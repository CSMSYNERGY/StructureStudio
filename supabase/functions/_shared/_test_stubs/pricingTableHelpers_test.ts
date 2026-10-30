// Pricing Table helpers (portal/03-catalog.jsx), lifted from the SHIPPED source. The Excel template
// and the Pricing Table both build their option columns with ssPricingColumns, so a change to it
// changes the header builders download. The golden header below is today's sheet: if it moves,
// every builder's saved sheet stops matching on re-upload (columns are matched by exact label).

import { assert, assertEquals } from "jsr:@std/assert";
import { MAX_CALL_CELLS, MAX_CALL_ENTRIES, parseDim, parsePrice, parseQty, validatePayload } from "../pricingCells.ts";
import { DIM_CASES, PRICE_CASES, QTY_CASES } from "./pricingParseCases.ts";

const src = (await Deno.readTextFile(new URL("../../../../portal/03-catalog.jsx", import.meta.url))).replace(/\r\n/g, "\n");
const lift = (sig: string) => {
  const i = src.indexOf(sig);
  const j = i < 0 ? -1 : src.indexOf("\n}\n", i);
  if (i < 0 || j < 0) throw new Error(`pricingTableHelpers_test: "${sig}" not found in portal/03-catalog.jsx — re-point the anchor rather than deleting this test.`);
  return src.slice(i, j + 2);
};
// deno-lint-ignore no-explicit-any
type Cat = any;
type Section = { name: string; argb: string; cols: { key: string; label: string }[] };
const fmtFtIn = new Function(`${lift("function fmtFtIn(inches) {")}; return fmtFtIn;`)() as (n: unknown) => string;
const ssPricingColumns = new Function(`${lift("function fmtFtIn(inches) {")}\n${lift("function ssPricingColumns(cat) {")}; return ssPricingColumns;`)() as (cat: Cat) => Section[];

const CAT = {
  items: [
    { key: "loft", label: "Loft (sq ft)" },
    { key: "ramp", label: "Ramp" },                       // managed in Ramp settings: no column
    { key: "partitionWall", label: "Partition wall" },    // customer's own layout: no column
    { key: "shelf", label: "Shelf", archived: true },     // archived: no column
    { key: "workbench", label: "Workbench" },
  ],
  fixtures: [
    { id: 11, name: "Single Door", category: "door", width_in: 36, height_in: 76 },
    { id: 12, name: "Old Door", category: "door", archived: true },
    { id: 13, name: "Hidden Door", category: "door", active: false },
    { id: 14, name: "Barn Door" },                         // no category reads as a door; no size
    { id: 21, name: "Window", category: "window", width_in: 24, height_in: 36 },
    { id: 31, name: "Gable Vent", category: "vent", width_in: 12, height_in: 12 },
    { id: 41, name: "Ramp Kit", category: "ramp", width_in: 48, height_in: 6 },
    { id: 51, name: "Skylight", category: "skylight" },    // unknown category: kept under Other
    { id: 52, category: "skylight", width_in: 24, height_in: 24 },
    null,
  ],
};

Deno.test("fmtFtIn writes feet and inches the way the template labels need", () => {
  assertEquals(fmtFtIn(36), "3'");
  assertEquals(fmtFtIn(76), "6'4\"");
  assertEquals(fmtFtIn(6), "6\"");
  assertEquals(fmtFtIn(0), "");
  assertEquals(fmtFtIn("x"), "");
});

Deno.test("ssPricingColumns: sections, order and keys match the Options tab", () => {
  const s = ssPricingColumns(CAT);
  assertEquals(s.map((x) => x.name), ["Built-in options", "Doors", "Windows", "Vents", "Ramps", "Other"]);
  assertEquals(s.map((x) => x.argb), ["FFDBEAFF", "FFFEE9C7", "FFDCF1FB", "FFEAF3E6", "FFE7E5E4", "FFF1F5F9"]);
  assertEquals(s.map((x) => x.cols.map((c) => c.key)), [["loft", "workbench"], ["11", "14"], ["21"], ["31"], ["41"], ["51", "52"]]);
});

Deno.test("ssPricingColumns: the golden Excel header", () => {
  const its = ssPricingColumns(CAT).flatMap((x) => x.cols);
  const headers = ["style", "width", "length", "price", ...its.map((it) => it.label), "active"];
  assertEquals(headers, [
    "style", "width", "length", "price",
    "Loft (sq ft)", "Workbench",
    "Single Door (3'x6'4\")", "Barn Door",
    "Window (2'x3')",
    "Gable Vent (1'x1')",
    "Ramp Kit (4'x6\")",
    "Skylight", "Item (2'x2')",
    "active",
  ]);
});

Deno.test("ssPricingColumns: empty sections drop out, and a missing catalog gives no columns", () => {
  assertEquals(ssPricingColumns({ items: [{ key: "loft", label: "Loft" }], fixtures: [] }).map((x) => x.name), ["Built-in options"]);
  assertEquals(ssPricingColumns(null), []);
  assertEquals(ssPricingColumns({}), []);
});

// ─── Phase 2: the read-only grid's pure helpers (2026-10-30) ───────────────────────────────────
// Lifted the same way, from the shipped text. Each is a top-level `function x(…) {` whose only free
// names are the other helpers lifted with it.
const PURE = ["function fmtFtIn(inches) {", "function ssPricingColumns(cat) {", "function ssPgFmtPrice(v) {",
  "function ssPgModel(cat, table) {", "function ssPgRows(model, opts) {", "function ssPgMove(order, ncols, at, key, shift) {",
  "function ssPgReanchor(prev, order, at, ncols) {",
  "function ssPgHeaderHeight(labels, measure, pad) {", "function ssPgTemplate(cat, table) {"].map(lift).join("\n");
// deno-lint-ignore no-explicit-any
type Any = any;
const H = new Function(`${PURE}; return { ssPgFmtPrice, ssPgModel, ssPgRows, ssPgMove, ssPgReanchor, ssPgHeaderHeight, ssPgTemplate };`)() as Record<string, (...a: Any[]) => Any>;

// Made-up ids and names only: this repo is public.
const sid = (n: number) => `00000000-0000-4000-8000-0000000000${String(n).padStart(2, "0")}`;
const zid = (n: number) => `10000000-0000-4000-8000-0000000000${String(n).padStart(2, "0")}`;
const DOOR = "Single Door (3'x6'4\")";
const TCAT = { clientId: "test-barns", items: [{ key: "loft", label: "Loft (sq ft)" }, { key: "workbench", label: "Workbench" }],
  fixtures: [{ id: 11, name: "Single Door", category: "door", width_in: 36, height_in: 76 }] };
const STYLES = [
  { id: sid(2), key: "utility", label: "Test Utility", code: "TU", active: true, sort_order: 2 },
  { id: sid(1), key: "barn", label: "Test Barn", code: "TB", active: true, sort_order: 1 },
  { id: sid(3), key: "old", label: "Test Old Style", code: "TO", active: false, sort_order: 0 },
  { id: sid(4), key: "empty", label: "Test Empty", code: "TE", active: true, sort_order: 3 },
];
const size = (n: number, style: number, w: number, l: number, price: number | null, active: boolean, sort: number) =>
  ({ id: zid(n), style_id: sid(style), label: `${w}x${l}`, width_ft: w, length_ft: l, base_price: price, active, sort_order: sort,
    created_at: "2026-10-01T00:00:00.000001+00:00", updated_at: `2026-10-0${n % 9 + 1}T00:00:00.123456+00:00` });
const SIZES = [
  size(3, 1, 12, 24, 4800, true, 2),
  size(1, 1, 10, 12, 0, true, 0),
  size(2, 1, 10, 16, null, false, 1),          // never priced: hidden
  size(4, 2, 8, 10, 2100.5, false, 0),          // priced, Offered unticked: hidden
  size(5, 2, 8, 12, 2350.555, true, 1),
  size(6, 3, 6, 8, 999, true, 0),               // in a hidden style
];
const INCS = [
  { size_id: zid(3), item_key: "loft", included: true, qty: 50 },
  { size_id: zid(3), item_key: "11", included: true, qty: 2 },
  { size_id: zid(1), item_key: "workbench", included: true, qty: null },     // included, no qty: reads 1
  { size_id: zid(1), item_key: "loft", included: false, qty: 30 },           // on file, not included: empty
  { size_id: zid(5), item_key: "ramp", included: true, qty: 1 },             // not a column: ignored
];
const TABLE = { clientId: "test-barns", rtpOn: false, styles: STYLES, sizes: SIZES, inclusions: INCS, counts: { sizes: SIZES.length, inclusions: INCS.length } };

Deno.test("ssPgFmtPrice: dollars with commas; two decimals when there are any; more than two shown as stored", () => {
  assertEquals(H.ssPgFmtPrice(4800), "$4,800");
  assertEquals(H.ssPgFmtPrice(0), "$0");
  assertEquals(H.ssPgFmtPrice(4800.5), "$4,800.50");
  assertEquals(H.ssPgFmtPrice(12.1), "$12.10");
  assertEquals(H.ssPgFmtPrice(4800.555), "$4,800.555");
  assertEquals(H.ssPgFmtPrice("1250000"), "$1,250,000");
  assertEquals(H.ssPgFmtPrice(null), "");
  assertEquals(H.ssPgFmtPrice(""), "");
});

Deno.test("ssPgModel: columns, styles in order, hidden styles apart, sizes in order", () => {
  const m = H.ssPgModel(TCAT, TABLE);
  assertEquals(m.cols.map((c: Any) => c.key), ["loft", "workbench", "11"]);
  assertEquals(m.cols.map((c: Any) => c.section), [0, 0, 1]);
  assertEquals(m.styles.map((s: Any) => s.label), ["Test Barn", "Test Utility", "Test Empty"]);
  assertEquals(m.hiddenStyles.map((s: Any) => s.label), ["Test Old Style"]);
  assertEquals(m.styles[0].sizes.map((z: Any) => z.label), ["10x12", "10x16", "12x24"]);
  assertEquals(m.styles[2].sizes, []);
  assertEquals(m.hiddenStyles[0].sizes.map((z: Any) => z.label), ["6x8"]);
  assertEquals(m.guard, null);
  assertEquals(m.clientId, "test-barns");
  assertEquals(m.rtpOn, false);
  assertEquals(H.ssPgModel(TCAT, { ...TABLE, rtpOn: "yes" }).rtpOn, false, "only a real true locks prices");
  assertEquals(H.ssPgModel(TCAT, { ...TABLE, rtpOn: true }).rtpOn, true);
});

Deno.test("ssPgModel: cells show the included quantity and nothing else (Q2: empty, not 0)", () => {
  const m = H.ssPgModel(TCAT, TABLE);
  const by = (n: number) => m.styles.flatMap((s: Any) => s.sizes).find((z: Any) => z.id === zid(n));
  assertEquals(by(3).values, ["50", "", "2"]);
  assertEquals(by(1).values, ["", "1", ""], "included with no qty reads 1 (the template's rule); not included is empty");
  assertEquals(by(5).values, ["", "", ""], "an inclusion on a key that is not a column is not drawn");
  assertEquals(by(3).priceText, "$4,800");
  assertEquals(by(5).priceText, "$2,350.555");
  assertEquals(by(3).title, "12 ft × 24 ft");
  assertEquals(by(3).version, "2026-10-04T00:00:00.123456+00:00", "the version is kept verbatim, microseconds and all");
});

Deno.test("ssPgModel: a size is hidden when it is not offered or has no price; $0 is offered", () => {
  const m = H.ssPgModel(TCAT, TABLE);
  const by = (n: number) => m.styles.flatMap((s: Any) => s.sizes).find((z: Any) => z.id === zid(n));
  assertEquals([by(1).offered, by(1).hidden, by(1).price], [true, false, 0]);
  assertEquals([by(2).offered, by(2).hidden, by(2).price, by(2).priceText], [false, true, null, ""]);
  assertEquals([by(4).offered, by(4).hidden], [false, true]);
  assertEquals([by(5).offered, by(5).hidden], [true, false]);
});

Deno.test("ssPgModel: the truncation guard trips on a count mismatch, an orphan, and the 1000-row cap", () => {
  assertEquals(H.ssPgModel(TCAT, { ...TABLE, counts: { sizes: SIZES.length + 1, inclusions: INCS.length } }).guard, "count");
  assertEquals(H.ssPgModel(TCAT, { ...TABLE, counts: { sizes: SIZES.length, inclusions: INCS.length + 1 } }).guard, "count");
  assertEquals(H.ssPgModel(TCAT, { ...TABLE, counts: undefined }).guard, "count", "no counts is not a pass");
  const orphanInc = [...INCS, { size_id: zid(99), item_key: "loft", included: true, qty: 1 }];
  assertEquals(H.ssPgModel(TCAT, { ...TABLE, inclusions: orphanInc, counts: { sizes: SIZES.length, inclusions: orphanInc.length } }).guard, "orphan_inclusion");
  const orphanSize = [...SIZES, size(9, 77, 9, 9, 1, true, 0)];
  assertEquals(H.ssPgModel(TCAT, { ...TABLE, sizes: orphanSize, counts: { sizes: orphanSize.length, inclusions: INCS.length } }).guard, "orphan_size");
  const many = (n: number) => Array.from({ length: n }, (_, i) => ({ key: `k${i}`, label: `Item ${i}` }));
  assertEquals(H.ssPgModel({ ...TCAT, items: many(999) }, TABLE).guard, null);
  assertEquals(H.ssPgModel({ ...TCAT, items: many(1000) }, TABLE).guard, "cap");
  assertEquals(H.ssPgModel({ ...TCAT, fixtures: Array.from({ length: 1000 }, (_, i) => ({ id: i, name: "F", category: "door", archived: true })) }, TABLE).guard, "cap");
});

Deno.test("ssPgModel: a count that does not add up is reported first, even past the 1000-row cap", () => {
  // The Excel template refuses on "count" alone (plan 4.8): a row cut off a list would go out as 0
  // and the importer would delete it. So a capped catalog must not hide a short list behind "cap".
  const many = (n: number) => Array.from({ length: n }, (_, i) => ({ key: `k${i}`, label: `Item ${i}` }));
  const short = { ...TABLE, counts: { sizes: SIZES.length, inclusions: INCS.length + 1 } };
  assertEquals(H.ssPgModel({ ...TCAT, items: many(1000) }, short).guard, "count");
  const orphanInc = [...INCS, { size_id: zid(99), item_key: "loft", included: true, qty: 1 }];
  assertEquals(H.ssPgModel(TCAT, { ...TABLE, inclusions: orphanInc, counts: { sizes: SIZES.length, inclusions: orphanInc.length + 1 } }).guard, "count");
  // Past the cap, with every list adding up: "cap", which the template builds anyway (the importer
  // never touches a column the sheet does not carry); the table still opens view-only on it.
  assertEquals(H.ssPgModel({ ...TCAT, items: many(1000) }, TABLE).guard, "cap");
});

Deno.test("ssPgRows: bands, sizes, placeholders, folding hidden sizes, and the hidden-styles section", () => {
  const m = H.ssPgModel(TCAT, TABLE);
  const shape = (rows: Any[]) => rows.map((r) => r.kind === "size" ? r.size.label : r.kind === "band" ? `[${r.style.label} ${r.total}/${r.hidden}/${r.folded}]` : r.kind === "empty" ? `(${r.text})` : `{hidden ${r.count} ${r.open}}`);
  assertEquals(shape(H.ssPgRows(m, {})), ["[Test Barn 3/1/0]", "10x12", "10x16", "12x24", "[Test Utility 2/1/0]", "8x10", "8x12",
    "[Test Empty 0/0/0]", "(No sizes yet.)", "{hidden 1 false}"]);
  assertEquals(shape(H.ssPgRows(m, { showHidden: false })), ["[Test Barn 3/1/1]", "10x12", "12x24", "[Test Utility 2/1/1]", "8x12",
    "[Test Empty 0/0/0]", "(No sizes yet.)", "{hidden 1 false}"]);
  assertEquals(shape(H.ssPgRows(m, { hiddenStylesOpen: true })).slice(-3), ["{hidden 1 true}", "[Test Old Style 1/0/0]", "6x8"]);
  const allHidden = H.ssPgModel(TCAT, { ...TABLE, sizes: [SIZES[2]], inclusions: [], counts: { sizes: 1, inclusions: 0 } });
  assertEquals(shape(H.ssPgRows(allHidden, { showHidden: false })).slice(0, 2), ["[Test Barn 1/1/1]", "(1 hidden size, folded away.)"]);
  assertEquals(H.ssPgRows(null, {}), []);
});

Deno.test("ssPgMove: arrows clamp at the edges, Home/End, Tab wraps rows and lets go at either end", () => {
  const order = ["a", "b", "c"];
  const mv = (at: Any, key: string, shift = false) => H.ssPgMove(order, 5, at, key, shift);
  assertEquals(mv({ sizeId: "b", col: 2 }, "ArrowUp"), { sizeId: "a", col: 2 });
  assertEquals(mv({ sizeId: "a", col: 2 }, "ArrowUp"), { sizeId: "a", col: 2 });
  assertEquals(mv({ sizeId: "b", col: 2 }, "ArrowDown"), { sizeId: "c", col: 2 });
  assertEquals(mv({ sizeId: "c", col: 2 }, "ArrowDown"), { sizeId: "c", col: 2 });
  assertEquals(mv({ sizeId: "b", col: 0 }, "ArrowLeft"), { sizeId: "b", col: 0 });
  assertEquals(mv({ sizeId: "b", col: 4 }, "ArrowRight"), { sizeId: "b", col: 4 });
  assertEquals(mv({ sizeId: "b", col: 2 }, "Home"), { sizeId: "b", col: 0 });
  assertEquals(mv({ sizeId: "b", col: 2 }, "End"), { sizeId: "b", col: 4 });
  assertEquals(mv({ sizeId: "a", col: 4 }, "Tab"), { sizeId: "b", col: 0 });
  assertEquals(mv({ sizeId: "b", col: 0 }, "Tab", true), { sizeId: "a", col: 4 });
  assertEquals(mv({ sizeId: "c", col: 4 }, "Tab"), null, "Tab off the last cell leaves the grid");
  assertEquals(mv({ sizeId: "a", col: 0 }, "Tab", true), null, "Shift+Tab off the first cell leaves the grid");
  assertEquals(mv(null, "ArrowDown"), { sizeId: "b", col: 0 }, "no active cell starts at the first");
  assertEquals(mv({ sizeId: "gone", col: 3 }, "ArrowRight"), { sizeId: "a", col: 1 }, "a folded-away cell restarts at the first");
  assertEquals(mv({ sizeId: "b", col: 2 }, "Enter"), null, "not a move: the browser keeps the key");
  assertEquals(H.ssPgMove([], 5, null, "ArrowDown", false), null);
});

Deno.test("ssPgReanchor: a folded-away or vanished size hands the cursor to its nearest drawn neighbour, same column", () => {
  const prev = ["a", "b", "c", "d", "e"];
  const at = { sizeId: "c", col: 4 };
  // Still drawn: the very same object back, so the page sets nothing.
  assertEquals(H.ssPgReanchor(prev, prev, at, 9) === at, true);
  // Folded away ("Show hidden sizes" off): the next drawn size below it, then above it.
  assertEquals(H.ssPgReanchor(prev, ["a", "b", "e"], at, 9), { sizeId: "e", col: 4 });
  assertEquals(H.ssPgReanchor(prev, ["a", "b"], at, 9), { sizeId: "b", col: 4 });
  // Gone on a Reload along with its neighbours: the first survivor below it in the old order.
  assertEquals(H.ssPgReanchor(prev, ["a", "e", "x"], { sizeId: "c", col: 1 }, 9), { sizeId: "e", col: 1 });
  // Columns went away on the same Reload: the column is clamped.
  assertEquals(H.ssPgReanchor(prev, ["a", "b", "c"], at, 4), { sizeId: "c", col: 3 });
  assertEquals(H.ssPgReanchor(prev, ["a", "e"], at, 4), { sizeId: "e", col: 3 });
  // Nothing drawn, no cursor, or a cursor the old order never had: no cursor.
  assertEquals(H.ssPgReanchor(prev, [], at, 9), null);
  assertEquals(H.ssPgReanchor(prev, ["a"], null, 9), null);
  assertEquals(H.ssPgReanchor(prev, ["a"], { sizeId: "zz", col: 1 }, 9), null);
  assertEquals(H.ssPgReanchor(null, ["a"], at, 9), null);
});

Deno.test("ssPgHeaderHeight: the longer half at the best split, the longest name, plus padding", () => {
  const px = (s: string) => s.length * 7;
  assertEquals(H.ssPgHeaderHeight(["Loft"], px, 16), 28 + 16);
  // The door: best split "Single Door" | the size = 11 vs 9 characters, so 77.
  assertEquals(H.ssPgHeaderHeight([DOOR], px, 16), 77 + 16);
  // One word longer than any split is its own floor.
  assertEquals(H.ssPgHeaderHeight(["Ab Extraordinarily"], px, 0), "Extraordinarily".length * 7);
  assertEquals(H.ssPgHeaderHeight(["Loft", DOOR, "Ramp"], px, 16), 77 + 16);
  assertEquals(H.ssPgHeaderHeight([], px, 16), 16);
  assertEquals(H.ssPgHeaderHeight(["", null], px, 16), 16);
});

Deno.test("ssPgHeaderHeight: a browser filling lines greedily never needs a third line at that height", () => {
  // Greedy line filling over spaces, the way a browser wraps white-space:normal text.
  const px = (s: string) => s.length * 7 + (s.match(/[MW]/g) || []).length * 3;
  const lines = (label: string, width: number) => {
    const words = label.split(/\s+/).filter(Boolean);
    let n = 0, cur = "";
    for (const w of words) {
      const next = cur ? cur + " " + w : w;
      if (cur && px(next) > width) { n++; cur = w; } else cur = next;
    }
    return n + (cur ? 1 : 0);
  };
  const LABELS = [
    "Double Door with Transom Window and Kick Plate (6'x7')", DOOR, "Loft (sq ft)",
    "Window (2'x3')", "Gable Vent (1'x1')", "Workbench", "Shelf",
    "Heavy Duty Roll-Up Door With Windows (9'x8')", "Wide Window Mullions Weathered (3'x4')", "A B C D E F G H I J K L M N",
  ];
  for (const label of LABELS) {
    const h = H.ssPgHeaderHeight([label], px, 0);
    assert(lines(label, h) <= 2, `${label} needs ${lines(label, h)} lines at ${h}px`);
  }
});

Deno.test("ssPgTemplate: the Excel template from a fresh size_table, same layout as before", () => {
  const { headers, rows, sections } = H.ssPgTemplate(TCAT, TABLE);
  assertEquals(sections.map((s: Any) => s.name), ["Built-in options", "Doors"]);
  assertEquals(headers, ["style", "width", "length", "price", "Loft (sq ft)", "Workbench", DOOR, "active"]);
  assertEquals(rows, [
    ["Test Barn", 10, 12, 0, 0, 1, 0, "yes"],
    ["Test Barn", 10, 16, "", 0, 0, 0, "no"],
    ["Test Barn", 12, 24, 4800, 50, 0, 2, "yes"],
    ["Test Utility", 8, 10, 2100.5, 0, 0, 0, "no"],
    ["Test Utility", 8, 12, 2350.555, 0, 0, 0, "yes"],
    ["Test Empty", "", "", "", 0, 0, 0, "yes"],   // no sizes yet: one starter row
  ]);
  // Hidden styles stay out of the sheet, as before; a missing table gives a header and no rows.
  assert(!rows.some((r: Any[]) => r[0] === "Test Old Style"));
  assertEquals(H.ssPgTemplate(TCAT, null).rows, []);
});

Deno.test("SS_SETTINGS_WRITE_RE: the table's save, Add style and a rename reach an open table; reads do not", async () => {
  const core = (await Deno.readTextFile(new URL("../../../../portal/01-core.jsx", import.meta.url))).replace(/\r\n/g, "\n");
  const line = core.split("\n").find((l) => l.startsWith("const SS_SETTINGS_WRITE_RE = "));
  assert(line, "SS_SETTINGS_WRITE_RE not found in portal/01-core.jsx");
  const re = new Function(`${line}; return SS_SETTINGS_WRITE_RE;`)() as RegExp;
  for (const a of ["save_pricing_cells", "create_style", "update_style", "import_pricing_csv", "set_style_active", "delete_style", "reorder_styles"]) assert(re.test(a), a);
  for (const a of ["size_table", "catalog", "status", "get_profile"]) assert(!re.test(a), a);
});

// ─── Phase 3: the save path's pure half (2026-10-31) ───────────────────────────────────────────
// The parsers, the save queue (ssPgQueue with ssPgBuildBatch and ssPgRebase), and what the page
// draws and says from it. The queue cases are the plan's section 8.1 list, numbered as there, run
// against a small fake of migration 350's function (`serve` below: the version check, the `from`
// check, saved / duplicate / conflict / missing, cellErrors, creates), so an answer is shaped as the
// server shapes it and a resend meets the state an earlier copy left behind. Every call the queue
// builds is also put through the server's own validatePayload: the browser never sends what the
// edge would answer 400.
const SAVE = ["function ssPgParsePrice(text, stored) {", "function ssPgParseQty(text, stored) {", "function ssPgParseDim(text) {",
  "function ssPgVal(s, f) {", "function ssPgSame(a, b) {", "function ssPgServerSizes(model) {", "function ssPgRowView(z, s, fs, cols) {",
  "function ssPgCount(q) {", "function ssPgBuildBatch(q, caps) {", "function ssPgRebase(sent, server, again) {", "function ssPgQueue(q, ev) {",
  "function ssPgDueIn(q, now) {", "function ssPgBackoff(failures, schedule) {", "function ssPgAnswerKind(r, expect) {",
  "function ssPgErrorLine(where, field, err) {", "function ssPgColBox(col, narrow) {"].map(lift).join("\n");
const S = new Function(`${PURE}\n${SAVE}; return { ssPgParsePrice, ssPgParseQty, ssPgParseDim, ssPgVal, ssPgSame, ssPgServerSizes, ssPgRowView, ssPgCount,
  ssPgBuildBatch, ssPgRebase, ssPgQueue, ssPgDueIn, ssPgBackoff, ssPgAnswerKind, ssPgErrorLine, ssPgColBox };`)() as Record<string, (...a: Any[]) => Any>;

Deno.test("parse parity: the browser's parsers answer the shared table exactly as the server's do", () => {
  const pairs: [string, (t: string, s?: Any) => Any, (t: string, s?: Any) => Any, Any[]][] = [
    ["price", S.ssPgParsePrice, parsePrice, PRICE_CASES], ["qty", S.ssPgParseQty, parseQty, QTY_CASES],
    ["dim", (t: string) => S.ssPgParseDim(t), (t: string) => parseDim(t), DIM_CASES],
  ];
  for (const [what, browser, server, cases] of pairs) {
    for (const [text, stored, want] of cases) {
      const b = browser(text, stored), s = server(text, stored);
      assertEquals(b, s, `${what} ${JSON.stringify(text)} (stored ${stored}): browser ${JSON.stringify(b)}, server ${JSON.stringify(s)}`);
      if (want === "error") assert(!b.ok, `${what} ${JSON.stringify(text)} should be refused`);
      else assert(b.ok && Object.is(b.value, want), `${what} ${JSON.stringify(text)} should be ${want}, got ${JSON.stringify(b)}`);
    }
  }
  // The plan's own examples (8.1), and the reasons the boxes show.
  assertEquals(S.ssPgParsePrice("$4,800"), { ok: true, value: 4800 });
  assertEquals(S.ssPgParsePrice("4800.555"), { ok: true, value: 4800.555 });
  assertEquals(S.ssPgParsePrice(""), { ok: true, value: null });
  for (const t of ["-5", "abc", "4.8k"]) assertEquals(S.ssPgParsePrice(t), { ok: false, error: "A price is a number, 0 or more" });
  for (const t of ["2.5", "-1", "yes", "x"]) assertEquals(S.ssPgParseQty(t), { ok: false, error: "Whole numbers only, 0 or more" });
  assertEquals(S.ssPgParseQty("1000000"), { ok: false, error: "Whole numbers from 0 to 999,999" });
  assertEquals([S.ssPgParseQty("").value, S.ssPgParseQty("0").value, S.ssPgParseQty("50").value], [0, 0, 50]);
});

// ── A fake of migration 350's pricing_cells_apply: sizes and creates, the parts the queue meets ──
type Row = { version: string; price: number | null; active: boolean; cells: Record<string, number> };
let tick = 0;
const nextV = () => `2026-10-31T00:00:00.${String(++tick).padStart(6, "0")}+00:00`;
const A = zid(1), B = zid(2), C = zid(3), Z = zid(9), E = zid(8);
const V0 = "2026-10-20T00:00:00.100001+00:00";
function serve(db: Record<string, Row>, body: Any, opts: { rtp?: boolean; allowed?: string[]; exists?: Record<string, string> } = {}) {
  const rowOf = (r: Row) => ({ price: r.price, active: r.active, label: "10x12", width_ft: 10, length_ft: 12, style_id: sid(1), sort_order: 0, created_at: V0 });
  const created = (body.creates || []).map((c: Any) => {
    const hit = opts.exists && opts.exists[c.id];
    if (hit) return { id: c.id, status: "exists", existingId: hit, version: db[hit].version, row: rowOf(db[hit]), cells: { ...db[hit].cells } };
    if (db[c.id]) return { id: c.id, status: "duplicate", version: db[c.id].version, row: rowOf(db[c.id]), cells: { ...db[c.id].cells } };
    db[c.id] = { version: nextV(), price: null, active: false, cells: {} };
    return { id: c.id, status: "created", version: db[c.id].version, row: rowOf(db[c.id]), cells: {} };
  });
  const results = (body.sizes || []).map((e: Any) => {
    const row = db[e.id];
    if (!row) return { id: e.id, status: "missing", version: null, row: null, cells: {}, reason: "That size isn't on this account any more." };
    const cur = (k: string) => row.cells[k] ?? 0;
    const sameAs = (side: Any) => (!("price" in side) || side.price === row.price) && (!("active" in side) || side.active === row.active)
      && Object.entries(side.cells ?? {}).every(([k, v]) => v === cur(k));
    const errs: Record<string, string> = {};
    let status: string;
    if (row.version === e.base && sameAs(e.from)) {
      let price = row.price;
      if ("price" in e.to) { if (opts.rtp) errs.price = "Real-Time Pricing sets prices on this account"; else price = e.to.price; }
      let active = "active" in e.to ? e.to.active : (row.price == null && price != null ? true : row.active);
      if (active && price == null) { if ("active" in e.to) errs.active = "Add a price first"; active = false; }
      row.price = price; row.active = active; row.version = nextV();
      for (const [k, q] of Object.entries(e.to.cells ?? {}) as [string, number][]) {
        if (opts.allowed && !opts.allowed.includes(k)) { errs[k] = "That option has no column in your sizes table"; continue; }
        if (q > 0) row.cells[k] = q; else delete row.cells[k];
      }
      status = "saved";
    } else status = sameAs(e.to) ? "duplicate" : "conflict";
    const cells: Record<string, number> = {};
    for (const k of Object.keys(e.to.cells ?? {})) cells[k] = cur(k);
    return { id: e.id, status, version: row.version, row: rowOf(row), cells, ...(Object.keys(errs).length ? { cellErrors: errs } : {}) };
  });
  return { ok: true, clientId: "test-barns", created, removed: [], results };
}
const copy = (db: Record<string, Row>) => JSON.parse(JSON.stringify(db)) as Record<string, Row>;
const Q = (q: Any, ...events: Any[]) => events.reduce((s, e) => S.ssPgQueue(s, e), q);
const start = (db: Record<string, Row>) => S.ssPgQueue(null, { type: "init", sizes: copy(db), cols: ["loft", "101"] });
const commit = (sizeId: string, f: string, value: Any, at = 0) => ({ type: "commit", sizeId, f, value, at });
// Send the next call and answer it from `db`, as the page does; returns [state, the body sent].
const roundTrip = (q: Any, db: Record<string, Row>, opts = {}): [Any, Any] => {
  const s1 = S.ssPgQueue(q, { type: "send" });
  if (!s1.flight || s1.flight === q.flight) return [s1, null];
  const body = s1.flight.body;
  assert(validatePayload(body).ok, `the server's validatePayload refuses what the browser built: ${JSON.stringify(validatePayload(body))}`);
  return [S.ssPgQueue(s1, { type: "ok", n: s1.flight.n, answer: serve(db, body, opts) }), body];
};
const field = (q: Any, id: string, f: string) => (q.fields[id] || {})[f];
const DB = (): Record<string, Row> => ({
  [A]: { version: V0, price: 400, active: true, cells: { loft: 50 } },
  [B]: { version: V0, price: 2100, active: true, cells: {} },
  [C]: { version: V0, price: null, active: false, cells: {} },
});

Deno.test("queue: a commit sends only what changed, from what it was made against; a value back to the baseline sends nothing", () => {
  const db = DB();
  let q = Q(start(db), commit(A, "c:loft", 60));
  assertEquals(field(q, A, "c:loft").pending, { to: 60, from: 50, seq: 1 });
  assertEquals(S.ssPgBuildBatch(q).body, { creates: [], removes: [], sizes: [{ id: A, base: V0, from: { cells: { loft: 50 } }, to: { cells: { loft: 60 } } }] });
  q = Q(q, commit(A, "c:loft", 50));
  assertEquals(field(q, A, "c:loft"), undefined, "typed back to what is on file: nothing to send");
  assertEquals(S.ssPgBuildBatch(q), null);
  assertEquals(S.ssPgDueIn(q, 1000), null);
  // A price cleared: blank is null (not offered), never $0.
  q = Q(q, commit(B, "price", null));
  assertEquals(S.ssPgBuildBatch(q).body.sizes, [{ id: B, base: V0, from: { price: 2100 }, to: { price: null } }]);
});

Deno.test("queue 1: an edit made during the flight survives the answer", () => {
  const db = DB();
  let q = Q(start(db), commit(A, "price", 4800), { type: "send" }, commit(A, "c:loft", 75));
  q = Q(q, { type: "ok", n: q.flight.n, answer: serve(db, q.flight.body) });
  assertEquals([field(q, A, "price"), q.sizes[A].price], [undefined, 4800]);
  assertEquals(field(q, A, "c:loft").pending, { to: 75, from: 50, seq: 2 });
  const v = q.sizes[A].version;
  const [q2, body] = roundTrip(q, db);
  assertEquals(body.sizes, [{ id: A, base: v, from: { cells: { loft: 50 } }, to: { cells: { loft: 75 } } }]);
  assertEquals([db[A].price, db[A].cells.loft, S.ssPgCount(q2).pending], [4800, 75, 0]);
});

Deno.test("queue 2: an answer for an older edit does not clear a newer one of the same box", () => {
  const db = DB();
  let q = Q(start(db), commit(A, "price", 4800), { type: "send" }, commit(A, "price", 5000));
  q = Q(q, { type: "ok", n: q.flight.n, answer: serve(db, q.flight.body) });
  assertEquals(field(q, A, "price"), { pending: { to: 5000, from: 4800, seq: 2 } });
  assertEquals(q.sizes[A].price, 4800);
});

Deno.test("queue 3: at most one call is out; another send is a no-op until it is answered", () => {
  const db = DB();
  const q = Q(start(db), commit(A, "price", 4800), { type: "send" }, commit(B, "price", 2200));
  assert(Q(q, { type: "send" }) === q, "a second send while one is out changes nothing");
  assertEquals(q.flight.n, 1);
  assertEquals(S.ssPgDueIn(q, 99999), null, "the clock does not run while a call is out");
  const [after, body] = roundTrip(Q(q, { type: "ok", n: 1, answer: serve(db, q.flight.body) }), db);
  assertEquals(body.sizes.map((s: Any) => s.id), [B]);
  assertEquals(after.flight, null);
});

Deno.test("queue 4: typing 480, then 400 again during the flight, sends { to: 400, from: 480 } after the ack", () => {
  const db = DB();
  let q = Q(start(db), commit(A, "price", 480), { type: "send" });
  assertEquals(q.flight.body.sizes[0], { id: A, base: V0, from: { price: 400 }, to: { price: 480 } });
  q = Q(q, commit(A, "price", 400));
  assertEquals(field(q, A, "price").pending, { to: 400, from: 480, seq: 2 }, "never thrown away: its baseline is the in-flight 480");
  q = Q(q, { type: "ok", n: q.flight.n, answer: serve(db, q.flight.body) });
  const v1 = q.sizes[A].version;
  const [q2, body] = roundTrip(q, db);
  assertEquals(body.sizes, [{ id: A, base: v1, from: { price: 480 }, to: { price: 400 } }]);
  assertEquals([db[A].price, q2.sizes[A].price, S.ssPgCount(q2).red], [400, 400, 0]);
});

Deno.test("queue 5: editing back to the in-flight value drops the follow-up", () => {
  const db = DB();
  let q = Q(start(db), commit(A, "price", 480), { type: "send" }, commit(A, "price", 500), commit(A, "price", 480));
  assertEquals(field(q, A, "price").pending, undefined);
  q = Q(q, { type: "ok", n: q.flight.n, answer: serve(db, q.flight.body) });
  assertEquals(S.ssPgBuildBatch(q), null);
  assertEquals(S.ssPgCount(q), { pending: 0, inflight: 0, red: 0, creating: 0, removing: 0 });
});

Deno.test("queue 6: a conflict on the box in flight turns its follow-up red, and it is not sent", () => {
  const db = DB();
  let q = Q(start(db), commit(A, "price", 480), { type: "send" }, commit(A, "price", 490));
  db[A].price = 4950; db[A].version = nextV();   // a colleague, while 480 was out
  q = Q(q, { type: "ok", n: q.flight.n, answer: serve(db, q.flight.body) });
  assertEquals(field(q, A, "price"), { error: { kind: "conflict", typed: 490, server: 4950, reason: null } });
  assertEquals([q.sizes[A].price, q.sizes[A].version], [4950, db[A].version], "the grid shows what the server holds");
  assertEquals(S.ssPgBuildBatch(q), null, "nothing goes");
  assertEquals(S.ssPgErrorLine("Test Barn 10x12", { name: "Price", kind: "price" }, field(q, A, "price").error),
    "Test Barn 10x12 · Price: changed elsewhere to $4,950 while you typed $490. Type it again if yours is right.");
  // Typing it again is an ordinary edit, from what is there now.
  q = Q(q, commit(A, "price", 490));
  assertEquals(field(q, A, "price"), { pending: { to: 490, from: 4950, seq: 3 } });
});

Deno.test("queue 7: create, then type a price: the edit waits, then goes on the create's version", () => {
  const db = DB();
  let q = Q(start(db), { type: "create", id: Z, styleId: sid(1), width: 10, length: 16, at: 0 }, commit(Z, "price", 3000));
  assertEquals(field(q, Z, "price").pending, { to: 3000, from: null, seq: 1 });
  let body;
  [q, body] = roundTrip(q, db);
  assertEquals(body.creates, [{ id: Z, styleId: sid(1), width: 10, length: 16 }]);
  assertEquals(body.sizes, [], "no version yet: the edit waits for the create's answer");
  assertEquals([q.sizes[Z].version, q.sizes[Z].creating, q.flush], [db[Z].version, undefined, true]);
  assertEquals(S.ssPgDueIn(q, 0), 0, "and goes at once");
  const vz = q.sizes[Z].version;
  [q, body] = roundTrip(q, db);
  assertEquals(body.sizes, [{ id: Z, base: vz, from: { price: null }, to: { price: 3000 } }]);
  assertEquals([db[Z].price, db[Z].active], [3000, true], "the first price ticks Offered (plan 3.9)");
});

Deno.test("queue 8: `exists` on a create puts the existing size in its place and turns the minted row's edits red", () => {
  const db = { ...DB(), [E]: { version: V0, price: 2500, active: true, cells: {} } };
  let q = Q(start(db), { type: "create", id: Z, styleId: sid(1), width: 10, length: 12, at: 0 }, commit(Z, "price", 3000));
  [q] = roundTrip(q, db, { exists: { [Z]: E } });
  assertEquals([q.sizes[Z], q.renamed], [undefined, { [Z]: E }]);
  assertEquals(field(q, E, "price").error, { kind: "conflict", typed: 3000, server: 2500, reason: "Someone else just added this size. Check its numbers and type yours again." });
  assertEquals(S.ssPgErrorLine("Test Barn 10x12", { name: "Price", kind: "price" }, field(q, E, "price").error),
    "Test Barn 10x12 · Price: Someone else just added this size. Check its numbers and type yours again.");
  assertEquals(S.ssPgBuildBatch(q), null);
});

Deno.test("queue 9: a refresh between commit and send, another tab having changed the same box: red at once, nothing sent, version kept", () => {
  const db = DB();
  let q = Q(start(db), commit(A, "price", 480));
  q = Q(q, { type: "refresh", okAt: 0, sizes: { ...copy(db), [A]: { version: "2026-10-30T00:00:00.000009+00:00", price: 450, active: true, cells: { loft: 55 } } } });
  assertEquals(field(q, A, "price").error, { kind: "conflict", typed: 480, server: 450, reason: null });
  assertEquals(q.sizes[A].version, V0, "a size with local edits keeps the version they were made against");
  assertEquals([q.sizes[A].price, q.sizes[A].cells.loft], [450, 55], "every box not in flight shows what the server holds now");
  assertEquals(S.ssPgBuildBatch(q), null);
});

Deno.test("queue 10: a refresh adopts the new version and values of a size with nothing local, and names the boxes that moved", () => {
  const db = DB();
  const V9 = "2026-10-30T00:00:00.000009+00:00";
  const q = Q(start(db), commit(A, "price", 480), { type: "refresh", okAt: 0, sizes: { ...copy(db), [B]: { version: V9, price: 2150, active: true, cells: { loft: 10 } } } });
  assertEquals(q.sizes[B], { version: V9, price: 2150, active: true, cells: { loft: 10 } });
  assertEquals(q.flash.changed, { [B]: ["price", "c:loft"] });
  assertEquals(field(q, A, "price").pending.to, 480, "an edit whose starting value still holds stays unsent");
});

Deno.test("queue 11: a refresh asked for before the latest answer is dropped, and another read is wanted", () => {
  const db = DB();
  let q = Q(start(db), commit(A, "price", 480), { type: "send" });
  const okAt = q.oks;   // the page notes this when it asks
  q = Q(q, { type: "ok", n: q.flight.n, answer: serve(db, q.flight.body) });
  const after = Q(q, { type: "refresh", okAt, sizes: copy(DB()) });   // read before the save landed: 400 on V0
  assertEquals([after.sizes[A].price, after.sizes[A].version, after.reread], [480, db[A].version, true]);
});

Deno.test("queue 12: Offered unticked while a colleague changed the price: no conflict, one resend", () => {
  const db = DB();
  let q = Q(start(db), commit(A, "active", false), { type: "send" });
  db[A].price = 450; db[A].version = nextV();   // the colleague's price
  q = Q(q, { type: "ok", n: q.flight.n, answer: serve(db, q.flight.body) });
  assertEquals(field(q, A, "active"), { pending: { to: false, from: true, seq: 1 } }, "Offered still held `from`: not a real conflict");
  assertEquals([q.flush, q.retried[A]], [true, true]);
  let body;
  [q, body] = roundTrip(q, db);
  assertEquals(body.sizes, [{ id: A, base: body.sizes[0].base, from: { active: true }, to: { active: false } }]);
  assert(body.sizes[0].base !== V0, "resent on the new version");
  assertEquals([db[A].active, db[A].price, S.ssPgCount(q).red], [false, 450, 0], "the colleague's price stands; nothing red");
});

Deno.test("queue 13: a conflict on another field gives one resend; a second conflict on the same size turns it red", () => {
  const db = DB();
  let q = Q(start(db), commit(A, "c:loft", 80), { type: "send" });
  db[A].price = 450; db[A].version = nextV();
  q = Q(q, { type: "ok", n: q.flight.n, answer: serve(db, q.flight.body) });
  assertEquals(field(q, A, "c:loft").pending, { to: 80, from: 50, seq: 1 });
  q = Q(q, { type: "send" });
  db[A].price = 460; db[A].version = nextV();   // and again, before the resend lands
  q = Q(q, { type: "ok", n: q.flight.n, answer: serve(db, q.flight.body) });
  assertEquals(field(q, A, "c:loft"), { error: { kind: "conflict", typed: 80, server: 50, reason: null } }, "no second resend: red");
  assertEquals([S.ssPgBuildBatch(q), db[A].cells.loft], [null, 50]);
});

Deno.test("queue 14: a column that went away drops its unsent and red boxes, with a note", () => {
  const db = DB();
  let q = Q(start(db), commit(A, "c:101", 2), commit(B, "c:101", 1), commit(A, "c:loft", 70),
    { type: "invalid", sizeId: C, f: "c:101", typed: "x", reason: "Whole numbers only, 0 or more" });
  q = Q(q, { type: "columns", keys: ["loft"], names: { "101": "Test Door", loft: "Loft" } });
  assertEquals([field(q, A, "c:101"), field(q, B, "c:101"), field(q, C, "c:101")], [undefined, undefined, undefined]);
  assertEquals(field(q, A, "c:loft").pending.to, 70);
  assertEquals(q.note, { text: "Test Door was archived in Options; 3 unsaved boxes in that column were dropped." });
  const one = Q(start(db), commit(A, "c:101", 2), { type: "columns", keys: ["loft"], names: { "101": "Test Door" } });
  assertEquals(one.note.text, "Test Door was archived in Options; 1 unsaved box in that column was dropped.");
});

Deno.test("queue 15: a transport failure keeps the same call and backs off 2/5/15/30 s; the fifth stops saving; Retry resumes it", () => {
  const db = DB();
  let q = Q(start(db), commit(A, "price", 480), { type: "send" });
  const body = q.flight.body;
  for (let i = 1; i <= 4; i++) {
    q = Q(q, { type: "fail", n: q.flight.n, kind: "transport" });
    assertEquals([q.failures, q.stopped, q.flight.body === body], [i, null, true]);
  }
  assertEquals([1, 2, 3, 4, 9].map((n) => S.ssPgBackoff(n)), [2000, 5000, 15000, 30000, 30000]);
  assertEquals(S.ssPgBackoff(1, [10, 20]), 10, "the harness's shorter schedule");
  q = Q(q, { type: "fail", n: q.flight.n, kind: "transport" });
  assertEquals(q.stopped, { kind: "transport", reason: "couldn't reach the server" });
  assert(Q(q, { type: "send" }) === q, "nothing goes while stopped");
  assertEquals(field(q, A, "price").inflight.to, 480, "the edit is kept");
  q = Q(q, { type: "resume" });
  assertEquals([q.stopped, q.failures, q.flight.body === body], [null, 0, true], "Retry resends the very same call");
});

Deno.test("queue 16: a 403 turns the page view-only; what was out is unsent again, and nothing more goes", () => {
  const db = DB();
  let q = Q(start(db), commit(A, "price", 480), { type: "send" }, commit(A, "price", 490));
  q = Q(q, { type: "fail", n: q.flight.n, kind: "forbidden", reason: "You can't change Sheds on this account" });
  assertEquals(q.viewOnly, { reason: "You can't change Sheds on this account" });
  assertEquals(field(q, A, "price"), { pending: { to: 490, from: 400, seq: 2 } }, "the follow-up folds into the unsent edit, from where the flight started");
  assert(Q(q, { type: "send" }) === q);
  assertEquals(S.ssPgDueIn(q, 0), null);
  assertEquals(S.ssPgCount(q).pending, 1, "still counted for the leave prompt");
});

Deno.test("queue: A→B→A with a lost answer: the resend comes back duplicate, the next edit goes on its version, and the stalled original changes nothing", () => {
  const db = DB();
  let q = Q(start(db), commit(A, "price", 480), { type: "send" });
  const original = q.flight.body, n1 = q.flight.n;
  serve(db, original);   // it landed, but its answer was lost on the way back
  q = Q(q, { type: "fail", n: n1, kind: "transport" });
  const resent = serve(db, original);   // the same call again, after the backoff
  assertEquals(resent.results[0].status, "duplicate");
  q = Q(q, { type: "ok", n: n1, answer: resent });
  assertEquals([q.sizes[A].price, S.ssPgCount(q).red, q.failures], [480, 0, 0]);
  const v1 = db[A].version;
  let body;
  [q, body] = roundTrip(Q(q, commit(A, "price", 400)), db);
  assertEquals(body.sizes, [{ id: A, base: v1, from: { price: 480 }, to: { price: 400 } }]);
  // The stalled first copy finally reaches the server: its base is gone and 400 is not its `to`.
  const late = serve(db, original);
  assertEquals([late.results[0].status, db[A].price], ["conflict", 400], "the server writes nothing");
  assert(Q(q, { type: "ok", n: n1, answer: late }) === q, "and nobody is waiting for that answer");
});

Deno.test("queue: a refused box and a refused size go red with the server's reason, keep the server's value, and are never resent", () => {
  const db = DB();
  let q = Q(start(db), commit(A, "c:101", 2), commit(A, "c:loft", 60), commit(A, "price", 500));
  [q] = roundTrip(q, db, { allowed: ["loft"] });
  assertEquals(field(q, A, "c:101"), { error: { kind: "refused", typed: 2, reason: "That option has no column in your sizes table" } });
  assertEquals([field(q, A, "c:loft"), field(q, A, "price"), q.sizes[A].cells.loft, q.sizes[A].price], [undefined, undefined, 60, 500], "the rest of the size saved");
  assertEquals([...q.flash.saved[A]].sort(), ["c:loft", "price"]);
  assertEquals(S.ssPgBuildBatch(q), null);
  // Real-Time Pricing owns the price: refused per box.
  [q] = roundTrip(Q(q, commit(B, "price", 2300)), db, { rtp: true });
  assertEquals(field(q, B, "price").error.reason, "Real-Time Pricing sets prices on this account");
  // A whole size refused, and one gone from the account.
  q = Q(q, commit(C, "c:loft", 5), { type: "send" });
  q = Q(q, { type: "ok", n: q.flight.n, answer: { ok: true, created: [], removed: [], results: [
    { id: C, status: "refused", version: V0, row: { price: null, active: false }, cells: { loft: 0 }, reason: "The database refused this change." }] } });
  assertEquals(field(q, C, "c:loft").error, { kind: "refused", typed: 5, reason: "The database refused this change." });
  delete db[B];
  [q] = roundTrip(Q(q, commit(B, "c:loft", 3)), db);
  assertEquals(field(q, B, "c:loft").error, { kind: "refused", typed: 3, reason: "That size isn't on this account any more." });
  assertEquals(S.ssPgCount(q).red, 4);
});

Deno.test("queue: a 400 turns every box in the call red; a bad entry typed here is red and never queued; Dismiss clears it", () => {
  const db = DB();
  let q = Q(start(db), commit(A, "price", 480), commit(B, "c:loft", 1), { type: "send" });
  q = Q(q, { type: "fail", n: q.flight.n, kind: "refused", reason: "This change couldn't be saved. Tell CSM Synergy if it keeps happening" });
  assertEquals([field(q, A, "price").error.kind, field(q, B, "c:loft").error.typed, q.flight], ["refused", 1, null]);
  q = Q(start(db), commit(A, "c:loft", 60), { type: "invalid", sizeId: A, f: "c:loft", typed: "abc", reason: "Whole numbers only, 0 or more" });
  assertEquals(field(q, A, "c:loft"), { error: { kind: "invalid", typed: "abc", reason: "Whole numbers only, 0 or more" } }, "the newest thing typed there is the bad one");
  assertEquals(S.ssPgBuildBatch(q), null);
  assertEquals(S.ssPgErrorLine("Test Barn 10x12", { name: "Loft (sq ft)", kind: "qty" }, field(q, A, "c:loft").error),
    "Test Barn 10x12 · Loft (sq ft): “abc” wasn't saved. Whole numbers only, 0 or more.");
  q = Q(q, { type: "dismiss", sizeId: A, f: "c:loft" });
  assertEquals(q.fields, {});
});

Deno.test("queue: 401, an answer for another account, Discard, and an answer the call left out", () => {
  const db = DB();
  const q = Q(start(db), commit(A, "price", 480), { type: "send" });
  const auth = Q(q, { type: "fail", n: q.flight.n, kind: "auth", reason: "you were signed out" });
  assertEquals([auth.stopped.kind, field(auth, A, "price").pending.to], ["auth", 480]);
  const other = Q(q, { type: "fail", n: q.flight.n, kind: "tenant", reason: "x" });
  assertEquals(other.stopped.kind, "tenant");
  assert(Q(other, { type: "resume" }) === other, "an answer for another account is never retried from the page");
  // Discard: unsent and in-flight edits go; red ones stay; a late answer is ignored.
  const red = Q(q, { type: "invalid", sizeId: B, f: "price", typed: "abc", reason: "A price is a number, 0 or more" }, commit(C, "c:loft", 3));
  const gone = Q(red, { type: "discard" });
  assertEquals([field(gone, A, "price"), field(gone, C, "c:loft"), field(gone, B, "price").error.typed, gone.flight], [undefined, undefined, "abc", null]);
  assert(Q(gone, { type: "ok", n: q.flight.n, answer: serve(copy(db), q.flight.body) }) === gone);
  // A size the answer does not mention goes red with what was typed: never lost, and never resent
  // every 800 ms by a server that keeps leaving it out.
  const left = Q(q, { type: "ok", n: q.flight.n, answer: { ok: true, created: [], removed: [], results: [] } });
  assertEquals(field(left, A, "price"), { error: { kind: "refused", typed: 480, reason: "The server didn't answer for this change. Type it again" } });
  assertEquals([S.ssPgBuildBatch(left), S.ssPgDueIn(left, 0)], [null, null]);
  const made = Q(start(db), { type: "create", id: Z, styleId: sid(1), width: 10, length: 16, at: 0 }, { type: "send" });
  const lost = Q(made, { type: "ok", n: made.flight.n, answer: { ok: true, created: [], removed: [], results: [] } });
  assertEquals([lost.sizes[Z], lost.note && lost.note.text], [undefined, "Couldn't add 10x16: the server didn't answer. Add it again."]);
});

Deno.test("queue: the 50-entry and 2,500-box caps split work into calls, and every box goes exactly once", () => {
  assertEquals([MAX_CALL_ENTRIES, MAX_CALL_CELLS], [50, 2500], "the browser's caps are the server's");
  const id = (lead: string, i: number) => `${lead}0000000-0000-4000-8000-${String(i).padStart(12, "0")}`;
  // 60 sizes with a price each: 50, then 10.
  const many: Record<string, Row> = {};
  for (let i = 0; i < 60; i++) many[id("4", i)] = { version: V0, price: 100, active: true, cells: {} };
  const ids = Object.keys(many);
  let q = Q(S.ssPgQueue(null, { type: "init", sizes: copy(many), cols: [] }), ...ids.map((x, i) => commit(x, "price", 200 + i)));
  let b1, b2;
  [q, b1] = roundTrip(q, many);
  assertEquals(b1.sizes.length, 50);
  assert(S.ssPgDueIn(q, 0) != null, "the rest is due");
  [q, b2] = roundTrip(q, many);
  assertEquals(b2.sizes.length, 10);
  assertEquals(new Set([...b1.sizes, ...b2.sizes].map((s: Any) => s.id)).size, 60);
  assertEquals(S.ssPgCount(q), { pending: 0, inflight: 0, red: 0, creating: 0, removing: 0 });
  // 40 sizes x 70 option boxes = 2,800 boxes: 2,500 in the first call (the 36th size split), the rest next.
  const keys = Array.from({ length: 70 }, (_, i) => `k${i}`);
  const wide: Record<string, Row> = {};
  for (let i = 0; i < 40; i++) wide[id("5", i)] = { version: V0, price: 100, active: true, cells: {} };
  const wids = Object.keys(wide);
  q = Q(S.ssPgQueue(null, { type: "init", sizes: copy(wide), cols: keys }), ...wids.flatMap((x) => keys.map((k) => commit(x, "c:" + k, 1))));
  const sentCells = (b: Any) => b.sizes.reduce((n: number, s: Any) => n + Object.keys(s.to.cells || {}).length, 0);
  [q, b1] = roundTrip(q, wide);
  assertEquals([b1.sizes.length, sentCells(b1), Object.keys(b1.sizes[35].to.cells).length], [36, 2500, 50]);
  [q, b2] = roundTrip(q, wide);
  assertEquals([b2.sizes.length, sentCells(b2)], [5, 300]);
  assert(wids.every((x) => keys.every((k) => wide[x].cells[k] === 1)), "every box landed, none twice");
  // Creates count toward the 50, and go first.
  q = Q(start(DB()), ...Array.from({ length: 30 }, (_, i) => ({ type: "create", id: id("6", i), styleId: sid(1), width: 10, length: 20 + i, at: 0 })),
    commit(A, "price", 1), commit(B, "price", 2));
  const b3 = S.ssPgBuildBatch(q, { entries: 31 });
  assertEquals([b3.creates.length, b3.body.creates.length, b3.body.sizes.length], [30, 30, 1]);
  assert(validatePayload(S.ssPgBuildBatch(q).body).ok);
});

Deno.test("queue: the send clock: 800 ms after the last edit, at most 3 s after the first unsent one, at once after a flush", () => {
  let q = Q(start(DB()), commit(A, "price", 401, 1000));
  assertEquals(S.ssPgDueIn(q, 1000), 800);
  for (let t = 1500; t <= 3500; t += 500) q = Q(q, commit(A, "price", 400 + t, t));
  assertEquals(S.ssPgDueIn(q, 3500), 500, "3 s after the first edit, not 800 ms after the last");
  assertEquals(S.ssPgDueIn(Q(q, { type: "flush" }), 3500), 0);
  q = Q(q, { type: "send" });
  assertEquals([q.firstAt, q.lastAt, q.flush], [null, null, false], "nothing left: the clock resets");
});

Deno.test("ssPgAnswerKind: what one save answer means (plan 4.7)", () => {
  const k = (r: Any, expect = "test-barns") => S.ssPgAnswerKind(r, expect).kind;
  assertEquals(k({ data: { ok: true, clientId: "test-barns", results: [] }, error: null }), "ok");
  assertEquals(k({ data: { ok: true, clientId: "other-barns" }, error: null }), "tenant");
  assertEquals(k({ data: null, error: { message: "timed out", ssTimeout: true } }), "transport");
  assertEquals(k({ data: null, error: { message: "Failed to fetch", name: "FunctionsFetchError" } }), "transport");
  assertEquals(k({ data: null, error: { message: "Your session is reconnecting" } }), "transport");
  for (const s of [500, 502, 503, 504, 408, 429]) assertEquals(k({ data: null, error: { message: "x", ssStatus: s } }), "transport", String(s));
  for (const s of [400, 404, 409]) assertEquals(k({ data: null, error: { message: "x", ssStatus: s } }), "refused", String(s));
  assertEquals(k({ data: null, error: { message: "x", ssStatus: 403 } }), "forbidden");
  assertEquals(k({ data: null, error: { message: "x", ssStatus: 401 } }), "auth");
  assertEquals(k({ data: { error: "Nothing to save" }, error: null }), "refused");
  assertEquals(k({ data: null, error: null }), "transport");
});

Deno.test("ssPgErrorLine: the status line's sentences (plan 3.14)", () => {
  const P = { name: "Price", kind: "price" }, O = { name: "Offered", kind: "active" }, L = { name: "Loft (sq ft)", kind: "qty" };
  assertEquals(S.ssPgErrorLine("Barn 12x24", P, { kind: "conflict", typed: 4800, server: 4950, reason: null }),
    "Barn 12x24 · Price: changed elsewhere to $4,950 while you typed $4,800. Type it again if yours is right.");
  assertEquals(S.ssPgErrorLine("Barn 12x24", P, { kind: "conflict", typed: 4800, server: null, reason: null }),
    "Barn 12x24 · Price: cleared elsewhere while you typed $4,800. Type it again if yours is right.");
  assertEquals(S.ssPgErrorLine("Barn 12x24", L, { kind: "conflict", typed: 0, server: 2, reason: null }),
    "Barn 12x24 · Loft (sq ft): changed elsewhere to 2 while you cleared it. Type it again if yours is right.");
  assertEquals(S.ssPgErrorLine("Barn 12x24", O, { kind: "conflict", typed: false, server: true, reason: null }),
    "Barn 12x24 · Offered: changed elsewhere to offered while you unticked it. Set it again if yours is right.");
  assertEquals(S.ssPgErrorLine("Barn 12x24", L, { kind: "refused", typed: 2, reason: "That option has no column in your sizes table" }),
    "Barn 12x24 · Loft (sq ft): That option has no column in your sizes table.");
  assertEquals(S.ssPgErrorLine("Barn 12x24", P, { kind: "invalid", typed: "-5", reason: "A price is a number, 0 or more" }),
    "Barn 12x24 · Price: “-5” wasn't saved. A price is a number, 0 or more.");
  assertEquals(S.ssPgErrorLine("Barn 12x24", P, null), "");
});

Deno.test("ssPgRowView: the server's values with this page's edits on top, and one mark per column", () => {
  const m = H.ssPgModel(TCAT, TABLE);
  const z = m.styles[0].sizes.find((x: Any) => x.id === zid(3));   // 12x24: $4,800, loft 50, door 2
  const s = S.ssPgServerSizes(m)[zid(3)];
  assertEquals(s, { version: "2026-10-04T00:00:00.123456+00:00", price: 4800, active: true, cells: { loft: 50, "11": 2 } });
  assertEquals(S.ssPgRowView(z, null, null, m.cols).values, z.values, "before the queue exists: the model's own");
  const plain = S.ssPgRowView(z, s, null, m.cols);
  assertEquals([plain.priceText, plain.values, plain.marks, plain.offered], ["$4,800", ["50", "", "2"], "", true]);
  const fs = { price: { pending: { to: null, from: 4800, seq: 1 } }, "c:loft": { inflight: { to: 0, from: 50, seq: 2 } },
    "c:11": { error: { kind: "conflict", typed: 3, server: 2 } }, "c:workbench": { error: { kind: "invalid", typed: "x", reason: "" } } };
  const v = S.ssPgRowView(z, s, fs, m.cols);
  assertEquals([v.priceText, v.values, v.marks, v.offered, v.noPrice, v.hidden], ["", ["", "", "2"], "-p-prc", false, true, true],
    "a cleared price hides the size at once; a red box shows the server's value");
  const unpriced = S.ssPgRowView(m.styles[0].sizes.find((x: Any) => x.id === zid(2)), { version: "v", price: null, active: false, cells: {} },
    { price: { pending: { to: 900, from: null, seq: 1 } } }, m.cols);
  assertEquals([unpriced.priceText, unpriced.noPrice], ["$900", true], "Offered stays disabled until the first price is on file");
});

Deno.test("ssPgColBox: the overlay's columns; Size, Price and Offered frozen, Size alone below 700 px", () => {
  assertEquals([0, 1, 2, 3, 4].map((c) => S.ssPgColBox(c, false)), [
    { x: 0, w: 64, frozen: true }, { x: 64, w: 76, frozen: true }, { x: 140, w: 30, frozen: true }, { x: 170, w: 44, frozen: false }, { x: 214, w: 44, frozen: false }]);
  assertEquals([0, 1, 2].map((c) => S.ssPgColBox(c, true).frozen), [true, false, false]);
});
