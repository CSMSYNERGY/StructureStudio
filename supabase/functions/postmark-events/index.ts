import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { logEdgeError, withErrorLog } from "../_shared/logError.ts";

// Provider events → email_sends ledger: the delivery/bounce return leg.
//
// PROVIDER SWAPPED 2026-08-21 (Postmark → Resend, migration 113). The send path is
// _shared/emailSend.ts on top of _shared/resend.ts, and it records the id Resend returns
// in email_sends.provider_message_id. This function is that ledger's return leg: it takes
// the delivery/bounce/complaint events Resend POSTs and flips the row's status so the
// ledger reflects what actually happened after "sent" — the Friday delivery verification
// reads these columns.
//
// The Postmark event shape it used to parse (RecordType/MessageID, matched against
// email_sends.postmark_message_id) is GONE, not kept as a fallback: the Postmark account
// was declined, no Postmark webhook exists to post here, and postmark_message_id is
// documented DEAD in 113 — null on every row. A second branch matching a dead column would
// only look like a working consumer.
//
// THE FUNCTION NAME IS DELIBERATELY UNCHANGED. Renaming it would mean a new URL, a new
// config.toml block and a re-registration on the provider side for zero behavioural gain;
// the name is a deployment address, not a claim about who posts here.
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
// verification later means SUPERSEDING this gate, not sitting beside it.
//
// Two deliberate 200s — providers retry non-2xx responses (and eventually suspend a webhook
// that keeps failing), so a non-2xx is reserved for failures a retry can fix:
//   • an event type we don't record — retrying will never make it recordable;
//   • an id matching zero rows (a dashboard test send, a row predating the ledger) —
//     a retry storm over an unmatchable row helps nobody.
//
// Never echo the provider payload back in responses or errors: bounce events carry customer
// email addresses and message details, and webhook responses are visible in the provider's
// UI.
//
// Required secrets: EMAIL_EVENTS_SECRET (+ the platform SUPABASE_* pair).
// One-time setup on the provider side: add an endpoint at
// <project>/functions/v1/postmark-events?key=<EMAIL_EVENTS_SECRET> subscribed to
// email.delivered, email.bounced and email.complained. Until that endpoint exists nothing
// posts here and every send stays at 'sent' forever.

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

/**
 * Map one Resend event to the email_sends patch it implies. Pure — exported for tests.
 * Returns null for anything we don't record (unrecorded event type, missing email id);
 * null means "answer 200 and move on", never an error.
 *
 * Event shape: { type, created_at, data: { email_id, … } }. `data.email_id` is the same id
 * rsSendEmail returned at send time, which emailSend.ts stored in provider_message_id.
 *
 * The patch stays inside the status CHECK from 107 ('claimed','sent','failed','delivered',
 * 'bounced'). A wider vocabulary would 23514 the update, so a complaint is recorded as
 * 'bounced' with an authored reason rather than a status of its own.
 */
export function mapEvent(body: unknown): { messageId: string; patch: Record<string, unknown> } | null {
  if (!body || typeof body !== "object") return null;
  const b = body as Record<string, unknown>;
  const data = (b.data && typeof b.data === "object" ? b.data : {}) as Record<string, unknown>;

  const messageId = str(data.email_id);
  if (!messageId) return null;

  // The TOP-LEVEL created_at is when the event happened; data.created_at is when the email
  // was created, which would date a bounce to the send. Falling back to now keeps the
  // column non-null with a time we can defend.
  const at = str(b.created_at) || new Date().toISOString();

  switch (b.type) {
    case "email.delivered":
      return { messageId, patch: { status: "delivered", delivered_at: at } };

    case "email.bounced": {
      // Resend nests the classification under data.bounce ({type, subType, message}) on
      // current payloads and omits it on older ones. Capped — bounce_reason is a short
      // diagnostic, not a transcript.
      const bounce = (data.bounce && typeof data.bounce === "object" ? data.bounce : {}) as Record<string, unknown>;
      const cls = str(bounce.type) || "Bounce";
      const sub = str(bounce.subType);
      const msg = str(bounce.message);
      return {
        messageId,
        patch: {
          status: "bounced",
          bounced_at: at,
          bounce_reason: `${cls}${sub ? `/${sub}` : ""}${msg ? `: ${msg}` : ""}`.slice(0, 300),
        },
      };
    }

    case "email.complained":
      // A complaint is terminal for this recipient — recorded as bounced with a fixed,
      // AUTHORED reason so the ledger's status vocabulary stays small. No bounced_at: the
      // complaint timestamp is when the recipient clicked "spam", not a delivery event.
      return { messageId, patch: { status: "bounced", bounce_reason: "Complaint: recipient reported this as spam" } };

    default:
      // email.sent / email.delivery_delayed / email.opened / email.clicked / anything Resend
      // adds later — not ours to record. delivery_delayed especially: it is NOT terminal,
      // and 113 rules it out of the status vocabulary on purpose.
      return null;
  }
}

async function handler(req: Request): Promise<Response> {
  if (req.method === "GET") return json({ ok: true, service: "postmark-events" });
  if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });

  // EMAIL_EVENTS_SECRET is the provider-neutral name; POSTMARK_WEBHOOK_SECRET is read as a
  // legacy fallback so a secret already minted under the old name keeps working. NEITHER set
  // still refuses — no fail-open when configuration is missing.
  const secret = Deno.env.get("EMAIL_EVENTS_SECRET") || Deno.env.get("POSTMARK_WEBHOOK_SECRET") || "";
  const key = new URL(req.url).searchParams.get("key") || "";
  if (!secret || !timingSafeEqual(key, secret)) {
    return new Response("Unauthorized", { status: 401 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return new Response("Bad JSON", { status: 400 });
  }

  const mapped = mapEvent(body);
  if (!mapped) return json({ ok: true, ignored: "unhandled record type" });

  const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  const upd = await admin
    .from("email_sends")
    .update({ ...mapped.patch, updated_at: new Date().toISOString() })
    .eq("provider_message_id", mapped.messageId)
    .select("id");

  if (upd.error) {
    // The Postgres message can carry row values (the dbFail lesson) and this response goes
    // back to the provider — log the specifics to app_errors, answer generically. The
    // context carries OUR mapped status, never a field copied out of the payload.
    await logEdgeError({
      fn: "postmark-events",
      message: upd.error.message,
      code: "email_sends_update_failed",
      req,
      context: { status: String(mapped.patch.status ?? "") },
    });
    return json({ ok: false, error: "update failed" }, 500);
  }

  // updated: 0 is still a 200 — see the header.
  return json({ ok: true, updated: upd.data?.length ?? 0 });
}

Deno.serve(withErrorLog("postmark-events", handler));
