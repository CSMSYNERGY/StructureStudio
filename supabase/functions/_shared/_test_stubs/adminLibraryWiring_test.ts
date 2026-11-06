// Admin → Master Catalog → Library and Library requests (migration 339; plan §1 step 6), driven through
// the SHIPPED admin-catalog handler:
//   * operator-only: a builder's session and a support operator are refused at the gate; a read-only
//     operator reads the library and the queue but cannot write; a refund needs the money grant;
//   * a template: added as version 1 from CSM, every edit bumps the version, a cladding keeps its
//     profile, archiving is an edit, an invalid look is refused, and no builder's copy moves;
//   * the queue: lists every builder's requests with their company, signs photo links only inside that
//     builder's own requests folder, moves a request to done with a result template and a copy in the
//     builder's library (named as they asked, made unique), and refuses a template of another kind;
//   * a refund credits the builder's wallet once per amount, never more than was charged, with a reason.
//   * doors builders made from photos (347): operators list every builder's READY look with its company;
//     promoting one copies its spec and tile into a template under a NEW name, with no builder id or name
//     on the row (the audit row says where it came from), a free slug, read-only operators refused; the
//     list then says it is in the library; a promoted template keeps its look but renames and archives.
//
// HOW. deleteClientHarness's loader (Deno.serve stubbed while admin-catalog/index.ts is imported, the
// import map swapping supabase-js for supabase_stub.ts) and an in-memory fake for every table, rpc and
// bucket. The caller authenticates with an operator JWT (stubAuth). No --allow-net. Made-up tenants.

// deno-lint-ignore-file no-explicit-any
import { assert, assertEquals } from "jsr:@std/assert";
import { stubAuth, stubDb, stubRpc, stubStorage } from "./supabase_stub.ts";
import { loadAdminCatalog } from "./deleteClientHarness.ts";

const ADMIN = await loadAdminCatalog(false);
const A = "acme-sheds", B = "bravo-barns";
const OP_ID = "00000000-0000-4000-8000-0000000000c1";
const U = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const T_LAP = U(901), T_WIN = U(902), T_DOOR = U(903);
const L_READY = U(801), L_DRAFT = U(802), L_READY2 = U(803);

type Row = Record<string, any>;
type Op = { can_write: boolean; can_bill: boolean; support_only: boolean } | null;
type World = { op: Op; tables: Record<string, Row[]> };
type Trace = { writes: Array<{ table: string; verb: string; row: any }>; rpc: Array<{ fn: string; args: any }>; signed: string[]; copied: Array<[string, string]> };

function world(op: Op): World {
  return {
    op,
    tables: {
      library_items: [
        { id: T_LAP, category: "cladding", slug: "lap", name: '7" LP Lap Siding', look: { profile: "lap" }, version: 1, status: "active", source: "builtin", sort_order: 10, search_terms: ["lap"] },
        { id: T_WIN, category: "window", slug: "four-lite", name: "4-lite", look: { liteRows: 2, liteCols: 2 }, version: 1, status: "active", source: "builtin", sort_order: 10, search_terms: [] },
        { id: T_DOOR, category: "door", slug: "american", name: "American (built in 3D)", look: { doorStyle: "american" }, version: 1, status: "active", source: "builtin", sort_order: 10, search_terms: [] },
      ],
      client_library: [
        { id: U(501), client_id: A, category: "cladding", name: "Our lap", look: { profile: "lap", exposureIn: 7 }, library_item_id: T_LAP, template_version: 1 },
        { id: U(502), client_id: A, category: "window", name: "Arched window", look: {}, library_item_id: null, template_version: null },
      ],
      library_requests: [
        { id: U(601), client_id: A, category: "window", status: "submitted", name: "Arched window", photos: [{ path: `${A}/requests/${U(1)}.jpg`, role: "front" }, { path: `${B}/requests/${U(2)}.jpg`, role: "front" }], charged_cents: 200, refunded_cents: 0, created_at: "2026-10-27T10:00:00Z", updated_at: "2026-10-27T10:00:00Z" },
        { id: U(602), client_id: B, category: "cladding", status: "in_progress", name: "Stone veneer", photos: [], charged_cents: 0, refunded_cents: 0, created_at: "2026-10-27T11:00:00Z", updated_at: "2026-10-27T11:00:00Z" },
      ],
      client_configs: [{ client_id: A, company_name: "Acme Sheds" }, { client_id: B, company_name: "Bravo Barns" }],
      door_looks: [
        { id: L_READY, client_id: B, name: "Bravo ranch door", base: "zbrace", spec: { v: 1, base: "zbrace", src: { leaves: 1, hinge: "left" }, brace: { t: "z", from: "hinge" } }, spec_version: 1, status: "ready", thumb_url: `https://stub.supabase.co/storage/v1/object/public/fixtures/${B}/door-look-${U(3)}.png`, ai_call_id: U(4), updated_at: "2026-10-27T12:00:00Z" },
        { id: L_READY2, client_id: A, name: "Acme barn door", base: "zbrace", spec: { v: 1, base: "zbrace", src: { leaves: 1, hinge: "right" } }, spec_version: 1, status: "ready", thumb_url: "https://elsewhere.example.test/a.png", ai_call_id: U(6), updated_at: "2026-10-27T11:00:00Z" },
        { id: L_DRAFT, client_id: A, name: "Acme draft", base: "plank", spec: { v: 1, base: "plank", src: { leaves: 1, hinge: "left" } }, spec_version: 1, status: "draft", thumb_url: null, ai_call_id: U(5), updated_at: "2026-10-27T12:30:00Z" },
      ],
      admin_audit: [],
    },
  };
}

const has = (ops: any[][], op: string) => ops.some((o) => o[0] === op);
const argOf = (ops: any[][], op: string) => (ops.find((o) => o[0] === op) ?? []).slice(1);
function matches(r: Row, ops: any[][]): boolean {
  for (const o of ops) {
    if (o[0] === "eq" && r[o[1]] !== o[2]) return false;
    if (o[0] === "in" && !(o[2] as unknown[]).includes(r[o[1]])) return false;
    if (o[0] === "is" && o[2] === null && r[o[1]] != null) return false;
    if (o[0] === "not" && o[2] === "is" && o[3] === null && r[o[1]] == null) return false;
  }
  return true;
}
let seq = 700;
function answer(w: World, t: Trace, table: string, ops: any[][]): any {
  const verb = ["upsert", "insert", "update", "delete"].find((v) => has(ops, v));
  const single = has(ops, "single") || has(ops, "maybeSingle");
  const out = (rows: Row[]) => (single ? { data: rows[0] ?? null, error: null } : { data: rows, error: null });
  if (table === "app_operators") return { data: w.op ? { user_id: OP_ID, email: "ops@example.test", ...w.op } : null, error: null };
  if (table === "app_errors" || table === "admin_auth_attempts") return { data: null, error: null };
  // admin_audit keeps its rows: the promoted doors list reads them back (347).
  if (table === "admin_audit" && !has(ops, "insert") && !has(ops, "select")) return { data: null, error: null };
  if (verb) t.writes.push({ table, verb, row: argOf(ops, verb)[0] });
  const rows = (w.tables[table] ??= []);
  if (verb === "insert") {
    const raw = argOf(ops, "insert")[0];
    const list: Row[] = (Array.isArray(raw) ? raw : [raw]).map((r: Row) => ({ id: U(seq++), version: 1, status: "active", ...r }));
    if (table === "library_items") {
      for (const r of list) if (rows.some((x) => x.category === r.category && x.slug === r.slug)) return { data: null, error: { code: "23505", message: "duplicate key value violates unique constraint \"library_items_slug_key\"" } };
    }
    rows.push(...list);
    return out(list);
  }
  const hit = rows.filter((r) => matches(r, ops));
  if (verb === "update") { for (const r of hit) Object.assign(r, argOf(ops, "update")[0]); return { ...out(hit), count: hit.length }; }
  return out(hit);
}
function chain(w: World, t: Trace, table: string, ops: any[][]): any {
  const q: any = {};
  for (const m of ["select", "insert", "update", "delete", "upsert", "eq", "neq", "is", "in", "not", "gte", "or", "limit", "order", "range", "single", "maybeSingle"]) {
    q[m] = (...a: unknown[]) => chain(w, t, table, [...ops, [m, ...a]]);
  }
  q.then = (ok: any, bad: any) => Promise.resolve().then(() => answer(w, t, table, ops)).then(ok, bad);
  return q;
}

const ENV: Record<string, string> = { SUPABASE_URL: "https://stub.supabase.co", SUPABASE_ANON_KEY: "stub-anon", SUPABASE_SERVICE_ROLE_KEY: "stub-service" };
async function call(body: Record<string, unknown>, w: World) {
  const t: Trace = { writes: [], rpc: [], signed: [], copied: [] };
  const saved = Object.fromEntries(Object.keys(ENV).map((k) => [k, Deno.env.get(k)]));
  for (const [k, v] of Object.entries(ENV)) Deno.env.set(k, v);
  stubAuth.user = { id: OP_ID, email: "ops@example.test" };
  stubAuth.error = null;
  stubDb.from = (table: string) => chain(w, t, table, []);
  stubRpc.rpc = (fn: string, args?: any) => { t.rpc.push({ fn, args }); return Promise.resolve({ data: 1234, error: null }); };
  stubStorage.from = (bucket: string) => ({
    createSignedUrl: (path: string) => { t.signed.push(`${bucket}:${path}`); return Promise.resolve({ data: { signedUrl: `https://signed.example.test/${path}` }, error: null }); },
    copy: (from: string, to: string) => { t.copied.push([`${bucket}:${from}`, `${bucket}:${to}`]); return Promise.resolve({ data: { path: to }, error: null }); },
    getPublicUrl: (p: string) => ({ data: { publicUrl: `https://stub.supabase.co/storage/v1/object/public/${bucket}/${p}` } }),
    remove: (paths: string[]) => { t.copied.push([`${bucket}:removed`, paths.join(",")]); return Promise.resolve({ data: [], error: null }); },
  });
  try {
    const res = await ADMIN(new Request("https://stub.supabase.co/functions/v1/admin-catalog", {
      method: "POST",
      headers: { authorization: "Bearer operator-session", "content-type": "application/json" },
      body: JSON.stringify(body),
    }));
    return { status: res.status, body: await res.json(), t };
  } finally {
    stubDb.from = null; stubRpc.rpc = null; stubStorage.from = null; stubAuth.user = null;
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) Deno.env.delete(k); else Deno.env.set(k, v); }
  }
}
const FULL: Op = { can_write: true, can_bill: true, support_only: false };

Deno.test("operator-only: a builder and a support operator are refused; read-only reads but cannot write; refunds need can_bill", async () => {
  const builder = await call({ action: "library_items_list" }, world(null));
  assertEquals(builder.status, 403, "a builder's session is not an operator");
  const support = await call({ action: "library_requests_list" }, world({ can_write: true, can_bill: true, support_only: true }));
  assertEquals(support.status, 403, "a support operator is not an admin");
  const ro = world({ can_write: false, can_bill: false, support_only: false });
  assertEquals((await call({ action: "library_items_list" }, ro)).status, 200);
  assertEquals((await call({ action: "library_requests_list" }, ro)).status, 200);
  const roWrite = await call({ action: "library_item_save", id: T_LAP, name: "Lap" }, ro);
  assertEquals(roWrite.status, 403);
  assertEquals(roWrite.t.writes.filter((x) => x.table === "library_items").length, 0);
  const noBill = await call({ action: "library_request_refund", id: U(601), reason: "test" }, world({ can_write: true, can_bill: false, support_only: false }));
  assertEquals(noBill.status, 403);
  assert(!noBill.t.rpc.some((x) => x.fn === "wallet_credit"), "no money moved");
});

Deno.test("templates: add is CSM version 1, edits bump the version, a cladding keeps its profile, builders' copies never move", async () => {
  const w = world(FULL);
  const add = await call({ action: "library_item_save", category: "window", name: "12-lite (3 by 4)", look: { liteRows: 3, liteCols: 4 }, searchTerms: "12 lite, colonial, 12 lite" }, w);
  assertEquals(add.status, 200, JSON.stringify(add.body));
  const made = w.tables.library_items.find((x) => x.name === "12-lite (3 by 4)")!;
  assertEquals([made.source, made.slug, made.search_terms], ["csm", "12-lite-3-by-4", ["12 lite", "colonial"]]);
  const ed = await call({ action: "library_item_save", id: T_LAP, description: "Horizontal boards.", searchTerms: ["lap", "engineered wood"] }, w);
  assertEquals(ed.status, 200);
  assertEquals(w.tables.library_items.find((x) => x.id === T_LAP)!.version, 2);
  const swap = await call({ action: "library_item_save", id: T_LAP, look: { profile: "panel" } }, w);
  assertEquals(swap.status, 400, "a cladding template keeps its profile");
  const bad = await call({ action: "library_item_save", id: T_WIN, look: { liteRows: 9, liteCols: 1 } }, w);
  assertEquals(bad.status, 400, "a grid over 8 is refused");
  const arch = await call({ action: "library_item_save", id: T_WIN, status: "archived" }, w);
  assertEquals([arch.status, w.tables.library_items.find((x) => x.id === T_WIN)!.status, w.tables.library_items.find((x) => x.id === T_WIN)!.version], [200, "archived", 2]);
  assertEquals(w.tables.client_library.find((x) => x.id === U(501))!.look, { profile: "lap", exposureIn: 7 }, "a builder's copy did not move");
  assert(!add.t.writes.concat(ed.t.writes, arch.t.writes).some((x) => x.table === "client_library"), "no template edit writes a builder's library");
  const list = await call({ action: "library_items_list" }, w);
  assertEquals(list.body.items.find((x: any) => x.id === T_LAP).copies, 1);
});

Deno.test("the queue: every builder's requests, photo links only in that builder's folder", async () => {
  const r = await call({ action: "library_requests_list" }, world(FULL));
  assertEquals(r.status, 200);
  assertEquals(r.body.requests.map((x: any) => [x.clientId, x.companyName, x.status]), [[A, "Acme Sheds", "submitted"], [B, "Bravo Barns", "in_progress"]]);
  const a = r.body.requests[0];
  assertEquals(a.photos.map((p: any) => p.url !== null), [true, false], "a path outside the request's own builder's folder is never signed");
  assertEquals(r.t.signed, [`library-refs:${A}/requests/${U(1)}.jpg`]);
});

Deno.test("done with a result: the template is linked and a copy lands in that builder's library under a unique name", async () => {
  const w = world(FULL);
  const wrongKind = await call({ action: "library_request_set", id: U(601), status: "done", resultItemId: T_DOOR }, w);
  assertEquals(wrongKind.status, 400, "a door template cannot answer a window request");
  const r = await call({ action: "library_request_set", id: U(601), status: "done", resultItemId: T_WIN, addToBuilder: true, resultNote: "Added as a 4-lite grid." }, w);
  assertEquals(r.status, 200, JSON.stringify(r.body));
  const req = w.tables.library_requests.find((x) => x.id === U(601))!;
  assertEquals([req.status, req.result_library_item_id, req.result_note], ["done", T_WIN, "Added as a 4-lite grid."]);
  const copy = w.tables.client_library.find((x) => x.id === req.result_client_library_id)!;
  assertEquals([copy.client_id, copy.category, copy.name, copy.library_item_id], [A, "window", "Arched window (2)", T_WIN], "the builder already had that name");
  assertEquals(copy.look, { liteRows: 2, liteCols: 2 });
  const back = await call({ action: "library_request_set", id: U(601), status: "in_progress" }, w);
  assertEquals([back.status, w.tables.library_requests.find((x) => x.id === U(601))!.decided_at], [200, null]);
  const unknown = await call({ action: "library_request_set", id: U(601), status: "paused" }, w);
  assertEquals(unknown.status, 400);
});

Deno.test("a refund: credited to that builder, never more than charged, once per amount, with a reason", async () => {
  const w = world(FULL);
  const noReason = await call({ action: "library_request_refund", id: U(601), reason: "" }, w);
  assertEquals(noReason.status, 400);
  const tooMuch = await call({ action: "library_request_refund", id: U(601), amountCents: 300, reason: "Refused: not a window" }, w);
  assertEquals(tooMuch.status, 400);
  const r = await call({ action: "library_request_refund", id: U(601), reason: "Refused: not a window" }, w);
  assertEquals(r.status, 200, JSON.stringify(r.body));
  const cr = r.t.rpc.find((x) => x.fn === "wallet_credit")!;
  assertEquals([cr.args.p_client_id, cr.args.p_amount_cents, cr.args.p_kind, cr.args.p_idem], [A, 200, "refund", `libreq-refund:${U(601)}:200`]);
  assertEquals(w.tables.library_requests.find((x) => x.id === U(601))!.refunded_cents, 200);
  const again = await call({ action: "library_request_refund", id: U(601), reason: "again" }, w);
  assertEquals(again.status, 400, "nothing left to refund");
  const free = await call({ action: "library_request_refund", id: U(602), reason: "x" }, w);
  assertEquals(free.status, 400, "nothing was charged");
});

Deno.test("doors builders made from photos: operators see every builder's ready look; promoting copies it with no builder on the template", async () => {
  const w = world(FULL);
  const list = await call({ action: "library_door_looks_list" }, w);
  assertEquals(list.status, 200, JSON.stringify(list.body));
  assertEquals(list.body.looks.map((l: any) => [l.name, l.companyName, l.base, l.fromPhoto, l.promotedItemId]),
    [["Bravo ranch door", "Bravo Barns", "zbrace", true, null], ["Acme barn door", "Acme Sheds", "zbrace", true, null]], "ready looks only, with their builder");
  const ro = world({ can_write: false, can_bill: false, support_only: false });
  assertEquals((await call({ action: "library_door_looks_list" }, ro)).status, 200, "a read-only operator may look");
  const roP = await call({ action: "library_door_look_promote", doorLookId: L_READY, name: "Ranch Z door" }, ro);
  assertEquals(roP.status, 403, "...but not promote");
  assertEquals(roP.t.writes.filter((x) => x.table === "library_items").length, 0);
  const noName = await call({ action: "library_door_look_promote", doorLookId: L_READY, name: "  " }, w);
  assertEquals(noName.status, 400, "a StructureStudio name is required");
  const long = await call({ action: "library_door_look_promote", doorLookId: L_READY, name: "x".repeat(61) }, w);
  assertEquals(long.status, 400, "60 characters at most: builders import it under this name");
  const longDesc = await call({ action: "library_door_look_promote", doorLookId: L_READY, name: "Ranch Z door", description: "y".repeat(601) }, w);
  assertEquals(longDesc.status, 400);
  assertEquals(longDesc.t.copied.length, 0, "a refused promote copies no tile");
  const draft = await call({ action: "library_door_look_promote", doorLookId: L_DRAFT, name: "Draft door" }, w);
  assertEquals(draft.status, 404, "a draft is not promoted");

  const p = await call({ action: "library_door_look_promote", doorLookId: L_READY, name: "Ranch Z door", description: "Boards with a Z brace and T-straps.", searchTerms: "barn, ranch, z brace" }, w);
  assertEquals(p.status, 200, JSON.stringify(p.body));
  const made = w.tables.library_items.find((x) => x.name === "Ranch Z door")!;
  assertEquals([made.category, made.source, made.slug, made.look, made.leaves], ["door", "csm", "ranch-z-door", { doorStyle: "zbrace" }, 1]);
  assertEquals(made.door_spec, w.tables.door_looks[0].spec, "the builder's spec, as saved");
  assert(!JSON.stringify(made).includes(B) && !JSON.stringify(made).includes("Bravo"), "no builder id or name on the template: " + JSON.stringify(made));
  assertEquals(p.t.copied.length, 1, "the tile is copied");
  assert(p.t.copied[0][0] === `fixtures:${B}/door-look-${U(3)}.png` && /^fixtures:library\/door-[0-9a-f-]{36}\.png$/.test(p.t.copied[0][1]), JSON.stringify(p.t.copied));
  assert(/\/public\/fixtures\/library\/door-/.test(made.thumb_url), "the template shows the StructureStudio copy: " + made.thumb_url);
  assertEquals(p.body.tileCopied, true);
  const audit = w.tables.admin_audit.find((x) => x.action === "library_door_look_promote")!;
  assert(audit && audit.target_client_id === B && audit.note.includes(`look=${L_READY}`) && audit.note.includes(`item=${made.id}`), "where it came from is in the audit row only");

  const again = await call({ action: "library_door_looks_list" }, w);
  assertEquals(again.body.looks[0].promotedItemId, made.id, "the list says it is in the library");
  const twice = await call({ action: "library_door_look_promote", doorLookId: L_READY, name: "Ranch Z door, again" }, w);
  assertEquals([twice.status, twice.body.code, twice.body.itemId], [409, "library_door_look_promoted", made.id], "a door is promoted once");
  assertEquals(twice.t.copied.length, 0, "...and copies no tile");
  const other = await call({ action: "library_door_look_promote", doorLookId: L_READY2, name: "Ranch Z door" }, w);
  assertEquals(other.status, 200, "another door under the same name takes a free slug");
  assertEquals(w.tables.library_items.filter((x) => x.name === "Ranch Z door").map((x) => x.slug), ["ranch-z-door", "ranch-z-door-2"]);
  assertEquals([other.body.tileCopied, other.t.copied.length], [false, 0], "a tile from anywhere but our own storage is not copied");
  // A builder's imported COPY of the promoted door is shown as in the library, and never offered again.
  w.tables.door_looks.push({ id: U(804), client_id: A, name: "Our Ranch Z", base: "zbrace", spec: made.door_spec, spec_version: 1, status: "ready", thumb_url: made.thumb_url, ai_call_id: null, updated_at: "2026-10-27T13:00:00Z" });
  w.tables.client_library.push({ id: U(505), client_id: A, category: "door", name: "Our Ranch Z", look: { doorStyle: "zbrace", doorLookId: U(804) }, library_item_id: made.id, template_version: 1 });
  const withCopy = await call({ action: "library_door_looks_list" }, w);
  assertEquals(withCopy.body.looks.find((l: any) => l.id === U(804)).promotedItemId, made.id, "a copy shows as in the library");
  const copyP = await call({ action: "library_door_look_promote", doorLookId: U(804), name: "Copy of a copy" }, w);
  assertEquals([copyP.status, copyP.body.code], [409, "library_door_look_promoted"], "a copy is never promoted again");
  // A door request is never closed with a promoted door (that would be a plain entry on it).
  w.tables.library_requests.push({ id: U(603), client_id: A, category: "door", status: "in_progress", name: "Ranch door", photos: [], charged_cents: 0, refunded_cents: 0, created_at: "2026-10-27T11:30:00Z", updated_at: "2026-10-27T11:30:00Z" });
  const req = await call({ action: "library_request_set", id: U(603), status: "done", resultItemId: made.id, addToBuilder: true }, w);
  assertEquals(req.status, 400, "a promoted door is not a request's result");
  assert(!w.tables.client_library.some((x) => x.library_item_id === made.id && x.client_id === A && !x.look?.doorLookId), "no plain entry on a promoted door");

  const items = await call({ action: "library_items_list" }, w);
  assertEquals(items.status, 200);
  const byName = Object.fromEntries(items.body.items.map((x: any) => [x.slug, x]));
  assertEquals([byName["ranch-z-door"].fromPhoto, byName["american"].fromPhoto], [true, false]);
  const move = await call({ action: "library_item_save", id: made.id, look: { doorStyle: "classic" } }, w);
  assertEquals([move.status, move.body.code], [400, "library_promoted_look_fixed"], "a promoted door keeps its look");
  const rename = await call({ action: "library_item_save", id: made.id, name: "Ranch Z barn door", look: { doorStyle: "zbrace" } }, w);
  assertEquals(rename.status, 200, "...but renames (the editor's own look sent back is fine)");
  const plain = await call({ action: "library_item_save", id: T_DOOR, look: { doorStyle: "classic" } }, w);
  assertEquals(plain.status, 200, "a built-in door template still changes its look");
});
