// Plans as data, the phone Worker's half (stage D; migrations 386 to 388).
//
// The edge functions refuse an action whose tab a company has not got (_shared/accessEnforce.ts,
// resolveTenant.ts). The portal never calls or texts, though: the apps do, through this Worker, and
// stage C left "must not CALL" to it (_shared/accessActions.ts). This file is the Worker's read of
// the same answer, public.access_for_server, and the three tabs it acts on:
//   phone     placing a call, taking one, and every app route that needs the line switched on
//   sms       sending a text
//   contacts  the contact list and its search
//
// THREE ANSWERS, the edge's own (accessEnforce.ts):
//   null     NOT NAMED, OR THE READ FAILED, OR IT WAS SLOW: exactly the rules the Worker already
//            had. Null never refuses anyone and never opens anything.
//   report   the old rules still decide; what WOULD be refused is filed as an info row
//            (module_would_refuse), once per isolate per company and action.
//   block    a tab that is not exactly "on" is not had ("locked" is an offer to buy, not access).
// A plan only ever stops NEW work. Nothing here is asked on a call in flight, a 911 call or its
// callback, a text coming in, a charge being posted, sign-out or a person's own settings: those
// routes never import this file, and the apps' controls on a call already up (hold, resume,
// transfer, moving it to the other device) tell requireCaller not to ask (plan: false).
// THE 911 CALLBACK NEEDS A LINE TO RING. /voice/inbound rings only the person who dialed 911 for
// the next 60 minutes, on the line /token mints (which lasts that same hour). So the two places
// that answer phone_off for a plan (/token, and requireCaller's default) first ask
// emergencyWindowOpen, below: inside that person's own 60 minutes the plan does not refuse them.
//
// WHY NOT serverAccess ITSELF. It asks access_for_server for EVERY company, named or not: cached
// per company for 30 seconds (in a Worker too, since stage D's cachesHere), but still one database
// call per company per isolate each time that runs out, with no bound on how long it may take.
// Twilio waits on two of these answers before anyone hears a ring. So the Worker asks in two
// steps, each cached per isolate the way twilioAccount.ts caches a business's account:
//   1. planNamed  WHO is named at all: the one access_config row (key 'enforce'), 30 seconds.
//                 While nobody is named, which is every company today, that is the only read, and
//                 callers start it beside the read they already make (planNamedSoon) and hand it
//                 to planFor, so the not-named world gains no serial round trip.
//   2. planFor    for a company that IS named, access_for_server, 30 seconds per company.
// So a change to a plan, or to who is named, reaches the Worker within about 30 seconds. Failures
// are never kept: the next request asks again.
//
// Every read here ends in a value, never a throw and never an app_errors row: a started read is
// often left behind (the caller refused first, or answered Twilio), and a plan read that failed
// must leave the request exactly as it was. Failures go to the console, as serverAccess's do.
//
// ⚠️ ONLY VALUES ARE KEPT BETWEEN REQUESTS, NEVER A READ UNDER WAY. A Worker cancels a request's
// unfinished I/O when that request ends, and a second request waiting on the first one's promise
// then waits for ever. The early read is exactly the kind a request walks away from (it refused,
// or it answered Twilio), so the promise planNamedSoon returns belongs to the request that started
// it and is passed along by hand; two requests that both find the cache cold each read the row.
//
// A READ THAT PASSES ITS BOUND is null to the request that was waiting (the old rules), and what
// becomes of the read itself depends on the route:
//   the two call webhooks  hand it to waitUntil (planFor's `keep`), so it still lands and fills
//   and /token             the cache: the NEXT call (or line) finds the answer waiting instead of
//                          paying the bound again and again by the old rules while the database
//                          is slow.
//   any other app route    has no waitUntil in requireCaller: the read ends with the request and
//                          the next request asks again.
// Either way it is counted, and one console line a minute per isolate says how many there were
// (noteSlow): without it a slow stretch looks exactly like "nobody is named", and in report mode
// like "nothing would be refused". That count is of the two PLAN reads only. The 911 window read
// (emergencyWindowOpen) writes its own line when it passes its bound.

import type { Admin } from "./db";
import { logFault } from "./log";
import { anyModuleOn, serverAccessFromAnswer, type ServerAccess } from "../../../supabase/functions/_shared/accessEnforce.ts";

export type { ServerAccess };

/** The tab behind calling, and behind every app route that needs the line on. */
export const PHONE_TAB: readonly string[] = ["phone"];
/** The tab behind sending a text. */
export const SMS_TAB: readonly string[] = ["sms"];
/** The tab behind the contact list and its search. */
export const CONTACTS_TAB: readonly string[] = ["contacts"];

/**
 * The longest a plan read may hold up Twilio on /voice/outbound and /voice/inbound. Past it the
 * call goes on by the old rules (null): a slow database must never cost a caller their ring.
 */
export const VOICE_PLAN_MS = 400;
/** The same bound for an app route, where a person is waiting rather than a ringing phone. */
export const APP_PLAN_MS = 2000;

const TTL_MS = 30_000;
const PLAN_CACHE_MAX = 1000;
const REPORTED_MAX = 5000;

// ── 1. Who is named ─────────────────────────────────────────────────────────────────

export interface PlanNamed {
  /** server_all: every company is blocked by its map. */
  all: boolean;
  /** server_clients: these companies are blocked by their maps. */
  block: ReadonlySet<string>;
  /** server_report: these are only reported on. */
  report: ReadonlySet<string>;
}

const NOBODY: PlanNamed = { all: false, block: new Set(), report: new Set() };

/** A jsonb array's string members, as SQL's `?` sees them. Anything that is not an array is empty. */
function names(v: unknown): Set<string> {
  const out = new Set<string>();
  if (Array.isArray(v)) for (const x of v) if (typeof x === "string") out.add(x);
  return out;
}

/**
 * access_config.enforce's value as migration 388 reads it, with the same tolerance: server_all
 * counts only as the boolean true, each list only as a real array (and only its strings), and a
 * value that is not an object names nobody. Each key is read on its own, as the SQL does, so one
 * malformed key does not hide a good one. Pure, for the tests.
 */
export function planNamedFromValue(value: unknown): PlanNamed {
  if (!value || typeof value !== "object" || Array.isArray(value)) return NOBODY;
  const v = value as Record<string, unknown>;
  return { all: v.server_all === true, block: names(v.server_clients), report: names(v.server_report) };
}

function isNamed(n: PlanNamed, clientId: string): boolean {
  return n.all || n.block.has(clientId) || n.report.has(clientId);
}

let named: { until: number; value: PlanNamed } | null = null;
/** Bumped by the test reset, so a read that lands after it cannot fill the next test's cache. */
let generation = 0;

async function readNamed(admin: Admin): Promise<PlanNamed> {
  const gen = generation;
  try {
    const { data, error } = await admin.from("access_config").select("value").eq("key", "enforce").maybeSingle();
    if (error) {
      console.warn(`[phone-api] access_config could not be read; nobody is on a plan map meanwhile: ${error.message ?? "no message"}`);
      return NOBODY;
    }
    const value = planNamedFromValue((data as { value?: unknown } | null)?.value);
    if (gen === generation) named = { until: Date.now() + TTL_MS, value };
    return value;
  } catch (e) {
    console.warn(`[phone-api] access_config read threw; nobody is on a plan map meanwhile: ${(e as Error)?.message ?? e}`);
    return NOBODY;
  }
}

/**
 * Who the server switch names (access_config.enforce), cached 30 seconds per isolate. A failed
 * read names nobody and is not kept. Never throws.
 */
export function planNamed(admin: Admin, now: number = Date.now()): Promise<PlanNamed> {
  if (named && named.until > now) return Promise.resolve(named.value);
  return readNamed(admin);
}

/**
 * Start the "who is named" read now, without waiting for it, and hand back its promise for
 * planFor's `named`. Called just before the read a handler already makes (phone_caller_context,
 * phone_route_for_number), so the two travel together and planFor, asked once the company is
 * known, finds the answer already here. The promise never rejects, so a handler that returns
 * before using it leaves nothing behind. It is this request's own: never keep it between requests.
 */
export function planNamedSoon(admin: Admin): Promise<PlanNamed> {
  return planNamed(admin);
}

// ── 2. One company's answer ─────────────────────────────────────────────────────────

const planCache = new Map<string, { until: number; plan: ServerAccess | null }>();

async function readPlan(admin: Admin, clientId: string, namedRead: Promise<PlanNamed> | undefined): Promise<ServerAccess | null> {
  const gen = generation;
  try {
    // Named first, the cache second: a company taken off the list is back on the old rules at the
    // list's next read, not when its own cached answer runs out as well.
    if (!isNamed(await (namedRead ?? planNamed(admin)), clientId)) return null;
    const hit = planCache.get(clientId);
    if (hit && hit.until > Date.now()) return hit.plan;
    const { data, error } = await admin.rpc("access_for_server", { p_client_id: clientId });
    if (error) {
      console.warn(`[phone-api] access_for_server failed; this company keeps the old rules: ${error.message ?? "no message"}`);
      return null;
    }
    const plan = serverAccessFromAnswer(data);
    if (gen === generation) {
      if (planCache.size >= PLAN_CACHE_MAX && !planCache.has(clientId)) planCache.clear();
      planCache.set(clientId, { until: Date.now() + TTL_MS, plan });
    }
    return plan;
  } catch (e) {
    console.warn(`[phone-api] access_for_server threw; this company keeps the old rules: ${(e as Error)?.message ?? e}`);
    return null;
  }
}

// How many plan reads passed their bound since the last console line, and when that line was.
const SLOW_WARN_MS = 60_000;
let slow = { count: 0, warnedAt: 0 };

/** A plan read passed its bound: count it, and say so at most once a minute per isolate. */
function noteSlow(ms: number): void {
  slow.count++;
  const now = Date.now();
  if (now - slow.warnedAt < SLOW_WARN_MS) return;
  console.warn(`[phone-api] a plan read passed its ${ms} ms bound (${slow.count} since the last line like this); the old rules applied meanwhile`);
  slow = { count: 0, warnedAt: now };
}

/**
 * `p`, or null once `ms` has passed; `late` is then told. Nothing here keeps `p` going: whether it
 * still lands is the caller's business (see "A READ THAT PASSES ITS BOUND" at the top).
 */
function within<T>(p: Promise<T | null>, ms: number, late: () => void): Promise<T | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      resolve(null);
      late();
    }, ms);
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      () => {
        clearTimeout(timer);
        resolve(null);
      },
    );
  });
}

/**
 * The company's plan answer: null (the old rules), or { mode: "block" | "report", modules }.
 * Null unless the switch names this company, so while nobody is named no per-company read is ever
 * made. Null too for a failed, malformed or slow read (`timeoutMs`, default APP_PLAN_MS; the two
 * voice webhooks pass VOICE_PLAN_MS). Cached 30 seconds per company, successful reads only.
 * `named` is the read this request started early (planNamedSoon); without it the kept answer is
 * used, or the row is read now. `keep` is the request's waitUntil: a read that passed its bound is
 * handed to it, so it is not cancelled when the request answers and its answer is in the cache for
 * the next one (the runtime gives such work 30 seconds at most). Without `keep` a late read ends
 * with the request. Never throws.
 */
export function planFor(
  admin: Admin, clientId: string,
  opts: { named?: Promise<PlanNamed>; timeoutMs?: number; keep?: (read: Promise<unknown>) => void } = {},
): Promise<ServerAccess | null> {
  const id = String(clientId ?? "");
  if (!id) return Promise.resolve(null);
  const ms = opts.timeoutMs ?? APP_PLAN_MS;
  const read = readPlan(admin, id, opts.named);
  return within(read, ms, () => {
    noteSlow(ms);
    // readPlan never rejects, so this hands over nothing that can fail. The try is for a request
    // that answered before the bound ran out (it refused first): there is no one left to keep for.
    try {
      opts.keep?.(read);
    } catch { /* the request is over */ }
  });
}

// ── What the answer says about one action ───────────────────────────────────────────

export type PlanVerdict = "ok" | "report" | "refuse";

/**
 * ok: no plan answer (the old rules), or the company has one of these tabs "on".
 * refuse: block mode and none of them is on. report: the same in report mode, where nothing is
 * refused and the caller files a row (planReport).
 */
export function planVerdict(plan: ServerAccess | null | undefined, tabs: readonly string[]): PlanVerdict {
  if (!plan || anyModuleOn(plan.modules, tabs)) return "ok";
  return plan.mode === "block" ? "refuse" : "report";
}

// Report mode: one row per (company, action) per isolate, as the edge's firstReport keeps one per
// (company, function, action). Kept here rather than borrowed, so the tests can start it empty.
const reported = new Set<string>();

/**
 * File what report mode would have refused: one info row, code module_would_refuse, the first time
 * this isolate sees this company and action. `action` is one of this Worker's own fixed names
 * (app_route, token, outbound_call, inbound_call, sms_send, contacts_list, contacts_search),
 * never a request path: a thread's path carries a customer's number, and these
 * rows are read in summary only (logPrivacy.ts). The row names the company, the action and its
 * tabs' states, and nothing about any person or customer. Never throws.
 */
export function planReport(clientId: string, action: string, plan: ServerAccess, tabs: readonly string[]): Promise<void> {
  const k = `${clientId}\u0000${action}`;
  if (reported.has(k)) return Promise.resolve();
  if (reported.size > REPORTED_MAX) reported.clear();
  reported.add(k);
  return logFault({
    code: "module_would_refuse", severity: "info", clientId,
    message: `Report only: ${action} would be refused (needs ${tabs.join(" or ")}).`,
    context: { action, tabs: [...tabs], states: Object.fromEntries(tabs.map((t) => [t, plan.modules[t] ?? null])) },
  });
}

/**
 * For an app route, where the person can wait for one insert: true when the plan refuses these
 * tabs. In report mode it files the row, AWAITED (work a response does not wait for can be
 * dropped, and a report that never lands reads as "nothing would be refused"), and answers false.
 * The two voice webhooks use planVerdict and hand planReport to waitUntil instead: Twilio is
 * waiting, and waitUntil is this runtime's promise that the row is still written.
 */
export async function planRefuses(plan: ServerAccess | null | undefined, clientId: string, action: string, tabs: readonly string[]): Promise<boolean> {
  const verdict = planVerdict(plan, tabs);
  if (verdict === "report") await planReport(clientId, action, plan!, tabs);
  return verdict === "refuse";
}

// ── The 911 callback window ─────────────────────────────────────────────────────────

/**
 * How long after a 911 call the dispatcher's callback rings only the person who dialed: the
 * database's own 60 minutes (phone_route_for_number's recent_emergency_user, migration 266).
 * /token's line lasts the same hour (TOKEN_TTL), which is why a refresh can fall inside it.
 */
export const EMERGENCY_WINDOW_MS = 60 * 60_000;

/**
 * Did this person place a 911 call in the last 60 minutes? Asked ONLY when the plan is about to
 * answer phone_off (/token, requireCaller), so no request the plan lets through pays for it.
 * A plan never refuses 911 or its callback, and the callback rings this person's own line: with
 * the answer true the plan does not refuse them that line, nor send their app to its "not
 * switched on" screen. That is wider than the callback alone: inside the window this one person's
 * default app routes (requireCaller) all answer as they did before plans. So a text still follows
 * the `sms` tab and the contact list the `contacts` tab, and recording a greeting still rings
 * their own app (routes/greeting.ts places that call itself, not through /voice/outbound). A new
 * call that is not 911 is still refused at /voice/outbound.
 *
 * The rows are the ones recent_emergency_user is read from (migration 266): an OUTBOUND call
 * marked is_emergency, placed by a person, started inside the 60 minutes. That rule is asked per
 * NUMBER and names whoever dialed last; this one is asked per PERSON within their company, so it
 * says yes to everyone the database would ring, and also to a person whose 911 call was followed
 * by a teammate's from the same number. It can only ever refuse fewer people, never more. The
 * partial index phone_calls_emergency_idx (254) covers the read: it holds only outbound
 * emergency calls, of every company. The 60 minutes are counted on this Worker's clock, the
 * database's on its own: seconds apart at the very edge.
 *
 * TRUE TOO when the read fails, throws, answers something that is not rows, or passes `timeoutMs`:
 * a read that failed must never refuse. Nothing is kept: a "no" kept for even a few seconds
 * would refuse the person who dials 911 next. Never throws.
 *
 * A read that failed, threw or passed its bound is said on the console in the window's OWN words
 * (an answer that is not rows writes nothing). A slow one is not counted with the plan reads
 * (noteSlow): that line sends its reader to access_config and access_for_server, and here those
 * answered. It was phone_calls that was slow, and a blocked company was let through on it. Every
 * time, not once a minute: it can only happen to a request the plan was about to refuse.
 */
export function emergencyWindowOpen(admin: Admin, clientId: string, userId: string, timeoutMs: number = APP_PLAN_MS): Promise<boolean> {
  const read = (async (): Promise<boolean> => {
    try {
      const { data, error } = await admin.from("phone_calls").select("id")
        .eq("client_id", clientId).eq("placed_by", userId).eq("is_emergency", true).eq("direction", "out")
        .gt("started_at", new Date(Date.now() - EMERGENCY_WINDOW_MS).toISOString())
        .limit(1);
      if (error) {
        console.warn(`[phone-api] the 911 callback window could not be read; the plan refuses nobody meanwhile: ${error.message ?? "no message"}`);
        return true;
      }
      return !Array.isArray(data) || data.length > 0;
    } catch (e) {
      console.warn(`[phone-api] the 911 callback window read threw; the plan refuses nobody meanwhile: ${(e as Error)?.message ?? e}`);
      return true;
    }
  })();
  // within() answers null for a read that passed its bound (or rejected, which this one cannot).
  return within(read, timeoutMs, () => {
    console.warn(`[phone-api] the 911 callback window read passed its ${timeoutMs} ms bound; the plan refuses nobody meanwhile`);
  }).then((open) => open ?? true);
}

/** Tests only: every test starts with nothing cached and nothing reported. */
export function _resetPlanCaches(): void {
  generation++;
  named = null;
  planCache.clear();
  reported.clear();
  slow = { count: 0, warnedAt: 0 };
}
