// The library's portal-settings actions (migration 339; plan §1 step 5), driven through the SHIPPED
// handler, request by request:
//   * the flag fails closed: off answers 403 library_off, a database without 339 answers 503, and the
//     catalog then says libraryBeta false and still loads;
//   * another builder's entry is 404 (every read and write is scoped to the caller's client_id);
//   * removing an entry still in use is 409 and names the rows;
//   * library_seed_mine run twice gives the same rows (the second run creates and links nothing), names a
//     cladding entry by the label the builder already shows, and adds "Use the door's photo";
//   * save_cladding: an entry of another cladding look is refused for that row and nothing is linked; the
//     entry's name and course are written with the link; an ABSENT clientLibraryId writes no link column
//     (production's older portal);
//   * save_fixture: an entry puts its look on the door and wins over the doorStyle sent; absent writes
//     no link column;
//   * library_request: a door is refused; an inactive meter charges nothing and calls no wallet
//     function; an armed meter holds then captures under library_request; insufficient funds is 402 and
//     stores nothing; a photo path of another shape is refused;
//   * library_request_cancel credits back what was charged, once.
//   * a door made from a photo (345): library_add with a doorLookId makes an entry drawn over the look's
//     base, from a READY look of this builder's only; a database without 345 answers 503 in words; the
//     library read carries the look's tile; such an entry is rename-only; a template never takes a
//     doorLookId; save_fixture refuses a save naming both looks, and an entry put on a row clears the
//     row's own look (one look per door row).
//
// HOW. numberRequestsHandler_test's idiom: Deno.serve is stubbed while index.ts is imported, the import
// map swaps supabase-js for supabase_stub.ts, and stubDb / stubRpc / stubStorage route every call into
// the in-memory fake below. No --allow-net. Tenants are made up; the repo is public.
//
// ⚠️ THE IMPORT SPECIFIER IS COMPUTED ON PURPOSE (see aiDraftStreamWiring_test).

// deno-lint-ignore-file no-explicit-any
import { assert, assertEquals } from "jsr:@std/assert";
import { stubAuth, stubDb, stubRpc, stubStorage } from "./supabase_stub.ts";

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

const OWN = "acme-sheds", OTHER = "bravo-barns";
const USER_ID = "00000000-0000-4000-8000-0000000000b8";
const U = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const T_LAP = U(901), T_PANEL = U(902), T_AMERICAN = U(903), T_AUTO = U(904), T_SIX = U(905), T_STD = U(906);
const STYLE = U(11);
const LOOK_READY = U(801), LOOK_DRAFT = U(802), LOOK_OLD = U(803), LOOK_THEIRS = U(804);

type Row = Record<string, any>;
type World = {
  tables: Record<string, Row[]>;
  /** client_settings.library_beta, or "missing" = a database without 339. */
  flag: boolean | "missing";
  meter?: { price_cents: number; active: boolean; visible?: boolean };
  wallet?: (fn: string, args: any) => any;
  /** A database without 345: library_look_ok refuses a door look that names a doorLookId. */
  no345?: boolean;
};
type Trace = { reads: Array<{ table: string; ops: any[][] }>; writes: Array<{ table: string; verb: string; row: any; ops: any[][] }>; rpc: Array<{ fn: string; args: any }> };

function world(): World {
  return {
    flag: true,
    meter: { price_cents: 200, active: false },
    tables: {
      library_items: [
        { id: T_LAP, category: "cladding", slug: "lap", name: '7" LP Lap Siding', look: { profile: "lap" }, version: 1, status: "active", sort_order: 10, search_terms: ["lap"] },
        { id: T_PANEL, category: "cladding", slug: "panel", name: "Panel Siding", look: { profile: "panel" }, version: 1, status: "active", sort_order: 30, search_terms: ["panel"] },
        { id: T_AUTO, category: "door", slug: "photo", name: "Use the door's photo", look: { doorStyle: "auto" }, version: 1, status: "active", sort_order: 10, search_terms: [] },
        { id: T_AMERICAN, category: "door", slug: "american", name: "American (built in 3D)", look: { doorStyle: "american" }, version: 2, status: "active", sort_order: 60, search_terms: [] },
        { id: T_STD, category: "window", slug: "automatic", name: "Standard window", look: {}, version: 1, status: "active", sort_order: 10, search_terms: [] },
        { id: T_SIX, category: "window", slug: "six-lite", name: "6-lite (3 rows of 2)", look: { liteRows: 3, liteCols: 2 }, version: 1, status: "active", sort_order: 40, search_terms: [] },
      ],
      client_library: [
        { id: U(501), client_id: OTHER, category: "cladding", name: "Their lap", look: { profile: "lap" }, library_item_id: T_LAP },
      ],
      building_styles: [{ id: STYLE, client_id: OWN, label: "Utility" }, { id: U(12), client_id: OTHER, label: "Theirs" }],
      style_cladding: [
        { id: U(21), client_id: OWN, style_id: STYLE, cladding_id: "lap", label_override: null, exposure_in: null, rate: 0, active: true, client_library_id: null },
        { id: U(22), client_id: OWN, style_id: STYLE, cladding_id: "panel", label_override: "Smooth panel", exposure_in: null, rate: 1.5, active: true, client_library_id: null },
        { id: U(23), client_id: OWN, style_id: STYLE, cladding_id: "batten", label_override: null, exposure_in: null, rate: null, active: true, client_library_id: null },
        { id: U(24), client_id: OTHER, style_id: U(12), cladding_id: "lap", label_override: null, exposure_in: null, rate: 0, active: true, client_library_id: null },
      ],
      fixture_items: [
        { id: U(31), client_id: OWN, category: "door", name: "Double barn door", door_style: "american", lite_rows: null, lite_cols: null, client_library_id: null, sort_order: 0 },
        { id: U(32), client_id: OWN, category: "window", name: "Wall window", door_style: "auto", lite_rows: 3, lite_cols: 2, client_library_id: null, sort_order: 0 },
        { id: U(33), client_id: OTHER, category: "door", name: "Their door", door_style: "plank", lite_rows: null, lite_cols: null, client_library_id: null, sort_order: 0 },
      ],
      library_requests: [],
      wallet_accounts: [],
      door_looks: [
        { id: LOOK_READY, client_id: OWN, name: "Our photo door", base: "classic", status: "ready", thumb_url: "https://stub.supabase.co/storage/v1/object/public/fixtures/acme-sheds/door-look-1.png" },
        { id: LOOK_DRAFT, client_id: OWN, name: "A draft", base: "plank", status: "draft", thumb_url: null },
        { id: LOOK_OLD, client_id: OWN, name: "An old one", base: "dutch", status: "archived", thumb_url: null },
        { id: LOOK_THEIRS, client_id: OTHER, name: "Their photo door", base: "zbrace", status: "ready", thumb_url: null },
      ],
    },
  };
}

const has = (ops: any[][], op: string) => ops.some((o) => o[0] === op);
const argOf = (ops: any[][], op: string) => (ops.find((o) => o[0] === op) ?? []).slice(1);
/** Apply the query's filters to a row. */
function matches(r: Row, ops: any[][]): boolean {
  for (const o of ops) {
    if (o[0] === "eq" && r[o[1]] !== o[2]) return false;
    if (o[0] === "is" && o[2] === null && r[o[1]] != null) return false;
    if (o[0] === "not" && o[2] === "is" && o[3] === null && r[o[1]] == null) return false;
    if (o[0] === "in" && !(o[2] as unknown[]).includes(r[o[1]])) return false;
  }
  return true;
}
let seq = 700;
function answer(w: World, t: Trace, table: string, ops: any[][]): any {
  const verb = ["upsert", "insert", "update", "delete"].find((v) => has(ops, v));
  if (verb && table !== "admin_audit" && table !== "app_errors") t.writes.push({ table, verb, row: argOf(ops, verb)[0], ops });
  else if (!verb) t.reads.push({ table, ops });
  const single = has(ops, "single") || has(ops, "maybeSingle");
  const out = (rows: Row[]) => (single ? { data: rows[0] ?? null, error: null } : { data: rows, error: null });
  switch (table) {
    case "client_users":
      if (argOf(ops, "eq")[0] === "role") return { data: [{ role: "owner", title: "owner", access: null }], error: null };
      return { data: [{ client_id: OWN, role: "owner", title: "owner", access: null, user_id: USER_ID }], error: null };
    case "app_operators":
      return { data: null, error: null };
    case "client_configs":
      return { data: { client_id: OWN }, error: null };
    case "admin_audit": case "app_errors":
      return { data: null, error: null };
    case "client_settings": {
      const sel = String(argOf(ops, "select")[0] ?? "");
      if (sel.includes("library_beta") && w.flag === "missing") return { data: null, error: { code: "42703", message: "column client_settings.library_beta does not exist" } };
      return { data: { library_beta: w.flag === true, billing_exempt: false, internal_account: false }, error: null };
    }
    case "usage_prices":
      return { data: w.meter ? { visible: true, ...w.meter } : null, error: null };
  }
  const rows = (w.tables[table] ??= []);
  if (verb === "insert") {
    const raw = argOf(ops, "insert")[0];
    const list: Row[] = (Array.isArray(raw) ? raw : [raw]).map((r: Row) => ({ id: U(seq++), created_at: "2026-10-27T10:00:00Z", ...r }));
    if (table === "client_library") {
      for (const r of list) {
        if (w.no345 && r.look && r.look.doorLookId !== undefined) {
          return { data: null, error: { code: "23514", message: "new row for relation \"client_library\" violates check constraint \"client_library_look_chk\"" } };
        }
        if (rows.some((x) => x.client_id === r.client_id && x.category === r.category && String(x.name).toLowerCase() === String(r.name).toLowerCase())) {
          return { data: null, error: { code: "23505", message: "duplicate key value violates unique constraint \"client_library_name_key\"" } };
        }
      }
    }
    rows.push(...list);
    return out(list);
  }
  const hit = rows.filter((r) => matches(r, ops));
  if (verb === "update") { for (const r of hit) Object.assign(r, argOf(ops, "update")[0]); return { ...out(hit), count: hit.length }; }
  if (verb === "delete") { w.tables[table] = rows.filter((r) => !hit.includes(r)); return { data: null, error: null }; }
  const lim = argOf(ops, "limit")[0];
  return out(typeof lim === "number" ? hit.slice(0, lim) : hit);
}
function chain(w: World, t: Trace, table: string, ops: any[][]): any {
  const next = (op: any[]) => chain(w, t, table, [...ops, op]);
  const q: any = {};
  for (const m of ["select", "insert", "update", "delete", "upsert", "eq", "neq", "is", "in", "not", "or", "limit", "order", "range", "single", "maybeSingle"]) {
    q[m] = (...a: unknown[]) => next([m, ...a]);
  }
  q.then = (ok: any, bad: any) => Promise.resolve().then(() => answer(w, t, table, ops)).then(ok, bad);
  return q;
}

const ENV: Record<string, string> = { SUPABASE_URL: "https://stub.supabase.co", SUPABASE_ANON_KEY: "stub-anon", SUPABASE_SERVICE_ROLE_KEY: "stub-service" };
async function call(body: Record<string, unknown>, w: World) {
  const t: Trace = { reads: [], writes: [], rpc: [] };
  const saved = Object.fromEntries(Object.keys(ENV).map((k) => [k, Deno.env.get(k)]));
  for (const [k, v] of Object.entries(ENV)) Deno.env.set(k, v);
  stubAuth.user = { id: USER_ID, email: "owner@example.test" };
  stubAuth.error = null;
  stubDb.from = (table: string) => chain(w, t, table, []);
  stubRpc.rpc = (fn: string, args?: any) => {
    t.rpc.push({ fn, args });
    const res = w.wallet ? w.wallet(fn, args) : { data: null, error: null };
    const p: any = Promise.resolve(res);
    p.maybeSingle = () => Promise.resolve(res);
    return p;
  };
  stubStorage.from = (bucket: string) => ({
    createSignedUploadUrl: (path: string) => { t.rpc.push({ fn: `storage:${bucket}`, args: { path } }); return Promise.resolve({ data: { token: "tok" }, error: null }); },
  });
  try {
    const res = await SETTINGS(new Request("https://stub.supabase.co/functions/v1/portal-settings", {
      method: "POST",
      headers: { authorization: "Bearer harness", "content-type": "application/json", "user-agent": "harness/1.0" },
      body: JSON.stringify(body),
    }));
    return { status: res.status, body: await res.json(), t };
  } finally {
    stubDb.from = null; stubRpc.rpc = null; stubStorage.from = null; stubAuth.user = null;
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) Deno.env.delete(k); else Deno.env.set(k, v); }
  }
}
/** Every read and write of a tenant table names the caller's own client_id. */
function scopedToOwn(t: Trace) {
  for (const x of [...t.reads, ...t.writes]) {
    if (!["client_library", "library_requests", "style_cladding", "fixture_items", "building_styles"].includes(x.table)) continue;
    const eqc = x.ops.find((o) => o[0] === "eq" && o[1] === "client_id");
    const row = (x as any).row;
    const rowsOwn = row ? (Array.isArray(row) ? row : [row]).every((r: Row) => r.client_id === undefined || r.client_id === OWN) : true;
    assert((eqc && eqc[2] === OWN) || ((x as any).verb === "insert" && rowsOwn), `${x.table} touched without client_id = ${OWN}: ${JSON.stringify(x.ops)}`);
  }
}

Deno.test("the flag fails closed: off is 403, a database without 339 is 503", async () => {
  const w = world(); w.flag = false;
  const off = await call({ action: "library" }, w);
  assertEquals(off.status, 403);
  assertEquals(off.body.code, "library_off");
  w.flag = "missing";
  const gone = await call({ action: "library" }, w);
  assertEquals(gone.status, 503);
  assertEquals(gone.body.code, "library_unavailable");
});

Deno.test("library: templates, this builder's entries with where they are used, requests and the price", async () => {
  const w = world();
  w.tables.client_library.push({ id: U(601), client_id: OWN, category: "cladding", name: "Our lap", look: { profile: "lap" }, library_item_id: T_LAP });
  w.tables.style_cladding[0].client_library_id = U(601);
  const r = await call({ action: "library" }, w);
  assertEquals(r.status, 200);
  assertEquals(r.body.templates.length, 6);
  assertEquals(r.body.entries.map((e: any) => e.name), ["Our lap"], "another builder's entry is never listed");
  assertEquals(r.body.entries[0].usedOn, ["Utility"]);
  assertEquals(r.body.requestPrice, { priceCents: 200, active: false, exempt: false });
  scopedToOwn(r.t);
});

Deno.test("another builder's entry is 404, for edit and remove", async () => {
  const w = world();
  const e = await call({ action: "library_edit", id: U(501), name: "Mine now" }, w);
  assertEquals(e.status, 404);
  const d = await call({ action: "library_remove", id: U(501) }, w);
  assertEquals(d.status, 404);
  assertEquals(w.tables.client_library.find((x) => x.id === U(501))!.name, "Their lap", "nothing moved");
  scopedToOwn(e.t); scopedToOwn(d.t);
});

Deno.test("remove refuses while the entry is in use, naming the rows", async () => {
  const w = world();
  w.tables.client_library.push({ id: U(602), client_id: OWN, category: "door", name: "Our American", look: { doorStyle: "american" }, library_item_id: T_AMERICAN });
  w.tables.fixture_items[0].client_library_id = U(602);
  const r = await call({ action: "library_remove", id: U(602) }, w);
  assertEquals(r.status, 409);
  assertEquals(r.body.code, "library_in_use");
  assertEquals(r.body.usedOn, ["Double barn door"]);
  assert(w.tables.client_library.some((x) => x.id === U(602)), "not deleted");
  w.tables.fixture_items[0].client_library_id = null;
  const ok = await call({ action: "library_remove", id: U(602) }, w);
  assertEquals(ok.status, 200);
  assert(!w.tables.client_library.some((x) => x.id === U(602)), "deleted once nothing uses it");
});

Deno.test("seed_mine: what they use today, named as they show it, and twice gives the same rows", async () => {
  const w = world();
  const a = await call({ action: "library_seed_mine" }, w);
  assertEquals(a.status, 200);
  const mine = () => w.tables.client_library.filter((x) => x.client_id === OWN).map((x) => `${x.category}:${x.name}:${JSON.stringify(x.look)}`).sort();
  const first = mine();
  assertEquals(first, [
    'cladding:7" LP Lap Siding:{"profile":"lap"}',
    'cladding:Smooth panel:{"profile":"panel"}',
    'door:American (built in 3D):{"doorStyle":"american"}',
    `door:Use the door's photo:{"doorStyle":"auto"}`,
    'window:6-lite (3 rows of 2):{"liteRows":3,"liteCols":2}',
  ], "offered cladding only (batten has no rate), the label already shown, and the photo door");
  assertEquals(a.body, { ok: true, created: 5, linked: 4, skipped: 0 });
  assertEquals(w.tables.style_cladding.find((x) => x.id === U(23))!.client_library_id, null, "a cladding not offered is not linked");
  assertEquals(w.tables.style_cladding.find((x) => x.id === U(24))!.client_library_id, null, "another builder's row is never touched");
  const b = await call({ action: "library_seed_mine" }, w);
  assertEquals(b.body, { ok: true, created: 0, linked: 0, skipped: 0 });
  assertEquals(mine(), first, "the same rows");
  scopedToOwn(a.t); scopedToOwn(b.t);
});

Deno.test("add copies a template (with the builder's edit) and edit changes only the copy", async () => {
  const w = world();
  const add = await call({ action: "library_add", templateId: T_LAP, name: "LP SmartSide 8in", look: { profile: "lap", exposureIn: 8 } }, w);
  assertEquals(add.status, 200);
  assertEquals(add.body.entry.look, { profile: "lap", exposureIn: 8 });
  assertEquals(w.tables.library_items.find((x) => x.id === T_LAP)!.look, { profile: "lap" }, "the template is untouched");
  const dup = await call({ action: "library_add", templateId: T_LAP, name: "lp smartside 8IN" }, w);
  assertEquals(dup.status, 409);
  const bad = await call({ action: "library_add", templateId: T_PANEL, name: "Panel with a course", look: { profile: "panel", exposureIn: 7 } }, w);
  assertEquals(bad.status, 400, "a course on panel is refused");
  const swap = await call({ action: "library_edit", id: add.body.entry.id, look: { profile: "panel" } }, w);
  assertEquals(swap.status, 400, "a cladding entry keeps its profile");
  const ed = await call({ action: "library_edit", id: add.body.entry.id, look: { profile: "lap", exposureIn: 6 } }, w);
  assertEquals(ed.status, 200);
  assertEquals(ed.body.entry.look, { profile: "lap", exposureIn: 6 });
  scopedToOwn(add.t); scopedToOwn(ed.t);
});

Deno.test("save_cladding: a mismatched profile is refused for the row; a match writes the link, name and course", async () => {
  const w = world();
  w.tables.client_library.push({ id: U(603), client_id: OWN, category: "cladding", name: "Our 7in lap", look: { profile: "lap", exposureIn: 7 }, library_item_id: T_LAP });
  const wrong = await call({ action: "save_cladding", styleId: STYLE, rows: [{ claddingId: "panel", rate: "1", clientLibraryId: U(603) }] }, w);
  assertEquals(wrong.status, 200);
  assertEquals(wrong.body.saved, 0);
  assert(String(wrong.body.skipped[0]).includes("different cladding"), wrong.body.skipped[0]);
  assert(!wrong.t.writes.some((x) => x.table === "style_cladding"), "nothing written for that row");
  const theirs = await call({ action: "save_cladding", styleId: STYLE, rows: [{ claddingId: "lap", rate: "0", clientLibraryId: U(501) }] }, w);
  assert(String(theirs.body.skipped[0]).includes("isn't in your library"), "another builder's entry is not found");
  const good = await call({ action: "save_cladding", styleId: STYLE, rows: [{ claddingId: "lap", rate: "0", labelOverride: "typed", clientLibraryId: U(603) }] }, w);
  assertEquals(good.body.saved, 1);
  const up = good.t.writes.find((x) => x.table === "style_cladding")!.row;
  assertEquals([up.client_library_id, up.label_override, up.exposure_in], [U(603), "Our 7in lap", 7]);
  const old = await call({ action: "save_cladding", styleId: STYLE, rows: [{ claddingId: "lap", rate: "0" }] }, w);
  const upOld = old.t.writes.find((x) => x.table === "style_cladding")!.row;
  assert(!("client_library_id" in upOld), "an absent clientLibraryId (the old portal) writes no link column");
  w.flag = false;
  const off = await call({ action: "save_cladding", styleId: STYLE, rows: [{ claddingId: "lap", rate: "0", clientLibraryId: U(603) }] }, w);
  assert(String(off.body.skipped[0]).includes("isn't turned on"), "an entry named with the flag off is refused for that row");
  const offOld = await call({ action: "save_cladding", styleId: STYLE, rows: [{ claddingId: "lap", rate: "2" }] }, w);
  assertEquals(offOld.body.saved, 1, "...and a save that does not mention the library still saves");
});

Deno.test("save_fixture: an entry's look wins over the doorStyle sent; absent writes no link", async () => {
  const w = world();
  w.tables.client_library.push({ id: U(604), client_id: OWN, category: "door", name: "Our Classic", look: { doorStyle: "classic" }, library_item_id: null });
  const base = { action: "save_fixture", category: "door", id: U(31), name: "Double barn door", widthIn: 60, heightIn: 72, price: 300, opDouble: true, swingOut: true };
  const r = await call({ ...base, doorStyle: "american", clientLibraryId: U(604) }, w);
  assertEquals(r.status, 200, JSON.stringify(r.body));
  const up = r.t.writes.find((x) => x.table === "fixture_items")!.row;
  assertEquals([up.client_library_id, up.door_style], [U(604), "classic"]);
  const old = await call({ ...base, doorStyle: "plank" }, w);
  const upOld = old.t.writes.find((x) => x.table === "fixture_items")!.row;
  assert(!("client_library_id" in upOld), "the old portal's save names no link column");
  const wrong = await call({ ...base, clientLibraryId: U(32) }, w);
  assertEquals(wrong.status, 404, "an id that is not an entry of theirs is not found");
  scopedToOwn(r.t);
});

Deno.test("library_request: doors refused, inactive meter free, armed meter holds then captures, no funds stores nothing", async () => {
  const w = world();
  const door = await call({ action: "library_request", category: "door", name: "A door", supplierUrl: "https://example.test/d", idempotencyKey: "key-door-1" }, w);
  assertEquals(door.status, 409);
  const badPath = await call({ action: "library_request", category: "window", name: "A window", photos: [{ path: `${OTHER}/requests/${U(1)}.jpg` }], idempotencyKey: "key-win-0" }, w);
  assertEquals(badPath.status, 400, "a photo path of another builder's shape is refused");
  const free = await call({ action: "library_request", category: "window", name: "Arched window", widthIn: 24, heightIn: 36, photos: [{ path: `${OWN}/requests/${U(2)}.jpg`, role: "front" }], idempotencyKey: "key-win-1" }, w);
  assertEquals(free.status, 200, JSON.stringify(free.body));
  assertEquals(free.body.request.chargedCents, 0);
  assert(!free.t.rpc.some((x) => x.fn.startsWith("wallet_")), "an inactive meter calls no wallet function");

  w.meter = { price_cents: 200, active: true };
  w.wallet = (fn, args) => {
    if (fn === "wallet_hold") return { data: { hold_id: 77, price_cents: 200, balance_after: 1000, err: null }, error: null };
    return { data: 800, error: null };
  };
  const paid = await call({ action: "library_request", category: "cladding", name: "Stone veneer", supplierUrl: "https://example.test/s", idempotencyKey: "key-clad-1" }, w);
  assertEquals(paid.status, 200, JSON.stringify(paid.body));
  assertEquals(paid.body.request.chargedCents, 200);
  const hold = paid.t.rpc.find((x) => x.fn === "wallet_hold")!;
  assertEquals([hold.args.p_client_id, hold.args.p_kind, hold.args.p_idem], [OWN, "library_request", "libreq:key-clad-1"]);
  assert(paid.t.rpc.some((x) => x.fn === "wallet_capture" && x.args.p_hold_id === 77), "captured at submit");

  w.wallet = (fn) => fn === "wallet_hold" ? { data: { hold_id: null, price_cents: 200, balance_after: 50, err: "insufficient_funds" }, error: null } : { data: null, error: null };
  const n0 = w.tables.library_requests.length;
  const broke = await call({ action: "library_request", category: "cladding", name: "Stone veneer 2", supplierUrl: "https://example.test/s", idempotencyKey: "key-clad-2" }, w);
  assertEquals(broke.status, 402);
  assertEquals(w.tables.library_requests.length, n0, "nothing stored");
  scopedToOwn(free.t); scopedToOwn(paid.t);
});

Deno.test("library_request_cancel credits back what was charged, once", async () => {
  const w = world();
  w.tables.library_requests.push({ id: U(801), client_id: OWN, category: "window", status: "submitted", name: "W", charged_cents: 200, refunded_cents: 0 });
  w.tables.library_requests.push({ id: U(802), client_id: OWN, category: "window", status: "in_progress", name: "W2", charged_cents: 200, refunded_cents: 0 });
  w.wallet = () => ({ data: 1000, error: null });
  const r = await call({ action: "library_request_cancel", id: U(801) }, w);
  assertEquals(r.status, 200);
  assertEquals(r.body.refundedCents, 200);
  const cr = r.t.rpc.find((x) => x.fn === "wallet_credit")!;
  assertEquals([cr.args.p_client_id, cr.args.p_amount_cents, cr.args.p_kind, cr.args.p_idem], [OWN, 200, "refund", `libreq-refund:${U(801)}`]);
  const again = await call({ action: "library_request_cancel", id: U(801) }, w);
  assertEquals(again.status, 409, "already cancelled");
  assert(!again.t.rpc.some((x) => x.fn === "wallet_credit"), "no second credit");
  const started = await call({ action: "library_request_cancel", id: U(802) }, w);
  assertEquals(started.status, 409, "CSM started it");
});

Deno.test("the request photo upload URL is minted under this builder's requests folder", async () => {
  const w = world();
  const r = await call({ action: "library_request_upload_url", contentType: "image/png" }, w);
  assertEquals(r.status, 200);
  assert(new RegExp(`^${OWN}/requests/[0-9a-f-]{36}\\.png$`).test(r.body.path), r.body.path);
  assertEquals(r.t.rpc.find((x) => x.fn.startsWith("storage:"))!.fn, "storage:library-refs");
});

Deno.test("catalog: libraryBeta and the entries when on; a database without 339 still loads, off", async () => {
  const w = world();
  w.tables.client_library.push({ id: U(605), client_id: OWN, category: "door", name: "Our American", look: { doorStyle: "american" }, library_item_id: T_AMERICAN });
  w.tables.fixture_items[0].client_library_id = U(605);
  const on = await call({ action: "catalog" }, w);
  assertEquals(on.status, 200, JSON.stringify(on.body).slice(0, 300));
  assertEquals(on.body.libraryBeta, true);
  assertEquals(on.body.library.entries.map((e: any) => e.name), ["Our American"]);
  assertEquals(on.body.library.fixtureLinks, { [U(31)]: U(605) });
  w.flag = "missing";
  const gone = await call({ action: "catalog" }, w);
  assertEquals(gone.status, 200, "the catalog loads on a database without 339");
  assertEquals([gone.body.libraryBeta, gone.body.library], [false, null]);
  w.flag = false;
  const off = await call({ action: "catalog" }, w);
  assertEquals([off.body.libraryBeta, off.body.library], [false, null]);
  assert(!off.t.reads.some((x) => x.table === "client_library"), "the entries are not even read with the flag off");
});

Deno.test("seed_mine never renames a label: a second course under the same name stays unlinked", async () => {
  const w = world();
  // Two styles show the same built-in name, one at the standard course and one at 8 in.
  w.tables.building_styles.push({ id: U(13), client_id: OWN, label: "Deluxe" });
  w.tables.style_cladding.push({ id: U(25), client_id: OWN, style_id: U(13), cladding_id: "lap", label_override: null, exposure_in: 8, rate: 0, active: true, client_library_id: null });
  const r = await call({ action: "library_seed_mine" }, w);
  assertEquals(r.status, 200);
  assertEquals(r.body.skipped, 1);
  const laps = w.tables.client_library.filter((x) => x.client_id === OWN && x.category === "cladding" && x.look.profile === "lap");
  assertEquals(laps.map((x) => x.name), ['7" LP Lap Siding'], "no renamed second entry");
  assertEquals(w.tables.style_cladding.find((x) => x.id === U(25))!.client_library_id, null, "that row keeps its label and stays unlinked");
});

Deno.test("a door made from a photo: library_add with a doorLookId, from this builder's ready look only", async () => {
  const w = world();
  const r = await call({ action: "library_add", doorLookId: LOOK_READY }, w);
  assertEquals(r.status, 200, JSON.stringify(r.body));
  assertEquals(r.body.entry.look, { doorStyle: "classic", doorLookId: LOOK_READY }, "drawn over the look's base, naming the look");
  assertEquals([r.body.entry.name, r.body.entry.templateId], ["Our photo door", null], "the look's own name, and no template");
  assertEquals(r.body.entry.doorLook, { thumbUrl: w.tables.door_looks[0].thumb_url, status: "ready", name: "Our photo door" });
  const named = await call({ action: "library_add", doorLookId: LOOK_READY, name: "  Barn   door from photo " }, w);
  assertEquals([named.status, named.body.entry?.name], [200, "Barn door from photo"], "a name of the builder's own, cleaned");
  const dup = await call({ action: "library_add", doorLookId: LOOK_READY, name: "our photo door" }, w);
  assertEquals([dup.status, dup.body.code], [409, "library_name_taken"]);
  for (const [id, status, code] of [[LOOK_DRAFT, 409, "library_door_look_not_ready"], [LOOK_OLD, 404, "library_door_look_not_found"], [LOOK_THEIRS, 404, "library_door_look_not_found"], ["not-a-uuid", 404, "library_door_look_not_found"]]) {
    const x = await call({ action: "library_add", doorLookId: id }, w);
    assertEquals([x.status, x.body.code], [status, code], String(id));
    assert(!x.t.writes.some((y) => y.table === "client_library"), "nothing written for " + id);
  }
  assertEquals(w.tables.client_library.filter((x) => x.client_id === OWN).length, 2, "two entries, both from the ready look");
  scopedToOwn(r.t);
  const lookRead = r.t.reads.find((x) => x.table === "door_looks")!;
  assert(lookRead.ops.some((o) => o[0] === "eq" && o[1] === "client_id" && o[2] === OWN), "the look is read in this builder's catalog only");
});

Deno.test("a door made from a photo: a database without 345 refuses in words; a template never takes a doorLookId", async () => {
  const w = world(); w.no345 = true;
  const r = await call({ action: "library_add", doorLookId: LOOK_READY }, w);
  assertEquals([r.status, r.body.code], [503, "library_door_looks_unavailable"], JSON.stringify(r.body));
  const w2 = world();
  const tpl = await call({ action: "library_add", templateId: T_AMERICAN, look: { doorStyle: "american", doorLookId: LOOK_READY } }, w2);
  assertEquals([tpl.status, tpl.body.code], [400, "library_bad_look"], "a template's copy can't name a builder's look");
});

Deno.test("a door made from a photo: the library read carries its tile, and it is rename-only", async () => {
  const w = world();
  w.tables.client_library.push(
    { id: U(611), client_id: OWN, category: "door", name: "Our photo door", look: { doorStyle: "classic", doorLookId: LOOK_READY }, library_item_id: null },
    { id: U(612), client_id: OWN, category: "door", name: "Our Classic", look: { doorStyle: "classic" }, library_item_id: null },
  );
  const lib = await call({ action: "library" }, w);
  assertEquals(lib.status, 200);
  const byName = Object.fromEntries(lib.body.entries.map((e: any) => [e.name, e]));
  assertEquals(byName["Our photo door"].doorLook, { thumbUrl: w.tables.door_looks[0].thumb_url, status: "ready", name: "Our photo door" });
  assert(!("doorLook" in byName["Our Classic"]), "an entry from a template carries no doorLook key");
  const rename = await call({ action: "library_edit", id: U(611), name: "Front door", look: { doorStyle: "classic", doorLookId: LOOK_READY } }, w);
  assertEquals(rename.status, 200, JSON.stringify(rename.body));
  assertEquals(rename.body.entry.name, "Front door");
  const up = rename.t.writes.find((x) => x.table === "client_library")!.row;
  assert(!("look" in up), "a rename sends the same look and writes no look");
  for (const look of [{ doorStyle: "dutch" }, { doorStyle: "classic" }, { doorStyle: "classic", doorLookId: LOOK_THEIRS }]) {
    const x = await call({ action: "library_edit", id: U(611), look }, w);
    assertEquals([x.status, x.body.code], [400, "library_door_look_fixed"], JSON.stringify(look));
    assert(!x.t.writes.some((y) => y.table === "client_library"), "nothing written");
  }
  const gain = await call({ action: "library_edit", id: U(612), look: { doorStyle: "classic", doorLookId: LOOK_READY } }, w);
  assertEquals(gain.status, 400, "an entry from a template never gains a look");
  scopedToOwn(lib.t);
});

Deno.test("save_fixture: one look per door row", async () => {
  const w = world();
  w.tables.client_library.push({ id: U(613), client_id: OWN, category: "door", name: "Our photo door", look: { doorStyle: "classic", doorLookId: LOOK_READY }, library_item_id: null });
  w.tables.fixture_items[0].door_look_id = LOOK_READY;
  const base = { action: "save_fixture", category: "door", id: U(31), name: "Double barn door", widthIn: 60, heightIn: 72, price: 300, opDouble: true, swingOut: true };
  const both = await call({ ...base, clientLibraryId: U(613), doorLookId: LOOK_READY }, w);
  assertEquals([both.status, both.body.code], [400, "door_one_look"], JSON.stringify(both.body));
  assert(!both.t.writes.some((x) => x.table === "fixture_items"), "nothing written");
  const link = await call({ ...base, doorStyle: "american", clientLibraryId: U(613) }, w);
  assertEquals(link.status, 200, JSON.stringify(link.body));
  const up = link.t.writes.find((x) => x.table === "fixture_items")!.row;
  assertEquals([up.client_library_id, up.door_style, up.door_look_id], [U(613), "classic", null], "the entry goes on, drawn over its base, and the row's own look comes off");
  scopedToOwn(link.t);
});
