// POST /sms/send: a text a person typed in the extension or the app.
//
// THE SAME CHECKS THE CRM MAKES (portal-settings crm_send_sms), in the same order, then the same
// send rules (_shared/smsSend.ts sendTenantSms):
//   1. contacts edit access (canEdit: 'edit', or 'own', which writes but only to its own rows);
//   2. CONTACT_ROW_SCOPE: someone limited to their own customers may only text a contact they
//      own or follow, answered by public.crm_visible_contact_ids, the predicate the portal runs;
//   3. the contact/short-code match. This API carries no short code (the phone has no deal
//      picker), so its twin here is the NUMBER: the recipient is read from the contact row
//      server-side, and the to_e164 the app sent is only a confirmation that must agree with it.
//      The number in the body is never what is dialed (portal-settings' open-relay rule).
// Then sendTenantSms (registered number, STOP, consent), with bypassQuietHours: true stated
// explicitly: a text a person types goes out at any hour, the portal's rule since 09-29.
//
// UNKNOWN NUMBERS (no contact): a reply is allowed for contacts view or edit, only to a number
// whose latest text in the thread came IN from that number (it texted first, which sms-inbound
// records as consent to reply). Someone limited to their own customers saves the contact first.

import type { Ctx, Env } from "../env";
import { sendTenantSms, type SmsOutcome } from "../../../../supabase/functions/_shared/smsSend.ts";
import { requireCaller } from "../context";
import { must } from "../db";
import { ApiError, ok, readJson, UUID_RE, type ErrorCode } from "../http";
import { phoneDigits, toE164 } from "../identity";
import { logFault } from "../log";
import { mayReadUnknownNumbers, maySendToContacts, narrowedToOwn, visibleContactIds } from "../scope";

const TEMP_ID_RE = /^[A-Za-z0-9_.:-]{1,64}$/;

/** A refused send, in the SPEC's codes and plain English. smsSend's own sentences are kept. */
export function mapSmsRefusal(out: SmsOutcome): { code: ErrorCode; message: string; status: number } {
  switch (out.reason) {
    case "no_consent":
      return { code: "no_consent", status: 409, message: out.error ?? "This customer hasn't agreed to texts yet." };
    case "opted_out":
      return { code: "opted_out", status: 409, message: out.error ?? "This customer asked not to be texted (STOP)." };
    case "not_active":
      return { code: "number_not_registered", status: 409, message: out.error ?? "Your texting number isn't registered yet." };
    case "bad_number":
    case "damaged_number":
      return { code: "bad_request", status: 400, message: out.error ?? "That number can't receive texts." };
    case "quiet_hours":
      // Cannot happen with bypassQuietHours: true; if it ever does, say what it means.
      return { code: "internal", status: 500, message: out.error ?? "The text was held for quiet hours." };
    case "failed":
    default:
      return { code: "twilio_error", status: 502, message: out.error ?? "The text could not be sent. Try again, or call them instead." };
  }
}

/** Which app sent it (sms_messages.sent_via): the extension's pages carry their origin. */
export function sentVia(req: Request): "extension" | "mobile" {
  const hinted = (req.headers.get("x-sss-client") ?? "").toLowerCase();
  if (hinted === "extension" || hinted === "mobile") return hinted;
  return (req.headers.get("origin") ?? "").startsWith("chrome-extension://") ? "extension" : "mobile";
}

export async function sendSms(env: Env, ec: Ctx, req: Request): Promise<Response> {
  const c = await requireCaller(env, req);
  const body = await readJson(req);
  // Photos cannot be SENT yet: the shared sendTenantSms has no media parameter (twilioSms.ts
  // posts Body only), and a second send path would be a second set of texting rules. Refused
  // out loud rather than dropped, so the app never shows a photo as sent when it was not.
  const media = body.media_urls;
  if (media !== undefined && media !== null && !(Array.isArray(media) && media.length === 0)) {
    throw new ApiError("bad_request", "Sending photos isn't available yet. Send the text on its own.");
  }
  const text = String(body.body ?? "").trim().slice(0, 1600);
  if (!text) throw new ApiError("bad_request", "The message is empty.");
  const tempId = body.client_temp_id == null ? "" : String(body.client_temp_id);
  if (tempId && !TEMP_ID_RE.test(tempId)) throw new ApiError("bad_request", "The message id isn't valid.");
  const to = toE164(String(body.to_e164 ?? ""));
  if (!to) throw new ApiError("bad_request", "That isn't a US or Canadian mobile number.");
  const contactId = body.contact_id == null || body.contact_id === "" ? null : String(body.contact_id);
  if (contactId !== null && !UUID_RE.test(contactId)) throw new ApiError("bad_request", "That contact id isn't valid.");
  if (!c.ctx.number) throw new ApiError("no_number");

  let toPhone: string;
  if (contactId) {
    // 1. contacts edit access.
    if (!maySendToContacts(c.ctx)) {
      throw new ApiError("not_your_customer", "Your account can see customers but not text them. Ask your owner for Contacts edit access.");
    }
    // 2. row scope. 404-style wording on purpose: a distinct refusal would confirm the row exists.
    if (narrowedToOwn(c.ctx)) {
      const seen = await visibleContactIds(c, [contactId]);
      if (!seen.has(contactId)) throw new ApiError("not_your_customer");
    }
    const contact = must(
      await c.admin.from("crm_contacts").select("id, phone, phone_digits").eq("client_id", c.ctx.client_id).eq("id", contactId).maybeSingle(),
      "look up contact",
    ) as { id: string; phone: string | null; phone_digits: string | null } | null;
    if (!contact) throw new ApiError("not_found", "That contact wasn't found.");
    if (!contact.phone) throw new ApiError("bad_request", "This contact has no phone number on file.");
    // 3. the recipient is the contact's own number; the app's copy must agree with it.
    if (phoneDigits(contact.phone) !== to.slice(2)) {
      throw new ApiError("bad_request", "That number doesn't match this customer's phone. Refresh and try again.");
    }
    toPhone = contact.phone;
  } else {
    if (!mayReadUnknownNumbers(c.ctx)) {
      throw new ApiError("not_your_customer", "Save this number as a contact first, then text them from their record.");
    }
    const digits = to.slice(2);
    const [saved, inbound] = await Promise.all([
      c.admin.from("crm_contacts").select("id").eq("client_id", c.ctx.client_id).eq("phone_digits", digits)
        .is("merged_into", null).limit(1),
      // The thread is keyed by this number, so its latest inbound text is one FROM this number:
      // the question is only whether they texted this builder first.
      c.admin.from("sms_messages").select("id").eq("client_id", c.ctx.client_id)
        .is("contact_id", null).eq("direction", "in").eq("from_number", to)
        .order("created_at", { ascending: false }).limit(1),
    ]);
    if ((must(saved, "check saved contact") as unknown[] | null)?.length) {
      throw new ApiError("bad_request", "This number is saved as a contact now. Open their thread to reply.");
    }
    if (!(must(inbound, "read unknown-number thread") as unknown[] | null)?.length) {
      throw new ApiError("not_your_customer", "You can only reply to a number that texted you first. Save it as a contact to start a conversation.");
    }
    toPhone = to;
  }

  const secret = env.SMS_INBOUND_SECRET ?? "";
  const statusCallback = secret && env.SUPABASE_URL
    ? `${env.SUPABASE_URL.replace(/\/+$/, "")}/functions/v1/sms-status?key=${encodeURIComponent(secret)}`
    : null;

  const out = await sendTenantSms(c.admin, c.ctx.client_id, {
    toPhone,
    body: text,
    contactId,
    shortCode: null,
    sentBy: c.userId,
    statusCallback,
    // A person typed this and pressed Send: it goes now, at any hour (portal rule since 09-29).
    // Consent and STOP still refuse. Stated explicitly, as every caller must (the wiring test).
    bypassQuietHours: true,
  });

  if (!out.sent || !out.id) {
    const r = mapSmsRefusal(out);
    if (r.code === "twilio_error" || r.code === "internal") {
      ec.waitUntil(logFault({ code: `sms_send_${out.reason ?? "failed"}`, clientId: c.ctx.client_id, message: `sendTenantSms refused: ${out.reason ?? "failed"}`, context: { contactId } }));
    }
    throw new ApiError(r.code, r.message, r.status);
  }

  // The row sendTenantSms wrote, tagged so the app's optimistic bubble matches it exactly once.
  const { error: tagErr } = await c.admin.from("sms_messages")
    .update({ client_temp_id: tempId || null, sent_via: sentVia(req) })
    .eq("id", out.id).eq("client_id", c.ctx.client_id);
  if (tagErr) {
    // Sent but not tagged: the text is with the customer, so this stays a success. The bubble
    // falls back to matching on the returned id.
    ec.waitUntil(logFault({ code: "sms_tag_failed", clientId: c.ctx.client_id, message: `client_temp_id/sent_via update failed: ${tagErr.message}`, context: { id: out.id } }));
  }
  return ok({ message: { id: out.id, client_temp_id: tempId || null, status: "sent" } });
}
