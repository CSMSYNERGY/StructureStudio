// A SIZE CHANGE never leaves two lofts overlapping, tested against the SHIPPED designer source.
//
// reflowItems moves every placed item into the new building. A loft's centre was scaled on its
// own and clamped into the box, which kept it inside the building but not clear of the loft beside
// it: two lofts snapped flush grow an overlap when the length shrinks, and side-by-side lofts
// collapse into each other when the width does. Nothing reported it, the plan drew it, and the
// quote summed both lofts' square footage. A loft now goes flush against the one it would land on,
// or is BLOCKED (the size change is reverted with the reason) when it cannot fit anywhere clear.
//
// Same lift-the-real-code technique as wallSlab_test / ventGable_test: the functions are sliced out
// of structure-studio.component.js by stable anchors and run. Every anchor is guarded.

import { assert, assertAlmostEquals, assertEquals } from "jsr:@std/assert";

const SRC = await Deno.readTextFile(new URL("../../../../structure-studio.component.js", import.meta.url));
function lift(start: string, end: string) {
  const a = SRC.indexOf(start), b = SRC.indexOf(end, a);
  if (a < 0 || b < 0) throw new Error(`reflowLofts_test: anchors moved for ${start} (${a}, ${b}). Re-point them rather than deleting this test.`);
  return SRC.slice(a, b);
}
const PAGE = /const SS_PAGE = \{[^\n]*\n/.exec(SRC);
if (!PAGE) throw new Error("reflowLofts_test: SS_PAGE moved — re-point it");
const BLOCK = [
  PAGE[0],
  lift("function snapToWall(", "// Always returns a wall"),
  lift("function pageGeom(", "// Where a ramp sits"),
  lift("function rampPosFor(", "// Items the customer sizes"),
  lift("const SS_RO_KEYS = [", "// Plan/PDF label"),
  lift("const SS_SHRINKABLE = {", "function reflowItems("),
  lift("function reflowItems(", "// Point on a note box's border"),
].join("\n");
assert(BLOCK.includes("function reflowItems("), "extracted block is missing reflowItems");

type Item = { id: number; type: string; x: number; y: number; widthFt: number; heightFt: number; rotation: number; wall: null };
type Dims = { w: number; h: number };
type Ev = { id: number; kind: string };
// Lofts never reach the wall-item helpers, so those stay unlifted (a call would throw loudly).
const { reflowItems, pageGeom } = new Function(`${BLOCK}; return { reflowItems, pageGeom };`)() as {
  reflowItems: (items: Item[], prev: Dims, next: Dims, ITEMS: unknown) => { items: Item[]; events: Ev[] };
  pageGeom: (w: number, h: number) => { scale: number; mgX: number; mgY: number };
};
const ITEMS = { loft: { width: 4, height: 4, label: "Loft Area" } };

function loft(id: number, d: Dims, cxFt: number, cyFt: number, w: number, h: number): Item {
  const g = pageGeom(d.w, d.h);
  return { id, type: "loft", x: g.mgX + cxFt * g.scale, y: g.mgY + cyFt * g.scale, widthFt: w, heightFt: h, rotation: 0, wall: null };
}
function edges(it: Item, d: Dims) {
  const g = pageGeom(d.w, d.h);
  const cx = (it.x - g.mgX) / g.scale, cy = (it.y - g.mgY) / g.scale;
  return { l: cx - it.widthFt / 2, r: cx + it.widthFt / 2, t: cy - it.heightFt / 2, b: cy + it.heightFt / 2 };
}
// The 0.1 ft slack every loft-overlap test in the designer uses.
function overlaps(a: ReturnType<typeof edges>, b: ReturnType<typeof edges>) {
  return a.l < b.r - 0.1 && a.r > b.l + 0.1 && a.t < b.b - 0.1 && a.b > b.t + 0.1;
}
const P = { w: 10, h: 16 };

Deno.test("two lofts snapped flush stay flush, not overlapping, when the building gets shorter", () => {
  // A over 4.4..8.4, B over 8.4..12.4 on a 10x16. At 10x12 the scaled centres alone put B's top
  // at 5.8, a foot inside A.
  const next = { w: 10, h: 12 };
  const { items, events } = reflowItems([loft(1, P, 5, 6.4, 10, 4), loft(2, P, 5, 10.4, 10, 4)], P, next, ITEMS);
  assertEquals(events.filter((e) => e.kind === "blocked"), []);
  const [a, b] = items.map((i) => edges(i, next));
  assert(!overlaps(a, b), `A ${JSON.stringify(a)} B ${JSON.stringify(b)}`);
  assertAlmostEquals(b.t, a.b, 1e-6, "B sits flush on A");
  assert(b.b <= next.h + 1e-6, "and inside the building");
});

Deno.test("side-by-side lofts on a narrower building do not collapse into each other", () => {
  const Q = { w: 12, h: 16 }, next = { w: 8, h: 16 };
  const { items, events } = reflowItems([loft(1, Q, 3, 2, 6, 4), loft(2, Q, 9, 2, 6, 4)], Q, next, ITEMS);
  assertEquals(events.filter((e) => e.kind === "blocked"), []);
  const [a, b] = items.map((i) => edges(i, next));
  assert(!overlaps(a, b), `A ${JSON.stringify(a)} B ${JSON.stringify(b)}`);
  for (const e of [a, b]) assert(e.l >= -1e-6 && e.r <= next.w + 1e-6 && e.t >= -1e-6 && e.b <= next.h + 1e-6, "inside the building");
});

Deno.test("two 4 ft lofts cannot both fit in 6 ft: the second is blocked, so the size change is reverted", () => {
  const { events } = reflowItems([loft(1, P, 5, 2, 10, 4), loft(2, P, 5, 14, 10, 4)], P, { w: 10, h: 6 }, ITEMS);
  assertEquals(events.map((e) => [e.id, e.kind]), [[2, "blocked"]]);
});

Deno.test("lofts that already fit are moved exactly as before (growing, and a reload at the same size)", () => {
  const grown = reflowItems([loft(1, P, 5, 6.4, 10, 4), loft(2, P, 5, 10.4, 10, 4)], P, { w: 10, h: 20 }, ITEMS);
  assertEquals(grown.events, []);
  const g = grown.items.map((i) => edges(i, { w: 10, h: 20 }));
  assertAlmostEquals(g[0].t, 6.4 * 20 / 16 - 2, 1e-6);
  assertAlmostEquals(g[1].t, 10.4 * 20 / 16 - 2, 1e-6);
  const same = [loft(1, P, 5, 6.4, 10, 4), loft(2, P, 5, 10.4, 10, 4)];
  const reloaded = reflowItems(same, P, P, ITEMS);
  assertEquals(reloaded.events, []);
  reloaded.items.forEach((it, k) => { assertAlmostEquals(it.x, same[k].x, 1e-6); assertAlmostEquals(it.y, same[k].y, 1e-6); });
});
