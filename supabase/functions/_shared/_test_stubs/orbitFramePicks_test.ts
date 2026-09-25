// Which frames of a walk-around video become the twelve the model reads, tested against BOTH
// SHIPPED designer twins.
//
// ssExtractOrbitFrames decodes the video in the browser and cannot run here, but everything it
// DECIDES is pure and lives above it: ssSkyPixel and ssProbeLook read one 32x18 probe,
// ssProbeClasses calls it good, fair or bad, and ssOrbitPicks chooses the frames. They are lifted
// out by stable anchors and run, the porchGeom_test technique, and the region is asserted
// byte-identical across the two hand-mirrored twins.
//
// What they must never do again (2026-09-24, four real laps): spend a third of the frames on
// the walk up to one porch and on the ceiling under another, because a close-up is the biggest
// frame-to-frame change in any walk-around. So the load-bearing tests are the close-up stretch
// that no pick may land in, and the even spread round the rest of the lap.

import { assert, assertEquals } from "jsr:@std/assert";

const JSX = await Deno.readTextFile(new URL("../../../../StructureStudio.jsx", import.meta.url));
const CMP = await Deno.readTextFile(new URL("../../../../structure-studio.component.js", import.meta.url));

function lift(src: string, file: string, start: string, end: string): string {
  const i = src.indexOf(start);
  const j = i < 0 ? -1 : src.indexOf(end, i);
  if (i < 0 || j < 0) {
    throw new Error(
      `orbitFramePicks_test: could not find ${start} .. ${end} in ${file} (start=${i}, end=${j}). ` +
        "The anchors moved — re-point them rather than deleting this test.",
    );
  }
  return src.slice(i, j);
}

const REGIONS: Array<[string, string]> = [
  ["const SS_VID_FRAMES =", "const SS_VID_LONG_EDGE ="],
  ["function ssSkyPixel(", "async function ssExtractOrbitFrames("],
];
const blocks = REGIONS.map(([a, b]) => ({
  a,
  cmp: lift(CMP, "structure-studio.component.js", a, b),
  jsx: lift(JSX, "StructureStudio.jsx", a, b),
}));

Deno.test("every lifted frame-choice region is byte-identical in the two twins", () => {
  for (const { a, cmp, jsx } of blocks) assertEquals(jsx, cmp, `twins differ in the region starting ${a}`);
});

// deno-lint-ignore no-explicit-any
type Any = any;
const F = new Function(
  `${blocks.map((b) => b.cmp).join("\n")}; return { SS_VID_FRAMES, SS_VID_PROBE_MAX, ssSkyPixel, ssProbeLook, ssProbeClasses, ssProbeMotion, ssOrbitPicks };`,
)() as Record<string, Any>;

// ── Probes drawn by hand: 32x18 RGBA, the size the cutter reads ───────────────────────────
const W = 32, H = 18;
const SKY = [40, 95, 165];          // a clear sky at the top of a phone frame: deep, not bright
type RGB = number[];
function probe(paint: (x: number, y: number) => RGB) {
  const px = new Uint8ClampedArray(W * H * 4);
  const luma = new Float32Array(W * H);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const [r, g, b] = paint(x, y);
      const k = (y * W + x) * 4;
      px[k] = r; px[k + 1] = g; px[k + 2] = b; px[k + 3] = 255;
      luma[y * W + x] = 0.299 * r + 0.587 * g + 0.114 * b;
    }
  }
  return F.ssProbeLook(px, W, H, luma);
}
// Gravel: grey with a checker of texture, so it never reads as one flat surface.
const gravel = (x: number, y: number): RGB => ((x + y) % 2 ? [150, 144, 132] : [196, 188, 174]);
// A brown building from column a to b (inclusive), its roof top at row `top`, its base at row 12;
// sky above the building and above a background skyline at row 9, gravel below.
const scene = (a: number, b: number, top: number) => (x: number, y: number): RGB => {
  if (y >= 12) return gravel(x, y);
  if (x >= a && x <= b && y >= top) return (x + y) % 3 ? [92, 60, 40] : [70, 46, 30];
  if (y >= 9) return (x % 2) ? [60, 90, 50] : [45, 70, 40];   // distant trees
  return SKY;
};

Deno.test("a clear sky is sky whether deep or bright; walls, gravel and shade are not", () => {
  assert(F.ssSkyPixel(...SKY));
  assert(F.ssSkyPixel(31, 84, 152), "the deepest blue at the very top of the frame");
  assert(F.ssSkyPixel(200, 225, 245), "haze round the sun");
  assert(F.ssSkyPixel(250, 250, 250), "glare");
  assert(!F.ssSkyPixel(222, 218, 208), "a white wall in sun is warm, not sky");
  assert(!F.ssSkyPixel(170, 165, 155), "gravel");
  assert(!F.ssSkyPixel(40, 40, 46), "a dark wall");
  assert(!F.ssSkyPixel(92, 60, 40), "brown siding");
});

Deno.test("a building seen whole: sky over its roofline, nothing cut, no big flat surface", () => {
  const look = probe(scene(10, 21, 3));
  assertEquals(look.touch, 0);
  assertEquals(look.head, 3);
  assertEquals(look.cut, false);
  assert(look.flat < 0.2, `flat ${look.flat}`);
});

Deno.test("a porch ceiling across the top of the frame is a close-up", () => {
  const look = probe((x, y) => (y < 6 ? [150, 100, 60] : scene(0, 31, 6)(x, y)));
  assertEquals(look.touch, 1);
  assertEquals(look.head, 0);
});

Deno.test("a building running off one side of the frame is cut; one inside it is not", () => {
  assertEquals(probe(scene(8, 31, 2)).cut, true);
  assertEquals(probe(scene(0, 22, 2)).cut, true);
  assertEquals(probe(scene(6, 25, 2)).cut, false);
  // A LONG LOW ROOF seen side-on stands barely above the background: it is not called cut for
  // being flat, because the test is only asked when the roof stands 3 rows above the skyline.
  assertEquals(probe(scene(0, 31, 7)).cut, false);
});

Deno.test("a near wall is one flat surface", () => {
  const look = probe((x, y) => (y < 3 ? SKY : y >= 16 ? gravel(x, y) : [214, 210, 202]));
  assert(look.flat > 0.35, `flat ${look.flat}`);
  assertEquals(look.touch, 0);
});

// ── Classes and picks on a synthetic lap ───────────────────────────────────────────────────
const WHOLE = { touch: 0, head: 4, flat: 0.08, cut: false };
const CLOSE = { touch: 1, head: 0, flat: 0.3, cut: false };
/** N probes over `dur` seconds, the cutter's own schedule; `kind(i)` says what probe i shows. */
function lap(N: number, dur: number, kind: (i: number) => Any, sharp = (_i: number) => 20) {
  return Array.from({ length: N }, (_, i) => ({ t: dur * ((i + 0.5) / N), change: 20, sharp: sharp(i), ...kind(i) }));
}

Deno.test("twelve frames, never above the server's video cap", () => {
  assertEquals(F.SS_VID_FRAMES, 12);
  assert(F.SS_VID_PROBE_MAX >= 4 * F.SS_VID_FRAMES, "the chooser needs room to step round a bad frame");
});

Deno.test("a clip with no more probes than frames keeps every one, in order", () => {
  const p = lap(12, 8, () => WHOLE);
  assertEquals(F.ssOrbitPicks(p, 12), [...Array(12).keys()]);
  assertEquals(F.ssOrbitPicks(p.slice(0, 5), 12), [0, 1, 2, 3, 4]);
});

Deno.test("⚠️ NO PICK IN A CLOSE-UP: the walk up to a porch and back out gets no frame", () => {
  // 54 probes over 72 s; probes 5-17 (about 7 s to 23 s) are close-ups of a porch.
  const p = lap(54, 72, (i) => (i >= 5 && i <= 17 ? CLOSE : WHOLE));
  const picks = F.ssOrbitPicks(p, 12);
  assertEquals(picks.length, 12);
  for (let k = 1; k < picks.length; k++) assert(picks[k] > picks[k - 1], "walk order");
  for (const i of picks) assert(i < 5 || i > 17, `probe ${i} is a close-up`);
  const q = F.ssProbeClasses(p);
  assertEquals(q[10], 0);
  assertEquals(q[30], 2);
});

Deno.test("the rest of the lap is covered evenly: no stretch of whole views is skipped", () => {
  const p = lap(54, 72, (i) => (i >= 5 && i <= 17 ? CLOSE : WHOLE));
  const t = F.ssOrbitPicks(p, 12).map((i: number) => p[i].t);
  // Outside the close-up the frames are about 5 s apart (60 s of whole views, twelve frames).
  const outside = t.filter((x: number) => x > 23.5);
  for (let k = 1; k < outside.length; k++) assert(outside[k] - outside[k - 1] < 8, `gap ${outside[k - 1]} → ${outside[k]}`);
  assert(t[0] < 7 && t[t.length - 1] > 64, `ends ${t[0]} … ${t[t.length - 1]}`);
});

Deno.test("a clip where every probe is bad still gets evenly spaced frames, not none", () => {
  const p = lap(54, 90, () => CLOSE);
  const picks = F.ssOrbitPicks(p, 12);
  assertEquals(picks.length, 12);
  const gaps = picks.slice(1).map((v: number, k: number) => v - picks[k]);
  for (const g of gaps) assert(g >= 4 && g <= 5, `gaps ${gaps}`);
});

Deno.test("an overcast clip (no blue anywhere) is judged without the sky test", () => {
  const grey = { touch: 1, head: 0, flat: 0.1, cut: false };
  const q = F.ssProbeClasses(lap(54, 90, () => grey));
  assert(q.every((c: number) => c === 2), "no sky at all is not a reason to call every frame a close-up");
  // …while a flat near wall is still bad without it.
  assertEquals(F.ssProbeClasses(lap(54, 90, (i) => (i === 20 ? { ...grey, flat: 0.5 } : grey)))[20], 0);
});

Deno.test("fair: cut at a side, the roofline one row from the top, a big surface, or a parallax spike", () => {
  const q = F.ssProbeClasses([
    { t: 0, change: 0, ...WHOLE },
    { t: 1, change: 20, ...WHOLE, cut: true },
    { t: 2, change: 20, ...WHOLE, head: 1 },
    { t: 3, change: 20, ...WHOLE, flat: 0.25 },
    { t: 4, change: 40, ...WHOLE },            // this step and the next are both big: walking close
    { t: 5, change: 30, ...WHOLE },
    { t: 6, change: 40, ...WHOLE },            // one jolt, and the next step is ordinary: not a spike
    { t: 7, change: 20, ...WHOLE },
    { t: 8, change: 20, ...WHOLE, touch: 0.5 },
  ]);
  assertEquals(q, [2, 1, 1, 1, 1, 2, 2, 2, 0]);
});

Deno.test("a motion-blurred probe gives way to its sharp neighbour", () => {
  // Blur exactly the probes an all-sharp lap would pick: every pick must move to a neighbour.
  const sharpPicks = F.ssOrbitPicks(lap(54, 72, () => WHOLE), 12);
  const blurry = new Set(sharpPicks);
  const picks = F.ssOrbitPicks(lap(54, 72, () => WHOLE, (i) => (blurry.has(i) ? 5 : 20)), 12);
  assertEquals(picks.length, 12);
  picks.forEach((i: number, k: number) => {
    assert(!blurry.has(i), `picked blurry probe ${i}`);
    assert(Math.abs(i - sharpPicks[k]) <= 2, `pick ${k} moved from ${sharpPicks[k]} to ${i}`);
  });
});

// ── A pause is not part of the lap (2026-09-25) ────────────────────────────────────────────
// A builder standing still films one view for as long as they stand there. Measured in plain
// time, a 15 s pause at the start of a 60 s clip took 3 of the 12 frames and a 30 s pause in the
// middle of a 90 s clip took 4, every one the same view. The `change` of a still phone is a few
// luma steps (hand shake, exposure drift); walking is 20 and up, varying.
const STILL = (i: number) => 1 + (i % 3);                  // a handheld phone, standing still
const WALK = (i: number) => 20 + ((i * 7) % 5) * 3;        // 20..32, never twice the same in a row
/** The cutter's schedule over `dur` seconds, whole views throughout, standing still where `still(t)`. */
function walk(dur: number, still: (t: number) => boolean) {
  const N = Math.max(12, Math.min(F.SS_VID_PROBE_MAX, Math.round(dur * 1.2)));
  return Array.from({ length: N }, (_, i) => {
    const t = dur * ((i + 0.5) / N);
    return { t, change: i === 0 ? 0 : still(t) ? STILL(i) : WALK(i), sharp: 20, ...WHOLE };
  });
}

Deno.test("⚠️ A PAUSE TAKES ONE FRAME AT MOST: 15 s standing still at the start of a 60 s clip", () => {
  const still = (t: number) => t < 15;
  const p = walk(60, still);
  const picks = F.ssOrbitPicks(p, 12);
  assertEquals(picks.length, 12);
  for (let k = 1; k < picks.length; k++) assert(picks[k] > picks[k - 1], "walk order");
  const t = picks.map((i: number) => p[i].t);
  assert(t.filter(still).length <= 1, `picks in the pause at ${t.filter(still).map((x: number) => x.toFixed(1))}`);
  // …and the frames it did not spend there cover the walk: no gap over 6 s, the end reached.
  const walking = t.filter((x: number) => !still(x));
  assert(walking.length >= 11, String(walking.length));
  for (let k = 1; k < walking.length; k++) assert(walking[k] - walking[k - 1] < 6, `gap ${walking[k - 1]} → ${walking[k]}`);
  assert(t[t.length - 1] > 55, `last ${t[t.length - 1]}`);
});

Deno.test("⚠️ …and 30 s standing still in the middle of a 90 s clip", () => {
  const still = (t: number) => t >= 30 && t < 60;
  const p = walk(90, still);
  const picks = F.ssOrbitPicks(p, 12);
  assertEquals(picks.length, 12);
  const t = picks.map((i: number) => p[i].t);
  assert(t.filter(still).length <= 1, `picks in the pause at ${t.filter(still).map((x: number) => x.toFixed(1))}`);
  assert(t.filter((x: number) => x < 30).length >= 5 && t.filter((x: number) => x >= 60).length >= 5, t.map((x: number) => x.toFixed(1)).join(" "));
});

Deno.test("ssProbeMotion: a pause counts a tenth, a walk counts in full, and no change at all is plain time", () => {
  const m = F.ssProbeMotion(walk(60, (t: number) => t < 15));
  assert(m.length === 54 && m.every((v: number) => v >= 0.1 - 1e-12 && v <= 1), "one per probe, 0.1..1");
  assertEquals(m[5], 0.1, "standing still");
  assertEquals(m[40], 1, "walking");
  assertEquals(m[0], m[1], "the stretch before the first probe counts like the first step");
  // A tripod or a still frame: nothing moves anywhere, so nothing is discounted.
  assert(F.ssProbeMotion(lap(54, 72, () => WHOLE).map((p) => ({ ...p, change: 0 }))).every((v: number) => v === 1));
});

Deno.test("⚠️ a real walk is still plain time: every step at half the median change or more changes no pick", () => {
  // The four real laps' smallest steps were 0.55 to 0.69 of their clip's median (2026-09-24).
  const even = F.ssOrbitPicks(lap(54, 72, () => WHOLE), 12);
  // Under 1.6 x the median everywhere, so no step is a parallax spike and every probe stays good.
  const ratios = [0.55, 1, 1.5, 0.7, 1.2, 0.9, 1.25];
  const uneven = lap(54, 72, () => WHOLE).map((p, i) => ({ ...p, change: i === 0 ? 0 : 20 * ratios[i % ratios.length] }));
  assert(F.ssProbeClasses(uneven).every((c: number) => c === 2), "every probe good, as in the even lap");
  assert(F.ssProbeMotion(uneven).every((v: number) => v === 1));
  assertEquals(F.ssOrbitPicks(uneven, 12), even);
});
