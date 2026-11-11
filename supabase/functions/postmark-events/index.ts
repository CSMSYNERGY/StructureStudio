import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { logEdgeError, withErrorLog } from "../_shared/logError.ts";
import { readSesEvent } from "../_shared/sesEvents.ts";

// Provider events → email_sends ledger: the delivery/open/bounce return leg.
//
// PROVIDER SWAPPED 2026-08-21 (Postmark → Resend, migration 113). The send path is
// _shared/emailSend.ts on top of _shared/resend.ts, and it records the id Resend returns
// in email_sends.provider_message_id. This function is that ledger's return leg: it takes
// the delivery/open/bounce/complaint events Resend POSTs and records them on the row, so the
// ledger reflects what actually happened after "sent" — the record page's History and the phone
// app's bubbles read these columns.
//
// OPENS (B4, migration 262, 2026-10-04). Carolyn, 2026-10-01: "One of the potential clients to
// sign up asked to be able to see if an email is read or not." `email.opened` is recorded too
// now: the earliest open time and a count. Resend only reports opens for a domain whose tracking
// subdomain is set up (see _shared/resend.ts rsEnableOpenTracking), and opens are approximate by
// nature — some mail apps block the tracking image, some open mail by themselves.
//
// The Postmark event shape it used to parse (RecordType/MessageID, matched against
// email_sends.postmark_message_id) is GONE, not kept as a fallback: the Postmark account
// was declined, no Postmark webhook exists to post here, and postmark_message_id is
// documented DEAD in 113 — null on every row. A second branch matching a dead column would
// only look like a working consumer.
//
// THE FUNCTION NAME IS DELIBERATELY UNCHANGED. Renaming it would mean a new URL, a new
// config.toml block and a re-registration on the provider side for zero behavioural gain;
// the name is a deployment address, not a claim about who posts here. It is also why this is
// not a second, `email-events` function: this one already was it.
//
// ONE DATABASE CALL, record_email_event (migration 262), and it is the whole write. It finds the
// send by provider_message_id, applies the event, and keeps the event's id in the same
// transaction, so:
//   • IDEMPOTENT. Resend retries a failed delivery and replays any message from its dashboard,
//     succeeded ones included. The id is Resend's `svix-id` header, the same on every retry and
//     replay; an id already applied changes nothing. Without it every retried open counts twice.
//     A post with no svix-id (a hand-made test) falls back to a key built from the event's own
//     type, email id and time, which a retry repeats exactly — see eventKey.
//   • ORDER-PROOF. Times keep the earliest seen, and a late delivery never undoes a bounce.
//   • An open needs `open_count = open_count + 1`, which PostgREST's update cannot say. That is
//     why this is a function and not the `.update()` it used to be.
//
// Auth: the provider posts server-to-server and cannot send a Supabase JWT, so this
// function is deployed with verify_jwt = false (config.toml) and authenticates by a shared
// secret in the URL (?key= ⇄ EMAIL_EVENTS_SECRET, falling back to the legacy
// POSTMARK_WEBHOOK_SECRET name) compared in constant time — the same pattern as
// feedback-monday-webhook and email-inbound. NO secret set at all refuses everything with a
// 401: until the secret is minted this function is deliberately inert, and "refuse
// everything" is the inert state (a webhook that accepted unauthenticated posts because
// configuration was missing would be an open write path into the ledger).
//
// Resend also signs its webhooks (svix headers). That is NOT verified here, deliberately:
// the shared secret in the URL is the single auth gate, so there is exactly one thing to
// mint, rotate and reason about rather than two half-wired ones. Adding signature
// verification later means SUPERSEDING this gate, not sitting beside it. (The svix-id is read
// only as the idempotency key; it authorizes nothing.)
//
// Deliberate 200s — providers retry non-2xx responses (and eventually suspend a webhook
// that keeps failing), so a non-2xx is reserved for failures a retry can fix:
//   • an event type we don't record — retrying will never make it recordable;
//   • an id matching zero rows (a dashboard test send, a row predating the ledger) —
//     a retry storm over an unmatchable row helps nobody;
//   • an event already applied — the retry it is did its job.
// A database error IS a 500, including "no such function" before migration 262 is applied: Resend
// retries for about a day, so an event that arrives early is recorded once the migration lands.
//
// Never echo the provider payload back in responses or errors: bounce events carry customer
// email addresses and message details, and webhook responses are visible in the provider's
// UI.
//
// AMAZON SES POSTS HERE TOO (2026-11-10), through Amazon SNS. Email is moving from Resend to SES
// one builder at a time, so for a while both providers report here: the same URL, the same
// ?key=, the same record_email_event. An SNS delivery announces itself with the
// `x-amz-sns-message-type` header and is handled by sesEvent() below; everything else is Resend's
// webhook, exactly as before. Three things differ for SES, all in _shared/sesEvents.ts:
//   • the URL key is not the only proof. SNS signs every message, and the signature is VERIFIED
//     (the topic must also be ours, SES_EVENTS_TOPIC_ARN). The key still comes first, so a
//     stranger without it never makes us fetch a certificate.
//   • the idempotency key is the SNS MessageId, the same on every redelivery.
//   • a 5xx is useful: SNS tries again for about an hour, so a database blip costs nothing.
// One extra step exists only for SES: an event whose id matches no row is tried once more by the
// ledger row's own id, which rides on every SES email as a tag (adopt_email_send, migration 383).
// That is how a send whose call timed out, but which went, stops reading "failed".
//
// Required secrets: EMAIL_EVENTS_SECRET (+ the platform SUPABASE_* pair). For SES also
// SES_EVENTS_TOPIC_ARN (the topic's ARN; it carries the AWS account number, so it is a setting
// and never in this public source).
// One-time setup on the provider side: a webhook SEPARATE from the inbound one (each Resend
// webhook has one URL; adding these events to the email.received webhook would post them to
// email-inbound) at <project>/functions/v1/postmark-events?key=<EMAIL_EVENTS_SECRET>, subscribed
// to email.delivered, email.opened, email.bounced, email.complained, email.suppressed and
// email.failed. Until that endpoint exists nothing posts here and every send stays at 'sent'
// forever.
//
// ⚠️ THE LAST TWO ARE EMAILS THAT NEVER LEFT. Resend's API accepts a send and hands back an id,
// so sendTenantEmail stores 'sent', and only then decides not to send it:
//   • email.suppressed — the address is on Resend's suppression list, which a bounce or a spam
//     complaint adds it to, and which covers the WHOLE Resend account. Every builder sends from
//     the one CSM account, so a customer who bounced or reported one builder's email is skipped
//     for every other builder too. Recorded as a bounce (status 'bounced', so the phone says "Not
//     sent" and the portal "Bounced"), with a reason that says why.
//   • email.failed — sending failed after it was accepted (a quota, a domain problem). Recorded
//     as 'failed' with Resend's reason, NOT as a bounce: the address is not the problem.
// Without these two, both read 'Sent' for good.

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

/** Constant-time string compare (same as feedback-monday-webhook). Exported for tests. */
export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let out = 0;
  for (let i = 0; i < a.length; i++) out |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return out === 0;
}

/** Trimmed string or "" — provider fields are all optional in practice. */
function str(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

/** The five events record_email_event knows (migration 262's CHECK on email_send_events). */
export type RecordedEvent = "delivered" | "opened" | "bounced" | "complained" | "failed";

export type MappedEvent = {
  /** Resend's email id: what emailSend.ts stored in provider_message_id. */
  messageId: string;
  event: RecordedEvent;
  /** When it happened, ISO. */
  at: string;
  /** Bounces and failures only: why, capped. */
  reason: string | null;
};

/**
 * Map one Resend event to what record_email_event needs. Pure — exported for tests.
 * Returns null for anything we don't record (unrecorded event type, missing email id);
 * null means "answer 200 and move on", never an error.
 *
 * Event shape: { type, created_at, data: { email_id, … } }. `data.email_id` is the same id
 * rsSendEmail returned at send time, which emailSend.ts stored in provider_message_id.
 */
export function mapEvent(body: unknown): MappedEvent | null {
  if (!body || typeof body !== "object") return null;
  const b = body as Record<string, unknown>;
  const data = (b.data && typeof b.data === "object" ? b.data : {}) as Record<string, unknown>;

  const messageId = str(data.email_id);
  if (!messageId) return null;

  // The TOP-LEVEL created_at is when the event happened; data.created_at is when the email
  // was created, which would date a bounce (or an open) to the send. A value that is not a time
  // falls back to now: handed to Postgres as-is it would fail the call, and the 500 would have
  // Resend retry the same unreadable time for a day.
  const t = Date.parse(str(b.created_at));
  const at = Number.isFinite(t) ? new Date(t).toISOString() : new Date().toISOString();

  switch (b.type) {
    case "email.delivered":
      return { messageId, event: "delivered", at, reason: null };

    case "email.opened":
      return { messageId, event: "opened", at, reason: null };

    case "email.bounced": {
      // Resend nests the classification under data.bounce ({type, subType, message}) on
      // current payloads and omits it on older ones. Capped — bounce_reason is a short
      // diagnostic, not a transcript.
      const bounce = (data.bounce && typeof data.bounce === "object" ? data.bounce : {}) as Record<string, unknown>;
      const cls = str(bounce.type) || "Bounce";
      const sub = str(bounce.subType);
      const msg = str(bounce.message);
      return { messageId, event: "bounced", at, reason: `${cls}${sub ? `/${sub}` : ""}${msg ? `: ${msg}` : ""}`.slice(0, 300) };
    }

    case "email.complained":
      // The recipient marked it as spam. record_email_event keeps it in complained_at (migration
      // 262) and NOT as a bounce: the email arrived, so the status and the bounce fields are left
      // alone, and the portal shows "Marked as spam". No reason: there is nothing to say but that.
      return { messageId, event: "complained", at, reason: null };

    case "email.suppressed": {
      // Accepted, then never sent: the address is on Resend's account-wide suppression list
      // because an earlier email to it bounced or was reported as spam (see the header). A bounce
      // in all but name: the email did not reach them, and sending again will not either. The
      // reason is ours, in words a builder can act on; Resend's own message is about its bounce
      // rate. Its type (e.g. OnAccountSuppressionList) is kept for whoever looks closer.
      const sup = (data.suppressed && typeof data.suppressed === "object" ? data.suppressed : {}) as Record<string, unknown>;
      const kind = str(sup.type);
      return {
        messageId, event: "bounced", at,
        reason: `Not sent: an earlier email to this address bounced or was marked as spam${kind ? ` (${kind})` : ""}`.slice(0, 300),
      };
    }

    case "email.failed": {
      // Accepted, then sending failed (Resend's examples: a daily quota, a domain verification
      // problem). Not the address's fault, so not a bounce: record_email_event marks it failed.
      const failed = (data.failed && typeof data.failed === "object" ? data.failed : {}) as Record<string, unknown>;
      const why = str(failed.reason);
      return { messageId, event: "failed", at, reason: `Not sent${why ? `: ${why}` : ""}`.slice(0, 300) };
    }

    default:
      // email.sent / email.delivery_delayed / email.clicked / anything Resend adds later — not
      // ours to record. delivery_delayed especially: it is NOT terminal, and 113 rules it out of
      // the status vocabulary on purpose. Clicks are not tracked at all (rsEnableOpenTracking
      // never turns click tracking on: it rewrites every link in the email).
      return null;
  }
}

/** What an svix-id looks like ("msg_" + base62 today); anything else is not trusted as a key. */
const SVIX_ID_RE = /^[A-Za-z0-9_.:-]{1,128}$/;

/**
 * The idempotency key for one event. Pure — exported for tests.
 *
 * The svix-id header first: Resend (through Svix) sends the same one on every retry and replay
 * of a message, and a different one for every other message. Without it (a hand-made post), a
 * key built from the event itself — type, email id and the event's own created_at — which a
 * retry repeats byte for byte. With neither (no created_at either), null: the event is still
 * recorded, just without protection against a repeat; refusing it would lose a real open over a
 * missing header.
 */
export function eventKey(svixId: string | null, body: unknown, mapped: MappedEvent): string | null {
  const id = str(svixId);
  if (SVIX_ID_RE.test(id)) return id;
  const created = body && typeof body === "object" ? str((body as Record<string, unknown>).created_at) : "";
  if (!created) return null;
  return `derived:${mapped.event}:${mapped.messageId}:${created}`.slice(0, 200);
}

/** Responses whose app_errors row was written here, with its own code and context, so
 *  withErrorLog does not add a second, vaguer row for the same answer (customer-auth's pattern). */
const filedAtReturnSite = new WeakSet<Response>();

/** "No such function": the database is from before migration 383. Both spellings PostgREST and
 *  Postgres use for it. */
const NO_SUCH_FUNCTION = new Set(["PGRST202", "42883"]);

/**
 * One Amazon SES event, delivered by Amazon SNS. The request is already past the URL key.
 * _shared/sesEvents.ts proves the message is SNS's and from our topic and maps it; this writes it
 * through the same record_email_event the Resend path uses.
 */
async function sesEvent(req: Request): Promise<Response> {
  const read = await readSesEvent(await req.text());
  if (read.kind === "answer") {
    const res = json(read.body, read.status);
    if (read.log) {
      await logEdgeError({ fn: "postmark-events", req, ...read.log });
      filedAtReturnSite.add(res);
    }
    return res;
  }
  const { event, eventId } = read;
  const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  const record = () => admin.rpc("record_email_event", {
    p_provider_message_id: event.messageId,
    p_event: event.event,
    p_at: event.at,
    p_reason: event.reason,
    p_event_id: eventId,
  });

  let { data, error } = await record();
  // No row holds this id. If the email carried its ledger row's id (every SES send does), the
  // row is one whose send call lost SES's answer: give it the id, then record the event.
  if (!error && data === "unknown" && event.sendId) {
    const adopt = await admin.rpc("adopt_email_send", { p_send_id: event.sendId, p_provider_message_id: event.messageId });
    if (adopt.error && !NO_SUCH_FUNCTION.has(String((adopt.error as { code?: string }).code ?? ""))) {
      error = adopt.error;
    } else if (adopt.data === true) {
      ({ data, error } = await record());
    }
  }

  if (error) {
    // Same posture as the Resend path below: specifics to app_errors, a generic answer to the
    // provider. A 500 here is deliberate: SNS delivers the event again.
    await logEdgeError({
      fn: "postmark-events",
      message: String(error.message ?? "record_email_event failed"),
      code: "email_event_record_failed",
      req,
      context: { event: event.event, provider: "ses", pgCode: (error as { code?: string }).code ?? null },
    });
    const res = json({ ok: false, error: "update failed" }, 500);
    filedAtReturnSite.add(res);
    return res;
  }

  const result = typeof data === "string" ? data : "";
  // THE COMPLAINT WATCH. Every builder sends from the one AWS account, and AWS reviews an
  // account at a complaint rate of 0.1% (one in a thousand), so a single builder drawing
  // complaints is everyone's problem. One warn row per real complaint, with the builder it was
  // sent for, makes that visible here before AWS says it. No address, no message.
  if (event.event === "complained" && result === "recorded") {
    await logEdgeError({
      fn: "postmark-events", req, clientId: event.clientId, code: "email_complaint", severity: "warn",
      message: "a recipient marked an email as spam (Amazon SES complaint)",
    });
  }
  if (result === "duplicate") return json({ ok: true, duplicate: true, updated: 0 });
  return json({ ok: true, updated: result === "recorded" ? 1 : 0 });
}

async function handler(req: Request): Promise<Response> {
  if (req.method === "GET") return json({ ok: true, service: "postmark-events" });
  if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });

  // EMAIL_EVENTS_SECRET is the provider-neutral name; POSTMARK_WEBHOOK_SECRET is read as a
  // legacy fallback so a secret already minted under the old name keeps working. NEITHER set
  // still refuses — no fail-open when configuration is missing.
  const secret = Deno.env.get("EMAIL_EVENTS_SECRET") || Deno.env.get("POSTMARK_WEBHOOK_SECRET") || "";
  const key = new URL(req.url).searchParams.get("key") || "";
  // Amazon SNS posts with a key of its own, SES_WEBHOOK_SECRET (2026-11-10), which opens ONLY
  // the SNS path below, where the message's signature is verified as well. The key above opens
  // both, as before. (email-inbound's key check says why a second key exists.)
  const viaSns = Boolean(req.headers.get("x-amz-sns-message-type"));
  const sesSecret = Deno.env.get("SES_WEBHOOK_SECRET") || "";
  const keyOk = (!!secret && timingSafeEqual(key, secret)) || (viaSns && !!sesSecret && timingSafeEqual(key, sesSecret));
  if (!keyOk) {
    return new Response("Unauthorized", { status: 401 });
  }

  // Amazon SES, by way of Amazon SNS: see the header. After the key, before the body is read
  // (the signature is over the raw text, which req.json() would destroy).
  if (viaSns) return await sesEvent(req);

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return new Response("Bad JSON", { status: 400 });
  }

  const mapped = mapEvent(body);
  if (!mapped) return json({ ok: true, ignored: "unhandled record type" });

  const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  const { data, error } = await admin.rpc("record_email_event", {
    p_provider_message_id: mapped.messageId,
    p_event: mapped.event,
    p_at: mapped.at,
    p_reason: mapped.reason,
    p_event_id: eventKey(req.headers.get("svix-id"), body, mapped),
  });

  if (error) {
    // The Postgres message can carry row values (the dbFail lesson) and this response goes
    // back to the provider — log the specifics to app_errors, answer generically. The
    // context carries OUR mapped event, never a field copied out of the payload.
    await logEdgeError({
      fn: "postmark-events",
      message: String(error.message ?? "record_email_event failed"),
      code: "email_event_record_failed",
      req,
      context: { event: mapped.event, pgCode: (error as { code?: string }).code ?? null },
    });
    return json({ ok: false, error: "update failed" }, 500);
  }

  // 'unknown' (no such send), 'duplicate' (already applied) and 'capped' (an email that already
  // has 25 opens; 262 stops counting there) are all a 200 — see the header.
  const result = typeof data === "string" ? data : "";
  if (result === "duplicate") return json({ ok: true, duplicate: true, updated: 0 });
  return json({ ok: true, updated: result === "recorded" ? 1 : 0 });
}

Deno.serve(withErrorLog("postmark-events", handler, { alreadyFiled: (res) => filedAtReturnSite.has(res) }));
