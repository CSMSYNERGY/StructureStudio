// Vents in the GABLE, driven for real: clicks on the plan, a drag, a click in the 3D, and the scene
// graph measured afterwards.
//
// Carolyn, 2026-09-14: a Standard Vent placed on the front wall landed beside the door, low. From
// 2026-09-15 a vent placed on a gable end goes into the gable (ventZone "gable"), centred under the
// ridge; on an eave wall it stays high on the wall; on a gable too small for it it stays on the wall
// and the designer says why. This proves the COMPILED bundle does that, through the same clicks a
// customer makes:
//   1. a plan click on the south (gable) end   -> ventZone "gable", along 6 ft on a 12 ft end
//   2. a plan click on an eave wall            -> no zone, no toast
//   3. dragging the gable vent at the corner   -> it stops inside the rake, still in the gable
//   4. dragging a gable vent onto an eave wall -> it comes down to that wall
//   5. the 3D: that vent's meshes sit above the plate at the ridge, the style's vent is gone from
//      that end only, and the battens stop around it
//   6. a click in the 3D on the north wall     -> into the north gable
//   7. "Look inside" hides it with the roof
//   8. an 8 ft gable at 3:12 and a 24 in vent  -> on the wall, with the "too small" toast
//   9. the porch Cabin's truss end             -> sill over the brace feet, truss in front of the vent
//
//   python -m http.server 8125 --bind 127.0.0.1        (repo root)
//   node tests/harness/ventGable.mjs                    (SS_SHOTS=<dir> for the screenshots)
import { pathToFileURL } from "node:url";
import { launch, stubSupabase, collectErrors, openDesigner, readItems, svgPoint, buildingRect, reporter, shotsDir } from "./lib.mjs";
import { CONFIG as GABLE_CONFIG, FIXTURES as GABLE_FIXTURES, pickStyle, chooseCladding, openEditor, sceneMeshes, classifyEnd, shot } from "./gableProbe.mjs";

const W = 12, L = 32, H = 7.5;
const MIN_RISE = 2 / 12;
const TOO_SMALL = "This gable is too small for that vent";

// The probe's hand-written config (Porch Cabin, Gable Cabin: 12x32 at 5:12, batten, 7.5 ft walls)
// plus an 8x12 "Low Barn" at 3:12 and a 24x12 vent, the two halves of the too-small case.
const plain = GABLE_CONFIG.buildingStyles.find((s) => s.value === "plain");
const CONFIG = {
  ...GABLE_CONFIG,
  clientId: "harness-vent-gable",
  buildingStyles: [...GABLE_CONFIG.buildingStyles,
    { ...plain, value: "low", label: "Low Barn", sizes: ["8x12"], d3: { ...plain.d3, roof: { ...plain.d3.roof, pitch: 0.25 } } }],
  defaultSizes: [...GABLE_CONFIG.defaultSizes, "8x12"],
  sizePricing: { ...GABLE_CONFIG.sizePricing, low: { "8x12": { widthFt: 8, lengthFt: 12, basePrice: 5000 } } },
  claddingOptions: { ...GABLE_CONFIG.claddingOptions, low: GABLE_CONFIG.claddingOptions.plain },
};
const FIXTURES = {
  ...GABLE_FIXTURES,
  items: [...GABLE_FIXTURES.items, { ...GABLE_FIXTURES.items[0], id: "v-big", name: "Big Vent", price: 60, widthIn: 24, heightIn: 12, planLabel: "BVNT", sortOrder: 1 }],
};

const settle = (page, ms = 400) => page.waitForTimeout(ms);
const near = (a, b, eps) => Math.abs(a - b) <= eps;

async function chooseSizeLabel(page, label, lenFt) {
  const sel = page.locator("select").filter({ has: page.locator("option", { hasText: label }) });
  await sel.first().selectOption({ label });
  await page.waitForFunction((l) => [...document.querySelectorAll("svg text")].some((t) => t.textContent.trim() === `${l} ft`), lenFt, { timeout: 15000 });
  await settle(page, 500);
}
// A point 0.4 ft inside a wall, `alongFt` from its west/north end, in screen pixels.
async function wallPoint(page, wall, alongFt, w, l) {
  const r = await buildingRect(page);
  const fx = r.w / w, fy = r.h / l;
  if (wall === "south") return svgPoint(page, r.x + alongFt * fx, r.y + r.h - 0.4 * fy);
  if (wall === "north") return svgPoint(page, r.x + alongFt * fx, r.y + 0.4 * fy);
  if (wall === "west") return svgPoint(page, r.x + 0.4 * fx, r.y + alongFt * fy);
  return svgPoint(page, r.x + r.w - 0.4 * fx, r.y + alongFt * fy);
}
async function alongOf(page, it, w, l) {
  const r = await buildingRect(page);
  return (it.wall === "north" || it.wall === "south") ? ((it.x - r.x) / r.w) * w : ((it.y - r.y) / r.h) * l;
}
// Arm a vent tool on the plan and click a wall; returns the new item (or null) and any "too small" toast.
async function placeOnPlan(page, toolName, wall, alongFt, w, l) {
  const before = new Set(((await readItems(page)) || []).map((i) => i.id));
  await page.getByRole("button", { name: new RegExp(toolName) }).first().click();
  await settle(page, 250);
  const p = await wallPoint(page, wall, alongFt, w, l);
  await page.mouse.click(p.x, p.y);
  await settle(page, 500);
  const toast = await page.evaluate((t) => document.body.innerText.includes(t), TOO_SMALL);
  const it = ((await readItems(page)) || []).find((i) => !before.has(i.id)) || null;
  return { it, toast };
}
async function dragItemTo(page, it, to) {
  const from = await svgPoint(page, it.x, it.y);
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(from.x + 4, from.y + 2, { steps: 2 });
  await page.mouse.move(to.x, to.y, { steps: 24 });
  await settle(page, 150);
  await page.mouse.up();
  await settle(page, 500);
  return ((await readItems(page)) || []).find((i) => i.id === it.id) || null;
}
async function freshDesigner(ctx, styleLabel) {
  const page = await ctx.newPage();
  const errors = collectErrors(page);
  await page.addInitScript(() => { window.__SS3D_DEBUG = true; });
  const calls = await stubSupabase(page, { config: CONFIG, fixtures: FIXTURES });
  await openDesigner(page, CONFIG.clientId);
  await page.waitForFunction(() => [...document.querySelectorAll("svg rect")].some((r) => r.getAttribute("stroke") === "#1E293B"), null, { timeout: 30000 });
  await pickStyle(page, styleLabel);
  return { page, errors, calls };
}
// The meshes of one placed item and their world bounds.
const itemMeshes = (meshes, id) => meshes.filter((m) => m.itemId === id);
const bounds = (ms) => ({
  min: [0, 1, 2].map((k) => Math.min(...ms.map((m) => m.min[k]))),
  max: [0, 1, 2].map((k) => Math.max(...ms.map((m) => m.max[k]))),
});

export async function main() {
  const { ok, failed } = reporter();
  const shots = shotsDir("ventGable");
  const { browser, ctx } = await launch({ width: 1440, height: 1000 });
  const allCalls = [];
  const allErrors = [];
  try {
    // ── The Gable Cabin, 12x32, batten ───────────────────────────────────────────────────
    const { page, errors, calls } = await freshDesigner(ctx, "Gable Cabin");
    allCalls.push(calls); allErrors.push(errors);
    await chooseSizeLabel(page, `${W}x${L}`, L);
    await chooseCladding(page, "batten");

    // 1. A plan click on the south (gable) end, well off-centre: it goes to the ridge.
    const s1 = await placeOnPlan(page, "Standard Vent", "south", 3, W, L);
    const south = s1.it;
    ok("1. a vent clicked onto the south gable end is placed", !!south && south.isVent && south.wall === "south", JSON.stringify(south && { wall: south.wall, isVent: south.isVent }));
    ok("1. it is IN THE GABLE (ventZone gable, 2 in above the plate)", !!south && south.ventZone === "gable" && near(south.ventRiseFt, MIN_RISE, 1e-6),
      JSON.stringify(south && { ventZone: south.ventZone, ventRiseFt: south.ventRiseFt }));
    ok("1. centred under the ridge (6 ft along a 12 ft end), not where it was clicked", !!south && near(await alongOf(page, south, W, L), 6, 0.05), south ? (await alongOf(page, south, W, L)).toFixed(3) : "");
    ok("1. no 'too small' toast", !s1.toast);
    await page.screenshot({ path: `${shots}/1-plan-south-gable-vent.png` });

    // 2. An eave wall: stays on the wall, no zone, no toast.
    const s2 = await placeOnPlan(page, "Standard Vent", "east", 20, W, L);
    ok("2. a vent on the east (eave) wall is placed with NO gable zone", !!s2.it && s2.it.wall === "east" && !s2.it.ventZone, JSON.stringify(s2.it && { wall: s2.it.wall, ventZone: s2.it.ventZone }));
    ok("2. no 'too small' toast on an eave wall", !s2.toast);

    // 3. Drag the gable vent toward the west corner: it stops inside the rake, still in the gable.
    //    12 ft at 5:12 with a 12x8 vent: the frame's top corner reaches the 3 in clearance at 3.14 ft.
    if (south) {
      const dragged = await dragItemTo(page, south, await wallPoint(page, "south", 0.8, W, L));
      const a = dragged ? await alongOf(page, dragged, W, L) : NaN;
      ok("3. dragged toward the corner, the gable vent stops inside the rake", !!dragged && dragged.ventZone === "gable" && near(a, 3.14, 0.06), `along ${a.toFixed(3)} zone ${dragged && dragged.ventZone}`);
      const back = await dragItemTo(page, dragged, await wallPoint(page, "south", 6, W, L));
      const a2 = back ? await alongOf(page, back, W, L) : NaN;
      ok("3. dragged back to the middle, it follows", !!back && back.ventZone === "gable" && near(a2, 6, 0.1), `along ${a2.toFixed(3)}`);
    }

    // 4. A second gable vent on the north end, dragged onto the west (eave) wall: it comes down.
    const s4 = await placeOnPlan(page, "Standard Vent", "north", 6, W, L);
    ok("4. a vent clicked onto the north gable end goes into that gable", !!s4.it && s4.it.wall === "north" && s4.it.ventZone === "gable");
    let westVent = null;
    if (s4.it) {
      westVent = await dragItemTo(page, s4.it, await wallPoint(page, "west", 10, W, L));
      ok("4. dragged onto the west eave wall, it leaves the gable (zone and rise cleared)", !!westVent && westVent.wall === "west" && westVent.ventZone == null && westVent.ventRiseFt == null,
        JSON.stringify(westVent && { wall: westVent.wall, ventZone: westVent.ventZone, ventRiseFt: westVent.ventRiseFt }));
    }
    await page.screenshot({ path: `${shots}/4-plan-after-drags.png` });

    // 5. The 3D. The south vent's along is read off the PLAN first: the full-screen editor covers
    // the plan, and buildingRect finds no plan svg while it is open.
    const southNow = south ? ((await readItems(page)) || []).find((i) => i.id === south.id) : null;
    const southAlongFt = southNow ? await alongOf(page, southNow, W, L) : null;
    await openEditor(page);
    let meshes = await sceneMeshes(page);
    const items = (await readItems(page)) || [];
    const sv = items.find((i) => south && i.id === south.id);
    const svMeshes = sv ? itemMeshes(meshes, sv.id) : [];
    const b = svMeshes.length ? bounds(svMeshes) : null;
    ok("5. the gable vent is drawn in 3D as louvre + 4 frame boards, all in its gable group", svMeshes.length === 5 && svMeshes.every((m) => m.group === "openings" && m.gable),
      `meshes ${svMeshes.length} groups ${[...new Set(svMeshes.map((m) => m.group + (m.gable ? "/gable" : "")))]}`);
    if (b) {
      ok("5. the whole vent is above the plate (frame bottom > H)", b.min[1] > H, `bottom ${b.min[1].toFixed(3)} H ${H}`);
      const louvre = svMeshes.find((m) => m.color === "#2a2e33");
      ok("5. the louvre's bottom edge is 2 in above the plate", !!louvre && near(louvre.min[1], H + MIN_RISE, 0.006), louvre ? louvre.min[1].toFixed(3) : "no louvre");
      // Where the PLAN has it, to the hundredth: step 3's drag back to the middle lands at whatever
      // along the pointer released on (5.96 on the first run, and world x -0.041 to match), so the
      // centre is asserted against the live item. Step 1 proved the default IS the ridge centre;
      // step 6 checks it again on a vent nobody dragged.
      const wantX = southAlongFt != null ? southAlongFt - W / 2 : NaN;
      ok("5. drawn where the plan has it along the gable (world x = along - 6)", near((b.min[0] + b.max[0]) / 2, wantX, 0.01), `3D ${((b.min[0] + b.max[0]) / 2).toFixed(3)} plan ${wantX.toFixed(3)}`);
      ok("5. on the south cap, standing out from it (z just past +L/2)", b.min[2] >= L / 2 - 0.02 && b.max[2] <= L / 2 + 0.4, `z ${b.min[2].toFixed(3)}..${b.max[2].toFixed(3)}`);
    }
    const front = classifyEnd(meshes, 1, H), backEnd = classifyEnd(meshes, -1, H);
    ok("5. the style's own gable vent is GONE from the south end", front.louvre.length === 0, `louvres ${front.louvre.length}`);
    ok("5. ...and still on the north end, which has no placed gable vent", backEnd.louvre.length === 1, `louvres ${backEnd.louvre.length}`);
    if (b) {
      const crossing = front.strips.filter((m) => m.max[0] > b.min[0] + 0.001 && m.min[0] < b.max[0] - 0.001 && m.max[1] > b.min[1] + 0.001 && m.min[1] < b.max[1] - 0.001);
      const inColumn = front.strips.filter((m) => m.max[0] > b.min[0] && m.min[0] < b.max[0]);
      ok("5. the south gable's battens stop at the vent (none crosses its frame)", crossing.length === 0 && inColumn.length > 0, `crossing ${crossing.length}, strips in its column ${inColumn.length}`);
    }
    const wvMeshes = westVent ? itemMeshes(meshes, westVent.id) : [];
    ok("5. the vent dragged down to the west wall is drawn IN that wall, under the plate", wvMeshes.length > 0 && wvMeshes.every((m) => !m.gable) && bounds(wvMeshes).max[1] <= H,
      wvMeshes.length ? `top ${bounds(wvMeshes).max[1].toFixed(3)}` : "no meshes");
    await shot(page, `${shots}/5-front.png`, { eye: [0, H + 1.4, L / 2 + 15], at: [0, H + 0.9, L / 2] });
    await shot(page, `${shots}/5-front-close.png`, { eye: [0, H + 1.0, L / 2 + 5.5], at: [0, H + 0.8, L / 2] });
    await shot(page, `${shots}/5-back-close-style-vent.png`, { eye: [0, H + 1.0, -L / 2 - 5.5], at: [0, H + 0.8, -L / 2] });

    // 6. A click in the 3D on the north wall, below the plate: into the north gable.
    {
      const before = new Set(((await readItems(page)) || []).map((i) => i.id));
      await shot(page, `${shots}/6-aim-north-wall.png`, { eye: [0, 3.5, -L / 2 - 12], at: [0, 3.5, -L / 2] });
      await page.getByRole("button", { name: /SVNT/ }).first().click();
      await settle(page, 300);
      const c = await page.evaluate(() => { const r = window.__ss3dEngine.renderer.domElement.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; });
      await page.mouse.click(c.x, c.y);
      await settle(page, 1200);
      const nv = ((await readItems(page)) || []).find((i) => !before.has(i.id));
      ok("6. a 3D click on the north wall places a vent into the north gable", !!nv && nv.wall === "north" && nv.ventZone === "gable" && near(nv.ventRiseFt, MIN_RISE, 1e-6),
        JSON.stringify(nv && { wall: nv.wall, ventZone: nv.ventZone, ventRiseFt: nv.ventRiseFt }));
      meshes = await sceneMeshes(page);
      const nvm = nv ? itemMeshes(meshes, nv.id) : [];
      ok("6. ...drawn above the plate on the north cap", nvm.length === 5 && bounds(nvm).min[1] > H && bounds(nvm).max[2] <= -L / 2 + 0.02, nvm.length ? JSON.stringify(bounds(nvm)) : "no meshes");
      ok("6. ...centred on the ridge (world x 0) — placed, never dragged", nvm.length > 0 && near((bounds(nvm).min[0] + bounds(nvm).max[0]) / 2, 0, 0.01),
        nvm.length ? ((bounds(nvm).min[0] + bounds(nvm).max[0]) / 2).toFixed(3) : "");
      ok("6. ...and the north end's style vent gives way to it too", classifyEnd(meshes, -1, H).louvre.length === 0);
      await shot(page, `${shots}/6-back-close-placed.png`, { eye: [0, H + 1.0, -L / 2 - 5.5], at: [0, H + 0.8, -L / 2] });
    }

    // 7. Look inside hides the gable vents with the roof.
    {
      await page.getByRole("button", { name: /Look inside/ }).first().click();
      await settle(page, 500);
      const vis = await page.evaluate(() => window.__ss3dEngine.model.openingsGroup.children.filter((g) => g.userData && g.userData.gable).map((g) => g.visible));
      ok("7. 'Look inside' hides every gable vent with the roof", vis.length === 2 && vis.every((v) => v === false), JSON.stringify(vis));
      await page.getByRole("button", { name: /Show exterior/ }).first().click();
      await settle(page, 400);
      const vis2 = await page.evaluate(() => window.__ss3dEngine.model.openingsGroup.children.filter((g) => g.userData && g.userData.gable).map((g) => g.visible));
      ok("7. ...and shows them again with it", vis2.length === 2 && vis2.every((v) => v === true), JSON.stringify(vis2));
    }
    await page.close();

    // ── 8. Too small: the Low Barn, 8x12 at 3:12, and a 24x12 vent ──────────────────────
    {
      const d = await freshDesigner(ctx, "Low Barn");
      allCalls.push(d.calls); allErrors.push(d.errors);
      await chooseSizeLabel(d.page, "8x12", 12);
      const r = await placeOnPlan(d.page, "Big Vent", "south", 4, 8, 12);
      ok("8. a 24 in vent on an 8 ft gable at 3:12 is still placed, on the wall", !!r.it && r.it.wall === "south" && !r.it.ventZone, JSON.stringify(r.it && { wall: r.it.wall, ventZone: r.it.ventZone }));
      ok("8. ...with the 'too small' toast saying why", r.toast);
      await d.page.screenshot({ path: `${shots}/8-too-small-toast.png` });
      await d.page.close();
    }

    // ── 9. The porch Cabin's truss end ────────────────────────────────────────────────────
    {
      const d = await freshDesigner(ctx, "Porch Cabin");
      allCalls.push(d.calls); allErrors.push(d.errors);
      await chooseSizeLabel(d.page, `${W}x${L}`, L);
      await chooseCladding(d.page, "batten");
      const r = await placeOnPlan(d.page, "Standard Vent", "south", 6, W, L);
      ok("9. a vent on the porch (truss) end goes into the gable with its sill over the brace feet", !!r.it && r.it.ventZone === "gable" && r.it.ventRiseFt >= 0.42 - 1e-6,
        JSON.stringify(r.it && { ventZone: r.it.ventZone, ventRiseFt: r.it.ventRiseFt }));
      await openEditor(d.page);
      const m9 = await sceneMeshes(d.page);
      const pv = r.it ? itemMeshes(m9, r.it.id) : [];
      const fe = classifyEnd(m9, 1, H);
      if (pv.length && fe.truss.length) {
        const vb = bounds(pv);
        const trussBackZ = Math.min(...fe.truss.map((m) => m.min[2]));
        const footY = fe.braces.length ? Math.min(...fe.braces.map((m) => m.min[1])) : H;
        ok("9. the truss stands wholly in front of the placed vent", vb.max[2] <= trussBackZ + 0.001, `vent front z ${vb.max[2].toFixed(3)} truss back z ${trussBackZ.toFixed(3)}`);
        ok("9. the vent's frame clears the brace feet", vb.min[1] >= footY + 0.05, `frame bottom ${vb.min[1].toFixed(3)} brace low ${footY.toFixed(3)}`);
        ok("9. no board rests on the porch header, and the style vent gave way", fe.boardsOnHeader.length === 0 && fe.louvre.length === 0, `boards ${fe.boardsOnHeader.length} louvres ${fe.louvre.length}`);
      } else {
        ok("9. porch end measured", false, `vent meshes ${pv.length}, truss ${fe.truss.length}`);
      }
      await shot(d.page, `${shots}/9-porch-front-close.png`, { eye: [0, H + 1.0, L / 2 + 5.5], at: [0, H + 0.8, L / 2] });
      await shot(d.page, `${shots}/9-porch-quarter.png`, { eye: [3.8, H + 0.9, L / 2 + 3.6], at: [0, H + 0.7, L / 2] });
      await d.page.close();
    }
  } catch (e) {
    ok("harness ran to the end", false, e && e.stack ? e.stack.split("\n").slice(0, 5).join(" / ") : String(e));
  } finally {
    const writes = allCalls.flat().filter((c) => !c.aborted && c.method !== "GET" && c.path && !/\/rpc\/(get_config|get_fixtures)$/.test(c.path));
    console.log(`stubbed non-config calls: ${writes.length}${writes.length ? " — " + [...new Set(writes.map((c) => c.path))].join(", ") : ""}`);
    const pageErrors = allErrors.flat().filter((x) => /^pageerror/.test(x));
    ok("no uncaught page errors", pageErrors.length === 0, pageErrors.slice(0, 3).join(" | "));
    await browser.close();
  }
  const bad = failed();
  console.log(bad.length ? `\n${bad.length} check(s) FAILED` : "\nall checks passed");
  console.log(`shots in ${shots}`);
  return bad.length;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then((n) => process.exit(n ? 1 : 0));
}
