// The pricing-sheet importer writes a sheet in bulk since 2026-10-28 (_shared/pricingImport.ts).
// Before that it made one database call per size and one per option cell, and a builder's
// ~210-size, ~38-column sheet died every time on the edge function's CPU limit (546).
//
// WHAT IS PINNED:
//   1. Both callers (portal-settings, admin-catalog) use the one shared copy; neither keeps its own.
//   2. SAME RESULT AS BEFORE. On a few hundred generated sheets (blank lines, unknown and ambiguous
//      styles, bad sizes and prices, the same size twice, legacy "yes" cells, partition walls,
//      blank cells over options on file) the bulk importer returns the same counts and skipped
//      lines as the row-at-a-time importer (frozen in pricingImportLegacy.ts) and leaves the
//      tables holding the same thing.
//   3. A FEW CALLS, NOT ONE PER CELL: a sheet shaped like the one that failed, and three times it,
//      lands in a bounded handful of statements.
//   4. A batch that fails is replayed one row at a time, so the same per-row skipped lines come
//      back and the rest of the sheet still lands.
//   5. RETRY-SAFE: the same sheet sent twice makes nothing twice.
//   6. A catalog past PostgREST's 1000-row read is read whole, so blank cells still remove
//      options on file and legacy "yes" cells still keep their quantity on every size.
//
// The tables are an in-memory fake (pricingImportFake.ts). Tenants, styles and prices are made up;
// the repo is public.

// deno-lint-ignore-file no-explicit-any
import { assert, assertEquals } from "jsr:@std/assert";
import { importPricingRows } from "../pricingImport.ts";
import { legacyImportPricingRows } from "./pricingImportLegacy.ts";
import { fakeDb, snapshot, type Tables } from "./pricingImportFake.ts";

const CLIENT = "acme-sheds";
const read = async (rel: string) => (await Deno.readTextFile(new URL(rel, import.meta.url))).replace(/\r\n/g, "\n");
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v));

/** Run both importers on copies of the same tables and sheet; return both results and tables. */
async function both(seed: Partial<Tables>, rows: any[], opts: Parameters<typeof fakeDb>[1] = {}) {
  const a = fakeDb(clone(seed), opts), b = fakeDb(clone(seed), opts);
  const legacy = await legacyImportPricingRows(a.sb, CLIENT, clone(rows));
  const bulk = await importPricingRows(b.sb, CLIENT, clone(rows));
  return { legacy, bulk, legacyDb: a, bulkDb: b };
}
function assertSame(r: Awaited<ReturnType<typeof both>>, note = "") {
  assertEquals(r.bulk, r.legacy, `result differs ${note}`);
  assertEquals(snapshot(r.bulkDb.tables), snapshot(r.legacyDb.tables), `tables differ ${note}`);
}

// ── 1. wiring ─────────────────────────────────────────────────────────────────────────────────
for (const fn of ["portal-settings", "admin-catalog"]) {
  Deno.test(`${fn} imports the shared importer and keeps no copy of its own`, async () => {
    const src = await read(`../../${fn}/index.ts`);
    assert(src.includes(`import { importPricingRows } from "../_shared/pricingImport.ts";`), `${fn} must import _shared/pricingImport.ts`);
    assert(!src.includes("async function importPricingRows("), `${fn} still carries its own importPricingRows`);
    assert(src.includes("await importPricingRows("), `${fn} no longer calls the importer`);
  });
}

// ── 2. same result as the row-at-a-time importer ──────────────────────────────────────────────
function rng(seed: number) {
  let s = seed >>> 0;
  return () => { s = (s + 0x6D2B79F5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const KEYS = ["loft", "workbench", "door-a", "door-b", "window-a"];
const CELLS: unknown[] = ["", "", "", "0", "no", "yes", "x", " Y ", "2", "50", "$1,200", true, "garbage", "-3", "1.6", undefined];

function scenario(seed: number) {
  const r = rng(seed);
  const pick = <T>(xs: T[]): T => xs[Math.floor(r() * xs.length)];
  const styles = [
    { client_id: CLIENT, id: "st-a", key: "utility", label: "Utility" },
    { client_id: CLIENT, id: "st-b", key: "lofted-barn", label: "Lofted Barn" },
    { client_id: CLIENT, id: "st-c", key: "cabin", label: "Cabin" },
  ];
  if (r() < 0.3) styles.push({ client_id: CLIENT, id: "st-d", key: "barn", label: "Barn" }, { client_id: CLIENT, id: "st-e", key: "barn-2", label: "Barn" });
  const W = [8, 10, 12, 14], L = [10, 12, 16, 20, 24];
  const sizes: any[] = [];
  for (const st of styles) {
    let sort = 0;
    for (const w of W) for (const l of L) {
      if (r() < 0.35) {
        const price = r() < 0.15 ? null : Math.round(r() * 9000) + 1000;
        sizes.push({ id: `sz-${st.id}-${w}-${l}`, client_id: CLIENT, style_id: st.id, label: `${w}x${l}`, width_ft: w, length_ft: l, base_price: price, active: price != null && r() < 0.8, sort_order: sort });
        sort += 1 + Math.floor(r() * 3);
      }
    }
  }
  const inclusions: any[] = [];
  for (const z of sizes) for (const k of KEYS) if (r() < 0.25) inclusions.push({ client_id: CLIENT, size_id: z.id, item_key: k, included: true, qty: 1 + Math.floor(r() * 60) });
  const styleCell = () => {
    const s = pick(styles);
    const name = r() < 0.5 ? s.label : s.key;
    return pick([name, name.toUpperCase(), `  ${name} `]);
  };
  const rows: any[] = [];
  const n = Math.floor(r() * 26);
  for (let i = 0; i < n; i++) {
    const kind = r();
    if (kind < 0.05) { rows.push({ style: "", width: "", length: "", price: "", active: "", inclusions: {} }); continue; }
    if (kind < 0.09) { rows.push({ style: "Greenhouse", width: "8", length: "10", price: "100", active: "", inclusions: {} }); continue; }
    if (kind < 0.12) { rows.push({ style: styleCell(), width: "", length: "", price: "100", active: "", inclusions: {} }); continue; }
    if (kind < 0.15) { rows.push({ style: styleCell(), width: pick(["abc", "-3", "0", "10"]), length: pick(["12", "0", "x"]), price: "100", active: "", inclusions: {} }); continue; }
    const w = pick([...W, 16]), l = pick([...L, 28]);
    const inc: Record<string, unknown> = {};
    for (const k of KEYS) { const v = pick(CELLS); if (v !== undefined) inc[k] = v; }
    if (r() < 0.2) inc.partitionWall = pick(["x", "1", "yes"]);
    if (r() < 0.05) inc[""] = "1";
    rows.push({
      style: styleCell(),
      width: pick([w, String(w), `${w}.0`]),
      length: pick([l, String(l), ` ${l} `]),
      price: pick(["", "0", "$4,995", "5200", 6100, "-10", "TBD", " 3,000 "]),
      active: pick(["", "yes", "no", "Y", "inactive", "0", undefined]),
      inclusions: inc,
    });
  }
  return { seed: { building_styles: styles, building_sizes: sizes, building_size_inclusions: inclusions }, rows };
}

Deno.test("generated sheets: the bulk importer ends exactly where the row-at-a-time one did", async () => {
  // Tallies, so the comparison cannot pass by both importers doing nothing.
  let created = 0, updated = 0, skipped = 0, cleared = 0;
  for (let s = 1; s <= 300; s++) {
    const { seed, rows } = scenario(s);
    const r = await both(seed, rows);
    assertSame(r, `(scenario ${s})`);
    created += r.bulk.created; updated += r.bulk.updated; skipped += r.bulk.skipped.length;
    cleared += r.bulkDb.calls.filter((c) => c.verb === "delete").length;
  }
  assert(created > 500 && updated > 500 && skipped > 300 && cleared > 100, JSON.stringify({ created, updated, skipped, cleared }));
});

Deno.test("the same size twice: the last row wins, counted created then updated", async () => {
  const seed = { building_styles: [{ client_id: CLIENT, id: "st-a", key: "utility", label: "Utility" }] };
  const rows = [
    { style: "Utility", width: "10", length: "12", price: "3000", active: "yes", inclusions: { loft: "50", workbench: "1" } },
    { style: "utility", width: 10, length: "12.0", price: "3200", active: "", inclusions: { loft: "" } },
  ];
  const r = await both(seed, rows);
  assertSame(r);
  assertEquals([r.bulk.created, r.bulk.updated, r.bulk.imported], [1, 1, 2]);
  const snap = snapshot(r.bulkDb.tables);
  assertEquals(snap.sizes.map(([, v]) => v.base_price), [3200]);
  assertEquals(snap.inclusions.map(([k, v]) => [k.split("|").pop(), v.qty]), [["workbench", 1]]);
});

// ── 3. a handful of statements, whatever the size of the sheet ───────────────────────────────
/** A tenant shaped like the one whose sheet failed: 13 styles, 38 option columns, ~210 sizes. */
function bigTenant() {
  const styles = Array.from({ length: 13 }, (_, i) => ({ client_id: CLIENT, id: `st-${i}`, key: `style-${i}`, label: `Style ${i}` }));
  const keys = [...Array.from({ length: 31 }, (_, i) => `00000000-0000-4000-8000-${String(900 + i).padStart(12, "0")}`),
    "loft", "workbench", "shelf", "window", "vent", "door", "porch"];
  const sizes: any[] = [], inclusions: any[] = [];
  styles.forEach((st, si) => {
    for (let k = 0; k < 16; k++) {
      const w = 8 + 2 * (k % 4), l = 10 + 2 * Math.floor(k / 4) + si % 2;
      const id = `sz-${si}-${k}`;
      sizes.push({ id, client_id: CLIENT, style_id: st.id, label: `${w}x${l}`, width_ft: w, length_ft: l, base_price: 2000 + 100 * k, active: true, sort_order: k });
      if (k % 2 === 0) inclusions.push({ client_id: CLIENT, size_id: id, item_key: keys[k % keys.length], included: true, qty: 1 });
      if (k % 3 === 0) inclusions.push({ client_id: CLIENT, size_id: id, item_key: "loft", included: true, qty: 48 });
    }
  });
  return { seed: { building_styles: styles, building_sizes: sizes, building_size_inclusions: inclusions }, keys, sizes };
}
/** One row per size on file plus `extra` new sizes per style; every option column filled in. */
function bigSheet(t: ReturnType<typeof bigTenant>, extra: number) {
  const rows: any[] = [];
  const cellsFor = (i: number) => Object.fromEntries(t.keys.map((k, j) => [k, (i + j) % 17 === 0 ? "1" : k === "loft" && i % 5 === 0 ? "yes" : (i + j) % 23 === 0 ? "48" : ""]));
  t.sizes.forEach((z, i) => rows.push({ style: `Style ${z.style_id.slice(3)}`, width: String(z.width_ft), length: String(z.length_ft), price: `$${(2500 + i).toLocaleString("en-US")}`, active: "yes", inclusions: cellsFor(i) }));
  for (let si = 0; si < 13; si++) for (let e = 0; e < extra; e++) {
    rows.push({ style: `Style ${si}`, width: String(20 + (e % 10) * 2), length: String(30 + Math.floor(e / 10) * 2), price: String(9000 + e), active: "", inclusions: cellsFor(e + si) });
  }
  return rows;
}

Deno.test("a sheet shaped like the one that failed: same result, a few statements instead of thousands", async () => {
  const t = bigTenant();
  const rows = bigSheet(t, 0);   // 208 rows x 38 option columns
  const r = await both(t.seed, rows);
  assertSame(r);
  assertEquals(r.bulk.skipped, []);
  const legacyCalls = r.legacyDb.calls.length, bulkCalls = r.bulkDb.calls.length;
  assert(legacyCalls > 7000, `the old importer should take one call per cell (took ${legacyCalls})`);
  // 3 reads, 1 size batch, 1 option upsert batch, and one DELETE per option the sheet clears.
  assert(bulkCalls <= 20, `bulk import took ${bulkCalls} statements`);
});

Deno.test("three times that sheet (624 rows, 416 of them new sizes) still lands in a few statements", async () => {
  const t = bigTenant();
  const rows = bigSheet(t, 32);
  assertEquals(rows.length, 624);
  const { sb, tables, calls } = fakeDb(clone(t.seed));
  const out = await importPricingRows(sb, CLIENT, rows);
  assertEquals([out.created, out.updated, out.skipped], [416, 208, []]);
  assertEquals(tables.building_sizes.length, 624);
  assert(calls.length <= 25, `bulk import took ${calls.length} statements: ${JSON.stringify(calls)}`);
  // Nothing was written one row at a time, and DELETEs grow with the options cleared, not the cells.
  assertEquals(calls.filter((c) => c.verb !== "select" && !c.bulk), []);
  assert(calls.filter((c) => c.verb === "delete").length <= t.keys.length, "at most one DELETE per option column per 100 sizes");
  // New sizes go after each style's last one, in sheet order.
  const st0 = tables.building_sizes.filter((z) => z.style_id === "st-0").sort((a, b) => a.sort_order - b.sort_order);
  assertEquals(st0.slice(16, 19).map((z) => [z.label, z.sort_order]), [["20x30", 16], ["22x30", 17], ["24x30", 18]]);
});

// ── 4. a failed batch is replayed row by row ─────────────────────────────────────────────────
Deno.test("a size whose new label is taken fails alone, with the old line; the rest lands", async () => {
  const seed = {
    building_styles: [{ client_id: CLIENT, id: "st-a", key: "utility", label: "Utility" }],
    building_sizes: [
      { id: "sz-1", client_id: CLIENT, style_id: "st-a", label: "Small", width_ft: 10, length_ft: 12, base_price: 100, active: true, sort_order: 0 },
      { id: "sz-2", client_id: CLIENT, style_id: "st-a", label: "10x12", width_ft: 12, length_ft: 14, base_price: 200, active: true, sort_order: 1 },
      { id: "sz-3", client_id: CLIENT, style_id: "st-a", label: "8x8", width_ft: 8, length_ft: 8, base_price: 50, active: true, sort_order: 2 },
    ],
  };
  const rows = [
    { style: "Utility", width: "10", length: "12", price: "150", active: "", inclusions: { loft: "1" } },
    { style: "Utility", width: "8", length: "8", price: "75", active: "", inclusions: { loft: "2" } },
    { style: "Utility", width: "16", length: "20", price: "900", active: "", inclusions: { loft: "3" } },
  ];
  const r = await both(seed, rows);
  assertSame(r);
  assertEquals(r.bulk.skipped.length, 1);
  assert(/^Utility 10x12: duplicate key value/.test(r.bulk.skipped[0]), r.bulk.skipped[0]);
  assertEquals([r.bulk.created, r.bulk.updated], [1, 1]);
});

Deno.test("a failing new size and a failing option come back as the same per-row lines", async () => {
  const failOn = ({ table, payload }: { table: string; payload: any[] }) =>
    table === "building_sizes" && payload.some((p) => Number(p.width_ft) === 99) ? "size refused"
    : table === "building_size_inclusions" && payload.some((p) => p.item_key === "bad") ? "option refused"
    : null;
  const seed = { building_styles: [{ client_id: CLIENT, id: "st-a", key: "utility", label: "Utility" }] };
  const rows = [
    { style: "Utility", width: "99", length: "12", price: "100", active: "", inclusions: { loft: "1" } },
    { style: "Utility", width: "10", length: "12", price: "100", active: "", inclusions: { loft: "1", bad: "2", door: "1" } },
    { style: "Utility", width: "12", length: "12", price: "100", active: "", inclusions: { bad: "yes" } },
  ];
  const r = await both(seed, rows, { failOn });
  assertSame(r);
  assertEquals(r.bulk.skipped, [
    "Utility 99x12: size refused",
    "Utility 10x12 / bad: option refused",
    "Utility 12x12 / bad: option refused",
  ]);
  assertEquals([r.bulk.created, r.bulk.updated], [2, 0]);
});

// ── 5. retry-safe ─────────────────────────────────────────────────────────────────────────────
Deno.test("the same sheet sent twice makes nothing twice", async () => {
  const t = bigTenant();
  const rows = bigSheet(t, 5);
  const { sb, tables } = fakeDb(clone(t.seed));
  const first = await importPricingRows(sb, CLIENT, rows);
  const after1 = snapshot(tables);
  const second = await importPricingRows(sb, CLIENT, rows);
  assertEquals([first.created, first.updated], [65, 208]);
  assertEquals([second.created, second.updated, second.skipped], [0, 273, []]);
  assertEquals(snapshot(tables), after1);
});

// ── 6. a catalog past one PostgREST page ─────────────────────────────────────────────────────
Deno.test("a catalog of 1,500 sizes is read whole: blank cells clear options on every size, yes keeps qty", async () => {
  const sizes: any[] = [], inclusions: any[] = [];
  for (let i = 0; i < 1500; i++) {
    const id = `sz-${String(i).padStart(4, "0")}`;
    sizes.push({ id, client_id: CLIENT, style_id: "st-a", label: `${8 + i}x10`, width_ft: 8 + i, length_ft: 10, base_price: 1000, active: true, sort_order: i });
    inclusions.push({ client_id: CLIENT, size_id: id, item_key: "workbench", included: true, qty: 1 });
    inclusions.push({ client_id: CLIENT, size_id: id, item_key: "loft", included: true, qty: 40 });
  }
  const { sb, tables } = fakeDb({ building_styles: [{ client_id: CLIENT, id: "st-a", key: "utility", label: "Utility" }], building_sizes: sizes, building_size_inclusions: inclusions }, { maxRows: 1000 });
  const rows = sizes.map((z) => ({ style: "Utility", width: String(z.width_ft), length: "10", price: "1100", active: "", inclusions: { workbench: "", loft: "yes" } }));
  const out = await importPricingRows(sb, CLIENT, rows);
  assertEquals([out.created, out.updated, out.skipped], [0, 1500, []]);
  assertEquals(tables.building_sizes.length, 1500);
  assertEquals(tables.building_size_inclusions.filter((i) => i.item_key === "workbench").length, 0);
  const lofts = tables.building_size_inclusions.filter((i) => i.item_key === "loft");
  assertEquals([lofts.length, lofts.every((i) => i.qty === 40)], [1500, true]);
});
