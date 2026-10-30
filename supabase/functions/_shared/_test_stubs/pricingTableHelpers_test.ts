// Pricing Table helpers (portal/03-catalog.jsx), lifted from the SHIPPED source. The Excel template
// and the Pricing Table both build their option columns with ssPricingColumns, so a change to it
// changes the header builders download. The golden header below is today's sheet: if it moves,
// every builder's saved sheet stops matching on re-upload (columns are matched by exact label).

import { assertEquals } from "jsr:@std/assert";

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
