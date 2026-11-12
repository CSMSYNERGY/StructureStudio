// _shared/accessPortal.ts — the portal's read of plans as data (migrations 386 and 387).
//
// portal-billing sends the entitlement that decides what a company's portal shows. This adds one
// field to it: `modules`, the resolver's answer for every tab ({ tab: on | locked | hidden | off }),
// and ONLY for a company whose rollout switch is on (public.access_for_portal, migration 387).
// For every other company it is null, and the portal keeps working its tabs out the old way.
//
// ONE RULE: A FAILURE IS "NOT ENFORCED". An error from the database, a thrown call, an answer of
// the wrong shape, an unknown state for any tab: all of them return null. Null never grants and
// never refuses; it means "use the rules you already had". That is the safe direction while both
// sets of rules exist, and it is why the old ones must stay in place until the rollout is finished.
// It also means a database without 387 (a restored snapshot) changes nothing.
//
// NOT CACHED. portal-billing's `status` runs once per sign-in and on the hourly refresh, and an
// operator who changes a plan expects the next reload to show it.
//
// Dependency-free (the client is passed in). Importer: portal-billing. Deploy it when this changes.

// deno-lint-ignore no-explicit-any
type Admin = any;

const STATES: ReadonlySet<string> = new Set(["on", "locked", "hidden", "off"]);
const KEY = /^[a-z][a-z0-9_]{1,39}$/;

/** access_for_portal's answer as a clean map, or null when the company is not enforced or the
 *  answer is not exactly what the resolver promises. Pure, for the tests. */
export function modulesFromAnswer(answer: unknown): Record<string, string> | null {
  if (!answer || typeof answer !== "object" || Array.isArray(answer)) return null;
  const a = answer as { enforced?: unknown; modules?: unknown };
  if (a.enforced !== true) return null;
  const m = a.modules;
  if (!m || typeof m !== "object" || Array.isArray(m)) return null;
  const out: Record<string, string> = Object.create(null);
  let n = 0;
  for (const [k, v] of Object.entries(m as Record<string, unknown>)) {
    if (!KEY.test(k) || typeof v !== "string" || !STATES.has(v)) return null;
    out[k] = v;
    n++;
  }
  // An enforced company with an empty map would hide every tab. The resolver always answers for
  // every catalogue tab, so empty means something is wrong: not enforced.
  return n > 0 ? { ...out } : null;
}

/** What portal-billing needs for one company on the map: its tabs, and whether an operator granted
 *  it something directly (an assigned plan, a tab switched on), which is what opens the billing gate
 *  for a company with no card subscription. */
export interface PortalAccess { modules: Record<string, string>; granted: boolean }

/** access_for_portal's answer as { modules, granted }, or null when the company is not enforced or
 *  the answer is not clean. `granted` is strictly true; anything else is false. Pure, for the tests. */
export function accessFromAnswer(answer: unknown): PortalAccess | null {
  const modules = modulesFromAnswer(answer);
  if (!modules) return null;
  return { modules, granted: (answer as { granted?: unknown }).granted === true };
}

/** One company's access by the new map when its rollout switch is on, else null (the old rules). */
export async function portalAccess(admin: Admin, clientId: string): Promise<PortalAccess | null> {
  try {
    if (!admin || typeof admin.rpc !== "function" || !clientId) return null;
    const { data, error } = await admin.rpc("access_for_portal", { p_client_id: clientId });
    if (error) {
      console.error("access_for_portal failed; this company keeps the old rules:", error.message ?? error);
      return null;
    }
    return accessFromAnswer(data);
  } catch (e) {
    console.error("access_for_portal threw; this company keeps the old rules:", (e as Error)?.message ?? e);
    return null;
  }
}
