// portal-setup's two Jack additions, driven through the SHIPPED request handler.
//
//   list    each step carries `key` (setup_template_items.jack_key, read through template_item_id)
//           and `completed_via` ('jack' or null). A hidden step still never leaves the server, a
//           locked one is still flagged, and the counts are unchanged.
//   toggle  `viaProposal` stamps completed_via='jack' only for a Jack card of THIS builder that is
//           being saved right now, was approved by the caller and lists this step. Anything else
//           is one refusal. An untick naming a card clears only that card's own tick. A person's
//           own tick clears the marker.
//
// And the deploy order: before the migration that adds the three columns, the list still loads
// (key and completed_via null) and a person's tick still works, while Jack's tick is refused rather
// than recorded as the person's. The fake answers 42703 for a column it doesn't have, the way
// PostgREST does, so that fallback is tested, not assumed.
//
// Run (from supabase/functions/):
//   deno test --quiet --allow-env --allow-read --node-modules-dir=none \
//     --import-map=_shared/_test_stubs/import_map.json \
//     _shared/_test_stubs/portalSetupJack_test.ts
//
// Same loading trick as calChargeWallet_test.ts: Deno.serve is stubbed, the module is imported, and
// the import map swaps supabase-js for supabase_stub.ts. No network permission: fetch is never
// reached (the bearer isn't a JWT, so the caller is read through the stub's auth.getUser()).

// deno-lint-ignore-file no-explicit-any
import { stubAuth, stubDb } from "./supabase_stub.ts";

function assertEquals(actual: unknown, expected: unknown, msg = ""): void {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a !== e) throw new Error(`Expected ${e}, got ${a}${msg ? ` (${msg})` : ""}`);
}
function assert(v: unknown, msg = ""): void {
  if (!v) throw new Error(`Assertion failed${msg ? `: ${msg}` : ""}`);
}

const realServe = Deno.serve;
let handler: ((req: Request) => Promise<Response>) | null = null;
(Deno as any).serve = (h: (req: Request) => Promise<Response>) => {
  handler = h;
  return { finished: Promise.resolve() };
};
await import(new URL("../../portal-setup/index.ts", import.meta.url).href);
(Deno as any).serve = realServe;
if (!handler) throw new Error("portal-setup did not hand Deno.serve a handler");
const HANDLER = handler as (req: Request) => Promise<Response>;

const T = "example-builder";
const OTHER = "another-builder";
const OWNER = "00000000-0000-4000-8000-000000000001";
const REP = "00000000-0000-4000-8000-000000000002";
const CARD = "10000000-0000-4000-8000-000000000001";
const PROJECT = "https://stub.supabase.co";
const ENV: Record<string, string> = { SUPABASE_URL: PROJECT, SUPABASE_ANON_KEY: "stub-anon", SUPABASE_SERVICE_ROLE_KEY: "stub-service" };

// ── The tables, with the columns they really have ─────────────────────────────────────────────
// Before the migration the three new columns don't exist, and naming one is a 42703.
const BASE_COLUMNS: Record<string, string[]> = {
  client_users: ["user_id", "client_id", "role", "title", "access", "full_name"],
  tenant_setup_items: ["id", "client_id", "template_item_id", "title", "detail", "link_page", "section", "image_url", "position", "completed_at", "completed_by_kind", "completed_by_name", "created_at"],
  setup_template_items: ["id", "title", "requires_feature", "builder_visible", "account_type"],
  jack_proposals: ["id", "client_id", "user_id", "kind", "status", "approved_by", "payload"],
  client_settings: ["client_id", "internal_account", "billing_exempt", "sheds_enabled"],
  billing_plans: ["id", "feature", "billing_interval", "operator_grantable"],
  app_errors: [],
};
const NEW_COLUMNS: Record<string, string[]> = {
  tenant_setup_items: ["completed_via", "completed_proposal_id"],
  setup_template_items: ["jack_key"],
};
type Row = Record<string, unknown>;

class World {
  migrated = true;
  tables: Record<string, Row[]>;
  writes: string[] = [];
  constructor() {
    this.tables = {
      client_users: [
        { user_id: OWNER, client_id: T, role: "owner", title: null, access: null, full_name: "Mike Owner" },
        { user_id: REP, client_id: T, role: "user", title: null, access: null, full_name: "Rita Rep" },
      ],
      setup_template_items: [
        { id: "t-business", title: "Add your business details and logo", requires_feature: null, builder_visible: true, jack_key: "business" },
        { id: "t-email", title: "Send email from your own domain", requires_feature: null, builder_visible: false, jack_key: "email_domain" },
        { id: "t-qbo", title: "QuickBooks", requires_feature: "quickbooks_sync", builder_visible: true, jack_key: "quickbooks" },
        { id: "t-nokey", title: "An old step", requires_feature: null, builder_visible: true, jack_key: null },
      ],
      tenant_setup_items: [
        step("s-business", "t-business", 1),
        step("s-email", "t-email", 2),
        step("s-qbo", "t-qbo", 3),
        step("s-nokey", "t-nokey", 4),
        step("s-bespoke", null, 5),
        { ...step("s-theirs", "t-business", 1), client_id: OTHER },
      ],
      jack_proposals: [],
      client_settings: [{ client_id: T, internal_account: false, billing_exempt: false }],
      billing_plans: [],
      app_errors: [],
    };
  }
  columns(table: string): string[] | null {
    const base = BASE_COLUMNS[table];
    if (!base) return null;
    return this.migrated ? [...base, ...(NEW_COLUMNS[table] ?? [])] : base;
  }
  step(id: string): Row {
    return this.tables.tenant_setup_items.find((r) => r.id === id)!;
  }
}

function step(id: string, template: string | null, position: number): Row {
  return {
    id, client_id: T, template_item_id: template, title: `Step ${id}`, detail: null, link_page: null, section: "The basics", image_url: null,
    position, completed_at: null, completed_by_kind: null, completed_by_name: null, created_at: "2026-11-01T00:00:00Z",
    completed_via: null, completed_proposal_id: null,
  };
}

const UNKNOWN = (col: string) => ({ code: "42703", message: `column "${col}" does not exist` });

function chain(world: World, table: string, ops: any[][]): any {
  const next = (op: any[]) => chain(world, table, [...ops, op]);
  const q: any = {};
  for (const m of ["select", "insert", "update", "upsert", "eq", "in", "order", "limit", "maybeSingle", "single"]) q[m] = (...a: unknown[]) => next([m, ...a]);
  q.then = (ok: any, bad: any) => Promise.resolve().then(() => run(world, table, ops)).then(ok, bad);
  return q;
}

function run(world: World, table: string, ops: any[][]): { data: unknown; error: unknown } {
  const cols = world.columns(table);
  if (cols === null) throw new Error(`portal-setup is not expected to touch ${table}`);
  const rows = world.tables[table];
  const filters = ops.filter((o) => o[0] === "eq" || o[0] === "in");
  const match = (r: Row) => filters.every((o) => (o[0] === "eq" ? r[o[1]] === o[2] : (o[2] as unknown[]).includes(r[o[1]])));
  const one = ops.some((o) => o[0] === "maybeSingle" || o[0] === "single");
  const sel = ops.find((o) => o[0] === "select");
  const named = sel && typeof sel[1] === "string" ? String(sel[1]).split(",").map((c) => c.trim()).filter(Boolean) : null;
  if (table !== "app_errors" && named) for (const c of named) if (!cols.includes(c)) return { data: null, error: UNKNOWN(c) };
  const shape = (r: Row) => Object.fromEntries((named ?? cols).filter((c) => c in r).map((c) => [c, r[c]]));

  const ins = ops.find((o) => o[0] === "insert");
  if (ins) { world.writes.push(`${table}:insert`); rows.push({ ...ins[1] }); return { data: null, error: null }; }
  const upd = ops.find((o) => o[0] === "update");
  if (upd) {
    const patch = upd[1] as Row;
    for (const c of Object.keys(patch)) if (!cols.includes(c)) return { data: null, error: UNKNOWN(c) };
    // The column's CHECK (null or 'jack').
    if ("completed_via" in patch && patch.completed_via !== null && patch.completed_via !== "jack") return { data: null, error: { code: "23514", message: "check" } };
    world.writes.push(`${table}:update`);
    const hit = rows.filter(match);
    for (const r of hit) Object.assign(r, patch);
    const out = hit.map(shape);
    return { data: one ? out[0] ?? null : out, error: null };
  }
  const out = rows.filter(match).map(shape);
  return { data: one ? out[0] ?? null : out, error: null };
}

async function call(world: World, body: Record<string, unknown>, who = OWNER) {
  const saved = Object.fromEntries(Object.keys(ENV).map((k) => [k, Deno.env.get(k)]));
  for (const [k, v] of Object.entries(ENV)) Deno.env.set(k, v);
  const realFetch = globalThis.fetch;
  globalThis.fetch = ((input: string | URL | Request) => Promise.reject(new Error(`unexpected fetch: ${String(input)}`))) as typeof fetch;
  stubAuth.user = { id: who, email: who === OWNER ? "mike@example.test" : "rita@example.test" };
  stubAuth.error = null;
  stubDb.from = (table: string) => chain(world, table, []);
  try {
    const res = await HANDLER(new Request(`${PROJECT}/functions/v1/portal-setup`, {
      method: "POST",
      headers: { authorization: "Bearer harness", "content-type": "application/json", "user-agent": "harness/1.0" },
      body: JSON.stringify(body),
    }));
    return { status: res.status, body: await res.json() };
  } finally {
    globalThis.fetch = realFetch;
    stubDb.from = null;
    stubAuth.user = null;
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) Deno.env.delete(k);
      else Deno.env.set(k, v);
    }
  }
}

/** A Jack card that ticks s-business, as setup.ts writes it, mid-save. */
function card(world: World, over: Row = {}) {
  world.tables.jack_proposals.push({
    id: CARD, client_id: T, user_id: OWNER, kind: "setup_company", status: "applying", approved_by: OWNER,
    payload: { save: { businessName: "Ridgeline" }, ticks: [{ id: "s-business", title: "Add your business details and logo" }] },
    ...over,
  });
}

// ── list ──────────────────────────────────────────────────────────────────────────────────────

Deno.test("list: each step says its Jack key and whether Jack ticked it; hidden still never leaves, locked still flagged", async () => {
  const w = new World();
  Object.assign(w.step("s-nokey"), { completed_at: "2026-11-02T00:00:00Z", completed_by_kind: "client", completed_by_name: "Mike Owner", completed_via: "jack", completed_proposal_id: CARD });
  const r = await call(w, { action: "list" });
  assertEquals(r.status, 200);
  const items = r.body.items as Row[];
  assertEquals(items.map((i) => i.id), ["s-business", "s-qbo", "s-nokey", "s-bespoke"], "the hidden email step is not sent");
  assertEquals(items.map((i) => i.key), ["business", "quickbooks", null, null]);
  assertEquals(items.map((i) => i.completed_via), [null, null, "jack", null]);
  assertEquals(items.find((i) => i.id === "s-qbo")!.locked, true);
  // The plumbing stays in.
  assert(items.every((i) => !("template_item_id" in i) && !("completed_proposal_id" in i)), "template id and card id stay on the server");
  assertEquals(r.body.counts, { total: 3, done: 1, open: 2 });
  assertEquals(r.body.canEdit, true);
});

Deno.test("list: a rep can read it, and is told a tick won't be accepted", async () => {
  const r = await call(new World(), { action: "list" }, REP);
  assertEquals(r.status, 200);
  assertEquals(r.body.canEdit, false);
});

Deno.test("list before the migration: it still loads, with no keys and no marker", async () => {
  const w = new World();
  w.migrated = false;
  const r = await call(w, { action: "list" });
  assertEquals(r.status, 200);
  const items = r.body.items as Row[];
  assertEquals(items.map((i) => i.id), ["s-business", "s-qbo", "s-nokey", "s-bespoke"], "the hidden step is still hidden on the fallback read");
  assertEquals(items.map((i) => i.key), [null, null, null, null]);
  assertEquals(items.map((i) => i.completed_via), [null, null, null, null]);
});

// ── toggle with viaProposal ───────────────────────────────────────────────────────────────────

Deno.test("Jack's tick: stamped 'with Jack' for this builder's card, mid-save, approved by the caller, listing the step", async () => {
  const w = new World();
  card(w);
  const r = await call(w, { action: "toggle", id: "s-business", done: true, viaProposal: CARD });
  assertEquals(r.status, 200);
  const s = w.step("s-business");
  assertEquals([s.completed_via, s.completed_proposal_id, s.completed_by_kind, s.completed_by_name], ["jack", CARD, "client", "Mike Owner"]);
  assert(s.completed_at, "ticked");
});

Deno.test("Jack's tick is refused for any other card: another builder's, not mid-save, another approver, another step, unknown, wrong kind", async () => {
  const cases: [string, Row | null, string][] = [
    ["another builder's card", { client_id: OTHER }, "s-business"],
    ["a card already finished", { status: "applied" }, "s-business"],
    ["a card still waiting", { status: "ready" }, "s-business"],
    ["approved by someone else", { approved_by: REP }, "s-business"],
    ["a card that ticks another step", { payload: { ticks: [{ id: "s-nokey" }] } }, "s-business"],
    ["a card with no ticks", { payload: {} }, "s-business"],
    ["a price card", { kind: "size_rule" }, "s-business"],
    ["no card at all", null, "s-business"],
  ];
  for (const [why, over, id] of cases) {
    const w = new World();
    if (over) card(w, over);
    const r = await call(w, { action: "toggle", id, done: true, viaProposal: CARD });
    assertEquals([r.status, r.body.error], [403, "That approval doesn't match this step."], why);
    assertEquals(w.step(id).completed_at, null, `${why}: nothing ticked`);
    assertEquals(w.writes.filter((x) => x.startsWith("tenant_setup_items")), [], `${why}: nothing written`);
  }
});

Deno.test("Jack's tick: a malformed card id is refused before any read", async () => {
  const w = new World();
  const r = await call(w, { action: "toggle", id: "s-business", done: true, viaProposal: "not-a-uuid" });
  assertEquals(r.status, 400);
});

Deno.test("Jack's tick never writes over a person's tick", async () => {
  const w = new World();
  card(w);
  Object.assign(w.step("s-business"), { completed_at: "2026-11-02T00:00:00Z", completed_by_kind: "client", completed_by_name: "Rita Rep" });
  const r = await call(w, { action: "toggle", id: "s-business", done: true, viaProposal: CARD });
  assertEquals([r.status, r.body.already], [200, true]);
  assertEquals([w.step("s-business").completed_by_name, w.step("s-business").completed_via], ["Rita Rep", null]);
  assertEquals(w.writes.filter((x) => x.startsWith("tenant_setup_items")), []);
});

Deno.test("Jack's tick still can't reach a hidden or locked step, or another builder's", async () => {
  for (const [id, status] of [["s-email", 404], ["s-qbo", 403], ["s-theirs", 404]] as const) {
    const w = new World();
    card(w, { payload: { ticks: [{ id }] } });
    const r = await call(w, { action: "toggle", id, done: true, viaProposal: CARD });
    assertEquals(r.status, status, id);
  }
});

Deno.test("a rep can't tick, with or without a card", async () => {
  const w = new World();
  card(w, { approved_by: REP });
  assertEquals((await call(w, { action: "toggle", id: "s-business", done: true, viaProposal: CARD }, REP)).status, 403);
  assertEquals((await call(w, { action: "toggle", id: "s-business", done: true }, REP)).status, 403);
  assertEquals(w.step("s-business").completed_at, null);
});

// ── Jack's Undo ───────────────────────────────────────────────────────────────────────────────

Deno.test("Jack's Undo clears its own tick, and leaves a person's tick ticked", async () => {
  const w = new World();
  Object.assign(w.step("s-business"), { completed_at: "2026-11-02T00:00:00Z", completed_by_kind: "client", completed_by_name: "Mike Owner", completed_via: "jack", completed_proposal_id: CARD });
  Object.assign(w.step("s-nokey"), { completed_at: "2026-11-02T00:00:00Z", completed_by_kind: "client", completed_by_name: "Rita Rep" });

  const mine = await call(w, { action: "toggle", id: "s-business", done: false, viaProposal: CARD });
  assertEquals(mine.status, 200);
  assertEquals([w.step("s-business").completed_at, w.step("s-business").completed_via, w.step("s-business").completed_proposal_id], [null, null, null]);

  const theirs = await call(w, { action: "toggle", id: "s-nokey", done: false, viaProposal: CARD });
  assertEquals([theirs.status, theirs.body.kept], [409, true]);
  assertEquals(w.step("s-nokey").completed_by_name, "Rita Rep");

  // A second Undo (a retry after a blip) finds it already clear and says fine.
  const again = await call(w, { action: "toggle", id: "s-business", done: false, viaProposal: CARD });
  assertEquals(again.status, 200);
});

Deno.test("a tick another card made is not this card's to take back", async () => {
  const w = new World();
  Object.assign(w.step("s-business"), { completed_at: "2026-11-02T00:00:00Z", completed_via: "jack", completed_proposal_id: "10000000-0000-4000-8000-000000000099" });
  const r = await call(w, { action: "toggle", id: "s-business", done: false, viaProposal: CARD });
  assertEquals(r.status, 409);
  assert(w.step("s-business").completed_at, "still ticked");
});

// ── A person's own press ──────────────────────────────────────────────────────────────────────

Deno.test("a person's own tick and untick work as before, and clear the 'with Jack' marker", async () => {
  const w = new World();
  Object.assign(w.step("s-business"), { completed_at: "2026-11-02T00:00:00Z", completed_via: "jack", completed_proposal_id: CARD });
  const off = await call(w, { action: "toggle", id: "s-business", done: false });
  assertEquals(off.status, 200);
  assertEquals([w.step("s-business").completed_at, w.step("s-business").completed_via], [null, null]);
  const on = await call(w, { action: "toggle", id: "s-business", done: true });
  assertEquals(on.status, 200);
  assertEquals([w.step("s-business").completed_by_name, w.step("s-business").completed_via, w.step("s-business").completed_proposal_id], ["Mike Owner", null, null]);
});

Deno.test("before the migration: a person's tick still works, and Jack's is refused instead of stamped as theirs", async () => {
  const w = new World();
  w.migrated = false;
  card(w);
  const jack = await call(w, { action: "toggle", id: "s-business", done: true, viaProposal: CARD });
  assertEquals(jack.status, 409);
  assertEquals(w.step("s-business").completed_at, null);
  const person = await call(w, { action: "toggle", id: "s-business", done: true });
  assertEquals(person.status, 200);
  assertEquals(w.step("s-business").completed_by_name, "Mike Owner");
  // The person's update named no column the old table lacks.
  assertEquals(w.tables.app_errors.length, 0);
});
