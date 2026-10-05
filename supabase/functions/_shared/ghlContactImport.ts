/**
 * ghlContactImport.ts: CSM Synergy's own GoHighLevel contacts into the built-in CRM (migration 282),
 * the part that runs without a database: reading the location's contacts a page at a time, turning
 * each into the row the database function takes, and deciding when to stop.
 *
 * WHY. Carolyn, 2026-09-28: "continue building out the CRM part of it as well, because I also want to
 * use it for all of our leads in here." portal-settings' crm_import_ghl_contacts is the action
 * (operator-only, CSM Synergy's own account only, a dry run unless the request says otherwise); this
 * module is everything it does between the GoHighLevel key and public.crm_import_ghl_contacts.
 *
 * WHAT IT CALLS, AND ONLY THAT: POST /contacts/search, 100 a page. It is a read (GoHighLevel's search
 * is a POST because the filters ride in the body). Nothing here creates, updates, tags or deletes
 * anything in GoHighLevel, and the test's fake CRM throws on any other URL.
 *
 * PAGING. GoHighLevel's search has two ways to walk: `page` (which stops at 10,000 records) and
 * `searchAfter` (each contact carries the value that asks for the rows after it). The first request
 * asks for page 1; from then on the walk follows the last contact's `searchAfter` when there is one,
 * and page numbers when there is not, so either answer shape works. A short page is the end.
 * The position between calls is an opaque cursor: GoHighLevel's own paging value (a timestamp and a
 * contact id) and whether it came from a dry run, base64 so nobody reads meaning into it. It carries
 * nothing about the person. A dry run's position is refused by a real run: started there, the real
 * run would skip every page before it and still end on "that is every contact".
 *
 * RATE LIMITS. A 429, a 5xx or a dropped connection is tried again (Retry-After when GoHighLevel
 * sends one, else 1 s, 2 s, 4 s), four tries a page. A 401/403 (the key) or any other 4xx (the
 * request) stops at once. A stop always hands back the cursor of the page that did not land, so the
 * next call carries on from exactly there: the database function is idempotent, so a page that is
 * read twice costs time and creates nothing twice.
 *
 * TIME. One call stays inside the gateway's 150 s of silence and the worker's 400 s life
 * (importDeadlines): it starts no new page after the soft deadline and gives up a back-off that
 * would cross the hard one. The operator runs it again with the cursor it answered.
 *
 * COUNTS ONLY. Nothing here logs, and nothing it returns carries a name, a number, an address or a
 * tag. GoHighLevel's error bodies are read and thrown away, never passed on.
 *
 * Dependency-free (fetch, the clock and sleep are parameters), so _shared/ghlContactImport.test.ts
 * drives every path offline against _test_stubs/ghlFake.ts.
 */

import { phoneKey } from "./phoneKey.ts";

export const GHL_CONTACT_SEARCH_URL = "https://services.leadconnectorhq.com/contacts/search";
export const GHL_API_VERSION = "2021-07-28";
/** Contacts per GoHighLevel page, and so per database call. */
export const IMPORT_PAGE_SIZE = 100;
/** GoHighLevel's page/pageLimit walk stops at 10,000 records; searchAfter has no such ceiling. */
export const GHL_PAGE_MODE_CEILING = 10_000;
/** Tries per page before the call stops with `ghl_busy` (one, then three more). */
export const GHL_TRIES_PER_PAGE = 4;
export const GHL_FETCH_TIMEOUT_MS = 20_000;
export const GHL_MAX_BACKOFF_MS = 30_000;

/** The same caps migration 282 applies, so a row is the same whichever side cuts it. */
export const TAGS_PER_CONTACT = 25;
export const TAG_MAX_LENGTH = 60;
const NAME_MAX = 200;
const PHONE_MAX = 40;
const EMAIL_MAX = 254;

/** One contact as public.crm_import_ghl_contacts takes it. Every value may be null. `sms_dnd` is
 *  GoHighLevel's texting do-not-disturb, which the function keeps as an opt-out on the phone. */
export type ImportRow = {
  name: string | null;
  phone: string | null;
  email: string | null;
  tags: string[];
  added_at: string | null;
  sms_dnd: boolean;
};

/** A GoHighLevel contact, read: the row, its two match keys, and its texting do-not-disturb. */
export type ParsedContact = { row: ImportRow; phoneKey: string; emailKey: string; smsDnd: boolean };

// deno-lint-ignore no-explicit-any
type Raw = any;

const text = (v: unknown, max: number): string | null => {
  if (typeof v !== "string") return null;
  const s = v.replace(/\s+/g, " ").trim().slice(0, max).trim();
  return s ? s : null;
};

/** GoHighLevel tags as labels: strings only, whitespace collapsed, at most 60 characters, one per
 *  spelling ignoring case (the first kept), at most 25. */
export function cleanTags(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const t of raw) {
    const s = text(t, TAG_MAX_LENGTH);
    if (!s || seen.has(s.toLowerCase())) continue;
    seen.add(s.toLowerCase());
    out.push(s);
    if (out.length >= TAGS_PER_CONTACT) break;
  }
  return out;
}

/** GoHighLevel's "date added", as ISO, or null when it is not a date. The database ignores one
 *  before 2000 or in the future. */
function addedAt(raw: unknown): string | null {
  if (typeof raw !== "string" && typeof raw !== "number") return null;
  const d = new Date(raw);
  return Number.isFinite(d.getTime()) ? d.toISOString() : null;
}

/** Has this contact asked GoHighLevel not to be texted? Carried as `sms_dnd`, and migration 282 keeps
 *  it as an opt-out on the phone (sms_opt_outs, reason 'import'). A missing consent record is not
 *  enough on its own: one can be created after the import (they text the business, or staff record
 *  permission), and only an opt-out outranks it in _shared/smsSend.ts. */
function smsDoNotDisturb(r: Raw): boolean {
  if (r?.dnd === true) return true;
  const st = String(r?.dndSettings?.SMS?.status ?? "").toLowerCase();
  return st === "active" || st === "permanent";
}

/** A name GoHighLevel only holds lowercased ("pat o'brien"), capitalised word by word ("Pat
 *  O'Brien"). A name only ever fills a blank, so a lowercase one would stay for good; one with any
 *  capital letter in it is left exactly as written. */
export function capitaliseLowercaseName(s: string | null): string | null {
  if (!s || s !== s.toLowerCase()) return s;
  return s.replace(/(^|[\s'-])(\p{Ll})/gu, (_m, before: string, letter: string) => before + letter.toUpperCase());
}

/**
 * One GoHighLevel contact as the import row, or null when it is not an object at all. The name is
 * the first and last name, else the contact or company name GoHighLevel holds; the fields GoHighLevel
 * keeps lowercased (firstNameLowerCase, lastNameLowerCase, contactName) are capitalised when that is
 * all there is. An email that is not shaped like one is dropped rather than stored. The phone is kept
 * as GoHighLevel wrote it; the database matches on its digits (crm_phone_key, whose rule phoneKey
 * shares).
 */
export function parseGhlContact(raw: unknown): ParsedContact | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const r = raw as Raw;
  const first = text(r.firstName, NAME_MAX) ?? text(r.firstNameRaw, NAME_MAX)
    ?? capitaliseLowercaseName(text(r.firstNameLowerCase, NAME_MAX));
  const last = text(r.lastName, NAME_MAX) ?? text(r.lastNameRaw, NAME_MAX)
    ?? capitaliseLowercaseName(text(r.lastNameLowerCase, NAME_MAX));
  const name = text([first, last].filter(Boolean).join(" "), NAME_MAX)
    ?? capitaliseLowercaseName(text(r.contactName, NAME_MAX)) ?? text(r.name, NAME_MAX) ?? text(r.companyName, NAME_MAX);
  const phone = text(r.phone, PHONE_MAX);
  const rawEmail = text(r.email, EMAIL_MAX);
  const email = rawEmail && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(rawEmail) ? rawEmail : null;
  const smsDnd = smsDoNotDisturb(r);
  return {
    row: { name, phone, email, tags: cleanTags(r.tags), added_at: addedAt(r.dateAdded), sms_dnd: smsDnd },
    phoneKey: phone ? phoneKey(phone) : "",
    emailKey: email ? email.toLowerCase() : "",
    smsDnd,
  };
}

// ── The cursor ───────────────────────────────────────────────────────────────────────────────

/** Where the next page starts: after a contact (GoHighLevel's searchAfter), or at a page number. */
export type ImportCursor = { after: (string | number)[] } | { page: number };

/** GoHighLevel's searchAfter, when it is the shape we can send back: one to four strings or numbers. */
function searchAfterOf(v: unknown): (string | number)[] | null {
  if (!Array.isArray(v) || v.length < 1 || v.length > 4) return null;
  for (const x of v) {
    if (typeof x === "number" ? !Number.isFinite(x) : typeof x !== "string" || x.length > 200) return null;
  }
  return v as (string | number)[];
}

const b64url = (s: string) =>
  btoa(String.fromCharCode(...new TextEncoder().encode(s))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const unb64url = (s: string) => {
  const b = atob(s.replace(/-/g, "+").replace(/_/g, "/"));
  return new TextDecoder().decode(Uint8Array.from(b, (c) => c.charCodeAt(0)));
};

/** The position, and whether the call that answered it was a dry run (`d`, 1 or 0). */
export function encodeCursor(c: ImportCursor, dryRun: boolean): string {
  const d = dryRun ? 1 : 0;
  return b64url(JSON.stringify("after" in c ? { v: 1, d, a: c.after } : { v: 1, d, p: c.page }));
}

/** The cursor a previous call answered and the mode it came from, or null when it is not one (the
 *  caller refuses it). One without its mode is not one. */
export function decodeCursor(raw: string): { cursor: ImportCursor; dryRun: boolean } | null {
  if (raw.length > 2000 || !/^[A-Za-z0-9_-]+$/.test(raw)) return null;
  let o: Raw;
  try { o = JSON.parse(unb64url(raw)); } catch { return null; }
  if (!o || typeof o !== "object" || o.v !== 1 || (o.d !== 0 && o.d !== 1)) return null;
  const dryRun = o.d === 1;
  if ("a" in o) {
    const after = searchAfterOf(o.a);
    return after ? { cursor: { after }, dryRun } : null;
  }
  const p = o.p;
  if (Number.isInteger(p) && p >= 1 && (p - 1) * IMPORT_PAGE_SIZE < GHL_PAGE_MODE_CEILING) return { cursor: { page: p }, dryRun };
  return null;
}

// ── The request ──────────────────────────────────────────────────────────────────────────────

export const BAD_CURSOR_SENTENCE = "That import position isn't valid. Start the import again without one.";
export const DRY_RUN_CURSOR_SENTENCE = "That position is from a dry run. Start the real import without one.";

/**
 * The action's body. A DRY RUN unless `dryRun` is the boolean false: a missing flag, a null, the
 * string "false" or anything else all read as a dry run, so nothing but a deliberate request writes.
 * A real run refuses a dry run's cursor: the pages before it were only ever rolled back. (A real
 * run's cursor in a dry run is let through; it writes nothing either way.)
 */
export function parseImportRequest(p: Record<string, unknown>):
  | { ok: true; dryRun: boolean; cursor: ImportCursor | null }
  | { ok: false; error: string } {
  const dryRun = p.dryRun !== false;
  const raw = p.cursor;
  if (raw === undefined || raw === null || raw === "") return { ok: true, dryRun, cursor: null };
  if (typeof raw !== "string") return { ok: false, error: BAD_CURSOR_SENTENCE };
  const dec = decodeCursor(raw);
  if (!dec) return { ok: false, error: BAD_CURSOR_SENTENCE };
  if (dec.dryRun && !dryRun) return { ok: false, error: DRY_RUN_CURSOR_SENTENCE };
  return { ok: true, dryRun, cursor: dec.cursor };
}

// ── Time ─────────────────────────────────────────────────────────────────────────────────────

/** The gateway ends a request that has sent nothing for 150 s; the import answers well inside it. */
export const IMPORT_REQUEST_HARD_MS = 120_000;
export const IMPORT_REQUEST_SOFT_MS = 90_000;
/** A worker is ended at 400 s whatever it is doing (styleD3.ts EDGE_WALL_CLOCK_MS has the source). */
export const IMPORT_WORKER_WALL_MS = 400_000;
export const IMPORT_WORKER_MARGIN_MS = 40_000;
/** The first page is tried whenever this much time is left, so a call on an old worker still moves. */
export const IMPORT_FIRST_PAGE_MS = 25_000;

/**
 * When this call stops starting pages (`softMs`) and stops waiting on GoHighLevel (`hardMs`), as
 * absolute epoch milliseconds: from the request's arrival, and from the worker's birth (one worker
 * serves many requests and dies at 400 s whatever is in flight).
 */
export function importDeadlines(o: { requestStartMs: number; workerBornMs: number }): { softMs: number; hardMs: number } {
  const hardMs = Math.min(o.requestStartMs + IMPORT_REQUEST_HARD_MS, o.workerBornMs + IMPORT_WORKER_WALL_MS - IMPORT_WORKER_MARGIN_MS);
  const softMs = Math.min(o.requestStartMs + IMPORT_REQUEST_SOFT_MS, hardMs - IMPORT_FIRST_PAGE_MS);
  return { softMs, hardMs };
}

// ── The walk ─────────────────────────────────────────────────────────────────────────────────

/** What the database function answers for one page (public.crm_import_ghl_contacts). `optedOut` is
 *  how many phones it newly marked not to be texted (GoHighLevel's do-not-disturb); `split` is how
 *  many rows carried an email another contact already holds, so the email stayed with that contact
 *  and the row went to its phone's contact alone. */
export type PageCounts = {
  created: number; matched: number; noIdentity: number; conflicts: number; labelled: number; optedOut: number; split: number;
};

/** The whole call's numbers. `fetched` is every contact GoHighLevel handed over; `repeats` is how many
 *  of them shared a phone or email with an earlier one in this call (GoHighLevel holds duplicates; in a
 *  dry run the second of a pair on another page counts as new, see migration 282); `smsDnd` is how
 *  many GoHighLevel marks as not to be texted (with or without a phone; `optedOut` is the ones kept). */
export type ImportCounts = PageCounts & { fetched: number; repeats: number; smsDnd: number };

export type ImportStop =
  | "end"           // GoHighLevel had no more contacts
  | "time"          // the call's time ran out; carry on from `cursor`
  | "ghl_busy"      // rate-limited, 5xx or unreachable four times; carry on from `cursor`
  | "ghl_auth"      // 401/403: the location's key was refused
  | "ghl_refused"   // any other 4xx, or an answer that is not a contact list
  | "page_ceiling"  // page numbering reached GoHighLevel's 10,000-record ceiling
  | "paging_stuck"  // GoHighLevel's searchAfter did not move, or vanished mid-walk
  | "database";     // the database function failed this page; nothing of it was kept

export type ImportResult = {
  done: boolean;
  stopped: ImportStop;
  /** GoHighLevel's HTTP status for a ghl_* stop (null when the connection itself failed). */
  ghlStatus: number | null;
  /** Where the next call carries on; null once done. */
  cursor: string | null;
  pages: number;
  /** GoHighLevel's own total for the location, when it reports one. */
  total: number | null;
  paging: "after" | "page" | null;
  counts: ImportCounts;
  /** The database function's error, for the caller to log by code. Never data. */
  dbError?: unknown;
};

export type ImportDeps = {
  locationId: string;
  apiKey: string;
  dryRun: boolean;
  cursor: ImportCursor | null;
  /** One page into the database: public.crm_import_ghl_contacts. Throws on failure. */
  importPage: (rows: ImportRow[], dryRun: boolean) => Promise<PageCounts>;
  softMs: number;
  hardMs: number;
  fetchFn?: typeof fetch;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
};

const zero = (): ImportCounts => ({
  fetched: 0, created: 0, matched: 0, noIdentity: 0, conflicts: 0, labelled: 0, optedOut: 0, split: 0, repeats: 0, smsDnd: 0,
});

type PageRead =
  | { ok: true; contacts: Raw[]; total: number | null }
  | { ok: false; stopped: "ghl_busy" | "ghl_auth" | "ghl_refused"; status: number | null };

/** How long to wait before trying a page again: GoHighLevel's Retry-After (seconds or a date) when
 *  it sends one, else 1 s, 2 s, 4 s. Never more than 30 s. */
export function retryWaitMs(res: Response | null, attempt: number, now: number): number {
  const ra = res?.headers.get("retry-after");
  if (ra) {
    const secs = Number(ra);
    if (Number.isFinite(secs) && secs >= 0) return Math.min(secs * 1000, GHL_MAX_BACKOFF_MS);
    const at = Date.parse(ra);
    if (Number.isFinite(at)) return Math.min(Math.max(at - now, 0), GHL_MAX_BACKOFF_MS);
  }
  return Math.min(1000 * 2 ** (attempt - 1), GHL_MAX_BACKOFF_MS);
}

async function readPage(d: Required<Pick<ImportDeps, "fetchFn" | "now" | "sleep">> & ImportDeps, cursor: ImportCursor): Promise<PageRead> {
  const body = JSON.stringify({
    locationId: d.locationId,
    pageLimit: IMPORT_PAGE_SIZE,
    ...("after" in cursor ? { searchAfter: cursor.after } : { page: cursor.page }),
  });
  const headers = {
    Authorization: `Bearer ${d.apiKey}`,
    Version: GHL_API_VERSION,
    "Content-Type": "application/json",
    Accept: "application/json",
  };
  for (let attempt = 1; ; attempt++) {
    let res: Response | null = null;
    try {
      const left = Math.max(1_000, Math.min(GHL_FETCH_TIMEOUT_MS, d.hardMs - d.now()));
      res = await d.fetchFn(GHL_CONTACT_SEARCH_URL, { method: "POST", headers, body, signal: AbortSignal.timeout(left) });
    } catch {
      res = null; // the connection failed or timed out: tried again like a 5xx
    }
    if (res?.ok) {
      let data: Raw = null;
      try { data = await res.json(); } catch { data = null; }
      if (!data || !Array.isArray(data.contacts)) return { ok: false, stopped: "ghl_refused", status: res.status };
      const total = typeof data.total === "number" && Number.isFinite(data.total) ? data.total : null;
      return { ok: true, contacts: data.contacts, total };
    }
    const status = res ? res.status : null;
    // GoHighLevel's error body may quote the request back; it is read to free the connection and
    // never kept.
    if (res) await res.body?.cancel().catch(() => {});
    if (status === 401 || status === 403) return { ok: false, stopped: "ghl_auth", status };
    if (status !== null && status !== 429 && status < 500) return { ok: false, stopped: "ghl_refused", status };
    if (attempt >= GHL_TRIES_PER_PAGE) return { ok: false, stopped: "ghl_busy", status };
    const wait = retryWaitMs(res, attempt, d.now());
    if (d.now() + wait >= d.hardMs) return { ok: false, stopped: "ghl_busy", status };
    await d.sleep(wait);
  }
}

/**
 * Walk the location from `cursor` (or the start), one page into the database at a time, until
 * GoHighLevel runs out, the time runs out or something refuses. Never throws for GoHighLevel or the
 * database: every stop is an answer with the counts so far and the cursor to carry on from.
 */
export async function runGhlContactImport(deps: ImportDeps): Promise<ImportResult> {
  const d = {
    ...deps,
    fetchFn: deps.fetchFn ?? fetch,
    now: deps.now ?? (() => Date.now()),
    sleep: deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms))),
  };
  const counts = zero();
  const seenPhones = new Set<string>();
  const seenEmails = new Set<string>();
  let cursor: ImportCursor = deps.cursor ?? { page: 1 };
  let pages = 0;
  let total: number | null = null;
  let paging: "after" | "page" | null = null;
  let lastAfter: string | null = "after" in cursor ? JSON.stringify(cursor.after) : null;

  const stop = (stopped: ImportStop, at: ImportCursor | null, ghlStatus: number | null = null, dbError?: unknown): ImportResult => ({
    done: stopped === "end", stopped, ghlStatus, cursor: at ? encodeCursor(at, d.dryRun) : null, pages, total, paging, counts,
    ...(dbError === undefined ? {} : { dbError }),
  });

  while (true) {
    const startBy = pages === 0 ? d.hardMs - IMPORT_FIRST_PAGE_MS : d.softMs;
    if (d.now() >= startBy) return stop("time", cursor);

    const read = await readPage(d, cursor);
    if (!read.ok) return stop(read.stopped, cursor, read.status);
    if (read.total !== null) total = read.total;

    // This page's numbers, merged only once the database has taken it, so a page that fails there
    // leaves the totals as they were and the cursor on it.
    const page = zero();
    const rows: ImportRow[] = [];
    const pagePhones: string[] = [];
    const pageEmails: string[] = [];
    for (const raw of read.contacts) {
      page.fetched++;
      const c = parseGhlContact(raw);
      if (!c) { page.noIdentity++; continue; }
      if (c.smsDnd) page.smsDnd++;
      if (!c.phoneKey && !c.emailKey) { page.noIdentity++; continue; }
      const seen = (c.phoneKey && (seenPhones.has(c.phoneKey) || pagePhones.includes(c.phoneKey)))
        || (c.emailKey && (seenEmails.has(c.emailKey) || pageEmails.includes(c.emailKey)));
      if (seen) page.repeats++;
      if (c.phoneKey) pagePhones.push(c.phoneKey);
      if (c.emailKey) pageEmails.push(c.emailKey);
      rows.push(c.row);
    }
    if (rows.length) {
      let done: PageCounts;
      try {
        done = await d.importPage(rows, d.dryRun);
      } catch (e) {
        return stop("database", cursor, null, e);
      }
      page.created += done.created;
      page.matched += done.matched;
      page.noIdentity += done.noIdentity;
      page.conflicts += done.conflicts;
      page.labelled += done.labelled;
      page.optedOut += done.optedOut;
      page.split += done.split;
    }
    for (const k of Object.keys(counts) as (keyof ImportCounts)[]) counts[k] += page[k];
    for (const p of pagePhones) seenPhones.add(p);
    for (const e of pageEmails) seenEmails.add(e);
    pages++;

    // A short page is the end (an exact multiple of 100 ends on the empty page after it).
    if (read.contacts.length < IMPORT_PAGE_SIZE) return stop("end", null);

    const after = searchAfterOf(read.contacts[read.contacts.length - 1]?.searchAfter);
    if (after) {
      const key = JSON.stringify(after);
      if (key === lastAfter) return stop("paging_stuck", cursor);
      lastAfter = key;
      paging = "after";
      cursor = { after };
    } else if ("page" in cursor) {
      paging = "page";
      const next = cursor.page + 1;
      if ((next - 1) * IMPORT_PAGE_SIZE >= GHL_PAGE_MODE_CEILING) return stop("page_ceiling", null);
      cursor = { page: next };
    } else {
      // searchAfter was there and is gone: there is no page number to fall back on from here.
      return stop("paging_stuck", cursor);
    }
  }
}

/** A plain sentence for the operator: what happened and what to do next. Numbers only. */
export function importSummary(r: ImportResult, dryRun: boolean): string {
  const c = r.counts;
  const lead = dryRun ? "Dry run, nothing was saved" : "Imported";
  const would = dryRun ? "would be new" : "new";
  const marked = dryRun ? "would be marked" : "marked";
  const body = `${c.fetched} GoHighLevel contact${c.fetched === 1 ? "" : "s"} read over ${r.pages} page${r.pages === 1 ? "" : "s"}: `
    + `${c.created} ${would}, ${c.matched} already here, ${c.noIdentity} with no phone or email`
    + (c.conflicts ? `, ${c.conflicts} skipped (try again)` : "")
    + (c.optedOut ? `, ${c.optedOut} ${marked} do not text` : "")
    + (c.split ? `, ${c.split} with an email another contact already has (left there)` : "") + ".";
  const next: Record<ImportStop, string> = {
    end: "That is every contact in the location.",
    time: "Stopped to stay inside the time limit. Run it again with this cursor to carry on.",
    ghl_busy: "GoHighLevel kept asking us to slow down. Run it again with this cursor in a minute.",
    ghl_auth: "GoHighLevel refused this account's API key. Check the key under Settings → CRM Connection.",
    ghl_refused: "GoHighLevel refused the contact search. Nothing after the last page was read.",
    page_ceiling: "GoHighLevel stops page-numbered reads at 10,000 contacts, so the rest were not read.",
    paging_stuck: "GoHighLevel's paging stopped moving, so the read stopped. Run it again with this cursor.",
    database: "Saving a page failed and nothing from it was kept. Run it again with this cursor.",
  };
  return `${lead}. ${body} ${next[r.stopped]}`;
}
