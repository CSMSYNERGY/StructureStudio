// Wall-height upgrade pricing, tested against the SHIPPED designer source.
//
// Same technique and the same reason as wallSlab_test: the browser's preview and the server's
// estimate line must agree to the penny, and a copied-out copy of the rule would keep passing
// while the real file drifted. Here that matters more than usual — this is the first SELECTION
// charge (nothing is placed on the plan), so it sits outside the pushItem machinery that every
// other priced thing shares, and there is no existing test that would notice it going wrong.
//
// The server half (submit-estimate) is asserted by shape rather than by execution: it is a
// 2,200-line HTTP handler with no unit-test harness, so what is pinned here is the arithmetic
// and the resolution rule the two sides share.

import { assert, assertEquals, assertFalse } from "jsr:@std/assert";

const SRC = await Deno.readTextFile(
  new URL("../../../../structure-studio.component.js", import.meta.url),
);

const START = "function wallHeightOptionsFor(C, styleKey) {";
const END = "function computeSelectionRows(";
const i = SRC.indexOf(START);
const j = SRC.indexOf(END, i);
if (i < 0 || j < 0) {
  throw new Error(
    `wallHeight_test: could not find the wall-height helpers in the designer source (start=${i}, end=${j}). ` +
      "The anchors moved — re-point them rather than deleting this test.",
  );
}
const BLOCK = SRC.slice(i, j);
for (const name of ["wallHeightOptionsFor", "resolveWallHeight"]) {
  assert(BLOCK.includes(name), `extracted block is missing ${name}`);
}

const { wallHeightOptionsFor, resolveWallHeight } = new Function(
  `${BLOCK}; return { wallHeightOptionsFor, resolveWallHeight };`,
)() as {
  wallHeightOptionsFor: (C: unknown, k: string) => { deltaIn: number; ratePerLf: number | null }[];
  resolveWallHeight: (C: unknown, k: string, d: unknown) => { deltaIn: number; ratePerLf: number | null } | null;
};

// get_config's shape after migration 172: keyed by style, offered heights only.
const C = {
  showPricing: true,
  wallHeightOptions: {
    lofted: [{ deltaIn: 6, ratePerLf: 2 }, { deltaIn: 12, ratePerLf: 8 }],
    utility: [],
  },
};

// The rule both sides implement: rate x perimeter. 12x24 => 72 lineal feet.
const perimeter = (w: number, l: number) => 2 * (w + l);
const priceOf = (rate: number, w: number, l: number) => Math.round(rate * perimeter(w, l) * 100) / 100;

Deno.test("Carolyn's example prices exactly", () => {
  assertEquals(perimeter(12, 24), 72);
  assertEquals(priceOf(2, 12, 24), 144);   // +6in at $2/lf
  assertEquals(priceOf(8, 12, 24), 576);   // +12in at $8/lf
});

Deno.test("a style offers only its own heights", () => {
  assertEquals(wallHeightOptionsFor(C, "lofted").length, 2);
  assertEquals(wallHeightOptionsFor(C, "utility").length, 0);
  // A style absent from the map offers nothing rather than throwing — most styles have none.
  assertEquals(wallHeightOptionsFor(C, "no-such-style").length, 0);
  assertEquals(wallHeightOptionsFor({}, "lofted").length, 0);
});

Deno.test("an increase this style does not offer resolves to nothing", () => {
  // The browser must price NOTHING here, because the server answers the same case with a hard
  // 400. A preview that charged for something the estimate then refuses is the bad outcome.
  assertEquals(resolveWallHeight(C, "lofted", 9), null);
  assertEquals(resolveWallHeight(C, "utility", 6), null);
  assertEquals(resolveWallHeight(C, "lofted", 6)?.ratePerLf, 2);
});

Deno.test("standard means no charge", () => {
  for (const v of [0, null, undefined, "", "0"]) {
    assertEquals(resolveWallHeight(C, "lofted", v), null, `standard should not price for ${JSON.stringify(v)}`);
  }
});

Deno.test("a hidden-price tenant still gets the CHOICE, just not the number", () => {
  // get_config nulls ratePerLf when show_pricing is off (the colors[] idiom) rather than
  // dropping the option — otherwise a tenant who hides prices could not sell taller walls.
  const hidden = { wallHeightOptions: { lofted: [{ deltaIn: 6, ratePerLf: null }] } };
  const opt = resolveWallHeight(hidden, "lofted", 6);
  assert(opt, "the height must still be offered");
  assertEquals(opt?.ratePerLf, null);
  assertEquals(Number(opt?.ratePerLf) || 0, 0); // and prices at nothing in the preview
});

Deno.test("the delta is inches and the price scales with the building, not the height", () => {
  // Guards the units. A 6in increase on a bigger building costs MORE because there is more
  // wall, not because the increase changed — reading delta_in as feet would 12x every quote.
  assertEquals(priceOf(2, 10, 12), 88);    // 44 lf
  assertEquals(priceOf(2, 12, 24), 144);   // 72 lf
  assert(priceOf(2, 12, 24) > priceOf(2, 10, 12));
});

Deno.test("legacy 3D absolute pick is not a delta and prices nothing", () => {
  // Pre-172 designs carry sel.wallHeight (absolute feet, e.g. 9) and no delta. Those must keep
  // costing nothing: they were never priced, and silently charging for them would re-price
  // every saved design the moment this shipped.
  const legacySel = { wallHeight: 9 };
  assertEquals(resolveWallHeight(C, "lofted", (legacySel as { wallHeightDeltaIn?: number }).wallHeightDeltaIn), null);
  assertFalse(!!resolveWallHeight(C, "lofted", undefined));
});
