// The plan and company-access actions (accessPlans.ts, migration 386), against an in-memory database
// that behaves like the live one where it matters:
//   * it knows each table's REAL columns and answers 42703 for any other (a fake that accepts any
//     column lets a wrong one ship: 2026-10-28, the pricing importer);
//   * a read returns at most 1000 rows whatever it asks for, with no error (PostgREST db-max-rows);
//   * primary keys, the two foreign keys and the CHECKs of migration 386 refuse what Postgres would.
// The resolver itself is SQL and is tested for real in tests/sql/migration386.test.cjs; here `rpc`
// only proves these actions ask it and pass its answer through.
//
// Run: deno test --no-check --allow-read supabase/functions/admin-catalog/accessPlans_test.ts
import { assert, assertEquals } from "jsr:@std/assert@1";
import {
  ACCESS_PLAN_ACTIONS, ACCESS_PLAN_READS, ACCESS_PLAN_WRITES, handleAccessPlansAction, MAX_ROWS, ROLLOUT_ALL_CONFIRM,
} from "./accessPlans.ts";
import { ACCESS_MODULES } from "../_shared/accessModules.ts";

type Row = Record<string, unknown>;

const COLUMNS: Record<string, string[]> = {
  access_modules: ["key", "label", "grp", "shed", "sort"],
  access_plans: ["key", "name", "blurb", "status", "visibility", "free_period", "replaces", "sort", "created_by", "created_at", "updated_at"],
  access_plan_modules: ["plan_key", "module", "state"],
  client_access_plans: ["client_id", "plan_key", "reason", "expires_at", "note", "set_by", "set_at"],
  client_modules: ["client_id", "module", "mode", "expires_at", "note", "set_by", "set_at"],
  client_configs: ["client_id", "company_name"],
  billing_plans: ["id", "feature", "name", "price_cents", "billing_interval", "active", "availability"],
  billing_subscriptions: ["id", "client_id", "plan_id", "status"],
  admin_audit: ["id", "created_at", "action", "target_client_id", "row_count", "note", "actor_email", "actor_user_id"],
  access_config: ["key", "value", "updated_at", "updated_by"],
};
const PK: Record<string, string[]> = {
  access_modules: ["key"], access_plans: ["key"], access_plan_modules: ["plan_key", "module"],
  client_access_plans: ["client_id", "plan_key"], client_modules: ["client_id", "module"], access_config: ["key"],
};

interface World {
  rows: Record<string, Row[]>;
  writes: { table: string; op: string }[];
  rpcCalls: { name: string; args: Row }[];
  fail?: Record<string, string>;          // "table:op" -> sqlstate
}

function pgErr(code: string, message: string) { return { code, message }; }

/** What Postgres would refuse on a write to one of 386's tables. */
function constraint(w: World, table: string, row: Row): { code: string; message: string } | null {
  const has = (t: string, col: string, v: unknown) => (w.rows[t] ?? []).some((r) => r[col] === v);
  if (table === "access_plan_modules") {
    if (!has("access_plans", "key", row.plan_key)) return pgErr("23503", "violates foreign key constraint access_plan_modules_plan_key_fkey");
    if (!has("access_modules", "key", row.module)) return pgErr("23503", "violates foreign key constraint access_plan_modules_module_fkey");
    if (!["included", "teaser"].includes(String(row.state))) return pgErr("23514", "violates check constraint access_plan_modules_state_check");
  }
  if (table === "client_access_plans") {
    if (!has("access_plans", "key", row.plan_key)) return pgErr("23503", "violates foreign key constraint client_access_plans_plan_key_fkey");
    if (!["comp", "paid_offline"].includes(String(row.reason))) return pgErr("23514", "violates check constraint");
  }
  if (table === "client_modules") {
    if (!has("access_modules", "key", row.module)) return pgErr("23503", "violates foreign key constraint client_modules_module_fkey");
    if (!["on", "off"].includes(String(row.mode))) return pgErr("23514", "violates check constraint");
  }
  if (table === "access_plans") {
    if (!/^[a-z][a-z0-9_]{1,39}$/.test(String(row.key))) return pgErr("23514", "violates check constraint access_plans_key_check");
    if (row.status !== undefined && !["draft", "active", "retired"].includes(String(row.status))) return pgErr("23514", "violates check constraint");
    if (row.visibility !== undefined && !["public", "private"].includes(String(row.visibility))) return pgErr("23514", "violates check constraint");
  }
  return null;
}

class Query {
  private filters: ((r: Row) => boolean)[] = [];
  private orders: [string, boolean][] = [];
  private from = 0;
  private to = Infinity;
  private single = false;
  private op: "select" | "update" | "delete" = "select";
  private patch: Row = {};
  private err: { code: string; message: string } | null = null;
  constructor(private w: World, private table: string) {
    if (!COLUMNS[table]) this.err = pgErr("42P01", `relation "public.${table}" does not exist`);
  }
  private col(c: string) {
    if (!this.err && !COLUMNS[this.table].includes(c)) this.err = pgErr("42703", `column ${this.table}.${c} does not exist`);
  }
  private injected(op: string) {
    const code = this.w.fail?.[`${this.table}:${op}`];
    if (code && !this.err) this.err = pgErr(code, `${op} on ${this.table} failed`);
  }
  select(cols: string) { for (const c of cols.split(",").map((s) => s.trim())) this.col(c); return this; }
  eq(c: string, v: unknown) { this.col(c); this.filters.push((r) => r[c] === v); return this; }
  in(c: string, vs: unknown[]) { this.col(c); this.filters.push((r) => vs.includes(r[c])); return this; }
  order(c: string, o?: { ascending?: boolean }) { this.col(c); this.orders.push([c, o?.ascending !== false]); return this; }
  range(from: number, to: number) { this.from = from; this.to = to; return this; }
  maybeSingle() { this.single = true; return this; }
  update(patch: Row) { this.op = "update"; this.patch = patch; for (const c of Object.keys(patch)) this.col(c); return this; }
  delete() { this.op = "delete"; return this; }
  insert(input: Row | Row[]) {
    const list = Array.isArray(input) ? input : [input];
    this.injected("insert");
    for (const row of list) for (const c of Object.keys(row)) this.col(c);
    if (!this.err) {
      const pk = PK[this.table];
      for (const row of list) {
        const c = constraint(this.w, this.table, row);
        if (c) { this.err = c; break; }
        if (pk && (this.w.rows[this.table] ?? []).some((r) => pk.every((k) => r[k] === row[k]))) {
          this.err = pgErr("23505", `duplicate key value violates unique constraint "${this.table}_pkey"`); break;
        }
      }
    }
    if (!this.err) {
      (this.w.rows[this.table] ??= []).push(...list.map((r) => ({ ...r })));
      this.w.writes.push({ table: this.table, op: "insert" });
    }
    return Promise.resolve({ data: null, error: this.err });
  }
  upsert(input: Row | Row[], opts: { onConflict: string }) {
    const list = Array.isArray(input) ? input : [input];
    const keys = opts.onConflict.split(",").map((s) => s.trim());
    this.injected("upsert");
    for (const row of list) for (const c of Object.keys(row)) this.col(c);
    for (const k of keys) this.col(k);
    if (!this.err) for (const row of list) { const c = constraint(this.w, this.table, row); if (c) { this.err = c; break; } }
    if (!this.err) {
      const rows = (this.w.rows[this.table] ??= []);
      for (const row of list) {
        const at = rows.findIndex((r) => keys.every((k) => r[k] === row[k]));
        if (at >= 0) rows[at] = { ...rows[at], ...row }; else rows.push({ ...row });
      }
      this.w.writes.push({ table: this.table, op: "upsert" });
    }
    return Promise.resolve({ data: null, error: this.err });
  }
  then<T>(res: (v: { data: unknown; error: unknown }) => T, rej?: (e: unknown) => T) {
    return Promise.resolve(this.run()).then(res, rej);
  }
  private run() {
    this.injected(this.op);
    if (this.err) return { data: null, error: this.err };
    const all = (this.w.rows[this.table] ??= []);
    const hit = all.filter((r) => this.filters.every((f) => f(r)));
    if (this.op === "update") {
      for (const r of hit) Object.assign(r, this.patch);
      this.w.writes.push({ table: this.table, op: "update" });
      return { data: null, error: null };
    }
    if (this.op === "delete") {
      this.w.rows[this.table] = all.filter((r) => !hit.includes(r));
      this.w.writes.push({ table: this.table, op: "delete" });
      return { data: null, error: null };
    }
    let rows = [...hit];
    for (const [c, asc] of [...this.orders].reverse()) {
      rows.sort((a, b) => (a[c] === b[c] ? 0 : (a[c] as string | number) < (b[c] as string | number) ? -1 : 1) * (asc ? 1 : -1));
    }
    rows = rows.slice(this.from, this.to === Infinity ? undefined : this.to + 1).slice(0, 1000);   // db-max-rows
    if (this.single) return { data: rows[0] ? { ...rows[0] } : null, error: null };
    return { data: rows.map((r) => ({ ...r })), error: null };
  }
}

function world(extra: Record<string, Row[]> = {}): World {
  const rows: Record<string, Row[]> = {
    access_modules: ACCESS_MODULES.map((m) => ({ key: m.key, label: m.label, grp: m.group, shed: m.shed, sort: m.sort })),
    access_plans: [
      { key: "crm", name: "Customer Hub", blurb: null, status: "active", visibility: "public", free_period: false, replaces: [], sort: 75 },
      { key: "simple_layout", name: "Simple Layout", blurb: null, status: "active", visibility: "public", free_period: true, replaces: [], sort: 100 },
      { key: "phone_contacts", name: "Phone + Contacts", blurb: null, status: "active", visibility: "private", free_period: false, replaces: [], sort: 50 },
      { key: "old_plan", name: "Old", blurb: null, status: "retired", visibility: "private", free_period: false, replaces: [], sort: 10 },
      { key: "wip_plan", name: "Not ready", blurb: null, status: "draft", visibility: "private", free_period: false, replaces: [], sort: 5 },
    ],
    access_plan_modules: [
      { plan_key: "crm", module: "contacts", state: "included" }, { plan_key: "crm", module: "pipelines", state: "included" },
      { plan_key: "crm", module: "quickbooks", state: "teaser" },
      { plan_key: "simple_layout", module: "designer", state: "included" }, { plan_key: "simple_layout", module: "contacts", state: "teaser" },
      { plan_key: "phone_contacts", module: "contacts", state: "included" }, { plan_key: "phone_contacts", module: "phone", state: "included" },
    ],
    client_access_plans: [], client_modules: [],
    client_configs: [{ client_id: "acme-sheds", company_name: "Acme Sheds" }, { client_id: "ridge-co", company_name: "Ridge Co" }],
    billing_plans: [
      { id: "crm_monthly", feature: "crm", active: true, availability: "available" },
      { id: "crm_annual", feature: "crm", active: true, availability: "available" },
      { id: "simple_layout_monthly", feature: "simple_layout", active: true, availability: "available" },
      { id: "soon_monthly", feature: "wip_plan", active: true, availability: "coming_soon" },
    ],
    billing_subscriptions: [
      { id: "s1", client_id: "acme-sheds", plan_id: "crm_annual", status: "active" },
      { id: "s2", client_id: "ridge-co", plan_id: "crm_monthly", status: "past_due" },
      { id: "s3", client_id: "ridge-co", plan_id: "crm_annual", status: "cancelled" },
    ],
    admin_audit: [],
    access_config: [{ key: "enforce", value: { all: false, clients: [] } }],
    ...extra,
  };
  return { rows, writes: [], rpcCalls: [] };
}

function db(w: World) {
  return {
    from: (t: string) => new Query(w, t),
    rpc: (name: string, args: Row) => {
      w.rpcCalls.push({ name, args });
      if (name === "access_resolve_detail") return Promise.resolve({ data: [{ module: "contacts", state: "on", source: "test" }], error: null });
      if (name === "access_usable_plans") return Promise.resolve({ data: ["crm", "crm"], error: null });
      return Promise.resolve({ data: null, error: pgErr("42883", `function ${name} does not exist`) });
    },
  };
}

const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s });
const OP = { via: "operator", userId: "16047abe-7156-4e7d-8734-cedf2f261927", email: "op@example.com" };
const NOW = new Date("2026-11-12T12:00:00Z");
async function call(w: World, action: string, p: Row = {}, identity = OP) {
  const res = await handleAccessPlansAction(db(w), action, p, identity, json, { now: () => NOW });
  return { status: res.status, body: await res.json() as Row };
}
const plan = (w: World, key: string) => w.rows.access_plans.find((r) => r.key === key);
const mods = (w: World, key: string) => Object.fromEntries(w.rows.access_plan_modules.filter((r) => r.plan_key === key).map((r) => [r.module, r.state]));
const audits = (w: World, action: string) => w.rows.admin_audit.filter((r) => r.action === action);

// ── the fake itself ──────────────────────────────────────────────────────────────────────────
Deno.test("the fake caps a read at 1000 rows and refuses a column the table lacks", async () => {
  const w = world({ client_access_plans: Array.from({ length: 1500 }, (_, i) => ({ client_id: `c${String(i).padStart(4, "0")}`, plan_key: "crm", reason: "comp", expires_at: null })) });
  const capped = await db(w).from("client_access_plans").select("client_id").range(0, 4999);
  assertEquals((capped.data as Row[]).length, 1000);
  const bad = await db(w).from("access_plans").select("key, price_cents");
  assertEquals((bad.error as { code: string }).code, "42703");
  assertEquals(MAX_ROWS, 1000);
});

// ── reads ────────────────────────────────────────────────────────────────────────────────────
Deno.test("access_plan_list: the catalogue, each plan's tabs, who holds it, and whether it is sold", async () => {
  const w = world();
  w.rows.client_access_plans.push(
    { client_id: "acme-sheds", plan_key: "phone_contacts", reason: "comp", expires_at: null },
    { client_id: "ridge-co", plan_key: "phone_contacts", reason: "comp", expires_at: "2026-11-01T00:00:00Z" },   // ended
  );
  const { status, body } = await call(w, "access_plan_list");
  assertEquals(status, 200);
  assertEquals((body.modules as Row[]).length, ACCESS_MODULES.length);
  const plans = body.plans as Row[];
  assertEquals(plans.map((p) => p.key), ["wip_plan", "old_plan", "phone_contacts", "crm", "simple_layout"]);   // by sort
  const crm = plans.find((p) => p.key === "crm")!;
  assertEquals(crm.modules, { contacts: "included", pipelines: "included", quickbooks: "teaser" });
  assertEquals([crm.sold, crm.forSale], [true, true]);
  const phone = plans.find((p) => p.key === "phone_contacts")!;
  assertEquals([phone.assigned, phone.sold, phone.forSale], [1, false, false]);   // the ended assignment is not counted
  const wip = plans.find((p) => p.key === "wip_plan")!;
  assertEquals([wip.sold, wip.forSale], [true, false]);                           // priced, but coming soon
  assertEquals(w.writes.length, 0);
});

Deno.test("access_plan_list counts assignments past the 1000-row cap", async () => {
  const w = world({ client_access_plans: Array.from({ length: 2300 }, (_, i) => ({ client_id: `c${String(i).padStart(4, "0")}`, plan_key: "crm", reason: "comp", expires_at: null })) });
  const { body } = await call(w, "access_plan_list");
  assertEquals((body.plans as Row[]).find((p) => p.key === "crm")!.assigned, 2300);
});

Deno.test("access_client_get: asks the resolver, and returns its answer with the rows behind it", async () => {
  const w = world();
  w.rows.client_modules.push({ client_id: "acme-sheds", module: "jack", mode: "on", expires_at: null, note: "trial" });
  const { status, body } = await call(w, "access_client_get", { clientId: "acme-sheds" });
  assertEquals(status, 200);
  assertEquals(body.tabs, [{ module: "contacts", state: "on", source: "test" }]);
  assertEquals(body.subscribed, ["crm"]);                                          // de-duplicated
  assertEquals((body.exceptions as Row[]).map((e) => e.module), ["jack"]);
  assertEquals(w.rpcCalls.map((c) => [c.name, c.args.p_client_id]), [["access_resolve_detail", "acme-sheds"], ["access_usable_plans", "acme-sheds"]]);
  assertEquals((await call(w, "access_client_get", { clientId: "nobody" })).status, 404);
  assertEquals((await call(w, "access_client_get", { clientId: "Not A Slug" })).status, 400);
});

// ── plans ────────────────────────────────────────────────────────────────────────────────────
Deno.test("access_plan_save: a new plan is private and active, and is audited", async () => {
  const w = world();
  const { status, body } = await call(w, "access_plan_save", { key: "gutters_basic", name: "  Gutters Basic  ", blurb: "For gutter installers." });
  assertEquals(status, 200);
  assertEquals(body.created, true);
  const row = plan(w, "gutters_basic")!;
  assertEquals([row.name, row.visibility, row.status, row.blurb, row.created_by], ["Gutters Basic", "private", "active", "For gutter installers.", OP.userId]);
  assertEquals(audits(w, "access_plan_save").length, 1);
  assert(String(audits(w, "access_plan_save")[0].note).includes("gutters_basic"));
});

Deno.test("access_plan_save refuses a bad key, a missing name, and unknown values, writing nothing", async () => {
  const w = world();
  for (const p of [
    { key: "Gutters", name: "x" }, { key: "g", name: "x" }, { key: "gutters-basic", name: "x" }, { key: "9lives", name: "x" },
    { key: "gutters_basic" }, { key: "gutters_basic", name: "   " }, { key: "gutters_basic", name: "x".repeat(81) },
    { key: "gutters_basic", name: "x", visibility: "secret" }, { key: "gutters_basic", name: "x", freePeriod: "yes" },
    { key: "gutters_basic", name: "x", sort: 1.5 }, { key: "gutters_basic", name: "x", status: "retired" },
    { key: "gutters_basic", name: "x", replaces: ["no_such_plan"] }, { key: "gutters_basic", name: "x", replaces: ["gutters_basic"] },
    { key: "gutters_basic", name: "x", replaces: "crm" },
  ]) {
    const { status } = await call(w, "access_plan_save", p);
    assertEquals(status, 400, JSON.stringify(p));
  }
  assertEquals(w.writes.length, 0);
});

Deno.test("access_plan_save: an existing plan takes only the fields sent; a plan in use never becomes a draft", async () => {
  const w = world();
  assertEquals((await call(w, "access_plan_save", { key: "crm", blurb: "Contacts and pipelines.", sort: 80 })).status, 200);
  assertEquals([plan(w, "crm")!.name, plan(w, "crm")!.blurb, plan(w, "crm")!.sort, plan(w, "crm")!.visibility], ["Customer Hub", "Contacts and pipelines.", 80, "public"]);
  assertEquals((await call(w, "access_plan_save", { key: "crm" })).status, 400);                              // nothing to change
  assertEquals((await call(w, "access_plan_save", { key: "crm", status: "draft" })).status, 400);
  assertEquals((await call(w, "access_plan_save", { key: "old_plan", status: "active" })).status, 400);       // that is retire's job
  assertEquals((await call(w, "access_plan_save", { key: "wip_plan", status: "active" })).status, 200);       // a draft goes live here
  assertEquals(plan(w, "wip_plan")!.status, "active");
  assertEquals((await call(w, "access_plan_save", { key: "new_draft", name: "Later", status: "draft" })).status, 200);
  assertEquals(plan(w, "new_draft")!.status, "draft");
  assertEquals((await call(w, "access_plan_save", { key: "crm", replaces: ["simple_layout"] })).status, 200);
  assertEquals(plan(w, "crm")!.replaces, ["simple_layout"]);
});

Deno.test("access_plan_set_modules is a PATCH: one tab sent changes one tab", async () => {
  const w = world();
  const { status, body } = await call(w, "access_plan_set_modules", { key: "crm", modules: { meetings: "included" } });
  assertEquals(status, 200);
  assertEquals(mods(w, "crm"), { contacts: "included", pipelines: "included", quickbooks: "teaser", meetings: "included" });
  assertEquals(body.reach, { assigned: 0, subscribed: 2 });        // active + past_due companies; a cancelled row adds nobody
  const a = audits(w, "access_plan_set_modules")[0];
  assert(String(a.note).includes('"before"') && String(a.note).includes('"after"'));
});

Deno.test("access_plan_set_modules: hidden removes, a state changes in place, replace makes it the whole list", async () => {
  const w = world();
  await call(w, "access_plan_set_modules", { key: "crm", modules: { quickbooks: "hidden", pipelines: "teaser" } });
  assertEquals(mods(w, "crm"), { contacts: "included", pipelines: "teaser" });
  await call(w, "access_plan_set_modules", { key: "crm", modules: { contacts: null } });
  assertEquals(mods(w, "crm"), { pipelines: "teaser" });
  await call(w, "access_plan_set_modules", { key: "crm", replace: true, modules: { forms: "included", jack: "teaser" } });
  assertEquals(mods(w, "crm"), { forms: "included", jack: "teaser" });
  assertEquals(mods(w, "simple_layout"), { designer: "included", contacts: "teaser" });   // another plan's rows never move
});

Deno.test("access_plan_set_modules refuses a tab outside the catalogue or a bad state, and writes NOTHING", async () => {
  const w = world();
  for (const p of [
    { key: "crm", modules: { contacts: "included", contcats: "included" } },
    { key: "crm", modules: { contacts: "maybe" } }, { key: "crm", modules: { contacts: true } },
    { key: "crm", modules: ["contacts"] }, { key: "crm" }, { key: "crm", modules: "contacts" },
    { key: "crm", modules: JSON.parse('{"__proto__":"included","constructor":"included"}') },
  ]) {
    const { status } = await call(w, "access_plan_set_modules", p as Row);
    assertEquals(status, 400, JSON.stringify(p));
  }
  assertEquals((await call(w, "access_plan_set_modules", { key: "no_such", modules: { contacts: "included" } })).status, 404);
  assertEquals(w.writes.length, 0);
});

Deno.test("the phone-only plan can change but can never be left with nothing included", async () => {
  const w = world();
  assertEquals((await call(w, "access_plan_set_modules", { key: "phone_contacts", modules: { contacts: "hidden", phone: "hidden" } })).status, 400);
  assertEquals((await call(w, "access_plan_set_modules", { key: "phone_contacts", replace: true, modules: { jack: "teaser" } })).status, 400);
  assertEquals((await call(w, "access_plan_set_modules", { key: "phone_contacts", modules: { contacts: "teaser", phone: "teaser" } })).status, 400);
  assertEquals(mods(w, "phone_contacts"), { contacts: "included", phone: "included" });
  assertEquals((await call(w, "access_plan_set_modules", { key: "phone_contacts", modules: { contacts: "hidden", sms: "included" } })).status, 200);
  assertEquals(mods(w, "phone_contacts"), { phone: "included", sms: "included" });
  assertEquals((await call(w, "access_plan_save", { key: "phone_contacts", status: "draft" })).status, 400);
});

Deno.test("access_plan_duplicate copies the tabs into a new PRIVATE plan", async () => {
  const w = world();
  w.rows.access_plans.find((r) => r.key === "simple_layout")!.replaces = ["crm"];
  const { status, body } = await call(w, "access_plan_duplicate", { from: "simple_layout", key: "simple_layout_v2", name: "Simple Layout v2" });
  assertEquals(status, 200);
  const copy = plan(w, "simple_layout_v2")!;
  assertEquals([copy.visibility, copy.status, copy.free_period, copy.replaces], ["private", "active", false, []]);
  assertEquals(mods(w, "simple_layout_v2"), mods(w, "simple_layout"));
  assertEquals((body.plan as Row).modules, { contacts: "teaser", designer: "included" });
  assertEquals((await call(w, "access_plan_duplicate", { from: "simple_layout", key: "crm", name: "x" })).status, 409);
  assertEquals((await call(w, "access_plan_duplicate", { from: "nope_plan", key: "copy_two", name: "x" })).status, 404);
  assertEquals((await call(w, "access_plan_duplicate", { from: "crm", key: "copy_two" })).status, 400);
});

Deno.test("access_plan_duplicate takes a half-made copy back out when its tabs fail to save", async () => {
  const w = world();
  w.fail = { "access_plan_modules:insert": "57014" };
  let threw = false;
  try { await call(w, "access_plan_duplicate", { from: "crm", key: "crm_copy", name: "Copy" }); } catch (_e) { threw = true; }
  assert(threw, "a database fault must surface, not read as success");
  assertEquals(plan(w, "crm_copy"), undefined);
});

Deno.test("access_plan_retire retires and restores; a retired plan cannot be newly assigned", async () => {
  const w = world();
  assertEquals((await call(w, "access_plan_retire", { key: "crm", retired: true })).body.status, "retired");
  assertEquals(plan(w, "crm")!.status, "retired");
  assertEquals((await call(w, "access_client_plan_assign", { clientId: "acme-sheds", planKey: "crm" })).status, 400);
  assertEquals((await call(w, "access_plan_retire", { key: "crm", retired: false })).body.status, "active");
  assertEquals((await call(w, "access_plan_retire", { key: "wip_plan", retired: true })).status, 400);
  assertEquals((await call(w, "access_plan_retire", { key: "crm" })).status, 400);
  assertEquals((await call(w, "access_plan_retire", { key: "no_such", retired: true })).status, 404);
});

// ── one company ──────────────────────────────────────────────────────────────────────────────
Deno.test("access_client_plan_assign: a comp by default, an end date in the future, the resolver's answer back", async () => {
  const w = world();
  const { status, body } = await call(w, "access_client_plan_assign", { clientId: "acme-sheds", planKey: "phone_contacts", note: "trial month", expiresAt: "2026-12-12T00:00:00Z" });
  assertEquals(status, 200);
  const row = w.rows.client_access_plans[0];
  assertEquals([row.client_id, row.plan_key, row.reason, row.expires_at, row.note, row.set_by], ["acme-sheds", "phone_contacts", "comp", "2026-12-12T00:00:00.000Z", "trial month", OP.userId]);
  assertEquals(body.tabs, [{ module: "contacts", state: "on", source: "test" }]);
  assertEquals(audits(w, "access_client_plan_assign")[0].target_client_id, "acme-sheds");
  // Assigning again replaces the row, it never adds a second.
  await call(w, "access_client_plan_assign", { clientId: "acme-sheds", planKey: "phone_contacts", reason: "paid_offline" });
  assertEquals(w.rows.client_access_plans.length, 1);
  assertEquals([w.rows.client_access_plans[0].reason, w.rows.client_access_plans[0].expires_at], ["paid_offline", null]);
});

Deno.test("access_client_plan_assign refuses an unknown company or plan, a draft, a past date and a bad reason", async () => {
  const w = world();
  assertEquals((await call(w, "access_client_plan_assign", { clientId: "nobody", planKey: "crm" })).status, 404);
  assertEquals((await call(w, "access_client_plan_assign", { clientId: "acme-sheds", planKey: "no_such" })).status, 404);
  assertEquals((await call(w, "access_client_plan_assign", { clientId: "acme-sheds", planKey: "wip_plan" })).status, 400);
  assertEquals((await call(w, "access_client_plan_assign", { clientId: "acme-sheds", planKey: "old_plan" })).status, 400);
  assertEquals((await call(w, "access_client_plan_assign", { clientId: "acme-sheds", planKey: "crm", expiresAt: "2026-11-01T00:00:00Z" })).status, 400);
  assertEquals((await call(w, "access_client_plan_assign", { clientId: "acme-sheds", planKey: "crm", expiresAt: "soon" })).status, 400);
  assertEquals((await call(w, "access_client_plan_assign", { clientId: "acme-sheds", planKey: "crm", reason: "gift" })).status, 400);
  assertEquals((await call(w, "access_client_plan_assign", { clientId: "acme-sheds", planKey: "crm", note: "x".repeat(501) })).status, 400);
  assertEquals(w.writes.length, 0);
});

Deno.test("access_client_plan_remove removes an assignment, and says where a card plan is cancelled", async () => {
  const w = world();
  await call(w, "access_client_plan_assign", { clientId: "acme-sheds", planKey: "phone_contacts" });
  assertEquals((await call(w, "access_client_plan_remove", { clientId: "acme-sheds", planKey: "phone_contacts" })).status, 200);
  assertEquals(w.rows.client_access_plans.length, 0);
  const again = await call(w, "access_client_plan_remove", { clientId: "acme-sheds", planKey: "crm" });   // held by card, not by assignment
  assertEquals(again.status, 404);
  assert(String(again.body.error).includes("Billing"));
  assertEquals(w.rows.billing_subscriptions.length, 3);
});

Deno.test("access_client_module_set: on, off, an end date, and plan to clear it", async () => {
  const w = world();
  assertEquals((await call(w, "access_client_module_set", { clientId: "acme-sheds", module: "jack", mode: "on", expiresAt: "2027-01-01T00:00:00Z" })).status, 200);
  assertEquals([w.rows.client_modules[0].mode, w.rows.client_modules[0].expires_at], ["on", "2027-01-01T00:00:00.000Z"]);
  await call(w, "access_client_module_set", { clientId: "acme-sheds", module: "jack", mode: "off", note: "asked to pause" });
  assertEquals(w.rows.client_modules.length, 1);
  assertEquals([w.rows.client_modules[0].mode, w.rows.client_modules[0].expires_at, w.rows.client_modules[0].note], ["off", null, "asked to pause"]);
  assertEquals((await call(w, "access_client_module_set", { clientId: "acme-sheds", module: "jack", mode: "plan" })).status, 200);
  assertEquals(w.rows.client_modules.length, 0);
  assertEquals((await call(w, "access_client_module_set", { clientId: "acme-sheds", module: "jack", mode: null })).status, 200);   // clearing nothing is fine
  assertEquals(audits(w, "access_client_module_set").length, 4);
  for (const p of [
    { clientId: "acme-sheds", module: "jacks", mode: "on" }, { clientId: "acme-sheds", module: "jack", mode: "maybe" },
    { clientId: "acme-sheds", module: "jack" }, { clientId: "acme-sheds", module: "jack", mode: "on", expiresAt: "2020-01-01" },
  ]) assertEquals((await call(w, "access_client_module_set", p as Row)).status, 400, JSON.stringify(p));
  assertEquals((await call(w, "access_client_module_set", { clientId: "nobody", module: "jack", mode: "on" })).status, 404);
});

Deno.test("the break-glass password path writes with no operator id, and an audit failure never fails a write", async () => {
  const w = world();
  const { status } = await call(w, "access_client_module_set", { clientId: "acme-sheds", module: "jack", mode: "on" }, { via: "password" } as typeof OP);
  assertEquals(status, 200);
  assertEquals(w.rows.client_modules[0].set_by, null);
  assertEquals(audits(w, "access_client_module_set")[0].actor_user_id, null);
  const w2 = world();
  w2.fail = { "admin_audit:insert": "57014" };
  assertEquals((await call(w2, "access_plan_save", { key: "quiet_plan", name: "Quiet" })).status, 200);
  assert(plan(w2, "quiet_plan"));
});

Deno.test("no action ever writes a billing table, a company row or the catalogue", async () => {
  const w = world();
  await call(w, "access_plan_save", { key: "gutters_basic", name: "Gutters Basic" });
  await call(w, "access_plan_set_modules", { key: "gutters_basic", modules: { contacts: "included", phone: "included" } });
  await call(w, "access_plan_duplicate", { from: "gutters_basic", key: "gutters_plus", name: "Gutters Plus" });
  await call(w, "access_plan_retire", { key: "gutters_plus", retired: true });
  await call(w, "access_client_plan_assign", { clientId: "ridge-co", planKey: "gutters_basic" });
  await call(w, "access_client_module_set", { clientId: "ridge-co", module: "jack", mode: "off" });
  await call(w, "access_client_plan_remove", { clientId: "ridge-co", planKey: "gutters_basic" });
  const touched = new Set(w.writes.map((x) => x.table));
  assertEquals([...touched].sort(), ["access_plan_modules", "access_plans", "admin_audit", "client_access_plans", "client_modules"]);
  await call(w, "access_rollout_set", { clientId: "ridge-co", on: true });
  const touched2 = new Set(w.writes.map((x) => x.table));
  assertEquals([...touched2].sort(), ["access_config", "access_plan_modules", "access_plans", "admin_audit", "client_access_plans", "client_modules"]);
});

// ── the rollout switch (387) ─────────────────────────────────────────────────────────────────
const rollout = (w: World) => w.rows.access_config.find((r) => r.key === "enforce")!.value as
  { all: boolean; clients: string[]; server_all: boolean; server_clients: string[]; server_report: string[] };

Deno.test("access_rollout_set names one company at a time, and un-names it", async () => {
  const w = world();
  assertEquals((await call(w, "access_rollout_get")).body, { all: false, clients: [], server_all: false, server_clients: [], server_report: [] });
  const on = await call(w, "access_rollout_set", { clientId: "ridge-co", on: true });
  assertEquals([on.status, on.body.all, on.body.clients], [200, false, ["ridge-co"]]);
  await call(w, "access_rollout_set", { clientId: "acme-sheds", on: true });
  await call(w, "access_rollout_set", { clientId: "acme-sheds", on: true });           // naming twice is one entry
  assertEquals(rollout(w).clients, ["acme-sheds", "ridge-co"]);
  await call(w, "access_rollout_set", { clientId: "ridge-co", on: false });
  assertEquals([rollout(w).all, rollout(w).clients], [false, ["acme-sheds"]]);
  assertEquals((await call(w, "access_rollout_set", { clientId: "long-gone", on: false })).status, 200);   // un-naming a company that left is fine
  const a = audits(w, "access_rollout_set")[0];
  assert(String(a.note).includes('"before"') && a.target_client_id === "ridge-co");
});

Deno.test("access_rollout_set refuses an unknown company, a missing on, and nothing to do", async () => {
  const w = world();
  assertEquals((await call(w, "access_rollout_set", { clientId: "nobody", on: true })).status, 404);
  assertEquals((await call(w, "access_rollout_set", { clientId: "acme-sheds" })).status, 400);
  assertEquals((await call(w, "access_rollout_set", { clientId: "acme-sheds", on: "yes" })).status, 400);
  assertEquals((await call(w, "access_rollout_set", {})).status, 400);
  assertEquals((await call(w, "access_rollout_set", { all: "true" })).status, 400);
  assertEquals([rollout(w).all, rollout(w).clients], [false, []]);
  assertEquals(w.writes.length, 0);
});

Deno.test("switching EVERY company on needs the phrase; switching it back off does not", async () => {
  const w = world();
  assertEquals((await call(w, "access_rollout_set", { all: true })).status, 400);
  assertEquals((await call(w, "access_rollout_set", { all: true, confirm: "yes" })).status, 400);
  assertEquals(rollout(w).all, false);
  assertEquals((await call(w, "access_rollout_set", { all: true, confirm: ROLLOUT_ALL_CONFIRM })).status, 200);
  assertEquals(rollout(w).all, true);
  assertEquals((await call(w, "access_rollout_set", { all: false })).status, 200);
  assertEquals(rollout(w).all, false);
});

Deno.test("a malformed rollout row reads as nobody, and the next write repairs it", async () => {
  const w = world({ access_config: [{ key: "enforce", value: { all: "true", clients: "acme-sheds" } }] });
  assertEquals((await call(w, "access_rollout_get")).body, { all: false, clients: [], server_all: false, server_clients: [], server_report: [] });
  await call(w, "access_rollout_set", { clientId: "acme-sheds", on: true });
  assertEquals(rollout(w), { all: false, clients: ["acme-sheds"], server_all: false, server_clients: [], server_report: [] });
  const none = world({ access_config: [] });
  assertEquals((await call(none, "access_rollout_get")).body, { all: false, clients: [], server_all: false, server_clients: [], server_report: [] });
  await call(none, "access_rollout_set", { clientId: "acme-sheds", on: true });
  assertEquals(rollout(none).clients, ["acme-sheds"]);
});

Deno.test("the three steps are three lists, and moving a company one step never drops another step's list", async () => {
  const w = world();
  await call(w, "access_rollout_set", { clientId: "acme-sheds", on: true });                       // portal (the default)
  await call(w, "access_rollout_set", { layer: "report", clientId: "acme-sheds", on: true });
  await call(w, "access_rollout_set", { layer: "report", clientId: "ridge-co", on: true });
  await call(w, "access_rollout_set", { layer: "server", clientId: "acme-sheds", on: true });
  assertEquals(rollout(w), { all: false, clients: ["acme-sheds"], server_all: false, server_clients: ["acme-sheds"], server_report: ["acme-sheds", "ridge-co"] });
  // Stepping the server back off leaves the portal and the report list alone.
  await call(w, "access_rollout_set", { layer: "server", clientId: "acme-sheds", on: false });
  assertEquals(rollout(w), { all: false, clients: ["acme-sheds"], server_all: false, server_clients: [], server_report: ["acme-sheds", "ridge-co"] });
  const a = audits(w, "access_rollout_set");
  assert(String(a[a.length - 1].note).includes('"layer":"server"'));
});

Deno.test("the server's `all` needs the phrase too; report has no all; an unknown layer is refused", async () => {
  const w = world();
  assertEquals((await call(w, "access_rollout_set", { layer: "server", all: true })).status, 400);
  assertEquals((await call(w, "access_rollout_set", { layer: "server", all: true, confirm: ROLLOUT_ALL_CONFIRM })).status, 200);
  assertEquals([rollout(w).server_all, rollout(w).all], [true, false]);                              // the server's all is not the portal's
  assertEquals((await call(w, "access_rollout_set", { layer: "server", all: false })).status, 200);
  assertEquals(rollout(w).server_all, false);
  assertEquals((await call(w, "access_rollout_set", { layer: "report", all: true, confirm: ROLLOUT_ALL_CONFIRM })).status, 400);
  assertEquals((await call(w, "access_rollout_set", { layer: "everything", clientId: "acme-sheds", on: true })).status, 400);
  assertEquals((await call(w, "access_rollout_set", { layer: "report", clientId: "nobody", on: true })).status, 404);
});

Deno.test("a row written before the server lists existed keeps its portal list when a server step is added", async () => {
  const w = world({ access_config: [{ key: "enforce", value: { all: false, clients: ["ridge-co"] } }] });
  await call(w, "access_rollout_set", { layer: "report", clientId: "ridge-co", on: true });
  assertEquals(rollout(w), { all: false, clients: ["ridge-co"], server_all: false, server_clients: [], server_report: ["ridge-co"] });
});

Deno.test("an unknown action is refused", async () => {
  assertEquals((await call(world(), "access_plan_delete", { key: "crm" })).status, 400);
});

// ── the wiring in admin-catalog/index.ts, read from the shipped source ───────────────────────
Deno.test("admin-catalog routes every action here, lists the reads as read-only and puts the writes on the money grant", async () => {
  const src = (await Deno.readTextFile(new URL("./index.ts", import.meta.url))).replace(/\r\n/g, "\n");
  for (const a of ACCESS_PLAN_ACTIONS) assert(src.includes(`case "${a}":`), `admin-catalog has no case for ${a}`);
  assertEquals([...ACCESS_PLAN_READS].sort(), ["access_client_get", "access_plan_list", "access_rollout_get"]);
  const ro = src.slice(src.indexOf("const READ_ONLY_ACTIONS = new Set(["), src.indexOf('if (identity.via === "operator" && !READ_ONLY_ACTIONS.has('));
  assert(ro.includes("...ACCESS_PLAN_READS"), "the two reads are not on READ_ONLY_ACTIONS");
  assert(!ro.includes("ACCESS_PLAN_WRITES"), "a write is on READ_ONLY_ACTIONS");
  for (const wAction of ACCESS_PLAN_WRITES) assert(!ro.includes(`"${wAction}"`), `${wAction} is listed as read-only`);
  assert(/if \(ACCESS_PLAN_WRITES\.includes\(String\(action \?\? ""\)\) && !identity\.canBill\) \{\s*return json\(\{ error: "This operator account cannot change plans or a company's access\." \}, 403\);/.test(src),
    "the plan writes are not gated on can_bill");
});
