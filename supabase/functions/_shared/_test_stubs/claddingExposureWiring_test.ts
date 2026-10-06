// A builder's own lap course (style_cladding.exposure_in, migration 275), driven through the SHIPPED
// portal-settings handler.
//
// WHAT THIS PINS, against the real handler:
//
//   1. catalog reads exposure_in with the other cladding columns and says so (claddingCourses: true),
//      so the Cladding card can show its "Course (in)" box. On a database before 275 PostgREST
//      answers 42703 for that select: the cladding rows are read again without it, the card loads
//      with claddingCourses false (the box hides), and nothing is logged for support. Any OTHER
//      error on that read still fails the catalog, as before.
//   2. save_cladding writes exposure_in only when the row NAMES exposureIn: a size on the lap row,
//      blank → NULL; a row that does not name it (production's portal, until it is promoted) never
//      touches the size. A size on any other cladding, or outside 3..12 in, or not a number, is
//      refused with a sentence and that row is not written; the other rows still save.
//
// HOW. quoteCornerViewsWiring_test's idiom: Deno.serve is stubbed while portal-settings/index.ts is
// imported, so a request goes through withErrorLog, resolveTenant and the action's branch as it does
// live. The import map swaps supabase-js for supabase_stub.ts, whose stubDb routes every table call
// into the fake below. No --allow-net is granted, so nothing leaves the box.
//
// ⚠️ THE IMPORT SPECIFIER IS COMPUTED ON PURPOSE (see aiDraftStreamWiring_test): a literal one would
// type-check portal-settings against the stub's partial client type.
//
// Tenants are made up. The repo is public.

// deno-lint-ignore-file no-explicit-any
import { assert, assertEquals } from "jsr:@std/assert";
import { stubAuth, stubDb } from "./supabase_stub.ts";

// ─── The real handler ──────────────────────────────────────────────────────────────────────────
const realServe = Deno.serve;
let handler: ((req: Request) => Promise<Response>) | null = null;
(Deno as any).serve = (h: (req: Request) => Promise<Response>) => {
  handler = h;
  return { finished: Promise.resolve() };
};
await import(new URL("../../portal-settings/index.ts", import.meta.url).href);
(Deno as any).serve = realServe;
if (!handler) throw new Error("portal-settings did not hand Deno.serve a handler");
const HANDLER = handler as (req: Request) => Promise<Response>;

// ─── The world one request runs in ─────────────────────────────────────────────────────────────
const T = "acme-sheds";
const STYLE = "11111111-1111-4111-8111-111111111111";
const PROJECT = "https://stub.supabase.co";
const ENV: Record<string, string> = {
  SUPABASE_URL: PROJECT,
  SUPABASE_ANON_KEY: "stub-anon",
  SUPABASE_SERVICE_ROLE_KEY: "stub-service",
};
const ROWS = [
  { id: "r1", style_id: STYLE, cladding_id: "panel", label_override: null, rate: 0, basis: "sqft_option", taxable: true, internal_only: false, active: true, sort_order: 0, exposure_in: null },
  { id: "r2", style_id: STYLE, cladding_id: "lap", label_override: "Vinyl Siding", rate: 0, basis: "sqft_option", taxable: true, internal_only: false, active: true, sort_order: 1, exposure_in: 4.5 },
];

type World = {
  noColumn?: boolean;    // the database has no exposure_in (a deploy ahead of 275)
  claddingFails?: boolean;  // style_cladding's read fails for some other reason
};
type Trace = { claddingSelects: string[]; upserts: Record<string, unknown>[]; rows: Record<string, unknown>[] };

const MISSING = { code: "42703", message: "column style_cladding.exposure_in does not exist" };
const TIMEOUT = { code: "57014", message: "canceling statement due to statement timeout" };

function answer(world: World, trace: Trace, table: string, ops: any[][]) {
  const has = (op: string) => ops.some((o) => o[0] === op);
  const arg = (op: string) => (ops.find((o) => o[0] === op) ?? [])[1];
  const cols = String(arg("select") ?? "");
  if (table === "client_users") return { data: [{ client_id: T, role: "owner", title: null, access: null, user_id: "u1", prefs: null }], error: null };
  if (table === "admin_audit") return { data: null, error: null };
  if (table === "building_styles" && has("maybeSingle")) return { data: { id: STYLE }, error: null };
  if (table === "style_cladding") {
    if (has("upsert")) {
      const row = arg("upsert");
      trace.upserts.push(row);
      return { data: null, error: world.noColumn && "exposure_in" in row ? MISSING : null };
    }
    trace.claddingSelects.push(cols);
    if (world.claddingFails) return { data: null, error: TIMEOUT };
    if (/\bexposure_in\b/.test(cols)) return world.noColumn ? { data: null, error: MISSING } : { data: ROWS, error: null };
    return { data: ROWS.map(({ exposure_in: _e, ...r }) => r), error: null };
  }
  // Anything else answers empty rather than throwing: these tests are about one column, and a read
  // this file does not model must not be mistaken for one that failed.
  return { data: has("maybeSingle") || has("single") ? null : [], error: null };
}

function chain(world: World, trace: Trace, table: string, ops: any[][]): any {
  const next = (op: any[]) => chain(world, trace, table, [...ops, op]);
  const q: any = {};
  for (const m of ["select", "insert", "update", "delete", "upsert", "eq", "neq", "is", "in", "not", "gte", "lte", "gt", "lt", "or", "limit", "order", "range", "single", "maybeSingle"]) {
    q[m] = (...a: unknown[]) => next([m, ...a]);
  }
  q.then = (ok: any, bad: any) => {
    if (table === "app_errors") {
      trace.rows.push((ops.find((o) => o[0] === "insert") ?? [])[1]);
      return Promise.resolve({ error: null }).then(ok, bad);
    }
    return Promise.resolve().then(() => answer(world, trace, table, ops)).then(ok, bad);
  };
  return q;
}

async function drive(payload: Record<string, unknown>, world: World = {}) {
  const trace: Trace = { claddingSelects: [], upserts: [], rows: [] };
  const savedEnv = Object.fromEntries(Object.keys(ENV).map((k) => [k, Deno.env.get(k)]));
  for (const [k, v] of Object.entries(ENV)) Deno.env.set(k, v);
  const realFetch = globalThis.fetch;
  stubAuth.user = { id: "u1", email: "owner@example.test" };
  stubAuth.error = null;
  stubDb.from = (table: string) => chain(world, trace, table, []);
  globalThis.fetch = ((input: string | URL | Request) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    return Promise.reject(new Error(`unexpected fetch: ${url}`));
  }) as typeof fetch;
  try {
    const res = await HANDLER(new Request(`${PROJECT}/functions/v1/portal-settings`, {
      method: "POST",
      headers: { authorization: "Bearer harness", "content-type": "application/json", "user-agent": "harness/1.0" },
      body: JSON.stringify(payload),
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

// ─── 1. catalog ────────────────────────────────────────────────────────────────────────────────
Deno.test("catalog reads the lap course with the other cladding columns, once, and says the card can offer it", async () => {
  const { status, body, trace } = await drive({ action: "catalog" });
  assertEquals(status, 200, JSON.stringify(body));
  assertEquals(trace.claddingSelects.length, 1, "one read");
  assertEquals(trace.claddingSelects[0], "id, style_id, cladding_id, label_override, rate, basis, taxable, internal_only, active, sort_order, exposure_in");
  assertEquals(body.claddingCourses, true);
  assertEquals(body.cladding.find((r: any) => r.cladding_id === "lap").exposure_in, 4.5);
});

Deno.test("catalog on a database before 275: read again without it, the card loads and hides the box, nothing logged", async () => {
  const { status, body, trace } = await drive({ action: "catalog" }, { noColumn: true });
  assertEquals(status, 200, JSON.stringify(body));
  assertEquals(trace.claddingSelects.length, 2, "the read, then the read without the column");
  assertEquals(trace.claddingSelects[1], "id, style_id, cladding_id, label_override, rate, basis, taxable, internal_only, active, sort_order");
  assertEquals(body.claddingCourses, false);
  assertEquals(body.cladding.length, 2, "every cladding row still loads");
  assert(!("exposure_in" in body.cladding[1]));
  assertEquals(trace.rows.length, 0, "a column that is not there yet is not an error for support");
});

Deno.test("catalog: any other cladding read failure still fails the catalog, and is not retried", async () => {
  const { status, body, trace } = await drive({ action: "catalog" }, { claddingFails: true });
  assert(status >= 500, `${status}: ${JSON.stringify(body)}`);
  assertEquals(trace.claddingSelects.length, 1);
});

// ─── 2. save_cladding ──────────────────────────────────────────────────────────────────────────
const row = (claddingId: string, extra: Record<string, unknown> = {}) =>
  ({ claddingId, labelOverride: "", rate: "0", basis: "sqft_option", taxable: true, active: true, internalOnly: false, ...extra });
const save = (rows: unknown[], world: World = {}) => drive({ action: "save_cladding", styleId: STYLE, rows }, world);
const upsertFor = (trace: Trace, cid: string) => trace.upserts.find((u) => u.cladding_id === cid);

Deno.test("save: a size on the lap row is written; blank is NULL (the 3D's 6 in)", async () => {
  for (const [sent, stored] of [["4.5", 4.5], [4.5, 4.5], [" 5 ", 5], ["3", 3], ["12", 12], ["", null], [null, null]] as const) {
    const { status, body, trace } = await save([row("panel"), row("lap", { exposureIn: sent })]);
    assertEquals(status, 200, JSON.stringify(body));
    assertEquals(body.saved, 2, JSON.stringify(body));
    assertEquals(body.skipped, []);
    const lap = upsertFor(trace, "lap")!;
    assert("exposure_in" in lap, `${JSON.stringify(sent)}: the lap row names the column`);
    assertEquals(lap.exposure_in, stored, `sent ${JSON.stringify(sent)}`);
    assert(!("exposure_in" in upsertFor(trace, "panel")!), "the panel row never names it");
  }
});

Deno.test("save: a row that does not mention it never names the column (production's portal leaves a size alone)", async () => {
  const { status, body, trace } = await save([row("panel"), row("lap")], { noColumn: true });
  assertEquals(status, 200, JSON.stringify(body));
  assertEquals(body.saved, 2, JSON.stringify(body));
  for (const u of trace.upserts) assert(!("exposure_in" in u), JSON.stringify(u));
});

Deno.test("save: a blank size on another cladding is nothing to write, not a refusal", async () => {
  const { status, body, trace } = await save([row("panel", { exposureIn: "" }), row("batten", { exposureIn: null })]);
  assertEquals(status, 200, JSON.stringify(body));
  assertEquals([body.saved, body.skipped], [2, []]);
  for (const u of trace.upserts) assert(!("exposure_in" in u), JSON.stringify(u));
});

Deno.test("save: a size on any other cladding is refused with a sentence; the other rows still save", async () => {
  for (const cid of ["panel", "batten", "agpanel"]) {
    const { status, body, trace } = await save([row(cid, { exposureIn: "4.5" }), row("lap", { exposureIn: "4.5" })]);
    assertEquals(status, 200, JSON.stringify(body));
    assertEquals(body.skipped, [`${cid}: only lap siding takes a course size`]);
    assertEquals(body.saved, 1);
    assert(!upsertFor(trace, cid), `${cid} was not written`);
    assertEquals(upsertFor(trace, "lap")!.exposure_in, 4.5);
  }
});

Deno.test("save: a lap size outside 3..12 or not a number is refused, never coerced", async () => {
  for (const sent of ["2", "2.99", "12.01", "13", "0", "-4.5", "wide", "4.5in", true, {}, "NaN", "Infinity"]) {
    const { status, body, trace } = await save([row("panel"), row("lap", { exposureIn: sent })]);
    assertEquals(status, 200, JSON.stringify(body));
    assertEquals(body.skipped.length, 1, `${JSON.stringify(sent)}: ${JSON.stringify(body)}`);
    assert(/^lap: ".*" is not a course size from 3 to 12 inches$/.test(body.skipped[0]), body.skipped[0]);
    assert(!upsertFor(trace, "lap"), `${JSON.stringify(sent)} wrote nothing for lap`);
    assertEquals(body.saved, 1, "the panel row still saved");
  }
});
