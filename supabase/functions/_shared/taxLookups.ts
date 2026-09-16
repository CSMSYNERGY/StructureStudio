// The Avalara call ledger (migration 242): one `tax_lookups` row per deliberate lookup.
//
// WHY A LEDGER WHEN THE WALLET ALREADY RECORDS CHARGES. The wallet cannot count calls. A
// charge is skipped while the meter is disarmed, priced at zero or the tenant is exempt, and an
// answer-keyed charge collapses a repeat press that returns the same rate — every one of those
// still made a request Avalara metered. The billable unit and the cost unit are not the same
// thing, so the cost unit gets its own table, and that table is also the SPEND CAP: the daily
// count below is taken from it before any request is made.
//
// THE ORDER A CALLER FOLLOWS (verify_tax and the invoice-time check do it through one function,
// taxSpend.ts' paidLookup; the operator ping in admin-catalog does steps 2-4 itself):
//   1. countLookups24h — refuse when it returns null (unreadable) or reaches the cap;
//   2. insertLookup    — refuse when it returns null. The row IS the cap: a lookup with no
//                        row is a lookup nothing counts;
//   3. the request     — resolveRate(…, { allowLookup: true, onResult }) or pingAvalara();
//   4. finishLookup    — with what came back. Best-effort: the request already happened, and a
//                        row left in flight still counts toward the cap.
// `resolveRate` calls `onResult` once per lookup that reached the network, so one row per
// resolveRate, with `attempts` recording how many HTTP requests it took.
//
// Every function here NEVER THROWS; failure is in the return value, because the caller has to
// decide between refusing (steps 1-2) and logging (step 4).
//
// ⚠️ Bundled per function like every _shared module: a change here means redeploying every
// importer. Derive them, do not trust a list (CLAUDE.md, importer audits):
//     find supabase/functions -name '*.ts' ! -name '*.test.ts' ! -path '*_test_stubs*' -print0 \
//       | xargs -0 -I{} perl -0777 -ne 'print "$ARGV\n" if m{import[^;]*?from\s+"[^"]*taxLookups\.ts"}s' {}

import type { AvalaraFailure, AvalaraPing, AvalaraResult } from "./salesTax.ts";

// deno-lint-ignore no-explicit-any
type Admin = any;

/** Lookups a tenant may make in any rolling 24 hours, verify and invoice kinds together. A
 *  ceiling on OUR exposure, not a product limit: at the per-call price this bounds one runaway
 *  loop or one stolen staff token to a known daily figure. Pings are not counted — they are
 *  operator-only and spend no builder's allowance. */
export const DAILY_TAX_LOOKUP_CAP = 100;

export type TaxLookupKind = "verify" | "invoice" | "ping";
/** Mirrors the `outcome` CHECK on tax_lookups. Null (not listed) while the request is in flight. */
export type TaxLookupOutcome = "ok" | "not_configured" | AvalaraFailure;

/** The kinds the daily cap counts. */
const CAPPED_KINDS: TaxLookupKind[] = ["verify", "invoice"];
const KINDS: TaxLookupKind[] = ["verify", "invoice", "ping"];

// Column-length CHECKs in migration 242. Clipped here rather than refused there: a long short
// code must not be the reason a staff member cannot verify a rate.
const MAX_CODE = 64;
const MAX_REGION = 16;
const MAX_POSTAL = 16;
const MAX_JURISDICTION = 200;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const clip = (v: unknown, n: number): string | null => {
  if (v == null) return null;
  const s = String(v).trim().slice(0, n);
  return s || null;
};

export interface NewTaxLookup {
  clientId: string;
  kind: TaxLookupKind;
  shortCode?: string | null;
  invoiceNumber?: string | number | null;
  /** The signed-in user who caused it. Audit only — a non-UUID is stored as null, not refused. */
  actorUserId?: string | null;
  /** A platform operator acting in view-as. */
  operator?: boolean;
  /** The two-letter region asked about (stateCode()), and the postcode. */
  region?: string | null;
  postalCode?: string | null;
}

/**
 * Write the in-flight row BEFORE the request. Returns its id, or null when it could not be
 * written — and a null means the caller refuses the lookup: an uncounted call is exactly the
 * spend the ledger exists to bound.
 */
export async function insertLookup(admin: Admin, row: NewTaxLookup): Promise<string | null> {
  try {
    if (!row?.clientId || !KINDS.includes(row.kind)) return null;
    const { data, error } = await admin
      .from("tax_lookups")
      .insert({
        client_id: row.clientId,
        kind: row.kind,
        short_code: clip(row.shortCode, MAX_CODE),
        invoice_number: clip(row.invoiceNumber, MAX_CODE),
        actor_user_id: typeof row.actorUserId === "string" && UUID.test(row.actorUserId) ? row.actorUserId : null,
        operator: row.operator === true,
        region: clip(row.region, MAX_REGION),
        postal_code: clip(row.postalCode, MAX_POSTAL),
      })
      .select("id")
      .single();
    if (error || typeof data?.id !== "string") return null;
    return data.id;
  } catch {
    return null;
  }
}

/** The columns a finished row carries, from whatever the request produced. Exported for tests. */
export function finishedColumns(result: AvalaraResult | AvalaraPing | "not_configured"): {
  outcome: TaxLookupOutcome;
  http_status: number | null;
  attempts: number;
  rate: number | null;
  jurisdiction: string | null;
} {
  const status = (s: unknown) => (typeof s === "number" && Number.isInteger(s) && s >= 100 && s <= 599 ? s : null);
  if (result === "not_configured") {
    return { outcome: "not_configured", http_status: null, attempts: 0, rate: null, jurisdiction: null };
  }
  if ("configured" in result) {
    // A ping. It never errors on bad credentials (200 + authenticated:false), and it does not
    // say whether a null status was a timeout or a dropped connection, so both read `network`,
    // as does a 5xx.
    if (!result.configured) return { outcome: "not_configured", http_status: null, attempts: 0, rate: null, jurisdiction: null };
    const s = result.httpStatus;
    const outcome: TaxLookupOutcome = result.authenticated ? "ok"
      : s == null || s >= 500 ? "network"
      : s === 429 ? "rate_limited"
      : "credentials_rejected";
    return { outcome, http_status: status(result.httpStatus), attempts: 1, rate: null, jurisdiction: null };
  }
  const attempts = Number.isInteger(result.attempts) ? Math.min(Math.max(result.attempts, 0), 10) : 0;
  if (!result.ok) {
    return { outcome: result.failure, http_status: status(result.httpStatus), attempts, rate: null, jurisdiction: null };
  }
  const rate = Number.isFinite(result.rate) && result.rate >= 0 && result.rate <= 0.25 ? result.rate : null;
  return {
    outcome: "ok",
    http_status: status(result.httpStatus),
    attempts,
    rate,
    jurisdiction: clip(result.jurisdiction, MAX_JURISDICTION),
  };
}

/**
 * Close an in-flight row with what came back. `"not_configured"` is for a row whose request
 * never went out because the credentials were missing (resolveRate then returns
 * "avalara not configured" and calls no onResult).
 *
 * Returns true only when exactly that in-flight row was closed. A row closes ONCE — an
 * already-finished row is left as it is and reported false — so a double callback can never
 * rewrite what a lookup cost. Best-effort for the caller: log a false, do not refuse over it.
 */
export async function finishLookup(
  admin: Admin,
  id: string,
  result: AvalaraResult | AvalaraPing | "not_configured",
): Promise<boolean> {
  try {
    if (typeof id !== "string" || !UUID.test(id)) return false;
    const { data, error } = await admin
      .from("tax_lookups")
      .update({ ...finishedColumns(result), finished_at: new Date().toISOString() })
      .eq("id", id)
      .is("finished_at", null)
      .select("id");
    return !error && Array.isArray(data) && data.length === 1;
  } catch {
    return false;
  }
}

/**
 * The `client_id` an operator's credential ping is recorded under. A ping checks the PLATFORM's
 * credentials and belongs to no builder, so it is not filed under anybody's tenant — not even the
 * operator's own, which is a real builder account whose usage query should read only its own
 * calls. The column is text with no foreign key (deliberately, migration 242), so a fixed value
 * is allowed; the leading underscore is one no tenant slug can have (slugs are
 * `^[a-z0-9][a-z0-9-]*$`), so it can never collide with a tenant created later. Pings are not in
 * the capped kinds either way.
 */
export const PING_CLIENT_ID = "_platform";

/**
 * What the operator console is told about a ping, and nothing else. pingAvalara already
 * whitelists; this is the second whitelist, at the response boundary, so a field added to
 * AvalaraPing later does not ride out to a browser by being spread. `ok` is the console's usual
 * "the action ran" (a refusal carries `error` instead); whether the credentials work is
 * `authenticated`.
 */
export function pingResponse(ping: AvalaraPing): {
  ok: true;
  configured: boolean;
  authenticated: boolean;
  authenticationType: string | null;
  httpStatus: number | null;
} {
  const configured = ping?.configured === true;
  const type = ping?.authenticationType;
  const s = ping?.httpStatus;
  return {
    ok: true,
    configured,
    authenticated: configured && ping?.authenticated === true,
    authenticationType: configured && typeof type === "string" && /^[A-Za-z]{1,40}$/.test(type) ? type : null,
    httpStatus: typeof s === "number" && Number.isInteger(s) && s >= 100 && s <= 599 ? s : null,
  };
}

/**
 * Lookups (verify + invoice) this tenant made in the last rolling 24 hours, in-flight rows
 * included. FAILS CLOSED: null when the count cannot be read, and the caller REFUSES on null.
 * That is the opposite of the AI-drafting cap's fail-open count, and deliberately so — there a
 * blind pass costs cents of our own; here it is an uncapped run of calls billed to the account.
 */
export async function countLookups24h(admin: Admin, clientId: string): Promise<number | null> {
  try {
    if (!clientId) return null;
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const { count, error } = await admin
      .from("tax_lookups")
      .select("id", { count: "exact", head: true })
      .eq("client_id", clientId)
      .in("kind", CAPPED_KINDS)
      .gt("called_at", since);
    if (error || typeof count !== "number" || !Number.isFinite(count)) return null;
    return count;
  } catch {
    return null;
  }
}
