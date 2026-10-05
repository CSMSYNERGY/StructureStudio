// The PROJECTING PORCH and the PLATE BAND, measured off the scene graph.
//
// A projecting porch (roof.porchOutFt, 2026-09-17) is a deck, posts and a low roof of its own
// standing in front of one gable end; the plate band (roof.plateBand) is a trim board across both
// gable caps at the top of the wall, which that porch roof tucks under. The pure numbers are pinned
// by _shared/_test_stubs/porchGeom_test.ts. This script proves the SHIPPED compiled bundle builds
// them, in the real designer with a hand-written config, through __SS3D_DEBUG (window.__ss3dEngine):
//
//   1. the porch roof group sits in roofGroup; the deck is in root, NOT in roofGroup
//   2. the deck's top is the floor (y 0) and it projects D; the roof sheet reaches D + 0.25..0.45
//      and stays under H - 0.15
//   3. tuck-under: no main-roof mesh reaching into the porch's width past the wall face sits
//      below the porch roof's top (a lean-to by the part of it over the porch, not by its box)
//   4. posts: model.porch.posts of them (3 at 16 ft, 4 on a 20 ft shed wall), all at D, measured
//      postH tall, 6'8" clear or pitch 0.05 flagged short; the header sits on them, under the roof
//      sheet, its ends inside the cheeks
//   5. the frame: the rafters (model.porch.nRaf) hang from the ceiling boards inside the cheeks,
//      the ledger's top is ceilWall + RAF_D on the wall, and a cheek each side runs from the wall
//      to the corner post's outer face (D) and from the post tops to the ceiling; no rafter reaches
//      a cheek's inner face (flush, the two faces flickered as grey dots along the cheek)
//   6. the front corners (2026-10-04, the 10-01 call: the siding "needs to be in", the post at the
//      corner): no cheek past the post's face at all, and past it, out to the front board, the
//      corner is closed in wood from the post top to the ceiling
//   7. no recessed set-back: the porch-end wall spans the footprint, flush with it
//   8. the ground label on the porch wall stands more than D + 2 out
//   9. a ramp on the porch wall starts at the deck's edge; a flood light there hangs under the
//      porch ceiling (ceilWall - 0.45)
//  10. the porch roof sheet shares the main roof's material (metal: with its sky); posts take
//      colors.wood, else the natural fallback
//  11. the plate band: 2 meshes with the porch (whose high edge is exactly H - 0.2), 1 on a recessed
//      porch's building (none on its porch end), and neither kind of porch group there. Where the
//      main roof pushes the porch roof lower, the band on the porch's end reaches down to it (H)
//  12. porchOutFt 0 draws no porch; look-inside hides the porch roof and keeps the deck
//  13. a lean-to on either long side leaves the porch exactly as the same building builds it without
//      one: high edge, pitch, posts and the band on the porch's end (cases I and J against I0)
//  14. the porch wall and the doors on it receive shadows (the porch roof shades them) and no other
//      wall does; without a projecting porch no wall does
//  15. zero page errors
//  16. steps (roof.porchSteps) and a customer's ramp on the porch wall never both show where they
//      overlap: centre steps under a ramp to a centred door are hidden (userData.ssHiddenBy "ramp"),
//      left steps beside it stay; centre steps with no porchPosts take a middle bay (4 posts at 16 ft)
//  17. steps off an END of the deck (leftSide / rightSide, 2026-10-03), on a front, a back and an eave
//      wall (cases S*): one flight turned a quarter onto that end, its first tread at the side rim's
//      outer face, between the wall and the corner post, on the grass, the count model.porch.steps
//      says; the posts are the ones the same porch builds without steps; clear of every deck support,
//      a shallow deck's corner pier and a deep deck's middle row (whose support at that end is left out);
//      on the shallowest deck the panels offer it on (2.5 ft) every front pier stands, the one under the
//      corner post included (the front row is never left out, 2026-10-04)
//  18. a RECESSED porch's steps (2026-10-03), left / centre / right on a gable end and on an eave wall
//      (cases R*): one flight in a holder in root (not the roof), its first tread 0.15 ft past the
//      footprint's edge, inside the opening and clear of every post, on the grass, climbing a raised
//      floor's whole height; centre steps on an even eave count add a bay (d3RecessedPorchFrame); a
//      ramp run out over them hides them, and a live rebuild without it brings them back
//  19. A LEAN-TO THAT MEETS THE PORCH (roof.leanTos[i].meetPorch, d3PorchJoins, 2026-10-05; cases PJ*): the
//      porch is built from its readout's numbers (never lowered by the scan), and on the joined side its sheet,
//      ceiling, board and drip run on to the lean-to's eave and stop on the hip; that side's cheek, corner fill
//      and rake trim are gone; the header runs on to one corner post where the two posts' lines cross (down the
//      lean-to's slope past the hip), on the ground; a hip rafter, jack rafters and the cap's half on the sheet;
//      a rake trim along the lean-to's eave line where the porch is the deeper. Front gable end and an eave wall,
//      the lean-to narrower and wider. Asked but a hair off, nothing at all changes (PJ5). Hung under its own rule
//      (no attach) at a 0.6 and a 1 ft overhang, the main roof's eave corners hold it at the height the scan builds
//      it at unjoined (PJ6, PJ7). Every joined porch is tucked under everything else on the roof: no vertex of it
//      inside the porch's sheet, ceiling, board or drip, and its ceiling never over what the scan still measures
//      without the lean-tos it meets (model.porch.joinClear). A lower lean-to beside it on the other wall stops
//      the join, said, and nothing changes (PJ8).
//  20. A PORCH ON A SIDE WALL (roof.porchEnd "left" / "right", 2026-10-05; cases P*, PR*, PS*, PJ9, PJ10): in the
//      new frame the porch stands on the west or east wall and the front stays the front. Projecting on a front
//      gable's side (an eave wall: down the ridge, posts every 8.5 ft or less), on a long-side front's side (a gable
//      end, with a plate band) and on a single slant's high wall and sloped end, every check of 1-15 above on that
//      wall (P1-P6); under a lean-to on the same wall, tucked under it (PL); recessed into a front gable's side (a
//      post every 10 ft or less along the eave), a long-side front's side (a gable end, the truss) and a single
//      slant's high wall, the check of 18 (PR1-PR3); a flight off an end of a side porch's deck, the check of 17
//      (PS1, PS2); and a lean-to on the front or back wall meeting a side porch round its corner, the check of 19
//      (PJ9, PJ10: s and d swap axes, the porch's wall running along z).
//
// The porch groups and bands are found by userData.ssPorch, and every member inside them by
// userData.ssPorchPart, never by size or draw order: a 16x24's porch sheet is as big as a main roof
// slab, and a member looked up by its size vanishes from the checks the moment it is built wrong.
//
//   python -m http.server 8125 --bind 127.0.0.1                  (repo root)
//   node tests/harness/porchProbe.mjs                            (SS_SHOTS=<dir> for the PNGs)
//   SS_CASES=A,E node tests/harness/porchProbe.mjs               (a subset)
//
// Exit 0 = every assertion held.
import { pathToFileURL } from "node:url";
import { launch, stubSupabase, collectErrors, openDesigner, readItems, svgPoint, buildingRect, reporter, shotsDir, revealTool, purePorch } from "./lib.mjs";

// The renderer's natural lumber when a style sets no colors.wood (D3_COLORS.wood).
const WOOD_FALLBACK = "#c4965a";
const CLADS = ["panel", "lap", "batten", "agpanel"].map((id) => ({ id, rate: 0, basis: "sqft_option", label: null, charged: false }));
const COLORS = { body: "#eeebe0", trim: "#686c70", roof: "#5f6266" };
const GAMBREL = { type: "gambrel", pitch: 1.2, ridgeOffset: 0, overhang: 0.15, kneeU: 0.72, kneeRise: 0.72, ridgeRise: 1, eave: "fascia" };
// A recessed porch with a king-post truss, as gableProbe's porch fixture has it.
const RECESSED = { type: "gable", pitch: 0.42, overhang: 0.8, eave: "fascia", ridgeOffset: 0, porchEnd: "front", porchTruss: true, porchDepthFt: 6 };
// The building cases I0, I and J share; I and J add a lean-to.
const LEAN_BASE = { type: "gable", pitch: 0.4, overhang: 0.5, eave: "fascia", porchOutFt: 6.5, porchEnd: "front", plateBand: true };

const CASES = [
  { id: "A", label: "Harness Barn", size: "16x24", H: 9, posts: 3, metal: true, wood: "#c4965a", place: true, bands: 2, bandUnderEdge: true,
    d3: { roof: { ...GAMBREL, porchOutFt: 6.5, porchEnd: "front", plateBand: true }, siding: null, colors: { ...COLORS, wood: "#C4965A" }, wallHeightFt: 9, roofMaterial: "metal", foundation: "skids" } },
  // Raw data holding both kinds: the projecting porch wins. Its own wood colour proves colors.wood is read.
  { id: "B", label: "Harness Both Porches", size: "12x24", H: 8, metal: true, wood: "#8b5a2b",
    d3: { roof: { ...RECESSED, porchOutFt: 6 }, siding: "batten", colors: { body: "#4a3327", trim: "#b0a081", roof: "#8a8f94", wood: "#8B5A2B" }, wallHeightFt: 8, roofMaterial: "metal" } },
  { id: "C", label: "Harness Open Eave", size: "14x20", H: 8, metal: false, wood: WOOD_FALLBACK,
    d3: { roof: { type: "gable", pitch: 0.33, overhang: 1, eave: "open", porchOutFt: 6 }, siding: "lap", colors: COLORS, wallHeightFt: 8, roofMaterial: "shingle" } },
  { id: "D", label: "Harness Studio", size: "12x20", H: 8, posts: 4, metal: true, wood: WOOD_FALLBACK,
    d3: { roof: { type: "shed", pitch: 0.25, overhang: 0.6, porchOutFt: 6 }, siding: "panel", colors: COLORS, wallHeightFt: 8, roofMaterial: "metal" } },
  { id: "E", label: "Harness Low Barn", size: "12x16", H: 7, metal: true, wood: WOOD_FALLBACK, short: true,
    d3: { roof: { ...GAMBREL, porchOutFt: 6, porchEnd: "back" }, siding: null, colors: COLORS, wallHeightFt: 7, roofMaterial: "metal" } },
  { id: "F", label: "Harness No Porch", size: "16x24", H: 9, off: true,
    d3: { roof: { ...GAMBREL, porchOutFt: 0 }, siding: null, colors: COLORS, wallHeightFt: 9, roofMaterial: "metal" } },
  { id: "G", label: "Harness Recessed Band", size: "12x32", H: 7.5, off: true, bands: 1,
    d3: { roof: { ...RECESSED, plateBand: true }, siding: "batten", colors: { body: "#4a3327", trim: "#b0a081", roof: "#8a8f94" }, gableVent: { widthFrac: 0.12 }, foundation: "skids", roofMaterial: "metal", wallHeightFt: 7.5 } },
  // A deep overhang's rake pushes the porch roof under H - 0.2, with a plate band: the band on the
  // porch's end must come down to meet it, or bare siding shows between the two.
  { id: "H", label: "Harness Deep Rake", size: "12x16", H: 8, posts: 3, metal: true, wood: WOOD_FALLBACK, bands: 2, bandDrops: true,
    d3: { roof: { type: "gable", pitch: 0.33, overhang: 1, eave: "fascia", porchOutFt: 6, plateBand: true }, siding: "panel", colors: COLORS, wallHeightFt: 8, roofMaterial: "metal" } },
  // A LEAN-TO beside the porch. On a 0.5 ft overhang the lean-to's slab runs past the gable wall and
  // its box starts at the eave wall, inside the porch's width, so a box-based clearance scan read its
  // free edge, 8 to 10 ft out to the side, as hanging over the porch. Only its inner strip is. The
  // porch must build exactly as it does on the same building without a lean-to (I0).
  { id: "I0", label: "Harness Porch Gable", size: "16x24", H: 9, posts: 3, metal: true, wood: WOOD_FALLBACK, bands: 2,
    d3: { roof: LEAN_BASE, siding: "panel", colors: COLORS, wallHeightFt: 9, roofMaterial: "metal" } },
  { id: "I", label: "Harness Lean-To Left", size: "16x24", H: 9, posts: 3, metal: true, wood: WOOD_FALLBACK, bands: 2, sameAs: "I0",
    d3: { roof: { ...LEAN_BASE, leanToWidthFt: 8, leanToDropFt: 1.5, leanToSide: "left" }, siding: "panel", colors: COLORS, wallHeightFt: 9, roofMaterial: "metal" } },
  { id: "J", label: "Harness Lean-To Right", size: "16x24", H: 9, posts: 3, metal: true, wood: WOOD_FALLBACK, bands: 2, sameAs: "I0",
    d3: { roof: { ...LEAN_BASE, leanToWidthFt: 10, leanToDropFt: 3, leanToSide: "right" }, siding: "panel", colors: COLORS, wallHeightFt: 9, roofMaterial: "metal" } },
  // STEPS AND A RAMP (2026-09-25): case A's building, its door and ramp, and porch steps. K puts the
  // door and ramp in the MIDDLE of the porch wall (8 ft), where its centre steps stand, so the steps
  // are hidden; L keeps them at 10.5 ft with left steps in the left bay, clear of it, and they show.
  // K has no porchPosts, so its centre steps take a middle bay. (No "Ramp" in either label: the ramp
  // tool is found by that word.)
  { id: "K", label: "Harness Steps Centre", size: "16x24", H: 9, posts: 4, metal: true, wood: "#c4965a", place: true, at: 8, bands: 2, steps: "center", stepsHidden: true,
    d3: { roof: { ...GAMBREL, porchOutFt: 6.5, porchEnd: "front", plateBand: true, porchSteps: "center" }, siding: null, colors: { ...COLORS, wood: "#C4965A" }, wallHeightFt: 9, roofMaterial: "metal", foundation: "skids" } },
  { id: "L", label: "Harness Steps Left", size: "16x24", H: 9, posts: 3, metal: true, wood: "#c4965a", place: true, bands: 2, steps: "left", stepsHidden: false,
    d3: { roof: { ...GAMBREL, porchOutFt: 6.5, porchEnd: "front", plateBand: true, porchSteps: "left" }, siding: null, colors: { ...COLORS, wood: "#C4965A" }, wallHeightFt: 9, roofMaterial: "metal", foundation: "skids" } },
];

// 20. A PORCH ON A SIDE WALL (2026-10-05): `wall` is where it must stand. A single slant's H is its high wall's top,
// the tallest wall in the scene.
const SIDE_FRONT = { type: "gable", front: "gable", pitch: 0.4, overhang: 0.6, eave: "fascia", porchOutFt: 6 };
const SIDE_LONG = { type: "gable", front: "eave", pitch: 0.4, overhang: 0.6, eave: "fascia", porchOutFt: 6 };
CASES.push(
  { id: "P1", label: "Harness Side Porch Left", size: "16x24", H: 9, wall: "west", metal: true, wood: WOOD_FALLBACK,
    d3: { roof: { ...SIDE_FRONT, porchEnd: "left" }, siding: "batten", colors: COLORS, wallHeightFt: 9, roofMaterial: "metal" } },
  { id: "P2", label: "Harness Side Porch Right", size: "16x24", H: 9, wall: "east", metal: true, wood: "#8a5a36",
    d3: { roof: { ...SIDE_FRONT, porchEnd: "right", porchWidthFt: 14, porchAttachFt: 8.25 }, siding: "lap", colors: { ...COLORS, wood: "#8A5A36" }, wallHeightFt: 9, roofMaterial: "metal" } },
  { id: "P3", label: "Harness Side Porch Gable Left", size: "24x16", H: 9, wall: "west", metal: true, wood: WOOD_FALLBACK, bands: 2,
    d3: { roof: { ...SIDE_LONG, porchEnd: "left", plateBand: true }, siding: "batten", colors: COLORS, wallHeightFt: 9, roofMaterial: "metal" } },
  { id: "P4", label: "Harness Side Porch Gable Right", size: "24x16", H: 9, wall: "east", metal: false, wood: WOOD_FALLBACK,
    d3: { roof: { ...SIDE_LONG, porchEnd: "right" }, siding: "panel", colors: COLORS, wallHeightFt: 9, roofMaterial: "shingle" } },
  { id: "P5", label: "Harness Side Porch High Wall", size: "12x16", H: 11, wall: "west", metal: true, wood: WOOD_FALLBACK,
    d3: { roof: { type: "shed", highSide: "left", pitch: 0.25, overhang: 0.6, eave: "fascia", porchOutFt: 5, porchAttachFt: 8.5, porchEnd: "left" }, siding: "panel", colors: COLORS, wallHeightFt: 8, roofMaterial: "metal" } },
  { id: "P6", label: "Harness Side Porch Sloped End", size: "16x12", H: 11, wall: "east", metal: true, wood: WOOD_FALLBACK,
    d3: { roof: { type: "shed", highSide: "front", pitch: 0.25, overhang: 0.6, eave: "fascia", porchOutFt: 5, porchEnd: "right" }, siding: "panel", colors: COLORS, wallHeightFt: 8, roofMaterial: "metal" } },
  // A lean-to on the porch's own side wall: the porch is tucked under its roof (the clearance scan).
  { id: "PL", label: "Harness Side Porch Under Lean-To", size: "16x24", H: 9, wall: "west", metal: true, wood: WOOD_FALLBACK, leanToOver: true,
    d3: { roof: { ...SIDE_FRONT, porchEnd: "left", leanTos: [{ wall: "left", widthFt: 10, dropFt: 1.5 }] }, siding: "batten", colors: COLORS, wallHeightFt: 9, roofMaterial: "metal" } },
);

// ── 17 / 18. STEPS OFF A DECK'S END, AND A RECESSED PORCH'S STEPS (2026-10-03) ──────────────────────
// Each its own building, measured by stepsRun below. `wall` is where the porch is; `posts` how many
// posts the porch stands (the recessed eave's centre-step bay included); `place` puts a door and ramp
// in the middle of that (south) wall, over centre steps.
const SIDE_GABLE = { type: "gable", front: "gable", pitch: 0.4, overhang: 0.6, eave: "fascia", porchOutFt: 6 };
const STEP_CASES = [
  { id: "S1", label: "Harness Side Steps Front", size: "16x24", wall: "south", steps: "leftSide",
    d3: { roof: { ...SIDE_GABLE, porchSteps: "leftSide" }, siding: "batten", colors: COLORS, wallHeightFt: 9, roofMaterial: "metal", foundation: "piers", floorHeightFt: 1.5 } },
  { id: "S2", label: "Harness Side Steps Back", size: "16x24", wall: "north", steps: "rightSide",
    d3: { roof: { ...SIDE_GABLE, porchEnd: "back", porchSteps: "rightSide" }, siding: "batten", colors: COLORS, wallHeightFt: 9, roofMaterial: "metal" } },
  { id: "S3", label: "Harness Side Steps Eave", size: "16x10", wall: "south", steps: "rightSide",
    d3: { roof: { type: "shed", highSide: "front", pitch: 0.22, overhang: 0.8, eave: "fascia", porchOutFt: 5, porchAttachFt: 8, porchSteps: "rightSide", porchStepCount: 2 }, siding: "panel", colors: COLORS, wallHeightFt: 7.3, roofMaterial: "metal", foundation: "blocks", floorHeightFt: 1.1 } },
  // A shallow deck on blocks: the flight takes the whole run between the wall and the corner post.
  { id: "S4", label: "Harness Side Steps Shallow", size: "12x16", wall: "south", steps: "leftSide",
    d3: { roof: { ...SIDE_GABLE, porchOutFt: 3, porchSteps: "leftSide" }, siding: "panel", colors: COLORS, wallHeightFt: 8, roofMaterial: "metal", foundation: "blocks", floorHeightFt: 2 } },
  // ...and on piers, whose 12 in corner pier reaches a foot in from the deck's edge and 3 in past its end.
  { id: "S5", label: "Harness Side Steps Shallow Piers", size: "12x16", wall: "south", steps: "rightSide",
    d3: { roof: { ...SIDE_GABLE, porchOutFt: 3, porchSteps: "rightSide" }, siding: "panel", colors: COLORS, wallHeightFt: 8, roofMaterial: "metal", foundation: "piers", floorHeightFt: 1.5 } },
  // The shallowest deck the panels offer a side flight on (2026-10-04): its front pier under the corner
  // post stands, though the flight's middle is just over a pier's reach from it.
  { id: "S7", label: "Harness Side Steps Shallowest Piers", size: "12x16", wall: "south", steps: "rightSide",
    d3: { roof: { ...SIDE_GABLE, porchOutFt: 2.5, porchSteps: "rightSide" }, siding: "panel", colors: COLORS, wallHeightFt: 8, roofMaterial: "metal", foundation: "piers", floorHeightFt: 1.5 } },
  // A deck over 7 ft deep stands a middle row of supports; the one at the flight's end is left out.
  { id: "S6", label: "Harness Side Steps Deep Piers", size: "16x24", wall: "south", steps: "leftSide",
    d3: { roof: { ...SIDE_GABLE, porchOutFt: 8, porchSteps: "leftSide" }, siding: "batten", colors: COLORS, wallHeightFt: 9, roofMaterial: "metal", foundation: "piers", floorHeightFt: 1.5 } },
  { id: "RGL", label: "Harness Recessed Left", size: "12x16", wall: "south", steps: "left", recessed: true, posts: 2,
    d3: { roof: { type: "gable", pitch: 0.42, overhang: 0.8, eave: "fascia", porchDepthFt: 4, porchTruss: true, porchSteps: "left" }, siding: "batten", colors: COLORS, wallHeightFt: 8, roofMaterial: "metal" } },
  { id: "RGC", label: "Harness Recessed Centre Piers", size: "24x12", wall: "west", steps: "center", recessed: true, posts: 2,
    d3: { roof: { type: "gable", pitch: 0.42, overhang: 0.8, eave: "fascia", porchDepthFt: 5, porchSteps: "center" }, siding: "lap", colors: COLORS, wallHeightFt: 8, roofMaterial: "metal", foundation: "piers", floorHeightFt: 1.5 } },
  { id: "RGR", label: "Harness Recessed Right Back", size: "12x16", wall: "north", steps: "right", recessed: true, posts: 2,
    d3: { roof: { type: "gambrel", pitch: 1.2, overhang: 0.4, kneeU: 0.72, kneeRise: 0.72, ridgeRise: 1, eave: "fascia", porchDepthFt: 4, porchEnd: "back", porchSteps: "right", porchStepCount: 2 }, siding: "panel", colors: COLORS, wallHeightFt: 8, roofMaterial: "shingle" } },
  { id: "REL", label: "Harness Recessed Eave Left", size: "20x12", wall: "south", steps: "left", recessed: true, eave: true, posts: 3,
    d3: { roof: { type: "gable", front: "eave", pitch: 0.4, overhang: 0.6, eave: "fascia", porchDepthFt: 4, porchSteps: "left" }, siding: "batten", colors: COLORS, wallHeightFt: 8, roofMaterial: "metal" } },
  // 16 ft of eave: the rule's 2 bays stand a post in the middle, so centre steps take a third.
  { id: "REC", label: "Harness Recessed Eave Centre", size: "16x12", wall: "south", steps: "center", recessed: true, eave: true, posts: 4,
    d3: { roof: { type: "gable", front: "eave", pitch: 0.4, overhang: 0.6, eave: "fascia", porchDepthFt: 4, porchSteps: "center" }, siding: "batten", colors: COLORS, wallHeightFt: 8, roofMaterial: "metal", foundation: "blocks", floorHeightFt: 1.1 } },
  { id: "RER", label: "Harness Recessed Eave Right", size: "16x12", wall: "north", steps: "right", recessed: true, eave: true, posts: 3,
    d3: { roof: { type: "shed", highSide: "back", pitch: 0.25, overhang: 0.6, eave: "fascia", porchDepthFt: 4, porchEnd: "back", porchSteps: "right" }, siding: "panel", colors: COLORS, wallHeightFt: 8, roofMaterial: "metal" } },
  // A ramp to a door in the middle of a shallow recessed porch on piers runs out past the footprint's
  // edge, over its centre steps: they hide, as on a projecting porch. (No "Ramp" in the label: the ramp
  // tool is found by that word.)
  { id: "RRP", label: "Harness Recessed Steps Hidden", size: "16x24", wall: "south", steps: "center", recessed: true, posts: 2, place: true, at: 8, stepsHidden: true,
    d3: { roof: { type: "gable", pitch: 0.42, overhang: 0.8, eave: "fascia", porchDepthFt: 3, porchSteps: "center" }, siding: "batten", colors: COLORS, wallHeightFt: 8, roofMaterial: "metal", foundation: "piers", floorHeightFt: 1.5 } },
  // 20. On a SIDE wall (2026-10-05). A front gable's left wall is a 24 ft eave wall: three bays, four posts.
  { id: "PR1", label: "Harness Side Recessed Eave", size: "12x24", wall: "west", steps: "left", recessed: true, eave: true, posts: 4,
    d3: { roof: { type: "gable", front: "gable", pitch: 0.4, overhang: 0.6, eave: "fascia", porchDepthFt: 4, porchEnd: "left", porchSteps: "left" }, siding: "batten", colors: COLORS, wallHeightFt: 8, roofMaterial: "metal" } },
  // A long-side front's right wall is a gable end: two corner posts, and the timber truss in the gable over them.
  { id: "PR2", label: "Harness Side Recessed Truss", size: "24x12", wall: "east", steps: "center", recessed: true, posts: 2,
    d3: { roof: { type: "gable", front: "eave", pitch: 0.42, overhang: 0.8, eave: "fascia", porchDepthFt: 5, porchTruss: true, porchEnd: "right", porchSteps: "center" }, siding: "lap", colors: COLORS, wallHeightFt: 8, roofMaterial: "metal", foundation: "piers", floorHeightFt: 1.5 } },
  // A single slant high on the right: its east wall is the high one, 16 ft long, two bays.
  { id: "PR3", label: "Harness Side Recessed High Wall", size: "12x16", wall: "east", steps: "right", recessed: true, eave: true, posts: 3,
    d3: { roof: { type: "shed", highSide: "right", pitch: 0.25, overhang: 0.6, eave: "fascia", porchDepthFt: 4, porchEnd: "right", porchSteps: "right" }, siding: "panel", colors: COLORS, wallHeightFt: 8, roofMaterial: "metal" } },
  // A side porch's flight off an end of its deck (the A2 side flights): down the ridge on an eave wall, across a gable end.
  { id: "PS1", label: "Harness Side Porch Side Steps", size: "16x24", wall: "west", steps: "leftSide",
    d3: { roof: { ...SIDE_GABLE, porchEnd: "left", porchSteps: "leftSide" }, siding: "batten", colors: COLORS, wallHeightFt: 9, roofMaterial: "metal", foundation: "piers", floorHeightFt: 1.5 } },
  { id: "PS2", label: "Harness Side Porch Gable Steps", size: "24x16", wall: "east", steps: "rightSide",
    d3: { roof: { type: "gable", front: "eave", pitch: 0.4, overhang: 0.6, eave: "fascia", porchOutFt: 6, porchEnd: "right", porchSteps: "rightSide" }, siding: "batten", colors: COLORS, wallHeightFt: 9, roofMaterial: "metal" } },
];

// 19. THE PORCH A LEAN-TO MEETS (d3PorchJoins, 2026-10-05). Each lean-to's boxes are set to what its card says
// matches the porch (d3LeanTosReadout's porchCorner.fix), so each joins. sd places the corner in the world: s out
// from the lean-to's wall along x, d out from the porch's wall along z (s = sx (x - cx), d = dz (z - cz)).
const JOIN_BASE = { type: "gable", front: "gable", pitch: 0.4, overhang: 0.6, eave: "fascia", porchOutFt: 8, porchAttachFt: 7.5, porchPitch: 2 / 12 };
const JOIN_CASES = [
  // The porch 8 ft deep (its front edge 8.3 ft out) and the lean-to 8 ft wide (its eave 8.6 ft out): the hip runs
  // to the porch's front edge, and the header past the corner post's line slopes down the lean-to.
  { id: "PJ1", label: "Harness Porch Meets Right", size: "12x16", H: 8, sd: { cx: 6, cz: 8, sx: 1, dz: 1 },
    d3: { roof: { ...JOIN_BASE, leanTos: [{ wall: "right", widthFt: 8, meetPorch: true }] }, siding: "batten", colors: COLORS, wallHeightFt: 8, roofMaterial: "metal" } },
  // The lean-to 5 ft wide: the porch is the deeper, so its sheet runs on past the hip with a rake trim on it.
  { id: "PJ2", label: "Harness Porch Meets Narrow", size: "12x16", H: 8, sd: { cx: 6, cz: 8, sx: 1, dz: 1 },
    d3: { roof: { ...JOIN_BASE, leanTos: [{ wall: "right", widthFt: 5, meetPorch: true }] }, siding: "batten", colors: COLORS, wallHeightFt: 8, roofMaterial: "metal" } },
  // The porch on an EAVE wall (the front a long side): an end-wall lean-to meets it at the front-right corner.
  { id: "PJ3", label: "Harness Eave Porch Meets End", size: "16x12", H: 9, sd: { cx: 8, cz: 6, sx: 1, dz: 1 },
    d3: { roof: { ...JOIN_BASE, front: "eave", porchOutFt: 6, porchAttachFt: 8, porchPitch: 0.125, leanTos: [{ wall: "right", widthFt: 7, meetPorch: true }] }, siding: "lap", colors: COLORS, wallHeightFt: 9, roofMaterial: "metal" } },
  // A shallow porch (4 ft) on a back wall, a wide lean-to on the left: the lean-to is cut on the porch's front edge.
  { id: "PJ4", label: "Harness Back Porch Meets Wide", size: "12x16", H: 9, sd: { cx: -6, cz: -8, sx: -1, dz: -1 },
    d3: { roof: { ...JOIN_BASE, porchEnd: "back", porchOutFt: 4, porchAttachFt: 8.5, leanTos: [{ wall: "left", widthFt: 8, enclosed: true, meetPorch: true }] }, siding: "panel", colors: COLORS, wallHeightFt: 9, roofMaterial: "metal" } },
];
// 20. A porch on a SIDE wall (2026-10-05) and a lean-to on the front or back wall round its corner: s runs out from the
// lean-to's wall along z and d out from the porch's wall along x (swap). PJ9: a front gable's left wall (an eave
// wall), the lean-to on the front; PJ10: a long-side front's right wall (a gable end), the lean-to on the back.
JOIN_CASES.push(
  { id: "PJ9", label: "Harness Side Porch Meets Front", size: "12x16", H: 8, sd: { cx: -6, cz: 8, sx: 1, dz: -1, swap: true },
    d3: { roof: { ...JOIN_BASE, porchEnd: "left", porchOutFt: 6, leanTos: [{ wall: "front", widthFt: 6, meetPorch: true }] }, siding: "batten", colors: COLORS, wallHeightFt: 8, roofMaterial: "metal" } },
  { id: "PJ10", label: "Harness Side Porch Gable Meets Back", size: "16x12", H: 9, sd: { cx: 8, cz: -6, sx: -1, dz: 1, swap: true },
    d3: { roof: { ...JOIN_BASE, front: "eave", porchEnd: "right", porchOutFt: 5, porchAttachFt: 8, porchPitch: 0.125, leanTos: [{ wall: "back", widthFt: 7, meetPorch: true }] }, siding: "lap", colors: COLORS, wallHeightFt: 9, roofMaterial: "metal" } },
);
// No attach: the porch under its own rule, just under the plate, where the main roof's eave and rake boards hang out
// over its corners. Joined, its numbers take them (d3PorchEaveCornerCapFt): the height the scan builds it at unjoined.
const { porchAttachFt: _hung, ...JOIN_FREE } = JOIN_BASE;
JOIN_CASES.push(
  { id: "PJ6", label: "Harness Porch Meets Under Eave", size: "12x16", H: 8, sd: { cx: 6, cz: 8, sx: 1, dz: 1 }, yHigh: 7.617,
    d3: { roof: { ...JOIN_FREE, leanTos: [{ wall: "right", widthFt: 8, meetPorch: true }] }, siding: "batten", colors: COLORS, wallHeightFt: 8, roofMaterial: "metal" } },
  // A 1 ft overhang: the eave boards reach over both front corners, the one with no lean-to too.
  { id: "PJ7", label: "Harness Porch Meets Wide Eave", size: "12x16", H: 8, sd: { cx: 6, cz: 8, sx: 1, dz: 1 }, yHigh: 7.469,
    d3: { roof: { ...JOIN_FREE, overhang: 1, leanTos: [{ wall: "right", widthFt: 8, meetPorch: true }] }, siding: "batten", colors: COLORS, wallHeightFt: 8, roofMaterial: "metal" } },
);
// PJ5: asked, but its drop 3 in more than matches: the porch and the lean-to are built exactly as without the ask.
const JOIN_MISS = { id: "PJ5", label: "Harness Porch Near Miss", size: "12x16", H: 8, sd: { cx: 6, cz: 8, sx: 1, dz: 1 }, off: 0.25, why: ["pitch"],
  d3: { roof: { ...JOIN_BASE, leanTos: [{ wall: "right", widthFt: 8, meetPorch: true }] }, siding: "batten", colors: COLORS, wallHeightFt: 8, roofMaterial: "metal" } };
// PJ8: matched and asked, but a lean-to on the left wall, met a foot down with 2 ft of drop, runs its overhang out over
// the porch's left end under the porch roof: the scan lowers the porch under it, so nothing meets the porch.
const JOIN_EDGE = { id: "PJ8", label: "Harness Porch Edge Miss", size: "12x16", H: 8, sd: { cx: 6, cz: 8, sx: 1, dz: 1 }, why: ["edge"],
  d3: { roof: { ...JOIN_FREE, leanTos: [{ wall: "right", widthFt: 8, meetPorch: true }, { wall: "left", widthFt: 8, attach: "wall", attachFt: 1, dropFt: 2 }] }, siding: "batten", colors: COLORS, wallHeightFt: 8, roofMaterial: "metal" } };

const configFor = (c) => {
  const [w, l] = c.size.split("x").map(Number);
  return {
    clientId: "harness-porch",
    branding: { companyName: "Harness Sheds", accentColor: "#1D4ED8", headerBg: "#FFFFFF", tagline: null, logo: null },
    contactFields: ["name", "email", "phone"],
    buildingStyles: [{ value: "porch", label: c.label, img: null, sizes: [c.size], sizeInclusions: {}, sizeInclusionQty: {}, d3: c.d3 }],
    defaultSizes: [c.size],
    sizePricing: { porch: { [c.size]: { widthFt: w, lengthFt: l, basePrice: 9000 } } },
    options: [], colors: [], claddingOptions: { porch: CLADS }, wallHeightOptions: {},
    showPricing: true, view3d: true, layoutItems: {}, layoutPricing: {}, layoutPrices: {},
    // A standalone flood light, the one exterior lamp the porch caps.
    electrical: null,
    electricalItems: [{ id: "e-flood", icon: "🔦", name: "Flood Light", mount: "wall", withPackage: false, standalone: true, priceWithPackage: null, priceStandalone: 185, heightOffFloorIn: 120 }],
    insulation: [],
  };
};
// One catalog door (the ramp tool needs a door) and the simple ramp.
const FIXTURES = {
  ramp: { mode: "simple", price: 0, method: "each", enabled: true, imageUrl: null, showImage: false },
  items: [{ id: "d-walk", name: "Harness Walk Door", price: 300, widthIn: 36, heightIn: 80, category: "door", colorMode: "fixed", planLabel: "WD", sortOrder: 0, imageUrl: null,
    sillIn: null, sillMode: "fixed", opLeft: false, opRight: true, opDouble: false, opSlideUp: false, opDefault: "right", swingIn: false, swingOut: true, swingDefault: null, hasTrimColor: false }],
  windowColors: [],
};

const settle = (page, ms = 400) => page.waitForTimeout(ms);
const f3 = (v) => (v == null || !Number.isFinite(Number(v)) ? String(v) : Number(v).toFixed(3));

// Waits for the tile first: the tiles render only once get_config has answered, which can land
// after the app reports it booted.
async function pickStyle(page, label) {
  await page.waitForFunction((lab) => {
    const want = lab.trim().toLowerCase();
    return [...document.querySelectorAll("div,span,p,strong,b")]
      .some((e) => e.children.length === 0 && (e.textContent || "").trim().toLowerCase() === want && e.offsetParent);
  }, label, { timeout: 30000 }).catch(() => {});
  const ok = await page.evaluate((lab) => {
    const want = lab.trim().toLowerCase();
    const el = [...document.querySelectorAll("div,span,p,strong,b")]
      .find((e) => e.children.length === 0 && (e.textContent || "").trim().toLowerCase() === want && e.offsetParent);
    if (!el) return false;
    el.click();
    return true;
  }, label);
  if (!ok) throw new Error(`no style tile labelled ${label}`);
  await settle(page, 500);
}
async function chooseSize(page, size) {
  const sel = page.locator("select").filter({ has: page.locator("option", { hasText: size }) });
  if (await sel.count()) await sel.first().selectOption({ label: size });
  const l = Number(size.split("x")[1]);
  await page.waitForFunction((l) => [...document.querySelectorAll("svg text")].some((t) => t.textContent.trim() === `${l} ft`), l, { timeout: 15000 });
  await settle(page, 600);
}
// Screen point just inside the SOUTH wall, `alongFt` from its west end.
async function southWall(page, W, L, alongFt) {
  const r = await buildingRect(page);
  return svgPoint(page, r.x + alongFt * (r.w / W), r.y + r.h - 0.4 * (r.h / L));
}
async function openEditor(page) {
  const edit = page.getByRole("button", { name: /Edit in 3D/ });
  if (!(await edit.count()) || !(await edit.first().isVisible())) {
    const show = page.getByRole("button", { name: /Show 3D|3D View/ });
    if (await show.count()) { await show.first().click(); await settle(page, 800); }
  }
  await edit.first().waitFor({ state: "visible", timeout: 60000 });
  await edit.first().click();
  await page.waitForFunction(() => {
    const E = window.__ss3dEngine;
    return !!(E && E.model && E.model.roofGroup && E.model.roofGroup.children.length > 0);
  }, null, { timeout: 90000 });
  await settle(page, 1500);
}

// Case A only: a door, its ramp and a flood light on the porch wall (south), placed in 2D. `at` is
// how far along the wall the door and ramp go (10.5 ft unless the case says).
async function placeOnPorchWall(page, ok, W, L, at = 10.5) {
  await (await revealTool(page, /^Door wall$/)).click();
  await settle(page, 300);
  let p = await southWall(page, W, L, at);
  await page.mouse.click(p.x, p.y);
  await settle(page, 600);
  await page.getByText(FIXTURES.items[0].name, { exact: true }).first().click({ timeout: 10000 });
  await settle(page, 300);
  await page.getByRole("button", { name: "Place door" }).click();
  await settle(page, 600);
  await (await revealTool(page, /Ramp/)).click();
  await settle(page, 300);
  p = await southWall(page, W, L, at);
  await page.mouse.click(p.x, p.y);
  await settle(page, 600);
  await (await revealTool(page, /Electrical Items/)).click();
  await settle(page, 300);
  await page.getByText("Flood Light", { exact: true }).first().click({ timeout: 10000 });
  await settle(page, 300);
  p = await southWall(page, W, L, 3);
  await page.mouse.click(p.x, p.y);
  await settle(page, 600);
  if (await page.getByText("Add an electrical item").count()) await page.keyboard.press("Escape");
  const items = (await readItems(page)) || [];
  const door = items.find((i) => i.type === "fixtureDoor");
  const ramp = items.find((i) => i.type === "ramp");
  const flood = items.find((i) => i.electricalItemId === "e-flood");
  ok("A: a door placed on the porch wall (south)", door && door.wall === "south", JSON.stringify(door && { type: door.type, wall: door.wall }));
  ok("A: a ramp on that door", ramp && ramp.wall === "south" && door && ramp.snapDoorId === door.id, JSON.stringify(ramp && { wall: ramp.wall, snap: ramp.snapDoorId }));
  ok("A: a flood light on the porch wall", flood && flood.wall === "south", JSON.stringify(flood && { wall: flood.wall }));
}

// Everything the assertions need, measured in world space in one pass.
async function measure(page, W, L) {
  return page.evaluate(({ W, L }) => {
    const E = window.__ss3dEngine, M = E.model, V = E.camera.position.constructor;
    E.scene.updateMatrixWorld(true);
    const bbOf = (o, skip) => {
      const mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
      o.traverse((q) => {
        if (!q.isMesh || !q.geometry || (skip && skip(q))) return;
        if (!q.geometry.boundingBox) q.geometry.computeBoundingBox();
        const b = q.geometry.boundingBox;
        for (const x of [b.min.x, b.max.x]) for (const y of [b.min.y, b.max.y]) for (const z of [b.min.z, b.max.z]) {
          const v = new V(x, y, z).applyMatrix4(q.matrixWorld);
          [v.x, v.y, v.z].forEach((c, k) => { mn[k] = Math.min(mn[k], c); mx[k] = Math.max(mx[k], c); });
        }
      });
      return { mn, mx };
    };
    const tagged = (tag) => { const out = []; M.root.traverse((q) => { if (q.userData && q.userData.ssPorch === tag) out.push(q); }); return out; };
    const under = (q, anc) => { let n = q; while (n) { if (n === anc) return true; n = n.parent; } return false; };
    const hex = (m) => (m && m.color ? "#" + m.color.getHexString() : null);
    const roofs = tagged("roof"), decks = tagged("deck"), bands = tagged("band");
    let wallTop = -Infinity;
    M.wallsGroup.traverse((o) => { if (o.isMesh) wallTop = Math.max(wallTop, bbOf(o).mx[1]); });
    // Feet OUT from the porch wall's footprint line (the gable wall's mid-plane): the renderer's d.
    const outOn = (wall, bb) => ({ south: bb.mx[2] - L / 2, north: -L / 2 - bb.mn[2], east: bb.mx[0] - W / 2, west: -W / 2 - bb.mn[0] })[wall];
    // Shadow receivers among the walls and the openings on them, by wall.
    const recv = { porchWall: 0, porchWallNo: 0, porchOpen: 0, porchOpenNo: 0, other: 0 };
    [[M.wallsGroup, "Wall"], [M.openingsGroup, "Open"]].forEach(([grp, kind]) => grp.children.forEach((g) => g.traverse((q) => {
      if (!q.isMesh) return;
      const onPorch = !!M.porch && g.userData && g.userData.wall === M.porch.wall && !g.userData.gable;
      if (onPorch) recv[`porch${kind}${q.receiveShadow ? "" : "No"}`]++;
      else if (q.receiveShadow) recv.other++;
    })));
    const out = {
      porch: M.porch, H: wallTop, nRoof: roofs.length, nDeck: decks.length, recv,
      roofInRoofGroup: roofs.length > 0 && roofs.every((g) => under(g, M.roofGroup)),
      deckInRoot: decks.length > 0 && decks.every((g) => under(g, M.root)),
      deckInRoofGroup: decks.some((g) => under(g, M.roofGroup)),
      // porchEnd: the band in front of the projecting porch's wall (the far one sits a length behind).
      bands: bands.map((b) => { const bb = bbOf(b); return { isMesh: !!b.isMesh, minY: bb.mn[1], maxY: bb.mx[1], inRoofGroup: under(b, M.roofGroup), porchEnd: !!M.porch && outOn(M.porch.wall, bb) > -1 }; }),
    };
    if (!roofs.length || !decks.length || !M.porch) return out;
    const P = M.porch, pg = roofs[0];
    const outDist = (bb) => outOn(P.wall, bb);
    const nearDist = (bb) => ({ south: bb.mn[2] - L / 2, north: -L / 2 - bb.mx[2], east: bb.mn[0] - W / 2, west: -W / 2 - bb.mx[0] })[P.wall];
    const across = (bb) => (P.wall === "south" || P.wall === "north") ? [bb.mn[0], bb.mx[0]] : [bb.mn[2], bb.mx[2]];
    const dOf = (v) => ({ south: v.z - L / 2, north: -L / 2 - v.z, east: v.x - W / 2, west: -W / 2 - v.x })[P.wall];
    // Every member by its tag, never by its size: a member built the wrong size must still be found.
    const partsOf = (name) => { const a = []; pg.traverse((q) => { if (q.isMesh && q.userData && q.userData.ssPorchPart === name) a.push(q); }); return a; };
    const boxOf = (q) => { const b = bbOf(q); return { minY: b.mn[1], maxY: b.mx[1], near: nearDist(b), out: outDist(b), across: across(b), color: hex(Array.isArray(q.material) ? q.material[0] : q.material) }; };
    // The deck's own box, without its steps (which run out past D by design).
    const inSteps = (q) => { let n = q; while (n) { if (n.userData && n.userData.ssPorchPart === "steps") return true; n = n.parent; } return false; };
    const db = bbOf(decks[0], inSteps);
    const chainShown = (q) => { let n = q; while (n) { if (!n.visible) return false; n = n.parent; } return true; };
    out.steps = [];
    decks[0].traverse((q) => {
      if (!(q.userData && q.userData.ssPorchPart === "steps")) return;
      const b = bbOf(q);
      out.steps.push({ where: q.userData.ssPorchSteps, visible: chainShown(q), hiddenBy: q.userData.ssHiddenBy || null, across: across(b), near: nearDist(b), out: outDist(b) });
    });
    out.deck = { top: db.mx[1], out: outDist(db), visibleChain: true };
    const NAMES = ["slab", "ceiling", "rafter", "header", "post", "cheek", "cornerFill", "rake", "board", "drip", "ledger"];
    out.parts = Object.fromEntries(NAMES.map((n) => [n, partsOf(n).map(boxOf)]));
    let untagged = 0;
    pg.traverse((q) => { if (q.isMesh && !(q.userData && q.userData.ssPorchPart)) untagged++; });
    out.untagged = untagged;
    // THE FRONT CORNERS: every cheek vertex out past the posts' face (d > D). The siding stops at the
    // corner post's outer face (2026-10-04); before that, one below the board's bottom was the light block.
    const boards = partsOf("board");
    const boardBot = boards.length ? Math.min(...boards.map((q) => bbOf(q).mn[1])) : null;
    out.boardBot = boardBot;
    out.cheekStub = [];
    if (boardBot != null) partsOf("cheek").forEach((q) => {
      const pos = q.geometry.attributes.position;
      for (let i = 0; i < pos.count; i++) {
        const v = new V(pos.getX(i), pos.getY(i), pos.getZ(i)).applyMatrix4(q.matrixWorld);
        const d = dOf(v);
        if (d > P.D + 0.005) out.cheekStub.push([+d.toFixed(3), +v.y.toFixed(3)]);
      }
    });
    // The sheet.
    const slab = partsOf("slab")[0];
    if (slab) {
      const sb = bbOf(slab);
      out.slab = { top: sb.mx[1], out: outDist(sb), across: across(sb), hasEnv: !!slab.material.envMap };
      // The main roof's slab material: a textured 0.2 ft slab at least as long as the short side
      // (the extrusion runs the long side on a gable, the short one on a shed).
      let mainMat = null;
      M.roofGroup.traverse((q) => {
        if (mainMat || !q.isMesh || under(q, pg)) return;
        const g = q.geometry.type === "BoxGeometry" ? q.geometry.parameters : null;
        if (g && Math.abs(g.height - 0.2) < 1e-9 && g.depth >= Math.min(W, L) - 0.01 && q.material && q.material.map) mainMat = q.material;
      });
      out.slabSharesRoofMat = !!mainMat && slab.material === mainMat;
      // Tuck-under: every main-roof mesh (bands included) past the wall face inside the porch's width.
      // A lean-to (userData.ssLeanTo) counts by its lowest point OVER that footprint: its triangles
      // clipped to the porch sheet's width and to more than 0.16 ft out. Its box spans the whole slope
      // down to the free edge, which is nowhere near the porch.
      const acrossOf = (v) => ((P.wall === "south" || P.wall === "north") ? v.x : v.z);
      const lowestOver = (q) => {
        const pos = q.geometry.attributes.position, idx = q.geometry.index, n = idx ? idx.count : pos.count;
        const inside = [(v) => acrossOf(v) - out.slab.across[0], (v) => out.slab.across[1] - acrossOf(v), (v) => dOf(v) - 0.16];
        let lo = Infinity;
        for (let t = 0; t + 2 < n; t += 3) {
          let poly = [0, 1, 2].map((k) => new V().fromBufferAttribute(pos, idx ? idx.getX(t + k) : t + k).applyMatrix4(q.matrixWorld));
          for (const f of inside) {
            const next = [];
            poly.forEach((a, i) => {
              const b = poly[(i + 1) % poly.length], fa = f(a), fb = f(b);
              if (fa >= 0) next.push(a);
              if ((fa >= 0) !== (fb >= 0)) next.push(a.clone().lerp(b, fa / (fa - fb)));
            });
            poly = next;
            if (!poly.length) break;
          }
          poly.forEach((v) => { lo = Math.min(lo, v.y); });
        }
        return lo;
      };
      const clash = [];
      out.leanTo = { n: 0, boxOver: false, lowestOver: null };
      M.roofGroup.traverse((q) => {
        if (!q.isMesh || under(q, pg)) return;
        // The single lean-to is tagged true, a listed one by its index (0 is one too).
        const lean = !!q.userData && q.userData.ssLeanTo != null && q.userData.ssLeanTo !== false;
        if (lean) out.leanTo.n++;
        const b = bbOf(q), o = outDist(b), a = across(b);
        if (o <= 0.16 || a[1] < out.slab.across[0] || a[0] > out.slab.across[1]) return;
        if (b.mn[1] < 1) return;                   // corner boards stand on the ground beside the wall
        let lowY = b.mn[1];
        // On an EAVE wall (model.porch.onCap false: the new frame's, a side wall's too) every member is measured by
        // what is really over the porch, the renderer's own rule there: a sloped rake's box over a porch that runs
        // the whole wall is its far, low corner, nowhere near the porch.
        if (!lean && P.onCap === false) lowY = lowestOver(q);
        if (lean) {
          lowY = lowestOver(q);
          if (b.mn[1] < out.slab.top - 0.005) out.leanTo.boxOver = true;
          out.leanTo.lowestOver = Math.min(out.leanTo.lowestOver == null ? Infinity : out.leanTo.lowestOver, lowY);
        }
        if (lowY < out.slab.top - 0.005) clash.push({ geom: q.geometry.type, minY: +lowY.toFixed(3), out: +o.toFixed(3), leanTo: lean });
      });
      out.clash = clash;
    }
    out.posts = out.parts.post;
    const hdr = out.parts.header[0];
    if (hdr) out.hdrU = Math.max(Math.abs(hdr.across[0]), Math.abs(hdr.across[1]));
    const wg = M.wallsGroup.children.find((g) => g.userData && g.userData.wall === P.wall);
    if (wg) { const b = bbOf(wg); out.wallAcross = across(b); out.wallOut = outDist(b); }
    // The ground label on the porch wall: an env holder on the wall's axis, beyond the footprint.
    const lbl = M.envGroup.children.find((h) => !h.isMesh && (
      P.wall === "south" ? Math.abs(h.position.x) < 1e-6 && h.position.z > L / 2
        : P.wall === "north" ? Math.abs(h.position.x) < 1e-6 && h.position.z < -L / 2
          : P.wall === "east" ? Math.abs(h.position.z) < 1e-6 && h.position.x > W / 2
            : Math.abs(h.position.z) < 1e-6 && h.position.x < -W / 2));
    out.lblOut = lbl ? ({ south: lbl.position.z - L / 2, north: -L / 2 - lbl.position.z, east: lbl.position.x - W / 2, west: -W / 2 - lbl.position.x })[P.wall] : null;
    // Ramps: interior groups outside the porch wall that are not electrical devices.
    out.ramps = [];
    out.floods = [];
    M.interiorGroup.children.forEach((g) => {
      const b = bbOf(g);
      if (!(outDist(b) > 0.1)) return;
      if (g.userData && g.userData.ssElec) {
        const head = g.children.find((q) => q.isMesh && q.geometry.type === "BoxGeometry" && Math.abs(q.geometry.parameters.width - 0.6) < 1e-9);
        out.floods.push({ topY: b.mx[1], headCtrY: head ? head.getWorldPosition(new V()).y : null });
      } else out.ramps.push({ near: nearDist(b), out: outDist(b), across: across(b), tagged: !!(g.userData && g.userData.ssRamp) });
    });
    // Look inside: the roof (and the porch roof with it) hides, the deck stays.
    const chainVisible = (q) => { let n = q; while (n) { if (!n.visible) return false; n = n.parent; } return true; };
    E.interior = true; E.applyShellMode(E);
    out.inside = { roofVisible: M.roofGroup.visible, porchRoofVisible: chainVisible(pg), deckVisible: chainVisible(decks[0]) };
    E.interior = false; E.applyShellMode(E);
    return out;
  }, { W, L });
}

// 17 / 18: the steps, measured in their own frames. The flight's group (ssPorchPart "steps") sits in the
// projecting porch's deck frame (x across, z = d out from the wall's mid-plane) or a recessed porch's
// holder (x across, z = d out from the footprint's edge); every vertex is read into that frame and the
// world, so each check is the number it is about.
async function measureSteps(page, W, L, H) {
  return page.evaluate(({ W, L, H }) => {
    const E = window.__ss3dEngine, M = E.model, V = E.camera.position.constructor, M4 = E.camera.matrixWorld.constructor;
    E.scene.updateMatrixWorld(true);
    const boxIn = (o, inv) => {
      const mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
      o.traverse((q) => {
        if (!q.isMesh || !q.geometry) return;
        const pos = q.geometry.attributes.position;
        for (let i = 0; i < pos.count; i++) {
          const v = new V().fromBufferAttribute(pos, i).applyMatrix4(q.matrixWorld);
          if (inv) v.applyMatrix4(inv);
          [v.x, v.y, v.z].forEach((c, k) => { mn[k] = Math.min(mn[k], c); mx[k] = Math.max(mx[k], c); });
        }
      });
      return { mn, mx };
    };
    const groups = [];
    M.root.traverse((q) => { if (q.userData && q.userData.ssPorchPart === "steps") groups.push(q); });
    const out = { n: groups.length, grade: M.grade, porch: M.porch ? { steps: M.porch.steps || null, posts: M.porch.posts, side: M.porch.side, D: M.porch.D, dWall: M.porch.dWall, POST: M.porch.sizes.POST } : null,
      recessedSteps: M.recessedSteps || null };
    if (!groups.length) return out;
    const st = groups[0], frame = st.parent;
    const inv = new M4().copy(frame.matrixWorld).invert();
    const chainShown = (q) => { let n = q; while (n) { if (!n.visible) return false; n = n.parent; } return true; };
    const local = boxIn(st, inv), world = boxIn(st, null);
    const treads = [];
    st.traverse((q) => { if (q.isMesh && q.userData.ssPorchPart === "stepTread") treads.push(boxIn(q, null).mx[1]); });
    const under = (q, anc) => { let n = q; while (n) { if (n === anc) return true; n = n.parent; } return false; };
    Object.assign(out, {
      where: st.userData.ssPorchSteps, visible: chainShown(st), hiddenBy: st.userData.ssHiddenBy || null,
      frameTag: frame.userData.ssPorch || null, frameInRoot: frame.parent === M.root, inRoofGroup: under(st, M.roofGroup),
      local: { x: [local.mn[0], local.mx[0]], z: [local.mn[2], local.mx[2]] }, world: { y: [world.mn[1], world.mx[1]] },
      treads: treads.sort((a, b) => b - a),
      // Out from the footprint's line on each wall, the steps' nearest and farthest points.
      near: { south: world.mn[2] - L / 2, north: -L / 2 - world.mx[2], east: world.mn[0] - W / 2, west: -W / 2 - world.mx[0] },
    });
    // The projecting deck's side rims (their outer faces are the deck's ends) and its posts, in the deck frame.
    out.rims = []; out.deckPosts = []; out.deckSupports = [];
    if (frame.userData.ssPorch !== "recessedSteps") {
      frame.traverse((q) => { if (q.isMesh && q.userData.ssPorchPart === "rim") { const b = boxIn(q, inv); if (b.mx[2] - b.mn[2] > 1) out.rims.push([b.mn[0], b.mx[0]]); } });
      frame.traverse((q) => { if (q.isMesh && q.userData.ssPorchPart === "deckSupport") { const b = boxIn(q, inv); out.deckSupports.push([b.mn[0], b.mx[0], b.mn[2], b.mx[2]]); } });
      M.roofGroup.traverse((q) => { if (q.isMesh && q.userData.ssPorchPart === "post") { const b = boxIn(q, inv); out.deckPosts.push([(b.mn[0] + b.mx[0]) / 2, b.mn[2], b.mx[2]]); } });
    }
    // A recessed porch's posts, in the holder's frame: the eave line's tagged ones, and a gable end's two
    // corner posts, found by their size (0.32 ft square and the wall's height: nothing else is).
    out.recPosts = [];
    M.roofGroup.traverse((q) => {
      if (!q.isMesh || !q.geometry || q.geometry.type !== "BoxGeometry") return;
      const g = q.geometry.parameters;
      const tagged = q.userData && q.userData.ssRecessedEave === "post";
      if (!tagged && !(Math.abs(g.width - 0.32) < 1e-9 && Math.abs(g.depth - 0.32) < 1e-9 && Math.abs(g.height - H) < 1e-6)) return;
      const b = boxIn(q, inv);
      out.recPosts.push([b.mn[0], b.mx[0], b.mn[2], b.mx[2]]);
    });
    return out;
  }, { W, L, H });
}

async function stepsRun(ctx, c, ok, shots) {
  const [W, L] = c.size.split("x").map(Number);
  const config = configFor(c);
  const page = await ctx.newPage();
  const errors = collectErrors(page);
  await page.addInitScript(() => { window.__SS3D_DEBUG = true; });
  await stubSupabase(page, { config, fixtures: FIXTURES });
  const tag = `${c.id} ${c.label} ${c.size}`;
  const PURE = purePorch();
  try {
    await openDesigner(page, config.clientId);
    await page.waitForFunction(() => [...document.querySelectorAll("svg rect")].some((r) => r.getAttribute("stroke") === "#1E293B"), null, { timeout: 30000 });
    await pickStyle(page, c.label);
    await chooseSize(page, c.size);
    if (c.place) await placeOnPorchWall(page, ok, W, L, c.at);
    await openEditor(page);
    const H = c.d3.wallHeightFt;
    const m = await measureSteps(page, W, L, H);
    const g = c.recessed ? m.recessedSteps : m.porch && m.porch.steps;
    ok(`${tag}: one flight of steps, "${c.steps}"`, m.n === 1 && m.where === c.steps && !!g && g.where === c.steps, JSON.stringify({ n: m.n, where: m.where, model: g && g.where }));
    if (!g || m.n !== 1) return;
    console.log(`   ${tag}: count ${g.count} rise ${f3(g.rise)} w ${f3(g.w)} grade ${f3(-g.grade)} local x ${m.local.x.map(f3)} z ${m.local.z.map(f3)}`);
    ok(`${tag}: ${g.count} treads, each a rise lower than the one before, the top one a rise under the floor`,
      m.treads.length === g.count && m.treads.every((y, k) => Math.abs(y - (g.grade + (g.count - k) * g.rise)) < 0.005), `${m.treads.map(f3).join(" ")} rise ${f3(g.rise)}`);
    ok(`${tag}: it stands on the grass (the model's grade, level ground)`, Math.abs(m.world.y[0] + m.grade) < 0.005 && Math.abs(-g.grade - m.grade) < 1e-9, `bottom ${f3(m.world.y[0])} grade ${f3(m.grade)}`);
    ok(`${tag}: no riser over 7.5 in`, g.rise <= 7.5 / 12 + 1e-9 || g.count === Number(c.d3.roof.porchStepCount), f3(g.rise * 12));
    if (!c.recessed) {
      const P = m.porch;
      const turn = c.steps === "rightSide" ? 1 : -1;
      ok(`${tag}: model.porch.steps is turned onto the ${turn > 0 ? "right" : "left"} end`, g.turn === turn && Math.abs(g.edgeX - turn * P.side) < 1e-9, JSON.stringify({ turn: g.turn, edgeX: g.edgeX, side: P.side }));
      ok(`${tag}: in the deck's group, beside the deck (not the roof)`, m.frameTag === null && !m.inRoofGroup);
      // The deck's end: the side rim's outer face. The first tread starts EPS past it.
      const rim = m.rims.find((r) => (turn > 0 ? r[1] > 0 : r[0] < 0));
      const rimFace = rim ? (turn > 0 ? rim[1] : rim[0]) : null;
      const inner = turn > 0 ? m.local.x[0] : m.local.x[1];
      ok(`${tag}: its first tread starts at the side rim's outer face`, rimFace != null && Math.abs(rimFace - turn * P.side) < 0.005 && Math.abs(inner - (rimFace + turn * 0.005)) < 0.005,
        `flight inner face ${f3(inner)} rim face ${f3(rimFace)} side ${f3(P.side)}`);
      ok(`${tag}: it runs out from that end, count x tread`, Math.abs((turn > 0 ? m.local.x[1] - m.local.x[0] : m.local.x[1] - m.local.x[0]) - (0.005 + g.count * g.tread)) < 0.01,
        `${f3(m.local.x[1] - m.local.x[0])} vs ${f3(0.005 + g.count * g.tread)}`);
      ok(`${tag}: along the end, between the wall and the corner post's inner face`, m.local.z[0] >= P.dWall - 1e-6 && m.local.z[1] <= P.D - P.POST + 1e-6 && Math.abs((m.local.z[0] + m.local.z[1]) / 2 - g.atD) < 0.005,
        `d ${m.local.z.map(f3)} wall ${f3(P.dWall)} post ${f3(P.D - P.POST)} atD ${f3(g.atD)}`);
      // ...and clear of every deck support (a corner block reaches 5 in past the deck's end), in plan.
      const sClash = m.deckSupports.filter((q) => q[0] < m.local.x[1] - 1e-6 && q[1] > m.local.x[0] + 1e-6 && q[2] < m.local.z[1] - 1e-6 && q[3] > m.local.z[0] + 1e-6);
      ok(`${tag}: ...and clear of the deck's supports (${m.deckSupports.length})`, sClash.length === 0, JSON.stringify(sClash.slice(0, 2)));
      // On piers (one mesh each) every support the deck stands is there, but a middle row's at the end the
      // flight leaves from, where the flight stands instead (a deck over 7 ft deep past the wall).
      if (c.d3.foundation === "piers") {
        const mid = P.D - P.dWall > 7 ? (P.dWall + P.D) / 2 : null;
        const dropped = mid != null && Math.abs(mid - g.atD) < g.w / 2 + 0.5 ? 1 : 0;
        const want = (mid != null ? 2 : 1) * P.posts - dropped;
        ok(`${tag}: ${want} piers under the deck${dropped ? ", the middle row's under the flight left out" : ""}`, m.deckSupports.length === want, `found ${m.deckSupports.length}`);
      }
      // The posts are the same porch's without steps: side steps never add a bay.
      const roofNo = { ...c.d3.roof }; delete roofNo.porchSteps; delete roofNo.porchStepCount;
      const plain = PURE.d3PorchReadout({ ...c.d3, roof: roofNo }, c.size);
      const outer = P.side - P.POST / 2;
      const want = Array.from({ length: plain.posts }, (_, k) => -outer + (2 * outer * k) / plain.bays);
      const got = m.deckPosts.map((q) => q[0]).sort((a, b) => a - b);
      ok(`${tag}: the posts are the ones the porch builds without steps (${plain.posts})`, P.posts === plain.posts && got.length === want.length && got.every((x, k) => Math.abs(x - want[k]) < 0.005),
        `drawn ${got.map(f3).join(" ")} want ${want.map(f3).join(" ")}`);
    } else {
      const fr = PURE.d3RecessedPorchFrame(c.d3.roof, W, L, H);
      ok(`${tag}: the pure frame is this porch (${c.wall}${c.eave ? ", an eave wall" : ""}, ${c.posts} posts)`, !!fr && fr.wall === c.wall && fr.onEave === !!c.eave && fr.posts === c.posts && g.wall === c.wall,
        JSON.stringify(fr && { wall: fr.wall, onEave: fr.onEave, posts: fr.posts, model: g.wall }));
      ok(`${tag}: in its own holder in root, not in the roof (look-inside keeps it)`, m.frameTag === "recessedSteps" && m.frameInRoot && !m.inRoofGroup);
      ok(`${tag}: its first tread starts 0.15 ft past the footprint's edge`, Math.abs(m.local.z[0] - (0.15 + 0.005)) < 0.005 && Math.abs(m.near[c.wall] - (0.15 + 0.005)) < 0.005,
        `local ${f3(m.local.z[0])} world ${f3(m.near[c.wall])}`);
      ok(`${tag}: ...and runs out count x tread from there`, Math.abs(m.local.z[1] - (0.155 + g.count * g.tread)) < 0.01, `${f3(m.local.z[1])} vs ${f3(0.155 + g.count * g.tread)}`);
      ok(`${tag}: ${c.posts} posts stand in the opening`, m.recPosts.length === c.posts, `found ${m.recPosts.length}`);
      const clash = m.recPosts.filter((q) => q[0] < m.local.x[1] - 1e-6 && q[1] > m.local.x[0] + 1e-6);
      ok(`${tag}: the flight stands clear of every post`, m.recPosts.length > 0 && clash.length === 0,
        `flight x ${m.local.x.map(f3)} posts ${m.recPosts.map((q) => `${f3(q[0])}..${f3(q[1])}`).join(" ")}`);
      const halfOpen = Math.max(...m.recPosts.map((q) => Math.max(Math.abs(q[0]), Math.abs(q[1]))));
      ok(`${tag}: ...and inside the opening, on its ${c.steps === "center" ? "middle" : c.steps} side`,
        m.local.x[0] > -halfOpen && m.local.x[1] < halfOpen && (c.steps === "center" ? Math.abs(m.local.x[0] + m.local.x[1]) < 0.01 : (c.steps === "left" ? m.local.x[1] < 0 : m.local.x[0] > 0)),
        `x ${m.local.x.map(f3)} opening ${f3(halfOpen)}`);
      // The holder's x runs to the right of someone standing in front of it: on the north wall that is -x.
      const pr = PURE.d3RecessedPorchReadout(c.d3, c.size);
      ok(`${tag}: model.recessedSteps is the readout's flight`, !!pr && JSON.stringify(pr.steps) === JSON.stringify({ ...g, wall: undefined }), JSON.stringify({ pure: pr && pr.steps, model: g }));
    }
    if (c.stepsHidden) {
      ok(`${tag}: a ramp run out over them hides them, saying the ramp did it`, m.visible === false && m.hiddenBy === "ramp", JSON.stringify({ visible: m.visible, hiddenBy: m.hiddenBy }));
      const items = (await readItems(page)) || [];
      const shown = (list) => page.evaluate((list) => {
        const M = window.__ss3dEngine.model;
        M.rebuildInterior(list);
        let vis = null;
        M.root.traverse((q) => {
          if (!(q.userData && q.userData.ssPorchPart === "steps")) return;
          let n = q, v = true;
          while (n) { if (!n.visible) v = false; n = n.parent; }
          vis = v;
        });
        return vis;
      }, list);
      ok(`${tag}: a live rebuild without the ramp brings them back`, (await shown(items.filter((i) => i.type !== "ramp"))) === true);
      ok(`${tag}: ...and with it, hides them again`, (await shown(items)) === false);
    } else ok(`${tag}: the steps are drawn`, m.visible === true && m.hiddenBy === null);
    const n = { south: [0, 1], north: [0, -1], east: [1, 0], west: [-1, 0] }[c.wall];
    const reach = c.recessed ? 0 : (m.porch ? m.porch.D : 0);
    // From in front, off to the side the steps are on, so a flight off an end is in the frame.
    const sg = /left/i.test(c.steps) ? -1 : 1, r = [sg * n[1], -sg * n[0]];
    await shot(page, `${shots}/${c.id}-steps.png`, [n[0] * (W / 2 + reach + 10) + r[0] * 11, H * 0.7, n[1] * (L / 2 + reach + 10) + r[1] * 11], [n[0] * (W / 2 + reach * 0.6) + r[0] * 4, 0, n[1] * (L / 2 + reach * 0.6) + r[1] * 4]);
    ok(`${tag}: no page errors`, errors.length === 0, JSON.stringify(errors).slice(0, 300));
  } catch (e) {
    ok(`${tag}: ran to the end`, false, e && e.message ? e.message.split("\n")[0] : String(e));
  } finally {
    await page.close();
  }
}

async function shot(page, path, eye, at) {
  const clip = await page.evaluate(({ eye, at }) => {
    const E = window.__ss3dEngine;
    E.camera.position.set(eye[0], eye[1], eye[2]);
    E.controls.target.set(at[0], at[1], at[2]);
    E.camera.lookAt(at[0], at[1], at[2]);
    E.camera.updateProjectionMatrix();
    if (E.controls.update) E.controls.update();
    E.render();
    const c = E.renderer.domElement.getBoundingClientRect();
    return { x: c.x, y: c.y, width: c.width, height: c.height };
  }, { eye, at });
  await settle(page, 250);
  await page.evaluate(() => window.__ss3dEngine.render());
  await page.screenshot({ path, clip });
}

// 19: every porch member and lean-to member in the corner's own frame (s, d, y and f = d - s, the side of the hip:
// + the porch's, - the lean-to's), by its tag; and a digest of every porch and lean-to vertex, for PJ5.
async function measureJoin(page, sd) {
  return page.evaluate((sd) => {
    const E = window.__ss3dEngine, M = E.model, V = E.camera.position.constructor;
    E.scene.updateMatrixWorld(true);
    const rng = (o) => {
      const r = { s: [Infinity, -Infinity], d: [Infinity, -Infinity], y: [Infinity, -Infinity], f: [Infinity, -Infinity] };
      const p = o.geometry.attributes.position, v = new V();
      for (let k = 0; k < p.count; k++) {
        v.fromBufferAttribute(p, k).applyMatrix4(o.matrixWorld);
        const s = sd.swap ? sd.sx * (v.z - sd.cz) : sd.sx * (v.x - sd.cx), d = sd.swap ? sd.dz * (v.x - sd.cx) : sd.dz * (v.z - sd.cz);
        [["s", s], ["d", d], ["y", v.y], ["f", d - s]].forEach(([key, x]) => { r[key][0] = Math.min(r[key][0], x); r[key][1] = Math.max(r[key][1], x); });
      }
      return r;
    };
    const parts = {}, lean = [];
    let digest = "";
    const dig = (o) => { const p = o.geometry.attributes.position, v = new V(); for (let k = 0; k < p.count; k++) { v.fromBufferAttribute(p, k).applyMatrix4(o.matrixWorld); digest += [v.x, v.y, v.z].map((c) => c.toFixed(4)).join(",") + ";"; } };
    M.root.traverse((q) => {
      if (!q.isMesh || !q.userData) return;
      const u = q.userData;
      if (u.ssPorchPart && !(q.parent && q.parent.userData && q.parent.userData.ssPorchPart === "steps")) {
        (parts[u.ssPorchPart] = parts[u.ssPorchPart] || []).push({ ...rng(q), join: u.ssPorchJoin == null ? null : u.ssPorchJoin, buffer: q.geometry.type === "BufferGeometry" });
        dig(q);
      }
      if (u.ssLeanTo !== undefined) {
        lean.push({ tag: u.ssLeanTo, slab: !!u.ssLeanToSlab, hip: !!u.ssLeanToHip, post: !!u.ssLeanToPost, ...rng(q) });
        dig(q);
      }
    });
    // TUCKED: no vertex of anything else on the roof inside the porch's sheet, ceiling, front board or drip -- bar the
    // lean-tos it meets, whose roofs it runs into on the hip. Each is a convex box, cut on the hip where it runs on, so
    // a point is inside when it stands behind every face, by `depth`.
    const meets = new Set(M.leanToPorch ? Object.keys(M.leanToPorch.ends).map(Number) : []);
    const inPorch = (q) => { let n = q; while (n) { if (n.userData && n.userData.ssPorch) return true; n = n.parent; } return false; };
    const holders = [];
    M.root.traverse((q) => {
      if (!q.isMesh || !q.userData || ["slab", "ceiling", "board", "drip"].indexOf(q.userData.ssPorchPart) < 0) return;
      const p = q.geometry.attributes.position, idx = q.geometry.index, n = idx ? idx.count : p.count;
      const at = (k) => new V().fromBufferAttribute(p, idx ? idx.getX(k) : k).applyMatrix4(q.matrixWorld);
      const planes = [], lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity], mid = new V();
      for (let t = 0; t + 2 < n; t += 3) {
        const a = at(t), b = at(t + 1), c = at(t + 2);
        [a, b, c].forEach((v) => { mid.add(v); [v.x, v.y, v.z].forEach((x, k) => { lo[k] = Math.min(lo[k], x); hi[k] = Math.max(hi[k], x); }); });
        const nrm = new V().subVectors(b, a).cross(new V().subVectors(c, a));
        if (nrm.lengthSq() < 1e-16) continue;
        nrm.normalize();
        planes.push([nrm, nrm.dot(a)]);
      }
      // Its own middle must test inside, or the faces were not wound outward and the test below could see nothing.
      mid.multiplyScalar(1 / n);
      holders.push({ name: q.userData.ssPorchPart, planes, lo, hi, self: Math.min(...planes.map(([nrm, d]) => d - nrm.dot(mid))) });
    });
    const tucked = [];
    M.roofGroup.traverse((q) => {
      if (!q.isMesh || inPorch(q) || (q.userData && q.userData.ssLeanTo != null && meets.has(q.userData.ssLeanTo))) return;
      const p = q.geometry.attributes.position, v = new V();
      for (let k = 0; k < p.count; k++) {
        v.fromBufferAttribute(p, k).applyMatrix4(q.matrixWorld);
        for (const h of holders) {
          if (v.x < h.lo[0] || v.x > h.hi[0] || v.y < h.lo[1] || v.y > h.hi[1] || v.z < h.lo[2] || v.z > h.hi[2]) continue;
          const depth = Math.min(...h.planes.map(([nrm, d]) => d - nrm.dot(v)));
          if (depth > 1e-4 && tucked.length < 40) tucked.push({ in: h.name, lean: q.userData ? q.userData.ssLeanTo : undefined, at: [v.x, v.y, v.z].map((x) => +x.toFixed(3)), depth: +depth.toFixed(4) });
        }
      }
    });
    const P = M.porch;
    return { parts, lean, digest, tucked, tuckSees: holders.length >= 4 && holders.every((h) => h.self > 0.005), grade: M.grade, ltp: M.leanToPorch ? JSON.parse(JSON.stringify(M.leanToPorch)) : null,
      porch: P ? { yHigh: P.yHigh, pitch: P.pitch, postH: P.postH, hdrTop: P.hdrTop, posts: P.posts, dPost: P.dPost, dEnd: P.dEnd, side: P.side, join: P.join || null, joinClear: P.joinClear, sizes: P.sizes } : null };
  }, sd);
}

// A style whose lean-tos are set to what their cards say matches the porch, `off` ft more drop on the first.
const matchedJoin = (PURE, c) => {
  const spec = c.d3, rs = PURE.d3LeanTosReadout(spec, c.size) || [];
  const leanTos = spec.roof.leanTos.map((e, i) => {
    const f = e.meetPorch && rs[i] && rs[i].porchCorner && rs[i].porchCorner.fix;
    return f ? { ...e, attach: f.attach || undefined, attachFt: f.attach ? f.attachFt : undefined, dropFt: f.dropFt + (i === 0 && c.off ? c.off : 0) } : e;
  });
  return { ...spec, roof: { ...spec.roof, leanTos } };
};

async function joinOpen(ctx, c, d3) {
  const config = configFor({ ...c, d3 });
  const page = await ctx.newPage();
  const errors = collectErrors(page);
  await page.addInitScript(() => { window.__SS3D_DEBUG = true; });
  await stubSupabase(page, { config, fixtures: FIXTURES });
  await openDesigner(page, config.clientId);
  await page.waitForFunction(() => [...document.querySelectorAll("svg rect")].some((r) => r.getAttribute("stroke") === "#1E293B"), null, { timeout: 30000 });
  await pickStyle(page, c.label);
  await chooseSize(page, c.size);
  await openEditor(page);
  return { page, errors };
}

async function joinRun(ctx, c, ok, shots) {
  const PURE = purePorch();
  const tag = `${c.id} ${c.label} ${c.size}`;
  const d3 = matchedJoin(PURE, c);
  const { page, errors } = await joinOpen(ctx, c, d3);
  try {
    const m = await measureJoin(page, c.sd);
    const P = m.porch, J = m.ltp && m.ltp.joins[0], R = PURE.d3PorchReadout(d3, c.size);
    ok(`${tag}: the lean-to meets the porch: one join, named on model.porch`, !!P && !!J && m.ltp.joins.length === 1 && JSON.stringify(P.join) === JSON.stringify([{ i: 0, at: J.at, js: J.js }]),
      JSON.stringify({ join: P && P.join, joins: m.ltp && m.ltp.joins.map((x) => x.at), near: m.ltp && m.ltp.near }));
    if (!P || !J) return;
    const near = (a, b, t = 0.01) => Math.abs(a - b) <= t;
    ok(`${tag}: the porch is the readout's to the float -- built from its numbers, never lowered by the scan -- and the readout says who meets it`,
      near(P.yHigh, R.yHigh, 1e-9) && near(P.pitch, R.pitch, 1e-9) && near(P.postH, R.postH, 1e-9) && R.atMost === false && JSON.stringify(R.meets) === JSON.stringify([{ i: 0, at: J.at }]),
      JSON.stringify({ built: [P.yHigh, P.pitch], readout: [R.yHigh, R.pitch, R.atMost, R.meets] }));
    if (c.yHigh != null) ok(`${tag}: hung under the main roof's eave corners, at the height the scan builds it unjoined (${c.yHigh})`, near(P.yHigh, c.yHigh, 0.001), f3(P.yHigh));
    ok(`${tag}: its ceiling (${f3(m.ltp.porch.cap)}) never stands over what the scan measures without the lean-to it meets (${f3(P.joinClear)})`,
      typeof P.joinClear === "number" && m.ltp.porch.cap <= P.joinClear + 1e-6, JSON.stringify({ cap: m.ltp.porch.cap, joinClear: P.joinClear }));
    ok(`${tag}: tucked under everything else on the roof: no vertex of it inside the porch's sheet, ceiling, board or drip`, m.tuckSees && m.tucked.length === 0, JSON.stringify({ sees: m.tuckSees, in: m.tucked.slice(0, 6) }));
    const one = (name) => (m.parts[name] || []);
    const sheet = one("slab")[0], ceil = one("ceiling")[0];
    ok(`${tag}: its sheet stays on its side of the hip and runs out past the corner to the lean-to's eave or the hip's end, the nearer (${f3(Math.min(J.eL, J.eP))} ft)`,
      !!sheet && sheet.buffer && sheet.f[0] >= -0.005 && near(sheet.s[1], Math.min(J.eL, J.eP), 0.01), sheet && JSON.stringify({ f: sheet.f.map(f3), s: sheet.s.map(f3) }));
    ok(`${tag}: ...the ceiling under it too, inside the sheet's edge`, !!ceil && ceil.f[0] >= -0.005 && ceil.s[1] <= J.eL - P.sizes.SIDE_OV + 0.005, ceil && JSON.stringify({ f: ceil.f.map(f3), s: ceil.s.map(f3) }));
    const front = Math.min(J.eL, J.eP);
    ok(`${tag}: the front board and the drip run on to where the front edge meets the hip or the lean-to's eave (${f3(front)})`,
      ["board", "drip"].every((k) => one(k).length === 1 && one(k)[0].f[0] >= -0.005 && one(k)[0].s[1] >= front - 0.01 && one(k)[0].s[1] <= front + 0.06),
      JSON.stringify(["board", "drip"].map((k) => one(k).map((b) => b.s.map(f3)))));
    ok(`${tag}: one cheek, one corner fill and one rake trim, all on the far side; none on the joined one`,
      one("cheek").length === 1 && one("cornerFill").length === 1 && one("rake").length === 1 && [...one("cheek"), ...one("cornerFill"), ...one("rake")].every((b) => b.s[1] < -2),
      JSON.stringify({ cheek: one("cheek").map((b) => f3(b.s[1])), fill: one("cornerFill").length, rake: one("rake").map((b) => f3(b.s[1])) }));
    const rk = one("joinRake");
    ok(`${tag}: ${J.eL < J.eP ? "a rake trim along the lean-to's eave line, from the hip to the front edge" : "no rake trim past the hip (the lean-to is the deeper)"}`,
      J.eL < J.eP ? rk.length === 1 && near(rk[0].s[1], J.eL, 0.01) && rk[0].f[0] >= -0.005 && near(rk[0].d[1], J.eP, 0.06) : rk.length === 0, JSON.stringify(rk.map((b) => ({ s: b.s.map(f3), d: b.d.map(f3) }))));
    const own = one("post"), cp = one("joinCorner"), ext = one("joinPost");
    const hw = m.ltp.porch.hw, s0 = P.side - P.sizes.POST / 2 - hw;
    ok(`${tag}: the porch's own ${P.posts} posts stand on its deck, inside its width`, own.length === P.posts && own.every((b) => near(b.y[0], 0, 0.001) && b.s[1] <= P.side - hw + 0.001), JSON.stringify(own.map((b) => [f3(b.s[0]), f3(b.y[0])])));
    const cpb = cp[0], cs = cpb ? (cpb.s[0] + cpb.s[1]) / 2 : NaN, cd = cpb ? (cpb.d[0] + cpb.d[1]) / 2 : NaN;
    const bot = d3.foundation === "blocks" || d3.foundation === "piers" ? -m.grade : 0;
    ok(`${tag}: one corner post where the lean-to's posts' line (${J.w} ft out) crosses the porch's (${f3(P.dPost)}), on the ground`,
      cp.length === 1 && near(cs, J.w, 0.005) && near(cd, P.dPost, 0.005) && near(cpb.y[0], bot, 0.005), JSON.stringify({ n: cp.length, s: f3(cs), d: f3(cd), y: cpb && cpb.y.map(f3) }));
    ok(`${tag}: posts along the porch's line out to it at least every 8.5 ft (${ext.length})`, ext.every((b) => near((b.d[0] + b.d[1]) / 2, P.dPost, 0.005) && b.s[0] > 0 && b.s[1] < J.w) && ext.length === Math.max(1, Math.ceil((J.w - s0) / 8.5 - 1e-6)) - 1,
      JSON.stringify(ext.map((b) => f3((b.s[0] + b.s[1]) / 2))));
    const hd = one("header"), lvl = hd.find((b) => b.join == null), slope = hd.find((b) => b.join === 0);
    const sLvl = Math.min(J.w + 0.175, P.dPost);
    ok(`${tag}: the header runs on level to ${f3(sLvl)} past the corner${J.w + 0.175 > P.dPost ? ", then down the lean-to's slope to its posts' line" : ""}`,
      !!lvl && near(lvl.s[1], sLvl, 0.005) && (J.w + 0.175 > P.dPost + 0.01 ? !!slope && near(slope.s[1], J.w + 0.175, 0.06) && slope.y[0] < lvl.y[0] : !slope),
      JSON.stringify({ lvl: lvl && lvl.s.map(f3), slope: slope && { s: slope.s.map(f3), y: slope.y.map(f3) }, lvlY: lvl && lvl.y.map(f3) }));
    const phi = Math.atan(P.pitch), HH = P.sizes.HDR_H;
    const hb = J.w <= P.dPost ? P.hdrTop - HH : P.hdrTop - P.pitch * (J.w - P.dPost) - HH / Math.cos(phi);
    ok(`${tag}: the corner post's top meets the header's underside there (${f3(hb)})`, !!cpb && near(cpb.y[1], hb, 0.005), JSON.stringify({ post: cpb && f3(cpb.y[1]), hdr: hd.map((b) => b.y.map(f3)) }));
    const hr = one("hipRafter"), jr = one("jackRafter");
    ok(`${tag}: a hip rafter under the hip, and jack rafters from it on the porch's side, inside the ceiling (${jr.length})`,
      hr.length === 1 && hr[0].f[0] > -0.15 && hr[0].f[1] < 0.15 && (J.eL - P.sizes.SIDE_OV > 2.5 ? jr.length >= 1 : true) && jr.every((b) => b.f[0] >= 0.088 - 0.005 && b.s[1] <= J.eL - P.sizes.SIDE_OV + 0.005),
      JSON.stringify({ hr: hr.map((b) => b.f.map(f3)), jr: jr.map((b) => [b.f[0], b.s[1]].map(f3)) }));
    const cap = one("hip"), lcap = m.lean.filter((q) => q.hip);
    ok(`${tag}: the hip's cap, a strip on the sheet and one on the lean-to's slab, each 0.06 ft past the hip`,
      cap.length === 1 && lcap.length === 1 && cap[0].f[0] >= -0.06 * Math.SQRT2 - 0.005 && cap[0].f[1] <= 0.275 * Math.SQRT2 + 0.005 && lcap[0].f[1] <= 0.06 * Math.SQRT2 + 0.005,
      JSON.stringify({ porch: cap.map((b) => b.f.map(f3)), lean: lcap.map((b) => b.f.map(f3)) }));
    const ls = m.lean.find((q) => q.slab);
    ok(`${tag}: the lean-to's slab stays on its side of the hip${J.eL > J.eP ? " and stops on the porch's front edge" : ""}`,
      !!ls && ls.f[1] <= 0.005 && (J.eL > J.eP ? ls.d[1] <= J.eP + 0.005 : true), ls && JSON.stringify({ f: ls.f.map(f3), d: ls.d.map(f3) }));
    ok(`${tag}: no page errors`, errors.length === 0, JSON.stringify(errors).slice(0, 300));
    const [W, L] = c.size.split("x").map(Number);
    // A point s out from the lean-to's wall and d out from the porch's, in the world (x, z): measureJoin's frame.
    const at = (s, d) => (c.sd.swap ? [c.sd.cx + c.sd.dz * d, c.sd.cz + c.sd.sx * s] : [c.sd.cx + c.sd.sx * s, c.sd.cz + c.sd.dz * d]);
    const e1 = at(J.w / 2 + 20, P.dPost / 2 + 24), e2 = at(J.w + 9, P.dPost + 10), t2 = at(J.w * 0.6, P.dPost * 0.6);
    await shot(page, `${shots}/${c.id}-join.png`, [e1[0], c.H + 9, e1[1]], [c.sd.cx, c.H * 0.55, c.sd.cz]);
    await shot(page, `${shots}/${c.id}-corner.png`, [e2[0], c.H + 3, e2[1]], [t2[0], c.H - 1.5, t2[1]]);
    void W; void L;
  } catch (e) {
    ok(`${tag}: ran to the end`, false, e && e.message ? e.message.split("\n")[0] : String(e));
  } finally {
    await page.close();
  }
}

// PJ5: asked and a hair off is the same porch and lean-to as not asked at all, vertex for vertex.
async function joinMissRun(ctx, c, ok) {
  const PURE = purePorch();
  const tag = `${c.id} ${c.label} ${c.size}`;
  const d3 = matchedJoin(PURE, c);
  const plain = { ...d3, roof: { ...d3.roof, leanTos: d3.roof.leanTos.map(({ meetPorch: _m, ...e }) => e) } };
  try {
    const a = await joinOpen(ctx, c, d3);
    const ma = await measureJoin(a.page, c.sd);
    await a.page.close();
    const b = await joinOpen(ctx, { ...c, label: c.label + " Plain" }, plain);
    const mb = await measureJoin(b.page, c.sd);
    await b.page.close();
    const N0 = ma.ltp && ma.ltp.near.find((x) => x.i === 0);
    ok(`${tag}: asked, ${c.off ? `its drop ${c.off * 12} in past a match` : "matched, beside a lower lean-to over the porch"}: no join, a near-miss (${c.why})`,
      !!ma.ltp && ma.ltp.joins.length === 0 && !!N0 && N0.asked && JSON.stringify(N0.why) === JSON.stringify(c.why) && !ma.porch.join,
      JSON.stringify(ma.ltp));
    ok(`${tag}: ...and the porch and the lean-to are built vertex for vertex as without the ask (${ma.digest.length} chars)`, ma.digest.length > 1000 && ma.digest === mb.digest,
      `${ma.digest.length} vs ${mb.digest.length}`);
    ok(`${tag}: no page errors`, a.errors.length === 0 && b.errors.length === 0, JSON.stringify([...a.errors, ...b.errors]).slice(0, 300));
  } catch (e) {
    ok(`${tag}: ran to the end`, false, e && e.message ? e.message.split("\n")[0] : String(e));
  }
}

// seen: what each finished case built, for the cases that must build the same porch (sameAs).
async function runCase(ctx, c, ok, shots, seen) {
  const [W, L] = c.size.split("x").map(Number);
  const config = configFor(c);
  const page = await ctx.newPage();
  const errors = collectErrors(page);
  await page.addInitScript(() => { window.__SS3D_DEBUG = true; });
  await stubSupabase(page, { config, fixtures: FIXTURES });
  const tag = `${c.id} ${c.label} ${c.size}`;
  try {
    await openDesigner(page, config.clientId);
    await page.waitForFunction(() => [...document.querySelectorAll("svg rect")].some((r) => r.getAttribute("stroke") === "#1E293B"), null, { timeout: 30000 });
    await pickStyle(page, c.label);
    await chooseSize(page, c.size);
    if (c.place) await placeOnPorchWall(page, ok, W, L, c.at);
    await openEditor(page);
    const m = await measure(page, W, L);
    const P = m.porch;
    ok(`${tag}: wall height read from the scene is ${c.H}`, Math.abs(m.H - c.H) < 0.02, f3(m.H));

    if (c.off) {
      ok(`${tag}: no porch roof or deck groups, and model.porch is null`, m.nRoof === 0 && m.nDeck === 0 && P === null, `roof ${m.nRoof} deck ${m.nDeck} porch ${JSON.stringify(P)}`);
      ok(`${tag}: ...and no wall receives shadows`, m.recv.other === 0, JSON.stringify(m.recv));
    } else {
      ok(`${tag}: one porch roof group, inside roofGroup`, m.nRoof === 1 && m.roofInRoofGroup, `roof groups ${m.nRoof}`);
      ok(`${tag}: one deck group, reachable from root and NOT inside roofGroup`, m.nDeck === 1 && m.deckInRoot && !m.deckInRoofGroup);
      if (!P || !m.slab) { ok(`${tag}: model.porch and the porch roof sheet exist`, false, JSON.stringify({ porch: !!P, slab: !!m.slab })); return; }
      console.log(`   ${tag}: D ${P.D} wall ${P.wall} pitch ${f3(P.pitch)} yHigh ${f3(P.yHigh)} postH ${f3(P.postH)} ceilWall ${f3(P.ceilWall)} posts ${P.posts} short ${P.short}`);
      if (c.wall) ok(`${tag}: the porch stands on the ${c.wall} wall (${c.d3.roof.porchEnd})`, P.wall === c.wall, P.wall);
      if (c.leanToOver) {
        ok(`${tag}: the lean-to on the porch's wall is tagged, and its roof runs over the porch`, m.leanTo.n >= 3 && m.leanTo.lowestOver != null && Number.isFinite(m.leanTo.lowestOver), JSON.stringify(m.leanTo));
        ok(`${tag}: ...and the porch roof is tucked under it`, m.leanTo.lowestOver != null && m.slab.top <= m.leanTo.lowestOver + 0.005, `slab top ${f3(m.slab.top)} lean-to over it ${f3(m.leanTo.lowestOver)}`);
      }
      ok(`${tag}: the deck's top is the floor (y 0)`, Math.abs(m.deck.top) <= 0.005, f3(m.deck.top));
      ok(`${tag}: the deck projects D`, Math.abs(m.deck.out - P.D) <= 0.02, `out ${f3(m.deck.out)} D ${P.D}`);
      ok(`${tag}: the porch roof reaches D + 0.25..0.45`, m.slab.out > P.D + 0.25 && m.slab.out < P.D + 0.45, f3(m.slab.out));
      ok(`${tag}: the porch roof's top stays under H - 0.15`, m.slab.top < c.H - 0.15, `top ${f3(m.slab.top)} H ${c.H}`);
      ok(`${tag}: tucked under every main-roof mesh past the wall face`, m.clash.length === 0, JSON.stringify(m.clash).slice(0, 240));
      const Z = P.sizes, parts = m.parts, n = (k) => parts[k].length;
      // The porch roof's planes, from the pure numbers: its top, and the ceiling boards' underside.
      const sec = Math.sqrt(1 + P.pitch * P.pitch);
      const yTop = (d) => P.yHigh - P.pitch * (d - P.dWall);
      const yU = (d) => yTop(d) - (Z.PR_T + Z.SHEATH) * sec;
      const dC = P.dEnd - Z.FAS_T;
      ok(`${tag}: every porch member is tagged, and each is there`,
        m.untagged === 0 && n("slab") === 1 && n("ceiling") === 1 && n("header") === 1 && n("rafter") === P.nRaf && n("cheek") === 2 && n("rake") === 2 && n("board") === 1 && n("drip") === 1 && n("ledger") === 1,
        `untagged ${m.untagged} ${Object.entries(parts).map(([k, v]) => `${k} ${v.length}`).join(", ")} (nRaf ${P.nRaf})`);
      ok(`${tag}: post count is model.porch.posts${c.posts ? ` (${c.posts})` : ""}`, m.posts.length === P.posts && (!c.posts || P.posts === c.posts), `posts ${m.posts.length} model ${P.posts}`);
      ok(`${tag}: every post stands at D, from the floor to postH`, m.posts.length > 0 && m.posts.every((q) => Math.abs(q.out - P.D) <= 0.02 && Math.abs(q.minY) < 0.005 && Math.abs(q.maxY - P.postH) < 0.005),
        m.posts.map((q) => `${f3(q.out)}@${f3(q.maxY)}`).join(" "));
      const postTop = m.posts.length ? Math.min(...m.posts.map((q) => q.maxY)) : null;
      if (c.short) ok(`${tag}: a wall too short for 6'8" sits at pitch 0.05 and says short`, P.pitch === 0.05 && P.short === true, `pitch ${P.pitch} short ${P.short}`);
      else ok(`${tag}: 6'8" clear under the header (the drawn posts), or pitch 0.05 flagged short`, (postTop != null && postTop >= 6.66) || (P.pitch === 0.05 && P.short === true), `post tops ${f3(postTop)} pitch ${f3(P.pitch)}`);
      const H0 = parts.header[0];
      ok(`${tag}: the header sits on the posts and meets the ceiling boards (hdrTop)`, !!H0 && Math.abs(H0.minY - P.postH) < 0.005 && Math.abs(H0.maxY - P.hdrTop) < 0.005,
        H0 ? `${f3(H0.minY)}..${f3(H0.maxY)} want ${f3(P.postH)}..${f3(P.hdrTop)}` : "no header");
      ok(`${tag}: ...under the roof sheet's underside at its centre line`, !!H0 && H0.maxY <= yTop((H0.near + H0.out) / 2) - Z.PR_T * sec + 0.001,
        H0 ? `top ${f3(H0.maxY)} sheet underside ${f3(yTop((H0.near + H0.out) / 2) - Z.PR_T * sec)}` : "no header");
      ok(`${tag}: the header's ends stay inside the cheeks`, m.hdrU != null && m.hdrU <= P.side - Z.CHEEK_T + 0.011, `|u| ${f3(m.hdrU)} limit ${f3(P.side - Z.CHEEK_T + 0.011)}`);
      // A rafter lies on the slope, so its box's highest corner is its top inner edge, which sits
      // RAF_D * sin(slope) further out than the box's nearest corner (its bottom inner edge), and
      // its farthest corner is its top outer edge, (PR_T + SHEATH) * sin(slope) short of its end.
      const sinA = P.pitch / sec;
      const rBad = parts.rafter.filter((r) => !(Math.abs(r.maxY - yU(r.near + sinA * Z.RAF_D)) < 0.005 && Math.max(Math.abs(r.across[0]), Math.abs(r.across[1])) <= P.side - Z.CHEEK_T + 0.005
        && Math.abs(r.out + sinA * (Z.PR_T + Z.SHEATH) - dC) < 0.005));
      ok(`${tag}: the rafters hang from the ceiling boards, inside the cheeks, out to the front board`, parts.rafter.length === P.nRaf && rBad.length === 0,
        `rafters ${parts.rafter.length} off ${JSON.stringify(rBad.slice(0, 2).map((r) => ({ top: f3(r.maxY), ceil: f3(yU(r.near + sinA * Z.RAF_D)), u: r.across.map(f3), out: f3(r.out), dC: f3(dC) })))}`);
      const Lg = parts.ledger[0];
      ok(`${tag}: the ledger is on the wall with its top at ceilWall + RAF_D`, !!Lg && Math.abs(Lg.maxY - (P.ceilWall + Z.RAF_D)) < 0.005 && Math.abs(Lg.near) < 0.005,
        Lg ? `top ${f3(Lg.maxY)} want ${f3(P.ceilWall + Z.RAF_D)} near ${f3(Lg.near)}` : "no ledger");
      const ch = [...parts.cheek].sort((a, b) => (a.across[0] + a.across[1]) - (b.across[0] + b.across[1]));
      ok(`${tag}: a cheek each side, wall to the corner post's outer face (D), post tops to the ceiling, flush with the posts' outer faces`,
        ch.length === 2 && ch.every((q) => Math.abs(q.minY - P.postH) < 0.005 && Math.abs(q.maxY - yU(P.dWall)) < 0.01 && Math.abs(q.near - P.dWall) < 0.005 && Math.abs(q.out - P.D) < 0.005 && Math.abs(q.across[1] - q.across[0] - Z.CHEEK_T) < 0.005)
          && Math.abs(Math.abs(ch[0].across[0]) - P.side) < 0.005 && Math.abs(Math.abs(ch[1].across[1]) - P.side) < 0.005,
        ch.map((q) => `y ${f3(q.minY)}..${f3(q.maxY)} d ${f3(q.near)}..${f3(q.out)} u ${q.across.map(f3)}`).join(" | "));
      // THE CHEEK STIPPLE. An outer rafter laid flush against a cheek put its face in the cheek's inner
      // plane, and faint grey single-pixel dots ran along both cheeks. Every rafter's across extent must
      // stop short of the nearer (inner) face of the cheeks as they are built, not of a number.
      const cheekInner = ch.length === 2 ? Math.min(...ch.map((q) => Math.min(Math.abs(q.across[0]), Math.abs(q.across[1])))) : null;
      const rafReach = parts.rafter.length ? Math.max(...parts.rafter.map((r) => Math.max(Math.abs(r.across[0]), Math.abs(r.across[1])))) : null;
      ok(`${tag}: no rafter reaches a cheek's inner face (the stipple)`, cheekInner != null && rafReach != null && rafReach <= cheekInner - 0.005,
        `rafters reach |u| ${f3(rafReach)}, cheek inner face |u| ${f3(cheekInner)}`);
      ok(`${tag}: the siding stops at the corner post's outer face: no cheek past D (10-01)`, m.boardBot != null && m.cheekStub.length === 0, `stub ${JSON.stringify(m.cheekStub.slice(0, 4))}`);
      const fills = parts.cornerFill;
      ok(`${tag}: ...and past it each front corner is closed in wood, from the post top to the ceiling and out to the board`,
        fills.length === 2 && fills.every((q) => Math.abs(q.minY - P.postH) < 0.005 && Math.abs(q.maxY - yU(P.D)) < 0.005 && Math.abs(q.near - P.D) < 0.005 && Math.abs(q.out - dC) < 0.005
          && ch.some((k) => Math.abs(k.across[0] - q.across[0]) < 0.005 && Math.abs(k.across[1] - q.across[1]) < 0.005) && q.color === c.wood),
        fills.map((q) => `y ${f3(q.minY)}..${f3(q.maxY)} d ${f3(q.near)}..${f3(q.out)} u ${q.across.map(f3)} ${q.color}`).join(" | "));
      ok(`${tag}: no recessed set-back: the porch-end wall spans the footprint, flush`,
        m.wallAcross && (m.wallAcross[1] - m.wallAcross[0]) > ((P.wall === "south" || P.wall === "north") ? W : L) - 0.05 && Math.abs(m.wallOut) < 0.3,
        `across ${m.wallAcross && m.wallAcross.map(f3)} out ${f3(m.wallOut)}`);
      if (m.lblOut != null || c.place) ok(`${tag}: the ground label on the porch wall stands more than D + 2 out`, m.lblOut != null && m.lblOut > P.D + 2, f3(m.lblOut));
      ok(`${tag}: the porch roof sheet shares the main roof's material`, m.slabSharesRoofMat);
      if (c.metal) ok(`${tag}: ...and on a metal roof, its sky`, m.slab.hasEnv);
      ok(`${tag}: posts take ${c.d3.colors.wood ? "colors.wood" : "the natural fallback wood"} (${c.wood})`, m.posts.length > 0 && m.posts.every((q) => q.color === c.wood), [...new Set(m.posts.map((q) => q.color))].join(" "));
      ok(`${tag}: the porch wall receives the porch roof's shadow, and no other wall does`, m.recv.porchWall > 0 && m.recv.porchWallNo === 0 && m.recv.other === 0, JSON.stringify(m.recv));
      if (c.place) ok(`${tag}: ...and so does the door on it`, m.recv.porchOpen > 0 && m.recv.porchOpenNo === 0, JSON.stringify(m.recv));
      ok(`${tag}: look-inside hides the roof and the porch roof, and keeps the deck`, m.inside.roofVisible === false && m.inside.porchRoofVisible === false && m.inside.deckVisible === true, JSON.stringify(m.inside));
      if (c.place) {
        ok(`${tag}: the ramp on the porch wall starts at the deck's edge (D)`, m.ramps.length === 1 && Math.abs(m.ramps[0].near - P.D) <= 0.1, JSON.stringify(m.ramps));
        ok(`${tag}: the flood light hangs under the porch ceiling (head centre <= ceilWall - 0.45)`, m.floods.length === 1 && m.floods[0].headCtrY != null && m.floods[0].headCtrY <= P.ceilWall - 0.45 + 0.001,
          `head ${f3(m.floods[0] && m.floods[0].headCtrY)} cap ${f3(P.ceilWall - 0.45)}`);
        ok(`${tag}: ...and all of it below the ceiling`, m.floods.length === 1 && m.floods[0].topY < P.ceilWall, `top ${f3(m.floods[0] && m.floods[0].topY)} ceilWall ${f3(P.ceilWall)}`);
      }
      if (c.steps) {
        const st = m.steps[0], rp = m.ramps[0];
        ok(`${tag}: one step group, "${c.steps}"`, m.steps.length === 1 && st.where === c.steps, JSON.stringify(m.steps));
        const overlap = !!(st && rp && rp.across[0] < st.across[1] - 0.01 && rp.across[1] > st.across[0] + 0.01 && rp.near < st.out && rp.out > st.near);
        ok(`${tag}: the ramp ${c.stepsHidden ? "runs over" : "stands clear of"} the ${c.steps} steps`, !!rp && overlap === c.stepsHidden,
          `ramp across ${rp && rp.across.map(f3)} out ${rp && f3(rp.near)}..${rp && f3(rp.out)}, steps across ${st && st.across.map(f3)} out ${st && f3(st.near)}..${st && f3(st.out)}`);
        ok(`${tag}: ⚠️ STEPS AND A RAMP NEVER BOTH SHOW WHERE THEY OVERLAP`, !(overlap && st.visible), JSON.stringify({ overlap, visible: st && st.visible }));
        ok(`${tag}: the steps are ${c.stepsHidden ? "hidden, saying the ramp did it" : "drawn"}`,
          !!st && (c.stepsHidden ? st.visible === false && st.hiddenBy === "ramp" : st.visible === true && st.hiddenBy === null), JSON.stringify(st));
        ok(`${tag}: the ramp is tagged for the check`, !!rp && rp.tagged === true);
        if (c.stepsHidden) {
          // A LIVE DRAG rebuilds the interior alone (model.rebuildInterior), never the porch: the check
          // runs there too, so taking the ramp away brings the steps back, and putting it back hides them.
          const items = (await readItems(page)) || [];
          const shown = (list) => page.evaluate((list) => {
            const M = window.__ss3dEngine.model;
            M.rebuildInterior(list);
            let vis = null;
            M.root.traverse((q) => {
              if (!(q.userData && q.userData.ssPorchPart === "steps")) return;
              let n = q, v = true;
              while (n) { if (!n.visible) v = false; n = n.parent; }
              vis = v;
            });
            return vis;
          }, list);
          ok(`${tag}: a live rebuild without the ramp brings the steps back`, (await shown(items.filter((i) => i.type !== "ramp"))) === true);
          ok(`${tag}: ...and with it, hides them again`, (await shown(items)) === false);
        }
      }
      if (c.bandUnderEdge) ok(`${tag}: with a plate band the porch roof meets the wall at exactly H - 0.2`, Math.abs(P.yHigh - (c.H - 0.2)) < 1e-9, f3(P.yHigh));
      const porchEndBand = m.bands.filter((b) => b.porchEnd);
      seen[c.id] = { yHigh: P.yHigh, pitch: P.pitch, postH: P.postH, posts: P.posts, short: P.short, bandBot: porchEndBand.length === 1 ? porchEndBand[0].minY : null };
      if (c.sameAs) {
        const ref = seen[c.sameAs];
        ok(`${tag}: the lean-to's members are tagged userData.ssLeanTo`, m.leanTo.n >= 3, `tagged ${m.leanTo.n}`);
        ok(`${tag}: ...and its box reaches over the porch below the porch roof's top (what this case tests)`, m.leanTo.boxOver === true, `lowest point over the porch ${f3(m.leanTo.lowestOver)} slab top ${f3(m.slab.top)}`);
        ok(`${tag}: the porch builds exactly as without the lean-to (${c.sameAs}): high edge, pitch, post height, posts, short`,
          !!ref && Math.abs(P.yHigh - ref.yHigh) < 1e-9 && Math.abs(P.pitch - ref.pitch) < 1e-9 && Math.abs(P.postH - ref.postH) < 1e-9 && P.posts === ref.posts && P.short === ref.short,
          ref ? `yHigh ${f3(P.yHigh)}/${f3(ref.yHigh)} pitch ${f3(P.pitch)}/${f3(ref.pitch)} postH ${f3(P.postH)}/${f3(ref.postH)} posts ${P.posts}/${ref.posts} short ${P.short}/${ref.short}` : `${c.sameAs} did not measure`);
        ok(`${tag}: ...and the band on the porch's end comes down no further than without it`,
          !!ref && ref.bandBot != null && seen[c.id].bandBot != null && Math.abs(seen[c.id].bandBot - ref.bandBot) < 0.005,
          ref ? `bottom ${f3(seen[c.id].bandBot)} without ${f3(ref.bandBot)}` : `${c.sameAs} did not measure`);
      }
      const out = { south: [0, 1], north: [0, -1], east: [1, 0], west: [-1, 0] }[P.wall];
      const eye = [out[0] * (W / 2 + P.D + 14) + out[1] * 9, c.H + 3, out[1] * (L / 2 + P.D + 14) - out[0] * 9];
      await shot(page, `${shots}/${c.id}-porch.png`, eye, [out[0] * (W / 2 + P.D / 2), c.H * 0.45, out[1] * (L / 2 + P.D / 2)]);
    }
    if (c.bands != null) {
      ok(`${tag}: ${c.bands} plate band mesh(es), in roofGroup`, m.bands.length === c.bands && m.bands.every((b) => b.isMesh && b.inRoofGroup), `bands ${m.bands.length}`);
      // The top is always H + 0.1. The bottom is H - 0.2, except on a projecting porch's end, where
      // it comes down to the porch roof's high edge when the main roof pushed that edge lower.
      const bandBot = (b) => (b.porchEnd && P ? Math.min(c.H - 0.2, P.yHigh) : c.H - 0.2);
      ok(`${tag}: each band runs H - 0.2 (or the porch roof's high edge, on the porch's end) to H + 0.1`,
        m.bands.length > 0 && m.bands.every((b) => Math.abs(b.minY - bandBot(b)) < 0.005 && Math.abs(b.maxY - (c.H + 0.1)) < 0.005),
        m.bands.map((b) => `${b.porchEnd ? "porch end " : ""}${f3(b.minY)}..${f3(b.maxY)}`).join(" "));
      if (c.bandDrops) {
        const pb = m.bands.filter((b) => b.porchEnd);
        ok(`${tag}: the main roof really pushes the porch roof under H - 0.2 here`, !!P && P.yHigh < c.H - 0.3, P ? `yHigh ${f3(P.yHigh)}` : "no porch");
        ok(`${tag}: the band on the porch's end reaches down to the porch roof: no bare siding between them`, !!P && pb.length === 1 && pb[0].minY <= P.yHigh + 0.005,
          P ? `porch-end bands ${pb.length} bottom ${f3(pb[0] && pb[0].minY)} yHigh ${f3(P.yHigh)}` : "no porch");
      }
    } else ok(`${tag}: no plate band without roof.plateBand`, m.bands.length === 0, `bands ${m.bands.length}`);
    if (c.off && c.bands) await shot(page, `${shots}/${c.id}-band.png`, [W + 6, c.H + 4, -L / 2 - 12], [0, c.H * 0.6, -L / 2]);
    ok(`${tag}: no page errors`, errors.length === 0, JSON.stringify(errors).slice(0, 300));
  } catch (e) {
    ok(`${tag}: ran to the end`, false, e && e.message ? e.message.split("\n")[0] : String(e));
  } finally {
    await page.close();
  }
}

export async function main() {
  const { ok, failed } = reporter();
  const shots = shotsDir("porchProbe");
  const only = (process.env.SS_CASES || "").split(",").map((s) => s.trim()).filter(Boolean);
  // A case compared with another (sameAs) brings that one along, ahead of it in CASES.
  CASES.forEach((c) => { if (c.sameAs && only.includes(c.id) && !only.includes(c.sameAs)) only.push(c.sameAs); });
  const seen = {};
  const { browser, ctx } = await launch({ width: 1280, height: 900 });
  try {
    for (const c of CASES) {
      if (only.length && !only.includes(c.id)) continue;
      await runCase(ctx, c, ok, shots, seen);
    }
    for (const c of STEP_CASES) {
      if (only.length && !only.includes(c.id)) continue;
      await stepsRun(ctx, c, ok, shots);
    }
    for (const c of JOIN_CASES) {
      if (only.length && !only.includes(c.id)) continue;
      await joinRun(ctx, c, ok, shots);
    }
    for (const c of [JOIN_MISS, JOIN_EDGE]) if (!only.length || only.includes(c.id)) await joinMissRun(ctx, c, ok);
  } finally {
    await browser.close();
  }
  const bad = failed();
  console.log(bad.length ? `\n${bad.length} check(s) FAILED` : "\nall checks passed");
  console.log(`shots in ${shots}`);
  return bad.length;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then((n) => process.exit(n ? 1 : 0), (e) => { console.error(e); process.exit(2); });
}
