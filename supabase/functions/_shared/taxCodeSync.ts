// The operator's tax code sync (migration 246, 2026-09-17): page Avalara's ListTaxCodes into
// avalara_tax_codes. Called only by admin-catalog's avalara_sync_tax_codes, pressed on purpose
// by an operator. Builders never trigger it; their picker searches the stored copy.
//
// WHY A STORED COPY. Avalara's system codes (about 3,200) are the same for every account, and a
// type-ahead that called Avalara per keystroke would put an authenticated, possibly metered call
// behind every builder's search box. One deliberate sync keeps the builders' side free of
// network calls entirely.
//
// WHAT IT COSTS. ListTaxCodes is a definitions read, not a tax calculation, and Avalara's terms
// bill documents and calculation calls; that it is unbilled is an inference from what the terms
// leave out, not something Avalara says. So it is treated like the ping: an operator action, can_write
// required, up to SYNC_MAX_PAGES requests per press, no retries, and nothing automatic calls it.
//
// THE RULES THE DATABASE WRITE FOLLOWS:
//   • credentials refused (401/403) → nothing is written, whatever pages came before;
//   • nothing usable fetched (a failure on the first page, or an empty list) → nothing is written;
//   • a COMPLETE sync — every page up to @recordsetCount, or an empty page — upserts everything it
//     read and then marks the 'avalara' rows it did not see inactive. Seen means written by this
//     sync: every upserted row carries this sync's synced_at, so "not seen" is `synced_at <` it,
//     one UPDATE rather than a 3,000-code NOT IN list;
//   • a PARTIAL sync — the page cap, or a failure after some pages — upserts what it read and
//     deactivates NOTHING, because a code missing from half a list says nothing about the code;
//   • rows are never deleted (tax_code_assignments references them).
// What leaves this module is counts and a sentence. Each TaxCodeModel also carries company and
// user ids; only the five code fields are read (taxCodes.ts mapAvalaraTaxCode), and no body is
// echoed.
//
// Import-free apart from its two _shared siblings, so its tests run offline with a stubbed fetch
// and a fake client.
//
// ⚠️ Bundled per function: a change here means redeploying every importer. Derive them:
//     find supabase/functions -name '*.ts' ! -name '*.test.ts' ! -path '*_test_stubs*' -print0 \
//       | xargs -0 -I{} perl -0777 -ne 'print "$ARGV\n" if m{import[^;]*?from\s+"[^"]*taxCodeSync\.ts"}s' {}

import { avalaraAuthFailure, avalaraHeaders, avalaraUrl, isConfigured } from "./salesTax.ts";
import { mapAvalaraTaxCode, type TaxCodeRow } from "./taxCodes.ts";

// deno-lint-ignore no-explicit-any
type Admin = any;

/** ListTaxCodes' maximum $top. */
export const SYNC_PAGE_SIZE = 1000;
/** Ten thousand codes, three times today's list. A list that has not ended by then is not the
 *  list this module was written for, and a partial sync deactivates nothing. */
export const SYNC_MAX_PAGES = 10;
export const SYNC_PAGE_TIMEOUT_MS = 10_000;
/** Rows per upsert: one PostgREST request each, well under its body limit at ~300 bytes a row. */
export const SYNC_UPSERT_CHUNK = 500;

export type SyncFailure =
  | "credentials_rejected" // 401/403: the account id or licence key is wrong
  | "subscription"         // 401/403 naming a missing entitlement
  | "rejected"             // any other 4xx
  | "rate_limited"         // 429
  | "timeout"              // no answer inside SYNC_PAGE_TIMEOUT_MS
  | "network"              // connection failure or a 5xx
  | "malformed";           // a 2xx whose body is not the documented { value: [...] }

export type FetchedCodes =
  | {
    ok: true;
    /** Every page was read: the list ended (@recordsetCount reached, or an empty page). */
    complete: boolean;
    /** Why a partial sync stopped; null when complete. */
    stoppedBy: SyncFailure | "page_cap" | null;
    /** Distinct usable codes, last page wins on a repeat. */
    codes: TaxCodeRow[];
    /** Entries Avalara returned, usable or not. */
    fetched: number;
    /** Entries whose taxCode could not be a code. */
    skipped: number;
    /** Requests made, including a failed one. */
    pages: number;
  }
  | { ok: false; failure: SyncFailure; httpStatus: number | null; pages: number };

const isTimeout = (e: unknown) =>
  (e as { name?: string })?.name === "TimeoutError" || (e as { name?: string })?.name === "AbortError";

/**
 * Read the whole list, page by page. Never throws. `$skip` advances by the entries actually
 * received, so a page Avalara answers short of $top loses nothing.
 */
export async function fetchTaxCodes(): Promise<FetchedCodes> {
  const headers = avalaraHeaders();
  const byCode = new Map<string, TaxCodeRow>();
  let fetched = 0, skipped = 0, pages = 0, readPages = 0;

  const result = (complete: boolean, stoppedBy: SyncFailure | "page_cap" | null): FetchedCodes =>
    ({ ok: true, complete, stoppedBy, codes: [...byCode.values()], fetched, skipped, pages });
  // A failure before any page was read has nothing to write; after one, what was read is kept.
  const stop = (failure: SyncFailure, httpStatus: number | null): FetchedCodes =>
    readPages ? result(false, failure) : { ok: false, failure, httpStatus, pages };

  while (pages < SYNC_MAX_PAGES) {
    const url = avalaraUrl(`/api/v2/definitions/taxcodes?$top=${SYNC_PAGE_SIZE}&$skip=${fetched}`);
    pages++;
    let res: Response;
    try {
      res = await fetch(url, { headers, signal: AbortSignal.timeout(SYNC_PAGE_TIMEOUT_MS) });
    } catch (e) {
      return stop(isTimeout(e) ? "timeout" : "network", null);
    }
    if (res.status === 401 || res.status === 403) {
      // Refused credentials write nothing, even after earlier pages: a key that stops working
      // mid-sync is not a list to trust.
      return { ok: false, failure: await avalaraAuthFailure(res), httpStatus: res.status, pages };
    }
    if (!res.ok) {
      try { await res.body?.cancel(); } catch { /* already closed */ }
      return stop(res.status === 429 ? "rate_limited" : res.status >= 500 ? "network" : "rejected", res.status);
    }
    let body: Record<string, unknown> | null;
    try {
      body = JSON.parse(await res.text());
    } catch (e) {
      return stop(isTimeout(e) ? "timeout" : "malformed", res.status);
    }
    const value = body?.value;
    if (!Array.isArray(value)) return stop("malformed", res.status);
    readPages++;
    if (value.length === 0) return result(true, null);
    fetched += value.length;
    for (const raw of value) {
      const row = mapAvalaraTaxCode(raw);
      if (row) byCode.set(row.code, row);
      else skipped++;
    }
    const total = body?.["@recordsetCount"];
    if (typeof total === "number" && Number.isFinite(total) && fetched >= total) return result(true, null);
  }
  return result(false, "page_cap");
}

export type SyncOutcome =
  | {
    ok: true;
    fetched: number;
    upserted: number;
    skipped: number;
    deactivated: number;
    pages: number;
    complete: boolean;
    syncedAt: string;
  }
  | { ok: false; status: number; reason: string; error: string; pages?: number; upserted?: number };

/** The sentence an operator reads for each failure. Names the secrets to check, never a value. */
export function syncFailureText(failure: SyncFailure, httpStatus: number | null): string {
  const http = httpStatus ? ` (HTTP ${httpStatus})` : "";
  switch (failure) {
    case "credentials_rejected":
      return `Avalara refused the platform's credentials${http}. Check AVALARA_ACCOUNT_ID and AVALARA_LICENSE_KEY. Nothing was changed.`;
    case "subscription":
      return `Avalara accepted the credentials but this account isn't entitled to list tax codes${http}. Nothing was changed.`;
    case "rate_limited":
      return `Avalara is limiting requests right now${http}. Nothing was changed — try again in a minute.`;
    case "timeout":
      return `Avalara didn't answer within ${SYNC_PAGE_TIMEOUT_MS / 1000} seconds. Nothing was changed — try again.`;
    case "network":
      return `Couldn't reach Avalara${http}. Nothing was changed — try again.`;
    case "rejected":
      return `Avalara refused the tax code request${http}. Nothing was changed.`;
    case "malformed":
      return `Avalara's answer wasn't the tax code list this sync reads${http}. Nothing was changed.`;
  }
}

const clip = (s: unknown) => String(s ?? "unknown database error").slice(0, 200);

/**
 * Fetch and store. `now` is injectable so a test can pin synced_at. Never throws: a client that
 * throws reads as a database failure.
 */
export async function syncTaxCodes(admin: Admin, now: Date = new Date()): Promise<SyncOutcome> {
  if (!isConfigured()) {
    return {
      ok: false, status: 409, reason: "not_configured",
      error: "Avalara isn't configured on the server (AVALARA_ACCOUNT_ID and AVALARA_LICENSE_KEY), so no tax codes were fetched.",
    };
  }
  const got = await fetchTaxCodes();
  if (!got.ok) {
    return { ok: false, status: 502, reason: got.failure, error: syncFailureText(got.failure, got.httpStatus), pages: got.pages };
  }
  if (!got.codes.length) {
    // Refused rather than written: an empty "complete" list would deactivate every synced code
    // in one press. A partial one that stopped on a failure reports that failure.
    const why = got.stoppedBy && got.stoppedBy !== "page_cap" ? got.stoppedBy : null;
    return {
      ok: false, status: 502, reason: why ?? "empty", pages: got.pages,
      error: why ? syncFailureText(why, null) : "Avalara answered with no usable tax codes, so nothing was changed.",
    };
  }

  const syncedAt = now.toISOString();
  let upserted = 0;
  const dbFailed = (what: string, message: unknown): SyncOutcome => ({
    ok: false, status: 500, reason: "db", pages: got.pages, upserted,
    error: `Couldn't ${what}: ${clip(message)}. ${upserted} of ${got.codes.length} codes were saved and none were deactivated — run the sync again.`,
  });
  try {
    for (let i = 0; i < got.codes.length; i += SYNC_UPSERT_CHUNK) {
      const chunk = got.codes.slice(i, i + SYNC_UPSERT_CHUNK)
        .map((row) => ({ ...row, source: "avalara", synced_at: syncedAt }));
      const { error } = await admin.from("avalara_tax_codes").upsert(chunk, { onConflict: "code" });
      if (error) return dbFailed("save the tax codes", error.message);
      upserted += chunk.length;
    }

    let deactivated = 0;
    if (got.complete) {
      const { error, count } = await admin.from("avalara_tax_codes")
        .update({ is_active: false }, { count: "exact" })
        .eq("source", "avalara").eq("is_active", true).lt("synced_at", syncedAt);
      if (error) return dbFailed("mark the codes Avalara no longer lists", error.message);
      deactivated = typeof count === "number" ? count : 0;
    }
    return {
      ok: true, fetched: got.fetched, upserted, skipped: got.skipped, deactivated,
      pages: got.pages, complete: got.complete, syncedAt,
    };
  } catch (e) {
    return dbFailed("save the tax codes", (e as Error)?.message);
  }
}
