// The sizes table's two portal-settings actions, size_table and save_pricing_cells (2026-10-30),
// driven through the SHIPPED handler. This is the SERVER half of the table's wiring test; the
// portal half (the link, the Dashboard branch, the page's transport) belongs beside it.
//
// WHAT IS PINNED:
//   1. Both actions are gated: size_table needs settings_structures view, save_pricing_cells edit.
//      Someone without the area gets neither, a view-only person reads and cannot save, and a refused
//      call reads nothing and calls nothing.
//   2. The tenant comes from the token, never the body: a body naming another builder (clientId,
//      client_id, p_client_id) is ignored, a non-operator's targetClientId is a 403, and only an
//      operator's view-as reaches another builder, with operator_save_pricing_cells audited.
//   3. Every answer carries clientId: the page checks it itself, because its calls go through the
//      side door, which skips the invoke wrapper's tenant tripwire.
//   4. A malformed save is a 400 and makes no rpc call; a database error is dbFail's sentence with
//      the ref "save your table changes" (or "load your sizes"), logged, and not audited as saved;
//      a lock timeout is one of those 500s (the page resends it).
//   The client_settings fake refuses a column the table lacks (42703, as PostgREST does), and the
//   one settings read is checked to filter on the resolved tenant.
//   5. A save answers the function's three lists as they came, with one audit row of counts.
//
// HOW. deleteDesignWiring_test's idiom: Deno.serve is stubbed while portal-settings/index.ts is
// imported, the import map swaps supabase-js for supabase_stub.ts, and its stubDb / stubRpc route
// every table call and the rpc into the fakes below (pricingImportFake.ts for the three catalog
// tables, capped at 1,000 rows a read like PostgREST). No --allow-net. Tenants are made up; the repo
// is public.
//
// ⚠️ THE IMPORT SPECIFIER IS COMPUTED ON PURPOSE (see aiDraftStreamWiring_test).

// deno-lint-ignore-file no-explicit-any
import { assert, assertEquals } from "jsr:@std/assert";
import { stubAuth, stubDb, stubRpc } from "./supabase_stub.ts";
import { fakeDb } from "./pricingImportFake.ts";

const SOURCE = (await Deno.readTextFile(new URL("../../portal-settings/index.ts", import.meta.url))).replace(/\r\n/g, "\n");

const realServe = Deno.serve;
let handler: ((req: Request) => Promise<Response>) | null = null;
(Deno as any).serve = (h: (req: Request) => Promise<Response>) => {
  handler = h;
  return { finished: Promise.resolve() };
};
await import(new URL("../../portal-settings/index.ts", import.meta.url).href);
(Deno as any).serve = realServe;
if (!handler) throw new Error("portal-settings did not hand Deno.serve a handler");
const SETTINGS = handler as (req: Request) => Promise<Response>;

const OWN = "acme-sheds";
const OTHER = "bravo-barns";
const USER_ID = "00000000-0000-4000-8000-0000000000a1";
const uid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const V = "2026-10-30T14:41:07.123456+00:00";
const ENV: Record<string, string> = { SUPABASE_URL: "https://stub.supabase.co", SUPABASE_ANON_KEY: "stub-anon", SUPABASE_SERVICE_ROLE_KEY: "stub-service" };

const STYLES = [
  { id: uid(1), client_id: OWN, key: "test-barn", label: "Test Barn", code: "TB", active: true, sort_order: 0 },
  { id: uid(2), client_id: OTHER, key: "other-barn", label: "Other Barn", code: "OB", active: true, sort_order: 0 },
];
const SIZES = [
  { id: uid(11), client_id: OWN, style_id: uid(1), label: "10x12", width_ft: 10, length_ft: 12, base_price: 4800, active: true, sort_order: 0, created_at: V, updated_at: V },
  { id: uid(12), client_id: OWN, style_id: uid(1), label: "12x24", width_ft: 12, length_ft: 24, base_price: null, active: false, sort_order: 1, created_at: V, updated_at: V },
  { id: uid(21), client_id: OTHER, style_id: uid(2), label: "10x12", width_ft: 10, length_ft: 12, base_price: 999, active: true, sort_order: 0, created_at: V, updated_at: V },
];
const INCLUSIONS = [
  { client_id: OWN, size_id: uid(11), item_key: "loft", included: true, qty: 50 },
  { client_id: OTHER, size_id: uid(21), item_key: "loft", included: true, qty: 9 },
];
const ANSWER = {
  created: [],
  removed: [],
  results: [{ id: uid(11), status: "saved", version: "2026-10-30T14:45:00.000001+00:00", row: { price: 4900, active: true, label: "10x12", width_ft: 10, length_ft: 12 }, cells: { loft: 0 } }],
};
const SAVE = {
  action: "save_pricing_cells",
  sizes: [{ id: uid(11), base: V, from: { price: 4800, cells: { loft: 50 } }, to: { price: 4900, cells: { loft: 0 } } }],
};

type World = {
  caller?: { role: string; title?: string | null; access?: Record<string, string> | null };
  operator?: { can_write: boolean; can_bill?: boolean; support_only?: boolean } | null;
  settings?: Record<string, unknown> | null;
  rpc?: (args: any) => { data: any; error: any };
  readFails?: boolean;
};
type Trace = { rpc: { fn: string; args: any }[]; audit: any[]; faults: any[]; catalogReads: string[]; settingsReads: any[][][] };

const eqOf = (ops: any[][], col: string) => (ops.find((o) => o[0] === "eq" && o[1] === col) ?? [])[2];
/** client_settings' columns these two actions may name (rtp_enabled: 152). The fake refuses any
 *  other, as PostgREST does (42703), so a misspelled column fails here instead of turning every
 *  size_table call into a 500 live. */
const SETTINGS_COLS = new Set(["client_id", "rtp_enabled"]);
function settingsAnswer(ops: any[][], settings: Record<string, unknown> | null | undefined) {
  const named = [
    ...ops.filter((o) => o[0] === "select").flatMap((o) => String(o[1] ?? "*").split(",").map((c) => c.trim())),
    ...ops.filter((o) => ["eq", "neq", "is", "in", "order"].includes(o[0])).map((o) => String(o[1])),
  ];
  const unknown = named.find((c) => !SETTINGS_COLS.has(c));
  if (unknown) return { data: null, error: { code: "42703", message: `column client_settings.${unknown} does not exist` } };
  return { data: settings ?? null, error: null };
}
function chain(answer: (ops: any[][]) => any): any {
  const build = (ops: any[][]): any => {
    const q: any = {};
    for (const m of ["select", "eq", "neq", "is", "in", "limit", "order", "range", "insert", "update", "upsert", "delete"]) {
      q[m] = (...a: unknown[]) => build([...ops, [m, ...a]]);
    }
    q.maybeSingle = () => Promise.resolve().then(() => answer([...ops, ["maybeSingle"]]));
    q.single = () => Promise.resolve().then(() => answer([...ops, ["single"]]));
    q.then = (ok: any, bad: any) => Promise.resolve().then(() => answer(ops)).then(ok, bad);
    return q;
  };
  return build([]);
}

async function drive(body: Record<string, unknown>, world: World = {}) {
  const trace: Trace = { rpc: [], audit: [], faults: [], catalogReads: [], settingsReads: [] };
  const db = fakeDb({ building_styles: STYLES, building_sizes: SIZES, building_size_inclusions: INCLUSIONS }, { maxRows: 1000 });
  const caller = world.caller ?? { role: "owner", title: "owner", access: null };
  const savedEnv = Object.fromEntries(Object.keys(ENV).map((k) => [k, Deno.env.get(k)]));
  for (const [k, v] of Object.entries(ENV)) Deno.env.set(k, v);
  stubAuth.user = { id: USER_ID, email: "owner@example.test" };
  stubAuth.error = null;
  stubDb.from = (table: string) => {
    if (table.startsWith("building_")) {
      trace.catalogReads.push(table);
      if (world.readFails) return chain(() => ({ data: null, error: { code: "57014", message: "canceling statement due to statement timeout" } }));
      return db.sb.from(table);
    }
    return chain((ops) => {
      const insert = (ops.find((o) => o[0] === "insert") ?? [])[1];
      switch (table) {
        case "client_users": return { data: [{ client_id: OWN, role: caller.role, title: caller.title ?? null, access: caller.access ?? null, user_id: USER_ID }], error: null };
        case "app_operators": return { data: world.operator ? { user_id: USER_ID, email: "op@example.test", can_bill: false, support_only: false, ...world.operator } : null, error: null };
        case "client_configs": { const c = eqOf(ops, "client_id"); return { data: [OWN, OTHER].includes(c) ? { client_id: c } : null, error: null }; }
        case "client_settings": trace.settingsReads.push(ops); return settingsAnswer(ops, world.settings);
        case "admin_audit": trace.audit.push(insert); return { data: null, error: null };
        case "app_errors": trace.faults.push(insert); return { data: null, error: null };
      }
      throw new Error(`the fake database has no answer for ${table} ${JSON.stringify(ops)}`);
    });
  };
  stubRpc.rpc = (fn: string, args?: any) => {
    trace.rpc.push({ fn, args });
    if (fn !== "pricing_cells_apply") return Promise.reject(new Error(`unexpected rpc ${fn}`));
    return Promise.resolve(world.rpc ? world.rpc(args) : { data: ANSWER, error: null });
  };
  try {
    const res = await SETTINGS(new Request("https://stub.supabase.co/functions/v1/portal-settings", {
      method: "POST",
      headers: { authorization: "Bearer harness", "content-type": "application/json", "user-agent": "harness/1.0" },
      body: JSON.stringify(body),
    }));
    return { status: res.status, body: await res.json(), trace, ins: db.ins };
  } finally {
    stubDb.from = null;
    stubRpc.rpc = null;
    stubAuth.user = null;
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) Deno.env.delete(k);
      else Deno.env.set(k, v);
    }
  }
}

const VIEWER = { role: "user", title: "sales_rep", access: { settings_structures: "view" } };
const NOBODY = { role: "user", title: "sales_rep", access: { settings_structures: "none" } };
const audited = (t: Trace, action: string) => t.audit.filter((r) => r?.action === action);

// ─── 1. The gates ──────────────────────────────────────────────────────────────────────────────
Deno.test("GATES: size_table needs Sheds view and save_pricing_cells needs Sheds edit, beside the sheet's import", () => {
  const gates = SOURCE.slice(SOURCE.indexOf("const GATES: GateTable = {"));
  const imp = gates.indexOf('  import_pricing_csv:        { area: "settings_structures", level: "edit" },');
  const read = gates.indexOf('  size_table:                { area: "settings_structures", level: "view" },');
  const save = gates.indexOf('  save_pricing_cells:        { area: "settings_structures", level: "edit" },');
  assert(imp >= 0 && read > imp && save > read, "the two gate lines sit under import_pricing_csv's");
  const branchImp = SOURCE.indexOf('if (action === "import_pricing_csv") {');
  const branchRead = SOURCE.indexOf('if (action === "size_table") {');
  const branchSave = SOURCE.indexOf('if (action === "save_pricing_cells") {');
  assert(branchImp > 0 && branchRead > branchImp && branchSave > branchRead, "the two branches sit beside the sheet's import");
});

Deno.test("an owner reads the whole table, with clientId, counts and Real-Time Pricing", async () => {
  const r = await drive({ action: "size_table" }, { settings: { rtp_enabled: true } });
  assertEquals(r.status, 200, JSON.stringify(r.body));
  assertEquals(r.body.ok, true);
  assertEquals(r.body.clientId, OWN);
  assertEquals(r.body.styles.map((s: any) => s.id), [uid(1)]);
  assertEquals(r.body.sizes.map((z: any) => z.id).sort(), [uid(11), uid(12)]);
  assertEquals(r.body.inclusions.map((i: any) => [i.size_id, i.item_key, i.qty]), [[uid(11), "loft", 50]]);
  assertEquals(r.body.counts, { sizes: 2, inclusions: 1 });
  assertEquals(r.body.rtpOn, true);
  assertEquals(r.body.sizes.find((z: any) => z.id === uid(11)).updated_at, V, "the version every edit sends back");
  assertEquals(r.ins, [], "no read carries a list of ids");
  // The settings fake refuses any column client_settings lacks; here, the one read names rtp_enabled
  // and filters on client_id = the tenant the token resolved to.
  assertEquals(r.trace.settingsReads.map((ops) => [(ops.find((o) => o[0] === "select") ?? [])[1], eqOf(ops, "client_id")]), [["rtp_enabled", OWN]]);
  assertEquals(settingsAnswer([["select", "rtp_enable"], ["eq", "client_id", OWN]], { rtp_enabled: true }).error?.code, "42703", "(the fake refuses a misspelled column)");
});

Deno.test("a view-only person reads the table and cannot save; someone without Sheds gets neither", async () => {
  const read = await drive({ action: "size_table" }, { caller: VIEWER });
  assertEquals(read.status, 200, JSON.stringify(read.body));
  const save = await drive(SAVE, { caller: VIEWER });
  assertEquals(save.status, 403, JSON.stringify(save.body));
  assertEquals(save.trace.rpc.length, 0, "a refused save calls nothing");
  for (const body of [{ action: "size_table" }, SAVE]) {
    const r = await drive(body, { caller: NOBODY });
    assertEquals(r.status, 403, `${body.action}: ${JSON.stringify(r.body)}`);
    assertEquals([r.trace.rpc.length, r.trace.catalogReads.length], [0, 0], `${body.action} read or called something`);
  }
});

// ─── 2-3. The tenant comes from the token, and every answer names it ────────────────────────────
Deno.test("a body naming another builder is ignored: the rpc gets the caller's own tenant", async () => {
  const r = await drive({ ...SAVE, clientId: OTHER, client_id: OTHER, p_client_id: OTHER });
  assertEquals(r.status, 200, JSON.stringify(r.body));
  assertEquals(r.trace.rpc.length, 1);
  assertEquals(r.trace.rpc[0].args.p_client_id, OWN);
  assertEquals(r.body.clientId, OWN);
  const read = await drive({ action: "size_table", clientId: OTHER, client_id: OTHER });
  assertEquals(read.body.clientId, OWN);
  assert(read.body.sizes.every((z: any) => z.client_id === OWN) && !read.body.sizes.some((z: any) => z.id === uid(21)), "only the caller's sizes");
});

Deno.test("a non-operator's targetClientId is a 403, before anything is read or called", async () => {
  for (const body of [{ ...SAVE, targetClientId: OTHER }, { action: "size_table", targetClientId: OTHER }]) {
    const r = await drive(body);
    assertEquals(r.status, 403, JSON.stringify(r.body));
    assertEquals([r.trace.rpc.length, r.trace.catalogReads.length], [0, 0]);
  }
});

Deno.test("an operator's view-as reaches the viewed builder, and the save is audited for them", async () => {
  const r = await drive({ ...SAVE, targetClientId: OTHER }, { operator: { can_write: true } });
  assertEquals(r.status, 200, JSON.stringify(r.body));
  assertEquals(r.trace.rpc[0].args.p_client_id, OTHER);
  assertEquals(r.body.clientId, OTHER);
  assertEquals(audited(r.trace, "operator_save_pricing_cells").length, 1);
  assertEquals(audited(r.trace, "portal_save_pricing_cells").map((a) => a.target_client_id), [OTHER]);
  const read = await drive({ action: "size_table", targetClientId: OTHER }, { operator: { can_write: false } });
  assertEquals(read.status, 200, "a read-only operator can read");
  assertEquals([read.body.clientId, read.body.sizes.map((z: any) => z.id)], [OTHER, [uid(21)]]);
  assertEquals(read.trace.settingsReads.map((ops) => eqOf(ops, "client_id")), [OTHER], "...and Real-Time Pricing is read for the viewed builder");
  const ro = await drive({ ...SAVE, targetClientId: OTHER }, { operator: { can_write: false } });
  assertEquals([ro.status, ro.trace.rpc.length], [403, 0], "a read-only operator cannot save");
});

// ─── 4-5. The save's answers ───────────────────────────────────────────────────────────────────
Deno.test("a save answers the function's lists as they came, with clientId and one audit row of counts", async () => {
  const r = await drive(SAVE);
  assertEquals(r.status, 200);
  assertEquals(r.body, { ok: true, clientId: OWN, ...ANSWER });
  assertEquals(r.trace.rpc[0].args, {
    p_client_id: OWN, p_creates: [], p_removes: [],
    p_sizes: [{ id: uid(11), base: V, from: { price: 4800, cells: { loft: 50 } }, to: { price: 4900, cells: { loft: 0 } } }],
  });
  const rows = audited(r.trace, "portal_save_pricing_cells");
  assertEquals(rows.length, 1);
  assertEquals(rows[0].row_count, 1);
  assert(/^(\w+=\d+)( \w+=\d+)*$/.test(rows[0].note), rows[0].note);
  assertEquals(audited(r.trace, "operator_save_pricing_cells").length, 0, "not an operator");
});

Deno.test("a malformed save is a 400 and calls nothing", async () => {
  const sizes = SAVE.sizes;
  for (const body of [
    { action: "save_pricing_cells" },
    { action: "save_pricing_cells", sizes: [{ ...sizes[0], base: undefined }] },
    { action: "save_pricing_cells", sizes: [{ ...sizes[0], id: "nope" }] },
    { action: "save_pricing_cells", sizes: [{ ...sizes[0], to: { price: 4900, cells: { loft: 2.5 } } }] },
    { action: "save_pricing_cells", removes: Array.from({ length: 51 }, (_, i) => uid(100 + i)) },
  ]) {
    const r = await drive(body);
    assertEquals(r.status, 400, JSON.stringify([body, r.body]));
    assert(typeof r.body.error === "string" && r.body.error.length > 0);
    assertEquals(r.trace.rpc.length, 0, JSON.stringify(body));
    assertEquals(audited(r.trace, "portal_save_pricing_cells").length, 0);
  }
});

Deno.test("a database error is dbFail's sentence, logged, and not audited as a save", async () => {
  const r = await drive(SAVE, { rpc: () => ({ data: null, error: { code: "42883", message: "function public.pricing_cells_apply does not exist" } }) });
  assertEquals(r.status, 500);
  assertEquals(r.body.ref, "save your table changes");
  assert(/Couldn't save your table changes/.test(r.body.error), r.body.error);
  assert(!JSON.stringify(r.body).includes("pricing_cells_apply"), "the raw message stays off the screen");
  assertEquals(r.trace.rpc.length, 1, "a SQLSTATE is not retried");
  assert(r.trace.faults.some((f) => /save your table changes/.test(String(f?.message))), JSON.stringify(r.trace.faults));
  assertEquals(audited(r.trace, "portal_save_pricing_cells").length, 0);

  const read = await drive({ action: "size_table" }, { readFails: true });
  assertEquals([read.status, read.body.ref], [500, "load your sizes"]);

  // A lock wait past the function's lock_timeout fails the whole call (migration 350 raises it rather
  // than refusing one size). It must reach the browser as a 5xx, which the page resends after its
  // backoff, and never as a 400 or a 200 with refused boxes.
  const busy = await drive(SAVE, { rpc: () => ({ data: null, error: { code: "55P03", message: "canceling statement due to lock timeout" } }) });
  assertEquals([busy.status, busy.body.ref, busy.trace.rpc.length], [500, "save your table changes", 1]);
  assertEquals(audited(busy.trace, "portal_save_pricing_cells").length, 0);
});
