// _shared/accessEnforce.ts — the SERVER's read of plans as data (migrations 386 to 388).
//
// The portal half (accessPortal.ts, 01-core.jsx) decides what a company is OFFERED. This is the half
// that decides what it is ALLOWED: for a company named in access_config.enforce.server_clients, an
// edge function refuses an action whose tab the company has not got, and opens a paid action by
// the tab map instead of by the billing feature.
//
// THREE ANSWERS, AND THEIR FAIL DIRECTIONS
//   null     NOT NAMED, OR THE READ FAILED: "the rules you already had". A database error, a thrown
//            call, a malformed answer, a database without 388: all null. Null never refuses anyone
//            and never opens anything, which is the only safe direction while both sets of rules
//            exist. It is also what makes it safe to deploy the functions before any company is
//            named, and to redeploy them one at a time.
//   report   NAMED IN server_report: the old rules still decide, and an action the map WOULD refuse
//            is written to app_errors as an info row (code module_would_refuse), once per isolate
//            per action. That is how the calls a page makes to another tab's actions are found on
//            a real company's real traffic before anything is taken away from it.
//   block    NAMED IN server_clients: the map is the answer. An action whose tab is not "on" is
//            refused (MODULE_REFUSAL), and that includes "locked": a padlock in the rail is an offer
//            to buy, not access.
//
// CACHED PER ISOLATE FOR 30 SECONDS, like accountShape.ts's flag and for its reason: resolveTenant
// asks on nearly every portal call, and an uncached read would add a round trip to all of them. So
// a plan change reaches the server within 30 seconds. Cached only on a real runtime: Supabase's
// edge runtime, and the Cloudflare phone Worker (stage D: the Worker bundles this file through
// featureCheck.ts and asks on a customer's phone traffic, where an uncached read was one database
// round trip per call). Never under `deno test` or the Worker's vitest (node): the tests share one
// process, where a cache would make a test's reads depend on which test ran first. cachesHere()
// below is that decision.
// A FAILED read is remembered too, as null, but only for 10 seconds (FAIL_MS). One request can ask
// more than once: resolveTenant at the door, then jack-agent again for the turn's tools or a press.
// With nothing remembered, a database that takes N seconds to fail made that request wait N twice.
// WHAT THAT COSTS: for those 10 seconds the company keeps the old rules on this isolate, on every
// call and not only the one that failed. For a company that is not named that is no change. For a
// named one it is the old rules in both directions: a tab its plan withholds answers as it did
// before, and a paid tab its plan grants with no subscription behind it is answered by billing for
// the window, and billing says no. Short on purpose: a blip must not hold a company on the old
// rules for the full 30.
// REMEMBERING A FAILURE NEVER REPLACES AN ANSWER FROM A NEWER READ. Nothing shares one read between
// requests (the Worker could not), so two can be reading for one company at once, and the slow one
// may fail after the fast one has answered. Each entry is stamped with when it was stored, and a
// failure is remembered only over an entry stored before its own read began. So an answer in hand
// is never thrown away for a timeout that started before it arrived, and reads that overlap and
// fail one after another hold the company for 10 seconds from the first failure, not 10 from each.
// (A read that begins after those 10 seconds and fails again starts 10 more, as it should.)
//
// Dependency-free (the client is passed in). Importers: resolveTenant.ts, featureCheck.ts,
// accessCheck.ts, and jack-agent (handler.ts, agent.ts and plan.ts). All are bundled per function,
// so EVERY function that imports any of them goes out together when this changes.
// ⚠️ AND THE PHONE WORKER, TWICE. workers/phone-api/src/plan.ts imports this file directly
// (anyModuleOn and serverAccessFromAnswer, for every phone route's plan check), and
// workers/phone-api/src/routes/reads.ts imports featureCheck.ts, which imports it again, so
// wrangler bundles both into the Worker. It deploys by hand and on its own approval: a change here
// or in featureCheck.ts is not live for the phone until it is redeployed.

// deno-lint-ignore no-explicit-any
type Admin = any;

/** What a company on the map is told when it calls an action outside its plan. Answered as a 403
 *  with code "module_off": a refusal, not a fault, so withErrorLog (which files 5xx) writes no
 *  app_errors row for it. */
export const MODULE_REFUSAL =
  "This isn't part of your plan. Ask Structure Studio to add it to your account.";

export interface ServerAccess { mode: "block" | "report"; modules: Record<string, string> }

const STATES: ReadonlySet<string> = new Set(["on", "locked", "hidden", "off"]);
const KEY = /^[a-z][a-z0-9_]{1,39}$/;
const CACHE_MS = 30_000;
const FAIL_MS = 10_000;
const cache = new Map<string, { value: ServerAccess | null; until: number; at: number }>();
/** Is this a runtime where the 30-second cache is safe: one isolate serving real requests?
 *  Supabase's edge runtime defines the `EdgeRuntime` global; a Cloudflare Worker's navigator says
 *  "Cloudflare-Workers" (on for every Worker since the 2022-03-21 compatibility date). `deno test`
 *  says "Deno/…" and node says "Node.js/…" or has no navigator, so neither caches. Pure, for the
 *  tests: it is asked once, when the module loads. */
// deno-lint-ignore no-explicit-any
export function cachesHere(g: any): boolean {
  if (!g) return false;
  if (typeof g.EdgeRuntime !== "undefined") return true;
  try {
    return g.navigator?.userAgent === "Cloudflare-Workers";
  } catch {
    return false;
  }
}
const onEdge = cachesHere(globalThis);

/** access_for_server's answer, clean, or null. Pure, for the tests. A missing mode, an unknown
 *  mode, an empty map or one bad tab is null: a company with every tab refused is far likelier to
 *  be a bad answer than a plan. */
export function serverAccessFromAnswer(answer: unknown): ServerAccess | null {
  if (!answer || typeof answer !== "object" || Array.isArray(answer)) return null;
  const a = answer as { mode?: unknown; modules?: unknown };
  if (a.mode !== "block" && a.mode !== "report") return null;
  const m = a.modules;
  if (!m || typeof m !== "object" || Array.isArray(m)) return null;
  const modules: Record<string, string> = {};
  let n = 0;
  for (const [k, v] of Object.entries(m as Record<string, unknown>)) {
    if (!KEY.test(k) || typeof v !== "string" || !STATES.has(v)) return null;
    modules[k] = v;
    n++;
  }
  return n > 0 ? { mode: a.mode, modules } : null;
}

/** The company's server answer (block or report), else null (the old rules). Never throws. */
export function serverAccess(admin: Admin, clientId: string): Promise<ServerAccess | null> {
  return serverAccessOn(admin, clientId, onEdge);
}

/** serverAccess with the runtime's two facts handed in, so the tests can hold the cache itself:
 *  whether this runtime caches (never under a test, see the header) and the clock. Everything else
 *  calls serverAccess. A good answer is remembered for CACHE_MS and a failed read, as null, for
 *  FAIL_MS; a client that cannot ask at all is not a read and is not remembered. A failed read is
 *  not remembered either when another read for the company stored its answer while this one was
 *  out: that answer stays, for the time it was given. */
export async function serverAccessOn(admin: Admin, clientId: string, caches: boolean, now: () => number = Date.now): Promise<ServerAccess | null> {
  if (!clientId) return null;
  if (caches) {
    const hit = cache.get(clientId);
    if (hit && now() < hit.until) return hit.value;
  }
  // Two requests can be reading for one company at once, and this one may fail after the other has
  // answered. So a failure is remembered only over an entry that was already here when this read
  // began (`at` is when an entry was stored): never over one stored while this read was out, good
  // or null. `<` and not `<=`: an entry stored on the very tick this read began is either one this
  // read would have been served from, or a sibling's.
  const began = now();
  const failed = (): null => {
    if (caches) {
      const cur = cache.get(clientId);
      const at = now();
      if (!cur || cur.at < began) cache.set(clientId, { value: null, until: at + FAIL_MS, at });
    }
    return null;
  };
  try {
    if (!admin || typeof admin.rpc !== "function") return null;
    const { data, error } = await admin.rpc("access_for_server", { p_client_id: clientId });
    if (error) {
      console.error("access_for_server failed; this company keeps the old rules:", error.message ?? error);
      return failed();
    }
    const value = serverAccessFromAnswer(data);
    if (caches) {
      const at = now();
      cache.set(clientId, { value, until: at + CACHE_MS, at });
    }
    return value;
  } catch (e) {
    console.error("access_for_server threw; this company keeps the old rules:", (e as Error)?.message ?? e);
    return failed();
  }
}

/** The map when the server BLOCKS by it, else null. For the paid-feature checks: in report mode the
 *  old rules still decide, so they must not see the map. */
export async function serverModules(admin: Admin, clientId: string): Promise<Record<string, string> | null> {
  const a = await serverAccess(admin, clientId);
  return a && a.mode === "block" ? a.modules : null;
}

/** Is at least one of these tabs ON in the map? An action that belongs to several tabs (a payload
 *  two pages share) is allowed when the company has any of them. */
export function anyModuleOn(map: Record<string, string>, keys: readonly string[]): boolean {
  return keys.some((k) => map[k] === "on");
}

// Report mode: one row per (company, function, action) per isolate. An isolate lives minutes, so a
// busy page writes a handful of rows, not one per call.
const reported = new Set<string>();
/** Has this would-be refusal already been reported by this isolate? Marks it as reported. */
export function firstReport(clientId: string, fn: string, action: string): boolean {
  const k = `${clientId}\u0000${fn}\u0000${action}`;
  if (reported.has(k)) return false;
  if (reported.size > 5000) reported.clear();
  reported.add(k);
  return true;
}
