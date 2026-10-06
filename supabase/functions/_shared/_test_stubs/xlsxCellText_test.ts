// xlsxCellText (portal/03-catalog.jsx), lifted from the SHIPPED source: every spreadsheet import
// in the portal (pricing sheet, fixture catalogs, Real-Time Pricing workbook) reads cells
// through it, and each of them gives a BLANK cell a meaning — "not priced" (the size is hidden),
// "no price" (the fixture is dropped from the designer), "$0". An Excel error cell must
// therefore never read as blank.

import { assertEquals } from "jsr:@std/assert";

const src = (await Deno.readTextFile(new URL("../../../../portal/03-catalog.jsx", import.meta.url))).replace(/\r\n/g, "\n");
const i = src.indexOf("function xlsxCellText(v) {");
const j = i < 0 ? -1 : src.indexOf("\n}\n", i);
if (i < 0 || j < 0) throw new Error("xlsxCellText_test: xlsxCellText not found in portal/03-catalog.jsx — re-point the anchor rather than deleting this test.");
const xlsxCellText = new Function(`${src.slice(i, j + 2)}; return xlsxCellText;`)() as (v: unknown) => string;

Deno.test("an Excel error value reads as its code, not as a blank cell", () => {
  assertEquals(xlsxCellText({ error: "#REF!" }), "#REF!");
  assertEquals(xlsxCellText({ formula: "B2/C2", result: { error: "#DIV/0!" } }), "#DIV/0!");
});

Deno.test("the ordinary cell shapes are unchanged", () => {
  assertEquals(xlsxCellText(null), "");
  assertEquals(xlsxCellText(4995), "4995");
  assertEquals(xlsxCellText("Lofted Barn"), "Lofted Barn");
  assertEquals(xlsxCellText({ formula: "A1*1.1", result: 5494.5 }), "5494.5");
  assertEquals(xlsxCellText({ formula: "A1*0", result: 0 }), "0");
  assertEquals(xlsxCellText({ richText: [{ text: "Lofted " }, { text: "Barn" }] }), "Lofted Barn");
  assertEquals(xlsxCellText({ text: "site", hyperlink: "https://x" }), "site");
  const d = new Date(Date.UTC(2026, 0, 2));
  assertEquals(xlsxCellText({ formula: "TODAY()", result: d }), String(d));
});
