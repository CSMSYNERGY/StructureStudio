import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

// Deposyt subscription-lifecycle webhook → mirrors billing state into
// public.billing_subscriptions (portal Billing tab reads that, never the gateway).
//
// Auth: this endpoint is public at the gateway level (Deposyt cannot send a
// Supabase JWT) — authentication is the Deposyt HMAC-SHA256 signature over the
// raw request body, same scheme as BuildBridge:
//   x-deposyt-signature: sha256=<hex>
// verified against the DEPOSYT_WEBHOOK_SIGNING_KEY secret. Missing secret =>
// endpoint refuses everything (503), so it is inert until billing is set up.
//
// Events handled (anything else is logged + acknowledged):
//   recurring.subscription.add     → upsert row (client_id from metadata/merchant field)
//   recurring.subscription.update  → status / period end
//   recurring.subscription.delete  → status cancelled
//   recurring.subscription.pause   → status paused
//
// Every event is recorded in billing_webhook_events keyed by the Deposyt event id
// (idempotency: a replayed event id short-circuits as already-processed).

const SIGNING_KEY = Deno.env.get("DEPOSYT_WEBHOOK_SIGNING_KEY") || "";

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

async function hmacHex(key: string, data: string): Promise<string> {
  const k = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(key),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", k, new TextEncoder().encode(data));
  return Array.from(new Uint8Array(sig)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

// Constant-time-ish comparison (both sides are fixed-length hex of our own making).
function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
  if (!SIGNING_KEY) return json({ error: "Billing webhooks are not configured." }, 503);

  // 1. Verify the Deposyt signature over the raw body.
  const raw = await req.text();
  const sigHeader = req.headers.get("x-deposyt-signature") || "";
  const [scheme, theirHex] = sigHeader.split("=");
  if (scheme !== "sha256" || !theirHex) return json({ error: "Missing or malformed x-deposyt-signature." }, 401);
  const ourHex = await hmacHex(SIGNING_KEY, raw);
  if (!safeEqual(ourHex, theirHex.toLowerCase())) return json({ error: "Invalid signature." }, 401);

  let payload: any;
  try { payload = JSON.parse(raw); }
  catch { return json({ error: "Invalid JSON" }, 400); }

  const eventId = String(payload?.id ?? payload?.event_id ?? "");
  const eventType = String(payload?.type ?? payload?.event_type ?? "");
  if (!eventId || !eventType) return json({ error: "Missing event id or type." }, 400);

  const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

  // 2. Idempotency: log the event; a duplicate id that already processed is a no-op ack.
  const { data: existing } = await admin
    .from("billing_webhook_events").select("id, status").eq("id", eventId).maybeSingle();
  if (existing?.status === "processed") return json({ ok: true, duplicate: true });
  if (!existing) {
    const { error: logErr } = await admin.from("billing_webhook_events")
      .insert({ id: eventId, event_type: eventType, payload });
    if (logErr) console.warn("[billing-webhook] event log insert failed:", logErr.message);
  }

  const done = async (ok: boolean, error?: string) => {
    await admin.from("billing_webhook_events")
      .update({ status: ok ? "processed" : "failed", error: error ?? null, processed_at: new Date().toISOString() })
      .eq("id", eventId);
  };

  try {
    const sub = payload?.data?.subscription ?? payload?.subscription;
    if (!sub) throw new Error("No subscription object in payload");
    const subId = String(sub.id ?? sub.subscription_id ?? "");
    if (!subId) throw new Error("No subscription id in payload");
    const status = sub.status ? String(sub.status) : null;
    const periodEnd = sub.current_period_end ?? sub.next_charge_date ?? null;
    // Tenant: subscribe-time we set merchant_defined_field_1 = client_id; Deposyt
    // may echo it as metadata. Fall back to the already-known row for updates.
    const clientId =
      payload?.data?.subscription?.metadata?.locationId ??
      payload?.subscription?.metadata?.locationId ??
      sub?.merchant_defined_field_1 ?? sub?.metadata?.clientId ?? null;

    const norm = (s: string | null) => {
      const v = String(s ?? "").toLowerCase();
      if (["active", "trialing"].includes(v)) return "active";
      if (["paused", "pause"].includes(v)) return "paused";
      if (["past_due", "pastdue", "failed", "declined"].includes(v)) return "past_due";
      if (["cancelled", "canceled", "deleted"].includes(v)) return "cancelled";
      return null;
    };

    switch (eventType) {
      case "recurring.subscription.add": {
        if (!clientId) throw new Error("subscription.add without a client id (metadata/merchant field)");
        const { error } = await admin.from("billing_subscriptions").upsert({
          id: subId, client_id: String(clientId),
          status: norm(status) ?? "active",
          current_period_start: new Date().toISOString(),
          current_period_end: periodEnd ? new Date(periodEnd).toISOString() : null,
        }, { onConflict: "id" });
        if (error) throw new Error(error.message);
        break;
      }
      case "recurring.subscription.update": {
        const { error } = await admin.from("billing_subscriptions").update({
          status: norm(status) ?? "active",
          current_period_end: periodEnd ? new Date(periodEnd).toISOString() : undefined,
          updated_at: new Date().toISOString(),
        }).eq("id", subId);
        if (error) throw new Error(error.message);
        break;
      }
      case "recurring.subscription.delete": {
        const { error } = await admin.from("billing_subscriptions").update({
          status: "cancelled", canceled_at: new Date().toISOString(), updated_at: new Date().toISOString(),
        }).eq("id", subId);
        if (error) throw new Error(error.message);
        break;
      }
      case "recurring.subscription.pause": {
        const { error } = await admin.from("billing_subscriptions").update({
          status: "paused", updated_at: new Date().toISOString(),
        }).eq("id", subId);
        if (error) throw new Error(error.message);
        break;
      }
      default:
        console.warn(`[billing-webhook] Unhandled event type: ${eventType}`);
    }
    await done(true);
    return json({ ok: true });
  } catch (e) {
    await done(false, (e as Error).message).catch(() => {});
    return json({ error: (e as Error).message }, 422);
  }
});
