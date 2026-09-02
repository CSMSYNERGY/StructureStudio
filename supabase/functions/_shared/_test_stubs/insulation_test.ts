// Insulation area maths, tested against the SHIPPED designer source.
//
// The browser previews the square footage and the server re-derives it to bill. Those two must
// agree, and nothing else would notice if they stopped: insulation is a SELECTION charge, so it
// sits outside the pushItem machinery every placed item shares. Same lift-the-real-code
// technique as wallSlab_test and wallHeight_test.

import { assert, assertEquals } from "jsr:@std/assert";

const SRC = await Deno.readTextFile(
  new URL("../../../../structure-studio.component.js", import.meta.url),
);

const START = "const INSULATION_AREAS = [";
const END = "function wallHeightFitsWidth(";
const i = SRC.indexOf(START);
const j = SRC.indexOf(END, i);
if (i < 0 || j < 0) {
  throw new Error(
    `insulation_test: could not find the insulation helpers (start=${i}, end=${j}). ` +
      "The anchors moved — re-point them rather than deleting this test.",
  );
}
const BLOCK = SRC.slice(i, j);
for (const name of ["insulationSqft", "insulationOffered", "insulationTypes", "insulationAreasFor"]) {
  assert(BLOCK.includes(name), `extracted block is missing ${name}`);
}

const { insulationSqft, insulationTypes, insulationAreasFor } = new Function(
  `${BLOCK}; return { insulationSqft, insulationOffered, insulationTypes, insulationAreasFor };`,
)() as {
  insulationSqft: (area: string, w: number, l: number, h: number) => number;
  insulationTypes: (C: unknown) => string[];
  insulationAreasFor: (C: unknown, t: string) => string[];
};

// get_config's shape after 177: offered combinations only, and NO rate — Carolyn chose no
// price in the designer, so there is nothing to gate on show_pricing and nothing to forge.
const C = {
  insulation: [
    { type: "batt", area: "floor" }, { type: "batt", area: "walls" }, { type: "batt", area: "roof" },
    { type: "spray_foam", area: "floor" }, { type: "spray_foam", area: "walls" },
    // spray foam ROOF is deliberately absent — the builder left that rate blank.
  ],
};

// The server's own rule, transcribed from submit-estimate. If these two ever disagree the
// preview and the emailed quote disagree, which is the failure this file exists to catch.
const serverSqft = (area: string, w: number, l: number, h: number) =>
  area === "walls" ? Math.round(2 * (w + l) * h) : Math.round(w * l);

Deno.test("floor and roof are the footprint; walls are perimeter x height", () => {
  // A 12x24 at the standard 8 ft wall.
  assertEquals(insulationSqft("floor", 12, 24, 8), 288);
  assertEquals(insulationSqft("roof", 12, 24, 8), 288);
  assertEquals(insulationSqft("walls", 12, 24, 8), 576);   // 72 lf x 8 ft
});

Deno.test("the browser and the server compute the SAME square footage", () => {
  for (const [w, l, h] of [[12, 24, 8], [10, 12, 8], [8, 16, 9.5], [14, 40, 8]]) {
    for (const area of ["floor", "walls", "roof"]) {
      assertEquals(
        insulationSqft(area, w, l, h), serverSqft(area, w, l, h),
        `${area} on ${w}x${l} at ${h} ft must match the server`,
      );
    }
  }
});

Deno.test("a taller wall grows the WALL area and nothing else", () => {
  // This is why insulation waited for taller walls: +12in takes the wall from 8 ft to 9.
  const flat = insulationSqft("walls", 12, 24, 8);
  const taller = insulationSqft("walls", 12, 24, 9);
  assertEquals(flat, 576);
  assertEquals(taller, 648);
  assert(taller > flat);
  // Floor and roof are unaffected by wall height — a bug here would bill the roof for the upgrade.
  assertEquals(insulationSqft("floor", 12, 24, 9), insulationSqft("floor", 12, 24, 8));
  assertEquals(insulationSqft("roof", 12, 24, 9), insulationSqft("roof", 12, 24, 8));
});

Deno.test("walls are GROSS — no deduction for openings", () => {
  // Deliberate: it is how insulation is quoted, and subtracting openings would couple this to
  // the door/window catalog. Pinned so nobody "improves" it without meaning to.
  assertEquals(insulationSqft("walls", 12, 24, 8), 2 * (12 + 24) * 8);
});

Deno.test("an unknown area measures nothing rather than guessing", () => {
  assertEquals(insulationSqft("ceiling", 12, 24, 8), 0);
  assertEquals(insulationSqft("", 12, 24, 8), 0);
});

Deno.test("only offered combinations are selectable", () => {
  assertEquals(insulationTypes(C), ["batt", "spray_foam"]);
  assertEquals(insulationAreasFor(C, "batt"), ["floor", "walls", "roof"]);
  // The unpriced spray-foam roof is simply not there — the customer never sees the choice, and
  // the server answers it with a hard 400 if a forged payload asks for it anyway.
  assertEquals(insulationAreasFor(C, "spray_foam"), ["floor", "walls"]);
  assertEquals(insulationAreasFor(C, "rockwool"), []);
});

Deno.test("areas come back in floor/walls/roof order, not payload order", () => {
  // get_config sorts by (type, area) alphabetically, which puts roof before walls. The UI must
  // read floor -> walls -> roof, outside in.
  const shuffled = { insulation: [{ type: "batt", area: "roof" }, { type: "batt", area: "floor" }, { type: "batt", area: "walls" }] };
  assertEquals(insulationAreasFor(shuffled, "batt"), ["floor", "walls", "roof"]);
});

Deno.test("a tenant offering nothing gets an empty list, not a crash", () => {
  assertEquals(insulationTypes({}), []);
  assertEquals(insulationTypes({ insulation: [] }), []);
  assertEquals(insulationAreasFor({}, "batt"), []);
});
