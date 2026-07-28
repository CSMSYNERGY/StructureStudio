import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { withErrorLog } from "../_shared/logError.ts";

// Deposyt subscription-lifecycle webhook → mirrors billing state into
// public.billing_subscriptions (portal Billing tab reads that, never the gateway).
//
// Auth: this endpoint is public at the gateway level (the gateway cannot send a
// Supabase JWT) — authentication is the HMAC-SHA256 signature verified against
// the DEPOSYT_WEBHOOK_SIGNING_KEY secret (the Signing Key shown on the gateway's
// Options → Settings → Webhooks page). Two schemes accepted:
//   Webhook-Signature: t=<nonce>,s=<hex>   — NMI's real format (verified against
//     `${nonce}.${rawBody}`; confirmed via docs.nmi.com 2026-07-25)
//   x-deposyt-signature: sha256=<hex>      — legacy BuildBridge-style (over raw body)
// Missing secret => endpoint refuses everything (503), inert until set up.
//
// DEPLOY NOTE: this function MUST stay verify_jwt=false. Deposyt cannot send a
// Supabase JWT, so with JWT verification on, the gateway 401s every delivery before
// this code runs — the signature is never even checked and nothing is recorded.
// That silently broke the whole billing lifecycle until 2026-07-28.
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

Deno.serve(withErrorLog("billing-webhook", async (req: Request) => {
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
  if (!SIGNING_KEY) return json({ error: "Billing webhooks are not configured." }, 503);

  // 1. Verify the gateway signature over the raw body (either scheme).
  const raw = await req.text();
  const nmiHeader = req.headers.get("webhook-signature") || "";
  const legacyHeader = req.headers.get("x-deposyt-signature") || "";
  let verified = false;
  if (nmiHeader) {
    // Webhook-Signature: t=<nonce>,s=<hex> — HMAC over `${nonce}.${body}`.
    const parts = Object.fromEntries(nmiHeader.split(",").map((p) => p.trim().split("=") as [string, string]));
    if (parts.t && parts.s) {
      const ourHex = await hmacHex(SIGNING_KEY, `${parts.t}.${raw}`);
      verified = safeEqual(ourHex, String(parts.s).toLowerCase());
    }
  } else if (legacyHeader) {
    const [scheme, theirHex] = legacyHeader.split("=");
    if (scheme === "sha256" && theirHex) {
      const ourHex = await hmacHex(SIGNING_KEY, raw);
      verified = safeEqual(ourHex, theirHex.toLowerCase());
    }
  }
  // ── TEMPORARY DIAGNOSTIC — remove once a real delivery verifies ─────────────
  // A rejection happens BEFORE the billing_webhook_events insert, so we otherwise
  // have no record of what was actually sent. This records SHAPE ONLY, to tell a
  // wrong signing key apart from a signature scheme that differs from NMI's spec.
  // Deliberately never recorded: the signature value, the signing key, the request
  // body, or anything about the customer/payment. Behaviour is unchanged — a bad
  // signature is still rejected below.
  if (!verified) {
    try {
      const rawHmac = async (key: string, data: string) => {
        const k = await crypto.subtle.importKey("raw", new TextEncoder().encode(key),
          { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
        return new Uint8Array(await crypto.subtle.sign("HMAC", k, new TextEncoder().encode(data)));
      };
      const toHex = (u: Uint8Array) => Array.from(u).map((b) => b.toString(16).padStart(2, "0")).join("");
      const toB64 = (u: Uint8Array) => btoa(String.fromCharCode(...u));
      const p = Object.fromEntries((nmiHeader || "").split(",").map((x) => x.trim().split("=")));
      const nonce = String(p.t ?? "");
      const theirSig = String(p.s ?? (legacyHeader.split("=")[1] ?? ""));
      // Which construction, if any, reproduces their signature? Names only.
      const cand: Record<string, string> = {};
      if (nonce) {
        const a = await rawHmac(SIGNING_KEY, `${nonce}.${raw}`);
        cand["nonce.body/hex"] = toHex(a); cand["nonce.body/base64"] = toB64(a);
      }
      const b = await rawHmac(SIGNING_KEY, raw);
      cand["body-only/hex"] = toHex(b); cand["body-only/base64"] = toB64(b);
      const matched = Object.entries(cand)
        .filter(([, v]) => v.toLowerCase() === theirSig.toLowerCase()).map(([k]) => k);
      const diag = {
        headerNames: [...req.headers.keys()].sort(),
        hasWebhookSignature: Boolean(nmiHeader),
        hasLegacyHeader: Boolean(legacyHeader),
        parsedNonce: Boolean(nonce),
        parsedSig: Boolean(theirSig),
        sigLength: theirSig.length,
        sigCharset: /^[0-9a-fA-F]+$/.test(theirSig) ? "hex"
          : /^[A-Za-z0-9+/]+={0,2}$/.test(theirSig) ? "base64" : "other",
        schemeMatched: matched.length ? matched : "NONE — signing key does not match",
      };
      console.log("[billing-webhook][diag] " + JSON.stringify(diag));
      // The runtime console stream is not reliably queryable on this project, so
      // persist the shape to app_errors too — that table demonstrably works.
      const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
      await sb.from("app_errors").insert({
        source: "edge:billing-webhook", severity: "error", code: "sig_diag",
        message: "signature rejected — shape diagnostic", context: diag,
      });
    } catch (_e) { /* a diagnostic must never change behaviour */ }
  }
  if (!verified) return json({ error: "Missing or invalid webhook signature." }, 401);

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
    // NMI wraps the details in event_body; older Deposyt shapes nested a
    // subscription object. Accept any of them.
    const sub = payload?.data?.subscription ?? payload?.subscription ?? payload?.event_body;
    if (!sub) throw new Error("No subscription object in payload");
    const subId = String(sub.subscription_id ?? sub.id ?? "");
    if (!subId) throw new Error("No subscription id in payload");
    const status = sub.status ? String(sub.status) : null;
    const periodEnd = sub.current_period_end ?? sub.next_charge_date ?? null;
    // Tenant: subscribe-time we set merchant_defined_field_1 = client_id. NMI may
    // echo it as merchant_defined_fields (array or object); older shapes used
    // metadata. Fall back to the already-known row for updates.
    const mdf = sub?.merchant_defined_fields;
    const mdfClientId = Array.isArray(mdf)
      ? (mdf.find((f: any) => String(f?.id ?? f?.field ?? "") === "1")?.value ?? mdf[0]?.value ?? null)
      : (mdf && typeof mdf === "object" ? (mdf["1"] ?? mdf.merchant_defined_field_1 ?? null) : null);
    const clientId =
      payload?.data?.subscription?.metadata?.locationId ??
      payload?.subscription?.metadata?.locationId ??
      sub?.merchant_defined_field_1 ?? mdfClientId ?? sub?.metadata?.clientId ?? null;

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
        const next = norm(status) ?? "active";
        // Stamp when a subscription FIRST goes past_due — that starts the grace clock
        // the portal gate reads (a failed payment keeps working for a few days with a
        // warning instead of locking a paying customer out over an expired card).
        // Clear it the moment the payment recovers. Read-then-write so a repeated
        // past_due event doesn't keep pushing the deadline forward.
        let pastDuePatch: Record<string, unknown> = {};
        if (next === "past_due") {
          const { data: cur } = await admin.from("billing_subscriptions")
            .select("past_due_since").eq("id", subId).maybeSingle();
          if (!cur?.past_due_since) pastDuePatch = { past_due_since: new Date().toISOString() };
        } else {
          pastDuePatch = { past_due_since: null };
        }
        const { error } = await admin.from("billing_subscriptions").update({
          status: next,
          current_period_end: periodEnd ? new Date(periodEnd).toISOString() : undefined,
          updated_at: new Date().toISOString(),
          ...pastDuePatch,
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
}, { minStatus: 400 }));
