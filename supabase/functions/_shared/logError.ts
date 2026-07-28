// Durable error logging for edge functions → public.app_errors (service role).
//
// WHY THIS EXISTS
// ---------------
// The browser apps (designer, portal, admin) have logged to app_errors since
// migration 028, but NONE of the 11 edge functions recorded anything. A failing
// submit-estimate, billing-webhook, or capture-lead existed only in Supabase's
// function logs until those aged out — so the server half of every money path was
// invisible to triage. `select * from app_errors` looked clean while customers were
// losing estimates.
//
// HARD RULES (same as BuildBridge's errorLogService):
//   1. NEVER throw. Logging a failure must not become a second failure, and must
//      never change what the caller receives.
//   2. NEVER recurse. This module catches its own errors and reports them to the
//      console only.
//   3. NEVER persist secrets. Callers pass `context` deliberately; don't hand it raw
//      request bodies, tokens, or service keys.

import { createClient } from "jsr:@supabase/supabase-js@2";

const MAX_MESSAGE = 4000;
const MAX_CODE = 100;
const MAX_URL = 600;
const MAX_UA = 400;
const MAX_CONTEXT_BYTES = 8000;

export interface EdgeErrorInput {
  /** Function name, e.g. 'submit-estimate' → stored as source 'edge:submit-estimate'. */
  fn: string;
  message: string;
  /** HTTP status or app code. */
  code?: string | number | null;
  /** The request, used for url + user-agent only. */
  req?: Request | null;
  clientId?: string | null;
  context?: Record<string, unknown> | null;
}

function truncate(value: string | null | undefined, max: number): string | null {
  if (!value) return null;
  return value.length > max ? value.slice(0, max) : value;
}

/** Insert one error row. Resolves even when logging fails. */
export async function logEdgeError(input: EdgeErrorInput): Promise<void> {
  try {
    const url = Deno.env.get("SUPABASE_URL");
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    if (!url || !serviceKey) return; // nothing to write with — console already has it

    let path: string | null = null;
    let userAgent: string | null = null;
    if (input.req) {
      try {
        path = new URL(input.req.url).pathname;
      } catch { /* unparsable url — leave null */ }
      userAgent = input.req.headers.get("user-agent");
    }

    let context = input.context ?? null;
    if (context) {
      try {
        const encoded = JSON.stringify(context);
        if (encoded.length > MAX_CONTEXT_BYTES) {
          context = { _truncated: true, bytes: encoded.length };
        }
      } catch {
        context = null; // unserializable (cycles) — not worth failing over
      }
    }

    const sb = createClient(url, serviceKey);
    const { error } = await sb.from("app_errors").insert({
      source: `edge:${input.fn}`.slice(0, 100),
      severity: "error",
      code: truncate(input.code == null ? null : String(input.code), MAX_CODE),
      message: truncate(input.message || "unknown error", MAX_MESSAGE),
      url: truncate(path, MAX_URL),
      user_agent: truncate(userAgent, MAX_UA),
      client_id: truncate(input.clientId ?? null, 100),
      context,
    });
    if (error) console.warn(`[logError] insert failed: ${error.message}`);
  } catch (e) {
    // Rule 2: the logger's own failure is never fed back into the logger.
    console.warn(`[logError] threw: ${(e as Error)?.message}`);
  }
}

/** Pull an { error } / { message } string out of a JSON response body, if present. */
function messageFromBody(body: string): string | null {
  if (!body) return null;
  try {
    const parsed = JSON.parse(body) as { error?: unknown; message?: unknown };
    if (parsed?.error) return String(parsed.error);
    if (parsed?.message) return String(parsed.message);
  } catch { /* not JSON */ }
  return body.slice(0, 500);
}

/** Best-effort client id from the request body, read from a CLONE so the handler's
 *  own body stream is untouched. Only called on the failure path. */
async function clientIdFrom(req: Request | null): Promise<string | null> {
  if (!req) return null;
  try {
    const body = await req.json() as Record<string, unknown>;
    const id = body?.client_id ?? body?.clientId ?? body?.client;
    return id ? String(id).slice(0, 100) : null;
  } catch {
    return null;
  }
}

/**
 * Wrap a Deno.serve handler so failures land in app_errors.
 *
 * Records two things the function itself would otherwise swallow:
 *   • an unhandled throw (rethrown afterwards, so platform behaviour is unchanged)
 *   • a response the handler returned itself with status >= `minStatus`
 *
 * `minStatus` defaults to 500. Pass 400 for webhooks, where a 4xx we return means WE
 * failed to process the event rather than "the caller sent something silly" — e.g.
 * billing-webhook answers 422 on its own internal failures.
 */
export function withErrorLog(
  fn: string,
  handler: (req: Request) => Promise<Response>,
  opts: { minStatus?: number } = {},
): (req: Request) => Promise<Response> {
  const minStatus = opts.minStatus ?? 500;

  return async (req: Request): Promise<Response> => {
    // Cloned up front: once the handler reads the body the stream is spent, and the
    // client id is only obtainable from the body.
    let clone: Request | null = null;
    try {
      clone = req.clone();
    } catch {
      clone = null;
    }

    try {
      const res = await handler(req);

      if (res.status >= minStatus) {
        const body = await res.clone().text().catch(() => "");
        await logEdgeError({
          fn,
          req,
          code: res.status,
          message: messageFromBody(body) ?? `HTTP ${res.status}`,
          clientId: await clientIdFrom(clone),
          context: { returnedStatus: res.status },
        });
      }

      return res;
    } catch (e) {
      const err = e as Error;
      await logEdgeError({
        fn,
        req,
        code: "unhandled",
        message: err?.message ?? String(e),
        clientId: await clientIdFrom(clone),
        context: { stack: String(err?.stack ?? "").slice(0, 2000) },
      });
      throw e; // unchanged behaviour: the platform still turns this into a 500
    }
  };
}
