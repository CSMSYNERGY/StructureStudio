// Unit tests for the internal-tenant lookup that guards the operator roster.
//
// WHY THESE EXIST. portal-projects can hand a login access to EVERY builder's account.
// Until now the only check before that grant was "does this profile have a login at all",
// so an operator could type a builder's sales rep's email into the people editor and tick
// one box. These three outcomes are the whole decision, and the middle one is the trap:
// the obvious hardening ("the login must be on our tenant") locks out every platform
// operator, because an operator belongs to NO tenant by design and resolveTenant has a
// test pinning exactly that. Allow-on-absent is deliberate and must stay pinned.
//
// Dependency-free (no jsr:/npm: imports), the house rule for _shared tests.

import { isInternalTenant, loginTenant } from "./internalTenant.ts";

function check(name: string, cond: boolean, detail?: string) {
  if (!cond) throw new Error(`${name}${detail ? `: ${detail}` : ""}`);
}

// Minimal PostgREST-shaped fake: .from(t).select(c).eq(c, v)[.maybeSingle()|.limit(n)].
// Mirrors the two call shapes internalTenant.ts actually uses and nothing else.
type Row = Record<string, unknown>;
function makeAdmin(tables: Record<string, Row[]>, failOn?: string) {
  return {
    from(table: string) {
      const rows = tables[table] || [];
      const filters: Array<[string, unknown]> = [];
      const api = {
        select(_cols: string) { return api; },
        eq(col: string, val: unknown) { filters.push([col, val]); return api; },
        match() {
          if (failOn === table) return { data: null, error: { message: "boom" } };
          const hit = rows.filter((r) => filters.every(([c, v]) => r[c] === v));
          return { data: hit, error: null };
        },
        maybeSingle() {
          const res = api.match();
          if (res.error) return res;
          return { data: res.data.length ? res.data[0] : null, error: null };
        },
        limit(n: number) {
          const res = api.match();
          if (res.error) return res;
          return { data: res.data.slice(0, n), error: null };
        },
      };
      return api;
    },
  // deno-lint-ignore no-explicit-any
  } as any;
}

const TENANTS = {
  client_settings: [
    { client_id: "structure-studio", internal_account: true },
    { client_id: "junior-barns", internal_account: false },
    // A tenant row that predates the column entirely — null, not false.
    { client_id: "yoder-barns", internal_account: null },
  ],
  client_users: [
    { user_id: "u-carolyn", client_id: "structure-studio" },
    { user_id: "u-nevin", client_id: "junior-barns" },
    { user_id: "u-adam", client_id: "yoder-barns" },
  ],
};

Deno.test("only a tenant flagged internal_account reads as ours", async () => {
  const admin = makeAdmin(TENANTS);
  check("ours", await isInternalTenant(admin, "structure-studio") === true);
  check("customer", await isInternalTenant(admin, "junior-barns") === false);
  // null is not true. Worth pinning because `internal_account` was added late (169) and
  // every row that predates it reads null, not false.
  check("null column", await isInternalTenant(admin, "yoder-barns") === false);
  // A tenant with no client_settings row at all is not ours either.
  check("unknown tenant", await isInternalTenant(admin, "nope") === false);
  check("empty id", await isInternalTenant(admin, "") === false);
});

Deno.test("a login on NO tenant is the platform operator, and must resolve cleanly", async () => {
  // ⚠️ THE CASE THE OBVIOUS HARDENING BREAKS. app_operators keys on auth.users.id and is
  // cross-tenant by definition; client_users.user_id is a PRIMARY KEY, so a login belongs
  // to at most one tenant and an operator typically belongs to none. resolveTenant has
  // always handled this (resolveTenant_test.ts: "operator with no client_users row still
  // resolves the target"). If this ever starts refusing, every CSM operator who is not a
  // member of a tenant loses the console.
  const admin = makeAdmin(TENANTS);
  const res = await loginTenant(admin, "u-operator-with-no-tenant");
  check("no tenant", res.clientId === null, JSON.stringify(res));
  check("not internal", res.internal === false);
});

Deno.test("a login is reported with its tenant, and whether that tenant is ours", async () => {
  const admin = makeAdmin(TENANTS);
  const ours = await loginTenant(admin, "u-carolyn");
  check("ours tenant", ours.clientId === "structure-studio");
  check("ours internal", ours.internal === true);

  const theirs = await loginTenant(admin, "u-nevin");
  check("their tenant", theirs.clientId === "junior-barns");
  // This is the row that must refuse an operator grant: a real customer's own login.
  check("their internal", theirs.internal === false);
});

Deno.test("a read error THROWS rather than answering 'not internal'", async () => {
  // Fails closed, the same posture as featureCheck.ts's read of this column. Both callers
  // use the answer to decide whether to hand out cross-tenant reach, so "we could not
  // tell" must never resolve to "go ahead".
  let threw = false;
  try {
    await isInternalTenant(makeAdmin(TENANTS, "client_settings"), "structure-studio");
  } catch { threw = true; }
  check("client_settings error throws", threw);

  threw = false;
  try {
    await loginTenant(makeAdmin(TENANTS, "client_users"), "u-carolyn");
  } catch { threw = true; }
  check("client_users error throws", threw);
});

Deno.test("a duplicate client_users row does not become a lockout", async () => {
  // .limit(1), not .maybeSingle(): maybeSingle throws on more than one row, which would
  // turn a data fault into a hard refusal at the door. Same idiom, same reason, as
  // resolveTenant's own read of this table.
  const dup = {
    ...TENANTS,
    client_users: [
      { user_id: "u-dup", client_id: "structure-studio" },
      { user_id: "u-dup", client_id: "structure-studio" },
    ],
  };
  const res = await loginTenant(makeAdmin(dup), "u-dup");
  check("resolved anyway", res.clientId === "structure-studio");
  check("internal", res.internal === true);
});
