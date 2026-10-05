// The builder's Advanced mode switch (2026-10-05, migration 270), driven through the SHIPPED
// portal-settings and portal-billing handlers and pinned against the SHIPPED portal sources.
//
// WHY THIS EXISTS. Carolyn, 09-28: the Advanced page is "only available in Structure Studio for us
// yet". Ahsan: when it launches, builders "just have to go into settings and ... turn on the advanced
// mode to access this tab, so everybody is not going to see." Carolyn: "Yep, yep, no, that's good."
// So, end to end, and each part is held here:
//
//   1. portal-settings `save_advanced_mode {enabled}` UPDATES client_settings.advanced_mode (the
//      column + updated_at, nothing else). A tenant with no row gets one only when the switch goes ON,
//      and that row names ramp_enabled false, because the column defaults to true while get_fixtures
//      reads a missing row's ramps as off; OFF with no row writes nothing. Owner or admin only, on top
//      of the settings_structures:edit gate; a platform operator in view-as writes the VIEWED tenant;
//      a support operator, a read-only operator and a team member are refused with nothing written;
//      anything but a real boolean is refused, never coerced.
//   2. portal-billing's entitlement carries `advancedMode`: internal_account OR the column, strictly
//      true. `granted`, `paid` and `features` do not change because of it. The column is read on its
//      own, fail-soft: a database without it (a deploy ahead of 270) is Advanced off, never a 500.
//   3. The portal: ssAdvancedOn reads it (tabClamp_test / advancedGate_test hold the rule and the
//      shell's gate); the Settings → Designer card sends the save to the tenant on screen and then
//      raises ssEntitlementChanged, so the shell re-reads the entitlement and the menu item appears
//      without a reload (tests/harness/advancedModeSwitch.mjs drives that on the compiled portal).
//
// HOW. deleteDesignWiring_test's idiom: Deno.serve is stubbed while each function's index.ts is
// imported, and the import map swaps supabase-js for supabase_stub.ts, whose stubDb hook routes every
// table call into the fakes below. No --allow-net: nothing here reaches a real database. Nothing is
// charged and no grant is read or written by the switch.
//
// ⚠️ THE IMPORT SPECIFIERS ARE COMPUTED ON PURPOSE (see aiDraftStreamWiring_test): literal ones would
// type-check both functions against the stub's partial client type.
//
// Tenants and users are made up. The repo is public: no real client id belongs in a fixture.

// deno-lint-ignore-file no-explicit-any
import { assert, assertEquals } from "jsr:@std/assert";
import { stubAuth, stubDb } from "./supabase_stub.ts";

const read = async (rel: string) => (await Deno.readTextFile(new URL(rel, import.meta.url))).replace(/\r\n/g, "\n");
const SETTINGS_SRC = await read("../../portal-settings/index.ts");
const BILLING_SRC = await read("../../portal-billing/index.ts");
const CARD_SRC = await read("../../../../portal/06-3d.jsx");
const SHELL_SRC = await read("../../../../portal/12-shell.jsx");
const SETTINGS_SHELL_SRC = await read("../../../../portal/08-integrations.jsx");
const MIGRATION = await read("../../../migrations/270_paid_3d_unlock.sql");

function between(src: string, start: string, end: string, label: string): string {
  const i = src.indexOf(start);
  const j = i < 0 ? -1 : src.indexOf(end, i + start.length);
  if (i < 0 || j < 0) {
    throw new Error(`advancedModeSwitch_test: could not find ${label} (start=${i}, end=${j}). The anchors moved — re-point them rather than deleting this test.`);
  }
  return src.slice(i, j);
}
/** Whole-line comments dropped, so a comment naming a token cannot satisfy a check. */
const code = (s: string) => s.split("\n").filter((l) => !/^\s*(\/\/|\/\*|\*|\{\/\*)/.test(l)).join("\n");

// ─── The real handlers ─────────────────────────────────────────────────────────────────────────
async function load(rel: string): Promise<(req: Request) => Promise<Response>> {
  const realServe = Deno.serve;
  let handler: ((req: Request) => Promise<Response>) | null = null;
  (Deno as any).serve = (h: (req: Request) => Promise<Response>) => {
    handler = h;
    return { finished: Promise.resolve() };
  };
  try {
    await import(new URL(rel, import.meta.url).href);
  } finally {
    (Deno as any).serve = realServe;
  }
  if (!handler) throw new Error(`${rel} did not hand Deno.serve a handler`);
  return handler;
}
const SETTINGS = await load("../../portal-settings/index.ts");
const BILLING = await load("../../portal-billing/index.ts");

// ─── The world one request runs in ─────────────────────────────────────────────────────────────
const OWN = "acme-sheds";          // the caller's own tenant
const VIEWED = "bravo-barns";      // the tenant an operator views
const OPS_HOME = "harness-ops";    // an operator's own tenant
const USER_ID = "00000000-0000-4000-8000-0000000000a7";

type World = {
  // The caller's own client_users row (role + title + stored access overrides).
  me?: { client_id: string; role: string; title: string | null; access: Record<string, string> | null };
  // app_operators row, when the caller is one.
  op?: { can_write: boolean; can_bill: boolean; support_only: boolean } | null;
  // portal-settings: the tenant has no client_settings row yet (default: it has one).
  noRow?: boolean;
  writeFails?: boolean;
  // The row appears between the update (zero rows) and the insert: the insert hits 23505.
  rowAppears?: boolean;
  // portal-billing: the tenant's client_settings row (null = no row at all).
  settings?: Record<string, unknown> | null;
  // A database without the column (before 270, or 270 rolled back): any select naming it is 42703.
  noColumn?: boolean;
  grants?: Record<string, unknown>[];
  subs?: Record<string, unknown>[];
};
type Trace = {
  db: any[][];
  sets: { verb: string; row: any; ops: any[][] }[];   // client_settings writes, in order
  writes: string[];                 // every insert/update/delete/upsert, as "table:verb"
  audit: Record<string, unknown>[];
  errors: Record<string, unknown>[];
};
const has = (ops: any[][], op: string) => ops.some((o) => o[0] === op);
const argOf = (ops: any[][], op: string) => (ops.find((o) => o[0] === op) ?? []).slice(1);
const eqOf = (ops: any[][], col: string) => (ops.find((o) => o[0] === "eq" && o[1] === col) ?? [])[2];

const PLANS = [
  { id: "simple_layout_annual", feature: "simple_layout", billing_interval: "annual", required: true, operator_grantable: false, active: true },
  { id: "view_3d_annual", feature: "view_3d", billing_interval: "annual", required: false, operator_grantable: true, active: true },
].map((p, i) => ({
  ...p, name: p.feature, price_cents: 10000, gateway_plan_id: `HARNESS_${p.id.toUpperCase()}`, setup_fee_cents: 0,
  availability: "available", sort_order: 100 - i, price_visible: true,
}));
const FAR = new Date(Date.now() + 300 * 86400000).toISOString();
const BASE_SUB = { id: "s-base", client_id: OWN, plan_id: "simple_layout_annual", status: "active", price_cents: 10000, current_period_start: null, current_period_end: FAR, canceled_at: null, created_at: "2026-01-01T00:00:00Z", past_due_since: null };

function answer(world: World, trace: Trace, table: string, ops: any[][]): any {
  const one = (row: unknown) => ({ data: row ?? null, error: null });
  switch (table) {
    case "client_users":
      // resolveTenant's support branch reads the viewed tenant's OWNER row; everything else is the
      // caller's own mapping.
      if (eqOf(ops, "role") === "owner") return { data: [{ role: "owner", title: "owner", access: null }], error: null };
      return { data: world.me ? [{ ...world.me, user_id: USER_ID }] : [], error: null };
    case "app_operators":
      return one(world.op ? { user_id: USER_ID, email: "ops@example.test", ...world.op } : null);
    case "client_configs":
      return one({ client_id: eqOf(ops, "client_id") ?? OWN });
    case "admin_audit":
      trace.audit.push(argOf(ops, "insert")[0]);
      return { data: null, error: null };
    case "app_errors":
      trace.errors.push(argOf(ops, "insert")[0]);
      return { data: null, error: null };
    case "client_settings": {
      const verb = ["upsert", "insert", "update"].find((v) => has(ops, v));
      if (verb) {
        trace.sets.push({ verb, row: argOf(ops, verb)[0], ops });
        if (world.writeFails) return { data: null, error: { message: "the write timed out", code: "57014" } };
        if (verb === "insert") {
          const raced = !!world.rowAppears;
          world.noRow = false;
          return raced
            ? { data: null, error: { message: "duplicate key value violates unique constraint", code: "23505" } }
            : { data: null, error: null };
        }
        // An update answers the rows it matched only when asked to (.select()); a zero-row update is
        // still a success, which is the trap the handler has to see through.
        const matched = world.noRow ? [] : [{ client_id: eqOf(ops, "client_id") }];
        return { data: has(ops, "select") ? matched : null, error: null };
      }
      const cols = String(argOf(ops, "select")[0] ?? "");
      if (world.noColumn && /\badvanced_mode\b/.test(cols)) {
        return { data: null, error: { message: "column client_settings.advanced_mode does not exist", code: "42703" } };
      }
      return one(world.settings === undefined ? { billing_exempt: false, internal_account: false, discount_percent: 0, advanced_mode: false } : world.settings);
    }
    case "billing_plans":
      return { data: PLANS.map((p) => ({ ...p })), error: null };
    case "billing_subscriptions":
      return { data: (world.subs ?? [BASE_SUB]).map((s) => ({ ...s })), error: null };
    case "client_feature_grants":
      return { data: (world.grants ?? []).map((g) => ({ ...g })), error: null };
    case "billing_customers":
      return one(null);
    case "wallet_accounts":
      return one({ balance_cents: 0, held_cents: 0, metered_exempt: false, auto_topup_enabled: false });
    case "usage_prices":
    case "wallet_transactions":
      return { data: [], error: null };
  }
  throw new Error(`the fake database has no answer for ${table} ${JSON.stringify(ops)}`);
}

function chain(world: World, trace: Trace, table: string, ops: any[][]): any {
  const next = (op: any[]) => chain(world, trace, table, [...ops, op]);
  const q: any = {};
  for (const m of ["select", "insert", "update", "delete", "upsert", "eq", "neq", "gt", "gte", "lt", "is", "in", "not", "or", "limit", "order", "single", "maybeSingle"]) {
    q[m] = (...a: unknown[]) => next([m, ...a]);
  }
  q.then = (ok: any, bad: any) => {
    trace.db.push([table, ...ops]);
    const verb = ops.find((o) => ["insert", "update", "delete", "upsert"].includes(o[0]))?.[0];
    if (verb && table !== "admin_audit" && table !== "app_errors") trace.writes.push(`${table}:${verb}`);
    return Promise.resolve().then(() => answer(world, trace, table, ops)).then(ok, bad);
  };
  return q;
}

const ENV: Record<string, string> = {
  SUPABASE_URL: "https://stub.supabase.co",
  SUPABASE_ANON_KEY: "stub-anon",
  SUPABASE_SERVICE_ROLE_KEY: "stub-service",
};

async function call(handler: (req: Request) => Promise<Response>, fn: string, body: Record<string, unknown>, world: World) {
  const trace: Trace = { db: [], sets: [], writes: [], audit: [], errors: [] };
  const savedEnv = Object.fromEntries(Object.keys(ENV).map((k) => [k, Deno.env.get(k)]));
  for (const [k, v] of Object.entries(ENV)) Deno.env.set(k, v);
  const realFetch = globalThis.fetch;
  stubAuth.user = { id: USER_ID, email: "someone@example.test" };
  stubAuth.error = null;
  stubDb.from = (table: string) => chain(world, trace, table, []);
  globalThis.fetch = ((input: string | URL | Request) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    return Promise.reject(new Error(`TEST FAILURE: unexpected fetch to ${url}`));
  }) as typeof fetch;
  try {
    const res = await handler(new Request(`https://stub.supabase.co/functions/v1/${fn}`, {
      method: "POST",
      headers: { authorization: "Bearer harness", "content-type": "application/json", "user-agent": "harness/1.0" },
      body: JSON.stringify(body),
    }));
    return { status: res.status, body: await res.json(), trace };
  } finally {
    globalThis.fetch = realFetch;
    stubDb.from = null;
    stubAuth.user = null;
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) Deno.env.delete(k);
      else Deno.env.set(k, v);
    }
  }
}
const save = (body: Record<string, unknown>, world: World) => call(SETTINGS, "portal-settings", { action: "save_advanced_mode", ...body }, world);
const status = (world: World) => call(BILLING, "portal-billing", { action: "status" }, world);

const OWNER = { client_id: OWN, role: "owner", title: "owner", access: null };
const ADMIN = { client_id: OWN, role: "admin", title: "admin", access: null };
// A team member an owner gave Structures (edit) on the Team screen: past the gate, not the branch.
const STRUCTURES_EDITOR = { client_id: OWN, role: "user", title: "sales_manager", access: { settings_structures: "edit" } };
const SALES_REP = { client_id: OWN, role: "user", title: "sales_rep", access: null };
const OPERATOR = { me: { client_id: OPS_HOME, role: "user", title: null, access: null } };

/** The one write a save makes on a tenant that has a row: an update of the switch, and only it. */
function assertSwitchUpdate(trace: Trace, tenant: string, enabled: boolean) {
  assertEquals(trace.writes, ["client_settings:update"], `exactly one write, the update: ${JSON.stringify(trace.writes)}`);
  const [{ row, ops }] = trace.sets;
  assertEquals(Object.keys(row).sort(), ["advanced_mode", "updated_at"], "the switch and its timestamp: nothing else the row holds can move");
  assertEquals(eqOf(ops, "client_id"), tenant);
  assertEquals(row.advanced_mode, enabled);
  assert(!Number.isNaN(Date.parse(row.updated_at)), `updated_at ${row.updated_at}`);
}

// ─── 1. portal-settings save_advanced_mode ─────────────────────────────────────────────────────
Deno.test("an owner turns Advanced mode on: one update of the switch on their own row, audited", async () => {
  const r = await save({ enabled: true }, { me: OWNER });
  assertEquals(r.status, 200, JSON.stringify(r.body));
  assertEquals(r.body, { ok: true, advancedMode: true });
  assertSwitchUpdate(r.trace, OWN, true);
  const a = r.trace.audit.find((x) => x.action === "portal_advanced_mode");
  assert(a, `no audit row: ${JSON.stringify(r.trace.audit)}`);
  assertEquals(a.note, "advanced_mode=true");
  assertEquals(a.target_client_id, OWN);
  assertEquals(r.trace.errors, []);
});

Deno.test("an owner turns it off: the same row, false", async () => {
  const r = await save({ enabled: false }, { me: OWNER });
  assertEquals(r.status, 200, JSON.stringify(r.body));
  assertEquals(r.body.advancedMode, false);
  assertSwitchUpdate(r.trace, OWN, false);
});

Deno.test("no row yet, turning it ON: the update matches nothing, so one row is created with ramps kept OFF", async () => {
  const r = await save({ enabled: true }, { me: OWNER, noRow: true });
  assertEquals(r.status, 200, JSON.stringify(r.body));
  assertEquals(r.body, { ok: true, advancedMode: true });
  assertEquals(r.trace.writes, ["client_settings:update", "client_settings:insert"], JSON.stringify(r.trace.writes));
  const ins = r.trace.sets[1].row;
  assertEquals(Object.keys(ins).sort(), ["advanced_mode", "client_id", "ramp_enabled", "updated_at"]);
  assertEquals([ins.client_id, ins.advanced_mode], [OWN, true]);
  // ramp_enabled defaults to TRUE; get_fixtures reads a missing row as OFF. The create keeps OFF, or
  // this switch would put a ramp (with no price) on the builder's public designer.
  assertEquals(ins.ramp_enabled, false);
  assert(r.trace.audit.some((x) => x.action === "portal_advanced_mode"), JSON.stringify(r.trace.audit));
});

Deno.test("no row yet, turning it OFF: nothing is created (no row already reads as off)", async () => {
  const r = await save({ enabled: false }, { me: OWNER, noRow: true });
  assertEquals(r.status, 200, JSON.stringify(r.body));
  assertEquals(r.body, { ok: true, advancedMode: false });
  assertEquals(r.trace.writes, ["client_settings:update"], "the zero-row update only; no insert");
});

Deno.test("the row appears between the update and the insert: the switch lands by update, ramps untouched", async () => {
  const r = await save({ enabled: true }, { me: OWNER, noRow: true, rowAppears: true });
  assertEquals(r.status, 200, JSON.stringify(r.body));
  assertEquals(r.trace.writes, ["client_settings:update", "client_settings:insert", "client_settings:update"], JSON.stringify(r.trace.writes));
  assertEquals(Object.keys(r.trace.sets[2].row).sort(), ["advanced_mode", "updated_at"], "the retry is the plain update: an existing row's ramps are not touched");
  assertEquals(r.trace.sets[2].row.advanced_mode, true);
});

Deno.test("an admin may change it too", async () => {
  const r = await save({ enabled: true }, { me: ADMIN });
  assertEquals(r.status, 200, JSON.stringify(r.body));
  assertSwitchUpdate(r.trace, OWN, true);
});

Deno.test("a team member is refused with nothing written — past the area gate or not", async () => {
  // Holds settings_structures:edit, so the GATES line lets them in; the branch's role rule refuses.
  const editor = await save({ enabled: true }, { me: STRUCTURES_EDITOR });
  assertEquals(editor.status, 403, JSON.stringify(editor.body));
  assert(/owner or admin/i.test(editor.body.error), editor.body.error);
  assertEquals(editor.trace.writes, []);
  // A sales rep's preset has no Structures at all: the gate refuses before the branch runs.
  const rep = await save({ enabled: true }, { me: SALES_REP });
  assertEquals(rep.status, 403, JSON.stringify(rep.body));
  assertEquals(rep.trace.writes, []);
});

Deno.test("anything but a real boolean is refused, never coerced", async () => {
  for (const enabled of ["true", "false", 1, 0, null, "on", [true]]) {
    const r = await save({ enabled }, { me: OWNER });
    assertEquals(r.status, 400, `${JSON.stringify(enabled)} → ${JSON.stringify(r.body)}`);
    assertEquals(r.trace.writes, [], `${JSON.stringify(enabled)} wrote something`);
  }
  const missing = await call(SETTINGS, "portal-settings", { action: "save_advanced_mode" }, { me: OWNER });
  assertEquals(missing.status, 400);
  assertEquals(missing.trace.writes, []);
});

Deno.test("a platform operator in view-as writes the VIEWED builder's row, never their own", async () => {
  const r = await save({ enabled: true, targetClientId: VIEWED }, { ...OPERATOR, op: { can_write: true, can_bill: false, support_only: false } });
  assertEquals(r.status, 200, JSON.stringify(r.body));
  assertSwitchUpdate(r.trace, VIEWED, true);
  assertEquals(r.trace.audit.find((x) => x.action === "portal_advanced_mode")?.target_client_id, VIEWED);
});

Deno.test("a support operator is refused: the owner's map, not the owner's chair", async () => {
  const r = await save({ enabled: true, targetClientId: VIEWED }, { ...OPERATOR, op: { can_write: true, can_bill: false, support_only: true } });
  assertEquals(r.status, 403, JSON.stringify(r.body));
  assertEquals(r.trace.writes, []);
});

Deno.test("a read-only operator is refused before the branch (it is a write)", async () => {
  const r = await save({ enabled: true, targetClientId: VIEWED }, { ...OPERATOR, op: { can_write: false, can_bill: false, support_only: false } });
  assertEquals(r.status, 403, JSON.stringify(r.body));
  assert(/read-only/.test(r.body.error), r.body.error);
  assertEquals(r.trace.writes, []);
});

Deno.test("a failed write answers 500, never ok, and is logged with where it failed", async () => {
  const r = await save({ enabled: true }, { me: OWNER, writeFails: true });
  assertEquals(r.status, 500, JSON.stringify(r.body));
  assert(!r.body.ok, "a failed write must not say ok");
  assert(/turn Advanced mode on/.test(r.body.error), r.body.error);
  assert(!r.trace.audit.some((x) => x.action === "portal_advanced_mode"), "no audit row for a write that did not happen");
  // dbFail files it without awaiting; give that insert its turn.
  await new Promise((done) => setTimeout(done, 20));
  assert(r.trace.errors.some((e) => /turn Advanced mode on: the write timed out/.test(String(e.message))), JSON.stringify(r.trace.errors));
});

Deno.test("GATES: save_advanced_mode is settings_structures:edit (the Designer settings page's own area, as a write)", () => {
  assert(/save_advanced_mode:\s*\{ area: "settings_structures", level: "edit" \},/.test(SETTINGS_SRC), "the GATES line is missing or changed");
});

// ─── 2. portal-billing: the entitlement carries the switch ─────────────────────────────────────
Deno.test("advancedMode: the column, strictly; internal always; a missing row is off", async () => {
  const cases: [string, Record<string, unknown> | null, boolean][] = [
    ["switched on", { billing_exempt: false, internal_account: false, discount_percent: 0, advanced_mode: true }, true],
    ["switched off", { billing_exempt: false, internal_account: false, discount_percent: 0, advanced_mode: false }, false],
    ["no client_settings row at all", null, false],
    ["our own account, column off", { billing_exempt: false, internal_account: true, discount_percent: 0, advanced_mode: false }, true],
    ["a non-billable account, column off", { billing_exempt: true, internal_account: false, discount_percent: 0, advanced_mode: false }, false],
    ["a non-billable account, column on", { billing_exempt: true, internal_account: false, discount_percent: 0, advanced_mode: true }, true],
  ];
  for (const [name, settings, want] of cases) {
    const r = await status({ me: OWNER, settings });
    assertEquals(r.status, 200, `${name}: ${JSON.stringify(r.body)}`);
    assertEquals(r.body.entitlement.advancedMode, want, name);
  }
});

Deno.test("advancedMode changes nothing else in the entitlement", async () => {
  const off = await status({ me: OWNER, settings: { billing_exempt: false, internal_account: false, discount_percent: 0, advanced_mode: false } });
  const on = await status({ me: OWNER, settings: { billing_exempt: false, internal_account: false, discount_percent: 0, advanced_mode: true } });
  const { advancedMode: a, ...restOff } = off.body.entitlement;
  const { advancedMode: b, ...restOn } = on.body.entitlement;
  assertEquals([a, b], [false, true]);
  assertEquals(restOn, restOff, "granted / paid / features / state must not move with the switch");
  assertEquals(on.body.entitlement.granted, [], "the switch is not a grant");
  assert(!on.body.entitlement.paid.includes("view_3d"), "the switch is not 3D");
});

Deno.test("everyone on the account gets it (it rides on the entitlement, not the commercial detail)", async () => {
  const r = await status({ me: SALES_REP, settings: { billing_exempt: false, internal_account: false, discount_percent: 0, advanced_mode: true } });
  assertEquals(r.status, 200, JSON.stringify(r.body));
  assertEquals(r.body.entitlement.advancedMode, true);
  assertEquals(r.body.plans, [], "the commercial half is still withheld");
});

Deno.test("portal-billing reads advanced_mode on its own, never in the fatal settings read", async () => {
  const r = await status({ me: OWNER });
  const sel = r.trace.db.filter((q) => q[0] === "client_settings").map((q) => String((q.find((o: any) => o[0] === "select") ?? [])[1]));
  assertEquals(sel.length, 2, JSON.stringify(sel));
  assertEquals(sel[0], "billing_exempt, billing_exempt_until, discount_percent, discount_features, internal_account", "the fatal read is its five columns, as before 270");
  assertEquals(sel[1], "advanced_mode");
  assert(code(BILLING_SRC).includes("advancedMode: internal || (!advErr && advRow?.advanced_mode === true),"), "the rule moved");
  // Our own account has the page regardless, so it does not ask.
  const ours = await status({ me: OWNER, settings: { billing_exempt: false, internal_account: true, discount_percent: 0 } });
  assertEquals(ours.trace.db.filter((q) => q[0] === "client_settings").length, 1);
  assertEquals(ours.body.entitlement.advancedMode, true);
});

Deno.test("a database without the column (a deploy ahead of 270): status still answers, Advanced off, nothing else moves", async () => {
  const settings = { billing_exempt: false, internal_account: false, discount_percent: 0 };
  const grants = [{ client_id: OWN, feature: "view_3d", expires_at: null }];
  const subs = [BASE_SUB, { ...BASE_SUB, id: "s-3d", plan_id: "view_3d_annual" }];
  const without = await status({ me: OWNER, settings, grants, subs, noColumn: true });
  assertEquals(without.status, 200, JSON.stringify(without.body));
  assertEquals(without.body.entitlement.advancedMode, false);
  assert(without.body.entitlement.paid.includes("view_3d"), JSON.stringify(without.body.entitlement.paid));
  // The same tenant on a database that has the column, switched off: the whole entitlement agrees,
  // `paid` and `granted` included.
  const withCol = await status({ me: OWNER, settings: { ...settings, advanced_mode: false }, grants, subs });
  assertEquals(withCol.status, 200, JSON.stringify(withCol.body));
  assertEquals(without.body.entitlement.paid, withCol.body.entitlement.paid);
  assertEquals(without.body.entitlement.granted, withCol.body.entitlement.granted);
  assertEquals(without.body.entitlement, withCol.body.entitlement);
  // Our own account keeps the page even then: it never asks for the column.
  const ours = await status({ me: OWNER, settings: { ...settings, internal_account: true }, noColumn: true });
  assertEquals(ours.status, 200, JSON.stringify(ours.body));
  assertEquals(ours.body.entitlement.advancedMode, true);
});

// ─── 3. The portal half, pinned against the shipped sources ────────────────────────────────────
Deno.test("the card saves to the tenant on screen, then asks the shell to re-read the entitlement", () => {
  const card = code(between(CARD_SRC, "function AdvancedModeCard(", "\nfunction DesignerSettings(", "AdvancedModeCard"));
  const pin = card.indexOf("const target = ssTargetClientId || null;");
  const send = card.indexOf(`sb.functions.invoke("portal-settings", { body: { action: "save_advanced_mode", enabled: want, targetClientId: target } })`);
  const raise = card.indexOf("ssEntitlementChanged();");
  assert(pin > 0 && send > pin, "the target must be pinned in the click's tick, before the call");
  assert(raise > send, "ssEntitlementChanged must follow the server's answer");
  assert(card.indexOf("throw new Error(", send) < raise, "a refused save must not raise the signal");
  // Turning ON needs 3D; turning OFF never does; our own account cannot be changed here.
  assert(/const needs3d = !on && !has3d;/.test(card), "the 3D rule changed");
  assert(/const disabled = busy \|\| !!advanced\.locked \|\| needs3d;/.test(card), "the disabled rule changed");
  assert(/if \(!want && advanced\.confirmOff && !advanced\.confirmOff\(\)\) return;/.test(card), "turning off must ask the shell first");
  assert(CARD_SRC.includes("Adds an Advanced page under Designer for designing a building from scratch with every shape control."), "the card's words");
  assert(CARD_SRC.includes(">Needs 3D<"), "the Needs 3D badge");
});

Deno.test("the card sits above the 3D card in Settings → Designer, and only where the shell hands it one", () => {
  const ds = between(CARD_SRC, "function DesignerSettings(", "\nfunction DesignerTab(", "DesignerSettings");
  const cardAt = ds.indexOf("{advanced && <AdvancedModeCard advanced={advanced} has3d={!!setup3d} />}");
  const threeD = ds.indexOf(">3D</div>");
  assert(cardAt > 0 && threeD > cardAt, "AdvancedModeCard must render above the 3D card, gated on `advanced`");
  assert(/sub === "designer" && <DesignerSettings clientId=\{clientId\} setup3d=\{setup3d\} view3d=\{view3d\} canBill=\{canBill\} advanced=\{advanced\} \/>/.test(SETTINGS_SHELL_SRC), "SettingsShell must pass `advanced` through");
  assert(/advanced=\{advancedSwitch\}/.test(SHELL_SRC), "the shell must hand SettingsShell its advancedSwitch");
});

Deno.test("the action the card sends is the one the server answers", () => {
  assert(SETTINGS_SRC.includes(`if (action === "save_advanced_mode") {`));
  assert(CARD_SRC.includes(`action: "save_advanced_mode"`));
});

Deno.test("the migration adds the column off for everyone, closed to the browser", () => {
  assert(MIGRATION.includes("alter table public.client_settings add column advanced_mode boolean not null default false;"));
  assert(/has_column_privilege\(v_role, 'public\.client_settings', 'advanced_mode', 'SELECT'\)/.test(MIGRATION), "the browser-role check is gone");
  assert(MIGRATION.includes("raise exception '270: advanced_mode was just added and is already on for: %', v_on;"), "the first-run all-off check is gone");
  // One file for the batch: the column rides inside 270's own transaction, before its commit.
  assert(MIGRATION.indexOf("add column advanced_mode") < MIGRATION.lastIndexOf("\ncommit;"), "PART 5 must sit inside the transaction");
});
