// Each Colors page saves its OWN palette — driven through the SHIPPED portal-settings handler,
// and pinned against the SHIPPED browser source.
//
// WHY THIS EXISTS. Carolyn, 2026-10-30: "in the settings and the colors.. we need all the save
// colors to to work on their own page. currently the save on each page is saving all 3 pages."
// Settings → Colors is three pages (Paint, Shingles, Metal) over ONE `colors` table, and
// `save_colors` is a FULL-LIST REPLACE: every id it does not see is DELETED. So the fix had to be
// two halves that only work together, and the dangerous half is the sweep:
//
//   1. `section` narrows the delete sweep to the rows that page owns. A paint save never deletes
//      a shingle or metal colour, and never even names one in the delete.
//   2. A row that belongs to another section is SKIPPED under a scoped save, not written — the
//      sweep is narrowed on the stored flags, so a write it does not cover must not slip through.
//   3. No `section` (an older browser, or the combined view) still sweeps the whole palette, which
//      is what every caller before this change relied on.
//   4. The browser sends BOTH: only that section's rows AND `section`. A filtered list posted to a
//      server that ignores `section` wipes the other two pages, so the two are pinned together
//      here rather than trusted to stay in step.
//
// HOW. advancedModeSwitch_test's idiom: Deno.serve is stubbed while portal-settings/index.ts is
// imported, so a request goes through withErrorLog, resolveTenant and the save_colors branch
// exactly as it does live. The import map swaps supabase-js for supabase_stub.ts, whose stubDb hook
// routes every table call into the fake below. No --allow-net is granted: nothing here reaches a
// real database, and no builder's palette can be touched from this file.
//
// ⚠️ THE IMPORT SPECIFIER IS COMPUTED ON PURPOSE (see aiDraftStreamWiring_test): a literal one puts
// portal-settings in this file's type-checked graph against the stub's partial client type.
//
// Tenants, users and colour ids here are made up. The repo is public: no real client id belongs in
// a fixture.

// deno-lint-ignore-file no-explicit-any
import { assert, assertEquals } from "jsr:@std/assert";
import { stubAuth, stubDb } from "./supabase_stub.ts";

const read = async (rel: string) => (await Deno.readTextFile(new URL(rel, import.meta.url))).replace(/\r\n/g, "\n");
const CATALOG_SRC = await read("../../../../portal/03-catalog.jsx");

/** Whole-line comments dropped, so a comment naming a token cannot satisfy a check. */
const code = (s: string) => s.split("\n").filter((l) => !/^\s*(\/\/|\/\*|\*|\{\/\*)/.test(l)).join("\n");

function between(src: string, start: string, end: string, label: string): string {
  const i = src.indexOf(start);
  const j = i < 0 ? -1 : src.indexOf(end, i + start.length);
  if (i < 0 || j < 0) {
    throw new Error(`saveColorsSection_test: could not find ${label} (start=${i}, end=${j}). The anchors moved — re-point them rather than deleting this test.`);
  }
  return src.slice(i, j);
}

// ─── The real handler ──────────────────────────────────────────────────────────────────────────
const realServe = Deno.serve;
let loaded: ((req: Request) => Promise<Response>) | null = null;
(Deno as any).serve = (h: (req: Request) => Promise<Response>) => {
  loaded = h;
  return { finished: Promise.resolve() };
};
try {
  await import(new URL("../../portal-settings/index.ts", import.meta.url).href);
} finally {
  (Deno as any).serve = realServe;
}
if (!loaded) throw new Error("portal-settings/index.ts did not hand Deno.serve a handler");
const SETTINGS: (req: Request) => Promise<Response> = loaded;

// ─── The world one request runs in ─────────────────────────────────────────────────────────────
const OWN = "acme-sheds";
const USER_ID = "00000000-0000-4000-8000-0000000000c1";

// One stored palette across all three pages. `id` encodes the page only to keep the test readable.
const STORED = [
  { id: "paint-1", shingle: false, metal: false },
  { id: "paint-2", shingle: false, metal: false },
  { id: "shingle-1", shingle: true, metal: false },
  { id: "metal-1", shingle: false, metal: true },
];

type Trace = {
  writes: { table: string; verb: string; row: any; ops: any[][] }[];
  deleted: string[][];            // every .in("id", [...]) a delete carried, in order
  errors: Record<string, unknown>[];
};
const has = (ops: any[][], op: string) => ops.some((o) => o[0] === op);
const argOf = (ops: any[][], op: string) => (ops.find((o) => o[0] === op) ?? []).slice(1);
const eqOf = (ops: any[][], col: string) => (ops.find((o) => o[0] === "eq" && o[1] === col) ?? [])[2];

function answer(trace: Trace, table: string, ops: any[][]): any {
  const one = (row: unknown) => ({ data: row ?? null, error: null });
  switch (table) {
    case "client_users":
      if (eqOf(ops, "role") === "owner") return { data: [{ role: "owner", title: "owner", access: null }], error: null };
      return { data: [{ user_id: USER_ID, client_id: OWN, role: "owner", title: "owner", access: null }], error: null };
    case "app_operators":
      return one(null);
    case "client_configs":
      return one({ client_id: eqOf(ops, "client_id") ?? OWN });
    case "admin_audit":
      return { data: null, error: null };
    case "app_errors":
      trace.errors.push(argOf(ops, "insert")[0]);
      return { data: null, error: null };
    case "colors": {
      if (has(ops, "delete")) {
        const ids = (ops.find((o) => o[0] === "in" && o[1] === "id") ?? [])[2];
        trace.deleted.push((ids ?? []) as string[]);
        return { data: null, error: null };
      }
      if (has(ops, "insert") || has(ops, "update")) return { data: null, error: null };
      const cols = String(argOf(ops, "select")[0] ?? "");
      // The sweep's own read. It must carry the flags: the section a colour belongs to is not a
      // column, it is derived from them, so an `id`-only select cannot narrow the sweep at all.
      assert(/\bshingle\b/.test(cols) && /\bmetal\b/.test(cols),
        `the existing-colours read must select the section flags, got "${cols}"`);
      return { data: STORED.map((r) => ({ ...r })), error: null };
    }
  }
  throw new Error(`the fake database has no answer for ${table} ${JSON.stringify(ops)}`);
}

function chain(trace: Trace, table: string, ops: any[][]): any {
  const next = (op: any[]) => chain(trace, table, [...ops, op]);
  const q: any = {};
  for (const m of ["select", "insert", "update", "delete", "upsert", "eq", "neq", "gt", "gte", "lt", "is", "in", "not", "or", "limit", "order", "single", "maybeSingle"]) {
    q[m] = (...a: unknown[]) => next([m, ...a]);
  }
  q.then = (ok: any, bad: any) => {
    const verb = ops.find((o) => ["insert", "update", "delete", "upsert"].includes(o[0]))?.[0];
    if (verb && table !== "admin_audit" && table !== "app_errors") {
      trace.writes.push({ table, verb, row: argOf(ops, verb)[0], ops });
    }
    return Promise.resolve().then(() => answer(trace, table, ops)).then(ok, bad);
  };
  return q;
}

const ENV: Record<string, string> = {
  SUPABASE_URL: "https://stub.supabase.co",
  SUPABASE_ANON_KEY: "stub-anon",
  SUPABASE_SERVICE_ROLE_KEY: "stub-service",
};

async function save(body: Record<string, unknown>) {
  const trace: Trace = { writes: [], deleted: [], errors: [] };
  const savedEnv = Object.fromEntries(Object.keys(ENV).map((k) => [k, Deno.env.get(k)]));
  for (const [k, v] of Object.entries(ENV)) Deno.env.set(k, v);
  const realFetch = globalThis.fetch;
  stubAuth.user = { id: USER_ID, email: "someone@example.test" };
  stubAuth.error = null;
  stubDb.from = (table: string) => chain(trace, table, []);
  globalThis.fetch = ((input: string | URL | Request) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    return Promise.reject(new Error(`TEST FAILURE: unexpected fetch to ${url}`));
  }) as typeof fetch;
  try {
    const res = await SETTINGS(new Request("https://stub.supabase.co/functions/v1/portal-settings", {
      method: "POST",
      headers: { authorization: "Bearer harness", "content-type": "application/json", "user-agent": "harness/1.0" },
      body: JSON.stringify({ action: "save_colors", ...body }),
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

/** A colour as the browser posts one. `code` is required on anything that reaches a serial (316). */
const paint = (over: Record<string, unknown> = {}) => ({
  label: "Barn Red", siding: true, trim: true, shingle: false, metal: false, door: false,
  allowCustom: false, isDefault: false, active: true, sortOrder: 0, hex: "#8B1A1A",
  pricingMethod: "each", rate: 0, doorRate: 0, taxable: true, code: "BR", ...over,
});
const shingle = (over: Record<string, unknown> = {}) =>
  paint({ label: "Weathered Wood", siding: false, trim: false, shingle: true, code: "WW", ...over });
const metal = (over: Record<string, unknown> = {}) =>
  paint({ label: "Galvalume", siding: false, trim: false, metal: true, code: "GV", ...over });

// ─── 1. A scoped save sweeps only its own page ─────────────────────────────────────────────────
Deno.test("saving Paint deletes a removed paint colour and never names a shingle or metal one", async () => {
  // paint-1 kept, paint-2 dropped from the page. Shingle and metal are not in the payload at all,
  // which before this change is exactly what deleted them.
  const r = await save({ section: "paint", colors: [paint({ id: "paint-1" })] });
  assertEquals(r.status, 200);
  assertEquals(r.body.deleted, 1);
  assertEquals(r.trace.deleted, [["paint-2"]], `only the dropped paint row: ${JSON.stringify(r.trace.deleted)}`);
  const swept = r.trace.deleted.flat();
  for (const id of ["shingle-1", "metal-1"]) {
    assert(!swept.includes(id), `${id} must never reach a paint page's delete`);
  }
});

Deno.test("saving Shingles leaves both paint colours and the metal colour alone", async () => {
  const r = await save({ section: "shingle", colors: [shingle({ id: "shingle-1" })] });
  assertEquals(r.status, 200);
  // Nothing of this page's was dropped, so there is no delete at all.
  assertEquals(r.trace.deleted, []);
  assertEquals(r.body.deleted, 0);
  assertEquals(r.trace.writes.map((w) => w.verb), ["update"]);
  assertEquals(eqOf(r.trace.writes[0].ops, "id"), "shingle-1");
});

Deno.test("an empty Metal page deletes only the metal colour", async () => {
  const r = await save({ section: "metal", colors: [] });
  assertEquals(r.status, 200);
  assertEquals(r.trace.deleted, [["metal-1"]]);
  assertEquals(r.trace.writes.filter((w) => w.verb !== "delete"), []);
});

// ─── 2. A row from another page cannot slip through a scoped save ──────────────────────────────
Deno.test("a shingle row posted to the Paint page is skipped, not written", async () => {
  const r = await save({ section: "paint", colors: [paint({ id: "paint-1" }), paint({ id: "paint-2" }), shingle({ id: "shingle-1" })] });
  assertEquals(r.status, 200);
  assertEquals(r.body.saved, 2);
  assert(r.body.skipped.some((s: string) => /shingle/.test(s) && /not paint/.test(s)),
    `the skip names where the row belongs: ${JSON.stringify(r.body.skipped)}`);
  // Only the two paint rows were written, and the shingle row was not swept either.
  assertEquals(r.trace.writes.map((w) => eqOf(w.ops, "id")).sort(), ["paint-1", "paint-2"]);
  assertEquals(r.trace.deleted, []);
});

// ─── 3. No section is still the whole palette ──────────────────────────────────────────────────
Deno.test("without a section the sweep is the whole palette, exactly as before", async () => {
  const r = await save({ colors: [paint({ id: "paint-1" })] });
  assertEquals(r.status, 200);
  assertEquals(r.trace.deleted.length, 1);
  assertEquals([...r.trace.deleted[0]].sort(), ["metal-1", "paint-2", "shingle-1"]);
});

Deno.test('section "all" is the same as sending none', async () => {
  const r = await save({ section: "all", colors: [paint({ id: "paint-1" })] });
  assertEquals(r.status, 200);
  assertEquals([...r.trace.deleted[0]].sort(), ["metal-1", "paint-2", "shingle-1"]);
});

// ─── 4. A section nobody has heard of is refused with nothing touched ──────────────────────────
Deno.test("an unknown section is a 400 and writes nothing", async () => {
  const r = await save({ section: "siding", colors: [] });
  assertEquals(r.status, 400);
  assert(/siding/.test(String(r.body.error)), r.body.error);
  assertEquals(r.trace.writes, []);
  assertEquals(r.trace.deleted, []);
  // A refusal is not a fault: nothing is filed in app_errors.
  assertEquals(r.trace.errors, []);
});

// ─── 5. The browser half, pinned to the same change ────────────────────────────────────────────
Deno.test("the Colors page posts its own section and only its own rows", () => {
  const src = code(between(CATALOG_SRC, "const save = async (ckey) => {", "const errStyle =", "ColorsView.save"));
  assert(/action:\s*"save_colors",\s*section:\s*ckey/.test(src),
    "the save must name the section it is saving, or the server sweeps the whole palette");
  assert(/const mine = rows[\s\S]*?filter\(\(\{ r \}\) => catOf\(r\) === ckey\)/.test(src),
    "only this section's rows may be sent");
  assert(/const colors = mine\.map\(/.test(src), "the payload is built from the filtered rows, not from `rows`");
  assert(!/\brows\.map\(|\brows\.forEach\(|\brows\.filter\(/.test(src.replace(/const mine = rows[^\n]*\n/, "")),
    "nothing in the save may still walk the whole buffer");
  assert(/await load\(ckey\)/.test(src),
    "the refresh is scoped too, or unsaved edits on the other two pages are silently discarded");
});

Deno.test("the Save button is per-section and labelled for its own palette", () => {
  const src = code(CATALOG_SRC);
  assert(/onClick=\{\(\) => save\(ckey\)\}/.test(src), "each card's Save button saves its own section");
  assert(/const saveLabel = `Save \$\{SECTION_WORD\[ckey\] \|\| ckey\} colors`/.test(src),
    "the label names the palette, so three pages no longer show one identical button");
});
