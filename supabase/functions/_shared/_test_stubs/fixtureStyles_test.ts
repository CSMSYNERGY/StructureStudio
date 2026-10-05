// "Offered on" in the designer (migration 272), tested against the SHIPPED designer source.
//
// Feature request 2026-10-02: louvered vents only on greenhouse styles. get_fixtures sends a
// restricted fixture's styles as `styleKeys`; the designer's pickers offer it only on those
// styles, and a style change takes a placed one off the plan. Same lift-the-real-code technique as
// wallHeight_test: the pure helpers run as shipped, and the places that use them are pinned by
// shape, because they live inside the 30,000-line component with no unit-test harness of its own.
// tests/harness/fixtureStyles.mjs drives the compiled designer for the clicks.

import { assert, assertEquals, assertStrictEquals } from "jsr:@std/assert";

const SRC = await Deno.readTextFile(new URL("../../../../structure-studio.component.js", import.meta.url));
const JSX = await Deno.readTextFile(new URL("../../../../StructureStudio.jsx", import.meta.url));

const START = "// ─── Per-fixture building-style scoping (migration 272) ───";
const END = "// ─── 3D VIEW ENGINE ───";
const lift = (src: string, name: string) => {
  const i = src.indexOf(START);
  const j = src.indexOf(END, i);
  if (i < 0 || j < 0) {
    throw new Error(`fixtureStyles_test: could not find the helpers in ${name} (start=${i}, end=${j}). ` +
      "The anchors moved — re-point them rather than deleting this test.");
  }
  return src.slice(i, j);
};
const BLOCK = lift(SRC, "structure-studio.component.js");

const { fixtureOfferedOnStyle, ssPlacedNotOfferedOn, ssNotOfferedToast } = new Function(
  `${BLOCK}; return { fixtureOfferedOnStyle, ssPlacedNotOfferedOn, ssNotOfferedToast };`,
)() as {
  fixtureOfferedOnStyle: (f: unknown, styleKey: string) => boolean;
  ssPlacedNotOfferedOn: (items: unknown, fixtures: unknown, styleKey: string) => { id: number }[];
  ssNotOfferedToast: (names: string[], styleLabel: string, extra?: string | null) => { tone: string; title: string; text: string };
};

// The asking builder's shape: the standard vent everywhere, the louvered ones on the Greenhouse.
const STANDARD = { id: "v-std", category: "vent", name: "Standard vent" };
const LOUVERED = { id: "v-lou", category: "vent", name: "Louvered window vent", styleKeys: ["greenhouse"] };
const FAN = { id: "v-fan", category: "vent", name: "12\" louvered fan w/ thermostat", styleKeys: ["greenhouse"] };
const GARAGE = { id: "d-gar", category: "door", name: "Garage Door", styleKeys: ["deluxe", "utility"] };
const NOWHERE = { id: "w-x", category: "window", name: "Stale window", styleKeys: [] };
const FIXTURES = [STANDARD, LOUVERED, FAN, GARAGE, NOWHERE];

Deno.test("no styleKeys: offered on every style, before a style is picked too", () => {
  for (const k of ["greenhouse", "deluxe", "", "anything"]) assertStrictEquals(fixtureOfferedOnStyle(STANDARD, k), true, k);
  // A malformed key is not a list, so it cannot hide anything.
  assertStrictEquals(fixtureOfferedOnStyle({ ...STANDARD, styleKeys: "greenhouse" }, "deluxe"), true);
  assertStrictEquals(fixtureOfferedOnStyle(null, "deluxe"), true);
});

Deno.test("['greenhouse']: only on the Greenhouse", () => {
  assertStrictEquals(fixtureOfferedOnStyle(LOUVERED, "greenhouse"), true);
  assertStrictEquals(fixtureOfferedOnStyle(LOUVERED, "deluxe"), false);
  // Before a style is picked a restricted item is offered nowhere, like a style-scoped option.
  assertStrictEquals(fixtureOfferedOnStyle(LOUVERED, ""), false);
  // Keys are matched exactly, as the style picker's value is.
  assertStrictEquals(fixtureOfferedOnStyle(LOUVERED, "Greenhouse"), false);
});

Deno.test("an empty list offers it nowhere", () => {
  for (const k of ["greenhouse", "deluxe", ""]) assertStrictEquals(fixtureOfferedOnStyle(NOWHERE, k), false, k);
});

Deno.test("the Vent picker's list on each style", () => {
  const vents = FIXTURES.filter((f) => f.category === "vent");
  assertEquals(vents.filter((f) => fixtureOfferedOnStyle(f, "greenhouse")).map((f) => f.id), ["v-std", "v-lou", "v-fan"]);
  assertEquals(vents.filter((f) => fixtureOfferedOnStyle(f, "deluxe")).map((f) => f.id), ["v-std"]);
});

// A plan as the designer keeps it: catalog items carry fixtureItemId; built-ins do not.
const ITEMS = [
  { id: 1, type: "window", isVent: true, fixtureItemId: "v-std", windowName: "Standard vent" },
  { id: 2, type: "window", isVent: true, fixtureItemId: "v-lou", windowName: "Louvered window vent" },
  { id: 3, type: "fixtureDoor", fixtureItemId: "d-gar", doorName: "Garage Door" },
  { id: 4, type: "loft" },
  { id: 5, type: "window", fixtureItemId: "w-archived", windowName: "Retired window" },
  { id: 6, type: "window", isVent: true, fixtureItemId: "v-lou", windowName: "Louvered window vent" },
];

Deno.test("a style change takes off exactly the placed items the new style does not offer", () => {
  assertEquals(ssPlacedNotOfferedOn(ITEMS, FIXTURES, "greenhouse").map((i) => i.id), [3]);
  assertEquals(ssPlacedNotOfferedOn(ITEMS, FIXTURES, "deluxe").map((i) => i.id), [2, 6]);
  assertEquals(ssPlacedNotOfferedOn(ITEMS, FIXTURES, "utility").map((i) => i.id), [2, 6]);
});

Deno.test("an archived item (gone from the catalog) and built-ins are never taken off", () => {
  const off = ssPlacedNotOfferedOn(ITEMS, FIXTURES, "barn").map((i) => i.id);
  assertEquals(off, [2, 3, 6]);
  assert(!off.includes(4) && !off.includes(5));
});

Deno.test("a catalog with no restrictions takes nothing off (today's catalogs)", () => {
  assertEquals(ssPlacedNotOfferedOn(ITEMS, [STANDARD, { ...LOUVERED, styleKeys: undefined }, { ...GARAGE, styleKeys: undefined }], "deluxe"), []);
  assertEquals(ssPlacedNotOfferedOn(null, FIXTURES, "deluxe"), []);
  assertEquals(ssPlacedNotOfferedOn(ITEMS, null, "deluxe"), []);
});

Deno.test("the toast says what came off and why, in plain words", () => {
  assertEquals(ssNotOfferedToast(["Louvered window vent"], "Deluxe"), {
    tone: "warn", title: "Not offered on this style",
    text: "The Louvered window vent isn't offered on the Deluxe, so it was taken off your building.",
  });
  assertEquals(
    ssNotOfferedToast(["Louvered window vent", "Garage Door", "Louvered window vent"], "Greenhouse").text,
    "These aren't offered on the Greenhouse, so they were taken off your building: Louvered window vent (2), Garage Door.",
  );
  assertEquals(ssNotOfferedToast(["Garage Door"], "").text, "The Garage Door isn't offered on this style, so it was taken off your building.");
  // A gable vent brought down by the same switch is said in the same toast, not a second one.
  const both = ssNotOfferedToast(["Garage Door"], "Greenhouse", "This style has no gable room for your vent, so it moved down to the top of the wall.");
  assert(both.text.endsWith(" This style has no gable room for your vent, so it moved down to the top of the wall."), both.text);
  // An object, never a string: a string toast is titled "Can't place here", and nothing was refused.
  assertStrictEquals(typeof both, "object");
});

// ── The component, by shape ────────────────────────────────────────────────────────────────

Deno.test("both twins carry the helpers byte for byte", () => {
  assertStrictEquals(lift(JSX, "StructureStudio.jsx"), BLOCK);
});

for (const [name, src] of [["structure-studio.component.js", SRC], ["StructureStudio.jsx", JSX]] as const) {
  Deno.test(`${name}: the offered lists sit below the sel state (reading sel.style above it throws)`, () => {
    const selAt = src.indexOf("const [sel, setSel] = useState(() => {");
    assert(selAt > 0, "the sel useState moved");
    for (const k of ["Doors", "Ramps", "Windows", "Vents"]) {
      const at = src.indexOf(`const offered${k} = placeable${k}.filter((f) => fixtureOfferedOnStyle(f, sel.style));`);
      assert(at > selAt, `offered${k} is declared after the sel useState`);
      assert(src.indexOf(`const placeable${k} = `) < selAt, `placeable${k} stays where it was`);
    }
  });

  Deno.test(`${name}: every PICKER reads the offered lists`, () => {
    assert(src.includes("    offeredVents.forEach((fx) => {\n      out[`vnt:${fx.id}`] = {"), "the Vent tools");
    assert(src.includes("...(offeredDoors.length || roDoorTile ? { doorPicker: DOOR_PICKER_CFG } : {}),"), "the Door button");
    assert(src.includes("...(rampCustom && offeredRamps.length ? { rampPicker: RAMP_PICKER_CFG } : {}),"), "the Ramp button");
    assert(src.includes("...(offeredWindows.length || roWindowTile ? { windowPicker: WINDOW_PICKER_CFG } : {}),"), "the Window button");
    for (const p of ["<DoorPicker doors={offeredDoors} ", "<RampPicker ramps={offeredRamps} ", "<WindowPicker windows={offeredWindows} ", "<VentPicker vents={offeredVents}\n"]) {
      assert(src.includes(p), p);
    }
    assert(src.includes("const pool = isDoor ? offeredDoors : isWin ? offeredWindows : offeredRamps;"), "the Swap pool");
    assertStrictEquals(src.split("placeableDoors={offeredDoors} placeableWindows={offeredWindows} placeableRamps={offeredRamps}").length - 1, 2, "both 3D viewers");
    // Nothing that offers a choice still reads the unfiltered lists.
    assert(!/<(Door|Ramp|Window|Vent)Picker [a-z]+=\{placeable/.test(src), "no picker on a placeable list");
    assert(!src.includes("placeableVents.forEach("), "no vent tool from the placeable list");
  });

  Deno.test(`${name}: rampCustom stays on the style-agnostic list`, () => {
    // A style that offers none of a custom-ramp builder's ramps must hide the Ramp button, never
    // flip the builder to the simple ramp tool.
    assert(src.includes('const rampCustom = rampMode === "custom" && placeableRamps.length > 0;'));
  });

  Deno.test(`${name}: the full lists still feed render, archive and pricing`, () => {
    assert(src.includes("const pool = it.type === \"window\" ? (isVentItem(it) ? ventFixtures : windowFixtures) : it.type === \"ramp\" ? rampFixtures : doorFixtures;"), "isArchivedItem");
    assert(src.includes("const fx = windowFixtures.find((f) => String(f.id) === String(id));"), "the dormer window prices from the full catalog");
  });

  Deno.test(`${name}: a style change takes off what the new style does not offer, never on a load`, () => {
    const at = src.indexOf("const off = sel.style ? ssPlacedNotOfferedOn(items, fixtures, sel.style) : [];");
    assert(at > 0, "the style-change effect calls ssPlacedNotOfferedOn");
    const eff = src.slice(src.lastIndexOf("useEffect(() => {", at), src.indexOf("}, [sel.style]);", at));
    assert(eff.indexOf("if (ventItemsSeenRef.current !== items) return;") < eff.indexOf("ssPlacedNotOfferedOn"), "a design being opened is returned from first");
    assert(eff.includes("dormerWindowId: null, dormerWindowOffset: 0"), "the dormer window too");
    assert(eff.includes("ssNotOfferedToast("), "and says so");
  });

  Deno.test(`${name}: a door the style does not offer takes its ramp with it`, () => {
    // Every other door removal in the twins drops the ramp snapped to it (delSel, onItemDelete);
    // left behind, the ramp sat on a bare wall and was still priced and quoted.
    const eff = styleEffect(src);
    assert(eff.includes("const offIds = new Set(off.map((it) => it.id));"), "the removed ids");
    assert(eff.includes('const rampsOff = off.length ? items.filter((it) => it.type === "ramp" && !offIds.has(it.id) && offIds.has(it.snapDoorId)) : [];'),
      "the ramps snapped to a removed door, not counted twice when the ramp is restricted itself");
    assert(eff.includes("rampsOff.forEach((it) => offIds.add(it.id));"), "join the removal");
    assert(eff.includes("const kept = offIds.size ? items.filter((it) => !offIds.has(it.id)) : items;"), "and come off the plan the vents re-fit on");
    assert(eff.includes("was taken off with it."), "the toast says the ramp went with its door");
  });

  Deno.test(`${name}: the removal still lands when the size effect replaced the plan in the same commit`, () => {
    // A style sold in one size of other dimensions sets the size with the style; the size effect
    // above reflows the plan first, and the old `cur === from ? next : cur` dropped the removal.
    const eff = styleEffect(src);
    assert(eff.includes("if (next !== items) setItems((cur) => (cur === from ? next : offIds.size ? cur.filter((it) => !offIds.has(it.id)) : cur));"),
      "the computed plan when nothing replaced it, else the replacement less the same ids");
    assert(!eff.includes("(cur === from ? next : cur)"), "never the identity-only updater");
  });

  Deno.test(`${name}: a tool armed for something the new style does not offer is disarmed`, () => {
    // With activeTool missing from ITEMS, a plan click returns at `if (!cfg) return;`: nothing places
    // and nothing selects. Before the load return, so it holds whatever the switch was.
    const eff = styleEffect(src);
    const at = eff.indexOf("if (activeTool && !ITEMS[activeTool]) setActiveTool(null);");
    assert(at > 0, "disarmed in the style effect");
    assert(at > eff.indexOf("if (prevStyle === null || prevStyle === sel.style) return;"), "on a real change only");
    assert(at < eff.indexOf("if (ventItemsSeenRef.current !== items) return;"), "a load included");
  });
}

// The style-change effect, from its ssPlacedNotOfferedOn call out to its deps line.
function styleEffect(src: string): string {
  const at = src.indexOf("const off = sel.style ? ssPlacedNotOfferedOn(items, fixtures, sel.style) : [];");
  assert(at > 0, "the style-change effect calls ssPlacedNotOfferedOn");
  return src.slice(src.lastIndexOf("useEffect(() => {", at), src.indexOf("}, [sel.style]);", at));
}

Deno.test("both twins carry the style-change effect byte for byte", () => {
  assertStrictEquals(styleEffect(JSX), styleEffect(SRC));
});
