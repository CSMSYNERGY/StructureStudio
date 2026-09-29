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
//   P  THE CALIBRATION PANEL (?admin=1): a style with a list says "This style has 2 lean-tos, set on the
//      Advanced page." instead of the single lean-to's boxes, and saves the list untouched; a style with
//      the single lean-to still shows its boxes.
//   and zero page errors.
//
//   python -m http.server 8321 --bind 127.0.0.1 --directory <repo root>
//   SS_BASE=http://127.0.0.1:8321 SS_SHOTS=<dir> node tests/harness/leanTos.mjs     (SS_CASES=S,U,P for a subset)
//
// Exit 0 = every assertion held.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { launch, stubSupabase, collectErrors, openDesigner, reporter, shotsDir, BASE, REF, PASS_THROUGH_GET } from "./lib.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const PORTAL_HTML = readFileSync(join(ROOT, "portal.html"), "utf8");
const SHOTS = shotsDir("leanTos");
const CASES = (process.env.SS_CASES || "S,U,P").split(",");
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
    const g = by[t] || (by[t] = { n: 0, slab: null, posts: [], walls: [], corners: [], header: null, fillers: 0 });
    g.n++;
    const b = bb(q), P = q.geometry.parameters || {};
    if (q.userData.ssLeanToPost) g.posts.push(b);
    else if (q.userData.ssLeanToWall) g.walls.push(b);
    else if (q.userData.ssLeanToStand) g.corners.push(b);
    else if (q.geometry.type === "BoxGeometry" && Math.abs(P.height - 0.2) < 1e-9) g.slab = b;
    else if (q.geometry.type === "BoxGeometry") g.header = b;
    else g.fillers++;
  });
  return { by, grade: M.grade, leanTos: M.leanTos ? JSON.parse(JSON.stringify(M.leanTos)) : null, leanTo: M.leanTo ? JSON.parse(JSON.stringify(M.leanTo)) : null };
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
const PCONFIG = {
  branding: { companyName: "Harness Internal", accentColor: "#3D3672", headerBg: "#FFFFFF" },
  contactFields: [{ key: "name", label: "Name", required: true }],
  buildingStyles: [{ value: "hlean", label: "Harness Lean Cabin", sizes: [{ label: "12x16", w: 12, h: 16, price: 5000 }], d3: SINGLE_D3 }],
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
const inCard = (page, i, label) => card(page, i).getByLabel(label, { exact: true });
const segIn = (page, i, group, name) => card(page, i).getByRole("group", { name: group, exact: true }).getByRole("button", { name, exact: true });
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

await browser.close();
const bad = failed();
console.log(bad.length ? `\n${bad.length} check(s) FAILED` : "\nall checks passed");
console.log(`shots in ${SHOTS}`);
process.exit(bad.length ? 1 : 0);
