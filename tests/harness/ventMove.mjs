// Moving a vent UP AND DOWN, driven for real: the plan's zone chips and 3 in arrows, their refusal
// toasts, and a vent dragged down the wall and back up into the gable in the full-screen 3D.
//
// Carolyn, 2026-09-14: the Standard Vent she placed sat low beside the door, and it had to be
// "draggable up". 1.9 put a new vent in the gable by default; this proves the COMPILED bundle lets
// the customer move one afterwards, with the clicks a customer makes:
//   2D  1. a gable vent's readout, ▼ at the sill refused, ▲ 3 in, ▲ until the gable refuses
//       2. "On the wall": top spot, ▲ refused pointing at the chip, ▼ a variable sill, "In the gable" back up
//       3. a second vent whose wall spot is taken: "On the wall" refused
//       4. an eave vent: "In the gable" refused, ▲ at the top refused WITHOUT the chip hint, ▼ x4
//       5. the 3D draws the lowered eave vent at its sill, and the gable vent above the plate
//       6. an 8 ft gable at 3:12 and a 24 in vent: "In the gable" refused as too small
//   3D  7. a gable vent dragged DOWN in 3D comes onto the wall as a variable sill
//       8. dragged UP 120+ px it goes back into the gable
//       9. down once more, then sideways only: it moves along and its sill does not change
// The 3D section needs no plan control (the vent starts in the gable, where 1.9 places it), so
// VM_STEPS=3d runs it alone — which is how it is run against a build from before this change.
//
//   python -m http.server 8125 --bind 127.0.0.1        (repo root)
//   node tests/harness/ventMove.mjs                     (SS_SHOTS=<dir> for the screenshots)
import { pathToFileURL } from "node:url";
import { launch, stubSupabase, collectErrors, openDesigner, readItems, svgPoint, buildingRect, reporter, shotsDir, recordRefusals, waitNoRefusal, refusalsSince, armVent } from "./lib.mjs";
import { CONFIG as GABLE_CONFIG, FIXTURES as GABLE_FIXTURES, pickStyle, chooseCladding, openEditor, sceneMeshes, shot } from "./gableProbe.mjs";

const W = 12, L = 32, H = 7.5;
const MIN_RISE = 2 / 12;
const TOP_SILL = H - 0.35 - 8 / 12;          // a Standard Vent's bottom edge at the wall's top spot
const ONLY_3D = process.env.VM_STEPS === "3d";
const MSG = {
  noGable: "Only the end walls under the peak have a gable",
  noRoom: "This gable is too small for that vent.",
  topGable: "That vent is as high as this gable allows.",
  bottomGable: "That vent is at the bottom of the gable",
  topWallGable: "That vent is as high as the wall allows — choose In the gable to go higher.",
  topWall: "That vent is as high as the wall allows.",
  wall: "Something else is already on that part of the wall.",
};

// The probe's config (Porch Cabin, Gable Cabin: 12x32 at 5:12, batten, 7.5 ft walls) plus an 8x12
// "Low Barn" at 3:12 and a 24x12 vent — the same additions ventGable.mjs makes, for the too-small case.
const plain = GABLE_CONFIG.buildingStyles.find((s) => s.value === "plain");
const CONFIG = {
  ...GABLE_CONFIG,
  clientId: "harness-vent-move",
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
const fmt = (v) => (v == null ? String(v) : Number(v).toFixed(4));

async function chooseSizeLabel(page, label, lenFt) {
  const sel = page.locator("select").filter({ has: page.locator("option", { hasText: label }) });
  await sel.first().selectOption({ label });
  await page.waitForFunction((l) => [...document.querySelectorAll("svg text")].some((t) => t.textContent.trim() === `${l} ft`), lenFt, { timeout: 15000 });
  await settle(page, 500);
}
async function wallPoint(page, wall, alongFt, w, l) {
  const r = await buildingRect(page);
  const fx = r.w / w, fy = r.h / l;
  if (wall === "south") return svgPoint(page, r.x + alongFt * fx, r.y + r.h - 0.4 * fy);
  if (wall === "north") return svgPoint(page, r.x + alongFt * fx, r.y + 0.4 * fy);
  if (wall === "west") return svgPoint(page, r.x + 0.4 * fx, r.y + alongFt * fy);
  return svgPoint(page, r.x + r.w - 0.4 * fx, r.y + alongFt * fy);
}
async function placeOnPlan(page, toolName, wall, alongFt, w, l) {
  const before = new Set(((await readItems(page)) || []).map((i) => i.id));
  await armVent(page, toolName);
  await settle(page, 250);
  const p = await wallPoint(page, wall, alongFt, w, l);
  await page.mouse.click(p.x, p.y);
  await settle(page, 500);
  return ((await readItems(page)) || []).find((i) => !before.has(i.id)) || null;
}
const itemById = async (page, id) => ((await readItems(page)) || []).find((i) => i.id === id) || null;
const readout = (page) => page.locator("[data-vent-readout]").first().innerText({ timeout: 3000 }).catch(() => null);
const pressed = (page, name) => page.getByRole("button", { name, exact: true }).first().getAttribute("aria-pressed", { timeout: 3000 }).catch(() => null);

// Click a toolbar control and report whether `msg` was shown. Any earlier toast is waited out first:
// refuseDrag leaves an identical message's node alone, so a repeat inside its 4 s would be invisible.
async function clickFor(page, name, msg) {
  await waitNoRefusal(page);
  const t0 = await page.evaluate(() => Date.now());
  await page.getByRole("button", { name, exact: true }).first().click();
  await settle(page, 350);
  const seen = await refusalsSince(page, t0);
  return { toast: msg ? seen.some((t) => t.includes(msg)) : seen.length > 0, seen };
}
const UP = "Raise the vent 3 inches", DOWN = "Lower the vent 3 inches";

async function freshDesigner(ctx, styleLabel) {
  const page = await ctx.newPage();
  const errors = collectErrors(page);
  await page.addInitScript(() => { window.__SS3D_DEBUG = true; });
  await recordRefusals(page);
  const calls = await stubSupabase(page, { config: CONFIG, fixtures: FIXTURES });
  await openDesigner(page, CONFIG.clientId);
  await page.waitForFunction(() => [...document.querySelectorAll("svg rect")].some((r) => r.getAttribute("stroke") === "#1E293B"), null, { timeout: 30000 });
  await pickStyle(page, styleLabel);
  return { page, errors, calls };
}
const itemMeshes = (meshes, id) => meshes.filter((m) => m.itemId === id);
const bounds = (ms) => ({
  min: [0, 1, 2].map((k) => Math.min(...ms.map((m) => m.min[k]))),
  max: [0, 1, 2].map((k) => Math.max(...ms.map((m) => m.max[k]))),
});
// World points to screen pixels through the viewer's own camera.
async function project(page, pts) {
  return page.evaluate((pts) => {
    const E = window.__ss3dEngine;
    const V = E.camera.position.constructor;
    E.camera.updateMatrixWorld();
    const r = E.renderer.domElement.getBoundingClientRect();
    return pts.map(([x, y, z]) => { const v = new V(x, y, z).project(E.camera); return { x: r.x + ((v.x + 1) / 2) * r.width, y: r.y + ((1 - v.y) / 2) * r.height }; });
  }, pts);
}
// The screen point at the middle of an item's drawn meshes, facing the camera.
async function itemScreenCentre(page, id) {
  const m = itemMeshes(await sceneMeshes(page), id);
  if (!m.length) return null;
  const b = bounds(m);
  return { b, m, pt: (await project(page, [[(b.min[0] + b.max[0]) / 2, (b.min[1] + b.max[1]) / 2, b.max[2]]]))[0] };
}
async function drag3(page, from, to) {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(from.x + 1, from.y - 1, { steps: 2 });
  await page.mouse.move(to.x, to.y, { steps: 30 });
  await settle(page, 250);
  await page.mouse.up();
  await settle(page, 1200);
}
const heightKeys = (v) => v && ({ ventZone: v.ventZone, ventRiseFt: v.ventRiseFt, sillFt: v.sillFt, sillMode: v.sillMode });

export async function main() {
  const { ok, failed } = reporter();
  const shots = shotsDir("ventMove");
  const { browser, ctx } = await launch({ width: 1440, height: 1000 });
  const allCalls = [];
  const allErrors = [];
  try {
    if (!ONLY_3D) {
      // ── 2D: the Gable Cabin, 12x32, batten ───────────────────────────────────────────────
      const { page, errors, calls } = await freshDesigner(ctx, "Gable Cabin");
      allCalls.push(calls); allErrors.push(errors);
      await chooseSizeLabel(page, `${W}x${L}`, L);
      await chooseCladding(page, "batten");

      // 1. A vent on the south end goes into the gable (1.9) and is selected: the controls show.
      const A0 = await placeOnPlan(page, "Standard Vent", "south", 3, W, L);
      ok("1. a vent on the south end is placed in the gable and selected", !!A0 && A0.ventZone === "gable", JSON.stringify(A0 && { ventZone: A0.ventZone, rise: A0.ventRiseFt }));
      const id = A0 && A0.id;
      ok("1. the readout says 2\" above the plate", (await readout(page)) === '2" above the plate', await readout(page));
      ok("1. 'In the gable' is the pressed chip", (await pressed(page, "In the gable")) === "true" && (await pressed(page, "On the wall")) === "false");
      await page.screenshot({ path: `${shots}/1-toolbar-in-gable.png` });
      {
        const r = await clickFor(page, DOWN, MSG.bottomGable);
        const a = await itemById(page, id);
        ok("1. ▼ at the gable's sill is refused with a sentence pointing at On the wall", r.toast && near(a.ventRiseFt, MIN_RISE, 1e-6), `${r.seen.join(" | ")} rise ${fmt(a.ventRiseFt)}`);
      }
      {
        await clickFor(page, UP, null);
        const a = await itemById(page, id);
        ok("1. ▲ raises it 3 in (rise 5\")", a.ventZone === "gable" && near(a.ventRiseFt, MIN_RISE + 0.25, 1e-6), `rise ${fmt(a.ventRiseFt)}`);
        ok("1. ...and the readout follows", (await readout(page)) === '5" above the plate', await readout(page));
      }
      {
        let n = 0, prev = (await itemById(page, id)).ventRiseFt;
        for (; n < 15; n++) {
          await page.getByRole("button", { name: UP, exact: true }).first().click();
          await settle(page, 200);
          const cur = (await itemById(page, id)).ventRiseFt;
          if (cur <= prev + 1e-6) break;
          prev = cur;
        }
        // The press that did not move it must say why (waited out, so the text is fresh).
        const r = await clickFor(page, UP, MSG.topGable);
        const a = await itemById(page, id);
        ok("1. ▲ climbs until the gable stops it, then refuses: as high as this gable allows", r.toast && a.ventRiseFt > MIN_RISE + 0.5 && a.ventRiseFt < 2.52 && a.ventZone === "gable",
          `presses ${n} top rise ${fmt(a.ventRiseFt)} toast ${r.seen.join(" | ")}`);
        await page.screenshot({ path: `${shots}/1-top-of-gable-refused.png` });
      }

      // 2. On the wall.
      {
        await clickFor(page, "On the wall", null);
        const a = await itemById(page, id);
        ok("2. 'On the wall' brings it to the wall's top spot (zone off, sill fixed)", a.ventZone == null && a.ventRiseFt == null && a.sillFt == null && a.sillMode === "fixed", JSON.stringify(heightKeys(a)));
        ok("2. the readout gives its height off the floor", (await readout(page)) === `6'5.8" off the floor`, await readout(page));
        ok("2. 'On the wall' is now the pressed chip", (await pressed(page, "On the wall")) === "true");
        const r = await clickFor(page, UP, MSG.topWallGable);
        ok("2. ▲ at the top of a gable end's wall is refused, pointing at In the gable", r.toast, r.seen.join(" | "));
        await clickFor(page, DOWN, null);
        const b = await itemById(page, id);
        ok("2. ▼ lowers it 3 in as a variable sill", b.sillMode === "variable" && near(b.sillFt, TOP_SILL - 0.25, 1e-6), `sill ${fmt(b.sillFt)} ${b.sillMode}`);
        await page.screenshot({ path: `${shots}/2-on-the-wall-lowered.png` });
        await clickFor(page, "In the gable", null);
        const c = await itemById(page, id);
        ok("2. 'In the gable' takes it back up to the 2 in sill, sill pair written off", c.ventZone === "gable" && near(c.ventRiseFt, MIN_RISE, 1e-6) && c.sillFt == null && c.sillMode === "fixed", JSON.stringify(heightKeys(c)));
        await clickFor(page, "On the wall", null);
        const d = await itemById(page, id);
        ok("2. and 'On the wall' once more (the top spot, for step 3)", d.ventZone == null && d.sillMode === "fixed");
      }

      // 3. A second vent on the same end goes into the gable; the wall spot under it is taken.
      const B = await placeOnPlan(page, "Standard Vent", "south", 6, W, L);
      ok("3. a second vent on the south end goes into the (now empty) gable", !!B && B.ventZone === "gable");
      if (B) {
        const r = await clickFor(page, "On the wall", MSG.wall);
        const b = await itemById(page, B.id);
        ok("3. 'On the wall' where the first vent already is: refused, and it stays in the gable", r.toast && b.ventZone === "gable", `${r.seen.join(" | ")} zone ${b.ventZone}`);
      }

      // 4. An eave vent.
      const C = await placeOnPlan(page, "Standard Vent", "east", 20, W, L);
      ok("4. a vent on the east (eave) wall is on the wall", !!C && !C.ventZone);
      if (C) {
        const r = await clickFor(page, "In the gable", MSG.noGable);
        ok("4. 'In the gable' on an eave wall is refused: only the end walls have a gable", r.toast && !(await itemById(page, C.id)).ventZone, r.seen.join(" | "));
        const r2 = await clickFor(page, UP, MSG.topWall);
        ok("4. ▲ at the top of an eave wall is refused with no gable hint", r2.toast && !r2.seen.some((t) => t.includes("In the gable")), r2.seen.join(" | "));
        for (let k = 0; k < 4; k++) { await page.getByRole("button", { name: DOWN, exact: true }).first().click(); await settle(page, 200); }
        const c = await itemById(page, C.id);
        ok("4. ▼ x4 puts it 1 ft lower as a variable sill", c.sillMode === "variable" && near(c.sillFt, TOP_SILL - 1, 1e-6), `sill ${fmt(c.sillFt)}`);
        ok("4. the readout gives the new height", (await readout(page)) === `5'5.8" off the floor`, await readout(page));
      }
      await page.screenshot({ path: `${shots}/4-plan.png` });

      // 5. The 3D draws each where the plan says.
      await openEditor(page);
      {
        const meshes = await sceneMeshes(page);
        const cm = C ? itemMeshes(meshes, C.id) : [];
        const cb = cm.length ? bounds(cm) : null;
        // The hole is [sill, sill + 8 in]; the frame straddles its edge by a board, so allow 0.2 ft.
        ok("5. the lowered eave vent is cut into the east wall at its sill", !!cb && cm.every((m) => !m.gable) && near(cb.min[1], TOP_SILL - 1, 0.2) && near(cb.max[1], TOP_SILL - 1 + 8 / 12, 0.2),
          cb ? `y ${cb.min[1].toFixed(3)}..${cb.max[1].toFixed(3)} want ${(TOP_SILL - 1).toFixed(3)}..${(TOP_SILL - 1 + 8 / 12).toFixed(3)}` : "no meshes");
        const am = itemMeshes(meshes, id), bm = B ? itemMeshes(meshes, B.id) : [];
        ok("5. the first vent is on the south wall under the plate", am.length > 0 && am.every((m) => !m.gable) && bounds(am).max[1] <= H && near(bounds(am).max[1], H - 0.35, 0.2),
          am.length ? `top ${bounds(am).max[1].toFixed(3)}` : "no meshes");
        ok("5. the second vent is in the south gable, above the plate", bm.length === 5 && bm.every((m) => m.gable) && bounds(bm).min[1] > H, bm.length ? `bottom ${bounds(bm).min[1].toFixed(3)}` : "no meshes");
        await shot(page, `${shots}/5-south-end.png`, { eye: [0, 6.5, L / 2 + 14], at: [0, 6.5, L / 2] });
        await shot(page, `${shots}/5-east-wall-lowered.png`, { eye: [W / 2 + 12, 5.5, 20 - L / 2], at: [W / 2, 5.5, 20 - L / 2] });
      }
      await page.close();

      // ── 6. Too small: the Low Barn, 8x12 at 3:12, a 24x12 vent ─────────────────────────
      {
        const d = await freshDesigner(ctx, "Low Barn");
        allCalls.push(d.calls); allErrors.push(d.errors);
        await chooseSizeLabel(d.page, "8x12", 12);
        const big = await placeOnPlan(d.page, "Big Vent", "south", 4, 8, 12);
        ok("6. the 24 in vent lands on the wall of the 8 ft gable end", !!big && !big.ventZone);
        const r = big ? await clickFor(d.page, "In the gable", MSG.noRoom) : { toast: false, seen: [] };
        ok("6. 'In the gable' is refused: this gable is too small for that vent", r.toast && big && !(await itemById(d.page, big.id)).ventZone, r.seen.join(" | "));
        await d.page.screenshot({ path: `${shots}/6-too-small.png` });
        await d.page.close();
      }
    }

    // ── 7-9. The 3D drag. No plan control is used: the vent starts in the gable (1.9) ────────
    {
      const d = await freshDesigner(ctx, "Gable Cabin");
      allCalls.push(d.calls); allErrors.push(d.errors);
      const p = d.page;
      await chooseSizeLabel(p, `${W}x${L}`, L);
      await chooseCladding(p, "batten");
      const v0 = await placeOnPlan(p, "Standard Vent", "south", 6, W, L);
      ok("7. setup: a Standard Vent in the south gable", !!v0 && v0.ventZone === "gable", JSON.stringify(heightKeys(v0)));
      await openEditor(p);
      const cam = { eye: [0, 7.2, L / 2 + 15], at: [0, 7.2, L / 2] };
      await shot(p, `${shots}/7-before.png`, cam);
      const t0 = await p.evaluate(() => Date.now());
      let c = await itemScreenCentre(p, v0.id);
      const [u0, u1] = await project(p, [[0, H, L / 2], [0, H + 1, L / 2]]);
      const pxPerFt = u0.y - u1.y;

      // 7. Down: from the gable (bottom 7.67) to well under the plate.
      const downPx = Math.ceil(3 * pxPerFt);
      await drag3(p, c.pt, { x: c.pt.x, y: c.pt.y + downPx });
      const v1 = await itemById(p, v0.id);
      ok("7. dragged DOWN in 3D it comes out of the gable onto the wall as a variable sill", !!v1 && v1.ventZone == null && v1.ventRiseFt == null && v1.sillMode === "variable" && v1.sillFt < TOP_SILL - 0.2,
        `${downPx}px at ${pxPerFt.toFixed(1)} px/ft: ${JSON.stringify(heightKeys(v1))}`);
      c = await itemScreenCentre(p, v0.id);
      ok("7. ...cut into the wall at that sill", !!c && c.m.every((x) => !x.gable) && !!v1 && v1.sillFt != null && near(c.b.min[1], v1.sillFt, 0.2) && c.b.max[1] < H - 0.3,
        c ? `y ${c.b.min[1].toFixed(3)}..${c.b.max[1].toFixed(3)} sill ${fmt(v1 && v1.sillFt)}` : "no meshes");
      await shot(p, `${shots}/7-after-down.png`, cam);

      // 8. Up 120 px (or more, if this camera fits less than 2.2 ft into 120 px — the vent's centre
      // must climb from that sill past plate + 0.25 ft for the zone to change).
      c = await itemScreenCentre(p, v0.id);
      const upPx = Math.max(120, Math.ceil(((H + 0.25 + 0.5) - (v1 && v1.sillFt != null ? v1.sillFt : TOP_SILL)) * pxPerFt));
      await drag3(p, c.pt, { x: c.pt.x, y: c.pt.y - upPx });
      const v2 = await itemById(p, v0.id);
      ok("8. dragged UP it goes back INTO THE GABLE, sill pair written off", !!v2 && v2.ventZone === "gable" && v2.ventRiseFt >= MIN_RISE - 1e-6 && v2.sillFt == null && v2.sillMode === "fixed",
        `${upPx}px: ${JSON.stringify(heightKeys(v2))}`);
      ok("8. ...still under the ridge (only moved up and down)", !!v2 && near(v2.x, v0.x, 0.5), `x ${v2 && v2.x} was ${v0.x}`);
      c = await itemScreenCentre(p, v0.id);
      ok("8. ...drawn on the gable cap above the plate", !!c && c.m.every((x) => x.gable) && c.b.min[1] > H, c ? `bottom ${c.b.min[1].toFixed(3)}` : "no meshes");
      await shot(p, `${shots}/8-after-up.png`, cam);

      // 9. Down again, then sideways only.
      c = await itemScreenCentre(p, v0.id);
      await drag3(p, c.pt, { x: c.pt.x, y: c.pt.y + downPx });
      const v3 = await itemById(p, v0.id);
      ok("9. down again: on the wall", !!v3 && v3.ventZone == null && v3.sillMode === "variable", JSON.stringify(heightKeys(v3)));
      c = await itemScreenCentre(p, v0.id);
      if (c && v3) {
        await drag3(p, c.pt, { x: c.pt.x + Math.ceil(1.5 * pxPerFt), y: c.pt.y });
        const v4 = await itemById(p, v0.id);
        ok("9. dragged sideways only, it moves along and keeps its sill exactly", !!v4 && v4.x !== v3.x && v4.sillFt === v3.sillFt && v4.sillMode === "variable",
          JSON.stringify(v4 && { x: v4.x, was: v3.x, sillFt: v4.sillFt, sillMode: v4.sillMode }));
      } else {
        ok("9. sideways drag measured", false, "no vent meshes");
      }
      const refusals = await refusalsSince(p, t0);
      ok("7-9. no refusal toast during the drags", refusals.length === 0, refusals.join(" | "));
      await shot(p, `${shots}/9-after-sideways.png`, cam);
      await p.close();
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
