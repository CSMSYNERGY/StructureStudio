// The 3D drag plane must be SET by the branch that reads it — checked against the SHIPPED
// designer source.
//
// THE BUG THIS PINS (Carolyn, 2026-09-02): "add in a lawn mower. Now try to drag that mower
// around" -> "No, it's just going into one direction", and, from a top-down camera, "it does,
// but it's very jerky".
//
// `dragPlane` is ONE mutable THREE.Plane, created once and shared by every branch of the
// pointer-move handler. Each branch is supposed to aim it before raycasting against it — the
// floor for a dropped item, the wall's own plane for an opening, a horizontal plane at the
// slab's height for a shelf. The prop branch never did. So it read whatever the previous drag
// had left pointing, and on a fresh viewer it read THREE's constructor default: normal
// (1,0,0), constant 0 — a VERTICAL plane at x = 0. The intersection's x is then always 0, the
// prop's x never leaves the middle of the building, and it slides on one axis only. Turn the
// camera to look straight down and the ray becomes nearly parallel to that plane, so the
// intersection shoots off to infinity or misses: the "jerky".
//
// WHY A SOURCE TEST AND NOT A UNIT TEST. The maths is a closure inside the viewer, reachable
// only with a WebGL context and a camera, and the Browser pane cannot help — it runs with
// document.hidden true, so requestAnimationFrame never fires and the 3D never rebuilds. But
// the defect has a shape that is perfectly visible in the text: a read of the shared plane
// with no nearby write. That is what this asserts, and it holds for the NEXT branch somebody
// adds, which a fixture-based test would not.
//
// Dependency-free apart from std/assert, the house rule for these stubs.

import { assert } from "jsr:@std/assert";

const SRC = await Deno.readTextFile(
  new URL("../../../../structure-studio.component.js", import.meta.url),
);
const LINES = SRC.split(/\r?\n/);

// Every read of the shared plane.
const READS: number[] = [];
LINES.forEach((ln, i) => {
  if (ln.includes("intersectPlane(dragPlane")) READS.push(i);
});

// The extraction guard, in wallSlab_test's spirit: if the handler is rewritten and these
// disappear, fail loudly rather than pass on an empty list.
assert(
  READS.length >= 5,
  `dragPlane_test: expected several intersectPlane(dragPlane) reads in the shipped source, ` +
    `found ${READS.length}. The 3D drag handler moved — re-point this test rather than deleting it.`,
);

// A write is either an aim in place, or a call to the helper that aims it. Both count.
const isWrite = (ln: string) => ln.includes("dragPlane.set(") || /\bwallPlane\(\)\s*;/.test(ln);

// How far back a branch may reasonably set the plane before using it. The real ones sit 1-6
// lines above their read; the bug sat ~200 lines away in a different branch entirely, so this
// window separates the two cases with room to spare and no false alarms.
const WINDOW = 14;

Deno.test("every branch that raycasts against dragPlane aims it first", () => {
  const orphans: string[] = [];
  for (const r of READS) {
    let aimed = false;
    for (let k = r - 1; k >= Math.max(0, r - WINDOW); k--) {
      if (isWrite(LINES[k])) { aimed = true; break; }
    }
    if (!aimed) orphans.push(`line ${r + 1}: ${LINES[r].trim()}`);
  }
  assert(
    orphans.length === 0,
    "These raycasts read the shared dragPlane without aiming it first, so they inherit " +
      "whatever the previous drag left — or, on a fresh viewer, THREE's default vertical " +
      "plane at x=0, which pins one axis and makes the item move in 1D:\n  " +
      orphans.join("\n  "),
  );
});

Deno.test("the prop branch aims at the FLOOR, and does not quantise", () => {
  // Named separately because this is the branch Carolyn demonstrated, and because "aims at
  // some plane" is not enough for a prop: a mower stands on the slab, so the plane has to be
  // the horizontal one at y=0 that place3 already uses when the prop is first dropped. Aiming
  // it anywhere else would move the item without tracking the cursor.
  // ⚠️ Anchor on the branch's own comment, NOT on "else if (c.propType)" — that string
  // appears three times (interior geometry, the click-to-place picker, and this drag), and
  // indexOf finds the geometry one, which contains none of what is asserted below and would
  // fail for the wrong reason.
  const i = SRC.indexOf("// The loft drag above, minus everything a loft needs");
  assert(i > 0, "dragPlane_test: the prop drag branch moved — re-point this test.");
  const branch = SRC.slice(i, i + 2400);

  assert(
    branch.includes("dragPlane.set(new THREE.Vector3(0, 1, 0), 0)"),
    "the prop branch must aim dragPlane at the floor (normal 0,1,0 through the origin) " +
      "before raycasting, the same plane place3 drops the prop onto",
  );

  // Carolyn: "I want them to be able to drag it exactly where they want it and to not snap to
  // anything." The half-foot quantiser that used to sit here is gone and must stay gone.
  assert(
    !/Math\.round\([^)]*\*\s*2\s*\)\s*\/\s*2/.test(branch),
    "the prop branch is quantising again — free placement was the whole request",
  );
  assert(
    !branch.includes("Math.round(p.x") && !branch.includes("Math.round(p.z"),
    "the prop branch is rounding its floor position again",
  );

  // The clamp is NOT a snap and must survive: it keeps the item inside the building.
  assert(
    branch.includes("Math.max(halfW") && branch.includes("Math.min(p.x + bldgW / 2"),
    "the prop branch must still clamp the item inside the building",
  );
});

Deno.test("the two twins carry the same fix", () => {
  // structure-studio.component.js is what ships; StructureStudio.jsx is the ES-module source
  // and is hand-mirrored, with no generator between them. Editing only one compiles clean and
  // changes nothing at runtime — a trap this repo has paid for before.
  //
  // ⚠️ Compare the PROP BRANCH of each file, not the whole file. A whole-file `includes` for
  // the floor-plane line is satisfied by place3's identical line ~200 lines earlier, so it
  // passes with the bug fully reinstated — which it did, on the first draft of this test.
  const TWIN = Deno.readTextFileSync(
    new URL("../../../../StructureStudio.jsx", import.meta.url),
  );
  const ANCHOR = "// The loft drag above, minus everything a loft needs";
  const branchOf = (src: string, name: string) => {
    const i = src.indexOf(ANCHOR);
    assert(i > 0, `dragPlane_test: prop drag branch not found in ${name}`);
    return src.slice(i, i + 2400);
  };
  for (const [name, src] of [
    ["structure-studio.component.js", SRC],
    ["StructureStudio.jsx", TWIN],
  ] as const) {
    assert(
      branchOf(src, name).includes("dragPlane.set(new THREE.Vector3(0, 1, 0), 0)"),
      `${name} is missing the prop drag-plane fix`,
    );
  }
});
