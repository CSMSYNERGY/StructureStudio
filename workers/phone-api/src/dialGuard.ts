// The dial guard (2026-10-15, DEVIATIONS 83): which phone numbers a guarded login may make this
// Worker call, text or forward to.
//
// WHY. The app stores review My Synergy Phone with logins we hand their reviewers, and those
// logins can dial any US number from a real business number. Two kinds of login are guarded:
//   DEMO MODE      every login on a demo business (`demo_tenants`): calls and texts go only to
//                  the business's own numbers (phone_caller_context `numbers`, read from the
//                  database on every call) and the numbers in `allow_numbers` (the demo customer
//                  line). Everything else is refused.
//   OLD-LOGIN MODE the logins in `old_login_users`, which sit on a real business: calls and texts
//                  go anywhere EXCEPT a number saved on a contact of that business (the contact's
//                  own, or another person's on it: crm_contact_people, migration 190), or a number
//                  with any call or text on that business from before `guard_start`. A reviewer's
//                  own phone and their own voicemail call-back are new numbers, so they still work.
// In both modes "Forward to my cell" can't be saved, and a stored forward is never rung. A demo
// business's own after-hours or no-answer forward rings only a number in `allow_numbers`.
//
// THE SECRET. PHONE_DIAL_GUARD, one JSON object (README "Secrets", SETUP.md 3b). Every key but
// demo_daily_minutes is required, and an unknown key makes the whole secret unreadable, so a typo
// can never quietly switch a guard off:
//   {"demo_tenants": ["example-demo"], "old_login_users": ["00000000-0000-4000-8000-000000000001"],
//    "allow_numbers": ["+15555550123"], "guard_start": "2026-10-15T00:00:00Z", "demo_daily_minutes": 30}
// ⚠️ PUBLIC REPO: the real tenant, user ids and numbers live only in the secret.
//
// FAILS CLOSED. Unset: the guard is off and the Worker behaves as before; that is noted once per
// isolate on the console. Set but unreadable (blank, not JSON, a wrong type, an unknown key, a
// bad number, uuid or time): anyone the raw text could name (their user id or their business id
// appears in it anywhere) is refused calls, texts and forwards, and `dial_guard_config_invalid`
// is logged as an error (a blank one names nobody, but is still logged). An old-login lookup that
// fails refuses the call.
//
// NUMBERS. Every comparison is on E.164 (identity.ts toE164), the SAME value the Worker then
// dials: "+1 (816) 555-0123", "8165550123" and "18165550123" are one number, and an extension,
// a pause (w , ;), letters, a SIP URI or a client: identity either normalises to the number that
// would be dialed or isn't dialable at all. So nothing can be checked as one number and dialed as
// another.
//
// PRIVACY (SETUP.md section 10). A refusal stores no phone_calls row, and logs one line with a code
// and counts: never the number, a name or a SID. The old-login lookups send the number to the
// database in a POST body (migration 305's phone_list_search), never in a URL that Supabase's API
// request logs would keep; the one read 305 has no kind for (crm_contact_people) names only the
// tenant, and the number is matched here. A guarded login is never shown a stored forward either
// (me.ts settingsOut, /token): the old login is one account many reviewers share.

import type { Ctx, Env } from "./env";
import type { Admin } from "./db";
import { UUID_RE } from "./http";
import { toE164 } from "./identity";
import { logFault } from "./log";

/** The Worker secret's name: `npx wrangler secret put PHONE_DIAL_GUARD`. */
export const DIAL_GUARD_SECRET = "PHONE_DIAL_GUARD";

/** A demo business's outbound minutes per UTC day when the secret doesn't say. */
export const DEMO_DAILY_MINUTES_DEFAULT = 30;

/** What a refused call says before it hangs up, a refused text answers, and a refused forward says. */
export const GUARD_WORDS = {
  demoCall: "This demo account can only call the demo numbers.",
  blockedCall: "This number can't be called from this account.",
  demoText: "This demo account can only text the demo numbers.",
  blockedText: "This number can't be texted from this account.",
  forwardOff: "Forward to my cell is switched off for this account.",
} as const;

export interface DialGuardConfig {
  demoTenants: ReadonlySet<string>;
  /** Lowercased. */
  oldLoginUsers: ReadonlySet<string>;
  /** E.164. */
  allowNumbers: ReadonlySet<string>;
  /** ISO, as written. */
  guardStart: string;
  demoDailyMinutes: number;
}

export type DialGuardState =
  | { kind: "off" }
  | { kind: "on"; config: DialGuardConfig }
  /** `reason` is a fixed sentence; it never repeats anything from the secret. */
  | { kind: "invalid"; reason: string; raw: string };

/** Which rule a caller is under: null for none. `unreadable`: the secret is broken and may name them. */
export type GuardMode = "demo" | "old_login" | "unreadable";

const KEYS = new Set(["demo_tenants", "old_login_users", "allow_numbers", "guard_start", "demo_daily_minutes"]);
const REQUIRED = ["demo_tenants", "old_login_users", "allow_numbers", "guard_start"];
const MAX_ENTRIES = 50;
/** admin-catalog's rule for a client id (DNS-safe). */
const TENANT_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;
/** A time with its zone, so "midnight" can never mean two different moments. */
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,6})?)?(?:Z|[+-]\d{2}:\d{2})$/;

function invalid(reason: string, raw: string): DialGuardState {
  return { kind: "invalid", reason, raw };
}

function stringList(v: unknown): string[] | null {
  if (!Array.isArray(v) || v.length > MAX_ENTRIES) return null;
  const out: string[] = [];
  for (const x of v) {
    if (typeof x !== "string" || !x.trim()) return null;
    out.push(x.trim());
  }
  return out;
}

/**
 * The secret as the Worker reads it. Pure: tests call it directly. Only a secret that isn't there
 * at all is off: one that is set but blank (an empty file piped to `wrangler secret put`) is
 * unreadable, so it shows in app_errors instead of passing for a guard that is on.
 */
export function parseDialGuard(rawIn: string | undefined | null): DialGuardState {
  if (rawIn === undefined || rawIn === null) return { kind: "off" };
  const raw = String(rawIn);
  if (!raw.trim()) return invalid("it is empty", raw);
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    return invalid("it isn't JSON", raw);
  }
  if (!v || typeof v !== "object" || Array.isArray(v)) return invalid("it isn't a JSON object", raw);
  const o = v as Record<string, unknown>;
  for (const k of Object.keys(o)) if (!KEYS.has(k)) return invalid("it has a key the guard doesn't know", raw);
  for (const k of REQUIRED) if (!(k in o)) return invalid("a required key is missing", raw);

  const tenants = stringList(o.demo_tenants);
  if (!tenants || tenants.some((t) => !TENANT_RE.test(t))) return invalid("demo_tenants must be a list of business ids", raw);
  const users = stringList(o.old_login_users);
  if (!users || users.some((u) => !UUID_RE.test(u))) return invalid("old_login_users must be a list of user ids", raw);
  const numbers = stringList(o.allow_numbers);
  const allow = numbers?.map((n) => toE164(n));
  if (!allow || allow.some((n) => !n)) return invalid("allow_numbers must be a list of US or Canadian numbers", raw);
  const start = typeof o.guard_start === "string" ? o.guard_start.trim() : "";
  if (!ISO_RE.test(start) || !Number.isFinite(Date.parse(start))) return invalid("guard_start must be a time with its zone", raw);
  let minutes = DEMO_DAILY_MINUTES_DEFAULT;
  if (o.demo_daily_minutes !== undefined) {
    const m = o.demo_daily_minutes;
    if (typeof m !== "number" || !Number.isInteger(m) || m < 1 || m > 1440) return invalid("demo_daily_minutes must be a whole number from 1 to 1440", raw);
    minutes = m;
  }
  return {
    kind: "on",
    config: {
      demoTenants: new Set(tenants),
      oldLoginUsers: new Set(users.map((u) => u.toLowerCase())),
      allowNumbers: new Set(allow as string[]),
      guardStart: new Date(Date.parse(start)).toISOString(),
      demoDailyMinutes: minutes,
    },
  };
}

let cache: { raw: string | undefined; state: DialGuardState } | null = null;
let offNoted = false;

/** The secret, parsed once per value (it does not change under a running isolate). */
export function dialGuardState(env: Env): DialGuardState {
  const raw = env.PHONE_DIAL_GUARD;
  if (cache && cache.raw === raw) return cache.state;
  const state = parseDialGuard(raw);
  cache = { raw, state };
  return state;
}

/** Tests only. */
export function _resetDialGuard(): void {
  cache = null;
  offNoted = false;
}

/**
 * Could an unreadable secret name this person or business? Their user id (with or without its
 * hyphens) or their business id appears anywhere in the raw text. The broad answer on purpose:
 * while the secret is broken, refusing someone it didn't mean is the safe mistake.
 */
function couldBeNamed(raw: string, userId: string | null, clientId: string | null): boolean {
  const text = raw.toLowerCase();
  const u = String(userId ?? "").trim().toLowerCase();
  if (u && (text.includes(u) || text.includes(u.replace(/-/g, "")))) return true;
  const c = String(clientId ?? "").trim().toLowerCase();
  return !!c && text.includes(c);
}

/** The rule this caller is under, or null. A demo business wins over the old-login list. */
export function guardModeFor(state: DialGuardState, userId: string, clientId: string): GuardMode | null {
  if (state.kind === "off") return null;
  if (state.kind === "invalid") return couldBeNamed(state.raw, userId, clientId) ? "unreadable" : null;
  if (state.config.demoTenants.has(clientId)) return "demo";
  if (state.config.oldLoginUsers.has(String(userId).toLowerCase())) return "old_login";
  return null;
}

/**
 * Say how the guard stands, at most: off once per isolate on the console (nothing else changes,
 * so no app_errors row), unreadable as an error every 10 minutes per isolate.
 */
export function noteGuardState(ec: Ctx, state: DialGuardState): void {
  if (state.kind === "off") {
    if (!offNoted) {
      offNoted = true;
      console.warn(`[phone-api] info dial_guard_off: ${DIAL_GUARD_SECRET} is not set, so no business or login is guarded.`);
    }
    return;
  }
  if (state.kind === "invalid") {
    ec.waitUntil(logFault({
      code: "dial_guard_config_invalid", severity: "error", throttleMs: 10 * 60_000,
      message: `${DIAL_GUARD_SECRET} is set but can't be read (${state.reason}). Calls, texts and forwards are refused for every login and business it could name.`,
    }));
  }
}

/** The guard's rule for one caller, with its state noted. */
export function guardFor(env: Env, ec: Ctx, userId: string, clientId: string): { state: DialGuardState; mode: GuardMode | null } {
  const state = dialGuardState(env);
  noteGuardState(ec, state);
  return { state, mode: guardModeFor(state, userId, clientId) };
}

/**
 * Is a stored "Forward to my cell" rung for this person? Not while they are guarded (or an
 * unreadable secret could name them). Synchronous, for the TwiML builders on the inbound path.
 */
export function cellForwardAllowed(env: Env, userId: string, clientId: string): boolean {
  return guardModeFor(dialGuardState(env), userId, clientId) === null;
}

/**
 * Why a business's own forward (after hours, or when nobody answers) may NOT ring this number, or
 * null when it may. On a demo business only a number in allow_numbers rings ("demo"); on a business
 * an unreadable secret could name, none does ("unreadable"). Every other business: as before.
 * (Old-login mode is about one login, not the business's forward. A login with phone `edit` can
 * set that forward in the portal, so the old login must not have it: DEVIATIONS 83, "Not covered".)
 */
export function routeForwardRefusal(env: Env, clientId: string, e164: string): GuardMode | null {
  const state = dialGuardState(env);
  if (state.kind === "off") return null;
  if (state.kind === "invalid") return couldBeNamed(state.raw, null, clientId) ? "unreadable" : null;
  if (!state.config.demoTenants.has(clientId)) return null;
  const n = toE164(e164);
  return n && state.config.allowNumbers.has(n) ? null : "demo";
}

/** Today's outbound minute cap for this caller: a demo business's own cap, never above the Worker's. */
export function minuteCapFor(state: DialGuardState, mode: GuardMode | null, workerCap: number): number {
  if (mode !== "demo" || state.kind !== "on") return workerCap;
  const demo = state.config.demoDailyMinutes;
  return workerCap > 0 ? Math.min(workerCap, demo) : demo;
}

// ── The decision ────────────────────────────────────────────────────────────────────

/** Texts read per old-login check. A full page can't prove there is nothing older, so it refuses. */
export const TEXT_SCAN = 500;

export type GuardVerdict =
  | { ok: true }
  | {
    ok: false;
    mode: GuardMode;
    /** Counts only, for the log line: never a number, a name or an id. */
    counts: Record<string, number | boolean>;
    /** The old-login lookup failed: the database's error code, logged on its own line. */
    lookupFailed?: string | null;
  };

class LookupFailed extends Error {
  constructor(readonly pg: string | null) {
    super("dial guard lookup failed");
  }
}

async function search(admin: Admin, clientId: string, kind: string, digits: string, args: Record<string, unknown>): Promise<Record<string, unknown>[]> {
  // POST rpc: the digits travel in the body (migration 305's whole point), never in a URL.
  const { data, error } = await admin.rpc("phone_list_search", { p_client_id: clientId, p_kind: kind, p_digits: digits, ...args });
  if (error) throw new LookupFailed((error as { code?: string }).code ?? null);
  if (!Array.isArray(data)) throw new LookupFailed(null);
  return data as Record<string, unknown>[];
}

/**
 * crm_contact_people rows per read, and reads per check at most. A short page ends the reads, so
 * this must not be above the project's PostgREST max-rows (1000, Supabase's default, which the
 * Worker's other paged reads rely on too).
 */
export const PEOPLE_PAGE = 1000;
export const PEOPLE_PAGES = 20;

/**
 * How many of the business's extra people on its contacts (crm_contact_people, migration 190: a
 * spouse or partner from a design's second phone (191), a merged-away contact's number (192), a
 * second number from the GHL import (282)) hold `digits`, matched as 305 matches a contact (the ten
 * digits anywhere in phone_digits). 305 has no kind for this table, so the reads are GETs that name
 * ONLY the tenant (every person with a number, paged by id) and the number is matched here: it
 * never rides in a URL. Every row is read whatever its contact (a person left on a merged-away
 * contact still counts). `full`: the reads stopped at PEOPLE_PAGES with more left, so nothing can
 * be ruled out and the caller refuses.
 */
async function peopleHolding(admin: Admin, clientId: string, digits: string): Promise<{ found: number; full: boolean }> {
  for (let page = 0; page < PEOPLE_PAGES; page++) {
    const from = page * PEOPLE_PAGE;
    const { data, error } = await admin.from("crm_contact_people").select("phone_digits")
      .eq("client_id", clientId).not("phone_digits", "is", null)
      .order("id").range(from, from + PEOPLE_PAGE - 1);
    if (error) throw new LookupFailed((error as { code?: string }).code ?? null);
    if (!Array.isArray(data)) throw new LookupFailed(null);
    const found = (data as { phone_digits?: unknown }[]).filter((r) => String(r.phone_digits ?? "").includes(digits)).length;
    if (found) return { found, full: false };
    if (data.length < PEOPLE_PAGE) return { found: 0, full: false };
  }
  return { found: 0, full: true };
}

/**
 * Old-login mode: is `to` saved on a contact of the business (the contact's own number, or another
 * person's on it), or in its calls or texts from before guard_start? One parallel round: three
 * reads through migration 305's phone_list_search (the same function the list search uses), each
 * matching the customer's side of a call or text by the number's ten digits however it was
 * stored, and the contacts' extra people (peopleHolding).
 */
async function oldLoginBlocked(admin: Admin, clientId: string, to: string, guardStart: string): Promise<{ blocked: boolean; counts: Record<string, number | boolean> }> {
  const digits = to.slice(2);
  const [contacts, people, calls, texts] = await Promise.all([
    search(admin, clientId, "contacts", digits, { p_limit: 1 }),
    peopleHolding(admin, clientId, digits),
    search(admin, clientId, "calls", digits, { p_before: guardStart, p_limit: 1, p_customers: false }),
    // 305's `texts` has no time filter: the newest page, and any text in it older than the start.
    search(admin, clientId, "texts", digits, { p_limit: TEXT_SCAN }),
  ]);
  const start = Date.parse(guardStart);
  const olderTexts = texts.filter((t) => {
    const at = Date.parse(String(t.created_at ?? ""));
    // A text with no readable time can't be shown to be new.
    return !Number.isFinite(at) || at < start;
  }).length;
  const full = texts.length >= TEXT_SCAN;
  const counts = {
    contacts: contacts.length, people: people.found, calls: calls.length, texts: olderTexts,
    ...(people.full ? { people_full: true } : {}), ...(full ? { texts_full: true } : {}),
  };
  return { blocked: contacts.length > 0 || people.found > 0 || people.full || calls.length > 0 || olderTexts > 0 || full, counts };
}

/**
 * May this guarded caller make the Worker call or text `to` (already E.164, the value that would
 * be dialed)? `numbers` are the business's own live numbers (phone_caller_context).
 */
export async function guardedNumberAllowed(
  admin: Admin,
  state: DialGuardState,
  mode: GuardMode,
  who: { clientId: string; numbers: readonly string[] },
  to: string,
): Promise<GuardVerdict> {
  if (mode === "unreadable" || state.kind !== "on") return { ok: false, mode: "unreadable", counts: {} };
  if (mode === "demo") {
    const allowed = new Set(state.config.allowNumbers);
    for (const n of who.numbers) {
      const e = toE164(n);
      if (e) allowed.add(e);
    }
    return allowed.has(to) ? { ok: true } : { ok: false, mode, counts: { allowed: allowed.size } };
  }
  try {
    const r = await oldLoginBlocked(admin, who.clientId, to, state.config.guardStart);
    return r.blocked ? { ok: false, mode, counts: r.counts } : { ok: true };
  } catch (e) {
    return { ok: false, mode, counts: { lookup_failed: true }, lookupFailed: e instanceof LookupFailed ? e.pg : null };
  }
}

/** The one log line a refusal writes: a code, the mode, what was refused, and counts. */
export function logGuardRefusal(ec: Ctx, v: Extract<GuardVerdict, { ok: false }>, what: "call" | "text" | "forward_save" | "route_forward", clientId: string): void {
  if (v.lookupFailed !== undefined) {
    // The database's code only: an error message can repeat what it was asked, digits and all.
    ec.waitUntil(logFault({
      code: "dial_guard_lookup_failed", severity: "error", clientId, throttleMs: 10 * 60_000,
      message: `The dial guard couldn't check a ${what} for a guarded login, so it was refused.`,
      context: { what, pg: v.lookupFailed ?? null },
    }));
    return;
  }
  ec.waitUntil(logFault({
    code: "dial_guard_refused", severity: "info", clientId, throttleMs: 10_000,
    message: `The dial guard refused a ${what} (${v.mode}).`,
    context: { mode: v.mode, what, ...v.counts },
  }));
}
