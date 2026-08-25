// Shared validation for a building style's 3D appearance spec (`building_styles.d3`),
// plus the prompt that drafts one from photos.
//
// Why this is shared rather than inline: two functions write this column —
// portal-settings (the builder, JWT-resolved) and admin-save-settings (the operator,
// ADMIN_PASSWORD) — and the column is emitted straight to every anonymous customer
// browser by get_config. Two copies of the sanitiser would drift, and the day they
// drift is the day the weaker one becomes the way in. Same reasoning as
// resolveTenant.ts existing at all.
//
// The rule for everything below: REBUILD a clean object from known keys. Never store
// what the caller sent. A colour string here ends up inside a customer's page, and a
// number here drives geometry a quote is built from.

export const D3_ROOF_TYPES = ["shed", "gable", "gambrel"] as const;

// The four claddings the renderer can draw, in the order Carolyn names them
// (2026-08-24): "panel siding, lap siding, board and batten, and metal".
//
// These are the ids in the renderer's D3_CLADDING table, so a style spec can now
// name any of them. Until 2026-08-25 this list was effectively ["batten","lap"]
// inline below, which meant a style could never persist `panel` or `agpanel` —
// the sanitiser rewrote them to null WITHOUT erroring, and null renders as panel.
// That is why "set this style to Metal" appeared to save and read back as Panel.
//
// `null` is still legal and still means "unset". It normalises to `panel` in the
// renderer (d3NormalizeCladding), which is what every existing row already does —
// so widening this list changes nothing for a style nobody re-saves.
export const D3_SIDING_VALUES = ["panel", "lap", "batten", "agpanel"] as const;

// Room for a genuinely steep roof and a deep overhang, but not for the values that
// make the renderer produce nonsense (a "pitch" of 40 draws a spike through the sky).
const CLAMPS: Record<string, [number, number]> = {
  pitch: [0, 2],
  ridgeOffset: [-0.35, 0.35],   // saltbox shift, as a fraction of the half-span
  overhang: [0, 3],             // feet past the wall
  kneeU: [0, 1],                // gambrel knee, fraction of half-span
  kneeRise: [0, 1],
  ridgeRise: [0, 1.5],
  // Rafter-tail spacing in INCHES, because that is the unit a builder measures
  // on-centre in. 8 is tighter than any real framing, 96 looser than any.
  tailSpacingIn: [8, 96],
};

const num = (v: unknown): number | null => {
  const n = typeof v === "string" ? Number(v) : v;
  return typeof n === "number" && Number.isFinite(n) ? n : null;
};
const clamped = (key: string, v: unknown): number | null => {
  const n = num(v);
  if (n === null) return null;
  const [lo, hi] = CLAMPS[key];
  return Math.min(hi, Math.max(lo, n));
};
// Hex only. This string is interpolated into a customer-facing page by the renderer,
// so "red", "url(...)", and anything else creative is dropped rather than argued with.
const hex = (v: unknown): string | null =>
  (typeof v === "string" && /^#[0-9a-fA-F]{3,8}$/.test(v.trim())) ? v.trim() : null;

export type D3Spec = {
  roof: Record<string, unknown>;
  siding: string | null;
  colors: Record<string, string>;
  wallHeightFt?: number;
  roofMaterial?: string;
  gableVent?: { widthFrac: number };
  claddingChoices?: string[];
};

export function sanitizeD3Spec(raw: unknown): { ok: true; d3: D3Spec } | { ok: false; error: string } {
  if (!raw || typeof raw !== "object") return { ok: false, error: "A 3D spec object is required." };
  const src = raw as Record<string, any>;
  const rawRoof = src.roof;
  if (!rawRoof || typeof rawRoof !== "object") return { ok: false, error: "The 3D spec needs a roof object." };

  const type = String(rawRoof.type || "");
  if (!(D3_ROOF_TYPES as readonly string[]).includes(type)) {
    return { ok: false, error: `Unknown roof type "${type}" — expected shed, gable or gambrel.` };
  }
  const roof: Record<string, unknown> = { type };
  for (const k of ["pitch", "ridgeOffset", "overhang", "kneeU", "kneeRise", "ridgeRise", "tailSpacingIn"]) {
    const v = clamped(k, rawRoof[k]);
    if (v !== null) roof[k] = v;
  }
  // Eave finish. "open" = exposed rafter tails and no fascia — the signature of the
  // Urban style, read off a walk-around video; "fascia" = the painted trim board the
  // renderer has always drawn.
  //
  // ABSENT is deliberate and means fascia. The renderer tests `=== "open"`, so every
  // row that predates this field keeps its exact render, and the deep-equal on `roof`
  // in styleD3.test.ts keeps passing. Emitting a default here would fail that test AND
  // silently write the default into every tenant's column the first time a builder
  // opens and saves the calibration panel.
  //
  // Not in the numeric loop above: `clamped()` destructures CLAMPS[key] and would
  // throw on a key with no entry.
  if (rawRoof.eave === "open" || rawRoof.eave === "fascia") roof.eave = rawRoof.eave;

  // Anything that is not a renderable cladding means "unset", which the renderer
  // draws as panel siding. Matches the AI validator's posture: drop what we cannot
  // draw rather than argue with it.
  const siding = (D3_SIDING_VALUES as readonly string[]).includes(String(src.siding))
    ? String(src.siding)
    : null;

  const colors: Record<string, string> = {};
  const rawColors = (src.colors && typeof src.colors === "object") ? src.colors : {};
  for (const k of ["body", "trim", "roof"]) {
    const c = hex(rawColors[k]);
    if (c) colors[k] = c;
  }

  const d3: D3Spec = { roof, siding, colors };
  const wh = num(src.wallHeightFt);
  if (wh !== null && wh >= 5 && wh <= 14) d3.wallHeightFt = wh;
  // The style's default roof MATERIAL (2026-08-15): the renderer textures the
  // roof with it before any customer roof-type pick. Same posture as siding —
  // anything unknown means "unset".
  if (src.roofMaterial === "shingle" || src.roofMaterial === "metal") d3.roofMaterial = src.roofMaterial;

  // A louvered gable vent at both ends, sized as a fraction of the span. Absent means
  // no vent, which is what every row that predates this field says by omission.
  //
  // Height is NOT a field: real gable vents run about 2:1 wide-to-tall and the renderer
  // derives it, so there is one number to get wrong instead of two.
  const gvRaw = src.gableVent;
  if (gvRaw && typeof gvRaw === "object") {
    const w = num((gvRaw as Record<string, unknown>).widthFrac);
    if (w !== null && w > 0) d3.gableVent = { widthFrac: Math.min(0.6, Math.max(0.05, w)) };
  }

  // Which claddings THIS style offers the customer (2026-08-25). Absent means all four,
  // which is what every existing row says by omission.
  //
  // Per-style rather than per-tenant on purpose: a Horse Shelter can be metal while a
  // Lofted Cabin is not, and `building_styles.d3` already round-trips through this
  // sanitiser, is already emitted per style by get_config, and already has both save
  // paths. A tenant-level flag would need a migration, a get_config regenerated from
  // pg_get_functiondef, and a new save action — days of work for a worse answer.
  //
  // Rebuilt from D3_SIDING_VALUES rather than filtered from the caller's array, so the
  // stored order is always canonical and unknown ids cannot ride along.
  if (Array.isArray(src.claddingChoices)) {
    const offered = src.claddingChoices as unknown[];
    const picked = (D3_SIDING_VALUES as readonly string[]).filter((id) => offered.includes(id));
    // Every box unticked would leave the customer no cladding at all. That is a slip,
    // not an instruction, so it reads as "unset" and falls back to all four.
    if (picked.length) d3.claddingChoices = picked;
  }

  // A spec is a handful of numbers. Anything approaching this size is either a mistake
  // or someone using a customer-visible jsonb column as free storage.
  if (JSON.stringify(d3).length > 4096) return { ok: false, error: "That 3D spec is implausibly large." };
  return { ok: true, d3 };
}

// Reference photos for a spec: http(s) only, capped in both count and length. These are
// handed to the vision model AND rendered as thumbnails in the editor.
//
// `max` defaults to 4, which is what `d3_photos` stores and what every existing caller
// wants. The walk-around-video path passes more, because eight frames of one orbit is
// what covers four elevations AND four corners when the pace of the walk is unknown.
// It is a parameter rather than a bigger constant because this same function guards the
// PERSISTED column: raising the floor for everyone would quietly let a save write twelve
// URLs into a jsonb column the editor renders as exactly four slots.
export function sanitizePhotoUrls(raw: unknown, max = 4): string[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((u): u is string => typeof u === "string" && /^https?:\/\//.test(u.trim()) && u.trim().length <= 600)
    .map((u) => u.trim())
    .slice(0, Math.min(12, Math.max(1, Math.floor(max) || 4)));
}

// Ported verbatim from calibrate-style so the drafted shape cannot drift from the
// shape the renderer consumes and the sanitiser above accepts.
export const SPEC_PROMPT = `You are calibrating a parametric 3D model of a portable building (shed/barn) to match the building in these photos.

Return ONLY a JSON object with this exact shape (no prose, no markdown fence):
{
  "roof": {
    "type": "shed" | "gable" | "gambrel",
    "pitch": <rise over run, e.g. 0.33 for 4:12>,
    "ridgeOffset": <-0.35..0.35, gable only: shifts the ridge toward one eave for a saltbox look; 0 if centred>,
    "overhang": <feet the roof projects past the wall, typically 0.3-1.0>,
    "kneeU": <gambrel only, 0..1: where the lower slope breaks, as a fraction of the half-span>,
    "kneeRise": <gambrel only, 0..1: height of the knee as a fraction of the half-span>,
    "ridgeRise": <gambrel only, 0..1.5: height of the ridge above the knee>
  },
  "siding": "panel" | "lap" | "batten" | "agpanel" | null,
  "colors": { "body": "#rrggbb", "trim": "#rrggbb", "roof": "#rrggbb" },
  "wallHeightFt": <estimated wall height, typically 6-10; doors are about 6.5 ft tall, use them for scale>
}

Judge the roof type from the silhouette: one slope = shed, two = gable, four (a break partway down each side) = gambrel.

SIDING is what the wall surface is made of:
- "panel" — flat vertical sheets with narrow grooves cut INTO them every 8 inches or so, all flush with each other. Sold as SmartSide, DuraTemp or T1-11. This is the most common; use it when the wall reads as plain vertical sheeting.
- "lap" — horizontal boards, each overlapping the one below, casting a shadow line every few inches.
- "batten" — vertical boards about 12-18 inches apart with a narrow strip of trim laid ON TOP of each seam, standing proud of the wall. If you can see raised strips with gaps between them, it is batten, not panel.
- "agpanel" — ribbed metal sheeting, with regular raised ribs running vertically and a metallic sheen.
Use null only if the frames genuinely do not show the wall surface.

Colors are the dominant UNPAINTED material colors. Estimate conservatively and use typical values when a photo does not show something.`;

// The walk-around-video variant of the prompt above. Same output shape, because it feeds
// the same sanitiser and the same renderer — but three things differ enough to be worth a
// separate string rather than a conditional paragraph:
//
//   1. The frames are ONE building filmed continuously, not four staged photos. On a
//      dealer lot that means neighbouring buildings drift through frame constantly, and a
//      model told nothing about it will happily average two sheds together.
//   2. The camera never leaves the ground, so the roof is only ever a silhouette. The
//      gable edge against the sky IS the pitch, and saying so is the difference between a
//      measured number and a guess. It also means a hip or a flat roof cannot be read at
//      all — the spec has no way to say either, so it must say so out loud instead of
//      quietly returning "gable".
//   3. SHAPE is the whole point. Size, colour and material are configurator settings the
//      customer changes afterwards, so a colour the model is unsure of costs nothing and a
//      roof type it gets wrong costs everything.
//
// `siding` is deliberately ABSENT from this prompt (2026-08-25). It used to be here, and
// because the model answers every key it was asked for, EVERY walk-around draft overwrote
// the builder's cladding choice with a guess read off ground-level frames. Dropping the key
// is why applyDraftedShape no longer carries a siding line: a prompt that never mentions it
// cannot return it, which is a stronger guarantee than a caller remembering not to apply it.
// The builder picks cladding from a four-way list one field below the video button.
//
// `observed` is deliberately OUTSIDE the spec. sanitizeD3Spec rebuilds from known keys and
// drops it, which is what we want — it is a note for the builder about what the video
// actually showed (doors, windows, vents), not geometry. The renderer has no field for any
// of it, so pretending otherwise in the spec would be a lie the sanitiser would catch.
export const VIDEO_SHAPE_PROMPT = `These images are frames from ONE continuous walk-around video of ONE portable building (a shed or barn). They are in walk order, so consecutive frames are adjacent viewpoints of the same building.

Your job is the SHAPE of that building. Its size, its colours and its materials are settings the customer picks later — do not spend effort on them.

Return ONLY a JSON object with this exact shape (no prose, no markdown fence):
{
  "roof": {
    "type": "shed" | "gable" | "gambrel",
    "pitch": <rise over run of one slope, e.g. 0.42 for 5:12>,
    "ridgeOffset": <-0.35..0.35, gable only: shifts the ridge toward one eave for a saltbox look; 0 if centred>,
    "overhang": <feet the roof projects past the wall, typically 0.3-1.5>,
    "kneeU": <gambrel only, 0..1: where the lower slope breaks, as a fraction of the half-span>,
    "kneeRise": <gambrel only, 0..1: height of the knee as a fraction of the half-span>,
    "ridgeRise": <gambrel only, 0..1.5: height of the ridge above the knee>
  },
  "colors": { "body": "#rrggbb", "trim": "#rrggbb", "roof": "#rrggbb" },
  "wallHeightFt": <wall height at the eave, typically 6-10; a door is about 6.5 ft, use it for scale>,
  "observed": {
    "roofNote": "<one sentence: how you read the roof, and any doubt about it>",
    "eave": "<how the eave is finished: exposed rafter tails, a plain fascia board, a boxed soffit, or unclear>",
    "doors": "<how many doors, on which face relative to the ridge (gable end or long side), single or double>",
    "windows": "<how many windows and roughly where, or 'none'>",
    "vents": "<gable vents, ridge vent, or none>",
    "confidence": "high" | "medium" | "low"
  }
}

How to read it:

ROOF TYPE, from the silhouette at a corner: one slope = "shed"; two slopes meeting at a ridge = "gable"; four slopes with a break partway down each side = "gambrel". If the roof is actually a HIP (slopes on all four sides, no vertical gable triangle) or FLAT, none of the three fit — return the closest, "gable" for a hip and "shed" for a flat, and say plainly in observed.roofNote that it is really a hip or flat and the shape will not match.

PITCH: find a frame looking straight at a gable end and read the slope of the roof edge against the sky, comparing its rise to its horizontal run. A roof that rises half as much as it runs is 0.5. Do not guess from a corner view, where perspective flattens it.

OVERHANG: how far the roof edge stands out past the wall below it, in feet, judged against a door for scale. Some styles are sold on a deliberately wide eave, so this number carries the look — do not default it to a middle value if the frames show a wide one.

WALL HEIGHT: the wall at the eave, not at the peak.

Ignore every OTHER building in the frames. On a sales lot the subject is usually the one that stays roughly centred as the camera moves around it; neighbours drift past in the background and are often a different model entirely.

Estimate conservatively. Where the frames genuinely do not settle something, use a typical value and set observed.confidence accordingly.`;

// Tolerant parse of a model reply: pull the first {...} out of whatever wrapping the
// model chose, then hold it to the same rules a hand-typed spec must satisfy.
export function parseModelSpec(text: string): { ok: true; d3: D3Spec } | { ok: false; error: string } {
  const m = String(text || "").match(/\{[\s\S]*\}/);
  if (!m) return { ok: false, error: "The model did not return a spec." };
  let parsed: unknown;
  try { parsed = JSON.parse(m[0]); } catch { return { ok: false, error: "The model returned malformed JSON." }; }
  return sanitizeD3Spec(parsed);
}

// The video prompt's `observed` block: notes for the builder about what the walk-around
// actually showed. Never stored, never rendered by the 3D engine — it exists because the
// spec has no field for a door, a window or a vent, and the builder about to place those
// by hand is better off being told what is on the tape than left to re-watch it.
//
// Rebuilt from known keys with hard caps for the same reason sanitizeD3Spec is: this is
// model output on its way into someone's browser. Returning `null` rather than an empty
// object when nothing survives keeps the caller's check to one truthiness test.
const OBSERVED_KEYS = ["roofNote", "eave", "doors", "windows", "vents", "confidence"] as const;
export type ObservedNotes = Partial<Record<typeof OBSERVED_KEYS[number], string>>;

export function parseObservedNotes(text: string): ObservedNotes | null {
  const m = String(text || "").match(/\{[\s\S]*\}/);
  if (!m) return null;
  let parsed: any;
  try { parsed = JSON.parse(m[0]); } catch { return null; }
  const src = parsed && typeof parsed.observed === "object" && parsed.observed ? parsed.observed : null;
  if (!src) return null;
  const out: ObservedNotes = {};
  for (const k of OBSERVED_KEYS) {
    const v = src[k];
    if (typeof v !== "string") continue;
    // Collapse whitespace so a multi-line answer cannot break the one-line readout.
    const clean = v.replace(/\s+/g, " ").trim().slice(0, 240);
    if (clean) out[k] = clean;
  }
  if (out.confidence && !["high", "medium", "low"].includes(out.confidence)) delete out.confidence;
  return Object.keys(out).length ? out : null;
}
