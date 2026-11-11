/**
 * An email received through Amazon SES, turned into the shape email-inbound already files.
 *
 * WHY THIS FILE EXISTS (2026-11-10). Replies arrive two ways while email moves from Resend to
 * Amazon SES. Resend POSTs its own webhook. SES stores the raw email in our bucket and has Amazon
 * SNS POST a short notice saying where. This file takes that notice from raw request body to
 * "here is the message": it proves the notice is SNS's and ours (snsVerify.ts), answers the
 * one-time subscription handshake, reads the raw email from the bucket (ses.ts) and parses it
 * (mimeParse.ts). email-inbound then runs the SAME tenant and threading rules it runs for Resend.
 *
 * It lives in _shared, not in email-inbound/index.ts, for the reason emailInbound.ts does: that
 * file calls Deno.serve at the top level, so nothing in it can be imported by a test.
 *
 * ⚠️ WHAT IS EVIDENCE AND WHAT IS NOT. The notice is signed, so two things in it can be trusted
 * in a way nothing inside the email can:
 *   • `receipt.recipients`: the SMTP envelope recipients SES accepted the mail for. This is what
 *     email-inbound's Stage A picks the TENANT from (emailInbound.ts envelopeRecipients already
 *     reads it). It is the true envelope, better evidence than Resend's header-parsed field.
 *   • the spam, virus, SPF, DKIM and DMARC verdicts. They are written over whatever the email's
 *     own headers claim, so a sender who plants `X-SES-Spam-Verdict: PASS` in their message
 *     changes nothing.
 * Everything parsed out of the email itself (From, To, Subject, the body, In-Reply-To) is the
 * sender's text. It may only narrow WITHIN the tenant the envelope chose, and it is display.
 *
 * ⚠️ THE BUCKET IS NEVER TAKEN FROM THE NOTICE, and the object key is shape-checked before use
 * (ses.ts sesGetInboundObject). The notice says which object; our settings say which bucket.
 *
 * WHAT THE ANSWER'S STATUS MEANS TO SNS. 2xx and 4xx end the delivery; 5xx makes SNS try again
 * (for about an hour with the subscription's retry policy). So a forged or malformed notice is a
 * 4xx, and anything a second try could fix (the bucket did not answer, the signing certificate
 * could not be fetched, the settings are not in place yet) is a 503. The raw email stays in the
 * bucket for 30 days either way, which is the last resort a metadata-only webhook never had.
 */

import { confirmSnsSubscription, parseTopicArns, verifySnsMessage, type SnsMessage, type SnsVerdict } from "./snsVerify.ts";
import { sesGetInboundObject, sesInboundConfigured, SesApiError } from "./ses.ts";
import { parseMime, type ParsedMail } from "./mimeParse.ts";

/** A log line for the caller to write (this file holds no logger and no request). Shapes and
 *  codes only: inbound mail is customer content. */
export type SesInboundLog = {
  code: string;
  message: string;
  severity?: "error" | "warn" | "info";
  context?: Record<string, unknown>;
};

/** The message as email-inbound's existing code reads one (`m` there). */
export type SesInboundMail = {
  from: { email: string; name: string | null };
  to: string;
  subject: string;
  text: string;
  html: string;
  /** The email's headers, lower-cased names, with the five verdict headers REPLACED by the
   *  signed notice's verdicts. */
  headers: Record<string, string>;
  message_id: string;
  in_reply_to: string;
  references: string;
  /** Every attached file, inline ones too (inboundFiling.ts attachmentNote says why). */
  attachments: { filename: string }[];
};

export type SesInboundResult =
  /** Answer SNS with this and stop. */
  | { kind: "answer"; status: number; body: Record<string, unknown>; log?: SesInboundLog }
  /** A received email. `payload` is what envelopeRecipients reads the envelope from. */
  | {
    kind: "mail";
    payload: { receipt: { recipients: string[] }; data: SesInboundMail };
    /** Where the raw email is, for the repair ticket when something could not be read. */
    objectKey: string;
    log?: SesInboundLog;
  };

export type SesInboundDeps = {
  verify: (raw: string, topics: string[]) => Promise<SnsVerdict>;
  confirm: (m: SnsMessage) => Promise<boolean>;
  getObject: (key: string) => Promise<{ bytes: Uint8Array; truncated: boolean }>;
  parse: (bytes: Uint8Array) => ParsedMail;
  configured: () => boolean;
  topics: () => string[];
};

const DEFAULT_DEPS: SesInboundDeps = {
  verify: (raw, topics) => verifySnsMessage(raw, topics),
  confirm: (m) => confirmSnsSubscription(m),
  getObject: (key) => sesGetInboundObject(key),
  parse: (bytes) => parseMime(bytes),
  configured: () => sesInboundConfigured(),
  topics: () => parseTopicArns(Deno.env.get("SES_INBOUND_TOPIC_ARN")),
};

const answer = (status: number, body: Record<string, unknown>, log?: SesInboundLog): SesInboundResult =>
  ({ kind: "answer", status, body, ...(log ? { log } : {}) });

/** Which refusals a second delivery could turn into a success. */
const RETRYABLE_REFUSAL = new Set(["cert_fetch_failed"]);

const str = (v: unknown): string => (typeof v === "string" ? v : "");

/**
 * The sender's address and display name from a decoded From header.
 *
 * mimeParse decodes RFC 2047 words, so a display name can contain anything, angle brackets
 * included: `=?utf-8?Q?=3Cboss=40example.com=3E?= <someone@example.net>` reads
 * `<boss@example.com> <someone@example.net>` once decoded. The real address is the LAST
 * angle-bracket pair, because the display name always comes before it. A header with no angle
 * brackets is a bare address. Exported for the tests.
 */
export function senderOf(fromHeader: string): { email: string; name: string | null } {
  const s = String(fromHeader ?? "").trim();
  const angle = /<([^<>\s]+@[^<>\s]+)>[^<>]*$/.exec(s);
  if (angle) {
    const name = s.slice(0, angle.index).replace(/[<>"]/g, " ").replace(/\s+/g, " ").trim();
    return { email: angle[1].toLowerCase(), name: name || null };
  }
  const bare = /[^\s<>"(),;:]+@[^\s<>"(),;:]+/.exec(s)?.[0] ?? "";
  return { email: bare.toLowerCase(), name: null };
}

/** PASS / FAIL / GRAY / PROCESSING_FAILED as one lowercase word a verdict line can carry. */
function verdictWord(v: unknown): string {
  const s = str((v as { status?: unknown } | null)?.status).toUpperCase();
  if (s === "PASS") return "pass";
  if (s === "FAIL") return "fail";
  if (s === "GRAY") return "gray";
  return s ? "error" : "";
}

/**
 * Write the signed notice's verdicts over the email's own verdict headers, in the spelling
 * emailInbound.ts senderVerdict reads (the one SES itself writes), so the stored spam_verdict
 * says exactly what it said for Resend-era rows: `spam=PASS virus=PASS spf=pass dkim=pass
 * dmarc=pass`. A verdict the notice does not carry leaves NO header behind, the sender's
 * included: "we were told nothing" must never read as the sender's own claim.
 */
function applyVerdicts(headers: Record<string, string>, receipt: Record<string, unknown>): void {
  for (const h of ["x-ses-spam-verdict", "x-ses-virus-verdict", "x-spam-status", "received-spf", "authentication-results"]) delete headers[h];
  const spam = verdictWord(receipt.spamVerdict);
  const virus = verdictWord(receipt.virusVerdict);
  if (spam) headers["x-ses-spam-verdict"] = spam.toUpperCase();
  if (virus) headers["x-ses-virus-verdict"] = virus.toUpperCase();
  const auth = (["spf", "dkim", "dmarc"] as const)
    .map((k) => [k, verdictWord(receipt[`${k}Verdict`])] as const)
    .filter(([, w]) => w)
    .map(([k, w]) => `${k}=${w}`);
  if (auth.length) headers["authentication-results"] = `amazonses.com; ${auth.join("; ")}`;
}

/**
 * One raw SNS POST body to either an answer for SNS or a received email.
 * Never throws. `deps` is for the tests.
 */
export async function readSesInbound(rawBody: string, deps: Partial<SesInboundDeps> = {}): Promise<SesInboundResult> {
  const d: SesInboundDeps = { ...DEFAULT_DEPS, ...deps };
  try {
    const topics = d.topics();
    if (topics.length === 0) {
      // Not set up yet. 503 so the notice comes back once the setting is in place.
      return answer(503, { ok: false, error: "not configured" }, {
        code: "ses_inbound_not_configured", message: "SES_INBOUND_TOPIC_ARN is not set; an SNS notice was turned away to be retried.",
      });
    }
    const verdict = await d.verify(rawBody, topics);
    if (!verdict.ok) {
      const retry = RETRYABLE_REFUSAL.has(verdict.reason);
      return answer(retry ? 503 : 403, { ok: false, error: "not accepted" }, {
        code: "ses_inbound_sns_refused",
        message: `an SNS notice was refused: ${verdict.reason}`,
        // A stranger posting junk at a public URL is expected traffic, not a fault.
        severity: retry ? "error" : "warn",
        context: { reason: verdict.reason },
      });
    }
    const sns = verdict.message;

    if (sns.Type === "SubscriptionConfirmation") {
      const ok = await d.confirm(sns);
      return ok
        ? answer(200, { ok: true, confirmed: true }, { code: "ses_inbound_subscribed", message: "the SNS subscription for received email was confirmed", severity: "info" })
        : answer(503, { ok: false, error: "confirmation failed" }, { code: "ses_inbound_subscribe_failed", message: "the SNS subscription for received email could not be confirmed; SNS will send it again" });
    }
    if (sns.Type === "UnsubscribeConfirmation") {
      // Someone removed the subscription. Nothing is confirmed back (that would re-subscribe);
      // it is said loudly, because from now on no reply reaches the product.
      return answer(200, { ok: true, ignored: "unsubscribed" }, { code: "ses_inbound_unsubscribed", message: "the SNS subscription for received email was REMOVED: replies have stopped arriving" });
    }

    let notice: Record<string, unknown>;
    try {
      notice = JSON.parse(sns.Message) as Record<string, unknown>;
    } catch {
      // SES's own "topic validated" note is plain text. Not an email.
      return answer(200, { ok: true, ignored: "not an email notice" });
    }
    if (!notice || typeof notice !== "object" || notice.notificationType !== "Received") {
      return answer(200, { ok: true, ignored: "not an email notice" });
    }
    const receipt = (notice.receipt && typeof notice.receipt === "object" ? notice.receipt : {}) as Record<string, unknown>;
    const mail = (notice.mail && typeof notice.mail === "object" ? notice.mail : {}) as Record<string, unknown>;
    const action = (receipt.action && typeof receipt.action === "object" ? receipt.action : {}) as Record<string, unknown>;
    const recipients = Array.isArray(receipt.recipients) ? receipt.recipients.filter((r): r is string => typeof r === "string") : [];
    const objectKey = str(action.objectKey);
    if (str(action.type) !== "S3" || !objectKey) {
      return answer(200, { ok: true, ignored: "no stored email" }, {
        code: "ses_inbound_no_object", message: "a Received notice named no S3 object; the receiving rule may have changed", context: { actionType: str(action.type) || null },
      });
    }
    if (!d.configured()) {
      return answer(503, { ok: false, error: "not configured" }, {
        code: "ses_inbound_not_configured", message: "the SES key or SES_INBOUND_BUCKET is not set; a received email was turned away to be retried", context: { objectKey },
      });
    }

    // ── The raw email ────────────────────────────────────────────────────────────────────
    let parsed: ParsedMail | null = null;
    let log: SesInboundLog | undefined;
    try {
      const obj = await d.getObject(objectKey);
      parsed = d.parse(obj.bytes);
      if (obj.truncated) {
        log = { code: "ses_inbound_truncated", severity: "warn", message: "a received email was longer than the read limit; its tail (attachments) was not read", context: { objectKey } };
      }
    } catch (e) {
      const permanent = e instanceof SesApiError && e.permanent;
      const why = e instanceof SesApiError ? `${e.status}/${e.name_ || "unknown"}` : String((e as Error)?.message ?? e).slice(0, 200);
      if (!permanent) {
        // The bucket did not answer, or the key is being rotated. SNS brings the notice back.
        return answer(503, { ok: false, error: "could not read the email yet" }, {
          code: "inbound_body_fetch_failed", message: `could not read a received email from the bucket (will be retried): ${why}`, context: { objectKey, retried: true },
        });
      }
      // The object is gone or was never there: a second try reads the same nothing. The reply is
      // still filed, from what the notice itself says, because a reply with a missing body beats
      // a reply dropped. This row is the repair ticket.
      log = { code: "inbound_body_fetch_failed", message: `could not read a received email from the bucket: ${why}`, context: { objectKey, retried: false } };
    }

    const common = (mail.commonHeaders && typeof mail.commonHeaders === "object" ? mail.commonHeaders : {}) as Record<string, unknown>;
    const firstOf = (v: unknown): string => (Array.isArray(v) ? str(v[0]) : str(v));
    const headers: Record<string, string> = { ...(parsed?.headers ?? {}) };
    applyVerdicts(headers, receipt);

    // The parsed email first; the notice's own copy of a header only when the body was unreadable.
    let from = senderOf(parsed?.from || firstOf(common.from));
    // No usable From at all: the envelope sender is at least where the mail came from.
    if (!from.email.includes("@")) from = { email: str(mail.source).toLowerCase(), name: null };
    // Display only (email-inbound never picks a tenant from it). A To header can list several
    // people; the first address is what the record shows, and with none the envelope's.
    const toHeader = parsed?.to || firstOf(common.to);
    const firstTo = /[^\s<>"(),;:]+@[^\s<>"(),;:]+/.exec(toHeader)?.[0] ?? recipients[0] ?? "";
    const data: SesInboundMail = {
      from,
      to: firstTo,
      subject: parsed?.subject || str(common.subject),
      text: parsed?.text ?? "",
      html: parsed?.html ?? "",
      headers,
      // An email with no Message-ID of its own still needs one: it is the idempotency key SNS's
      // at-least-once delivery relies on. SES's id for the received message is unique and stable.
      message_id: parsed?.messageId || str(common.messageId) || `<${objectKey.split("/").pop()}@inbound.ses>`,
      in_reply_to: parsed?.inReplyTo ?? "",
      references: parsed?.references ?? "",
      attachments: (parsed?.attachments ?? []).map((a) => ({ filename: a.filename })),
    };
    return { kind: "mail", payload: { receipt: { recipients }, data }, objectKey, ...(log ? { log } : {}) };
  } catch (e) {
    // Nothing above is expected to throw. If it does, ask SNS to try again and say so.
    return answer(503, { ok: false, error: "unexpected" }, {
      code: "ses_inbound_unhandled", message: `reading an SNS notice failed unexpectedly: ${String((e as Error)?.message ?? e).slice(0, 200)}`,
    });
  }
}
