// A rep's own price for a line (a builder's request; migration 277) — the designer's
// half and the one key spelling, tested against the SHIPPED twins.
//
//   1. THE KEY RULE EXISTS THREE TIMES, BYTE FOR BYTE: _shared/priceRowKey.ts (submit-estimate) and
//      the region between the PRICE ROW KEYS markers in both designer twins. If they differ, an
//      override finds no line and the quote silently goes out at list price — so they may not.
//   2. Every spelling is pinned, including the partition keys reserved for the next build, and the
//      designer's existing Details keys are unchanged (priceRowMatcher still finds the items behind
//      each one, so the row's × keeps working).
//   3. The designer applies a price inside both row builders, before any percentage row: the unit
//      replaces the list unit, the line total follows, the unit text the customer reads is
//      re-spelled, the building's credit breakdown is dropped, a stale or unreadable price is
//      ignored, and an "included" row, a percentage row and a hidden-pricing tenant take nothing.
//   4. ssPriceOverrideList sends exactly what is applied (stale entries never reach the server) and
//      each rough opening by its own id.
//   5. The server's parse and apply rules (_shared/priceOverride.ts), on their own.
// submitEstimatePriceOverrideWiring_test drives the real handler and checks the two halves agree.

// deno-lint-ignore-file no-explicit-any
import { assert, assertEquals, assertFalse } from "jsr:@std/assert";
import { CMP, designer, detailsSubtotal, JSX, keyRegion, PRICE_ROW_KEY_TS, REGIONS_CMP, REGIONS_JSX } from "./designerPricing.ts";
import { ssPriceGroupId, ssPriceRowKey } from "../priceRowKey.ts";
import { applyPriceOverrides, parsePriceOverrides, PRICE_OVERRIDE_MAX } from "../priceOverride.ts";
import { buildFormalEstimatePdf } from "../estimatePdf.ts";
import { pdfText } from "./pdfText.ts";

const D = designer();

// ─── 1. One rule, three copies ─────────────────────────────────────────────────────────────────
Deno.test("the key rule is byte-identical in priceRowKey.ts and both designer twins", () => {
  const ts = keyRegion(PRICE_ROW_KEY_TS, "_shared/priceRowKey.ts");
  assertEquals(keyRegion(CMP, "structure-studio.component.js"), ts, "structure-studio.component.js differs from priceRowKey.ts");
  assertEquals(keyRegion(JSX, "StructureStudio.jsx"), ts, "StructureStudio.jsx differs from priceRowKey.ts");
  assert(ts.includes("function ssPriceRowKey(") && ts.includes("function ssPriceGroupId("), "the region holds both functions");
  // Exactly once per file, so a stale second copy cannot shadow the first.
  for (const [name, src] of [["cmp", CMP], ["jsx", JSX]] as const) {
    assertEquals(src.split("function ssPriceRowKey(").length - 1, 1, name);
  }
});

Deno.test("every lifted pricing region is byte-identical in the two twins", () => {
  REGIONS_CMP.forEach((r, i) => assertEquals(REGIONS_JSX[i].text, r.text, `twins differ in the region starting ${r.a}`));
});

// ─── 2. The spellings ──────────────────────────────────────────────────────────────────────────
Deno.test("every key is spelled exactly as the Details rows have always been keyed", () => {
  const cases: [string, unknown[], string][] = [
    ["building", [], "building"], ["paint", [], "paint"], ["roof", [], "roof"], ["cladding", [], "cladding"],
    ["wallHeight", [], "wallHeight"], ["buildOnSite", [], "buildOnSite"], ["electrical", [], "electrical"],
    ["layout", ["singleDoor"], "singleDoor"], ["layout", ["ramp"], "ramp"], ["layout", ["loft"], "loft"],
    ["insul", ["walls"], "insul:walls"], ["foundation", ["piers"], "foundation:piers"], ["elecItem", ["e-1"], "elecItem:e-1"],
    ["ro", [21], "ro:21"], ["ro", ["it-9"], "ro:it-9"],
    ["fx", ["fx-door", "c1", ""], "fx:fx-door|c1|"], ["fx", ["Barn Door|500", "", "t2"], "fx:Barn Door|500||t2"],
    ["win", ["fx-win", ""], "win:fx-win|"], ["win", ["Window|0", "wc"], "win:Window|0|wc"],
    ["dress", ["shutters", "c1"], "dress:shutters|c1"], ["ramp", ["fx-ramp"], "ramp:fx-ramp"], ["ramp", ["simple"], "ramp:simple"],
  ];
  for (const [kind, args, want] of cases) {
    assertEquals((ssPriceRowKey as any)(kind, ...args), want, `${kind} ${JSON.stringify(args)}`);
    assertEquals((D.ssPriceRowKey as any)(kind, ...args), want, `(designer copy) ${kind}`);
  }
  // A group id is the fixture id, or name|price when the item carries none.
  assertEquals(ssPriceGroupId("fx-1", "Barn Door", 500), "fx-1");
  assertEquals(ssPriceGroupId("", "Barn Door", 500), "Barn Door|500");
  assertEquals(ssPriceGroupId(null as any, "Window", 0), "Window|0");
  assertEquals(ssPriceGroupId(undefined, "Ramp", 12.5), "Ramp|12.5");
});

Deno.test("partition keys are reserved now, so the partition build cannot invent a second spelling", () => {
  assertEquals(ssPriceRowKey("partition", "p-1"), "partition:p-1");
  assertEquals(ssPriceRowKey("partition", "p-1", "o-7"), "partition:p-1:open:o-7");
  // Neither can collide with any key the designer already uses.
  for (const k of ["partition:p-1", "partition:p-1:open:o-7"]) {
    assertFalse(/^(fx|win|ramp|dress|ro|insul|foundation|elecItem):/.test(k));
  }
});

// ─── A tenant and a design, as get_config hands them to the designer ───────────────────────────
const C: any = {
  showPricing: true, options: [],
  layoutPricing: {
    singleDoor: { rate: 400, method: "each" }, workbench: { rate: 12.5, method: "lineal_ft" },
    loft: { rate: 6, method: "sqft_option" }, shelf: { rate: 5, method: "pct_estimate_total" },
    doubleShelf: { rate: 2, method: "sqft_building" }, roughOpeningDoor: { rate: 150, method: "each" },
  },
  sizePricing: { econo: { "10x12": { basePrice: 3000, widthFt: 10, lengthFt: 12 }, "12x16": { basePrice: 4200, widthFt: 12, lengthFt: 16 } } },
  buildingStyles: [{ value: "econo", label: "Econo", sizeInclusionQty: { "10x12": { singleDoor: 1 } } }],
  colors: [{ id: "c1", label: "Barn Red", siding: true, trim: true, rate: 100, pricingMethod: "each", doorRate: 50, shingle: true }],
  wallHeightOptions: { econo: [{ deltaIn: 6, ratePerLf: 5 }] },
  fixtures: [{ id: "fx-door", price: 500, colorMode: "paint" }],
};
const ITEMS: any[] = [
  { id: 1, type: "singleDoor" }, { id: 2, type: "singleDoor" },
  { id: 3, type: "workbench", widthFt: 6 }, { id: 4, type: "loft", widthFt: 6, heightFt: 8 },
  { id: 5, type: "shelf", widthFt: 4 }, { id: 6, type: "doubleShelf", widthFt: 3 },
  { id: 7, type: "fixtureDoor", fixtureItemId: "fx-door", price: 500, doorName: "Barn Door", colorId: "c1", colorLabel: "Barn Red" },
  { id: 8, type: "fixtureDoor", price: 275, doorName: "Old Door" },               // a fixture since deleted
  { id: 21, type: "roughOpeningDoor" },
];
const SEL: any = { style: "econo", size: "10x12", paint: "Painted", roofType: "Shingle", roofColor: "Barn Red", wallHeightDeltaIn: 6 };
const PAINT = { body: "Barn Red", trim: "Barn Red" };
const rowsOf = (sel: any, items = ITEMS, c = C) => [
  ...D.computeSelectionRows(sel, PAINT, c, items),
  ...D.computeLayoutPricingRows(items, sel, [], c, PAINT).rows,
];
const byKey = (rows: any[], k: string) => rows.find((r) => r.key === k);

Deno.test("the designer's row keys are today's, and the × still finds the items behind each", () => {
  const rows = rowsOf(SEL);
  const keys = rows.map((r) => r.key);
  for (const k of ["building", "wallHeight", "paint", "roof", "singleDoor", "workbench", "loft", "shelf", "doubleShelf", "fx:fx-door|c1|", "fx:Old Door|275||"]) {
    assert(keys.includes(k), `missing row ${k} in ${keys}`);
  }
  assertEquals(ITEMS.filter(D.priceRowMatcher("fx:fx-door|c1|")).map((i) => i.id), [7]);
  assertEquals(ITEMS.filter(D.priceRowMatcher("fx:Old Door|275||")).map((i) => i.id), [8]);
  assertEquals(ITEMS.filter(D.priceRowMatcher("singleDoor")).map((i) => i.id), [1, 2]);
});

Deno.test("only rows the server can re-price carry a list unit; included and percentage rows do not", () => {
  const rows = rowsOf(SEL);
  const unit = (k: string) => { const r = byKey(rows, k); return r && r.listUnit != null ? [r.listUnit, r.chargeQty, r.per] : null; };
  assertEquals(unit("building"), [3000, 1, "each"]);
  assertEquals(unit("wallHeight"), [5, 44, "per ft"]);
  assertEquals(unit("paint"), [100, 1, "each"]);
  assertEquals(unit("singleDoor"), [400, 1, "each"], "one of two is included: the charged count");
  assertEquals(unit("workbench"), [12.5, 6, "per ft"]);
  assertEquals(unit("loft"), [6, 48, "per sq ft"]);
  assertEquals(unit("doubleShelf"), [240, 1, "each"], "per sq ft OF BUILDING multiplies the count: the unit is rate x area");
  assertEquals(unit("fx:fx-door|c1|"), [550, 1, "each"]);
  assertEquals(unit("shelf"), null, "a percentage row never takes a price");
  // An included row: the size includes one single door; place only one and the row is included.
  const one = rowsOf(SEL, ITEMS.filter((i) => i.id !== 2));
  assertEquals(byKey(one, "singleDoor").unit, "included");
  assertEquals(byKey(one, "singleDoor").listUnit, undefined);
  // A tenant who hides prices: nothing is priceable anywhere.
  const hidden = { ...C, showPricing: false };
  assert(D.computeSelectionRows(SEL, PAINT, hidden, ITEMS).every((r: any) => r.listUnit == null));
  assertEquals(D.computeLayoutPricingRows(ITEMS, SEL, [], hidden, PAINT).rows, []);
});

Deno.test("absent, empty or unknown overrides leave every row exactly as it was", () => {
  const base = JSON.stringify(rowsOf(SEL));
  for (const ov of [undefined, {}, { nope: { amount: "1", was: 1 } }, null, "junk"]) {
    assertEquals(JSON.stringify(rowsOf({ ...SEL, priceOverrides: ov })), base, JSON.stringify(ov));
  }
});

// ─── 3. Applying a price ───────────────────────────────────────────────────────────────────────
Deno.test("a price replaces the UNIT, the line follows, and the customer's text shows only the new price", () => {
  const sel = { ...SEL, priceOverrides: {
    building: { amount: "2800", was: 3000 },
    workbench: { amount: "10", was: 12.5 },
    "fx:fx-door|c1|": { amount: "600", was: 550 },
    doubleShelf: { amount: "199.99", was: 240 },
  } };
  const rows = rowsOf(sel);
  const b = byKey(rows, "building");
  assertEquals([b.total, b.unitPrice, b.listTotal, b.overridden], [2800, 2800, 3000, true]);
  const wb = byKey(rows, "workbench");
  assertEquals([wb.total, wb.unit], [60, "$10.00 / ft"]);
  const fx = byKey(rows, "fx:fx-door|c1|");
  assertEquals([fx.total, fx.unit, fx.qty], [600, "$600.00 each", 1]);
  const ds = byKey(rows, "doubleShelf");
  assertEquals([ds.total, ds.unit], [199.99, "$199.99 each"], "a rate-per-building-sq-ft unit becomes the item's own price");
  // Rows nobody priced are untouched.
  assertEquals(byKey(rows, "loft").total, 288);
  assertFalse(byKey(rows, "loft").overridden);
});

Deno.test("the building's credit breakdown goes with a new building price — it opens with the list price", () => {
  const c = { ...C, buildingStyles: [{ value: "econo", label: "Econo", sizeInclusionQty: { "10x12": { singleDoor: 1, loft: 32 } } }] };
  const sel = { ...SEL, declinedItems: ["loft"] };
  const items = ITEMS.filter((i) => i.type !== "loft");
  const list = byKey(rowsOf(sel, items, c), "building");
  assert(list.detail.startsWith("Original building price: $3,000.00"), list.detail);
  const priced = byKey(rowsOf({ ...sel, priceOverrides: { building: { amount: "2600", was: list.listUnit } } }, items, c), "building");
  assertEquals([priced.total, priced.detail], [2600, ""]);
});

Deno.test("a percentage row is worked out again on the re-priced lines", () => {
  const pct = (sel: any) => byKey(D.computeLayoutPricingRows(ITEMS, sel, [], C, PAINT).rows, "shelf").total;
  const before = pct(SEL);
  const after = pct({ ...SEL, priceOverrides: { building: { amount: "2800", was: 3000 }, loft: { amount: "5", was: 6 }, "ro:21": { amount: "250", was: 150 } } });
  // 5% of (−200 on the building, −48 on the loft, +100 on the opening) = −7.40.
  assertEquals(Math.round((after - before) * 100) / 100, -7.4);
});

Deno.test("a STALE price — set against a list that has since moved — is not applied", () => {
  // Priced on a 10x12; the customer switched to a 12x16.
  const rows = rowsOf({ ...SEL, size: "12x16", priceOverrides: { building: { amount: "2800", was: 3000 } } });
  const b = byKey(rows, "building");
  assertEquals([b.total, b.overridden], [4200, undefined]);
  // A price with no `was` (an older shape) still applies.
  assertEquals(byKey(rowsOf({ ...SEL, priceOverrides: { building: { amount: "2800" } } }), "building").total, 2800);
});

Deno.test("an unreadable, empty or negative entry is ignored; a huge one is capped like the server's", () => {
  for (const amount of ["", "  ", "abc", "-5", null, "."]) {
    assertEquals(byKey(rowsOf({ ...SEL, priceOverrides: { building: { amount, was: 3000 } } }), "building").total, 3000, JSON.stringify(amount));
  }
  assertEquals(byKey(rowsOf({ ...SEL, priceOverrides: { building: { amount: "0", was: 3000 } } }), "building").total, 0, "zero is a real price");
  assertEquals(byKey(rowsOf({ ...SEL, priceOverrides: { building: { amount: "99999999", was: 3000 } } }), "building").total, PRICE_OVERRIDE_MAX);
});

Deno.test("a rough opening is priced one opening at a time, by its own id", () => {
  const ov = { "ro:21": { amount: "250", was: 150 } };
  assertEquals(D.ssRoPrice(ov, { id: 21, type: "roughOpeningDoor" }, 150), 250);
  assertEquals(D.ssRoPrice(ov, { id: 22, type: "roughOpeningDoor" }, 150), 150);
  assertEquals(D.ssRoPrice({ "ro:21": { amount: "250", was: 99 } }, { id: 21 }, 150), 150, "stale");
  const sub = (sel: any) => detailsSubtotal(D, sel, ITEMS, [], C, PAINT);
  assertEquals(Math.round((sub({ ...SEL, priceOverrides: ov }).roTotal - sub(SEL).roTotal) * 100) / 100, 100);
});

// ─── 4. What the payload carries ───────────────────────────────────────────────────────────────
Deno.test("the payload list is exactly the applied prices — never a stale or half-typed one", () => {
  const sel = { ...SEL, priceOverrides: {
    building: { amount: "2800", was: 3000 },
    loft: { amount: "", was: 6 },                       // being typed
    workbench: { amount: "11", was: 99 },               // stale
    shelf: { amount: "1", was: 5 },                     // a percentage row: never priceable
    "ro:21": { amount: "250", was: 150 },
    "ro:99": { amount: "250", was: 150 },               // an opening no longer on the plan
  } };
  assertEquals(D.ssPriceOverrideList(sel, ITEMS, [], C, PAINT), [
    { rowKey: "building", amount: 2800 },
    { rowKey: "ro:21", amount: 250 },
  ]);
  assertEquals(D.ssPriceOverrideList(SEL, ITEMS, [], C, PAINT), [], "no field, no entries");
});

// ─── 5. The server's rules on their own ────────────────────────────────────────────────────────
Deno.test("parsePriceOverrides keeps real prices and drops everything else", () => {
  const m = parsePriceOverrides([
    { rowKey: "building", amount: 2800 }, { rowKey: "loft", amount: "5.555" }, { rowKey: "neg", amount: -3 },
    { rowKey: "big", amount: 5e7 }, { rowKey: "", amount: 1 }, { rowKey: 4, amount: 1 }, { rowKey: "n", amount: null },
    { rowKey: "e", amount: "" }, { rowKey: "b", amount: true }, { rowKey: "x", amount: "abc" }, null, "junk",
    { rowKey: "k".repeat(301), amount: 1 },
  ]);
  assertEquals([...m.entries()], [["building", 2800], ["loft", 5.56], ["neg", 0], ["big", PRICE_OVERRIDE_MAX]]);
  assertEquals(parsePriceOverrides(undefined).size, 0);
  assertEquals(parsePriceOverrides({ building: 1 }).size, 0, "only the list shape the designer sends");
  assertEquals(parsePriceOverrides(Array.from({ length: 900 }, (_, i) => ({ rowKey: `k${i}`, amount: 1 }))).size, 500);
});

Deno.test("applyPriceOverrides replaces the unit, keeps the list, and skips what it must", () => {
  const building = { name: "Econo (10x12)", qty: 1, amount: 2900, description: "Original building price: $3000.00<br>Loft declined (−$100.00)" };
  const wall = { name: "Taller Walls (+6 in)", qty: 44, amount: 5, description: "44 ft of wall at $5.00 per foot" };
  const pct = { name: "Shelf", qty: 1, amount: 0, description: "" };
  const plain = { name: "Paint Colors", qty: 1, amount: 100, description: "Body: Barn Red, Trim: Barn Red" };
  const prov = new Map<any, any>([
    [building, { kind: "building", rowKey: "building" }],
    [wall, { kind: "wall_height", rowKey: "wallHeight" }],
    [pct, { kind: "layout_item", rowKey: "shelf" }],
    [plain, { kind: "paint" }],                                       // no rowKey: never re-priced
  ]);
  const n = applyPriceOverrides([building, wall, pct, plain], prov,
    new Map([["building", 2750], ["wallHeight", 6], ["shelf", 1], ["paint", 1]]), (l) => l === pct);
  assertEquals(n, 2);
  assertEquals([building.amount, prov.get(building).listAmount, building.description], [2750, 2900, ""]);
  assertEquals([wall.qty, wall.amount, prov.get(wall).listAmount, wall.description], [44, 6, 5, "44 ft of wall at $6.00 per foot"]);
  assertEquals([pct.amount, prov.get(pct).listAmount], [0, undefined]);
  assertEquals([plain.amount, prov.get(plain).listAmount], [100, undefined]);
  // An empty map touches nothing at all.
  assertEquals(applyPriceOverrides([wall], prov, new Map(), () => false), 0);
});

Deno.test("the formal estimate PDF prints the price charged and never the list it replaced", async () => {
  // The own-domain email path hands buildFormalEstimatePdf the snapshot's lines whole (`{ ...l }`),
  // listAmount included. It must read the named fields only. (quotePdf is held to the same rule
  // in salesTaxE2E_test.)
  const printed = await pdfText(await buildFormalEstimatePdf({
    business: { name: "Acme Sheds" },
    estimateNumber: "1001",
    lines: [
      { kind: "building", itemKey: "", name: "12x24 Lofted Barn", desc: "", qty: 1, amount: 10500, listAmount: 11200 },
      { kind: "layout_item", itemKey: "roughOpeningDoor", name: "RO-D1", desc: "4 x 7", qty: 1, amount: 275, listAmount: 150 },
    ] as any,
  }));
  assert(printed.includes("10,500.00") && printed.includes("275.00"), printed.slice(0, 400));
  for (const list of ["11,200", "150.00", "listAmount"]) assertFalse(printed.includes(list), list);
});
