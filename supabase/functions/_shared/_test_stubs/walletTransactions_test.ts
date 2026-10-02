// The wallet's Transactions view, driven through the SHIPPED portal-billing handler.
//
// WHY THIS EXISTS. `wallet_transactions` is the first tenant-facing read of the whole wallet
// ledger, and that table carries OUR cost on the same row as THEIR charge (cost_cents,
// cost_micros, usage). _shared/walletLedger.test.ts pins the source; this drives a request
// through withErrorLog, resolveTenant and the branch exactly as it runs live, and checks what
// actually goes to the database and back to the browser:
//
//   1. Every wallet_transactions select names LEDGER_COLUMNS (or the pre-259 fallback) and
//      never a cost column, `usage` or `*` — on a page, on the CSV walk, and in `status`.
//   2. Who may ask is who sees the wallet card: an owner, an operator with can_bill. A builder
//      without Billing and an operator without can_bill are refused before any ledger read.
//   3. The read is scoped to the caller's tenant and to posted + held lines, newest id first,
//      with the chip, the date range and the cursor applied as PostgREST filters.
//   4. Paging hands back a cursor only when there is more; the CSV export walks every page up
//      to 10,000 lines and says when it stopped short.
//   5. A database migration 259 has not reached (no exact columns) costs the four-decimal
//      amounts, not the view, and the meter list still renders.
//   6. Calls and texts on the wallet card read "Billed per call minute" / "Billed per text",
//      never "No charge".
//
// HOW. foundingAnnualOnly_test's idiom: Deno.serve is stubbed while portal-billing/index.ts is
// imported, and the import map swaps supabase-js for supabase_stub.ts, whose stubDb hook routes
// every table read into the fake below. No --allow-net: nothing here can reach a real database.
//
// ⚠️ THE IMPORT SPECIFIER IS COMPUTED ON PURPOSE, as in foundingAnnualOnly_test: a literal one
// puts portal-billing in this file's type-checked graph against the stub's partial client type.
//
// Tenants, users and numbers here are made up. The repo is public: no real client id belongs in
// a fixture.

// deno-lint-ignore-file no-explicit-any
import { assert, assertEquals } from "jsr:@std/assert";
import { stubAuth, stubDb } from "./supabase_stub.ts";
import {
  FORBIDDEN_LEDGER_COLUMNS, LEDGER_COLUMNS, LEDGER_COLUMNS_PRE_259, LEDGER_CSV_MAX_ROWS,
} from "../walletLedger.ts";

// ─── The real handler ──────────────────────────────────────────────────────────────────────────
const realServe = Deno.serve;
let handler: ((req: Request) => Promise<Response>) | null = null;
(Deno as any).serve = (h: (req: Request) => Promise<Response>) => {
  handler = h;
  return { finished: Promise.resolve() };
};
try {
  await import(new URL("../../portal-billing/index.ts", import.meta.url).href);
} finally {
  (Deno as any).serve = realServe;
}
if (!handler) throw new Error("portal-billing did not hand Deno.serve a handler");
const HANDLER = handler as (req: Request) => Promise<Response>;

// ─── The world one request runs in ─────────────────────────────────────────────────────────────
type World = {
  tenant?: string;
  role?: "owner" | "user";            // the builder's client_users role
  operator?: { can_bill: boolean };   // a platform operator in view-as
  ledger?: Record<string, unknown>[]; // wallet_transactions rows, any order
  pre259?: boolean;                   // the database has not had migration 259
  meters?: Record<string, unknown>[]; // usage_prices rows
};
type Trace = { db: any[][]; ledgerReads: any[][]; errors: Record<string, unknown>[] };

const USER_ID = "00000000-0000-4000-8000-00000000f001";
const OPERATOR_ID = "00000000-0000-4000-8000-00000000f0f0";
const EXACT = ["amount_exact_micros", "balance_after_exact_micros"];

const argOf = (ops: any[][], op: string) => (ops.find((o) => o[0] === op) ?? [])[1];
const allOf = (ops: any[][], op: string) => ops.filter((o) => o[0] === op);
const colsOf = (sel: unknown) => String(sel ?? "").split(",").map((c) => c.trim()).filter(Boolean);

/** Apply the recorded PostgREST filters to the fake ledger, the way the database would. */
function runLedger(world: World, ops: any[][]): Record<string, unknown>[] {
  const tenant = world.tenant ?? "harness-builder";
  let rows = (world.ledger ?? []).filter((r) => r.client_id === tenant);
  for (const o of ops) {
    const [op, col, a, b] = o;
    if (op === "eq") rows = rows.filter((r) => r[col] === a);
    if (op === "in") rows = rows.filter((r) => (a as unknown[]).includes(r[col]));
    if (op === "gte") rows = rows.filter((r) => String(r[col]) >= String(a));
    if (op === "lt") rows = rows.filter((r) => (col === "id" ? Number(r[col]) < Number(a) : String(r[col]) < String(a)));
    if (op === "not") {
      assertEquals(a, "in", "only not.in is expected");
      const list = String(b).replace(/^\(|\)$/g, "").split(",");
      rows = rows.filter((r) => r[col] != null && !list.includes(String(r[col])));
    }
    if (op === "or") {
      // The only or() the branch builds: "meter_kind.is.null,meter_kind.not.in.(a,b,…)".
      const m = String(col).match(/^meter_kind\.is\.null,meter_kind\.not\.in\.\((.*)\)$/);
      assert(m, `unexpected or() expression ${col}`);
      const list = m![1].split(",");
      rows = rows.filter((r) => r.meter_kind == null || !list.includes(String(r.meter_kind)));
    }
  }
  // The Transactions view orders by id; the card's ten-line list in `status` by created_at.
  const order = argOf(ops, "order");
  if (order) {
    assert(order === "id" || order === "created_at", `unexpected order column ${order}`);
    assertEquals((allOf(ops, "order")[0][2] ?? {}).ascending, false, "newest first");
    rows = [...rows].sort((x, y) => (order === "id" ? Number(y.id) - Number(x.id) : String(y.created_at).localeCompare(String(x.created_at))));
  }
  const limit = argOf(ops, "limit");
  // PostgREST's own row cap (db-max-rows, 1000 on this project) applies whatever the limit says.
  rows = rows.slice(0, Math.min(limit ?? 1000, 1000));
  const cols = colsOf(argOf(ops, "select"));
  return rows.map((r) => Object.fromEntries(cols.map((c) => [c, r[c] ?? null])));
}

function answer(world: World, trace: Trace, table: string, ops: any[][]): any {
  const tenant = world.tenant ?? "harness-builder";
  const one = (row: unknown) => ({ data: row ?? null, error: null });
  switch (table) {
    case "client_users":
      return { data: world.operator ? [] : [{ client_id: tenant, role: world.role ?? "owner", title: null, access: null }], error: null };
    case "app_operators":
      return one(world.operator
        ? { user_id: OPERATOR_ID, email: "operator@example.test", can_write: true, can_bill: world.operator.can_bill, support_only: false }
        : null);
    case "client_configs":
      return one({ client_id: tenant });
    case "admin_audit":
      return { data: null, error: null };
    case "app_errors":
      trace.errors.push(argOf(ops, "insert"));
      return { data: null, error: null };
    case "wallet_transactions": {
      trace.ledgerReads.push(ops);
      const sel = colsOf(argOf(ops, "select"));
      if (world.pre259 && sel.some((c) => EXACT.includes(c))) {
        return { data: null, error: { code: "42703", message: "column wallet_transactions.amount_exact_micros does not exist" } };
      }
      return { data: runLedger(world, ops), error: null };
    }
    // `status` only, from here down.
    case "billing_plans":
    case "billing_subscriptions":
    case "client_feature_grants":
      return { data: [], error: null };
    case "billing_customers":
      return one(null);
    case "client_settings":
      return one({ billing_exempt: false, internal_account: false, discount_percent: 0 });
    case "wallet_accounts":
      return one({ balance_cents: 2500, held_cents: 0, metered_exempt: false, auto_topup_enabled: false });
    case "usage_prices": {
      const sel = colsOf(argOf(ops, "select"));
      if (world.pre259 && sel.includes("pricing")) {
        return { data: null, error: { code: "42703", message: "column usage_prices.pricing does not exist" } };
      }
      return { data: (world.meters ?? []).map((m) => Object.fromEntries(sel.map((c) => [c, m[c] ?? null]))), error: null };
    }
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
    return Promise.resolve().then(() => answer(world, trace, table, ops)).then(ok, bad);
  };
  return q;
}

const ENV: Record<string, string> = {
  SUPABASE_URL: "https://stub.supabase.co",
  SUPABASE_ANON_KEY: "stub-anon",
  SUPABASE_SERVICE_ROLE_KEY: "stub-service",
};

async function drive(payload: Record<string, unknown>, world: World = {}) {
  const trace: Trace = { db: [], ledgerReads: [], errors: [] };
  const savedEnv = Object.fromEntries(Object.keys(ENV).map((k) => [k, Deno.env.get(k)]));
  for (const [k, v] of Object.entries(ENV)) Deno.env.set(k, v);
  const realFetch = globalThis.fetch;
  stubAuth.user = world.operator ? { id: OPERATOR_ID, email: "operator@example.test" } : { id: USER_ID, email: "owner@example.test" };
  stubAuth.error = null;
  stubDb.from = (table: string) => chain(world, trace, table, []);
  globalThis.fetch = ((input: string | URL | Request) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    return Promise.reject(new Error(`TEST FAILURE: unexpected fetch to ${url}`));
  }) as typeof fetch;
  try {
    const res = await HANDLER(new Request("https://stub.supabase.co/functions/v1/portal-billing", {
      method: "POST",
      headers: { "authorization": "Bearer harness", "content-type": "application/json", "user-agent": "harness/1.0" },
      body: JSON.stringify(world.operator ? { ...payload, targetClientId: world.tenant ?? "harness-builder" } : payload),
    }));
    const text = await res.text();
    let body: any = null;
    try { body = JSON.parse(text); } catch { body = text; }
    return { status: res.status, body, trace };
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

// ─── A ledger ──────────────────────────────────────────────────────────────────────────────────
// ids ascend with time, as an identity column does. Cost columns are POPULATED on every row so a
// select that named one would carry it to the response, where the checks below would see it.
// balance_after_cents is derived from the exact balance the way 259 relates them (cents × 10,000
// less a remainder under one cent) unless a row sets it, because toLedgerRow drops an exact
// balance a whole cent or more away from its cents (a captured 3D hold's stale value).
const T0 = Date.parse("2026-10-01T12:00:00.000Z");
function line(id: number, over: Record<string, unknown> = {}): Record<string, unknown> {
  const r: Record<string, unknown> = {
    id, client_id: "harness-builder", created_at: new Date(T0 + id * 60_000).toISOString(),
    kind: "debit", meter_kind: "voice_minute", state: "posted", memo: `Outbound call to (555) 010-${String(id).padStart(4, "0")} · 1 min`,
    amount_cents: 0, amount_exact_micros: -28_000, balance_after_exact_micros: 25_000_000 - id * 28_000,
    cost_cents: 1, cost_micros: 14_000, usage: { units: 1, unit: "minute", direction: "out" }, idempotency_key: `usage:call:${id}`,
    ...over,
  };
  if (!("balance_after_cents" in over)) r.balance_after_cents = Math.ceil(Number(r.balance_after_exact_micros) / 10_000) || 0;
  return r;
}
const MIXED = [
  line(1, { kind: "topup", meter_kind: null, memo: "Card top-up", amount_cents: 2500, amount_exact_micros: 25_000_000, balance_after_exact_micros: 25_000_000 }),
  line(2),
  line(3, { meter_kind: "voice_minute_in", memo: "Incoming call from (555) 010-0003 · 2 min", amount_exact_micros: -25_000 }),
  line(4, { meter_kind: "sms_segment", memo: "Text to (555) 010-0004 · 1 segment", amount_exact_micros: -16_600 }),
  line(5, { meter_kind: "sms_in", memo: "Text from (555) 010-0005 · 1 segment", amount_exact_micros: -12_000 }),
  line(6, { meter_kind: "video_3d_generation", memo: null, amount_cents: -2000, amount_exact_micros: -20_000_000 }),
  line(7, { meter_kind: "video_3d_generation", memo: null, state: "held", amount_cents: -2000, amount_exact_micros: -20_000_000 }),
  line(8, { kind: "grant", meter_kind: null, memo: "welcome", amount_cents: 1000, amount_exact_micros: 10_000_000 }),
  line(9, { meter_kind: "voice_minute", state: "released" }),
  line(10, { client_id: "another-builder" }),
];

function assertCleanLedgerReads(trace: Trace) {
  assert(trace.ledgerReads.length > 0, "no wallet_transactions read was made");
  for (const ops of trace.ledgerReads) {
    const sel = String(argOf(ops, "select"));
    const cols = colsOf(sel);
    for (const bad of [...FORBIDDEN_LEDGER_COLUMNS, "*"]) assert(!cols.includes(bad), `a ledger read selected ${bad}: "${sel}"`);
    assert(cols.every((c) => /^[a-z_]+$/.test(c)), `a ledger read has a non-bare column: "${sel}"`);
  }
}
// What a ledger row may carry to the browser, and nothing more. Every fake row has cost_cents,
// cost_micros, usage and an idempotency key populated, so a widened select or a spread of the raw
// row would show up here as an extra key.
const ROW_KEYS = [
  "amount_cents", "amount_exact_micros", "balance_after_cents", "balance_after_exact_micros", "category", "created_at",
  "description", "id", "kind", "pending", "precise",
];
function assertNoCostInBody(body: unknown) {
  const text = JSON.stringify(body);
  for (const bad of [...FORBIDDEN_LEDGER_COLUMNS, "idempotency_key", "client_id"]) {
    assert(!text.includes(`"${bad}"`), `the response carries ${bad}`);
  }
  const rows = (body as any)?.rows;
  if (Array.isArray(rows)) {
    for (const row of rows) assertEquals(Object.keys(row).sort(), ROW_KEYS, "a ledger row carries a key outside the allowed set");
  }
}

// ─── Tests ─────────────────────────────────────────────────────────────────────────────────────
Deno.test("an owner reads their own posted and held lines, newest first, with nothing of our cost", async () => {
  const r = await drive({ action: "wallet_transactions" }, { ledger: MIXED });
  assertEquals(r.status, 200, JSON.stringify(r.body));
  assertCleanLedgerReads(r.trace);
  assertNoCostInBody(r.body);
  assertEquals(r.trace.ledgerReads.length, 1, "one read for one page");
  const ops = r.trace.ledgerReads[0];
  assertEquals(argOf(ops, "select"), LEDGER_COLUMNS);
  assertEquals(allOf(ops, "eq").map((o) => o.slice(1)), [["client_id", "harness-builder"]]);
  assertEquals(allOf(ops, "in")[0].slice(1), ["state", ["posted", "held"]]);
  assertEquals(argOf(ops, "limit"), 51, "fifty a page, plus one to know whether there is more");
  assertEquals(r.body.rows.map((x: any) => x.id), [8, 7, 6, 5, 4, 3, 2, 1], "released and other tenants' lines are absent");
  assertEquals(r.body.next_cursor, null);
  const call = r.body.rows.find((x: any) => x.id === 2);
  assertEquals(call, {
    id: 2, created_at: "2026-10-01T12:02:00.000Z", description: "Outbound call to (555) 010-0002 · 1 min", kind: "debit",
    category: "calls", pending: false, amount_cents: 0, amount_exact_micros: -28_000, balance_after_cents: 2495,
    balance_after_exact_micros: 24_944_000, precise: true,
  });
  const hold = r.body.rows.find((x: any) => x.id === 7);
  assertEquals([hold.pending, hold.balance_after_cents, hold.description], [true, null, "3D generation from a video"]);
  // Answered ahead of entitlement: none of the plan, subscription, vault, settings or grant reads.
  const tables = new Set(r.trace.db.map((d) => d[0]));
  for (const t of ["billing_plans", "billing_subscriptions", "billing_customers", "client_settings", "client_feature_grants"]) {
    assert(!tables.has(t), `the ledger read also paid for ${t}`);
  }
  assertEquals(r.trace.errors, []);
});

Deno.test("each chip narrows to its lines, and the four chips add up to All", async () => {
  const want: Record<string, number[]> = { calls: [3, 2], texts: [5, 4], funds: [8, 1], other: [7, 6] };
  const seen: number[] = [];
  for (const [filter, ids] of Object.entries(want)) {
    const r = await drive({ action: "wallet_transactions", filter }, { ledger: MIXED });
    assertEquals(r.status, 200, JSON.stringify(r.body));
    assertCleanLedgerReads(r.trace);
    assertEquals(r.body.rows.map((x: any) => x.id), ids, `filter ${filter}`);
    assert(r.body.rows.every((x: any) => x.category === filter), `a ${filter} row is labelled another category`);
    seen.push(...ids);
  }
  assertEquals(seen.sort((a, b) => a - b), [1, 2, 3, 4, 5, 6, 7, 8], "the chips partition the ledger");
});

Deno.test("the date range is from-inclusive, to-exclusive, on created_at", async () => {
  const r = await drive({
    action: "wallet_transactions", from: "2026-10-01T12:03:00.000Z", to: "2026-10-01T12:06:00.000Z",
  }, { ledger: MIXED });
  assertEquals(r.status, 200, JSON.stringify(r.body));
  const ops = r.trace.ledgerReads[0];
  assertEquals(allOf(ops, "gte").map((o) => o.slice(1)), [["created_at", "2026-10-01T12:03:00.000Z"]]);
  assertEquals(allOf(ops, "lt").map((o) => o.slice(1)), [["created_at", "2026-10-01T12:06:00.000Z"]]);
  assertEquals(r.body.rows.map((x: any) => x.id), [5, 4, 3]);
});

Deno.test("paging: fifty lines, then a cursor that picks up exactly where the page ended", async () => {
  const ledger = Array.from({ length: 120 }, (_, i) => line(i + 1));
  const p1 = await drive({ action: "wallet_transactions" }, { ledger });
  assertEquals(p1.body.rows.length, 50);
  assertEquals([p1.body.rows[0].id, p1.body.rows[49].id, p1.body.next_cursor], [120, 71, "71"]);
  const p2 = await drive({ action: "wallet_transactions", cursor: p1.body.next_cursor }, { ledger });
  assertEquals(allOf(p2.trace.ledgerReads[0], "lt").map((o) => o.slice(1)), [["id", 71]]);
  assertEquals([p2.body.rows[0].id, p2.body.rows[49].id, p2.body.next_cursor], [70, 21, "21"]);
  const p3 = await drive({ action: "wallet_transactions", cursor: p2.body.next_cursor }, { ledger });
  assertEquals([p3.body.rows.length, p3.body.rows[19].id, p3.body.next_cursor], [20, 1, null], "the last page has no cursor");
  const small = await drive({ action: "wallet_transactions", limit: 500 }, { ledger });
  assertEquals(argOf(small.trace.ledgerReads[0], "limit"), 51, "a page size over 50 is capped");
});

Deno.test("CSV: walks every page, newest first, and stays clean on every read", async () => {
  const ledger = Array.from({ length: 2500 }, (_, i) => line(i + 1));
  const r = await drive({ action: "wallet_transactions", format: "csv", tz: "UTC", cursor: "40" }, { ledger });
  assertEquals(r.status, 200, JSON.stringify(r.body).slice(0, 300));
  assertCleanLedgerReads(r.trace);
  assertNoCostInBody(r.body);
  assertEquals([r.body.rows, r.body.truncated], [2500, false], "the cursor does not apply to an export");
  // 1000 + 1000 + 500 + the empty page that ends the walk.
  assertEquals(r.trace.ledgerReads.length, 4);
  assertEquals(r.trace.ledgerReads.map((ops) => allOf(ops, "lt").map((o) => o[2])[0] ?? null), [null, 1501, 501, 1]);
  const lines = r.body.csv.split("\r\n");
  assertEquals(lines[0], "Date,Description,Amount,Balance");
  assertEquals(lines[1], "2026-10-03 05:40,Outbound call to (555) 010-2500 · 1 min,-0.0280,-45.0000", "four places, and a balance below zero");
  assertEquals(lines.length, 2502, "header, 2500 lines, final CRLF");
});

Deno.test("CSV: stops at 10,000 lines and says so", async () => {
  const ledger = Array.from({ length: LEDGER_CSV_MAX_ROWS + 1 }, (_, i) => line(i + 1));
  const r = await drive({ action: "wallet_transactions", format: "csv" }, { ledger });
  assertEquals(r.status, 200);
  assertEquals([r.body.rows, r.body.truncated], [LEDGER_CSV_MAX_ROWS, true]);
  assertEquals(r.body.csv.split("\r\n").length, LEDGER_CSV_MAX_ROWS + 2);
  assertCleanLedgerReads(r.trace);
  const exactly = await drive({ action: "wallet_transactions", format: "csv" }, { ledger: ledger.slice(1) });
  assertEquals([exactly.body.rows, exactly.body.truncated], [LEDGER_CSV_MAX_ROWS, false], "exactly the cap is not truncated");
});

// wallet_hold fixes a 3D line's id when the video is sent; wallet_capture moves the balance
// minutes later by updating that row (128), and 259's exact-balance trigger only runs on insert.
// So a call charged in between has the higher id and the older balance. This pins what the view
// does about it today: id order (see the ⚠️ in portal-billing's ledger branch), and on the 3D
// line the balance capture wrote, in whole cents, never the stale hold-time exact value.
Deno.test("a 3D hold captured after a later call: id order, and the balance capture wrote", async () => {
  const ledger = [
    line(1, { kind: "topup", meter_kind: null, memo: "Card top-up", amount_cents: 1000, amount_exact_micros: 10_000_000, balance_after_exact_micros: 10_000_000 }),
    // Held against $10.00 at 12:02; captured at 12:04, after the call below took 2¢: $7.98.
    line(2, {
      meter_kind: "video_3d_generation", memo: null, amount_cents: -200, amount_exact_micros: -2_000_000,
      balance_after_cents: 798, balance_after_exact_micros: 10_000_000, posted_at: new Date(T0 + 4 * 60_000).toISOString(),
    }),
    line(3, { amount_cents: -2, balance_after_cents: 998, balance_after_exact_micros: 9_972_000 }),
    // $25.00 in on a balance still owing 8,000 micros: 32.9720, four places on a two-place amount.
    line(4, { kind: "topup", meter_kind: null, memo: "Card top-up", amount_cents: 2500, amount_exact_micros: 25_000_000, balance_after_cents: 3298, balance_after_exact_micros: 32_972_000 }),
  ];
  const r = await drive({ action: "wallet_transactions" }, { ledger });
  assertEquals(r.status, 200, JSON.stringify(r.body));
  assertCleanLedgerReads(r.trace);
  assertNoCostInBody(r.body);
  assertEquals(argOf(r.trace.ledgerReads[0], "order"), "id");
  assertEquals(r.body.rows.map((x: any) => x.id), [4, 3, 2, 1], "the 3D line keeps the place its hold took");
  const by = (id: number) => r.body.rows.find((x: any) => x.id === id);
  assertEquals([by(2).balance_after_cents, by(2).balance_after_exact_micros, by(2).precise], [798, null, false], "capture's cents, not the hold's exact value");
  assertEquals([by(3).balance_after_exact_micros, by(3).precise], [9_972_000, true]);
  assertEquals([by(4).balance_after_exact_micros, by(4).precise], [32_972_000, false], "the top-up keeps its exact balance");

  const csv = await drive({ action: "wallet_transactions", format: "csv", tz: "UTC" }, { ledger });
  assertEquals(csv.status, 200, JSON.stringify(csv.body));
  assertEquals(csv.body.csv.split("\r\n").slice(1, 5), [
    "2026-10-01 12:04,Added funds,25.0000,32.9720",
    "2026-10-01 12:03,Outbound call to (555) 010-0003 · 1 min,-0.0280,9.9720",
    "2026-10-01 12:02,3D generation from a video,-2.0000,7.98",
    "2026-10-01 12:01,Added funds,10.0000,10.0000",
  ]);
});

Deno.test("before migration 259: the view still loads, in whole cents", async () => {
  const r = await drive({ action: "wallet_transactions" }, { ledger: MIXED, pre259: true });
  assertEquals(r.status, 200, JSON.stringify(r.body));
  assertEquals(r.trace.ledgerReads.map((ops) => argOf(ops, "select")), [LEDGER_COLUMNS, LEDGER_COLUMNS_PRE_259]);
  assertCleanLedgerReads(r.trace);
  const call = r.body.rows.find((x: any) => x.id === 2);
  assertEquals([call.amount_exact_micros, call.balance_after_exact_micros, call.precise], [null, null, false]);
  const csv = await drive({ action: "wallet_transactions", format: "csv" }, { ledger: MIXED, pre259: true });
  assertEquals(csv.status, 200);
  assert(csv.body.csv.includes(",Added funds,25.00,25.00"), "two places without exact columns");
  assertEquals(csv.trace.ledgerReads.filter((ops) => argOf(ops, "select") === LEDGER_COLUMNS).length, 1, "the fallback sticks for the whole walk");
});

Deno.test("who may read it: an operator with can_bill yes; without it, or a builder without Billing, no", async () => {
  const op = await drive({ action: "wallet_transactions" }, { ledger: MIXED, operator: { can_bill: true } });
  assertEquals(op.status, 200, JSON.stringify(op.body));
  assertEquals(op.body.rows.length, 8);
  for (const world of [{ operator: { can_bill: false } }, { role: "user" as const }]) {
    const r = await drive({ action: "wallet_transactions" }, { ledger: MIXED, ...world });
    assertEquals(r.status, 403, `${JSON.stringify(world)}: ${JSON.stringify(r.body)}`);
    assertEquals(r.trace.ledgerReads, [], "the ledger was read before the refusal");
  }
});

Deno.test("a bad request is a 400 with a sentence, before any ledger read", async () => {
  for (const p of [{ filter: "everything" }, { cursor: "abc" }, { from: "soon" }, { format: "pdf" }]) {
    const r = await drive({ action: "wallet_transactions", ...p }, { ledger: MIXED });
    assertEquals(r.status, 400, JSON.stringify(p));
    assert(/^[A-Z].*\.$/.test(r.body.error), `not a sentence: ${r.body.error}`);
    assertEquals(r.trace.ledgerReads, []);
  }
});

const METERS = [
  { kind: "sms_registration", label: "Text messaging setup", unit_label: "one-time", price_cents: 4900, active: true, visible: true, pricing: "fixed" },
  { kind: "voice_minute", label: "Call minutes", unit_label: "minute", price_cents: 0, active: true, visible: true, pricing: "cost_plus" },
  { kind: "sms_segment", label: "Texts", unit_label: "segment", price_cents: 0, active: true, visible: true, pricing: "cost_plus" },
];

Deno.test("status: calls and texts on the wallet card are described, never priced at $0", async () => {
  const r = await drive({ action: "status" }, { meters: METERS, ledger: MIXED });
  assertEquals(r.status, 200, JSON.stringify(r.body));
  assertEquals(r.body.wallet.meters, [
    { kind: "sms_registration", label: "Text messaging setup", unitLabel: "one-time", priceCents: 4900 },
    { kind: "voice_minute", label: "Call minutes", unitLabel: "minute", priceCents: null, billedAs: "Billed per call minute" },
    { kind: "sms_segment", label: "Texts", unitLabel: "segment", priceCents: null, billedAs: "Billed per text" },
  ]);
  assertCleanLedgerReads(r.trace);
  // The ten-line list uses the same labels as the Transactions view.
  assertEquals(r.body.wallet.transactions.map((t: any) => t.label).slice(0, 2), ["Credit from CSM Synergy", "3D generation from a video"]);
  assertNoCostInBody(r.body.wallet);
});

Deno.test("status before migration 259: the meter list still renders, priced as before", async () => {
  const r = await drive({ action: "status" }, { meters: METERS, pre259: true });
  assertEquals(r.status, 200, JSON.stringify(r.body));
  const usageReads = r.trace.db.filter((d) => d[0] === "usage_prices");
  assertEquals(usageReads.length, 2, "one refused read with pricing, one without");
  assertEquals(r.body.wallet.meters.map((m: any) => [m.kind, m.priceCents, m.billedAs ?? null]),
    [["sms_registration", 4900, null], ["voice_minute", 0, null], ["sms_segment", 0, null]]);
});
