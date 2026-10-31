// Pricing Table helpers (portal/03-catalog.jsx), lifted from the SHIPPED source. The Excel template
// and the Pricing Table both build their option columns with ssPricingColumns, so a change to it
// changes the header builders download. The golden header below is today's sheet: if it moves,
// every builder's saved sheet stops matching on re-upload (columns are matched by exact label).

import { assert, assertEquals } from "jsr:@std/assert";
import { MAX_CALL_CELLS, MAX_CALL_ENTRIES, parseDim, parsePrice, parseQty, sizeLabel, validatePayload } from "../pricingCells.ts";
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
  // Removes: a size never priced and with nothing included goes; one that exists nowhere is gone already.
  const removed = (body.removes || []).map((id: string) => {
    const r = db[id];
    if (!r) return { id, status: "removed", gone: true };
    if (r.price == null && !Object.keys(r.cells).length) { delete db[id]; return { id, status: "removed" }; }
    return { id, status: "refused", reason: "Only a size that was never priced or edited can be removed. Untick Offered to hide it." };
  });
  return { ok: true, clientId: "test-barns", created, removed, results };
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

// A 400 for a call carrying a create: the size was never added, and the status line says so, as it
// does for a create the server refuses alone; nothing is left red to show it otherwise.
Deno.test("queue: a 400 for a call with new sizes in it names them, and what was typed on them, in the status line", () => {
  const db = DB();
  const why = "This change couldn't be saved. Tell CSM Synergy if it keeps happening";
  let q = Q(start(db), { type: "create", id: Z, styleId: sid(1), width: 12, length: 16, at: 0 }, { type: "send" }, commit(Z, "price", 3000));
  q = Q(q, { type: "fail", n: q.flight.n, kind: "refused", reason: why });
  assertEquals([q.sizes[Z], q.fields[Z], q.flight, S.ssPgCount(q)], [undefined, undefined, null, { pending: 0, inflight: 0, red: 0, creating: 0, removing: 0 }]);
  assertEquals(q.note, { text: "Couldn't add 12x16: This change couldn't be saved. Tell CSM Synergy if it keeps happening. What was typed on it wasn't saved either." });
  let r = start(db);
  for (let i = 0; i < 5; i++) r = Q(r, { type: "create", id: zid(40 + i), styleId: sid(1), width: 8, length: 10 + i, at: 0 });
  r = Q(r, { type: "send" });
  r = Q(r, { type: "fail", n: r.flight.n, kind: "refused", reason: why });
  assertEquals(r.note, { text: "Couldn't add 8x10, 8x11, 8x12 and 2 more: This change couldn't be saved. Tell CSM Synergy if it keeps happening." });
  // A 400 with no create in it keeps whatever the status line already said.
  const p = Q(start(db), commit(A, "price", 480), { type: "send" });
  assertEquals(Q(p, { type: "fail", n: p.flight.n, kind: "refused", reason: why }).note, null);
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

// Review fixes (2026-10-31).
Deno.test("queue: an answer that moves a box under the open editor turns the editor's commit red, and a colleague's value is never overwritten", () => {
  const db = DB();
  // Offered unticked goes out; the editor opens on Price showing $400.
  let q = Q(start(db), commit(A, "active", false), { type: "send" });
  const seen = S.ssPgVal(q.sizes[A], "price");
  db[A].price = 450; db[A].version = nextV();   // a colleague, meanwhile
  q = Q(q, { type: "ok", n: q.flight.n, answer: serve(db, q.flight.body) });
  assertEquals(q.sizes[A].price, 450, "the conflict on Offered brought the colleague's price");
  q = Q(q, { ...commit(A, "price", 500), seen });
  assertEquals(field(q, A, "price"), { error: { kind: "conflict", typed: 500, server: 450, reason: null } });
  assertEquals(S.ssPgErrorLine("Test Barn 10x12", { name: "Price", kind: "price" }, field(q, A, "price").error),
    "Test Barn 10x12 · Price: changed elsewhere to $450 while you typed $500. Type it again if yours is right.");
  let body;
  [q, body] = roundTrip(q, db);
  assertEquals(body.sizes.map((s: Any) => s.to), [{ active: false }], "only Offered's resend goes; the price is never sent");
  assertEquals([db[A].price, db[A].active, S.ssPgBuildBatch(q)], [450, false, null]);
  // Typing exactly what is there now is no change; typing again, the editor seeing $450, is an edit.
  assertEquals(field(Q(q, { ...commit(A, "price", 450), seen }), A, "price"), undefined);
  assertEquals(field(Q(q, { ...commit(A, "price", 500), seen: 450 }), A, "price").pending, { to: 500, from: 450, seq: 2 });
});

Deno.test("queue: the editor's own box moving with its own flight is not a conflict; its flight's red verdict is, and a refusal keeps its reason", () => {
  // Opened over an in-flight 480 that lands, or comes back to be resent: an ordinary edit.
  let db = DB();
  let q = Q(start(db), commit(A, "price", 480), { type: "send" });
  const seen = 480;   // the box shows the in-flight 480
  const landed = Q(q, { type: "ok", n: q.flight.n, answer: serve(copy(db), q.flight.body) }, { ...commit(A, "price", 500), seen });
  assertEquals(field(landed, A, "price"), { pending: { to: 500, from: 480, seq: 2 } });
  db = DB();
  q = Q(start(db), commit(A, "price", 480), { type: "send" });
  db[A].cells.loft = 60; db[A].version = nextV();   // a colleague, on another box
  const resent = Q(q, { type: "ok", n: q.flight.n, answer: serve(db, q.flight.body) }, { ...commit(A, "price", 500), seen });
  assertEquals(field(resent, A, "price"), { pending: { to: 500, from: 400, seq: 2 } }, "from what is on file: nobody else touched it");
  // The flight itself in conflict: the box shows the colleague's $4,950 now, so what was typed goes red.
  db = DB();
  q = Q(start(db), commit(A, "price", 480), { type: "send" });
  db[A].price = 4950; db[A].version = nextV();
  q = Q(q, { type: "ok", n: q.flight.n, answer: serve(db, q.flight.body) }, { ...commit(A, "price", 500), seen });
  assertEquals(field(q, A, "price"), { error: { kind: "conflict", typed: 500, server: 4950, reason: null } });
  assertEquals(S.ssPgBuildBatch(q), null);
  // Refused while the editor was open: the server's reason stays.
  db = DB();
  q = Q(start(db), commit(A, "c:101", 2), { type: "send" });
  q = Q(q, { type: "ok", n: q.flight.n, answer: serve(db, q.flight.body, { allowed: ["loft"] }) }, { ...commit(A, "c:101", 3), seen: 2 });
  assertEquals(field(q, A, "c:101"), { error: { kind: "refused", typed: 3, reason: "That option has no column in your sizes table" } });
});

// Review fixes, round 2 (2026-10-31).
Deno.test("queue: a box waiting behind a call goes red when the answer brings a colleague's value for it, and is never sent", () => {
  // Loft 50 → 60 goes; then the price 400 → 480 and Test Door 0 → 2 are typed, waiting behind it. A
  // colleague sets the price to $500 and Loft to 70 meanwhile: the answer is a conflict on Loft,
  // carrying their row.
  let db = DB();
  let q = Q(start(db), commit(A, "c:loft", 60), { type: "send" }, commit(A, "price", 480), commit(A, "c:101", 2));
  db[A].price = 500; db[A].cells.loft = 70; db[A].version = nextV();
  q = Q(q, { type: "ok", n: q.flight.n, answer: serve(db, q.flight.body) });
  assertEquals(field(q, A, "price"), { error: { kind: "conflict", typed: 480, server: 500, reason: null } }, "red at once, with both numbers");
  assertEquals(field(q, A, "c:loft"), { error: { kind: "conflict", typed: 60, server: 70, reason: null } });
  assertEquals(field(q, A, "c:101"), { pending: { to: 2, from: 0, seq: 3 } }, "a box whose starting value still holds still goes");
  const v = S.ssPgRowView({ priceText: "", values: [] }, q.sizes[A], q.fields[A], [{ key: "loft" }, { key: "101" }]);
  assertEquals([v.priceText, v.marks], ["$500", "-c-cp"], "the grid shows the colleague's $500, marked changed elsewhere");
  let body;
  [q, body] = roundTrip(q, db);
  assertEquals(body.sizes.map((s: Any) => [s.from, s.to]), [[{ cells: { 101: 0 } }, { cells: { 101: 2 } }]], "only Test Door goes; the price never does");
  // The editor was open on the price when the answer landed (it showed $480): what is typed then is
  // red too. Before, its `from` became the colleague's $500 and the server let it overwrite them.
  q = Q(q, { ...commit(A, "price", 490), seen: 480 });
  assertEquals(field(q, A, "price"), { error: { kind: "conflict", typed: 490, server: 500, reason: null } });
  assertEquals([S.ssPgBuildBatch(q), db[A].price, db[A].active], [null, 500, true]);
  // Typed or cleared over the $500 now on screen: the builder's own edit, from $500.
  assertEquals(field(Q(q, { ...commit(A, "price", 490), seen: 500 }), A, "price").pending, { to: 490, from: 500, seq: 4 });
  assertEquals(field(Q(q, commit(A, "price", null)), A, "price").pending, { to: null, from: 500, seq: 4 });
  // A resend that had already landed comes back duplicate, with the colleague's row: the same.
  db = DB();
  q = Q(start(db), commit(A, "c:loft", 60), { type: "send" });
  const sent = q.flight.body;
  serve(db, sent);                                   // it landed; the answer was lost
  q = Q(q, { type: "fail", n: q.flight.n, kind: "transport" }, commit(A, "price", 480));
  db[A].price = 500; db[A].version = nextV();
  const dup = serve(db, sent);
  assertEquals(dup.results[0].status, "duplicate");
  q = Q(q, { type: "ok", n: q.flight.n, answer: dup });
  assertEquals([field(q, A, "c:loft"), field(q, A, "price")], [undefined, { error: { kind: "conflict", typed: 480, server: 500, reason: null } }]);
  assertEquals([S.ssPgBuildBatch(q), db[A].price], [null, 500]);
  // A colleague who typed the very number waiting here: nothing left to send, nothing red.
  db = DB();
  q = Q(start(db), commit(A, "c:loft", 60), { type: "send" }, commit(A, "price", 480));
  db[A].price = 480; db[A].version = nextV();
  q = Q(q, { type: "ok", n: q.flight.n, answer: serve(db, q.flight.body) });
  assertEquals([field(q, A, "price"), q.sizes[A].price], [undefined, 480]);
});

Deno.test("queue: a resend keeps a box marked not valid during the flight red; a follow-up folds into the resend from what is on file", () => {
  // 480 out, then "abc" typed over the same box; a colleague changes another box: conflict, resend.
  let db = DB();
  const bad = { type: "invalid", sizeId: A, f: "price", typed: "abc", reason: "A price is a number, 0 or more" };
  let q = Q(start(db), commit(A, "price", 480), { type: "send" }, bad);
  db[A].cells.loft = 60; db[A].version = nextV();
  q = Q(q, { type: "ok", n: q.flight.n, answer: serve(db, q.flight.body) });
  assertEquals(field(q, A, "price"), { pending: { to: 480, from: 400, seq: 1 }, error: { kind: "invalid", typed: "abc", reason: "A price is a number, 0 or more" } },
    "the in-flight 480 goes again (as it would have landed), and the red 'abc' stays");
  let body;
  [q, body] = roundTrip(q, db);
  assertEquals(body.sizes[0].to, { price: 480 });
  assertEquals([db[A].price, field(q, A, "price"), S.ssPgCount(q).red], [480, { error: { kind: "invalid", typed: "abc", reason: "A price is a number, 0 or more" } }, 1]);
  // 480 out, 490 typed after it; the colleague's change is on another box: one resend of 490, from 400.
  db = DB();
  q = Q(start(db), commit(A, "price", 480), { type: "send" }, commit(A, "price", 490));
  db[A].cells.loft = 60; db[A].version = nextV();
  q = Q(q, { type: "ok", n: q.flight.n, answer: serve(db, q.flight.body) });
  assertEquals(field(q, A, "price"), { pending: { to: 490, from: 400, seq: 2 } });
  [q, body] = roundTrip(q, db);
  assertEquals([body.sizes[0].from, body.sizes[0].to, db[A].price, db[A].cells.loft, S.ssPgCount(q).red], [{ price: 400 }, { price: 490 }, 490, 60, 0]);
});

Deno.test("queue: removing a size whose create has not gone drops it here; one whose create is out goes after the answer; never both in one call", () => {
  const zero = { pending: 0, inflight: 0, red: 0, creating: 0, removing: 0 };
  const db = DB();
  const make = { type: "create", id: Z, styleId: sid(1), width: 10, length: 16, at: 0 };
  let q = Q(start(db), make, commit(Z, "price", 3000), { type: "remove", id: Z });
  assertEquals([q.sizes[Z], q.fields[Z], S.ssPgBuildBatch(q), S.ssPgCount(q)], [undefined, undefined, null, zero], "never added: nothing to send");
  q = Q(start(db), make, { type: "send" }, { type: "remove", id: Z });
  assertEquals(q.removes, { [Z]: "pending" });
  let body;
  q = Q(q, { type: "ok", n: q.flight.n, answer: serve(db, q.flight.body) });
  [q, body] = roundTrip(q, db);   // validatePayload accepts it (roundTrip asserts)
  assertEquals([body.creates, body.removes], [[], [Z]]);
  assertEquals([q.sizes[Z], db[Z], S.ssPgCount(q)], [undefined, undefined, zero]);
  // Every call a create-then-remove can build passes the server's shape check.
  q = Q(start(db), make, { type: "create", id: E, styleId: sid(1), width: 12, length: 16, at: 0 }, { type: "remove", id: Z }, { type: "remove", id: A });
  assert(validatePayload(S.ssPgBuildBatch(q).body).ok, JSON.stringify(validatePayload(S.ssPgBuildBatch(q).body)));
});

Deno.test("queue: Discard after a call that may have landed is unsure until a fresh read, which shows what is on file and says part had saved", () => {
  const db = DB();
  let q = Q(start(db), commit(A, "price", 480), { type: "send" });
  serve(db, q.flight.body);   // it landed; every answer was lost
  for (let i = 0; i < 5; i++) q = Q(q, { type: "fail", n: q.flight.n, kind: "transport" });
  q = Q(q, { type: "discard" });
  assertEquals([q.unsure, q.sizes[A].price, q.flight, S.ssPgCount(q).pending], [{ [A]: true }, 400, null, 0]);
  assertEquals(Q(start(db), commit(B, "price", 1), { type: "discard" }).unsure, null, "edits that never went out: nothing to be unsure of");
  q = Q(q, { type: "refresh", okAt: q.oks, sizes: copy(db) });
  assertEquals([q.unsure, q.sizes[A].price, q.sizes[A].version], [null, 480, db[A].version]);
  assertEquals(q.note, { text: "Part of what you discarded had already saved. The table shows what's on file now." });
  // Typing 400 back now sends it, from the 480 on file.
  let body;
  [q, body] = roundTrip(Q(q, commit(A, "price", 400)), db);
  assertEquals([body.sizes[0].from, db[A].price], [{ price: 480 }, 400]);
  // Nothing had landed: the read settles it without a note.
  const db2 = DB();
  let r = Q(start(db2), commit(A, "price", 480), { type: "send" });
  for (let i = 0; i < 5; i++) r = Q(r, { type: "fail", n: r.flight.n, kind: "transport" });
  r = Q(r, { type: "discard" }, { type: "refresh", okAt: 0, sizes: copy(db2) });
  assertEquals([r.unsure, r.note, r.sizes[A].price], [null, null, 400]);
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
  assertEquals(s, { version: "2026-10-04T00:00:00.123456+00:00", price: 4800, active: true, cells: { loft: 50, "11": 2 }, created: "2026-10-01T00:00:00.000001+00:00" });
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

// ─── Phase 4a: adding sizes, Remove, the refresh and the backup (2026-10-31) ───────────────────
// Lifted the same way, from the shipped text. Each is a top-level `function x(…) {` whose only free
// names are the helpers above it.
const P4 = ["function ssPgParseSizeList(text, existing, max) {", "function ssPgSizeGrid(widthsText, lengthsText, existing, unticked, max) {",
  "function ssPgLocalModel(model, added, sizes) {", "function ssPgCanRemove(q, id, z) {", "function ssPgRekeyCell(cell, before, after) {",
  "function ssPgBackup(q, draft, at, keep) {", "function ssPgBackupLoad(raw, now, maxAge) {", "function ssPgBackupMerge(list) {",
  "function ssPgEarlierText(red, where, fields) {"].map(lift).join("\n");
const G = new Function(`${PURE}\n${SAVE}\n${P4}; return { ssPgParseSizeList, ssPgSizeGrid, ssPgLocalModel, ssPgCanRemove, ssPgRekeyCell, ssPgBackup, ssPgBackupLoad,
  ssPgBackupMerge, ssPgEarlierText };`)() as Record<string, (...a: Any[]) => Any>;
const labels = (list: Any[]) => list.map((z: Any) => z.label);

Deno.test("ssPgParseSizeList: every way of writing a size, split by commas, semicolons or new lines, in the order typed", () => {
  const r = G.ssPgParseSizeList("10x12, 10 x 14; 10X16\n10 by 18\r\n10.5x12, 12×24 ,  ", []);
  assertEquals(r.ok, true);
  assertEquals(labels(r.sizes), ["10x12", "10x14", "10x16", "10x18", "10.5x12", "12x24"]);
  assertEquals(r.sizes[4], { width: 10.5, length: 12, label: "10.5x12" });
  assertEquals([r.skipped, r.repeats], [[], 0]);
  assertEquals(G.ssPgParseSizeList("10.50 x 12.00", []).sizes, [{ width: 10.5, length: 12, label: "10.5x12" }], "the server's label: 10.5x12, never 10.50x12");
  assertEquals(G.ssPgParseSizeList("10 BY 12", []).sizes[0].label, "10x12");
});

Deno.test("ssPgParseSizeList: one bad entry refuses the whole add and is named; repeats collapse; sizes already there are skipped and named; at most 100", () => {
  assertEquals(G.ssPgParseSizeList("10x12, 10y12, 12x16", []), { ok: false, error: "Nothing added. “10y12” isn't a size like 10x12." });
  assertEquals(G.ssPgParseSizeList("10x12, 600x12", []).error, "Nothing added. “600x12”: a width or length is above 0, at most 500, with at most 2 decimals.");
  assertEquals(G.ssPgParseSizeList("abc, 10.125x12, 0x8", []).error, "Nothing added. “abc” isn't a size like 10x12. 2 more entries aren't right either.");
  assertEquals(G.ssPgParseSizeList("10x12x14, 12x16, -1x8", []).error, "Nothing added. “10x12x14” isn't a size like 10x12. 1 more entry isn't right either.");
  assertEquals(G.ssPgParseSizeList(" , ;\n", []), { ok: false, error: "Type sizes like 10x12, 12x16." });
  const have = [{ width: 12, length: 16 }, { width: 10.5, length: 12 }];
  const r = G.ssPgParseSizeList("12x16, 14x20, 14 x 20, 10.50x12, 14X20", have);
  assertEquals([r.ok, labels(r.sizes), r.skipped, r.repeats], [true, ["14x20"], ["12x16", "10.5x12"], 2]);
  const all = G.ssPgParseSizeList("12x16", have);
  assertEquals([all.ok, all.sizes, all.skipped], [true, [], ["12x16"]], "all already there: nothing to add, and it says which");
  const list = (n: number) => Array.from({ length: n }, (_, i) => `10x${i + 1}`).join(", ");
  assertEquals(G.ssPgParseSizeList(list(100), []).sizes.length, 100);
  assertEquals(G.ssPgParseSizeList(list(101), []), { ok: false, error: "Nothing added. At most 100 sizes go in one add; this list has 101." });
  assertEquals(G.ssPgParseSizeList(list(101), [{ width: 10, length: 1 }]).sizes.length, 100, "a size already there does not count");
});

Deno.test("ssPgParseSizeList: the width and length rule is the server's own (parse parity), and 100 new sizes go as two calls the server takes", () => {
  for (const [text] of DIM_CASES) {
    for (const tok of [`${text}x12`, `12 x ${text}`]) {
      const b = G.ssPgParseSizeList(tok, []), s = parseDim(text);
      assertEquals(b.ok, s.ok, `${JSON.stringify(tok)}: browser ${JSON.stringify(b)}, server ${JSON.stringify(s)}`);
      if (!s.ok) continue;
      const z = b.sizes[0];
      assertEquals(tok.startsWith("12 x") ? z.length : z.width, s.value);
      assertEquals(z.label, sizeLabel(z.width, z.length), "the label the server writes");
    }
  }
  // One add of 100: creates count toward the 50 entries a call may carry, so two calls, in order.
  const r = G.ssPgParseSizeList(Array.from({ length: 100 }, (_, i) => `10.5x${i + 1}`).join("\n"), []);
  const nid = (i: number) => `20000000-0000-4000-8000-${String(i).padStart(12, "0")}`;
  let q = Q(start(DB()), ...r.sizes.map((z: Any, i: number) => ({ type: "create", id: nid(i), styleId: sid(1), width: z.width, length: z.length, at: 0 })));
  const got: string[] = [];
  for (let call = 0; call < 2; call++) {
    q = Q(q, { type: "send" });
    const v = validatePayload(q.flight.body);
    assert(v.ok, JSON.stringify(v));
    assertEquals(q.flight.body.creates.length, 50);
    got.push(...v.value.creates.map((c: Any) => c.label));
    q = Q(q, { type: "ok", n: q.flight.n, answer: { ok: true, created: q.flight.body.creates.map((c: Any) => ({ id: c.id, status: "created", version: V0, row: { price: null, active: false, created_at: V0 }, cells: {} })), removed: [], results: [] } });
  }
  assertEquals(got, labels(r.sizes), "typed order, so the server's max + 1 puts them in that order");
  assertEquals(S.ssPgBuildBatch(q), null);
});

Deno.test("ssPgSizeGrid: widths down, lengths across, all ticked; sizes already there greyed; unticked ones left out; added row by row", () => {
  const g = G.ssPgSizeGrid("8, 10, 12", "12 16 20", [{ width: 10, length: 16 }], {});
  assertEquals([g.ok, g.widths, g.lengths, g.error], [true, [8, 10, 12], [12, 16, 20], null]);
  assertEquals(g.rows.map((r: Any[]) => r.map((c: Any) => (c.there ? "there" : c.ticked ? "x" : "-"))), [["x", "x", "x"], ["x", "there", "x"], ["x", "x", "x"]]);
  assertEquals(g.sizes.length, 8);
  const off = G.ssPgSizeGrid("8, 10, 12", "12, 16, 20", [{ width: 10, length: 16 }], { "12x12": true, "8x20": true });
  assertEquals(labels(off.sizes), ["8x12", "8x16", "10x12", "10x20", "12x16", "12x20"]);
  assertEquals(off.rows[2][0], { width: 12, length: 12, label: "12x12", there: false, ticked: false });
  assertEquals(labels(G.ssPgSizeGrid("10, 10, 12", "16;16", [], {}).sizes), ["10x16", "12x16"], "repeats drop");
  assertEquals(G.ssPgSizeGrid("8, ten", "12", [], {}).error, "“ten” isn't a width: a number of feet above 0, at most 500, with at most 2 decimals.");
  assertEquals(G.ssPgSizeGrid("8", "12.125", [], {}).error, "“12.125” isn't a length: a number of feet above 0, at most 500, with at most 2 decimals.");
  const blank = G.ssPgSizeGrid("8, 10", "  ", [], {});
  assertEquals([blank.ok, blank.blank, blank.error, blank.sizes], [false, true, null, []], "an empty box is no grid yet, and no complaint");
  const nums = (n: number) => Array.from({ length: n }, (_, i) => i + 1).join(",");
  const big = G.ssPgSizeGrid(nums(11), nums(10), [], {});
  assertEquals([big.ok, big.sizes.length, big.error], [false, 110, "At most 100 sizes go in one add; 110 are ticked. Untick some, or add them in two goes."]);
  const ten: Record<string, boolean> = {};
  for (let l = 1; l <= 10; l++) ten[`11x${l}`] = true;
  const trimmed = G.ssPgSizeGrid(nums(11), nums(10), [], ten);
  assertEquals([trimmed.ok, trimmed.sizes.length], [true, 100]);
  // The same number rule as the server: each pair is a create the server's shape check takes.
  const sizes = G.ssPgSizeGrid("10.25, 500", "0.5", [], {}).sizes;
  assert(validatePayload({ creates: sizes.map((z: Any, i: number) => ({ id: zid(60 + i), styleId: sid(1), width: z.width, length: z.length })) }).ok);
});

Deno.test("ssPgRows: the add strip goes under its band; an empty style's placeholder is the strip when the page can edit; sizes added here never fold away", () => {
  const m = H.ssPgModel(TCAT, TABLE);
  const shape = (rows: Any[]) => rows.map((r) => r.kind === "size" ? r.size.label : r.kind === "band" ? `[${r.style.label} ${r.total}/${r.hidden}/${r.folded}]`
    : r.kind === "add" ? `<add ${r.style.label}${r.empty ? " empty" : ""}>` : r.kind === "empty" ? `(${r.text})` : `{hidden ${r.count} ${r.open}}`);
  assertEquals(shape(H.ssPgRows(m, { addEmpty: true, adding: { [sid(1)]: true } })), ["[Test Barn 3/1/0]", "<add Test Barn>", "10x12", "10x16", "12x24",
    "[Test Utility 2/1/0]", "8x10", "8x12", "[Test Empty 0/0/0]", "<add Test Empty empty>", "{hidden 1 false}"]);
  assertEquals(shape(H.ssPgRows(m, {})).slice(-3, -1), ["[Test Empty 0/0/0]", "(No sizes yet.)"], "a page that can't edit keeps the plain placeholder");
  // 10x16 is hidden (no price): folded away, unless this page added it.
  assertEquals(shape(H.ssPgRows(m, { showHidden: false, keep: { [zid(2)]: true } })).slice(0, 4), ["[Test Barn 3/1/0]", "10x12", "10x16", "12x24"]);
  assertEquals(shape(H.ssPgRows(m, { showHidden: false, adding: { [sid(1)]: true } })).slice(0, 4), ["[Test Barn 3/1/1]", "<add Test Barn>", "10x12", "12x24"]);
});

Deno.test("ssPgLocalModel: new sizes go after their style's last size in the order typed while the queue knows them; removed ones go; nothing changed, the same model", () => {
  const m = H.ssPgModel(TCAT, TABLE);
  const sizes = S.ssPgServerSizes(m);
  assertEquals(G.ssPgLocalModel(m, [], sizes), m, "nothing to change: the very same object, so the grid's memos hold");
  assert(G.ssPgLocalModel(m, [], sizes) === m);
  assert(G.ssPgLocalModel(m, [{ id: zid(41), styleId: sid(1), width: 1, length: 1, label: "1x1" }], null) === m, "no queue yet: the read");
  const N1 = zid(41), N2 = zid(42), N3 = zid(43);
  const added = [{ id: N2, styleId: sid(1), width: 14, length: 20, label: "14x20" }, { id: N1, styleId: sid(1), width: 10.5, length: 12, label: "10.5x12" },
    { id: N3, styleId: sid(4), width: 8, length: 8, label: "8x8" }];
  const q = Q(S.ssPgQueue(null, { type: "init", sizes, cols: ["loft", "workbench", "11"] }),
    ...added.map((a) => ({ type: "create", id: a.id, styleId: a.styleId, width: a.width, length: a.length, at: 0 })));
  const lm = G.ssPgLocalModel(m, added, q.sizes);
  assertEquals(labels(lm.styles[0].sizes), ["10x12", "10x16", "12x24", "14x20", "10.5x12"]);
  assertEquals(labels(lm.styles[2].sizes), ["8x8"], "an empty style's first size");
  const n = lm.styles[0].sizes[3];
  assertEquals([n.price, n.hidden, n.values, n.local, n.title, n.version], [null, true, ["", "", ""], true, "14 ft × 20 ft", null]);
  assert(lm.cols === m.cols && lm.sections === m.sections && lm.styles[1] === m.styles[1], "the columns are the read's, and an untouched style is the same object");
  const v = S.ssPgRowView(n, q.sizes[N2], q.fields[N2], lm.cols);
  assertEquals([v.priceText, v.noPrice, v.offered], ["", true, false], "Offered off and greyed until a price is on file");
  // Gone from the queue (removed, refused, or `exists` put another size in its place): gone from the grid.
  const gone = { ...q.sizes };
  delete gone[N2];
  delete gone[zid(1)];
  assertEquals(labels(G.ssPgLocalModel(m, added, gone).styles[0].sizes), ["10x16", "12x24", "10.5x12"]);
  // Once a read has it, it is drawn from the read, and only once.
  const t2 = { ...TABLE, sizes: [...SIZES, size(42, 1, 14, 20, null, false, 3)], counts: { sizes: SIZES.length + 1, inclusions: INCS.length } };
  const read = H.ssPgModel(TCAT, t2);
  const lr = G.ssPgLocalModel(read, added, { ...S.ssPgServerSizes(read), [N1]: q.sizes[N1], [N3]: q.sizes[N3] });
  assertEquals(labels(lr.styles[0].sizes), ["10x12", "10x16", "12x24", "14x20", "10.5x12"]);
  assertEquals([lr.styles[0].sizes[3].local, lr.styles[0].sizes[4].local], [undefined, true]);
  assertEquals(S.ssPgServerSizes(lm)[N2], undefined, "a size this page added is never read back as the server's");
});

Deno.test("ssPgCanRemove: only a size never priced or edited since it was added, with nothing included and nothing local", () => {
  const T = "2026-10-31T00:00:00.000001+00:00";
  const fresh = { version: T, created: T, price: null, active: false, cells: {} };
  const q0 = (s: Any, extra: Any = {}) => ({ sizes: { [Z]: s }, fields: {}, removes: {}, ...extra });
  assertEquals(G.ssPgCanRemove(q0(fresh), Z), true);
  assertEquals(G.ssPgCanRemove(q0(fresh), Z, { onFile: 0 }), true);
  assertEquals(G.ssPgCanRemove(q0({ ...fresh, cells: { loft: 0 } }), Z), true, "a box at 0 is nothing included");
  const no: [string, Any, Any?][] = [
    ["priced, even at $0", q0({ ...fresh, price: 0 })],
    ["edited since it was added", q0({ ...fresh, version: "2026-10-31T00:00:00.000002+00:00" })],
    ["something included", q0({ ...fresh, cells: { loft: 50 } })],
    ["an inclusion row on file, even one not included", q0(fresh), { onFile: 1 }],
    ["a box typed and not saved yet", q0(fresh, { fields: { [Z]: { price: { pending: { to: 1, from: null, seq: 1 } } } } })],
    ["a red box", q0(fresh, { fields: { [Z]: { price: { error: { kind: "invalid", typed: "x", reason: "" } } } } })],
    ["still being added", q0({ ...fresh, version: null, creating: "inflight" })],
    ["a remove already on its way", q0(fresh, { removes: { [Z]: "inflight" } })],
    ["no created_at known", q0({ version: T, price: null, active: false, cells: {} })],
    ["not on the account", { sizes: {}, fields: {}, removes: {} }],
  ];
  for (const [why, q, z] of no) assertEquals(G.ssPgCanRemove(q, Z, z), false, why);
  assertEquals(G.ssPgCanRemove(null, Z), false);
});

Deno.test("queue: a size added here can be removed once it is created, until it is changed; Remove goes through the queue and the size goes with the answer", () => {
  const db = DB();
  let q = Q(start(db), { type: "create", id: Z, styleId: sid(1), width: 14, length: 20, at: 0 });
  assertEquals(G.ssPgCanRemove(q, Z), false, "not while Adding…");
  q = Q(q, { type: "send" });
  const T = nextV();
  const row = { price: null, active: false, label: "14x20", width_ft: 14, length_ft: 20, style_id: sid(1), sort_order: 9, created_at: T };
  q = Q(q, { type: "ok", n: q.flight.n, answer: { ok: true, created: [{ id: Z, status: "created", version: T, row, cells: {} }], removed: [], results: [] } });
  assertEquals([q.sizes[Z].version, q.sizes[Z].created], [T, T], "created_at rides along from the answer");
  assertEquals(G.ssPgCanRemove(q, Z), true);
  assertEquals(G.ssPgCanRemove(Q(q, commit(Z, "price", 900)), Z), false, "a price typed: no Remove");
  q = Q(q, { type: "remove", id: Z, at: 0 });
  assertEquals([G.ssPgCanRemove(q, Z), q.removes[Z], q.flush, S.ssPgCount(q).removing], [false, "pending", true, 1]);
  q = Q(q, { type: "send" });
  assertEquals(q.flight.body, { creates: [], removes: [Z], sizes: [] });
  assert(validatePayload(q.flight.body).ok);
  const why = "Only a size that was never priced or edited can be removed. Untick Offered to hide it.";
  const refused = Q(q, { type: "ok", n: q.flight.n, answer: { ok: true, created: [], removed: [{ id: Z, status: "refused", reason: why }], results: [] } });
  assertEquals([!!refused.sizes[Z], refused.removes[Z], refused.note], [true, undefined, { text: why }]);
  // A size being removed takes no edit: typed, pasted or marked, it would go with the size unsaid.
  assert(Q(q, commit(Z, "price", 4800)) === q && Q(q, { type: "commits", edits: [{ sizeId: Z, f: "price", value: 4800, seen: null }], at: 0 }).fields[Z] === undefined
    && Q(q, { type: "invalid", sizeId: Z, f: "price", typed: "x", reason: "r" }) === q, "while its remove is out");
  assert(Q(refused, commit(Z, "price", 4800)).fields[Z].price.pending.to === 4800, "a remove the server refused gives the size back");
  q = Q(q, { type: "ok", n: q.flight.n, answer: { ok: true, created: [], removed: [{ id: Z, status: "removed" }], results: [] } });
  assertEquals([q.sizes[Z], q.removes[Z], q.fields[Z]], [undefined, undefined, undefined]);
  // A size read from the server whose two stamps are equal is removable as well.
  const one = { ...SIZES[2], updated_at: SIZES[2].created_at };
  const m = H.ssPgModel(TCAT, { ...TABLE, sizes: [one], inclusions: [], counts: { sizes: 1, inclusions: 0 } });
  const q2 = S.ssPgQueue(null, { type: "init", sizes: S.ssPgServerSizes(m), cols: [] });
  assertEquals(G.ssPgCanRemove(q2, zid(2), m.styles[0].sizes[0]), true);
});

Deno.test("refresh through the queue: red boxes, unsent and in-flight work kept; an Excel upload that changed an unsent box turns it red; the rest takes the read", () => {
  const db = DB();
  const V9 = "2026-10-30T00:00:00.000009+00:00";
  let q = Q(start(db), commit(B, "price", 2200), { type: "send" });          // B's price is out
  q = Q(q, commit(A, "c:loft", 60), commit(C, "price", 700));                 // these wait behind it
  q = Q(q, { type: "invalid", sizeId: A, f: "price", typed: "abc", reason: "A price is a number, 0 or more" });
  // An Excel upload in another tab: A's loft 50 → 55 and its price 400 → 410; C's price set to 700, as
  // this page had typed; B's price too (in flight: left to its answer).
  const sheet = { [A]: { version: V9, price: 410, active: true, cells: { loft: 55 } }, [B]: { version: V9, price: 2150, active: true, cells: { loft: 3 } },
    [C]: { version: V9, price: 700, active: true, cells: {} } };
  const r = Q(q, { type: "refresh", okAt: q.oks, sizes: sheet });
  assertEquals(field(r, A, "c:loft").error, { kind: "conflict", typed: 60, server: 55, reason: null }, "its starting value changed: red, never sent");
  assertEquals(field(r, A, "price").error.kind, "invalid", "a red box stays red");
  assertEquals([r.sizes[A].version, r.sizes[A].price, r.sizes[A].cells.loft], [V0, 410, 55], "local work keeps the version; the boxes show what is on file");
  assertEquals([field(r, B, "price").inflight.to, r.sizes[B].price, r.sizes[B].cells.loft, r.sizes[B].version], [2200, 2100, 3, V0],
    "in flight: left to its answer; its other boxes take the read");
  assertEquals([field(r, C, "price"), r.sizes[C]], [undefined, sheet[C]], "the sheet already says what C's box wanted: nothing left, so C takes the read whole");
  assertEquals(r.flight, q.flight, "the call out is kept");
  // After a conflict, a size has the new version but the boxes that call never named are stale until
  // a refresh replaces the whole size.
  const db2 = DB();
  let p = Q(start(db2), commit(A, "price", 480), { type: "send" });
  db2[A].price = 450; db2[A].cells.loft = 70; db2[A].version = nextV();
  p = Q(p, { type: "ok", n: p.flight.n, answer: serve(db2, p.flight.body) });
  assertEquals([field(p, A, "price").error.kind, p.sizes[A].price, p.sizes[A].cells.loft], ["conflict", 450, 50], "loft was never sent: still the old 50");
  p = Q(p, { type: "refresh", okAt: p.oks, sizes: copy(db2) });
  assertEquals([p.sizes[A].cells.loft, field(p, A, "price").error.kind, p.sizes[A].version], [70, "conflict", db2[A].version], "replaced whole; the red box stays");
});

Deno.test("refresh: an option archived elsewhere drops its unsaved boxes with the note; a new option is a new column the read fills", () => {
  const db = DB();
  let q = Q(start(db), commit(A, "c:101", 2), commit(B, "c:loft", 5));
  q = Q(q, { type: "columns", keys: ["loft", "202"], names: { loft: "Loft (sq ft)", "101": "Single Door (3'x6'4\")" } });
  q = Q(q, { type: "refresh", okAt: q.oks, sizes: { ...copy(db), [C]: { ...db[C], cells: { "202": 1 } } } });
  assertEquals(field(q, A, "c:101"), undefined);
  assertEquals(q.note, { text: "Single Door (3'x6'4\") was archived in Options; 1 unsaved box in that column was dropped." });
  assertEquals(field(q, B, "c:loft").pending.to, 5, "a column still there keeps its edits");
  assertEquals(S.ssPgRowView({}, q.sizes[C], q.fields[C], [{ key: "loft" }, { key: "202" }]).values, ["", "1"], "the new column's box shows what is on file");
  const b = S.ssPgBuildBatch(Q(q, commit(C, "c:202", 3)));
  assert(b.body.sizes.some((s: Any) => s.id === C && s.to.cells["202"] === 3 && s.from.cells["202"] === 1), JSON.stringify(b.body.sizes));
});

// An open editor, a cursor and a range are on an OPTION, not on a column number: a read that adds or
// archives an option moves the columns under them (plan 4.6's column change).
Deno.test("ssPgRekeyCell: after a read changes the columns, the cell stays on its option; one that went away hands it to the column in its place", () => {
  const was = [{ key: "loft" }, { key: "workbench" }, { key: "101" }];
  const cell = { sizeId: A, col: 4 };   // Workbench
  assertEquals(G.ssPgRekeyCell(cell, was, [{ key: "fan" }, ...was]), { sizeId: A, col: 5 }, "a new option sorted first: still Workbench");
  assertEquals(G.ssPgRekeyCell(cell, was, [{ key: "workbench" }, { key: "101" }]), { sizeId: A, col: 3 }, "Loft archived: still Workbench");
  assertEquals(G.ssPgRekeyCell(cell, was, [{ key: "loft" }, { key: "101" }]), { sizeId: A, col: 4 }, "Workbench archived: the column now in its place");
  assertEquals(G.ssPgRekeyCell({ sizeId: A, col: 5 }, was, [{ key: "loft" }, { key: "workbench" }]), { sizeId: A, col: 4 }, "the last one archived: the new last");
  assertEquals(G.ssPgRekeyCell({ sizeId: A, col: 3 }, was, []), { sizeId: A, col: 2 }, "no option columns left: Offered");
  assert(G.ssPgRekeyCell(cell, was, was) === cell, "nothing moved: the same object");
  for (const c of [null, { sizeId: A, col: 0 }, { sizeId: A, col: 1 }, { sizeId: A, col: 2 }]) assert(G.ssPgRekeyCell(c, was, [{ key: "fan" }, ...was]) === c, JSON.stringify(c));
  // The editor's text in a column that went away is counted in the columns note with the rest.
  const q = Q(start(DB()), commit(B, "c:101", 2), { type: "columns", keys: ["loft"], names: { "101": "Single Door (3'x6'4\")" }, drafts: ["101", "loft"] });
  assertEquals(q.note, { text: "Single Door (3'x6'4\") was archived in Options; 2 unsaved boxes in that column were dropped." }, "an editor on a column still there is not counted");
});

Deno.test("ssPgBackup: unsent and in-flight edits on the version and from the value they were made against; red boxes listed; the editor's text; nothing left, nothing kept", () => {
  const db = DB();
  assertEquals(G.ssPgBackup(start(db), null, 1000, null), null);
  let q = Q(start(db), commit(A, "price", 480), { type: "send" }, commit(A, "price", 500), commit(B, "c:loft", 7));
  q = Q(q, { type: "invalid", sizeId: C, f: "price", typed: "abc", reason: "A price is a number, 0 or more" });
  q = Q(q, { type: "create", id: Z, styleId: sid(1), width: 10, length: 16, at: 0 }, commit(Z, "price", 3000));
  assertEquals(G.ssPgBackup(q, { sizeId: B, key: "price", text: "2,250", seen: 2100 }, 1234, null), {
    savedAt: 1234,
    sizes: { [A]: { base: V0, fields: { price: { to: 500, from: 480, before: 400 } } }, [B]: { base: V0, fields: { "c:loft": { to: 7, from: 0 } } } },
    red: [{ sizeId: C, key: "price", kind: "invalid", typed: "abc", reason: "A price is a number, 0 or more" }],
    draft: { sizeId: B, key: "price", text: "2,250", base: V0, from: 2100 },
    creates: { [Z]: { styleId: sid(1), width: 10, length: 16, fields: { price: { to: 3000, from: null } } } },
  }, "in flight with a follow-up: the newest value, from the in-flight value, and the value under that; a size still being added has no version, so what was typed on it goes with its create");
  assertEquals(G.ssPgBackup(q, { sizeId: A, key: "price", text: "520", seen: 500 }, 1, null).draft, { sizeId: A, key: "price", text: "520", base: V0, from: 480, before: 400 },
    "the editor over a box in flight starts from the in-flight value it was typed over, and the value under that");
  assertEquals(G.ssPgBackup(Q(start(db), commit(B, "price", 2200)), { sizeId: B, key: "price", text: "2300", seen: 2200 }, 1, null).draft.from, 2100,
    "…over an unsent edit, from that edit's own starting value (the unsent one never reached the server)");
  assertEquals(G.ssPgBackup(Q(start(db), { type: "create", id: Z, styleId: sid(1), width: 10, length: 16, at: 0 }), { sizeId: Z, key: "price", text: "1", seen: null }, 1, null),
    { savedAt: 1, sizes: {}, red: [], draft: { sizeId: Z, key: "price", text: "1", base: null, from: null }, creates: { [Z]: { styleId: sid(1), width: 10, length: 16, fields: {} } } },
    "the editor's text on a size still being added: a draft with no version, beside that size's create");
  // A conflict keeps the colleague's number with it.
  const c = Q(start(db), commit(A, "price", 480), { type: "refresh", okAt: 0, sizes: { ...copy(db), [A]: { ...db[A], version: nextV(), price: 450 } } });
  assertEquals(G.ssPgBackup(c, null, 2, null).red, [{ sizeId: A, key: "price", kind: "conflict", typed: 480, reason: null, server: 450 }]);
  // What it writes, ssPgBackupLoad reads back.
  const back = G.ssPgBackupLoad(JSON.stringify(G.ssPgBackup(q, { sizeId: B, key: "price", text: "2,250", seen: 2100 }, 1234, null)), 1234);
  assertEquals([back.count, back.sizes[B].fields.price, back.sizes[A].fields.price, back.red.length],
    [4, { to: 2250, from: 2100, at: 1234 }, { to: 500, from: 480, before: 400, at: 1234 }, 1]);
  assertEquals(back.creates, { [Z]: { styleId: sid(1), width: 10, length: 16, fields: { price: { to: 3000, from: null, at: 1234 } } } });
});

// Prices typed on a size whose create is unanswered (amber retries, "Adding…"), then the tab closed:
// they used to be left out of the backup, and lost, whether or not the create landed.
Deno.test("the backup and Save them, for a size still being added: added again if it never landed, its boxes after it; on file already, its boxes on its version", () => {
  const db = DB();
  const q = Q(start(db), { type: "create", id: Z, styleId: sid(1), width: 10, length: 16, at: 0 }, { type: "send" }, commit(Z, "price", 3000), commit(Z, "c:loft", 40));
  const b = G.ssPgBackupLoad(JSON.stringify(G.ssPgBackup(q, null, 9, null)), 10);
  assertEquals([b.count, Object.keys(b.sizes), Object.keys(b.creates[Z].fields).sort()], [2, [], ["c:loft", "price"]]);
  // The create never landed: Save them adds it again, then the boxes go on its version.
  const lost = DB();
  let r = Q(start(lost), { type: "restore", sizes: b.sizes, creates: b.creates, at: 0 });
  assertEquals([r.sizes[Z].creating, r.sizes[Z].create, S.ssPgCount(r).pending, r.flush], ["pending", { styleId: sid(1), width: 10, length: 16 }, 2, true]);
  let body;
  [r, body] = roundTrip(r, lost);
  assertEquals([body.creates.map((c: Any) => c.id), body.sizes], [[Z], []], "the create first, alone");
  const v = lost[Z].version;
  [r, body] = roundTrip(r, lost);
  assertEquals(body.sizes, [{ id: Z, base: v, from: { price: null, cells: { loft: 0 } }, to: { price: 3000, cells: { loft: 40 } } }]);
  assertEquals([lost[Z].price, lost[Z].cells.loft, S.ssPgCount(r).pending], [3000, 40, 0]);
  // It landed after all, and this page's read has it: its boxes go on the version read, from a new size's values.
  const landed = DB();
  landed[Z] = { version: nextV(), price: null, active: false, cells: {} };
  r = Q(start(landed), { type: "restore", sizes: b.sizes, creates: b.creates, at: 0 });
  assertEquals([r.sizes[Z].creating, r.sizes[Z].version], [undefined, landed[Z].version]);
  [r] = roundTrip(r, landed);
  assertEquals([landed[Z].price, landed[Z].cells.loft], [3000, 40]);
  // …and a colleague priced it since: their number stays, the box goes red.
  const theirs = DB();
  theirs[Z] = { version: nextV(), price: 2500, active: true, cells: {} };
  r = Q(start(theirs), { type: "restore", sizes: b.sizes, creates: b.creates, at: 0 });
  [r] = roundTrip(r, theirs);
  assertEquals([theirs[Z].price, field(r, Z, "price").error.kind], [2500, "conflict"]);
  // The editor's text on it, and a backup with one that's malformed.
  const d = G.ssPgBackupLoad(JSON.stringify(G.ssPgBackup(Q(start(db), { type: "create", id: Z, styleId: sid(1), width: 10, length: 16, at: 0 }), { sizeId: Z, key: "price", text: "$1,500", seen: null }, 1, null)), 1);
  assertEquals([d.count, d.creates[Z].fields.price], [1, { to: 1500, from: null, at: 1 }]);
  const junk = { savedAt: 1, sizes: {}, red: [], draft: null, creates: { [Z]: { styleId: "x", width: 10, length: 16, fields: { price: { to: 1, from: null } } }, [E]: { styleId: sid(1), width: 600, length: 16, fields: { price: { to: 1, from: null } } } } };
  assertEquals(G.ssPgBackupLoad(JSON.stringify(junk), 1), null, "a create the server would refuse whole is dropped");
  // Merged with another table's backup, box by box.
  const m = G.ssPgBackupMerge([b, { savedAt: 20, sizes: {}, red: [], count: 1, creates: { [Z]: { styleId: sid(1), width: 10, length: 16, fields: { price: { to: 3100, from: null } } } } }]);
  assertEquals([m.count, m.creates[Z].fields.price.to, m.creates[Z].fields["c:loft"].to], [2, 3100, 40]);
});

// Plan 4.6's blocker case, through a closed tab: 400 on file, 480 typed (out), then 400 typed back.
// Merged into one edit from where the flight started, it said nothing at all (400 → 400), and the
// page cleared its backup; the follow-up, and 500 typed instead, are kept as their own leg.
Deno.test("ssPgBackup: a box typed again while its value is in flight keeps both legs; Save them goes from whichever is on file", () => {
  const db = DB();
  const out = Q(start(db), commit(A, "price", 480), { type: "send" });
  const back = Q(out, commit(A, "price", 400));
  const typed = G.ssPgBackup(back, null, 50, null);
  assertEquals(typed && typed.sizes[A], { base: V0, fields: { price: { to: 400, from: 480, before: 400 } } }, "400 typed back over the 480 in flight is kept, not dropped as no change");
  const draft = G.ssPgBackup(out, { sizeId: A, key: "price", text: "400", seen: 480 }, 50, null);
  assertEquals(draft && draft.draft, { sizeId: A, key: "price", text: "400", base: V0, from: 480, before: 400 }, "the editor's 400 over the 480 in flight: from 480, never from 400");
  const more = G.ssPgBackup(Q(out, commit(A, "price", 500)), null, 50, null);
  for (const [what, stored, want] of [["400 typed back", typed, 400], ["the editor's 400", draft, 400], ["500 typed instead", more, 500]] as [string, Any, number][]) {
    const b = G.ssPgBackupLoad(JSON.stringify(stored), 60);
    assertEquals(b.count, 1, what);
    // The 480 landed before the tab closed: the server holds 480 on a newer version.
    const landed = DB();
    landed[A].price = 480; landed[A].version = nextV();
    let q = Q(start(landed), { type: "restore", sizes: b.sizes, at: 70 });
    assertEquals(field(q, A, "price").pending.from, 480, `${what} (480 landed): it goes from the 480 on file`);
    [q] = roundTrip(q, landed);   // the stored version is stale: conflict, and the rebase sends it again from 480
    [q] = roundTrip(q, landed);
    assertEquals([landed[A].price, field(q, A, "price"), S.ssPgCount(q).red], [want, undefined, 0], `${what} (480 landed): saved, never "changed elsewhere to $480"`);
    // The 480 never landed: the server still holds 400, on the version the edit was made against.
    const lost = DB();
    const r = Q(start(lost), { type: "restore", sizes: b.sizes, at: 70 });
    if (want === 400) assertEquals([field(r, A, "price"), r.flush], [undefined, false], `${what} (480 lost): 400 is what's on file, nothing to send`);
    else {
      assertEquals(field(r, A, "price").pending, { to: 500, from: 400, seq: 1 }, `${what} (480 lost): from the 400 on file`);
      const [r2] = roundTrip(r, lost);
      assertEquals([lost[A].price, S.ssPgCount(r2).red], [500, 0]);
    }
    // A colleague's number since: the server's checks turn it red, never overwritten.
    const theirs = DB();
    theirs[A].price = 450; theirs[A].version = nextV();
    let t = Q(start(theirs), { type: "restore", sizes: b.sizes, at: 70 });
    [t] = roundTrip(t, theirs);
    assertEquals([theirs[A].price, field(t, A, "price").error.kind, field(t, A, "price").error.server], [450, "conflict", 450], `${what}: a colleague's 450 stays`);
  }
});

// The editor's text counts as typed (plan 3.10), and committing a value equal to its box's baseline
// drops the unsent edit (commitBox). The backup used to skip such a draft and keep the edit, so Save
// them sent the very value the builder had typed back over.
Deno.test("ssPgBackup: the editor's text back where its box's unsent edit started takes that edit out, as committing it would; Save them never sends what was typed back over", () => {
  const db = DB();
  // 400 on file, 450 typed and unsent (a call out, a big paste or a retry holds it), the editor
  // opened on it again and "400" typed back, then the tab closed.
  const q1 = Q(start(db), commit(A, "price", 450), commit(A, "c:loft", 60));
  const b1 = G.ssPgBackup(q1, { sizeId: A, key: "price", text: "400", seen: 450 }, 1, null);
  assertEquals(b1.sizes, { [A]: { base: V0, fields: { "c:loft": { to: 60, from: 50 } } } }, "the price edit is gone; the size's other box stays");
  assertEquals(G.ssPgBackup(Q(q1, commit(A, "price", 400)), null, 1, null).sizes, b1.sizes, "the same as committing the 400");
  assertEquals(Object.keys(G.ssPgBackupLoad(JSON.stringify(b1), 1).sizes[A].fields), ["c:loft"]);
  assertEquals(G.ssPgBackupLoad(JSON.stringify(G.ssPgBackup(Q(start(db), commit(A, "price", 450)), { sizeId: A, key: "price", text: "$400", seen: 450 }, 1, null)), 1), null,
    "nothing else waiting: nothing to offer");
  assertEquals(G.ssPgBackupLoad(JSON.stringify(G.ssPgBackup(Q(start(db), commit(A, "c:loft", 60)), { sizeId: A, key: "c:loft", text: "50", seen: 60 }, 1, null)), 1), null,
    "an option box the same way");
  // 480 in flight, 500 typed after it, then "480" typed in the editor: what is in flight is left,
  // from where it started, and the 500 is gone.
  const out = Q(start(db), commit(A, "price", 480), { type: "send" }, commit(A, "price", 500));
  const b2 = G.ssPgBackup(out, { sizeId: A, key: "price", text: "480", seen: 500 }, 1, null);
  assertEquals(b2.sizes[A].fields.price, { to: 480, from: 400 });
  assertEquals(G.ssPgBackup(Q(out, commit(A, "price", 480)), null, 1, null).sizes, b2.sizes, "the same as committing the 480");
  const l2 = G.ssPgBackupLoad(JSON.stringify(b2), 1);
  const landed = DB();
  landed[A].price = 480; landed[A].version = nextV();
  const [r1] = roundTrip(Q(start(landed), { type: "restore", sizes: l2.sizes, at: 2 }), landed);
  assertEquals([landed[A].price, S.ssPgCount(r1).pending, S.ssPgCount(r1).red], [480, 0, 0], "the 480 landed before the tab closed: Save them changes nothing, never 500");
  const lost = DB();
  const [r2] = roundTrip(Q(start(lost), { type: "restore", sizes: l2.sizes, at: 2 }), lost);
  assertEquals([lost[A].price, S.ssPgCount(r2).red], [480, 0], "the 480 never landed: it goes again, never 500");
  // A size still being added, $5,000 typed on it, then the editor cleared: no price goes with it
  // (a first price would also tick Offered).
  const adding = Q(start(db), { type: "create", id: Z, styleId: sid(1), width: 10, length: 16, at: 0 }, commit(Z, "price", 5000));
  const b3 = G.ssPgBackup(adding, { sizeId: Z, key: "price", text: "", seen: 5000 }, 1, null);
  assertEquals(b3.creates, { [Z]: { styleId: sid(1), width: 10, length: 16, fields: {} } });
  assertEquals(G.ssPgBackupLoad(JSON.stringify(b3), 1), null, "nothing typed on it is left");
  assertEquals(G.ssPgBackup(Q(adding, commit(Z, "price", null)), null, 1, null), null, "the same as committing the blank");
  const b4 = G.ssPgBackupLoad(JSON.stringify(G.ssPgBackup(Q(adding, commit(Z, "c:loft", 40)), { sizeId: Z, key: "price", text: "", seen: 5000 }, 1, null)), 1);
  assertEquals(b4.creates[Z].fields, { "c:loft": { to: 40, from: 0, at: 1 } }, "another box typed on it comes back with the size; the price doesn't");
  // Text that differs is unchanged: the edit is stored, and ssPgBackupLoad puts the draft in its place.
  const b5 = G.ssPgBackup(Q(start(db), commit(A, "price", 450)), { sizeId: A, key: "price", text: "420", seen: 450 }, 1, null);
  assertEquals([b5.sizes[A].fields.price, G.ssPgBackupLoad(JSON.stringify(b5), 1).sizes[A].fields.price], [{ to: 450, from: 400 }, { to: 420, from: 400, at: 1 }]);
});

Deno.test("ssPgBackup and ssPgBackupLoad: an entry kept from an older backup keeps its own age, so an unanswered banner still ages out after 7 days", () => {
  const DAY = 24 * 3600 * 1000;
  const db = DB();
  // Day 0: a price typed and the tab closed.
  const day0 = G.ssPgBackup(Q(start(db), commit(A, "price", 500)), null, 0, null);
  // Opened every 6 days, the banner never answered: each open rewrites the backup with it kept.
  let stored: Any = day0;
  for (const day of [6, 12]) {
    const b = G.ssPgBackupLoad(JSON.stringify(stored), day * DAY);
    if (day === 12) { assertEquals(b, null, "day 12: more than 7 days since it was typed, however often it was rewritten"); break; }
    assertEquals(b.sizes[A].fields.price, { to: 500, from: 400, at: 0 }, "read back with the age it was typed at");
    stored = G.ssPgBackup(start(db), null, day * DAY, { sizes: b.sizes, red: b.red });
    assertEquals([stored.savedAt, stored.sizes[A].fields.price.at], [6 * DAY, 0], "rewritten on day 6, still as old as day 0");
  }
  // A backup holding both an old kept entry and this page's own: the old one goes, this page's stays.
  const kept = G.ssPgBackupLoad(JSON.stringify(day0), 6 * DAY);
  const both = G.ssPgBackup(Q(start(db), commit(B, "price", 2200)), null, 6 * DAY, { sizes: kept.sizes, red: kept.red });
  assertEquals([both.sizes[A].fields.price.at, both.sizes[B].fields.price.at], [0, undefined], "the kept entry keeps its age; this page's own is as old as the backup");
  const b = G.ssPgBackupLoad(JSON.stringify(both), 8 * DAY);
  assertEquals([b.count, Object.keys(b.sizes)], [1, [B]]);
  // Red entries age the same way.
  const red = { savedAt: 9 * DAY, sizes: {}, red: [{ sizeId: A, key: "price", kind: "refused", typed: 1, reason: "x", at: 0 }, { sizeId: B, key: "price", kind: "refused", typed: 2, reason: "y" }], draft: null };
  assertEquals(G.ssPgBackupLoad(JSON.stringify(red), 9 * DAY).red.map((r: Any) => [r.sizeId, r.at]), [[B, 9 * DAY]]);
});

Deno.test("ssPgBackupMerge: the backups of tables that closed, oldest first; a newer box wins, a size on a newer version takes its place whole, red once per box", () => {
  const V1 = "2026-10-21T00:00:00.000001+00:00";
  const older = { savedAt: 10, count: 3, red: [{ sizeId: C, key: "price", kind: "invalid", typed: "a" }],
    sizes: { [A]: { base: V0, fields: { price: { to: 500, from: 400 }, "c:loft": { to: 60, from: 50 } } }, [B]: { base: V0, fields: { price: { to: 1, from: 2100 } } } } };
  const newer = { savedAt: 20, count: 2, red: [{ sizeId: C, key: "price", kind: "invalid", typed: "b" }],
    sizes: { [A]: { base: V0, fields: { price: { to: 600, from: 400 } } }, [B]: { base: V1, fields: { "c:loft": { to: 3, from: 0 } } } } };
  assertEquals(G.ssPgBackupMerge([newer, null, older]), {
    savedAt: 20, count: 3, red: [{ sizeId: C, key: "price", kind: "invalid", typed: "b" }],
    sizes: { [A]: { base: V0, fields: { price: { to: 600, from: 400 }, "c:loft": { to: 60, from: 50 } } }, [B]: { base: V1, fields: { "c:loft": { to: 3, from: 0 } } } },
  });
  assertEquals(G.ssPgBackupMerge([older]).sizes, older.sizes, "one backup: as it was");
  assertEquals([G.ssPgBackupMerge([]), G.ssPgBackupMerge(null)], [null, null]);
});

Deno.test("ssPgBackup: an earlier backup still on offer stays stored until it is answered, except where this page has a newer edit", () => {
  const db = DB();
  const keep = { sizes: { [A]: { base: V0, fields: { price: { to: 500, from: 400 }, "c:loft": { to: 60, from: 50 } } }, [C]: { base: V0, fields: { price: { to: 9, from: null } } } },
    red: [{ sizeId: B, key: "price", kind: "conflict", typed: 1, server: 2, reason: null }] };
  assertEquals(G.ssPgBackup(start(db), null, 7, keep), { savedAt: 7, sizes: keep.sizes, red: keep.red, draft: null }, "nothing local yet: as it was");
  const b = G.ssPgBackup(Q(start(db), commit(A, "price", 450)), null, 8, keep);
  assertEquals(b.sizes[A].fields, { price: { to: 450, from: 400 }, "c:loft": { to: 60, from: 50 } }, "this page's newer price wins; the rest of the earlier edit stays");
  assertEquals([b.sizes[C], b.red], [keep.sizes[C], keep.red]);
  assertEquals(G.ssPgBackup(start(db), null, 9, { sizes: null, red: null }), null, "answered and dismissed: nothing kept");
});

Deno.test("ssPgBackupLoad: the editor's draft becomes an edit; older than 7 days is dropped; anything the server would refuse whole is dropped", () => {
  const DAY = 24 * 3600 * 1000;
  const red0 = { sizeId: C, key: "price", kind: "invalid", typed: "abc", reason: "A price is a number, 0 or more" };
  const stored = { savedAt: 10 * DAY, sizes: { [A]: { base: V0, fields: { price: { to: 500, from: 400 } } } }, red: [red0],
    draft: { sizeId: B, key: "c:loft", text: "12", base: V0, from: 0 } };
  assertEquals(G.ssPgBackupLoad(JSON.stringify(stored), 10 * DAY + 1000), {
    savedAt: 10 * DAY, sizes: { [A]: { base: V0, fields: { price: { to: 500, from: 400, at: 10 * DAY } } }, [B]: { base: V0, fields: { "c:loft": { to: 12, from: 0, at: 10 * DAY } } } },
    red: [{ ...red0, at: 10 * DAY }], count: 2 });
  assertEquals(G.ssPgBackupLoad(JSON.stringify(stored), 17 * DAY + 1), null, "older than 7 days");
  assert(G.ssPgBackupLoad(JSON.stringify(stored), 17 * DAY) !== null, "7 days to the millisecond is still kept");
  for (const raw of ["not json", null, "", "42", "{}"]) assertEquals(G.ssPgBackupLoad(raw, 0), null, String(raw));
  // A draft the rules refuse is a red entry, listed, never sent.
  const bad = G.ssPgBackupLoad(JSON.stringify({ ...stored, draft: { ...stored.draft, text: "2.5" } }), 10 * DAY);
  assertEquals([bad.count, bad.red[0]], [1, { sizeId: B, key: "c:loft", kind: "invalid", typed: "2.5", reason: "Whole numbers only, 0 or more", at: 10 * DAY }]);
  // A draft over a box already in the backup takes its place, from the starting value ssPgBackup gave
  // it (the same as that box's own: an unsent edit's starting value).
  const over = G.ssPgBackupLoad(JSON.stringify({ ...stored, draft: { sizeId: A, key: "price", text: "$520", base: V0, from: 400 } }), 10 * DAY);
  assertEquals([over.count, over.sizes[A].fields.price], [1, { to: 520, from: 400, at: 10 * DAY }]);
  // …and a draft over a box in flight keeps both its legs.
  const flying = G.ssPgBackupLoad(JSON.stringify({ ...stored, draft: { sizeId: A, key: "price", text: "400", base: V0, from: 500, before: 400 } }), 10 * DAY);
  assertEquals(flying.sizes[A].fields.price, { to: 400, from: 500, before: 400, at: 10 * DAY });
  const badLeg = G.ssPgBackupLoad(JSON.stringify({ ...stored, draft: null, sizes: { [A]: { base: V0, fields: { price: { to: 1, from: 2, before: "x" } } } } }), 10 * DAY);
  assertEquals([badLeg.count, badLeg.sizes], [0, {}], "a `before` the server would refuse drops the entry");
  // Malformed: a bad id or version, a field or value the server would refuse, a no-change, an unknown red kind.
  const junk = { savedAt: 1, sizes: {
    "not-a-uuid": { base: V0, fields: { price: { to: 1, from: 2 } } },
    [A]: { base: "yesterday", fields: { price: { to: 1, from: 2 } } },
    [B]: { base: V0, fields: { colour: { to: 1, from: 0 }, price: { to: "500", from: 400 }, "c:loft": { to: 2.5, from: 0 }, active: { to: true, from: true }, "c:workbench": { to: 1, from: 0 } } },
  }, red: [{ sizeId: "x", key: "price", kind: "invalid" }, { sizeId: C, key: "price", kind: "weird" }, null] };
  assertEquals(G.ssPgBackupLoad(JSON.stringify(junk), 2), { savedAt: 1, sizes: { [B]: { base: V0, fields: { "c:workbench": { to: 1, from: 0, at: 1 } } } }, red: [], count: 1 });
});

Deno.test("restore (Save them): the stored base and from go out; a colleague's change since comes back conflict and turns red; untouched boxes save; red entries never replay", () => {
  const db = DB();
  // Stored on V0: A's price 400 → 500 and loft 50 → 60, B's price 2100 → 2200. Since then a colleague
  // changed A's price, and this page's first read has that.
  const backup = { [A]: { base: V0, fields: { price: { to: 500, from: 400 }, "c:loft": { to: 60, from: 50 } } }, [B]: { base: V0, fields: { price: { to: 2200, from: 2100 } } } };
  db[A].price = 450; db[A].version = nextV();
  let q = Q(start(db), { type: "restore", sizes: backup, at: 5 });
  assertEquals([q.sizes[A].version, q.sizes[B].version, q.flush, S.ssPgCount(q).pending], [V0, V0, true, 3], "each size on the version its edits were made against; out at once");
  let body;
  [q, body] = roundTrip(q, db);
  assertEquals(body.sizes, [{ id: A, base: V0, from: { price: 400, cells: { loft: 50 } }, to: { price: 500, cells: { loft: 60 } } },
    { id: B, base: V0, from: { price: 2100 }, to: { price: 2200 } }], "the STORED base and from, never what was read just now");
  assertEquals(field(q, A, "price").error, { kind: "conflict", typed: 500, server: 450, reason: null });
  assertEquals([field(q, A, "c:loft").pending.to, field(q, A, "c:loft").pending.from], [60, 50], "nobody touched loft: it goes again");
  assertEquals([db[B].price, field(q, B, "price")], [2200, undefined]);
  const v1 = db[A].version;
  [q, body] = roundTrip(q, db);
  assertEquals(body.sizes, [{ id: A, base: v1, from: { cells: { loft: 50 } }, to: { cells: { loft: 60 } } }]);
  assertEquals([db[A].cells.loft, db[A].price], [60, 450], "the colleague's price is never overwritten");
  // The editor's draft is restored as an ordinary edit; a red entry is listed, never put back.
  const loaded = G.ssPgBackupLoad(JSON.stringify({ savedAt: 0, sizes: {}, red: [{ sizeId: A, key: "price", kind: "conflict", typed: 999, server: 1, reason: null }],
    draft: { sizeId: C, key: "price", text: "$1,250", base: V0, from: null } }), 0);
  const r2 = Q(start(DB()), { type: "restore", sizes: loaded.sizes, at: 0 });
  assertEquals(field(r2, C, "price").pending, { to: 1250, from: null, seq: 1 });
  assertEquals([field(r2, A, "price"), S.ssPgCount(r2).red], [undefined, 0]);
});

Deno.test("restore: a box typed since keeps the newer edit; a column gone and a size not on the account are left out", () => {
  const db = DB();
  let q = Q(start(db), commit(B, "price", 2300), { type: "send" }, commit(A, "price", 777));
  q = Q(q, { type: "restore", at: 0, sizes: {
    [A]: { base: V0, fields: { price: { to: 500, from: 400 }, "c:loft": { to: 60, from: 50 }, "c:999": { to: 1, from: 0 } } },
    [B]: { base: V0, fields: { "c:loft": { to: 9, from: 0 }, price: { to: 1, from: 2100 } } },
    [Z]: { base: V0, fields: { price: { to: 1, from: null }, active: { to: true, from: false } } },
  } });
  assertEquals([field(q, A, "price").pending.to, field(q, A, "c:loft").pending.to, field(q, A, "c:999")], [777, 60, undefined]);
  assertEquals([field(q, B, "c:loft").pending, field(q, B, "price").inflight.to], [{ to: 9, from: 0, seq: 4 }, 2300],
    "a size with a call out takes its stored edits too; the box in flight keeps its own (the newer edit)");
  assertEquals(q.note, { text: "2 changes from earlier were for a size that isn't on this account any more." });
  const s0 = start(db);
  assert(Q(s0, { type: "restore", at: 0, sizes: {} }) === s0, "nothing to put back: the same state");
});

// "Save them" while a call is out for that size (a box typed there a moment before): the stored edits
// used to be skipped, and the page then let them go from the backup with no word.
Deno.test("restore while a call is out for the same size: the stored edits wait behind it and go on the version its answer brings", () => {
  const db = DB();
  let q = Q(start(db), commit(C, "price", 700), { type: "send" });
  const v0 = q.sizes[C].version;
  q = Q(q, { type: "restore", at: 1, sizes: { [C]: { base: V0, fields: { "c:loft": { to: 50, from: 0 } } } } });
  assertEquals([field(q, C, "c:loft").pending, q.sizes[C].version, q.flush, S.ssPgCount(q).pending], [{ to: 50, from: 0, seq: 2 }, v0, true, 1],
    "kept, counted (the badge, the leave prompt and the backup see it), the version left for the answer to set");
  assert(Q(q, { type: "send" }) === q, "nothing goes while the call is out");
  q = Q(q, { type: "ok", n: q.flight.n, answer: serve(db, q.flight.body) });
  const v1 = db[C].version;
  let body;
  [q, body] = roundTrip(q, db);
  assertEquals(body.sizes, [{ id: C, base: v1, from: { cells: { loft: 0 } }, to: { cells: { loft: 50 } } }]);
  assertEquals([db[C].price, db[C].cells.loft, S.ssPgCount(q)], [700, 50, { pending: 0, inflight: 0, red: 0, creating: 0, removing: 0 }]);
  // The backup holds it all the while: a crash before the answer loses nothing.
  const db2 = DB();
  const w = Q(start(db2), commit(C, "price", 700), { type: "send" }, { type: "restore", at: 1, sizes: { [C]: { base: V0, fields: { "c:loft": { to: 50, from: 0 } } } } });
  assertEquals(G.ssPgBackup(w, null, 2, null).sizes[C].fields, { price: { to: 700, from: null }, "c:loft": { to: 50, from: 0 } });
});

Deno.test("ssPgEarlierText: the backup's red entries, named for the status line", () => {
  const where = { [A]: "Test Barn 10x12", [B]: "Test Barn 12x24" };
  const fields = { price: { name: "Price", kind: "price" }, active: { name: "Offered", kind: "active" }, "c:loft": { name: "Loft (sq ft)", kind: "qty" } };
  assertEquals(G.ssPgEarlierText([{ sizeId: A, key: "price", kind: "conflict", typed: 4800, server: 4950 }], where, fields),
    "This didn't save before you left: Test Barn 10x12 · Price ($4,800). Type it again if it's right.");
  assertEquals(G.ssPgEarlierText([
    { sizeId: A, key: "c:loft", kind: "invalid", typed: "abc" }, { sizeId: B, key: "active", kind: "refused", typed: true },
    { sizeId: B, key: "price", kind: "conflict", typed: null }, { sizeId: A, key: "c:loft", kind: "refused", typed: 0 },
    { sizeId: Z, key: "price", kind: "refused", typed: 1 }, { sizeId: A, key: "c:gone", kind: "refused", typed: 1 }], where, fields),
    "These didn't save before you left: Test Barn 10x12 · Loft (sq ft) (“abc”); Test Barn 12x24 · Offered (ticked); Test Barn 12x24 · Price (cleared); and 1 more. Type them again if they're right.");
  assertEquals([G.ssPgEarlierText([], where, fields), G.ssPgEarlierText(null, where, fields)], ["", ""]);
});

// ─── Phase 4b: copy, paste, fill down, clear and the confirm (2026-10-31) ──────────────────────
// Lifted the same way, from the shipped text. The VIEW is what the page hands them: the drawn rows
// (ssPgRows), the drawn size ids, the option columns, Real-Time Pricing, and the save queue.
const P4B = ["function ssPgParseTsv(text) {", "function ssPgToTsv(rows) {", "function ssPgParseOffered(text) {",
  "function ssPgSelectionBlock(view, ids, c0, c1) {", "function ssPgOffLost(q, d) {", "function ssPgPlanCells(view, targets, opts) {",
  "function ssPgPastePlan(view, at, block, opts) {", "function ssPgFillPlan(view, sel, opts) {", "function ssPgClearPlan(view, sel, opts) {",
  "function ssPgChangeSummary(sizes) {"].map(lift).join("\n");
const K = new Function(`${PURE}\n${SAVE}\n${P4}\n${P4B}; return { ssPgParseTsv, ssPgToTsv, ssPgParseOffered, ssPgSelectionBlock, ssPgOffLost, ssPgPlanCells,
  ssPgPastePlan, ssPgFillPlan, ssPgClearPlan, ssPgChangeSummary };`)() as Record<string, (...a: Any[]) => Any>;
// The page's view of a model: rows as drawn with `opts` (ssPgRows), and a queue that starts from the
// read unless one is given.
const viewOf = (m: Any, opts: Any = {}, q: Any = null) => {
  const rows = H.ssPgRows(m, opts);
  return { rows, order: rows.filter((r: Any) => r.kind === "size").map((r: Any) => r.id), cols: m.cols, rtp: !!opts.rtp,
    q: q || S.ssPgQueue(null, { type: "init", sizes: S.ssPgServerSizes(m), cols: m.cols.map((c: Any) => c.key) }) };
};
const M4 = () => H.ssPgModel(TCAT, TABLE);
// Columns: 0 Size, 1 Price, 2 Offered, 3 Loft (sq ft), 4 Workbench, 5 the Single Door. Drawn sizes:
// Test Barn 10x12 ($0, Workbench 1), 10x16 (no price, hidden), 12x24 ($4,800, Loft 50, door 2);
// Test Utility 8x10 ($2,100.50, unticked), 8x12; Test Empty (none); Test Old Style 6x8 (hidden style).
const [Z1, Z2, Z3, Z4, Z5, Z6] = [1, 2, 3, 4, 5, 6].map(zid);
const onlyEdits = (p: Any) => p.edits.map((d: Any) => `${d.sizeId.slice(-2)} ${d.f}=${JSON.stringify(d.value)} (seen ${JSON.stringify(d.seen)})`);

Deno.test("ssPgParseTsv: CRLF, LF and CR; the trailing newline; tabs; quoted cells holding tabs, newlines and quotes; ragged rows", () => {
  assertEquals(K.ssPgParseTsv("a\tb\r\nc\td\r\n"), [["a", "b"], ["c", "d"]], "Excel: CRLF and a trailing CRLF");
  assertEquals(K.ssPgParseTsv("1\t2\n3\t4"), [["1", "2"], ["3", "4"]], "Google Sheets: LF and none at the end");
  assertEquals(K.ssPgParseTsv("a\nb\rc\r\n"), [["a"], ["b"], ["c"]]);
  assertEquals([K.ssPgParseTsv("480\r\n"), K.ssPgParseTsv("480"), K.ssPgParseTsv("\r\n"), K.ssPgParseTsv(""), K.ssPgParseTsv(null)],
    [[["480"]], [["480"]], [[""]], [], []], "one box; one EMPTY box (it clears); nothing at all");
  assertEquals(K.ssPgParseTsv('"a\tb"\t"c\r\nd"\te\r\n'), [["a\tb", "c\r\nd", "e"]], "a quoted tab and a quoted line break stay in their cell");
  assertEquals(K.ssPgParseTsv('"say ""hi"""\tx'), [['say "hi"', "x"]], "a doubled quote is one quote");
  assertEquals(K.ssPgParseTsv('"ab"c\td'), [["abc", "d"]], "what follows the closing quote is kept");
  assertEquals(K.ssPgParseTsv('"12\t5\r\n6'), [['"12', "5"], ["6"]], "a quote that never closes is a character, not the rest of the block");
  assertEquals(K.ssPgParseTsv("6'4\"\t2"), [["6'4\"", "2"]], "a quote inside a cell is a character");
  assertEquals(K.ssPgParseTsv("1\t2\t3\r\n4\r\n5\t6\r\n"), [["1", "2", "3"], ["4"], ["5", "6"]], "ragged rows keep their own length");
  assertEquals(K.ssPgParseTsv("1\t\t3\r\n\t\r\n1\t"), [["1", "", "3"], ["", ""], ["1", ""]], "empty cells inside a row are cells");
  assertEquals(K.ssPgParseTsv("1\r\n\r\n3\r\n"), [["1"], [""], ["3"]], "an empty line in the middle is a row with one empty cell");
});

Deno.test("ssPgToTsv: Excel's own shape, and anything it writes reads back the same", () => {
  assertEquals(K.ssPgToTsv([["a", "b"], ["", "c"]]), "a\tb\r\n\tc\r\n");
  assertEquals(K.ssPgToTsv([[""]]), "\r\n", "an empty box copies as one empty box");
  assertEquals([K.ssPgToTsv([]), K.ssPgToTsv(null)], ["", ""]);
  assertEquals(K.ssPgToTsv([["a\tb", 'say "hi"', "x\ny", 4800]]), '"a\tb"\t"say ""hi"""\t"x\ny"\t4800\r\n');
  for (const rows of [[["10x12", "4800.5", "yes", "", "1"]], [[""], ["", ""], ["a\r\nb", '"', "\t"]], [["6'4\"", "1"]]]) {
    assertEquals(K.ssPgParseTsv(K.ssPgToTsv(rows)), rows, JSON.stringify(rows));
  }
});

Deno.test("ssPgParseOffered: yes or no in a sheet's words; blank is no", () => {
  for (const t of ["yes", "Y", " TRUE ", "1", "x", "✓", "on", "Offered"]) assertEquals(K.ssPgParseOffered(t), { ok: true, value: true }, t);
  for (const t of ["", "no", "N", "false", "0", "off", "not offered", null]) assertEquals(K.ssPgParseOffered(t), { ok: true, value: false }, String(t));
  assertEquals(K.ssPgParseOffered("maybe").ok, false);
});

Deno.test("copy (ssPgSelectionBlock): the selected boxes as drawn, plain numbers, yes/no, blanks; an unsent edit is what is drawn", () => {
  const m = M4();
  const v = viewOf(m);
  assertEquals(K.ssPgSelectionBlock(v, [Z1, Z2, Z3], 0, 5), [
    ["10x12", "0", "yes", "", "1", ""],
    ["10x16", "", "no", "", "", ""],
    ["12x24", "4800", "yes", "50", "", "2"],
  ]);
  assertEquals(K.ssPgToTsv(K.ssPgSelectionBlock(v, [Z4, Z5], 1, 3)), "2100.5\tno\t\r\n2350.555\tyes\t\r\n", "an unticked size copies as no; three decimals as stored");
  const q = Q(v.q, commit(Z3, "price", 4900), commit(Z3, "c:loft", 0));
  assertEquals(K.ssPgSelectionBlock({ ...v, q }, [Z3], 1, 3), [["4900", "yes", ""]]);
});

Deno.test("paste: a block lands at its top-left box over the drawn rows and columns; only boxes that change are edits, each with what it showed", () => {
  const m = M4();
  const v = viewOf(m);
  const p = K.ssPgPastePlan(v, { sizeId: Z1, col: 1 }, K.ssPgParseTsv("4900\tyes\r\n5000\r\n"));
  assertEquals(p.ok, true, p.error);
  assertEquals(onlyEdits(p), ["01 price=4900 (seen 0)", "02 price=5000 (seen null)"], "row 2 is short: its Offered box is left as it is");
  assertEquals(p.area, { first: Z1, last: Z2, c0: 1, c1: 2 });
  assertEquals(K.ssPgChangeSummary(p.sizes).text, "Change 2 sizes, Test Barn 10x12 to Test Barn 10x16: 2 prices, 1 size now offered in your designer. Continue?",
    "a first price puts 10x16 in the designer (the server ticks Offered with it)");
  // An empty cell INSIDE a row clears its box; a cell missing from the END of a short row is untouched.
  const c = K.ssPgPastePlan(v, { sizeId: Z3, col: 3 }, [["", "", "3"]]);
  assertEquals(onlyEdits(c), ["03 c:loft=0 (seen 50)", "03 c:11=3 (seen 2)"]);
  const r = K.ssPgPastePlan(v, { sizeId: Z1, col: 3 }, [["7", "8", "9"], ["4"]]);
  assertEquals(onlyEdits(r), ["01 c:loft=7 (seen 0)", "01 c:workbench=8 (seen 1)", "01 c:11=9 (seen 0)", "02 c:loft=4 (seen 0)"]);
  // What is drawn already: nothing to do.
  assertEquals(K.ssPgPastePlan(v, { sizeId: Z3, col: 1 }, [["$4,800", "yes", "50"]]).edits, []);
  // An unsent edit is what is drawn: pasting the server's own value over it is an edit (it drops the edit).
  const q = Q(v.q, commit(Z3, "price", 4900));
  assertEquals(onlyEdits(K.ssPgPastePlan({ ...v, q }, { sizeId: Z3, col: 1 }, [["4800"]])), ["03 price=4800 (seen 4900)"]);
});

Deno.test("paste is ALL OR NOTHING: the first problem named, the rest counted, nothing planned", () => {
  const v = viewOf(M4());
  const p = K.ssPgPastePlan(v, { sizeId: Z1, col: 3 }, [["5", "2"], ["6"], ["abc", "x", "-1"]]);
  assertEquals(p, { ok: false, error: "Row 3 (Test Barn 12x24), Loft (sq ft): 'abc' isn't a whole number. 2 more problems.", problems: 3 }, "the plan's own example");
  assertEquals(K.ssPgPastePlan(v, { sizeId: Z1, col: 3 }, [["2.5"]]).error, "Row 1 (Test Barn 10x12), Loft (sq ft): '2.5' isn't a whole number.");
  assertEquals(K.ssPgPastePlan(v, { sizeId: Z1, col: 3 }, [["1"], ["1,000,000"]]).error, "Row 2 (Test Barn 10x16), Loft (sq ft): '1,000,000' is more than 999,999.");
  assertEquals(K.ssPgPastePlan(v, { sizeId: Z1, col: 1 }, [["-5"], ["4.8k"]]).error, "Row 1 (Test Barn 10x12), Price: '-5' isn't a number of 0 or more. 1 more problem.");
  assertEquals(K.ssPgPastePlan(v, { sizeId: Z1, col: 2 }, [["maybe"]]).error, "Row 1 (Test Barn 10x12), Offered: 'maybe' isn't yes or no.");
  assertEquals(K.ssPgPastePlan(v, { sizeId: Z1, col: 3 }, [["a very long piece of text that goes on and on"]]).error,
    "Row 1 (Test Barn 10x12), Loft (sq ft): 'a very long piece of text tha…' isn't a whole number.");
});

Deno.test("paste: a value equal to what is stored is always accepted, even one the rules would refuse if typed new", () => {
  const t = { ...TABLE, sizes: SIZES.map((z) => (z.id === Z3 ? { ...z, base_price: -5 } : z)),
    inclusions: [...INCS.filter((x) => !(x.size_id === Z3 && x.item_key === "loft")), { size_id: Z3, item_key: "loft", included: true, qty: 1200000 }] };
  const v = viewOf(H.ssPgModel(TCAT, t));
  assertEquals(K.ssPgPastePlan(v, { sizeId: Z3, col: 1 }, [["-5", "yes", "1,200,000"]]), { ok: true, edits: [], sizes: [], area: { first: Z3, last: Z3, c0: 1, c1: 3 } });
  assertEquals(K.ssPgPastePlan(v, { sizeId: Z3, col: 1 }, [["-6"]]).ok, false);
  assertEquals(K.ssPgPastePlan(v, { sizeId: Z3, col: 3 }, [["1200001"]]).error, "Row 1 (Test Barn 12x24), Loft (sq ft): '1200001' is more than 999,999.");
});

Deno.test("paste: Offered and a Real-Time Pricing price follow the rules typing does", () => {
  const v = viewOf(M4());
  assertEquals(K.ssPgPastePlan(v, { sizeId: Z2, col: 2 }, [["yes"]]).error, "Row 1 (Test Barn 10x16), Offered: Add a price first.", "no price on file, none pasted");
  assertEquals(onlyEdits(K.ssPgPastePlan(v, { sizeId: Z2, col: 1 }, [["900", "yes"]])), ["02 price=900 (seen null)"],
    "a first price in the same row: accepted, and nothing goes for Offered (the server ticks it with the price)");
  assertEquals(K.ssPgPastePlan(v, { sizeId: Z3, col: 1 }, [["", "yes"]]).sizes[0].nowShown, false, "a cleared price hides the size whatever Offered says");
  assertEquals(K.ssPgPastePlan(v, { sizeId: Z2, col: 1 }, [["", "yes"]]).error, "Row 1 (Test Barn 10x16), Offered: Add a price first.");
  const off = K.ssPgPastePlan(v, { sizeId: Z3, col: 2 }, [["no"]]);
  assertEquals([onlyEdits(off), off.sizes[0].wasShown, off.sizes[0].nowShown], [["03 active=false (seen true)"], true, false]);
  assertEquals(onlyEdits(K.ssPgPastePlan(v, { sizeId: Z4, col: 2 }, [["yes"]])), ["04 active=true (seen false)"], "a priced, unticked size can be ticked");
  // Real-Time Pricing locks the prices; the price on file is still accepted, and the other boxes paste.
  const rtp = { ...v, rtp: true };
  assertEquals(K.ssPgPastePlan(rtp, { sizeId: Z3, col: 1 }, [["4900", "yes", "7"]]).error, "Row 1 (Test Barn 12x24), Price: Real-Time Pricing sets prices on this account.");
  assertEquals(onlyEdits(K.ssPgPastePlan(rtp, { sizeId: Z3, col: 1 }, [["4800", "no", "7"]])), ["03 active=false (seen true)", "03 c:loft=7 (seen 50)"]);
});

// The round trip a builder makes: copy the table into a sheet (an unpriced size's Offered copies as
// "no"), fill in prices, paste it back. The server ticks Offered with a first price unless told
// otherwise; Excel keeps a "no" row unoffered (plan 4.11), and so must the table (plan 3.11: each
// box takes what was pasted).
Deno.test("paste: a first price with Offered 'no' goes with Offered unticked; with 'yes', the server ticks it", () => {
  const m = M4();
  const v = viewOf(m);
  const no = K.ssPgPastePlan(v, { sizeId: Z2, col: 1 }, [["900", "no"]]);
  assertEquals([no.edits, no.sizes[0].nowShown], [[{ sizeId: Z2, f: "price", value: 900, seen: null, off: true }], false]);
  const yes = K.ssPgPastePlan(v, { sizeId: Z2, col: 1 }, [["900", "yes"]]);
  assertEquals([yes.edits, yes.sizes[0].nowShown], [[{ sizeId: Z2, f: "price", value: 900, seen: null, off: false }], true]);
  // Two such rows: the confirm no longer says they join the designer.
  const db: Record<string, Row> = { [Z2]: { version: SIZES[2].updated_at, price: null, active: false, cells: {} }, [Z1]: { version: SIZES[1].updated_at, price: 0, active: true, cells: { workbench: 1 } } };
  const two = K.ssPgPastePlan(v, { sizeId: Z1, col: 1 }, [["10", "yes"], ["900", "no"]]);
  assertEquals(K.ssPgChangeSummary(two.sizes).text, "Change 2 sizes, Test Barn 10x12 to Test Barn 10x16: 2 prices. Continue?");
  // Sent: the price, and Offered false from false with it; the server keeps it unoffered.
  let q = Q(v.q, { type: "commits", edits: two.edits, at: 0 });
  const [q2, body] = roundTrip(q, db);
  assertEquals(body.sizes.find((s: Any) => s.id === Z2), { id: Z2, base: SIZES[2].updated_at, from: { price: null, active: false }, to: { price: 900, active: false } });
  assertEquals(body.sizes.find((s: Any) => s.id === Z1), { id: Z1, base: SIZES[1].updated_at, from: { price: 0 }, to: { price: 10 } }, "a size with a price on file: just the price");
  assertEquals([db[Z2].price, db[Z2].active, S.ssPgCount(q2).red], [900, false, 0]);
  // "yes" sends the price alone, and the server ticks it.
  const db2: Record<string, Row> = { [Z2]: { version: SIZES[2].updated_at, price: null, active: false, cells: {} } };
  const [, b2] = roundTrip(Q(v.q, { type: "commits", edits: yes.edits, at: 0 }), db2);
  assertEquals([b2.sizes[0].to, db2[Z2].active], [{ price: 900 }, true]);
  // The "no" holds through a price typed over it before it goes, a conflict's resend and a 403; a
  // later paste saying "yes" (with the same price waiting) takes it back.
  q = Q(v.q, { type: "commits", edits: no.edits, at: 0 }, commit(Z2, "price", 950));
  assertEquals(field(q, Z2, "price").pending, { to: 950, from: null, seq: 2, off: true });
  const yesAgain = K.ssPgPastePlan({ ...v, q }, { sizeId: Z2, col: 2 }, [["yes"]]);
  assertEquals(yesAgain.edits, [{ sizeId: Z2, f: "price", value: 950, seen: 950, off: false }]);
  assertEquals(field(Q(q, { type: "commits", edits: yesAgain.edits, at: 0 }), Z2, "price").pending.off, undefined);
  const out = Q(q, { type: "send" });
  assertEquals(Q(out, { type: "fail", n: out.flight.n, kind: "forbidden" }).fields[Z2].price.pending.off, true, "a 403 puts it back unsent, still unticked");
  const db3: Record<string, Row> = { [Z2]: { version: nextV(), price: null, active: false, cells: {} } };   // a colleague's other change: a new version
  let r = Q(out, { type: "ok", n: out.flight.n, answer: serve(db3, out.flight.body) });
  assertEquals(field(r, Z2, "price").pending.off, true, "the conflict's resend still goes unticked");
  [r] = roundTrip(r, db3);
  assertEquals([db3[Z2].price, db3[Z2].active], [950, false]);
  // The backup keeps it too.
  const kept = G.ssPgBackupLoad(JSON.stringify(G.ssPgBackup(q, null, 1, null)), 1);
  assertEquals(kept.sizes[Z2].fields.price, { to: 950, from: null, off: true, at: 1 });
  assertEquals(Q(start({ [Z2]: { version: SIZES[2].updated_at, price: null, active: false, cells: {} } }), { type: "restore", sizes: kept.sizes, at: 0 }).fields[Z2].price.pending.off, true);
  // Fill down from a priced but unticked size onto an unpriced one under it.
  const fill = K.ssPgFillPlan(viewOf(m, { showHidden: true }), { r0: 0, r1: 1, c0: 1, c1: 2 });
  assertEquals(onlyEdits(fill), ["02 price=0 (seen null)"]);
  assertEquals([fill.edits[0].off, fill.sizes[0].nowShown], [false, true], "copied from an offered size: offered");
});

// A first price already on its way has said Offered: its call carried Offered unticked or left it to
// the server's tick. A paste saying otherwise used to plan the price again with `off`, and the queue
// dropped it as no change to the price: the size went into the designer while the confirm said it
// stayed out. A transport failure keeps a price in flight for minutes, so a paste then hit it every time.
Deno.test("paste: Offered on a size whose first price is already on its way is refused when it says otherwise; it never vanishes, and the confirm counts what happens", () => {
  const v = viewOf(M4());
  const STILL = "Row 1 (Test Barn 10x16), Offered: its first price is still saving. Try again once it's saved.";
  // 10x16 has no price on file; $5,000 typed and sent, the answer not back yet.
  const out = Q(v.q, commit(Z2, "price", 5000), { type: "send" });
  assertEquals(out.flight.body.sizes[0].to, { price: 5000 }, "the call carries no Offered: the server ticks it with the price");
  const vo = { ...v, q: out };
  // The reviewer's case, a block with 12x24 under it: refused whole, before anything changes.
  assertEquals(K.ssPgPastePlan(vo, { sizeId: Z2, col: 1 }, [["5000", "no"], ["4900", "no"]]), { ok: false, error: STILL, problems: 1 });
  assertEquals(K.ssPgPastePlan(vo, { sizeId: Z2, col: 1 }, [["6000", "no"]]).error, STILL, "with another price too (that one would go after the first, and Offered not with it)");
  assertEquals(K.ssPgPastePlan(vo, { sizeId: Z2, col: 2 }, [["no"]]).error, STILL);
  // Fill down names the size alone.
  const rows = viewOf(M4(), { showHidden: true }, out);
  assertEquals(K.ssPgFillPlan({ ...rows, q: Q(out, commit(Z1, "active", false)) }, { r0: 0, r1: 1, c0: 1, c1: 2 }).error,
    "Test Barn 10x16, Offered: its first price is still saving. Try again once it's saved.");
  // "yes" is what that call does: nothing more to send for Offered, and the confirm counts it as joining.
  assertEquals(K.ssPgPastePlan(vo, { sizeId: Z2, col: 1 }, [["5000", "yes"]]).edits, []);
  const yes = K.ssPgPastePlan(vo, { sizeId: Z2, col: 1 }, [["6000", "yes"]]);
  assertEquals([onlyEdits(yes), yes.sizes[0].nowShown], [["02 price=6000 (seen 5000)"], true]);
  // A call that carried Offered unticked (a "no" pasted while the price was unsent): "no" again is no
  // change, "yes" is refused, and a price pasted alone over it leaves the size out, as that call does.
  const offOut = Q(v.q, { type: "commits", edits: K.ssPgPastePlan(v, { sizeId: Z2, col: 1 }, [["5000", "no"]]).edits, at: 0 }, { type: "send" });
  assertEquals(offOut.flight.body.sizes[0].to, { price: 5000, active: false });
  const vf = { ...v, q: offOut };
  assertEquals(K.ssPgPastePlan(vf, { sizeId: Z2, col: 1 }, [["5000", "no"]]).edits, []);
  assertEquals(K.ssPgPastePlan(vf, { sizeId: Z2, col: 2 }, [["yes"]]).error, STILL);
  const alone = K.ssPgPastePlan(vf, { sizeId: Z1, col: 1 }, [["10"], ["5100"]]);
  assertEquals(K.ssPgChangeSummary(alone.sizes).text, "Change 2 sizes, Test Barn 10x12 to Test Barn 10x16: 2 prices. Continue?", "not counted as joining the designer");
  // Once it has saved (the server ticked Offered), "no" is an ordinary Offered edit, and the size ends unoffered.
  const db: Record<string, Row> = { [Z2]: { version: SIZES[2].updated_at, price: null, active: false, cells: {} } };
  let q = Q(out, { type: "ok", n: out.flight.n, answer: serve(db, out.flight.body) });
  assertEquals([db[Z2].price, db[Z2].active], [5000, true]);
  const after = K.ssPgPastePlan({ ...v, q }, { sizeId: Z2, col: 1 }, [["5000", "no"]]);
  assertEquals(onlyEdits(after), ["02 active=false (seen true)"]);
  [q] = roundTrip(Q(q, { type: "commits", edits: after.edits, at: 0 }), db);
  assertEquals([db[Z2].price, db[Z2].active, S.ssPgCount(q).red], [5000, false, 0], "unoffered, as the paste said");
});

// The same thing a moment later: the price was unsent when the block was checked, and went out on its
// own while the confirm was open (the send clock runs under it). The page asks ssPgOffLost at Continue.
Deno.test("ssPgOffLost: a paste's Offered holds while its first price is unsent; one sent or saved since would lose it", () => {
  const v = viewOf(M4());
  const q0 = Q(v.q, commit(Z2, "price", 5000));
  const plan = K.ssPgPastePlan({ ...v, q: q0 }, { sizeId: Z1, col: 1 }, [["10", "yes"], ["5000", "no"]]);
  const pe = plan.edits.find((d: Any) => d.sizeId === Z2);
  assertEquals(pe, { sizeId: Z2, f: "price", value: 5000, seen: 5000, off: true });
  assertEquals(K.ssPgChangeSummary(plan.sizes).text, "Change 2 sizes, Test Barn 10x12 to Test Barn 10x16: 1 price. Continue?");
  assertEquals(plan.edits.map((d: Any) => K.ssPgOffLost(q0, d)), [false, false], "unsent: the 'no' goes with the price");
  const q1 = Q(q0, { type: "send" });
  assertEquals(q1.flight.body.sizes[0].to, { price: 5000 }, "sent without it");
  assertEquals(K.ssPgOffLost(q1, pe), true, "on its way: committing it now would drop the 'no'…");
  assertEquals(Q(q1, { type: "commits", edits: [pe], at: 0 }).fields[Z2].price, q1.fields[Z2].price, "…as the queue shows: nothing of it is kept");
  const db: Record<string, Row> = { [Z2]: { version: SIZES[2].updated_at, price: null, active: false, cells: {} } };
  const q2 = Q(q1, { type: "ok", n: q1.flight.n, answer: serve(db, q1.flight.body) });
  assertEquals([q2.sizes[Z2].price, q2.sizes[Z2].active, K.ssPgOffLost(q2, pe)], [5000, true, true], "saved, and the server ticked it");
  // What the server does anyway is never lost: "yes" either way, "no" once Offered is unticked on file.
  assertEquals([K.ssPgOffLost(q1, { ...pe, off: false }), K.ssPgOffLost(q2, { ...pe, off: false })], [false, false]);
  assertEquals(K.ssPgOffLost(Q(q2, commit(Z2, "active", false)), pe), false);
  // Nothing else is ever judged: a price with no `off`, an Offered edit, a size that went.
  assertEquals([K.ssPgOffLost(q1, { sizeId: Z2, f: "price", value: 5000, seen: 5000 }), K.ssPgOffLost(q1, { sizeId: Z2, f: "active", value: false, seen: false, off: true }),
    K.ssPgOffLost(q1, { ...pe, sizeId: zid(77) }), K.ssPgOffLost(null, pe)], [false, false, false, false]);
});

Deno.test("paste, fill and clear take nothing on a size being removed: refused, named", () => {
  const m = M4();
  const v = viewOf(m);
  const q = { ...v.q, removes: { [Z2]: "inflight" } };
  assertEquals(K.ssPgPastePlan({ ...v, q }, { sizeId: Z1, col: 3 }, [["5"], ["6"]]).error, "Row 2 (Test Barn 10x16): this size is being removed.");
  assertEquals(K.ssPgClearPlan({ ...v, q }, { r0: 1, r1: 1, c0: 3, c1: 3 }).error, "Test Barn 10x16: this size is being removed.");
});

Deno.test("paste is refused BEFORE any value is checked: a band or placeholder, a folded hidden size, past the last row or column, the Size column, over 20,000 boxes", () => {
  const m = M4();
  const v = viewOf(m);
  const at = (sizeId: string, col = 1) => ({ sizeId, col });
  assertEquals(K.ssPgPastePlan(v, at(Z3), [["abc"], ["abc"]]).error, "Paste one style at a time.", "12x24 is Test Barn's last size; the next row is a band");
  assertEquals(K.ssPgPastePlan(v, at(Z5), [["1"], ["1"]]).error, "Paste one style at a time.", "into Test Empty's band and placeholder");
  // A placeholder or an add strip never lands a box, wherever it is drawn.
  for (const kind of ["empty", "add"]) {
    const rows = [...v.rows];
    rows.splice(rows.findIndex((r: Any) => r.id === Z1) + 1, 0, { kind, id: "x-" + sid(1), style: rows[0].style, text: "No sizes yet." });
    assertEquals(K.ssPgPastePlan({ ...v, rows }, at(Z1), [["1"], ["1"]]).error, "Paste one style at a time.", kind);
  }
  // Folded hidden sizes.
  const fold = { ...TABLE, sizes: [size(11, 1, 10, 10, 100, true, 0), size(12, 1, 10, 12, null, false, 1), size(13, 1, 10, 14, 120, false, 2),
    size(14, 1, 10, 16, 140, true, 3), size(15, 1, 10, 18, 160, true, 4)], inclusions: [], counts: { sizes: 5, inclusions: 0 } };
  const fm = H.ssPgModel(TCAT, fold);
  const folded = viewOf(fm, { showHidden: false });
  assertEquals(folded.order, [zid(11), zid(14), zid(15)]);
  assertEquals(K.ssPgPastePlan(folded, at(zid(11)), [["abc"], ["1"]]).error, "Show hidden sizes first. This block would skip 2 hidden sizes.");
  assertEquals(K.ssPgPastePlan(folded, at(zid(14)), [["1"], ["2"]]).ok, true, "two sizes drawn side by side");
  assertEquals(K.ssPgPastePlan(viewOf(m, { showHidden: false }), at(Z1), [["1"], ["2"]]).error, "Show hidden sizes first. This block would skip 1 hidden size.");
  assertEquals(K.ssPgPastePlan(viewOf(fm), at(zid(11)), [["1"], ["2"]]).ok, true, "shown, they are rows like any other");
  // The edges.
  assertEquals(K.ssPgPastePlan(viewOf(m, { hiddenStylesOpen: true }), at(Z6), [["1"], ["1"]]).error, "This block runs past the last size.");
  assertEquals(K.ssPgPastePlan(v, at(Z1, 5), [["1", "abc"]]).error, "This block runs past the last column.");
  assertEquals(K.ssPgPastePlan(v, at(Z1, 0), [["10x12", "1"]]).error, "The Size column can't be pasted into. Start on a price or an option box.");
  assertEquals(K.ssPgPastePlan(v, at(Z1, 3), [["1", "2", "abc"], ["4", "5", "6"]], { max: 5 }).error, "This block has 6 boxes. Paste at most 5 at a time.");
  assertEquals(K.ssPgPastePlan(v, at(Z1, 3), []).error, "There's nothing to paste.");
  assertEquals(K.ssPgPastePlan(v, null, [["1"]]).error, "Click the box where the paste should start.");
});

Deno.test("fill down: the top row copied into the rows under it; one row tall takes the size above; the same band, fold and all-or-nothing rules", () => {
  const m = M4();
  const v = viewOf(m);
  // Rows 10x12 to 12x24, Price to Loft: $0, yes, blank.
  const f = K.ssPgFillPlan(v, { r0: 0, r1: 2, c0: 1, c1: 3 });
  assertEquals(onlyEdits(f), ["02 price=0 (seen null)", "03 price=0 (seen 4800)", "03 c:loft=0 (seen 50)"], "10x16 takes its first price, and Offered with it");
  assertEquals(K.ssPgChangeSummary(f.sizes).text, "Change 2 sizes, Test Barn 10x16 to Test Barn 12x24: 2 prices, 1 size now offered in your designer, 1 included option. Continue?");
  // One row: from the size drawn right above it. One size: no confirm.
  const one = K.ssPgFillPlan(v, { r0: 1, r1: 1, c0: 1, c1: 1 });
  assertEquals([onlyEdits(one), K.ssPgChangeSummary(one.sizes).ask], [["02 price=0 (seen null)"], false]);
  assertEquals(K.ssPgFillPlan(v, { r0: 0, r1: 0, c0: 1, c1: 1 }).error, "There's no size above this one in Test Barn to fill down from.");
  assertEquals(K.ssPgFillPlan(v, { r0: 3, r1: 3, c0: 1, c1: 1 }).error, "There's no size above this one in Test Utility to fill down from.", "the row above is a band");
  assertEquals(K.ssPgFillPlan(v, { r0: 2, r1: 3, c0: 1, c1: 1 }).error, "Fill down one style at a time.");
  assertEquals(K.ssPgFillPlan(viewOf(m, { showHidden: false }), { r0: 1, r1: 1, c0: 3, c1: 3 }).error, "Show hidden sizes first. Filling down would skip 1 hidden size.");
  // The Size column is never filled.
  assertEquals(onlyEdits(K.ssPgFillPlan(v, { r0: 0, r1: 1, c0: 0, c1: 1 })), ["02 price=0 (seen null)"]);
  assertEquals(K.ssPgFillPlan(v, { r0: 0, r1: 1, c0: 0, c1: 0 }).error, "A size's width and length can't be changed here.");
  // Real-Time Pricing: a price can't be filled; all or nothing, named by size.
  assertEquals(K.ssPgFillPlan({ ...v, rtp: true }, { r0: 0, r1: 2, c0: 1, c1: 1 }).error, "Test Barn 10x16, Price: Real-Time Pricing sets prices on this account. 1 more problem.");
  assertEquals(K.ssPgFillPlan(v, { r0: 0, r1: 2, c0: 1, c1: 5 }, { max: 10 }).error, "That's 15 boxes. Fill down at most 10 at a time.");
  assertEquals(K.ssPgFillPlan(v, null).error, "Click a box first.");
});

Deno.test("clear: every selected box emptied, across styles; the Size column never; Real-Time Pricing locks prices, all or nothing", () => {
  const m = M4();
  const v = viewOf(m);
  // 12x24 to 8x12, Price to the door: 12x24 and 8x12 leave the designer; 8x10 was not in it.
  const c = K.ssPgClearPlan(v, { r0: 2, r1: 4, c0: 1, c1: 5 });
  assertEquals(onlyEdits(c), ["03 price=null (seen 4800)", "03 active=false (seen true)", "03 c:loft=0 (seen 50)", "03 c:11=0 (seen 2)",
    "04 price=null (seen 2100.5)", "05 price=null (seen 2350.555)", "05 active=false (seen true)"]);
  assertEquals(K.ssPgChangeSummary(c.sizes).text, "Change 3 sizes, Test Barn 12x24 to Test Utility 8x12: 3 prices, 2 sizes hidden from your designer, 2 included options. Continue?");
  assertEquals(onlyEdits(K.ssPgClearPlan(v, { r0: 0, r1: 0, c0: 0, c1: 4 })), ["01 price=null (seen 0)", "01 active=false (seen true)", "01 c:workbench=0 (seen 1)"],
    "the Size column is skipped");
  assertEquals(K.ssPgClearPlan(v, { r0: 0, r1: 2, c0: 0, c1: 0 }).error, "A size's width and length can't be changed here.");
  assertEquals(K.ssPgClearPlan(v, { r0: 1, r1: 1, c0: 1, c1: 5 }).edits, [], "nothing there: nothing to clear");
  assertEquals(K.ssPgClearPlan({ ...v, rtp: true }, { r0: 2, r1: 4, c0: 1, c1: 3 }).error, "Test Barn 12x24, Price: Real-Time Pricing sets prices on this account. 2 more problems.");
  assertEquals(onlyEdits(K.ssPgClearPlan({ ...v, rtp: true }, { r0: 2, r1: 2, c0: 3, c1: 5 })), ["03 c:loft=0 (seen 50)", "03 c:11=0 (seen 2)"], "the option boxes still clear");
  assertEquals(K.ssPgClearPlan(v, { r0: 0, r1: 4, c0: 1, c1: 5 }, { max: 20 }).error, "That's 25 boxes. Clear at most 20 at a time.");
});

Deno.test("ssPgChangeSummary: names the first and last size, counts prices, sizes leaving or joining the designer, options; one size never asks", () => {
  const z = (name: string, prices: number, options: number, wasShown = true, nowShown = true) => ({ id: name, name, prices, options, offered: 0, wasShown, nowShown });
  const six = [z("Barn 10x12", 1, 3), z("Barn 10x16", 1, 3, true, false), z("Barn 10x20", 1, 2), z("Barn 12x16", 1, 2, true, false), z("Barn 12x20", 1, 2), z("Barn 12x24", 1, 2)];
  assertEquals(K.ssPgChangeSummary(six), { ask: true, sizes: 6, prices: 6, hidden: 2, shown: 0, options: 14,
    text: "Change 6 sizes, Barn 10x12 to Barn 12x24: 6 prices, 2 sizes hidden from your designer, 14 included options. Continue?" }, "the plan's own example");
  assertEquals(K.ssPgChangeSummary([z("A 1x1", 1, 0, true, false), z("A 1x2", 0, 1, false, true)]).text,
    "Change 2 sizes, A 1x1 to A 1x2: 1 price, 1 size hidden from your designer, 1 size now offered in your designer, 1 included option. Continue?");
  assertEquals(K.ssPgChangeSummary([z("A 1x1", 1, 40)]), { ask: false, sizes: 1, prices: 1, hidden: 0, shown: 0, options: 40, text: "" }, "one size: typing never asks, nor does this");
  assertEquals([K.ssPgChangeSummary([]).ask, K.ssPgChangeSummary(null).ask], [false, false]);
});

Deno.test("queue commits: many boxes in one event, each by the commit rule and its seen check, flushed; the same as committing them one by one", () => {
  const edits = [{ sizeId: A, f: "price", value: 480 }, { sizeId: A, f: "c:loft", value: 0 }, { sizeId: B, f: "price", value: 2100 }, { sizeId: E, f: "price", value: 1 }];
  const many = Q(start(DB()), { type: "commits", edits, at: 5 });
  const oneByOne = Q(start(DB()), ...edits.map((d) => commit(d.sizeId, d.f, d.value, 5)));
  assertEquals(many.fields, oneByOne.fields, "an equal value sends nothing; a size not on the account is ignored");
  assertEquals([many.seq, many.flush, S.ssPgDueIn(many, 5)], [2, true, 0], "a paste goes at once");
  const s0 = start(DB());
  const none = Q(s0, { type: "commits", edits: [{ sizeId: B, f: "price", value: 2100 }], at: 0 });
  assertEquals([none.flush, S.ssPgDueIn(none, 0)], [false, null], "nothing changed: nothing due");
  assertEquals(s0.fields, {}, "the input state is never touched");
  // `seen`: a box that moved since the paste was checked (an answer while the confirm was open) turns
  // red with both values and is never sent; the boxes beside it go.
  const db = DB();
  let q = Q(start(db), commit(A, "price", 500));
  q = Q(q, { type: "commits", edits: [{ sizeId: A, f: "price", value: 600, seen: 400 }, { sizeId: A, f: "c:loft", value: 7, seen: 50 }], at: 0 });
  assertEquals(field(q, A, "price"), { error: { kind: "conflict", typed: 600, server: 400, reason: null } });
  assertEquals(field(q, A, "c:loft").pending, { to: 7, from: 50, seq: 2 });
  const [q2, body] = roundTrip(q, db);
  assertEquals(body.sizes, [{ id: A, base: V0, from: { cells: { loft: 50 } }, to: { cells: { loft: 7 } } }]);
  assertEquals(S.ssPgCount(q2).red, 1);
});

Deno.test("a paste of 20,000 boxes: planned, committed in one event, sent in calls of at most 50 sizes and 2,500 boxes, every box once", () => {
  const N = 500, W = 40;
  const cat = { clientId: "test-barns", items: Array.from({ length: W }, (_, i) => ({ key: `opt${i}`, label: `Test Option ${i}` })), fixtures: [] };
  const big = Array.from({ length: N }, (_, i) => ({ id: `20000000-0000-4000-8000-${String(i).padStart(12, "0")}`, style_id: sid(1), label: `10x${i + 1}`,
    width_ft: 10, length_ft: i + 1, base_price: 1000 + i, active: true, sort_order: i, created_at: V0, updated_at: V0 }));
  const m = H.ssPgModel(cat, { clientId: "test-barns", rtpOn: false, styles: [STYLES[1]], sizes: big, inclusions: [], counts: { sizes: N, inclusions: 0 } });
  const v = viewOf(m);
  const text = K.ssPgToTsv(Array.from({ length: N }, (_, r) => Array.from({ length: W }, (_, c) => String(((r + c) % 9) + 1))));
  const block = K.ssPgParseTsv(text);
  const plan = K.ssPgPastePlan(v, { sizeId: big[0].id, col: 3 }, block);
  assertEquals([plan.ok, plan.edits.length, plan.sizes.length], [true, N * W, N]);
  assertEquals(K.ssPgChangeSummary(plan.sizes).text, `Change ${N} sizes, Test Barn 10x1 to Test Barn 10x${N}: 20,000 included options. Continue?`);
  let q = Q(v.q, { type: "commits", edits: plan.edits, at: 0 });
  assertEquals(S.ssPgCount(q).pending, N * W);
  assertEquals(K.ssPgPastePlan(v, { sizeId: big[0].id, col: 3 }, [...block, ["1"]]).error, "This block runs past the last size.");
  const wider = block.map((r: string[]) => [...r, "1"]);
  assertEquals(K.ssPgPastePlan({ ...v, cols: [...v.cols, { key: "x", label: "X" }] }, { sizeId: big[0].id, col: 3 }, wider).error,
    "This block has 20,500 boxes. Paste at most 20,000 at a time.");
  const db = copy(S.ssPgServerSizes(m) as Record<string, Row>);
  const bodies: Any[] = [];
  for (let i = 0; i < 40 && (S.ssPgCount(q).pending || q.flight); i++) {
    let body;
    [q, body] = roundTrip(q, db);
    if (body) bodies.push(body);
  }
  const cells = (b: Any) => b.sizes.reduce((n: number, s: Any) => n + Object.keys(s.to.cells || {}).length, 0);
  assertEquals(bodies.length, 10, "50 sizes x 40 boxes a call");
  assert(bodies.every((b) => b.sizes.length <= MAX_CALL_ENTRIES && cells(b) <= MAX_CALL_CELLS), JSON.stringify(bodies.map((b) => [b.sizes.length, cells(b)])));
  assertEquals(bodies.reduce((n, b) => n + cells(b), 0), N * W, "every box went exactly once");
  assertEquals(S.ssPgCount(q), { pending: 0, inflight: 0, red: 0, creating: 0, removing: 0 });
  assert(big.every((z, r) => Array.from({ length: W }, (_, c) => db[z.id].cells[`opt${c}`] === ((r + c) % 9) + 1).every(Boolean)), "the server holds the block");
});
