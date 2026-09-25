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

// The tallest wall the renderer draws, in feet (was 14 until 2026-09-24). Exported so the one
// other server copy that must agree — knownDimsNote's sentence below — reads it rather than a
// literal. The bottom stays 5. See the wall-height block in sanitizeD3Spec for the lock-step list.
export const WALL_HEIGHT_MAX_FT = 20;

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

  // ── THE v2 VOCABULARY (2026-09-24, "video → exact 3D") ────────────────────────────────────
  // Every key below is ADDITIVE and ABSENT MEANS TODAY'S RENDER, for the reason the lean-to
  // block above gives: one table serves beta and production, and the production renderer simply
  // does not read a key it has never heard of. None of them ever gets a default written here.
  //
  // Where the projecting porch's roof meets its wall: floor to the TOP of the porch roof, in
  // feet. Absent is today's "just under the top of the wall". 6 is a door's height, which no
  // porch roof starts below; 24 is past the tallest centre section the renderer draws.
  // Projecting porch only — dropped below unless porchOutFt is on.
  porchAttachFt: [6, 24],
  // The porch's width along its wall, centred on that wall (or on the centre section when the
  // building has side wings). Absent is the full wall, or the full centre section. Projecting
  // porch only, like porchAttachFt.
  porchWidthFt: [4, 60],
  // ENCLOSED lower wings along the eave sides, carved out of the footprint (a monitor barn, a
  // raised-centre house). Width is each wing's, measured in from its outer wall; 0 is the off
  // switch, exactly leanToWidthFt's rule. Gable and gambrel only — dropped below on a shed.
  wingWidthFt: [0, 16],
  // The wing roof's rise over run, falling AWAY from the centre. Absent is the renderer's 0.25.
  wingPitch: [0, 1.5],
  // Floor to the top of the CENTRE section's walls, where its own roof starts. Absent with wings
  // is the renderer's "wing roof top + 3 ft". 26 clears a two-storey centre over a 20 ft wall.
  centerEaveFt: [6, 26],
  // ── THE PORCH'S OWN FRAMING (2026-09-25) ── Projecting porch only, like porchAttachFt, and
  // absent is today's porch exactly.
  // How many posts stand along the porch's front edge, the two corner posts included. Absent is
  // the renderer's rule (one every 8.5 ft or less). A WHOLE number: the sanitiser rounds it after
  // clamping. 2 is the two corners; 8 is past any porch a portable building carries.
  porchPosts: [2, 8],
  // The porch roof's own rise over run. Absent is the renderer's solver (2:12, lowered only to keep
  // a door's height under the header). Given, it is still lowered where the wall is too short for
  // it, and the panel says so. 0.05 is the solver's own floor; 0.5 (6:12) is steeper than any
  // porch roof hung under a main roof's eave.
  porchPitch: [0.05, 0.5],
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
// ── THE FRONT, and the frame every left/right/front/back is read in (2026-09-24) ─────────────
// FRONT is the wall you walk up to: the one carrying the porch, or the main door when there is
// no porch. The builder's size "WxL" is W = that wall's length, L = the depth front to back.
// Either of the next two keys switches the renderer into that frame; with neither, EVERYTHING
// renders exactly as today (the portrait/landscape rule, porchEnd's old south/west rule, the
// shed's fixed high end). That is the whole back-compat story, so neither is ever defaulted.
//
// roof.front: is the FRONT wall a gable end ("gable": the ridge runs front to back) or a long
// eave wall ("eave": the ridge runs side to side)? Gable and gambrel only — a shed has no ridge.
export const D3_ROOF_FRONTS = ["gable", "eave"] as const;
// roof.highSide: which wall of a SHED is the tall one. front/back make the slope run front to
// back; left/right make it run across the front wall. Shed only. Geometric, never door-relative:
// the FRONT is fixed by the porch or the main door, so moving a window cannot rotate the roof.
export const D3_SHED_HIGH_SIDES = ["front", "back", "left", "right"] as const;
// roof.wingSide: which EAVE sides carry an enclosed lower wing. "front"/"back" exist for a
// building whose front is an eave wall; a side that is not an eave side is dropped by the
// renderer, not here, because the sanitiser cannot know which way a later edit will turn the roof.
export const D3_WING_SIDES = ["both", "left", "right", "front", "back"] as const;
// The keys that only mean something with a ridge. Dropped as a set on a shed.
const D3_WING_KEYS = ["wingSide", "wingWidthFt", "wingPitch", "centerEaveFt"] as const;
// roof.porchSteps (2026-09-25): where a set of steps leaves the projecting porch's deck, along its
// FRONT edge, as seen standing in front of the porch facing it (left is the viewer's left, the
// frame every left/right here is read in). Absent = no steps, which is every porch before today.
export const D3_PORCH_STEPS = ["left", "center", "right"] as const;
// ── WHAT THE BUILDING STANDS ON (top-level `foundation`; blocks and piers 2026-09-25) ──────────
// "slab" and "skids" draw at grade, as they always have. "blocks" (stacked 8x8x16 concrete blocks
// under the runners) and "piers" (round concrete piers) RAISE THE FLOOR off the ground: every
// building filmed so far sits up like that, and drawn at grade its porch steps came out as one
// 2-inch step and the building looked planted. Absent is still the slab every row has always drawn.
//
// ⚠️ PRODUCTION'S OLDER DESIGNER CANNOT HOLD THE TWO NEW VALUES. Its d3ResolveStyleSpec and its draft
// merge rewrite anything but skids/slab to null, and its renderer draws a slab for them (which is the
// honest fallback). So a save from that panel would ERASE a stored "blocks" or "piers" and the
// floor height with it. carryForwardFoundation below is the save paths' answer, the roofProfile
// precedent.
export const D3_FOUNDATIONS = ["skids", "slab", "blocks", "piers"] as const;
export const D3_RAISED_FOUNDATIONS = ["blocks", "piers"] as const;
// floorHeightFt: feet from the GROUND to the TOP OF THE FLOOR, at the FRONT (a site can slope; the
// front is where a builder measures and where the steps are). Kept only with blocks or piers.
// 0.3 is a floor sitting almost on the grass; 6 is a building on tall piers over a slope. A reading
// up to FLOOR_HEIGHT_ACCEPT_FT is pulled into that band (a 7 ft reading is someone's tall pier, not
// a unit error); anything past it is inches or a hallucination and is dropped, wallHeightFt's rule.
export const FLOOR_HEIGHT_FT: readonly [number, number] = [0.3, 6];
const FLOOR_HEIGHT_ACCEPT_FT = 8;
const isRaisedFoundation = (v: unknown): boolean => (D3_RAISED_FOUNDATIONS as readonly unknown[]).includes(v);

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
  floorHeightFt?: number;
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
                   "porchDepthFt", "porchOutFt",
                   // v2 (2026-09-24). APPENDED, so every existing spec keeps its key order.
                   "porchAttachFt", "porchWidthFt", "wingWidthFt", "wingPitch", "centerEaveFt",
                   // 2026-09-25, appended for the same reason.
                   "porchPosts", "porchPitch"]) {
    const v = clamped(k, rawRoof[k]);
    if (v !== null) roof[k] = v;
  }
  // A post count is a count. Rounded AFTER the clamp, so it stays inside 2..8 either way.
  if (typeof roof.porchPosts === "number") roof.porchPosts = Math.round(roof.porchPosts);
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
  // HOW the overhang is framed, which is a different question from how far it projects.
  // "extended" carries the whole rafter out past the wall, so the full tail — and the fascia
  // hung on it — keeps dropping as it projects; "notched" cuts the tail back on its underside,
  // leaving the deck on one straight plane with a level soffit stepping the underside back.
  // Carolyn drew both off paused walk-around frames (2026-09-18) and a four-inch tail really is
  // just extended, so both are offered rather than one replacing the other.
  //
  // ABSENT is deliberate and means "derive it from the overhang size, AT RENDER TIME" —
  // d3OverhangStyle in both designer twins, at half a foot. Exactly the `eave` posture: every
  // row that predates this field keeps its exact render, and the deep-equal on `roof` in
  // styleD3.test.ts keeps passing.
  //
  // ⚠️ NOTHING ANYWHERE WRITES THE DERIVED VALUE DOWN, and that is load-bearing rather than
  // tidiness: not this sanitiser, not d3ResolveStyleSpec, not the AI draft above, not the AR
  // scan. The moment a derived value is stored, raising the style's overhang stops re-framing
  // its eave and the field silently stops following the number it is documented to follow.
  // Only a builder's explicit pick in the calibration panel ever stores the key. (A first cut
  // derived it in d3ResolveStyleSpec, which is the layer the panel posts straight back — so it
  // froze into every tenant's column on the first save.)
  //
  // Not in the numeric loop above: `clamped()` destructures CLAMPS[key] and would throw on a
  // key with no entry. ⚠️ And a key missing from THIS rebuild is dropped without a word, which
  // looks to a builder exactly like "the save didn't work".
  if (rawRoof.overhangStyle === "notched" || rawRoof.overhangStyle === "extended") {
    roof.overhangStyle = rawRoof.overhangStyle;
  }
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
  } else {
    // The mirror image (2026-09-24): the attach height and the width describe a PROJECTING
    // porch's own roof, so without one they describe nothing. Dropped rather than stored for
    // later, unlike porchEnd, because a recessed porch has no roof of its own for them to move
    // and a renderer that one day reads them there would be reading a leftover.
    delete roof.porchAttachFt;
    delete roof.porchWidthFt;
    // The porch's posts and its roof's pitch (2026-09-25) are that roof's too.
    delete roof.porchPosts;
    delete roof.porchPitch;
  }

  // ── v2 ENUMS AND THE ROOF-TYPE RULES (2026-09-24) ──────────────────────────────────────────
  // Each enum follows leanToSide: a known word is stored, anything else is dropped without an
  // error, and absence is never filled in. Each is then held to the roof types it can describe,
  // because a stored key the renderer must ignore is a trap for the next edit: flip a shed with a
  // stale `front` on it to a gable and the building silently turns sideways.
  if ((D3_ROOF_FRONTS as readonly string[]).includes(String(rawRoof.front)) && type !== "shed") {
    roof.front = String(rawRoof.front);
  }
  if ((D3_SHED_HIGH_SIDES as readonly string[]).includes(String(rawRoof.highSide)) && type === "shed") {
    roof.highSide = String(rawRoof.highSide);
  }
  // Which sides carry a wing. Stored whether or not wingWidthFt is currently above zero, like
  // leanToSide, so turning the width back up remembers the side.
  if ((D3_WING_SIDES as readonly string[]).includes(String(rawRoof.wingSide))) {
    roof.wingSide = String(rawRoof.wingSide);
  }
  // Wings need a ridge to stand either side of. On a shed the whole set goes, numbers included —
  // after the numeric loop, which is where the numbers were written.
  if (type === "shed") {
    for (const k of D3_WING_KEYS) delete roof[k];
  }
  // Where the porch's steps leave its deck (2026-09-25). The enum posture above, and the porch
  // rule porchAttachFt follows: steps come off a PROJECTING porch's deck, so without one they
  // describe nothing and are dropped rather than stored for later.
  if ((D3_PORCH_STEPS as readonly string[]).includes(String(rawRoof.porchSteps))
      && typeof roof.porchOutFt === "number" && roof.porchOutFt > 0.5) {
    roof.porchSteps = String(rawRoof.porchSteps);
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
  //
  // `corner` and `fascia` (2026-09-24): the corner boards, and the fascia and rake boards along
  // the roof edges. A real building often has corners in the BODY colour and a fascia in the
  // ROOF colour while only the window casings are white, and one `trim` cannot say that. Absent
  // means `trim`, which is what every row saved before today draws; the server never writes it.
  for (const k of ["body", "trim", "roof", "wood", "corner", "fascia"]) {
    const c = hex(rawColors[k]);
    if (c) colors[k] = c;
  }

  const d3: D3Spec = { roof, siding, colors };
  // Wall height is CLAMPED into range rather than dropped, but only from a plausible band.
  // Dropping a 4.5 threw away a good near-miss and left the style default (often 8) standing,
  // which is further from the truth than the bound would have been. Clamping everything is
  // the opposite mistake: a model that answers in INCHES returns 96, and clamping that to the
  // top would draw a two-storey wall on a garden shed. So anything a human could plausibly have
  // meant in feet gets pulled to the nearest bound, and anything outside that is a different
  // unit or a hallucination and is dropped, leaving the builder's own value alone.
  //
  // The TOP moved from 14 to 20 on 2026-09-24, and now coincides with the accept band's: a two-
  // storey centre section or a tall cabin front is a real wall, and a builder who measured 16
  // was being drawn at 14. ⚠️ LOCK-STEP: the same 5..WALL_HEIGHT_MAX_FT lives in knownDimsNote
  // below, submit-estimate's upgrade clamp, d3WallHeightFromDelta in both designer twins, and
  // wallHeight_test. Change one, change all five.
  const wh = num(src.wallHeightFt);
  if (wh !== null && wh >= 3 && wh <= 20) d3.wallHeightFt = Math.min(WALL_HEIGHT_MAX_FT, Math.max(5, wh));
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
  // renderer has always drawn, so no existing row moves. "blocks" and "piers" (2026-09-25) raise
  // the floor off the ground (see D3_FOUNDATIONS); anything else is still dropped.
  if ((D3_FOUNDATIONS as readonly unknown[]).includes(src.foundation)) d3.foundation = src.foundation;
  // How high that raised floor stands, grade to floor top at the front. Only a raised foundation
  // has one: on a slab or skids the floor is at grade by definition, and the key is dropped rather
  // than carried where nothing reads it. Absent is the renderer's own default for the kind, and is
  // never written here.
  if (isRaisedFoundation(d3.foundation)) {
    const fh = num(src.floorHeightFt);
    if (fh !== null && fh > 0 && fh <= FLOOR_HEIGHT_ACCEPT_FT) {
      d3.floorHeightFt = Math.min(FLOOR_HEIGHT_FT[1], Math.max(FLOOR_HEIGHT_FT[0], fh));
    }
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

// ── A RAISED FOUNDATION SURVIVES AN OLDER PANEL'S SAVE (2026-09-25) ────────────────────────────
// The save paths' carry-forward for `foundation` "blocks"/"piers" and `floorHeightFt`, shared by
// portal-settings and admin-save-settings so the two cannot disagree (the roofProfile precedent,
// which each of them inlines for a key that absence alone could erase).
//
// ABSENCE IS NOT ENOUGH HERE. Production's designer resolves any foundation but skids/slab to
// null and SENDS `foundation: null`, and its draft merge can hand on a legacy draft's "slab"; it
// never sends floorHeightFt at all. So from a request WITHOUT frame "front" -- that older panel, and
// anything else that has not been taught the new values -- a foundation that is absent, null or
// "slab" while the row stores blocks or piers keeps the stored foundation, and its stored floor
// height with it. "skids" is still honoured: that panel's select offers it, so it is a real pick.
// The current panel sends frame "front" on every save (12-shell's onSaveSpec, the operator page's
// save), and gets exactly what it sent: it can set both keys, change them and clear them.
//
// Mutates `clean` (the sanitised spec about to be written). The stored height is held to the
// sanitiser's band again, because this is the one place a stored value is written back unread.
export function carryForwardFoundation(clean: D3Spec, sent: unknown, stored: unknown, frame: unknown): void {
  if (frame === PROMPT_FRAME_FRONT) return;
  if (!sent || typeof sent !== "object") return;
  const was = (stored && typeof stored === "object") ? stored as Record<string, unknown> : null;
  if (!was || !isRaisedFoundation(was.foundation)) return;
  const incoming = (sent as Record<string, unknown>).foundation;
  if (!(incoming === undefined || incoming === null || incoming === "slab")) return;
  clean.foundation = was.foundation as string;
  const fh = num(was.floorHeightFt);
  if (fh !== null && fh > 0 && fh <= FLOOR_HEIGHT_ACCEPT_FT) {
    clean.floorHeightFt = Math.min(FLOOR_HEIGHT_FT[1], Math.max(FLOOR_HEIGHT_FT[0], fh));
  } else {
    delete clean.floorHeightFt;
  }
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
// The walk-around path passes WALK_FRAME_MAX (SS_VID_FRAMES) into its own column.
//
// The 12 in the slice below is a hard ceiling on top of `max` and is pinned by styleD3.test.ts:
// no caller can raise it, whatever it asks for.
//
// WALK_FRAME_MAX went from 8 to 12 on 2026-09-24: eight frames of a lap gave one look at each
// side, and a building with a wing on BOTH sides, or a porch on its long front, needs the back
// and the far side seen too. It is the cap for EVERY place a walk's frames are kept or read —
// the generation's `video` source, and the d3_video_frames column both save paths write —
// because the self-check pairs a frame with a render only if the style STORES that frame, so a
// save that kept eight of twelve would quietly leave four views with nothing to compare.
// ⚠️ SHIP WITH THE BROWSER: the designer's SS_VID_FRAMES may only rise once this is deployed.
export const WALK_FRAME_MAX = 12;
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
//
// ⛔ FROZEN SINCE 2026-09-24. This is now ONLY the prompt of the LEGACY paths — a request without
// the builder's measurements, and (with the old ruler spliced in, legacyDimsPrompt) one with dims
// but without `frame: "front"` — and styleD3.test.ts pins both by hash. Every word the generator
// learns from here on goes into VIDEO_SHAPE_V2 below, which is what the rollout gate
// (wantsV2Prompt) sends the new designer, whose every request carries dims and the frame. Editing
// this string changes production's legacy paths and nothing else, so there is no reason left to.
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
  },
  "frameMap": {
    "front": { "frame": <1-based index of the image that looks most square-on at the gable end the door is on>, "azimuthDeg": <where you were standing for that image, to the nearest 45 degrees> },
    "side": { "frame": <the image most square-on to a long side>, "azimuthDeg": <as above> },
    "eaveCorner": { "frame": <the image where the roof edge along a long side reads most clearly against the sky>, "azimuthDeg": <as above> },
    "corner": { "frame": <an image showing one gable end and one long side at once, three-quarters on>, "azimuthDeg": <as above> }
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

FRAME MAP: which image goes with which view of the building. Number the images in the order you were given them, starting at 1, and name the ONE image that best shows each of the four views in frameMap. Count only the walk-around frames and never one of the builder's own photographs, which were taken separately and are not part of the lap. The same image may serve two views. A view you have no good image for should be LEFT OUT: naming an image that does not show it is worse than saying nothing, because that image is about to be put beside a drawing of that view and the builder asked to say whether the two match.

AZIMUTH: for each image you name, where the camera was standing, as an angle around the building to the nearest 45 degrees. 0 is square in front of the gable end the door is on. Going from there around the building toward its RIGHT side, 90 is square to the right-hand long side, 180 is square at the far gable end, and 270 is square to the left-hand long side. Right and left are as seen from outside facing the doors, the same way leanToSide and dormerOffsetU are read. Answer 0, 45, 90, 135, 180, 225, 270 or 315 and nothing in between -- this is a coarse note of where you stood, not a survey.

Where the frames genuinely do not settle something, say so in observed and OMIT the key. Omitting a key leaves the builder's existing setting alone, which is better than a typical value they then have to find and undo. Do not fill a field with the middle of its stated range.`;

// ─── THE v2 SHAPE PROMPT: "video → exact 3D" (2026-09-24) ─────────────────────────────────
// What every request WITH the builder's measurements gets. Two real buildings drove it, and each
// failed on something the base prompt had no words for:
//
//   * FARMSTAND, a one-slope cabin whose HIGH wall is its long FRONT, carrying a full-width porch
//     whose own roof meets that wall two feet below the main eave, with body-coloured corner
//     boards and roof-coloured fascia. The base could say none of that: its shed always slopes the
//     long way with the high end fixed, every porch sits at a gable end just under the top of the
//     wall, and one `trim` paints every board. It came back a gable with a recessed porch.
//   * TRI HOME, a raised-centre house: a two-storey gable centre whose ridge runs front to back,
//     an ENCLOSED single-storey wing down each side under its own lower roof, and a porch in front
//     of the centre only. The base has only the open, posts-carried lean-to, one side at a time,
//     and a wall clamped at 14 ft. It came back a 14 ft box.
//
// So it teaches, on top of everything the base already reads correctly (kept word for word where
// the tests pin it, and reworded only where "gable end" or "long side" stopped being true): the
// FRONT as the single frame every front/back/left/right is read in; `roof.front` and
// `roof.highSide`, the two keys that switch the renderer into that frame, as REQUIRED decisions;
// the porch on the front wall whichever kind of wall it is, with its attach height and width;
// SIDE WINGS against the lean-to, with their own REQUIRED decision beside the porch's; and colours
// as the paint looks in even daylight, including corner, fascia and porch wood.
//
// THE FIRST PROXY RUNS (2026-09-24, three per building on the app's own twelve frames) failed in
// four places, and the paragraphs below now teach a PROCEDURE for each rather than a definition:
// the shed's high side came back front, back and left for one cabin (one run read the porch's own
// lower roof as the main roof), so SHED HIGH SIDE reads the tall edge of the sloping end walls off
// the MAIN roof; the raised-centre house came back with ONE wing in two runs of three although
// the rear frames show both, so the WINGS DECISION looks at both sides and says "one" only on a
// named frame; one run called a posted, decked porch "recessed"; and one read the porch rafters
// as the main eave's finish. The worked examples use generic numbers, never the two test
// buildings' own, so an evaluation on those two measures reading rather than copying.
//
// THE REPLY IS KEPT SHORT ON PURPOSE. Thinking and the answer share one max_tokens, and a reply
// cut off anywhere loses the spec, the notes and the frame map together (one JSON object). Every
// new key is a short number or word; the prose lives in `observed`, capped at one phrase each.
//
// ⚠️ THE TESTS PIN, ACROSS BOTH PROMPTS: the schema lines for pitch, overhangIn and the three
// gambrel numbers, and the whole GAMBREL NUMBERS paragraph, are byte-identical to the base (the
// gambrel ratios measurably work — see the test); `wallHeightFt` appears nowhere in here; and
// the opening paragraph ends at the first blank line, because videoShapePrompt inserts the ruler
// there and combinedShapePrompt replaces everything above it.
const VIDEO_SHAPE_V2 = `These images are frames from ONE continuous walk-around video of ONE portable building (a shed, barn, cabin or small house). They are in walk order, so consecutive frames are adjacent viewpoints of the same building.

Your job is to describe this building exactly enough that a 3D model drawn from your answer looks like the video: its shape first, then its colours. Both matter. The builder is about to see your drawing beside these frames, and anything you got wrong is something they must find and fix by hand.

Return ONLY a JSON object with this exact shape (no prose, no markdown fence). Keep every observed string to one short phrase, under 20 words: your reasoning and this reply share one length limit, and a reply that runs out before its end is lost whole. Settle each REQUIRED decision once, from the frames named for it, and do not re-measure a number you have already given.
{
  "roof": {
    "type": "shed" | "gable" | "gambrel",
    "front": "gable" | "eave",
    "highSide": "front" | "back" | "left" | "right",
    "pitch": <rise over run of one slope, e.g. 0.42 for 5:12>,
    "ridgeOffset": <-0.35..0.35, gable only: how far the ridge sits off the centreline toward one eave for a saltbox look, as a fraction of the FULL width under that roof (the whole building's, or the centre section's on a building with side wings), not of the half-span; 0 if centred>,
    "overhangIn": <inches the roof projects past the wall, 0 to 36; 0 means a flush eave>,
    "kneeU": <gambrel only, 0..1: how far the knee (where the steep lower slope meets the shallow upper one) sits out from the CENTRELINE under the ridge, as a fraction of the half-span -- NOT measured in from the eave. 1 would put the knee directly above the wall; a typical barn knee sits near the wall, about 0.7-0.85>,
    "kneeRise": <gambrel only, 0..1: height of the knee above the TOP OF THE WALL, as a fraction of the half-span>,
    "ridgeRise": <gambrel only, 0..1.5: height of the ridge above the TOP OF THE WALL, as a fraction of the half-span -- the same datum kneeRise uses, NOT measured up from the knee>,
    "eave": "open" | "fascia",
    "tailSpacingIn": <only when eave is "open": inches on centre between the rafter tails, typically 16 or 24>,
    "leanToWidthFt": <only if an OPEN lean-to on posts runs along one side wall: how far it projects, in feet>,
    "leanToDropFt": <how far the lean-to's outer edge sits below the main eave, in feet, typically 1-2>,
    "leanToSide": "left" | "right",
    "wingSide": "both" | "left" | "right" | "front" | "back",
    "wingWidthFt": <only if ENCLOSED lower wings flank a taller centre section: each wing's width in feet, from its outer wall in to the centre section's wall>,
    "wingPitch": <the wing roof's rise over run, falling away from the centre>,
    "centerEaveFt": <feet from the floor to the top of the centre section's walls, where its own roof starts>,
    "dormerWidthFt": <only if a dormer sits on a roof slope: its width in feet>,
    "dormerRiseFt": <how far the dormer stands above the slope, in feet>,
    "dormerOffsetU": <-0.85..0.85: how far the dormer sits from the ridge line toward one eave, as a fraction of the half-span. This is a SIDEWAYS position across the roof, not a distance up the slope: 0 puts it on the ridge, 0.5 halfway out to the eave, and the sign picks the side as the DORMER paragraph says>,
    "porchDepthFt": <only if a covered porch is recessed into the front of the building under the main roof: how many feet of the building's depth it takes up>,
    "porchEnd": "front" | "back",
    "porchTruss": <true only if decorative timber beams fill the gable ABOVE the porch opening>,
    "porchOutFt": <only if a porch STANDS OUT in front of the FRONT wall under its own lower roof: how many feet its deck and posts project past that wall>,
    "porchAttachFt": <projecting porch only: feet from the floor to the TOP of the porch roof where it meets the wall>,
    "porchWidthFt": <projecting porch only, and only when it is narrower than its wall, or than the centre section on a building with side wings: its width along the wall, in feet>,
    "porchPosts": <projecting porch only: how many posts stand along the porch's front edge, the corner posts included>,
    "porchPitch": <projecting porch only: the porch roof's own rise over run>,
    "porchSteps": "left" | "center" | "right"
  },
  "gableVent": { "widthFrac": <vent width as a fraction of the width of the gable wall it sits in, e.g. 0.25 for a 2 ft vent on an 8 ft wall> },
  "foundation": "skids" | "slab" | "blocks" | "piers",
  "floorHeightFt": <blocks or piers only: feet from the ground up to the TOP of the floor, at the FRONT>,
  "roofMaterial": "shingle" | "metal",
  "colors": { "body": "#rrggbb", "trim": "#rrggbb", "roof": "#rrggbb", "corner": "#rrggbb", "fascia": "#rrggbb", "wood": "#rrggbb" },
  "observed": {
    "roofNote": "<one short sentence: how you read the roof and which way it runs, and any doubt>",
    "porch": "projecting" | "recessed" | "none",
    "wings": "both" | "one" | "none",
    "eave": "<exposed rafter tails, a plain fascia board, a boxed soffit, or unclear>",
    "doors": "<how many, on which wall (front, back, left, right), single or double>",
    "windows": "<how many and on which walls, or 'none'>",
    "vents": "<gable vents, ridge vent, or none>",
    "confidence": "high" | "medium" | "low"
  },
  "frameMap": {
    "front": { "frame": <1-based index of the image that looks most square-on at the FRONT wall>, "azimuthDeg": <where you were standing for that image, to the nearest 45 degrees> },
    "side": { "frame": <the image most square-on to the right-hand side wall, or failing that the left-hand one>, "azimuthDeg": <as above> },
    "eaveCorner": { "frame": <the image where the roof edge along an eave reads most clearly against the sky>, "azimuthDeg": <as above> },
    "corner": { "frame": <an image showing the FRONT wall and one side wall at once, three-quarters on>, "azimuthDeg": <as above> },
    "back": { "frame": <the image most square-on to the BACK wall, the one opposite the front>, "azimuthDeg": <as above> },
    "otherSide": { "frame": <the image most square-on to the side wall OPPOSITE the one you gave for side>, "azimuthDeg": <as above> }
  }
}

How to read it:

THE FRONT, which every front, back, left and right in this reply is read from. The FRONT is the wall you would walk up to: the one carrying a ROOFED porch, or the main door when there is no porch. An open deck, a stair or a ramp with no roof of its own over it does not decide the front. Left and right are as seen standing outside in front of it, facing it. The FRONT can be a gable end (the wall with the roof's triangle above it) or a long eave wall (the wall the roof edge runs level along). Both are common, so read it off the frames and never assume the front is the shorter wall.

ROOF TYPE, from the silhouette at a corner: one slope = "shed"; two slopes meeting at a ridge = "gable"; four slopes with a break partway down each side = "gambrel". A real gambrel is a barn roof: a STEEP lower slope from the wall up to the knee, then a SHALLOW upper slope from the knee to the ridge. If the roof is actually a HIP (slopes on all four sides, no vertical gable triangle) or FLAT, none of the three fit — return the closest, "gable" for a hip and "shed" for a flat, and say plainly in observed.roofNote that it is really a hip or flat and the shape will not match.

ROOF DIRECTION, REQUIRED on a two-slope or gambrel roof: roof.front says which kind of wall the FRONT is. "gable" when the front wall is a gable end: from the front you see the roof's triangle (or the barn's five-sided outline) and the ridge runs straight away from you, front to back. "eave" when the front wall is a long wall with the roof edge running level along its top: from the front you look up at a roof slope and the ridge runs side to side, parallel to the front wall. Settle it from the frame square to the front: a peak above the front wall is "gable", a level roof edge along it is "eave". Give it on every two-slope or gambrel building, even when the door is off to one side, and leave it out on a shed.

SHED HIGH SIDE, REQUIRED on a one-slope roof: roof.highSide says which wall is the HIGH one. The high wall is the tallest wall of the building: the MAIN roof starts along its top and falls away from it to the low wall opposite. Settle it in three steps, from the walls themselves:
1. Find the MAIN roof: the highest roof edge on the building. A porch's own lower roof, hung on a wall below the main roof's edge, is NOT the main roof. Never read the slope, or the high side, off a porch roof.
2. Find the two walls whose top edge SLOPES under the main roof, and the frames most square-on to each of them. Each of those walls is a trapezoid: one of its two vertical edges is plainly taller than the other, and the TALL vertical edge stands at the high wall. Read both if you can; they must agree.
3. Name it relative to the FRONT. "front" when the tall edges stand at the front: the front wall itself is the tall one, and the roof falls away from you toward the back. "back" when they stand at the far end: the roof rises away from you and the back wall is the tallest. "left" or "right" when the two sloping walls are the front and the back themselves: the front wall's top edge climbs toward that side.
Leave it out on anything that is not a shed.

PITCH: find a frame looking straight at a gable end and read the slope of the roof edge against the sky, comparing its rise to its horizontal run. A roof that rises half as much as it runs is 0.5. Do not guess from a corner view, where perspective flattens it. A shed has no gable end: read its one slope from a frame square to one of the two walls whose top edge runs diagonally, along the MAIN roof's edge and never a porch roof's, or work it out from the walls, as the high wall's height minus the low wall's, divided by the distance between them. A 12 ft deep shed whose high wall stands 10 ft and whose low wall stands 8 ft is (10 - 8) / 12 = 0.17.

GAMBREL NUMBERS, only for a gambrel, from that same frame straight at a gable end. Measure all three from the CENTRELINE under the ridge and the TOP OF THE WALL, and divide each by the distance from the centreline to the wall: kneeU is how far the knee sits out from the centreline, kneeRise is how high the knee sits above the wall, ridgeRise is how high the ridge sits above the wall. Example: a 12 ft wide barn with its knee 1.5 ft in from each wall and 4.3 ft above it, and the ridge 6.2 ft above the wall, is kneeU 0.75, kneeRise 0.72, ridgeRise 1.03. Check before you answer: kneeRise / (1 - kneeU) is the steepness of the lower slope and (ridgeRise - kneeRise) / kneeU is the upper; the lower must come out clearly larger, or you measured from the wrong point.

OVERHANG: how far the roof edge stands out past the wall below it, in INCHES, judged against a door for scale. Read it from a frame looking along an eave wall, where the roof edge and the wall below it are both in view. 0 is a real answer and an ordinary one: a flush eave is the wall running straight up into the roof edge, with no shadow under it and nothing to see from below, and a building built that way is as common as one with a deep eave. 2 inches and 16 inches are both common answers and they look nothing alike, so give the one this building shows. Some styles are sold on a deliberately wide eave, so this number carries the look.

WALL HEIGHT: already known — the builder measured it and it is stated above. Do not estimate it, do not report it, and do not bend the other numbers to fit some other wall height. It is the LOW wall on a one-slope roof, and the wings' outer walls on a building with side wings; every taller wall is yours to give, through the pitch or centerEaveFt, measured against it.

EAVE FINISH, from a frame looking along an eave wall at the underside of the roof edge. There are two possibilities and they look nothing alike once you know to look: a continuous painted board running the whole length, level and unbroken, is "fascia"; a repeating row of raw unpainted wood blocks projecting below the roof with gaps of open air between them is "open" — exposed rafter tails, which give the bottom of the roof a sawtooth outline rather than a straight line. If it is "open", count the blocks along a run you can measure against the wall and give the spacing in inches — 24 is the common one, 16 the next. If you cannot see under the eave in any frame, omit both keys rather than guessing; omitting them means the fascia we already draw. On a shed, the high eave is usually the one whose underside you can see best. Judge it on the MAIN roof's own eaves: a porch roof often shows exposed rafters under it while the main roof above it has a plain fascia board, and the porch's rafters are not the main roof's eave finish.

GABLE VENT: a louvered opening set in the gable triangle, above the top of the wall. Give its width as a fraction of the width of the gable wall it sits in, not of the triangle; on a building with side wings that is the CENTRE section's width, not the whole front. Omit the whole gableVent object if the gable ends carry no vent — that is common and is not a failure to see one.

ROOF MATERIAL: asphalt shingles are laid in overlapping courses, so the slope carries a horizontal line every few inches and the surface looks granular. Metal is long continuous panels running UP the slope with raised ribs a foot or so apart, and it catches light in hard streaks rather than evenly. Judge it from the frame where the roof fills most of the picture; on an overcast day the giveaway is the direction of the lines — across the slope means shingle, up it means metal.

LEAN-TO: an OPEN roofed section running along one side wall, its outer edge carried on posts rather than a wall — an equipment bay, or a carport down the side. Only report one if the posts are actually there; a deep eave overhang is not a lean-to. Give how far it projects from the wall in feet, how far its outer edge drops below the main eave, and which side it is on as seen standing in front of the FRONT wall. ⚠️ A lean-to is OPEN underneath and stands OUTSIDE the walls. A covered area in front of the FRONT wall is a PORCH, never a lean-to, whether the front is a gable end or an eave wall; it has its own fields below, and reporting it as a lean-to draws a lump on the wrong side of the wrong wall. And a lower section with WALLS of its own — siding, windows, closed in — is a SIDE WING, below, however much its roof looks like a lean-to's. A lean-to can only be drawn along a wall the main roof's edge runs level along: give the lean-to keys only on a two-slope building whose front is a gable end, or on a shed whose high side is left or right. On any other building leave all three lean-to keys out and say in observed.roofNote which wall the lean-to is on.

SIDE WINGS, on a monitor or raised-centre building: a taller CENTRE section with its own roof, flanked along its sides by lower ENCLOSED rooms. Each wing is a real room — walls with siding and often windows, closed in from the front of the building to the back — under its own one-slope roof that falls AWAY from the centre to a lower outer wall. Above the wing roofs the centre section's own side walls carry on up, as a band of siding or a row of small windows, to the centre roof's eave. The wings are inside the size the builder measured: the FRONT wall's length includes them. Give wingSide, which sides carry a wing: "both", or "left" or "right" for one (on a building whose front is an eave wall, wings along the front and back walls are "front" or "back"). Give wingWidthFt, each wing's width from its outer wall in to the centre section's wall, measured against the front wall's known length, which the centre and the wings make up between them. Give wingPitch, the wing roof's rise over run, read from the frame where the wing roof is seen edge-on (square to the front for wings along the sides, square to a side for wings along the front and back): the height where it meets the centre wall, minus the outer wall's height, divided by wingWidthFt. Give centerEaveFt, from the floor to the top of the centre section's walls where its own roof starts, measured against the known wall height, which is the height of the wings' outer walls. Build it from two parts rather than reading it in one guess: first where the wing roof meets the centre wall (the outer wall plus wingWidthFt times wingPitch), then the BAND of centre wall that shows above the wing roof up to the centre's eave, measured in a frame square to the front or the back against the outer wall's height in the same frame (a band half as tall as the outer wall adds half that wall's height). A band holding a row of upper windows needs at least about 4 ft of wall. centerEaveFt is the two added together. Report the centre section's own roof — its type, pitch and front — exactly as you would a building's. Omit all four wing keys on an ordinary building.

WINGS DECISION, REQUIRED: observed.wings must carry one of exactly three answers on EVERY building — "both" for enclosed wings along both sides of a taller centre section, "one" for a single enclosed wing, "none" for a building with no side wings, which is the common case. An open lean-to on posts is "none" here. LOOK AT BOTH SIDES before you answer: the frames square to each side wall, and the back view, where the far wing often shows best. A raised centre with a wing on only one side is uncommon, so answer "one" only when a frame shows the other side's wall running straight up to the centre section's eave with no lower roof against it, and name that frame in observed.roofNote. Answer it even when the answer is "none", and answer it even when you are unsure; say the doubt in observed.roofNote instead of leaving the key out. "both" or "one" obliges you to give wingSide and wingWidthFt.

PORCH ON THE FRONT WALL: a porch decides which wall is the FRONT, so porchEnd is "front" for every porch, and the front wall can be either kind — a gable end, or a long eave wall. A cabin with a porch across its long front is an ordinary case of the second, and everything below applies to both.

PORCH TRUSS: with a porch, look at the TRIANGLE of gable wall directly above the porch opening. If heavy timber beams are fixed across it in a decorative pattern — typically an upright post running from the horizontal header up to the peak, with two diagonal braces angling up to meet it, so the triangle reads as a timber frame rather than as flat siding — set porchTruss true. It is usually raw or stained wood against a painted gable, so it stands out clearly. A plain gable above the porch, even one with a vent in it, is porchTruss false.

PORCH: a covered area recessed INTO the front of the building. The main roof does not change at all: it simply carries on over the porch, and the outer corners are held up by posts instead of walls, on a gable front usually with a decorative timber truss filling the gable above them. Look for the wall with the door standing BACK from the edge of the roof rather than flush with it, so the front of the building is open air under the same roof for the first few feet. Give porchDepthFt as how far the porch eats INTO the building's depth — a 12x24 with an 8 ft porch is still a 12x24, with 16 ft of enclosed room and 8 ft of porch. Typical depths are 4 to 8 feet. If instead the front wall runs full height with the door in it, and the porch stands in front of that wall under a separate lower roof, it is a PROJECTING PORCH, below, and porchDepthFt stays out. A deck with posts along its outer edge, standing in front of a wall that runs full height with the door in it, is PROJECTING, never recessed, however low its roof and however open its sides: recessed means the WALL itself stands back under the main roof. Omit both keys if the building has no porch.

PROJECTING PORCH: a porch built IN FRONT of the front wall instead of cut into it. The wall runs full height behind it, with the door in it, and the main roof stops at that wall exactly as it would with no porch. In front of the wall stands a deck at floor level with posts along its outer edge, covered by its own separate roof: a low, nearly flat slope that starts on the wall and falls away over the posts. From the front you see TWO roof edges, the main roof's and the porch's lower one below it. Three things settle it from the ground, and all three survive a walk-around: the wall runs UNBROKEN from the floor up behind the porch roof, with nothing cut out of it; the porch ceiling is nearly level while the main roof above it is a separate plane; and from the side the porch sticks out PAST the front of the building instead of sitting inside it. Give porchOutFt as how far the posts stand out from the wall, in feet, typically 4 to 8; a porch never changes the building's size. A porch is one kind or the other: if you give porchOutFt, leave porchDepthFt and porchTruss out.

PORCH ROOF HEIGHT, porchAttachFt: where the projecting porch's roof meets the wall, as the height in feet from the floor to the TOP of the porch roof at that wall. Leave it out only when the porch roof starts just under the top of a wall whose top is the known wall height, which is the usual build on a gable end. Give it whenever the wall behind the porch is taller than that — the high wall of a shed, or the centre section of a building with side wings — and whenever a band of wall shows between the porch roof and the main roof's edge above it. Measure it on the wall itself, with a ruler you can trust: the door is 6 ft 8 in tall, so a porch roof meeting the wall about a foot above the top of the door is at about 7.7 ft; or count the siding courses or battens up the wall against the known wall height. On a building with side wings, measure it on the centre section's wall the same way.

PORCH WIDTH, porchWidthFt: give it only when the porch is clearly narrower than the stretch of wall it could cover. That stretch is the whole front wall on an ordinary building, and the CENTRE section alone on a building with side wings. Leave it out when the porch runs the whole front wall, which is the common case, and leave it out when a porch on a winged building runs exactly from one wing to the other, because that is what is drawn without it. Give it when the porch covers only part of that stretch, measured against the front wall's known length; it is drawn centred on that stretch.

PORCH POSTS, porchPosts: count the posts standing along the porch's FRONT edge, the edge farthest from the wall, from the frame most square-on to the front, and include the posts at both corners. A porch with a post at each corner and one in the middle is 3. One at each corner and three between them is 5. Posts that stand beside the door or at the top of the steps count like any other. Count them one by one along the edge before answering. Count posts only, never the wall's corner boards or a handrail's newel. Leave it out when no frame shows the whole front edge.

PORCH ROOF PITCH, porchPitch: the porch roof's OWN slope as rise over run, never the main roof's. Read it from a side frame, where the porch roof's edge is seen square-on: it runs from where the roof meets the wall down to its front edge, so compare how far it drops with how far it runs out from the wall. A porch roof that drops 1 ft over 5 ft of run is 0.2. Leave it out when no frame shows that edge square-on.

PORCH STEPS, porchSteps: where a set of steps leaves the porch's deck along its FRONT edge, as seen standing in front of the porch facing it: "left", "center" or "right", with left and right read the same way as everywhere else in this reply. Leave it out when the porch has no steps, and when its steps leave the deck from one of its sides rather than its front edge.

PORCH DECISION, REQUIRED: observed.porch must carry one of exactly three answers on EVERY building — "projecting" for a porch standing out in front of the front wall under its own lower roof, "recessed" for one cut into the building under the main roof, "none" for a building with no porch. Answer it even when the answer is "none", and answer it even when you are unsure; say the doubt in observed.roofNote instead of leaving the key out. Naming a porch obliges you to give its field: "projecting" means porchOutFt, "recessed" means porchDepthFt and porchEnd. Do not report a porch here and leave its number out of the roof.

DORMER: a small roofed box sitting ON one of the main roof slopes, breaking its line. Give its width, how far it stands above the slope, and how far ACROSS the roof it sits -- measured sideways from the ridge line toward one eave, as a fraction of the half-span, negative for the left side and positive for the right as seen standing in front of the FRONT wall. When the front is an eave wall the two slopes face front and back instead: negative for the back slope, positive for the front one. Omit all three keys if the roof is unbroken, which is the common case.

COLOURS matter here: the builder compares your drawing with these frames. Give each colour as the paint looks in EVEN daylight: not the side in shadow, which reads darker and bluer than the paint is, and not a face in hard sun, glare or a reflection of the sky, which reads paler. When those are the only faces you have, the paint lies between them, and dark paint stays dark: never report a dark wall's sun-bleached reading as its colour. body is the main wall colour; trim is the window and door casings (the boards framing them, not shutters); roof is the roofing. corner is the vertical boards at the building's corners, and fascia is the boards along the roof edges — along the eaves, up the rakes, and round the porch roof. Look at those two on their own rather than assuming they match the casings, and ALWAYS give both: repeat trim's value only when they really are the casings' colour. They often differ: on board-and-batten and panel siding the corner boards are usually the wall colour, and the fascia is often the roof colour. Leaving corner out draws the corners in the trim colour, which on a dark building with white window casings is a white stripe down every corner. wood is the natural or stained lumber of a porch — posts, deck and rafters — and only when there is a porch. Give each as the #rrggbb you see, not the name of a paint.

FOUNDATION: look at the very bottom of the building, all the way round. "slab" means the walls meet the ground with no gap. "skids" means it sits low on wooden runners lying on the ground or on thin shims, with only a narrow shadow gap under the floor — the normal look for a building that was delivered on a trailer and set down. "blocks" means its runners or beams rest on stacked grey concrete blocks, with a clear gap under the building. "piers" means it stands on concrete piers (round or square concrete posts, often with a wooden beam across their tops), with a clear gap under the building. Omit if the bottom is never visible.

FLOOR HEIGHT, floorHeightFt, with "blocks" or "piers" only: how many feet the TOP of the floor stands above the ground, at the FRONT. The ground often slopes, so read it at the front wall, where the door, the porch and its steps are, and report that. Read it against something whose size you know: a door opening is 6 ft 8 in tall, so compare the gap under the building with the door; a porch deck is at floor level, and each porch or entry step rises about 7 in, so count the risers from the ground up to the deck. Leave it out for "skids" or "slab", and when the bottom of the front wall is never visible.

Ignore every OTHER building in the frames. On a sales lot the subject is usually the one that stays roughly centred as the camera moves around it; neighbours drift past in the background and are often a different model entirely.

FRAME MAP: which image goes with which view of the building. Number the images in the order you were given them, starting at 1, and name the ONE image that best shows each of the six views in frameMap. Count only the walk-around frames and never one of the builder's own photographs, which were taken separately and are not part of the lap. The same image may serve two views. A view you have no good image for should be LEFT OUT: naming an image that does not show it is worse than saying nothing, because that image is about to be put beside a drawing of that view and the builder asked to say whether the two match.

AZIMUTH: for each image you name, where the camera was standing, as an angle around the building to the nearest 45 degrees. 0 is square in front of the FRONT wall. Going from there around the building toward its RIGHT side, 90 is square to the right-hand side wall, 180 is square to the back wall, and 270 is square to the left-hand side wall. Right and left are as seen standing in front of the FRONT wall, facing it, the same way leanToSide, wingSide and dormerOffsetU are read. Answer 0, 45, 90, 135, 180, 225, 270 or 315 and nothing in between -- this is a coarse note of where you stood, not a survey.

Where the frames genuinely do not settle something, say so in observed and OMIT the key. Omitting a key leaves the builder's existing setting alone, which is better than a typical value they then have to find and undo. Do not fill a field with the middle of its stated range. The exceptions are the decisions marked REQUIRED above: give your best reading of each and put the doubt in observed.roofNote.`;

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
// WALL HEIGHT's band is `sanitizeD3Spec`'s OWN accept band (3..20), not its 5..20 clamp (5..14
// until 2026-09-24), and the gap between the two is deliberate: inside 3..20 the existing clamp
// does the whole job, exactly as it already does for a model-drafted wall, so there is one clamp rather than two that can
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
// path is re-derived, re-templated or re-worded here; it is returned. (Since 2026-09-24 a second
// test also pins that string's BYTES by hash, because identity alone would pass on an edited base.)
//
// WHERE THE BLOCK GOES, and it is not cosmetic: immediately after the FIRST BLANK LINE, inside
// the body `combinedShapePrompt` inherits. That function replaces everything up to the first
// blank line and keeps the rest, so a preamble placed above it would be eaten on every combined
// generation — silently, with a prompt that still reads perfectly well. A test pins it.
//
// WITH DIMS AND `v2` (the rollout gate below), THE v2 PROMPT (2026-09-24). The legacy dims path
// (legacyDimsPrompt) takes the base and cuts the wall height out of it by replacing two exact
// strings. The v2 prompt is WRITTEN without them — it has no `wallHeightFt` schema line and its
// WALL HEIGHT paragraph already says the wall is known — so there is nothing left to replace, and
// the old failure (a reworded line turning the replacement into a no-op) cannot happen there. The
// tests still assert neither dims prompt names `wallHeightFt`.
//
// THE RULER IS IN THE NEW FRAME: W is the FRONT wall (the side with the porch or main door), L the
// depth front to back, and the wall height is the OUTSIDE walls at the eave — on a one-slope roof
// the LOW side, with side wings the wings' outer walls. The designer's dimensions card asks for
// the three in exactly those words, which is what makes them one ruler rather than two.
export function knownDimsParagraph(dims: KnownDims): string {
  return `KNOWN DIMENSIONS, MEASURED BY THE BUILDER. The FRONT wall (the side with the porch or main door) is ${dimFt(dims.widthFt)} ft long, the building is ${dimFt(dims.lengthFt)} ft deep front to back, and its outside walls are ${dimFt(dims.wallHeightFt)} ft tall at the eave (on a one-slope roof, the LOW side; with side wings, the wings' outer walls). Those three are facts, not estimates, and they are your ruler: read every proportion you report against them and never against a scale of your own. Where one of them already answers a question, do not re-estimate it from a door, a person or a typical building.`;
}

// ─── THE ROLLOUT GATE (2026-09-24) ───────────────────────────────────────────────────────────
// Beta and production share ONE set of edge functions, and production runs an OLDER browser
// bundle that already sends dims — read in the OLD frame: its dimensions card says the width is
// "across the gable end". Handing that bundle the v2 prompt would state a builder's numbers in a
// frame they were not typed in. So v2 is chosen by the REQUEST, not by the deploy: only a caller
// that says `frame: "front"` (the new designer, whose dimensions card asks for the FRONT wall) AND
// sends dims gets it. Every other request keeps exactly the path it had before this change —
// the legacy prompt with no dims, and with dims the legacy prompt with the old ruler spliced in
// (legacyDimsPrompt below, frozen and pinned by hash).
export const PROMPT_FRAME_FRONT = "front";
export function wantsV2Prompt(frame: unknown, dims: KnownDims | null | undefined): boolean {
  return frame === PROMPT_FRAME_FRONT && !!dims;
}

// ─── THE STREAMED DRAFT (2026-09-25) ─────────────────────────────────────────────────────────
// Whether calibrate_style_ai answers this request behind a heartbeat (heartbeatJson.ts), so its
// draft can run past the gateway's 150 s of silence and its reads can think at effort "high".
// Decided from the request alone and BEFORE the branch runs, because the 200 has to go out before
// the work starts, and decided with the functions the branch itself uses for the same questions:
//   * `stream: true`, a real boolean: the new portal shell's opt-in. Production's older shell never
//     sends it, so every request it makes is answered exactly as before.
//   * not `lean: true`: the one automatic retry after a cut-off or timed-out read is a single,
//     shallow read that fits the old budget, and it keeps that budget.
//   * the v2 prompt: a shape-first source (video, combined) whose dims parse, with frame "front"
//     (wantsV2Prompt above). A request whose dims do not parse is refused with a 400 before anything
//     slow runs, so it is not streamed.
// aiDraftStreamWiring_test runs this against the branch's own v2Prompt and lean over a grid of
// requests, so the two cannot disagree about which requests stream.
export function wantsStreamedDraft(payload: unknown): boolean {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return false;
  const p = payload as Record<string, unknown>;
  if (p.stream !== true || p.lean === true) return false;
  if (p.source !== "video" && p.source !== "combined") return false;
  const dims = parseKnownDims(p.dims);
  return dims.ok && wantsV2Prompt(p.frame, dims.dims);
}

// ─── HOW LONG A STREAMED ANSWER MAY STAY OPEN (2026-09-25) ───────────────────────────────────
// Measured from the request's arrival (portal-settings' requestStartMs). The reads get at most
// min(230 s, 260 s - set-up), so a set-up under 200 s leaves the model done by 260 s; the capture,
// the ledger write and the answer normally take seconds after that, which leaves 40 s of room for a
// slow database. Past this the answer is closed with heartbeatJson's `stream_deadline` body and the
// work runs on behind it. The platform's own wall clock (400 s) is the hard stop above both.
export const DRAFT_STREAM_DEADLINE_MS = 300_000;

// ─── ONE PRESS'S KEY, CUT ONE WAY (253, 2026-09-25) ──────────────────────────────────────────
// The browser mints one idempotency key per press (calIdemRef) and sends it with the press.
// calibrate_style_ai files the wallet hold under it (wallet_hold's p_idem) and, since 253, writes it
// onto the press's ledger row (ai_style_calls.idem_key), and calibrate_style_ai_recover finds that
// row and that hold by it. Three readers, so one function: a key cut two ways would find nothing.
// Exactly the expression the hold always used: String(), the first 120 characters, empty is none.
export function draftIdemKey(raw: unknown): string | null {
  return String(raw ?? "").slice(0, 120) || null;
}

// ─── PICKING A STREAMED DRAFT UP AFTER THE CONNECTION DROPPED (2026-09-25, BY KEY SINCE 253) ──
// A streamed draft runs three to five minutes, and a phone that backgrounds the tab, or a network
// that blinks, drops the answer while the server is still working (or after it has finished and
// charged). Asking again under the same key cannot help: it either runs the model a second time or
// meets hold_in_flight / already_charged. But the server writes what it drafted onto the ledger row
// (226), so the browser reads it back: calibrate_style_ai_recover.
//
// ⚠️ THE PRESS IS FOUND BY ITS KEY, NEVER BY TIME. The first cut matched "the newest row of this
// tenant, user and style since the press began" and guessed the money from timing, and a review
// confirmed all four ways that goes wrong (253's header): a drop noticed after the budget never
// asked; a slow poll's clock correction started the window after the row; a captured hold could be
// told "not charged"; and a LATER press on another tab could be returned. So there is no `since`,
// no clock and no window any more. The browser mints ONE idempotency key per press (calIdemRef) and
// sends it with the press; the ledger row carries it (253's idem_key) and wallet_hold files the hold
// under it (128's idempotency_key). The recover action reads THAT press's rows and THAT press's
// money, both by the key, both scoped to the tenant and user the server resolved itself.

// How long a row with no draft is still worth waiting on WHEN THE WALLET HAS NO WORD ON IT (the
// meter is inactive, which is every tenant today): the answer's own deadline plus 100 s, which is
// the platform's 400 s wall clock. The work runs on past its answer's deadline, but no worker
// outlives the wall clock, so a row still without draft_ms by then will never get a draft.
export const DRAFT_RECOVER_PENDING_MS = DRAFT_STREAM_DEADLINE_MS + 100_000;
// How long a draft may trail the write that says the work is over. NOT a money decision: the
// sentence about money always comes from the wallet's own state. It only decides whether to keep
// waiting. On a success the usage write (draft_ms, started without await) and the capture land a
// moment before `drafted` (one or two round trips), so a row caught in between has finished and
// is about to show its draft. Every failure exit writes draft_ms and never writes `drafted`, and
// releases its hold.
export const DRAFT_RECOVER_SETTLE_MS = 90_000;
// A key owns one row per attempt: the press, the builder's own retry of a press that failed (the
// key is kept until a draft lands), the lean retry. More than this under one key is not a press
// being picked up.
export const DRAFT_RECOVER_MAX_ROWS = 20;

// The ledger rows calibrate_style_ai_recover reads (select these columns, nothing else).
export const DRAFT_RECOVER_COLUMNS = "id, called_at, source, drafted, observed, frames, video_count, dims, draft_ms, frame_map";
export type DraftRecoverRow = {
  id: string;
  called_at: string;
  source: unknown;
  drafted: unknown;
  observed: unknown;
  frames: unknown;
  video_count: unknown;
  dims: unknown;
  draft_ms: unknown;
  frame_map: unknown;
};
// And the press's wallet rows (wallet_transactions under the same key).
export const DRAFT_RECOVER_MONEY_COLUMNS = "state, posted_at";
export type DraftRecoverMoneyRow = { state: unknown; posted_at: unknown };

const hasDraft = (r: DraftRecoverRow) => r.drafted !== null && r.drafted !== undefined;
const calledMsOf = (r: DraftRecoverRow) => {
  const ms = Date.parse(String(r.called_at ?? ""));
  return Number.isFinite(ms) ? ms : -Infinity;
};

// Which of the key's rows answers. A key can own several (a failed attempt, then the retry of the
// same intent), so the one that DRAFTED wins, and among several, or among none that drafted, the
// newest. Sorted here rather than trusted from the query's order, so the choice is this function's.
export function pickRecoverRow(rows: DraftRecoverRow[] | null | undefined): DraftRecoverRow | null {
  const list = (Array.isArray(rows) ? rows : []).filter((r) => r && typeof r === "object");
  if (!list.length) return null;
  const newestFirst = [...list].sort((a, b) => calledMsOf(b) - calledMsOf(a));
  return newestFirst.find(hasDraft) ?? newestFirst[0];
}

// What the press's money is doing, from its own wallet rows (128: a hold is a 'held' debit, a
// capture turns it 'posted', a release 'released'; after 248 a key can own several released rows
// and at most one that is not). Captured beats held beats released, because one row per attempt
// and only the latest attempt can still be running. No rows at all is the meter being inactive
// (every tenant today) or a press refused before its hold. Any other state is not ours to guess.
export type DraftMoney =
  | { kind: "captured"; postedMs: number | null }
  | { kind: "held" }
  | { kind: "released" }
  | { kind: "none" }
  | { kind: "unknown" };
export function draftMoneyState(rows: DraftRecoverMoneyRow[] | null | undefined): DraftMoney {
  const list = Array.isArray(rows) ? rows.filter((r) => r && typeof r === "object") : [];
  if (!list.length) return { kind: "none" };
  const posted = list.filter((r) => r.state === "posted");
  if (posted.length) {
    const times = posted.map((r) => Date.parse(String(r.posted_at ?? ""))).filter((ms) => Number.isFinite(ms));
    return { kind: "captured", postedMs: times.length ? Math.max(...times) : null };
  }
  if (list.some((r) => r.state === "held")) return { kind: "held" };
  if (list.every((r) => r.state === "released")) return { kind: "released" };
  return { kind: "unknown" };
}

export type DraftRecoverAnswer =
  | { kind: "draft"; code: string; severity: "info"; body: Record<string, unknown> }
  | { kind: "pending"; body: { ok: true; pending: true } }
  | {
    kind: "lost";
    code: string;
    severity: "info" | "error";
    why: string;
    body: { ok: true; pending: false; reason: string; message: string };
  };

// The three sentences a builder can be given, each true for the money state it is chosen by.
const RECOVER_NOT_CHARGED = "We could not pick the draft up from the server: that generation did not finish, so you are not charged for it. Press Generate to try again.";
const RECOVER_CHARGED_LOST = "That generation finished and was charged once, but its draft could not be saved for pickup, so it is gone. You have not been charged twice. Reload this page before pressing Generate again; the next press will be a new charge.";
const RECOVER_UNSURE = "We could not pick the draft up from the server. A generation is only ever charged once, never twice. Reload this page before pressing Generate again.";
function lostSentence(money: DraftMoney): { message: string; severity: "info" | "error" } {
  if (money.kind === "captured") return { message: RECOVER_CHARGED_LOST, severity: "error" };
  if (money.kind === "released" || money.kind === "none") return { message: RECOVER_NOT_CHARGED, severity: "info" };
  return { message: RECOVER_UNSURE, severity: "error" };
}

// The frame map read back off the row, through the parser that made it: the same six viewpoints,
// the same integer frames bounded by the walk frames that request sent (all of them on "video";
// the leading `video_count` on "combined", whose trailing images are the builder's photographs),
// the same azimuths. Our own write, so this changes nothing, but a row is data and is checked.
function frameMapOfRow(row: DraftRecoverRow): FrameMap | null {
  const raw = row.frame_map;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const bound = row.source === "combined" ? num(row.video_count) : num(row.frames);
  return parseFrameMap(JSON.stringify({ frameMap: raw }), bound ?? 0);
}

// What the recover action answers, for the row pickRecoverRow chose (null: the key has none) and
// the money draftMoneyState read under the same key.
//   * DRAFTED: the body calibrate_style_ai's success answered with, rebuilt from the row, field for
//     field and in the same order, plus `recovered: true`. `frameMap` is the row's own (253), so the
//     free self-check RUNS on a recovered draft exactly as on a live answer; it is null only on a
//     row written before 253, or when the reply carried no map, and then the designer skips the
//     check and says why. `dropped` is null (the browser knows what it sent) and `balanceCents`
//     null, as a response that took no money back to the browser always has. Money is not read.
//   * NO DRAFT, by what the money says:
//       captured  charged. Pending for DRAFT_RECOVER_SETTLE_MS after the capture (the draft is
//                 written a moment after it), then "charged once, and lost" -- an error row.
//       held      the work is still running: pending.
//       released  the draft failed and its hold went back: not charged.
//       none      nothing was held (the meter is inactive, or the press was refused), so "not
//                 charged" is true whatever happened, and only the ledger says whether to wait:
//                 draft_ms written means the work ended (pending for the settle window, then
//                 failed); no draft_ms is pending until the 400 s wall clock, then lost.
//   * NO ROW for the key: `reason: "no_row"`. Not an answer the shell acts on at once: its press's
//     insert may not have landed, so it keeps asking for 90 s from the press. The sentence is
//     chosen by the money like any other.
//   Every `lost` body carries `reason` (why) beside its sentence.
export function recoverDraftAnswer(row: DraftRecoverRow | null, money: DraftMoney, nowMs: number): DraftRecoverAnswer {
  const lost = (why: string, said = lostSentence(money)): DraftRecoverAnswer => ({
    kind: "lost", code: "ai_draft_recover_none", severity: said.severity, why,
    body: { ok: true, pending: false, reason: why, message: said.message },
  });
  const pending: DraftRecoverAnswer = { kind: "pending", body: { ok: true, pending: true } };
  if (!row) return lost("no_row");
  if (hasDraft(row)) {
    const d3 = row.drafted;
    // Our own sanitised write, read back. Anything else is a fault, never a draft to apply.
    if (typeof d3 !== "object" || Array.isArray(d3) || !sanitizeD3Spec(d3).ok) {
      const said = lostSentence(money);
      return lost("unreadable", { message: said.message, severity: "error" });
    }
    const dims = parseKnownDims(row.dims);
    return {
      kind: "draft", code: "ai_draft_recovered", severity: "info",
      body: {
        ok: true,
        d3,
        frames: typeof row.frames === "number" ? row.frames : null,
        dropped: null,
        observed: row.observed ?? null,
        balanceCents: null,
        dims: dims.ok ? dims.dims : null,
        frameMap: frameMapOfRow(row),
        checkId: row.id,
        recovered: true,
      },
    };
  }
  if (money.kind === "captured") {
    // Charged, and the draft has not reached the row. A moment behind the capture on a success;
    // past the settle window the capture ran and the 226 write did not (ai_style_result_log_failed).
    const settled = money.postedMs === null || nowMs - money.postedMs > DRAFT_RECOVER_SETTLE_MS;
    return settled ? lost("charged_unsaved") : pending;
  }
  if (money.kind === "held") return pending;
  if (money.kind === "released") return lost("failed");
  if (money.kind === "unknown") return lost("money_unknown");
  // Nothing held under this key: the ledger alone says whether a draft can still come.
  const calledMs = calledMsOf(row);
  const ageMs = Number.isFinite(calledMs) ? nowMs - calledMs : Infinity;
  const draftMs = typeof row.draft_ms === "number" && Number.isFinite(row.draft_ms) ? row.draft_ms : null;
  if (draftMs !== null) return ageMs > draftMs + DRAFT_RECOVER_SETTLE_MS ? lost("failed") : pending;
  return ageMs < DRAFT_RECOVER_PENDING_MS ? pending : lost("stale");
}

// THE LEGACY RULER, EXACTLY AS IT SHIPPED ON 2026-09-19 (d3ab404), for callers the gate keeps on
// the old path. Frozen: the ruler speaks the old frame ("wide across the gable end") because that
// is the frame the old dimensions card asked in, and the wall height is cut out of the legacy
// schema by replacing two exact strings. styleD3.test.ts pins the output by SHA-256 and asserts
// neither replacement has become a no-op, which is the one failure here invisible from outside.
const WALL_HEIGHT_SCHEMA_LINE = `  "wallHeightFt": <wall height at the eave, typically 6-10; a door is about 6 ft 8 in, use it for scale>,\n`;
const WALL_HEIGHT_PARAGRAPH = `WALL HEIGHT: the wall at the eave, not at the peak.`;
function legacyDimsPrompt(dims: KnownDims): string {
  const known = `KNOWN DIMENSIONS, MEASURED BY THE BUILDER. This building is ${dimFt(dims.widthFt)} ft wide across the gable end, ${dimFt(dims.lengthFt)} ft long down the side, and its wall is ${dimFt(dims.wallHeightFt)} ft high at the eave. Those three are facts, not estimates, and they are your ruler: read every proportion you report against them and never against a scale of your own. Where one of them already answers a question, do not re-estimate it from a door, a person or a typical building.`;
  const cut = VIDEO_SHAPE_BASE.indexOf("\n\n");
  if (cut < 0) return VIDEO_SHAPE_BASE;
  const withKnown = `${VIDEO_SHAPE_BASE.slice(0, cut)}\n\n${known}${VIDEO_SHAPE_BASE.slice(cut)}`;
  return withKnown
    .replace(WALL_HEIGHT_SCHEMA_LINE, "")
    .replace(
      WALL_HEIGHT_PARAGRAPH,
      "WALL HEIGHT: already known — the builder measured it and it is stated above. Do not estimate it, do not report it, and do not bend the other numbers to fit some other wall height.",
    );
}

// `v2` is wantsV2Prompt's answer for the request. With no dims it cannot matter: the legacy base.
export function videoShapePrompt(dims?: KnownDims | null, v2 = false): string {
  if (!dims) return VIDEO_SHAPE_BASE;
  if (!v2) return legacyDimsPrompt(dims);
  const cut = VIDEO_SHAPE_V2.indexOf("\n\n");
  // Defensive only: v2 opens with a paragraph and a blank line, and a test pins it. If that ever
  // stopped being true, the ruler would have nowhere safe to go, and a v2 prompt whose WALL HEIGHT
  // paragraph says "stated above" over nothing is worse than the legacy prompt, which asks.
  if (cut < 0) return VIDEO_SHAPE_BASE;
  return `${VIDEO_SHAPE_V2.slice(0, cut)}\n\n${knownDimsParagraph(dims)}${VIDEO_SHAPE_V2.slice(cut)}`;
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
// `sanitizeD3Spec` clamps a wall to 5..WALL_HEIGHT_MAX_FT because that is what the renderer can
// draw. Inside parseKnownDims's 3..20 band there is room to type a number that comes back
// different (until 2026-09-24 a 16 came back as a 14; since the top rose to 20, only a wall under
// 5 ft still can), and a silent clamp on a number the builder MEASURED is the worst kind: they
// typed it, they can see the preview is wrong, and nothing on screen connects the two. Composed
// into `roofNote` beside the gambrel and porch warnings, so it reaches production's older panel
// with no browser change.
//
// Only the wall height can clamp. Width and length are never stored, and `overhangIn`'s 0..36
// band divides into exactly CLAMPS.overhang's 0..3 ft.
export function knownDimsNote(dims?: KnownDims | null): string | null {
  if (!dims) return null;
  const h = dims.wallHeightFt;
  const drawn = Math.min(WALL_HEIGHT_MAX_FT, Math.max(5, h));
  if (drawn === h) return null;
  return `Check the wall height before saving: you gave ${dimFt(h)} ft, and the 3D can only draw a wall between 5 and ${WALL_HEIGHT_MAX_FT} ft, so it has been drawn at ${dimFt(drawn)} ft.`;
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
export function combinedShapePrompt(videoCount: number, photoCount: number, dims?: KnownDims | null, v2 = false): string {
  const v = Math.max(0, Math.floor(videoCount || 0));
  const p = Math.max(0, Math.floor(photoCount || 0));
  const base = videoShapePrompt(dims, v2);
  if (!v) return base;
  const cut = base.indexOf("\n\n");
  if (cut < 0) return base;
  const rest = base.slice(cut);
  const frames = v === 1 ? "image is a frame" : "images are frames";
  const shots = p === 1 ? "image is a photograph" : "images are photographs";
  const tail = p
    ? ` The REMAINING ${p} ${shots} the builder took deliberately, standing back from one side at a time. They are sharper and better framed than the video frames, so prefer them wherever the two disagree - but they are NOT part of the walk and are not in walk order.`
    : "";
  // The v2 body names its subject more widely (a raised-centre HOUSE is one of the two buildings
  // it was built for, and "a shed or barn" primes barn answers for it), so its combined opening
  // does too. Only where the v2 body is what follows: the legacy opening is pinned by hash.
  const subject = v2 && dims ? "a shed, barn, cabin or small house" : "a shed or barn";
  return `These images are all of ONE portable building (${subject}), from two sources.\n\nThe FIRST ${v} ${frames} cut out of one continuous walk-around video, in walk order, so consecutive frames are adjacent viewpoints.${tail}${rest}`;
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
// `wings` (2026-09-24) is the second key read back the same way: the v2 prompt forces it to one of
// three words and wingsAgreementWarning checks it against the wing keys the same reply drafted.
const OBSERVED_KEYS = ["roofNote", "porch", "wings", "eave", "doors", "windows", "vents", "confidence"] as const;
export type ObservedNotes = Partial<Record<typeof OBSERVED_KEYS[number], string>>;

// The three answers the prompt forces observed.porch to, and the only three the agreement
// check understands. Exported because the same vocabulary has to appear in the prompt test.
export const OBSERVED_PORCH_KINDS = ["projecting", "recessed", "none"] as const;
export type PorchKind = typeof OBSERVED_PORCH_KINDS[number];
// The same for observed.wings. "one" rather than a side: WHICH side is the roof's business
// (roof.wingSide) and the note is only the headcount the geometry can be checked against.
export const OBSERVED_WING_KINDS = ["both", "one", "none"] as const;
export type WingKind = typeof OBSERVED_WING_KINDS[number];

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
  // The same rule for the wings answer, for the same reason: a sentence is not one of three words.
  if (out.wings) {
    const w = out.wings.toLowerCase();
    if ((OBSERVED_WING_KINDS as readonly string[]).includes(w)) out.wings = w;
    else delete out.wings;
  }
  return Object.keys(out).length ? out : null;
}

// ─── Which frame goes with which view (2026-09-19) ────────────────────────────────────────────────────────
// The free second pass renders the drafted model from a few camera positions and puts each
// render beside the builder's own frame of that view. Something has to decide which frame goes
// with which render, and the FIRST pass is the only thing in the system that has looked at every
// frame in walk order. So it is asked, in the same reply, at no extra call.
//
// ⚠️ THE INDICES ARE INTO THE ARRAY THIS REQUEST WAS GIVEN, which is not the style's stored
// list of frames. `calGenerateSet` keeps at most `CAL_PHOTO_MAX - photos.length` frames and
// STRIDES through them, so a lap of eight sent beside eight photographs is walk-1, 3, 5, 7 —
// four images — and positions 5..12 of what the model saw are the builder's staged photographs,
// not walk frames at all. Reading "frame 5" as the fifth frame of the lap would caption a
// photograph as a walk-around view, or pair a render with a frame a quarter of the way further
// round the building. The prompt says "the order you were given them" and this parses it that
// way; `videoCount` is how many of those leading images were walk frames.
//
// OUT OF RANGE IS DROPPED, NOT CLAMPED, and the two are not the same safety. Clamping a 9 to an
// 8 does stop a photograph being captioned as a frame, but it does it by substituting a pairing
// the model never made: the builder is shown frame 8 beside a render matched to whatever image 9
// was, with nothing on screen saying so. A missing viewpoint is an honest gap the compare step
// already has to handle (up to four, at least one); a fabricated one is a wrong answer wearing a
// confident label.
//
// BOTH HALVES OR NEITHER. A frame with no azimuth is a frame there is no angle to render
// against; an azimuth with no frame is a camera aimed at nothing to compare with. The pair is
// the unit, so half an answer drops the whole viewpoint here rather than leaving the caller to
// find the missing half at render time.
//
// NOT part of `observed` — that block is builder-facing prose with its own 240-char caps, and
// this is a handful of small integers — and NEVER stored in `d3`: sanitizeD3Spec rebuilds from
// known keys, so a `frameMap` in a model reply is dropped on the way to the column and
// production's older renderer cannot see it. No additive-key rule is touched.
//
// SIX, NOT FOUR (v2, 2026-09-24). The four originals see the front and ONE side, so the far
// side and the back were never compared -- and that is exactly where the two buildings v2 was
// built for differ from their drafts: the Tri Home's second wing is on the far side, and a
// shed's tall wall is as often the back as the front. `back` looks square at the wall opposite
// the front (azimuth front + 180) and `otherSide` square at the side wall opposite `side`.
// APPENDED, never interleaved: this order is the canonical order selfCheckPairs presents pairs
// in, and an older browser that only knows the first four must keep getting them in the order
// it always has. The v2 first-pass prompt's frameMap schema names all six (VIDEO_SHAPE_V2; the
// legacy VIDEO_SHAPE_BASE is frozen byte-for-byte with the original four, and a legacy reply simply
// has no back/otherSide to pair). styleD3.test.ts pins both against this list.
export const FRAME_MAP_VIEWPOINTS = ["front", "side", "eaveCorner", "corner", "back", "otherSide"] as const;
export type FrameMapViewpoint = typeof FRAME_MAP_VIEWPOINTS[number];
export type FramePick = { frame: number; azimuthDeg: number };
export type FrameMap = Partial<Record<FrameMapViewpoint, FramePick>>;

// One lap either side of 0 is accepted and normalised: a model that answers -45 or 405 means 315
// and 45, and refusing those throws away a right answer over its phrasing. Anything further out
// is not an angle with a lap counted twice, it is junk — and `4000 % 360` is 40, a perfectly
// plausible-looking answer manufactured out of nothing, which is the failure worth refusing.
const AZIMUTH_LAP = 360;

export function parseFrameMap(text: string, videoCount: number): FrameMap | null {
  const m = String(text || "").match(/\{[\s\S]*\}/);
  if (!m) return null;
  let parsed: any;
  try { parsed = JSON.parse(m[0]); } catch { return null; }
  const raw = parsed?.frameMap;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const src = raw as Record<string, unknown>;
  // `num` rather than a bare Math.floor: `Math.floor(NaN) < 1` is FALSE, so a junk count would
  // leave the bound as NaN and every comparison against it false — which reads as "accept any
  // positive integer", the exact opposite of a bound. No walk frames means nothing here can
  // point anywhere, so bail rather than build an empty object: the caller's check stays one
  // truthiness test, as it is for parseObservedNotes.
  const bound = Math.floor(num(videoCount) ?? 0);
  if (bound < 1) return null;
  const out: FrameMap = {};
  for (const k of FRAME_MAP_VIEWPOINTS) {
    const v = src[k];
    if (!v || typeof v !== "object" || Array.isArray(v)) continue;
    const pick = v as Record<string, unknown>;
    const frame = num(pick.frame);
    // AN INTEGER, not "something that rounds to one": 2.5 is not an index, it is a model hedging
    // between two frames, and rounding it would pick one of them on its behalf.
    if (frame === null || !Number.isInteger(frame) || frame < 1 || frame > bound) continue;
    const az = num(pick.azimuthDeg);
    if (az === null || az < -AZIMUTH_LAP || az > 2 * AZIMUTH_LAP) continue;
    const norm = ((az % AZIMUTH_LAP) + AZIMUTH_LAP) % AZIMUTH_LAP;
    out[k] = { frame, azimuthDeg: (Math.round(norm / 45) * 45) % AZIMUTH_LAP };
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

// ─── the wings nobody drew (2026-09-24) ───────────────────────────────────────────────────
// Modelled on porchAgreementWarning, line for line, because it is the same failure one room
// over: the v2 prompt forces `observed.wings` to one of three words, and a reply can say "both"
// in its notes while handing back a roof with no wing keys — which draws a raised-centre house as
// a plain box, the exact result this vocabulary exists to end. Same two sentences (no answer /
// a contradiction), same FLAG-NEVER-REPAIR posture, same place in `roofNote`.
//
// ⚠️ CALL IT ONLY FOR A v2 GENERATION (the rollout gate's v2Prompt: frame "front" AND dims). The
// legacy prompts never ask the question, so on those paths "the reading never said" would fire on
// every single generation and force every draft to low confidence. portal-settings gates the call
// on v2Prompt for exactly that reason.
//
// What the DRAFT says, read the way the renderer draws it: a wing exists only when wingWidthFt is
// above zero on a gable or gambrel (the sanitiser drops wing keys on a shed, and this reads the
// same way so an unsanitised roof cannot disagree with a sanitised one). A width with no side
// reads as "both" — the monitor-barn form the key exists for. ⚠️ The renderer has to read an
// absent wingSide the same way, or this check and the drawing disagree about a spec they share.
export function draftWingKind(roof: Record<string, unknown> | null | undefined): WingKind {
  if (!roof || roof.type === "shed") return "none";
  if ((num(roof.wingWidthFt) ?? 0) <= 0) return "none";
  const side = roof.wingSide;
  if (side === "left" || side === "right" || side === "front" || side === "back") return "one";
  return "both";
}

// Builder's words. "wingWidthFt" means nothing to someone holding a phone.
const WINGS_IN_WORDS: Record<WingKind, string> = {
  both: "enclosed lower wings along both sides",
  one: "an enclosed lower wing along one side",
  none: "no side wings",
};

export function wingsAgreementWarning(
  roof: Record<string, unknown> | null | undefined,
  observed: ObservedNotes | null | undefined,
): string | null {
  const drafted = draftWingKind(roof);
  const said = observed?.wings;
  if (!said || !(OBSERVED_WING_KINDS as readonly string[]).includes(said)) {
    return `Check the side wings before saving: the video reading never said whether this building has enclosed wings along its sides, so there was nothing to check the drawing against. It has been drawn with ${WINGS_IN_WORDS[drafted]}.`;
  }
  if (said === drafted) return null;
  return `Check the side wings before saving: the video reading says this building has ${WINGS_IN_WORDS[said as WingKind]}, but it has been drawn with ${WINGS_IN_WORDS[drafted]}. One of those is wrong and only the building settles which — compare the sides of the building with the preview, then set the wings below to match.`;
}

// ─── the front nobody named (fix, 2026-09-24) ─────────────────────────────────────────────
// The v2 prompt marks roof.front (gable, gambrel) and roof.highSide (shed) REQUIRED, and nothing
// enforced it. A draft without them renders in the OLD frame -- the ridge, or the shed's slope,
// along the footprint's longer walls, and a porch on the old gable end -- and the designer drops
// any stored front when a draft omits it. On a building whose front is its long wall that is the
// building turned round, with nothing on screen saying why. The lean retry, at effort "low", is
// the reply most likely to drop the key.
//
// So it is flagged in `roofNote` like the porch and the wings (FLAG, NEVER REPAIR: which way the
// building faces is exactly what the server cannot guess), and flagObservedNotes drops the
// confidence to low. ⚠️ v2 ONLY: the legacy prompts never ask for either key, so on those paths
// this would fire on every draft. portal-settings gates it on v2Prompt, beside the wings check.
// Read the way the sanitiser keeps them: front only on a two-slope roof, highSide only on a shed.
export function frameKeyWarning(roof: Record<string, unknown> | null | undefined): string | null {
  if (!roof) return null;
  const type = roof.type;
  if ((type === "gable" || type === "gambrel") && !(D3_ROOF_FRONTS as readonly string[]).includes(String(roof.front))) {
    return "Check which way the building faces before saving: the video reading did not say whether the front wall is a gable end or a long side, so the roof has been drawn the old way, with its ridge along the longer walls. Compare the preview with the video, then set Front wall below.";
  }
  if (type === "shed" && !(D3_SHED_HIGH_SIDES as readonly string[]).includes(String(roof.highSide))) {
    return "Check which wall is the high one before saving: the video reading did not say which wall of this single-slope roof is the tall one, so it has been drawn the old way, sloping along the longer walls. Compare the preview with the video, then set High side below.";
  }
  return null;
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

// ─── THE FREE SECOND PASS (2026-09-19) ────────────────────────────────────────────────────
// One press is one hold is one charge. The first call drafts a spec and the money ladder ends
// there, exactly where it ends today. Then the browser renders that draft from a few camera
// angles, puts each render beside the builder's own frame of the same view, and asks the model
// one narrow question: where does YOUR DRAFT not match THEIR BUILDING? That second call is
// FREE and it is single-use — a conditional claim on the ledger row that already paid.
//
// v2 (2026-09-24): up to SELF_CHECK_MAX_ROUNDS rounds, each its own single-use claim. The claim
// is a compare-and-swap on the row's round counter, a later round is claimable only after the
// round before it applied corrections, and every round judges the spec the ROW holds
// (`self_check_after ?? drafted`) -- never one the browser sends.
//
// Everything below is the pure half: the prompt, the reading of the reply, and the three gates
// a correction has to pass before it can touch a spec a customer will be quoted against. The
// claim, the model call and the ledger writes live in portal-settings, because they are I/O.
//
// ⚠️ EVERY INPUT TO THE SECOND CALL COMES FROM THE SERVER'S OWN ROW, NOT FROM THE CALLER.
// The draft is read back from `ai_style_calls.drafted`; the builder's measurements are read
// back from `ai_style_calls.dims`; the frames are intersected against the style's own stored
// lists. A design where the browser posts the draft JSON and the image URLs would be a free,
// caller-controlled vision call with caller-controlled text spliced into the prompt — one $20
// generation buying unlimited inference on any twelve images on the internet. The only thing
// the caller supplies that reaches the model is the RENDER BYTES, and those are held to six
// JPEGs (four before v2) it cannot make bigger than the cap.

// The six the first pass labels (four before v2), in the order the content array presents them. Reusing
// FRAME_MAP_VIEWPOINTS rather than restating the list: the pairing is only meaningful if both
// halves agree on the vocabulary, and two lists is one drift away from a render captioned as
// the wrong view.
export const SELF_CHECK_VIEWPOINTS = FRAME_MAP_VIEWPOINTS;

// What a viewpoint IS, in the words the prompt's numbered steps use. The steps say "the
// close-up viewpoint" and "the side viewpoint"; nothing else in the request would tell the
// model which image that is, and a check that reads the eave off the wrong image is worse than
// no check, because it answers confidently.
//
// In the v2 FRAME OF REFERENCE (CONTRACT §0): the FRONT is the wall with the porch, or the main
// door when there is no porch -- a gable end on one building and a long eave wall on another,
// which is why `front` and `side` no longer say "end" and "long wall". Left and right are as
// seen standing in front of it.
const SELF_CHECK_VIEW_WORDS: Record<FrameMapViewpoint, string> = {
  front: "head-on at the front, the wall with the porch or the main door",
  side: "square to one side wall",
  eaveCorner: "the close-up of the roof edge against the sky",
  corner: "a three-quarter view",
  back: "head-on at the back, the wall opposite the front",
  otherSide: "square to the other side wall, opposite the side view",
};

// THE RENDER CAPS. `portal-settings` already caps `logoBase64` at 2 MB and `imageBase64` at
// 3 MB; this is the same shape with a tighter number, because these are 896x672 JPEGs at
// quality 0.80 and the measured size is 25-35 KB each. 400 KB is more than ten times what a
// real one weighs, which leaves room for a slower device's encoder and none for a payload.
//
// SIX RENDERS AND 1.8 MB (v2): one per viewpoint, and the total raised in proportion (1.2 MB for
// four is 300 KB a view; so is 1.8 MB for six). The per-render cap does not move -- a render is
// the same 896x672 JPEG it always was.
export const SELF_CHECK_MAX_RENDERS = 6;
export const SELF_CHECK_MAX_RENDER_BYTES = 400_000;
export const SELF_CHECK_TOTAL_RENDER_BYTES = 1_800_000;

// At most EIGHT fields per round (six until v2). More than that is not a check, it is a second
// draft — and a second draft is a second charge. Counted over what the model DECLARES in
// `changed`, not over what survives the allow-list: the cap is reading the model's own statement
// of how much of the draft it wants to rewrite, and a reply that wants to rewrite fifteen fields
// is not a reply to take four corrections from. (Undeclared corrections cannot rewrite anything
// at all — see the both-lists gate below — so counting them would refuse over fields that have
// no effect.)
//
// WHY EIGHT. The allow-list grew from 22 paths to 30, and the two v2 features are MULTI-KEY:
// wings are side + width + pitch + centre eave, and porch placement is end + attach height +
// width on top of the porch's own number. The Tri Home drafted without its wings, with its front
// read the wrong way and a full-width porch is ONE visible correction to a person and seven
// fields here (front, wingSide, wingWidthFt, centerEaveFt, wingPitch, porchWidthFt,
// porchAttachFt) -- and the cap is all-or-nothing, so six would have thrown the whole of it
// away. Eight still refuses a reply that is rewriting the building (nine or more of thirty), and
// the extra rounds are NOT a reason to keep six: a refused round ends the loop, it does not
// split the correction across the next one.
export const SELF_CHECK_MAX_FIELDS = 8;

// At most THREE rounds per paid generation (v2). Round 0 is the check that has always run; each
// further round judges the renders of the spec the round before it produced. The limit lives
// HERE and is enforced twice in portal-settings: parseSelfCheckRound refuses a round past it
// before any database call, and the claim is a compare-and-swap on `self_check_round`, so the
// counter itself cannot pass it either.
export const SELF_CHECK_MAX_ROUNDS = 3;

// Which round a request is for. ABSENT MEANS ROUND 0, and that is the whole backwards-
// compatibility story: production's older browser sends no `round`, so it keeps exactly the
// single-use check it has always had (round 0 also requires `self_check_at` to be null, so its
// second request is still a 409). A round past the limit is refused the same way a spent claim
// is, with the same 409 code, so a browser needs only one rule for "stop asking".
//
// `max` (fix, 2026-09-24) is the caller's mode's limit: SELF_CHECK_MAX_ROUNDS for the v2 check,
// and 1 for the LEGACY check (selfCheckMode), which is d3ab404's single-use check -- an older
// designer never sends `round`, and a request without frame "front" that asks for a round past 0
// is asking for something that check never had. Same 409 and code as a spent claim.
export function parseSelfCheckRound(raw: unknown, max: number = SELF_CHECK_MAX_ROUNDS):
  | { ok: true; round: number }
  | { ok: false; status: 400 | 409; error: string; code?: string } {
  if (raw === undefined || raw === null) return { ok: true, round: 0 };
  // `num` would read "" as 0. An empty string is not "no round", it is a malformed one.
  const n = typeof raw === "string" && !raw.trim() ? null : num(raw);
  if (n === null || !Number.isInteger(n) || n < 0) {
    return { ok: false, status: 400, error: "round must be a whole number, starting at 0." };
  }
  if (n >= max) {
    return {
      ok: false, status: 409, code: "check_unavailable",
      error: max === 1
        ? "That generation has already had its check."
        : `That generation has already had all ${max} of its checks.`,
    };
  }
  return { ok: true, round: n };
}

// ── WHAT A CORRECTION IS ALLOWED TO TOUCH ─────────────────────────────────────────────────
// Dotted paths, matching the `changed[].field` the prompt asks for. Shape only.
//
// `wallHeightFt` and `sizeFt` are absent because the BUILDER MEASURED THEM. A pass that
// re-guesses a typed fact is a regression dressed as a feature, and the whole reason the check
// can read an eave at all is that it has a wall of known height to read it against.
//
// `colors` is absent because the render is drawn in the draft's own colours under a flat
// hemisphere light, and comparing that with daylight invites confident nonsense. Colours are
// already the strongest field in the baseline. Nothing to win, something to lose.
//
// `siding` is absent because no prompt in this pipeline asks about cladding AND sanitizeD3Spec
// always emits the key, so letting it through would reset a builder's choice to plain on every
// check — the exact defect applyDraftedShape was written to stop.
//
// v2 adds every new ROOF key and none of the new colours (`colors.corner`, `colors.fascia`
// stay off for the reason `colors` does). They are the massing and placement keys the
// numbered steps of the prompt now ask about: which way the front faces (gable/gambrel), which
// wall is tall (shed), the enclosed wings, and where the porch meets its wall and how wide it
// runs. Each of them is still held to sanitizeD3Spec's validity rules on the way out, so a
// highSide on a gable, or a porch attach height with no projecting porch, cannot land.
export const SELF_CHECK_ALLOW = [
  "roof.type", "roof.pitch", "roof.ridgeOffset", "roof.overhang",
  "roof.kneeU", "roof.kneeRise", "roof.ridgeRise",
  "roof.eave", "roof.tailSpacingIn",
  "roof.porchOutFt", "roof.porchDepthFt", "roof.porchEnd", "roof.porchTruss",
  "roof.leanToWidthFt", "roof.leanToDropFt", "roof.leanToSide",
  "roof.dormerWidthFt", "roof.dormerRiseFt", "roof.dormerOffsetU",
  "gableVent", "foundation", "roofMaterial",
  "roof.front", "roof.highSide",
  "roof.porchAttachFt", "roof.porchWidthFt",
  "roof.wingSide", "roof.wingWidthFt", "roof.wingPitch", "roof.centerEaveFt",
  // The porch's own framing (2026-09-25): its posts, its roof's pitch, and where its steps leave
  // the deck. Projecting porch only, which sanitizeD3Spec holds them to on the way out.
  "roof.porchPosts", "roof.porchPitch", "roof.porchSteps",
  // How high a raised floor stands (2026-09-25), top-level beside foundation, which is already on
  // the list and now takes "blocks" and "piers" too. Blocks or piers only, which sanitizeD3Spec
  // holds it to on the way out.
  "floorHeightFt",
] as const;

// `massing` (v2) is the answer to the new first step: which way the building faces, which wall
// is tall, and whether it has wings. Additive -- a reply without it parses exactly as before.
const SELF_CHECK_CHECKED_KEYS = ["overhang", "porch", "roofProfile", "eave", "massing"] as const;
const SELF_CHECK_CHECKED_WORDS = ["ok", "changed", "unclear"] as const;

// ── THE ROLLOUT GATE, FOR THE CHECK TOO (fix, 2026-09-24) ─────────────────────────────────────
// The draft has been gated since v2 (wantsV2Prompt): only a request that says `frame: "front"`
// gets the v2 prompt. The CHECK was not, and production's older designer -- which sends no frame
// and no round -- was being handed the whole v2 check: a new-frame ruler ("the FRONT wall is W ft
// long") over dims its card typed "across the gable end", a massing step that asks for roof.front
// and the wings, and a 30-path allow-list that let those keys into a spec the old renderer cannot
// draw and the old panel can neither show nor clear. Saved, they would switch on the day the new
// renderer is promoted: a style turned 90 degrees, or grown a raised centre, that no builder saw.
//
// So the check is gated exactly like the draft, ON THE REQUEST: the new designer sends
// `frame: "front"` on every check (12-shell onSelfCheck) and gets "v2". Everything else gets
// "legacy", which is d3ab404's check VERBATIM -- the frozen prompt (legacySelfCheckPrompt, pinned
// by SHA-256), its 22-path allow-list, six fields, the four viewpoints in their old words, four
// renders and 1.2 MB, the old `checked` keys, and its 4000-token / 45 s budget. Only the claim is
// shared: round 0 of the multi-round claim IS d3ab404's single-use claim, and a legacy request
// cannot ask for a later round (parseSelfCheckRound's `max`).
export type SelfCheckMode = "v2" | "legacy";
export function selfCheckMode(frame: unknown): SelfCheckMode {
  return frame === PROMPT_FRAME_FRONT ? "v2" : "legacy";
}

// ⛔ FROZEN at d3ab404, every one of them. styleD3.test.ts pins each against the value it had.
export const SELF_CHECK_LEGACY_VIEWPOINTS: readonly FrameMapViewpoint[] = ["front", "side", "eaveCorner", "corner"];
const SELF_CHECK_LEGACY_VIEW_WORDS: Record<string, string> = {
  front: "head-on at the end the door is on",
  side: "square to a long wall",
  eaveCorner: "the close-up of the roof edge against the sky",
  corner: "a three-quarter view",
};
export const SELF_CHECK_LEGACY_MAX_RENDERS = 4;
export const SELF_CHECK_LEGACY_TOTAL_RENDER_BYTES = 1_200_000;
export const SELF_CHECK_LEGACY_MAX_FIELDS = 6;
export const SELF_CHECK_LEGACY_ALLOW = [
  "roof.type", "roof.pitch", "roof.ridgeOffset", "roof.overhang",
  "roof.kneeU", "roof.kneeRise", "roof.ridgeRise",
  "roof.eave", "roof.tailSpacingIn",
  "roof.porchOutFt", "roof.porchDepthFt", "roof.porchEnd", "roof.porchTruss",
  "roof.leanToWidthFt", "roof.leanToDropFt", "roof.leanToSide",
  "roof.dormerWidthFt", "roof.dormerRiseFt", "roof.dormerOffsetU",
  "gableVent", "foundation", "roofMaterial",
] as const;
const SELF_CHECK_LEGACY_CHECKED_KEYS = ["overhang", "porch", "roofProfile", "eave"] as const;

// The rules each mode's gates run on, in one place so no gate can read one mode's list and
// another gate the other's.
type SelfCheckRules = {
  viewpoints: readonly FrameMapViewpoint[];
  maxRenders: number;
  totalRenderBytes: number;
  maxFields: number;
  allow: readonly string[];
  checkedKeys: readonly string[];
};
function selfCheckRules(mode: SelfCheckMode): SelfCheckRules {
  return mode === "legacy"
    ? {
      viewpoints: SELF_CHECK_LEGACY_VIEWPOINTS, maxRenders: SELF_CHECK_LEGACY_MAX_RENDERS,
      totalRenderBytes: SELF_CHECK_LEGACY_TOTAL_RENDER_BYTES, maxFields: SELF_CHECK_LEGACY_MAX_FIELDS,
      allow: SELF_CHECK_LEGACY_ALLOW, checkedKeys: SELF_CHECK_LEGACY_CHECKED_KEYS,
    }
    : {
      viewpoints: SELF_CHECK_VIEWPOINTS, maxRenders: SELF_CHECK_MAX_RENDERS,
      totalRenderBytes: SELF_CHECK_TOTAL_RENDER_BYTES, maxFields: SELF_CHECK_MAX_FIELDS,
      allow: SELF_CHECK_ALLOW, checkedKeys: SELF_CHECK_CHECKED_KEYS,
    };
}

// THE CALL'S BUDGET, per mode. Legacy is d3ab404's 4000 tokens and 45 s. v2 is 8000 and 90 s
// (fix, 2026-09-24): the v2 check carries up to six frame+render pairs (twelve images, six fetched
// by URL) and a longer prompt with the massing step, and at the ~78 tokens/s measured on 09-21,
// 45 s is ~3,500 tokens including the time to the first one. A timeout ENDS the rounds, so the
// massing corrections v2 depends on (round 0 turning the building, round 1 refining widths) were
// the ones cut off. 90 s + the handler's own overhead stays well inside the gateway's 150 s, and
// nothing about money rides on this call. ⚠️ The browser's own abort on this call has to sit above
// 90 s (the designer's SS_CHECK_MS and 12-shell's onSelfCheck signal), or it cuts the server off.
export const SELF_CHECK_BUDGET: Record<SelfCheckMode, { maxTokens: number; abortMs: number }> = {
  legacy: { maxTokens: 4000, abortMs: 45_000 },
  v2: { maxTokens: 8000, abortMs: 90_000 },
};

export type SelfCheckChange = { field: string; from: unknown; to: unknown; why: string };
export type SelfCheckChecked = Partial<Record<typeof SELF_CHECK_CHECKED_KEYS[number], string>>;
export type SelfCheckRead = {
  verdict: "matches" | "corrections";
  corrections: Record<string, unknown>;
  changed: SelfCheckChange[];
  checked: SelfCheckChecked;
  note: string;
};

// ── HOW STEEP THE RENDER CAN DRAW THE STYLE'S PORCH PITCH (fix, 2026-09-25) ─────────────────
// The renderer (d3PorchGeom, in both designer twins) builds a GIVEN porchPitch only as steep as
// leaves 6 ft under the porch beam, lowering it as far as it must. The check was told "currently
// 0.25" beside a render drawn at 0.05, so it "corrected" the pitch upward: a change that draws
// nothing, costs a round, and is listed to the builder as a change.
//
// The porch roof's high edge sits AT porchAttachFt or lower (the renderer also holds it under the
// building's own outline and the eave over it), so with porchAttachFt set this is an UPPER bound on
// the pitch the render shows: when even it is under the stored pitch, the render is certainly
// flatter, and the prompt says so. Without porchAttachFt, or without a porchPitch, null: the
// server does not know the wall top the renderer hangs the porch from, and says nothing it cannot
// stand behind. The member sizes and the bisection are d3PorchGeom's exactly; porchGeom_test runs
// the two side by side.
export function porchPitchDrawable(roof: Record<string, unknown> | null | undefined): number | null {
  const want = num(roof?.porchPitch), attach = num(roof?.porchAttachFt), out = num(roof?.porchOutFt);
  if (want === null || !(want > 0) || attach === null || !(attach > 0) || out === null || !(out > 0.5)) return null;
  const D = Math.min(12, out);
  const POST = 0.46, HDR_H = 0.62, HDR_D = 0.29, PR_T = 0.12, SHEATH = 0.04, WALL_T = 0.3, CLEAR_FLOOR = 6.0;
  const WANT = Math.max(0.05, Math.min(0.5, want));
  const dWall = WALL_T / 2, dPost = D - POST / 2;
  const run = Math.max(0.1, dPost - HDR_D / 2 - dWall);
  const stack = (p: number) => (PR_T + SHEATH) * Math.sqrt(1 + p * p);
  const clearAt = (p: number) => attach - p * run - stack(p) - HDR_H;
  if (clearAt(WANT) >= CLEAR_FLOOR) return WANT;
  if (clearAt(0.05) < CLEAR_FLOOR) return 0.05;
  let lo = 0.05, hi = WANT;
  for (let i = 0; i < 40; i++) { const mid = (lo + hi) / 2; if (clearAt(mid) >= CLEAR_FLOOR) lo = mid; else hi = mid; }
  return lo;
}

// ── THE PROMPT ────────────────────────────────────────────────────────────────────────────
// Built as a template because the draft and the builder's measurements are interpolated per
// generation. The refusal path is kept VERBATIM and stated three separate times — "it matches"
// is a complete and expected answer — because the measured A/B says a check that corrects an
// already-good draft scores 70.5 against the 74.3 of not checking at all. The most valuable
// thing this prompt does is give the model permission to change nothing.
//
// The dimensions are REQUIRED here, and that is a real restriction rather than a convenience:
// every measuring instruction (the eave in step 2, the porch attach height and the wings'
// widths) reads a length as a fraction of a wall whose height is known. A check run against a
// wall the model itself guessed would measure the eave against a number the baseline says is
// wrong in 74 % of generations, and would be wrong in the same direction every time. The
// caller refuses the check rather than run it blind.
//
// v2 STEP ORDER. The massing comes FIRST (which way the front faces, which wall is tall, the
// wings) because it is the error that makes every other comparison meaningless: an eave
// measured on a building drawn the wrong way round is measured on the wrong wall. The
// "it matches" discipline is unchanged and still stated three times, and the new step ends,
// like the profile step, by telling the model to leave all of it alone when the outlines agree.
//
// ROOF TYPE FIRST, INSIDE THE MASSING (fix, 2026-09-24). A front-high shed drafted as a gable has a
// valid-looking answer to "is the front a gable end or an eave wall?" -- a level edge runs along
// it -- so with the type left to a last "only if plainly wrong" step the massing passed and the
// shed's highSide, dropped by the sanitiser on a gable, never landed. The type is now the first
// question, and changing it brings its frame key in the same answer. This is the v2 check ONLY:
// production's older designer gets legacySelfCheckPrompt, below, frozen at d3ab404.
export function selfCheckPrompt(opts: {
  dims: KnownDims;
  draft: D3Spec;
  viewpoints: readonly FrameMapViewpoint[];
  // v2: which round this is (0-based; absent = 0), and the fields the rounds before it changed.
  // Both are read off the LEDGER ROW by the caller, never off the request. Round 0 -- and every
  // caller that passes neither -- gets the single check that has always run.
  round?: number;
  earlier?: readonly string[];
}): string {
  const { dims, draft } = opts;
  const views = SELF_CHECK_VIEWPOINTS.filter((v) => opts.viewpoints.includes(v));
  const roof = (draft.roof ?? {}) as Record<string, unknown>;
  const overhang = num(roof["overhang"]);
  const eave = overhang === null ? "not set" : `${dimFt(overhang)} ft`;
  // ⚠️ THE WALL THE RENDER WAS DRAWN AT, NOT THE ONE THAT WAS TYPED. parseKnownDims accepts a
  // measured wall of 3..20 ft and sanitizeD3Spec then CLAMPS it to the band the renderer can
  // draw, so a builder who measured a wall outside that band has a draft -- and therefore a set
  // of renders -- with a different wall in them. Stating the typed number here would tell the
  // model that "every render you are shown was drawn at exactly these dimensions" over pictures
  // of a wall that is not that height, and step 2 turns a fraction of that wall into feet: every
  // length it read off a render would be off by the same ratio, in the same direction, on
  // roof.overhang -- the field this whole pass was first built to fix. Step 4 is worse still,
  // because it asks whether the gambrel rises are absorbing a wall difference, and the clamp is
  // exactly such a difference.
  //
  // Width and length never clamp -- they are the ruler for this reading and are never stored --
  // so they stay as typed. The builder is told about the clamp separately, by knownDimsNote.
  const wall = dimFt(num(draft.wallHeightFt) ?? dims.wallHeightFt);
  // ⚠️ AND THE EAVE, WHERE THE BUILDER MEASURED IT. `overhangIn` is an optional chip on the
  // dimensions card: null means "read it off the video", and a number means they went and
  // looked. applyKnownDims has already written it into the draft, so asking the model to
  // re-measure it from a photograph is asking it to overwrite a tape measure with a guess --
  // on the field this prompt spends one of its longest steps on, and with nothing on the panel
  // reconciling the two afterwards (the chip goes on reading "16 in" while the spec says 2, and
  // pressing the chip again does nothing). applySelfCheck drops roof.overhang from the
  // allow-list for the same generation, so a correction would be thrown away in any case; this
  // is what stops the model spending its effort on a field that cannot land.
  const measuredEave = dims.overhangIn === undefined || dims.overhangIn === null ? null : dims.overhangIn;
  const present = views.length
    ? views.map((v) => `${v} (${SELF_CHECK_VIEW_WORDS[v]})`).join(", ")
    : "none";
  // The draft's own value, for the "currently" in each v2 step. Words are quoted exactly as the
  // model would write them back; feet are feet. Absent is said as absent, never as a default.
  const said = (k: string) => (typeof roof[k] === "string" ? `"${roof[k]}"` : "not set");
  const feet = (k: string) => {
    const n = num(roof[k]);
    return n === null ? "not set" : `${dimFt(n)} ft`;
  };
  const wingsNow = (num(roof.wingWidthFt) ?? 0) > 0
    ? `wingSide ${said("wingSide")}, wingWidthFt ${feet("wingWidthFt")}`
    : "none";
  // WHERE ABSENT DRAWS SOMETHING, SAY WHAT. A bare "not set" on a key the renderer defaults
  // invites the model to "correct" it to the very value already drawn -- a change that moves
  // nothing on screen, is reported to the builder as one, and counts against "it matches".
  const porchEndNow = roof.porchEnd === "back" ? '"back"' : `"front"${roof.porchEnd === undefined ? " (not set, which means the front)" : ""}`;
  const attachNow = num(roof.porchAttachFt) === null ? "not set, which draws it just under the top of the wall" : feet("porchAttachFt");
  // The porch's own framing (2026-09-25), each said as what absent DRAWS, for the reason above.
  const postsNow = num(roof.porchPosts) === null
    ? "not set, which draws a post at each corner and one every 8.5 ft or less between them"
    : String(num(roof.porchPosts));
  // …and where the render cannot draw the stored pitch at this attach height, the number the
  // render DOES show, and why (porchPitchDrawable, 2026-09-25).
  const pitchDrawn = porchPitchDrawable(roof);
  const pitchStored = num(roof.porchPitch);
  const porchPitchNow = pitchStored === null
    ? "not set, which draws a 2 in 12 porch roof, lower where the wall is too short for it"
    : pitchDrawn !== null && pitchDrawn < Math.min(0.5, pitchStored) - 1e-6
    ? `${pitchStored} but DRAWN AT ${Math.round(pitchDrawn * 100) / 100} (hung at porchAttachFt ${feet("porchAttachFt")}, anything steeper leaves less than 6 ft under the porch beam, so the render's porch roof is flatter than this number and raising the number changes nothing; if the frame's porch roof meets the wall higher, correct roof.porchAttachFt)`
    : String(pitchStored);
  const stepsNow = typeof roof.porchSteps === "string" ? said("porchSteps") : "not set, which draws no steps";
  const hasWings = (num(roof.wingWidthFt) ?? 0) > 0;
  // The centre's default is only a thing the renderer DRAWS when there are wings to stand it on.
  const centreNow = num(roof.centerEaveFt) !== null
    ? feet("centerEaveFt")
    : hasWings ? "not set, which draws it 3 ft above the top of the wing roofs" : "not set";
  // What the building stands on (2026-09-25), each said as what the render DRAWS: absent is a slab
  // at grade, and a raised foundation with no height is drawn at the renderer's default for it
  // (d3GradeFt in the designer: 1 ft on blocks, 1.5 ft on piers).
  const raised = isRaisedFoundation(draft.foundation);
  const foundationNow = typeof draft.foundation === "string"
    ? `"${draft.foundation}"`
    : "not set, which draws a slab on the ground";
  const floorNow = !raised ? "not set, and drawn only with blocks or piers"
    : num(draft.floorHeightFt) !== null ? `${dimFt(num(draft.floorHeightFt) as number)} ft`
    : `not set, which draws the floor ${draft.foundation === "piers" ? "1.5 ft" : "1 ft"} up`;
  // ⚠️ AND THE TWO FRAME KEYS (fix, 2026-09-24). A draft without roof.front / roof.highSide is
  // drawn in the OLD frame (d3RoofAxes' portrait/landscape rule): a two-slope roof's ridge along
  // the footprint's longer walls, with a porch on the gable end at the WEST (left) when the front
  // is the longer wall; a shed sloping along the longer walls, tall at the west (left) when the
  // front is longer and at the north (back) otherwise. A bare "not set" read to the model as
  // "nothing drawn yet", so on a long-fronted building it compared a front that was the short
  // end, found the same KIND of wall, and passed it. Saying what the render actually shows is
  // what lets it see the building is turned round -- and the fix is always to give the key.
  // Said only for the key the draft's OWN roof type carries; the other one is a plain "not set",
  // because it draws nothing on this roof.
  const W = dims.widthFt, D = dims.lengthFt;
  const wideFront = W > D;
  const twoSlope = roof.type === "gable" || roof.type === "gambrel";
  const frontNow = typeof roof.front === "string"
    ? said("front")
    : !twoSlope ? "not set"
    : `not set, which draws the roof by the old rule: the ridge runs along the building's longer walls, so ${wideFront
      ? `the ${dimFt(W)} ft front is drawn as a long eave wall and a porch is put on the ${dimFt(D)} ft LEFT end instead`
      : "the front is drawn as a gable end"}. If it is not set, ALWAYS give it`;
  const highNow = typeof roof.highSide === "string"
    ? said("highSide")
    : roof.type !== "shed" ? "not set"
    : `not set, which draws it by the old rule: the roof slopes along the building's longer walls, tall at the ${wideFront ? "LEFT" : "BACK"} wall. If it is not set, ALWAYS give it`;
  // Same KIND of wall is not enough: the old frame's front on a long-fronted gable is a gable end,
  // just the wrong (short) one. The width is what tells them apart.
  const frontWidth = twoSlope && W !== D
    ? ` AND the same wall: the FRONT is the ${dimFt(W)} ft wall, so if the render's front is plainly the ${dimFt(D)} ft wall instead, roof.front is wrong or missing - fix that before anything else`
    : "";
  // THE WALL UNDER EACH EAVE (fix, 2026-09-24). The overhang is read as a fraction of the wall
  // under the eave in view, and the first pass steers the close-up to a shed's HIGH eave, which
  // stands a whole rise above the known (low) wall; the same goes for a centre section's eave
  // over wings. Stated per eave, only where the draft has one, so a fraction read off a 9.5 ft
  // wall is not multiplied by 7. Figures are the draft's own, drawn the way the renderer draws
  // them (the old frame's shed slopes along the longer walls).
  const wallN = num(draft.wallHeightFt) ?? dims.wallHeightFt;
  const eaveWalls: string[] = [];
  const about = (n: number) => dimFt(Math.round(n * 10) / 10);   // "about", so a tenth of a foot
  const pitchN = num(roof.pitch);
  if (roof.type === "shed" && pitchN !== null && pitchN > 0) {
    const hs = roof.highSide;
    const run = hs === "front" || hs === "back" ? D : hs === "left" || hs === "right" ? W : Math.max(W, D);
    eaveWalls.push(`about ${about(wallN + run * pitchN)} ft for this shed's HIGH eave`);
  }
  if (hasWings) {
    const ya = wallN + (num(roof.wingWidthFt) ?? 0) * (num(roof.wingPitch) ?? 0.25);
    const c = num(roof.centerEaveFt);
    eaveWalls.push(`about ${about(c !== null ? Math.max(c, ya + 1) : ya + 3)} ft for the centre section's eave`);
  }
  const eaveRuler = eaveWalls.length
    ? `
   Measure against the wall directly under THAT eave: ${wall} ft for ${roof.type === "shed" ? "the LOW eave" : "a wing's outer eave"}; ${eaveWalls.join("; ")}.`
    : "";
  // ── THE ROUND (v2) ──
  // A later round judges renders of the spec the round before it PRODUCED, and says so. Without
  // this the model reads "YOUR DRAFT" as its own first answer and a correction an earlier round
  // made as its own mistake -- which is how a check flips a field back and forth for three
  // rounds. Only allow-listed field NAMES are interpolated: they come off our own ledger row, but
  // nothing that reached a column as model prose is spliced back into a prompt.
  const round = Math.max(0, Math.floor(num(opts.round) ?? 0));
  const earlier = (opts.earlier ?? []).filter((f) => (SELF_CHECK_ALLOW as readonly string[]).includes(f));
  const roundNote = round > 0
    ? `

THIS IS CHECK ROUND ${round + 1} OF ${SELF_CHECK_MAX_ROUNDS}. The draft above already carries what the
earlier round${round > 1 ? "s" : ""} corrected${earlier.length ? ` (${earlier.join(", ")})` : ""}, and every render below was drawn from it.
Judge the pictures as they are NOW. A field an earlier round corrected is right unless these
pictures plainly show otherwise - changing it straight back is almost always a mistake. If
everything now matches, that is the answer: say so and stop.`
    : "";
  return `You drafted a 3D spec for a portable building from a walk-around video. We rendered your
draft and are showing you the result beside the builder's own frames. Your job now is
narrow: find the places where YOUR DRAFT does not match THEIR BUILDING, and correct only
those.

This is a check, not a second draft. Most fields will already be right. "It matches" is a
correct and expected answer, and it is the answer we expect most often. Do not change a
field to show you are working - a wrong correction is worse than no correction, because it
overwrites a number that was already good.

THE BUILDER HAS MEASURED THESE. They are facts, not your estimates, and you must not change
them or argue with them:
  building size: ${dimFt(dims.widthFt)} ft wide by ${dimFt(dims.lengthFt)} ft long - the FRONT wall is ${dimFt(dims.widthFt)} ft long,
    and the building runs ${dimFt(dims.lengthFt)} ft from the front to the back
  wall height at the eave: ${wall} ft - the OUTSIDE walls (on a one-slope roof, the LOW side;
    with wings, the wings' outer walls)${measuredEave === null ? "" : `
  eave overhang: ${dimFt(measuredEave)} in past the wall`}
Use them as your ruler. Every render you are shown was drawn at exactly these dimensions, so
anything in a render can be measured against a wall you know the height of.

THE FRONT is the wall with the roofed porch on it, or the main door when there is no porch (an
open deck or stair does not count). Left and right are as seen standing in front of it, facing
the building.

YOUR DRAFT, as rendered:
${JSON.stringify(draft, null, 2)}${roundNote}

THE IMAGES. Each viewpoint gives you two images in a row: first the builder's own frame,
then our render of your draft from the same angle. Compare them as SHAPES. Ignore the
background, the grass, the sky, the lighting, the sharpness, the neighbouring buildings, and
any door, window or vent - the render deliberately does not draw the openings, and their
absence is not a mistake to report.

THE VIEWPOINTS IN THIS REQUEST, in the order they appear below: ${present}. Those are the only
ones here. Where a step below names a viewpoint you were not given, answer it from what you do
have or mark it unclear - never read one view as though it were another.

CHECK EXACTLY THESE, IN THIS ORDER. For each one, say whether it matches or give a
correction. These first four are the ones this pass gets wrong most often, so spend your
effort here.

1. THE MASSING: what kind of roof it is, which way the building faces, and what blocks it
   is made of. Check the OUTLINE before anything else - a building drawn the wrong way round
   makes every other comparison meaningless. The back and otherSide viewpoints, where you
   have them, are there for this: a far wing or a tall back wall can only be seen from there.
     * roof.type FIRST, currently ${said("type")}. One slope ("shed"), two slopes meeting at a
       ridge ("gable"), or a barn's two-pitch slopes ("gambrel")? Read it from the side and
       back views. A wrong type makes every other answer here meaningless: correct it HERE,
       and give roof.highSide (shed) or roof.front (gable, gambrel) in the same answer.
     * Two-slope roofs (gable, gambrel) - roof.front, currently ${frontNow}. Is the front
       wall a GABLE END - it rises to a triangle under the peak and the ridge runs away from
       you ("gable") - or an EAVE WALL - a level roof edge runs along its top and the ridge
       runs across in front of you ("eave")? The render's front must be the same kind${frontWidth}.
     * One-slope roofs (shed) - roof.highSide, currently ${highNow}. Which wall is
       the TALL one in the frames: "front", "back", "left" or "right"? Judge it by the MAIN
       roof, never by a porch's own lower roof: on the two walls whose top edge slopes, the
       taller vertical edge stands at the high wall. The same wall must be the tall one in
       the render.
     * Wings - currently ${wingsNow}. A wing is an ENCLOSED lower room, with walls and often
       windows, running the full depth along a side the main roof slopes down to, under its
       own lower one-slope roof that falls away from the centre; the taller centre section's
       walls rise above it to their own eave. A roof carried on OPEN posts is a lean-to, not
       a wing - if the draft drew a lean-to where the frames show a wing, set
       roof.leanToWidthFt to 0 and give the wing. Do the frames show wings, and on both sides
       or one (roof.wingSide: "both", or "left", "right", "front" or "back")? Look at BOTH
       sides before you answer: a raised centre with a wing on one side only is uncommon.
       Does the render? If the frames show wings and the render has none, ADD them in ONE
       answer: roof.wingSide; roof.wingWidthFt (each wing's width, from its outer wall in to
       the centre section's wall); roof.wingPitch (the wing roof's rise over that width); and
       roof.centerEaveFt (feet from the floor to the top of the centre walls) - all measured
       against the ${wall} ft outer walls.
       Where both show wings, compare each wing's width against the ruler (roof.wingWidthFt;
       0 removes the wings), the slope of the wing roofs (roof.wingPitch, rise over run), and
       the CENTRE section's eave (roof.centerEaveFt, currently ${centreNow}: feet
       from the floor to the top of the centre walls). Measure it, do not eyeball it: in a
       frame square to the front or the back, compare the BAND of centre wall showing above the
       wing roof with the height of the wing's outer wall below it, then do the same in the
       render. If the band's share differs by a quarter or more (a band as tall as half the
       outer wall in the frame and a quarter of it in the render, say), correct
       roof.centerEaveFt to where the wing roof meets the centre wall plus the band you
       measured in the frame.
   If the render and the frames trace the same outline from every viewpoint you have, leave
   all of these alone.

${measuredEave !== null ? `2. THE EAVE OVERHANG (roof.overhang, currently ${eave}). THE BUILDER MEASURED THIS ONE TOO
   and it is already in the draft. It is not yours to change: a correction to roof.overhang
   will be thrown away. Mark "overhang" as "ok" and spend the effort on the porch below.` : `2. THE EAVE OVERHANG (roof.overhang, currently ${eave}). Look at the close-up
   viewpoint, where the roof edge is seen in profile against the sky with the wall below it.
   Measure how far the roof stands out past the wall as a FRACTION OF THE WALL HEIGHT you
   were given, in the frame and in the render, and convert: a roof that projects a
   twentieth of the wall's height on a ${wall} ft wall is about
   ${wall}/20 ft. Buildings with a tight, trimmed eave are common and read as
   almost no projection at all - values near 0.15 ft are real. Do not settle on 1.0 ft
   because it is typical; report what this eave actually does.${eaveRuler}`}

3. THE PORCH, AND WHICH KIND (roof.porchOutFt / roof.porchDepthFt). There are two kinds and
   they are not interchangeable:
     * RECESSED (porchDepthFt): the porch wall is set BACK into the building, the main roof
       carries straight over the gap, and nothing sticks out past the end of the roof.
     * PROJECTING (porchOutFt): the porch wall runs full height with the door in it, and a
       deck with posts and its OWN lower roof stands OUT in front of that wall.
   The side viewpoint settles it: if the porch roof sticks out past the building, it is
   projecting. If that face of the building is one flat plane, it is recessed. Getting
   this wrong is the single most visible error on the whole building, so check it even when
   the two pictures look broadly alike. If you change the kind, give the new key and leave
   the other one out entirely.
   Then, where both show a porch, WHERE IT IS, HOW BIG AND HOW IT IS BUILT:
     * roof.porchEnd, currently ${porchEndNow}: always "front" on this building, because the
       porch is what defines the front. If the render's porch is on a different wall from the
       frame's, the fault is roof.front or roof.highSide (step 1): correct that instead. The
       only correction roof.porchEnd itself can take is to "front".
     * roof.porchAttachFt, projecting porches only, currently ${attachNow}: feet
       from the floor to the TOP of the porch roof where it meets the wall. Look at what shows
       between the porch roof and the top of that wall: a band of siding in the frame and none
       in the render, or the reverse, means this is wrong. Work it out against the ruler.
     * roof.porchWidthFt, projecting porches only, currently ${feet("porchWidthFt")}: how far
       the porch runs along its wall. "not set" means the whole wall, or the centre section
       when there are wings. Correct it only where the frame shows plain wall beyond the
       porch's ends.
     * roof.porchPosts, projecting porches only, currently ${postsNow}: how many posts stand
       along the porch's front edge, the corner posts included. Count them in the front
       viewpoint, in the frame and in the render, and correct it only where the counts differ.
     * roof.porchPitch, projecting porches only, currently ${porchPitchNow}: the porch
       roof's own rise over run, from a side viewpoint where its edge is seen square-on. Correct
       it only where the porch roof plainly falls more steeply, or less, than the render's. The
       render never draws a porch roof so steep that less than 6 ft stands under its beam, so a
       porch roof that meets the wall low is drawn flatter than porchPitch says; where that is
       why the render's is flatter, correct roof.porchAttachFt, never porchPitch.
     * roof.porchSteps, projecting porches only, currently ${stepsNow}: where steps leave the
       porch's front edge, "left", "center" or "right" as seen standing in front of it. Give it
       where the frame shows steps the render lacks, or shows them at a different place. Give
       "none" where the render shows steps the frame does not, or where the frame's steps leave
       the deck from one of its sides rather than its front edge: "none" removes them.

4. THE WALL, AS DRAWN (not the number). You cannot change wallHeightFt - it is measured. But
   if the render's walls look plainly shorter or taller than the frame's at the same angle
   while the roof matches, something else is absorbing the difference: say so in \`note\` and
   check whether the gambrel rises below are carrying it.

THEN THESE, only if the pictures disagree:
5. ROOF PROFILE. For a gambrel: kneeU, kneeRise, ridgeRise, measured from the CENTRELINE and
   the TOP OF THE WALL, each divided by the half-span. For a gable or shed: pitch. Check the
   silhouette at the head-on viewpoint. If the render's roof and the frame's roof trace the
   same outline, leave all of these alone.
6. roof.eave - "open" (a sawtooth row of rafter tails with gaps of sky between them) or
   "fascia" (one unbroken board). Only from a viewpoint that actually shows under the eave.
7. roofMaterial, foundation, gableVent - only if plainly wrong. (roof.type is step 1's.)
   foundation, currently ${foundationNow}: "slab" (the walls meet the ground), "skids" (low
   runners on the ground, a narrow shadow gap), "blocks" (stacked concrete blocks under the
   runners, a clear gap) or "piers" (concrete piers, a clear gap). With blocks or piers,
   floorHeightFt, currently ${floorNow}: feet from the ground to the TOP of the floor at the
   FRONT. Judge the gap under the building against the door (6 ft 8 in tall), or count the
   porch steps' risers (about 7 in each) from the ground up to the deck. Correct it only where
   the render's building plainly stands higher or lower off the ground than the frame's.

RETURN ONLY this JSON object, no prose and no markdown fence:
{
  "verdict": "matches" | "corrections",
  "corrections": { ... only the fields you are changing, in the same shape as the draft ... },
  "changed": [
    { "field": "roof.overhang", "from": 1.0, "to": 0.2,
      "why": "<one sentence naming what in which image made you change it>" }
  ],
  "checked": {
    "massing": "ok" | "changed" | "unclear",
    "overhang": "ok" | "changed" | "unclear",
    "porch": "ok" | "changed" | "unclear",
    "roofProfile": "ok" | "changed" | "unclear",
    "eave": "ok" | "changed" | "unclear"
  },
  "note": "<one sentence for the builder, or an empty string>"
}

RULES FOR THE ANSWER:
  * If nothing needs changing, return "verdict": "matches" with "corrections": {} and
    "changed": []. That is a complete, correct answer. Stop there.
  * Every field in "corrections" must also appear in "changed". Anything not in both is
    ignored.
  * Never return wallHeightFt, sizeFt, colors or siding${measuredEave === null ? "" : " or roof.overhang"}. They are not yours to change here.
  * Change at most ${SELF_CHECK_MAX_FIELDS} fields. If you believe more than ${SELF_CHECK_MAX_FIELDS} are wrong, the draft is
    not worth patching: return the ${SELF_CHECK_MAX_FIELDS} that matter most and say so in "note".
  * "unclear" is better than a guess. A field the frames genuinely do not settle should be
    left alone and marked unclear, not corrected to a typical value.`;
}

// ── THE LEGACY CHECK PROMPT: d3ab404's selfCheckPrompt, VERBATIM (fix, 2026-09-24) ──────────
// ⛔ FROZEN. What every check request WITHOUT frame "front" gets (selfCheckMode "legacy") --
// production's older designer, whose dimensions card typed W "across the gable end" and whose
// renderer and panel know none of the v2 keys. Lifted character for character from the function
// as it shipped at d3ab404 (only its name and the names of the frozen constants it reads were
// changed), and styleD3.test.ts pins its output by SHA-256 against what d3ab404 produced for the
// same inputs. Every word the check learns goes into selfCheckPrompt above; editing this one
// changes production's older designer and nothing else, so there is no reason left to. (Its
// inner comments are d3ab404's too, clamp numbers included.)
export function legacySelfCheckPrompt(opts: {
  dims: KnownDims;
  draft: D3Spec;
  viewpoints: readonly FrameMapViewpoint[];
}): string {
  const { dims, draft } = opts;
  const views = SELF_CHECK_LEGACY_VIEWPOINTS.filter((v) => opts.viewpoints.includes(v));
  const overhang = num((draft.roof ?? {})["overhang"]);
  const eave = overhang === null ? "not set" : `${dimFt(overhang)} ft`;
  // ⚠️ THE WALL THE RENDER WAS DRAWN AT, NOT THE ONE THAT WAS TYPED. parseKnownDims accepts a
  // measured wall of 3..20 ft and sanitizeD3Spec then CLAMPS it to the 5..14 the renderer can
  // draw, so a builder who measured 16 has a draft -- and therefore a set of renders -- with a
  // 14 ft wall in them. Stating the 16 here would tell the model that "every render you are
  // shown was drawn at exactly these dimensions" over pictures of a wall an eighth shorter,
  // and step 1 turns a fraction of that wall into feet: every length it read off a render
  // would be long by the same ratio, in the same direction, on roof.overhang -- the field this
  // whole pass exists to fix. Step 3 is worse still, because it asks whether the gambrel rises
  // are absorbing a wall difference, and the clamp is exactly such a difference.
  //
  // Width and length never clamp -- they are the ruler for this reading and are never stored --
  // so they stay as typed. The builder is told about the clamp separately, by knownDimsNote.
  const wall = dimFt(num(draft.wallHeightFt) ?? dims.wallHeightFt);
  // ⚠️ AND THE EAVE, WHERE THE BUILDER MEASURED IT. `overhangIn` is an optional chip on the
  // dimensions card: null means "read it off the video", and a number means they went and
  // looked. applyKnownDims has already written it into the draft, so asking the model to
  // re-measure it from a photograph is asking it to overwrite a tape measure with a guess --
  // on the one field this prompt spends its first and longest step on, and with nothing on the
  // panel reconciling the two afterwards (the chip goes on reading "16 in" while the spec says
  // 2, and pressing the chip again does nothing). applySelfCheck drops roof.overhang from the
  // allow-list for the same generation, so a correction would be thrown away in any case; this
  // is what stops the model spending its effort on a field that cannot land.
  const measuredEave = dims.overhangIn === undefined || dims.overhangIn === null ? null : dims.overhangIn;
  const present = views.length
    ? views.map((v) => `${v} (${SELF_CHECK_LEGACY_VIEW_WORDS[v]})`).join(", ")
    : "none";
  return `You drafted a 3D spec for a portable building from a walk-around video. We rendered your
draft and are showing you the result beside the builder's own frames. Your job now is
narrow: find the places where YOUR DRAFT does not match THEIR BUILDING, and correct only
those.

This is a check, not a second draft. Most fields will already be right. "It matches" is a
correct and expected answer, and it is the answer we expect most often. Do not change a
field to show you are working - a wrong correction is worse than no correction, because it
overwrites a number that was already good.

THE BUILDER HAS MEASURED THESE. They are facts, not your estimates, and you must not change
them or argue with them:
  building size: ${dimFt(dims.widthFt)} ft wide by ${dimFt(dims.lengthFt)} ft long
  wall height at the eave: ${wall} ft${measuredEave === null ? "" : `
  eave overhang: ${dimFt(measuredEave)} in past the wall`}
Use them as your ruler. Every render you are shown was drawn at exactly these dimensions, so
anything in a render can be measured against a wall you know the height of.

YOUR DRAFT, as rendered:
${JSON.stringify(draft, null, 2)}

THE IMAGES. Each viewpoint gives you two images in a row: first the builder's own frame,
then our render of your draft from the same angle. Compare them as SHAPES. Ignore the
background, the grass, the sky, the lighting, the sharpness, the neighbouring buildings, and
any door, window or vent - the render deliberately does not draw the openings, and their
absence is not a mistake to report.

THE VIEWPOINTS IN THIS REQUEST, in the order they appear below: ${present}. Those are the only
ones here. Where a step below names a viewpoint you were not given, answer it from what you do
have or mark it unclear - never read one view as though it were another.

CHECK EXACTLY THESE, IN THIS ORDER. For each one, say whether it matches or give a
correction. These first three are the ones this pass gets wrong most often, so spend your
effort here.

${measuredEave !== null ? `1. THE EAVE OVERHANG (roof.overhang, currently ${eave}). THE BUILDER MEASURED THIS ONE TOO
   and it is already in the draft. It is not yours to change: a correction to roof.overhang
   will be thrown away. Mark "overhang" as "ok" and spend the effort on the porch below.` : `1. THE EAVE OVERHANG (roof.overhang, currently ${eave}). Look at the close-up
   viewpoint, where the roof edge is seen in profile against the sky with the wall below it.
   Measure how far the roof stands out past the wall as a FRACTION OF THE WALL HEIGHT you
   were given, in the frame and in the render, and convert: a roof that projects a
   twentieth of the wall's height on a ${wall} ft wall is about
   ${wall}/20 ft. Buildings with a tight, trimmed eave are common and read as
   almost no projection at all - values near 0.15 ft are real. Do not settle on 1.0 ft
   because it is typical; report what this eave actually does.`}

2. THE PORCH, AND WHICH KIND (roof.porchOutFt / roof.porchDepthFt). There are two kinds and
   they are not interchangeable:
     * RECESSED (porchDepthFt): the end wall is set BACK into the building, the main roof
       carries straight over the gap, and nothing sticks out past the end of the roof.
     * PROJECTING (porchOutFt): the end wall runs full height with the door in it, and a
       deck with posts and its OWN lower roof stands OUT in front of that wall.
   The side viewpoint settles it: if the porch roof sticks out past the end of the building,
   it is projecting. If the end of the building is one flat plane, it is recessed. Getting
   this wrong is the single most visible error on the whole building, so check it even when
   the two pictures look broadly alike. If you change the kind, give the new key and leave
   the other one out entirely.

3. THE WALL, AS DRAWN (not the number). You cannot change wallHeightFt - it is measured. But
   if the render's walls look plainly shorter or taller than the frame's at the same angle
   while the roof matches, something else is absorbing the difference: say so in \`note\` and
   check whether the gambrel rises below are carrying it.

THEN THESE, only if the pictures disagree:
4. ROOF PROFILE. For a gambrel: kneeU, kneeRise, ridgeRise, measured from the CENTRELINE and
   the TOP OF THE WALL, each divided by the half-span. For a gable or shed: pitch. Check the
   silhouette at the head-on viewpoint. If the render's roof and the frame's roof trace the
   same outline, leave all of these alone.
5. roof.eave - "open" (a sawtooth row of rafter tails with gaps of sky between them) or
   "fascia" (one unbroken board). Only from a viewpoint that actually shows under the eave.
6. roof.type, roofMaterial, foundation, gableVent - only if plainly wrong.

RETURN ONLY this JSON object, no prose and no markdown fence:
{
  "verdict": "matches" | "corrections",
  "corrections": { ... only the fields you are changing, in the same shape as the draft ... },
  "changed": [
    { "field": "roof.overhang", "from": 1.0, "to": 0.2,
      "why": "<one sentence naming what in which image made you change it>" }
  ],
  "checked": {
    "overhang": "ok" | "changed" | "unclear",
    "porch": "ok" | "changed" | "unclear",
    "roofProfile": "ok" | "changed" | "unclear",
    "eave": "ok" | "changed" | "unclear"
  },
  "note": "<one sentence for the builder, or an empty string>"
}

RULES FOR THE ANSWER:
  * If nothing needs changing, return "verdict": "matches" with "corrections": {} and
    "changed": []. That is a complete, correct answer. Stop there.
  * Every field in "corrections" must also appear in "changed". Anything not in both is
    ignored.
  * Never return wallHeightFt, sizeFt, colors or siding${measuredEave === null ? "" : " or roof.overhang"}. They are not yours to change here.
  * Change at most ${SELF_CHECK_LEGACY_MAX_FIELDS} fields. If you believe more than ${SELF_CHECK_LEGACY_MAX_FIELDS} are wrong, the draft is
    not worth patching: return the ${SELF_CHECK_LEGACY_MAX_FIELDS} that matter most and say so in "note".
  * "unclear" is better than a guess. A field the frames genuinely do not settle should be
    left alone and marked unclear, not corrected to a typical value.`;
}

// ── READING THE REPLY ─────────────────────────────────────────────────────────────────────
// Tolerant of wrapping, strict about vocabulary, and NEVER invents a change. Returns null when
// the reply carries none of the four keys this prompt asks for, which the caller records as a
// failed check rather than as a silent pass.
//
// ⚠️ AN EMPTY OBJECT IS NOT "IT MATCHES". `{}` is what comes back when a model wrote prose and
// one stray brace, and reading that as a clean pass would inflate the single statistic this
// whole feature is judged on — how often the check leaves an already-good draft alone.
// "matches" has to be something the model SAID.
// `mode` (fix, 2026-09-24): the legacy check keeps d3ab404's four `checked` keys, so an older
// designer is handed exactly what it always was.
export function parseSelfCheck(text: string, mode: SelfCheckMode = "v2"): SelfCheckRead | null {
  const m = String(text || "").match(/\{[\s\S]*\}/);
  if (!m) return null;
  // deno-lint-ignore no-explicit-any
  let parsed: any;
  try { parsed = JSON.parse(m[0]); } catch { return null; }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const answered = ["verdict", "corrections", "changed", "checked"].some((k) => k in parsed);
  if (!answered) return null;

  const corrections = (parsed.corrections && typeof parsed.corrections === "object" && !Array.isArray(parsed.corrections))
    ? parsed.corrections as Record<string, unknown>
    : {};

  const changed: SelfCheckChange[] = [];
  if (Array.isArray(parsed.changed)) {
    for (const entry of parsed.changed) {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
      const e = entry as Record<string, unknown>;
      const field = typeof e.field === "string" ? e.field.trim().slice(0, 60) : "";
      if (!field) continue;
      // The model's own sentence, held to the same 240 as every other piece of model prose in
      // this file: it is shown to the builder beside the old and the new value.
      const why = typeof e.why === "string" ? e.why.replace(/\s+/g, " ").trim().slice(0, 240) : "";
      changed.push({ field, from: e.from ?? null, to: e.to ?? null, why });
    }
  }

  const checked: SelfCheckChecked = {};
  if (parsed.checked && typeof parsed.checked === "object" && !Array.isArray(parsed.checked)) {
    const src = parsed.checked as Record<string, unknown>;
    for (const k of selfCheckRules(mode).checkedKeys) {
      const v = src[k];
      if (typeof v === "string" && (SELF_CHECK_CHECKED_WORDS as readonly string[]).includes(v)) {
        checked[k as keyof SelfCheckChecked] = v;
      }
    }
  }

  const note = typeof parsed.note === "string" ? parsed.note.replace(/\s+/g, " ").trim().slice(0, 240) : "";
  // An unrecognised verdict is READ OFF THE ANSWER rather than trusted or refused. A model that
  // writes "ok" or "no_changes" while handing back three corrections has still handed back
  // three corrections, and one that writes "corrections" while changing nothing has changed
  // nothing. Neither reading can invent a change, because `changed` is the only source of one.
  const verdict: "matches" | "corrections" =
    parsed.verdict === "matches" ? "matches"
      : parsed.verdict === "corrections" ? "corrections"
        : (changed.length ? "corrections" : "matches");
  return { verdict, corrections, changed, checked, note };
}

// ── THE THREE GATES ───────────────────────────────────────────────────────────────────────
// A field is applied only if it appears in BOTH `corrections` and `changed[].field`, AND is on
// the allow-list, AND survives sanitizeD3Spec. Three independent gates on model output heading
// for a renderer a customer is quoted against.
//
// `from` and `to` are RECOMPUTED from the two specs rather than copied out of the reply. The
// model's own `from` is its recollection of a number it was shown, and its `to` is what it
// asked for rather than what landed: sanitizeD3Spec clamps, so an overhang corrected to 8 ft is
// recorded as the 3 ft it actually became. A correction whose value comes out of the sanitiser
// EQUAL to the draft's did not change anything, and is dropped rather than reported to the
// builder as a change — the "What the check changed" list has to be true line by line.
// `dims` is optional and carries ONE decision: if the builder measured the eave themselves
// (the overhang chip on the dimensions card), roof.overhang comes off the allow-list for this
// generation, exactly as wallHeightFt and sizeFt are permanently off it. Same rule, same
// reason -- a field the builder measured is not the check's to re-measure from a photograph.
// Absent (every existing caller, and production's older bundle, which sends no dims at all)
// means the list is unchanged.
//
// `mode` (fix, 2026-09-24) picks the allow-list and the cap: "legacy" is d3ab404's gate exactly
// (22 paths, six fields, and no v2 consequence report), so no v2 key can land from a check an
// older designer ran. Absent is "v2", which is every call this file's tests already make.
export function applySelfCheck(draft: unknown, read: SelfCheckRead, dims?: KnownDims | null, mode: SelfCheckMode = "v2"):
  | { ok: false; error: string }
  | {
    ok: true;
    verdict: "matches" | "corrections" | "rejected_too_many";
    d3: D3Spec;
    changed: SelfCheckChange[];
    dropped: string[];
  } {
  const base = sanitizeD3Spec(draft);
  // The draft came out of our own ledger row and went in through this same function, so this is
  // unreachable in practice. It is a refusal rather than a fallback because the alternative —
  // carrying on against a spec we could not read — would report a verdict about a building
  // nobody drafted.
  if (!base.ok) return { ok: false, error: `The recorded draft could not be read back: ${base.error}` };

  // Deduplicated, in the order the model listed them. A model naming the same field twice is
  // asking for one change, not two, and must not be pushed over the cap by its own repetition.
  const rules = selfCheckRules(mode);
  const declared: string[] = [];
  for (const c of read.changed) if (!declared.includes(c.field)) declared.push(c.field);
  if (declared.length > rules.maxFields) {
    return { ok: true, verdict: "rejected_too_many", d3: base.d3, changed: [], dropped: declared.slice() };
  }

  const measuredEave = !!dims && dims.overhangIn !== undefined && dims.overhangIn !== null;
  const allow = measuredEave
    ? rules.allow.filter((f) => f !== "roof.overhang")
    : rules.allow;
  const dropped: string[] = [];
  // The value the model wants at each allowed path. Read out of `corrections`, never out of the
  // `to` in `changed`: that one is prose about the change, and the prompt says a field has to be
  // in both to count.
  const wanted = new Map<string, unknown>();
  for (const field of declared) {
    if (!allow.includes(field)) { dropped.push(field); continue; }
    const dot = field.indexOf(".");
    const src = read.corrections;
    let value: unknown;
    if (dot < 0) {
      if (!(field in src)) { dropped.push(field); continue; }
      value = src[field];
    } else {
      const head = field.slice(0, dot), tail = field.slice(dot + 1);
      const inner = src[head];
      if (!inner || typeof inner !== "object" || Array.isArray(inner) || !(tail in (inner as Record<string, unknown>))) {
        dropped.push(field);
        continue;
      }
      value = (inner as Record<string, unknown>)[tail];
    }
    wanted.set(field, value);
  }

  // `roof.type` is checked against the three the renderer can draw BEFORE it is applied, because
  // it is the only correction that can make sanitizeD3Spec refuse the WHOLE spec rather than
  // clamp one field — and a refusal here would throw away a draft the builder has already paid
  // for.
  for (const field of [...wanted.keys()]) {
    if (field !== "roof.type") continue;
    if ((D3_ROOF_TYPES as readonly string[]).includes(String(wanted.get(field)))) continue;
    dropped.push(field);
    wanted.delete(field);
  }
  // AN OLDER DESIGNER'S CHECK KEEPS ITS OLD FOUNDATION WORDS (2026-09-25). The sanitiser now keeps
  // "blocks" and "piers", which that designer can neither draw nor show, so a legacy correction to
  // either is dropped as it always was (and the destructive pass never sees it). Its prompt, frozen,
  // names neither.
  if (mode === "legacy" && wanted.has("foundation") && !["skids", "slab"].includes(String(wanted.get("foundation")))) {
    dropped.push("foundation");
    wanted.delete("foundation");
  }

  // "none" TAKES THE PORCH STEPS OFF (v2, fix 2026-09-25). No steps is an ABSENT roof.porchSteps,
  // and absent is the one value a correction could not say: null, "none" and "" were all dropped by
  // the sanitiser, and the destructive pass below then put the draft's steps back. A first pass that
  // invented steps, or put a side stair on the front edge, could never be corrected in three rounds.
  // So an explicit "none" (the word the prompt offers) CLEARS the key: build() deletes it, and it is
  // never in `wanted`, so the destructive pass cannot restore it. Any other unreadable word still
  // leaves the draft's steps standing. Legacy never had the key on its allow-list.
  const cleared = new Set<string>();
  if (mode === "v2" && wanted.has("roof.porchSteps")
      && String(wanted.get("roof.porchSteps")).trim().toLowerCase() === "none") {
    wanted.delete("roof.porchSteps");
    cleared.add("roof.porchSteps");
  }

  // WHICH KEYS THE PORCH EXCLUSION TOOK OUT, recorded by build() rather than inferred by the
  // two passes that need it. They need it for opposite reasons and both were wrong without it:
  // the destructive pass must not undo a removal that was the POINT of the correction, and the
  // report must not call an applied correction a dropped one — or leave it out altogether.
  let excluded = new Set<string>();
  // Build the merged spec and hold it to the sanitiser. Written as a function because it may run
  // TWICE — see the destructive-correction pass below.
  const build = () => {
    const roof: Record<string, unknown> = { ...base.d3.roof };
    const merged: Record<string, unknown> = { ...base.d3, roof };
    for (const [field, value] of wanted) {
      if (field.startsWith("roof.")) roof[field.slice(5)] = value;
      else merged[field] = value;
    }
    for (const field of cleared) delete roof[field.slice(5)];
    // THE PORCH EXCLUSION, which is calDraftRoof's rule and has to run HERE rather than be left
    // to the sanitiser. sanitizeD3Spec drops porchDepthFt when porchOutFt is above 0.5 — the
    // projecting-wins direction — so a correction changing a PROJECTING porch to a RECESSED one
    // would be thrown away by the sanitiser and the stale projecting porch would stand, which is
    // the one correction on this whole list the baseline says matters most. The rule keys on the
    // CORRECTION's values, exactly as calDraftRoof keys on the incoming draft's.
    const out = num(wanted.get("roof.porchOutFt")) ?? 0;
    const depth = num(wanted.get("roof.porchDepthFt")) ?? 0;
    const gone = new Set<string>();
    if (out > 0.5) {
      delete roof.porchDepthFt; delete roof.porchTruss;
      gone.add("roof.porchDepthFt"); gone.add("roof.porchTruss");
    } else if (depth > 0.5) {
      delete roof.porchOutFt;
      gone.add("roof.porchOutFt");
    }
    excluded = gone;
    return sanitizeD3Spec(merged);
  };

  let finalSpec = build();
  // Defensive: with roof.type guarded above, the only refusal left is the 4 KB ceiling, and a
  // merge of a spec that already passed it cannot reach that. Keeping the draft and saying so is
  // the honest answer if it ever happens — better than reporting "matches" over a spec we could
  // not build.
  if (!finalSpec.ok) return { ok: false, error: `The corrected spec could not be built: ${finalSpec.error}` };

  // ⚠️ A CORRECTION THE SANITISER CANNOT READ MUST NOT DELETE THE VALUE IT WAS AIMED AT. The
  // sanitiser's posture everywhere is "drop what we cannot draw" — `eave: "flat"`, `foundation:
  // "piers"`, `roofMaterial: "tin"` are all simply not emitted — so writing one of them over a
  // key the draft already had would leave the key ABSENT. That is not a correction, it is a
  // deletion the model never asked for, and it would reach the builder as a real-looking
  // "fascia -> nothing" line. Any declared field that vanished this way is taken back out and
  // the spec is rebuilt once, so the draft's own value stands.
  //
  // Only DECLARED fields are restored, and never one the porch exclusion removed on purpose.
  // That exemption is load-bearing: a model that swaps the porch kind by DECLARING BOTH keys
  // ("porchOutFt": 6, "porchDepthFt": 0) had its own porchDepthFt read as unreadable here,
  // moved into `dropped` and taken out of `wanted`. The geometry still came out right — the
  // exclusion fires again off the base roof on the rebuild — but the builder was told the
  // recess had not been applied when it had, and that false line went into the info row
  // portal-settings writes as "changes that were not applied".
  const destructive = [...wanted.keys()].filter((f) =>
    !excluded.has(f)
    && readSpecPath(base.d3, f) !== undefined && readSpecPath((finalSpec as { d3: D3Spec }).d3, f) === undefined
  );
  if (destructive.length) {
    for (const f of destructive) { wanted.delete(f); dropped.push(f); }
    finalSpec = build();
    if (!finalSpec.ok) return { ok: false, error: `The corrected spec could not be built: ${finalSpec.error}` };
  }

  // What ACTUALLY moved, read off the two sanitised specs. A field the sanitiser clamped back to
  // where it started, or dropped outright, did not change.
  //
  // ⚠️ THE EXCLUDED KEYS ARE REPORTED TOO, and they are not declared. Swapping a recessed porch
  // for a projecting one is ONE correction to the model — the prompt tells it to "give the new
  // key and leave the other one out entirely" — and two changes to the building: the projection
  // appears and the recess (with its truss) goes. Reporting only the declared half left the
  // builder's "What the check changed" list saying the porch now sticks out 6 ft and never
  // saying the recess had been removed, on the correction the baseline calls the single most
  // visible error on the whole building. The list has to be true line by line AND complete;
  // reading both sides off the sanitised specs is what makes it both.
  const applied: SelfCheckChange[] = [];
  const report = declared.slice();
  for (const f of excluded) if (!report.includes(f)) report.push(f);
  for (const field of report) {
    const proposed = wanted.has(field) || cleared.has(field);
    if (!proposed && !excluded.has(field)) continue;
    const before = readSpecPath(base.d3, field);
    const after = readSpecPath(finalSpec.d3, field);
    if (JSON.stringify(before ?? null) === JSON.stringify(after ?? null)) {
      // Only something the MODEL asked for can be "not applied". A porch key the exclusion
      // would have removed had the draft carried one is not a proposal and belongs nowhere.
      if (proposed) dropped.push(field);
      continue;
    }
    const why = read.changed.find((c) => c.field === field)?.why ?? "";
    applied.push({ field, from: before ?? null, to: after ?? null, why });
  }
  // ⚠️ AND WHAT THE SANITISER'S OWN VALIDITY RULES TOOK WITH IT (v2). The porch exclusion above
  // is no longer the only rule that removes a key the model never named: roof.front exists only
  // on a two-slope roof and roof.highSide only on a shed, the wing keys only on gable/gambrel,
  // and a porch's attach height and width only while it projects. So a correction of roof.type
  // from gable to shed quietly takes roof.front and the wings with it, and a correction to a
  // recessed porch takes the attach height and width. Same rule as the exclusion: the list has
  // to be true line by line AND complete, so every allow-listed path that moved is on it. These
  // carry no `why` -- nobody asked for them; they are what the asked-for change cost.
  // v2 only: d3ab404 had no such pass, and the legacy check is d3ab404's (none of its 22 paths
  // can be taken by a validity rule the porch exclusion does not already report).
  for (const field of (mode === "v2" ? SELF_CHECK_ALLOW : []) as readonly string[]) {
    if (applied.some((c) => c.field === field)) continue;
    const before = readSpecPath(base.d3, field);
    const after = readSpecPath(finalSpec.d3, field);
    if (JSON.stringify(before ?? null) === JSON.stringify(after ?? null)) continue;
    applied.push({ field, from: before ?? null, to: after ?? null, why: "" });
  }
  // Nothing survived the gates. "matches" is the design's own answer for that — the draft stands
  // untouched, which is exactly what the builder sees — and `dropped` is what says the model
  // tried. The final spec is only handed back when something moved, so a caller that applies it
  // unconditionally still cannot re-merge a draft onto itself.
  return {
    ok: true,
    verdict: applied.length ? "corrections" : "matches",
    d3: applied.length ? finalSpec.d3 : base.d3,
    changed: applied,
    dropped,
  };
}

// ── WHAT THE WHOLE CHECK CHANGED, ACROSS ROUNDS (v2) ──────────────────────────────────────
// applySelfCheck reports ONE round: `from` is the spec that round judged, which after round 0
// is the previous round's output. What the builder reads, and what `self_check_changed` records,
// is the net effect against the FIRST DRAFT, so every line runs from `drafted` to the final spec
// and the list stays true line by line however many rounds produced it.
//
//  * A field a later round moved BACK to the draft's value is not a change any more and is not
//    listed. That is also how a flip-flop is seen: see selfCheckReverted.
//  * `earlier` is the row's own `self_check_changed` from the round before. It is read for its
//    ORDER and its `why` only, and only for allow-listed paths; every from/to is recomputed off
//    the two specs, exactly as applySelfCheck does, so nothing in that column is trusted as data.
//  * `why` is the latest round's that touched the field, else the earlier round's, else "".
//
// Round 0 comes out IDENTICAL to applySelfCheck's own list (same paths, order, values and why),
// which styleD3.test.ts pins -- so the single check an older browser runs records exactly what
// it always has.
export function selfCheckTotalChanges(
  first: D3Spec,
  final: D3Spec,
  earlier: unknown,
  latest: readonly SelfCheckChange[],
): SelfCheckChange[] {
  const allow = SELF_CHECK_ALLOW as readonly string[];
  const prior: { field: string; why: string }[] = [];
  if (Array.isArray(earlier)) {
    for (const e of earlier) {
      if (!e || typeof e !== "object" || Array.isArray(e)) continue;
      const r = e as Record<string, unknown>;
      if (typeof r.field !== "string" || !allow.includes(r.field)) continue;
      prior.push({ field: r.field, why: typeof r.why === "string" ? r.why.slice(0, 240) : "" });
    }
  }
  const order: string[] = [];
  for (const f of [...prior.map((p) => p.field), ...latest.map((c) => c.field)]) {
    if (allow.includes(f) && !order.includes(f)) order.push(f);
  }
  for (const f of allow) if (!order.includes(f)) order.push(f);
  const out: SelfCheckChange[] = [];
  for (const field of order) {
    const from = readSpecPath(first, field);
    const to = readSpecPath(final, field);
    if (JSON.stringify(from ?? null) === JSON.stringify(to ?? null)) continue;
    const mine = latest.find((c) => c.field === field);
    const why = mine ? mine.why : (prior.find((p) => p.field === field)?.why ?? "");
    out.push({ field, from: from ?? null, to: to ?? null, why });
  }
  return out;
}

// The fields THIS round moved straight back to where the first draft had them: an earlier round
// changed them and this one undid it. That is the flip-flop a multi-round check has to stop on,
// and the browser is told which fields rather than left to diff three specs to find out.
export function selfCheckReverted(
  total: readonly SelfCheckChange[],
  latest: readonly SelfCheckChange[],
): string[] {
  return latest.filter((c) => !total.some((t) => t.field === c.field)).map((c) => c.field);
}

// The allow-listed field NAMES from a row's `self_check_changed`, for the round note in
// selfCheckPrompt. Names only: the `why` in that column is model prose, and nothing a model wrote
// is spliced back into a prompt.
export function selfCheckChangedFields(changed: unknown): string[] {
  if (!Array.isArray(changed)) return [];
  const allow = SELF_CHECK_ALLOW as readonly string[];
  const out: string[] = [];
  for (const e of changed) {
    const f = e && typeof e === "object" && !Array.isArray(e) ? (e as Record<string, unknown>).field : null;
    if (typeof f === "string" && allow.includes(f) && !out.includes(f)) out.push(f);
  }
  return out;
}

// One level of dotting, which is all the allow-list has. Returns undefined for an absent key, so
// "absent" and "null" stay distinguishable at the call site.
function readSpecPath(spec: D3Spec, field: string): unknown {
  const dot = field.indexOf(".");
  const src = spec as unknown as Record<string, unknown>;
  if (dot < 0) return src[field];
  const inner = src[field.slice(0, dot)];
  if (!inner || typeof inner !== "object") return undefined;
  return (inner as Record<string, unknown>)[field.slice(dot + 1)];
}

// ── THE RENDERS ───────────────────────────────────────────────────────────────────────────
// Six JPEGs at most, 400 KB each at most, 1.8 MB in total at most, and JPEG is proved from the
// BYTES rather than believed from a header the caller wrote. Everything here REFUSES rather than
// drops: a render that is the wrong size or the wrong type is a fault in the half of this
// feature we ship alongside it, and silently comparing five views instead of six would hide
// that while making the check quietly worse.
//
// `frame` is a 1-based index into the array of images the FIRST call was given, which is what
// the first pass's frameMap indices mean. It is bounded here only by the length of that array;
// whether the image at that position is one the style actually owns is settled by
// selfCheckPairs, against the style's own stored lists.
export type SelfCheckRender = { viewpoint: FrameMapViewpoint; frame: number; base64: string; bytes: number };

const JPEG_DATA_PREFIX = /^data:image\/jpe?g;base64,/i;
const ANY_DATA_PREFIX = /^data:/i;

// `mode` (fix, 2026-09-24): the legacy check takes d3ab404's four viewpoints, four renders and
// 1.2 MB, refused in d3ab404's words; absent is "v2".
export function parseSelfCheckRenders(raw: unknown, frameCount: number, mode: SelfCheckMode = "v2"):
  { ok: true; renders: SelfCheckRender[] } | { ok: false; error: string } {
  const rules = selfCheckRules(mode);
  if (!Array.isArray(raw) || raw.length === 0) return { ok: false, error: "The check needs at least one render." };
  if (raw.length > rules.maxRenders) {
    return { ok: false, error: `A check compares at most ${rules.maxRenders} views, and ${raw.length} were sent.` };
  }
  const bound = Math.floor(num(frameCount) ?? 0);
  const renders: SelfCheckRender[] = [];
  const seen = new Set<string>();
  let total = 0;
  for (const entry of raw) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      return { ok: false, error: "A render was sent in a shape we cannot read." };
    }
    const e = entry as Record<string, unknown>;
    const viewpoint = String(e.viewpoint ?? "");
    if (!(rules.viewpoints as readonly string[]).includes(viewpoint)) {
      return { ok: false, error: `"${viewpoint.slice(0, 40)}" is not a viewpoint this check knows.` };
    }
    // One render per viewpoint. Two renders labelled `side` would put two pictures of the same
    // view in front of the model and leave a view it asked about missing, with nothing saying so.
    if (seen.has(viewpoint)) return { ok: false, error: `Two renders were sent for the ${viewpoint} view.` };
    seen.add(viewpoint);
    const frame = num(e.frame);
    if (frame === null || !Number.isInteger(frame) || frame < 1 || frame > bound) {
      return { ok: false, error: `The ${viewpoint} render names image ${String(e.frame).slice(0, 20)}, which was not in this generation.` };
    }
    if (typeof e.base64 !== "string" || !e.base64.trim()) return { ok: false, error: `The ${viewpoint} render had no image data.` };
    const head = e.base64.trim();
    // A data: prefix is allowed only when it says JPEG. Any other prefix is refused rather than
    // stripped: the bytes are sniffed below anyway, but a caller that believes it is sending a
    // PNG has a bug worth hearing about now rather than at the next render-size change.
    if (ANY_DATA_PREFIX.test(head) && !JPEG_DATA_PREFIX.test(head)) {
      return { ok: false, error: `The ${viewpoint} render is not a JPEG.` };
    }
    const b64 = head.replace(JPEG_DATA_PREFIX, "");
    let bytes: Uint8Array;
    try {
      bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    } catch {
      return { ok: false, error: `The ${viewpoint} render was not readable image data.` };
    }
    if (bytes.length > SELF_CHECK_MAX_RENDER_BYTES) {
      return {
        ok: false,
        error: `The ${viewpoint} render is ${Math.round(bytes.length / 1000)} KB, over the ${Math.round(SELF_CHECK_MAX_RENDER_BYTES / 1000)} KB a check allows.`,
      };
    }
    // JPEG's start-of-image marker. This is what makes "image/jpeg only" a fact about the
    // payload rather than a claim about a string the caller chose.
    if (bytes.length < 4 || bytes[0] !== 0xFF || bytes[1] !== 0xD8 || bytes[2] !== 0xFF) {
      return { ok: false, error: `The ${viewpoint} render is not a JPEG.` };
    }
    total += bytes.length;
    if (total > rules.totalRenderBytes) {
      return { ok: false, error: `Those renders come to more than the ${Math.round(rules.totalRenderBytes / 1000)} KB a check allows.` };
    }
    renders.push({ viewpoint: viewpoint as FrameMapViewpoint, frame, base64: b64, bytes: bytes.length });
  }
  return { ok: true, renders };
}

// ── WHICH OF THE BUILDER'S FRAMES MAY BE SHOWN ────────────────────────────────────────────
// The caller re-sends the same array of image URLs the first call was given, because the frame
// indices only mean anything against that array. NOTHING IN IT IS TRUSTED EXCEPT ITS POSITIONS:
// a URL only ever reaches the model if the STYLE ITSELF stores it, in `d3_video_frames` or
// `d3_photos`. `sanitizePhotoUrls` accepts any https URL up to 600 characters and is not bucket
// scoped, so taking the caller's list as the frame list would make this a free vision call on
// any twelve images anywhere.
//
// ⚠️ THE ARRAY IS NEVER COMPACTED. Dropping a disallowed URL and closing the gap would shift
// every index after it, and a render aimed at image 6 would be paired with image 7 — a wrong
// pairing that looks exactly like a right one. Positions are held; a render whose position is
// out of range or not allowed loses its frame and is dropped whole, because a render with no
// frame beside it is our own drawing with nothing to compare it against.
//
// Ordered canonically rather than in the caller's order, so two runs of one generation put the
// same pictures in the same places.
export function selfCheckPairs(
  sentUrls: readonly unknown[],
  allowed: readonly string[],
  renders: readonly SelfCheckRender[],
): { viewpoint: FrameMapViewpoint; frameUrl: string; base64: string }[] {
  const ok = new Set(allowed.filter((u): u is string => typeof u === "string" && !!u));
  const out: { viewpoint: FrameMapViewpoint; frameUrl: string; base64: string }[] = [];
  for (const v of SELF_CHECK_VIEWPOINTS) {
    const r = renders.find((x) => x.viewpoint === v);
    if (!r) continue;
    const url = sentUrls[r.frame - 1];
    if (typeof url !== "string" || !ok.has(url)) continue;
    out.push({ viewpoint: v, frameUrl: url, base64: r.base64 });
  }
  return out;
}

// The one line each pair is introduced with, so the model is never guessing which of two
// adjacent images is the photograph and which is ours.
// The legacy check labels its pairs in d3ab404's words ("the end the door is on", "a long wall").
export function selfCheckPairLabel(viewpoint: FrameMapViewpoint, mode: SelfCheckMode = "v2"): string {
  const words = mode === "legacy"
    ? (SELF_CHECK_LEGACY_VIEW_WORDS[viewpoint] ?? SELF_CHECK_VIEW_WORDS[viewpoint])
    : SELF_CHECK_VIEW_WORDS[viewpoint];
  return `VIEWPOINT "${viewpoint}" - ${words}. The builder's own frame comes first, then our render of your draft from the same angle.`;
}

// ── WHICH MODEL READS THE FRAMES (2026-09-24) ────────────────────────────────────────────────
// The v2 path (the new designer, frame "front") runs Opus; the legacy path keeps Sonnet, byte for
// byte, so production's older designer sees no change in its requests or its timing.
//
// MEASURED, not assumed. The same 12 walk-around frames and the same v2 prompts, three runs per
// building, scored against tape-and-batten truth: Sonnet's first pass got the shed's high side
// right 2/3, the porch kind 1/3 and the raised centre's wings 2/3, and its self-check approved a
// roof sloping the wrong way; Opus's first pass passed 6/6 (five at 100%) and its check corrected
// every one of Sonnet's wrong drafts in one round. The 2026-09 note that "a bigger model would not
// help" was about fields the old vocabulary could express; the discrete massing reads added since
// (which wall is high, both wings, porch in front of the wall) are where the model is the limit.
//
// A refusal is handled exactly as before on both paths (ai_spec_refused / the check's refused
// verdict): the hold is released and the builder is told plainly.
export const AI_MODEL_LEGACY = "claude-sonnet-5";
export const AI_MODEL_V2 = "claude-opus-5";
// The model field of a request body for one path: spread into the body, never mutated.
export function aiModelFields(v2: boolean): Record<string, unknown> {
  return { model: v2 ? AI_MODEL_V2 : AI_MODEL_LEGACY };
}
// ── WHAT A DRAFT COSTS US, BY MODEL (fix, 2026-09-25) ────────────────────────────────────────
// List prices in US dollars per million tokens, input and output, for the two models above.
export const AI_MODEL_LIST_USD_PER_MTOK: Readonly<Record<string, { input: number; output: number }>> = {
  [AI_MODEL_LEGACY]: { input: 2, output: 10 },
  [AI_MODEL_V2]: { input: 5, output: 25 },
};
// The cost basis a metered draft's capture records (wallet_transactions.cost_cents, OUR gross
// margin figure, never a tenant-facing price), in cents. Picked with the SAME flag as
// aiModelFields, so it is the model the request actually ran.
//   v2      the Opus list price above. Until 2026-09-25 every capture used one hardcoded Sonnet
//           rate, $3/$15, so each Opus draft recorded about 60% of what it cost.
//   legacy  FROZEN at that $3/$15, the number every capture has recorded since the meter was
//           built, so production's older designer records exactly what it always has. Sonnet 5
//           lists at $2/$10, so this over-states it by half; the raw tokens are stored and
//           `draft_tokens.model` says which model ran, so a correction can be applied later.
export function aiDraftCostCents(v2: boolean, inputTokens: number, outputTokens: number): number {
  if (!v2) return Math.round((inputTokens * 0.0003 + outputTokens * 0.0015) * 100) / 100;
  const rate = AI_MODEL_LIST_USD_PER_MTOK[AI_MODEL_V2];
  // Dollars per million tokens to cents per token: x 100 / 1,000,000.
  return Math.round((inputTokens * rate.input / 10_000 + outputTokens * rate.output / 10_000) * 100) / 100;
}

// ── THE WHOLE REQUEST, IN ONE PURE FUNCTION (fix, 2026-09-24) ────────────────────────────────
// The prompt, the labelled pairs, the model, the budget and the abort -- everything the check
// sends -- built here rather than inline in portal-settings, so "an older designer's check is
// d3ab404's check" is a test on the BYTES of the request (styleD3.test.ts hashes the legacy body
// against what d3ab404's handler built for the same row) rather than a claim about a handler.
// The caller only adds the headers and the signal, and reads `abortMs` for the latter.
export type SelfCheckPair = { viewpoint: FrameMapViewpoint; frameUrl: string; base64: string };
export function selfCheckRequest(opts: {
  mode: SelfCheckMode;
  dims: KnownDims;
  draft: D3Spec;
  pairs: readonly SelfCheckPair[];
  // v2 only, and read off the ledger row by the caller (see selfCheckPrompt).
  round?: number;
  earlier?: readonly string[];
}): { abortMs: number; body: Record<string, unknown> } {
  const viewpoints = opts.pairs.map((p) => p.viewpoint);
  const text = opts.mode === "legacy"
    ? legacySelfCheckPrompt({ dims: opts.dims, draft: opts.draft, viewpoints })
    : selfCheckPrompt({ dims: opts.dims, draft: opts.draft, viewpoints, round: opts.round, earlier: opts.earlier });
  const content: unknown[] = [{ type: "text", text }];
  for (const p of opts.pairs) {
    content.push({ type: "text", text: selfCheckPairLabel(p.viewpoint, opts.mode) });
    content.push({ type: "image", source: { type: "url", url: p.frameUrl } });
    content.push({ type: "image", source: { type: "base64", media_type: "image/jpeg", data: p.base64 } });
  }
  const budget = SELF_CHECK_BUDGET[opts.mode];
  return {
    abortMs: budget.abortMs,
    body: {
      ...aiModelFields(opts.mode !== "legacy"),
      max_tokens: budget.maxTokens,
      thinking: { type: "adaptive" },
      output_config: { effort: "medium" },
      messages: [{ role: "user", content }],
    },
  };
}

// ═══ CONSENSUS DRAFTING (2026-09-25) ═══════════════════════════════════════════════════════════
// Live v2 runs of ONE video give the same SHAPE every time and wandering NUMBERS: a raised centre's
// eave read 15, then 14, then 12.5 ft; the pitch anywhere from 0.37 to 0.7; 3 porch posts one run and
// 4 the next; the steps in the centre, then on the right. Each read is a fair sample of what the
// frames support, so three independent reads combined take out most of that scatter. The v2 draft
// (and only it: see draftCallCount) therefore sends the SAME request three times in parallel, and
// combines what comes back here.
//
// The half in this file is pure (runDraftCalls takes its fetch as an argument). portal-settings'
// calibrate_style_ai owns the wiring, the hold, the ledger and the money, and
// aiDraftConsensusWiring_test runs that wiring.

// Three reads, and the cut-off for a straggler once two are in. The grace is a latency bound, not a
// quality one. It was 20 s until 2026-09-25, and live runs showed what that cost: the straggler is
// usually the read that THOUGHT (3,400-5,400 tokens, 56-106 s) while the two quick ones had barely
// thought at all, so a 20 s grace kept the two shallow reads and threw the careful one away. At
// effort "high" every read thinks; 60 s lets the slowest of them in within the draft budget.
export const DRAFT_CONSENSUS_CALLS = 3;
export const DRAFT_CONSENSUS_QUORUM = 2;
export const DRAFT_CONSENSUS_GRACE_MS = 60_000;

// How many calls a draft makes. ONE on every legacy request (production's older designer: its
// request, its timing and its cost stay exactly what they were) and on the lean retry (a retry after
// a cut-off or timed-out reply is already short of time, and three parallel reads would not make
// the reply that ran out of room any shorter).
export function draftCallCount(v2: boolean, lean: boolean): number {
  return v2 && !lean ? DRAFT_CONSENSUS_CALLS : 1;
}

// One reply body, read the way calibrate_style_ai reads it: every text block joined (modelReplyText),
// a refusal is never a draft, and the spec is parseModelSpec's (the builder's dims over the model's
// numbers, then the sanitiser). Never throws: a body that is not JSON reads as no reply at all.
export type DraftReading = {
  // deno-lint-ignore no-explicit-any
  data: Record<string, any> | null;
  reply: ModelReply;
  d3: D3Spec | null;
  drafted: boolean;
};
export function readDraftReply(body: string, dims?: KnownDims | null): DraftReading {
  // deno-lint-ignore no-explicit-any
  let data: any = null;
  try { data = JSON.parse(body); } catch { data = null; }
  if (!data || typeof data !== "object" || Array.isArray(data)) data = null;
  const reply = modelReplyText(data);
  const spec = reply.stopReason === "refusal" ? null : parseModelSpec(reply.text, dims);
  const d3 = spec && spec.ok ? spec.d3 : null;
  return { data, reply, d3, drafted: d3 !== null };
}

// ─── The calls ─────────────────────────────────────────────────────────────────────────────────
// Which clock stopped a call that threw, read the moment it threw: "deadline" is the draft's one
// abort budget (draftAbortMs, shared by every call), "quorum" the straggler cut-off below.
export type DraftCallAbort = "deadline" | "quorum";
export type DraftCall<R> = { index: number; ms: number } & (
  // fetch, or the body read, threw: no reply
  | { threw: true; error: unknown; aborted: DraftCallAbort | null; status: null; httpOk: false; body: ""; reading: null }
  // a reply that was not 2xx (a 429, a 529): its body is the error text
  | { threw: false; error: null; aborted: null; status: number; httpOk: false; body: string; reading: null }
  // a 2xx reply, read
  | { threw: false; error: null; aborted: null; status: number; httpOk: true; body: string; reading: R }
);

// Sends `count` calls in parallel and settles every one of them; never rejects.
//
//   * ONE call is sent on the deadline signal ITSELF, so a single call is the request today's
//     handler sent, on the signal it sent it on, classified the way it classified it.
//   * Several calls each get their own signal, aborted by the shared deadline (one budget for all,
//     never one each) or by the quorum cut-off: once DRAFT_CONSENSUS_QUORUM of them have DRAFTED
//     (a 2xx reply that `read` says parses), the rest get `graceMs` more and are then aborted.
//   * A failed call is simply one more result: the caller decides what three failures mean.
//
// The results come back in SEND order (index), not in arrival order, so "the first call" is always
// the same call whichever one the network happened to answer first.
export async function runDraftCalls<R extends { drafted: boolean }>(opts: {
  count: number;
  deadline: AbortSignal;
  graceMs: number;
  send: (signal: AbortSignal) => Promise<Response>;
  read: (body: string) => R;
}): Promise<DraftCall<R>[]> {
  const count = Math.max(1, Math.floor(opts.count) || 1);
  const quorum = Math.min(DRAFT_CONSENSUS_QUORUM, count);
  const cutoff = new AbortController();
  let drafted = 0;
  let graceTimer: ReturnType<typeof setTimeout> | undefined;
  const one = async (index: number): Promise<DraftCall<R>> => {
    const started = Date.now();
    let signal = opts.deadline;
    let unlink = () => {};
    if (count > 1) {
      const own = new AbortController();
      const stop = () => own.abort();
      opts.deadline.addEventListener("abort", stop);
      cutoff.signal.addEventListener("abort", stop);
      unlink = () => {
        opts.deadline.removeEventListener("abort", stop);
        cutoff.signal.removeEventListener("abort", stop);
      };
      if (opts.deadline.aborted || cutoff.signal.aborted) own.abort();
      signal = own.signal;
    }
    try {
      const res = await opts.send(signal);
      const body = await res.text();
      const ms = Date.now() - started;
      if (!res.ok) return { index, ms, threw: false, error: null, aborted: null, status: res.status, httpOk: false, body, reading: null };
      const reading = opts.read(body);
      if (reading.drafted && count > 1 && ++drafted === quorum && quorum < count) {
        graceTimer = setTimeout(() => cutoff.abort(), Math.max(0, opts.graceMs));
      }
      return { index, ms, threw: false, error: null, aborted: null, status: res.status, httpOk: true, body, reading };
    } catch (error) {
      const aborted: DraftCallAbort | null = opts.deadline.aborted ? "deadline" : cutoff.signal.aborted ? "quorum" : null;
      return { index, ms: Date.now() - started, threw: true, error, aborted, status: null, httpOk: false, body: "", reading: null };
    } finally {
      unlink();
    }
  };
  try {
    return await Promise.all(Array.from({ length: count }, (_, i) => one(i)));
  } finally {
    if (graceTimer !== undefined) clearTimeout(graceTimer);
  }
}

// ─── Combining the reads ───────────────────────────────────────────────────────────────────────
// THE BASE IS THE MEDOID: the read that disagrees least, in total, with the others over the
// discrete fields below. Every field this does not decide (and the builder-facing `observed` notes
// and the frame map, which are prose and picks that cannot be averaged) is the medoid's own.
//
// DISCRETE FIELDS GO BY MAJORITY; a tie goes to the medoid's value. Only reads that GAVE an answer
// vote, and a field that belongs to a structure (which end the porch is on, which side the wings are
// on) is voted only by the reads that chose that structure: a read that saw no porch has no opinion
// on where its steps are. Where leaving a key out is itself an answer, it votes as one: no steps, a
// porch across the whole wall (porchWidthFt left out), a porch roof hung at the wall top
// (porchAttachFt left out), no wings, no lean-to, no dormer, no gable vent. Presence is read the way
// the renderer draws it (a porch, lean-to, dormer or wing over half a foot).
//
// NUMBERS ARE THE MEDIAN over the reads that agree with the structure chosen for them: the porch's
// numbers from the reads with the chosen porch kind, the wings' from the reads with wings, the pitch
// and the gambrel ratios from the reads of the chosen roof type, the tail spacing from the reads with
// an open eave. Two values give their midpoint; porchPosts is rounded to a whole post. A dormer's
// offset is signed (the sign is the slope it sits on), so the slope is voted first and only the reads
// on that slope are averaged; the midpoint of -0.5 and 0.5 would put it on the ridge.
//
// COLOURS: per key, the median of each channel over the reads that gave the key. Two readings far
// apart (a channel more than CONSENSUS_COLOR_BLEND_MAX apart) are a split read, not noise, and their
// midpoint would be a third colour neither read saw, so the medoid's reading (or the best-ranked
// read that gave one) is kept instead.
//
// The result goes back through sanitizeD3Spec. One read comes back exactly as it went in.
export type ConsensusDraft = { d3: D3Spec; observed: ObservedNotes | null; frameMap: FrameMap | null };
export type ConsensusReport = {
  n: number;
  // The medoid's position in the drafts given.
  medoid: number;
  // Per discrete field: how many of the reads that voted gave the chosen answer, "k/n".
  discreteAgreement: Record<string, string>;
  // Per number the reads did NOT agree on: the lowest and highest read. A number every read gave
  // alike has no entry, which keeps the report to the fields that wandered.
  spread: Record<string, [number, number]>;
};
export type ConsensusResult = {
  d3: D3Spec;
  observed: ObservedNotes | null;
  frameMap: FrameMap | null;
  medoid: number;
  report: ConsensusReport;
};

export const CONSENSUS_COLOR_BLEND_MAX = 64;

type ConsensusRoof = Record<string, unknown>;
const cRoof = (d: D3Spec): ConsensusRoof => (d.roof || {}) as ConsensusRoof;
const cOn = (v: unknown): boolean => (num(v) ?? 0) > 0.5;
const cStr = (v: unknown): string | null => (typeof v === "string" && v ? v : null);
// The porch as the renderer and the panel read it (d3ProjectingPorch, calPorchKind): over half a foot.
function consensusPorchKind(roof: ConsensusRoof): PorchKind {
  if (cOn(roof.porchOutFt)) return "projecting";
  if (cOn(roof.porchDepthFt)) return "recessed";
  return "none";
}
const cWings = (r: ConsensusRoof) => r.type !== "shed" && cOn(r.wingWidthFt);
const cLeanTo = (r: ConsensusRoof) => cOn(r.leanToWidthFt);
const cDormer = (r: ConsensusRoof) => r.type !== "shed" && cOn(r.dormerWidthFt);
// Absent is the renderer's 0.45, which is on the right-hand (positive) slope.
const cDormerSide = (r: ConsensusRoof) => {
  const u = num(r.dormerOffsetU) ?? 0.45;
  return u < 0 ? "left" : u > 0 ? "right" : "ridge";
};

type ConsensusField = {
  name: string;
  // Voted only among the reads whose answer to this field matches the one chosen for it.
  parent?: string;
  // This read's answer, or null when it gave none (or the field does not apply to it).
  key: (d: D3Spec) => string | null;
  // Writes the chosen answer into the result, copied from `rep` (the best-ranked read that gave it);
  // `rep` null means nobody voted, so the key goes. Fields without one are carried by the numbers.
  apply?: (out: D3Spec, rep: D3Spec | null) => void;
};
const copyRoofKey = (k: string) => (out: D3Spec, rep: D3Spec | null) => {
  const from = rep ? cRoof(rep) : null;
  if (from && k in from) out.roof[k] = from[k];
  else delete out.roof[k];
};
const copySpecKey = (k: "roofMaterial" | "foundation") => (out: D3Spec, rep: D3Spec | null) => {
  if (rep && rep[k] !== undefined) out[k] = rep[k];
  else delete out[k];
};
const CONSENSUS_FIELDS: readonly ConsensusField[] = [
  { name: "type", key: (d) => cStr(cRoof(d).type), apply: copyRoofKey("type") },
  { name: "front", parent: "type", key: (d) => (cRoof(d).type !== "shed" ? cStr(cRoof(d).front) : null), apply: copyRoofKey("front") },
  { name: "highSide", parent: "type", key: (d) => (cRoof(d).type === "shed" ? cStr(cRoof(d).highSide) : null), apply: copyRoofKey("highSide") },
  { name: "eave", key: (d) => cStr(cRoof(d).eave), apply: copyRoofKey("eave") },
  { name: "porch", key: (d) => consensusPorchKind(cRoof(d)) },
  { name: "porchEnd", parent: "porch", key: (d) => (consensusPorchKind(cRoof(d)) !== "none" ? cStr(cRoof(d).porchEnd) : null), apply: copyRoofKey("porchEnd") },
  { name: "porchTruss", parent: "porch", key: (d) => (consensusPorchKind(cRoof(d)) === "recessed" ? String(cRoof(d).porchTruss === true) : null), apply: copyRoofKey("porchTruss") },
  { name: "porchSteps", parent: "porch", key: (d) => (consensusPorchKind(cRoof(d)) === "projecting" ? (cStr(cRoof(d).porchSteps) ?? "none") : null), apply: copyRoofKey("porchSteps") },
  { name: "porchAttach", parent: "porch", key: (d) => (consensusPorchKind(cRoof(d)) === "projecting" ? (num(cRoof(d).porchAttachFt) !== null ? "given" : "wall top") : null) },
  { name: "porchWidth", parent: "porch", key: (d) => (consensusPorchKind(cRoof(d)) === "projecting" ? (num(cRoof(d).porchWidthFt) !== null ? "part" : "full") : null) },
  { name: "wings", key: (d) => (cWings(cRoof(d)) ? "yes" : "no") },
  { name: "wingSide", parent: "wings", key: (d) => (cWings(cRoof(d)) ? (cStr(cRoof(d).wingSide) ?? "both") : null), apply: copyRoofKey("wingSide") },
  { name: "leanTo", key: (d) => (cLeanTo(cRoof(d)) ? "yes" : "no") },
  { name: "leanToSide", parent: "leanTo", key: (d) => (cLeanTo(cRoof(d)) ? (cStr(cRoof(d).leanToSide) ?? "right") : null), apply: copyRoofKey("leanToSide") },
  { name: "dormer", key: (d) => (cDormer(cRoof(d)) ? "yes" : "no") },
  { name: "dormerType", parent: "dormer", key: (d) => (cDormer(cRoof(d)) ? (cStr(cRoof(d).dormerType) ?? "gable") : null), apply: copyRoofKey("dormerType") },
  { name: "dormerSide", parent: "dormer", key: (d) => (cDormer(cRoof(d)) ? cDormerSide(cRoof(d)) : null) },
  { name: "roofMaterial", key: (d) => cStr(d.roofMaterial), apply: copySpecKey("roofMaterial") },
  { name: "foundation", key: (d) => cStr(d.foundation), apply: copySpecKey("foundation") },
  { name: "gableVent", key: (d) => (d.gableVent ? "yes" : "no") },
];

type ConsensusNumber = {
  name: string;
  get: (d: D3Spec) => number | null;
  set: (out: D3Spec, v: number | null) => void;
  // Whether this read's value counts, given the answers already chosen.
  counts: (d: D3Spec, chosen: Record<string, string | null>) => boolean;
  whole?: boolean;
};
const roofNumber = (k: string, counts: ConsensusNumber["counts"], whole = false): ConsensusNumber => ({
  name: k,
  get: (d) => num(cRoof(d)[k]),
  set: (out, v) => { if (v === null) delete out.roof[k]; else out.roof[k] = v; },
  counts,
  whole,
});
const sameType = (d: D3Spec, c: Record<string, string | null>) => cRoof(d).type === c.type;
const always = () => true;
const porchIs = (kind: PorchKind) => (d: D3Spec, c: Record<string, string | null>) => c.porch === kind && consensusPorchKind(cRoof(d)) === kind;
const CONSENSUS_NUMBERS: readonly ConsensusNumber[] = [
  roofNumber("pitch", sameType),
  roofNumber("ridgeOffset", sameType),
  roofNumber("overhang", always),
  roofNumber("kneeU", sameType),
  roofNumber("kneeRise", sameType),
  roofNumber("ridgeRise", sameType),
  roofNumber("tailSpacingIn", (d, c) => c.eave === "open" && cRoof(d).eave === "open"),
  roofNumber("leanToWidthFt", (d, c) => c.leanTo === "yes" && cLeanTo(cRoof(d))),
  roofNumber("leanToDropFt", (d, c) => c.leanTo === "yes" && cLeanTo(cRoof(d))),
  roofNumber("dormerWidthFt", (d, c) => c.dormer === "yes" && cDormer(cRoof(d))),
  roofNumber("dormerRiseFt", (d, c) => c.dormer === "yes" && cDormer(cRoof(d))),
  roofNumber("dormerOffsetU", (d, c) => c.dormer === "yes" && cDormer(cRoof(d)) && cDormerSide(cRoof(d)) === c.dormerSide),
  roofNumber("porchDepthFt", porchIs("recessed")),
  roofNumber("porchOutFt", porchIs("projecting")),
  roofNumber("porchAttachFt", (d, c) => c.porchAttach === "given" && porchIs("projecting")(d, c)),
  roofNumber("porchWidthFt", (d, c) => c.porchWidth === "part" && porchIs("projecting")(d, c)),
  roofNumber("porchPosts", porchIs("projecting"), true),
  roofNumber("porchPitch", porchIs("projecting")),
  roofNumber("wingWidthFt", (d, c) => c.wings === "yes" && cWings(cRoof(d))),
  roofNumber("wingPitch", (d, c) => c.wings === "yes" && cWings(cRoof(d))),
  roofNumber("centerEaveFt", (d, c) => c.wings === "yes" && cWings(cRoof(d))),
  {
    name: "wallHeightFt",
    get: (d) => num(d.wallHeightFt),
    set: (out, v) => { if (v === null) delete out.wallHeightFt; else out.wallHeightFt = v; },
    counts: always,
  },
  {
    name: "gableVent.widthFrac",
    get: (d) => (d.gableVent ? num(d.gableVent.widthFrac) : null),
    set: (out, v) => { if (v === null) delete out.gableVent; else out.gableVent = { widthFrac: v }; },
    counts: (d, c) => c.gableVent === "yes" && !!d.gableVent,
  },
];
const CONSENSUS_COLOR_KEYS = ["body", "trim", "roof", "wood", "corner", "fascia"] as const;

// The median; two values give their midpoint, held to four places so a float sum cannot leave
// 0.5349999999999999 in a customer's column. One value is returned exactly.
function consensusMedian(values: number[]): number {
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  if (s.length % 2) return s[mid];
  return Math.round(((s[mid - 1] + s[mid]) / 2) * 10_000) / 10_000;
}

function hexRgb(v: string): [number, number, number] | null {
  const h = v.trim().replace(/^#/, "");
  const full = h.length === 3 || h.length === 4 ? h.slice(0, 3).split("").map((c) => c + c).join("")
    : h.length === 6 || h.length === 8 ? h.slice(0, 6) : null;
  if (!full || !/^[0-9a-fA-F]{6}$/.test(full)) return null;
  return [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16)) as [number, number, number];
}
const rgbHex = (c: number[]) => "#" + c.map((x) => Math.round(x).toString(16).padStart(2, "0")).join("");

// How many of a read's OWN checks it fails (the ones portal-settings shows the builder): a read that
// contradicts itself is the worse base when the disagreement count ties, which with two reads it
// always does.
function consensusSelfDoubts(d: ConsensusDraft): number {
  const roof = cRoof(d.d3);
  return [frameKeyWarning(roof), gambrelRoofWarning(roof), porchAgreementWarning(roof, d.observed), wingsAgreementWarning(roof, d.observed)]
    .filter((w) => w !== null).length;
}
const CONFIDENCE_RANK: Record<string, number> = { high: 0, medium: 1, low: 2 };

export function consensusDrafts(drafts: readonly ConsensusDraft[]): ConsensusResult {
  const n = drafts.length;
  if (n === 0) throw new Error("consensusDrafts needs at least one draft");
  const fieldAt = new Map(CONSENSUS_FIELDS.map((f, i) => [f.name, i]));
  const keys = drafts.map((d) => CONSENSUS_FIELDS.map((f) => f.key(d.d3)));

  // Pairwise disagreement: a field counts when both reads answered it and, for a field that belongs
  // to a structure, when both chose the same structure (a porch-kind split is counted once, on the
  // porch, not again on every porch detail).
  const apart = (a: number, b: number) => {
    let d = 0;
    CONSENSUS_FIELDS.forEach((f, i) => {
      const ka = keys[a][i], kb = keys[b][i];
      if (ka === null || kb === null) return;
      if (f.parent) {
        const p = fieldAt.get(f.parent)!;
        if (keys[a][p] !== keys[b][p]) return;
      }
      if (ka !== kb) d++;
    });
    return d;
  };
  const score = drafts.map((_, a) => drafts.reduce((s, __, b) => (a === b ? s : s + apart(a, b)), 0));
  const doubts = drafts.map(consensusSelfDoubts);
  const conf = drafts.map((d) => CONFIDENCE_RANK[d.observed?.confidence ?? ""] ?? 1);
  // Best first: least disagreement, then fewest self-contradictions, then the read's own confidence,
  // then send order. rank[0] is the medoid, and every tie below goes to the best-ranked read.
  const rank = drafts.map((_, i) => i).sort((a, b) => score[a] - score[b] || doubts[a] - doubts[b] || conf[a] - conf[b] || a - b);
  const medoid = rank[0];

  const out = JSON.parse(JSON.stringify(drafts[medoid].d3)) as D3Spec;
  const chosen: Record<string, string | null> = {};
  const discreteAgreement: Record<string, string> = {};
  CONSENSUS_FIELDS.forEach((f, i) => {
    const p = f.parent ? fieldAt.get(f.parent)! : -1;
    const voters = rank.filter((d) => keys[d][i] !== null && (p < 0 || keys[d][p] === chosen[f.parent!]));
    if (!voters.length) {
      chosen[f.name] = null;
      f.apply?.(out, null);
      return;
    }
    const tally = new Map<string, number>();
    for (const d of voters) tally.set(keys[d][i]!, (tally.get(keys[d][i]!) ?? 0) + 1);
    const top = Math.max(...tally.values());
    // `voters` is in rank order, so the first one holding a top-count answer is the tie-break.
    const rep = voters.find((d) => tally.get(keys[d][i]!) === top)!;
    chosen[f.name] = keys[rep][i];
    discreteAgreement[f.name] = `${top}/${voters.length}`;
    f.apply?.(out, drafts[rep].d3);
  });

  const spread: Record<string, [number, number]> = {};
  for (const f of CONSENSUS_NUMBERS) {
    const values = drafts.filter((d) => f.counts(d.d3, chosen)).map((d) => f.get(d.d3)).filter((v): v is number => v !== null);
    if (!values.length) { f.set(out, null); continue; }
    const m = consensusMedian(values);
    f.set(out, f.whole ? Math.round(m) : m);
    const lo = Math.min(...values), hi = Math.max(...values);
    if (lo < hi) spread[f.name] = [lo, hi];
  }

  const colors: Record<string, string> = {};
  for (const k of CONSENSUS_COLOR_KEYS) {
    const givers = rank.filter((d) => typeof drafts[d].d3.colors?.[k] === "string");
    if (!givers.length) continue;
    const given = givers.map((d) => drafts[d].d3.colors[k]);
    if (given.every((v) => v === given[0])) { colors[k] = given[0]; continue; }
    const rgb = given.map(hexRgb).filter((c): c is [number, number, number] => c !== null);
    if (!rgb.length) { colors[k] = given[0]; continue; }
    if (rgb.length === 2 && [0, 1, 2].some((ch) => Math.abs(rgb[0][ch] - rgb[1][ch]) > CONSENSUS_COLOR_BLEND_MAX)) {
      colors[k] = given[0];
      continue;
    }
    colors[k] = rgbHex([0, 1, 2].map((ch) => consensusMedian(rgb.map((c) => c[ch]))));
  }
  out.colors = colors;

  const clean = sanitizeD3Spec(out);
  return {
    d3: clean.ok ? clean.d3 : drafts[medoid].d3,
    observed: drafts[medoid].observed,
    frameMap: drafts[medoid].frameMap,
    medoid,
    report: { n, medoid, discreteAgreement, spread },
  };
}

// The consensus of every call that drafted, with the medoid's CALL index (`call`) so the handler can
// answer from that call's own reply: its `observed` notes and its frame map are the consensus's.
// Null when no call drafted, which is the handler's cue to fail exactly as a single call would.
export function consensusOfCalls(
  calls: readonly DraftCall<DraftReading>[],
  walkFrames: number,
): (ConsensusResult & { call: number }) | null {
  const usable: { call: number; draft: ConsensusDraft }[] = [];
  calls.forEach((c, call) => {
    if (!c.reading || !c.reading.d3) return;
    const text = c.reading.reply.text;
    usable.push({ call, draft: { d3: c.reading.d3, observed: parseObservedNotes(text), frameMap: parseFrameMap(text, walkFrames) } });
  });
  if (!usable.length) return null;
  const result = consensusDrafts(usable.map((u) => u.draft));
  return { ...result, call: usable[result.medoid].call };
}

// Builder's words for each discrete field, for the split warning below.
const CONSENSUS_FIELD_WORDS: Record<string, string> = {
  type: "the roof type",
  front: "which wall is the front",
  highSide: "which wall is the high one",
  eave: "the eave finish",
  porch: "the porch",
  porchEnd: "which end the porch is on",
  porchTruss: "the porch truss",
  porchSteps: "where the porch steps are",
  porchAttach: "where the porch roof meets the wall",
  porchWidth: "how wide the porch is",
  wings: "the side wings",
  wingSide: "which sides have wings",
  leanTo: "the lean-to",
  leanToSide: "which side the lean-to is on",
  dormer: "the dormer",
  dormerType: "the dormer's shape",
  dormerSide: "which slope the dormer is on",
  roofMaterial: "the roof material",
  foundation: "the foundation",
  gableVent: "the gable vent",
};

// Where the reads SPLIT, said to the builder: any discrete field that no two reads agreed on (1 of
// 3, or 1 of 2). A 2-of-3 majority is a consensus and says nothing. Composed into roofNote by
// flagObservedNotes beside the porch and wings checks, which also drops the confidence to low.
export function consensusSplitWarning(report: ConsensusReport | null | undefined): string | null {
  if (!report || report.n < 2) return null;
  const split = Object.entries(report.discreteAgreement)
    .filter(([, a]) => {
      const [k, n] = a.split("/").map(Number);
      return k === 1 && n >= 2;
    })
    .map(([f]) => CONSENSUS_FIELD_WORDS[f] ?? f);
  if (!split.length) return null;
  const list = split.length === 1 ? split[0] : `${split.slice(0, -1).join(", ")} and ${split[split.length - 1]}`;
  const times = report.n === 2 ? "twice" : report.n === 3 ? "three times" : `${report.n} times`;
  return `Check ${list} before saving: we read the video ${times} and the readings did not agree on ${split.length === 1 ? "it" : "them"}, so the drawing follows the reading that agreed best with the others. Compare the preview with the video.`;
}

// What the calls used, for a draft that made more than one (a single call records exactly what it
// always has, in the handler). `tokens` is the draft_tokens jsonb: the SUM of every call's usage
// under today's keys, the lead reply's shapes (the medoid's, or the first call's when none drafted),
// one entry per call, the sanitised roof of every read that drafted (for later analysis of how far
// reads wander), and the agreement report. `usage` is the same sum under Anthropic's own keys, for
// the capture: every call that answered cost money, so all of them are the cost basis. A call with
// no usage block (aborted, a 529) adds nothing, and a sum no call reported is null, never 0.
export function draftCallsUsage(
  // aiModelFields(v2).model, stored as the single call's record stores it.
  model: unknown,
  calls: readonly DraftCall<DraftReading>[],
  lead: DraftCall<DraftReading>,
  consensus: ConsensusResult | null,
): { tokens: Record<string, unknown>; usage: Record<string, number | null> } {
  const count = (c: DraftCall<DraftReading>, key: string): number | null => {
    const v = c.reading?.data?.usage?.[key];
    return typeof v === "number" && Number.isFinite(v) ? v : null;
  };
  const sum = (key: string): number | null =>
    calls.reduce<number | null>((s, c) => {
      const v = count(c, key);
      return v === null ? s : (s ?? 0) + v;
    }, null);
  const usage = {
    input_tokens: sum("input_tokens"),
    output_tokens: sum("output_tokens"),
    cache_read_input_tokens: sum("cache_read_input_tokens"),
    cache_creation_input_tokens: sum("cache_creation_input_tokens"),
    calls: calls.length,
  };
  const reply = lead.reading?.reply ?? null;
  const tokens: Record<string, unknown> = {
    model,
    input: usage.input_tokens,
    output: usage.output_tokens,
    cache_read: usage.cache_read_input_tokens,
    cache_creation: usage.cache_creation_input_tokens,
    stopReason: reply ? reply.stopReason : null,
    textChars: reply ? reply.text.length : 0,
    blockTypes: reply ? reply.blockTypes : [],
    calls: calls.map((c) => ({
      model,
      output: count(c, "output_tokens"),
      stopReason: c.reading ? c.reading.reply.stopReason : null,
      ms: c.ms,
      ok: !!c.reading?.drafted,
      aborted: c.aborted,
    })),
    samples: calls.flatMap((c) => (c.reading?.d3 ? [c.reading.d3.roof] : [])),
    agreement: consensus ? consensus.report : null,
  };
  return { tokens, usage };
}
