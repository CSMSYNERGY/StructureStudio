/**
 * Tenant SMS send — the orchestration layer over twilioSms.ts, mirroring emailSend.ts.
 *
 * Same shape and the same reasons: dark guards that touch nothing when the feature is not
 * configured, a LEDGER ROW CLAIMED BEFORE the provider call, and an outcome recorded on
 * that row afterwards. It never throws; callers branch on the returned verdict.
 *
 * ⚠️ DEPLOYING THIS CHANGES NOTHING ON ITS OWN. Every path below goes dark unless the
 * platform secrets exist AND the tenant's client_settings.sms_status is 'active' with a
 * number. That is deliberate: the code can ship, be reviewed and be tested while the A2P
 * campaign is still in carrier review, and no tenant sees a text until a human flips them
 * on. The email side works the same way and for the same reason.
 */

import { logEdgeError } from "./logError.ts";
import {
  sendSms, smsConfigured, smsE164US, smsPhoneKey, isDamagedPhoneKey, SmsApiError,
} from "./twilioSms.ts";

export type SmsOutcome = {
  sent: boolean;
  /** not_active: the feature is off for this deployment or this tenant — the caller should
   *  say "not switched on", never "failed". opted_out / bad_number / failed are real
   *  refusals with something to tell the user. */
  reason?: "not_active" | "opted_out" | "bad_number" | "damaged_number" | "failed";
  error?: string;
  id?: string;
};

export type TenantSms = {
  /** The customer's number as stored on crm_contacts.phone — display text, not normalized. */
  toPhone: string;
  body: string;
  contactId?: string | null;
  shortCode?: string | null;
  /** The signed-in human, for attribution on the ledger row. */
  sentBy?: string | null;
  /** Twilio posts delivery updates here. Omitted → no callback, and the row stays 'sent'. */
  statusCallback?: string | null;
};

export async function sendTenantSms(
  admin: any,
  clientId: string,
  msg: TenantSms,
): Promise<SmsOutcome> {
  try {
    // ── Dark guards (zero network, zero ledger) ───────────────────────────────────────
    // Platform secrets first: an unconfigured deployment skips even the settings read.
    if (!smsConfigured()) return { sent: false, reason: "not_active" };

    const { data: s } = await admin.from("client_settings")
      .select("sms_number, sms_status")
      .eq("client_id", clientId).maybeSingle();
    // A missing row or a read error both land here and go dark: without settings we cannot
    // know this tenant is registered, and an unregistered US send fails at the carrier
    // (30034) rather than merely erroring.
    if (!s || s.sms_status !== "active" || !s.sms_number) return { sent: false, reason: "not_active" };

    // ── The number, derived server-side ──────────────────────────────────────────────
    // ⚠️ NEVER trust a number from the browser. The caller passes ids; this reads the
    // stored phone and normalizes it the same way public.crm_phone_key does in SQL, so the
    // three definitions (resolver, backfill, sender) cannot disagree.
    const key = smsPhoneKey(msg.toPhone);
    if (isDamagedPhoneKey(key)) {
      // Ten digits starting with 1 is not a NANP number. It is the fingerprint of the
      // formatter that truncated +1 numbers and destroyed the last digit (fixed 08-25).
      // Refusing here, by name, beats a Twilio 21211 that reads as "this customer's phone
      // does not work".
      return {
        sent: false,
        reason: "damaged_number",
        error: "This phone number looks damaged — its last digit was lost when it was first saved. Re-enter it on the contact, then try again.",
      };
    }
    const to = smsE164US(key);
    if (!to) return { sent: false, reason: "bad_number", error: "That is not a US mobile number we can text." };

    // ── Opt-out, checked BEFORE the provider ─────────────────────────────────────────
    // Twilio's Advanced Opt-Out blocks the send anyway (21610), but finding out from a
    // provider error costs a round trip and reads as a system fault rather than as the
    // customer's own instruction. STOP is a legal instruction; say so plainly.
    if (msg.contactId) {
      const { data: c } = await admin.from("crm_contacts")
        .select("sms_opt_out_at").eq("client_id", clientId).eq("id", msg.contactId).maybeSingle();
      if (c && c.sms_opt_out_at) {
        return {
          sent: false,
          reason: "opted_out",
          error: "This customer replied STOP, so we cannot text them. They can reply START to that same number to opt back in.",
        };
      }
    }

    const body = String(msg.body ?? "").trim().slice(0, 1600);
    if (!body) return { sent: false, reason: "failed", error: "The message is empty." };

    // ── Ledger first: claim the send before touching the provider ────────────────────
    const { data: row, error: insErr } = await admin.from("sms_messages").insert({
      client_id: clientId,
      contact_id: msg.contactId ?? null,
      short_code: msg.shortCode ?? null,
      direction: "out",
      from_number: s.sms_number,
      to_number: to,
      body,
      status: "claimed",
      sent_by: msg.sentBy ?? null,
    }).select("id").single();

    if (insErr || !row?.id) {
      // No claim row → no send. A message the customer received and the builder cannot see
      // is worse than a message that did not go. The raw Postgres text can echo the row
      // (which holds the number), so it goes to app_errors, not to the browser.
      await logEdgeError({
        fn: "sms-send",
        clientId,
        code: "sms_ledger_insert_failed",
        message: `sms_messages claim row could not be written: ${insErr?.message ?? "insert returned no id"}`,
        context: { contactId: msg.contactId ?? null, shortCode: msg.shortCode ?? null },
      });
      return { sent: false, reason: "failed", error: "sms ledger write failed" };
    }
    const rowId = row.id;

    // ── Send, then record the outcome on the claimed row ─────────────────────────────
    try {
      const out = await sendSms({
        to,
        from: String(s.sms_number),
        body,
        statusCallback: msg.statusCallback ?? null,
      });
      const { error: upErr } = await admin.from("sms_messages").update({
        status: "sent",
        provider_sid: out.sid || null,
        num_segments: out.segments,
        updated_at: new Date().toISOString(),
      }).eq("id", rowId);
      if (upErr) {
        // SENT BUT NOT RECORDED. The message is with the customer, so the verdict stays
        // `sent: true` — reporting a failure would invite a resend and text them twice.
        // The gap is logged instead. Same asymmetry as emailSend.
        await logEdgeError({
          fn: "sms-send",
          clientId,
          code: "sms_ledger_update_failed",
          message: `sms_messages row ${rowId} sent but not updated: ${upErr.message}`,
          context: { rowId },
        });
      }
      return { sent: true, id: rowId };
    } catch (e) {
      const err = e as SmsApiError;
      const code = typeof err.code === "number" ? err.code : 0;
      await admin.from("sms_messages").update({
        status: "failed",
        error_code: code ? String(code) : null,
        updated_at: new Date().toISOString(),
      }).eq("id", rowId);

      // 21610 is Twilio telling us the recipient opted out through a route we did not see
      // (a STOP to a different number on the same service, or one our webhook missed).
      // Record it on the contact so the composer stops offering, and answer in the
      // customer's terms rather than with a provider code.
      if (code === 21610 && msg.contactId) {
        await admin.from("crm_contacts")
          .update({ sms_opt_out_at: new Date().toISOString() })
          .eq("client_id", clientId).eq("id", msg.contactId);
        return { sent: false, reason: "opted_out", error: "This customer has opted out of texts from this number." };
      }
      if (code === 30034) {
        return {
          sent: false,
          reason: "not_active",
          error: "Texting is not switched on for this account yet — the number is still with the carriers for approval.",
        };
      }
      return {
        sent: false,
        reason: "failed",
        error: `The text could not be sent${code ? ` (carrier code ${code})` : ""}. Try again, or call them instead.`,
      };
    }
  } catch (e) {
    // Belt and braces: this function must never throw into a request handler.
    await logEdgeError({
      fn: "sms-send",
      clientId,
      code: "sms_send_unhandled",
      message: `unhandled: ${(e as Error).message}`,
    }).catch(() => {});
    return { sent: false, reason: "failed", error: "The text could not be sent." };
  }
}
