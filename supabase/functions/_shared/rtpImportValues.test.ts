// The Real-Time Pricing workbook's numbers, as they arrive from the browser: rtpNum's NaN has
// already been through JSON.stringify, so it is null on the wire.
// Run: deno test supabase/functions/_shared/rtpImportValues.test.ts
import { assert, assertEquals } from "jsr:@std/assert@1";
import { rtpImportNumber, rtpImportOverhead } from "./rtpImportValues.ts";

/** What the server receives for a cell the browser parsed with rtpNum. */
const wire = (n: number) => JSON.parse(JSON.stringify({ v: n })).v;

Deno.test("a cell the browser could not parse is NOT a number on the server (it used to be $0)", () => {
  const tbd = wire(Number("TBD"));
  assertEquals(tbd, null);
  assertEquals(Number(tbd), 0, "the old server read it as a valid zero");
  assert(Number.isNaN(rtpImportNumber(tbd)));
  assert(Number.isNaN(rtpImportNumber(undefined)));
  assert(Number.isNaN(rtpImportNumber("  ")));
  assertEquals(rtpImportNumber(12.5), 12.5);
  assertEquals(rtpImportNumber("12.5"), 12.5);
  assertEquals(rtpImportNumber(0), 0);
});

Deno.test("a non-numeric multiplier is refused, never applied as ×0", () => {
  const { rows, invalid } = rtpImportOverhead([
    { label: "Material markup", kind: "multiplier", value: wire(Number("x1.8")) },
    { label: "Delivery", kind: "flat", value: 150 },
  ]);
  assertEquals(invalid.length, 1);
  assert(/Material markup/.test(invalid[0]));
  assertEquals(rows.map((r) => r.label), ["Delivery"], "the caller must not apply a sheet with an invalid line");
});

Deno.test("a ×0 multiplier (a blank cell) is refused; flat and percent zero are fine", () => {
  const { rows, invalid } = rtpImportOverhead([
    { label: "Markup", kind: "multiplier", value: 0 },
    { label: "Fee", kind: "flat", value: 0 },
    { label: "Sales", kind: "percent_of_price", value: 0 },
  ]);
  assertEquals(invalid.length, 1);
  assert(/×0 multiplier/.test(invalid[0]));
  assertEquals(rows.map((r) => r.kind), ["flat", "percent_of_price"]);
});

Deno.test("a clean sheet keeps its order (the order IS the formula)", () => {
  const { rows, invalid } = rtpImportOverhead([
    { label: "Markup", kind: "multiplier", value: 1.8 },
    { label: "Overhead", kind: "multiplier", value: 1.1 },
    { label: "Sales", kind: "percent_of_price", value: 10 },
  ]);
  assertEquals(invalid, []);
  assertEquals(rows.map((r) => [r.label, r.value, r.sort_order]), [["Markup", 1.8, 0], ["Overhead", 1.1, 1], ["Sales", 10, 2]]);
});
