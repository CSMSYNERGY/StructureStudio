import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { logEdgeError, withErrorLog } from "../_shared/logError.ts";

// Postmark → email_sends ledger: the delivery/bounce return leg.
//
// Postmark's server webhook POSTs one JSON event per message state change (we subscribe to
// Delivery + Bounce + SpamComplaint). Each event carries the MessageID Postmark returned at
// send time, which the send path stored on the email_sends row as postmark_message_id; this
// function flips that row's status so the ledger reflects what actually happened after
// "sent" — the Friday delivery verification reads these columns.
//
// Auth: Postmark posts server-to-server and cannot send a Supabase JWT, so this function is
// deployed with verify_jwt = false and authenticates by a shared secret in the URL
// (?key= ⇄ POSTMARK_WEBHOOK_SECRET) compared in constant time — the same pattern as
// feedback-monday-webhook. An UNSET secret refuses everything with a 401: until the secret
// is minted this function is deployed deliberately inert, and "refuse everything" is the
// inert state (a webhook that accepted unauthenticated posts because configuration was
// missing would be an open write path into the ledger).
//
// Two deliberate 200s — Postmark retries non-2xx responses (and eventually suspends a
// webhook that keeps failing), so a non-2xx is reserved for failures a retry can fix:
//   • an event type we don't handle — retrying will never make it handleable;
//   • a MessageID matching zero rows (a dashboard test send, a row predating the ledger) —
//     a retry storm over an unmatchable row helps nobody.
//
// Never echo the provider payload back in responses or errors: bounce events carry customer
// email addresses and message details, and webhook responses are visible in Postmark's UI.
//
// Required secrets: POSTMARK_WEBHOOK_SECRET (+ the platform SUPABASE_* pair).

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

/**
 * Map one Postmark event to the email_sends patch it implies. Pure — exported for tests.
 * Returns null for anything we don't record (unknown RecordType, missing MessageID);
 * null means "answer 200 and move on", never an error.
 */
export function mapEvent(body: unknown): { messageId: string; patch: Record<string, unknown> } | null {
  if (!body || typeof body !== "object") return null;
  const b = body as Record<string, unknown>;
  const messageId = typeof b.MessageID === "string" && b.MessageID ? b.MessageID : "";
  if (!messageId) return null;

  switch (b.RecordType) {
    case "Delivery":
      return {
        messageId,
        patch: {
          status: "delivered",
          delivered_at: typeof b.DeliveredAt === "string" ? b.DeliveredAt : new Date().toISOString(),
        },
      };
    case "Bounce":
      // Type is Postmark's bounce class ("HardBounce", "Transient", …); Description is
      // their prose explanation. Capped — bounce_reason is a short diagnostic, not a
      // transcript, and the raw SMTP Details field is deliberately NOT stored.
      return {
        messageId,
        patch: {
          status: "bounced",
          bounced_at: typeof b.BouncedAt === "string" ? b.BouncedAt : new Date().toISOString(),
          bounce_reason: `${typeof b.Type === "string" ? b.Type : "Bounce"}: ${
            typeof b.Description === "string" ? b.Description : ""
          }`.slice(0, 300),
        },
      };
    case "SpamComplaint":
      // A complaint is terminal for this recipient — recorded as bounced with a fixed
      // reason so the ledger's status vocabulary stays small. No bounced_at: the
      // complaint timestamp is when the recipient clicked "spam", not a delivery event.
      return { messageId, patch: { status: "bounced", bounce_reason: "SpamComplaint" } };
    default:
      // Open/Click/SubscriptionChange/anything Postmark adds later — not ours to record.
      return null;
  }
}

async function handler(req: Request): Promise<Response> {
  if (req.method === "GET") return json({ ok: true, service: "postmark-events" });
  if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });

  const secret = Deno.env.get("POSTMARK_WEBHOOK_SECRET");
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
    .eq("postmark_message_id", mapped.messageId)
    .select("id");

  if (upd.error) {
    // The Postgres message can carry row values (the dbFail lesson) and this response goes
    // back to Postmark — log the specifics to app_errors, answer generically.
    await logEdgeError({
      fn: "postmark-events",
      message: upd.error.message,
      code: "email_sends_update_failed",
      req,
      context: { recordType: String((body as Record<string, unknown>).RecordType ?? "") },
    });
    return json({ ok: false, error: "update failed" }, 500);
  }

  // updated: 0 is still a 200 — see the header.
  return json({ ok: true, updated: upd.data?.length ?? 0 });
}

Deno.serve(withErrorLog("postmark-events", handler));
