// The porch gable, MEASURED: every mesh on a gable end, where it sits in depth, and what that means.
//
// Carolyn, 2026-09-14 (call at 2:45-3:28, drawing on the full-screen 3D of her Cabin, 12x32 with
// an open porch and the king-post truss): green marks through the gable vent at the truss foot and
// along the top of the porch header. Read as two faults, and this script exists so neither is
// guessed at:
//   H1  the "extra 2x4 along the header" is the style gable vent's SILL trim board, laid right on
//       top of the porch header (the vent sits 2 in above the plate and the header's top IS the plate)
//   H2  "the vent merging with the wood" is a DEPTH overlap: the vent frame stands 0.15-0.25 ft out
//       from the cap and the truss 0.03-0.45, so the king post and braces pass through the frame
//
// It reads the scene graph through __SS3D_DEBUG (window.__ss3dEngine), classifies the meshes on
// each gable end, prints them, asserts the depth ladder, and takes aimed screenshots with the
// candidates tinted. Each variant is a fresh page, because the full-screen viewer builds from the
// props it opened with.
//
//   python -m http.server 8125 --bind 127.0.0.1                  (repo root)
//   node tests/harness/gableProbe.mjs                            (hand-written config, 6 variants)
//   SS_CONFIG_FILE=cfg.json SS_FIXTURES_FILE=fx.json SS_STYLES=Cabin node tests/harness/gableProbe.mjs
//       (a saved get_config read — how the real tenant's Cabin was measured on 2026-09-15)
//   SS_VARIANTS=porch:batten,plain:panel  PROBE_WALL_VENT=1  SS_SHOTS=<dir>
//
// Exit 0 = every assertion held. PROBE_REPORT_ONLY=1 prints the same checks but always exits 0
// (the measuring run against the unfixed build, where the assertions are EXPECTED to fail).
import { pathToFileURL } from "node:url";
import { readFileSync, writeFileSync } from "node:fs";
import { launch, stubSupabase, collectErrors, openDesigner, readItems, reporter, shotsDir } from "./lib.mjs";

const W = 12, L = 32, SIZE = `${W}x${L}`;
const TRIM = "#b0a081", BODY = "#4a3327", VENT_DARK = "#2a2e33";

// The measured Cabin's 3D spec, copied field for field; only the name is ours.
const PORCH_D3 = {
  roof: { eave: "fascia", type: "gable", pitch: 0.42, overhang: 0.8, porchEnd: "front", porchTruss: true, ridgeOffset: 0, porchDepthFt: 6 },
  colors: { body: BODY, roof: "#8a8f94", trim: TRIM },
  siding: "batten", gableVent: { widthFrac: 0.12 }, foundation: "skids", roofMaterial: "metal", wallHeightFt: 7.5,
};
const PLAIN_D3 = { ...PORCH_D3, roof: { eave: "fascia", type: "gable", pitch: 0.42, overhang: 0.8, ridgeOffset: 0 } };
const CLADS = ["panel", "lap", "batten", "agpanel"].map((id) => ({ id, rate: 0, basis: "sqft_option", label: null, charged: false }));
const style = (value, label, d3) => ({ value, label, img: null, sizes: [SIZE], sizeInclusions: {}, sizeInclusionQty: {}, d3 });

export const CONFIG = {
  clientId: "harness-gable",
  branding: { companyName: "Harness Sheds", accentColor: "#1D4ED8", headerBg: "#FFFFFF", tagline: null, logo: null },
  contactFields: ["name", "email", "phone"],
  buildingStyles: [style("porch", "Porch Cabin", PORCH_D3), style("plain", "Gable Cabin", PLAIN_D3)],
  defaultSizes: [SIZE],
  sizePricing: { porch: { [SIZE]: { widthFt: W, lengthFt: L, basePrice: 10000 } }, plain: { [SIZE]: { widthFt: W, lengthFt: L, basePrice: 9000 } } },
  options: [], colors: [], claddingOptions: { porch: CLADS, plain: CLADS }, wallHeightOptions: {},
  showPricing: true, view3d: true, layoutItems: {}, layoutPricing: {}, layoutPrices: {},
  electrical: null, electricalItems: [], insulation: [],
};
export const FIXTURES = {
  ramp: { mode: "simple", price: 0, method: "each", enabled: false, imageUrl: null, showImage: false },
  items: [{ id: "v-std", name: "Standard Vent", price: 25, widthIn: 12, heightIn: 8, category: "vent", colorMode: "fixed", planLabel: "SVNT", sortOrder: 0, imageUrl: null,
    opLeft: false, opRight: false, opDouble: false, opSlideUp: false, opDefault: null, swingIn: false, swingOut: false, swingDefault: null, hasTrimColor: false }],
  windowColors: [],
};

const settle = (page, ms = 400) => page.waitForTimeout(ms);
const near = (a, b, eps = 0.012) => Math.abs(a - b) <= eps;

export async function pickStyle(page, label) {
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
export async function chooseSize(page) {
  const sel = page.locator("select").filter({ has: page.locator("option", { hasText: SIZE }) });
  await sel.first().selectOption({ label: SIZE });
  await page.waitForFunction((l) => [...document.querySelectorAll("svg text")].some((t) => t.textContent.trim() === `${l} ft`), L, { timeout: 15000 });
}
export async function chooseCladding(page, id) {
  const sel = page.locator("select").filter({ has: page.locator("option", { hasText: "Builder's standard" }) });
  if (!(await sel.count())) throw new Error("no Cladding control");
  await sel.first().selectOption(id);
  await settle(page, 300);
}
export async function openEditor(page) {
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
  // "ready" enables the Add row; until then an async texture pass may still be swapping materials.
  await page.waitForFunction(() => [...document.querySelectorAll("button")].some((b) => /SVNT/.test(b.innerText) && !b.disabled), null, { timeout: 90000 }).catch(() => {});
  await settle(page, 1200);
}

// Every mesh in the roof, openings and walls groups: world bbox, the BoxGeometry's own
// width/height/depth, its rotation about z, colour, and the item group it belongs to.
export async function sceneMeshes(page) {
  return page.evaluate(() => {
    const E = window.__ss3dEngine;
    const V = E.camera.position.constructor;
    E.scene.updateMatrixWorld(true);
    const hexOf = (m) => { const mm = Array.isArray(m) ? m[m.length - 1] : m; return mm && mm.color ? "#" + mm.color.getHexString() : null; };
    const r3 = (v) => Math.round(v * 1000) / 1000;
    const out = [];
    window.__probeMesh = [];
    const groups = { roof: E.model.roofGroup, openings: E.model.openingsGroup, walls: E.model.wallsGroup };
    Object.keys(groups).forEach((gname) => {
      groups[gname].traverse((o) => {
        if (!o.isMesh || !o.geometry || !o.visible) return;
        if (!o.geometry.boundingBox) o.geometry.computeBoundingBox();
        const bb = o.geometry.boundingBox;
        const mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
        [bb.min.x, bb.max.x].forEach((x) => [bb.min.y, bb.max.y].forEach((y) => [bb.min.z, bb.max.z].forEach((z) => {
          const v = new V(x, y, z).applyMatrix4(o.matrixWorld);
          [v.x, v.y, v.z].forEach((c, k) => { mn[k] = Math.min(mn[k], c); mx[k] = Math.max(mx[k], c); });
        })));
        let q = o, itemId = null, gable = false;
        while (q) { if (q.userData && q.userData.itemId) { itemId = q.userData.itemId; gable = !!q.userData.gable; break; } q = q.parent; }
        const p = o.geometry.parameters || {};
        window.__probeMesh.push(o);
        out.push({
          i: out.length, group: gname, itemId, gable, geom: o.geometry.type, color: hexOf(o.material),
          box: p.width != null && p.depth != null ? [r3(p.width), r3(p.height), r3(p.depth)] : null,
          rotZ: r3(o.rotation.z), min: mn.map(r3), max: mx.map(r3),
          ctr: mn.map((v, k) => r3((v + mx[k]) / 2)), size: mn.map((v, k) => r3(mx[k] - v)),
        });
      });
    });
    return out;
  });
}

// Which mesh is which, on one gable end. `sgn` is +1 for the end at world +z (the porch end: the
// porch takes the FRONT, which is south, which is +z for this portrait footprint), -1 for -z.
// "out" is the distance from the wall's mid-plane toward the outside, so both ends read the same.
export function classifyEnd(meshes, sgn, H) {
  const zMid = sgn * (L / 2);
  const outOf = (m) => ({ back: sgn > 0 ? m.min[2] - zMid : zMid - m.max[2], front: sgn > 0 ? m.max[2] - zMid : zMid - m.min[2] });
  const onEnd = meshes.filter((m) => m.group === "roof" && (sgn > 0 ? m.max[2] > zMid - 0.7 && m.min[2] > zMid - 1.2 : m.min[2] < zMid + 0.7 && m.max[2] < zMid + 1.2));
  const withOut = (m) => ({ ...m, ...outOf(m) });
  const cap = meshes.filter((m) => m.group === "roof" && m.geom === "ExtrudeGeometry").map((m) => ({ ...m, face: sgn > 0 ? m.max[2] - zMid : zMid - m.min[2] }))
    .sort((a, b) => b.size[0] - a.size[0])[0] || null;
  const louvre = onEnd.filter((m) => m.color === VENT_DARK && m.min[1] >= H - 0.01).map(withOut);
  const vTrim = louvre.length ? onEnd.filter((m) => m.color === TRIM && m.box && !m.rotZ && m.min[1] >= H - 0.05
    && m.max[1] <= louvre[0].max[1] + 0.2 && m.min[0] >= louvre[0].min[0] - 0.2 && m.max[0] <= louvre[0].max[0] + 0.2
    && !(near(m.box[2], 0.42) || near(m.box[0], 12, 0.05))).map(withOut) : [];
  const truss = onEnd.filter((m) => m.color === TRIM && m.box && near(m.box[2], 0.42) && m.min[1] >= H - 0.3).map(withOut);
  const braces = truss.filter((m) => Math.abs(m.rotZ) > 0.01);
  const header = onEnd.filter((m) => m.color === TRIM && m.box && near(m.box[0], W, 0.05) && near(m.box[1], 0.5) && near(m.box[2], 0.4)).map(withOut)[0] || null;
  const strips = onEnd.filter((m) => m.box && !m.rotZ && m.min[1] >= H - 0.01 && m.color !== TRIM && m.color !== VENT_DARK && m.box[0] <= 0.2 && m.box[2] <= 0.11).map(withOut);
  // A flat trim-coloured board lying within 0.25 ft above the header's top: H1's "extra 2x4".
  const boardsOnHeader = header ? onEnd.filter((m) => m.color === TRIM && m.box && !m.rotZ && !near(m.box[2], 0.42) && m !== header
    && m.size[0] > 3 * m.size[1] && m.min[1] >= header.max[1] - 0.02 && m.min[1] <= header.max[1] + 0.25).map(withOut) : [];
  return { zMid, cap, louvre, vTrim, truss, braces, header, strips, boardsOnHeader, bandMeshes: onEnd.filter((m) => m.max[1] > H - 0.6).map(withOut) };
}

const zr = (m) => `${m.back.toFixed(3)}..${m.front.toFixed(3)}`;
function printEnd(tag, e, H) {
  const lines = [`  ${tag}: cap face out ${e.cap ? e.cap.face.toFixed(3) : "?"}`];
  if (e.header) lines.push(`    header      y ${e.header.min[1].toFixed(3)}..${e.header.max[1].toFixed(3)} (H+${(e.header.max[1] - H).toFixed(3)} top)  out ${zr(e.header)}`);
  e.louvre.forEach((m) => lines.push(`    vent louvre ${m.size[0].toFixed(2)}x${m.size[1].toFixed(2)} centre y ${m.ctr[1].toFixed(3)}  out ${zr(m)}`));
  e.vTrim.forEach((m) => lines.push(`    vent trim   ${m.box.join("x")} y ${m.min[1].toFixed(3)}..${m.max[1].toFixed(3)} (H+${(m.min[1] - H).toFixed(3)})  out ${zr(m)}`));
  e.truss.forEach((m) => lines.push(`    truss ${m.rotZ ? "brace" : "post "} ${m.box.join("x")} rotZ ${m.rotZ} y ${m.min[1].toFixed(3)}..${m.max[1].toFixed(3)}  x ${m.min[0].toFixed(2)}..${m.max[0].toFixed(2)}  out ${zr(m)}`));
  if (e.strips.length) lines.push(`    gable strips x${e.strips.length}  out ${zr(e.strips[0])}`);
  e.boardsOnHeader.forEach((m) => lines.push(`    ⚠ board on header ${m.box.join("x")} y ${m.min[1].toFixed(3)}..${m.max[1].toFixed(3)} x ${m.min[0].toFixed(2)}..${m.max[0].toFixed(2)}`));
  console.log(lines.join("\n"));
}

// Aim, render synchronously, screenshot the canvas. `tint` maps mesh index -> hex.
export async function shot(page, path, { eye, at, tint = {} }) {
  await page.evaluate(({ eye, at, tint }) => {
    const E = window.__ss3dEngine;
    window.__probeRestore = window.__probeRestore || [];
    window.__probeRestore.forEach(([o, m]) => { o.material = m; });
    window.__probeRestore = [];
    Object.keys(tint).forEach((k) => {
      const o = window.__probeMesh[+k];
      if (!o) return;
      const orig = o.material;
      const base = Array.isArray(orig) ? orig[0] : orig;
      const t = base.clone();
      t.map = null; t.color.set(tint[k]);
      if (t.emissive) t.emissive.set(tint[k]).multiplyScalar(0.35);
      t.needsUpdate = true;
      o.material = t;
      window.__probeRestore.push([o, orig]);
    });
    E.camera.position.set(eye[0], eye[1], eye[2]);
    E.controls.target.set(at[0], at[1], at[2]);
    E.camera.lookAt(at[0], at[1], at[2]);
    E.camera.updateProjectionMatrix();
    E.render();
  }, { eye, at, tint });
  const box = await page.evaluate(() => {
    const c = window.__ss3dEngine.renderer.domElement.getBoundingClientRect();
    return { x: c.x, y: c.y, width: c.width, height: c.height };
  });
  await page.screenshot({ path, clip: box });
}

async function placeWallVent(page) {
  const before = ((await readItems(page)) || []).length;
  const btn = page.getByRole("button", { name: /SVNT/ });
  const box = await page.evaluate(() => {
    const c = window.__ss3dEngine.renderer.domElement.getBoundingClientRect();
    return { x: c.x, y: c.y, w: c.width, h: c.height };
  });
  // THE EAST (EAVE) WALL, not the front. This aimed at the south wall until 2026-09-15, which on
  // a 12x32 is a GABLE END — and since 1.9 a vent placed on a gable end goes INTO the gable
  // (ventZone), drawn on the roof's cap with no wall casing at all, so these wall-vent checks
  // measured a gable vent and failed 24 times. A vent under the plate now lives on an eave wall;
  // tests/harness/ventGable.mjs measures the gable one.
  // Aimed by hand, square on to the east wall at 3.5 ft, not with setViewPreset(90, ...): that
  // turns from the viewer's FRONT, and the first try landed the vent on the north gable instead.
  await page.evaluate(({ W }) => {
    const E = window.__ss3dEngine;
    E.camera.position.set(W / 2 + 14, 3.5, 0);
    E.controls.target.set(W / 2, 3.5, 0);
    E.camera.lookAt(W / 2, 3.5, 0);
    E.camera.updateProjectionMatrix();
    E.render();
  }, { W });
  for (const [fx, fy] of [[0.5, 0.5], [0.4, 0.5], [0.6, 0.5], [0.5, 0.58], [0.45, 0.42]]) {
    await btn.first().click();
    await settle(page, 300);
    await page.mouse.click(box.x + fx * box.w, box.y + fy * box.h);
    await settle(page, 900);
    const items = (await readItems(page)) || [];
    if (items.length > before) return items.find((i) => i.isVent) || null;
  }
  return null;
}

export async function probeVariant({ ok, shots, config, fixtures, styleLabel, cladding, tag, H, wallVent }) {
  const { browser, ctx } = await launch({ width: 1440, height: 1000 });
  const page = await ctx.newPage();
  const errors = collectErrors(page);
  await page.addInitScript(() => { window.__SS3D_DEBUG = true; });
  await stubSupabase(page, { config, fixtures });
  const result = { tag };
  try {
    await openDesigner(page, config.clientId);
    await page.waitForFunction(() => [...document.querySelectorAll("svg rect")].some((r) => r.getAttribute("stroke") === "#1E293B"), null, { timeout: 30000 });
    await pickStyle(page, styleLabel);
    await chooseSize(page);
    if (cladding) await chooseCladding(page, cladding);
    await openEditor(page);
    let meshes = await sceneMeshes(page);
    const front = classifyEnd(meshes, 1, H), back = classifyEnd(meshes, -1, H);
    const porch = !!front.header;
    console.log(`\n[${tag}] ${styleLabel} ${SIZE} ${cladding || "(style default)"}  porch=${porch}  meshes=${meshes.length}`);
    printEnd("front (+z, porch end)", front, H);
    printEnd("back (-z)", back, H);
    Object.assign(result, { porch, front, back });

    for (const [name, e] of [["front", front], ["back", back]]) {
      if (!e.louvre.length) { ok(`[${tag}] ${name}: style gable vent drawn`, false, "no louvre mesh"); continue; }
      const lv = e.louvre[0];
      const trimFront = Math.max(...e.vTrim.map((m) => m.front)), trimBack = Math.min(...e.vTrim.map((m) => m.back));
      const sill = e.vTrim.slice().sort((a, b) => a.min[1] - b.min[1])[0];
      ok(`[${tag}] ${name}: vent has 4 trim boards`, e.vTrim.length === 4, `got ${e.vTrim.length}`);
      ok(`[${tag}] ${name}: louvre is recessed inside its frame (louvre front < trim front)`, lv.front < trimFront - 0.005, `louvre ${lv.front.toFixed(3)} trim ${trimFront.toFixed(3)}`);
      ok(`[${tag}] ${name}: frame sits ON the cap (trim back = cap face)`, e.cap && Math.abs(trimBack - e.cap.face) <= 0.011, `trim back ${trimBack.toFixed(3)} cap ${e.cap && e.cap.face.toFixed(3)}`);
      ok(`[${tag}] ${name}: louvre not floating off the cap (louvre back <= cap face + 0.01)`, e.cap && lv.back <= e.cap.face + 0.011, `louvre back ${lv.back.toFixed(3)} cap ${e.cap && e.cap.face.toFixed(3)}`);
      if (e.strips.length) {
        const stripFront = Math.max(...e.strips.map((m) => m.front));
        ok(`[${tag}] ${name}: gable strips are not proud of the vent frame`, stripFront <= trimFront - 0.005, `strips ${stripFront.toFixed(3)} trim ${trimFront.toFixed(3)}`);
      }
      if (e.truss.length) {
        const trussBack = Math.min(...e.truss.map((m) => m.back));
        // H2: nothing of the vent shares depth with a truss member.
        ok(`[${tag}] ${name}: H2 — the truss stands wholly in front of the vent (vent front <= truss back)`, Math.max(trimFront, lv.front) <= trussBack + 0.001,
          `vent ${Math.min(trimBack, lv.back).toFixed(3)}..${Math.max(trimFront, lv.front).toFixed(3)}  truss ${trussBack.toFixed(3)}..${Math.max(...e.truss.map((m) => m.front)).toFixed(3)}`);
        ok(`[${tag}] ${name}: the truss stands in front of every gable feature`, e.strips.every((m) => m.front <= trussBack + 0.001) && (!e.cap || e.cap.face <= trussBack + 0.001));
        // H1: no board resting on the header, and the vent's sill clears the brace feet.
        const footY = e.braces.length ? Math.min(...e.braces.map((m) => m.min[1])) : H;
        ok(`[${tag}] ${name}: H1 — no flat trim board rests on the porch header`, e.boardsOnHeader.length === 0,
          e.boardsOnHeader.map((m) => `${m.box.join("x")}@H+${(m.min[1] - H).toFixed(3)}`).join(" "));
        ok(`[${tag}] ${name}: vent sill sits above the header and the brace feet`, sill.min[1] >= H + 0.25 && sill.min[1] >= footY + 0.05,
          `sill bottom H+${(sill.min[1] - H).toFixed(3)}, brace low corner H+${(footY - H).toFixed(3)}`);
      }
    }

    // Plain + tinted shots of the porch end, and the far end for reference.
    const pk = H + (W / 2) * 0.42;
    const vent = [...front.louvre, ...front.vTrim].map((m) => m.i);
    const sillIdx = front.boardsOnHeader.map((m) => m.i);
    const truss = front.truss.map((m) => m.i);
    const tintV = Object.fromEntries(vent.map((i) => [i, "#ff00ff"]));
    const tintAll = { ...tintV, ...Object.fromEntries(truss.map((i) => [i, "#00d0ff"])) };
    await shot(page, `${shots}/${tag}-front.png`, { eye: [0, H + 1.4, L / 2 + 15], at: [0, H + 0.9, L / 2] });
    await shot(page, `${shots}/${tag}-front-close.png`, { eye: [0, H + 1.0, L / 2 + 5.5], at: [0, H + 0.8, L / 2] });
    await shot(page, `${shots}/${tag}-front-close-vent-magenta.png`, { eye: [0, H + 1.0, L / 2 + 5.5], at: [0, H + 0.8, L / 2], tint: { ...tintV, ...Object.fromEntries(sillIdx.map((i) => [i, "#ff00ff"])) } });
    if (truss.length) await shot(page, `${shots}/${tag}-front-close-vent-magenta-truss-cyan.png`, { eye: [0, H + 1.0, L / 2 + 5.5], at: [0, H + 0.8, L / 2], tint: tintAll });
    await shot(page, `${shots}/${tag}-quarter-close.png`, { eye: [3.8, H + 0.9, L / 2 + 3.6], at: [0, H + 0.7, L / 2] });
    await shot(page, `${shots}/${tag}-quarter-close-tinted.png`, { eye: [3.8, H + 0.9, L / 2 + 3.6], at: [0, H + 0.7, L / 2], tint: tintAll });
    await shot(page, `${shots}/${tag}-back-close.png`, { eye: [0, H + 1.0, -L / 2 - 5.5], at: [0, H + 0.8, -L / 2] });
    ok(`[${tag}] peak is where the probe aims`, pk > H);

    if (wallVent) {
      const it = await placeWallVent(page);
      ok(`[${tag}] a wall vent placed from the 3D palette`, !!it, it ? `${it.wall}` : "none");
      if (it) {
        await settle(page, 800);
        meshes = await sceneMeshes(page);
        result.wallVent = meshes.filter((m) => m.itemId === it.id);
        console.log(`  wall vent ${it.id} on ${it.wall}: ${result.wallVent.length} meshes`);
        result.wallVent.forEach((m) => console.log(`    ${m.color} box ${m.box && m.box.join("x")} y ${m.min[1]}..${m.max[1]} ctr ${m.ctr.join(",")}`));
        // Out from the wall's mid-plane along whichever world axis is its normal: z for north/south
        // (the porch end's wall sets back 6 ft), x for east/west.
        const ax = (it.wall === "east" || it.wall === "west") ? 0 : 2;
        const wz = it.wall === "south" || it.wall === "east" ? 1 : -1;
        {
          const faceZ = ax === 0 ? wz * (W / 2) : (wz > 0 ? (porch ? L / 2 - 6 : L / 2) : -L / 2);
          const outs = result.wallVent.map((m) => ({ ...m, back: wz > 0 ? m.min[ax] - faceZ : faceZ - m.max[ax], front: wz > 0 ? m.max[ax] - faceZ : faceZ - m.min[ax] }));
          result.wallVentOut = outs.map((m) => ({ color: m.color, box: m.box, back: +m.back.toFixed(3), front: +m.front.toFixed(3), y: [m.min[1], m.max[1]] }));
          // 1.7: the vent's own frame IS its casing. Before 2026-09-15 buildOneWall drew the three
          // generic casing boxes (front on trimFace) AND a second four-board frame recessed inside
          // them at 0.10-0.16 — a frame within a frame. trimFace per cladding: T/2 + 0.03 on panel,
          // the relief's reach + 0.03 on the others (buildShed3DModel's CLAD_RELIEF_OUT block).
          const TRIM_FACE = { panel: 0.18, lap: 0.26, batten: 0.26, agpanel: 0.235 };
          const wantFace = TRIM_FACE[cladding || "batten"];
          const frame = outs.filter((m) => m.color === TRIM && m.box && near(m.box[2], 2 * wantFace, 0.02));
          const field = outs.filter((m) => m.color === VENT_DARK);
          const blades = outs.filter((m) => m.color === TRIM && m.box && near(m.box[2], 0.05, 0.004));
          const maxFront = Math.max(...outs.map((m) => m.front));
          const topAll = Math.max(...outs.map((m) => m.max[1]));
          ok(`[${tag}] wall vent: one frame and no casing around it (4 boards + field + blades)`,
            frame.length === 4 && field.length === 1 && blades.length >= 3 && outs.length === 4 + 1 + blades.length,
            `frame ${frame.length} field ${field.length} blades ${blades.length} total ${outs.length}`);
          ok(`[${tag}] wall vent: every frame board's front face is on trimFace ${wantFace}`,
            frame.length === 4 && Math.abs(maxFront - wantFace) <= 0.006 && frame.every((m) => Math.abs(m.front - wantFace) <= 0.006), `max front ${maxFront.toFixed(3)}`);
          ok(`[${tag}] wall vent: blades recessed inside the frame`, blades.length >= 3 && blades.every((m) => m.front < wantFace - 0.005),
            blades.map((m) => m.front.toFixed(3)).join(" "));
          // ssVentSpan tops a vent at H - 0.35; the frame head may reach vF (<= 0.14) above that.
          ok(`[${tag}] wall vent: nothing reaches above the frame head`, topAll <= H - 0.35 + 0.14 + 0.002, `top ${topAll} limit ${(H - 0.35 + 0.14).toFixed(3)}`);
          const cen = outs.reduce((a, m) => ({ x: a.x + m.ctr[0], y: a.y + m.ctr[1], z: a.z + m.ctr[2] }), { x: 0, y: 0, z: 0 });
          const cx = cen.x / outs.length, cy = cen.y / outs.length, cz = cen.z / outs.length;
          // (along, out) -> world, for whichever axis this wall faces.
          const P = (along, y, out) => (ax === 2 ? [cx + along, y, faceZ + wz * out] : [faceZ + wz * out, y, cz + along]);
          await shot(page, `${shots}/${tag}-wallvent.png`, { eye: P(1.2, cy + 0.3, 4), at: P(0, cy, 0) });
          await shot(page, `${shots}/${tag}-wallvent-side.png`, { eye: P(3.5, cy + 0.2, 1.2), at: P(0, cy, 0.15) });
        }
      }
    }
    ok(`[${tag}] no uncaught page errors`, errors.filter((e) => /^pageerror/.test(e)).length === 0, errors.slice(0, 3).join(" | "));
  } catch (e) {
    ok(`[${tag}] probe ran to the end`, false, e && e.stack ? e.stack.split("\n").slice(0, 4).join(" / ") : String(e));
    await page.screenshot({ path: `${shots}/${tag}-error.png` }).catch(() => {});
  } finally {
    await browser.close();
  }
  return result;
}

export async function main() {
  const { ok, failed } = reporter();
  const shots = shotsDir("gable");
  const config = process.env.SS_CONFIG_FILE ? JSON.parse(readFileSync(process.env.SS_CONFIG_FILE, "utf8")) : CONFIG;
  const fixtures = process.env.SS_FIXTURES_FILE ? JSON.parse(readFileSync(process.env.SS_FIXTURES_FILE, "utf8")) : FIXTURES;
  const H = Number(process.env.PROBE_WALL_H) || 7.5;
  // Variants: "<style label or porch|plain>:<cladding id or ''>"
  const labelOf = (k) => (k === "porch" ? "Porch Cabin" : k === "plain" ? "Gable Cabin" : k);
  const spec = process.env.SS_VARIANTS
    || (process.env.SS_CONFIG_FILE ? (process.env.SS_STYLES || "Cabin") + ":"
      : "porch:panel,porch:batten,porch:lap,plain:panel,plain:batten,plain:lap");
  const results = [];
  for (const v of spec.split(",")) {
    const [st, clad] = v.split(":");
    const tag = `${st.toLowerCase().replace(/\W+/g, "-")}-${clad || "default"}`;
    results.push(await probeVariant({ ok, shots, config, fixtures, styleLabel: labelOf(st), cladding: clad || null, tag, H, wallVent: !!process.env.PROBE_WALL_VENT }));
  }
  writeFileSync(`${shots}/probe-results.json`, JSON.stringify(results, null, 1));
  const bad = failed();
  console.log(bad.length ? `\n${bad.length} check(s) FAILED` : "\nall checks passed");
  console.log(`shots + probe-results.json in ${shots}`);
  return process.env.PROBE_REPORT_ONLY ? 0 : bad.length;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then((n) => process.exit(n ? 1 : 0));
}
