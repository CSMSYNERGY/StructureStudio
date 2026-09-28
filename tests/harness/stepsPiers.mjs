// THE PORCH'S STEP COUNT AND THE CUSTOMER'S PIERS (2026-09-28, Carolyn's call), driven in the real
// designer against the COMPILED bundle and measured off the scene graph (__SS3D_DEBUG).
//
// Carolyn: "steps is something I can see us needing, especially with larger buildings", and, opening
// Designer > Foundation, "if they choose piers, we could show it on the building."
//
//   A. THE STEP COUNT (roof.porchStepCount). A style that gives a count draws exactly that many
//      treads and risers, climbing the same height (each riser height / (count + 1)); the top tread
//      meets the deck, one riser under it, its back edge at the deck's front edge; the flight lands
//      on the grass; model.porch.steps says the same count. Without the key the renderer's own count
//      is drawn (one per 7.5 in), on piers and at grade.
//   B. THE CUSTOMER'S PIERS. A style with no foundation, a tenant offering Piers on the Foundation
//      tab. Before: at grade, no supports, one porch step. Ticking Piers stands the building on piers
//      in the docked 3D (rebuilt in place) and in the full-screen viewer: model.foundation.kind
//      "piers", the renderer's 1.5 ft default, a pier under every runner every 7 ft or less, each
//      from the grass to its runner, and the porch steps climbing the new height (three). Unticking
//      returns to the style's own foundation. A style on 1.1 ft blocks keeps its 1.1 ft as piers.
//   C. THE PANEL (?admin=1). "Number of steps" shows beside "Porch steps" only with steps chosen,
//      blank, its placeholder the renderer's count for the floor height ("blank = 3" on 1.5 ft
//      piers); the hint says each step's rise, amber with a plain warning past 8 in or under 4 in; an
//      untouched style saves no count; a typed count saves rounded and held to 1..12; a cleared box
//      deletes it; "None" for the steps deletes the count too; the 3D preview draws the typed count.
//   D. zero page errors.
//
//   python -m http.server 8125 --bind 127.0.0.1 --directory <repo root>
//   node tests/harness/stepsPiers.mjs              (SS_BASE=http://127.0.0.1:<port> to move it)
//   SS_CASES=A,B,C node tests/harness/stepsPiers.mjs   (a subset)   SS_SHOTS=<dir> for screenshots
//
// Exit 0 = every assertion held.
import { join } from "node:path";
import { launch, stubSupabase, collectErrors, openDesigner, reporter, shotsDir, showOptTab, BASE } from "./lib.mjs";

const PLAIN = { body: "#eeebe0", trim: "#686c70", roof: "#5f6266", wood: "#c4965a" };
const GABLE_PORCH = { type: "gable", front: "gable", pitch: 0.4, overhang: 0.6, eave: "fascia", porchEnd: "front", porchOutFt: 6, porchSteps: "left" };
const PIERS_OFFER = { id: "piers", label: "Piers", basis: "each", rate: 100, charged: true };
const FIXTURES = { ramp: { mode: "simple", price: 0, method: "each", enabled: false, imageUrl: null, showImage: false }, items: [], windowColors: [] };

const settle = (page, ms = 400) => page.waitForTimeout(ms);
const f3 = (v) => (v == null || !Number.isFinite(Number(v)) ? String(v) : Number(v).toFixed(3));
const near = (a, b, tol) => Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) <= tol;
const has = (o, k) => !!o && Object.prototype.hasOwnProperty.call(o, k);

const configFor = ({ clientId, label, size, d3, foundationItems }) => {
  const [w, l] = size.split("x").map(Number);
  return {
    clientId,
    branding: { companyName: "Harness Sheds", accentColor: "#1D4ED8", headerBg: "#FFFFFF", tagline: null, logo: null },
    contactFields: ["name", "email", "phone"],
    buildingStyles: [{ value: "stp", label, img: null, sizes: [size], sizeInclusions: {}, sizeInclusionQty: {}, d3 }],
    defaultSizes: [size],
    sizePricing: { stp: { [size]: { widthFt: w, lengthFt: l, basePrice: 9000 } } },
    options: [], colors: [], claddingOptions: {}, wallHeightOptions: {},
    showPricing: true, view3d: true, layoutItems: {}, layoutPricing: {}, layoutPrices: {},
    electrical: null, electricalItems: [], insulation: [],
    ...(foundationItems ? { foundationItems } : {}),
  };
};

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
async function openEditor(page) {
  const edit = page.getByRole("button", { name: /Edit in 3D/ });
  if (!(await edit.count()) || !(await edit.first().isVisible())) {
    const show = page.getByRole("button", { name: /Show 3D|3D View/ });
    if (await show.count()) { await show.first().click(); await settle(page, 800); }
  }
  await edit.first().waitFor({ state: "visible", timeout: 60000 });
  await page.evaluate(() => { window.__ss3dEngine = null; });
  await edit.first().click();
  await page.waitForFunction(() => {
    const E = window.__ss3dEngine;
    return !!(E && E.model && E.model.roofGroup && E.model.roofGroup.children.length > 0);
  }, null, { timeout: 90000 });
  await settle(page, 1200);
}
async function closeEditor(page) {
  await page.getByRole("button", { name: "✕", exact: true }).first().click();
  await page.waitForFunction(() => !document.querySelector('div[style*="z-index: 1100"] canvas'), null, { timeout: 30000 }).catch(() => {});
  await settle(page, 800);
}
async function dockModel(page) {
  const show = page.getByRole("button", { name: /Show 3D|3D View/ });
  if (!(await page.evaluate(() => !!(window.__ss3dPanel && window.__ss3dPanel.model))) && await show.count()) await show.first().click();
  await page.waitForFunction(() => !!(window.__ss3dPanel && window.__ss3dPanel.model), null, { timeout: 60000 });
  await settle(page, 1000);
}

// Everything the assertions read off an engine handle ("__ss3dEngine" or "__ss3dPanel").
async function measure(page, handle) {
  return page.evaluate((handle) => {
    const E = window[handle], M = E.model, V = E.camera.position.constructor;
    E.scene.updateMatrixWorld(true);
    const bbOf = (o, frame) => {
      const inv = frame ? frame.matrixWorld.clone().invert() : null;
      const mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
      o.traverse((q) => {
        if (!q.isMesh || !q.geometry) return;
        if (!q.geometry.boundingBox) q.geometry.computeBoundingBox();
        const b = q.geometry.boundingBox;
        for (const x of [b.min.x, b.max.x]) for (const y of [b.min.y, b.max.y]) for (const z of [b.min.z, b.max.z]) {
          const v = new V(x, y, z).applyMatrix4(q.matrixWorld);
          if (inv) v.applyMatrix4(inv);
          [v.x, v.y, v.z].forEach((c, k) => { mn[k] = Math.min(mn[k], c); mx[k] = Math.max(mx[k], c); });
        }
      });
      return { mn, mx };
    };
    const all = (root, pred) => { const a = []; root.traverse((q) => { if (q.isMesh && pred(q)) a.push(q); }); return a; };
    const tag = (q, k, v) => q.userData && q.userData[k] === v;
    const inDeck = (q) => tag(q, "ssPorchPart", "deckSupport");
    const piers = all(M.root, (q) => tag(q, "ssFoundationPart", "pier") && !inDeck(q)).map((q) => bbOf(q));
    const runners = all(M.root, (q) => tag(q, "ssFoundationPart", "runner")).map((q) => bbOf(q));
    let deck = null, steps = null;
    M.root.traverse((q) => { if (q.userData && q.userData.ssPorch === "deck") deck = q; if (q.userData && q.userData.ssPorchPart === "steps") steps = q; });
    const out = { grade: M.grade, foundation: M.foundation || null, porchSteps: M.porch && M.porch.steps ? { count: M.porch.steps.count, rise: M.porch.steps.rise } : null,
      piers, runners, deckSupports: all(M.root, inDeck).length };
    if (steps && deck) {
      // In the DECK's own frame: y up from the floor, z out from the wall, whichever wall it is on.
      const treads = all(steps, (q) => tag(q, "ssPorchPart", "stepTread")).map((q) => bbOf(q, deck));
      const risers = all(steps, (q) => tag(q, "ssPorchPart", "stepRiser")).length;
      const boards = all(deck, (q) => tag(q, "ssPorchPart", "deckBoard") || tag(q, "ssPorchPart", "rim")).map((q) => bbOf(q, deck));
      const flight = bbOf(steps);
      out.steps = { visible: steps.visible, treads, risers, bottom: flight.mn[1], top: flight.mx[1],
        deckFront: Math.max(...boards.map((b) => b.mx[2])), deckTop: Math.max(...boards.map((b) => b.mx[1])),
        centre: [(flight.mn[0] + flight.mx[0]) / 2, (flight.mn[1] + flight.mx[1]) / 2, (flight.mn[2] + flight.mx[2]) / 2] };
    }
    return out;
  }, handle);
}

// Aim the full-screen viewer's camera and screenshot its canvas.
async function shoot(page, eye, at, path) {
  await page.evaluate(({ eye, at }) => {
    const E = window.__ss3dEngine;
    E.camera.position.set(...eye);
    E.controls.target.set(...at);
    E.controls.update();
    E.render();
  }, { eye, at });
  await settle(page, 300);
  await page.evaluate(() => window.__ss3dEngine.render());
  await page.locator("canvas").last().screenshot({ path });
}
// Standing off the porch's front corner, looking at the steps.
async function shootSteps(page, m, path) {
  const [cx, cy, cz] = m.steps.centre;
  const r = Math.hypot(cx, cz) || 1, ox = cx / r, oz = cz / r;
  const eye = [cx + ox * 7 - oz * 5, cy + 2.6, cz + oz * 7 + ox * 5];
  await shoot(page, eye, [cx, cy + 0.3, cz], path);
}

// ── A. THE STEP COUNT IN 3D ─────────────────────────────────────────────────────────────────
const STEP_CASES = [
  { id: "A5", label: "Steps Five On Piers", size: "12x16", grade: 1.5, count: 5, asked: true,
    d3: { roof: { ...GABLE_PORCH, porchStepCount: 5 }, siding: "batten", colors: PLAIN, wallHeightFt: 8, roofMaterial: "metal", foundation: "piers", floorHeightFt: 1.5 } },
  { id: "A3", label: "Steps Auto On Piers", size: "12x16", grade: 1.5, count: 3, asked: false,
    d3: { roof: GABLE_PORCH, siding: "batten", colors: PLAIN, wallHeightFt: 8, roofMaterial: "metal", foundation: "piers", floorHeightFt: 1.5 } },
  { id: "A2", label: "Steps Two At Grade", size: "12x16", grade: 0.35, count: 2, asked: true,
    d3: { roof: { ...GABLE_PORCH, porchSteps: "center", porchStepCount: 2 }, siding: "batten", colors: PLAIN, wallHeightFt: 8, roofMaterial: "metal" } },
  { id: "A1", label: "Steps Auto At Grade", size: "12x16", grade: 0.35, count: 1, asked: false,
    d3: { roof: { ...GABLE_PORCH, porchSteps: "center" }, siding: "batten", colors: PLAIN, wallHeightFt: 8, roofMaterial: "metal" } },
];

function stepAsserts(ok, tag, m, g, count) {
  const st = m.steps, rise = g / (count + 1);
  ok(`${tag}: ${count} tread(s) and ${count} riser(s)`, !!st && st.treads.length === count && st.risers === count, st && `${st.treads.length} treads, ${st.risers} risers`);
  ok(`${tag}: model.porch.steps says ${count}, rise ${f3(rise * 12)} in`, m.porchSteps && m.porchSteps.count === count && near(m.porchSteps.rise, rise, 1e-9), JSON.stringify(m.porchSteps));
  if (!st) return;
  const tops = st.treads.map((t) => t.mx[1]).sort((a, b) => a - b);
  ok(`${tag}: the treads rise evenly, ${f3(rise * 12)} in each, grass to deck`, tops.every((t, i) => near(t, -g + (i + 1) * rise, 0.002)), tops.map(f3).join(" "));
  const topTread = st.treads.reduce((a, b) => (b.mx[1] > a.mx[1] ? b : a));
  ok(`${tag}: ⚠️ THE TOP TREAD MEETS THE DECK: one riser under its top, its back edge at the deck's front edge`,
    near(st.deckTop, 0, 0.002) && near(topTread.mx[1], st.deckTop - rise, 0.002) && near(topTread.mn[2], st.deckFront, 0.03),
    `deck top ${f3(st.deckTop)} front ${f3(st.deckFront)}; top tread y ${f3(topTread.mx[1])} back ${f3(topTread.mn[2])}`);
  ok(`${tag}: the flight lands on the grass`, near(st.bottom, -g, 0.002) && st.visible, `${f3(st.bottom)} visible ${st.visible}`);
}

async function runStepCase(ctx, c, ok, shots) {
  const page = await ctx.newPage();
  const errors = collectErrors(page);
  await page.addInitScript(() => { window.__SS3D_DEBUG = true; });
  const config = configFor({ clientId: "harness-steps", label: c.label, size: c.size, d3: c.d3 });
  await stubSupabase(page, { config, fixtures: FIXTURES });
  const tag = `${c.id} ${c.label}`;
  try {
    await openDesigner(page, config.clientId);
    await pickStyle(page, c.label);
    await chooseSize(page, c.size);
    await openEditor(page);
    const m = await measure(page, "__ss3dEngine");
    ok(`${tag}: model.grade ${c.grade}`, near(m.grade, c.grade, 1e-9), f3(m.grade));
    stepAsserts(ok, tag, m, c.grade, c.count);
    if (shots && m.steps) await shootSteps(page, m, join(shots, `A-${c.id}-steps-${c.count}${c.asked ? "-asked" : "-auto"}.png`));
    ok(`${tag}: zero page errors`, errors.length === 0, errors.slice(0, 3).join(" | "));
  } catch (e) {
    ok(`${tag}: ran`, false, e && e.message ? e.message.split("\n")[0] : String(e));
  } finally {
    await page.close();
  }
}

// ── B. THE CUSTOMER'S PIERS ─────────────────────────────────────────────────────────────────
function pierAsserts(ok, tag, m, W, L, g, porch = true) {
  const alongX = W >= L, across = alongX ? L : W, len = alongX ? W : L;
  const nRun = Math.max(2, Math.round(across / 4)), nSup = Math.max(2, Math.ceil((len - 1.2) / 7 - 1e-9) + 1);
  const F = m.foundation;
  ok(`${tag}: model.foundation.kind "piers", grade ${g}`, !!F && F.kind === "piers" && near(m.grade, g, 1e-9) && near(F.grade, g, 1e-9), JSON.stringify(F && { kind: F.kind, grade: F.grade }) + ` model.grade ${f3(m.grade)}`);
  ok(`${tag}: ${nRun * nSup} piers (${nSup} under each of ${nRun} runners), the renderer's rule`, !!F && F.supports.length === nRun * nSup && m.piers.length === nRun * nSup,
    `${m.piers.length} built, model ${F && F.supports.length}`);
  const runBot = m.runners.length ? Math.min(...m.runners.map((r) => r.mn[1])) : NaN;
  ok(`${tag}: ⚠️ EVERY PIER STANDS ON THE GRASS AND REACHES ITS RUNNER`, m.piers.length > 0 && m.piers.every((p) => near(p.mn[1], -g, 0.002) && near(p.mx[1], runBot, 0.002)),
    m.piers.slice(0, 3).map((p) => `${f3(p.mn[1])}..${f3(p.mx[1])}`).join(" ") + ` runner ${f3(runBot)}`);
  ok(`${tag}: every pier under the footprint`, m.piers.every((p) => Math.abs((p.mn[0] + p.mx[0]) / 2) <= W / 2 && Math.abs((p.mn[2] + p.mx[2]) / 2) <= L / 2));
  if (porch) ok(`${tag}: the porch deck has its own piers`, m.deckSupports > 0, String(m.deckSupports));
}

async function runPiers(ctx, ok, shots) {
  const W = 12, L = 16, SIZE = "12x16";
  const page = await ctx.newPage();
  const errors = collectErrors(page);
  await page.addInitScript(() => { window.__SS3D_DEBUG = true; });
  const config = configFor({ clientId: "harness-cust-piers", label: "Customer Piers Tri", size: SIZE,
    d3: { roof: GABLE_PORCH, siding: "batten", colors: PLAIN, wallHeightFt: 8, roofMaterial: "metal" },
    foundationItems: [{ id: "gravel_pad", label: "Gravel pad", basis: "sqft_building", rate: 2, charged: true }, PIERS_OFFER] });
  await stubSupabase(page, { config, fixtures: FIXTURES });
  const tag = "B customer piers";
  const piersBtn = () => page.locator(".ssd-fd button", { hasText: "Piers" }).first();
  const toggle = async (want) => {
    await showOptTab(page, "foundation");
    await piersBtn().waitFor({ state: "visible", timeout: 15000 });
    if (((await piersBtn().getAttribute("aria-pressed")) === "true") !== want) await piersBtn().click();
    await settle(page, 600);
    ok(`${tag}: the Piers button reads ${want ? "on" : "off"}`, ((await piersBtn().getAttribute("aria-pressed")) === "true") === want);
  };
  // A corner from behind and low, so the base shows clear of the porch.
  const baseEye = [W * 1.3, 2.2, -L * 1.15], baseAt = [0, -0.1, -1];
  try {
    await openDesigner(page, config.clientId);
    await pickStyle(page, "Customer Piers Tri");
    await chooseSize(page, SIZE);
    // ── THE DOCK first, while it is mounted (the full-screen viewer unmounts it) ──
    await dockModel(page);
    let d = await measure(page, "__ss3dPanel");
    ok(`${tag}: before, the dock stands at grade with no piers`, near(d.grade, 0.35, 1e-9) && d.foundation === null && d.piers.length === 0, `${f3(d.grade)} ${JSON.stringify(d.foundation)}`);
    await toggle(true);
    await page.waitForFunction(() => { const P = window.__ss3dPanel; return !!(P && P.model && P.model.foundation && P.model.foundation.kind === "piers"); }, null, { timeout: 30000 })
      .catch(() => {});
    d = await measure(page, "__ss3dPanel");
    pierAsserts(ok, `${tag} (dock, rebuilt in place)`, d, W, L, 1.5);
    if (shots) await page.locator("canvas").first().screenshot({ path: join(shots, "B-3-dock-with-piers.png") }).catch(() => {});
    await toggle(false);
    await page.waitForFunction(() => { const P = window.__ss3dPanel; return !!(P && P.model && !P.model.foundation); }, null, { timeout: 30000 }).catch(() => {});
    d = await measure(page, "__ss3dPanel");
    ok(`${tag}: ⚠️ UNTICKED, THE DOCK IS BACK AT GRADE`, near(d.grade, 0.35, 1e-9) && d.foundation === null && d.piers.length === 0, `${f3(d.grade)} ${d.piers.length} piers`);
    // ── THE FULL-SCREEN VIEWER: before, ticked, unticked ──
    await openEditor(page);
    let m = await measure(page, "__ss3dEngine");
    ok(`${tag}: before, the viewer stands at grade: no foundation, no piers, one porch step`,
      near(m.grade, 0.35, 1e-9) && m.foundation === null && m.piers.length === 0 && m.steps && m.steps.treads.length === 1, `${f3(m.grade)} ${m.piers.length} piers`);
    if (shots) {
      await shoot(page, baseEye, baseAt, join(shots, "B-1-before-no-piers.png"));
      await shootSteps(page, m, join(shots, "B-1-before-porch.png"));
    }
    await closeEditor(page);
    await toggle(true);
    await openEditor(page);
    m = await measure(page, "__ss3dEngine");
    pierAsserts(ok, `${tag} (viewer)`, m, W, L, 1.5);
    ok(`${tag}: the porch steps climb the new height: three, by the rule`, m.steps && m.steps.treads.length === 3 && near(m.steps.bottom, -1.5, 0.002),
      m.steps && `${m.steps.treads.length} treads from ${f3(m.steps.bottom)}`);
    if (shots) {
      await shoot(page, baseEye, baseAt, join(shots, "B-2-after-piers.png"));
      await shootSteps(page, m, join(shots, "B-2-after-porch.png"));
    }
    await closeEditor(page);
    await toggle(false);
    await openEditor(page);
    m = await measure(page, "__ss3dEngine");
    ok(`${tag}: ⚠️ UNTICKED, THE VIEWER IS BACK AT GRADE TOO`, near(m.grade, 0.35, 1e-9) && m.foundation === null && m.piers.length === 0, `${f3(m.grade)} ${m.piers.length} piers`);
    await closeEditor(page);
    ok(`${tag}: zero page errors`, errors.length === 0, errors.slice(0, 3).join(" | "));
  } catch (e) {
    ok(`${tag}: ran`, false, e && e.message ? e.message.split("\n")[0] : String(e));
  } finally {
    await page.close();
  }
}

// A style on 1.1 ft blocks: the customer's piers stand at the style's own measured height; a tenant
// that does not offer piers draws the style's own foundation whatever sel says.
async function runPiersOnBlocks(ctx, ok) {
  const W = 16, L = 10, SIZE = "16x10";
  const page = await ctx.newPage();
  const errors = collectErrors(page);
  await page.addInitScript(() => { window.__SS3D_DEBUG = true; });
  const config = configFor({ clientId: "harness-cust-piers-blocks", label: "Customer Piers Blocks", size: SIZE,
    d3: { roof: { type: "gable", pitch: 0.4, overhang: 0.6 }, siding: "lap", colors: PLAIN, wallHeightFt: 8, foundation: "blocks", floorHeightFt: 1.1 },
    foundationItems: [PIERS_OFFER] });
  await stubSupabase(page, { config, fixtures: FIXTURES });
  const tag = "B2 blocks style";
  try {
    await openDesigner(page, config.clientId);
    await pickStyle(page, "Customer Piers Blocks");
    await chooseSize(page, SIZE);
    await dockModel(page);
    let d = await measure(page, "__ss3dPanel");
    ok(`${tag}: before, the style's own blocks at 1.1 ft`, d.foundation && d.foundation.kind === "blocks" && near(d.grade, 1.1, 1e-9), JSON.stringify(d.foundation && d.foundation.kind));
    await showOptTab(page, "foundation");
    await page.locator(".ssd-fd button", { hasText: "Piers" }).first().click();
    await page.waitForFunction(() => { const P = window.__ss3dPanel; return !!(P && P.model && P.model.foundation && P.model.foundation.kind === "piers"); }, null, { timeout: 30000 }).catch(() => {});
    d = await measure(page, "__ss3dPanel");
    pierAsserts(ok, `${tag}: piers ticked, at the style's own 1.1 ft`, d, W, L, 1.1, false);
    ok(`${tag}: zero page errors`, errors.length === 0, errors.slice(0, 3).join(" | "));
  } catch (e) {
    ok(`${tag}: ran`, false, e && e.message ? e.message.split("\n")[0] : String(e));
  } finally {
    await page.close();
  }
}

// ── C. THE PANEL ────────────────────────────────────────────────────────────────────────────
const PANEL_STYLE = { value: "tri", label: "Harness Steps Tri", img: null, sizes: ["12x16"], sizeInclusions: {}, sizeInclusionQty: {},
  d3: { roof: GABLE_PORCH, siding: "batten", colors: PLAIN, wallHeightFt: 8, roofMaterial: "metal", foundation: "piers", floorHeightFt: 1.5 } };
const PANEL_CONFIG = { ...configFor({ clientId: "harness-steps-panel", label: "x", size: "12x16", d3: {} }), buildingStyles: [PANEL_STYLE],
  sizePricing: { tri: { "12x16": { widthFt: 12, lengthFt: 16, basePrice: 9000 } } } };

async function runPanel(ctx, ok, shots) {
  const page = await ctx.newPage();
  const errors = collectErrors(page);
  await page.addInitScript(() => { window.__SS3D_DEBUG = true; });
  const calls = await stubSupabase(page, { config: PANEL_CONFIG, fixtures: FIXTURES });
  const saves = () => calls.filter((c) => c.path && c.path.endsWith("/functions/v1/admin-save-settings") && c.body && c.body.action === "save_style_d3");
  const save = async () => {
    const before = saves().length;
    await page.getByRole("button", { name: "Save to config" }).click();
    const t0 = Date.now();
    while (saves().length === before) {
      if (Date.now() - t0 > 15000) throw new Error("Save sent no admin-save-settings call");
      await settle(page, 100);
    }
    await page.getByText("Saved — reload the page to see it live.").waitFor({ state: "visible", timeout: 15000 });
    return saves()[saves().length - 1].body.d3;
  };
  const count = () => page.locator('input[data-ss-step-count="ss-grid"]');
  const rise = () => page.locator('div[data-ss-step-rise="ss-grid"]');
  const stepsSel = () => page.locator("label").filter({ hasText: /^Porch steps/ }).locator("select");
  const typeCount = async (v) => {
    await count().click();
    await count().fill(String(v));
    await page.keyboard.press("Tab");
    await settle(page, 300);
  };
  const riseText = async () => ({ text: (await rise().innerText()).replace(/\s+/g, " ").trim(), color: await rise().evaluate((e) => getComputedStyle(e).color) });
  const AMBER = "rgb(180, 83, 9)";   // #B45309, the panel's warning colour
  const tag = "C panel";
  try {
    await page.goto(`${BASE}/?client=${encodeURIComponent(PANEL_CONFIG.clientId)}&admin=1`, { waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => window.__ssAppBooted === true && typeof window.StructureStudio === "function", null, { timeout: 60000 });
    await page.getByText("3D Style Calibration").first().waitFor({ state: "visible", timeout: 30000 });
    await page.getByPlaceholder("Admin password").fill("harness");
    const btn = page.getByRole("button", { name: "Harness Steps Tri", exact: true });
    await btn.first().waitFor({ state: "visible", timeout: 30000 });
    await btn.first().click();
    await stepsSel().waitFor({ state: "visible", timeout: 15000 });
    await settle(page);
    ok(`${tag}: "Number of steps" shows beside "Porch steps", blank`, (await count().count()) === 1 && (await count().inputValue()) === "");
    ok(`${tag}: ...its placeholder the renderer's own count on 1.5 ft piers: "blank = 3"`, (await count().getAttribute("placeholder")) === "blank = 3", await count().getAttribute("placeholder"));
    const label = (await count().locator("xpath=..").innerText()).replace(/\s+/g, " ");
    ok(`${tag}: ...labelled "Number of steps"`, /^Number of steps/.test(label.trim()), label.slice(0, 80));
    let r = await riseText();
    ok(`${tag}: the hint says each step rises 4.5 in, not amber`, r.text === "Each step rises 4.5 in." && r.color !== AMBER, JSON.stringify(r));
    let d3 = await save();
    ok(`${tag}: ⚠️ SAVED UNTOUCHED, NO COUNT IS SENT`, !has(d3.roof, "porchStepCount") && d3.roof.porchSteps === "left", JSON.stringify(d3.roof));

    await typeCount(5);
    d3 = await save();
    ok(`${tag}: a typed 5 saves roof.porchStepCount 5`, d3.roof.porchStepCount === 5, JSON.stringify(d3.roof));
    r = await riseText();
    ok(`${tag}: 5 steps up 1.5 ft rise 3 in each: amber, "fewer steps"`, r.text === "Each step rises 3 in. Fewer steps would make them easier to climb." && r.color === AMBER, JSON.stringify(r));
    if (shots) await count().locator("xpath=../..").screenshot({ path: join(shots, "C-1-panel-five-steps.png") }).catch(() => {});
    await typeCount(1);
    r = await riseText();
    ok(`${tag}: 1 step up 1.5 ft rises 9 in: amber, "more steps"`, r.text === "Each step rises 9 in. More steps would make them easier to climb." && r.color === AMBER, JSON.stringify(r));
    if (shots) await count().locator("xpath=../..").screenshot({ path: join(shots, "C-2-panel-one-step-warning.png") }).catch(() => {});
    d3 = await save();
    ok(`${tag}: ...and saves 1`, d3.roof.porchStepCount === 1, String(d3.roof.porchStepCount));
    await typeCount(3.6);
    d3 = await save();
    ok(`${tag}: 3.6 saves rounded, 4`, d3.roof.porchStepCount === 4, String(d3.roof.porchStepCount));
    r = await riseText();
    ok(`${tag}: 4 steps rise 3.6 in: amber`, r.text === "Each step rises 3.6 in. Fewer steps would make them easier to climb." && r.color === AMBER, JSON.stringify(r));
    await typeCount(40);
    d3 = await save();
    ok(`${tag}: past the band saves at its top, 12`, d3.roof.porchStepCount === 12, String(d3.roof.porchStepCount));
    await typeCount("");
    d3 = await save();
    ok(`${tag}: ⚠️ A CLEARED BOX DELETES THE KEY`, !has(d3.roof, "porchStepCount") && d3.roof.porchSteps === "left", JSON.stringify(d3.roof));
    r = await riseText();
    ok(`${tag}: ...and the hint is the rule's 4.5 in again`, r.text === "Each step rises 4.5 in." && r.color !== AMBER, JSON.stringify(r));
    await typeCount(2);
    await stepsSel().selectOption("");
    await settle(page);
    ok(`${tag}: "None" for the steps hides the count`, (await count().count()) === 0);
    d3 = await save();
    ok(`${tag}: ⚠️ ...AND DELETES IT WITH THE STEPS`, !has(d3.roof, "porchSteps") && !has(d3.roof, "porchStepCount"), JSON.stringify(d3.roof));
    await stepsSel().selectOption("right");
    await settle(page);
    ok(`${tag}: steps back on, the count is blank (nothing remembered)`, (await count().inputValue()) === "");
    // The preview draws the DRAFT: type the count, then open it.
    await typeCount(6);
    await page.getByRole("button", { name: /Preview in 3D/ }).first().click();
    await page.waitForFunction(() => { const E = window.__ss3dEngine; return !!(E && E.model && E.model.porch && E.model.porch.steps); }, null, { timeout: 90000 });
    await settle(page, 1000);
    const m = await measure(page, "__ss3dEngine");
    stepAsserts(ok, `${tag}: the 3D preview`, m, 1.5, 6);
    if (shots && m.steps) await shootSteps(page, m, join(shots, "C-3-preview-six-steps.png"));
    ok(`${tag}: zero page errors`, errors.length === 0, errors.slice(0, 3).join(" | "));
  } catch (e) {
    ok(`${tag}: ran to the end`, false, e && e.message ? e.message.split("\n")[0] : String(e));
  } finally {
    await page.close();
  }
}

const { ok, failed } = reporter();
const only = process.env.SS_CASES ? process.env.SS_CASES.split(",") : null;
const want = (k) => !only || only.includes(k);
const shots = process.env.SS_SHOTS ? shotsDir("stepsPiers") : null;
const { browser, ctx } = await launch({ width: 1280, height: 900 });
try {
  const jobs = [];
  if (want("A")) jobs.push((async () => { for (const c of STEP_CASES) await runStepCase(ctx, c, ok, shots); })());
  if (want("B")) jobs.push((async () => { await runPiers(ctx, ok, shots); await runPiersOnBlocks(ctx, ok); })());
  if (want("C")) jobs.push(runPanel(ctx, ok, shots));
  await Promise.all(jobs);
} finally {
  await browser.close();
}
const bad = failed();
console.log(bad.length ? `\n${bad.length} FAILED` : "\nALL PASS");
process.exit(bad.length ? 1 : 0);
