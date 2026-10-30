// Pricing Table helpers (portal/03-catalog.jsx), lifted from the SHIPPED source. The Excel template
// and the Pricing Table both build their option columns with ssPricingColumns, so a change to it
// changes the header builders download. The golden header below is today's sheet: if it moves,
// every builder's saved sheet stops matching on re-upload (columns are matched by exact label).

import { assert, assertEquals } from "jsr:@std/assert";

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
  "function ssPgHeaderHeight(labels, measure, pad) {", "function ssPgTemplate(cat, table) {"].map(lift).join("\n");
// deno-lint-ignore no-explicit-any
type Any = any;
const H = new Function(`${PURE}; return { ssPgFmtPrice, ssPgModel, ssPgRows, ssPgMove, ssPgHeaderHeight, ssPgTemplate };`)() as Record<string, (...a: Any[]) => Any>;

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
