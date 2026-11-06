import { assertEquals } from "jsr:@std/assert@1";
import { genShortCode, includedLines, purchaseSentence, purchaseSnapshot } from "./shopPurchase.ts";
import { orderCentsFromSnapshot, totalFromSnapshot } from "./estimateLines.ts";

Deno.test("genShortCode matches the design code shape", () => {
  for (let i = 0; i < 50; i++) assertEquals(/^SS-[A-HJ-NP-Z2-9]{10}$/.test(genShortCode()), true);
});

Deno.test("included lines group identical items and skip notes, lines and props", () => {
  const rows = includedLines([
    { type: "window", windowName: "Slider Window", widthIn: 48, heightIn: 36, colorLabel: "White" },
    { type: "window", windowName: "Slider Window", widthIn: 48, heightIn: 36, colorLabel: "White" },
    { type: "loft", widthFt: 12 }, { type: "textNote" }, { type: "prop" }, { type: "line" },
  ], { layout: { loft: "Storage loft" }, electrical: {} });
  assertEquals(rows, [
    { name: "Slider Window", desc: '48" x 36" · White', qty: 2 },
    { name: "Storage loft", desc: "12 ft", qty: 1 },
  ]);
});

Deno.test("the purchase snapshot totals to exactly what the shopper was shown", () => {
  // #4523 on beta: $10,392 + $148 delivery (not taxed) + 7.25% on the building = $11,293.42
  const snap = purchaseSnapshot({
    buildingName: "Lofted Barn (12x28)", serial: 4523, lotName: "MO Builder", priceCents: 1039200,
    included: [{ name: "Double Barn Door", desc: "", qty: 1 }], options: [{ name: "Siding", desc: "Lap" }],
    deliveryCents: 14800, deliveryNote: "24 miles", deliveryTaxable: false,
    tax: { rate: 0.0725, amountCents: 75342, label: "Sales tax", basis: "company", locationId: null },
  });
  assertEquals(totalFromSnapshot(snap), 11293.42);
  assertEquals(orderCentsFromSnapshot(snap), { totalCents: 1129342, pretaxCents: 1054000, taxCents: 75342 });
});

Deno.test("no tax rate on file: a pre-tax snapshot, total = price + delivery", () => {
  const snap = purchaseSnapshot({
    buildingName: "Cabin", serial: 1, lotName: null, priceCents: 500000, included: [], options: [],
    deliveryCents: 0, deliveryNote: null, deliveryTaxable: true, tax: null,
  });
  assertEquals(totalFromSnapshot(snap), 5000);
});

Deno.test("the purchase sentence names the money and promises an invoice to sign — no signature now", () => {
  const s = purchaseSentence({ business: "Acme Barns", labels: ["#4523 12x28 Lofted Barn"], totalCents: 1129342, dueNowCents: 112934, payInFull: false });
  assertEquals(s, "I am buying #4523 12x28 Lofted Barn from Acme Barns for $11,293.42, paying a $1,129.34 deposit today. I understand Acme Barns will send me an invoice to sign.");
});
