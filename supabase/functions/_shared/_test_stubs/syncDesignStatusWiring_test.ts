// sync-design-status, driven through the SHIPPED handler against a fake database and a fake CRM
// (2026-10-05, "sync-design-status 6.1 s on Pipeline").
//
// WHY THIS EXISTS. _shared/designStatusSync.test.ts proves the reads and rules give the old
// statuses. This proves the function around them is wired the way the speed fix needs, against
// the real request path (withErrorLog, Server-Timing, resolveTenant, the reads, the writes):
//
//   1. Server-Timing is on every POST: auth, db, then est / opp / writes with their page and row
//      counts, then total and region, so a slow Pipeline sync says "CRM or database?" by itself.
//   2. By default (SDS_STAGE_SEARCH unset) the opportunities are walked in full, exactly as before,
//      and Server-Timing says "full walk". With the switch on, a tenant with three mapped stages asks
//      the CRM for those three stages, in parallel, and never for the whole location. Either way
//      the estimate walk stops once the call's ids are in hand.
//   3. A call with nothing in the CRM to look at makes no CRM request at all.
//   4. A refused CRM read still only promotes (the cached status is a floor).
//   5. The orders snapshot is read beside the CRM reads, not after the status writes; order
//      totals keep their manual-total guard (`.or(...)` in the UPDATE) and skip unchanged rows.
//   6. Status writes run a few at a time (never more than four at once); the inventory claim
//      stays one at a time.
//   7. With the switch on, a downgrade that rests on an opportunity missing from every stage list
//      is confirmed with the full walk before it is written, so a stage filter that wrongly answers
//      empty cannot take a status down.
//   8. The warm ping and the preflight are untouched.
//
// HOW. The aiDraftStreamWiring_test idiom: Deno.serve is stubbed while sync-design-status/index.ts
// is imported. The import map swaps supabase-js for supabase_stub.ts; its stubDb routes every
// table into the fake below. fetch is the fake CRM (ghlFake.ts) and nothing else, and no
// --allow-net is granted, so nothing leaves the box.
//
// ⚠️ THE IMPORT SPECIFIER IS COMPUTED ON PURPOSE (see aiDraftStreamWiring_test): a literal one would
// type-check the function against the stub's partial client type.
//
// Tenants, codes and CRM ids are made up. The repo is public.

// deno-lint-ignore-file no-explicit-any
import { assert, assertEquals } from "jsr:@std/assert";
import { stubAuth, stubDb } from "./supabase_stub.ts";
import { type FakeEstimate, type FakeOpportunity, ghlFake, type GhlWorld } from "./ghlFake.ts";

// ─── The real handler ──────────────────────────────────────────────────────────────────────────
const realServe = Deno.serve;
let handler: ((req: Request) => Promise<Response>) | null = null;
(Deno as any).serve = (h: (req: Request) => Promise<Response>) => {
  handler = h;
  return { finished: Promise.resolve() };
};
await import(new URL("../../sync-design-status/index.ts", import.meta.url).href);
(Deno as any).serve = realServe;
if (!handler) throw new Error("sync-design-status did not hand Deno.serve a handler");
const HANDLER = handler as (req: Request) => Promise<Response>;

// ─── The world one request runs in ─────────────────────────────────────────────────────────────
const T = "acme-sheds";
const ACC = "stage-acc", INV = "stage-inv", DEL = "stage-del";
const CREDS = {
  ghl_location_id: "loc-acme", ghl_api_key: "harness-key",
  ghl_stage_accepted_id: ACC, ghl_stage_invoiced_id: INV, ghl_stage_delivered_id: DEL,
};
const ENV: Record<string, string> = {
  SUPABASE_URL: "https://stub.supabase.co",
  SUPABASE_ANON_KEY: "stub-anon",
  SUPABASE_SERVICE_ROLE_KEY: "stub-service",
  SB_REGION: "us-east-1",
};

type Db = {
  designs: Record<string, any>[];
  creds?: Record<string, unknown> | null;
  orders?: Record<string, any>[];
  dbLatencyMs?: number;
};
type Trace = {
  events: string[];
  designWrites: { short_code: string; status: string }[];
  orderWrites: { id: string; cents: number; or: string }[];
  claims: string[];
  peakDesignWrites: number;
  rows: Record<string, unknown>[]; // app_errors
};

function chain(db: Db, trace: Trace, table: string, ops: any[][], live: { designWrites: number }): any {
  const next = (op: any[]) => chain(db, trace, table, [...ops, op], live);
  const q: any = {};
  for (const m of ["select", "insert", "update", "delete", "upsert", "eq", "neq", "is", "in", "or", "limit", "order", "single", "maybeSingle"]) {
    q[m] = (...a: unknown[]) => next([m, ...a]);
  }
  const arg = (op: string) => (ops.find((o) => o[0] === op) ?? []).slice(1);
  const eqv = (col: string) => ops.find((o) => o[0] === "eq" && o[1] === col)?.[2];
  q.then = (ok: any, bad: any) => {
    if (table === "app_errors") {
      trace.rows.push(arg("insert")[0]);
      return Promise.resolve({ error: null }).then(ok, bad);
    }
    const verb = ops.find((o) => ["select", "insert", "update", "delete", "upsert"].includes(o[0]))?.[0] ?? "?";
    trace.events.push(`db:${table}:${verb}`);
    const answer = async () => {
      const writing = table === "designs" && verb === "update";
      if (writing) { live.designWrites++; trace.peakDesignWrites = Math.max(trace.peakDesignWrites, live.designWrites); }
      try {
        if (db.dbLatencyMs) await new Promise((r) => setTimeout(r, db.dbLatencyMs));
        if (table === "client_users") return { data: [{ client_id: T, role: "owner", title: null, access: null }], error: null };
        if (table === "client_settings") return { data: db.creds === undefined ? CREDS : db.creds, error: null };
        if (table === "designs" && verb === "select") {
          assertEquals(eqv("client_id"), T, "designs are read for the resolved tenant only");
          const codes = new Set(arg("in")[1] as string[]);
          return { data: db.designs.filter((d) => codes.has(d.short_code)), error: null };
        }
        if (writing) {
          assertEquals(eqv("client_id"), T);
          trace.designWrites.push({ short_code: eqv("short_code"), status: arg("update")[0].status });
          return { data: null, error: null };
        }
        if (table === "orders" && verb === "select") {
          const codes = new Set(arg("in")[1] as string[]);
          return { data: (db.orders ?? []).filter((o) => codes.has(o.short_code)), error: null };
        }
        if (table === "orders" && verb === "update") {
          trace.orderWrites.push({ id: eqv("id"), cents: arg("update")[0].total_cents, or: String(arg("or")[0]) });
          return { data: null, error: null };
        }
        if (table === "inventory_units" && verb === "update") {
          trace.claims.push(String(eqv("id")));
          return { data: { id: eqv("id"), serial: 7 }, error: null };
        }
        throw new Error(`the fake database has no answer for ${table} ${JSON.stringify(ops)}`);
      } finally {
        if (writing) live.designWrites--;
      }
    };
    return answer().then(ok, bad);
  };
  return q;
}

// The per-stage opportunity search is a secret, off unless it is "1" (sync-design-status/index.ts).
const STAGE_SEARCH = { SDS_STAGE_SEARCH: "1" };

async function drive(
  body: Record<string, unknown>, db: Db, world: GhlWorld,
  opts: { method?: string; query?: string; env?: Record<string, string> } = {},
) {
  const trace: Trace = { events: [], designWrites: [], orderWrites: [], claims: [], peakDesignWrites: 0, rows: [] };
  const live = { designWrites: 0 };
  // SDS_STAGE_SEARCH is always saved and cleared, so a test without the switch runs the default
  // even when the shell running the suite happens to have it set.
  const env: Record<string, string | undefined> = { SDS_STAGE_SEARCH: undefined, ...ENV, ...opts.env };
  const savedEnv = Object.fromEntries(Object.keys(env).map((k) => [k, Deno.env.get(k)]));
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) Deno.env.delete(k);
    else Deno.env.set(k, v);
  }
  const realFetch = globalThis.fetch;
  const crm = ghlFake(world);
  stubAuth.user = { id: "u1", email: "owner@example.test" };
  stubAuth.error = null;
  stubDb.from = (table: string) => chain(db, trace, table, [], live);
  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
    trace.events.push("crm");
    return crm.fetch(input, init);
  }) as typeof fetch;
  const warn = console.warn;
  console.warn = () => {};
  try {
    const method = opts.method ?? "POST";
    const res = await HANDLER(new Request(`https://stub.supabase.co/functions/v1/sync-design-status${opts.query ?? ""}`, {
      method,
      headers: { authorization: "Bearer harness", "content-type": "application/json", "user-agent": "harness/1.0" },
      body: method === "POST" ? JSON.stringify(body) : undefined,
    }));
    const text = await res.text();
    return { res, body: text && text !== "ok" ? JSON.parse(text) : text, trace, crm: crm.trace };
  } finally {
    console.warn = warn;
    globalThis.fetch = realFetch;
    stubDb.from = null;
    stubAuth.user = null;
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) Deno.env.delete(k);
      else Deno.env.set(k, v);
    }
  }
}

// ─── A large shared CRM location ───────────────────────────────────────────────────────────────
// 1,500 opportunities over four pipelines and 450 estimates, of which this tenant owns a handful.
function location(): { estimates: FakeEstimate[]; opportunities: FakeOpportunity[] } {
  const estimates: FakeEstimate[] = Array.from({ length: 450 }, (_, i) => ({ _id: `e${i}`, estimateStatus: "sent", total: 1000 + i }));
  const opportunities: FakeOpportunity[] = Array.from({ length: 1500 }, (_, i) => ({
    id: `o${String(i).padStart(4, "0")}`,
    pipelineId: ["pipe-sales", "pipe-service", "pipe-builds", "pipe-old"][i % 4],
    pipelineStageId: ["stage-new", "stage-quoted", "stage-lost"][i % 3],
  }));
  // This tenant's deals.
  estimates[3].estimateStatus = "accepted";
  estimates[120].estimateStatus = "paid";
  opportunities[10].pipelineStageId = ACC;
  opportunities[700].pipelineStageId = INV;
  opportunities[1400].pipelineStageId = DEL;
  return { estimates, opportunities };
}
const D = (code: string, over: Record<string, unknown> = {}) => ({
  short_code: code, status: "sent", ghl_estimate_id: null, ghl_opportunity_id: null, delivered_at: null,
  inventory_unit_id: null, contact: { name: "Pat Example" }, ss_quote_number: null, accepted_at: null, ...over,
});
const PIPELINE = [
  D("SS-AAA111", { ghl_estimate_id: "e3", ghl_opportunity_id: "o0001" }),                        // estimate accepted
  D("SS-AAA222", { ghl_estimate_id: "e120", ghl_opportunity_id: "o0002", inventory_unit_id: "unit-9" }), // paid → invoiced, claims its unit
  D("SS-AAA333", { ghl_estimate_id: "e7", ghl_opportunity_id: "o0010" }),                        // opp at the accepted stage
  D("SS-AAA444", { status: "accepted", ghl_estimate_id: "e8", ghl_opportunity_id: "o0700" }),    // opp at invoiced
  D("SS-AAA555", { status: "invoiced", ghl_estimate_id: "e9", ghl_opportunity_id: "o1400" }),    // opp at delivered
  D("SS-AAA666", { status: "invoiced", ghl_estimate_id: "e11" }),                               // estimate says sent: downgrade
  D("SS-BBB111", { status: "accepted", ss_quote_number: "SST-1001", ghl_opportunity_id: "o0700" }), // SS-only: fenced
  D("SS-BBB222", { status: "draft" }),
];
const CODES = PIPELINE.map((d) => d.short_code);

// ─── 1 + 2. A Pipeline load ─────────────────────────────────────────────────────────────────────
const PIPELINE_STATUSES = {
  "SS-AAA111": "accepted", "SS-AAA222": "invoiced", "SS-AAA333": "accepted", "SS-AAA444": "invoiced",
  "SS-AAA555": "delivered", "SS-AAA666": "sent", "SS-BBB111": "accepted", "SS-BBB222": "draft",
};

Deno.test("a Pipeline load, by default: one full opportunity walk, never a stage search, the same statuses, and Server-Timing says so", async () => {
  const { res, body, trace, crm } = await drive({ shortCodes: CODES }, { designs: PIPELINE }, { ...location(), latencyMs: 3 });
  assertEquals(res.status, 200, JSON.stringify(body));
  assertEquals(body.statuses, PIPELINE_STATUSES);
  assertEquals([body.synced, body.changed], [true, 6]);
  assertEquals(trace.claims, ["unit-9"]);

  const opp = crm.calls.filter((c) => c.startsWith("/opportunities/search"));
  assertEquals(opp.length, 15, "1,500 opportunities, 100 a page, walked once");
  assert(opp.every((c) => !c.includes("pipeline_stage_id=")), JSON.stringify(opp));
  assertEquals(crm.calls.filter((c) => c.startsWith("/invoices/estimate/list")).length, 2, "the estimate walk still stops early");

  const st = res.headers.get("Server-Timing") ?? "";
  assert(st.includes('opp;desc="15 pages, full walk"'), st);

  // A CRM whose stage filter answers EMPTY cannot hold back a promotion while the switch is off.
  const empty = await drive({ shortCodes: CODES }, { designs: PIPELINE }, { ...location(), emptyStageFilter: true });
  assertEquals(empty.body.statuses, PIPELINE_STATUSES);
});

Deno.test("a Pipeline load with SDS_STAGE_SEARCH=1: three stage searches in parallel, an early-stopping estimate walk, the right statuses, and Server-Timing", async () => {
  const { res, body, trace, crm } = await drive({ shortCodes: CODES }, { designs: PIPELINE }, { ...location(), latencyMs: 3 }, { env: STAGE_SEARCH });
  assertEquals(res.status, 200, JSON.stringify(body));
  assertEquals(body.statuses, PIPELINE_STATUSES);
  assertEquals([body.synced, body.changed], [true, 6]);
  assertEquals(trace.designWrites.map((w) => w.short_code).sort(), ["SS-AAA111", "SS-AAA222", "SS-AAA333", "SS-AAA444", "SS-AAA555", "SS-AAA666"]);
  assertEquals(trace.claims, ["unit-9"], "the paid estimate's lot building is claimed");

  const opp = crm.calls.filter((c) => c.startsWith("/opportunities/search"));
  assertEquals(opp.length, 3, JSON.stringify(opp));
  assert(opp.every((c) => c.includes("pipeline_stage_id=")), "never the whole location");
  assertEquals(crm.calls.filter((c) => c.startsWith("/invoices/estimate/list")).length, 2, "e120 is on page 2; pages 3-5 are never asked for");
  assert(crm.maxInFlight >= 3, `the reads overlap (peak ${crm.maxInFlight})`);

  const st = res.headers.get("Server-Timing") ?? "";
  assert(new RegExp(
    '^auth;desc="network";dur=\\d+, db;desc="\\d+ queries";dur=\\d+, est;desc="2 pages";dur=\\d+, ' +
      'opp;desc="3 pages, by stage";dur=\\d+, writes;desc="7 rows";dur=\\d+, total;dur=\\d+, region;desc="us-east-1"$',
  ).test(st), st);
  assertEquals(res.headers.get("Access-Control-Expose-Headers"), "Server-Timing");
  assertEquals(trace.rows, [], "nothing filed");
});

// ─── 3. Nothing to look at ──────────────────────────────────────────────────────────────────────
Deno.test("no estimate or opportunity ids in the call: no CRM request at all, and no orders read", async () => {
  const designs = [D("SS-CCC111", { status: "accepted", ss_quote_number: "SST-2001" }), D("SS-CCC222", { status: "draft" }), D("SS-CCC333")];
  const { res, body, trace, crm } = await drive({ shortCodes: designs.map((d) => d.short_code) }, { designs }, location());
  assertEquals(res.status, 200);
  assertEquals(body.statuses, { "SS-CCC111": "accepted", "SS-CCC222": "draft", "SS-CCC333": "sent" });
  assertEquals(crm.calls, []);
  assert(!trace.events.includes("db:orders:select"), "no totals to compare, so no orders read");
  const st = res.headers.get("Server-Timing") ?? "";
  assert(st.includes('est;desc="skipped";dur=0, opp;desc="skipped";dur=0, writes;desc="0 rows"'), st);
});

Deno.test("fenced opportunities only: the estimate list is read, the opportunity search is not", async () => {
  const designs = [
    D("SS-DDD111", { status: "accepted", ss_quote_number: "SST-3001", ghl_opportunity_id: "o0700" }),
    D("SS-DDD222", { status: "delivered", delivered_at: "2026-09-30T12:00:00Z", ghl_estimate_id: "e1", ghl_opportunity_id: "o1400" }),
  ];
  const { body, crm } = await drive({ shortCodes: designs.map((d) => d.short_code) }, { designs }, location());
  assertEquals(body.statuses, { "SS-DDD111": "accepted", "SS-DDD222": "delivered" });
  assertEquals(crm.calls.filter((c) => c.startsWith("/opportunities/")), []);
  assertEquals(crm.calls.filter((c) => c.startsWith("/invoices/estimate/list")).length, 1, "the delivered order's total still follows the CRM");
});

// ─── 4. A refused read ──────────────────────────────────────────────────────────────────────────
Deno.test("the CRM refuses the estimate list: promotions land, nothing is downgraded", async () => {
  const { res, body, trace } = await drive({ shortCodes: CODES }, { designs: PIPELINE }, { ...location(), failEstimatesAt: { offset: 0, status: 429 } });
  assertEquals(res.status, 200);
  assertEquals(body.statuses["SS-AAA666"], "invoiced", "kept: the estimate list said nothing");
  assertEquals(body.statuses["SS-AAA555"], "delivered", "promoted from its opportunity");
  assert(!trace.designWrites.some((w) => w.short_code === "SS-AAA666"), "no downgrade written");
  assert((res.headers.get("Server-Timing") ?? "").includes('est;desc="1 pages"'));
});

// ─── 5. Order totals ────────────────────────────────────────────────────────────────────────────
Deno.test("order totals: read beside the CRM reads, a changed total written with the manual guard, manual and unchanged rows left alone", async () => {
  const orders = [
    { id: "ord-1", short_code: "SS-AAA111", total_source: "ghl", total_cents: 99 },        // e3 total 1003 → 100300
    { id: "ord-2", short_code: "SS-AAA222", total_source: "manual", total_cents: 5 },      // owner-entered
    { id: "ord-3", short_code: "SS-AAA333", total_source: "ghl", total_cents: 100700 },    // e7 unchanged
    { id: "ord-4", short_code: "SS-AAA444", total_source: null, total_cents: null },       // e8 first total
  ];
  const { trace } = await drive({ shortCodes: CODES }, { designs: PIPELINE, orders, dbLatencyMs: 1 }, { ...location(), latencyMs: 3 });
  assertEquals(trace.orderWrites, [
    { id: "ord-1", cents: 100300, or: "total_source.is.null,total_source.neq.manual" },
    { id: "ord-4", cents: 100800, or: "total_source.is.null,total_source.neq.manual" },
  ]);
  const ordersRead = trace.events.indexOf("db:orders:select");
  assert(ordersRead > 0 && ordersRead < trace.events.indexOf("db:designs:update"), `orders are read before the writes: ${trace.events.join(" ")}`);
});

// ─── 6. Writes ──────────────────────────────────────────────────────────────────────────────────
Deno.test("a burst of status changes is written four at a time, not one after another", async () => {
  const designs = Array.from({ length: 12 }, (_, i) => D(`SS-EEE${String(i).padStart(3, "0")}`, { status: "invoiced", ghl_estimate_id: `e${i + 20}` }));
  const { body, trace } = await drive({ shortCodes: designs.map((d) => d.short_code) }, { designs, dbLatencyMs: 4 }, location());
  assertEquals(body.changed, 12);
  assertEquals(trace.designWrites.length, 12);
  assertEquals(trace.peakDesignWrites, 4);
});

// ─── 7. A downgrade that rests on absence ──────────────────────────────────────────────────────
Deno.test("SDS_STAGE_SEARCH=1: a downgrade that rests on an opportunity missing from the stage lists is confirmed with the full walk first", async () => {
  // o0005 sits at an unmapped stage: a real move backwards. Written, but only after the full walk.
  const moved = [D("SS-FFF111", { status: "invoiced", ghl_estimate_id: "e11", ghl_opportunity_id: "o0005" })];
  const a = await drive({ shortCodes: ["SS-FFF111"] }, { designs: moved }, location(), { env: STAGE_SEARCH });
  assertEquals(a.body.statuses, { "SS-FFF111": "sent" });
  assertEquals(a.trace.designWrites, [{ short_code: "SS-FFF111", status: "sent" }]);
  assert(a.crm.calls.some((c) => c.startsWith("/opportunities/search") && !c.includes("pipeline_stage_id")), "the full walk confirmed it");
  assert((a.res.headers.get("Server-Timing") ?? "").includes('opp;desc="18 pages, full walk"'), a.res.headers.get("Server-Timing") ?? "");

  // A CRM whose stage filter answers EMPTY: o0700 really is at the invoiced stage, so nothing moves.
  const held = [D("SS-FFF222", { status: "invoiced", ghl_estimate_id: "e11", ghl_opportunity_id: "o0700" })];
  const b = await drive({ shortCodes: ["SS-FFF222"] }, { designs: held }, { ...location(), emptyStageFilter: true }, { env: STAGE_SEARCH });
  assertEquals(b.body.statuses, { "SS-FFF222": "invoiced" });
  assertEquals(b.trace.designWrites, []);
});

// ─── 8. Untouched paths ─────────────────────────────────────────────────────────────────────────
Deno.test("warm ping, preflight and an unconfigured tenant behave as before", async () => {
  const warm = await drive({}, { designs: [] }, location(), { query: "?warm=1" });
  assertEquals([warm.res.status, warm.body], [200, { ok: true }]);
  assertEquals(warm.trace.events, [], "the warm ping touches nothing");

  const pre = await drive({}, { designs: [] }, location(), { method: "OPTIONS" });
  assertEquals(pre.res.status, 200);
  assertEquals(pre.res.headers.get("Server-Timing"), null);
  assertEquals(pre.res.headers.get("Access-Control-Max-Age"), "86400");

  const bare = await drive({ shortCodes: CODES }, { designs: PIPELINE, creds: { ghl_location_id: null, ghl_api_key: null } }, location());
  assertEquals([bare.body.synced, bare.body.reason], [false, "GHL not configured"]);
  assertEquals(bare.crm.calls, []);
  assert(/^auth;desc="network";dur=\d+, db;desc="\d+ queries";dur=\d+, total;dur=\d+, region;desc="us-east-1"$/.test(bare.res.headers.get("Server-Timing") ?? ""));
});
