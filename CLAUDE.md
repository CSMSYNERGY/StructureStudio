# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project shape

StructureStudio is a single-file React component (a floor-plan designer + quote builder for custom sheds/barns) delivered as two parallel artifacts:

- `StructureStudio.jsx` — ES-module React source (`import { useState, ... } from "react"`; default export `StructureStudio`). Consumed by hosts that have their own build.
- `index.html` — self-contained, zero-build drop-in: loads React 18 UMD + ReactDOM + **Babel-standalone** from CDN and inlines the whole component in `<script type="text/babel">`. Opens directly in a browser; no bundler, no package.json, no tests, no lint config. This is also the file Netlify serves at the site root.

**Both files contain the same component body.** The only structural differences:
1. HTML top: `const {useState,useRef,useCallback,useEffect}=React;` instead of `import ... from "react";`
2. HTML bottom: `ReactDOM.createRoot(...).render(<StructureStudio/>)` + a `window.addEventListener("message", ...)` re-render hook.

Any non-trivial edit must be mirrored in both files or the HTML deliverable will drift from the JSX source. There is no generator — they are hand-maintained siblings.

There is no build/run/test command. To sanity-check a change, open `index.html` in a browser.

## Runtime configuration model

The component is white-labeled per client. `DEFAULT_CONFIG` (Junior Barns) is baked into the top of the file, but callers override it three ways:

1. React prop: `<StructureStudio config={clientConfig} />`
2. `postMessage` from a parent frame: `{ type: "structureConfig", config: {...} }` — the HTML file's bottom listener re-renders the root when this arrives. A separate listener inside the component also accepts `{ type: "structureConfig", <flat fields> }` to prefill selections and contact info without a full re-render.
3. Direct edit of `DEFAULT_CONFIG`.

Config shape (see `DEFAULT_CONFIG` for the canonical example): `clientId`, `webhookUrl`, `branding`, `contactFields[]`, `buildingStyles[]` (each with its own `sizes[]`), `defaultSizes[]`, `options[]` (dynamic option renderers — currently `counter` and `image_cards` types), and `layoutItems{}` (the palette of placeable items). Changing client behavior normally means editing config, not code.

Each entry in `options[]` may optionally declare `buildingStyles: ["Urban", "Northwood"]` to limit when it appears. Without that field the option always shows (the default). Visibility is computed by `isOptionApplicable(opt, sel.style)`; on style change, values of options that just became inapplicable are reset to their default so they don't leak into the submit payload.

## Architectural concepts

**Coordinate system.** The floor plan is stored in feet (`bldgW`, `bldgH`, `widthFt`, `heightFt`, and item positions converted from px). All on-screen geometry is `feet * scale + mg`, where `scale` is recomputed from `bldgW/bldgH` on every render and `mg` is a fixed margin. When adding geometry, work in feet and convert at the edges.

**Item taxonomy via flags on `C.layoutItems`.** Placement rules are driven by per-type flags, not class hierarchies:
- `wallOnly: true` — doors, windows, rough openings. Must click a wall; rendered as a bar on the wall line.
- `wallSnap: true` — workbench. Snaps to the nearest wall's interior; can be resized along the wall (1D).
- `doorSnap: true` — ramp. Attaches to an existing door (outside the building); cannot be dragged; only one per door.
- Neither — loft. Free-floating with 4-sided resize; must pass `checkLoftAttached` (both ends of at least one axis touching a wall or another loft).

Adding a new item type usually means adding an entry to `layoutItems` + any new flag branch in `handleClick`, `onPtrMove` (drag), `startResize` logic, `generatePNG`, and the submit payload rollup.

**Logical walls vs. display labels.** Walls are stored as `north|south|east|west` (positional). `getFrontWall(items)` picks the FRONT from door placement (double door wins over single), and `getDisplayLabel(positionalWall, frontWall)` maps each positional wall to `FRONT/BACK/LEFT/RIGHT` for user-facing labels and for the submit payload's wall fields. Internal collision/snap math uses positional walls; anything shown to the user or sent to the webhook uses display labels.

**Collision / placement invariants.** These are enforced by `checkDoorCollision`, workbench-on-wall overlap checks in `handleClick`/`onPtrMove`, loft-vs-loft overlap checks, and `checkLoftAttached`. Breaking any of these will let users build layouts the backend and downstream estimating logic assumes are impossible.

**Two rendering paths that must stay in sync.** Live UI renders via SVG inside the component's JSX. Export and submit both call `generatePNG()`, which draws the same scene on a `<canvas>` using 2× DPR for the exported image. When adjusting visuals (colors, labels, door swing arcs, loft hatching, etc.), update both the SVG JSX and the canvas drawing inside `generatePNG` — otherwise the PDF/email the customer receives won't match what they designed.

## Submit flow

`submitQuote()` POSTs JSON to `config.webhookUrl` (a CSM Synergy n8n workflow by default). Payload shape is consumed downstream, so treat it as a contract:

- `designId` — short code (e.g. `SS-NR4DV8`) that keys the design in Supabase
- `imageUrl` — public Storage URL of the rendered PNG; n8n fetches the image bytes from here when needed
- `viewUrl` — `?id=...` URL on the deployed host (sales reps click this to reopen/edit)
- `contact`, `selections` (`buildingStyle`, `buildingSize`, `paint`, optional paint colors)
- `floorPlanItems[]` — raw list; each has `type`, `wall` (already mapped to front/back/left/right lowercase), and `lengthFt` for workbenches
- `itemSummary` — rolled-up counts + workbench lengths
- `customOptions[]` (only rows with a non-empty name are included)
- `roughOpenings[]` — one entry per RO with its dimensions string

If you rename or restructure these fields, the n8n workflow that turns them into estimates/emails breaks silently.
