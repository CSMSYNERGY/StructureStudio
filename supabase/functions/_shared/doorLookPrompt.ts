// ─── DOOR LOOKS FROM A PHOTO: WHAT THE MODEL IS ASKED, AND HOW ITS ANSWER IS READ (2026-10-26) ──────
// Phase P4 of "door looks from a photo" (the plan of 2026-10-24, section 4). The Stage A prompt
// (DOOR_LOOK_V2) and its answer shape, the three close-up asks, the Stage B read, the request body they
// all go in, and the photo limits. Every word the model is sent about a door is in this file, so the
// server (portal-settings, through _shared/doorGenerate.ts) and the local path (scripts/doorLookLocal.mjs,
// which runs the very same prompt by hand where there is no API key) cannot drift apart.
//
// PURE: no I/O, and nothing but erasable TypeScript, so Node imports it too (scripts/doorLookLocal.mjs
// and tests/doorlooks/doorSim.mjs load it with pathToFileURL, as the scorer loads doorLook.ts).
//
// THE ANSWER IS PIXEL POINTS. The model names the closest base look and gives points; doorLook.ts turns
// the points into inches and fractions (doorLookFromMeasure) and merges three reads (consensusDoorLooks).
// So the measure shape below is exactly the one doorLook.ts reads (the comment above its
// DOOR_SIZE_ASPECT_TOL), and a change to one is a change to the other.

import type { DoorLook, XY } from "./doorLook.ts";

// V2 (2026-10-27): the photo shows an edge strip past each side of the door (DOOR_EDGE_PAD_IN, below).
// V3 (2026-10-28): V2's edge strips, plus pivot hinges, a pull's two ends and a lock of its own (a modern
// pivot door's: Ahsan's test case, ai_door_calls 5013e3e0).
// V4 (2026-10-28): V3 plus `surface`, so a wood door keeps its own tone and grain.
export const DOOR_LOOK_PROMPT_ID = "DOOR_LOOK_V4";

// ─── THE PHOTO'S LIMITS ───────────────────────────────────────────────────────────────────────────
// The browser straightens and re-encodes every door photo at these, so the API never resizes one and the
// points the model gives are points on the image we measure against. 1.15 megapixels is the API's own
// threshold (1.15 x 1024 x 1024: a 1092 x 1092 square fits, as its table says), and 1568 px its long side.
export const DOOR_PHOTO_MAX_LONG = 1568;
export const DOOR_PHOTO_MAX_PIXELS = Math.floor(1.15 * 1024 * 1024);
export const DOOR_PHOTO_MAX_BYTES = 5 * 1024 * 1024; // the door-refs bucket's own limit (343)

// ─── THE EDGE STRIPS (DOOR_LOOK_V2, 2026-10-27) ───────────────────────────────────────────────────
// A butt hinge's knuckle sits ON the leaf's edge, the line the builder drags the straightening corners
// to, so a photo cut at the corners halves every knuckle: the first door generated from a photo kept a
// sliver of its 3 hinges and every read said "hidden". So the straightened photo shows DOOR_EDGE_PAD_IN
// inches past each SIDE edge of the door; top and bottom are still the top of the leaves and the top of
// the threshold. The browser's straightener and the local script warp the dragged corners to the box
// inside the strips (doorEdgePadPx), and doorLook.ts reads the points through them (DoorMeasureCtx.padIn).
export const DOOR_EDGE_PAD_IN = 2;
// One strip's width in pixels, on a straightened photo `photoW` wide of a door `widthIn` wide.
export function doorEdgePadPx(photoW: number, widthIn: number, padIn = DOOR_EDGE_PAD_IN): number {
  return padIn > 0 ? (photoW * padIn) / (widthIn + 2 * padIn) : 0;
}

// The largest size inside both limits with this aspect, never larger than the source (a photo is only
// ever shrunk). The browser's straightener and the local script both size with this.
export function doorFitSize(src: XY, aspect?: number): XY {
  const a = aspect && Number.isFinite(aspect) && aspect > 0 ? aspect : src[0] / src[1];
  // Start from the source's own size along its long side, then shrink until both limits hold.
  let w = a >= 1 ? Math.min(src[0], DOOR_PHOTO_MAX_LONG) : Math.min(src[1], DOOR_PHOTO_MAX_LONG) * a;
  let h = w / a;
  if (Math.max(w, h) > DOOR_PHOTO_MAX_LONG) [w, h] = a >= 1 ? [DOOR_PHOTO_MAX_LONG, DOOR_PHOTO_MAX_LONG / a] : [DOOR_PHOTO_MAX_LONG * a, DOOR_PHOTO_MAX_LONG];
  if (w * h > DOOR_PHOTO_MAX_PIXELS) {
    const k = Math.sqrt(DOOR_PHOTO_MAX_PIXELS / (w * h));
    [w, h] = [w * k, h * k];
  }
  // Rounded down so rounding never steps over a limit.
  return [Math.max(1, Math.floor(w)), Math.max(1, Math.floor(h))];
}
export const doorPhotoFits = (size: XY) =>
  size[0] > 0 && size[1] > 0 && Math.max(size[0], size[1]) <= DOOR_PHOTO_MAX_LONG && size[0] * size[1] <= DOOR_PHOTO_MAX_PIXELS;

// ─── STAGE A: READ THE DOOR (DOOR_LOOK_V1) ────────────────────────────────────────────────────────
// The plan's order: known size, base looks, leaves and meet, frame and rails, field, brace and panels,
// parts, hinges and handle, observed and unexplained, refuse, measure. The bases are described as they
// are DRAWN today (plankDoorLeaf, trimDoorLeaf), in section 3's words, because the base is where the
// renderer starts.
export type DoorCloseUpKind = "hinge" | "handle" | "meet";
export const DOOR_CLOSEUP_LABELS: Record<DoorCloseUpKind, string> = {
  hinge: "a close-up of one hinge",
  handle: "a close-up of the handle",
  meet: "a close-up of the middle of the double door, where the two leaves meet",
};
export type DoorStageAInput = {
  widthIn: number;
  heightIn: number;
  leaves: 1 | 2; // what the builder typed
  photo: XY; // the straightened photo's own size in pixels: the size the model must echo
  padIn?: number; // the photo's edge strips: DOOR_EDGE_PAD_IN when absent, 0 for a photo cut at the leaves
  closeUps?: DoorCloseUpKind[]; // the builder's own close-ups, in the order they follow the photo
};

const inchText = (n: number) => `${Math.round(n * 10) / 10}`;

// Where the door is in the photo, in the model's words (Stage A and Stage B say it the same way).
function edgesText(w: number, widthIn: number, padIn: number): string {
  const p = Math.round(doorEdgePadPx(w, widthIn, padIn));
  if (p <= 0) {
    return "This photo is straightened. Its edges are the outer edges of the leaves, inside the casing, from the top of the threshold to the top of the leaves. " +
      "A pixel's x divided by the image width is its fraction across the door, and its y divided by the image height is its fraction down from the top of the door. ";
  }
  return `This photo is straightened. The door's leaves fill it across from x = ${p} to x = ${w - p}, and down from the top of the leaves (the top edge) to the top of the threshold (the bottom edge). ` +
    `The strip ${p} pixels wide down each side is just past the leaves' outer edges: the jamb or casing, and the knuckles of butt hinges, which sit on the edge. ` +
    "The strips are not part of the door: give a point in them only for a hinge (its pivot, or colorAt.hardware on it). " +
    "A pixel's y divided by the image height is its fraction down from the top of the door. ";
}

// The answer, as the model is shown it: points first (measure), then the words. The words match the
// plan's example; the parts list shows each part's own shape once.
export const DOOR_STAGE_A_ANSWER = {
  measure: {
    size: [0, 0],
    leaves: [[[0, 0], [0, 0], [0, 0], [0, 0]]],
    meet: [[0, 0], [0, 0]],
    rails: [{ top: [[0, 0], [0, 0]], bottom: [[0, 0], [0, 0]] }],
    stiles: [{ inner: [[0, 0], [0, 0]] }],
    seams: [0],
    braces: [{ a: [0, 0], b: [0, 0], across: [[0, 0], [0, 0]] }],
    hinges: [{ pivot: [0, 0], tip: [0, 0], across: [[0, 0], [0, 0]] }],
    handle: [0, 0],
    parts: [
      { t: "lite", box: [[0, 0], [0, 0]], rows: 3, cols: 3 },
      { t: "board", a: [0, 0], b: [0, 0], across: [[0, 0], [0, 0]], role: "members" },
      { t: "split", line: [[0, 0], [0, 0]] },
    ],
    colorAt: { infill: [0, 0], frame: [0, 0], members: [0, 0], hardware: [0, 0] },
  },
  refuse: null,
  base: "zbrace",
  leaves: 2,
  hingeSide: "right",
  field: "v",
  surface: "painted",
  brace: "z",
  panels: ["none", "none"],
  hinges: { type: "tstrap" },
  handle: { type: "barn" },
  lock: "none",
  meet: { type: "overlap" },
  observed: ["two leaves", "one Z brace across each leaf", "three black T-straps per leaf"],
  unexplained: [],
} as const;

export function doorStageAPrompt(x: DoorStageAInput): string {
  const [w, h] = x.photo;
  const kind = x.leaves === 2 ? "a double door: two leaves that meet in the middle" : "a single door: one leaf";
  const ups = (x.closeUps ?? []).filter((k) => k in DOOR_CLOSEUP_LABELS);
  const closeUpText = ups.length
    ? ` The ${ups.length === 1 ? "image" : `${ups.length} images`} after the first ${ups.length === 1 ? "is" : "are"} the builder's own close-up${ups.length === 1 ? "" : "s"}: ${ups.map((k) => DOOR_CLOSEUP_LABELS[k]).join("; ")}. ` +
      "Use them only to see what a hinge, the handle or the meeting edge is. They are not measured against the door: never give a point on them."
    : "";
  return [
    `${DOOR_LOOK_PROMPT_ID}. You are measuring one photo of one closed door so that we can build the same door in 3D. Answer with one JSON object and nothing else.`,

    `1. KNOWN SIZE. The builder measured this door: ${inchText(x.widthIn)} in wide and ${inchText(x.heightIn)} in tall, ${kind}. ` +
      edgesText(w, x.widthIn, x.padIn ?? DOOR_EDGE_PAD_IN) +
      `This image is ${w} x ${h} pixels.${closeUpText}`,

    "2. BASE LOOKS. Every door we build is one of these seven looks plus what you measure. Name the closest one as `base`:\n" +
      "- plank: framed vertical boards: stiles down both edges, rails at the top and bottom, vertical boards between them, and one mid rail across the leaf at about 55% of its height.\n" +
      "- zbrace: plank plus one diagonal brace across the whole leaf, laid over the mid rail, rising from the hinge side.\n" +
      "- xbrace: plank plus an X in the lower panel only, below the mid rail.\n" +
      "- american: a trim frame, a mid rail at about 42% of the height, and pickets (narrow vertical boards) across the lower panel.\n" +
      "- basic: a trim frame and a mid rail at about 42% of the height, and nothing more.\n" +
      "- classic: a trim frame and a mid rail at about 42%. The upper panel has an octagon (four short braces across its corners) round a solid diamond. The lower panel has an X.\n" +
      "- dutch: a trim frame with a mid rail and a small dark louvred vent in the lower panel. A door split to open top and bottom is a split part, not dutch.\n" +
      "A plain flat door with no frame showing is basic with field smooth. A frame filled with one sheet (ribbed or corrugated metal, or grooved siding) is a trim look with field grooved, however much its ribs look like boards: american, classic or dutch when it has their pickets, octagon and X, or vent, and basic otherwise. plank, zbrace and xbrace are framed separate boards. A door of six raised panels (a 6-panel door) is basic with field smooth, its six panels given as six raised parts, and \"6-panel\" in unexplained; never refuse a 6-panel door. " +
      "The base only says where we start: everything you measure below is what we build, so give what is really there even where it differs from the base you named.",

    "3. LEAVES and MEET. `leaves` is how many leaves you see: 1 or 2 (3 for three or more). The latch leaf is the one with the handle; on a single door it is the only leaf. " +
      "`hingeSide` is left or right as seen in this photo: on a single door, the side its hinges are on; on a double door, the side the latch leaf is on (each leaf hinges on its own outer edge). " +
      "Give each leaf's four corners in measure.leaves and, on a double door, the meeting line in measure.meet: two points on the joint between the leaves, one near the top and one near the bottom.",

    "4. FRAME and RAILS. measure.rails: every horizontal rail across a leaf, the frame's top and bottom rails included, each as its top edge and its bottom edge. On a double door, give the rails of both leaves. " +
      "measure.stiles: the inner edge of each stile (the upright frame boards down each side of a leaf). Put the two points of an edge far apart along it.",

    "5. FIELD. `field` is v (vertical boards), h (horizontal boards), smooth (a flat sheet, no boards) or grooved (a flat sheet with vertical grooves cut in it). " +
      "measure.seams: the x of each joint between neighbouring boards, on every leaf (on level boards, the y of each joint instead). " +
      "`surface` is wood (natural or stained wood, its grain showing), painted (a solid paint colour, grain or none) or metal.",

    "6. BRACE and PANELS. `brace` is z (one diagonal brace across the whole leaf, crossing the mid rail), x (two crossing ones across the whole leaf) or none. " +
      "`panels` is the fill of each panel between the rails, bottom first, one entry per panel: none, z (one diagonal in that panel), x (an X in that panel), pickets (narrow vertical boards; give {\"fill\": \"pickets\", \"count\": n}), " +
      "vent (a louvred vent), raised (a raised panel), diamond (Classic's octagon round a diamond) or lite (glass; give {\"fill\": \"lite\", \"rows\": r, \"cols\": c} for its panes). " +
      "measure.braces: every diagonal board, in a panel or across the leaf, as its two ends (a and b, on its centre line) and its width (across: one point on each of its edges, straight across it).",

    "7. PARTS. measure.parts: anything that does not fill a whole panel. A window: {\"t\": \"lite\", \"box\": [corner, opposite corner], \"rows\": r, \"cols\": c}. A vent: {\"t\": \"vent\", \"box\": [...]}. " +
      "A raised panel: {\"t\": \"raised\", \"box\": [...]}. A board that is not a rail, a stile or a diagonal brace: {\"t\": \"board\", \"a\": end, \"b\": end, \"across\": [edge point, edge point], \"role\": \"frame\" or \"members\"}. " +
      "A door split to open top and bottom: {\"t\": \"split\", \"line\": [left end, right end]} along the split. On a double door, give each part on the leaf you see it on.",

    "8. HINGES and HANDLE. measure.hinges: each hinge you can see, as pivot (where it turns, at the leaf's hinge edge; on a butt hinge, the middle of its knuckle), tip (the far end of its strap; the pivot again when it has no strap) and across (its width where it is widest, one point on each edge). " +
      "hinges.type: tstrap (a strap that widens to a plate at the hinge edge: a T-strap), strap (a plain strap), scroll (a strap whose end curls), butt (small leaves on the door's edge, no strap on the face), hidden (no hinge shows), pintle (a strap hung on a pin set in the jamb) or pivot (a pivot door: it turns on pins in the head and the floor, set in from its edge, so no hinge shows on its edge or face). " +
      "measure.handle: the centre of the handle or latch; for a pull, its two ends instead, [top end, bottom end], so a long bar pull is its whole length. handle.type: barn (the standard shed and barn-door latch: a lever or bar on a back plate, mounted on a rail or stile, or a bar that drops into a catch), " +
      "lever (a lever handle on its own, with no back plate, as on a house or steel door), pull (a fixed pull), ring, thumb (a thumb latch) or none. " +
      "`lock`: thumbturn (a small turn knob on its own plate) or keyed (a key cylinder on its own plate) when the door has a lock of its own apart from the handle, else none; give its centre as measure.lock. " +
      "On a double door, meet.type: astragal (a narrow strip covering the joint) or overlap (one leaf's edge board runs past the joint over the other leaf).",

    "9. OBSERVED and UNEXPLAINED. `observed`: short phrases of a few words for what you see (\"two leaves\", \"one Z brace on each leaf\", \"three black T-strap hinges\"). " +
      "`unexplained`: short phrases for anything on the door that the words above cannot say (an arched top, a knob, leaves of different widths, a 6-panel door). Leave it empty when everything is said.",

    "10. REFUSE. `refuse` is null, or one word when we cannot build this door from this photo: not_door (there is no door), open (the door is open), blocked (more than 30% of the door is hidden behind something), " +
      "angled (taken too far to one side to measure), unsupported (a garage, roll-up, overhead or sliding track door, a bi-fold, or a door of 3 or more leaves). A 6-panel door is not unsupported. " +
      "When you refuse, still give `leaves`, and leave measure empty.",

    `11. MEASURE. Write the image's size in pixels first, as measure.size: [${w}, ${h}]. Then the points. Every point is [x, y] in this image's pixels, x from its left edge and y down from its top edge. ` +
      "Give pixel points, never estimates in inches or fractions. Put the two points of an edge far apart along it; for a width, one point on each edge, straight across. " +
      "Leave out a key you cannot see rather than guess at it: an empty list means you looked and there is none. " +
      "measure.colorAt: one point on each of infill (a board or panel), frame (a stile or rail), members (a brace or picket) and hardware (a hinge), wherever each shows plainly; leave out those the door does not have. " +
      "Points come first in the answer, before the words.",

    `Answer with this JSON object only, with no prose and no code fence:\n${JSON.stringify(DOOR_STAGE_A_ANSWER)}`,
  ].join("\n\n");
}

// ─── THE CLOSE-UPS ────────────────────────────────────────────────────────────────────────────────
// Each crop is a small window cut out of the straightened photo and enlarged 6 times (closeUp.ts's
// closeUpWindow and cutCloseUps). They decide the hardware types and finish only; lengths and positions
// come from Stage A's points. The builder's own close-up of that thing, when there is one, rides in the
// same ask after the crops.
export type DoorCloseUpAsk = "hinges" | "handle" | "meet";
export function doorCloseUpPrompt(ask: DoorCloseUpAsk, x: { crops: number; builderPhoto: boolean; widthIn?: number }): string {
  const imgs = `${x.crops} close-up${x.crops === 1 ? "" : "s"} cut out of a photo of a closed door and enlarged 6 times` +
    (x.builderPhoto ? `, then the builder's own photo of the same ${ask === "hinges" ? "kind of hinge" : ask === "handle" ? "handle" : "joint"}` : "");
  const finish = "finish: black (painted or black iron), galv (bare silver or galvanised steel) or bronze (dark brown or oil-rubbed metal)";
  if (ask === "hinges") {
    return `These images are ${imgs}. Each crop is centred on one of the door's hinges. Say what kind of hinge this is and its finish.\n` +
      "type: tstrap (a strap that widens to a plate at the door's hinge edge: a T-strap), strap (a plain straight strap), scroll (a strap whose end curls), " +
      "butt (two small leaves on the door's edge at a knuckle, no strap on its face), hidden (no hinge shows), pintle (a strap hung on a pin set in the jamb) or pivot (a pin in the head or floor, set in from the edge; nothing on the edge or face).\n" +
      `${finish}.\nAnswer with this JSON object only, with no prose and no code fence: {"type": "tstrap", "finish": "black"}`;
  }
  if (ask === "handle") {
    return `These images are ${imgs}. The crop is centred on the door's handle or latch. Say what kind it is and its finish.\n` +
      "type: barn (the standard shed and barn-door latch: a lever or bar on a back plate, mounted on a rail or stile, or a bar that drops into a catch), lever (a lever handle on its own, with no back plate, as on a house or steel door), " +
      "pull (a fixed pull handle), ring (a ring pull), thumb (a thumb latch) or none (no handle shows).\n" +
      `${finish}.\nAnswer with this JSON object only, with no prose and no code fence: {"type": "barn", "finish": "black"}`;
  }
  const strip = x.widthIn ? ` Each crop is ${inchText(x.widthIn / 8)} in wide on the door.` : "";
  return `These images are ${imgs}. The two crops are where the two leaves of a double door meet: one at mid-height and one at the bottom.${strip}\n` +
    "type: astragal (a narrow strip covering the joint between the leaves) or overlap (one leaf's edge board runs past the joint over the other leaf).\n" +
    "wIn: the width in inches of that strip or overlapping board, read against the crop's width.\n" +
    'Answer with this JSON object only, with no prose and no code fence: {"type": "astragal", "wIn": 1.5}';
}

// ─── STAGE B: ONE MORE LOOK, ONLY WHEN THE READS LEFT SOMETHING UNSAID ────────────────────────────
// Asked only when the agreement check found something the reads saw and the draft does not draw, or a
// read listed something unexplained. It may only add vocabulary the draft can hold, as points: parts. A
// part it gives is kept only when a Stage A read also had it (doorLook.ts keepStageBParts).
export function doorStageBPrompt(x: { photo: XY; widthIn: number; heightIn: number; padIn?: number; spec: DoorLook; missing: string[]; unexplained: string[] }): string {
  const [w, h] = x.photo;
  const said = [
    ...x.missing.map((p) => `"${p}" (you saw it, and the draft does not draw it)`),
    ...x.unexplained.map((p) => `"${p}" (you said our words cannot say it)`),
  ];
  return [
    `${DOOR_LOOK_PROMPT_ID}, second look. This is the same photo of a closed door, ${inchText(x.widthIn)} in wide and ${inchText(x.heightIn)} in tall, ${w} x ${h} pixels. ` +
      edgesText(w, x.widthIn, x.padIn ?? DOOR_EDGE_PAD_IN).trim(),
    `We built this draft from your first reading:\n${JSON.stringify(x.spec)}`,
    `It may be missing: ${said.join("; ")}.`,
    "Mark only what the draft is missing that these parts can say, with pixel points on this image: a window {\"t\": \"lite\", \"box\": [corner, opposite corner], \"rows\": r, \"cols\": c}, " +
      "a vent {\"t\": \"vent\", \"box\": [...]}, a raised panel {\"t\": \"raised\", \"box\": [...]}, a board {\"t\": \"board\", \"a\": end, \"b\": end, \"across\": [edge point, edge point], \"role\": \"frame\" or \"members\"}, " +
      "a split to open top and bottom {\"t\": \"split\", \"line\": [left end, right end]}. Do not repeat what the draft already has.",
    `Write the image's size first, as measure.size: [${w}, ${h}]. List anything still not said in unexplained, as short phrases.`,
    `Answer with this JSON object only, with no prose and no code fence:\n${JSON.stringify({ measure: { size: [0, 0], parts: [] }, refuse: null, unexplained: [] })}`,
  ].join("\n\n");
}

// ─── THE REQUEST ──────────────────────────────────────────────────────────────────────────────────
// One Messages request: the images first, then the text, as the building reads send them. Adaptive
// thinking at the effort given; max_tokens caps the thinking and the answer together.
export type DoorImageSource = { url: string } | { base64: string; mediaType: string };
export function doorImageBlock(img: DoorImageSource): Record<string, unknown> {
  return "url" in img
    ? { type: "image", source: { type: "url", url: img.url } }
    : { type: "image", source: { type: "base64", media_type: img.mediaType, data: img.base64 } };
}
export function doorRequestBody(x: { model: string; maxTokens: number; effort: "low" | "medium" | "high"; images: DoorImageSource[]; text: string }): Record<string, unknown> {
  return {
    model: x.model,
    max_tokens: x.maxTokens,
    thinking: { type: "adaptive" },
    output_config: { effort: x.effort },
    messages: [{ role: "user", content: [...x.images.map(doorImageBlock), { type: "text", text: x.text }] }],
  };
}

// ─── READING AN ANSWER ────────────────────────────────────────────────────────────────────────────
// The model's text to the JSON object it was asked for: the first `{` to the last `}`, so a stray code
// fence or a sentence round it still reads. Anything that is not one object reads as no answer.
export function doorAnswerOf(text: unknown): Record<string, unknown> | null {
  if (typeof text !== "string") return null;
  const a = text.indexOf("{"), b = text.lastIndexOf("}");
  if (a < 0 || b <= a) return null;
  try {
    const v = JSON.parse(text.slice(a, b + 1));
    return v && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : null;
  } catch {
    return null;
  }
}
