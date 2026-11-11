/**
 * Amazon SES delivery events (delivered, bounced, complained, rejected), as the email ledger
 * already records them.
 *
 * WHY THIS FILE EXISTS (2026-11-10). postmark-events records what happened to an email after
 * "sent" by calling record_email_event (migration 262), fed until now by Resend's webhook. SES
 * reports the same things through its configuration set's event feed, an Amazon SNS topic. This
 * file takes one SNS POST from raw body to the SAME five events record_email_event knows, so the
 * ledger, the record page and the phone app need no change.
 *
 * WHAT STOPS MAIL TO A BAD ADDRESS is not here. SES keeps an account-level suppression list
 * (hard bounces and complaints, switched on for the account and inherited by the configuration
 * set): a later send to a listed address is accepted and then NOT delivered, and reported here
 * as a bounce with subtype OnAccountSuppressionList. That is recorded with the same sentence
 * Resend's `email.suppressed` gets, because it is the same thing: accepted, never sent, and
 * sending again will not help. The list is account-wide, as Resend's was.
 *
 * TWO IDS COME BACK ON EVERY EVENT, and the second is what makes a lost answer recoverable:
 *   • mail.messageId, the id SendEmail returned, which emailSend.ts stored in provider_message_id;
 *   • mail.tags.ss_send, the ledger row's own id, which emailSend.ts put on the email as a tag.
 *     When our send call timed out before SES answered, the row has no provider id to match on;
 *     the tag still names it (postmark-events adopts the id onto the row, migration 383).
 *
 * In _shared rather than in postmark-events/index.ts because that file calls Deno.serve at the
 * top level and cannot be imported by a test.
 */

import { confirmSnsSubscription, parseTopicArns, verifySnsMessage, type SnsMessage, type SnsVerdict } from "./snsVerify.ts";

/** The five events record_email_event knows (postmark-events' RecordedEvent). */
export type SesRecordedEvent = "delivered" | "opened" | "bounced" | "complained" | "failed";

export type SesMappedEvent = {
  /** SES's id for the email: what emailSend.ts stored in provider_message_id. */
  messageId: string;
  event: SesRecordedEvent;
  /** When it happened, ISO. */
  at: string;
  /** Bounces and failures only: why, capped, with any address masked. */
  reason: string | null;
  /** The email_sends row id from the ss_send tag, or null when the email carried none. */
  sendId: string | null;
  /** The builder from the client_id tag, for the complaint watch. Never used to find a row. */
  clientId: string | null;
};

export type SesEventLog = { code: string; message: string; severity?: "error" | "warn" | "info"; context?: Record<string, unknown> };

export type SesEventResult =
  | { kind: "answer"; status: number; body: Record<string, unknown>; log?: SesEventLog }
  /** `eventId` is the SNS MessageId: the same on every redelivery, so record_email_event's
   *  "seen before" check makes a retried event change nothing. */
  | { kind: "event"; event: SesMappedEvent; eventId: string };

export type SesEventDeps = {
  verify: (raw: string, topics: string[]) => Promise<SnsVerdict>;
  confirm: (m: SnsMessage) => Promise<boolean>;
  topics: () => string[];
};

const DEFAULT_DEPS: SesEventDeps = {
  verify: (raw, topics) => verifySnsMessage(raw, topics),
  confirm: (m) => confirmSnsSubscription(m),
  topics: () => parseTopicArns(Deno.env.get("SES_EVENTS_TOPIC_ARN")),
};

const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "");
const obj = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : {});
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The sentence a suppressed send gets, word for word what postmark-events writes for Resend's
 *  `email.suppressed`, so a builder reads one thing whichever provider it was. */
const SUPPRESSED = "Not sent: an earlier email to this address bounced or was marked as spam";
const SUPPRESSED_SUBTYPES = new Set(["OnAccountSuppressionList", "OnTenantSuppressionList", "Suppressed"]);

/** An ISO time from SES's timestamp, or now when it is missing or unreadable: handed to Postgres
 *  as-is, a bad time would fail the call and SNS would retry the same bad time for an hour. */
function isoOf(v: unknown): string {
  const t = Date.parse(str(v));
  return Number.isFinite(t) ? new Date(t).toISOString() : new Date().toISOString();
}

/** A receiving server's own words name the address it refused. bounce_reason is shown on a
 *  builder's screen and copied into support tickets, so the address is masked. */
function maskAddresses(s: string): string {
  return s.replace(/[^\s@<>()"',;:]+@[^\s@<>()"',;:]+/g, "[address]").replace(/\s+/g, " ").trim();
}

function firstTag(tags: Record<string, unknown>, name: string): string {
  const v = tags[name];
  return Array.isArray(v) ? str(v[0]) : str(v);
}

/**
 * Map one SES event to what record_email_event needs. Pure; exported for tests. Null for
 * anything not recorded (an event type we do not keep, or no message id): the caller answers
 * 200 and moves on.
 *
 * The type is `eventType` on a configuration set's feed, which is what we subscribe to. An
 * identity-level notification spells it `notificationType`; both are read so a topic wired the
 * other way still records.
 */
export function mapSesEvent(notice: unknown): SesMappedEvent | null {
  const n = obj(notice);
  const mail = obj(n.mail);
  const messageId = str(mail.messageId);
  if (!messageId) return null;
  const tags = obj(mail.tags);
  const send = firstTag(tags, "ss_send");
  const client = firstTag(tags, "client_id");
  const base = {
    messageId,
    sendId: UUID_RE.test(send) ? send.toLowerCase() : null,
    clientId: /^[a-z0-9][a-z0-9-]{0,62}$/.test(client) ? client : null,
  };

  switch (str(n.eventType) || str(n.notificationType)) {
    case "Delivery":
      return { ...base, event: "delivered", at: isoOf(obj(n.delivery).timestamp), reason: null };

    case "Open":
      // Not switched on yet (the configuration set does not publish opens). Mapped so the day it
      // is, nothing here has to change.
      return { ...base, event: "opened", at: isoOf(obj(n.open).timestamp), reason: null };

    case "Bounce": {
      const b = obj(n.bounce);
      const type = str(b.bounceType) || "Bounce";
      const sub = str(b.bounceSubType);
      if (SUPPRESSED_SUBTYPES.has(sub)) {
        return { ...base, event: "bounced", at: isoOf(b.timestamp), reason: `${SUPPRESSED} (${sub})`.slice(0, 300) };
      }
      // A Transient bounce reaches us only once SES has stopped trying, so it too is an email
      // that did not arrive. The type is kept in the reason: "Transient/MailboxFull" tells a
      // builder to try again later, "Permanent/General" that the address is wrong.
      const first = obj(Array.isArray(b.bouncedRecipients) ? b.bouncedRecipients[0] : null);
      const why = maskAddresses(str(first.diagnosticCode));
      return { ...base, event: "bounced", at: isoOf(b.timestamp), reason: `${type}${sub ? `/${sub}` : ""}${why ? `: ${why}` : ""}`.slice(0, 300) };
    }

    case "Complaint": {
      const c = obj(n.complaint);
      // A "complaint" whose subtype is the suppression list is SES declining to send to someone
      // who complained before: the email never left. Only a real complaint means it arrived and
      // was marked as spam.
      if (SUPPRESSED_SUBTYPES.has(str(c.complaintSubType))) {
        return { ...base, event: "bounced", at: isoOf(c.timestamp), reason: `${SUPPRESSED} (${str(c.complaintSubType)})`.slice(0, 300) };
      }
      return { ...base, event: "complained", at: isoOf(c.timestamp), reason: null };
    }

    case "Reject": {
      // SES accepted the call and then refused to send (a virus in the content). Not the
      // address's fault, so not a bounce: record_email_event marks it failed.
      const why = maskAddresses(str(obj(n.reject).reason));
      return { ...base, event: "failed", at: isoOf(mail.timestamp), reason: `Not sent${why ? `: ${why}` : ""}`.slice(0, 300) };
    }

    default:
      // Send, DeliveryDelay (not terminal), Click, Rendering Failure, Subscription, anything
      // AWS adds later: not ours to record.
      return null;
  }
}

const answer = (status: number, body: Record<string, unknown>, log?: SesEventLog): SesEventResult =>
  ({ kind: "answer", status, body, ...(log ? { log } : {}) });

/**
 * One raw SNS POST body to either an answer for SNS or one event to record. Never throws.
 * Status codes mean what they mean in sesInbound.ts: 4xx ends the delivery, 5xx asks SNS to try
 * again. `deps` is for the tests.
 */
export async function readSesEvent(rawBody: string, deps: Partial<SesEventDeps> = {}): Promise<SesEventResult> {
  const d: SesEventDeps = { ...DEFAULT_DEPS, ...deps };
  try {
    const topics = d.topics();
    if (topics.length === 0) {
      return answer(503, { ok: false, error: "not configured" }, {
        code: "ses_events_not_configured", message: "SES_EVENTS_TOPIC_ARN is not set; an SNS event was turned away to be retried.",
      });
    }
    const verdict = await d.verify(rawBody, topics);
    if (!verdict.ok) {
      const retry = verdict.reason === "cert_fetch_failed";
      return answer(retry ? 503 : 403, { ok: false, error: "not accepted" }, {
        code: "ses_events_sns_refused", message: `an SNS event was refused: ${verdict.reason}`,
        severity: retry ? "error" : "warn", context: { reason: verdict.reason },
      });
    }
    const sns = verdict.message;
    if (sns.Type === "SubscriptionConfirmation") {
      const ok = await d.confirm(sns);
      return ok
        ? answer(200, { ok: true, confirmed: true }, { code: "ses_events_subscribed", message: "the SNS subscription for email events was confirmed", severity: "info" })
        : answer(503, { ok: false, error: "confirmation failed" }, { code: "ses_events_subscribe_failed", message: "the SNS subscription for email events could not be confirmed; SNS will send it again" });
    }
    if (sns.Type === "UnsubscribeConfirmation") {
      return answer(200, { ok: true, ignored: "unsubscribed" }, { code: "ses_events_unsubscribed", message: "the SNS subscription for email events was REMOVED: bounces and complaints have stopped arriving" });
    }
    let notice: unknown;
    try {
      notice = JSON.parse(sns.Message);
    } catch {
      return answer(200, { ok: true, ignored: "not an event" });
    }
    const event = mapSesEvent(notice);
    if (!event) return answer(200, { ok: true, ignored: "unhandled record type" });
    return { kind: "event", event, eventId: `sns:${sns.MessageId}`.slice(0, 200) };
  } catch (e) {
    return answer(503, { ok: false, error: "unexpected" }, {
      code: "ses_events_unhandled", message: `reading an SNS event failed unexpectedly: ${String((e as Error)?.message ?? e).slice(0, 200)}`,
    });
  }
}
