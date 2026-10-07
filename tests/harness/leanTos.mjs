// AS MANY LEAN-TOS AS THEY WANT, EACH WHERE THEY WANT (roof.leanTos, 2026-09-29), on the COMPILED bundle.
//
// Carolyn, 09-29: "they start with a core building, then they can add a lean-to and specify where they want
// it, and add another one and specify where they want it ... as many lean-tos ... wherever they want." A
// style's roof.leanTos is a list of up to six, each on a building wall (front is south +z, left is west -x),
// with its own width, drop, where it meets the building, how much of the wall it runs along and where, and
// open on posts or enclosed. This proves, measured off the scene graph (window.__SS3D_DEBUG):
//
//   S  THE SCENE, in the designer's 3D editor with a hand-written style:
//      S1 a Tri Home-style building (24x30, gable front, 6 ft wings both sides) with THREE lean-tos: one
//         off the FRONT GABLE END, open on posts; one ENCLOSED off the LEFT WING's outer wall (a wing on a
//         wing); one on the RIGHT side along only 10 ft of it, slid 5 ft toward the front. Each is built
//         where it was asked: its roof from the wall it meets out to its outer edge at its drop, its posts
//         under that edge (at both ends and at least every 8 ft) standing on the ground, the enclosed one's
//         three walls in the building's siding standing on the ground with a corner board at each outer
//         corner and no posts, and the partial one's slab, posts and header only along its 10 ft.
//      S2 on piers over ground that falls 2 ft to the back: a back gable-end lean-to's and a partial left
//         one's posts each reach the ground under their own foot (the renderer's own d3GradeAt).
//      S3 a listed lean-to on an eave wall is the single lean-to's slab to the thousandth of a foot, and a
//         style with the single lean-to still builds it (tagged true, no list).
//   U  THE ADVANCED PAGE's Lean-to tab (the portal, stubbed): "Add a lean-to" adds a card and a lean-to on
//      the right; another goes on the left; a card's Wall, width, "Part of it", length, position and
//      Enclosed move the 3D; "On the roof" is off on an end wall; "On the roof" 2 ft on a side builds
//      there and reads back; ✕ removes that one only; six is the most; Save sends the list and none of
//      the single lean-to's keys; a copied style with the single lean-to shows it as card 1 and the first
//      edit turns it into the list's first entry, same wall, same drop.
//   C  CONVERTING THE SINGLE LEAN-TO KEEPS IT WHERE IT WAS (review, 2026-09-30): on a shed's HIGH side and on
//      the centre's own wall beside a single wing, where the eave stands above the plate, the single lean-to
//      hangs at wall height; the card says "At wall height" and "meets the wall N below the eave", and the
//      first edit (the same width typed again) builds the list's entry with the same slab, posts and header
//      to 1/1000 ft. Every card's boxes are named for a screen reader by their card ("Lean-to 2 width (ft)").
//   P  THE CALIBRATION PANEL (?admin=1): a style with a list says "This style has 2 lean-tos, set on the
//      Advanced page." instead of the single lean-to's boxes, and saves the list untouched; a style with
//      the single lean-to still shows its boxes.
//   J  TWO LEAN-TOS THAT MEET AT A CORNER (d3CornerJoins, 2026-10-04): a side-wall one and an end-wall one
//      that match exactly run as one roof round the corner. J1 open: each slab on its own side of the hip
//      and the two cut faces one face, one corner post, the side wall's header through and the end wall's
//      butted, one hip cap. J2 enclosed: 4 walls not 6, the outer walls meeting, one corner board. J3 a
//      near-miss joins nothing and builds each exactly as alone. J4 a wrap round three sides. J5 the
//      Advanced page's words on both cards, and a near-miss's numbers after a drop is changed. J6 beside a
//      projecting porch.
//   M  A LEAN-TO THAT MEETS THE PORCH (d3PorchJoins, 2026-10-05), its numbers set to what its card says matches:
//      M1 the lean-to's side of the join: its slab on its side of the hip with its top on the porch roof's
//      plane (the porch sheet's too, so the two meet on the hip), its posts from its free end to the porch's
//      corner post and not at it, its header level to the porch's header, its half of the cap. M2 narrower
//      than the porch is deep: the header level to where the hip crosses it, then down the porch roof's slope.
//      M3 enclosed: all its walls kept, and a header from its corner board to the corner post. M4 a wrap round
//      the back too: the lean-to it meets round the back corner (d3CornerJoins) is on the same plane, and so is
//      their corner post. M5 the Advanced page: "Meet the porch" shows on the card that reaches the porch's
//      corner; asked off by its numbers it says by how much and what to type; typed, the two join, the porch's
//      card says who meets it, Save carries meetPorch, and "Runs past it" takes the key off; a second lean-to
//      is offered it until it is set up the roof, where it never can meet the porch.
//   PW A WING ALONG PART OF ITS WALL (lengthFt, 2026-10-07): a lean-to inside the wing's stretch hangs off it; one
//      past the wing's ends, or across the open corner beside it, is not drawn (its card says so: wingList.mjs PWA).
//   and zero page errors.
//
//   python -m http.server 8321 --bind 127.0.0.1 --directory <repo root>
//   SS_BASE=http://127.0.0.1:8321 SS_SHOTS=<dir> node tests/harness/leanTos.mjs     (SS_CASES=S,U,C,P,J,M,PW for a subset)
//
// Exit 0 = every assertion held.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { launch, stubSupabase, collectErrors, openDesigner, reporter, shotsDir, purePorch, BASE, REF, PASS_THROUGH_GET } from "./lib.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const PORTAL_HTML = readFileSync(join(ROOT, "portal.html"), "utf8");
const SHOTS = shotsDir("leanTos");
const CASES = (process.env.SS_CASES || "S,U,C,P,J,M,PW").split(",");
const want = (k) => CASES.includes(k);
const settle = (page, ms = 400) => page.waitForTimeout(ms);
const near = (a, b, tol = 0.02) => Math.abs(a - b) <= tol;
const f3 = (v) => (Number.isFinite(v) ? v.toFixed(3) : String(v));

// The renderer's own ground (d3GradeAt), lifted from the component twin the way lib.mjs's purePorch does.
const PURE = (() => {
  const src = readFileSync(join(ROOT, "structure-studio.component.js"), "utf8");
  const lift = (a, b) => { const i = src.indexOf(a), j = i < 0 ? -1 : src.indexOf(b, i); if (i < 0 || j < 0) throw new Error(`leanTos: anchors ${a} .. ${b} moved`); return src.slice(i, j); };
  const body = [["const D3 = {", "// The casing reveal every opening"], ["function d3RoofAxes(", "function d3FtIn("], ["function ssPorchTrussWall(", "// Where a vent sits in the gable above"]].map(([a, b]) => lift(a, b)).join("\n");
  return new Function(`${body}; return { d3GradeAt, d3GradeFt, d3LeanTosGeom };`)();
})();

const COLORS = { body: "#d9cfbd", trim: "#5b5f63", roof: "#3b4a5c", wood: "#a8703f" };
const CLADS = ["panel", "lap", "batten", "agpanel"].map((id) => ({ id, rate: 0, basis: "sqft_option", label: null, charged: false }));
const FIXTURES = { ramp: { mode: "simple", price: 0, method: "each", enabled: false, imageUrl: null, showImage: false }, items: [], windowColors: [] };
const configFor = (label, size, d3) => {
  const [w, l] = size.split("x").map(Number);
  return {
    clientId: "harness-leantos",
    branding: { companyName: "Harness Lean-tos", accentColor: "#1D4ED8", headerBg: "#FFFFFF", tagline: null, logo: null },
    contactFields: ["name", "email", "phone"],
    buildingStyles: [{ value: "hlt", label, img: null, sizes: [size], sizeInclusions: {}, sizeInclusionQty: {}, d3 }],
    defaultSizes: [size],
    sizePricing: { hlt: { [size]: { widthFt: w, lengthFt: l, basePrice: 9000 } } },
    options: [], colors: [], claddingOptions: { hlt: CLADS }, wallHeightOptions: {},
    showPricing: true, view3d: true, layoutItems: {}, layoutPricing: {}, layoutPrices: {},
    electrical: null, electricalItems: [], insulation: [],
  };
};

async function pickStyle(page, label) {
  await page.waitForFunction((lab) => [...document.querySelectorAll("div,span,p,strong,b")]
    .some((e) => e.children.length === 0 && (e.textContent || "").trim().toLowerCase() === lab.toLowerCase() && e.offsetParent), label, { timeout: 30000 }).catch(() => {});
  const hit = await page.evaluate((lab) => {
    const el = [...document.querySelectorAll("div,span,p,strong,b")]
      .find((e) => e.children.length === 0 && (e.textContent || "").trim().toLowerCase() === lab.toLowerCase() && e.offsetParent);
    if (!el) return false;
    el.click();
    return true;
  }, label);
  if (!hit) throw new Error(`no style tile labelled ${label}`);
  await settle(page, 500);
}
async function chooseSize(page, size) {
  const sel = page.locator("select").filter({ has: page.locator("option", { hasText: size }) });
  if (await sel.count()) await sel.first().selectOption({ label: size });
  const l = Number(size.split("x")[1]);
  await page.waitForFunction((l) => [...document.querySelectorAll("svg text")].some((t) => t.textContent.trim() === `${l} ft`), l, { timeout: 15000 });
  await settle(page, 600);
}
async function openEditor(page) {
  const edit = page.getByRole("button", { name: /Edit in 3D/ });
  if (!(await edit.count()) || !(await edit.first().isVisible())) {
    const show = page.getByRole("button", { name: /Show 3D|3D View/ });
    if (await show.count()) { await show.first().click(); await settle(page, 800); }
  }
  await edit.first().waitFor({ state: "visible", timeout: 60000 });
  await edit.first().click();
  await page.waitForFunction(() => { const E = window.__ss3dEngine; return !!(E && E.model && E.model.roofGroup && E.model.roofGroup.children.length > 0); }, null, { timeout: 90000 });
  await settle(page, 1500);
}
async function openCase(ctx, label, size, d3) {
  const page = await ctx.newPage();
  const errors = collectErrors(page);
  await page.addInitScript(() => { window.__SS3D_DEBUG = true; });
  await stubSupabase(page, { config: configFor(label, size, d3), fixtures: FIXTURES });
  await openDesigner(page, "harness-leantos");
  await pickStyle(page, label);
  await chooseSize(page, size);
  await openEditor(page);
  return { page, errors };
}

// Every lean-to member in world feet, grouped by its tag (true for the single lean-to, the list index
// otherwise): the slab (the widest roofMat box), posts, header, walls, corner boards.
const SCENE = (engine) => {
  const E = window[engine], M = E.model, V = E.camera.position.constructor;
  E.scene.updateMatrixWorld(true);
  const bb = (o) => {
    const mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
    o.traverse((q) => {
      if (!q.isMesh || !q.geometry) return;
      if (!q.geometry.boundingBox) q.geometry.computeBoundingBox();
      const b = q.geometry.boundingBox;
      for (const x of [b.min.x, b.max.x]) for (const y of [b.min.y, b.max.y]) for (const z of [b.min.z, b.max.z]) {
        const v = new V(x, y, z).applyMatrix4(q.matrixWorld);
        [v.x, v.y, v.z].forEach((c, k) => { mn[k] = Math.min(mn[k], c); mx[k] = Math.max(mx[k], c); });
      }
    });
    return { mn: mn.map((c) => Math.round(c * 1000) / 1000), mx: mx.map((c) => Math.round(c * 1000) / 1000) };
  };
  const by = {};
  M.root.traverse((q) => {
    if (!q.isMesh || !q.userData || q.userData.ssLeanTo === undefined) return;
    const t = String(q.userData.ssLeanTo);
    const g = by[t] || (by[t] = { n: 0, slab: null, posts: [], walls: [], corners: [], header: null, fillers: 0, hips: 0 });
    g.n++;
    const b = bb(q), P = q.geometry.parameters || {};
    // Two lean-tos joined at a corner (d3CornerJoins): the slab cut along the hip and the hip cap's strips.
    if (q.userData.ssLeanToHip) g.hips++;
    else if (q.userData.ssLeanToSlab) g.slab = b;
    else if (q.userData.ssLeanToPost) g.posts.push(b);
    else if (q.userData.ssLeanToWall) g.walls.push(b);
    else if (q.userData.ssLeanToStand) g.corners.push(b);
    else if (q.geometry.type === "BoxGeometry" && Math.abs(P.height - 0.2) < 1e-9) g.slab = b;
    else if (q.geometry.type === "BoxGeometry") g.header = b;
    else g.fillers++;
  });
  return { by, grade: M.grade, leanTos: M.leanTos ? JSON.parse(JSON.stringify(M.leanTos)) : null, leanTo: M.leanTo ? JSON.parse(JSON.stringify(M.leanTo)) : null,
    corners: M.leanToCorners ? JSON.parse(JSON.stringify(M.leanToCorners)) : null };
};
// The joined lean-tos' members in the frame d3CornerJoins speaks (the building's u -- the roof group's x plus
// the massing's uc -- the roof group's z along the ridge, and y): every vertex of each cut slab, and the box
// of each strip, post, header, wall and corner board, by tag, so each is measured against its own hip.
const JOINED = (engine) => {
  const E = window[engine], M = E.model, V = E.camera.position.constructor;
  const uc = M.massing ? M.massing.uc : 0;
  const verts = (o) => {
    o.updateMatrix();
    const p = o.geometry.attributes.position, out = [], v = new V();
    for (let k = 0; k < p.count; k++) { v.fromBufferAttribute(p, k).applyMatrix4(o.matrix); out.push([v.x + uc, v.y, v.z]); }
    return out;
  };
  const r3 = (c) => Math.round(c * 1000) / 1000;
  const boxOf = (o) => { const vs = verts(o); return { mn: [0, 1, 2].map((k) => r3(Math.min(...vs.map((v) => v[k])))), mx: [0, 1, 2].map((k) => r3(Math.max(...vs.map((v) => v[k])))) }; };
  const by = {};
  M.root.traverse((q) => {
    if (!q.isMesh || !q.userData || q.userData.ssLeanTo === undefined) return;
    const u = q.userData, t = String(u.ssLeanTo);
    const g = by[t] || (by[t] = { slab: null, slabBox: null, hips: [], posts: [], cornerPosts: [], headers: [], walls: [], boards: [], cornerBoards: [] });
    if (u.ssLeanToHip) g.hips.push({ of: u.ssLeanToHip, ...boxOf(q) });
    else if (u.ssLeanToSlab) { g.slab = verts(q); g.slabBox = boxOf(q); }
    else if (u.ssLeanToPost) (u.ssLeanToCorner ? g.cornerPosts : g.posts).push(boxOf(q));
    else if (u.ssLeanToWall) g.walls.push(boxOf(q));
    else if (u.ssLeanToStand) (u.ssLeanToCorner ? g.cornerBoards : g.boards).push(boxOf(q));
    else if (q.geometry.type === "BoxGeometry" && Math.abs((q.geometry.parameters || {}).height - 0.2) < 1e-9) g.slabBox = boxOf(q);
    else if (q.geometry.type === "BoxGeometry") g.headers.push(boxOf(q));
  });
  return { by, corners: M.leanToCorners ? JSON.parse(JSON.stringify(M.leanToCorners)) : null, porch: !!M.porch };
};
async function aimShot(page, engine, path, eye, at) {
  const clip = await page.evaluate(({ engine, eye, at }) => {
    const E = window[engine];
    E.camera.position.set(eye[0], eye[1], eye[2]);
    E.controls.target.set(at[0], at[1], at[2]);
    E.camera.lookAt(at[0], at[1], at[2]);
    E.camera.updateProjectionMatrix();
    if (E.controls.update) E.controls.update();
    E.render();
    const c = E.renderer.domElement.getBoundingClientRect();
    return { x: c.x, y: c.y, width: c.width, height: c.height };
  }, { engine, eye, at });
  await settle(page, 300);
  await page.evaluate((engine) => window[engine].render(), engine);
  await page.screenshot({ path, clip });
}

const { ok, failed } = reporter();
const { browser, ctx } = await launch({ width: 1400, height: 950 });

// ── S · THE SCENE ─────────────────────────────────────────────────────────────────────────────
const TRI = { type: "gable", front: "gable", pitch: 0.5, overhang: 0.6, wingSide: "both", wingWidthFt: 6, wingPitch: 0.25 };
if (want("S")) {
  // S1: three lean-tos on three walls of a winged building, on level ground.
  try {
    const d3 = { roof: { ...TRI, leanTos: [
      { wall: "front", widthFt: 6, dropFt: 1.5 },
      { wall: "left", widthFt: 8, dropFt: 1, enclosed: true },
      { wall: "right", widthFt: 6, dropFt: 1.5, lengthFt: 10, offsetFt: 5 },
    ] }, siding: "lap", colors: COLORS, wallHeightFt: 8, roofMaterial: "metal" };
    const { page, errors } = await openCase(ctx, "Harness Three Lean-tos", "24x30", d3);
    const sc = await page.evaluate(SCENE, "__ss3dEngine");
    const L = sc.by, g0 = L["0"], g1 = L["1"], g2 = L["2"];
    ok("S1: three lean-tos built, tagged 0, 1 and 2, and no single lean-to", !!(g0 && g1 && g2) && !L["true"] && sc.leanTos && sc.leanTos.length === 3,
      JSON.stringify(Object.keys(L)));
    ok("S1: the list as built names each wall and kind (front a gable end, the sides eave walls)",
      JSON.stringify(sc.leanTos.map((q) => [q.wall, q.kind])) === JSON.stringify([["front", "gable"], ["left", "eave"], ["right", "eave"]]), JSON.stringify(sc.leanTos.map((q) => [q.wall, q.kind])));
    // Lean-to 1: off the front gable end (z = +15), 6 ft out, meeting at the 8 ft plate, outer edge 1.5 ft lower.
    ok("S1: lean-to 1 stands off the FRONT wall: its roof runs from the wall (z 15) out past 21", !!g0.slab && near(g0.slab.mn[2], 15, 0.05) && g0.slab.mx[2] >= 21 && g0.slab.mn[0] >= -12.7 && g0.slab.mx[0] <= 12.7,
      g0.slab && `${f3(g0.slab.mn[2])}..${f3(g0.slab.mx[2])} x ${f3(g0.slab.mn[0])}..${f3(g0.slab.mx[0])}`);
    ok("S1: …meeting the wall at its 8 ft top and falling to 6.5 ft at its edge", !!g0.slab && near(g0.slab.mx[1], 8 + 0.2 / Math.cos(Math.atan(0.25)), 0.08) && g0.slab.mn[1] < 6.5,
      g0.slab && `${f3(g0.slab.mn[1])}..${f3(g0.slab.mx[1])}`);
    ok("S1: …its posts under the outer edge across the whole 24 ft end, at least every 8 ft (4), standing on the ground (y 0) up to 6.5",
      g0.posts.length === 4 && g0.posts.every((p) => near((p.mn[2] + p.mx[2]) / 2, 21) && near(p.mn[1], 0) && near(p.mx[1], 6.5)) && Math.max(...g0.posts.map((p) => (p.mn[0] + p.mx[0]) / 2)) - Math.min(...g0.posts.map((p) => (p.mn[0] + p.mx[0]) / 2)) > 20,
      JSON.stringify(g0.posts.map((p) => [f3((p.mn[0] + p.mx[0]) / 2), f3(p.mn[1]), f3(p.mx[1])])));
    // Lean-to 2: enclosed, off the LEFT wing's outer wall (x = -12), 8 ft out to x = -20, 8 ft to 7 ft.
    ok("S1: lean-to 2 hangs off the left WING's outer wall (x -12) and reaches x -20: a wing on a wing", !!g1.slab && g1.slab.mx[0] <= -11.9 && g1.slab.mn[0] <= -20,
      g1.slab && `${f3(g1.slab.mn[0])}..${f3(g1.slab.mx[0])}`);
    ok("S1: …enclosed: three walls of the building's siding (outer + two ends), no posts, a corner board each outer corner",
      g1.walls.length === 3 && g1.posts.length === 0 && g1.corners.length === 2, `${g1.walls.length} walls, ${g1.posts.length} posts, ${g1.corners.length} corners`);
    const outer = g1.walls.find((w) => w.mx[2] - w.mn[2] > 20);
    ok("S1: …its outer wall runs the full 30 ft at x -20, from the ground to the 7 ft edge", !!outer && near((outer.mn[0] + outer.mx[0]) / 2, -20, 0.05) && near(outer.mn[1], 0) && near(outer.mx[1], 7) && near(outer.mn[2], -15) && near(outer.mx[2], 15),
      outer && JSON.stringify(outer));
    const ends = g1.walls.filter((w) => w !== outer);
    ok("S1: …its end walls rise from the ground to the roof line (8 ft at the wing wall, 7 ft outside)", ends.length === 2 && ends.every((w) => near(w.mn[1], 0) && w.mx[1] > 7.8 && w.mx[1] < 8.1 && w.mn[0] <= -19.9 && w.mx[0] >= -12.3),
      JSON.stringify(ends));
    // Lean-to 3: 10 ft of the right side (x = +12), slid 5 ft toward the front: z 0..10.
    ok("S1: lean-to 3 runs only 10 ft of the right wall, slid 5 ft toward the front (z 0..10), its slab past each end by the overhang",
      !!g2.slab && near(g2.slab.mn[2], -0.6, 0.05) && near(g2.slab.mx[2], 10.6, 0.05) && g2.slab.mn[0] >= 11.9, g2.slab && `${f3(g2.slab.mn[2])}..${f3(g2.slab.mx[2])}`);
    ok("S1: …3 posts (both ends, at most 8 ft apart) at x 18 between z 0 and 10, on the ground; its header only 10 ft long",
      g2.posts.length === 3 && g2.posts.every((p) => near((p.mn[0] + p.mx[0]) / 2, 18) && near(p.mn[1], 0) && p.mn[2] >= 0 && p.mx[2] <= 10) && !!g2.header && near(g2.header.mx[2] - g2.header.mn[2], 10, 0.01),
      JSON.stringify(g2.posts.map((p) => [f3((p.mn[2] + p.mx[2]) / 2), f3(p.mn[1])])));
    ok("S1: zero page errors", errors.length === 0, JSON.stringify(errors.slice(0, 3)));
    await aimShot(page, "__ss3dEngine", join(SHOTS, "s1-three-leantos-front-left.png"), [-34, 20, 40], [-3, 4, 0]);
    await aimShot(page, "__ss3dEngine", join(SHOTS, "s1-three-leantos-front-right.png"), [36, 18, 38], [4, 4, 2]);
    await page.close();
  } catch (e) { ok("S1: ran", false, e && e.stack); }

  // S2: piers over ground falling 2 ft to the back: every post reaches the ground under its own foot.
  try {
    const d3 = { roof: { type: "gable", pitch: 0.4, overhang: 0.6, leanTos: [
      { wall: "back", widthFt: 6, dropFt: 1.5 },
      { wall: "left", widthFt: 6, dropFt: 1, lengthFt: 8, offsetFt: -3 },
    ] }, siding: "batten", colors: COLORS, wallHeightFt: 8, roofMaterial: "metal", foundation: "piers", floorHeightFt: 1.5, gradeFallFt: 2, gradeFallToward: "back" };
    const { page, errors } = await openCase(ctx, "Harness Lean-tos On A Slope", "12x16", d3);
    const sc = await page.evaluate(SCENE, "__ss3dEngine");
    const posts = [...(sc.by["0"] ? sc.by["0"].posts : []), ...(sc.by["1"] ? sc.by["1"].posts : [])];
    // Each post's foot: the deepest ground under its 0.3 ft square, the renderer's own d3GradeAt.
    const deep = (p) => Math.max(...[p.mn[0], p.mx[0]].flatMap((x) => [p.mn[2], p.mx[2]].map((z) => PURE.d3GradeAt(d3, 12, 16, x, z))));
    const off = posts.map((p) => Math.abs(p.mn[1] + deep(p)));
    ok("S2: two lean-tos' posts (3 across the 12 ft back end, 2 along the left's 8 ft) each reach the ground under its own foot on falling ground", posts.length === 5 && off.every((d) => d < 0.02),
      JSON.stringify(posts.map((p) => [f3((p.mn[0] + p.mx[0]) / 2), f3((p.mn[2] + p.mx[2]) / 2), f3(p.mn[1]), f3(-deep(p))])));
    ok("S2: …the back lean-to's posts, 6 ft further down the slope than the back wall, stand deeper than the front's 1.5 ft", sc.by["0"] && sc.by["0"].posts.every((p) => p.mn[1] < -1.5 - 0.5 && near((p.mn[2] + p.mx[2]) / 2, -14)),
      sc.by["0"] && JSON.stringify(sc.by["0"].posts.map((p) => f3(p.mn[1]))));
    ok("S2: …and the left one's 8 ft run is slid 3 ft toward the back (z -7..1)", sc.by["1"] && sc.by["1"].posts.every((p) => (p.mn[2] + p.mx[2]) / 2 >= -7 && (p.mn[2] + p.mx[2]) / 2 <= 1 && near((p.mn[0] + p.mx[0]) / 2, -12)),
      sc.by["1"] && JSON.stringify(sc.by["1"].posts.map((p) => f3((p.mn[2] + p.mx[2]) / 2))));
    ok("S2: zero page errors", errors.length === 0, JSON.stringify(errors.slice(0, 3)));
    await aimShot(page, "__ss3dEngine", join(SHOTS, "s2-slope-back-left.png"), [-30, 12, -34], [0, 1, -4]);
    await page.close();
  } catch (e) { ok("S2: ran", false, e && e.stack); }

  // S3: a listed lean-to on an eave wall is the single lean-to's slab; the single lean-to still builds.
  try {
    const one = { type: "gable", pitch: 0.4, overhang: 0.6 };
    const a = await openCase(ctx, "Harness Single Lean", "12x16", { roof: { ...one, leanToWidthFt: 8, leanToDropFt: 2, leanToSide: "left", leanToAttach: "roof", leanToAttachFt: 1 }, siding: "batten", colors: COLORS, wallHeightFt: 8 });
    const sa = await a.page.evaluate(SCENE, "__ss3dEngine");
    await a.page.close();
    const b = await openCase(ctx, "Harness Listed Lean", "12x16", { roof: { ...one, leanTos: [{ wall: "left", widthFt: 8, dropFt: 2, attach: "roof", attachFt: 1 }] }, siding: "batten", colors: COLORS, wallHeightFt: 8 });
    const sb = await b.page.evaluate(SCENE, "__ss3dEngine");
    await b.page.close();
    ok("S3: the single lean-to still builds, tagged true, with no list", !!sa.by["true"] && !sa.leanTos && !!sa.leanTo, JSON.stringify(Object.keys(sa.by)));
    ok("S3: the same lean-to as the list's one entry: the same slab to 1/1000 ft, the same 3 posts, the same gable-end fillers",
      !!sb.by["0"] && JSON.stringify(sb.by["0"].slab) === JSON.stringify(sa.by["true"].slab) && JSON.stringify(sb.by["0"].posts) === JSON.stringify(sa.by["true"].posts) && sb.by["0"].fillers === sa.by["true"].fillers,
      JSON.stringify([sa.by["true"] && sa.by["true"].slab, sb.by["0"] && sb.by["0"].slab]));
    ok("S3: zero page errors", a.errors.length === 0 && b.errors.length === 0, JSON.stringify([...a.errors, ...b.errors].slice(0, 3)));
  } catch (e) { ok("S3: ran", false, e && e.stack); }
}

// S4: a 12x16 with an ENCLOSED lean-to on 6 ft of the front end, 2 ft right of centre, and a lean-to up the
// LEFT side's roof along 8 ft of it: the roof-attach closes its own two ends (the filler ends where it does).
if (want("S")) {
  try {
    const d3 = { roof: { type: "gable", pitch: 0.4, overhang: 0.6, leanTos: [
      { wall: "front", widthFt: 6, dropFt: 1, lengthFt: 6, offsetFt: 2, enclosed: true },
      { wall: "left", widthFt: 6, dropFt: 1.5, attach: "roof", attachFt: 1.5, lengthFt: 8, offsetFt: -2 },
    ] }, siding: "batten", colors: COLORS, wallHeightFt: 8, roofMaterial: "metal" };
    const { page, errors } = await openCase(ctx, "Harness Front Room", "12x16", d3);
    const sc = await page.evaluate(SCENE, "__ss3dEngine");
    const e0 = sc.by["0"], e1 = sc.by["1"];
    ok("S4: the enclosed front lean-to stands on 6 ft of the front, x -1..5, 6 ft out (z 8..14), walled, no posts",
      !!e0 && e0.walls.length === 3 && e0.posts.length === 0 && e0.walls.every((w) => w.mn[0] >= -1.2 && w.mx[0] <= 5.2 && w.mn[2] >= 7.8 && w.mx[2] <= 14.2 && near(w.mn[1], 0)),
      e0 && JSON.stringify(e0.walls));
    ok("S4: the left lean-to meets the roof 1.5 ft up along its own 8 ft (z -6..2), its roof-side ends closed by one filler that long, 2 posts (7.4 ft apart)",
      !!e1 && e1.fillers === 1 && !!e1.slab && near(e1.slab.mn[2], -6.6, 0.05) && near(e1.slab.mx[2], 2.6, 0.05) && e1.posts.length === 2, e1 && JSON.stringify({ f: e1.fillers, z: [e1.slab.mn[2], e1.slab.mx[2]], p: e1.posts.length }));
    const fz = await page.evaluate(() => { let r = null; window.__ss3dEngine.model.root.traverse((o) => { if (o.isMesh && o.userData && o.userData.ssLeanTo === 1 && o.geometry.type === "ExtrudeGeometry") { o.geometry.computeBoundingBox(); const b = o.geometry.boundingBox.clone().applyMatrix4(o.matrixWorld); r = [b.min.z, b.max.z]; } }); return r; });
    ok("S4: …the filler runs z -6..2 only", !!fz && near(fz[0], -6, 0.02) && near(fz[1], 2, 0.02), JSON.stringify(fz));
    ok("S4: zero page errors", errors.length === 0, JSON.stringify(errors.slice(0, 3)));
    await aimShot(page, "__ss3dEngine", join(SHOTS, "s4-front-room-and-roof-leanto.png"), [-22, 13, 26], [0, 3, 2]);
    await page.close();
  } catch (e) { ok("S4: ran", false, e && e.stack); }
}

// ── U · THE ADVANCED PAGE ──────────────────────────────────────────────────────────────────────
const OURS = "harness-internal";
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
const EXP = 4102444800;
const USER = { id: "00000000-0000-4000-8000-000000000047", aud: "authenticated", role: "authenticated", email: "lt@example.test", app_metadata: {}, user_metadata: {}, created_at: "2026-01-01T00:00:00Z" };
const SESSION = {
  access_token: `${b64({ alg: "HS256", typ: "JWT" })}.${b64({ sub: USER.id, role: "authenticated", email: USER.email, exp: EXP })}.c3R1Yg`,
  token_type: "bearer", expires_in: 999999999, expires_at: EXP, refresh_token: "r", user: USER,
};
const SINGLE_D3 = { roof: { type: "gable", pitch: 0.4, overhang: 0.6, leanToWidthFt: 7, leanToDropFt: 2, leanToSide: "left" }, siding: "batten", colors: { body: "#9B2F2F", trim: "#F4F1EA", roof: "#3E434A" }, wallHeightFt: 8 };
// The single lean-to where the eave stands above the plate: a shed's high side, and the centre's own wall
// beside a single wing (the lean-to on the side without the wing).
const SHED_HIGH_D3 = { roof: { type: "shed", highSide: "left", pitch: 0.25, overhang: 0.5, leanToWidthFt: 8, leanToDropFt: 1.5, leanToSide: "left" }, siding: "batten", colors: { body: "#9B2F2F", trim: "#F4F1EA", roof: "#3E434A" }, wallHeightFt: 8 };
const ONE_WING_D3 = { roof: { type: "gable", front: "gable", pitch: 0.5, overhang: 0.6, wingSide: "left", wingWidthFt: 6, wingPitch: 0.25, leanToWidthFt: 6, leanToDropFt: 1, leanToSide: "right" }, siding: "lap", colors: { body: "#9B2F2F", trim: "#F4F1EA", roof: "#3E434A" }, wallHeightFt: 8 };
const PCONFIG = {
  branding: { companyName: "Harness Internal", accentColor: "#3D3672", headerBg: "#FFFFFF" },
  contactFields: [{ key: "name", label: "Name", required: true }],
  buildingStyles: [{ value: "hlean", label: "Harness Lean Cabin", sizes: [{ label: "12x16", w: 12, h: 16, price: 5000 }], d3: SINGLE_D3 },
    { value: "hshed", label: "Harness Shed High", sizes: [{ label: "12x16", w: 12, h: 16, price: 5000 }], d3: SHED_HIGH_D3 },
    { value: "hwing", label: "Harness One Wing", sizes: [{ label: "24x16", w: 24, h: 16, price: 5000 }], d3: ONE_WING_D3 }],
  defaultSizes: [], options: [], wallHeightFt: 8,
  layoutItems: { door: { label: "Door", icon: "D", color: "#8B4513", width: 40, height: 12, shortLabel: "D" } },
};
const ENT = { reason: "internal", status: "active", granted: ["view_3d"], features: { view_3d: true }, exempt: true, state: "exempt" };
const HDR = { "access-control-allow-origin": "*", "access-control-expose-headers": "*" };
const jsonR = (route, body, status = 200) => route.fulfill({ status, contentType: "application/json", headers: HDR, body: JSON.stringify(body) });

async function openPortal(path) {
  const c = await browser.newContext({ viewport: { width: 1440, height: 1000 }, serviceWorkers: "block" });
  await c.addInitScript(([ref, s]) => {
    try { localStorage.setItem(`sb-${ref}-auth-token`, JSON.stringify(s)); } catch (_e) { /* storage blocked */ }
    window.__SS3D_DEBUG = true;
  }, [REF, SESSION]);
  const page = await c.newPage();
  const errors = collectErrors(page);
  const calls = [];
  let made = 0;
  await page.route((u) => !/^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?\//.test(u.href), (route) => {
    const req = route.request();
    if (req.method() === "GET" && PASS_THROUGH_GET.test(req.url())) return route.continue();
    return route.abort();
  });
  const handler = async (route) => {
    const req = route.request();
    const url = req.url();
    if (req.method() === "OPTIONS") return route.fulfill({ status: 200, headers: { ...HDR, "access-control-allow-headers": "*", "access-control-allow-methods": "*" }, body: "" });
    let body = {};
    try { body = JSON.parse(req.postData() || "{}"); } catch (_e) { /* not JSON */ }
    const rpc = /\/rest\/v1\/rpc\/([a-z_]+)/.exec(url);
    if (rpc) {
      if (rpc[1] === "get_config") return jsonR(route, PCONFIG);
      if (rpc[1] === "get_fixtures") return jsonR(route, []);
      return jsonR(route, rpc[1] === "log_error" ? null : false);
    }
    if (url.includes("/rest/v1/client_users")) return jsonR(route, [{ client_id: OURS, role: "owner" }]);
    if (url.includes("/rest/v1/")) return jsonR(route, []);
    if (url.includes("/auth/v1/user")) return jsonR(route, USER);
    if (url.includes("/auth/v1/")) return jsonR(route, SESSION);
    if (url.includes("/portal-billing")) return jsonR(route, { ok: true, configured: true, hasCard: false, plans: [], subscriptions: [], wallet: null, entitlement: ENT });
    if (url.includes("/portal-settings")) {
      calls.push({ action: body.action, body });
      if (body.action === "status") return jsonR(route, { ok: true, clientId: OURS, role: "owner", settings: { business_name: OURS }, config: { company_name: OURS, accent_color: "#3D3672" }, access: null, prefs: null });
      if (body.action === "catalog") return jsonR(route, { ok: true, aiReady: true, styles: [], sizes: [], layoutItems: [], fixtures: [], colors: [] });
      if (body.action === "create_style") {
        made++;
        const key = String(body.label || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "style";
        return jsonR(route, { ok: true, styleId: `00000000-0000-4000-8000-00000000b${String(made).padStart(3, "0")}`, key });
      }
      if (body.action === "save_style_d3") return jsonR(route, { ok: true, updatedAt: "2026-09-29T10:00:00.000+00:00" });
      return jsonR(route, { ok: true });
    }
    return jsonR(route, { ok: true });
  };
  await page.route(`**/${REF}.supabase.co/**`, handler);
  await page.route(`**/${REF}.functions.supabase.co/**`, handler);
  await page.route(`**/${REF}.storage.supabase.co/**`, handler);
  await page.route(/\/portal\/[a-z]/, (r) => r.fulfill({ status: 200, contentType: "text/html", body: PORTAL_HTML }));
  await page.goto(`${BASE}${path}`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => window.__ssAppBooted === true && !document.body.innerText.includes("Loading your business"), null, { timeout: 60000 });
  return { c, page, errors, calls };
}
// The docked 3D on the Advanced page, and the lean-to list it last built.
async function panelWait(page, src, timeout = 60000) {
  await page.waitForFunction((src) => {
    const P = window.__ss3dPanel;
    if (!(P && P.model && P.renderer && P.renderer.domElement.isConnected && P.renderer.domElement.closest('[data-ss-adv="view"]'))) return false;
    return new Function("M", `return (${src})(M);`)(P.model);
  }, src, { timeout });
}
const card = (page, i) => page.locator(`[data-ss-adv-lt="${i}"]`);
// Every card's boxes are named by their card for a screen reader (review, 2026-09-30): "Lean-to 2 width (ft)".
const ltAria = (n, label) => `Lean-to ${n} ${label.replace(/^Lean-to /, "").replace(/^./, (c) => c.toLowerCase())}`;
const inCard = (page, i, label) => card(page, i).getByLabel(ltAria(i + 1, label), { exact: true });
const segIn = (page, i, group, name) => card(page, i).getByRole("group", { name: ltAria(i + 1, group), exact: true }).getByRole("button", { name, exact: true });
const typeIn = async (page, i, label, v) => { const b = inCard(page, i, label); await b.fill(String(v)); await b.press("Tab"); await settle(page, 250); };
// Aim the docked 3D: the direction asked, as far back as its controls allow (they hold the camera inside
// maxDistance), rendered now; returns where it ended up.
const aimDock = (page, dir, at) => page.evaluate(({ dir, at }) => {
  const P = window.__ss3dPanel, n = Math.hypot(...dir);
  const d = Math.min(P.controls.maxDistance || 60, 60) * 0.97;
  P.controls.target.set(...at);
  P.camera.position.set(at[0] + dir[0] / n * d, at[1] + dir[1] / n * d, at[2] + dir[2] / n * d);
  P.controls.update(); P.render();
  return { pos: P.camera.position.toArray().map((v) => Math.round(v * 10) / 10), max: P.controls.maxDistance };
}, { dir, at });
const list = (page) => page.evaluate(() => { const M = window.__ss3dPanel && window.__ss3dPanel.model; return M && M.leanTos ? JSON.parse(JSON.stringify(M.leanTos)) : null; });

if (want("U")) {
  const { c, page, errors, calls } = await openPortal("/portal/advanced");
  try {
    await page.getByText("Every shape control on one building").first().waitFor({ state: "visible", timeout: 60000 }).catch(() => {});
    await page.locator('[data-ss-adv-sec="leanto"]').click();
    await settle(page, 300);
    ok("U: a blank building's Lean-to tab has no card and an \"Add a lean-to\" button", (await page.locator("[data-ss-adv-lt]").count()) === 0 && /Add a lean-to/.test(await page.locator('[data-ss-adv-f="leanToAdd"]').innerText()));
    await page.locator('[data-ss-adv-f="leanToAdd"]').click();
    await panelWait(page, "(M) => !!(M.leanTos && M.leanTos.length === 1)");
    let q = await list(page);
    ok("U: \"Add a lean-to\" adds card 1 and a lean-to on the RIGHT wall, 8 ft out, in the 3D", (await page.locator("[data-ss-adv-lt]").count()) === 1 && q[0].wall === "right" && q[0].w === 8 && q[0].u1 > 6,
      JSON.stringify(q && q.map((x) => [x.wall, x.w, x.u1])));
    await page.locator('[data-ss-adv-f="leanToAdd"]').click();
    await panelWait(page, "(M) => !!(M.leanTos && M.leanTos.length === 2)");
    q = await list(page);
    ok("U: another goes on the LEFT wall, the next free one", q[1].wall === "left" && q[1].u1 < -6, JSON.stringify(q.map((x) => x.wall)));
    ok("U: a side wall's card says so, and not that it is the long one", /A side wall, under the roof's edge\./.test(await card(page, 0).innerText()) && !/A long wall/.test(await card(page, 0).innerText()));
    // Card 2: the front wall, 6 ft wide, part of it, 6 ft long, 2 ft toward the right, enclosed.
    await segIn(page, 1, "Wall", "Front").click();
    await settle(page, 300);
    ok("U: on an end wall \"On the roof\" is off, with the reason on hover", await segIn(page, 1, "Meets the building", "On the roof").isDisabled()
      && /no roof edge/.test(await segIn(page, 1, "Meets the building", "On the roof").getAttribute("title") || ""));
    await typeIn(page, 1, "Lean-to width (ft)", 6);
    await card(page, 1).getByRole("button", { name: "Part of it", exact: true }).click();
    await settle(page, 300);
    await typeIn(page, 1, "Length along the wall (ft)", 6);
    await typeIn(page, 1, "Position from the middle (ft)", 2);
    await segIn(page, 1, "Sides", "Enclosed").click();
    await panelWait(page, "(M) => !!(M.leanTos && M.leanTos[1] && M.leanTos[1].wall === 'front' && M.leanTos[1].enclosed && Math.abs(M.leanTos[1].len - 6) < 1e-9 && Math.abs(M.leanTos[1].off - 2) < 1e-9)");
    q = await list(page);
    const walls1 = await page.evaluate(() => { let n = 0; window.__ss3dPanel.model.root.traverse((o) => { if (o.isMesh && o.userData && o.userData.ssLeanTo === 1 && o.userData.ssLeanToWall) n++; }); return n; });
    ok("U: card 2's Wall, width, Part of it, Length 6, Position 2 and Enclosed build a 6 ft enclosed lean-to on 6 ft of the front, 2 ft right of centre",
      q[1].kind === "gable" && q[1].w === 6 && near(q[1].a0, -1, 1e-6) && near(q[1].a1, 5, 1e-6) && walls1 === 3, JSON.stringify({ q: [q[1].kind, q[1].w, q[1].a0, q[1].a1], walls1 }));
    // Card 1: on the roof, 2 ft up.
    await segIn(page, 0, "Meets the building", "On the roof").click();
    await typeIn(page, 0, "How far up the roof (ft)", 2);
    await panelWait(page, "(M) => !!(M.leanTos && M.leanTos[0].mode === 'roof' && Math.abs(M.leanTos[0].d - 2) < 1e-6)");
    // Measurements are held together by no-break spaces on the page; read as plain spaces here.
    const say = (await card(page, 0).locator('[data-ss-adv-readout="leanTo"]').innerText()).replace(/\u00A0/g, " ").trim();
    ok("U: card 1 \"On the roof\" 2 ft builds there, and reads back what it builds", /^Builds [\d.]+ in 12 · meets the roof 2' 0" above the eave$/.test(say), JSON.stringify(say));
    await page.locator("#ss-step-adv-addons").scrollIntoViewIfNeeded();
    await settle(page, 400);
    await settle(page, 600);
    console.log("aim", JSON.stringify(await aimDock(page, [0.9, 0.55, 1], [0, 3, 2])));
    await settle(page, 300);
    await page.evaluate(() => window.__ss3dPanel.render());
    await page.screenshot({ path: join(SHOTS, "u-advanced-two-leantos.png") });
    // ✕ on card 1 removes that one only.
    await card(page, 0).getByRole("button", { name: "Remove lean-to 1", exact: true }).click();
    await panelWait(page, "(M) => !!(M.leanTos && M.leanTos.length === 1)");
    q = await list(page);
    ok("U: ✕ removes lean-to 1 only: the front one is now lean-to 1, still enclosed and where it was", q.length === 1 && q[0].wall === "front" && q[0].enclosed && near(q[0].a0, -1, 1e-6)
      && (await page.locator("[data-ss-adv-lt]").count()) === 1 && /^lean-to 1$/i.test((await card(page, 0).locator(".ssd-card-t").innerText()).trim()), JSON.stringify(q.map((x) => [x.i, x.wall])));
    // Up to six.
    for (let k = 0; k < 5; k++) { await page.locator('[data-ss-adv-f="leanToAdd"]').click(); await settle(page, 200); }
    await panelWait(page, "(M) => !!(M.leanTos && M.leanTos.length === 6)");
    q = await list(page);
    const tags = await page.evaluate(() => { const s = new Set(); window.__ss3dPanel.model.root.traverse((o) => { if (o.isMesh && o.userData && typeof o.userData.ssLeanTo === "number") s.add(o.userData.ssLeanTo); }); return [...s].sort(); });
    ok("U: six lean-tos is the most: all six drawn (tags 0..5), and the add button is off", q.length === 6 && JSON.stringify(tags) === "[0,1,2,3,4,5]" && await page.locator('[data-ss-adv-f="leanToAdd"]').isDisabled(), JSON.stringify(tags));
    ok("U: …two on one wall that overlap are said on their cards, never moved", (await page.locator("[data-ss-leanto-clash]").count()) > 0, String(await page.locator("[data-ss-leanto-clash]").count()));
    await page.locator('[data-ss-adv-lt="0"]').scrollIntoViewIfNeeded();
    await settle(page, 600);
    console.log("aim", JSON.stringify(await aimDock(page, [-0.8, 0.75, 1], [0, 3, 0])));
    await settle(page, 300);
    await page.evaluate(() => window.__ss3dPanel.render());
    await page.screenshot({ path: join(SHOTS, "u-advanced-six-leantos.png") });
    // The End view with lean-tos on both of its sides (review, 2026-09-30): no two of its words overlap, and
    // no lean-to's name crosses a post line.
    const elev = await page.evaluate(() => {
      const svg = [...document.querySelectorAll("svg")].find((v) => v.querySelector("[data-ss-elev-leanto]"));
      if (!svg) return null;
      // A label is its main words and the small line under them (one <g>): those two may touch each other.
      const texts = [...svg.querySelectorAll("text")].filter((t) => (t.textContent || "").trim()).map((t) => { const r = t.getBoundingClientRect(); return { g: t.parentNode, t: t.textContent.trim(), l: r.left, r: r.right, top: r.top, b: r.bottom }; });
      const hits = [];
      for (let i = 0; i < texts.length; i++) for (let j = i + 1; j < texts.length; j++) {
        const A = texts[i], B = texts[j];
        if (A.g === B.g) continue;
        if (Math.min(A.r, B.r) - Math.max(A.l, B.l) > 0.5 && Math.min(A.b, B.b) - Math.max(A.top, B.top) > 0.5) hits.push([A.t, B.t]);
      }
      const posts = [...svg.querySelectorAll("[data-ss-elev-leanto] line")].map((l) => { const r = l.getBoundingClientRect(); return { x: (r.left + r.right) / 2, top: r.top, b: r.bottom }; });
      const names = [...svg.querySelectorAll("[data-ss-elev-leanto-name] text")].map((t) => { const r = t.getBoundingClientRect(); return { t: t.textContent.trim(), l: r.left, r: r.right, top: r.top, b: r.bottom }; });
      const crossed = names.filter((n) => posts.some((p) => p.x > n.l && p.x < n.r && Math.min(p.b, n.b) - Math.max(p.top, n.top) > 0.5)).map((n) => n.t);
      return { n: texts.length, hits, crossed, names: names.map((n) => n.t), words: texts.map((x) => x.t) };
    });
    ok("U: the End view with lean-tos on both sides: no two labels overlap, and no lean-to name crosses a post line",
      !!elev && elev.hits.length === 0 && elev.crossed.length === 0 && elev.names.length >= 2, JSON.stringify(elev));
    ok("U: every card's boxes carry their card's name for a screen reader (Lean-to 3 width (ft), Lean-to 6 sides)",
      (await card(page, 2).getByLabel("Lean-to 3 width (ft)", { exact: true }).count()) === 1 && (await card(page, 5).getByRole("group", { name: "Lean-to 6 sides", exact: true }).count()) === 1
        && (await page.getByLabel("Lean-to width (ft)", { exact: true }).count()) === 0);
    // Save: the list, and none of the single lean-to's keys.
    await page.getByLabel("New style name").fill("Harness Six Lean-tos");
    await page.getByRole("button", { name: "Save as a new style" }).click();
    const t0 = Date.now();
    while (!calls.some((x) => x.action === "save_style_d3") && Date.now() - t0 < 20000) await settle(page, 200);
    const sd = calls.find((x) => x.action === "save_style_d3");
    const roof = sd && sd.body.d3 && sd.body.d3.roof;
    ok("U: Save sends roof.leanTos with all six, and no leanToWidthFt / leanToSide / leanToDropFt", !!roof && Array.isArray(roof.leanTos) && roof.leanTos.length === 6
      && ["leanToWidthFt", "leanToSide", "leanToDropFt", "leanToAttach", "leanToAttachFt"].every((k) => !(k in roof)) && roof.leanTos[0].wall === "front" && roof.leanTos[0].enclosed === true,
      roof && JSON.stringify(roof.leanTos && roof.leanTos.slice(0, 2)));
    // Without a front wall picked the roof turns with the size: the tab says each lean-to keeps its wall.
    const frameNote = await page.locator("[data-ss-leanto-frame]").count();
    ok("U: the \"stays on its wall at every size\" note shows exactly when no front wall is picked", frameNote === (roof && !roof.front && !roof.highSide ? 1 : 0), JSON.stringify({ frameNote, front: roof && roof.front }));
    // A copied style with the single lean-to: card 1, and the first edit makes it the list's first entry.
    page.on("dialog", (d) => d.accept());
    await page.locator('[data-ss-adv="start"] [data-ss-style="hlean"]').click();
    await settle(page, 1500);
    await page.locator('[data-ss-adv-sec="leanto"]').click();
    await panelWait(page, "(M) => !!(M.leanTo || (!M.leanTos && M.roofGroup.children.length))");
    const before = await page.evaluate(() => { const M = window.__ss3dPanel.model; let n = 0; M.root.traverse((o) => { if (o.isMesh && o.userData && o.userData.ssLeanTo === true) n++; }); return { single: n, list: !!M.leanTos }; });
    ok("U: a copied style with the single lean-to shows it as card 1 (left wall, 7 ft, 2 ft drop), built as the single lean-to still",
      (await page.locator("[data-ss-adv-lt]").count()) === 1 && (await inCard(page, 0, "Lean-to width (ft)").inputValue()) === "7" && (await inCard(page, 0, "Outer edge drop (ft)").inputValue()) === "2"
      && await segIn(page, 0, "Wall", "Left").getAttribute("aria-pressed") === "true" && before.single > 0 && !before.list, JSON.stringify(before));
    await typeIn(page, 0, "Lean-to width (ft)", 9);
    await panelWait(page, "(M) => !!(M.leanTos && M.leanTos.length === 1 && M.leanTos[0].w === 9)");
    q = await list(page);
    const single = await page.evaluate(() => { let n = 0; window.__ss3dPanel.model.root.traverse((o) => { if (o.isMesh && o.userData && o.userData.ssLeanTo === true) n++; }); return n; });
    ok("U: …the first edit makes it the list's first entry: same wall (left), same 2 ft drop, the new 9 ft width, and the single lean-to is gone",
      q[0].wall === "left" && q[0].drop === 2 && q[0].w === 9 && single === 0, JSON.stringify({ q: q.map((x) => [x.wall, x.drop, x.w]), single }));
    await page.getByLabel("New style name").fill("Harness Converted");
    const n0 = calls.filter((x) => x.action === "save_style_d3").length;
    await page.getByRole("button", { name: "Save as a new style" }).click();
    const t1 = Date.now();
    while (calls.filter((x) => x.action === "save_style_d3").length === n0 && Date.now() - t1 < 20000) await settle(page, 200);
    const sd2 = calls.filter((x) => x.action === "save_style_d3")[n0];
    const r2 = sd2 && sd2.body.d3.roof;
    ok("U: …and saves as {wall left, widthFt 9, dropFt 2}, the single lean-to's keys gone", !!r2 && JSON.stringify(r2.leanTos) === JSON.stringify([{ wall: "left", widthFt: 9, dropFt: 2 }]) && !("leanToWidthFt" in r2) && !("leanToSide" in r2),
      r2 && JSON.stringify({ leanTos: r2.leanTos, w: r2.leanToWidthFt, s: r2.leanToSide }));
    ok("U: zero page errors", errors.length === 0, JSON.stringify(errors.slice(0, 3)));
  } catch (e) { ok("U: ran", false, e && e.stack); await page.screenshot({ path: join(SHOTS, "u-failure.png") }).catch(() => {}); }
  await c.close();
}

// ── C · CONVERTING THE SINGLE LEAN-TO WHERE THE EAVE STANDS ABOVE THE PLATE ─────────────────────────
// The docked 3D's lean-to members for one tag, in world feet to 1/1000: slab, posts, header.
const dockMembers = (page, tag) => page.evaluate((tag) => {
  const M = window.__ss3dPanel.model;
  M.root.updateMatrixWorld(true);
  const r3 = (v) => Math.round(v * 1000) / 1000;
  const out = { slab: null, posts: [], header: null, n: 0 };
  M.root.traverse((o) => {
    if (!o.isMesh || !o.userData || o.userData.ssLeanTo !== tag) return;
    o.geometry.computeBoundingBox();
    const b = o.geometry.boundingBox.clone().applyMatrix4(o.matrixWorld);
    const bx = [b.min.x, b.min.y, b.min.z, b.max.x, b.max.y, b.max.z].map(r3);
    const P = o.geometry.parameters || {};
    out.n++;
    if (o.userData.ssLeanToPost) out.posts.push(bx);
    else if (o.geometry.type === "BoxGeometry" && Math.abs(P.height - 0.2) < 1e-9) out.slab = bx;
    else if (o.geometry.type === "BoxGeometry") out.header = bx;
  });
  out.posts.sort((a, b) => a[2] - b[2] || a[0] - b[0]);
  return out;
}, tag);
const singleCount = "(M) => { let n = 0; M.root.traverse((o) => { if (o.isMesh && o.userData && o.userData.ssLeanTo === true) n++; }); return n > 0 && !M.leanTos; }";
if (want("C")) {
  const { c, page, errors } = await openPortal("/portal/advanced");
  try {
    await page.getByText("Every shape control on one building").first().waitFor({ state: "visible", timeout: 60000 }).catch(() => {});
    page.on("dialog", (d) => d.accept());
    // [style, where, width to type (the width it has), building width, the eave's height over the plate]
    for (const [value, what, width, bldgW, gap] of [["hshed", "a shed's high side", 8, null, 3], ["hwing", "the centre's own wall beside a single wing", 6, 24, null]]) {
      await page.locator(`[data-ss-adv="start"] [data-ss-style="${value}"]`).click();
      await settle(page, 1500);
      if (bldgW) {
        const wBox = page.getByLabel("Width (ft)", { exact: true });
        await wBox.fill(String(bldgW));
        await wBox.press("Tab");
        await settle(page, 1500);
      }
      await page.locator('[data-ss-adv-sec="leanto"]').click();
      await panelWait(page, singleCount);
      await settle(page, 800);
      const before = await dockMembers(page, true);
      const pressed = (await card(page, 0).getByRole("group", { name: ltAria(1, "Meets the building"), exact: true }).locator('[aria-pressed="true"]').innerText()).trim();
      const say = (await card(page, 0).locator('[data-ss-adv-readout="leanTo"]').innerText()).replace(/ /g, " ").trim();
      ok(`C: on ${what} the single lean-to's card says "At wall height" and where it meets under the eave`,
        pressed === "At wall height" && /meets the wall \d+' \d+" below the eave$/.test(say) && (gap == null || say.endsWith(`meets the wall ${gap}' 0" below the eave`)), JSON.stringify({ pressed, say }));
      await card(page, 0).scrollIntoViewIfNeeded();
      await settle(page, 300);
      await page.evaluate(() => window.__ss3dPanel.render());
      await page.screenshot({ path: join(SHOTS, `c-single-${value}.png`) });
      // The first edit converts it; a box only commits a change, so a half foot more and then back.
      await typeIn(page, 0, "Lean-to width (ft)", width + 0.5);
      await typeIn(page, 0, "Lean-to width (ft)", width);
      await panelWait(page, `(M) => !!(M.leanTos && M.leanTos.length === 1 && M.leanTos[0].w === ${width})`);
      await settle(page, 800);
      const after = await dockMembers(page, 0);
      const single = await dockMembers(page, true);
      const q = await list(page);
      ok(`C: …the first edit makes it the list's entry and nothing moves: the same slab, posts and header to 1/1000 ft (${what})`,
        single.n === 0 && !!before.slab && JSON.stringify(after.slab) === JSON.stringify(before.slab) && JSON.stringify(after.posts) === JSON.stringify(before.posts)
          && JSON.stringify(after.header) === JSON.stringify(before.header) && before.posts.length > 0,
        JSON.stringify({ before: [before.slab, before.posts.map((p) => p[4])], after: [after.slab, after.posts.map((p) => p[4])], q: q && q.map((x) => [x.wall, x.E, x.ya, x.y1]) }));
      ok(`C: …it hangs at the 8 ft plate, under an eave that stands higher (${what})`, !!q && q[0].ya === 8 && q[0].E > 8.01 && q[0].mode === null,
        JSON.stringify(q && q.map((x) => [x.E, x.ya, x.y1, x.mode])));
      await page.evaluate(() => window.__ss3dPanel.render());
      await page.screenshot({ path: join(SHOTS, `c-converted-${value}.png`) });
    }
    ok("C: zero page errors", errors.length === 0, JSON.stringify(errors.slice(0, 3)));
  } catch (e) { ok("C: ran", false, e && e.stack); await page.screenshot({ path: join(SHOTS, "c-failure.png") }).catch(() => {}); }
  await c.close();
}

// ── P · THE CALIBRATION PANEL ──────────────────────────────────────────────────────────────────
if (want("P")) {
  const LISTED = { roof: { type: "gable", pitch: 0.4, overhang: 0.6, leanTos: [{ wall: "left", widthFt: 6 }, { wall: "front", widthFt: 5, enclosed: true, lengthFt: 6 }] }, siding: "batten", colors: COLORS, wallHeightFt: 8 };
  const styles = [
    { value: "hlisted", label: "Harness Listed", img: null, sizes: ["12x16"], sizeInclusions: {}, sizeInclusionQty: {}, d3: LISTED },
    { value: "hsingle", label: "Harness Single", img: null, sizes: ["12x16"], sizeInclusions: {}, sizeInclusionQty: {}, d3: SINGLE_D3 },
  ];
  const config = { ...configFor("x", "12x16", {}), clientId: "harness-leantos-panel", buildingStyles: styles,
    sizePricing: Object.fromEntries(styles.map((s) => [s.value, { "12x16": { widthFt: 12, lengthFt: 16, basePrice: 9000 } }])) };
  const page = await ctx.newPage();
  const errors = collectErrors(page);
  const calls = await stubSupabase(page, { config, fixtures: FIXTURES });
  try {
    await page.goto(`${BASE}/?client=${encodeURIComponent(config.clientId)}&admin=1`, { waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => window.__ssAppBooted === true && typeof window.StructureStudio === "function", null, { timeout: 60000 });
    await page.getByText("3D Style Calibration").first().waitFor({ state: "visible", timeout: 30000 });
    await page.getByPlaceholder("Admin password").fill("harness");
    await page.getByRole("button", { name: "Harness Listed", exact: true }).first().click();
    await settle(page, 800);
    const note = page.locator("[data-ss-leantos-note]");
    ok("P: a style with a lean-to list says so instead of the single lean-to's boxes", (await note.count()) === 1 && (await note.innerText()).trim() === "This style has 2 lean-tos, set on the Advanced page."
      && (await page.getByText("Lean-to width (ft, 0 = none)").count()) === 0, (await note.count()) ? await note.innerText() : "no note");
    await page.getByRole("button", { name: "Save to config" }).click();
    const t0 = Date.now();
    const saves = () => calls.filter((x) => x.path && x.path.endsWith("/functions/v1/admin-save-settings") && x.body && x.body.action === "save_style_d3");
    while (!saves().length && Date.now() - t0 < 15000) await settle(page, 150);
    const body = saves()[0] && saves()[0].body;
    ok("P: …and saves the list untouched", !!body && JSON.stringify(body.d3.roof.leanTos) === JSON.stringify(LISTED.roof.leanTos), body && JSON.stringify(body.d3.roof.leanTos));
    await page.getByRole("button", { name: "Harness Single", exact: true }).first().click();
    await settle(page, 800);
    ok("P: a style with the single lean-to still shows its boxes, and no note", (await page.getByText("Lean-to width (ft, 0 = none)").count()) === 1 && (await page.locator("[data-ss-leantos-note]").count()) === 0);
    ok("P: zero page errors", errors.length === 0, JSON.stringify(errors.slice(0, 3)));
  } catch (e) { ok("P: ran", false, e && e.stack); }
  await page.close();
}

// ── J · TWO LEAN-TOS THAT MEET AT A CORNER (d3CornerJoins, 2026-10-04) ──────────────────────────────
// 12x16, the old frame: the right wall is a side wall (u = 6, along z 0..16) and the front an end wall (z =
// 16, across u -6..6). Each lean-to 8 ft wide meeting at the 8 ft plate, 1 ft drop: they join at the
// front-right corner, the hip from (6, 16) out to past (14, 24), the outer corner post at (14, 24).
const J_ROOF = { type: "gable", pitch: 0.4, overhang: 0.6 };
const jCase = (leanTos, extra) => ({ roof: { ...J_ROOF, ...(extra || {}), leanTos }, siding: "batten", colors: COLORS, wallHeightFt: 8, roofMaterial: "metal" });
// Which side of join J's hip a point is on, across the plan (+ the end-wall lean-to's side, - the side-wall one's).
const hipSide = (J, v) => J.sz * (v[2] - J.zC) - J.dir * (v[0] - J.uC);
const ctr = (b) => [(b.mn[0] + b.mx[0]) / 2, (b.mn[1] + b.mx[1]) / 2, (b.mn[2] + b.mx[2]) / 2];
// A world eye and target from the building's frame (world x = u, world z = z - L/2 on 12x16).
const jEye = (u, y, z) => [u, y, z - 8];
if (want("J")) {
  // J1: an open pair. One roof: each slab stays on its own side of the hip, and the two cut faces are the
  // same face (the top faces meet on the hip line, no gap, no overlap); one corner post; the side-wall
  // header runs through to the end-wall header's outer face and that one butts into it; one hip cap.
  try {
    const { page, errors } = await openCase(ctx, "Harness Joined Open", "12x16", jCase([{ wall: "right", widthFt: 8 }, { wall: "front", widthFt: 8 }]));
    const m = await page.evaluate(JOINED, "__ss3dEngine");
    const J = m.corners && m.corners.joins[0];
    ok("J1: the right and front lean-tos join at the front-right corner, and nothing is a near-miss",
      !!J && m.corners.joins.length === 1 && J.at === "front-right" && J.i === 0 && J.j === 1 && m.corners.near.length === 0 && near(J.post[0], 14, 1e-9) && near(J.post[1], 24, 1e-9),
      JSON.stringify(m.corners && m.corners.joins.map((x) => [x.at, x.i, x.j, x.post])));
    const A = m.by["0"], B = m.by["1"];
    const crossA = A.slab ? Math.max(...A.slab.map((v) => hipSide(J, v))) : NaN, crossB = B.slab ? Math.max(...B.slab.map((v) => -hipSide(J, v))) : NaN;
    ok("J1: no slab vertex crosses the hip: the side wall's stays on its side, the end wall's on its own (within 0.005 ft)", crossA <= 0.005 && crossB <= 0.005, `${f3(crossA)} ${f3(crossB)}`);
    const onHip = (vs) => [...new Set(vs.filter((v) => Math.abs(hipSide(J, v)) < 1e-4).map((v) => v.map((c) => Math.round(c * 1000) / 1000).join(",")))].sort();
    const hA = onHip(A.slab || []), hB = onHip(B.slab || []);
    ok("J1: …and the two cut faces are one face: the same corners on the hip from both slabs (no gap, no overlap)", hA.length >= 4 && JSON.stringify(hA) === JSON.stringify(hB), JSON.stringify({ hA, hB }));
    ok("J1: …the free ends are today's: the side wall's past z 0 by the overhang, the end wall's past u -6", !!A.slabBox && near(A.slabBox.mn[2], -0.6, 0.002) && !!B.slabBox && near(B.slabBox.mn[0], -6.6, 0.002),
      JSON.stringify([A.slabBox, B.slabBox]));
    const cps = [...A.cornerPosts, ...B.cornerPosts];
    ok("J1: one post at the outer corner (14, 24), on the ground up to the 7 ft edge", cps.length === 1 && near(ctr(cps[0])[0], 14, 0.2) && near(ctr(cps[0])[2], 24, 0.2) && near(cps[0].mn[1], 0) && near(cps[0].mx[1], 7),
      JSON.stringify(cps));
    ok("J1: …the side wall's own posts run from its free end to it (3, at u 14, z 0.8..16.3), the end wall's (3, at z 24, u -5.2..7.6), none at the corner",
      A.posts.length === 3 && A.posts.every((p) => near(ctr(p)[0], 14) && ctr(p)[2] > 0.7 && ctr(p)[2] < 17) && B.posts.length === 3 && B.posts.every((p) => near(ctr(p)[2], 24) && ctr(p)[0] > -5.3 && ctr(p)[0] < 8),
      JSON.stringify([A.posts.map((p) => ctr(p).map(f3)), B.posts.map((p) => ctr(p).map(f3))]));
    const ha = A.headers[0], hb = B.headers[0];
    ok("J1: the side wall's header runs through to z 24.175 (the end wall header's outer face); the end wall's stops at u 13.825 (its inner face)",
      A.headers.length === 1 && B.headers.length === 1 && near(ha.mn[2], 0, 0.002) && near(ha.mx[2], 24.175, 0.002) && near(ha.mn[0], 13.825, 0.002)
        && near(hb.mn[0], -6, 0.002) && near(hb.mx[0], 13.825, 0.002) && near(hb.mx[2], 24.175, 0.002), JSON.stringify([ha, hb]));
    const hips = [...A.hips, ...B.hips];
    ok("J1: one hip cap, a strip on each slab, from the corner out to the eave", hips.length === 2 && hips.every((h) => JSON.stringify(h.of) === "[0,1]") && hips.every((h) => h.mn[0] < 6.5 && h.mx[0] > 14.3),
      JSON.stringify(hips));
    ok("J1: zero page errors", errors.length === 0, JSON.stringify(errors.slice(0, 3)));
    await aimShot(page, "__ss3dEngine", join(SHOTS, "j1-joined-open-pair.png"), jEye(30, 15, 38), jEye(7, 4, 14));
    await aimShot(page, "__ss3dEngine", join(SHOTS, "j1-joined-open-pair-corner.png"), jEye(20, 10.5, 29), jEye(10, 6.5, 19));
    await page.close();
  } catch (e) { ok("J1: ran", false, e && e.stack); }

  // J2: an enclosed pair. 4 walls, not 6: the side wall's outer wall runs on round the corner to the end
  // wall's outer face, the end wall's stops at the side wall's inner face, the two corner end walls are
  // left out, and one corner board stands at the outer corner.
  try {
    const { page, errors } = await openCase(ctx, "Harness Joined Enclosed", "12x16", jCase([{ wall: "right", widthFt: 8, enclosed: true }, { wall: "front", widthFt: 8, enclosed: true }]));
    const m = await page.evaluate(JOINED, "__ss3dEngine");
    const A = m.by["0"], B = m.by["1"];
    ok("J2: joined at the front-right corner", !!(m.corners && m.corners.joins.length === 1 && m.corners.joins[0].at === "front-right"), JSON.stringify(m.corners));
    ok("J2: 4 walls instead of 6, no posts at all", A.walls.length + B.walls.length === 4 && A.posts.length + B.posts.length + A.cornerPosts.length + B.cornerPosts.length === 0,
      JSON.stringify({ walls: [A.walls.length, B.walls.length], posts: [A.posts.length, B.posts.length] }));
    const oA = A.walls.find((w) => w.mx[2] - w.mn[2] > 10), oB = B.walls.find((w) => w.mx[0] - w.mn[0] > 10);
    ok("J2: the side wall's outer wall runs z 0..24.15 at u 14; the end wall's runs u -6..13.85 at z 24, both from the ground to the 7 ft edge",
      !!oA && near(oA.mn[2], 0, 0.002) && near(oA.mx[2], 24.15, 0.002) && near(ctr(oA)[0], 14, 0.002) && !!oB && near(oB.mn[0], -6, 0.002) && near(oB.mx[0], 13.85, 0.002) && near(ctr(oB)[2], 24, 0.002)
        && [oA, oB].every((w) => near(w.mn[1], 0) && near(w.mx[1], 7)), JSON.stringify([oA, oB]));
    const cb = [...A.cornerBoards, ...B.cornerBoards];
    ok("J2: one corner board at the outer corner (14, 24), and the free ends keep theirs (one each)",
      cb.length === 1 && near(ctr(cb[0])[0], 14, 0.01) && near(ctr(cb[0])[2], 24, 0.01) && A.boards.length === 1 && B.boards.length === 1, JSON.stringify({ cb, a: A.boards, b: B.boards }));
    ok("J2: zero page errors", errors.length === 0, JSON.stringify(errors.slice(0, 3)));
    await aimShot(page, "__ss3dEngine", join(SHOTS, "j2-joined-enclosed-pair.png"), jEye(30, 15, 38), jEye(7, 4, 14));
    await page.close();
  } catch (e) { ok("J2: ran", false, e && e.stack); }

  // J3: a near-miss (the front one's drop 3 in more) joins nothing, and each is built exactly as it is alone.
  try {
    const pair = await openCase(ctx, "Harness Near Miss", "12x16", jCase([{ wall: "right", widthFt: 8 }, { wall: "front", widthFt: 8, dropFt: 1.25 }]));
    const sp = await pair.page.evaluate(SCENE, "__ss3dEngine");
    await pair.page.close();
    const a = await openCase(ctx, "Harness Right Alone", "12x16", jCase([{ wall: "right", widthFt: 8 }]));
    const sa = await a.page.evaluate(SCENE, "__ss3dEngine");
    await a.page.close();
    const b = await openCase(ctx, "Harness Front Alone", "12x16", jCase([{ wall: "front", widthFt: 8, dropFt: 1.25 }]));
    const sb = await b.page.evaluate(SCENE, "__ss3dEngine");
    await b.page.close();
    ok("J3: a 3 in difference in drop joins nothing: one near-miss at the front-right corner, by its outer edge",
      !!sp.corners && sp.corners.joins.length === 0 && sp.corners.near.length === 1 && sp.corners.near[0].at === "front-right" && JSON.stringify(sp.corners.near[0].why) === '["drop"]' && near(sp.corners.near[0].d1, -0.25, 1e-9),
      JSON.stringify(sp.corners));
    const same = (x, y) => !!x && !!y && JSON.stringify(x.slab) === JSON.stringify(y.slab) && JSON.stringify(x.posts) === JSON.stringify(y.posts) && JSON.stringify(x.header) === JSON.stringify(y.header) && x.n === y.n && x.hips === 0;
    ok("J3: …and each lean-to is built exactly as it is alone: its slab, posts and header to 1/1000 ft", same(sp.by["0"], sa.by["0"]) && same(sp.by["1"], sb.by["0"]),
      JSON.stringify([sp.by["0"] && sp.by["0"].slab, sa.by["0"] && sa.by["0"].slab, sp.by["1"] && sp.by["1"].slab, sb.by["0"] && sb.by["0"].slab]));
    ok("J3: zero page errors", [pair, a, b].every((x) => x.errors.length === 0), JSON.stringify([...pair.errors, ...a.errors, ...b.errors].slice(0, 3)));
  } catch (e) { ok("J3: ran", false, e && e.stack); }

  // J4: a wrap round three sides: left, front and right, each 8 ft. The front one joins at both its ends;
  // its posts stand only between the two corner posts.
  try {
    const { page, errors } = await openCase(ctx, "Harness Wrap Three Sides", "12x16", jCase([{ wall: "left", widthFt: 8 }, { wall: "front", widthFt: 8 }, { wall: "right", widthFt: 8 }]));
    const m = await page.evaluate(JOINED, "__ss3dEngine");
    const js = m.corners ? m.corners.joins : [];
    ok("J4: two joins, front-left and front-right, the front lean-to joined at both its ends",
      js.length === 2 && JSON.stringify(js.map((x) => [x.at, x.i, x.j])) === JSON.stringify([["front-left", 0, 1], ["front-right", 2, 1]]) && JSON.stringify(m.corners.ends["1"]) === JSON.stringify({ a0: 0, a1: 1 }),
      JSON.stringify(m.corners && { joins: js.map((x) => [x.at, x.i, x.j]), ends: m.corners.ends }));
    const F = m.by["1"], cps = [...m.by["0"].cornerPosts, ...m.by["2"].cornerPosts, ...F.cornerPosts];
    ok("J4: two corner posts, at (-14, 24) and (14, 24)", cps.length === 2 && cps.some((p) => near(ctr(p)[0], -14, 0.2) && near(ctr(p)[2], 24, 0.2)) && cps.some((p) => near(ctr(p)[0], 14, 0.2) && near(ctr(p)[2], 24, 0.2)),
      JSON.stringify(cps.map(ctr)));
    ok("J4: the front one's own posts only between them (3 across the 28 ft, 7 ft apart), its header from one side header's inner face to the other's",
      F.posts.length === 3 && F.posts.every((p) => ctr(p)[0] > -13.5 && ctr(p)[0] < 13.5 && near(ctr(p)[2], 24)) && F.headers.length === 1 && near(F.headers[0].mn[0], -13.825, 0.002) && near(F.headers[0].mx[0], 13.825, 0.002),
      JSON.stringify({ posts: F.posts.map((p) => f3(ctr(p)[0])), hdr: F.headers }));
    ok("J4: two hip caps, two strips each", [m.by["0"], F, m.by["2"]].reduce((t, g) => t + g.hips.length, 0) === 4);
    const crosses = js.map((J) => {
      const side = m.by[String(J.i)], end = m.by[String(J.j)];
      // The end-wall slab is cut at both its ends, each by its own hip: measure it only near this corner.
      const nearC = (v) => J.dir * (v[0] - J.uC) > -2;
      return [Math.max(...side.slab.filter(nearC).map((v) => hipSide(J, v))), Math.max(...end.slab.filter(nearC).map((v) => -hipSide(J, v)))];
    });
    ok("J4: at each corner each slab stays on its own side of that corner's hip", crosses.every(([x, y]) => x <= 0.005 && y <= 0.005), JSON.stringify(crosses));
    ok("J4: zero page errors", errors.length === 0, JSON.stringify(errors.slice(0, 3)));
    await aimShot(page, "__ss3dEngine", join(SHOTS, "j4-wrap-three-sides.png"), jEye(-4, 22, 46), jEye(0, 3, 12));
    await aimShot(page, "__ss3dEngine", join(SHOTS, "j4-wrap-three-sides-left.png"), jEye(-34, 16, 36), jEye(-3, 4, 12));
    await page.close();
  } catch (e) { ok("J4: ran", false, e && e.stack); }

  // J6: a projecting porch on the front, and a joined pair at the back-right corner: built with no errors.
  try {
    const { page, errors } = await openCase(ctx, "Harness Joined With Porch", "12x16", jCase([{ wall: "right", widthFt: 8 }, { wall: "back", widthFt: 8 }], { porchOutFt: 6, porchEnd: "front" }));
    const m = await page.evaluate(JOINED, "__ss3dEngine");
    ok("J6: a projecting porch and a pair joined at the back-right corner build together", m.porch && !!m.corners && m.corners.joins.length === 1 && m.corners.joins[0].at === "back-right",
      JSON.stringify(m.corners && m.corners.joins.map((x) => x.at)));
    ok("J6: zero page errors", errors.length === 0, JSON.stringify(errors.slice(0, 3)));
    await aimShot(page, "__ss3dEngine", join(SHOTS, "j6-porch-and-joined-pair.png"), jEye(30, 16, -22), jEye(4, 3, 4));
    await page.close();
  } catch (e) { ok("J6: ran", false, e && e.stack); }

  // J5: the Advanced page says it on both cards; a drop changed by 3 in turns the words into a near-miss with
  // the number, on both.
  const { c, page, errors } = await openPortal("/portal/advanced");
  try {
    await page.getByText("Every shape control on one building").first().waitFor({ state: "visible", timeout: 60000 }).catch(() => {});
    await page.locator('[data-ss-adv-sec="leanto"]').click();
    await settle(page, 300);
    await page.locator('[data-ss-adv-f="leanToAdd"]').click();
    await panelWait(page, "(M) => !!(M.leanTos && M.leanTos.length === 1)");
    await page.locator('[data-ss-adv-f="leanToAdd"]').click();
    await panelWait(page, "(M) => !!(M.leanTos && M.leanTos.length === 2)");
    await segIn(page, 1, "Wall", "Front").click();
    await panelWait(page, "(M) => !!(M.leanToCorners && M.leanToCorners.joins.length === 1)");
    await settle(page, 300);
    const words = async (i) => (await card(page, i).locator("[data-ss-leanto-corner]").allInnerTexts()).map((t) => t.replace(/ /g, " ").trim());
    const kinds = async (i) => card(page, i).locator("[data-ss-leanto-corner]").evaluateAll((els) => els.map((e) => e.getAttribute("data-ss-leanto-corner")));
    const w0 = await words(0), w1 = await words(1);
    ok("J5: both cards say they meet, around the front-right corner",
      JSON.stringify(w0) === JSON.stringify(["Meets lean-to 2 around the front-right corner: one roof, a hip and one corner post."])
        && JSON.stringify(w1) === JSON.stringify(["Meets lean-to 1 around the front-right corner: one roof, a hip and one corner post."])
        && JSON.stringify(await kinds(0)) === '["joined"]' && JSON.stringify(await kinds(1)) === '["joined"]', JSON.stringify({ w0, w1 }));
    await card(page, 1).scrollIntoViewIfNeeded();
    await settle(page, 400);
    console.log("aim", JSON.stringify(await aimDock(page, [0.9, 0.6, 1], [3, 3, 4])));
    await settle(page, 300);
    await page.evaluate(() => window.__ss3dPanel.render());
    await page.screenshot({ path: join(SHOTS, "j5-advanced-joined.png") });
    await typeIn(page, 1, "Outer edge drop (ft)", 1.25);
    await panelWait(page, "(M) => !!(M.leanToCorners && M.leanToCorners.joins.length === 0 && M.leanToCorners.near.length === 1)");
    await settle(page, 300);
    const n0 = await words(0), n1 = await words(1);
    ok("J5: a drop 3 in more on lean-to 2: the joined words are gone, and each card says by how much the other differs",
      JSON.stringify(n0) === JSON.stringify(["Lean-to 2 also reaches the front-right corner, but its outer edge is 3\" lower, so the two roofs run past each other. Give both the same width, the same height at the wall and the same outer-edge height to run one roof around it."])
        && JSON.stringify(n1) === JSON.stringify(["Lean-to 1 also reaches the front-right corner, but its outer edge is 3\" higher, so the two roofs run past each other. Give both the same width, the same height at the wall and the same outer-edge height to run one roof around it."])
        && JSON.stringify(await kinds(0)) === '["near"]', JSON.stringify({ n0, n1 }));
    await typeIn(page, 1, "Outer edge drop (ft)", 1);
    await panelWait(page, "(M) => !!(M.leanToCorners && M.leanToCorners.joins.length === 1)");
    ok("J5: …and set back to 1 ft they meet again", (await page.locator('[data-ss-leanto-corner="joined"]').count()) === 2);
    ok("J5: zero page errors", errors.length === 0, JSON.stringify(errors.slice(0, 3)));
  } catch (e) { ok("J5: ran", false, e && e.stack); await page.screenshot({ path: join(SHOTS, "j5-failure.png") }).catch(() => {}); }
  await c.close();
}

// ── M · A LEAN-TO THAT MEETS THE PORCH (d3PorchJoins, 2026-10-05) ──────────────────────────────────────────
// 12x16, front a gable end, a projecting porch across it 8 ft deep, hung at 7' 6" and asked 2 in 12 (which the 6 ft
// under its beam lowers to about 1.15 in 12). Each lean-to's boxes are set to what its card says matches the porch
// (d3LeanTosReadout's porchCorner.fix). In the building's frame the front-right corner is (6, 8): s out from the
// right wall along x, d out from the front wall along z, f = d - s (+ the porch's side of the hip).
const M_ROOF = { type: "gable", front: "gable", pitch: 0.4, overhang: 0.6, eave: "fascia", porchOutFt: 8, porchAttachFt: 7.5, porchPitch: 2 / 12 };
const mCase = (leanTos) => {
  const d3 = { roof: { ...M_ROOF, leanTos }, siding: "batten", colors: COLORS, wallHeightFt: 8, roofMaterial: "metal" };
  const rs = purePorch().d3LeanTosReadout(d3, "12x16") || [];
  return { ...d3, roof: { ...d3.roof, leanTos: leanTos.map((e, i) => {
    const f = rs[i] && rs[i].porchCorner && rs[i].porchCorner.fix;
    return f ? { ...e, attach: f.attach || undefined, attachFt: f.attach ? f.attachFt : undefined, dropFt: f.dropFt } : e;
  }) } };
};
// Every lean-to member and the porch's sheet and posts, in the corner's frame, against the roof plane the two share
// (T(t) = Y0 - pitch * t, t the distance out from each one's own wall): its highest point over that plane.
const MEETS = (engine) => {
  const E = window[engine], M = E.model, V = E.camera.position.constructor;
  E.scene.updateMatrixWorld(true);
  const J = M.leanToPorch && M.leanToPorch.joins[0];
  if (!J) return { J: null, ltp: M.leanToPorch ? JSON.parse(JSON.stringify(M.leanToPorch)) : null };
  const Y0 = J.hip[0][2], p = J.pitch;
  const fr = (v) => ({ s: v.x - 6, d: v.z - 8 });
  const rng = (o, own) => {
    const r = { s: [Infinity, -Infinity], d: [Infinity, -Infinity], y: [Infinity, -Infinity], f: [Infinity, -Infinity], over: -Infinity };
    const pos = o.geometry.attributes.position, v = new V();
    for (let k = 0; k < pos.count; k++) {
      v.fromBufferAttribute(pos, k).applyMatrix4(o.matrixWorld);
      const { s, d } = fr(v);
      [["s", s], ["d", d], ["y", v.y], ["f", d - s]].forEach(([key, x]) => { r[key][0] = Math.min(r[key][0], x); r[key][1] = Math.max(r[key][1], x); });
      if (own) r.over = Math.max(r.over, v.y - (Y0 - p * own(v)));
    }
    return r;
  };
  const by = {};
  let sheet = null;
  M.root.traverse((q) => {
    if (!q.isMesh || !q.userData) return;
    const u = q.userData;
    if (u.ssPorchPart === "slab") sheet = rng(q, (v) => fr(v).d);
    if (u.ssLeanTo === undefined) return;
    const g = by[u.ssLeanTo] || (by[u.ssLeanTo] = { slab: null, hips: [], posts: [], corner: [], headers: [], walls: [], boards: [] });
    // Each lean-to's own distance out from its wall: the right one along +x, the back one along -z.
    const own = u.ssLeanTo === 0 ? (v) => fr(v).s : (v) => -8 - v.z;
    if (u.ssLeanToHip) g.hips.push({ of: u.ssLeanToHip, ...rng(q) });
    else if (u.ssLeanToSlab) g.slab = rng(q, own);
    else if (u.ssLeanToPost) (u.ssLeanToCorner ? g.corner : g.posts).push(rng(q));
    else if (u.ssLeanToWall) g.walls.push(rng(q));
    else if (u.ssLeanToStand) (u.ssLeanToCorner ? g.corner : g.boards).push(rng(q));
    else g.headers.push(rng(q));
  });
  const joinPosts = [];
  M.root.traverse((q) => { if (q.isMesh && q.userData && q.userData.ssPorchPart === "joinCorner") joinPosts.push(rng(q)); });
  return { J: JSON.parse(JSON.stringify(J)), ltp: JSON.parse(JSON.stringify(M.leanToPorch)), lc: M.leanToCorners ? JSON.parse(JSON.stringify(M.leanToCorners)) : null,
    by, sheet, joinPosts, porch: { dPost: M.porch.dPost, hdrTop: M.porch.hdrTop, yHigh: M.porch.yHigh, join: M.porch.join || null } };
};
const mid = (r, k) => (r[k][0] + r[k][1]) / 2;
if (want("M")) {
  // M1: open, as wide as the porch is deep.
  try {
    const { page, errors } = await openCase(ctx, "Harness Meets Porch", "12x16", mCase([{ wall: "right", widthFt: 8, meetPorch: true }]));
    const m = await page.evaluate(MEETS, "__ss3dEngine");
    const J = m.J, A = m.by["0"];
    ok("M1: the right lean-to meets the porch at the front-right corner", !!J && m.ltp.joins.length === 1 && J.at === "front-right" && J.i === 0 && J.js === 1 && JSON.stringify(m.porch.join) === '[{"i":0,"at":"front-right","js":1}]',
      JSON.stringify(m.ltp));
    if (!J) throw new Error("no join");
    ok("M1: its slab stays on its side of the hip, and stops on the porch's front edge (8.3 ft out, before its own 8.6)", !!A.slab && A.slab.f[1] <= 0.005 && near(A.slab.d[1], J.eP, 0.005),
      A.slab && JSON.stringify({ f: A.slab.f.map(f3), d: A.slab.d.map(f3) }));
    ok("M1: its top and the porch sheet's lie on the one roof plane they share (the lean-to rebuilt the porch's way): no point over it, both touching it",
      !!A.slab && !!m.sheet && Math.abs(A.slab.over) < 0.002 && Math.abs(m.sheet.over) < 0.002, JSON.stringify({ lean: A.slab && f3(A.slab.over), porch: m.sheet && f3(m.sheet.over) }));
    ok("M1: its posts run along its outer line (8 ft out) from its free end to short of the porch's corner post: 3, up to its edge",
      A.posts.length === 3 && A.posts.every((q) => near(mid(q, "s"), 8, 0.01) && q.d[1] < J.dPost - 1 && near(q.y[1], J.y1, 0.002)) && A.corner.length === 0,
      JSON.stringify(A.posts.map((q) => [f3(mid(q, "s")), f3(mid(q, "d")), f3(q.y[1])])));
    ok("M1: one corner post, the porch's, where the two posts' lines cross (8, 7.77)", m.joinPosts.length === 1 && near(mid(m.joinPosts[0], "s"), 8, 0.005) && near(mid(m.joinPosts[0], "d"), J.dPost, 0.005),
      JSON.stringify(m.joinPosts.map((q) => [f3(mid(q, "s")), f3(mid(q, "d"))])));
    ok("M1: its header runs level along its outer line, from its free end to the porch header's inner face (7.625), its top at its edge",
      A.headers.length === 1 && near(A.headers[0].d[0], -16, 0.005) && near(A.headers[0].d[1], J.hdrIn, 0.005) && near(A.headers[0].y[1], J.y1, 0.002),
      JSON.stringify(A.headers.map((q) => ({ d: q.d.map(f3), y: q.y.map(f3) }))));
    ok("M1: its half of the hip's cap, tagged [0, \"porch\"]", A.hips.length === 1 && JSON.stringify(A.hips[0].of) === '[0,"porch"]' && A.hips[0].f[1] <= 0.06 * Math.SQRT2 + 0.005, JSON.stringify(A.hips));
    ok("M1: zero page errors", errors.length === 0, JSON.stringify(errors.slice(0, 3)));
    await aimShot(page, "__ss3dEngine", join(SHOTS, "m1-meets-porch.png"), [30, 15, 30], [7, 4.5, 9]);
    await aimShot(page, "__ss3dEngine", join(SHOTS, "m1-meets-porch-corner.png"), [21, 10, 22], [11, 6, 12]);
    await page.close();
  } catch (e) { ok("M1: ran", false, e && e.stack); }

  // M2: 5 ft wide, the porch the deeper: the header level to the hip, then down the porch roof's slope.
  try {
    const { page, errors } = await openCase(ctx, "Harness Meets Porch Narrow", "12x16", mCase([{ wall: "right", widthFt: 5, meetPorch: true }]));
    const m = await page.evaluate(MEETS, "__ss3dEngine");
    const J = m.J, A = m.by["0"];
    ok("M2: joined, the lean-to's eave (5.6 ft out) before the porch's front edge (8.3)", !!J && J.eL < J.eP && near(A.slab.f[1], 0, 0.005) && near(A.slab.d[1], J.eL, 0.03), J && JSON.stringify({ eL: J.eL, eP: J.eP, d: A.slab.d }));
    const lvl = A.headers.find((q) => q.y[1] - q.y[0] < 0.51), slope = A.headers.find((q) => q.y[1] - q.y[0] >= 0.51);
    ok("M2: its header level to where the hip crosses its outer line (5 ft out), then a piece down the porch roof's slope to the porch's header (7.625)",
      A.headers.length === 2 && !!lvl && near(lvl.d[1], 5, 0.005) && !!slope && near(slope.d[1], J.hdrIn, 0.005) && slope.y[1] < lvl.y[1] + 0.001 && near(slope.y[0], J.y1 - J.pitch * (J.hdrIn - 5) - 0.5 * Math.cos(Math.atan(J.pitch)), 0.002),
      JSON.stringify(A.headers.map((q) => ({ d: q.d.map(f3), y: q.y.map(f3) }))));
    ok("M2: ...and it stays under the porch's ceiling there (its top under the porch roof plane by at least the roof's thickness)",
      !!slope && slope.y[1] <= J.hip[0][2] - J.pitch * 5 - 0.16, JSON.stringify(slope));
    ok("M2: zero page errors", errors.length === 0, JSON.stringify(errors.slice(0, 3)));
    await aimShot(page, "__ss3dEngine", join(SHOTS, "m2-meets-porch-narrow.png"), [28, 13, 30], [6, 5, 10]);
    await page.close();
  } catch (e) { ok("M2: ran", false, e && e.stack); }

  // M3: enclosed, it keeps all its walls; a header runs from its corner board to the corner post.
  try {
    const { page, errors } = await openCase(ctx, "Harness Meets Porch Enclosed", "12x16", mCase([{ wall: "right", widthFt: 8, enclosed: true, meetPorch: true }]));
    const m = await page.evaluate(MEETS, "__ss3dEngine");
    const J = m.J, A = m.by["0"];
    ok("M3: joined, with all three of its walls and both corner boards, on the ground", !!J && A.walls.length === 3 && A.boards.length === 2 && A.posts.length === 0, JSON.stringify({ walls: A.walls.length, boards: A.boards.length, posts: A.posts.length }));
    ok("M3: its outer wall stops at the porch's wall line, under its roof", A.walls.some((w) => near(w.d[1], 0, 0.005) && w.y[1] <= J.y1 + 0.002 + 1e-6),
      JSON.stringify(A.walls.map((w) => ({ d: w.d.map(f3), y: w.y.map(f3) }))));
    ok("M3: a header from its corner board's outer face (0.03 ft past the wall line) on to the porch header's inner face",
      A.headers.length === 1 && near(A.headers[0].d[0], 0.03, 0.005) && near(A.headers[0].d[1], J.hdrIn, 0.005) && near(A.headers[0].y[1], J.y1, 0.002), JSON.stringify(A.headers));
    ok("M3: zero page errors", errors.length === 0, JSON.stringify(errors.slice(0, 3)));
    await aimShot(page, "__ss3dEngine", join(SHOTS, "m3-meets-porch-enclosed.png"), [30, 15, 30], [7, 4.5, 9]);
    await page.close();
  } catch (e) { ok("M3: ran", false, e && e.stack); }

  // M4: a wrap round the back too: the right lean-to meets the porch, and a back one (the same numbers) meets it
  // round the back-right corner. Both on the porch roof's plane, and so is their corner post.
  try {
    // The back one with the right one's numbers, which the card set to match the porch.
    const right = mCase([{ wall: "right", widthFt: 8, meetPorch: true }]);
    const { meetPorch: _m, ...back } = right.roof.leanTos[0];
    const { page, errors } = await openCase(ctx, "Harness Meets Porch And Back", "12x16", { ...right, roof: { ...right.roof, leanTos: [right.roof.leanTos[0], { ...back, wall: "back" }] } });
    const m = await page.evaluate(MEETS, "__ss3dEngine");
    const J = m.J, A = m.by["0"], B = m.by["1"];
    ok("M4: the porch join at the front-right, and the two lean-tos joined at the back-right", !!J && !!m.lc && m.lc.joins.length === 1 && m.lc.joins[0].at === "back-right" && J.at === "front-right",
      JSON.stringify({ porch: J && J.at, lc: m.lc && m.lc.joins.map((x) => x.at) }));
    ok("M4: both lean-tos' tops on the porch roof's plane", !!A.slab && !!B.slab && Math.abs(A.slab.over) < 0.002 && Math.abs(B.slab.over) < 0.002, JSON.stringify({ a: A.slab && f3(A.slab.over), b: B.slab && f3(B.slab.over) }));
    const cp = [...A.corner, ...B.corner];
    ok("M4: their corner post at the back-right stands up to the edge both share (the porch's plane, 8 ft out)", cp.length === 1 && near(cp[0].y[1], J.y1, 0.002), JSON.stringify(cp.map((q) => q.y.map(f3))));
    ok("M4: zero page errors", errors.length === 0, JSON.stringify(errors.slice(0, 3)));
    await aimShot(page, "__ss3dEngine", join(SHOTS, "m4-meets-porch-and-back.png"), [30, 16, -24], [6, 5, -2]);
    await page.close();
  } catch (e) { ok("M4: ran", false, e && e.stack); }

  // M5: the Advanced page.
  const { c, page, errors, calls } = await openPortal("/portal/advanced");
  try {
    await page.getByText("Every shape control on one building").first().waitFor({ state: "visible", timeout: 60000 }).catch(() => {});
    // A projecting porch across the front, 8 ft deep, its roof hung at 7' 6" at 1 in 12 (which leaves 6 ft under its beam).
    await page.locator('[data-ss-adv-sec="porch"]').click();
    await settle(page, 300);
    await page.locator('[data-ss-adv-f="porchKind"] [data-ss-adv-tile="projecting"]').click();
    await settle(page, 300);
    for (const [label, v] of [["Depth (ft)", 8], ["Roof meets the wall at (ft up)", 7.5], ["Porch roof pitch", 1]]) {
      const b = page.getByLabel(label, { exact: true });
      await b.fill(String(v)); await b.press("Tab"); await settle(page, 250);
    }
    await panelWait(page, "(M) => !!(M.porch && Math.abs(M.porch.yHigh - 7.5) < 1e-9)");
    await settle(page, 300);
    const ro0 = (await page.locator('[data-ss-adv-readout="porch"]').innerText()).replace(/ /g, " ");
    // A lean-to on the right, 8 ft out, meeting at the eave.
    await page.locator('[data-ss-adv-sec="leanto"]').click();
    await settle(page, 300);
    await page.locator('[data-ss-adv-f="leanToAdd"]').click();
    await panelWait(page, "(M) => !!(M.leanTos && M.leanTos.length === 1 && M.leanToPorch)");
    const seg = card(page, 0).locator('[data-ss-adv-f="leanToMeetPorch"]');
    ok("M5: the card of a lean-to that reaches the porch's corner offers \"Meet the porch\", off", (await seg.count()) === 1
      && /It reaches the front-right corner of the porch's wall./.test(await seg.innerText()) && (await segIn(page, 0, "At the porch", "Runs past it").getAttribute("aria-pressed")) === "true",
      await seg.innerText().catch(() => ""));
    await segIn(page, 0, "At the porch", "Meet the porch").click();
    await panelWait(page, "(M) => !!(M.leanToPorch && M.leanToPorch.near.length === 1 && M.leanToPorch.near[0].asked)");
    await settle(page, 300);
    const nearT = (await card(page, 0).locator('[data-ss-leanto-porch="near"]').innerText()).replace(/ /g, " ");
    const fix = /pick "On the wall", set "How far down the wall" to ([\d.]+) and "Outer edge drop" to ([\d.]+)\./.exec(nearT);
    // The porch's height is its roof's top (7' 6", as its own card says); a lean-to's is its slab's underside, so the
    // height it meets its wall at to match is 7' 6" over the wall's line less the slab there: 7' 3.75".
    ok("M5: asked, it says what differs and by how much, and what to type", /^The porch roof meets the wall at 7' 6" and builds 1 in 12\. A lean-to's height is its roof's underside, so to run one roof with it this one meets its wall at 7'3\.75"\. This lean-to meets its wall 8\.25" higher than that, and its outer edge is 4\.25" higher than the porch roof's slope puts it, so the two roofs run past each other\. To run one roof around it, pick "On the wall"/.test(nearT) && !!fix && fix[1] === "0.69" && fix[2] === "1.35",
      nearT);
    await page.screenshot({ path: join(SHOTS, "m5-advanced-near.png") });
    await segIn(page, 0, "Meets the building", "On the wall").click();
    await settle(page, 300);
    await typeIn(page, 0, "How far down the wall (ft)", fix ? fix[1] : 0.69);
    await typeIn(page, 0, "Outer edge drop (ft)", fix ? fix[2] : 1.35);
    await panelWait(page, "(M) => !!(M.leanToPorch && M.leanToPorch.joins.length === 1)");
    await settle(page, 300);
    const joinedT = (await card(page, 0).locator('[data-ss-leanto-porch]').allInnerTexts()).map((t) => t.replace(/ /g, " "));
    ok("M5: typed as it says, the two meet: one roof round the front-right corner", JSON.stringify(joinedT) === JSON.stringify(["Meets the porch around the front-right corner: one roof with a hip, and one corner post."])
      && (await card(page, 0).locator('[data-ss-leanto-porch="joined"]').count()) === 1, JSON.stringify(joinedT));
    await card(page, 0).scrollIntoViewIfNeeded();
    await settle(page, 300);
    await aimDock(page, [0.9, 0.55, 1], [4, 3, 6]);
    await settle(page, 300);
    await page.evaluate(() => window.__ss3dPanel.render());
    await page.screenshot({ path: join(SHOTS, "m5-advanced-joined.png") });
    await page.locator('[data-ss-adv-sec="porch"]').click();
    await settle(page, 300);
    const pm = (await page.locator("[data-ss-porch-meets]").allInnerTexts()).map((t) => t.replace(/ /g, " "));
    ok("M5: the porch's card says who meets it", pm.length === 1 && /^Lean-to 1 meets it around the front-right corner: one roof with a hip./.test(pm[0]), JSON.stringify(pm));
    const ro = (await page.locator('[data-ss-adv-readout="porch"]').innerText()).replace(/ /g, " ");
    ok("M5: ...and its readout, \"or a little lower\" before (the main roof's edge could push it down), is now its exact height", /roof meets the wall at 7' 6" or a little lower/.test(ro0) && /roof meets the wall at 7' 6"/.test(ro) && !/a little lower/.test(ro), JSON.stringify([ro0, ro]));
    await page.locator('[data-ss-adv-sec="leanto"]').click();
    await settle(page, 300);
    // Save carries the ask on the lean-to.
    await page.getByLabel("New style name").fill("Harness Meets Porch");
    await page.getByRole("button", { name: "Save as a new style" }).click();
    const t0 = Date.now();
    while (!calls.some((x) => x.action === "save_style_d3") && Date.now() - t0 < 20000) await settle(page, 200);
    const sd = calls.find((x) => x.action === "save_style_d3");
    const lts = sd && sd.body.d3 && sd.body.d3.roof && sd.body.d3.roof.leanTos;
    ok("M5: Save sends the lean-to with meetPorch: true", !!lts && lts.length === 1 && lts[0].meetPorch === true && lts[0].attach === "wall", JSON.stringify(lts));
    // "Runs past it" takes the key off: no join, and the card says it would match.
    await segIn(page, 0, "At the porch", "Runs past it").click();
    await panelWait(page, "(M) => !!(M.leanToPorch && M.leanToPorch.joins.length === 0)");
    await settle(page, 300);
    const offT = (await card(page, 0).locator("[data-ss-leanto-porch]").allInnerTexts()).map((t) => t.replace(/ /g, " "));
    ok("M5: \"Runs past it\" takes the ask off: no join, and the card says it already matches",
      JSON.stringify(offT) === JSON.stringify(["It already matches the porch at the front-right corner. Pick \"Meet the porch\" to run one roof around it."]), JSON.stringify(offT));
    // A second lean-to, on the left: offered "Meet the porch" while it could meet it; set up the roof, where it never
    // can, it is not offered at all.
    await page.locator('[data-ss-adv-f="leanToAdd"]').click();
    await panelWait(page, "(M) => !!(M.leanTos && M.leanTos.length === 2)");
    await settle(page, 300);
    const seg1 = () => card(page, 1).locator('[data-ss-adv-f="leanToMeetPorch"]');
    const offered = await seg1().count();
    await segIn(page, 1, "Meets the building", "On the roof").click();
    await panelWait(page, "(M) => !!(M.leanTos && M.leanTos[1] && M.leanTos[1].mode === 'roof')");
    await settle(page, 300);
    const after = await seg1().count();
    ok("M5: a second lean-to on the left is offered \"Meet the porch\"; up the roof, where it never can, it is not", offered === 1 && after === 0, JSON.stringify({ offered, after }));
    ok("M5: zero page errors", errors.length === 0, JSON.stringify(errors.slice(0, 3)));
  } catch (e) { ok("M5: ran", false, e && e.stack); await page.screenshot({ path: join(SHOTS, "m5-failure.png") }).catch(() => {}); }
  await c.close();
}

// PW · A WING ALONG PART OF ITS WALL (roof.wingList[i].lengthFt, 2026-10-07): a 24 x 40 whose left wing runs 20 ft
// of its wall, centred (10..30), with four lean-tos: on the left wall inside the wing's stretch (drawn, off the
// wing's outer wall), on the left wall whole (past the wing's ends, into open ground: not drawn), on the back end
// wall whole (across the open corner: not drawn) and on the right wall (no wing there: drawn). The Advanced page's
// card sentence is in wingList.mjs case PWA.
if (want("PW")) {
  try {
    const d3 = { roof: { type: "gable", front: "gable", pitch: 0.5, overhang: 1, eave: "fascia", wingList: [{ wall: "left", widthFt: 8, lengthFt: 20 }], leanTos: [
      { wall: "left", widthFt: 6, dropFt: 1, lengthFt: 12, offsetFt: 2 },
      { wall: "left", widthFt: 6, dropFt: 1 },
      { wall: "back", widthFt: 5, dropFt: 1 },
      { wall: "right", widthFt: 6, dropFt: 1 },
    ] }, siding: "lap", colors: COLORS, wallHeightFt: 9, roofMaterial: "metal" };
    const { page, errors } = await openCase(ctx, "Harness Part Wing Lean-tos", "24x40", d3);
    const sc = await page.evaluate(SCENE, "__ss3dEngine");
    const L = sc.by;
    ok("PW1: the lean-to inside the wing's stretch and the right one are built, tagged 0 and 3", !!(L["0"] && L["3"]), JSON.stringify(Object.keys(L)));
    ok("PW1: the one past the wing's ends and the one across the open corner are not", !L["1"] && !L["2"], JSON.stringify(Object.keys(L)));
    ok("PW1: the list as built is those two", JSON.stringify((sc.leanTos || []).map((q) => q.i)) === "[0,3]", JSON.stringify((sc.leanTos || []).map((q) => q.i)));
    const s0 = L["0"] && L["0"].slab;
    ok("PW2: the one inside hangs off the wing's outer wall (x -12) over z -6..6 (12 ft, 2 toward the front)", !!s0 && s0.mx[0] <= -11.9 && s0.mn[0] <= -17.9 && s0.mn[2] >= -6 - 1.1 && s0.mx[2] <= 6 + 1.1 + 2,
      s0 && JSON.stringify(s0));
    await aimShot(page, "__ss3dEngine", join(SHOTS, "pw-part-wing-leantos.png"), [-40, 20, 30], [0, 5, 0]);
    ok("PW: zero page errors", errors.length === 0, JSON.stringify(errors.slice(0, 3)));
    await page.close();
  } catch (e) { ok("PW: ran", false, e && e.stack); }
}

await browser.close();
const bad = failed();
console.log(bad.length ? `\n${bad.length} check(s) FAILED` : "\nall checks passed");
console.log(`shots in ${SHOTS}`);
process.exit(bad.length ? 1 : 0);
