// ssDeliveryView, tested against the SHIPPED designer source.
//
// Delivery moved up into the designer's Services tab on 2026-09-16 (Carolyn: "services are delivery
// and foundation"), so two places now show what delivery costs: Services › Delivery and the Details
// subtotal. Both read this one function, and it carries submit-estimate's precedence: a fee the rep
// typed wins; else the builder's automatic rule once delivery-quote has priced the address; else
// nothing. A drift here would show a customer one delivery figure and charge them another.
//
// Lifted from the source rather than copied, so a drift fails the push. Same technique as
// tabClamp_test / wallSlab_test.

import { assert, assertEquals } from "jsr:@std/assert";

const SRC = await Deno.readTextFile(new URL("../../../../structure-studio.component.js", import.meta.url));
const START = "function ssDeliveryView(";
const END = "// Which price applies is decided by ONE thing";
const i = SRC.indexOf(START);
const j = SRC.indexOf(END, i);
if (i < 0 || j < 0) {
  throw new Error(`deliveryView_test: anchors moved (start=${i}, end=${j}). Re-point them rather than deleting this test.`);
}
type View = { manual: boolean; auto: unknown; pending: unknown; suggest: number | null; amount: number };
const ssDeliveryView = new Function(`${SRC.slice(i, j)}; return ssDeliveryView;`)() as (
  C: unknown,
  sel: unknown,
  quote: unknown,
  embedded: boolean,
) => View;

const AUTO = { delivery: { automate: true, configured: true } };
const MANUAL_ONLY = { delivery: { automate: false, configured: true } };
const priced = { ok: true, ready: true, autoPriced: true, fee: 150, miles: 12, desc: "12 mi" };
const unpriced = { ok: true, ready: true, autoPriced: false, reason: "beyond_last_band" };

Deno.test("automated, priced: the rule's fee is the amount; a rep is offered it as a suggestion", () => {
  const v = ssDeliveryView(AUTO, { deliveryFee: "" }, priced, false);
  assertEquals([v.manual, v.auto === priced, v.pending, v.amount, v.suggest], [false, true, null, 150, null]);
  assertEquals(ssDeliveryView(AUTO, {}, priced, true).suggest, 150);
});

Deno.test("a typed fee wins over the rule, and blank is not a fee", () => {
  const v = ssDeliveryView(AUTO, { deliveryFee: "75.50" }, priced, true);
  assertEquals([v.manual, v.auto, v.pending, v.amount], [true, null, null, 75.5]);
  assertEquals(ssDeliveryView(AUTO, { deliveryFee: "" }, null, true).manual, false);
});

Deno.test("an address the rule could not price is pending with no amount", () => {
  const v = ssDeliveryView(AUTO, {}, unpriced, false);
  assert(v.pending === unpriced);
  assertEquals([v.auto, v.amount], [null, 0]);
});

Deno.test("not automated: no automatic figure, even with a priced answer in hand", () => {
  const v = ssDeliveryView(MANUAL_ONLY, {}, priced, false);
  assertEquals([v.auto, v.pending, v.amount], [null, null, 0]);
  assertEquals(ssDeliveryView(null, null, null, false), { manual: false, auto: null, pending: null, suggest: null, amount: 0 });
});
