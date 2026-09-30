// STACKABLE WINGS (roof.wingList, 2026-10-01), measured off the compiled bundle's scene graph and driven
// on the Advanced page.
//
// The brief, 09-29: "they start with a core building ... add a lean-to and specify where they want it ... add
// another one ... They can add as many wings, as many lean-tos", "A wing can go on a wing", "Wherever they
// want." roof.wingList is an ordered list of wings, each on a building wall (left, right, front, back), inner
// to outer on each wall: a wing's parent is the previous entry on its wall, or the middle section. The pure
// numbers are pinned by supabase/functions/_shared/_test_stubs/wingList_test.ts. This script proves the
// SHIPPED compiled bundle builds them, and that nothing without a list moved:
//
//   D   LEGACY DIGESTS. Every legacy wing, lean-to, porch, dormer, step and plain style below builds the
//       same scene graph (world bbox at 1/1000 ft, material colours, userData up the tree) as the bundle
//       before the list existed. SS_WINGLIST_DIGEST=<file> writes, SS_WINGLIST_BASE=<file> compares; D runs
//       only when one of them is set. Write the base from a server serving the e8fd4e3 checkout.
//   D+  STORED STYLES. SS_WINGLIST_STORED=<json> ([{id, d3, firstSize}], a read-only export that stays out
//       of the repo) digested at its first size, 24x28 and 37x22. SS_WINGLIST_STORED_DIGEST=<file> writes,
//       SS_WINGLIST_STORED_BASE=<file> compares. Only counts and indexes are printed, never style data.
//   Z   JUNK. A Tri Home and a plain gable with each non-structural wingList value build exactly the style
//       without the key.
//   M   THE MIRROR. Each legacy wing style and its d3WingListFromLegacy conversion build the same geometry
//       and materials, mesh for mesh, at every size whose ridge runs the same way.
//   S   SIDE STACKS. Case S (design §3.7: 30x32, H 9, [{left,8},{left,6},{right,8}]) with every tier
//       measured against its massing record; a 3-deep chain with an "On the wall" outer tier; Case S on a
//       landscape footprint; tier 1 on the roof or on the wall with a wing on it; a wing squeezed out.
//   E   AN END WING (Case E: 24x32, [{front,8}]): the middle shortened to zB 24 and raised to 12.13, the
//       end roof falling to the south wall with rakes along both long walls, its clerestory at z 8.
//   C   COMBINED: Case S plus a front end wing and a 2-deep back end chain.
//   T   THE TRI HOME PLUS A FRONT END WING (Case T): the side wings' outer walls rise to 12 over the
//       middle's stretch and stay 9 over the end wing's.
//   SZ  EVERY SIZE x {Case S, a 3-deep chain} (+ {Case E, Case C} with end wings): finite, framed, meshes
//       for every drawn index and none for a dropped one, a build no slower than twice the Tri Home's.
//   A   THE ADVANCED PAGE (Wings tab, list mode): the add row, converting today's wings, a wing on a wing,
//       the Plan card, the push readout, Save (the list plus the older designer's approximation), Move,
//       Remove, the 16 cap, 390 px, the master switch.
//   P   THE CALIBRATION PANEL (?admin=1): a list style says so and saves its roof untouched.
//   X   THE OLDER DESIGNER (optional): SS_WINGLIST_OLD_BASE=<url of a server serving a build without the
//       list> draws A's approximation, one wing per side as wide as the stack, with no page errors.
//
// E, C, T and the end parts of SZ and A run only when the cmp twin's `const D3_WINGLIST_ENDS = true;`, or with
// SS_WINGLIST_FORCE_ENDS=1 (the R2 developer build, which sets the flag locally). PURE is the pure layer
// lifted from the cmp twin; PURE_E is the same with the flag forced true.
//
//   python -m http.server 8406 --bind 127.0.0.1 --directory <repo root>
//   SS_BASE=http://127.0.0.1:8406 node tests/harness/wingList.mjs      (SS_SHOTS=<dir> for the PNGs)
//   SS_CASES=D,Z,M,S,E,C,T,SZ,A,P,X                                    (a subset; default all but D, D+, X)
//
// Exit 0 = every assertion held.
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { launch, stubSupabase, collectErrors, openDesigner, reporter, shotsDir, buildingRect, BASE, REF, PASS_THROUGH_GET } from "./lib.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const T = 0.3;          // D3.WALL_T
const OV = 1;           // every fixture below overhangs 1 ft
const COLORS = { body: "#e9e4d8", trim: "#5b5f63", roof: "#3b4a5c", wood: "#a8703f" };
const CLADS = ["panel", "lap", "batten", "agpanel"].map((id) => ({ id, rate: 0, basis: "sqft_option", label: null, charged: false }));
const FIXTURES = {
  ramp: { mode: "simple", price: 0, method: "each", enabled: false, imageUrl: null, showImage: false },
  items: [
    { id: "d-std", name: "Harness Door", price: 1, widthIn: 36, heightIn: 78, category: "door", colorMode: "fixed", planLabel: "DR", sortOrder: 0, imageUrl: null,
      sillIn: null, sillMode: "fixed", opLeft: false, opRight: true, opDouble: false, opSlideUp: false, opDefault: "right", swingIn: false, swingOut: true, swingDefault: null, hasTrimColor: false },
    { id: "w-high", name: "Harness High Window", price: 1, widthIn: 30, heightIn: 36, category: "window", colorMode: "fixed", planLabel: "HW", sortOrder: 1, imageUrl: null,
      sillIn: 144, sillMode: "fixed" },
  ],
  windowColors: [],
};
const settle = (page, ms = 400) => page.waitForTimeout(ms);
const near = (a, b, e = 1e-6) => Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) <= e;
const f3 = (v) => (v == null || !Number.isFinite(Number(v)) ? String(v) : Number(v).toFixed(3));
const sp = (t) => String(t).replace(/ /g, " ");
const { ok, failed } = reporter();
const only = process.env.SS_CASES ? process.env.SS_CASES.split(",") : null;
const want = (k) => (only ? only.includes(k) : !["D", "D+", "X"].includes(k));
const shots = shotsDir("wingList");

// ── the pure layer, lifted from the cmp twin ─────────────────────────────────────────────────────
const SRC = readFileSync(join(ROOT, "structure-studio.component.js"), "utf8");
const FLAG_OFF = "const D3_WINGLIST_ENDS = false;", FLAG_ON = "const D3_WINGLIST_ENDS = true;";
const flagOn = SRC.includes(FLAG_ON);
const ENDS = flagOn || process.env.SS_WINGLIST_FORCE_ENDS === "1";
const REGIONS = [["const D3 = {", "// The casing reveal every opening"], ["const D3_CASE_F =", "// Built-in 3D appearance per building style"], ["function d3RoofAxes(", "function d3FtIn("]];
const pureOf = (src) => {
  const body = REGIONS.map(([a, b]) => {
    const i = src.indexOf(a), j = src.indexOf(b, i);
    if (i < 0 || j < 0) throw new Error(`The anchors moved: ${a}`);
    return src.slice(i, j);
  }).join("\n");
  return new Function(`${body}; return { d3Massing, d3WallTops, d3WingListFromLegacy, d3WingListFallback, d3WingListDeep, d3WingListOn, D3_WINGLIST_ENDS };`)();
};
const PURE = pureOf(SRC);
const PURE_E = (() => {
  if (flagOn) return PURE;
  const n = SRC.split(FLAG_OFF).length - 1;
  if (n !== 1) throw new Error(`the flag line ${FLAG_OFF} appears ${n} times in the cmp twin, not once`);
  return pureOf(SRC.replace(FLAG_OFF, FLAG_ON));
})();
ok(`the cmp twin's end-wing flag is ${flagOn}; end cases ${ENDS ? "run" : "wait for it (SS_WINGLIST_FORCE_ENDS=1 to force)"}`, flagOn || SRC.includes(FLAG_OFF));
ok("PURE_E builds end wings (the forced flag reached the lift)", PURE_E.D3_WINGLIST_ENDS === true
  && PURE_E.d3Massing({ type: "gable", pitch: 0.5, overhang: 1, wingList: [{ wall: "front", widthFt: 8 }] }, 24, 32, 9).ends.length === 1);
// The massing as JSON, every number to 1e-9, for the page-versus-pure checks.
// Wall-top pieces equal to 1e-9 (the design's worked numbers are decimals, the pure layer's floats).
const sameTops = (a, b) => Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((p, k) => p.length === b[k].length && p.every((v, j) => near(v, b[k][j], 1e-9)));
const r9 = (m) => JSON.parse(JSON.stringify(m, (k, v) => (typeof v === "number" ? Math.round(v * 1e9) / 1e9 : v)));
const sizeOf = (size) => size.split("x").map(Number);

// ── the designer, stubbed (wingSides.mjs's helpers) ────────────────────────────────────────────────
const configFor = (label, size, d3, clientId = "harness-winglist") => {
  const [w, l] = sizeOf(size);
  return {
    clientId, branding: { companyName: "Harness Sheds", accentColor: "#1D4ED8", headerBg: "#FFFFFF", tagline: null, logo: null },
    contactFields: ["name", "email", "phone"],
    buildingStyles: [{ value: "wls", label, img: null, sizes: [size], sizeInclusions: {}, sizeInclusionQty: {}, d3 }],
    defaultSizes: [size], sizePricing: { wls: { [size]: { widthFt: w, lengthFt: l, basePrice: 9000 } } },
    options: [], colors: [], claddingOptions: { wls: CLADS }, wallHeightOptions: {},
    showPricing: true, view3d: true, layoutItems: {}, layoutPricing: {}, layoutPrices: {}, electrical: null, electricalItems: [], insulation: [],
  };
};
async function pickStyle(page, label) {
  await page.waitForFunction((lab) => [...document.querySelectorAll("div,span,p,strong,b")].some((e) => e.children.length === 0 && (e.textContent || "").trim().toLowerCase() === lab.toLowerCase() && e.offsetParent), label, { timeout: 30000 }).catch(() => {});
  const hit = await page.evaluate((lab) => {
    const el = [...document.querySelectorAll("div,span,p,strong,b")].find((e) => e.children.length === 0 && (e.textContent || "").trim().toLowerCase() === lab.toLowerCase() && e.offsetParent);
    if (!el) return false;
    el.click();
    return true;
  }, label);
  if (!hit) throw new Error(`no style tile ${label}`);
  await settle(page, 500);
}
async function chooseSize(page, size) {
  const sel = page.locator("select").filter({ has: page.locator("option", { hasText: size }) });
  if (await sel.count()) await sel.first().selectOption({ label: size });
  const l = sizeOf(size)[1];
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
let ctxG;
// base: another server (X), served the same way. The stub answers every Supabase host; only the page's
// own origin changes.
async function openCase(label, size, d3, { base = BASE, rect = false } = {}) {
  const page = await ctxG.newPage();
  const errors = collectErrors(page);
  await page.addInitScript(() => { window.__SS3D_DEBUG = true; });
  await stubSupabase(page, { config: configFor(label, size, d3), fixtures: FIXTURES });
  if (base === BASE) await openDesigner(page, "harness-winglist");
  else {
    await page.addInitScript(() => { try { localStorage.setItem("ss_gate_harness-winglist", "1"); } catch (_e) { /* storage blocked */ } });
    await page.goto(`${base}/?client=harness-winglist`, { waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => window.__ssAppBooted === true && typeof window.StructureStudio === "function", null, { timeout: 60000 });
  }
  await pickStyle(page, label);
  await chooseSize(page, size);
  const r = rect ? await buildingRect(page) : null;
  await openEditor(page);
  return { page, errors, rect: r };
}
const D3of = (roof, H, extra = {}) => ({ roof, siding: "batten", colors: COLORS, wallHeightFt: H, roofMaterial: "metal", ...extra });

// The digest: every mesh's world bbox (1/1000 ft) and material colours, sorted. With `tags`, also the
// mesh's userData and every ancestor group's up to the model's own groups, so a legacy style's tags are
// pinned too (D, D+, Z). M compares geometry and material only: a list's meshes carry ssWingList.
async function digest(page, tags) {
  return page.evaluate((tags) => {
    const E = window.__ss3dEngine, M = E.model, V = E.camera.position.constructor;
    E.scene.updateMatrixWorld(true);
    const r3 = (v) => (Math.round(v * 1000) / 1000).toFixed(3), out = [];
    const ud = (o) => { try { return JSON.stringify(o.userData || {}); } catch (_e) { return "?"; } };
    [["roof", M.roofGroup], ["walls", M.wallsGroup], ["open", M.openingsGroup], ["interior", M.interiorGroup]].forEach(([name, grp]) => grp.traverse((o) => {
      if (!o.isMesh || !o.geometry) return;
      if (!o.geometry.boundingBox) o.geometry.computeBoundingBox();
      const b = o.geometry.boundingBox, mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
      for (const x of [b.min.x, b.max.x]) for (const y of [b.min.y, b.max.y]) for (const z of [b.min.z, b.max.z]) {
        const v = new V(x, y, z).applyMatrix4(o.matrixWorld);
        [v.x, v.y, v.z].forEach((c, k) => { mn[k] = Math.min(mn[k], c); mx[k] = Math.max(mx[k], c); });
      }
      const m = Array.isArray(o.material) ? o.material.map((q) => q.color && q.color.getHexString()).join("/") : (o.material && o.material.color && o.material.color.getHexString());
      let t = "";
      if (tags) { const up = []; for (let p = o; p && p !== grp; p = p.parent) up.push(ud(p)); t = " " + up.join("<"); }
      out.push(`${name} ${o.geometry.type} ${mn.map(r3).join(",")} ${mx.map(r3).join(",")} ${m}${t}`);
    }));
    return out.sort();
  }, !!tags);
}

// The scene grouped by list index: every mesh tagged ssWingList with its world bbox (and u/z in the
// building's own frame), the clerestories, each plain wall's piece tops, the middle's prism and ridge,
// the openings, the frame and whether every vertex is finite.
async function scene(page, engine = "__ss3dEngine") {
  return page.evaluate((engine) => {
    const E = window[engine], M = E.model, V = E.camera.position.constructor, m = M.massing;
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
      return { xMin: mn[0], xMax: mx[0], zMin: mn[2], zMax: mx[2], minY: mn[1], maxY: mx[1],
        uMin: m.uAxisIsX ? mn[0] : mn[2], uMax: m.uAxisIsX ? mx[0] : mx[2] };
    };
    const by = {};
    M.roofGroup.traverse((q) => {
      if (!q.isMesh || !q.userData || q.userData.ssWingList == null) return;
      const i = q.userData.ssWingList;
      (by[i] = by[i] || []).push({ ...bb(q), type: q.geometry.type, post: q.parent === M.roofGroup, tier: q.userData.ssWingTier, side: q.userData.ssWing,
        slabTan: q.geometry.type === "BoxGeometry" && q.rotation.z !== 0 && q.geometry.parameters && q.geometry.parameters.depth > 5 ? Math.abs(Math.tan(q.rotation.z)) : null,
        trim: q.material === M.trimMat });
    });
    const cl = [];
    M.wallsGroup.children.forEach((g) => { if (g.userData && g.userData.clerestory) cl.push({ ...bb(g), side: g.userData.clerestory, i: g.userData.clerestoryI }); });
    const walls = {};
    M.wallsGroup.children.forEach((g) => {
      if (!(g.userData && g.userData.wall)) return;
      const tops = new Set();
      g.children.forEach((q) => { if (q.isMesh) tops.add(Math.round(bb(q).maxY * 1000) / 1000); });
      walls[g.userData.wall] = [...tops].sort((a, b) => a - b);
    });
    // The middle's prism (wings.mjs): the highest ExtrudeGeometry with an array material that is no wing
    // and no porch member; and the middle's roof top over every untagged roof vertex.
    let prism = null, ridge = -Infinity;
    M.roofGroup.traverse((q) => {
      if (!q.isMesh || !q.geometry) return;
      const ud = q.userData || {};
      if (ud.ssWing || ud.ssPorchPart || ud.ssLeanTo !== undefined) return;
      if (q.geometry.type === "ExtrudeGeometry" && Array.isArray(q.material)) { const b = bb(q); if (!prism || b.maxY > prism.maxY) prism = b; }
      const p = q.geometry.attributes.position;
      for (let k = 0; k < p.count; k++) ridge = Math.max(ridge, new V().fromBufferAttribute(p, k).applyMatrix4(q.matrixWorld).y);
    });
    const openings = M.openingsGroup.children.filter((g) => g.userData && g.userData.itemId != null).map((g) => ({ id: g.userData.itemId, wall: g.userData.wall, ...bb(g) }));
    let worst = 0, finite = true;
    [M.roofGroup, M.wallsGroup].forEach((g) => g.traverse((q) => {
      if (!q.isMesh || !q.geometry || !q.geometry.attributes.position) return;
      const pos = q.geometry.attributes.position;
      for (let k = 0; k < pos.count; k++) {
        const w = new V().fromBufferAttribute(pos, k).applyMatrix4(q.matrixWorld);
        if (!Number.isFinite(w.x) || !Number.isFinite(w.y) || !Number.isFinite(w.z)) finite = false;
        const v = w.clone().project(E.camera);
        worst = Math.max(worst, Math.abs(v.x), Math.abs(v.y));
      }
    }));
    const builds = (performance.getEntriesByName ? performance.getEntriesByName("ss3d:rebuild") : []).map((e) => e.duration);
    return { massing: JSON.parse(JSON.stringify(m)), by, cl, walls, prism, ridge, openings, worst, finite, buildMs: builds.length ? Math.min(...builds) : null };
  }, engine);
}

async function shot(page, name, eye, at) {
  if (!process.env.SS_SHOTS) return;
  const clip = await page.evaluate(({ eye, at }) => {
    const E = window.__ss3dEngine;
    E.camera.position.set(eye[0], eye[1], eye[2]); E.controls.target.set(at[0], at[1], at[2]); E.camera.lookAt(at[0], at[1], at[2]);
    E.camera.updateProjectionMatrix(); if (E.controls.update) E.controls.update(); E.render();
    const c = E.renderer.domElement.getBoundingClientRect();
    return { x: c.x, y: c.y, width: c.width, height: c.height };
  }, { eye, at });
  await settle(page, 250);
  await page.evaluate(() => window.__ss3dEngine.render());
  await page.screenshot({ path: join(shots, name), clip });
}
// Place a catalog fixture from the 3D viewer's own path, at a plan point on a wall (wings.mjs).
async function place(page, r, fxId, type, wall, alongFt, W, L) {
  const pt = wall === "south" ? { x: r.x + alongFt * (r.w / W), y: r.y + r.h }
    : wall === "north" ? { x: r.x + alongFt * (r.w / W), y: r.y }
      : wall === "east" ? { x: r.x + r.w, y: r.y + alongFt * (r.h / L) } : { x: r.x, y: r.y + alongFt * (r.h / L) };
  const placed = await page.evaluate(({ fxId, type, pt, items }) => window.__ss3dEngine.place3Fixture(items.find((f) => f.id === fxId), type, pt.x, pt.y),
    { fxId, type, pt, items: FIXTURES.items });
  await settle(page, 900);
  return placed;
}

// The page's massing is the pure layer's for the same roof, size and wall height.
function oracleCheck(tag, got, pure, roof, W, L, H) {
  const want = r9(pure.d3Massing(roof, W, L, H));
  const same = JSON.stringify(r9(got)) === JSON.stringify(want);
  ok(`${tag}: the renderer's massing is the pure layer's, number for number`, same, same ? "" : JSON.stringify(r9(got)).slice(0, 300));
}

// Every side tier's own checks, against its massing record: a prism from ye up under ya, the slab at its
// pitch, nothing past its inner line, an outer tier's members under its parent's outside wall, a clerestory
// on its line from under its roof up to g.top, two corner boards to g.top, >= 5 tagged members.
function tierChecks(tag, S) {
  const m = S.massing;
  m.wings.forEach((g) => {
    const ms = S.by[g.i] || [], name = `${tag} i${g.i} (side ${g.side}, tier ${g.tier})`;
    const prisms = ms.filter((q) => q.type === "ExtrudeGeometry");
    ok(`${name}: one prism from its outside wall top ${f3(g.ye)} up under its roof (ya ${f3(g.ya)})`,
      prisms.length === 1 && near(prisms[0].minY, g.ye, 0.01) && prisms[0].maxY < g.ya + 1e-6, JSON.stringify(prisms.map((p) => [f3(p.minY), f3(p.maxY)])));
    const slab = ms.filter((q) => q.slabTan != null).sort((p, q) => (q.uMax - q.uMin) - (p.uMax - p.uMin))[0];
    ok(`${name}: its slab at its own pitch ${f3(g.pitch)}`, !!slab && near(slab.slabTan, g.pitch, 1e-3), slab && f3(slab.slabTan));
    const body = ms.filter((q) => !q.post);
    const inner = g.side < 0 ? Math.max(...body.map((q) => q.uMax)) : Math.min(...body.map((q) => q.uMin));
    const line = g.attach === "roof" && !g.cuts ? g.uIn : g.u0;   // up on the middle's roof it ends where it lands
    ok(`${name}: no member crosses its inner line ${f3(line)}`, g.side * (inner - line) >= -T / 2 - 1e-3, `reach ${f3(inner)}`);
    if (g.tier > 1) {
      const parent = m.wings.find((q) => q.side === g.side && q.tier === g.tier - 1);
      const top = Math.max(...body.map((q) => q.maxY));
      ok(`${name}: every member stays under its parent's outside wall (${f3(parent.ye)})`, top < parent.ye - 0.05, f3(top));
      ok(`${name}: its top is its parent's outside wall`, near(g.top, parent.ye, 1e-9), `${g.top} vs ${parent.ye}`);
    } else ok(`${name}: its top is the middle's eave`, near(g.top, m.Hc, 1e-9), `${g.top} vs ${m.Hc}`);
    const c = S.cl.find((q) => q.i === g.i);
    const onRoof = g.attach === "roof" && !g.cuts;
    if (onRoof) ok(`${name}: on the middle's roof, no clerestory`, !c, JSON.stringify(c));
    else {
      ok(`${name}: a clerestory on its line from <= ya up to ${f3(g.top)}`, !!c && c.minY <= g.ya + 1e-6 && c.minY >= g.ye - 1e-6 && near(c.maxY, g.top, 0.01)
        && near(g.side < 0 ? c.uMax : c.uMin, g.u0 - g.side * T / 2, 0.02), c && JSON.stringify([f3(c.minY), f3(c.maxY), f3(c.uMin), f3(c.uMax)]));
      const posts = ms.filter((q) => q.post);
      ok(`${name}: two clerestory corner boards up to ${f3(g.top)}`, posts.length === 2 && posts.every((p) => near(p.maxY, g.top, 0.01) && p.minY > g.ye),
        JSON.stringify(posts.map((p) => [f3(p.minY), f3(p.maxY)])));
    }
    ok(`${name}: >= 5 tagged members`, ms.length >= 5, String(ms.length));
  });
  ok(`${tag}: one clerestory per side wing not on the roof (plus one per end wing)`,
    S.cl.filter((c) => Math.abs(c.side) === 1).length === m.wings.filter((g) => !(g.attach === "roof" && !g.cuts)).length, String(S.cl.length));
  ok(`${tag}: every vertex finite`, S.finite);
  ok(`${tag}: the opening frame holds the building (NDC <= 1)`, S.worst <= 1 + 1e-6, f3(S.worst));
}

// ── fixtures ─────────────────────────────────────────────────────────────────────────────────
const G = { type: "gable", pitch: 0.5, overhang: 1, eave: "fascia" };
const CASE_S = { ...G, wingList: [{ wall: "left", widthFt: 8 }, { wall: "left", widthFt: 6 }, { wall: "right", widthFt: 8 }] };
const CHAIN = { ...G, wingList: [{ wall: "left", widthFt: 6 }, { wall: "left", widthFt: 5 }, { wall: "left", widthFt: 4, pitch: 1 / 3 },
  { wall: "right", widthFt: 6 }, { wall: "right", widthFt: 5, attach: "wall", attachFt: 1 }] };
const CASE_E = { ...G, wingList: [{ wall: "front", widthFt: 8 }] };
const CASE_C = { ...G, wingList: [...CASE_S.wingList, { wall: "front", widthFt: 8 }, { wall: "back", widthFt: 6 }, { wall: "back", widthFt: 5 }] };
const CASE_T = { ...G, centerEaveFt: 17, wingList: [{ wall: "left", widthFt: 8 }, { wall: "right", widthFt: 8 }, { wall: "front", widthFt: 8 }] };
// The same list on a landscape footprint (the ridge along x): the eave walls are back (-u) and front (+u),
// the gable ends left (west, the z = L end) and right (east, z = 0).
const LAND = { left: "back", right: "front", front: "left", back: "right" };
const landscape = (roof) => ({ ...roof, wingList: roof.wingList.map((e) => ({ ...e, wall: LAND[e.wall] })) });
const TRI = { ...G, wingSide: "both", wingWidthFt: 8, wingPitch: 0.25, centerEaveFt: 17 };
const TRI37 = { type: "gable", front: "gable", pitch: 0.67, overhang: 1, eave: "fascia", wingSide: "both", wingWidthFt: 12, wingPitch: 0.333, centerEaveFt: 14 };
const PLAIN = { type: "gable", pitch: 0.4, overhang: 0.6 };

// D: the legacy set. wingSides.mjs DIGEST_CASES, wings.mjs LEGACY L1..L5, attach.mjs WING_CASES, leanTos.mjs
// S1, roofStep.mjs's stepped cabin, and a projecting porch (the others: L2 a gambrel porch, L3 a shed,
// L4 a recessed porch, L5 a dormer, L1 a plain gable).
const LC = { body: "#3d4247", trim: "#2c3035", roof: "#2e3238", wood: "#a8703f" };
const DG = (id, size, H, roof, extra = {}) => ({ id, size, H, d3: { roof, siding: "batten", colors: COLORS, wallHeightFt: H, roofMaterial: "metal", ...extra } });
const DORMER = { dormerType: "transom", dormerWidthFt: 6, dormerRiseFt: 2.5, dormerOffsetU: 0.45 };
const CABIN = { type: "gable", front: "gable", pitch: 0.41, overhang: 1.3, eave: "fascia", porchDepthFt: 6, porchEnd: "front", porchTruss: true };
const LEGACY_CASES = [
  DG("ws-tri-both", "24x28", 9, TRI),
  DG("ws-tri-left", "24x28", 9, { ...TRI, wingSide: "left" }, { siding: "lap" }),
  DG("ws-tri-right-open", "20x28", 8, { ...TRI, wingSide: "right", wingWidthFt: 6, eave: "open", centerEaveFt: 15 }, { siding: "panel" }),
  DG("ws-tri-pushed", "24x28", 9, { ...TRI, centerEaveFt: 11.5 }),
  DG("ws-tri-wall", "24x28", 9, { ...TRI, wingPitch: 1.2, wingAttach: "wall", wingAttachFt: 2 }),
  DG("ws-tri-roof", "24x28", 9, { ...TRI, centerEaveFt: 11, wingAttach: "roof", wingAttachFt: 1 }),
  DG("ws-tri37-wall", "37x22", 10, { ...TRI37, wingAttach: "wall", wingAttachFt: 1.5 }),
  DG("ws-tri37-cannot", "37x22", 8, { ...TRI37, pitch: 5 / 12, wingAttach: "roof", wingAttachFt: 1 }),
  DG("ws-gambrel", "24x32", 10, { type: "gambrel", overhang: 0.6, wingSide: "both", wingWidthFt: 7, wingPitch: 0.3 }),
  DG("ws-front-porch", "28x20", 9, { type: "gable", front: "gable", pitch: 0.67, overhang: 1, eave: "fascia", wingSide: "both", wingWidthFt: 8, wingPitch: 0.2, centerEaveFt: 15, porchOutFt: 6, porchEnd: "front" }),
  DG("ws-lean-off-wing", "24x28", 9, { ...TRI, leanToWidthFt: 6, leanToDropFt: 1.5, leanToSide: "right", leanToAttach: "roof", leanToAttachFt: 0.5 }),
  DG("ws-dormer-roof", "37x22", 10, { ...TRI37, dormerWidthFt: 5, dormerType: "transom", dormerRiseFt: 1.5, dormerOffsetU: 0.6, wingAttach: "roof", wingAttachFt: 1 }),
  DG("ws-narrow", "16x20", 8, { ...TRI, wingWidthFt: 8, centerEaveFt: 14 }),
  DG("ws-front-eave", "28x20", 9, { type: "gable", front: "eave", pitch: 0.5, overhang: 1, eave: "fascia", wingSide: "back", wingWidthFt: 6, wingPitch: 0.25 }),
  { id: "L1", size: "12x16", H: 8, d3: { roof: PLAIN, siding: "batten", colors: LC, wallHeightFt: 8 } },
  { id: "L2", size: "16x24", H: 9, d3: { roof: { type: "gambrel", overhang: 0.4, porchOutFt: 6.5, plateBand: true }, siding: "lap", colors: LC, wallHeightFt: 9, roofMaterial: "metal" } },
  { id: "L3", size: "12x8", H: 7, d3: { roof: { type: "shed", pitch: 0.23, overhang: 0.5, porchOutFt: 4 }, siding: "panel", colors: LC, wallHeightFt: 7 } },
  { id: "L4", size: "12x32", H: 7.5, d3: { roof: { type: "gable", pitch: 0.42, overhang: 0.8, porchDepthFt: 6, porchTruss: true, porchEnd: "front", leanToWidthFt: 8, leanToSide: "left" }, siding: "batten", colors: LC, wallHeightFt: 7.5, gableVent: { widthFrac: 0.12 } } },
  { id: "L5", size: "24x14", H: 12, d3: { roof: { type: "gable", pitch: 0.33, overhang: 1, eave: "open", dormerWidthFt: 6, dormerType: "transom" }, siding: "agpanel", colors: LC, wallHeightFt: 12, roofMaterial: "metal" } },
  ...[
    ["tri8-auto", 8, {}], ["tri8-wall", 8, { wingAttach: "wall", wingAttachFt: 1 }], ["tri8-roof", 8, { wingAttach: "roof", wingAttachFt: 1 }],
    ["tri10-auto", 10, {}], ["tri10-wall", 10, { wingAttach: "wall", wingAttachFt: 1.5 }], ["tri10-roof", 10, { wingAttach: "roof", wingAttachFt: 1 }],
    ["tri10-wallTight", 10, { wingAttach: "wall", wingAttachFt: 0.25 }], ["tri8-roofCannot", 8, { pitch: 5 / 12, wingAttach: "roof", wingAttachFt: 1 }],
    ["tri8-roofLevel", 8, { pitch: 0.5, wingAttach: "roof", wingAttachFt: 1 }], ["tri8-roofCannot0", 8, { pitch: 5 / 12, wingAttach: "roof", wingAttachFt: 0 }],
    ["tri10-autoDormer", 10, DORMER], ["tri10-roofDormer", 10, { ...DORMER, wingAttach: "roof", wingAttachFt: 1 }],
  ].map(([id, H, x]) => DG(`att-${id}`, "37x22", H, { ...TRI37, ...x })),
  DG("lt-S1", "24x30", 8, { type: "gable", front: "gable", pitch: 0.5, overhang: 0.6, wingSide: "both", wingWidthFt: 6, wingPitch: 0.25, leanTos: [
    { wall: "front", widthFt: 6, dropFt: 1.5 }, { wall: "left", widthFt: 8, dropFt: 1, enclosed: true }, { wall: "right", widthFt: 6, dropFt: 1.5, lengthFt: 10, offsetFt: 5 }] }, { siding: "lap" }),
  DG("step-cabin", "14x40", 7.75, { ...CABIN, rearStepFt: 14, rearEaveRiseFt: 0.6 }, { foundation: "skids" }),
  DG("porch-projecting", "24x28", 9, { ...G, porchOutFt: 6, porchEnd: "front" }),
];

const { browser, ctx } = await launch({ width: 1280, height: 900 });
ctxG = ctx;

// ── D · legacy digests ───────────────────────────────────────────────────────────────────────
const D_OUT = process.env.SS_WINGLIST_DIGEST, D_BASE = process.env.SS_WINGLIST_BASE;
if (want("D") && (D_OUT || D_BASE)) {
  const base = D_BASE ? JSON.parse(readFileSync(D_BASE, "utf8")) : null;
  const out = {};
  for (const c of LEGACY_CASES) {
    try {
      const { page, errors } = await openCase(`Harness ${c.id}`, c.size, c.d3);
      const dg = await digest(page, true);
      out[c.id] = dg;
      if (base) {
        const b = base[c.id] || [];
        const diff = dg.filter((x) => !b.includes(x)).concat(b.filter((x) => !dg.includes(x)));
        ok(`D ${c.id}: the same scene graph as the base build (${dg.length} meshes)`, !!base[c.id] && !diff.length, diff.slice(0, 2).join(" | "));
      }
      ok(`D ${c.id}: no page errors`, errors.length === 0, errors.slice(0, 3).join(" | "));
      await page.close();
    } catch (e) { ok(`D ${c.id}: ran`, false, e && e.message); }
  }
  if (base) ok(`D: every base case was rendered (${Object.keys(base).length})`, Object.keys(base).every((k) => out[k]), Object.keys(base).filter((k) => !out[k]).join(","));
  if (D_OUT) { writeFileSync(D_OUT, JSON.stringify(out, null, 1)); console.log(`   D: wrote ${Object.keys(out).length} digests to ${D_OUT}`); }
}

// ── D+ · stored styles (counts only; the export never leaves the scratchpad) ────────────────────
const STORED = process.env.SS_WINGLIST_STORED;
if (want("D+") && STORED) {
  const rows = JSON.parse(readFileSync(STORED, "utf8"));
  const outFile = process.env.SS_WINGLIST_STORED_DIGEST, baseFile = process.env.SS_WINGLIST_STORED_BASE;
  const base = baseFile ? JSON.parse(readFileSync(baseFile, "utf8")) : null;
  const out = {};
  let same = 0, diff = 0, errs = 0;
  for (let k = 0; k < rows.length; k++) {
    const r = rows[k];
    const first = r.firstSize && r.firstSize.w && r.firstSize.l ? `${r.firstSize.w}x${r.firstSize.l}` : null;
    for (const size of [...new Set([first, "24x28", "37x22"].filter(Boolean))]) {
      const key = `${k}@${size}`;
      try {
        const { page, errors } = await openCase(`Harness Stored ${k}`, size, r.d3);
        out[key] = await digest(page, true);
        if (errors.length) errs++;
        await page.close();
      } catch (_e) { out[key] = ["ERROR"]; errs++; }
      if (base) { if (JSON.stringify(base[key]) === JSON.stringify(out[key])) same++; else { diff++; console.log(`   D+ differs: style #${k} at ${size}`); } }
    }
  }
  ok(`D+: ${rows.length} stored styles, ${Object.keys(out).length} renders, 0 with page errors`, errs === 0, `${errs} with errors`);
  if (base) ok(`D+: every stored style's digest equals the base build's (${same} equal, ${diff} different)`, diff === 0 && Object.keys(base).length === Object.keys(out).length, `${Object.keys(base).length} base keys`);
  if (outFile) writeFileSync(outFile, JSON.stringify(out));
}

// ── Z · junk ─────────────────────────────────────────────────────────────────────────────────
if (want("Z")) {
  const JUNK = [null, [], "left", {}, 4, [null], [null, 3], [{ wall: "top", widthFt: 8 }], [{ wall: ["left"], widthFt: 8 }], [{ wall: "left" }],
    [{ wall: "left", widthFt: 0.5 }], [{ wall: "left", widthFt: "" }], [[{ wall: "left", widthFt: 8 }]]];
  for (const [id, size, H, roof] of [["tri", "24x28", 9, TRI], ["plain", "12x16", 8, PLAIN]]) {
    try {
      const a = await openCase(`Junk ${id}`, size, D3of(roof, H));
      const base = await digest(a.page, true); await a.page.close();
      for (const junk of JUNK) {
        const b = await openCase(`Junk ${id}`, size, D3of({ ...roof, wingList: junk }, H));
        const d = await digest(b.page, true);
        const m = await b.page.evaluate(() => JSON.parse(JSON.stringify(window.__ss3dEngine.model.massing)));
        await b.page.close();
        ok(`Z ${id} ${JSON.stringify(junk)}: the same scene graph as without the key, and a legacy massing`,
          JSON.stringify(d) === JSON.stringify(base) && !("list" in m) && !("ends" in m) && !b.errors.length, b.errors.join(" | ").slice(0, 200));
      }
    } catch (e) { ok(`Z ${id}: ran`, false, e && e.message); }
  }
}

// ── M · the mirror ───────────────────────────────────────────────────────────────────────────
if (want("M")) {
  const FIX = [
    ["tri", "24x28", 9, TRI, ["30x36"]],
    ["tri-wall", "24x28", 9, { ...TRI, wingPitch: 1.2, wingAttach: "wall", wingAttachFt: 2 }, ["20x28"]],
    ["tri-roof", "24x28", 9, { ...TRI, centerEaveFt: 11, wingAttach: "roof", wingAttachFt: 1 }, ["16x20"]],
    ["mixed", "24x28", 9, { ...TRI, centerEaveFt: 14, wingSides: { left: { widthFt: 8, attach: "wall", attachFt: 1 }, right: { widthFt: 6, pitch: 0.75, attach: "auto" } } }, ["16x24"]],
    ["tri37-wall", "37x22", 10, { ...TRI37, wingAttach: "wall", wingAttachFt: 1.5 }, ["40x24"]],
    ["gambrel", "24x32", 10, { type: "gambrel", overhang: 0.6, wingSide: "both", wingWidthFt: 7, wingPitch: 0.3 }, ["12x16"]],
    ["one-side", "24x28", 9, { ...TRI, wingSide: "left" }, ["20x24"]],
  ];
  for (const [id, size0, H, roof, more] of FIX) {
    const [W0, L0] = sizeOf(size0);
    const list = PURE.d3WingListFromLegacy(roof, W0, L0, H);
    const conv = { ...roof, wingList: list }; delete conv.wingSides; delete conv.wingAttach; delete conv.wingAttachFt;
    const turn0 = PURE.d3Massing(roof, W0, L0, H).uAxisIsX;
    for (const size of [size0, ...more]) {
      const [W, L] = sizeOf(size);
      const tag = `M ${id} at ${size}`;
      if (PURE.d3Massing(roof, W, L, H).uAxisIsX !== turn0) { ok(`${tag}: the ridge turns at this size; not a mirror size`, false, "pick another size"); continue; }
      try {
        ok(`${tag}: the converted list is not deep`, !PURE.d3WingListDeep(PURE.d3Massing(conv, W, L, H)));
        const a = await openCase(`Mirror ${id}`, size, D3of(roof, H));
        const da = await digest(a.page, false); await a.page.close();
        const b = await openCase(`Mirror ${id}`, size, D3of(conv, H));
        const db = await digest(b.page, false); const Sb = await scene(b.page); await b.page.close();
        const diff = da.filter((x, k) => x !== db[k]);
        ok(`${tag}: the list builds the legacy geometry and materials mesh for mesh (${da.length})`, da.length === db.length && !diff.length, diff.slice(0, 2).join(" | "));
        ok(`${tag}: every list wing's meshes carry its index`, Sb.massing.wings.every((g) => (Sb.by[g.i] || []).length >= 5), JSON.stringify(Object.keys(Sb.by)));
        ok(`${tag}: zero page errors`, !a.errors.length && !b.errors.length, [...a.errors, ...b.errors].join(" | ").slice(0, 200));
      } catch (e) { ok(`${tag}: ran`, false, e && e.message); }
    }
  }
}

// ── S · side stacks ──────────────────────────────────────────────────────────────────────────
if (want("S")) {
  try {
    const { page, errors } = await openCase("Stack S", "30x32", D3of(CASE_S, 9));
    const S = await scene(page);
    const m = S.massing, w = m.wings;
    ok("S: a list massing with 3 side wings, tiers [1,1,2] and no end wings", m.list === true && w.length === 3 && JSON.stringify(w.map((g) => g.tier)) === "[1,1,2]" && m.ends.length === 0,
      JSON.stringify(w.map((g) => [g.i, g.side, g.tier])));
    oracleCheck("S", m, PURE, CASE_S, 30, 32, 9);
    const L1 = w.find((g) => g.i === 0), L2 = w.find((g) => g.i === 1), R1 = w.find((g) => g.i === 2);
    ok("S: left tier 2 u1 -15, u0 -9, ye 9, ya 10.5", near(L2.u1, -15) && near(L2.u0, -9) && near(L2.ye, 9) && near(L2.ya, 10.5), JSON.stringify(L2));
    ok("S: left tier 1 u1 -9, u0 -1, ye 11.5, ya 13.5, not raised", near(L1.u1, -9) && near(L1.u0, -1) && near(L1.ye, 11.5) && near(L1.ya, 13.5) && !L1.raised, JSON.stringify(L1));
    ok("S: right tier 1 u1 15, u0 7, ye 9, ya 11", near(R1.u1, 15) && near(R1.u0, 7) && near(R1.ye, 9) && near(R1.ya, 11), JSON.stringify(R1));
    ok("S: the middle Sc 8, uc 3, Hc 16.5", near(m.Sc, 8) && near(m.uc, 3) && near(m.Hc, 16.5), `${m.Sc} ${m.uc} ${m.Hc}`);
    tierChecks("S", S);
    ok("S: three clerestories, tagged 0, 1 and 2", JSON.stringify(S.cl.map((c) => c.i).sort()) === "[0,1,2]", JSON.stringify(S.cl.map((c) => c.i)));
    const c1 = S.cl.find((c) => c.i === 1);
    ok("S: tier 2's clerestory runs from <= 10.5 up to 11.5; the others to 16.5",
      !!c1 && c1.minY <= 10.5 + 1e-6 && near(c1.maxY, 11.5, 0.01) && S.cl.filter((c) => c.i !== 1).every((c) => near(c.maxY, 16.5, 0.01)), JSON.stringify(S.cl.map((c) => [c.i, f3(c.minY), f3(c.maxY)])));
    ok("S: the south gable wall's pieces top out at 9, 11.5 and 16.5", [9, 11.5, 16.5].every((y) => (S.walls.south || []).some((t) => near(t, y, 0.01))), JSON.stringify(S.walls.south));
    ok("S: the north gable wall steps the same", [9, 11.5, 16.5].every((y) => (S.walls.north || []).some((t) => near(t, y, 0.01))), JSON.stringify(S.walls.north));
    ok("S: the pure south stair is §3.7's", sameTops(PURE.d3WallTops(CASE_S, 30, 32, 9, "south"), [[0, 5.85, 9], [5.85, 13.85, 11.5], [13.85, 22.15, 16.5], [22.15, 30, 9]]),
      JSON.stringify(PURE.d3WallTops(CASE_S, 30, 32, 9, "south")));
    const fas = (S.by[0] || []).filter((q) => q.type === "BoxGeometry" && q.uMin > -9 - OV - 0.4 && q.uMax < -9 - OV + 0.4 && q.maxY > 11 && q.maxY < 11.8 && q.zMax - q.zMin > 30);
    ok("S: tier 1's outer eave has its finish at u ~ -9 - OV, y ~ 11.5, the length of the roof", fas.length >= 1, JSON.stringify(fas.slice(0, 1)));
    ok("S: six clerestory corner boards, tier 2's up to 11.5", Object.values(S.by).flat().filter((q) => q.post).length === 6 && (S.by[1] || []).filter((q) => q.post).every((p) => near(p.maxY, 11.5, 0.01)));
    ok("S: the middle's roof tops out a hair over its 18.5 ridge", S.ridge > 18.5 && S.ridge < 18.5 + 0.6, f3(S.ridge));
    await shot(page, "S-south-west.png", [-34, 22, 40], [-2, 9, 0]);
    await shot(page, "S-left-stack-south-end.png", [-16, 13, 30], [-7, 11, 12]);
    ok("S: zero page errors", errors.length === 0, errors.join(" | ").slice(0, 300));
    await page.close();
  } catch (e) { ok("S: ran", false, e && e.stack); }

  for (const [id, size, roof, want] of [
    ["S3 chain", "36x40", CHAIN, "[1,1,2,2,3]"],
    ["SL landscape", "32x30", landscape(CASE_S), "[1,1,2]"],
    ["S onroof", "30x32", { ...G, centerEaveFt: 15, wingList: [{ wall: "left", widthFt: 8, attach: "roof", attachFt: 1 }, { wall: "left", widthFt: 5 }, { wall: "right", widthFt: 6 }] }, "[1,1,2]"],
    ["S onwall", "30x32", { ...G, eave: "open", wingList: [{ wall: "right", widthFt: 7, attach: "wall", attachFt: 1.5 }, { wall: "right", widthFt: 5, pitch: 0.5 }, { wall: "left", widthFt: 6 }] }, "[1,1,2]"],
    ["S drop", "16x24", { ...G, wingList: [{ wall: "left", widthFt: 19.8 }, { wall: "left", widthFt: 0.6 }, { wall: "right", widthFt: 4 }] }, "[1,1]"],
  ]) {
    try {
      const [W, L] = sizeOf(size);
      const { page, errors } = await openCase(`Stack ${id}`, size, D3of(roof, 9));
      const S = await scene(page);
      ok(`${id}: tiers ${want}`, JSON.stringify(S.massing.wings.map((g) => g.tier)) === want, JSON.stringify(S.massing.wings.map((g) => [g.i, g.tier])));
      oracleCheck(id, S.massing, PURE, roof, W, L, 9);
      tierChecks(id, S);
      if (id === "S3 chain") {
        const r2 = S.massing.wings.find((g) => g.i === 4), r1 = S.massing.wings.find((g) => g.i === 3);
        ok("S3 chain: the right outer tier meets the right tier 1's outside wall, on the wall", r2.meets === "wall" && near(r2.ya, r1.ye - r2.meetFt, 1e-9), JSON.stringify(r2));
        await shot(page, "S3-chain-south-west.png", [-40, 24, 46], [-4, 10, 0]);
      }
      if (id === "SL landscape") ok("SL landscape: the east and west gable walls step 9 | 11.5 | 16.5", [9, 11.5, 16.5].every((y) => (S.walls.east || []).some((t) => near(t, y, 0.01)) && (S.walls.west || []).some((t) => near(t, y, 0.01))),
        JSON.stringify([S.walls.east, S.walls.west]));
      if (id === "S drop") ok("S drop: entry 1 is listDropped for room and has no meshes", JSON.stringify(S.massing.listDropped) === JSON.stringify([{ i: 1, why: "room" }]) && !S.by[1], JSON.stringify(S.massing.listDropped));
      ok(`${id}: zero page errors`, errors.length === 0, errors.join(" | ").slice(0, 300));
      await page.close();
    } catch (e) { ok(`${id}: ran`, false, e && e.stack); }
  }
}

// ── E · an end wing ──────────────────────────────────────────────────────────────────────────
// End-wing checks shared by E, C and T: per end index, a body prism, the slab at its pitch, a clerestory on
// its inner line, two corner boards, >= 6 tagged members, nothing past its inner line.
function endChecks(tag, S) {
  const m = S.massing, L = m.L;
  m.ends.forEach((t) => {
    const ms = S.by[t.i] || [], name = `${tag} end i${t.i} (${t.wall}, tier ${t.tier})`;
    ok(`${name}: >= 6 tagged members, each tagged ssWing ${2 * t.sz}`, ms.length >= 6 && ms.every((q) => q.side === 2 * t.sz), `${ms.length} ${JSON.stringify([...new Set(ms.map((q) => q.side))])}`);
    const slab = ms.filter((q) => q.slabTan != null).sort((p, q) => (q.xMax - q.xMin + q.zMax - q.zMin) - (p.xMax - p.xMin + p.zMax - p.zMin))[0];
    ok(`${name}: its slab at its own pitch ${f3(t.pitch)}`, !!slab && near(slab.slabTan, t.pitch, 1e-3), slab && f3(slab.slabTan));
    // z in the renderer's rg frame: portrait world z + L/2, landscape L/2 - world x.
    const zr = (q) => (m.uAxisIsX ? [q.zMin + L / 2, q.zMax + L / 2] : [L / 2 - q.xMax, L / 2 - q.xMin]);
    const body = ms.filter((q) => !q.post);
    const inner = t.sz > 0 ? Math.min(...body.map((q) => zr(q)[0])) : Math.max(...body.map((q) => zr(q)[1]));
    ok(`${name}: no member crosses its inner line z ${f3(t.zI)}`, t.sz * (inner - t.zI) >= -T / 2 - 1e-3, `reach ${f3(inner)}`);
    const c = S.cl.find((q) => q.i === t.i);
    const cz = c && zr(c);
    ok(`${name}: a clerestory on its inner line (inner face ${f3(t.zI - t.sz * T / 2)}), from <= ya ${f3(t.ya)} up to ${f3(t.top)}`,
      !!c && c.side === 2 * t.sz && near(t.sz > 0 ? cz[0] : cz[1], t.zI - t.sz * T / 2, 0.03) && c.minY <= t.ya + 1e-6 && near(c.maxY, t.top, 0.01),
      c && JSON.stringify([c.side, f3(cz[0]), f3(cz[1]), f3(c.minY), f3(c.maxY)]));
    const posts = ms.filter((q) => q.post);
    ok(`${name}: two corner boards at the long walls' corners on z ${f3(t.zI)}`, posts.length === 2
      && posts.every((p) => near((zr(p)[0] + zr(p)[1]) / 2, t.zI, 0.3) && near(Math.abs((p.uMin + p.uMax) / 2), m.S / 2, 0.3)), JSON.stringify(posts.map((p) => [f3(p.uMin), f3(p.uMax), ...zr(p).map(f3)])));
  });
  ok(`${tag}: every vertex finite`, S.finite);
  ok(`${tag}: the opening frame holds the building (NDC <= 1)`, S.worst <= 1 + 1e-6, f3(S.worst));
}
if (want("E") && ENDS) {
  try {
    const { page, errors, rect } = await openCase("End E", "24x32", D3of(CASE_E, 9), { rect: true });
    const S = await scene(page);
    const m = S.massing, t = m.ends[0];
    ok("E: one end wing, zB 24, Hc 12.13", m.ends.length === 1 && m.wings.length === 0 && near(m.zB, 24) && near(m.zA, 0) && near(m.Hc, 12.13), JSON.stringify({ ends: m.ends.length, zA: m.zA, zB: m.zB, Hc: m.Hc }));
    oracleCheck("E", m, PURE_E, CASE_E, 24, 32, 9);
    ok("E: the end wing: zO 32, zI 24, ye 9, ya 11, south, ssWing 2", !!t && near(t.zO, 32) && near(t.zI, 24) && near(t.ye, 9) && near(t.ya, 11) && t.wall === "south" && t.sz === 1, JSON.stringify(t));
    ok("E: the middle's prism runs world z -16 .. 8 (its caps flush)", !!S.prism && S.prism.zMin < -15.99 && S.prism.zMin > -16.3 && S.prism.zMax > 7.99 && S.prism.zMax < 8.3,
      S.prism && `${f3(S.prism.zMin)}..${f3(S.prism.zMax)}`);
    ok("E: the middle's ridge ~ 18.13", S.ridge > 18.13 && S.ridge < 18.13 + 0.6, f3(S.ridge));
    endChecks("E", S);
    const ms = S.by[0] || [];
    const slab = ms.filter((q) => q.slabTan != null).sort((p, q) => (q.xMax - q.xMin) - (p.xMax - p.xMin))[0];
    ok("E: the end slab falls to the south: its low edge at world z ~ 16 + OV", !!slab && near(slab.zMax, 16 + OV, 0.2) && slab.minY < 9.1, slab && `${f3(slab.zMax)} y ${f3(slab.minY)}`);
    const fascia = ms.filter((q) => q.trim && q.zMin > 16.4 && q.zMax < 17.6 && q.xMax - q.xMin > 20);
    ok("E: …with a fascia along it", fascia.length >= 1, JSON.stringify(ms.filter((q) => q.trim).slice(0, 3).map((q) => [f3(q.xMin), f3(q.xMax), f3(q.zMin), f3(q.zMax)])));
    const rakes = ms.filter((q) => !q.post && q.xMax - q.xMin < 0.4 && q.zMax - q.zMin > 6 && near(Math.abs((q.xMin + q.xMax) / 2), 12 + OV - 0.05, 0.15));
    ok("E: rakes along both long walls at |x| ~ 12 + OV - 0.05", rakes.some((q) => q.xMin > 0) && rakes.some((q) => q.xMax < 0), JSON.stringify(rakes.map((q) => [f3(q.xMin), f3(q.xMax)])));
    const c = S.cl.find((q) => q.i === 0);
    ok("E: the end clerestory (clerestory 2) at z ~ 8 +- T/2, from <= 11 up to 12.13", !!c && c.side === 2 && c.zMin > 8 - T / 2 - 0.03 && c.zMin < 8 + T / 2 && c.minY <= 11 + 1e-6 && near(c.maxY, 12.13, 0.01),
      c && JSON.stringify([f3(c.zMin), f3(c.zMax), f3(c.minY), f3(c.maxY)]));
    ok("E: the west wall steps 12.13 over the middle and 9 over the end wing", [12.13, 9].every((y) => (S.walls.west || []).some((v) => near(v, y, 0.01))), JSON.stringify(S.walls.west));
    ok("E: the south wall (the end wing's outside wall) is 9 end to end", (S.walls.south || []).length > 0 && S.walls.south.every((v) => near(v, 9, 0.01)), JSON.stringify(S.walls.south));
    ok("E: the pure west wall is §3.7's", sameTops(PURE_E.d3WallTops(CASE_E, 24, 32, 9, "west"), [[0, 24.15, 12.13], [24.15, 32, 9]]), JSON.stringify(PURE_E.d3WallTops(CASE_E, 24, 32, 9, "west")));
    // Openings: a door on the south wall keeps its 6.5 ft; a window asked at 12 ft on the west wall 30 ft
    // from the north corner (over the end wing) is pulled under 9.
    const before = new Set(S.openings.map((o) => o.id));
    const put = async (fx, type, wall, along) => {
      const placed = await place(page, rect, fx, type, wall, along, 24, 32);
      const now = await scene(page);
      const o = now.openings.find((q) => !before.has(q.id));
      if (o) before.add(o.id);
      return { placed, o };
    };
    const door = await put("d-std", "fixtureDoor", "south", 12);
    ok("E: a door on the south wall keeps its 6.5 ft", !!door.o && door.o.maxY >= 6.45 && door.o.maxY <= 7.3, JSON.stringify(door.o && [f3(door.o.minY), f3(door.o.maxY)]));
    const win = await put("w-high", "window", "west", 30);
    ok("E: a window asked at 12 ft on the west wall over the end wing is pulled under 9", !!win.o && win.o.maxY <= 9 + 1e-6, JSON.stringify(win.o && [f3(win.o.minY), f3(win.o.maxY)]));
    await shot(page, "E-south-west.png", [-30, 18, 44], [0, 9, 4]);
    ok("E: zero page errors", errors.length === 0, errors.join(" | ").slice(0, 300));
    await page.close();
  } catch (e) { ok("E: ran", false, e && e.stack); }
}

// ── C · combined ─────────────────────────────────────────────────────────────────────────────
if (want("C") && ENDS) {
  try {
    const { page, errors } = await openCase("End C", "30x32", D3of(CASE_C, 9));
    const S = await scene(page);
    const m = S.massing, want = PURE_E.d3Massing(CASE_C, 30, 32, 9);
    ok("C: three end wings and three side wings", m.ends.length === 3 && m.wings.length === 3, `${m.ends.length} ${m.wings.length}`);
    ok("C: zA, zB and E equal the pure layer's", near(m.zA, want.zA, 1e-9) && near(m.zB, want.zB, 1e-9) && JSON.stringify(r9(m.E)) === JSON.stringify(r9(want.E)),
      JSON.stringify({ zA: m.zA, zB: m.zB, E: m.E }));
    oracleCheck("C", m, PURE_E, CASE_C, 30, 32, 9);
    tierChecks("C", S);
    endChecks("C", S);
    const lo = m.zA - 16 - 0.7, hi = m.zB - 16 + 0.7;
    const out = m.wings.flatMap((g) => (S.by[g.i] || []).filter((q) => q.zMin < lo || q.zMax > hi).map((q) => [g.i, f3(q.zMin), f3(q.zMax)]));
    ok(`C: every side-tier member stands inside the middle's run (world z ${f3(lo)} .. ${f3(hi)})`, !out.length, JSON.stringify(out.slice(0, 3)));
    await shot(page, "C-south-west.png", [-36, 24, 46], [0, 10, 0]);
    ok("C: zero page errors", errors.length === 0, errors.join(" | ").slice(0, 300));
    await page.close();
  } catch (e) { ok("C: ran", false, e && e.stack); }
}

// ── T · the Tri Home plus a front end wing ─────────────────────────────────────────────────────
if (want("T") && ENDS) {
  try {
    const { page, errors } = await openCase("End T", "24x28", D3of(CASE_T, 9));
    const S = await scene(page);
    const m = S.massing;
    ok("T: Hc 17, zB 20, each side wing's outside wall raised to 12 by the end wing", near(m.Hc, 17) && near(m.zB, 20) && m.wings.length === 2
      && m.wings.every((g) => near(g.ye, 12) && near(g.ya, 14) && g.raised && g.raisedFrom === 9 && JSON.stringify(g.raisedBy) === "[2]"), JSON.stringify(m.wings.map((g) => [g.ye, g.ya, g.raised, g.raisedFrom, g.raisedBy])));
    oracleCheck("T", m, PURE_E, CASE_T, 24, 28, 9);
    tierChecks("T", S);
    endChecks("T", S);
    for (const wall of ["west", "east"]) ok(`T: the ${wall} wall is 12 over the middle's stretch and 9 over the end wing's`, [12, 9].every((y) => (S.walls[wall] || []).some((v) => near(v, y, 0.01)))
      && (S.walls[wall] || []).every((v) => near(v, 12, 0.01) || near(v, 9, 0.01)), JSON.stringify(S.walls[wall]));
    ok("T: the pure north wall is §3.7's", sameTops(PURE_E.d3WallTops(CASE_T, 24, 28, 9, "north"), [[0, 7.85, 12], [7.85, 16.15, 17], [16.15, 24, 12]]), JSON.stringify(PURE_E.d3WallTops(CASE_T, 24, 28, 9, "north")));
    await shot(page, "T-south-west.png", [-30, 20, 40], [0, 9, 2]);
    await shot(page, "T-south-end.png", [4, 12, 44], [0, 10, 0]);
    ok("T: zero page errors", errors.length === 0, errors.join(" | ").slice(0, 300));
    await page.close();
  } catch (e) { ok("T: ran", false, e && e.stack); }
}

// ── SZ · every size ──────────────────────────────────────────────────────────────────────────
if (want("SZ")) {
  const SIZES = [[8, 10], [10, 12], [12, 16], [16, 24], [24, 28], [37, 22], [28, 20], [60, 40], [16, 12]];
  const LISTS = [["S", CASE_S], ["chain", CHAIN], ...(ENDS ? [["E", CASE_E], ["C", CASE_C]] : [])];
  const slow = [];
  for (const [W, L] of SIZES) {
    const size = `${W}x${L}`;
    let triMs = null;
    try {
      const t = await openCase("SZ Tri", size, D3of(TRI, 9));
      triMs = (await scene(t.page)).buildMs;
      await t.page.close();
    } catch (e) { ok(`SZ tri ${size}: ran`, false, e && e.message); }
    for (const [lid, roof0] of LISTS) {
      const roof = W > L ? landscape(roof0) : roof0;
      const tag = `SZ ${lid} ${size}`;
      try {
        const { page, errors } = await openCase(`SZ ${lid}`, size, D3of(roof, 9));
        const S = await scene(page);
        const m = S.massing, sides = m.wings.map((g) => g.i), ends = (m.ends || []).map((t) => t.i), dropped = (m.listDropped || []).map((d) => d.i);
        oracleCheck(tag, m, lid === "E" || lid === "C" ? PURE_E : PURE, roof, W, L, 9);
        ok(`${tag}: finite and framed, ${sides.length} side / ${ends.length} end drawn, ${dropped.length} not`, S.finite && S.worst <= 1 + 1e-6, `worst ${f3(S.worst)}`);
        ok(`${tag}: >= 5 meshes per drawn side index, >= 6 per end index, none for one not drawn`,
          sides.every((i) => (S.by[i] || []).length >= 5) && ends.every((i) => (S.by[i] || []).length >= 6) && dropped.every((i) => !S.by[i]),
          JSON.stringify(Object.fromEntries(Object.entries(S.by).map(([k, v]) => [k, v.length]))));
        if (S.buildMs != null && triMs != null) {
          // A build is a few ms, so one sample is at the mercy of a GC pause: a slow one is timed again, both
          // the list and the Tri Home, and the faster of each counts. + 5 ms: timer noise at these scales.
          let ms = S.buildMs;
          if (ms > 2 * triMs + 5) {
            const again = async (lab, r) => { const o = await openCase(lab, size, D3of(r, 9)); const v = (await scene(o.page)).buildMs; await o.page.close(); return v; };
            ms = Math.min(ms, await again(`SZ ${lid}`, roof));
            triMs = Math.min(triMs, await again("SZ Tri", TRI));
          }
          S.buildMs = ms;
          const fast = S.buildMs <= 2 * triMs + 5;
          if (!fast) slow.push(`${tag} ${f3(S.buildMs)} ms vs Tri ${f3(triMs)} ms`);
          ok(`${tag}: builds in ${S.buildMs.toFixed(1)} ms, within twice the Tri Home's ${triMs.toFixed(1)} ms`, fast);
        } else ok(`${tag}: a build time was measured`, false, `${S.buildMs} / ${triMs}`);
        ok(`${tag}: zero page errors`, errors.length === 0, errors.join(" | ").slice(0, 200));
        await page.close();
      } catch (e) { ok(`${tag}: ran`, false, e && e.message); }
    }
  }
  if (slow.length) console.log(`   SZ slow: ${slow.join("; ")}`);
}

// ── A · the Advanced page ────────────────────────────────────────────────────────────────────
const PORTAL_HTML = readFileSync(join(ROOT, "portal.html"), "utf8");
const OURS = "harness-internal";
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
const EXP = 4102444800;
const USER = { id: "00000000-0000-4000-8000-000000000047", aud: "authenticated", role: "authenticated", email: "wl@example.test", app_metadata: {}, user_metadata: {}, created_at: "2026-01-01T00:00:00Z" };
const SESSION = {
  access_token: `${b64({ alg: "HS256", typ: "JWT" })}.${b64({ sub: USER.id, role: "authenticated", email: USER.email, exp: EXP })}.c3R1Yg`,
  token_type: "bearer", expires_in: 999999999, expires_at: EXP, refresh_token: "r", user: USER,
};
const ADV_CONFIG = {
  branding: { companyName: "Harness Internal", accentColor: "#3D3672", headerBg: "#FFFFFF" },
  contactFields: [{ key: "name", label: "Name", required: true }],
  buildingStyles: [{ value: "hcabin", label: "Harness Cabin", sizes: [{ label: "12x16", w: 12, h: 16, price: 5000 }],
    d3: { roof: { type: "gable", pitch: 0.4, overhang: 0.6 }, siding: "batten", colors: { body: "#9B2F2F", trim: "#F4F1EA", roof: "#3E434A" }, wallHeightFt: 8 } }],
  defaultSizes: [], options: [],
  layoutItems: { door: { label: "Door", icon: "D", color: "#8B4513", width: 40, height: 12, shortLabel: "D" } },
  wallHeightFt: 8,
};
const ENT = { reason: "internal", status: "active", granted: ["view_3d"], features: { view_3d: true }, exempt: true, state: "exempt" };
const HDR = { "access-control-allow-origin": "*", "access-control-expose-headers": "*" };
const json = (route, body, status = 200) => route.fulfill({ status, contentType: "application/json", headers: HDR, body: JSON.stringify(body) });
async function openAdvanced(viewport = { width: 1440, height: 1000 }) {
  const actx = await browser.newContext({ viewport, serviceWorkers: "block" });
  await actx.addInitScript(([ref, s]) => {
    try { localStorage.setItem(`sb-${ref}-auth-token`, JSON.stringify(s)); } catch (_e) { /* storage blocked */ }
    window.__SS3D_DEBUG = true;
  }, [REF, SESSION]);
  const page = await actx.newPage();
  const errors = collectErrors(page);
  const calls = [];
  let made = 0;
  await page.route((u) => !/^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?\//.test(u.href), (route) => {
    const req = route.request();
    if (req.method() === "GET" && PASS_THROUGH_GET.test(req.url())) return route.continue();
    return route.abort();
  });
  const handler = async (route) => {
    const req = route.request(), url = req.url();
    if (req.method() === "OPTIONS") return route.fulfill({ status: 200, headers: { ...HDR, "access-control-allow-headers": "*", "access-control-allow-methods": "*" }, body: "" });
    let body = {};
    try { body = JSON.parse(req.postData() || "{}"); } catch (_e) { /* not JSON */ }
    const rpc = /\/rest\/v1\/rpc\/([a-z_]+)/.exec(url);
    if (rpc) {
      if (rpc[1] === "get_config") return json(route, ADV_CONFIG);
      if (rpc[1] === "get_fixtures") return json(route, []);
      return json(route, rpc[1] === "log_error" ? null : false);
    }
    if (url.includes("/rest/v1/client_users")) return json(route, [{ client_id: OURS, role: "owner" }]);
    if (url.includes("/rest/v1/")) return json(route, []);
    if (url.includes("/auth/v1/user")) return json(route, USER);
    if (url.includes("/auth/v1/")) return json(route, SESSION);
    if (url.includes("/portal-billing")) return json(route, { ok: true, configured: true, hasCard: false, plans: [], subscriptions: [], wallet: null, entitlement: ENT });
    if (url.includes("/portal-settings")) {
      calls.push({ action: body.action, body });
      if (body.action === "status") return json(route, { ok: true, clientId: OURS, role: "owner", settings: { business_name: OURS }, config: { company_name: OURS, accent_color: "#3D3672" }, access: null, prefs: null });
      if (body.action === "catalog") return json(route, { ok: true, aiReady: true, styles: [], sizes: [], layoutItems: [], fixtures: [], colors: [] });
      if (body.action === "create_style") { made++; return json(route, { ok: true, styleId: `00000000-0000-4000-8000-00000000c${String(made).padStart(3, "0")}`, key: `harness-wing-list-${made}` }); }
      if (body.action === "save_style_d3") return json(route, { ok: true, updatedAt: "2026-10-01T10:00:00.000+00:00" });
      return json(route, { ok: true });
    }
    return json(route, { ok: true });
  };
  await page.route(`**/${REF}.supabase.co/**`, handler);
  await page.route(`**/${REF}.functions.supabase.co/**`, handler);
  await page.route(`**/${REF}.storage.supabase.co/**`, handler);
  await page.route(/\/portal\/[a-z]/, (r) => r.fulfill({ status: 200, contentType: "text/html", body: PORTAL_HTML }));
  await page.goto(`${BASE}/portal/advanced`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => window.__ssAppBooted === true && !document.body.innerText.includes("Loading your business"), null, { timeout: 60000 });
  await page.waitForSelector('[data-ss-adv="sections"]', { timeout: 60000 });
  return { actx, page, errors, calls };
}
async function advModel(page, test, timeout = 60000) {
  await page.waitForFunction((src) => {
    const P = window.__ss3dPanel;
    if (!(P && P.model && P.model.massing && P.renderer && P.renderer.domElement.isConnected && P.renderer.domElement.closest('[data-ss-adv="view"]'))) return false;
    return new Function("M", `return (${src})(M);`)(P.model);
  }, test.toString(), { timeout });
}
async function typeBox(page, loc, v) { await loc.click(); await loc.fill(String(v)); await loc.blur(); await settle(page, 350); }
const wlCards = (page) => page.$$eval("[data-ss-adv-wl]", (c) => c.map((x) => ({ i: x.dataset.ssAdvWl, wall: x.dataset.ssAdvWlWall, tier: x.dataset.ssAdvWlTier,
  t: (x.querySelector(".ssd-card-t") || {}).textContent, lit: x.classList.contains("is-lit") })));
// Every Plan label inside its own section's rectangle (the middle's included), on screen: the texts that are not.
const planOverflow = (page) => page.evaluate(() => [...document.querySelectorAll('[data-ss-adv="wingplan"] svg > g')].flatMap((g) => {
  const r = g.querySelector("rect").getBoundingClientRect();
  return [...g.querySelectorAll("text")].filter((t) => { const b = t.getBoundingClientRect(); return b.width > 0 && (b.left < r.left - 1 || b.right > r.right + 1 || b.top < r.top - 1 || b.bottom > r.bottom + 1); })
    .map((t) => t.textContent);
}));
const mass = (page) => page.evaluate(() => { const m = window.__ss3dPanel.model.massing; return JSON.parse(JSON.stringify(m)); });
const clickF = async (page, f, wall) => { await page.locator(`[data-ss-adv-f="${f}"]${wall ? `[data-ss-adv-wall="${wall}"]` : ""}`).first().click(); await settle(page, 450); };
async function setSize(page, W, L) {
  for (const [lab, v] of [["Width (ft)", W], ["Length (ft)", L]]) {
    const b = page.getByLabel(lab, { exact: true }).first();
    await b.fill(String(v)); await b.blur(); await settle(page, 300);
  }
}
async function saveNew(page, calls, name) {
  const n = calls.filter((c) => c.action === "save_style_d3").length;
  await page.getByLabel("New style name").fill(name);
  await page.getByRole("button", { name: "Save as a new style" }).click();
  await page.waitForFunction(() => { const m = document.querySelector('[data-ss-adv="msg"]'); return m && /Saved as|failed|Couldn|isn't/.test(m.innerText); }, null, { timeout: 60000 });
  const t0 = Date.now();
  while (calls.filter((c) => c.action === "save_style_d3").length === n && Date.now() - t0 < 15000) await settle(page, 150);
  const sd = calls.filter((c) => c.action === "save_style_d3").pop();
  return sd && sd.body && sd.body.d3;
}
let savedA = null;   // A7's saved spec, for X
if (want("A")) {
  const { actx, page, errors, calls } = await openAdvanced();
  try {
    await setSize(page, 30, 32);
    await page.locator('[data-ss-adv-sec="wings"]').click();
    await settle(page, 300);
    const add0 = await page.evaluate(() => ({
      first: ((document.querySelector("[data-ss-adv-panel] button.ssd-tool") || {}).dataset || {}).ssAdvF,
      add: [...document.querySelectorAll('[data-ss-adv-f="wlAdd"]')].map((b) => b.dataset.ssAdvWall),
    }));
    ok("A1: the master switch is still the first tool button", add0.first === "wingsOn", String(add0.first));
    ok(`A1: the add row offers ${ENDS ? "every wall" : "the side walls only (end wings wait for their flag)"}`,
      JSON.stringify(add0.add) === JSON.stringify(ENDS ? ["left", "right", "back", "front"] : ["left", "right"]), JSON.stringify(add0.add));
    // The blank seed is the old frame with its wings off: nothing yet to fix to a wall, so no frame note (review, 2026-09-30).
    ok("A1: with the wings off there is no old-frame note", (await page.locator("[data-ss-adv-wl-frame]").count()) === 0);
    // Today's wings on: the legacy cards, and the add row under them.
    await page.locator('[data-ss-adv-f="wingsOn"]').click();
    await settle(page, 400);
    await advModel(page, (M) => M.massing.wings.length === 2 && !M.massing.list);
    const legacy = await page.$$eval("[data-ss-adv-wing]", (c) => c.map((x) => x.dataset.ssAdvWing));
    ok("A1: the legacy cards are unchanged (left, right)", JSON.stringify(legacy) === '["left","right"]', JSON.stringify(legacy));
    ok("A1: …and the wlAdd row is there", (await page.locator('[data-ss-adv-f="wlAdd"][data-ss-adv-wall="left"]').count()) === 1);
    // A side that already has today's wing says the new one goes ON that wing (review, 2026-09-30).
    const addTxt = sp(await page.locator('[data-ss-adv-f="wlAdd"][data-ss-adv-wall="left"]').innerText());
    ok("A1: …its button says it adds a wing on the left wing", addTxt === "+ Add a wing on the left wing", addTxt);
    ok(`A1: gable-wall add buttons ${ENDS ? "are" : "are not"} offered`, (await page.locator('[data-ss-adv-f="wlAdd"][data-ss-adv-wall="front"]').count()) === (ENDS ? 1 : 0));
    // Today's wings on the old frame: the note says what adding a wing HERE does, not that today's wings vanish.
    const frame1 = await page.$$eval("[data-ss-adv-wl-frame]", (b) => b.map((x) => x.innerText));
    ok("A1: …the old-frame note says it is about adding a wing here", frame1.length === 1 && frame1[0].startsWith("Adding a wing here fixes these wings to their walls."), JSON.stringify(frame1));
    const pre = await mass(page);
    // A2: + Left side converts today's wings and adds one outside the left one.
    await clickF(page, "wlAdd", "left");
    await advModel(page, (M) => M.massing.list && M.massing.wings.length === 3);
    const m1 = await mass(page);
    let cards = await wlCards(page);
    ok("A2: three cards: left, left, right (the converted pair plus the new left)", JSON.stringify(cards.map((c) => [c.wall, c.tier])) === '[["left","1"],["left","2"],["right","1"]]', JSON.stringify(cards));
    // The "until this update reaches your live site" note is for beta hosts only; here (127.0.0.1) it is absent.
    ok("A2: the live-site note is not shown off a beta host", (await page.locator("[data-ss-adv-wl-live]").count()) === 0);
    const preR = pre.wings.find((g) => g.side > 0), r1 = m1.wings.find((g) => g.side > 0);
    ok("A2: the tier-1 wings keep their width and pitch; the right one its lines", m1.wings.filter((g) => g.tier === 1).every((g) => pre.wings.some((p) => p.side === g.side && near(p.w, g.w, 1e-9) && near(p.pitch, g.pitch, 1e-9)))
      && near(preR.u0, r1.u0, 1e-9) && near(preR.u1, r1.u1, 1e-9) && near(preR.ye, r1.ye, 1e-9), JSON.stringify({ pre: pre.wings.map((g) => [g.side, g.w, g.pitch, g.u0]), now: m1.wings.map((g) => [g.side, g.tier, g.w, g.pitch, g.u0]) }));
    // A3: + Add a wing on Left wing 2, typed 6 wide.
    await clickF(page, "wlAddOn", "left");
    await advModel(page, (M) => M.massing.wings.length === 4);
    cards = await wlCards(page);
    ok("A3: + Add a wing on Left wing 2 makes a third left wing", JSON.stringify(cards.filter((c) => c.wall === "left").map((c) => c.tier)) === '["1","2","3"]', JSON.stringify(cards));
    await typeBox(page, page.getByLabel("Left wing 3 width (ft)", { exact: true }), 6);
    await advModel(page, (M) => M.massing.wings.some((g) => g.tier === 3 && Math.abs(g.w - 6) < 1e-9));
    ok("A3: typing 6 into Left wing 3 width (ft) draws it 6 wide", true);
    // The box commits on every keystroke: a half-typed "0" holds the wing at 1 ft and never removes it (only ✕
    // does; review, 2026-09-30, where a Backspace to "0" took a wing and its settings away).
    const box3 = page.getByLabel("Left wing 3 width (ft)", { exact: true });
    await box3.click(); await box3.press("Control+a"); await box3.press("0"); await settle(page, 350);
    const mid0 = await wlCards(page);
    await advModel(page, (M) => M.massing.wings.some((g) => g.tier === 3 && Math.abs(g.w - 1) < 1e-9));
    await box3.press("Backspace"); await box3.press("6"); await box3.blur(); await settle(page, 350);
    await advModel(page, (M) => M.massing.wings.some((g) => g.tier === 3 && Math.abs(g.w - 6) < 1e-9));
    ok("A3: a box that reads 0 mid-typing keeps Left wing 3 (drawn 1 ft wide), and 6 typed after it draws 6", mid0.filter((c) => c.wall === "left").length === 3
      && (await wlCards(page)).filter((c) => c.wall === "left").length === 3, JSON.stringify(mid0));
    // A4: the Plan card.
    const m3 = await mass(page);
    const plan = await page.$$eval('[data-ss-adv="wingplan"] [data-ss-plan-wl]', (g) => g.map((x) => x.dataset.ssPlanWl));
    ok("A4: the Plan has one section per drawn wing", plan.length === m3.wings.length + m3.ends.length && m3.wings.every((g) => plan.includes(String(g.i))), JSON.stringify(plan));
    const pick = m3.wings.find((g) => g.tier === 2);
    await page.locator(`[data-ss-adv="wingplan"] [data-ss-plan-wl="${pick.i}"]`).click();
    await settle(page, 300);
    cards = await wlCards(page);
    const litRect = await page.$eval(`[data-ss-adv="wingplan"] [data-ss-plan-wl="${pick.i}"] rect`, (r) => r.getAttribute("stroke"));
    const over4 = await planOverflow(page);
    ok("A4: every Plan label fits inside its section", over4.length === 0, JSON.stringify(over4));
    ok("A4: clicking a wing in the Plan focuses its card and lights its rectangle", cards.filter((c) => c.lit).map((c) => c.i).join() === String(pick.i) && litRect === "#B45309", JSON.stringify({ lit: cards.filter((c) => c.lit), litRect }));
    // A5: Left wing 2's outside wall asked 9.5 ft; Left wing 3 at 12 in 12, Automatic, pushes it up.
    await typeBox(page, page.getByLabel("Left wing 2 outside wall height (ft)", { exact: true }), 9.5);
    await typeBox(page, page.getByLabel("Left wing 3 roof pitch", { exact: true }), 12);
    await advModel(page, (M) => M.massing.wings.some((g) => g.tier === 2 && g.raised));
    const m4 = await mass(page);
    const g2 = m4.wings.find((g) => g.side < 0 && g.tier === 2), g3 = m4.wings.find((g) => g.side < 0 && g.tier === 3);
    const pushTxt = sp(await page.locator(`[data-ss-adv-readout="wl-push-${g2.i}"]`).innerText().catch(() => ""));
    ok("A5: wl-push-<i> names the pushing wing", /Left wing 3/.test(pushTxt) && /pushes it up/.test(pushTxt) && g2.raisedBy.includes(g3.i) && g2.raisedFrom === 9.5, pushTxt);
    // A6: an end wing (flag on).
    if (ENDS) {
      await clickF(page, "wlAdd", "front");
      await advModel(page, (M) => M.massing.ends && M.massing.ends.length === 1);
      const me = await mass(page);
      ok("A6: + Front end adds an end wing", me.ends.length === 1 && me.ends[0].wall === "south", JSON.stringify(me.ends.map((t) => [t.i, t.wall])));
      const byEnd = me.wings.filter((g) => g.raised && (g.raisedBy || []).includes(me.ends[0].i));
      const says = [];
      for (const g of byEnd) says.push(sp(await page.locator(`[data-ss-adv-readout="wl-push-${g.i}"]`).innerText().catch(() => "")));
      ok("A6: …and each side card the end wing raised says so, from and to", byEnd.length >= 1 && says.every((t) => /Raised from .+ to .+ over the middle stretch/.test(t)),
        JSON.stringify({ raised: byEnd.map((g) => [g.i, g.raisedFrom, g.ye]), says }));
      const fi = me.ends[0].i;
      await page.locator(`[data-ss-adv-wl="${fi}"] [data-ss-adv-f="wlRemove"]`).click();
      await settle(page, 450);
      await advModel(page, (M) => !M.massing.ends.length && M.massing.wings.length === 4);
    }
    if (process.env.SS_SHOTS) {
      await page.locator("[data-ss-adv-panel]").screenshot({ path: join(shots, "A-wings-panel-1440.png") }).catch(() => {});
      await page.locator('[data-ss-adv="wingplan"]').screenshot({ path: join(shots, "A-plan-1440.png") }).catch(() => {});
    }
    // A7: Save as new: the list exactly, and the older designer's approximation beside it.
    const conv = pre.wings.map((g) => ({ wall: g.side < 0 ? "left" : "right", widthFt: g.w, pitch: g.pitch }));
    const expectList = [...conv, { wall: "left", widthFt: 8, eaveFt: 9.5 }, { wall: "left", widthFt: 6, pitch: 1 }];
    const d3 = await saveNew(page, calls, "Harness Wing List");
    const roof = d3 && d3.roof;
    savedA = d3;
    console.log(`   A7: saved roof keys ${roof ? Object.keys(roof).join(",") : "none"}`);
    ok("A7: Save sends the list exactly", !!roof && JSON.stringify(roof.wingList) === JSON.stringify(expectList), `${JSON.stringify(roof && roof.wingList)} vs ${JSON.stringify(expectList)}`);
    const t1L = m4.wings.find((g) => g.side < 0 && g.tier === 1), sumL = m4.wings.filter((g) => g.side < 0).reduce((t, g) => t + g.w, 0);
    const fb = PURE.d3WingListFallback(roof || {}, 30, 32, m4.H);
    // The left stack (18 ft) is more than twice the right one (4 ft): the older designer draws the left stack
    // alone, rather than 13 ft on each side (review, 2026-09-30).
    ok("A7: …with the fallback: the wider left stack alone, its width, the pitch that meets where its tier 1 does", !!roof && roof.wingSide === "left" && near(roof.wingWidthFt, Math.min(16, sumL), 1e-9)
      && near(roof.wingPitch, Math.max(0, Math.min(1.5, (t1L.ya - m4.H) / Math.min(16, sumL))), 1e-9) && roof.wingSide === fb.wingSide && roof.wingWidthFt === fb.wingWidthFt && roof.wingPitch === fb.wingPitch,
      JSON.stringify({ side: roof && roof.wingSide, w: roof && roof.wingWidthFt, p: roof && roof.wingPitch, sumL, ya: t1L.ya }));
    // Today's switch never writes centerEaveFt, and the list's writers never touch it: still absent.
    ok("A7: …centerEaveFt as it was (absent), and no wingSides / wingAttach / wingAttachFt", !!roof && !("centerEaveFt" in roof) && !("wingSides" in roof) && !("wingAttach" in roof) && !("wingAttachFt" in roof),
      JSON.stringify(roof && Object.keys(roof)));
    // A9: Move out Left wing 1 swaps it with Left wing 2.
    const c0 = (await wlCards(page)).find((c) => c.wall === "left" && c.tier === "1");
    const w0 = m4.wings.find((g) => g.i === Number(c0.i)).w;
    await page.locator(`[data-ss-adv-wl="${c0.i}"] [data-ss-adv-f="wlMove"] button`, { hasText: "Move out" }).click();
    await settle(page, 450);
    await advModel(page, (M) => M.massing.wings.filter((g) => g.side < 0 && g.tier === 1).every((g) => Math.abs(g.w - 8) < 1e-9));
    const mv = await mass(page);
    ok("A9: Move out swaps Left wing 1 with Left wing 2", near(mv.wings.find((g) => g.side < 0 && g.tier === 2).w, w0, 1e-9), JSON.stringify(mv.wings.map((g) => [g.i, g.bwall, g.tier, g.w])));
    // A8: ✕ on Left wing 1: the tiers renumber and the massing follows.
    const x1 = (await wlCards(page)).find((c) => c.wall === "left" && c.tier === "1");
    const xTitle = await page.locator(`[data-ss-adv-wl="${x1.i}"] [data-ss-adv-f="wlRemove"]`).getAttribute("title");
    ok("A8: the ✕ says what moves", /^Remove Left wing 1\./.test(xTitle || "") && /moves? in/.test(xTitle || ""), xTitle);
    await page.locator(`[data-ss-adv-wl="${x1.i}"] [data-ss-adv-f="wlRemove"]`).click();
    await settle(page, 450);
    await advModel(page, (M) => M.massing.wings.length === 3);
    cards = await wlCards(page);
    const m8 = await mass(page);
    ok("A8: after ✕ the left tiers renumber 1, 2 and the massing follows", JSON.stringify(cards.filter((c) => c.wall === "left").map((c) => c.tier)) === '["1","2"]' && /^Left wing 1/.test(cards[0].t)
      && JSON.stringify(m8.wings.filter((g) => g.side < 0).map((g) => g.tier).sort()) === "[1,2]", JSON.stringify(cards));
    // A10: add to 16: every add disabled, and the page says so; every wing not drawn is named.
    for (let k = 0; k < 13; k++) { await page.locator('[data-ss-adv-f="wlAddOn"][data-ss-adv-wall="right"]').click(); await settle(page, 120); }
    await settle(page, 600);
    const cap = await page.evaluate(() => ({ n: document.querySelectorAll("[data-ss-adv-wl]").length,
      dis: [...document.querySelectorAll('[data-ss-adv-f="wlAdd"],[data-ss-adv-f="wlAddOn"]')].map((b) => b.disabled),
      note: /Up to 16 wings on one building/.test(document.querySelector("[data-ss-adv-panel]").innerText) }));
    ok("A10: at 16 every wlAdd / wlAddOn is disabled, and the note shows", cap.n === 16 && cap.dis.length > 0 && cap.dis.every(Boolean) && cap.note, JSON.stringify(cap));
    // A wing squeezed to 6 in or less by the room share is not drawn at this size: its card says so, and
    // it stays in the list (1 ft, the least the box takes, asked beside 16 wings shares out well under 0.5).
    const lastR = (await wlCards(page)).filter((c) => c.wall === "right").pop();
    await typeBox(page, page.getByLabel(`Right wing ${lastR.tier} width (ft)`, { exact: true }), 1);
    await advModel(page, (M) => M.massing.listDropped.length > 0);
    const m16 = await mass(page);
    const dropped = await page.$$eval("[data-ss-adv-wl-dropped]", (s) => s.map((x) => x.innerText));
    ok("A10: a wing too narrow to draw at this size is named on its card, and stays in the list",
      m16.listDropped.length >= 1 && m16.listDropped.every((d) => d.why === "room") && m16.listDropped.some((d) => String(d.i) === lastR.i)
      && dropped.length === m16.listDropped.length && (await wlCards(page)).length === 16, JSON.stringify({ listDropped: m16.listDropped, dropped: dropped.map(sp) }));
    // A12: the master switch off: nothing drawn, and Save sends no wing key at all.
    await page.locator('[data-ss-adv-f="wingsOn"]').click();
    await settle(page, 450);
    await advModel(page, (M) => !M.massing.list && M.massing.wings.length === 0);
    const d3off = await saveNew(page, calls, "Harness No Wings");
    const WK = ["wingSide", "wingWidthFt", "wingPitch", "centerEaveFt", "wingSides", "wingAttach", "wingAttachFt", "wingList"];
    ok("A12: wings off: Save sends no wing key", !!d3off && WK.every((k) => !(k in d3off.roof)), JSON.stringify(d3off && Object.keys(d3off.roof)));
    ok("A13: zero page errors", errors.length === 0, errors.slice(0, 3).join(" | "));
  } catch (e) { ok("A: ran", false, e && e.stack); }
  await actx.close();

  // A11: at 390 px: no sideways scroll, one column.
  const ph = await openAdvanced({ width: 390, height: 844 });
  try {
    await setSize(ph.page, 30, 32);
    await ph.page.locator('[data-ss-adv-sec="wings"]').click();
    await settle(ph.page, 300);
    await clickF(ph.page, "wlAdd", "left");
    await clickF(ph.page, "wlAddOn", "left");
    await clickF(ph.page, "wlAdd", "right");
    await ph.page.waitForFunction(() => document.querySelectorAll("[data-ss-adv-wl]").length === 3, null, { timeout: 30000 });
    await settle(ph.page, 600);
    const lay = await ph.page.evaluate(() => {
      const se = document.scrollingElement;
      const cs = [...document.querySelectorAll("[data-ss-adv-wl]")].map((c) => c.getBoundingClientRect());
      return { sw: se.scrollWidth, cw: se.clientWidth, lefts: [...new Set(cs.map((r) => Math.round(r.left)))] };
    });
    ok("A11: at 390 px no sideways scroll", lay.sw <= lay.cw, JSON.stringify(lay));
    // A 6 ft middle at 390 px: its label turns on end rather than running over the wings (review, 2026-09-30).
    const over11 = await planOverflow(ph.page);
    ok("A11: every Plan label fits inside its section at 390 px", over11.length === 0, JSON.stringify(over11));
    // …and reads at 10 px or more there: the card draws 270 units in about 240 px (review, 2026-09-30).
    const px11 = await ph.page.evaluate(() => {
      const svg = document.querySelector('[data-ss-adv="wingplan"] svg'), k = svg.getBoundingClientRect().width / svg.viewBox.baseVal.width;
      return [...svg.querySelectorAll("text")].map((t) => [t.textContent, +(parseFloat(getComputedStyle(t).fontSize) * k).toFixed(1)]);
    });
    ok("A11: every Plan label renders at 10 px or more at 390 px", px11.length > 0 && px11.every(([t, px]) => t === "FRONT" ? px >= 9 : px >= 10), JSON.stringify(px11));
    ok("A11: …and the cards stack in one column", lay.lefts.length === 1, JSON.stringify(lay));
    if (process.env.SS_SHOTS) await ph.page.locator("[data-ss-adv-panel]").screenshot({ path: join(shots, "A-wings-panel-390.png") }).catch(() => {});
    ok("A11: zero page errors", ph.errors.length === 0, ph.errors.slice(0, 3).join(" | "));
  } catch (e) { ok("A11: ran", false, e && e.stack); }
  await ph.actx.close();
}

// ── P · the calibration panel ─────────────────────────────────────────────────────────────────
if (want("P")) {
  const roof = { ...G, wingSide: "both", wingWidthFt: 14, wingPitch: 0.32142857142857145, wingList: CASE_S.wingList };
  const d3 = D3of(roof, 9);
  const page = await ctx.newPage();
  const errors = collectErrors(page);
  try {
    const calls = await stubSupabase(page, { config: configFor("Harness WL Cal", "30x32", d3, "harness-winglist-cal"), fixtures: FIXTURES });
    await page.goto(`${BASE}/?client=harness-winglist-cal&admin=1`, { waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => window.__ssAppBooted === true && typeof window.StructureStudio === "function", null, { timeout: 60000 });
    await page.getByText("3D Style Calibration").first().waitFor({ state: "visible", timeout: 30000 });
    await page.getByPlaceholder("Admin password").fill("harness");
    await page.getByRole("button", { name: "Harness WL Cal", exact: true }).first().click();
    await page.waitForFunction(() => document.querySelector("[data-ss-cal-winglist]"), null, { timeout: 30000 });
    const txt = await page.evaluate(() => ({ note: document.querySelector("[data-ss-cal-winglist]").innerText, body: document.body.innerText }));
    ok("P: a list style shows the note", txt.note.trim() === "This style has 3 wings, set on the Advanced page.", txt.note);
    ok("P: …and no 'Lower wings, each' box", !/Lower wings, each/.test(txt.body));
    await page.getByRole("button", { name: "Save to config" }).click();
    const saves = () => calls.filter((x) => x.path && x.path.endsWith("/functions/v1/admin-save-settings") && x.body && x.body.action === "save_style_d3");
    const t0 = Date.now();
    while (!saves().length && Date.now() - t0 < 15000) await settle(page, 150);
    const body = saves()[0] && saves()[0].body;
    ok("P: Save to config, untouched, sends the roof exactly as stored", !!body && JSON.stringify(body.d3.roof) === JSON.stringify(roof), body && JSON.stringify(body.d3.roof));
    // A single slant drops every wing key, the list included (calSetRoofType("shed") deletes CAL_WING_KEYS). This
    // is the list-carrying seed calNewKeys' step 7 never had (review, 2026-09-30).
    await page.locator("label").filter({ hasText: /^Roof type/ }).locator("select").selectOption("shed");
    await settle(page, 400);
    await page.getByRole("button", { name: "Save to config" }).click();
    const t1 = Date.now();
    while (saves().length < 2 && Date.now() - t1 < 15000) await settle(page, 150);
    const shed = saves()[1] && saves()[1].body && saves()[1].body.d3.roof;
    const WK = ["wingSide", "wingWidthFt", "wingPitch", "centerEaveFt", "wingSides", "wingAttach", "wingAttachFt", "wingList"];
    ok("P: a single slant drops the list with every wing key", !!shed && shed.type === "shed" && WK.every((k) => !(k in shed)), JSON.stringify(shed && Object.keys(shed)));
    ok("P: zero page errors", errors.length === 0, errors.slice(0, 3).join(" | "));
  } catch (e) { ok("P: ran", false, e && e.stack); }
  await page.close();
}

// ── X · the older designer ─────────────────────────────────────────────────────────────────────
const OLD = process.env.SS_WINGLIST_OLD_BASE;
if (want("X") && OLD) {
  // A's saved spec when A ran; else Case S with the fallback the page would write.
  const d3 = savedA || D3of({ ...CASE_S, ...(() => { const fb = PURE.d3WingListFallback(CASE_S, 30, 32, 9); return { wingSide: fb.wingSide, wingWidthFt: fb.wingWidthFt, wingPitch: fb.wingPitch }; })() }, 9);
  const size = "30x32";
  try {
    const { page, errors } = await openCase("Older Designer", size, d3, { base: OLD });
    const m = await page.evaluate(() => JSON.parse(JSON.stringify(window.__ss3dEngine.model.massing)));
    // The approximation (d3WingListFallback) asks one width: both sides at the two stacks' mean when they are
    // about one width, else the wider stack alone. The older designer then shares the room as it always has, so
    // what it draws is the legacy massing of those keys alone -- and it is judged against beta's massing of the
    // list: the same middle height, and a middle no further off than the narrower stack (review, 2026-09-30).
    const [W, L] = sizeOf(size);
    const H = Number(d3.wallHeightFt) || 8;
    const beta = PURE.d3Massing(d3.roof, W, L, H);
    const stack = (s) => beta.wings.filter((g) => g.side === s).reduce((t, g) => t + g.w, 0);
    const sN = stack(-1), sP = stack(1), both = Math.max(sN, sP) <= 2 * Math.min(sN, sP) + 1e-9;
    const legacyRoof = { ...d3.roof }; delete legacyRoof.wingList;
    const lm = PURE.d3Massing(legacyRoof, W, L, H);
    ok("X: the approximation asks the mean of two stacks of about one width, else the wider stack alone",
      d3.roof.wingSide === (both ? "both" : sN >= sP ? "left" : "right") && near(d3.roof.wingWidthFt, Math.min(16, both ? (sN + sP) / 2 : Math.max(sN, sP)), 1e-9),
      JSON.stringify({ side: d3.roof.wingSide, w: d3.roof.wingWidthFt, sN, sP }));
    ok("X: the older designer draws exactly the legacy massing of those keys", m.wings.length === lm.wings.length && !("list" in m)
      && m.wings.every((g, k) => near(g.w, lm.wings[k].w, 1e-9) && near(g.ya, lm.wings[k].ya, 1e-9)) && near(m.Hc, lm.Hc, 1e-9),
      JSON.stringify({ drawn: m.wings.map((g) => [g.w, g.ya]), legacy: lm.wings.map((g) => [g.w, g.ya]), Hc: [m.Hc, lm.Hc] }));
    // (plus what the 16 ft cap on the one width leaves out: an 18 ft stack is drawn 16 wide)
    const capped = both ? 2 * Math.max(0, (sN + sP) / 2 - 16) : Math.max(0, Math.max(sN, sP) - 16);
    ok("X: …at beta's middle height, with a middle no further off than the narrower stack", near(m.Hc, beta.Hc, 1e-6)
      && Math.abs(m.Sc - beta.Sc) <= (both ? 0 : Math.min(sN, sP)) + capped + 1e-6, JSON.stringify({ Hc: [m.Hc, beta.Hc], Sc: [m.Sc, beta.Sc], sN, sP, capped }));
    ok("X: zero page errors", errors.length === 0, errors.slice(0, 3).join(" | "));
    await page.close();
  } catch (e) { ok("X: ran", false, e && e.stack); }
}

await browser.close();
const f = failed();
console.log(f.length ? `\n${f.length} check(s) FAILED` : "\nall checks passed");
if (process.env.SS_SHOTS) console.log(`shots in ${shots}`);
process.exitCode = f.length ? 1 : 0;
