// Unit tests for the shared tenant resolver.
//
// This gate sits in front of portal-settings, portal-billing and sync-design-status —
// i.e. every tenant's Settings, pricing, billing and design list. A mistake here breaks
// every customer at once, and it cannot be exercised end-to-end without real logins, so
// it is tested here directly with stubs.
//
// Run:
//   deno test --allow-env --import-map=supabase/functions/_shared/_test_stubs/import_map.json \
//             supabase/functions/_shared/_test_stubs/resolveTenant_test.ts

// deno-lint-ignore-file no-explicit-any
import { assertEquals } from "jsr:@std/assert@1";
import { resolveTenant } from "../resolveTenant.ts";
import { stubAuth } from "./supabase_stub.ts";

Deno.env.set("SUPABASE_URL", "https://stub.supabase.co");
Deno.env.set("SUPABASE_ANON_KEY", "stub-anon");

type Tables = {
  client_users?: any[];
  app_operators?: any | null;
  client_configs?: string[];   // slugs that exist
  /** The VIEWED tenant's owner row, as the support-operator branch reads it. A separate
   *  fixture because that query filters on role='owner' against a DIFFERENT tenant than the
   *  caller's own client_users row — serving one array to both would let a test pass by
   *  reading the operator's own mapping and never notice the branch was skipped. */
  tenant_owner?: any[];
};

const audits: any[] = [];

/** Minimal service-role client covering only the queries resolveTenant makes. */
function makeAdmin(t: Tables, opts: { auditFails?: boolean } = {}) {
  return {
    from(table: string) {
      if (table === "admin_audit") {
        return {
          insert: (row: any) => {
            if (opts.auditFails) return Promise.resolve({ error: { message: "audit table down" } });
            audits.push(row);
            return Promise.resolve({ error: null });
          },
        };
      }
      const chain: any = {
        select: () => chain,
        eq: () => chain,
        // ⚠️ .order() REALLY SORTS here rather than being a no-op passthrough. The support
        // branch's owner lookup is ordered precisely because a tenant can have several
        // owners and an unordered limit(1) is whatever Postgres returns that time; a fake
        // that accepted .order() and ignored it would let that ordering be deleted without a
        // single test noticing, which is the entire failure this is guarding.
        order: (col: string, o?: { ascending?: boolean }) => {
          chain._orders.push([col, !o || o.ascending !== false]);
          return chain;
        },
        // The support branch's owner lookup is the one client_users read that filters on
        // role; everything else is the caller's own mapping.
        limit: (n?: number) => {
          const base = (table === "client_users" && chain._eq && chain._eq.role === "owner")
            ? (t.tenant_owner ?? [])
            : (t.client_users ?? []);
          const rows = [...base];
          for (const [col, asc] of [...chain._orders].reverse()) {
            rows.sort((a: any, b: any) => {
              const x = a[col], y = b[col];
              if (x === y) return 0;
              return (x > y ? 1 : -1) * (asc ? 1 : -1);
            });
          }
          return Promise.resolve({ data: typeof n === "number" ? rows.slice(0, n) : rows, error: null });
        },
        maybeSingle: () => {
          if (table === "app_operators") return Promise.resolve({ data: t.app_operators ?? null, error: null });
          if (table === "client_configs") {
            // assertClient looks up by slug; `lastEq` captured below.
            return Promise.resolve({ data: chain._slug && (t.client_configs ?? []).includes(chain._slug) ? { client_id: chain._slug } : null, error: null });
          }
          return Promise.resolve({ data: null, error: null });
        },
      };
      // capture the slug passed to .eq("client_id", v) for client_configs, and every column
      // filtered on, so `limit` can tell the support branch's owner lookup apart.
      chain._eq = {};
      chain._orders = [] as Array<[string, boolean]>;
      chain.eq = (col: string, val: any) => { chain._eq[col] = val; if (col === "client_id") chain._slug = val; return chain; };
      chain.select = () => chain;
      return chain;
    },
  };
}

function req(body: unknown, withAuth = true) {
  return new Request("https://stub/fn", {
    method: "POST",
    headers: withAuth ? { Authorization: "Bearer x" } : {},
    body: JSON.stringify(body),
  });
}

const READS = new Set(["status", "catalog"]);
const OWNER = [{ client_id: "acme", role: "owner" }];
const TEAM = [{ client_id: "acme", role: "user" }];

function signedIn(id = "u1", email = "op@csmsynergy.com") { stubAuth.user = { id, email }; stubAuth.error = null; }
function signedOut() { stubAuth.user = null; stubAuth.error = null; }

// ── The primary defence ───────────────────────────────────────────────────────
Deno.test("anon/no user is 401 even WITH targetClientId", async () => {
  signedOut();
  const r = await resolveTenant(req({ action: "save", targetClientId: "other" }), makeAdmin({}), { readActions: READS });
  assertEquals(r.ok, false);
  assertEquals((r as any).status, 401);
});

Deno.test("401 beats a malformed body (precedence preserved)", async () => {
  signedOut();
  const bad = new Request("https://stub/fn", { method: "POST", headers: { Authorization: "Bearer x" }, body: "{not json" });
  const r = await resolveTenant(bad, makeAdmin({}), { readActions: READS });
  assertEquals((r as any).status, 401);
});

// ── Owner path must be unchanged ──────────────────────────────────────────────
Deno.test("owner, no target -> own tenant, role preserved", async () => {
  signedIn();
  const r = await resolveTenant(req({ action: "save" }), makeAdmin({ client_users: OWNER }), { readActions: READS });
  assertEquals(r.ok, true);
  assertEquals((r as any).ctx.clientId, "acme");
  assertEquals((r as any).ctx.role, "owner");
  assertEquals((r as any).ctx.operator, null);
});

Deno.test("role 'user' may READ but not WRITE (gate intact)", async () => {
  signedIn();
  const ok = await resolveTenant(req({ action: "status" }), makeAdmin({ client_users: TEAM }), { readActions: READS });
  assertEquals(ok.ok, true);
  const no = await resolveTenant(req({ action: "save" }), makeAdmin({ client_users: TEAM }), { readActions: READS });
  assertEquals((no as any).status, 403);
});

Deno.test("no client_users row and no target -> 403 (unchanged)", async () => {
  signedIn();
  const r = await resolveTenant(req({ action: "status" }), makeAdmin({ client_users: [] }), { readActions: READS });
  assertEquals((r as any).status, 403);
});

// ── The override ──────────────────────────────────────────────────────────────
Deno.test("NON-operator sending targetClientId is 403, never served own data", async () => {
  signedIn();
  const r = await resolveTenant(
    req({ action: "status", targetClientId: "victim" }),
    makeAdmin({ client_users: OWNER, app_operators: null, client_configs: ["victim"] }),
    { readActions: READS },
  );
  assertEquals(r.ok, false);
  assertEquals((r as any).status, 403);
  assertEquals((r as any).body.error, "Operator access required.");
});

Deno.test("own slug as targetClientId is a harmless no-op", async () => {
  signedIn();
  const r = await resolveTenant(
    req({ action: "save", targetClientId: "acme" }),
    makeAdmin({ client_users: OWNER, app_operators: null }),
    { readActions: READS },
  );
  assertEquals(r.ok, true);
  assertEquals((r as any).ctx.role, "owner");
  assertEquals((r as any).ctx.operator, null);
});

Deno.test("operator writes to another tenant", async () => {
  signedIn();
  const r = await resolveTenant(
    req({ action: "save", targetClientId: "victim" }),
    makeAdmin({
      client_users: TEAM,                                    // own role is only "user"
      app_operators: { user_id: "u1", email: "op@csmsynergy.com", can_write: true, can_bill: true },
      client_configs: ["victim"],
    }),
    { readActions: READS },
  );
  assertEquals(r.ok, true);
  assertEquals((r as any).ctx.clientId, "victim");
  assertEquals((r as any).ctx.role, "operator");
  assertEquals((r as any).ctx.operator.canWrite, true);
});

Deno.test("operator with no client_users row still resolves the target", async () => {
  signedIn();
  const admin = makeAdmin({
    client_users: [],
    app_operators: { user_id: "u1", email: "op@csmsynergy.com", can_write: true, can_bill: true },
    client_configs: ["victim"],
  });
  const withTarget = await resolveTenant(req({ action: "save", targetClientId: "victim" }), admin, { readActions: READS });
  assertEquals(withTarget.ok, true);
  // ...but grants nothing on their own (nonexistent) tenant.
  const without = await resolveTenant(req({ action: "save" }), admin, { readActions: READS });
  assertEquals((without as any).status, 403);
});

Deno.test("read-only operator: reads pass, writes 403", async () => {
  signedIn();
  const t = {
    client_users: OWNER,
    app_operators: { user_id: "u1", email: "ro@csmsynergy.com", can_write: false, can_bill: false },
    client_configs: ["victim"],
  };
  const read = await resolveTenant(req({ action: "status", targetClientId: "victim" }), makeAdmin(t), { readActions: READS });
  assertEquals(read.ok, true);
  const write = await resolveTenant(req({ action: "save", targetClientId: "victim" }), makeAdmin(t), { readActions: READS });
  assertEquals((write as any).status, 403);
});

Deno.test("can_bill gates billing separately from can_write", async () => {
  signedIn();
  const t = {
    client_users: OWNER,
    app_operators: { user_id: "u1", email: "w@csmsynergy.com", can_write: true, can_bill: false },
    client_configs: ["victim"],
  };
  const r = await resolveTenant(req({ action: "subscribe", targetClientId: "victim" }), makeAdmin(t), { readActions: READS, requireBilling: true });
  assertEquals((r as any).status, 403);
});

// ── Slug validation ───────────────────────────────────────────────────────────
Deno.test("malformed / unknown targets are 400 before anything else", async () => {
  signedIn();
  const t = {
    client_users: OWNER,
    app_operators: { user_id: "u1", email: "op@csmsynergy.com", can_write: true, can_bill: true },
    client_configs: ["victim"],
  };
  for (const bad of ["../etc", "Victim", "has space", "-leading", "nonexistent"]) {
    const r = await resolveTenant(req({ action: "save", targetClientId: bad }), makeAdmin(t), { readActions: READS });
    assertEquals(r.ok, false, `expected refusal for ${bad}`);
    assertEquals((r as any).status, 400, `expected 400 for ${bad}`);
  }
});

// ── Audit ─────────────────────────────────────────────────────────────────────
Deno.test("auditStrict throws when the audit cannot be written", async () => {
  signedIn();
  const r = await resolveTenant(
    req({ action: "save", targetClientId: "victim" }),
    makeAdmin({
      client_users: OWNER,
      app_operators: { user_id: "u1", email: "op@csmsynergy.com", can_write: true, can_bill: true },
      client_configs: ["victim"],
    }, { auditFails: true }),
    { readActions: READS },
  );
  assertEquals(r.ok, true);
  let threw = false;
  try { await (r as any).ctx.auditStrict("operator_billing_subscribe_attempt"); } catch { threw = true; }
  assertEquals(threw, true, "auditStrict must throw so the caller can refuse the side effect");
});

Deno.test("audit row carries actor + target", async () => {
  signedIn("u1", "op@csmsynergy.com");
  audits.length = 0;
  const r = await resolveTenant(
    req({ action: "save", targetClientId: "victim" }),
    makeAdmin({
      client_users: OWNER,
      app_operators: { user_id: "u1", email: "op@csmsynergy.com", can_write: true, can_bill: true },
      client_configs: ["victim"],
    }),
    { readActions: READS },
  );
  await (r as any).ctx.auditStrict("operator_test", 3, "note");
  assertEquals(audits.length, 1);
  assertEquals(audits[0].target_client_id, "victim");
  assertEquals(audits[0].actor_email, "op@csmsynergy.com");
  assertEquals(audits[0].actor_user_id, "u1");
});

// ── The SUPPORT operator (migration 176) ──────────────────────────────────────
// Carolyn, 2026-09-01: "when I log in as Junior Barnes, I get MY permissions, not Junior
// Barnes permissions ... I can't go in and mirror one of them." Every operator in view-as was
// handed effectiveAccess("owner","owner",null) — edit on all 18 areas — and the operator
// branch never called checkGate at all, so nothing about the viewed tenant constrained them.
//
// These tests exist because BOTH halves of that are easy to half-fix. Narrowing the access map
// without adding the gate call leaves a support operator carrying a narrow map that nothing
// reads; adding the gate without narrowing the map changes nothing. The refusal test below is
// the one that fails if either half is missing.

const SUPPORT = { user_id: "u1", email: "jonathan@csmsynergy.com", can_write: true, can_bill: true, support_only: true };
const PLATFORM = { user_id: "u1", email: "op@csmsynergy.com", can_write: true, can_bill: true, support_only: false };
const BILLING_GATE = { save: { area: "settings_billing", level: "edit" as const } };
const TENANT_OWNER = [{ role: "owner", title: "owner", access: null }];

Deno.test("support operator wears the viewed tenant's owner map, minus Billing", async () => {
  signedIn();
  const r = await resolveTenant(
    req({ action: "save", targetClientId: "victim" }),
    makeAdmin({ client_users: TEAM, app_operators: SUPPORT, client_configs: ["victim"], tenant_owner: TENANT_OWNER }),
    { readActions: READS },
  );
  assertEquals(r.ok, true);
  const ctx = (r as any).ctx;
  // The owner short-circuits to edit everywhere, so everything EXCEPT billing is edit — which
  // is what makes the one clamped area the whole assertion here.
  assertEquals(ctx.access.settings_billing, "none");
  assertEquals(ctx.access.designs, "edit");
  assertEquals(ctx.access.settings_team, "edit");
  assertEquals(ctx.operator.supportOnly, true);
});

Deno.test("support operator is REFUSED a Billing-gated action — the map is actually consulted", async () => {
  // If checkGate is missing from the operator branch, this returns ok:true and the support
  // account edits the card that pays for the product.
  signedIn();
  const r = await resolveTenant(
    req({ action: "save", targetClientId: "victim" }),
    makeAdmin({ client_users: TEAM, app_operators: SUPPORT, client_configs: ["victim"], tenant_owner: TENANT_OWNER }),
    { gates: BILLING_GATE, readActions: READS },
  );
  assertEquals(r.ok, false);
  assertEquals((r as any).status, 403);
});

Deno.test("a PLATFORM operator is unchanged by all of this", async () => {
  // The regression guard. Support is a new behaviour, not a narrowing of the operator account
  // CSM Synergy staff use to configure and repair tenants — a subscription lapse or a tenant's
  // own access map must never lock us out of fixing their account.
  signedIn();
  const r = await resolveTenant(
    req({ action: "save", targetClientId: "victim" }),
    makeAdmin({ client_users: TEAM, app_operators: PLATFORM, client_configs: ["victim"], tenant_owner: TENANT_OWNER }),
    { gates: BILLING_GATE, readActions: READS },
  );
  assertEquals(r.ok, true);
  const ctx = (r as any).ctx;
  assertEquals(ctx.access.settings_billing, "edit");
  assertEquals(ctx.operator.supportOnly, false);
  assertEquals(ctx.canRead("settings_billing"), true);
});

Deno.test("support operator is refused requireBilling even holding can_bill", async () => {
  // Two separate axes that an account can carry at once. Forcing the refusal here means it
  // does not depend on anyone remembering to clear can_bill when they tick support_only.
  signedIn();
  const r = await resolveTenant(
    req({ action: "save", targetClientId: "victim" }),
    makeAdmin({ client_users: TEAM, app_operators: SUPPORT, client_configs: ["victim"], tenant_owner: TENANT_OWNER }),
    { readActions: READS, requireBilling: true },
  );
  assertEquals(r.ok, false);
  assertEquals((r as any).status, 403);
  assertEquals((r as any).body.error, "This operator account cannot change billing.");
});

Deno.test("a tenant with NO owner row falls back to the admin preset, not to nothing", async () => {
  // Created but never invited, or the owner removed. "No access" would make support useless on
  // exactly the accounts most likely to need it.
  signedIn();
  const r = await resolveTenant(
    req({ action: "save", targetClientId: "victim" }),
    makeAdmin({ client_users: TEAM, app_operators: SUPPORT, client_configs: ["victim"], tenant_owner: [] }),
    { readActions: READS },
  );
  assertEquals(r.ok, true);
  const ctx = (r as any).ctx;
  assertEquals(ctx.access.settings_billing, "none");
  assertEquals(ctx.access.designs, "edit");
  assertEquals(ctx.access.settings_structures, "edit");
});

Deno.test("support operator mirrors a NARROWED owner rather than assuming full access", async () => {
  // An owner short-circuits to everything, so a non-owner title is what proves the map is
  // really resolved from the row and not hardcoded. A driver sees deliveries and little else.
  signedIn();
  const r = await resolveTenant(
    req({ action: "save", targetClientId: "victim" }),
    makeAdmin({
      client_users: TEAM,
      app_operators: SUPPORT,
      client_configs: ["victim"],
      tenant_owner: [{ role: "user", title: "driver", access: null }],
    }),
    { readActions: READS },
  );
  assertEquals(r.ok, true);
  const ctx = (r as any).ctx;
  assertEquals(ctx.access.delivery_schedule, "edit");
  assertEquals(ctx.access.designs, "none");
  assertEquals(ctx.canRead("designs"), false);
  assertEquals(ctx.canRead("delivery_schedule"), true);
  assertEquals(ctx.canEdit("delivery_schedule"), true);
});

Deno.test("a read-only support operator still cannot edit what it can see", async () => {
  // can_write and the area map are ANDed, not alternatives.
  signedIn();
  const r = await resolveTenant(
    req({ action: "status", targetClientId: "victim" }),
    makeAdmin({
      client_users: TEAM,
      app_operators: { ...SUPPORT, can_write: false },
      client_configs: ["victim"],
      tenant_owner: TENANT_OWNER,
    }),
    { readActions: READS },
  );
  assertEquals(r.ok, true);
  const ctx = (r as any).ctx;
  assertEquals(ctx.canRead("designs"), true);
  assertEquals(ctx.canEdit("designs"), false);
});

Deno.test("SEVERAL owners: the ROW ORDER must not change who is mirrored", async () => {
  // ⚠️ REAL SHAPE, not invented: junior-barns has two owner rows today. Before the .order(),
  // the support branch's limit(1) took whichever row Postgres handed back that time.
  //
  // THE TEST IS THE SAME TWO ROWS FED IN BOTH ORDERS, because that is the only thing a
  // deterministic fake can actually prove. Asserting "five identical calls agree" cannot fail
  // — a fake returns its fixture the same way every time — and an earlier draft of this test
  // did exactly that and passed happily with the ordering deleted. Feeding the rows both ways
  // round is what makes a missing .order() show up.
  //
  // The older row is a DRIVER purely so the two resolve DIFFERENTLY and the pick is
  // observable at all: two genuine owners are indistinguishable by construction, because
  // effectiveAccess short-circuits on role === "owner" and never reads the title or the blob.
  const OLDEST = { role: "user", title: "driver", access: null, created_at: "2026-01-01T00:00:00Z", user_id: "u-old" };
  const NEWEST = { role: "owner", title: "owner", access: null, created_at: "2026-09-01T00:00:00Z", user_id: "u-new" };

  const resolve = async (rows: unknown[]) => {
    signedIn();
    const r = await resolveTenant(
      req({ action: "save", targetClientId: "victim" }),
      makeAdmin({ client_users: TEAM, app_operators: SUPPORT, client_configs: ["victim"], tenant_owner: rows as never }),
      { readActions: READS },
    );
    assertEquals(r.ok, true);
    return (r as any).ctx.access;
  };

  const aThenB = await resolve([NEWEST, OLDEST]);
  const bThenA = await resolve([OLDEST, NEWEST]);
  assertEquals(aThenB, bThenA, "the same two rows in a different order must resolve the same");

  // And it is the OLDEST that wins, so the choice is written down rather than incidental.
  // ⛔ Do NOT read that as "the founder": on junior-barns the older row is OUR OWN support@
  // address and the actual customer was added a week later. Anything that wants "the real
  // owner" has to ask a different question than "the first one".
  assertEquals(aThenB.delivery_schedule, "edit", "the oldest row is the one taken");
  assertEquals(aThenB.designs, "none", "…and it really is that row's map, not a default");
  // Billing stays clamped whichever row wins.
  assertEquals(aThenB.settings_billing, "none");
});
