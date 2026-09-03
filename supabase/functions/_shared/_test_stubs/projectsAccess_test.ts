// Who may open the internal Projects console — the two doors, pinned.
//
// WHY THIS EXISTS. Projects is CSM Synergy's own board (bugs, roadmap, every builder's setup
// checklist), and until 2026-09-02 the only way in was an app_operators row — the SAME grant
// that opens every customer's account. Carolyn asked for the second door ("here we say ...
// we give them access to projects") so that filing a bug does not require handing someone
// every builder's data.
//
// A second door into a console like this is exactly the kind of change that is correct on
// the day it ships and wrong six weeks later, and it CANNOT be exercised by hand without
// creating four logins on two tenants and signing in as each. So the rule runs here, on
// every push.
//
// ⚠️ THE ASSERTION THAT MATTERS MOST is "a builder's owner is refused". Every owner of every
// tenant resolves projects='edit' — owners are absolute inside effectiveAccess, deliberately,
// so a corrupted access blob can never lock someone out of their own business. The area
// therefore cannot be the tenancy boundary; internal_account is. If somebody ever
// "simplifies" resolveProjectsAccess by dropping the internal check because "the area
// already says edit", that test is what stops it.

import { assert, assertEquals } from "jsr:@std/assert";
import { resolveProjectsAccess } from "../projectsAccess.ts";

type Row = Record<string, unknown>;

// Minimal PostgREST-shaped fake: .from(t).select(c).eq(c,v)[.maybeSingle()|.limit(n)].
function makeAdmin(tables: Record<string, Row[]>, failOn?: string) {
  return {
    from(table: string) {
      const rows = tables[table] || [];
      const filters: Array<[string, unknown]> = [];
      const api = {
        select(_c: string) { return api; },
        eq(col: string, val: unknown) { filters.push([col, val]); return api; },
        _hits() {
          if (failOn === table) return null;
          return rows.filter((r) => filters.every(([c, v]) => r[c] === v));
        },
        maybeSingle() {
          const h = api._hits();
          if (!h) return { data: null, error: { message: `${table} read failed` } };
          return { data: h.length ? h[0] : null, error: null };
        },
        limit(n: number) {
          const h = api._hits();
          if (!h) return { data: null, error: { message: `${table} read failed` } };
          return { data: h.slice(0, n), error: null };
        },
      };
      return api;
    },
    // deno-lint-ignore no-explicit-any
  } as any;
}

const SETTINGS = [
  { client_id: "structure-studio", internal_account: true },
  { client_id: "junior-barns", internal_account: false },
  { client_id: "yoder-barns", internal_account: null },   // predates migration 169
];

const base = (over: { operators?: Row[]; users?: Row[] } = {}) => makeAdmin({
  client_settings: SETTINGS,
  app_operators: over.operators ?? [],
  client_users: over.users ?? [],
});

Deno.test("DOOR 1: an operator with no tenant row still gets in", async () => {
  // ⚠️ The case the obvious hardening breaks. app_operators is cross-tenant by definition and
  // client_users.user_id is a PRIMARY KEY, so a platform operator is a member of no tenant at
  // all. resolveTenant supports this deliberately and has its own test saying so
  // (resolveTenant_test.ts, "operator with no client_users row still resolves the target").
  // If this ever starts returning null, every CSM operator loses the console.
  const r = await resolveProjectsAccess(base({ operators: [{ user_id: "u-op", can_write: true }] }), "u-op");
  assert(r, "a tenant-less operator must still resolve");
  assertEquals(r!.op!.user_id, "u-op");
  assertEquals(r!.teamAcc, null, "an operator is governed by app_operators, not by an area map");
});

Deno.test("DOOR 1 wins even when the operator is ALSO on a tenant", async () => {
  // Carolyn and Ahsan are both operators AND owners of structure-studio. The operator branch
  // is evaluated first and independently so their behaviour cannot change with this feature.
  const r = await resolveProjectsAccess(base({
    operators: [{ user_id: "u-carolyn", can_write: true }],
    users: [{ user_id: "u-carolyn", client_id: "structure-studio", role: "owner", title: "owner", access: null }],
  }), "u-carolyn");
  assert(r);
  assert(r!.op, "the operator row must win");
  assertEquals(r!.teamAcc, null);
});

Deno.test("DOOR 2: an internal-tenant member granted projects gets in, at their own level", async () => {
  const view = await resolveProjectsAccess(base({
    users: [{ user_id: "u-jane", client_id: "structure-studio", role: "user", title: "sales_rep", access: { projects: "view" } }],
  }), "u-jane");
  assert(view, "a granted team member must get in");
  assertEquals(view!.op, null, "they are NOT an operator and must not be handed operator powers");
  assertEquals(view!.teamAcc!.projects, "view");

  const edit = await resolveProjectsAccess(base({
    users: [{ user_id: "u-joe", client_id: "structure-studio", role: "user", title: "driver", access: { projects: "edit" } }],
  }), "u-joe");
  assertEquals(edit!.teamAcc!.projects, "edit");
});

Deno.test("DOOR 2 is closed without the grant — the area denies by default", async () => {
  for (const title of ["admin", "sales_rep", "crew_leader", "driver"]) {
    const r = await resolveProjectsAccess(base({
      users: [{ user_id: "u-x", client_id: "structure-studio", role: "user", title, access: null }],
    }), "u-x");
    assertEquals(r, null, `${title} on our own tenant must still need the switch`);
  }
});

Deno.test("🔴 A BUILDER'S OWNER IS REFUSED, even though they resolve projects=edit", async () => {
  // THE TEST THAT MATTERS. Nevin Friesen owns junior-barns; effectiveAccess hands every owner
  // 'edit' on every area including this one, by construction. What refuses him is
  // internal_account, not the area — so this passing is the only evidence that the tenancy
  // check is still in front of the permission check.
  const r = await resolveProjectsAccess(base({
    users: [{ user_id: "u-nevin", client_id: "junior-barns", role: "owner", title: "owner", access: null }],
  }), "u-nevin");
  assertEquals(r, null, "a customer's owner must never reach CSM's internal boards");

  // And not even with an explicit grant somebody managed to store on their row.
  const granted = await resolveProjectsAccess(base({
    users: [{ user_id: "u-rep", client_id: "junior-barns", role: "user", title: "sales_rep", access: { projects: "edit" } }],
  }), "u-rep");
  assertEquals(granted, null, "a stored grant on a builder's tenant must stay inert");
});

Deno.test("a NULL internal_account is not a true one", async () => {
  // yoder-barns predates migration 169, so the column is null rather than false. Pinned
  // because `coalesce`-shaped mistakes in this position grant rather than deny.
  const r = await resolveProjectsAccess(base({
    users: [{ user_id: "u-adam", client_id: "yoder-barns", role: "owner", title: "owner", access: null }],
  }), "u-adam");
  assertEquals(r, null);
});

Deno.test("a stranger with neither door is refused", async () => {
  assertEquals(await resolveProjectsAccess(base(), "u-nobody"), null);
  // A client_users row pointing at a tenant with no client_settings row at all.
  const orphan = await resolveProjectsAccess(base({
    users: [{ user_id: "u-orphan", client_id: "ghost-tenant", role: "owner", title: "owner", access: null }],
  }), "u-orphan");
  assertEquals(orphan, null);
});

Deno.test("a database fault THROWS rather than answering 'no door'", async () => {
  // Both callers turn this into a 500. Returning null would be a silent 403 that reads as a
  // permissions problem, and would send whoever hit it to Settings → Team to fix something
  // that is not broken. The internalTenant read fails closed for the opposite reason — it is
  // the read that GRANTS — and both postures are deliberate.
  for (const table of ["app_operators", "client_users", "client_settings"]) {
    const admin = makeAdmin({
      client_settings: SETTINGS,
      app_operators: [],
      client_users: [{ user_id: "u-jane", client_id: "structure-studio", role: "user", title: "sales_rep", access: { projects: "view" } }],
    }, table);
    let threw = false;
    try { await resolveProjectsAccess(admin, "u-jane"); } catch { threw = true; }
    assert(threw, `a ${table} read failure must throw`);
  }
});

Deno.test("a duplicate client_users row does not become a lockout", async () => {
  // .limit(1), not .maybeSingle(): a data fault must not turn into a hard refusal at the
  // door. Same idiom, same reason, as resolveTenant's own read of this table.
  const admin = makeAdmin({
    client_settings: SETTINGS,
    app_operators: [],
    client_users: [
      { user_id: "u-dup", client_id: "structure-studio", role: "user", title: "admin", access: { projects: "edit" } },
      { user_id: "u-dup", client_id: "structure-studio", role: "user", title: "admin", access: { projects: "edit" } },
    ],
  });
  const r = await resolveProjectsAccess(admin, "u-dup");
  assert(r, "a duplicate row must still resolve");
  assertEquals(r!.teamAcc!.projects, "edit");
});
