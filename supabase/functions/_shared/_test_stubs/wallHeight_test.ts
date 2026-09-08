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

// Widened 2026-09-02 to take in d3BaseWallHeightFt / d3WallHeightFromDelta as well: the 3D
// footer now turns a delta back into an absolute height with those, so they have to agree with
// the spec resolver or the viewer renders a height the estimate never priced.
const START = "function d3BaseWallHeightFt(C, styleCfg) {";
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
for (const name of ["wallHeightFitsWidth", "wallHeightOptionsFor", "resolveWallHeight", "d3BaseWallHeightFt", "d3WallHeightFromDelta", "d3CustomerWallHeightFt"]) {
  assert(BLOCK.includes(name), `extracted block is missing ${name}`);
}

const { wallHeightOptionsFor, resolveWallHeight, d3BaseWallHeightFt, d3WallHeightFromDelta, d3CustomerWallHeightFt } = new Function(
  `${BLOCK}; return { wallHeightFitsWidth, wallHeightOptionsFor, resolveWallHeight, d3BaseWallHeightFt, d3WallHeightFromDelta, d3CustomerWallHeightFt };`,
)() as {
  d3BaseWallHeightFt: (C: unknown, styleCfg: unknown) => number;
  d3WallHeightFromDelta: (baseFt: unknown, deltaIn: unknown) => number;
  // deno-lint-ignore no-explicit-any
  d3CustomerWallHeightFt: (C: unknown, styleCfg: any, styleKey: string, sel: any, widthFt?: number) => number;
  wallHeightOptionsFor: (C: unknown, k: string, w?: number, includeInternal?: boolean) => { deltaIn: number; ratePerLf: number | null }[];
  resolveWallHeight: (C: unknown, k: string, d: unknown, w?: number) => { deltaIn: number; ratePerLf: number | null } | null;
};

// get_config's shape after migration 172: keyed by style, offered heights only.
const C = {
  showPricing: true,
  wallHeightOptions: {
    // +12in is hauled only on the narrow widths; +6in carries no widthsFt at all, which means
    // EVERY width and keeps meaning that when a new width is added to the style later.
    lofted: [{ deltaIn: 6, ratePerLf: 2 }, { deltaIn: 12, ratePerLf: 8, widthsFt: [8, 10] }],
    utility: [],
    // An increase a REP can sell but a shopper never sees.
    econo: [{ deltaIn: 6, ratePerLf: 5, internalOnly: true }, { deltaIn: 12, ratePerLf: 9 }],
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

Deno.test("an increase is only offered on the widths it can be hauled at", () => {
  // Carolyn 2026-09-01: "you can increase the wall height more on an 8 wide than a 16 wide and
  // still remain in the height range for hauling." Total haul height is wall + roof, and the
  // roof grows with width.
  assertEquals(wallHeightOptionsFor(C, "lofted", 8).map((o) => o.deltaIn), [6, 12]);
  assertEquals(wallHeightOptionsFor(C, "lofted", 10).map((o) => o.deltaIn), [6, 12]);
  assertEquals(wallHeightOptionsFor(C, "lofted", 12).map((o) => o.deltaIn), [6]);
  assertEquals(wallHeightOptionsFor(C, "lofted", 14).map((o) => o.deltaIn), [6]);
});

Deno.test("a pick that no longer fits the building prices nothing", () => {
  // The customer picked +12in on an 8 wide, then switched to a 14 wide. The browser drops it and
  // says so; this pins that it also stops PRICING, so a stale pick can never ride into a quote.
  assertEquals(resolveWallHeight(C, "lofted", 12, 8)?.ratePerLf, 8);
  assertEquals(resolveWallHeight(C, "lofted", 12, 14), null);
  assertEquals(resolveWallHeight(C, "lofted", 6, 14)?.ratePerLf, 2, "an unrestricted increase still fits");
});

Deno.test("absent widthsFt is a LIVING default, not a snapshot", () => {
  // +6in lists no widths, so a width the builder adds to the style tomorrow is offered
  // automatically. Storing the width list eagerly would silently drop new sizes instead.
  for (const w of [8, 10, 12, 14, 16, 20]) {
    assert(resolveWallHeight(C, "lofted", 6, w), `+6in should be offered at ${w} ft`);
  }
});

Deno.test("omitting the width asks what the style offers AT ALL", () => {
  // The portal editor and the estimate-side lookup both want the full list, not a filtered one.
  assertEquals(wallHeightOptionsFor(C, "lofted").length, 2);
  assertEquals(resolveWallHeight(C, "lofted", 12)?.ratePerLf, 8);
});

Deno.test("internal-only increases are hidden from the customer, shown to the rep", () => {
  // Matches client_layout_items.internal_only exactly: offered in the REP designer (embedded),
  // hidden on the customer-facing page. The customer-facing call passes no includeInternal.
  assertEquals(wallHeightOptionsFor(C, "econo", 8).map((o) => o.deltaIn), [12]);
  assertEquals(wallHeightOptionsFor(C, "econo", 8, true).map((o) => o.deltaIn), [6, 12]);
});

Deno.test("an internal-only increase a rep chose STILL PRICES", () => {
  // Visibility only. resolveWallHeight deliberately does not filter on internalOnly, the same
  // way an already-placed internal-only layout item keeps its price — otherwise a rep could
  // select one, see a total, and have the estimate silently drop the charge.
  assertEquals(resolveWallHeight(C, "econo", 6, 8)?.ratePerLf, 5);
});


// ── The 3D footer and the 2D picker must be ONE control (2026-09-02) ──────────────────
// The footer used to be a fixed 6/7/8/9/10 ft writing sel.wallHeight — the UNPRICED legacy
// field — while clearing sel.wallHeightDeltaIn. Harmless until a builder configured increases.
// Carolyn did, on junior-barns (Econo +6in at $5/lf), and the hole became real: pick the paid
// upgrade in the designer, open 3D, touch that row, and the charge is silently zeroed while the
// building stays tall. Nothing errors. The footer now commits the same delta, and these pin the
// arithmetic both sides share — a viewer rendering a height the estimate did not price is the
// failure nobody sees until a quote goes out wrong.

const STYLE_8FT = { d3: { wallHeightFt: 8 } };

Deno.test("the footer's arithmetic IS the spec resolver's, to the inch", () => {
  // Same delta, two code paths, one answer. Diverge and the 3D shows one building while the
  // estimate prices another.
  for (const d of [6, 12]) {
    const viaFooter = d3WallHeightFromDelta(d3BaseWallHeightFt(C, STYLE_8FT), d);
    const viaResolver = d3CustomerWallHeightFt(C, STYLE_8FT, "lofted", { wallHeightDeltaIn: d }, 8);
    assertEquals(viaFooter, viaResolver, `+${d}in`);
  }
});

Deno.test("+6in on an 8 ft style is 8.5 ft, not a rounded 9", () => {
  assertEquals(d3WallHeightFromDelta(8, 6), 8.5);
  assertEquals(d3WallHeightFromDelta(8, 12), 9);
  assertEquals(d3WallHeightFromDelta(8, 0), 8, "Standard is the base, untouched");
});

Deno.test("the base walks the same fallback chain the spec resolver walks", () => {
  assertEquals(d3BaseWallHeightFt(C, { d3: { wallHeightFt: 7 } }), 7, "the style's own 3D spec wins");
  assertEquals(d3BaseWallHeightFt(C, { wallHeightFt: 9 }), 9, "then the style's top-level height");
  assertEquals(d3BaseWallHeightFt({ wallHeightFt: 10 }, {}), 10, "then the tenant default");
  assertEquals(d3BaseWallHeightFt({}, {}), 8, "then 8 ft");
  assertEquals(d3BaseWallHeightFt({}, null), 8, "a missing style is not a crash");
});

Deno.test("the clamp matches styleD3's column range, so the 3D cannot leave it", () => {
  assertEquals(d3WallHeightFromDelta(14, 12), 14, "clamped at the top");
  assertEquals(d3WallHeightFromDelta(4, 0), 5, "clamped at the bottom");
});

Deno.test("an increase that does not FIT the width prices nothing, and is not offered", () => {
  // +12in is hauled only on 8 and 10 wide. On a 12 wide the resolver refuses AND the footer
  // never lists it — the two agreeing is what stops a 3D preview of an unbillable choice.
  assertEquals(d3CustomerWallHeightFt(C, STYLE_8FT, "lofted", { wallHeightDeltaIn: 12 }, 12), 0);
  assertFalse(wallHeightOptionsFor(C, "lofted", 12).some((o) => Number(o.deltaIn) === 12));
});

Deno.test("a LEGACY absolute height still renders, and is not mistaken for a delta", () => {
  // Designs saved before the increases carry only sel.wallHeight and must keep rendering at the
  // height they were saved at — which is why the footer highlights nothing for them rather than
  // claiming "Standard".
  assertEquals(d3CustomerWallHeightFt(C, STYLE_8FT, "lofted", { wallHeight: 10 }, 12), 10);
  assertEquals(d3CustomerWallHeightFt(C, STYLE_8FT, "lofted", {}, 12), 0, "no pick at all is no override");
});

Deno.test("a delta BEATS a stale legacy absolute on the same design", () => {
  // Committing a delta clears sel.wallHeight, but a design mid-migration can carry both. The
  // PRICED field has to win, or the customer is charged for one height and shown another.
  assertEquals(d3CustomerWallHeightFt(C, STYLE_8FT, "lofted", { wallHeightDeltaIn: 6, wallHeight: 10 }, 8), 8.5);
});
