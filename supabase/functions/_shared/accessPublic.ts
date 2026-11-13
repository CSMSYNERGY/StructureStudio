// _shared/accessPublic.ts — the PUBLIC pages' read of plans as data (migrations 386 to 389).
//
// accessPortal.ts decides what a company's staff are OFFERED and accessEnforce.ts what they are
// ALLOWED. This is the third reader: what a company's CUSTOMERS are offered on the pages they open
// with no login. It is asked in three places only, each where a customer STARTS something: loading a
// website form (tab "forms"), asking for meeting times or booking one (tab "meetings"), and pricing
// a cart in the online lot shop (tab "inventory").
//
// THE PUBLIC RULE IS NOT THE SERVER RULE, and the database works it out (access_for_public, 389):
// a tab is BLOCKED for the public when its state is "off" (an operator's exception, or the company's
// shape), or when the company HOLDS a plan and the tab is not "on". A builder whose subscription has
// lapsed holds nothing, and THIS check leaves its shop and forms open, because that is what happens
// today: neither has ever read the billing gate. The server rule ("not exactly on = not had") would
// have darkened every lapsed builder's forms and shop on the day it was named. (Booking has a paid
// check of its own: book-public still asks for the Customer Hub after this says "ok", exactly as it
// did, so a lapsed builder's booking page answers not_found before and after.)
//
// IT ONLY STOPS OFFERING. A form SUBMIT, a purchase request, a card payment, and a booking read,
// moved or cancelled by its token are never put through it: those callers do not call this at all,
// and their tests pin that. A NEW booking is the one typed request that IS asked, like the times
// before it (see book-public): it is new work on a host's calendar, book-public's own Customer Hub
// check already refuses it the same way, and an unasked book could be posted without the page.
//
// THREE ANSWERS, AND THEIR FAIL DIRECTIONS (the same contract as accessEnforce.ts)
//   null     NOT NAMED, OR THE READ FAILED: exactly today's behaviour. A database error, a thrown
//            call, a malformed answer, a database without 389: all null, and null never refuses.
//            That is what makes it safe to deploy the callers before 389 is applied.
//   report   refuses NOTHING. What would have been refused is filed as an info row (code
//            module_would_refuse), once per isolate per company, function and action, AWAITED: the
//            edge runtime may drop work a response does not wait for.
//   block    a blocked tab answers "refuse", and the CALLER answers in its own existing not-found
//            shape, so nobody can tell from outside which builders have a feature.
//
// CACHED PER ISOLATE FOR 30 SECONDS, on the edge runtime only (never under deno test, for
// accessEnforce's reason), and successful reads only. A failed read is NOT remembered here, unlike
// accessEnforce's 10 seconds (FAIL_MS): each public request asks once, so there is no second wait
// to save, and the next request asks again. ⚠️ The cache is keyed by company id and these are
// public endpoints, where the id comes from the request body. A caller must ask ONLY AFTER it has
// proved the company exists (its form, its booking page, its shop row), or a stranger can grow the
// cache with made-up ids.
//
// Its own cache and its own "already reported" set, and no import of accessEnforce.ts: the public
// functions then do not join the set that has to be redeployed together when the server half changes.
// Importers: lead-form, book-public, shop-checkout.

import { logEdgeError } from "./logError.ts";

// deno-lint-ignore no-explicit-any
type Admin = any;

export interface PublicAccess { mode: "block" | "report"; holds: boolean; blocked: Record<string, boolean> }

const KEY = /^[a-z][a-z0-9_]{1,39}$/;
const CACHE_MS = 30_000;
const cache = new Map<string, { value: PublicAccess | null; at: number }>();
// deno-lint-ignore no-explicit-any
const onEdge = typeof (globalThis as any).EdgeRuntime !== "undefined";

/** access_for_public's answer, clean, or null. Pure, for the tests. Strict on purpose: a missing or
 *  unknown mode, a `holds` that is not a boolean, an empty map, one bad key or one value that is not
 *  a boolean is null, because a half-understood answer must never close a customer's page. */
export function publicAccessFromAnswer(answer: unknown): PublicAccess | null {
  if (!answer || typeof answer !== "object" || Array.isArray(answer)) return null;
  const a = answer as { mode?: unknown; holds?: unknown; blocked?: unknown };
  if (a.mode !== "block" && a.mode !== "report") return null;
  if (typeof a.holds !== "boolean") return null;
  const b = a.blocked;
  if (!b || typeof b !== "object" || Array.isArray(b)) return null;
  const blocked: Record<string, boolean> = {};
  let n = 0;
  for (const [k, v] of Object.entries(b as Record<string, unknown>)) {
    if (!KEY.test(k) || typeof v !== "boolean") return null;
    blocked[k] = v;
    n++;
  }
  return n > 0 ? { mode: a.mode, holds: a.holds, blocked } : null;
}

/** The company's public answer (block or report), else null (today's behaviour). Never throws. */
export async function publicAccess(admin: Admin, clientId: string): Promise<PublicAccess | null> {
  if (!clientId) return null;
  if (onEdge) {
    const hit = cache.get(clientId);
    if (hit && Date.now() - hit.at < CACHE_MS) return hit.value;
  }
  try {
    if (!admin || typeof admin.rpc !== "function") return null;
    const { data, error } = await admin.rpc("access_for_public", { p_client_id: clientId });
    if (error) {
      console.error("access_for_public failed; this company's public pages stay as they are:", error.message ?? error);
      return null;
    }
    const value = publicAccessFromAnswer(data);
    if (onEdge) cache.set(clientId, { value, at: Date.now() });
    return value;
  } catch (e) {
    console.error("access_for_public threw; this company's public pages stay as they are:", (e as Error)?.message ?? e);
    return null;
  }
}

// Report mode: one row per (company, function, action) per isolate, like accessEnforce's firstReport.
const reported = new Set<string>();
function firstPublicReport(clientId: string, fn: string, action: string): boolean {
  const k = `${clientId}\u0000${fn}\u0000${action}`;
  if (reported.has(k)) return false;
  if (reported.size > 5000) reported.clear();
  reported.add(k);
  return true;
}

/** May this public action be OFFERED for this company? "refuse" only in block mode and only when the
 *  tab is blocked; the caller then answers its own existing not-found. Everything else is "ok": not
 *  named, a failed read, a tab that is not blocked, a tab the answer does not list, and report mode
 *  (which files what it would have refused, once, and awaits the write). Never throws. */
export async function publicVerdict(
  admin: Admin,
  clientId: string,
  fn: string,
  action: string,
  tab: string,
  req?: Request | null,
): Promise<"ok" | "refuse"> {
  try {
    const a = await publicAccess(admin, clientId);
    if (!a || a.blocked[tab] !== true) return "ok";
    if (a.mode === "block") return "refuse";
    if (firstPublicReport(clientId, fn, action)) {
      await logEdgeError({
        fn, severity: "info", code: "module_would_refuse", clientId, req,
        message: `Report only: ${action} would be refused (needs ${tab}).`,
        context: { action, tabs: [tab], surface: "public" },
      });
    }
    return "ok";
  } catch (e) {
    console.error("publicVerdict failed; nothing is refused:", (e as Error)?.message ?? e);
    return "ok";
  }
}
