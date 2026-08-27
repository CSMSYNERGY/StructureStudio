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
    // The gateway account is SHARED with other CSM Synergy products, so their subscription
    // events arrive at this endpoint too (observed order_id prefixes "cs_" and "fu_" —
    // Framed-UP; ours is "ss_", minted only by portal-billing). Those events can NEVER
    // resolve to a StructureStudio tenant, and throwing made the gateway redeliver for
    // hours while app_errors filled with "cannot resolve tenant" / "No billing_subscriptions
    // row" rows (40+ per foreign subscription, observed 2026-08-24/25). A POSITIVELY
    // foreign prefix is acked as processed-with-note instead; an absent or unparseable
    // order_id keeps the throw-and-retry behaviour that out-of-order ss_ events rely on
    // (see the reordering note on the delete case).
    const orderIdRaw = String(sub.order_id ?? sub.orderid ?? "");
    const foreignOrderPrefix = (() => {
      const m = /^([a-z]+)_/.exec(orderIdRaw);
      return m && m[1] !== "ss" ? `${m[1]}_` : null;
    })();
    const ackForeign = async () => {
      await done(true, `ignored: foreign-product subscription (order_id=${orderIdRaw})`);
      return json({ ok: true, ignored: "foreign-product subscription" });
    };
    // NMI sends next_charge_date: "1970-01-01" as its placeholder for "no scheduled date"
    // — observed on EVERY live event 2026-07-28, adds and deletes alike. Stored at face
    // value that puts an epoch-zero renewal date in front of the tenant and makes any
    // "period has ended" comparison instantly true, so an implausibly old date is treated
    // as absent rather than trusted.
    const rawPeriodEnd = sub.current_period_end ?? sub.next_charge_date ?? null;
    const periodEnd = (() => {
      if (!rawPeriodEnd) return null;
      const t = Date.parse(String(rawPeriodEnd));
      if (!Number.isFinite(t) || t < Date.parse("2020-01-01")) return null;
      return new Date(t).toISOString();
    })();
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
        // NMI does NOT echo merchant_defined_fields in the webhook payload. Verified
        // against live events 2026-07-28: event_body carries subscription_id, order_id,
        // order_description, plan{id,name,amount,payments,day_of_month,month_frequency},
        // card, merchant, billing_address, shipping, tax, features, next_charge_date,
        // attempted_payments, completed_payments, remaining_payments — and no MDF or
        // metadata block anywhere. So merchant_defined_field_1 (which we DO send on
        // add_subscription) cannot be read back here, and every add event failed with
        // "without a client id" until this was fixed.
        //
        // Two recoveries, both reliable:
        //   1. The row we already wrote. portal-billing creates it immediately after the
        //      gateway call, so by the time this arrives the tenant is already known.
        //      This is authoritative — it is our own record, not a parsed string.
        //   2. order_id, which is ours: `ss_<clientId>_<planId>`. clientId is a DNS-safe
        //      slug (it doubles as a subdomain, so no underscores), hence the segment
        //      after "ss_" is exactly it. Covers a subscription created directly in the
        //      gateway, which we would have no row for.
        const { data: existingSub } = await admin.from("billing_subscriptions")
          .select("client_id, current_period_start, status").eq("id", subId).maybeSingle();
        // ss_first_<clientId>_<planId> is portal-billing's first-charge variant; without
        // the optional "first_" hop the capture group returned the literal "first" as the
        // tenant slug, and a gateway-created subscription would have been homed on a
        // nonexistent client called "first".
        const fromOrderId = /^ss_(?:first_)?([a-z0-9-]+)_/.exec(orderIdRaw)?.[1] ?? null;
        const tenant = existingSub?.client_id ?? clientId ?? fromOrderId;
        if (!tenant) {
          if (foreignOrderPrefix) return await ackForeign();
          throw new Error(`subscription.add: cannot resolve tenant (order_id=${orderIdRaw || "absent"})`);
        }
        // This event's real value is next_charge_date — portal-billing cannot know it.
        // Don't clobber what we already recorded: leave current_period_start alone on a
        // row that exists, and never overwrite a period end with null.
        const addPatch: Record<string, unknown> = {
          id: subId,
          client_id: String(tenant),
        };
        // `add` is the FIRST event in a subscription's life, so one arriving for a row we
        // already hold as cancelled is a stale replay — and Deposyt does retry failed
        // deliveries for hours. Applying its status would resurrect the subscription to
        // active and silently hand a cancelled tenant their account back. Never let an
        // add event raise the status of an already-cancelled row.
        if (existingSub?.status !== "cancelled") addPatch.status = norm(status) ?? "active";
        if (periodEnd) addPatch.current_period_end = periodEnd;
        if (!existingSub) addPatch.current_period_start = new Date().toISOString();
        const { error } = await admin.from("billing_subscriptions")
          .upsert(addPatch, { onConflict: "id" });
        if (error) throw new Error(error.message);
        break;
      }
      case "recurring.subscription.update": {
        // An UNMAPPED status must never be read as "everything is fine". This used to
        // default to "active", which would take a payment-failure state we don't
        // recognise and silently keep a non-paying tenant fully entitled — the gate's
        // entire purpose inverted, and invisibly. norm() only guesses at what NMI sends
        // on a decline (past_due / pastdue / failed / declined); the real string has never
        // been observed, because no test has yet driven a card failure.
        //
        // Same rule as the Monday status map: an unknown label leaves the tenant's state
        // untouched and shouts, rather than inventing one. Throwing records the event as
        // FAILED in billing_webhook_events with the offending string, so it is
        // discoverable and Deposyt's retries will apply the mapping once it is added.
        const next = norm(status);
        // ABSENT and UNKNOWN are different things, and conflating them was a retry-storm waiting
        // to happen. norm() returns null for both: for a status string we do not recognise (which
        // SHOULD fail loudly, so the mapping gets added) and for no status field at all — and
        // every one of the six live NMI subscription payloads carries NO status field. So the
        // first benign update event (a card swap, a gateway-side amount edit) would have 422'd on
        // every hourly redelivery until NMI gave up, filling app_errors and leaving a permanently
        // 'failed' event indistinguishable at triage time from a real defect. An update that
        // carries no status simply is not a status change: apply what it does carry and accept it.
        if (status == null || String(status).trim() === "") {
          const { error: peErr, count } = await admin.from("billing_subscriptions")
            .update({ current_period_end: periodEnd ?? undefined, updated_at: new Date().toISOString() },
                    { count: "exact" })
            .eq("id", subId);
          if (peErr) throw new Error(peErr.message);
          if (!count) {
            if (foreignOrderPrefix) return await ackForeign();
            throw new Error(`No billing_subscriptions row for ${subId} — retry once the add lands`);
          }
          break;
        }
        if (!next) {
          console.warn(`[billing-webhook] UNMAPPED status "${status}" on ${eventType}`);
          const { error: peErr } = await admin.from("billing_subscriptions").update({
            current_period_end: periodEnd ?? undefined,
            updated_at: new Date().toISOString(),
          }).eq("id", subId);
          if (peErr) throw new Error(peErr.message);
          throw new Error(`Unmapped subscription status "${status}" — left status unchanged; add it to norm()`);
        }
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
        // A 0-row match is NOT success — see the note on the delete case below.
        const { error, count } = await admin.from("billing_subscriptions").update({
          status: next,
          current_period_end: periodEnd ?? undefined,
          updated_at: new Date().toISOString(),
          ...pastDuePatch,
        }, { count: "exact" }).eq("id", subId);
        if (error) throw new Error(error.message);
        if (!count) {
          if (foreignOrderPrefix) return await ackForeign();
          throw new Error(`No billing_subscriptions row for ${subId} — retry once the add lands`);
        }
        break;
      }
      case "recurring.subscription.delete": {
        // COUNT THE ROWS. A PostgREST update matching zero rows returns no error, so this used to
        // no-op and then mark the event 'processed' — which quietly broke the anti-resurrection
        // guard on `add` (line ~188: `if (existingSub?.status !== "cancelled")` only protects when
        // the cancelled row EXISTS). Event reordering is real on this gateway: on 2026-07-29 a
        // delete processed at 02:46:45 while its own add, stuck in the 422 retry loop, only landed
        // at 03:30:30. Order survived that time solely because portal-billing had pre-created the
        // row — but a subscription created directly in the gateway (the exact case the order_id
        // fallback exists to support) has no pre-created row, so the delete vanished and the
        // retried add then wrote status 'active' with nothing ever correcting it: the mirror says
        // active forever and nobody is paying. Throwing instead leaves the event FAILED and lets
        // the gateway redeliver after the add has created the row, which is the correct order.
        const { error, count } = await admin.from("billing_subscriptions").update({
          status: "cancelled", canceled_at: new Date().toISOString(), updated_at: new Date().toISOString(),
        }, { count: "exact" }).eq("id", subId);
        if (error) throw new Error(error.message);
        if (!count) {
          if (foreignOrderPrefix) return await ackForeign();
          throw new Error(`No billing_subscriptions row for ${subId} — retry once the add lands`);
        }
        break;
      }
      case "recurring.subscription.pause": {
        // Same 0-row reasoning as delete: a swallowed pause loses a past_due/paused signal, so the
        // grace clock never starts and no failure is recorded anywhere.
        const { error, count } = await admin.from("billing_subscriptions").update({
          status: "paused", updated_at: new Date().toISOString(),
        }, { count: "exact" }).eq("id", subId);
        if (error) throw new Error(error.message);
        if (!count) {
          if (foreignOrderPrefix) return await ackForeign();
          throw new Error(`No billing_subscriptions row for ${subId} — retry once the add lands`);
        }
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
