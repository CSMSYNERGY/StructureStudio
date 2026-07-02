# StructureStudio 3D View — Integration Plan

> **Status:** ✅ ALL PHASES IMPLEMENTED on branch `beta-2.0` (2026-07-02). Phases 1–4: parametric viewer + quote-PDF snapshot. Phase 5: items are stamped with `openingHeightFt`/`sillFt`/`elevationFt` at placement (3D honors them, D3 fallbacks for legacy designs), wall height is config-driven (`buildingStyles[].wallHeightFt` / top-level `wallHeightFt`, default 8 ft), and `016_wall_height.sql` adds `building_sizes.wall_height_ft` (**NOT YET APPLIED** — hand-apply via SQL Editor). Phase 6: all item classes drag in 3D (doors/windows/ROs along walls, workbenches wall-snapped, lofts free with edge snapping), new wall items place from a 3D palette, selection syncs to 2D, and a **paint swatch picker** recolors the building live and commits to `paintColors`/`sel.paint`. Ramps follow their door in BOTH views (shared `rampPlacementForDoor`), and deleting a door cascades to its ramp. Remaining niceties: portal editor for wall height, mobile tap-to-select refinement.  
> **Date:** 2026-07-02 (updated with external research)  
> **Constraint:** All 3D geometry generated parametrically from existing layout/catalog state. No SaaS, no Blender, no purchased model libraries. Three.js loaded as a CDN module is acceptable.  
> **Stack validated by:** Live DOM inspection of IdeaRoom (Three.js r145, WebGL2, React+MUI) and Sensei3D (Three.js, WebGL2, Draco glTF) — both category leaders run the same engine we're choosing.

## Implementation notes (beta-2.0) — deviations from plan

Verified live in-browser (junior-barns tenant, layout placed, 3D opened, pixels sampled, snapshot captured):

1. **Snapshot delivery = page 2 of the existing quote PDF, not a separate `-3d.jpg` upload.** The live storage policy (`005_cutover.sql:37-44`) only allows `{client_id}/SS-<code>.pdf` names — a jpg would be rejected, and changing the policy or the shared `submit-estimate` Edge Function risks production. `buildPdfFromJpegBytes` became `buildPdfFromJpegPages(pages[])` (multi-page, aspect-fit); the 3D snapshot rides in the same PDF that already flows into the GHL estimate attachment (`submit-estimate/index.ts:433-442`). **Zero backend changes; nothing to redeploy.**
2. **Panel-split openings, not CSG.** `three-bvh-csg` would add a second CDN module and runtime Boolean cost; the panel-split fallback (§4.4) is deterministic and testable. Overlapping openings (e.g. window over door — the 2D collision check only guards door-vs-door) are unioned before segmentation.
3. **`nativeImport()` Function indirection is mandatory.** Babel-standalone (`index.html`) rewrites a literal `import()` into an async `require()` wrapper that explodes at call time (`ReferenceError: require is not defined` — and it's async, so try/catch around the call can't catch it). A `new Function("u","return import(u)")(u)` indirection is invisible to Babel and to bundlers; the browser runs the real dynamic import. Never write a bare `import()` in the shared component body.
4. **Gap #5 (`parentDoorId`) was already closed** — ramps store `snapDoorId` + `widthFt` at placement (`handleClick` doorSnap branch). The 3D ramp uses the item's own stored width/wall/position.
5. **Snapshot staleness guard:** the captured 3D shot is cleared whenever `items`/style/size/paint/colors/dimensions change, so a stale angle can never misrepresent the submitted design. Closing the 3D view without explicitly capturing still contributes the last-viewed angle automatically.
6. **"Look inside" mode** (not in the original plan): hides the roof group and ghosts the wall material so lofts/workbenches read clearly; door/window frames and interior items stay solid.

---

## 1. What We're Building

A **"View in 3D" button** in the existing toolbar that opens a full-screen modal with a live, orbitable 3D model of the building the customer just designed. The scene is generated entirely from the state already present in `StructureStudioInner` — building footprint, placed items, style selection, paint colors. A **"Capture Snapshot"** button in the modal produces a JPEG that supplements the 2D floor plan in the GHL estimate.

---

## 2. Source-of-Truth State (what feeds the 3D renderer)

All of the following already live in `StructureStudioInner`'s render scope:

| Variable | Type | Where defined | What it gives 3D |
|---|---|---|---|
| `bldgW` | `number` (ft) | `StructureStudio.jsx:278` | Building width (X axis) |
| `bldgH` | `number` (ft) | `StructureStudio.jsx:279` | Building depth (Z axis) |
| `items` | `Item[]` | `StructureStudio.jsx:281` | All placed elements |
| `sel.style` | `string` | `StructureStudio.jsx:~248` | Roof type / siding lookup |
| `paintColors.body` | CSS color | `StructureStudio.jsx:275` | Wall surface color |
| `paintColors.trim` | CSS color | `StructureStudio.jsx:275` | Trim / fascia color |
| `sel.paint` | `string` | `StructureStudio.jsx:~248` | Whether paint applies |
| `scale` | `number` (px/ft) | `StructureStudio.jsx:474` | px→ft conversion factor |
| `mgX`, `mgY` | `number` (px) | `StructureStudio.jsx:480,485` | Building origin in page px |
| `pW`, `pH` | `number` (px) | `StructureStudio.jsx:479` | Building rect in px |

### Item state shape (existing)

From `StructureStudio.jsx:281` and the placement handlers:

```js
{
  id: number,
  type: "singleDoor" | "doubleDoor" | "window" | "roughOpening"
       | "workbench" | "loft" | "ramp" | "textNote" | "line",
  x: number,          // page px (centre for most items)
  y: number,          // page px (centre for most items)
  x1?: number, y1?: number, x2?: number, y2?: number,  // line endpoints
  widthFt?: number,   // width in feet (doors, windows, workbench, loft)
  heightFt?: number,  // height in feet (loft ONLY — not doors/windows)
  widthPx?: number,   // notes only
  heightPx?: number,  // notes only
  rotation: 0 | 90 | 270,
  wall: "north" | "south" | "east" | "west" | null,
  text?: string
}
```

---

## 3. Coordinate Conversion: 2D Page px → 3D World (feet)

The 2D canvas uses page pixel coordinates with the building's top-left corner at `(mgX, mgY)`. Three.js will use **real feet** as world units, with the building footprint centred at the world origin, Y-axis pointing up.

```
Page px → building-local feet:
  localX_ft = (item.x - mgX) / scale      // 0 at west wall, bldgW at east wall
  localZ_ft = (item.y - mgY) / scale      // 0 at north wall, bldgH at south wall

Three.js world (building centred at origin):
  world_x = localX_ft - bldgW / 2
  world_z = localZ_ft - bldgH / 2
  world_y = 0                             // floor grade

Wall positions in world coords:
  North wall:  z = -bldgH / 2
  South wall:  z = +bldgH / 2
  West wall:   x = -bldgW / 2
  East wall:   x = +bldgW / 2
```

This conversion is deterministic from existing state — no new storage required. It will live in a pure helper function `pageToWorld(item, scale, mgX, mgY, bldgW, bldgH)`.

---

## 4. Catalog Elements → 3D Geometry

### 4.1 Building Shell — Walls

Four `PlaneGeometry` meshes (one per wall), each `bldgW × wallHeightFt` or `bldgH × wallHeightFt`, with `side: THREE.DoubleSide` so interior is visible. Positioned at the four wall centres, facing inward/outward.

Material: `MeshLambertMaterial({ color: paintColors.body || '#D4C5A9' })` — falls back to a neutral wood-tone if no paint chosen. Trim edge applied as a separate thin `BoxGeometry` cap along each wall top.

Wall openings for doors/windows: see §4.4.

### 4.2 Roof — Parametric by Style

The `building_styles` table (`migration 006:26-37`) stores only `key`, `label`, `image_url` — **no roof metadata**. Roof geometry is therefore hard-coded in the 3D component keyed by `sel.style.toLowerCase()`:

```js
const ROOF_CONFIGS = {
  econo:     { type: 'shed',    pitchRise: 0.25 },  // 3:12 pitch (single slope)
  urban:     { type: 'gable',   pitchRise: 0.33 },  // 4:12 gable along length
  northwood: { type: 'gable',   pitchRise: 0.50 },  // 6:12 steeper gable
  farmland:  { type: 'gambrel', pitchRise: 0.40,    // barn-style gambrel
               gambrelBreakRatio: 0.45 },
};
```

All roof types are built from `BufferGeometry` with manually specified vertices (triangles). No imported models.

- **Shed roof:** Two triangles forming a ramp from eave height on one side to ridge height on the other. Ridge height = `bldgW * pitchRise` for a side-slope.
- **Gable roof:** Four triangles — two slope panels + two triangular gable ends. Ridge runs along the depth axis (Z). Ridge height = `(bldgW / 2) * pitchRise`.
- **Gambrel:** Six triangles per side — lower steep slope then upper shallow slope, meeting at the knee point.

Roof material: `MeshLambertMaterial({ color: paintColors.trim || '#4A4A4A' })` (trim colour used for roofing).

### 4.3 Loft Platforms

Lofts are stored as free-floating items with `widthFt`, `heightFt`, and page-pixel centre `(x, y)`. 3D geometry:

- **Platform:** `BoxGeometry(widthFt, 0.5, heightFt)` — a half-foot-thick slab.
- **Elevation:** Loft floor sits at `LOFT_ELEVATION_FT = 7.0` (hardcoded default — **gap, see §6**).
- **Position:** Centre of the platform at world `(world_x, 7.25, world_z)` (7ft floor + 0.25 slab half-thickness).
- **Support posts:** 4× `CylinderGeometry(0.1, 0.1, 7, 8)` at the loft's four corners, from floor to loft underside.
- **Guard rail:** `EdgesGeometry` box outline at loft perimeter.

Material: `MeshLambertMaterial({ color: '#C4A882' })` (natural wood tone).

### 4.4 Doors and Windows (Wall-Mounted Items)

Wall-only items (`wallOnly: true`) are stored with `wall`, `widthFt`, and page-pixel `(x, y)`. Position along the wall:

```js
// For north/south walls (horizontal): position along = item.x
// For east/west walls (vertical): position along = item.y

function wallItemCentre(item, scale, mgX, mgY, bldgW, bldgH) {
  if (item.wall === 'north' || item.wall === 'south') {
    return { along: (item.x - mgX) / scale };  // feet from west wall
  } else {
    return { along: (item.y - mgY) / scale };  // feet from north wall
  }
}
```

**Opening strategy:** Research confirms the preferred 2025–2026 approach is **Constructive Solid Geometry (CSG)** — Boolean-subtracting a box-shaped hole from the wall mesh. The library is **`three-bvh-csg`** (MIT-licensed, available at `https://esm.sh/three-bvh-csg`), which is actively maintained and handles the BVH acceleration needed for real-time cuts. Each door or window is modelled as a `BoxGeometry` subtractor placed at the item's world position; the result is a clean, watertight wall mesh with a real opening.

The fallback (used if CSG proves too slow on mobile) is the **panel-split approach**: wall geometry is built as 3–5 `PlaneGeometry` panels that surround the opening (left strip, right strip, header strip above windows). Simpler to compute, no mesh operation overhead, but produces flat-shaded visual joins at the cut edges. Either approach is valid for Phase 3; choose at implementation time based on mobile perf benchmarks.

**Door geometry:**
- Frame: 4 thin `BoxGeometry` strips (two jambs + header + sill).
- Panel fill: `PlaneGeometry(widthFt, doorHeightFt)` with a contrasting material.
- Heights: single door = 7ft, double door = 7ft (**gap — not stored, see §6**).
- Sill elevation = 0ft (floor level).

**Window geometry:**
- Frame: same strip approach.
- Glass fill: `PlaneGeometry` with `MeshLambertMaterial({ color: '#A8D8EA', transparent: true, opacity: 0.5 })`.
- Sill elevation = 3ft, window height = 3ft (**both gaps — not stored, see §6**).

**Rough opening:** Same as a door frame without a panel fill.

### 4.5 Workbench

`wallSnap: true` items have `wall`, `widthFt`, and centre `(x, y)` in page px. Interior depth and height are not in state.

3D geometry: `BoxGeometry(widthFt, WORKBENCH_HEIGHT_FT, WORKBENCH_DEPTH_FT)` with:
- `WORKBENCH_HEIGHT_FT = 3.0`
- `WORKBENCH_DEPTH_FT = 2.0`
- Positioned flush against the interior wall face.

Material: `MeshLambertMaterial({ color: '#8B7355' })`.

### 4.6 Ramp

`doorSnap: true` items have `wall` and page-pixel position (centred on the door). The ramp has no explicit `widthFt` in state — its width should match the parent door's `widthFt`.

Ramp linkage: the ramp currently stores `wall` but **not** a `parentDoorId` (**gap — see §6**). The 3D renderer will find the nearest door on the same wall as a proxy.

Geometry: `BoxGeometry(doorWidthFt, 0.1, RAMP_DEPTH_FT)` rotated so the far end rests on grade. Or build as a sloped `BufferGeometry` with 6 vertices (a wedge).
- `RAMP_DEPTH_FT = 4.0`
- Near edge at grade (y=0.0), far edge at sill (y~0.0, since floor is grade level — ramp provides a gentle step).

Material: `MeshLambertMaterial({ color: '#888888' })`.

### 4.7 Annotations (textNote, line)

Annotations have no meaningful 3D representation — they will be **silently skipped** in the 3D view.

---

## 5. Where the 3D Button and Scene Mount

### 5.1 Button placement

The existing toolbar area sits below the main SVG canvas (search for the export/submit row in the JSX, around line ~2600+). A "View in 3D" button is added alongside the existing download/submit buttons:

```jsx
<button onClick={() => setShow3D(true)}>
  View in 3D
</button>
```

State addition to `StructureStudioInner`:
```js
const [show3D, setShow3D] = useState(false);
```

Enabling the button requires at minimum a style and size selection (same guard as the submit button).

### 5.2 3D Scene modal

The 3D modal renders as a `position: fixed; inset: 0` overlay (z-index above the main app), containing:

- A `<canvas ref={threeCanvasRef}>` that Three.js renders into, filling the available area.
- A close button (top-right).
- A "Capture Snapshot" button (bottom-centre) that saves a JPEG from the renderer.
- Orbit controls: click-drag to rotate, scroll to zoom, right-click/two-finger to pan.

The Three.js scene is set up inside a `useEffect` that fires when `show3D` becomes `true`. Cleanup tears down the renderer and animation loop when the modal closes.

### 5.3 Three.js vs react-three-fiber — and why we use plain Three.js here

Research confirms **react-three-fiber (R3F)** is the ecosystem default for new React+3D work — it is MIT-licensed, React 18-native, and the internal engine is the same Three.js r18x. R3F's `<Canvas>`, `<mesh>`, and the `@react-three/drei` toolkit would be ideal in a build-system project.

**For StructureStudio the constraint is the no-build CDN architecture.** R3F is a React *renderer* — it needs to be registered before any JSX it controls is compiled. Making that work inside a Babel-standalone `<script type="text/babel">` block via dynamic `import()` is fragile: Babel-standalone transforms JSX at parse time, before the async import resolves. The same code must work identically in both `StructureStudio.jsx` (ES module, used by host bundlers) and `index.html` (Babel-standalone, served directly).

**Decision: plain Three.js + OrbitControls loaded via dynamic `import()`.** The scene is wired imperatively inside a `useEffect` — the same pattern the existing `renderExportCanvas()` canvas drawing already uses. No JSX in the Three.js layer; React manages only the modal wrapper and the capture button.

```js
useEffect(() => {
  if (!show3D) return;
  let cancelled = false;
  (async () => {
    const THREE = await import('https://esm.sh/three@0.167.0');
    const { OrbitControls } = await import(
      'https://esm.sh/three@0.167.0/examples/jsm/controls/OrbitControls.js'
    );
    if (cancelled) return;
    // build scene imperatively …
  })();
  return () => { cancelled = true; /* dispose renderer, cancel animation frame */ };
}, [show3D]);
```

This is browser-native (dynamic `import()` is not transformed by Babel-standalone), requires no `<script>` additions to `index.html`, and loads nothing until the modal opens. If StructureStudio ever moves to a proper build step, migrating to R3F is straightforward — the Three.js scene logic maps 1-to-1 to R3F mesh components.

---

## 6. Data Model Gaps — What's Missing for Clean 3D Generation

These are fields or metadata not currently stored that the 3D renderer needs to assume or that should be added:

| # | Missing Field | Location of Gap | Impact | Recommended Fix |
|---|---|---|---|---|
| 1 | **`wallHeightFt`** | `building_sizes` table (`migration 006:39-51`) has only `width_ft` and `depth_ft` — no wall height. | 3D wall height unknown. | Add `wall_height_ft numeric default 8` column to `building_sizes`; default all existing rows to 8ft. Short-term: hard-code 8ft. |
| 2 | **`heightFt` for wall-only items** | Item state (`jsx:281`) stores `widthFt` for doors/windows but NOT `heightFt`. A single door is 3ft wide; its 7ft height is implicit and nowhere recorded. | Door/window openings have no height in 3D. | Add `heightFt` to item state for `wallOnly` items; default on placement: door=7, window=3. Persist in `items` JSONB via `save_design`. |
| 3 | **`elevationFt` (sill height) for windows** | Not in item state at all. Windows always start at "some height" off the floor. | Window position on wall unknown in 3D. | Add `elevationFt` to item state for windows (default 3ft). Or hard-code 3ft sill height. |
| 4 | **`elevationFt` (floor height) for lofts** | Loft items store footprint (`widthFt × heightFt`) but not how high the platform sits. | Loft floats at an unknown elevation. | Add `elevationFt` to loft item state (default 7ft). Or hard-code 7ft. |
| 5 | **`parentDoorId` for ramps** | Ramp stores `wall` and position but no explicit link to the door it was dropped on. | 3D ramp cannot reliably size itself to match the parent door. | Add `parentDoorId: number` to ramp item state at placement time. The existing `doorSnap` placement handler already knows which door it is attaching to. |
| 6 | **Roof geometry per style** | `building_styles` table (`migration 006:26-37`) has only `key`, `label`, `image_url` — no `roof_type`, `pitch_ratio`, `eave_height_ft`. | Roof shape must be guessed from style name. | Hard-code `ROOF_CONFIGS` map keyed by style `key` (see §4.2). Longer term, add columns to `building_styles`. |
| 7 | **Siding / material type per style** | No metadata anywhere. | 3D material is a flat colour only. | Hard-code per-style defaults. Can enrich later via `building_styles` columns. |
| 8 | **`paintColors` when paint = "No Paint"** | `paintColors.body` and `.trim` are empty strings when `sel.paint !== 'Painted'`. | 3D walls would be invisible/black. | Fall back to a per-style natural-wood default colour in the 3D renderer when paint is not chosen. |

**Priority for Phase 1:** Gaps 1, 2, 5 are the most important for a correct 3D model. Gaps 3, 4 are easy to fix with defaults. Gaps 6-8 are cosmetic and handled by hard-coded constants.

---

## 7. Snapshot → GHL Estimate

### Current flow (reference)

`submitQuote()` (`StructureStudio.jsx:~1294`):
1. `renderExportCanvas()` → JPEG bytes (line ~1014)
2. `buildPdfFromJpegBytes()` → PDF (line ~1507)
3. Upload to `floor-plans/{clientId}/{shortCode}.pdf` (Storage)
4. `save_design` RPC (line ~1355)
5. `submit-estimate` Edge Function with `imageUrl` (PDF Storage URL) in payload (line ~1459)

### 3D snapshot capture

The Three.js renderer must be created with `{ preserveDrawingBuffer: true }` so the WebGL buffer isn't cleared between frames:

```js
const renderer = new THREE.WebGLRenderer({ canvas: canvasEl, antialias: true, preserveDrawingBuffer: true });
```

Capture is then: `renderer.domElement.toDataURL('image/jpeg', 0.92)`.

For higher-resolution output independent of the customer's screen (e.g. for print): render into an offscreen `WebGLRenderTarget` at a fixed resolution (e.g. 2400×1600), read back with `renderer.readRenderTargetPixels()`, blit to a 2D canvas, and export from there. This produces a deterministic, device-independent JPEG.

### Snapshot additions to the submit flow

1. **Capture trigger:** "Capture Snapshot" button in the 3D modal stores the base64 JPEG in `render3DSnapshotRef = useRef(null)`.

2. **Upload at submit time:** Inside `submitQuote()`, after the existing PDF upload, if `render3DSnapshotRef.current` is set:
   - Decode base64 → `Blob`
   - Upload to `floor-plans/{clientId}/{shortCode}-3d.jpg` (same Supabase Storage bucket, `{clientId}/` prefix)
   - Store public URL as `render3dImageUrl`

3. **Payload addition:** Add `render3dImageUrl` to the `submit-estimate` Edge Function payload (line ~1380). The Edge Function (`supabase/functions/submit-estimate/index.ts`) has two options for surfacing it in GHL:
   - **Embed in estimate email body** — add an `<img>` tag to the HTML email template alongside the 2D floor plan.
   - **GHL Conversations API attachment** — after estimate creation, POST to the GHL Conversations "Send a new message" endpoint with `attachments: [{ url: render3dImageUrl }]`. This delivers it as a separate message on the contact record.

4. **The 2D PDF remains the primary image** (`imageUrl`) — it is the legally clear floor plan for the estimate. The 3D render is a supplementary persuasion visual. Both live in the same Supabase Storage bucket under the tenant prefix.

---

## 8. Performance Patterns (build these in from day one)

These are drawn from the R3F performance docs and apply equally to imperative Three.js:

| Pattern | How |
|---|---|
| **Render on demand** | Set `renderer.setAnimationLoop(null)` after initial render; call `renderer.render(scene, camera)` only when state changes. Skip the animation loop entirely for a static configurator. |
| **Dispose on close** | In the `useEffect` cleanup: `renderer.dispose()`, `geometry.dispose()`, `material.dispose()` for every object added to the scene. Three.js does NOT GC WebGL resources automatically. |
| **Toggle `visible`, don't remount** | Option variants (e.g. door styles, roof pitch extremes) should be pre-built and toggled `mesh.visible = false/true` rather than added/removed — material compilation on first render is expensive. |
| **Instance repeated geometry** | Siding boards, trusses, studs: use `THREE.InstancedMesh` rather than one mesh per element. Keeps draw calls in the low hundreds on a complex building. |
| **1–2K textures, Draco models** | Any future GLB door/window props: compress textures to 1024×1024 and use Draco geometry compression. Target total GLB payload under 2MB for mobile. |
| **`preserveDrawingBuffer: true` only when needed** | This flag prevents WebGL from clearing between frames, which costs memory. Enable it when a snapshot is pending; disable (by recreating the renderer) afterward, or accept the small overhead for the lifetime of the modal. |
| **Mobile first-render budget** | Target <3s to first frame on a mid-range phone (~iPhone 12 / Pixel 6 class). A parametric building with no textures achieves this easily; adding Draco glTF props may require lazy-loading per-wall-type. |

---

## 9. Implementation Phases

### Phase 1 — Coordinate foundation + building shell (~2–3 weeks)
- Add `show3D` state + "View in 3D" button in toolbar
- Lazy-load Three.js + OrbitControls via dynamic `import()` in `useEffect`
- Build 3D modal shell with `<canvas>` ref, ambient + directional lights, renderer resize handling
- Implement `pageToWorld()` pure function; log positions to validate alignment
- Render building walls (4 `PlaneGeometry` panels, no openings yet) + floor plane
- Apply `paintColors.body` (or per-style fallback) to walls; `paintColors.trim` to fascia
- Wire in performance patterns from §8 from the start (on-demand render, dispose on close)

### Phase 2 — Roof (~1 week)
- Implement `buildRoofGeometry(style, bldgW, bldgH, wallHeight)` with `ROOF_CONFIGS`
- Test all 4 style keys visually (econo shed, urban gable, northwood steep gable, farmland gambrel)
- Apply `paintColors.trim` (or fallback) to roof surface

### Phase 3 — Placed items (~2–3 weeks)
- Doors/windows: CSG openings via `three-bvh-csg` + frame strips + fill panel (panel-split fallback for mobile)
- Lofts: platform slab + 4 support posts + guard-rail edge outline
- Workbench: interior slab flush against wall face
- Ramp: sloped wedge `BufferGeometry` outside wall centred on door
- Rough openings: frame only, no fill

### Phase 4 — Snapshot + GHL wiring (~1 week)
- `preserveDrawingBuffer: true` on renderer init; "Capture Snapshot" → `render3DSnapshotRef`
- Upload at submit time to `floor-plans/{clientId}/{shortCode}-3d.jpg`
- Edge Function: embed 3D render in estimate email; optionally deliver via GHL Conversations attachment API

### Phase 5 — Data model augmentation (clean up hardcoded defaults)
- Add `wallHeightFt` to `building_sizes` (new SQL migration, default 8)
- Add `heightFt`, `elevationFt`, `parentDoorId` to item state and `save_design` RPC payload
- Expose `elevationFt` via a resize handle in the 2D loft editor (optional UX)

### Phase 6 — Editing in 3D (IdeaRoom parity, ~3–5 weeks) — see §10 for full detail
- Raycast picking on wall + item meshes (`THREE.Raycaster`)
- `worldToPage()` inverse mapping so 3D gestures write back to the same `items` state
- Place doors/windows by clicking a wall in 3D; drag items along walls in 3D
- Reuse — never reimplement — the 2D validators (`checkDoorCollision`, `checkLoftAttached`, snap functions)
- Shared selection state between views; incremental scene updates instead of full rebuild
- **Prerequisite:** Phase 5 first (esp. `parentDoorId` and `heightFt`/`elevationFt`)

**Rough effort estimates** (industry ranges, not a quote for this exact scope):
- Phase 1–2 (viewer shell): ~$8k–$20k / 2–4 weeks developer time
- Phase 1–4 (full configurator + snapshot): ~$25k–$50k / 6–10 weeks
- Phase 5 (data model cleanup): ~$5k–$10k additional
- Phase 6 (3D editing, IdeaRoom parity): ~$15k–$30k / 3–5 weeks additional
- Ongoing maintenance: ~10–15% of build cost per year; hosting adds zero marginal cost (static CDN, same as today)

---

## 10. Phase 6 Detail — Editing in 3D (IdeaRoom Parity)

> **Status:** SHIPPED on `beta-2.0` (2026-07-02). §10.5: ALL item classes drag in 3D — doors/windows/ROs along walls (horizontal-plane pick → `snapToWall`, wall switching included), workbenches via `snapToWallInterior` + door/bench collision, lofts via the 2D free-drag rules (integer-foot rounding, wall/loft edge snapping, overlap reject). §10.4: new wall items place from the 3D footer palette — wall-mesh raycast → page coords → the same `snapToWall` pipeline + Phase 5 stamps. Selection syncs to 2D via `onItemSelect` → `setSelectedId`. Every gesture routes through the literal 2D module functions; no 3D-only placement logic exists. Plus (beyond the original plan): a paint swatch picker (`D3_SWATCHES`) that recolors materials in place and commits labels to `paintColors` + flips `sel.paint`. Ramp-follow: a door's ramp is now DERIVED state — `rampPlacementForDoor()` (module fn) recomputes it during the 2D drag, the 3D drag (live + commit), and at placement; deleting a door cascade-deletes its ramp. Verified live: dragging a north-wall door around the corner in 3D landed door AND ramp on the west wall, rotations flipped, both committed to 2D. Remaining: §10.7 tap-to-select mobile refinement.

### 10.1 The architecture win: 3D editing is an input adapter, not a rewrite

Every 2D placement gesture already flows through one pipeline: `getSvgPt` converts the pointer event to page coordinates (`StructureStudio.jsx:507`), `getWallFromClick`/`getNearestWall` pick the wall (`jsx:44-89`), `snapToWall`/`snapToWallInterior` compute the snapped position (`jsx:56-75`), `checkDoorCollision`/`checkLoftAttached` validate (`jsx:91-130`), and the result lands in `setItems`.

The 3D editing layer replaces **only the first step**. A raycast hit on a 3D wall mesh, converted back to page coordinates, enters the *identical* snap → validate → `setItems` pipeline. Nothing downstream changes; both views stay in sync automatically because they render from the same state. This is the invariant to protect (per CLAUDE.md's placement-invariants rule): **3D gestures must route through the same validators as 2D gestures** — a parallel 3D-only placement path would eventually let customers build layouts the estimating logic assumes are impossible.

### 10.2 Raycast picking

- `THREE.Raycaster` cast from the camera through the pointer's NDC coordinates on every click/hover.
- Every scene mesh gets tagged at build time:
  - Wall meshes: `mesh.userData = { kind: 'wall', wall: 'north'|'south'|'east'|'west' }`
  - Item meshes: `mesh.userData = { kind: 'item', itemId: item.id }`
  - Floor mesh: `{ kind: 'floor' }` (loft placement target)
- Hover feedback: emissive tint on the hovered wall/item so the customer sees what a click will do.

### 10.3 `worldToPage()` — the inverse mapping

Exact inverse of `pageToWorld()` (§3), kept as its sibling pure function:

```
page_x = (world_x + bldgW / 2) * scale + mgX
page_y = (world_z + bldgH / 2) * scale + mgY
```

Both functions live together and are trivially unit-testable (`worldToPage(pageToWorld(p)) === p`).

### 10.4 Placing items in 3D

- An item palette strip inside the 3D modal, driven by the same `C.layoutItems` config as the 2D palette (`activeTool` state can be shared).
- Click a wall mesh → raycast intersection point → `worldToPage()` → the existing `snapToWall` + `checkDoorCollision` path → `setItems`.
- Invalid placements give the same feedback as 2D (toast/rejection) — same validator, same message.

### 10.5 Selecting and dragging in 3D

- Click an item mesh → `setSelectedId(item.id)` (`jsx:282`) — the *same* selection state the 2D view uses, so selecting in one view highlights in both.
- Drag: on pointermove, raycast against the item's constraint surface — the wall plane for `wallOnly`/`wallSnap` items, the floor plane for lofts — convert to page coords, run the same snap/collision, update `item.x/y`.
- **OrbitControls conflict:** set `controls.enabled = false` on item pointerdown, re-enable on pointerup. Drag on empty space orbits; drag on an item moves it.
- Ramps follow their door automatically once `parentDoorId` exists (Phase 5 prerequisite).

### 10.6 Incremental scene updates

Phases 1–5 can rebuild the whole scene on modal open. Live editing needs finer grain:

- Keep a `Map<itemId, THREE.Object3D>`; diff `items` in an effect and add/remove/reposition only what changed.
- CSG wall openings are the expensive operation — during a drag, move a cheap proxy mesh and recut the affected wall only on gesture end (debounced).
- Color/style changes stay cheap: `material.color.set(...)` + one on-demand render.

### 10.7 Touch/mobile interaction model

One-finger orbit vs. one-finger item-drag is the classic conflict. Recommended model: tap to select, then drag moves the selected item; drag anywhere else orbits. Prototype this early — it is the highest-UX-risk piece of Phase 6.

### 10.8 What stays out of scope even in Phase 6

- `textNote` and `line` annotations remain 2D-only tools (§4.7); the 2D sheet remains the canonical print/PDF artifact.
- No freeform geometry sculpting — the model stays parametric. Customers edit positions, sizes, styles, and colors; the building regenerates. (Same constraint IdeaRoom operates under — it's what keeps every design quotable and buildable.)

---

## 11. File and Line Reference Index

> Sources confirmed by direct code reads during plan preparation (2026-07-02).

| Topic | File | Lines |
|---|---|---|
| `bldgW`, `bldgH`, `items`, `paintColors` state | `StructureStudio.jsx` | 274–281 |
| `scale`, `mgX`, `mgY`, `pW`, `pH` geometry | `StructureStudio.jsx` | 460–486 |
| Wall snap / door collision helpers | `StructureStudio.jsx` | 44–108 |
| 2D interaction handlers (`getSvgPt`, click/drag pipeline) | `StructureStudio.jsx` | 506+ |
| `selectedId` selection state (shared with 3D in Phase 6) | `StructureStudio.jsx` | 282 |
| `checkLoftAttached` | `StructureStudio.jsx` | 116–130 |
| `renderExportCanvas()` (canvas drawing reference) | `StructureStudio.jsx` | 1014–1241 |
| Loft SVG render (shows widthFt/heightFt usage) | `StructureStudio.jsx` | 1992–2023 |
| Wall-item SVG render (door/window bars + arcs) | `StructureStudio.jsx` | 2024–2047 |
| Submit payload shape | `StructureStudio.jsx` | 1380–1449 |
| `submit-estimate` Edge Function | `supabase/functions/submit-estimate/index.ts` | 1–579 |
| `building_sizes` table schema (no `wall_height_ft`) | `supabase/migrations/006_catalog_pricing.sql` | 39–51 |
| `building_styles` table schema (no roof metadata) | `supabase/migrations/006_catalog_pricing.sql` | 26–37 |
| Style / size seed data | `supabase/migrations/007_seed_junior_barns.sql` | 12–61 |
| `save_design` RPC (items persisted as JSONB) | `supabase/migrations/002_design_rpcs.sql` | — |
| Multi-tenant architecture + mirror rule | `CLAUDE.md` | — |

---

## 12. Mirror Rule Reminder

Per `CLAUDE.md`: **`StructureStudio.jsx` and `index.html` must stay in sync.** Every change to the JSX (new state variables, new component, new button, new `useEffect`) must be mirrored verbatim in `index.html`, with the two structural differences noted in CLAUDE.md (UMD destructure instead of `import`, plain `function` instead of `export default function`). The dynamic `import()` approach for Three.js is intentionally chosen because it works identically in both files without any extra `<script>` tags.
