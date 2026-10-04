// THE GROUND'S FALL ON THE WIRE (review BC-1, 2026-09-29), pinned against the SHIPPED sources.
//
// frame "front" (2026-09-25) says a designer knows blocks, piers and floorHeightFt. Every designer
// built from 09-25 up to the fall's merge (2026-09-28) sends it, and its d3ResolveStyleSpec drops
// the top-level gradeFallFt / gradeFallToward because it does not name them. So the server carries a
// stored fall over any save that OMITS the keys, whatever its frame (carryForwardFoundation), and
// the panel that knows the fall sends BOTH keys on every save, null when there is none, so its clear
// is said out loud and lands. The null is never stored.
//
// Two senders, both lifted (not copied), so a drift fails the push:
//   · ssD3WithFall in portal/12-shell.jsx, which onSaveSpec wraps round every portal save (the
//     calibration panel's and the Advanced page's);
//   · calSpecToSend in both designer twins, the operator ?admin=1 page's save.
// Then each body goes through the server's own sanitiser and carry-forward, as save_style_d3 does.

import { assert, assertEquals } from "jsr:@std/assert";
import { carryForwardFoundation, sanitizeD3Spec } from "../styleD3.ts";

const read = async (rel: string) => (await Deno.readTextFile(new URL(rel, import.meta.url))).replace(/\r\n/g, "\n");
const SHELL = await read("../../../../portal/12-shell.jsx");
const JSX = await read("../../../../StructureStudio.jsx");
const CMP = await read("../../../../structure-studio.component.js");

function between(src: string, file: string, start: string, end: string): string {
  const i = src.indexOf(start);
  const j = i < 0 ? -1 : src.indexOf(end, i);
  if (i < 0 || j < 0) {
    throw new Error(`gradeFallSave_test: could not find ${start.slice(0, 40)}… in ${file} (start=${i}, end=${j}). The anchors moved — re-point them rather than deleting this test.`);
  }
  return src.slice(i, j + end.length);
}
type Send = (d3: unknown) => Record<string, unknown>;
const lift = (src: string, file: string, name: string): Send =>
  new Function(`${between(src, file, `function ${name}(`, "\n}")}; return ${name};`)() as Send;

const SENDERS: [string, Send][] = [
  ["12-shell ssD3WithFall", lift(SHELL, "portal/12-shell.jsx", "ssD3WithFall")],
  ["StructureStudio.jsx calSpecToSend", lift(JSX, "StructureStudio.jsx", "calSpecToSend")],
  ["structure-studio.component.js calSpecToSend", lift(CMP, "structure-studio.component.js", "calSpecToSend")],
];

// What save_style_d3 does with a body: sanitise, then carry forward from the stored row. `slabGround` is
// the body's own flag beside frame (2026-10-03), which the panels that draw a slab's corners send.
const land = (sent: Record<string, unknown>, stored: unknown, frame: unknown, slabGround?: boolean) => {
  const clean = sanitizeD3Spec(sent);
  assert(clean.ok, JSON.stringify(sent));
  if (!clean.ok) throw new Error("unreachable");
  carryForwardFoundation(clean.d3, sent, stored, frame, slabGround);
  return clean.d3 as Record<string, unknown>;
};

const roof = { type: "gable", pitch: 0.4, overhang: 0.6 };
const LEVEL = { roof, siding: "lap", colors: { body: "#9B2F2F" }, wallHeightFt: 8, foundation: "piers", floorHeightFt: 1.5 };
const FALLING = { ...LEVEL, gradeFallFt: 2, gradeFallToward: "left" };
const CORNERS = { fl: 0, fr: 1, bl: 0.5, br: 2.25 };
const STORED = { ...LEVEL, gradeCornersFt: CORNERS };

Deno.test("both senders put BOTH fall keys on every save, null when there is none, and touch nothing else", () => {
  for (const [who, send] of SENDERS) {
    const level = send(LEVEL);
    assertEquals([level.gradeFallFt, level.gradeFallToward], [null, null], `${who}: a level style says so`);
    assert("gradeFallFt" in level && "gradeFallToward" in level, `${who}: present, not absent`);
    const falling = send(FALLING);
    assertEquals([falling.gradeFallFt, falling.gradeFallToward], [2, "left"], `${who}: a fall is sent as it is`);
    const onlyToward = send({ ...LEVEL, gradeFallToward: "right" });
    assertEquals([onlyToward.gradeFallFt, onlyToward.gradeFallToward], [null, "right"], `${who}: a remembered direction rides`);
    for (const [k, v] of Object.entries(LEVEL)) assertEquals(level[k], v, `${who}: ${k} is untouched`);
    // The ground at each corner (2026-09-29) rides the same way: null when there is none.
    assert("gradeCornersFt" in level && level.gradeCornersFt === null, `${who}: level ground's corners are an explicit null`);
    assertEquals(send({ ...LEVEL, gradeCornersFt: CORNERS }).gradeCornersFt, CORNERS, `${who}: corners are sent as they are`);
    assertEquals(Object.keys(level).length, Object.keys(LEVEL).length + 3, `${who}: exactly three keys added`);
    // The draft is not changed: the keys are added to a copy.
    const draft = { ...LEVEL };
    send(draft);
    assert(!("gradeFallFt" in draft), `${who}: the draft itself is left alone`);
    for (const odd of [null, undefined, "x"]) assertEquals(send(odd) as unknown, odd as unknown, `${who}: ${String(odd)} passes through`);
  }
});

Deno.test("⚠️ the two senders are wired into the saves, each saying it knows a slab's corners", () => {
  assert(SHELL.includes(`const body = { action: "save_style_d3", styleValue, d3: ssD3WithFall(d3), d3Photos, frame: "front", slabGround: true };`),
    "12-shell onSaveSpec must send ssD3WithFall(d3) and slabGround: true");
  for (const [file, src] of [["StructureStudio.jsx", JSX], ["structure-studio.component.js", CMP]]) {
    assert(src.includes(`action: "save_style_d3", styleValue: adminCal.styleValue, d3: calSpecToSend(adminCal.spec),`),
      `${file}: the operator page's save must send calSpecToSend(adminCal.spec)`);
    assert(src.includes(`d3Photos: adminCal.photos.filter(Boolean), frame: "front", slabGround: true },`), `${file}: the operator page's save must send slabGround: true`);
  }
});

Deno.test("⚠️ end to end: a level style saves exactly as before, a clear lands, and an older designer's save keeps the fall", () => {
  for (const [who, send] of SENDERS) {
    // An untouched level style is stored byte-for-byte as the sanitiser always stored it: no null.
    assertEquals(JSON.stringify(land(send(LEVEL), LEVEL, "front")), JSON.stringify(land(LEVEL, LEVEL, "front")), `${who}: level, untouched`);
    assert(!JSON.stringify(land(send(LEVEL), LEVEL, "front")).includes("gradeFall"), `${who}: no fall key stored`);
    // A style storing a fall, saved untouched, keeps it; cleared in the panel, it goes.
    const kept = land(send(FALLING), FALLING, "front");
    assertEquals([kept.gradeFallFt, kept.gradeFallToward], [2, "left"], `${who}: an untouched fall is kept`);
    const cleared = land(send(LEVEL), FALLING, "front");
    assert(!("gradeFallFt" in cleared) && !("gradeFallToward" in cleared), `${who}: the panel's clear lands: ${JSON.stringify(cleared)}`);
  }
  // The designer built between 09-25 and 09-28: frame "front", no fall keys at all. Its untouched
  // save of a falling style keeps the fall (this is the bug: it used to be erased).
  const beta = land(LEVEL, FALLING, "front");
  assertEquals([beta.foundation, beta.gradeFallFt, beta.gradeFallToward], ["piers", 2, "left"], JSON.stringify(beta));
});

// ── THE GROUND AT EACH CORNER (gradeCornersFt, 2026-09-29) ON THE WIRE ─────────────────────────────
// The BC-1 rule, extended: every save that OMITS the key keeps the stored corners (production's
// designer, and the panels before today, all omit it), whatever the frame; an explicit null clears
// them; and corners replace the fall, sent or carried.
Deno.test("⚠️ end to end: corners saved, kept by an older designer's save, cleared by the panel's null, and never beside a fall", () => {
  for (const [who, send] of SENDERS) {
    // Typed in the panel on a level style: stored as all four.
    const typed = land(send({ ...LEVEL, gradeCornersFt: { fl: 0, fr: 1.5, bl: 0, br: 2 } }), LEVEL, "front");
    assertEquals(typed.gradeCornersFt, { fl: 0, fr: 1.5, bl: 0, br: 2 }, who);
    // Untouched, a style storing corners saves them back exactly; "Level ground" (no key on the draft) clears.
    assertEquals(land(send(STORED), STORED, "front").gradeCornersFt, CORNERS, `${who}: kept`);
    const cleared = land(send(LEVEL), STORED, "front");
    assert(!("gradeCornersFt" in cleared) && !JSON.stringify(cleared).includes("gradeFall"), `${who}: the panel's clear lands: ${JSON.stringify(cleared)}`);
    // Corners typed over a stored fall: the panel drops the fall from the draft (calSetGradeCorner), and
    // the fall goes; the corners are stored in its place.
    const over = land(send({ ...LEVEL, gradeCornersFt: { fl: 0, fr: 0, bl: 2, br: 3 } }), FALLING, "front");
    assertEquals(over.gradeCornersFt, { fl: 0, fr: 0, bl: 2, br: 3 }, who);
    assert(!("gradeFallFt" in over) && !("gradeFallToward" in over), `${who}: no fall beside corners: ${JSON.stringify(over)}`);
  }
  // A designer from before today (frame "front", or production's with none): no corners key at all.
  // Its untouched save keeps them, re-held to the band, and no fall comes back beside them.
  for (const frame of ["front", undefined, "front-left"]) {
    for (const sent of [LEVEL, { ...LEVEL, gradeFallFt: null, gradeFallToward: null }, FALLING]) {
      const kept = land(sent, { ...STORED, gradeCornersFt: { ...CORNERS, br: 11 } }, frame);
      assertEquals(kept.gradeCornersFt, { ...CORNERS, br: 6 }, `${String(frame)} ${JSON.stringify(sent)}`);
      assert(!("gradeFallFt" in kept) && !("gradeFallToward" in kept), `${String(frame)}: corners replace the fall: ${JSON.stringify(kept)}`);
    }
  }
  // Production's designer resolves piers to null: the raised floor is carried, and its corners with it.
  const prod = land({ roof, siding: "lap", colors: {}, wallHeightFt: 8, foundation: null }, STORED, undefined);
  assertEquals([prod.foundation, prod.gradeCornersFt], ["piers", CORNERS], JSON.stringify(prod));
  // Not raised any more (skids picked): nothing is carried.
  const skids = land({ ...LEVEL, foundation: "skids" }, STORED, "front");
  assert(!("gradeCornersFt" in skids), JSON.stringify(skids));
  // The sanitiser: all zeros, junk, or no raised floor stores nothing; a sent corner object replaces a sent fall.
  // null and a non-object leave the fall to its own keys.
  for (const junk of [null, "2"]) {
    const r = sanitizeD3Spec({ ...FALLING, gradeCornersFt: junk });
    assert(r.ok && !("gradeCornersFt" in r.d3) && r.d3.gradeFallFt === 2, JSON.stringify(junk));
  }
  // Any corners OBJECT, even one that stores nothing, drops the fall, as the renderer's d3GradeFall ignores
  // the fall beside it and draws level ground (review 2026-09-30: the preview and the stored row disagreed).
  for (const junk of [{}, { fl: 0, fr: 0, bl: 0, br: 0 }, [1, 2], { fl: -3, fr: "x" }]) {
    const r = sanitizeD3Spec({ ...FALLING, gradeCornersFt: junk });
    assert(r.ok && !("gradeCornersFt" in r.d3) && !("gradeFallFt" in r.d3) && !("gradeFallToward" in r.d3), JSON.stringify([junk, r]));
    // ...and the carry-forward does not bring a stored fall back beside it.
    const kept = land({ ...LEVEL, gradeCornersFt: junk }, FALLING, "front");
    assert(!("gradeFallFt" in kept) && !("gradeFallToward" in kept) && !("gradeCornersFt" in kept), `carry: ${JSON.stringify([junk, kept])}`);
  }
  const both = sanitizeD3Spec({ ...FALLING, gradeCornersFt: { fl: "1", br: 7 } });
  assert(both.ok && JSON.stringify(both.d3.gradeCornersFt) === JSON.stringify({ fl: 1, fr: 0, bl: 0, br: 6 }) && !("gradeFallFt" in both.d3) && !("gradeFallToward" in both.d3), JSON.stringify(both));
  // A slab keeps them since 2026-10-03 (below); skids still do not.
  const slab = sanitizeD3Spec({ ...LEVEL, foundation: "slab", gradeCornersFt: CORNERS });
  assert(slab.ok && JSON.stringify(slab.d3.gradeCornersFt) === JSON.stringify(CORNERS) && !("floorHeightFt" in slab.d3), JSON.stringify(slab));
  const onSkids = sanitizeD3Spec({ ...LEVEL, foundation: "skids", gradeCornersFt: CORNERS });
  assert(onSkids.ok && !("gradeCornersFt" in onSkids.d3), JSON.stringify(onSkids));
});

// ── A SLAB'S CORNERS ON THE WIRE (2026-10-03) ─────────────────────────────────────────────────────────
// Every panel before today sends gradeCornersFt null on every save and never drew a slab's corners, so on a
// slab that null cannot clear them. The panels that draw them say so with slabGround: true in the body, and
// only then is null a clear. The raised floor's rules are untouched by the flag.
const SLAB_ROW = { roof, siding: "lap", colors: { body: "#9B2F2F" }, wallHeightFt: 8, foundation: "slab" };
const SLAB_STORED = { ...SLAB_ROW, gradeCornersFt: CORNERS };
Deno.test("⚠️ a slab's corners: kept over a save that omits them or sends an older panel's null, cleared only by a panel that says it draws them", () => {
  for (const frame of ["front", undefined]) {
    // Absent: an older designer that has never heard of the key.
    assertEquals(land(SLAB_ROW, SLAB_STORED, frame).gradeCornersFt, CORNERS, `${String(frame)}: absent is carried`);
    // An older panel's null (ssD3WithFall / calSpecToSend before today): carried, with or without the flag false.
    for (const flag of [undefined, false]) {
      assertEquals(land({ ...SLAB_ROW, gradeCornersFt: null }, SLAB_STORED, frame, flag).gradeCornersFt, CORNERS, `${String(frame)} ${String(flag)}: null without the flag is carried`);
    }
    // The panels that draw them: their null is "level ground".
    const cleared = land({ ...SLAB_ROW, gradeCornersFt: null }, SLAB_STORED, frame, true);
    assert(!("gradeCornersFt" in cleared), `${String(frame)}: null with the flag clears: ${JSON.stringify(cleared)}`);
    // An object sent is what is stored, flag or not.
    for (const flag of [undefined, true]) {
      assertEquals(land({ ...SLAB_ROW, gradeCornersFt: { fl: 0, fr: 0, bl: 2, br: 0.5 } }, SLAB_STORED, frame, flag).gradeCornersFt, { fl: 0, fr: 0, bl: 2, br: 0.5 }, `${String(frame)}: replaced`);
      // An all-zero object is level ground, said out loud.
      assert(!("gradeCornersFt" in land({ ...SLAB_ROW, gradeCornersFt: { fl: 0, fr: 0, bl: 0, br: 0 } }, SLAB_STORED, frame, flag)), `${String(frame)}: zeros clear`);
    }
    // A carried value is re-held to the band.
    assertEquals(land(SLAB_ROW, { ...SLAB_STORED, gradeCornersFt: { ...CORNERS, br: 11 } }, frame).gradeCornersFt, { ...CORNERS, br: 6 });
    // Leaving the slab carries nothing: skids, or no foundation at all.
    for (const f of ["skids", null]) {
      const out = land({ ...SLAB_ROW, foundation: f }, SLAB_STORED, frame);
      assert(!("gradeCornersFt" in out), `${String(frame)}: slab -> ${String(f)} drops them: ${JSON.stringify(out)}`);
    }
  }
  // Onto a raised floor nothing comes over from the slab: the raised floor's carry starts from a stored raised floor.
  const piers = land({ ...SLAB_ROW, foundation: "piers", floorHeightFt: 1.5 }, SLAB_STORED, "front", true);
  assertEquals([piers.foundation, "gradeCornersFt" in piers], ["piers", false], JSON.stringify(piers));
  // A stored slab with no corners: nothing is invented.
  assert(!("gradeCornersFt" in land(SLAB_ROW, SLAB_ROW, "front")));
  // Both senders, end to end: an untouched slab with corners saves them back; "Level ground" clears them.
  for (const [who, send] of SENDERS) {
    assertEquals(land(send(SLAB_STORED), SLAB_STORED, "front", true).gradeCornersFt, CORNERS, `${who}: kept`);
    assert(!("gradeCornersFt" in land(send(SLAB_ROW), SLAB_STORED, "front", true)), `${who}: the panel's clear lands`);
    assertEquals(land(send(SLAB_ROW), SLAB_STORED, "front").gradeCornersFt, CORNERS, `${who}: the same body from before the flag keeps them`);
  }
});

Deno.test("⚠️ the slab flag never moves a raised floor's corners", () => {
  for (const flag of [undefined, false, true]) {
    for (const frame of ["front", undefined]) {
      assertEquals(land(LEVEL, STORED, frame, flag).gradeCornersFt, CORNERS, `${String(flag)} ${String(frame)}: absent is carried`);
      assert(!("gradeCornersFt" in land({ ...LEVEL, gradeCornersFt: null }, STORED, frame, flag)), `${String(flag)} ${String(frame)}: a raised floor's null clears, as before`);
    }
  }
});
