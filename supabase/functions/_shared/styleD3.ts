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
  ridgeOffset: [-0.35, 0.35],   // saltbox shift, as a fraction of the FULL span (d3RoofProfile: ru = S * ridgeOffset)
  overhang: [0, 3],             // feet past the wall
  // Gambrel knee, fraction of the half-span measured out from the CENTRELINE, so 1 is directly
  // above the wall: d3RoofProfile puts the knee at x = ±s2*kneeU. The prompts said only
  // "fraction of the half-span" until 2026-09-16, and a model measures in from the eave by
  // default -- a lofted barn came back 0.55 where the video frame measured 0.75, and drew as
  // a gable. Same class of defect as the ridgeRise datum below.
  kneeU: [0, 1],
  // BOTH rises are measured from the WALL PLATE, not from each other: d3RoofProfile does
  // kY = H + s2*kneeRise and rY = H + s2*ridgeRise off the same H. Describing ridgeRise as
  // "above the knee" anywhere makes every drafted gambrel come out inside-out, because the
  // model then reports the leftover and the renderer reads it as the whole height.
  kneeRise: [0, 1],
  ridgeRise: [0, 1.5],
  // Rafter-tail spacing in INCHES, because that is the unit a builder measures
  // on-centre in. 8 is tighter than any real framing, 96 looser than any.
  tailSpacingIn: [8, 96],

  // LEAN-TO and DORMER (2026-08-25). Both are ADDITIVE keys on `roof` rather than new
  // `roof.type` values, and that choice is load-bearing rather than stylistic.
  //
  // A new roof TYPE would be a live production hazard: one Supabase project serves beta
  // and production, `building_styles.d3` is one shared table, and the production
  // renderer's profile builder has an `else` branch that catches every unknown type and
  // draws a GABLE. So a builder calibrating "leanto" on beta would immediately show
  // production customers a plain gable on that style. As extra keys, an older renderer
  // simply does not read them and draws the base building correctly -- the appendage is
  // missing, which is honest, rather than the roof being wrong, which is not.
  //
  // A lean-to exists iff leanToWidthFt > 0; a dormer iff dormerWidthFt > 0. Zero is the
  // off switch, which is why every lower bound here is 0 rather than a real minimum.
  leanToWidthFt: [0, 16],     // feet the appendage projects past the eave wall
  leanToDropFt: [0, 6],       // how far its outer edge falls below the main eave
  dormerWidthFt: [0, 12],     // along the ridge
  dormerRiseFt: [0, 6],       // above the slope it sits on
  dormerOffsetU: [-1, 1],     // where along the span, as a fraction of the half-span
  // porchTruss has no range: it is a boolean, handled beside porchEnd rather than in the
  // numeric loop, because clamped() destructures CLAMPS[key] and throws on a key with no entry.
  // How far a recessed porch eats INTO the building, at a gable end. Not a projection: the
  // roof and the footprint do not move, the wall sets back. Same "0 is the off switch" rule
  // as the two above. 12 ft is past any shed porch anyone sells; the renderer clamps again
  // against the actual building so a 12 ft porch on a 12 ft shed cannot leave no building.
  porchDepthFt: [0, 12],
  // A PROJECTING porch (2026-09-17): a deck, posts and its own lower roof standing in front of
  // a gable end, not a recess cut into it. The end wall stays full height and the building
  // keeps its length; this is how far the posts stand out past that wall. It is deliberately
  // NOT porchDepthFt with a flag beside it: an older renderer reads porchDepthFt and would set
  // the wall 6 ft back INTO the building. Absent means no porch, and 0.5 or less is off, the
  // same "0 is the off switch" rule as the keys above.
  porchOutFt: [0, 12],
};

// Which eave the lean-to hangs off. Not a clamp, so it is checked separately.
const D3_LEANTO_SIDES = ["left", "right"] as const;
// The two dormers Carolyn named on 2026-08-28 @52:43-54:41. "What you have in here for a
// dormer right now is a gable dormer ... the other is a transom dormer, so we have two
// different dormers. This one runs the pitch that way, the other works like a lean-to --
// it comes off of the roof here and comes out here and then drops down."
//
// ABSENT means gable, deliberately: the renderer tests `=== "transom"`, so every row that
// predates this field keeps its exact render and styleD3.test.ts's deep-equal on `roof`
// keeps passing. Emitting a default here would fail that test AND write the default into
// every tenant's column the first time anyone opened and saved the calibration panel --
// the same reasoning `eave` below is built on.
const D3_DORMER_TYPES = ["gable", "transom"] as const;
// Which gable end a recessed porch opens at. ABSENT means "front", like dormerType's absent
// "gable": the renderer tests `!== "back"`, so a row that predates this field keeps its exact
// render and styleD3.test.ts's deep-equal on `roof` keeps passing. Emitting a default here
// would write it into every tenant's column the first time anyone saved the panel.
const D3_PORCH_ENDS = ["front", "back"] as const;

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
  roofProfile?: string;
  gableVent?: { widthFrac: number };
  foundation?: string;
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
  // ⚠️ A CLAMPS entry is not enough — a key missing from THIS list is dropped silently,
  // which looks to a builder exactly like "the save didn't work". Add to both.
  for (const k of ["pitch", "ridgeOffset", "overhang", "kneeU", "kneeRise", "ridgeRise", "tailSpacingIn",
                   "leanToWidthFt", "leanToDropFt", "dormerWidthFt", "dormerRiseFt", "dormerOffsetU",
                   "porchDepthFt", "porchOutFt"]) {
    const v = clamped(k, rawRoof[k]);
    if (v !== null) roof[k] = v;
  }
  // Which eave the lean-to hangs off. Only meaningful when leanToWidthFt > 0; stored
  // regardless so toggling the width back up remembers the side.
  if ((D3_LEANTO_SIDES as readonly string[]).includes(String(rawRoof.leanToSide))) {
    roof.leanToSide = String(rawRoof.leanToSide);
  }
  // Which of the two dormer shapes. Like leanToSide, stored whether or not dormerWidthFt is
  // currently above zero, so turning the width back up remembers the shape. Not in the
  // numeric loop above: clamped() destructures CLAMPS[key] and throws on a key with no entry.
  if ((D3_DORMER_TYPES as readonly string[]).includes(String(rawRoof.dormerType))) {
    roof.dormerType = String(rawRoof.dormerType);
  }
  // Which gable end the porch opens at. Stored whether or not porchDepthFt is currently above
  // zero, exactly like leanToSide and dormerType, so turning the depth back up remembers the
  // end. Out of the numeric loop for the same reason: clamped() destructures CLAMPS[key] and
  // would throw on a key with no entry.
  if ((D3_PORCH_ENDS as readonly string[]).includes(String(rawRoof.porchEnd))) {
    roof.porchEnd = String(rawRoof.porchEnd);
  }
  // The decorative king-post frame filling the porch gable. A BOOLEAN, so it sits here with
  // porchEnd rather than in the numeric loop above — clamped() would throw on a key with no
  // CLAMPS entry. Stored whether or not there is currently a porch, like porchEnd, so turning
  // the depth back up remembers it.
  //
  // ABSENT MEANS NO TRUSS, which is what keeps every style saved before today rendering exactly
  // as it did: the renderer tests the value as truthy, so a row that has never heard of this
  // field draws the plain gable it always drew.
  if (typeof rawRoof.porchTruss === "boolean") {
    roof.porchTruss = rawRoof.porchTruss;
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
  // A trim band across both gable ends at the top of the wall. A BOOLEAN, handled here like
  // porchTruss rather than in the numeric loop, because clamped() destructures CLAMPS[key] and
  // throws on a key with no entry. Only a real boolean is stored, and false IS stored.
  //
  // ABSENT MEANS NO BAND: the renderer tests the value as truthy, so every row saved before
  // this key existed keeps its exact render. Never emit a default here.
  if (typeof rawRoof.plateBand === "boolean") {
    roof.plateBand = rawRoof.plateBand;
  }
  // A porch is ONE kind or the other. With a projecting porch on, the recessed porch's depth
  // and its truss are dropped, because storing both would make the production renderer, which
  // knows only porchDepthFt, draw a recessed porch into a building that has a projecting one.
  // porchEnd is kept: both kinds use it to say which gable end.
  if (typeof roof.porchOutFt === "number" && roof.porchOutFt > 0.5) {
    delete roof.porchDepthFt;
    delete roof.porchTruss;
  }

  // Anything that is not a renderable cladding means "unset", which the renderer
  // draws as panel siding. Matches the AI validator's posture: drop what we cannot
  // draw rather than argue with it.
  const siding = (D3_SIDING_VALUES as readonly string[]).includes(String(src.siding))
    ? String(src.siding)
    : null;

  const colors: Record<string, string> = {};
  const rawColors = (src.colors && typeof src.colors === "object") ? src.colors : {};
  // `wood` (2026-09-17) is the natural lumber of a projecting porch: posts, deck, rafters and
  // ceiling. Absent means the renderer's own fallback, which is never written here.
  for (const k of ["body", "trim", "roof", "wood"]) {
    const c = hex(rawColors[k]);
    if (c) colors[k] = c;
  }

  const d3: D3Spec = { roof, siding, colors };
  // Wall height is CLAMPED into range rather than dropped, but only from a plausible band.
  // Dropping a 4.5 threw away a good near-miss and left the style default (often 8) standing,
  // which is further from the truth than the bound would have been. Clamping everything is
  // the opposite mistake: a model that answers in INCHES returns 96, and clamping that to 14
  // draws a two-storey wall on a garden shed. So anything a human could plausibly have meant
  // in feet gets pulled to the nearest bound, and anything outside that is a different unit
  // or a hallucination and is dropped, leaving the builder's own value alone.
  const wh = num(src.wallHeightFt);
  if (wh !== null && wh >= 3 && wh <= 20) d3.wallHeightFt = Math.min(14, Math.max(5, wh));
  // The style's default roof MATERIAL (2026-08-15): the renderer textures the
  // roof with it before any customer roof-type pick. Same posture as siding —
  // anything unknown means "unset".
  if (src.roofMaterial === "shingle" || src.roofMaterial === "metal") d3.roofMaterial = src.roofMaterial;
  // Which METAL a metal roof is drawn in (2026-09-15). ABSENT means AG Panel, the profile
  // Carolyn's shed builders install, so only a post-frame style's "standingseam" ever needs
  // storing and every row that predates this key renders as the renderer's default. Never
  // emit a default here: that would pin a tenant's column to whatever the default was on the
  // day they happened to save. Anything unrecognised is dropped, the roofMaterial posture.
  if (src.roofProfile === "agpanel" || src.roofProfile === "standingseam") d3.roofProfile = src.roofProfile;

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

  // What the building sits on. "skids" draws runners under a thin deck — the shadow gap
  // that says a building is portable rather than poured. Absent means the slab the
  // renderer has always drawn, so no existing row moves.
  if (src.foundation === "skids" || src.foundation === "slab") d3.foundation = src.foundation;

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
// `max` defaults to 4, which is now only a DEFENSIVE FALLBACK - no production caller relies
// on it any more, and the reasoning that used to be written here is retired rather than
// deleted, because it explains what changed. It read: "the default is what `d3_photos` stores
// ... raising the floor for everyone would quietly let a save write twelve URLs into a jsonb
// column the editor renders as exactly four slots."
//
// That last clause stopped being true on 2026-09-04, when "+ Another angle" shipped and the
// editor grew to CAL_PHOTO_MAX (12) slots - but the two persisted writers kept the 4-default,
// so a builder could add eight photos, watch a generation read all of them, press Save, and
// lose four with an HTTP 200 and no warning. Both `save_style_d3` writers now pass 12
// explicitly, matching the editor: four LABELLED views as a floor, twelve as the ceiling.
// The walk-around path passes 8 (SS_VID_FRAMES) into its own column.
//
// The 12 in the slice below is a hard ceiling on top of `max` and is pinned by styleD3.test.ts:
// no caller can raise it, whatever it asks for.
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
    "ridgeOffset": <-0.35..0.35, gable only: how far the ridge sits off the centreline toward one eave for a saltbox look, as a fraction of the building's FULL width, not of the half-span; 0 if centred>,
    "overhang": <feet the roof projects past the wall, typically 0.3-1.0>,
    "kneeU": <gambrel only, 0..1: how far the knee (where the steep lower slope meets the shallow upper one) sits out from the CENTRELINE under the ridge, as a fraction of the half-span -- NOT measured in from the eave. 1 would put the knee directly above the wall; a typical barn knee sits near the wall, about 0.7-0.85>,
    "kneeRise": <gambrel only, 0..1: height of the knee above the TOP OF THE WALL, as a fraction of the half-span>,
    "ridgeRise": <gambrel only, 0..1.5: height of the ridge above the TOP OF THE WALL, as a fraction of the half-span -- the same datum kneeRise uses, NOT measured up from the knee>
  },
  "siding": "panel" | "lap" | "batten" | "agpanel" | null,
  "colors": { "body": "#rrggbb", "trim": "#rrggbb", "roof": "#rrggbb" },
  "wallHeightFt": <estimated wall height, typically 6-10; doors are about 6.5 ft tall, use them for scale>
}

Judge the roof type from the silhouette: one slope = shed, two = gable, four (a break partway down each side) = gambrel. A real gambrel is a barn roof: a STEEP lower slope from the wall up to the knee, then a SHALLOW upper slope from the knee to the ridge. If the two slopes your numbers describe come out at about the same angle, you measured the knee from the wrong point.

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
//
// ⚠️ THE BASE, not the export. `videoShapePrompt(dims)` below is what callers use, and
// `VIDEO_SHAPE_PROMPT` is literally `videoShapePrompt(null)` — see that function's header for
// why the no-dims prompt has to remain the same string object it always was.
const VIDEO_SHAPE_BASE = `These images are frames from ONE continuous walk-around video of ONE portable building (a shed or barn). They are in walk order, so consecutive frames are adjacent viewpoints of the same building.

Your job is the SHAPE of that building. Its size, its colours and its materials are settings the customer picks later — do not spend effort on them.

Return ONLY a JSON object with this exact shape (no prose, no markdown fence):
{
  "roof": {
    "type": "shed" | "gable" | "gambrel",
    "pitch": <rise over run of one slope, e.g. 0.42 for 5:12>,
    "ridgeOffset": <-0.35..0.35, gable only: how far the ridge sits off the centreline toward one eave for a saltbox look, as a fraction of the building's FULL width, not of the half-span; 0 if centred>,
    "overhangIn": <inches the roof projects past the wall, 0 to 36; 0 means a flush eave>,
    "kneeU": <gambrel only, 0..1: how far the knee (where the steep lower slope meets the shallow upper one) sits out from the CENTRELINE under the ridge, as a fraction of the half-span -- NOT measured in from the eave. 1 would put the knee directly above the wall; a typical barn knee sits near the wall, about 0.7-0.85>,
    "kneeRise": <gambrel only, 0..1: height of the knee above the TOP OF THE WALL, as a fraction of the half-span>,
    "ridgeRise": <gambrel only, 0..1.5: height of the ridge above the TOP OF THE WALL, as a fraction of the half-span -- the same datum kneeRise uses, NOT measured up from the knee>,
    "eave": "open" | "fascia",
    "tailSpacingIn": <only when eave is "open": inches on centre between the rafter tails, typically 16 or 24>,
    "leanToWidthFt": <only if an open lean-to runs along one long side: how far it projects, in feet>,
    "leanToDropFt": <how far the lean-to's outer edge sits below the main eave, in feet, typically 1-2>,
    "leanToSide": "left" | "right",
    "dormerWidthFt": <only if a dormer sits on a roof slope: its width in feet>,
    "dormerRiseFt": <how far the dormer stands above the slope, in feet>,
    "dormerOffsetU": <-0.85..0.85: how far the dormer sits from the ridge line toward one eave, as a fraction of the half-span. This is a SIDEWAYS position across the roof, not a distance up the slope: 0 puts it on the ridge, 0.5 halfway out to the eave, and the sign picks the side (negative = left, positive = right, seen from outside facing the doors)>,
    "porchDepthFt": <only if a covered porch is recessed into one GABLE END under the main roof: how many feet of the building's length it takes up>,
    "porchEnd": "front" | "back",
    "porchTruss": <true only if decorative timber beams fill the gable ABOVE the porch opening>,
    "porchOutFt": <only if a porch STANDS OUT in front of one GABLE END under its own lower roof: how many feet its deck and posts project past that end wall>
  },
  "gableVent": { "widthFrac": <vent width as a fraction of the wall width, e.g. 0.25 for a 2 ft vent on an 8 ft wall> },
  "foundation": "skids" | "slab",
  "roofMaterial": "shingle" | "metal",
  "colors": { "body": "#rrggbb", "trim": "#rrggbb", "roof": "#rrggbb" },
  "wallHeightFt": <wall height at the eave, typically 6-10; a door is about 6 ft 8 in, use it for scale>,
  "observed": {
    "roofNote": "<one sentence: how you read the roof, and any doubt about it>",
    "porch": "projecting" | "recessed" | "none",
    "eave": "<how the eave is finished: exposed rafter tails, a plain fascia board, a boxed soffit, or unclear>",
    "doors": "<how many doors, on which face relative to the ridge (gable end or long side), single or double>",
    "windows": "<how many windows and roughly where, or 'none'>",
    "vents": "<gable vents, ridge vent, or none>",
    "confidence": "high" | "medium" | "low"
  }
}

How to read it:

ROOF TYPE, from the silhouette at a corner: one slope = "shed"; two slopes meeting at a ridge = "gable"; four slopes with a break partway down each side = "gambrel". A real gambrel is a barn roof: a STEEP lower slope from the wall up to the knee, then a SHALLOW upper slope from the knee to the ridge. If the roof is actually a HIP (slopes on all four sides, no vertical gable triangle) or FLAT, none of the three fit — return the closest, "gable" for a hip and "shed" for a flat, and say plainly in observed.roofNote that it is really a hip or flat and the shape will not match.

PITCH: find a frame looking straight at a gable end and read the slope of the roof edge against the sky, comparing its rise to its horizontal run. A roof that rises half as much as it runs is 0.5. Do not guess from a corner view, where perspective flattens it.

GAMBREL NUMBERS, only for a gambrel, from that same frame straight at a gable end. Measure all three from the CENTRELINE under the ridge and the TOP OF THE WALL, and divide each by the distance from the centreline to the wall: kneeU is how far the knee sits out from the centreline, kneeRise is how high the knee sits above the wall, ridgeRise is how high the ridge sits above the wall. Example: a 12 ft wide barn with its knee 1.5 ft in from each wall and 4.3 ft above it, and the ridge 6.2 ft above the wall, is kneeU 0.75, kneeRise 0.72, ridgeRise 1.03. Check before you answer: kneeRise / (1 - kneeU) is the steepness of the lower slope and (ridgeRise - kneeRise) / kneeU is the upper; the lower must come out clearly larger, or you measured from the wrong point.

OVERHANG: how far the roof edge stands out past the wall below it, in INCHES, judged against a door for scale. Read it from a frame looking along a long side, where the roof edge and the wall below it are both in view. 0 is a real answer and an ordinary one: a flush eave is the wall running straight up into the roof edge, with no shadow under it and nothing to see from below, and a building built that way is as common as one with a deep eave. 2 inches and 16 inches are both common answers and they look nothing alike, so give the one this building shows. Some styles are sold on a deliberately wide eave, so this number carries the look.

WALL HEIGHT: the wall at the eave, not at the peak.

EAVE FINISH, from a frame looking along a long side at the underside of the roof edge. There are two possibilities and they look nothing alike once you know to look: a continuous painted board running the whole length, level and unbroken, is "fascia"; a repeating row of raw unpainted wood blocks projecting below the roof with gaps of open air between them is "open" — exposed rafter tails, which give the bottom of the roof a sawtooth outline rather than a straight line. If it is "open", count the blocks along a run you can measure against the wall and give the spacing in inches — 24 is the common one, 16 the next. If you cannot see under the eave in any frame, omit both keys rather than guessing; omitting them means the fascia we already draw.

GABLE VENT: a louvered opening set in the gable triangle, above the top of the wall. Give its width as a fraction of the WALL's width, not of the triangle. Omit the whole gableVent object if the gable ends carry no vent — that is common and is not a failure to see one.

ROOF MATERIAL: asphalt shingles are laid in overlapping courses, so the slope carries a horizontal line every few inches and the surface looks granular. Metal is long continuous panels running UP the slope with raised ribs a foot or so apart, and it catches light in hard streaks rather than evenly. Judge it from the frame where the roof fills most of the picture; on an overcast day the giveaway is the direction of the lines — across the slope means shingle, up it means metal.

LEAN-TO: an open roofed section running along one LONG side, its outer edge carried on posts rather than a wall — an equipment bay, or a porch down the side. Only report one if the posts are actually there; a deep eave overhang is not a lean-to. Give how far it projects from the wall in feet, how far its outer edge drops below the main eave, and which side it is on as seen by someone standing outside facing the doors. ⚠️ A lean-to PROJECTS OUT from a long wall and its roof is a separate, lower slope. If what you are looking at is a porch at the SHORT end of the building (tucked under the main roof with the ridge carrying straight over it, or standing out in front of that end under its own lower roof) that is not a lean-to. It is a PORCH or a PROJECTING PORCH, and each has its own field below. Reporting a gable-end porch as a lean-to draws a lump on the wrong side of the wrong wall.

PORCH TRUSS: with a porch, look at the TRIANGLE of gable wall directly above the porch opening. If heavy timber beams are fixed across it in a decorative pattern — typically an upright post running from the horizontal header up to the peak, with two diagonal braces angling up to meet it, so the triangle reads as a timber frame rather than as flat siding — set porchTruss true. It is usually raw or stained wood against a painted gable, so it stands out clearly. A plain gable above the porch, even one with a vent in it, is porchTruss false.

PORCH: a covered area recessed into one GABLE END — the short end, the one with the triangle. The main roof does not change at all: the same ridge and the same two slopes simply carry on over the porch, and the outer corners are held up by posts instead of walls, usually with a decorative timber truss filling the gable above them. Look for the wall with the door standing BACK from the end of the roof rather than flush with it, so the end of the building is open air under the same roof for the first few feet. Give porchDepthFt as how far the porch eats INTO the building's length — a 12x24 with an 8 ft porch is still a 12x24, with 16 ft of enclosed room and 8 ft of porch. Typical depths are 4 to 8 feet. Say which end it opens at: "front" is the end you would walk up to, which is the end the door is on. If instead the end wall runs full height with the door in it, and the porch stands in front of that wall under a separate lower roof, it is a PROJECTING PORCH, below, and porchDepthFt stays out. Omit both keys if the building is enclosed to both ends, which is the common case.

PROJECTING PORCH: a porch built IN FRONT of one GABLE END instead of cut into it. The end wall runs full height from the floor to the top of the wall, with the door in it, and the main roof stops at that wall exactly as it would with no porch. In front of the wall stands a deck at floor level with posts along its outer edge, covered by its own separate roof: a low, nearly flat slope, usually about 2:12, that starts on the end wall just under the top of the wall and falls away over the posts. From the front you see TWO roof edges, the gable's and the porch's lower one below it. Three things settle it from the ground, and all three survive a walk-around: the end wall runs UNBROKEN from the floor to the top of the wall, with nothing cut out of it; the porch ceiling is nearly level while the main roof above it slopes away to the ridge; and from the side the porch sticks out PAST the end of the building instead of sitting inside it. Give porchOutFt as how far the posts stand out from the end wall, in feet, typically 4 to 8; a 12x24 with a 6 ft projecting porch is still a 12x24. Say which end with porchEnd, exactly as for a recessed porch. A porch is one kind or the other: if you give porchOutFt, leave porchDepthFt and porchTruss out.

PORCH DECISION, REQUIRED: observed.porch must carry one of exactly three answers on EVERY building — "projecting" for a porch standing out in front of a gable end under its own lower roof, "recessed" for one cut into a gable end under the main roof, "none" for a building closed to both ends. Answer it even when the answer is "none", and answer it even when you are unsure; say the doubt in observed.roofNote instead of leaving the key out. Naming a porch obliges you to give its field: "projecting" means porchOutFt, "recessed" means porchDepthFt and porchEnd. Do not report a porch here and leave its number out of the roof.

DORMER: a small roofed box sitting ON one of the main roof slopes, breaking its line. Give its width, how far it stands above the slope, and how far ACROSS the roof it sits -- measured sideways from the ridge line toward one eave, as a fraction of the half-span, negative for the left side and positive for the right as seen from outside facing the doors. Omit all three keys if the roof is unbroken, which is the common case.

FOUNDATION: look at the very bottom of the building. "skids" means it is raised on runners, with a visible shadow gap underneath and often blocks or shims between the runners and the ground — the normal look for a building that gets delivered on a trailer. "slab" means the walls meet the ground with no gap. Omit if the bottom is never visible.

Ignore every OTHER building in the frames. On a sales lot the subject is usually the one that stays roughly centred as the camera moves around it; neighbours drift past in the background and are often a different model entirely.

Where the frames genuinely do not settle something, say so in observed and OMIT the key. Omitting a key leaves the builder's existing setting alone, which is better than a typical value they then have to find and undo. Do not fill a field with the middle of its stated range.`;

// ─── The three numbers the builder measured (2026-09-19) ──────────────────────────────────
// Wall height came back 7 in 74 % of every recorded generation and was never once above 8, on
// buildings whose walls measure 9. That is not a model reading a wall badly; it is a model with
// no ruler being asked for a length. A phone at chest height sees no roof plane and no datum,
// and the only scale in the frame is a door it has to guess the height of first.
//
// So the builder is asked instead. Width, length and wall height are typed in before Generate
// and travel with the request; the prompt states them as facts and drops `wallHeightFt` from the
// schema entirely, because a number that is known must not also be estimated.
//
// WHAT THIS IS NOT. It is NOT a new stored field: nothing here reaches `building_styles.d3`
// except `wallHeightFt`, which is an existing d3 key that already means exactly this. Width and
// length stay out of the column deliberately — one style sells at up to 21 sizes and the
// renderer takes its width from the customer's pick, so a width on the style would be a second,
// lying answer to a question the catalog already answers. They are the ruler for this one
// reading and they belong on the ledger row, nowhere else.
export type KnownDims = {
  widthFt: number;
  lengthFt: number;
  wallHeightFt: number;
  // The eave, in inches, ONLY when the builder measured it. Absent means "read it off the
  // video", which is the chip the panel defaults to — so absent here is never "0 inches".
  overhangIn?: number;
};

// The bands, and why each one is where it is.
//
// These are REFUSALS, not clamps, and that is the whole point of parsing before the ledger row:
// a number outside them is a typo or a different unit, and the two costly ways to be wrong are
// to spend $20 telling the model a lie, or to state it in the prompt and then have the sanitiser
// silently drop it so the spec keeps a value the prompt contradicted.
//
// WALL HEIGHT's band is `sanitizeD3Spec`'s OWN accept band (3..20), not its 5..14 clamp, and the
// gap between the two is deliberate: inside 3..20 the existing clamp does the whole job, exactly
// as it already does for a model-drafted wall, so there is one clamp rather than two that can
// drift apart. Outside it the sanitiser would DROP the value — the prompt would say 30 ft and
// the spec would quietly keep the style's old wall — so it is refused here, before any cost.
const DIM_BANDS: Record<string, [number, number]> = {
  widthFt: [4, 60],        // a 4 ft dog kennel to a 60 ft post-frame span
  lengthFt: [4, 100],
  wallHeightFt: [3, 20],
  overhangIn: [0, 36],     // the range the prompt itself states, and /12 lands inside CLAMPS.overhang
};
// Builder's words for the refusal message. This string is shown to whoever pressed Generate.
const DIM_WORDS: Record<string, string> = {
  widthFt: "width",
  lengthFt: "length",
  wallHeightFt: "wall height",
  overhangIn: "overhang",
};
const DIM_UNITS: Record<string, string> = {
  widthFt: "feet", lengthFt: "feet", wallHeightFt: "feet", overhangIn: "inches",
};

// ABSENT IS NOT AN ERROR AND AN ERROR IS NOT ABSENT — the distinction is the whole safety
// property, which is why the return type carries three outcomes and not two.
//
//   { ok: true,  dims: null }  no dims were sent. Every existing caller, and production's older
//                              browser bundle, land here and behave exactly as they do today.
//   { ok: true,  dims }        three good numbers. The prompt gets a ruler.
//   { ok: false, error }       something was sent and it is not usable. The caller answers 400
//                              BEFORE the ledger row and before the wallet hold.
//
// Collapsing the third case into `null` is the tempting version and it is the dangerous one: a
// mistyped 140 ft width would silently become "no dims", the builder would be charged, and the
// draft would come back read against a scale nobody stated. Junk NEVER throws — this runs on an
// unauthenticated-shaped payload inside a function that must answer, not crash.
export function parseKnownDims(raw: unknown): { ok: true; dims: KnownDims | null } | { ok: false; error: string } {
  if (raw === undefined || raw === null) return { ok: true, dims: null };
  if (typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, error: "The building's dimensions were sent in a shape we cannot read." };
  }
  const src = raw as Record<string, unknown>;
  // An EMPTY object is "no dims", not a refusal: a caller that always sends the key and leaves it
  // blank is describing the same state as one that omits it.
  if (Object.keys(src).length === 0) return { ok: true, dims: null };
  const out: Record<string, number> = {};
  for (const key of ["widthFt", "lengthFt", "wallHeightFt"]) {
    const n = num(src[key]);
    if (n === null) {
      return { ok: false, error: `Type the building's ${DIM_WORDS[key]} before generating — all three measurements are needed.` };
    }
    const [lo, hi] = DIM_BANDS[key];
    if (n < lo || n > hi) {
      return { ok: false, error: `A ${DIM_WORDS[key]} of ${n} ${DIM_UNITS[key]} does not look right — it has to be between ${lo} and ${hi}. Check what you typed.` };
    }
    out[key] = n;
  }
  // OPTIONAL, and absent has to survive as absent: "read it off the video" is a real answer and
  // it is the chip the panel starts on. Only null/undefined means absent, never 0 — a flush eave
  // IS 0, which is the answer this whole change exists to make sayable.
  if (src.overhangIn !== undefined && src.overhangIn !== null && src.overhangIn !== "") {
    const n = num(src.overhangIn);
    if (n === null) return { ok: false, error: "The overhang has to be a number of inches, or left for us to read off the video." };
    const [lo, hi] = DIM_BANDS.overhangIn;
    if (n < lo || n > hi) {
      return { ok: false, error: `An overhang of ${n} inches does not look right — it has to be between ${lo} and ${hi}. Check what you typed.` };
    }
    out.overhangIn = n;
  }
  return { ok: true, dims: out as unknown as KnownDims };
}

// Feet with the trailing zeros off: 9 rather than 9.0, 8.5 rather than 8.50. The prompt reads
// like a builder wrote it or it reads like a form dump, and a model reconciling "8.50 ft" against
// a frame is being given false precision.
const dimFt = (n: number): string => String(Math.round(n * 100) / 100);

// THE PROMPT WITH A RULER IN IT.
//
// `videoShapePrompt(null)` IS `VIDEO_SHAPE_PROMPT` — the same string, asserted by a test whose
// only job is to say so. That identity is what makes this commit deployable while production runs
// an older browser bundle that cannot send dims: production's requests carry no `dims`, so they
// take this branch and get byte-for-byte the prompt they got yesterday. Nothing about the no-dims
// path is re-derived, re-templated or re-worded here; it is returned.
//
// WHERE THE BLOCK GOES, and it is not cosmetic: immediately after the FIRST BLANK LINE, inside
// the body `combinedShapePrompt` inherits. That function replaces everything up to the first
// blank line and keeps the rest, so a preamble placed above it would be eaten on every combined
// generation — silently, with a prompt that still reads perfectly well. A test pins it.
//
// The wall height is removed from the schema by REPLACEMENT of two exact strings rather than by a
// regex over the shape. If a future edit rewords either one, the replacement becomes a no-op and
// the dims prompt would both state the wall as a fact and ask for it as a guess. That is the one
// failure here that is invisible from the outside, so it is the one the tests assert hardest:
// they check the dims variant does not contain `wallHeightFt` at all.
const WALL_HEIGHT_SCHEMA_LINE = `  "wallHeightFt": <wall height at the eave, typically 6-10; a door is about 6 ft 8 in, use it for scale>,\n`;
const WALL_HEIGHT_PARAGRAPH = `WALL HEIGHT: the wall at the eave, not at the peak.`;

export function videoShapePrompt(dims?: KnownDims | null): string {
  if (!dims) return VIDEO_SHAPE_BASE;
  const known = `KNOWN DIMENSIONS, MEASURED BY THE BUILDER. This building is ${dimFt(dims.widthFt)} ft wide across the gable end, ${dimFt(dims.lengthFt)} ft long down the side, and its wall is ${dimFt(dims.wallHeightFt)} ft high at the eave. Those three are facts, not estimates, and they are your ruler: read every proportion you report against them and never against a scale of your own. Where one of them already answers a question, do not re-estimate it from a door, a person or a typical building.`;
  const cut = VIDEO_SHAPE_BASE.indexOf("\n\n");
  // Defensive only: the base opens with a paragraph and a blank line, and has since it was
  // written. Returning the base unchanged is the safe direction if that ever stops being true —
  // a prompt with no ruler is the behaviour we have today, not a new failure.
  if (cut < 0) return VIDEO_SHAPE_BASE;
  const withKnown = `${VIDEO_SHAPE_BASE.slice(0, cut)}\n\n${known}${VIDEO_SHAPE_BASE.slice(cut)}`;
  return withKnown
    .replace(WALL_HEIGHT_SCHEMA_LINE, "")
    .replace(
      WALL_HEIGHT_PARAGRAPH,
      "WALL HEIGHT: already known — the builder measured it and it is stated above. Do not estimate it, do not report it, and do not bend the other numbers to fit some other wall height.",
    );
}

// The constant every existing caller and every existing test still imports. Same name, same
// value, and now derived from the one function rather than sitting beside it, so the two cannot
// drift: there is nothing to keep in step.
export const VIDEO_SHAPE_PROMPT = videoShapePrompt(null);

// ─── The builder's numbers over the model's (2026-09-19) ──────────────────────────────────
// Runs between `foldOverhangInches` and `sanitizeD3Spec`, which is the only position that works:
// after the model's own `overhangIn` has already become feet, and before the clamps.
//
// ⚠️ IT DOES NOT CONVERT THE MODEL'S `overhangIn`. That key is consumed by `foldOverhangInches`
// one step earlier and is gone by the time this sees the spec. `dims.overhangIn` is a DIFFERENT
// number — the builder's own measurement off the chips — and converting it here is not a second
// conversion of the first. Dividing whatever is found in `overhang` by 12 again would put a 16 in
// eave at 0.11 ft, which reads as flush and is the exact defect the inches rewrite exists to end.
//
// PURE, and the identity with no dims: it returns its input BY REFERENCE, which is what makes
// "production is untouched" a fact about object identity rather than a claim about deep equality.
//
// Nothing is deleted, because by here there is nothing left to delete: `wallHeightFt` is
// OVERWRITTEN (the model was not asked for one, but a model that volunteers one must not win over
// a tape measure) and `overhangIn` is already gone. Width and length are not written at all —
// they are the ruler for this reading, not properties of the style.
export function applyKnownDims(raw: unknown, dims?: KnownDims | null): unknown {
  if (!dims) return raw;
  // `Array.isArray` is not decoration: an array is `typeof "object"`, so without it a model reply
  // of `[]` would spread into `{ wallHeightFt: 9 }` — a spec-shaped object built out of something
  // that was never a spec. sanitizeD3Spec refuses both, but one of them refuses with "the 3D spec
  // needs a roof object" over a value this function invented.
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return raw;
  const src = raw as Record<string, unknown>;
  const out: Record<string, unknown> = { ...src, wallHeightFt: dims.wallHeightFt };
  if (dims.overhangIn !== undefined && dims.overhangIn !== null) {
    const roofSrc = (src.roof && typeof src.roof === "object") ? src.roof as Record<string, unknown> : null;
    // No roof object means the reply is unusable anyway and sanitizeD3Spec is about to say so.
    // Inventing one here would turn "the model returned nothing" into a spec with an eave on it.
    if (roofSrc) out.roof = { ...roofSrc, overhang: dims.overhangIn / 12 };
  }
  return out;
}

// The one thing a builder's own number can still lose to, said out loud.
//
// `sanitizeD3Spec` clamps a wall to 5..14 ft because that is what the renderer can draw. Inside
// parseKnownDims's 3..20 band there is room to type a 16 that comes back as a 14, and a silent
// clamp on a number the builder MEASURED is the worst kind: they typed it, they can see the
// preview is wrong, and nothing on screen connects the two. Composed into `roofNote` beside the
// gambrel and porch warnings, so it reaches production's older panel with no browser change.
//
// Only the wall height can clamp. Width and length are never stored, and `overhangIn`'s 0..36
// band divides into exactly CLAMPS.overhang's 0..3 ft.
export function knownDimsNote(dims?: KnownDims | null): string | null {
  if (!dims) return null;
  const h = dims.wallHeightFt;
  const drawn = Math.min(14, Math.max(5, h));
  if (drawn === h) return null;
  return `Check the wall height before saving: you gave ${dimFt(h)} ft, and the 3D can only draw a wall between 5 and 14 ft, so it has been drawn at ${dimFt(drawn)} ft.`;
}

// A combined set is NOT what VIDEO_SHAPE_PROMPT describes, and saying so matters. That prompt
// opens by asserting every image is a consecutive frame of one lap; a combined generation appends
// the builder's own staged photographs, which are neither consecutive nor in walk order. Sending
// the video prompt unchanged - which is what shipped on 2026-09-07 - tells the model that four
// deliberately-aimed photographs are four more views of the same orbit, so a photo of the back
// reads as "the walk continued" and the shape gets reconciled against a lap that never happened.
//
// ONLY THE FIRST PARAGRAPH IS REPLACED. Everything after the first blank line - the JSON shape,
// the ground-level roof warning, the `observed` block - is reused verbatim, because the JOB is
// identical and a second copy of that spec is a second thing to keep in step. Split on the blank
// line rather than matching the sentence: a wording change to the first paragraph would otherwise
// silently turn this into a no-op that still returns a valid-looking prompt.
//
// `dims` (2026-09-19) is passed straight through to videoShapePrompt and never handled here. That
// is why the known-dimensions block sits AFTER the first blank line: this function keeps exactly
// the part of the body that starts there, so the ruler survives the splice for free and there is
// no second copy of it to write. A TWO-ARGUMENT CALL IS BYTE-IDENTICAL TO TODAY, which is what
// lets this deploy while production's browser bundle has never heard of dims.
export function combinedShapePrompt(videoCount: number, photoCount: number, dims?: KnownDims | null): string {
  const v = Math.max(0, Math.floor(videoCount || 0));
  const p = Math.max(0, Math.floor(photoCount || 0));
  const base = videoShapePrompt(dims);
  if (!v) return base;
  const cut = base.indexOf("\n\n");
  if (cut < 0) return base;
  const rest = base.slice(cut);
  const frames = v === 1 ? "image is a frame" : "images are frames";
  const shots = p === 1 ? "image is a photograph" : "images are photographs";
  const tail = p
    ? ` The REMAINING ${p} ${shots} the builder took deliberately, standing back from one side at a time. They are sharper and better framed than the video frames, so prefer them wherever the two disagree - but they are NOT part of the walk and are not in walk order.`
    : "";
  return `These images are all of ONE portable building (a shed or barn), from two sources.\n\nThe FIRST ${v} ${frames} cut out of one continuous walk-around video, in walk order, so consecutive frames are adjacent viewpoints.${tail}${rest}`;
}

// ─── overhangIn: the prompt asks in inches, the renderer stores feet (2026-09-19) ─────────
// The walk-around prompt used to ask for `overhang` in FEET, "typically 0.3-1.5". Exactly 1.0
// came back in 53 % of every recorded generation and in 3 of 3 on a building whose eave
// measures 0.15 ft — the top of the stated range, at zero variance. A range with a middle in
// it is an invitation to answer the middle. Inches with a 0 floor removes the invitation:
// 2 and 16 are different answers in a way 0.17 and 1.3 are not, and a flush eave finally has
// an honest number to be rather than a small fraction that reads as a rounding error.
//
// THE CONVERSION LIVES HERE, not in the sanitiser, and that is the load-bearing choice.
// `overhangIn` is a MODEL-REPLY key, never a stored one: giving it a CLAMPS entry and a place
// in the numeric loop would make it a second, parallel way to persist an eave in
// `building_styles.d3`, which the renderer — including production's older bundle — has never
// heard of. Folded into the existing `overhang` before sanitizeD3Spec runs, the existing
// 0..3 ft clamp does the whole job. No clamp moves, no new stored key, nothing top-level.
//
// Pure and shallow-copying. With no `overhangIn` anywhere it returns its input by reference,
// which is what keeps a hand-typed spec and every older reply byte-identical. `overhangIn`
// WINS over an `overhang` in the same reply, because inches is what this prompt now asks for;
// a model that answers the old key alone is still understood, which is what lets this commit
// deploy on its own without a browser release.
export function foldOverhangInches(raw: unknown): unknown {
  if (!raw || typeof raw !== "object") return raw;
  const src = raw as Record<string, unknown>;
  if (!src.roof || typeof src.roof !== "object") return raw;
  const roofSrc = src.roof as Record<string, unknown>;
  if (!("overhangIn" in roofSrc)) return raw;
  const roof: Record<string, unknown> = { ...roofSrc };
  delete roof.overhangIn;
  const inches = num(roofSrc.overhangIn);
  // Junk in the inches key drops it and leaves whatever `overhang` the reply carried, rather
  // than writing a 0 the model never said. 0 ITSELF is a real answer — the flush eave the
  // prompt now names — so the test is on null, never on truthiness.
  if (inches !== null) roof.overhang = inches / 12;
  return { ...src, roof };
}

// Tolerant parse of a model reply: pull the first {...} out of whatever wrapping the
// model chose, then hold it to the same rules a hand-typed spec must satisfy.
//
// THE ORDER OF THE THREE STEPS IS THE CONTRACT. `foldOverhangInches` turns the MODEL's inches
// into the stored feet key; `applyKnownDims` then puts the BUILDER's own numbers over the top;
// `sanitizeD3Spec` clamps whatever survives. Swapping the first two would let the model's eave
// beat a measured one, and moving either after the sanitiser would mean a second set of clamps.
// With no `dims` the middle step is the identity by reference, so an old caller's spec is the
// same object it has always been.
export function parseModelSpec(text: string, dims?: KnownDims | null): { ok: true; d3: D3Spec } | { ok: false; error: string } {
  const m = String(text || "").match(/\{[\s\S]*\}/);
  if (!m) return { ok: false, error: "The model did not return a spec." };
  let parsed: unknown;
  try { parsed = JSON.parse(m[0]); } catch { return { ok: false, error: "The model returned malformed JSON." }; }
  return sanitizeD3Spec(applyKnownDims(foldOverhangInches(parsed), dims));
}

// ─── Reading a Messages API reply (2026-09-17) ───────────────────────────────────────────
// The answer is EVERY `text` block joined in order, never `content[0].text`. The model this
// feature calls thinks adaptively by default, and when it decides to think the reply opens
// with a `thinking` block whose visible text is empty. Reading only the first block handed
// parseModelSpec an empty string, so an identical press failed or succeeded depending on
// whether the model chose to think, and every failure read "The model did not return a spec."
// The original standalone function (calibrate-style) filtered text blocks; the port into
// portal-settings did not.
//
// The other three fields are SHAPES for the failure log, never content: the stop reason, the
// block types (capped), and the output token count. None of them carries model text, so a
// log row built from them cannot leak what the model said about a building.
export type ModelReply = {
  text: string;
  stopReason: string | null;
  blockTypes: string[];
  outputTokens: number | null;
};

const MAX_LOGGED_BLOCK_TYPES = 8;

export function modelReplyText(data: unknown): ModelReply {
  const d = data && typeof data === "object" ? data as Record<string, unknown> : {};
  const content = Array.isArray(d.content) ? d.content : [];
  let text = "";
  const blockTypes: string[] = [];
  for (const block of content) {
    const b = block && typeof block === "object" ? block as Record<string, unknown> : null;
    const type = b && typeof b.type === "string" ? b.type : "unknown";
    if (blockTypes.length < MAX_LOGGED_BLOCK_TYPES) blockTypes.push(type.slice(0, 40));
    if (type === "text" && typeof b?.text === "string") text += b.text;
  }
  const usage = d.usage && typeof d.usage === "object" ? d.usage as Record<string, unknown> : null;
  const out = usage?.output_tokens;
  return {
    text,
    stopReason: typeof d.stop_reason === "string" ? d.stop_reason.slice(0, 40) : null,
    blockTypes,
    outputTokens: typeof out === "number" && Number.isFinite(out) ? out : null,
  };
}

// The video prompt's `observed` block: notes for the builder about what the walk-around
// actually showed. Never stored, never rendered by the 3D engine — it exists because the
// spec has no field for a door, a window or a vent, and the builder about to place those
// by hand is better off being told what is on the tape than left to re-watch it.
//
// Rebuilt from known keys with hard caps for the same reason sanitizeD3Spec is: this is
// model output on its way into someone's browser. Returning `null` rather than an empty
// object when nothing survives keeps the caller's check to one truthiness test.
// `porch` (2026-09-19) is the one key here the server READS rather than merely passes on:
// porchAgreementWarning checks it against the roof the same reply drafted. It is still prose
// in the same sense as the rest — nothing is stored from it and sanitizeD3Spec drops the whole
// block — but it is held to a three-word vocabulary, exactly as `confidence` is, so a model
// that answers in a sentence cannot be mistaken for one that answered the question.
const OBSERVED_KEYS = ["roofNote", "porch", "eave", "doors", "windows", "vents", "confidence"] as const;
export type ObservedNotes = Partial<Record<typeof OBSERVED_KEYS[number], string>>;

// The three answers the prompt forces observed.porch to, and the only three the agreement
// check understands. Exported because the same vocabulary has to appear in the prompt test.
export const OBSERVED_PORCH_KINDS = ["projecting", "recessed", "none"] as const;
export type PorchKind = typeof OBSERVED_PORCH_KINDS[number];

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
  // Out-of-vocabulary is DROPPED, never normalised. "a projecting porch on the front" is not an
  // answer to a three-way question, and porchAgreementWarning has a separate sentence for "you
  // did not answer" — turning a guess at the prose into an answer would silence that sentence.
  if (out.porch) {
    const p = out.porch.toLowerCase();
    if ((OBSERVED_PORCH_KINDS as readonly string[]).includes(p)) out.porch = p;
    else delete out.porch;
  }
  return Object.keys(out).length ? out : null;
}

// ─── A drafted gambrel that cannot look like one (2026-09-16) ─────────────────────────────
// A walk-around of a lofted barn drafted kneeU 0.55 / kneeRise 0.35 / ridgeRise 0.75. Every
// number was in range, the type said gambrel, and the read-back looked right. Rendered, the
// lower slope (0.35/0.45, 38 degrees) and the upper (0.40/0.55, 36 degrees) were two degrees
// apart, so the roof drew as a plain gable. The head-on frame measured 0.75 / 0.72 / 1.03.
//
// "The lower slope must be steeper than the upper" is the rule, but NOT as a bare inequality:
// that draft PASSES it (0.78 > 0.73). What the eye reads as a gambrel is the BEND at the knee,
// so the check is on the angle between the two slopes. Real ones bend a lot: the renderer's
// own default (0.55/0.55/0.8) bends 26 degrees, the measured barn 48, and a common 20:12 over
// 6:12 shed roof 32. Fifteen leaves room under all of those and is still eight times the draft.
export const GAMBREL_MIN_BEND_DEG = 15;

// FLAG, NEVER REJECT. A refusal would release the hold and throw away everything else the
// model read correctly (porch, colours, eave, the observed notes), and the same frames would
// most likely draft the same roof again. The builder reviews the draft before Save, so the
// useful act is to tell them where to look. Nor is the roof REPAIRED here: flipping kneeU
// (the obvious "measured from the eave" correction) makes that same draft worse, 0.64 below
// 0.89, because its kneeRise was wrong too. There is no safe guess, so none is made.
//
// Mirrors d3RoofProfile's defaults EXACTLY, including `||`: a 0 or absent kneeU draws at 0.55,
// so it is judged at 0.55. Checking the stored number instead would flag a roof that renders
// fine, or pass one that does not. (One thing the server cannot see: applyDraftedShape merges
// the draft over the style's current roof, so a key the model OMITS keeps the builder's value,
// not the default. Judging it at the default is the best reading available here.)
export function gambrelRoofWarning(roof: Record<string, unknown> | null | undefined): string | null {
  if (!roof || roof.type !== "gambrel") return null;
  const kneeU = Number(roof.kneeU) || 0.55;
  const kneeRise = Number(roof.kneeRise) || 0.55;
  const ridgeRise = Number(roof.ridgeRise) || 0.8;
  // Checked first and on its own: a ridge below the knee makes the "upper slope" negative,
  // which would score as an enormous bend and sail through the angle test.
  if (ridgeRise <= kneeRise) {
    return "Check this roof before saving: the gambrel came back with its ridge no higher than its knees, which cannot be right. Ridge rise has to be higher than Knee rise. Compare the preview with the end of the building.";
  }
  const deg = (rad: number) => (rad * 180) / Math.PI;
  const lower = deg(Math.atan2(kneeRise, 1 - kneeU));          // kneeU 1 = a vertical lower slope, 90
  const upper = deg(Math.atan2(ridgeRise - kneeRise, kneeU));
  if (lower - upper >= GAMBREL_MIN_BEND_DEG) return null;
  return "Check this roof before saving: the gambrel came back with its lower and upper slopes at almost the same angle, so it will look like a plain gable. A real gambrel has a steep lower slope and a shallow upper one. Compare the preview with the end of the building, then raise Knee rise or move the knee nearer the wall (Gambrel knee position, where 1 is right above the wall).";
}

// ─── the porch nobody reported (2026-09-19) ───────────────────────────────────────────────
// `porchOutFt` came back 0 times in 19 recorded generations, on a lot where a deck and posts in
// front of the gable end are ordinary; two of those replies said "recessed" and one said the
// building had no porch at all. On 2026-09-17 run 2 the model wrote "under the porch" in its own
// roofNote and handed back a roof with no porch key on it. Nothing caught that, because until
// now the reply had no place to state a porch except the geometry it was failing to state.
//
// `observed.porch` is that place, and this is what reads it back. TWO different failures with
// two different sentences, because they call for two different acts:
//
//   * "you did not answer" — the check could not be made. The builder should look, and that is
//     all that can honestly be said.
//   * "your answer contradicts your own numbers" — the draft is wrong one way or the other, for
//     certain, and only the building settles which.
//
// Folding those into one line would send a builder with a perfectly good draft off to re-check
// it, which is how a warning stops being read.
//
// FLAGGED, NEVER REPAIRED, for the same reason gambrelRoofWarning is (see above): there is no
// safe guess about which half of a contradiction is the true one, and a refusal after the hold
// is taken would throw away everything else the same reply got right.

// What the DRAFT says, read the way the renderer reads it: the renderer tests the NUMBER, not
// the key's presence, so a porch key sitting at 0 is not a porch. A key the model omitted is
// not a porch here either — that is the same reading gambrelRoofWarning makes, and for the same
// reason: the merge keeps the builder's stored value, which the server cannot see.
export function draftPorchKind(roof: Record<string, unknown> | null | undefined): PorchKind {
  if ((num(roof?.porchOutFt) ?? 0) > 0) return "projecting";
  if ((num(roof?.porchDepthFt) ?? 0) > 0) return "recessed";
  return "none";
}

// Builder's words, not the schema's. "porchOutFt" means nothing to someone holding a phone.
const PORCH_IN_WORDS: Record<PorchKind, string> = {
  projecting: "a porch standing out in front of one end, on its own posts",
  recessed: "a porch cut into one end, under the main roof",
  none: "no porch",
};

export function porchAgreementWarning(
  roof: Record<string, unknown> | null | undefined,
  observed: ObservedNotes | null | undefined,
): string | null {
  const drafted = draftPorchKind(roof);
  const said = observed?.porch;
  if (!said || !(OBSERVED_PORCH_KINDS as readonly string[]).includes(said)) {
    return `Check the porch before saving: the video reading never said whether this building has a porch, so there was nothing to check the drawing against. It has been drawn with ${PORCH_IN_WORDS[drafted]}.`;
  }
  if (said === drafted) return null;
  return `Check the porch before saving: the video reading says this building has ${PORCH_IN_WORDS[said as PorchKind]}, but it has been drawn with ${PORCH_IN_WORDS[drafted]}. One of those is wrong and only the building settles which — compare the end of the building with the preview, then set the porch below to match.`;
}

// Puts a roof warning where the builder already looks: `roofNote` in the "What the model saw"
// panel, with confidence forced to "low", which that panel already renders in amber with
// "check the roof numbers below against the building". No browser change is needed for the
// warning to appear, and ai_style_calls.observed records it, so a flagged draft is a query.
//
// The warning goes FIRST and the model's own sentence is kept after it rather than replaced:
// it is usually right about everything but the numbers, and it is what a builder compares.
// Bounded like parseObservedNotes: the warnings are ours and fixed, the model's part is <= 240.
//
// SEVERAL WARNINGS COMPOSE (2026-09-19). A rest parameter rather than a second argument, so
// every existing two-argument call still means exactly what it meant, and so a third check
// later costs an argument rather than a rewrite. They are joined in the order given and NONE
// replaces another: a roof that is both a flat gambrel and a contradicted porch has two things
// wrong with it, and dropping either would send the builder to look at half the problem.
export function flagObservedNotes(
  observed: ObservedNotes | null,
  ...warnings: (string | null | undefined)[]
): ObservedNotes | null {
  const flags = warnings.filter((w): w is string => typeof w === "string" && w.length > 0);
  if (!flags.length) return observed;
  const own = observed?.roofNote ? ` The model's own reading: ${observed.roofNote}` : "";
  return { ...(observed || {}), roofNote: `${flags.join(" ")}${own}`, confidence: "low" };
}
