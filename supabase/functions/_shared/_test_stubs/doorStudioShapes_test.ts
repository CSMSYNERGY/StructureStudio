// The Library card's "make it from a photo" straightener (portal/03-catalog.jsx, door looks P6) must hand
// the server EXACTLY the shape it checks: the typed door plus DOOR_EDGE_PAD_IN each side, inside the 1568 px
// / 1.15 MP limits (generate_door_look refuses anything else as door_photo_shape). The portal carries its
// own copies of doorFitSize and doorEdgePadPx (_shared/doorLookPrompt.ts) and of preparedSize
// (scripts/doorLookLocal.mjs, the local prepare that every corpus run used), because the portal is a
// buildless page that cannot import them. This test runs the SHIPPED portal text against both, so a change
// to either side that the other does not get fails here:
//   1. ssDoorFitSize === doorFitSize, ssDoorEdgePadPx === doorEdgePadPx, on sizes and aspects either side
//      of both limits;
//   2. ssDoorPreparedSize === doorLookLocal's preparedSize (the server's own fit inside it) on real-shaped
//      quads, and its answer passes the server's shape rule (doorGenerate.ts: within min(3 %, the strips'
//      share) of (width + 2 pad) / height) and doorPhotoFits;
//   3. the checks before anything is uploaded: under 600 px is refused; 600-1000 px wants a hinge close-up;
//      a quad more than 35 % off the typed shape is refused; a good one passes.
// The portal's names are lifted by text, the way aiDraftStreamShell_test lifts 01-core.

import { assert, assertEquals } from "jsr:@std/assert";
import { DOOR_EDGE_PAD_IN, doorEdgePadPx, doorFitSize, doorPhotoFits } from "../doorLookPrompt.ts";

const read = async (p: string) => (await Deno.readTextFile(new URL(p, import.meta.url))).replace(/\r\n/g, "\n");
const CATALOG = await read("../../../../portal/03-catalog.jsx");
const LOCAL = await read("../../../../scripts/doorLookLocal.mjs");
function lift(src: string, start: string, end: string, what: string): string {
  const i = src.indexOf(start);
  const j = i < 0 ? -1 : src.indexOf(end, i + start.length);
  if (i < 0 || j < 0) throw new Error(`doorStudioShapes_test: could not find ${what} (start=${i}, end=${j}). The anchors moved; re-point them.`);
  return src.slice(i, j);
}
type XY = [number, number];
type Quad = [XY, XY, XY, XY];
// The portal block: its constants, ssDoorFitSize, ssDoorEdgePadPx, ssDoorPreparedSize and ssDoorQuadCheck.
const PORTAL = new Function(
  lift(CATALOG, "const SS_DOOR_PAD_IN = 2;", "// The warp: the output's door box", "the portal's door photo shapes") +
    "\nreturn { SS_DOOR_PAD_IN, ssDoorFitSize, ssDoorEdgePadPx, ssDoorPreparedSize, ssDoorQuadCheck };",
)() as {
  SS_DOOR_PAD_IN: number;
  ssDoorFitSize: (src: XY, aspect?: number) => XY;
  ssDoorEdgePadPx: (w: number, widthIn: number, padIn?: number) => number;
  ssDoorPreparedSize: (quad: Quad, widthIn: number, heightIn: number, padIn?: number) => XY;
  ssDoorQuadCheck: (quad: Quad, widthIn: number, heightIn: number, hinge: boolean) => { ok: boolean; tall: number; error?: string };
};
// doorLookLocal.mjs's preparedSize, with the server's doorFitSize it calls.
const preparedSize = new Function("doorFitSize",
  lift(LOCAL, "export function preparedSize(", "\nexport function parseQuad", "doorLookLocal.mjs's preparedSize").replace(/^export /, "") + "\nreturn preparedSize;",
)(doorFitSize) as (o: { src: XY; quad: Quad; widthIn: number; heightIn: number; padIn: number }) => XY;

Deno.test("the portal's pad is the server's", () => {
  assertEquals(PORTAL.SS_DOOR_PAD_IN, DOOR_EDGE_PAD_IN);
});

Deno.test("ssDoorFitSize and ssDoorEdgePadPx are the server's, either side of both limits", () => {
  const sizes: XY[] = [[400, 900], [1000, 2200], [1568, 1568], [3000, 4000], [4032, 3024], [800, 600], [1200, 1100], [12000, 9000], [731, 1461]];
  const aspects = [undefined, 0.3, 0.5, 0.75, 1, 1.25, 2.4];
  for (const s of sizes) for (const a of aspects) assertEquals(PORTAL.ssDoorFitSize(s, a), doorFitSize(s, a), `${s} at ${a}`);
  for (const w of [200, 730, 1024, 1568]) for (const inch of [24, 36, 72, 144]) assertEquals(PORTAL.ssDoorEdgePadPx(w, inch), doorEdgePadPx(w, inch), `${w} px, ${inch} in`);
});

Deno.test("ssDoorPreparedSize is doorLookLocal's, and the server takes what it makes", () => {
  const quads: Array<[Quad, number, number]> = [
    [[[430, 300], [1110, 360], [1120, 1690], [420, 1760]], 36, 80],   // the harness's photo, from a little left
    [[[17, 33], [422, 31], [427, 937], [18, 953]], 36, 80],           // a small photo, square on
    [[[200, 400], [2900, 380], [2950, 2600], [180, 2650]], 120, 96],  // a wide double, big phone photo
    [[[600, 200], [1400, 260], [1380, 3900], [620, 3950]], 30, 81],   // a tall slab
    [[[50, 50], [2050, 80], [2100, 2050], [40, 2000]], 72, 72],      // square
  ];
  for (const [q, w, h] of quads) {
    const mine = PORTAL.ssDoorPreparedSize(q, w, h);
    assertEquals(mine, preparedSize({ src: [5000, 5000], quad: q, widthIn: w, heightIn: h, padIn: DOOR_EDGE_PAD_IN }), `${w} x ${h}`);
    assert(doorPhotoFits(mine), `${mine} fits the limits`);
    // doorGenerate.ts's door_photo_shape rule, as the server applies it.
    const tol = Math.min(0.03, DOOR_EDGE_PAD_IN / (w + 2 * DOOR_EDGE_PAD_IN));
    assert(Math.abs(mine[0] / mine[1] / ((w + 2 * DOOR_EDGE_PAD_IN) / h) - 1) <= tol, `${mine} is the shape the server checks for ${w} x ${h}`);
  }
});

Deno.test("the checks before anything is uploaded", () => {
  const rect = (x: number, y: number, w: number, h: number): Quad => [[x, y], [x + w, y], [x + w, y + h], [x, y + h]];
  const small = PORTAL.ssDoorQuadCheck(rect(10, 10, 250, 550), 36, 80, true);
  assertEquals([small.ok, /too small\. Use one/.test(small.error ?? "")], [false, true], "under 600 px tall is refused, close-up or not");
  const mid = PORTAL.ssDoorQuadCheck(rect(10, 10, 360, 800), 36, 80, false);
  assertEquals([mid.ok, /Add a close-up of a hinge/.test(mid.error ?? "")], [false, true], "600-1000 px wants a hinge close-up");
  assertEquals(PORTAL.ssDoorQuadCheck(rect(10, 10, 360, 800), 36, 80, true).ok, true, "...and passes with one");
  const off = PORTAL.ssDoorQuadCheck(rect(10, 10, 1000, 1200), 36, 80, false);
  assertEquals([off.ok, /doesn't match the door's size/.test(off.error ?? "")], [false, true], "a quad far off the typed shape");
  assertEquals(PORTAL.ssDoorQuadCheck(rect(10, 10, 620, 1300), 36, 80, false).ok, true, "a good one");
  // 35 % is the bar: a photo 35° off to one side narrows to about 0.82 and still passes.
  assertEquals(PORTAL.ssDoorQuadCheck(rect(10, 10, 0.82 * 1300 * 36 / 80, 1300), 36, 80, false).ok, true, "35° off to one side passes");
  assertEquals(PORTAL.ssDoorQuadCheck(rect(10, 10, 0.6 * 1300 * 36 / 80, 1300), 36, 80, false).ok, false, "40 % narrow does not");
});
