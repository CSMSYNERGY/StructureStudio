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

// What save_style_d3 does with a body: sanitise, then carry forward from the stored row.
const land = (sent: Record<string, unknown>, stored: unknown, frame: unknown) => {
  const clean = sanitizeD3Spec(sent);
  assert(clean.ok, JSON.stringify(sent));
  if (!clean.ok) throw new Error("unreachable");
  carryForwardFoundation(clean.d3, sent, stored, frame);
  return clean.d3 as Record<string, unknown>;
};

const roof = { type: "gable", pitch: 0.4, overhang: 0.6 };
const LEVEL = { roof, siding: "lap", colors: { body: "#9B2F2F" }, wallHeightFt: 8, foundation: "piers", floorHeightFt: 1.5 };
const FALLING = { ...LEVEL, gradeFallFt: 2, gradeFallToward: "left" };

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
    assertEquals(Object.keys(level).length, Object.keys(LEVEL).length + 2, `${who}: exactly two keys added`);
    // The draft is not changed: the keys are added to a copy.
    const draft = { ...LEVEL };
    send(draft);
    assert(!("gradeFallFt" in draft), `${who}: the draft itself is left alone`);
    for (const odd of [null, undefined, "x"]) assertEquals(send(odd) as unknown, odd as unknown, `${who}: ${String(odd)} passes through`);
  }
});

Deno.test("⚠️ the two senders are wired into the saves", () => {
  assert(SHELL.includes(`const body = { action: "save_style_d3", styleValue, d3: ssD3WithFall(d3), d3Photos, frame: "front" };`),
    "12-shell onSaveSpec must send ssD3WithFall(d3)");
  for (const [file, src] of [["StructureStudio.jsx", JSX], ["structure-studio.component.js", CMP]]) {
    assert(src.includes(`action: "save_style_d3", styleValue: adminCal.styleValue, d3: calSpecToSend(adminCal.spec),`),
      `${file}: the operator page's save must send calSpecToSend(adminCal.spec)`);
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
