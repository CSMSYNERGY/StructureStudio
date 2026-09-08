// WHO MAY OPEN THE INTERNAL PROJECTS CONSOLE — the two doors, in one place.
//
// Extracted from portal-projects' request handler rather than left inline, for one reason:
// this is the boundary between "CSM Synergy's own bug board" and "every builder's account",
// and a rule that can only be exercised by signing in as four different people is a rule
// nobody re-checks after the next edit. As a function it gets pinned by
// _test_stubs/projectsAccess_test.ts on every push.
//
// ── THE TWO DOORS ────────────────────────────────────────────────────────────────────────
//
//   1. an `app_operators` row — the platform operator. They belong to NO tenant by design
//      (client_users.user_id is a primary key, so a login is a member of at most one, and a
//      cross-tenant operator is a member of none). resolveTenant has always supported that
//      and resolveTenant_test.ts pins it; if this function ever started requiring a tenant
//      row, every CSM operator who is not on one would lose the console.
//
//   2. a `client_users` row on an INTERNAL tenant whose resolved `projects` level is not
//      'none' — added 2026-09-02 for Carolyn: "here we say ... we give them access to
//      projects." Before this, the only way onto the board was door 1, which is the same
//      grant that opens every customer's data. Filing a bug should not require that.
//
// ⚠️ THE INTERNAL CHECK IS THE BOUNDARY. THE AREA IS NOT.
// Every builder's OWNER resolves projects='edit' — owners are absolute inside
// effectiveAccess, by construction and deliberately, so their stored map can never lock them
// out of their own business. That means the area alone would admit every customer on the
// platform. `client_settings.internal_account` (migration 169, "this tenant IS US") is the
// only thing standing between Junior Barns' owner and CSM's roadmap. Read that twice before
// simplifying anything below.
//
// Door 1 is evaluated first and independently, so nothing here can regress an operator.

import { canRead, effectiveAccess, type Level } from "./access.ts";
import { isInternalTenant } from "./internalTenant.ts";

export interface OperatorRow {
  user_id: string;
  email?: string | null;
  can_write?: boolean | null;
  display_name?: string | null;
  support_only?: boolean | null;
}

export interface ProjectsAccess {
  /** The operator row, or null when they came through door 2. */
  op: OperatorRow | null;
  /** The team member's resolved access map, or null when they came through door 1. */
  teamAcc: Record<string, Level> | null;
}

// deno-lint-ignore no-explicit-any
type Admin = any;

/**
 * Resolve how (or whether) this login may reach Projects.
 *
 * Returns null when NEITHER door opens — the caller turns that into its 403. Throws only on
 * a database fault, which the caller turns into a 500: an unreadable client_settings must
 * never be read as "not internal, carry on", because that is the direction that grants.
 */
export async function resolveProjectsAccess(admin: Admin, userId: string): Promise<ProjectsAccess | null> {
  const opRes = await admin
    .from("app_operators")
    .select("user_id, email, can_write, display_name, support_only")
    .eq("user_id", userId)
    .maybeSingle();
  if (opRes.error) throw new Error(opRes.error.message);
  if (opRes.data) return { op: opRes.data as OperatorRow, teamAcc: null };

  // ⚠️ .limit(1), never .maybeSingle(): a duplicate client_users row is a data fault and must
  // not become an exception at the door — that would turn one bad row into a hard lockout.
  // Same idiom and same reason as resolveTenant's own read of this table.
  const cuRes = await admin
    .from("client_users").select("client_id, role, title, access")
    .eq("user_id", userId).limit(1);
  if (cuRes.error) throw new Error(cuRes.error.message);
  const cu = cuRes.data && cuRes.data[0];
  if (!cu || !cu.client_id) return null;

  if (!(await isInternalTenant(admin, cu.client_id))) return null;

  const acc = effectiveAccess(cu.role, cu.title, cu.access ?? null) as Record<string, Level>;
  if (!canRead(acc, "projects")) return null;
  return { op: null, teamAcc: acc };
}
