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
        limit: () => Promise.resolve({ data: t.client_users ?? [], error: null }),
        maybeSingle: () => {
          if (table === "app_operators") return Promise.resolve({ data: t.app_operators ?? null, error: null });
          if (table === "client_configs") {
            // assertClient looks up by slug; `lastEq` captured below.
            return Promise.resolve({ data: chain._slug && (t.client_configs ?? []).includes(chain._slug) ? { client_id: chain._slug } : null, error: null });
          }
          return Promise.resolve({ data: null, error: null });
        },
      };
      // capture the slug passed to .eq("client_id", v) for client_configs
      chain.eq = (_col: string, val: any) => { chain._slug = val; return chain; };
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
