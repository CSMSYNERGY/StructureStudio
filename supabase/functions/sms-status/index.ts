import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { logEdgeError, withErrorLog } from "../_shared/logError.ts";
import { timingSafeEqual } from "../_shared/emailInbound.ts";
import { validateTwilioSignature, hasSignatureKey } from "../_shared/twilioSms.ts";

// Twilio delivery receipts → the outbound row's final status. The twin of postmark-events,
// and the reason the Messages feed can say "delivered" rather than only "we handed it over".
//
// Twilio fires this several times per message (queued → sent → delivered), so it must be
// idempotent and cheap. It updates by provider_sid and does nothing else.
//
// ⚠️ ALWAYS 200 ONCE AUTHENTICATED, including when the SID matches no row — a status for a
// message we never recorded is not a failure worth a retry storm, and Twilio disables a
// webhook that keeps erroring.
//
// Required secrets: SMS_INBOUND_SECRET (shared with sms-inbound — same trust domain, same
// provider, and one secret to rotate rather than two).

type Patch = {
  status: "sent" | "delivered" | "undelivered" | "failed";
  delivered_at?: string;
  error_code?: string | null;
};

/**
 * Twilio MessageStatus → what we store. Exported and pure so the preflight gate can test
 * it offline, exactly as postmark-events' mapEvent is.
 *
 * `queued`/`accepted`/`sending`/`sent` are deliberately NOT mapped: the row is already 'sent'
 * from the send path, and writing a status that means "even less far along than what we have"
 * would make a delivered message flicker backwards if callbacks arrive out of order — Twilio
 * does deliver them out of order, and `sent` landing after `delivered` is the common pair.
 * `sent` is safe to drop because smsSend.ts writes provider_sid and status:'sent' in ONE
 * update, so every row a callback can match is already at least 'sent'; an unmapped status
 * returns null and the `if (!sid || !patch) return ok()` guard below 200s without a write.
 */
export function mapStatus(status: string, errorCode: string | null): Patch | null {
  switch (status) {
    case "delivered":
      return { status: "delivered", delivered_at: new Date().toISOString() };
    case "undelivered":
      return { status: "undelivered", error_code: errorCode };
    case "failed":
      return { status: "failed", error_code: errorCode };
    default:
      return null;
  }
}

function ok() {
  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}
function deny() {
  return new Response(JSON.stringify({ error: "unauthorized" }), {
    status: 401,
    headers: { "Content-Type": "application/json" },
  });
}

Deno.serve(withErrorLog("sms-status", async (req: Request) => {
  if (req.method !== "POST") return new Response("POST only", { status: 405 });

  const secret = Deno.env.get("SMS_INBOUND_SECRET") ?? "";
  const key = new URL(req.url).searchParams.get("key") ?? "";
  if (!secret || !timingSafeEqual(key, secret)) return deny();

  let params: Record<string, string> = {};
  try {
    const form = await req.formData();
    for (const [k, v] of form.entries()) params[k] = typeof v === "string" ? v : "";
  } catch {
    return ok();
  }

  // Same three-state signature handling as sms-inbound — see its header for why "no token"
  // proceeds rather than refusing.
  if (hasSignatureKey()) {
    const url = `${Deno.env.get("SUPABASE_URL") ?? ""}/functions/v1/sms-status?key=${key}`;
    const valid = await validateTwilioSignature(url, params, req.headers.get("X-Twilio-Signature") ?? "");
    if (!valid) return deny();
  }

  const sid = String(params.MessageSid ?? params.SmsSid ?? "").trim();
  const patch = mapStatus(String(params.MessageStatus ?? params.SmsStatus ?? ""), String(params.ErrorCode ?? "") || null);
  if (!sid || !patch) return ok();

  const admin = createClient(
    Deno.env.get("SUPABASE_URL") ?? "",
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
    { auth: { persistSession: false } },
  );

  const { error } = await admin.from("sms_messages")
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq("provider_sid", sid);
  if (error) {
    await logEdgeError({
      fn: "sms-status",
      code: "sms_status_update_failed",
      message: `delivery status could not be recorded: ${error.message}`,
      context: { status: patch.status },
    }).catch(() => {});
  }
  // No row matched is a normal, uninteresting outcome (a status for a message from before
  // this table existed, or one whose claim row failed). Not logged, still 200.
  return ok();
}));
