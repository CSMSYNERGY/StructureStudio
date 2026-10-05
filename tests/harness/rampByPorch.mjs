// WHERE A CUSTOMER'S RAMP IS BUILT IN 3D, BESIDE A PORCH (2026-10-04), measured off the scene graph of
// the SHIPPED compiled bundle (__SS3D_DEBUG), with the door and its ramp placed in the 2D plan:
//   R1  a wall a RECESSED porch shortens at its along=0 end (the south wall of a landscape building
//       whose front gable end is west): the ramp is centred on its door. It used to stand a porch
//       depth further along, because the ramp skipped the a0Ft shift the openings get.
//   R2  a door past a NARROW projecting porch's deck (porchWidthFt 8 on a 16 ft wall): its ramp starts
//       at the wall. It used to start D out, floating beside the deck.
//   R3  the same porch, the door in front of the deck: the ramp still starts at the deck's edge (D).
//   R4  a door on a recessed porch's own (set-back) wall: the ramp starts at the porch floor's edge,
//       the footprint line. It used to start at the set-back wall, its run buried in the porch floor.
//   Each: zero page errors.
//
//   python -m http.server 8125 --bind 127.0.0.1 --directory <repo root>
//   node tests/harness/rampByPorch.mjs           (SS_BASE=http://127.0.0.1:<port>, SS_CASES=R1,R4)
import { launch, stubSupabase, collectErrors, openDesigner, readItems, svgPoint, buildingRect, reporter, revealTool } from "./lib.mjs";

const CLADS = ["panel", "lap", "batten", "agpanel"].map((id) => ({ id, rate: 0, basis: "sqft_option", label: null, charged: false }));
const COLORS = { body: "#eeebe0", trim: "#686c70", roof: "#5f6266" };
const CASES = [
  // Landscape old frame: the front gable end is WEST, the recessed porch cut 6 ft into it, so the
  // north and south walls lose 6 ft at their west (along = 0) end. Door + ramp on the SOUTH wall.
  { id: "R1", label: "Probe Recessed Side", size: "24x12", wall: "south", at: 15,
    d3: { roof: { type: "gable", pitch: 0.4, overhang: 0.5, eave: "fascia", porchEnd: "front", porchDepthFt: 6 }, siding: "panel", colors: COLORS, wallHeightFt: 8 } },
  // A projecting porch 8 ft wide in the middle of a 16 ft south gable end; the door at 14 ft is past it.
  { id: "R2", label: "Probe Narrow Porch", size: "16x24", wall: "south", at: 14,
    d3: { roof: { type: "gable", pitch: 0.4, overhang: 0.5, eave: "fascia", porchEnd: "front", porchOutFt: 6, porchWidthFt: 8 }, siding: "panel", colors: COLORS, wallHeightFt: 8 } },
  // The same porch, the door at 8 ft: in front of the deck.
  { id: "R3", label: "Probe Narrow Porch Mid", size: "16x24", wall: "south", at: 8,
    d3: { roof: { type: "gable", pitch: 0.4, overhang: 0.5, eave: "fascia", porchEnd: "front", porchOutFt: 6, porchWidthFt: 8 }, siding: "panel", colors: COLORS, wallHeightFt: 8 } },
  // A recessed porch on the south gable end: the door on its set-back wall.
  { id: "R4", label: "Probe Recessed Porch Wall", size: "16x24", wall: "south", at: 8,
    d3: { roof: { type: "gable", pitch: 0.4, overhang: 0.5, eave: "fascia", porchEnd: "front", porchDepthFt: 6 }, siding: "panel", colors: COLORS, wallHeightFt: 8 } },
];
const only = (process.env.SS_CASES || "").split(",").filter(Boolean);
const configFor = (c) => {
  const [w, l] = c.size.split("x").map(Number);
  return {
    clientId: "harness-ramp",
    branding: { companyName: "Harness Sheds", accentColor: "#1D4ED8", headerBg: "#FFFFFF", tagline: null, logo: null },
    contactFields: ["name", "email", "phone"],
    buildingStyles: [{ value: "porch", label: c.label, img: null, sizes: [c.size], sizeInclusions: {}, sizeInclusionQty: {}, d3: c.d3 }],
    defaultSizes: [c.size],
    sizePricing: { porch: { [c.size]: { widthFt: w, lengthFt: l, basePrice: 9000 } } },
    options: [], colors: [], claddingOptions: { porch: CLADS }, wallHeightOptions: {},
    showPricing: true, view3d: true, layoutItems: {}, layoutPricing: {}, layoutPrices: {},
    electrical: null, electricalItems: [], insulation: [],
  };
};
const FIXTURES = {
  ramp: { mode: "simple", price: 0, method: "each", enabled: true, imageUrl: null, showImage: false },
  items: [{ id: "d-walk", name: "Harness Walk Door", price: 300, widthIn: 36, heightIn: 80, category: "door", colorMode: "fixed", planLabel: "WD", sortOrder: 0, imageUrl: null,
    sillIn: null, sillMode: "fixed", opLeft: false, opRight: true, opDouble: false, opSlideUp: false, opDefault: "right", swingIn: false, swingOut: true, swingDefault: null, hasTrimColor: false }],
  windowColors: [],
};
const settle = (page, ms = 400) => page.waitForTimeout(ms);
async function pickStyle(page, label) {
  await page.waitForFunction((lab) => [...document.querySelectorAll("div,span,p,strong,b")].some((e) => e.children.length === 0 && (e.textContent || "").trim().toLowerCase() === lab.toLowerCase() && e.offsetParent), label, { timeout: 30000 }).catch(() => {});
  await page.evaluate((lab) => { const el = [...document.querySelectorAll("div,span,p,strong,b")].find((e) => e.children.length === 0 && (e.textContent || "").trim().toLowerCase() === lab.toLowerCase() && e.offsetParent); if (el) el.click(); }, label);
  await settle(page, 500);
}
async function chooseSize(page, size) {
  const sel = page.locator("select").filter({ has: page.locator("option", { hasText: size }) });
  if (await sel.count()) await sel.first().selectOption({ label: size });
  const l = Number(size.split("x")[1]);
  await page.waitForFunction((l) => [...document.querySelectorAll("svg text")].some((t) => t.textContent.trim() === `${l} ft`), l, { timeout: 15000 });
  await settle(page, 600);
}
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
  await page.waitForFunction(() => { const E = window.__ss3dEngine; return !!(E && E.model && E.model.roofGroup && E.model.roofGroup.children.length > 0); }, null, { timeout: 90000 });
  await settle(page, 1500);
}
const { ok, failed } = reporter();
const { browser, ctx } = await launch({ width: 1280, height: 900 });
try {
  for (const c of CASES) {
    if (only.length && !only.includes(c.id)) continue;
    const [W, L] = c.size.split("x").map(Number);
    const config = configFor(c);
    const page = await ctx.newPage();
    const errors = collectErrors(page);
    await page.addInitScript(() => { window.__SS3D_DEBUG = true; });
    await stubSupabase(page, { config, fixtures: FIXTURES });
    try {
      await openDesigner(page, config.clientId);
      await page.waitForFunction(() => [...document.querySelectorAll("svg rect")].some((r) => r.getAttribute("stroke") === "#1E293B"), null, { timeout: 30000 });
      await pickStyle(page, c.label);
      await chooseSize(page, c.size);
      await (await revealTool(page, /^Door wall$/)).click();
      await settle(page, 300);
      let p = await southWall(page, W, L, c.at);
      await page.mouse.click(p.x, p.y);
      await settle(page, 600);
      await page.getByText(FIXTURES.items[0].name, { exact: true }).first().click({ timeout: 10000 });
      await settle(page, 300);
      await page.getByRole("button", { name: "Place door" }).click();
      await settle(page, 600);
      await (await revealTool(page, /Ramp/)).click();
      await settle(page, 300);
      p = await southWall(page, W, L, c.at);
      await page.mouse.click(p.x, p.y);
      await settle(page, 600);
      const items = (await readItems(page)) || [];
      const door = items.find((i) => i.type === "fixtureDoor"), ramp = items.find((i) => i.type === "ramp");
      ok(`${c.id}: door and ramp placed on the ${c.wall} wall`, door && ramp && door.wall === c.wall && ramp.wall === c.wall, JSON.stringify({ door: door && door.wall, ramp: ramp && ramp.wall }));
      await openEditor(page);
      const m = await page.evaluate(({ W, L, doorId }) => {
        const E = window.__ss3dEngine, M = E.model, V = E.camera.position.constructor;
        E.scene.updateMatrixWorld(true);
        const bbOf = (o) => {
          const mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
          o.traverse((q) => {
            if (!q.isMesh || !q.geometry) return;
            if (!q.geometry.boundingBox) q.geometry.computeBoundingBox();
            const b = q.geometry.boundingBox;
            for (const x of [b.min.x, b.max.x]) for (const y of [b.min.y, b.max.y]) for (const z of [b.min.z, b.max.z]) {
              const v = new V(x, y, z).applyMatrix4(q.matrixWorld);
              [v.x, v.y, v.z].forEach((cc, k) => { mn[k] = Math.min(mn[k], cc); mx[k] = Math.max(mx[k], cc); });
            }
          });
          return { mn, mx };
        };
        let ramp = null, door = null;
        M.interiorGroup.children.forEach((g) => { if (g.userData && g.userData.ssRamp) ramp = bbOf(g); });
        M.root.traverse((q) => { if (!door && q.userData && q.userData.itemId === doorId && !q.userData.floorItem) door = bbOf(q); });
        return { ramp, door, porch: M.porch ? { D: M.porch.D, side: M.porch.side } : null };
      }, { W, L, doorId: door && door.id });
      const cx = (b) => b && (b.mn[0] + b.mx[0]) / 2;
      console.log(`   ${c.id}: door x ${cx(m.door) && cx(m.door).toFixed(3)} ramp x ${cx(m.ramp) && cx(m.ramp).toFixed(3)} ramp z ${m.ramp && m.ramp.mn[2].toFixed(3)}..${m.ramp && m.ramp.mx[2].toFixed(3)} y ${m.ramp && m.ramp.mn[1].toFixed(3)}..${m.ramp && m.ramp.mx[1].toFixed(3)} porch ${JSON.stringify(m.porch)}`);
      ok(`${c.id}: the ramp is centred on its door along the wall`, m.ramp && m.door && Math.abs(cx(m.ramp) - cx(m.door)) < 0.05, `door ${cx(m.door)} ramp ${cx(m.ramp)}`);
      if (c.id === "R2") ok(`${c.id}: past the narrow deck the ramp starts at the wall, not D out`, m.ramp && m.ramp.mn[2] - L / 2 < 0.5, `near ${m.ramp && (m.ramp.mn[2] - L / 2)}`);
      if (c.id === "R3") ok(`${c.id}: in front of the deck it starts at the deck's edge`, m.ramp && Math.abs(m.ramp.mn[2] - L / 2 - 6) < 0.15, `near ${m.ramp && (m.ramp.mn[2] - L / 2)}`);
      if (c.id === "R4") ok(`${c.id}: on the recessed porch's wall the ramp starts at the porch floor's edge, not under it`, m.ramp && m.ramp.mn[2] - L / 2 > -0.05, `near ${m.ramp && (m.ramp.mn[2] - L / 2)}`);
      ok(`${c.id}: zero page errors`, errors.length === 0, errors.join(" | ").slice(0, 300));
    } finally { await page.close(); }
  }
} finally { await browser.close(); }
process.exit(failed().length ? 1 : 0);
