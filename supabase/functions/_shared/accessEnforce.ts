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
// a plan change reaches the server within 30 seconds. Only a successful read is cached, and only on
// the edge runtime (the tests share one process, where a cache would make a test's reads depend on
// which test ran first).
//
// Dependency-free (the client is passed in). Importers: resolveTenant.ts, featureCheck.ts. Both are
// bundled per function, so EVERY function that imports either goes out together when this changes.

// deno-lint-ignore no-explicit-any
type Admin = any;

/** What a company on the map is told when it calls an action outside its plan. 403, so app_errors
 *  files it as a refusal (info), not a fault. */
export const MODULE_REFUSAL =
  "This isn't part of your plan. Ask Structure Studio to add it to your account.";

export interface ServerAccess { mode: "block" | "report"; modules: Record<string, string> }

const STATES: ReadonlySet<string> = new Set(["on", "locked", "hidden", "off"]);
const KEY = /^[a-z][a-z0-9_]{1,39}$/;
const CACHE_MS = 30_000;
const cache = new Map<string, { value: ServerAccess | null; at: number }>();
// deno-lint-ignore no-explicit-any
const onEdge = typeof (globalThis as any).EdgeRuntime !== "undefined";

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
export async function serverAccess(admin: Admin, clientId: string): Promise<ServerAccess | null> {
  if (!clientId) return null;
  if (onEdge) {
    const hit = cache.get(clientId);
    if (hit && Date.now() - hit.at < CACHE_MS) return hit.value;
  }
  try {
    if (!admin || typeof admin.rpc !== "function") return null;
    const { data, error } = await admin.rpc("access_for_server", { p_client_id: clientId });
    if (error) {
      console.error("access_for_server failed; this company keeps the old rules:", error.message ?? error);
      return null;
    }
    const value = serverAccessFromAnswer(data);
    if (onEdge) cache.set(clientId, { value, at: Date.now() });
    return value;
  } catch (e) {
    console.error("access_for_server threw; this company keeps the old rules:", (e as Error)?.message ?? e);
    return null;
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
