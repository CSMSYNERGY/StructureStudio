// Electrical package maths, tested against the SHIPPED designer source.
//
// Why this one matters more than the others: the standard device counts are a PRICING INPUT on
// both sides. The browser nets them to decide what the customer is shown, and submit-estimate
// recomputes them to decide what the customer is billed. If the two ever disagree, the preview
// and the emailed quote disagree — silently, and only for buildings of certain sizes, which is
// the worst kind of pricing bug to find. Same lift-the-real-code technique as wallHeight_test.
//
// The server half is asserted by SHAPE (it is a 2,300-line HTTP handler with no unit harness),
// so what is pinned here is the arithmetic both sides implement.

import { assert, assertEquals } from "jsr:@std/assert";

const SRC = await Deno.readTextFile(
  new URL("../../../../structure-studio.component.js", import.meta.url),
);

const START = "const ELECTRICAL_DEVICES = [";
const END = "function electricalAutoItems(";
const i = SRC.indexOf(START);
const j = SRC.indexOf(END, i);
if (i < 0 || j < 0) {
  throw new Error(
    `electrical_test: could not find the electrical helpers (start=${i}, end=${j}). ` +
      "The anchors moved — re-point them rather than deleting this test.",
  );
}
const BLOCK = SRC.slice(i, j);
for (const name of ["electricalAutoCounts", "elecPerimeterPoint", "electricalOffered"]) {
  assert(BLOCK.includes(name), `extracted block is missing ${name}`);
}

const { electricalAutoCounts, elecPerimeterPoint, electricalOffered } = new Function(
  `${BLOCK}; return { electricalAutoCounts, elecPerimeterPoint, electricalOffered };`,
)() as {
  electricalAutoCounts: (cfg: unknown, w: number, l: number) => Record<string, number> | null;
  elecPerimeterPoint: (d: number, W: number, L: number) => { wall: string; xFt: number; yFt: number };
  electricalOffered: (C: unknown) => unknown;
};

// get_config's shape after 180. Note there is no rate here — per-device rates arrive through
// layoutPricing, which is already show_pricing gated.
const CFG = { label: "Electrical Package", price: 850, outletSpacingFt: 6, lightSpacingFt: 10, includePanel: true };

// THE RULE (Carolyn, 2026-09-02): "removing one doesn't discount it, extras charged per device."
const charge = (placed: number, auto: number, rate: number) => Math.max(0, placed - auto) * rate;

Deno.test("Carolyn's rule: removing a device never discounts the package", () => {
  const auto = electricalAutoCounts(CFG, 12, 24)!;
  assertEquals(auto.outlet, 12);
  // Delete four of the twelve and the package still costs exactly the package.
  assertEquals(charge(8, auto.outlet, 45), 0);
  assertEquals(charge(0, auto.outlet, 45), 0, "deleting every one of them still credits nothing");
  // Add three beyond the standard and only those three are charged.
  assertEquals(charge(15, auto.outlet, 45), 135);
});

Deno.test("deleting an auto device and adding a manual one costs nothing", () => {
  // This is the deliberate consequence of netting on COUNT rather than on which item carries
  // the auto marker: a customer who drags the layout around to suit themselves has not bought
  // anything extra, and should not be charged as if they had.
  const auto = electricalAutoCounts(CFG, 12, 24)!;
  assertEquals(charge(auto.outlet, auto.outlet, 45), 0);
});

Deno.test("outlets FLOOR around the perimeter, lights ROUND along the length", () => {
  // 12x24 -> perimeter 72 -> 72/6 = 12 exactly; length 24 / 10 = 2.4 -> 2.
  const a = electricalAutoCounts(CFG, 12, 24)!;
  assertEquals(a.outlet, 12);
  assertEquals(a.lightFixture, 2);
  assertEquals(a.lightSwitch, 1);
  // 10x14 -> perimeter 48 -> 48/6 = 8; 14/10 = 1.4 -> 1.
  const b = electricalAutoCounts(CFG, 10, 14)!;
  assertEquals(b.outlet, 8);
  assertEquals(b.lightFixture, 1);
  // A perimeter that is NOT a multiple of the spacing floors rather than rounding up: 10x13 ->
  // 46/6 = 7.67 -> 7. Ceil would hand out a free device on most buildings.
  assertEquals(electricalAutoCounts(CFG, 10, 13)!.outlet, 7);
  // 16/10 = 1.6 rounds UP to 2 — round, not floor, so a builder's own spacing is honoured.
  assertEquals(electricalAutoCounts(CFG, 10, 16)!.lightFixture, 2);
});

Deno.test("a bigger building gets more devices, never fewer", () => {
  let prev = 0;
  for (const l of [8, 12, 16, 20, 24, 32, 40]) {
    const n = electricalAutoCounts(CFG, 12, l)!.outlet;
    assert(n >= prev, `outlets went DOWN from ${prev} to ${n} at length ${l}`);
    prev = n;
  }
});

Deno.test("the builder's own spacing drives the count", () => {
  // Halve the spacing and a 12x24 gets twice the outlets — the standard is theirs, not ours.
  assertEquals(electricalAutoCounts({ ...CFG, outletSpacingFt: 3 }, 12, 24)!.outlet, 24);
  assertEquals(electricalAutoCounts({ ...CFG, outletSpacingFt: 12 }, 12, 24)!.outlet, 6);
  assertEquals(electricalAutoCounts({ ...CFG, lightSpacingFt: 6 }, 12, 24)!.lightFixture, 4);
});

Deno.test("a nonsense spacing falls back rather than dividing by zero", () => {
  // A zero or negative spacing would otherwise produce Infinity outlets and a browser that
  // never returns. get_config's CHECK constraints make this unreachable from the portal; this
  // guards the path a hand-edited row could still reach.
  for (const bad of [0, -6, null, undefined, "abc"]) {
    const n = electricalAutoCounts({ ...CFG, outletSpacingFt: bad }, 12, 24)!;
    assertEquals(n.outlet, 12, `spacing ${JSON.stringify(bad)} should fall back to 6 ft`);
    assert(Number.isFinite(n.outlet));
  }
});

Deno.test("no size yet means no counts — never a count of zero", () => {
  // Zero would read as "the package includes nothing", and every placed device would then be
  // charged on top of a package the customer has not been quoted a size for.
  assertEquals(electricalAutoCounts(CFG, 0, 24), null);
  assertEquals(electricalAutoCounts(CFG, 12, 0), null);
  assertEquals(electricalAutoCounts(null, 12, 24), null);
  // And every count is at least one, so the smallest building still gets a light and a switch.
  const tiny = electricalAutoCounts(CFG, 4, 4)!;
  assertEquals(tiny.lightFixture, 1);
  assertEquals(tiny.outlet, 2);
});

Deno.test("the perimeter walk visits all four walls in order and closes", () => {
  const W = 12, L = 24, per = 2 * (W + L);
  assertEquals(elecPerimeterPoint(0, W, L), { wall: "north", xFt: 0, yFt: 0 });
  assertEquals(elecPerimeterPoint(6, W, L).wall, "north");
  assertEquals(elecPerimeterPoint(12, W, L), { wall: "east", xFt: 12, yFt: 0 });
  assertEquals(elecPerimeterPoint(24, W, L).wall, "east");
  assertEquals(elecPerimeterPoint(36, W, L), { wall: "south", xFt: 12, yFt: 24 });
  assertEquals(elecPerimeterPoint(48, W, L), { wall: "west", xFt: 0, yFt: 24 });
  // Walking a full lap returns to the start, so the last device never lands past the corner.
  assertEquals(elecPerimeterPoint(per, W, L), elecPerimeterPoint(0, W, L));
  // Negative distances wrap rather than escaping the building.
  const back = elecPerimeterPoint(-6, W, L);
  assertEquals(back.wall, "west");
  assert(back.yFt >= 0 && back.yFt <= L);
});

Deno.test("every auto position lands ON the building's outline", () => {
  // A device off the outline would snap to the wrong wall, or outside the building entirely.
  const W = 10, L = 14, n = electricalAutoCounts(CFG, W, L)!.outlet, per = 2 * (W + L);
  for (let k = 0; k < n; k++) {
    const p = elecPerimeterPoint((k + 0.5) * (per / n), W, L);
    const onEdge = p.xFt === 0 || p.xFt === W || p.yFt === 0 || p.yFt === L;
    assert(onEdge, `outlet ${k} at (${p.xFt}, ${p.yFt}) is not on the outline`);
    assert(p.xFt >= 0 && p.xFt <= W && p.yFt >= 0 && p.yFt <= L, `outlet ${k} is outside the building`);
  }
});

Deno.test("the package is absent until the builder switches it on AND prices it", () => {
  // get_config emits null unless enabled and priced, so the browser never offers a package the
  // estimate would refuse. Ship-dark, the same contract as an unpriced size.
  assertEquals(electricalOffered({}), null);
  assertEquals(electricalOffered({ electrical: null }), null);
  assert(electricalOffered({ electrical: CFG }));
});

Deno.test("a hide-prices tenant still gets the package, just not the number", () => {
  // get_config nulls the price rather than dropping the offering (the colors[] idiom), so a
  // tenant who hides pricing can still sell electrical.
  const hidden = { electrical: { ...CFG, price: null } };
  const off = electricalOffered(hidden) as { price: number | null };
  assert(off, "the package must still be offered");
  assertEquals(off.price, null);
});

// ── The two implementations must not drift ───────────────────────────────────
// submit-estimate recomputes the standard counts itself (it must — the body sends only a
// boolean), so the arithmetic exists twice. Nothing else would notice them diverging: both
// sides would keep working, agreeing on most sizes and disagreeing on some, and the customer
// would see one number and be billed another. This reads the SERVER's formulas out of the
// shipped handler and checks they are the same three rules the browser just proved.
Deno.test("submit-estimate's auto counts match the designer's, formula for formula", async () => {
  const SERVER = await Deno.readTextFile(
    new URL("../../submit-estimate/index.ts", import.meta.url),
  );
  const m = /const autoCounts: Record<string, number> = \{([\s\S]*?)\};/.exec(SERVER);
  if (!m) {
    throw new Error(
      "electrical_test: could not find autoCounts in submit-estimate. If the resolver moved, " +
        "re-point this — do NOT delete it: it is the only thing holding the two copies together.",
    );
  }
  const body = m[1].replace(/\s+/g, " ");
  // The server measures the perimeter and the length with its own variable names, so compare
  // the RULES rather than the text: floor(perimeter / spacing), round(length / spacing), one.
  assert(
    /outlet:\s*Math\.max\(1,\s*Math\.floor\(buildingPerimeter\s*\/\s*outletSp\)\)/.test(body),
    `server outlet rule changed: ${body}`,
  );
  assert(
    /lightFixture:\s*Math\.max\(1,\s*Math\.round\(buildingDepthFt\s*\/\s*lightSp\)\)/.test(body),
    `server light rule changed: ${body}`,
  );
  assert(/lightSwitch:\s*1/.test(body), `server switch rule changed: ${body}`);

  // And prove they agree numerically on a spread of real sizes, using the server's own
  // perimeter definition (2*(W+L)) against the browser function lifted above.
  for (const [W, L] of [[8, 8], [10, 14], [12, 24], [14, 40], [12, 13], [10, 16]] as [number, number][]) {
    const browser = electricalAutoCounts(CFG, W, L)!;
    const server = {
      outlet: Math.max(1, Math.floor((2 * (W + L)) / CFG.outletSpacingFt)),
      lightFixture: Math.max(1, Math.round(L / CFG.lightSpacingFt)),
      lightSwitch: 1,
    };
    assertEquals(browser, server, `disagreement at ${W}x${L}`);
  }
});

Deno.test("the server refuses a package the tenant has not switched on or priced", () => {
  // Shape assertion: both refusals must stay, and stay as hard 400s. A stale tab holding an
  // offer the builder has since withdrawn must not be able to bill for it.
  const SERVER = Deno.readTextFileSync(
    new URL("../../submit-estimate/index.ts", import.meta.url),
  );
  assert(/electrical_settings/.test(SERVER), "the server must read the tenant's own settings");
  assert(
    /es\.enabled !== true[\s\S]{0,400}?\}, 400\)/.test(SERVER),
    "a disabled electrical package must be refused with a 400",
  );
  assert(
    /es\.package_price == null[\s\S]{0,400}?\}, 400\)/.test(SERVER),
    "an unpriced electrical package must be refused with a 400",
  );
  // The counts must never be read off the request body.
  assert(
    !/selections\??\.\s*electricalDevices|selections\??\.\s*autoCounts/.test(SERVER),
    "the standard counts must be recomputed server-side, never taken from the body",
  );
});

// ── The builder's own electrical items, and the TWO prices (migration 181) ───
// Carolyn: "there should be 2 pricing options. One is for this additional item to be added TO
// the existing package and the other is that there is no package and they are selling this
// item individually." The rule that needs holding down is that a NULL in one column means NOT
// OFFERED THAT WAY — never a fallback to the other number, which would charge a price the
// builder never set.
const IT_START = "function elecItemsOffered(";
const IT_END = "function ElectricalItemPicker(";
const ii = SRC.indexOf(IT_START), ij = SRC.indexOf(IT_END, ii);
if (ii < 0 || ij < 0) {
  throw new Error(`electrical_test: could not find the item helpers (${ii}, ${ij}). Re-point, don't delete.`);
}
const { elecItemsOffered, elecItemPrice } = new Function(
  `${SRC.slice(ii, ij)}; return { elecItemsOffered, elecItemPrice };`,
)() as {
  elecItemsOffered: (C: unknown, hasPackage: boolean, includeInternal?: boolean) => { id: string }[];
  elecItemPrice: (it: unknown, hasPackage: boolean) => number | null;
};

const BOTH = { id: "fan", name: "Ceiling Fan", mount: "ceiling", withPackage: true, standalone: true, priceWithPackage: 285, priceStandalone: 395 };
const PKG_ONLY = { id: "brk", name: "Extra Breaker", mount: "wall", withPackage: true, standalone: false, priceWithPackage: 45, priceStandalone: null };
const ALONE_ONLY = { id: "svc", name: "Service Call", mount: "wall", withPackage: false, standalone: true, priceWithPackage: null, priceStandalone: 120 };
const ITEMS_C = { electricalItems: [BOTH, PKG_ONLY, ALONE_ONLY] };

Deno.test("the package decides WHICH of the two prices applies", () => {
  assertEquals(elecItemPrice(BOTH, true), 285, "with the package, the add-on price");
  assertEquals(elecItemPrice(BOTH, false), 395, "without it, the standalone price");
  // The add-on price being lower is the whole reason there are two: an electrician is already
  // on site. Nothing enforces that ordering, but the two must not be the same number by accident.
  assert(elecItemPrice(BOTH, true)! < elecItemPrice(BOTH, false)!);
});

Deno.test("a blank price means NOT OFFERED that way, and never falls back", () => {
  // The failure this prevents: quietly charging the standalone price for a package add-on the
  // builder only ever priced one way.
  assertEquals(elecItemPrice(PKG_ONLY, false), null);
  assertEquals(elecItemPrice(ALONE_ONLY, true), null);
  assertEquals(elecItemPrice(PKG_ONLY, true), 45);
  assertEquals(elecItemPrice(ALONE_ONLY, false), 120);
});

Deno.test("the offered list changes with the package, in both directions", () => {
  const withPkg = elecItemsOffered(ITEMS_C, true).map((i) => i.id);
  const without = elecItemsOffered(ITEMS_C, false).map((i) => i.id);
  assertEquals(withPkg, ["fan", "brk"], "a standalone-only item disappears once the package is taken");
  assertEquals(without, ["fan", "svc"], "a package-only item is not offered on its own");
});

Deno.test("a hide-prices tenant still gets the items, just not the numbers", () => {
  // get_config nulls the PRICES but always emits withPackage/standalone as their own booleans,
  // precisely so "no price" cannot be mistaken for "not offered". Without that split, every
  // item would vanish for a tenant who hides pricing.
  const hidden = { electricalItems: [{ ...BOTH, priceWithPackage: null, priceStandalone: null }] };
  assertEquals(elecItemsOffered(hidden, true).length, 1);
  assertEquals(elecItemsOffered(hidden, false).length, 1);
  assertEquals(elecItemPrice(hidden.electricalItems[0], true), null);
});

Deno.test("internal-only items are hidden from the customer, shown to the rep", () => {
  const C2 = { electricalItems: [BOTH, { ...PKG_ONLY, internalOnly: true }] };
  assertEquals(elecItemsOffered(C2, true).map((i) => i.id), ["fan"]);
  assertEquals(elecItemsOffered(C2, true, true).map((i) => i.id), ["fan", "brk"]);
});

Deno.test("no catalog at all is empty, not a crash", () => {
  assertEquals(elecItemsOffered({}, true), []);
  assertEquals(elecItemsOffered({ electricalItems: null }, false), []);
  assertEquals(elecItemPrice(null, true), null);
});

Deno.test("the server prices items itself and refuses an unoffered mode", () => {
  const SERVER = Deno.readTextFileSync(new URL("../../submit-estimate/index.ts", import.meta.url));
  assert(/from\("electrical_items"\)/.test(SERVER), "the server must read the catalog itself");
  // The price must come from the ROW, never from the request body.
  assert(
    /const price = hasPkg \? ei\.price_with_package : ei\.price_standalone/.test(SERVER),
    "the server must pick the column from the package state",
  );
  assert(
    /if \(price == null\)[\s\S]{0,600}?\}, 400\)/.test(SERVER),
    "an item with no price in the current mode must be refused, not silently re-priced",
  );
  // And there must be no fallback between the two columns anywhere.
  assert(
    !/price_with_package\s*\?\?\s*.*price_standalone|price_standalone\s*\?\?\s*.*price_with_package/.test(SERVER),
    "the two prices must never fall back to one another",
  );
});
