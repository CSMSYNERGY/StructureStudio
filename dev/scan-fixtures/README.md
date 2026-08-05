# Scan-pipeline fixtures and harnesses

Developer tooling for the building-scan measurement code in
`structure-studio.component.js` (`scanInspectGlb` / `scanSamplePoints` /
`scanMeasure` / `scanToFeet`). Nothing here ships to a customer — no page loads
this directory, and the `.glb` files are gitignored because the generator
recreates them byte-for-byte.

## Why this exists

The measurement code turns a phone scan into a width/depth/eave/peak/pitch. It
is easy to write something that looks plausible and is wrong, and two failure
modes bit during development:

1. **The ground inflates the footprint.** A yard capture includes the ground, so
   the bounding box is the ground's, not the building's. Fixture B exists
   specifically to catch a regression here.
2. **Pitch read off a height threshold is wrong.** With zero roof overhang the
   roof's horizontal span stays near-full just above the eave, so "the height
   where the span has shrunk to X%" sits high by roughly `(1-X)·rise`. Two
   threshold-based attempts produced 0.583 and 0.56 for a true 0.625. The
   shipped version regresses across-span against height and takes
   `pitch = -2/slope`, which is exact on all three fixtures.

Anything that touches those functions should be re-run against these fixtures.

## The fixtures

`make_scan_fixture.py` writes spec-valid binary glTF 2.0 with the standard
library only (no trimesh, no blender). A 12 × 8 ft shed, 6.5 ft eave, 9 ft peak,
gable ridge along X, zero overhang so the bounding box *is* the footprint —
declared in feet, emitted in metres, Y-up, sitting on y=0.

| file | what it adds |
| --- | --- |
| `shed_12x8_gable.glb` | the building alone — the easy case |
| `shed_12x8_gable_ground.glb` | a 30 ft ground plane fused into the same primitive, so the bbox (30 × 30) is much larger than the building |
| `shed_12x8_gable_offset_rot.glb` | the shed under a node translation (5, 0, −3) m and a 30° Y rotation, so accessor `min`/`max` alone give the wrong answer and the yaw sweep has to find the orientation |

```bash
python dev/scan-fixtures/make_scan_fixture.py --write --verify
```

## The harnesses

Both need the repo served over HTTP (the component is fetched, and ES-module
imports do not work from `file://`):

```bash
python -m http.server 8128
```

- **`measure-shipped.html`** — known-answer test. It fetches
  `structure-studio.component.js`, slices the four scan functions and their two
  module constants *out of the shipped file*, and runs those exact bytes against
  the three fixtures, so what gets validated cannot drift from what a customer
  downloads. Also checks the four rejection paths: a non-GLB file, a GLB whose
  header lies about its length, geometry too flat to be a building, and a
  building far too large to be a shed (that last one is a **warning**, not a
  refusal — the operator is shown the numbers and decides).
  Open `/dev/scan-fixtures/measure-shipped.html`; `window.__result.ok` is the
  verdict.

- **`mount-designer.html`** — mounts the real designer with a stub `setup3d`
  prop, which is the only way to reach the portal-only 3D calibration surface
  (including the Building Scan block) without a signed-in builder session. Stub
  callbacks record their arguments in `window.__calls`.

Neither is wired into `npm run preflight`: both need a browser with three.js and
GLTFLoader, and preflight is a node process that must stay dependency-free.
