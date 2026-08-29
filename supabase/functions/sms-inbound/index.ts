import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { logEdgeError, withErrorLog } from "../_shared/logError.ts";
import { timingSafeEqual } from "../_shared/emailInbound.ts";
import { validateTwilioSignature, hasSignatureKey, smsPhoneKey } from "../_shared/twilioSms.ts";

// Inbound SMS → the CRM conversation. The return leg that makes texting two-way, and the
// twin of email-inbound: same shared-secret gate, same always-200-once-authenticated
// posture, same "an unmatched message is still stored" rule.
//
// ⚠️ THE TENANT COMES FROM THE `To` NUMBER AND NOTHING ELSE. That is the number Twilio
// delivered to, and it is unique per tenant (migration 148 enforces it with a partial
// unique index). The sender, the body and every other field are attacker-supplied and may
// only narrow WITHIN a tenant already proved. This mirrors email-inbound's two-stage rule,
// and collapsing the stages is how a stranger writes onto a builder's record.
//
// ⚠️ THIS FUNCTION MUST NEVER SEND ANYTHING. It stores a row and returns empty TwiML. An
// auto-reply would turn a spam run at a published number into US texting strangers, and
// the complaints land on the shared A2P campaign every other builder depends on.
//
// ⚠️ ALWAYS 200 ONCE AUTHENTICATED. A non-2xx makes Twilio retry and eventually disable the
// webhook — losing every future message to fix one. An unparseable payload, an unknown
// number, an unmatchable sender: none of those improve on the second attempt.
//
// Required secrets: SMS_INBOUND_SECRET (+ the platform SUPABASE_* pair). TWILIO_AUTH_TOKEN
// is optional but strongly wanted — see the signature block below.

/** Twilio expects TwiML. A JSON body earns a 12300 "invalid content type" warning on every
 *  single message, which buries real problems in the console. Empty <Response/> means
 *  "received, reply with nothing". */
function twiml(status = 200) {
  return new Response('<?xml version="1.0" encoding="UTF-8"?><Response/>', {
    status,
    headers: { "Content-Type": "text/xml" },
  });
}
function deny() {
  return new Response(JSON.stringify({ error: "unauthorized" }), {
    status: 401,
    headers: { "Content-Type": "application/json" },
  });
}

const STOP_WORDS = new Set(["stop", "stopall", "unsubscribe", "cancel", "end", "quit", "revoke", "optout"]);
const START_WORDS = new Set(["start", "yes", "unstop", "optin"]);

Deno.serve(withErrorLog("sms-inbound", async (req: Request) => {
  if (req.method !== "POST") return new Response("POST only", { status: 405 });

  const secret = Deno.env.get("SMS_INBOUND_SECRET") ?? "";
  const key = new URL(req.url).searchParams.get("key") ?? "";
  // Unset secret ⇒ refuse everything. Deliberately inert, never open — the same posture
  // email-inbound shipped with, so this can be deployed long before it is wired up.
  if (!secret || !timingSafeEqual(key, secret)) return deny();

  // Twilio posts form-encoded, not JSON.
  let params: Record<string, string> = {};
  try {
    const form = await req.formData();
    for (const [k, v] of form.entries()) params[k] = typeof v === "string" ? v : "";
  } catch {
    return twiml();
  }

  const admin = createClient(
    Deno.env.get("SUPABASE_URL") ?? "",
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
    { auth: { persistSession: false } },
  );

  // ── Signature ────────────────────────────────────────────────────────────────────────
  // Twilio signs with the ACCOUNT AUTH TOKEN specifically; an API key pair cannot validate
  // it. On this deployment TWILIO_AUTH_TOKEN is currently empty (2026-08-11 — the operator
  // only had the key pair), so "no token" is a third state, not a failed check:
  //
  //   - token set + signature bad  → refuse. Someone is forging.
  //   - token set + signature good → proceed.
  //   - NO TOKEN                   → proceed on the shared secret alone, and log it once so
  //                                  the gap is visible. Failing closed here would silently
  //                                  drop every customer's reply to fix a hardening step
  //                                  nobody has taken yet, which is the worse failure.
  //
  // The URL is REBUILT rather than read off req.url: the Supabase gateway rewrites the
  // incoming URL, while the signature was computed over the URL configured in Twilio.
  const sig = req.headers.get("X-Twilio-Signature") ?? "";
  if (hasSignatureKey()) {
    const url = `${Deno.env.get("SUPABASE_URL") ?? ""}/functions/v1/sms-inbound?key=${key}`;
    const ok = await validateTwilioSignature(url, params, sig);
    if (!ok) {
      await logEdgeError({
        fn: "sms-inbound",
        code: "sms_signature_invalid",
        message: "X-Twilio-Signature did not validate; message refused.",
        context: { hasSig: !!sig },
      }).catch(() => {});
      return deny();
    }
  } else {
    await logEdgeError({
      fn: "sms-inbound",
      code: "sms_signature_skipped",
      message: "TWILIO_AUTH_TOKEN is unset, so inbound SMS is authenticated by the URL secret alone. Set it to enable signature validation.",
      severity: "info",
    }).catch(() => {});
  }

  const fromNum = String(params.From ?? "").trim();
  const toNum = String(params.To ?? "").trim();
  const body = String(params.Body ?? "");
  const sid = String(params.MessageSid ?? params.SmsSid ?? "").trim();
  if (!fromNum || !toNum) return twiml();

  // ── STAGE A: the tenant, from the number Twilio delivered to ─────────────────────────
  // sms_numbers is the authority now that each builder owns their own number: it carries the
  // live/released distinction, and its partial unique index on (phone_number) where
  // released_at is null is what guarantees ONE tenant per live number. client_settings is
  // still consulted as a fallback for any tenant configured before migration 165.
  const { data: owned } = await admin.from("sms_numbers")
    .select("client_id").eq("phone_number", toNum).is("released_at", null).maybeSingle();
  let tenant = owned;
  if (!tenant?.client_id) {
    const { data: legacy } = await admin.from("client_settings")
      .select("client_id").eq("sms_number", toNum).maybeSingle();
    tenant = legacy;
  }
  if (!tenant?.client_id) {
    // A number pointed at us that belongs to no tenant. Worth seeing — it means a number
    // was bought and wired before its client_settings row was set, and the customer's text
    // is being dropped. Still a 200: retrying will not create the row.
    await logEdgeError({
      fn: "sms-inbound",
      code: "sms_inbound_no_tenant",
      message: "An SMS arrived on a number that is not configured for any tenant.",
      context: { to: toNum },
    }).catch(() => {});
    return twiml();
  }
  const clientId = String(tenant.client_id);

  // ── STAGE B: the contact, within that tenant ─────────────────────────────────────────
  // phone_digits is the 10-digit NANP key (migration 132), so the E.164 sender is reduced
  // the same way before matching. merged_into is null — a merged contact is a tombstone.
  const digits = smsPhoneKey(fromNum);
  let contactId: string | null = null;
  if (digits) {
    const { data: c } = await admin.from("crm_contacts")
      .select("id").eq("client_id", clientId).eq("phone_digits", digits)
      .is("merged_into", null).limit(1).maybeSingle();
    contactId = c?.id ?? null;
  }

  // ── STOP / START ─────────────────────────────────────────────────────────────────────
  // Twilio's Advanced Opt-Out already blocks our sends at the provider. This column is what
  // lets the composer tell the truth BEFORE somebody types a message that cannot arrive.
  // `OptOutType` is what the Messaging Service sets when it handles the keyword itself; the
  // bare-word check is the fallback for a number not yet on the service.
  const optOutType = String(params.OptOutType ?? "").toUpperCase();
  const word = body.trim().toLowerCase().replace(/[^a-z]/g, "");
  const isStop = optOutType === "STOP" || STOP_WORDS.has(word);
  const isStart = optOutType === "START" || START_WORDS.has(word);
  if (isStop || isStart) {
    // ⚠️ RECORDED AGAINST THE PHONE, not only the contact. A STOP from someone with no
    // contact row still has to be honoured — that is exactly the person most likely to be
    // texted again by mistake — and consent must survive the contact being merged, renamed
    // or re-created. sms_opt_outs is what smsSend actually checks before every send.
    if (digits) {
      if (isStop) {
        await admin.from("sms_opt_outs").upsert({
          client_id: clientId, phone_digits: digits, reason: "sms_stop",
          requested_at: new Date().toISOString(), effective_at: new Date().toISOString(),
        }, { onConflict: "client_id,phone_digits" });
      } else {
        await admin.from("sms_opt_outs").delete()
          .eq("client_id", clientId).eq("phone_digits", digits);
      }
      // Append-only evidence, separate from the derived block above. The body is stored
      // verbatim because what they actually typed is the record of what they asked for.
      await admin.from("sms_consent_log").insert({
        client_id: clientId, phone_digits: digits, contact_id: contactId,
        action: isStop ? "revoked" : "granted",
        source: isStop ? "sms_stop" : "sms_start",
        disclosure_text: body.slice(0, 500),
        detail: { messageSid: sid || null, optOutType: optOutType || null, from: fromNum },
      }).then(() => {}, () => {});
    }
    if (contactId) {
      await admin.from("crm_contacts")
        .update({ sms_opt_out_at: isStop ? new Date().toISOString() : null })
        .eq("client_id", clientId).eq("id", contactId);
    }
  }

  // ── Store ────────────────────────────────────────────────────────────────────────────
  // ⚠️ AN UNMATCHED MESSAGE IS STILL STORED, with a null contact_id. That is the
  // load-bearing decision, inherited verbatim from email-inbound: a customer's words are
  // worth more than our ability to file them. An unfiled row is visible to an operator via
  // sms_messages_unmatched_idx and can be re-linked; a dropped one is gone forever.
  const segs = Number(params.NumSegments);
  const { error } = await admin.from("sms_messages").insert({
    client_id: clientId,
    contact_id: contactId,
    direction: "in",
    from_number: fromNum,
    to_number: toNum,
    body,
    status: "received",
    provider_sid: sid || null,
    num_segments: Number.isFinite(segs) && segs > 0 ? segs : 1,
  });
  // 23505 on the partial unique index means Twilio retried a message we already stored.
  // That is a SUCCESS — the message is safe — so it must not look like a failure and must
  // not provoke another retry.
  if (error && String((error as { code?: string }).code) !== "23505") {
    await logEdgeError({
      fn: "sms-inbound",
      clientId,
      code: "sms_inbound_insert_failed",
      message: `inbound SMS could not be stored: ${error.message}`,
      context: { matched: !!contactId },
    }).catch(() => {});
  }

  return twiml();
}));
