// ELECTRICAL DEVICES PLACED FROM THE 3D, and the plan's ceiling-device click — tested against BOTH
// SHIPPED designer twins.
//
// Carolyn, 2026-10-06 (Q26): "yes, customers add outlets, lights and fans in the 3D view". The 3D
// editor gets one Electrical Items button and a chooser sheet; a card arms that item's own tool, and
// place3 commits it with exactly the fields a 2D click writes, so the plan, the 3D, the quote and the
// server price it identically. The fields are two catalog stamps, and an item missing them draws as
// nothing and prices at $0, so every placement path spreads ONE helper, ssElecStamps. Along the way
// the plan's own click is fixed: a ceiling device clicked within 80 px of a wall went to the wall
// branch, whose ssWallItemAt writes neither stamp.
//
// What is pure is lifted and run (ssElecStamps); what lives in the viewer's closures (place3, the
// pointer handlers, buildElectrical3D) is asserted by shape, in both twins, anchored on each branch's
// own comment or declaration rather than on strings that repeat (dragPlane_test's warning: "else if
// (c.propType)" appears three times). The behaviour is proved on the compiled bundle by
// tests/harness/elec3d.mjs (placement, drag, Remove, price parity) and electrical.mjs (the plan click).
//
// Dependency-free apart from std/assert, the house rule for these stubs.

import { assert, assertEquals } from "jsr:@std/assert";

const read = async (p: string) => (await Deno.readTextFile(new URL(p, import.meta.url))).replace(/\r\n/g, "\n");
const JSX = await read("../../../../StructureStudio.jsx");
const CMP = await read("../../../../structure-studio.component.js");
const TWINS = [["structure-studio.component.js", CMP], ["StructureStudio.jsx", JSX]] as const;

/** A plain slice between two stable anchors, loud when either moves. */
function lift(src: string, file: string, start: string, end: string): string {
  const i = src.indexOf(start);
  const j = i < 0 ? -1 : src.indexOf(end, i + start.length);
  if (i < 0 || j < 0) {
    throw new Error(
      `elec3dPlace_test: could not find ${start} .. ${end} in ${file} (start=${i}, end=${j}). ` +
        "The anchors moved — re-point them rather than deleting this test.",
    );
  }
  return src.slice(i, j);
}
const once = (src: string, needle: string) => src.split(needle).length - 1;

// The helper, from its declaration to the comment that follows it.
const STAMPS: [string, string] = ["function ssElecStamps(cfg) {", "// Does an item at `sn` overlap a wall slab"];
// The viewer's closures and the plan's click, each by its own declaration and the next one's.
const REGIONS: Record<string, [string, string]> = {
  handleClick: ["const handleClick = useCallback((e) => {", "// Place the door chosen in the picker"],
  place3: ["const place3 = (tool, cfg, pageX, pageY) => {", "const onPtr3Down = (ev) => {"],
  onPtr3Down: ["const onPtr3Down = (ev) => {", "const commitLive = (it, patch, scope) => {"],
  onPtr3Move: ["const onPtr3Move = (ev) => {", "const onPtr3Up = (ev) => {"],
  buildElectrical3D: ["const buildElectrical3D = (it, c, itemsNow) => {", "// ── STEPS AND A CUSTOMER'S RAMP"],
  placeHighlight: ["const placeHighlight = (it) => {", "// Queue a rebuild for the next frame"],
  elecBox3: ["const elecBox3 = (it) => {", "const placeDims = (it) => {"],
  sheetAndRow: ["{pick3 && (", "{msg3 && <span"],
};
const region = (src: string, file: string, k: string) => lift(src, file, REGIONS[k][0], REGIONS[k][1]);

// deno-lint-ignore no-explicit-any
type Fn = (cfg: any) => Record<string, unknown>;
const ssElecStamps = new Function(`${lift(CMP, "structure-studio.component.js", STAMPS[0], STAMPS[1])}; return ssElecStamps;`)() as Fn;

Deno.test("ssElecStamps and every lifted region are byte-identical in the two twins", () => {
  assertEquals(lift(JSX, "StructureStudio.jsx", STAMPS[0], STAMPS[1]), lift(CMP, "structure-studio.component.js", STAMPS[0], STAMPS[1]), "twins differ in ssElecStamps");
  for (const k of Object.keys(REGIONS)) assertEquals(region(JSX, "StructureStudio.jsx", k), region(CMP, "structure-studio.component.js", k), `twins differ in ${k}`);
});

Deno.test("ssElecStamps: the two catalog stamps, and nothing for a config without them", () => {
  // The tools elecToolsFor makes: an outlet on the wall, a fan on the ceiling.
  const wall = { label: "Outlet", wallSnap: true, modelKey: "electrical", width: 0.5, height: 0.3, heightOffFloorIn: 18, noPalette: true, electricalItemId: "e-out" };
  const ceiling = { label: "Ceiling Fan", wallSnap: false, modelKey: "electrical", width: 0.8, height: 0.8, heightOffFloorIn: 96, noPalette: true, electricalItemId: "e-fan" };
  assertEquals(ssElecStamps(wall), { electricalItemId: "e-out", heightOffFloorIn: 18 });
  assertEquals(ssElecStamps(ceiling), { electricalItemId: "e-fan", heightOffFloorIn: 96 });
  // A shelf: no catalog id. Its own height off the floor IS snapshotted, as the plan's wallSnap
  // branch always did (the inline pair this replaced wrote it for any config carrying one).
  assertEquals(ssElecStamps({ wallSnap: true, modelKey: "wallShelf", width: 4, height: 1, depthIn: 24 }), {});
  assertEquals(ssElecStamps({ wallSnap: true, modelKey: "wallShelf", width: 4, height: 1, heightOffFloorIn: 48 }), { heightOffFloorIn: 48 });
  // A height of 0 is a height (the != null test), an empty id is no id.
  assertEquals(ssElecStamps({ electricalItemId: "", heightOffFloorIn: 0 }), { heightOffFloorIn: 0 });
  assertEquals(ssElecStamps(null), {});
  assertEquals(ssElecStamps(undefined), {});
  // A new object every time: a placed item never shares the config's keys by reference.
  const a = ssElecStamps(wall), b = ssElecStamps(wall);
  assert(a !== b);
});

Deno.test("the plan's click: a ceiling device never takes the wall branch, and both branches stamp through ssElecStamps", () => {
  for (const [name, src] of TWINS) {
    const hc = region(src, name, "handleClick");
    // (a) the routing fix
    assertEquals(once(hc, "} else if (wall && !cfg.electricalItemId) {"), 1, `${name}: the wall branch must exclude a ceiling device`);
    assertEquals(once(hc, "} else if (wall) {"), 0, `${name}: the old unguarded wall branch is back`);
    // (b) the wallSnap candidate and the free branch both spread the helper, and nothing spells the
    // two keys out any more.
    const ws = lift(hc, name, "if (cfg.wallSnap) {", "const others = items.filter");
    assert(ws.includes("...(cfg.depthIn != null ? { depthIn: cfg.depthIn } : {}),"), `${name}: the plan's wallSnap branch keeps its depthIn`);
    assert(ws.includes("...ssElecStamps(cfg) };"), `${name}: the plan's wallSnap branch spreads ssElecStamps`);
    const free = lift(hc, name, "HERE EVEN WHEN CLICKED BESIDE A WALL", "setItems((p) => [...p, ni]);");
    assert(free.includes("wall: null") && free.includes("...ssElecStamps(cfg) };"), `${name}: the plan's free branch is wall-less and stamped`);
    assert(!hc.includes("{ electricalItemId: cfg.electricalItemId }"), `${name}: a placement spells the stamps out again`);
  }
});

Deno.test("place3: a ceiling device is the 2D free branch, before the wallSnap branch, and a wall device is stamped", () => {
  for (const [name, src] of TWINS) {
    const p3 = region(src, name, "place3");
    // (c) the ceiling branch, field for field, and ahead of `if (cfg.wallSnap)`, which would catch nothing
    // of it (a ceiling tool is not wallSnap) but is where a reader looks for the electrical rule.
    const at = p3.indexOf("if (cfg.electricalItemId && !cfg.wallSnap) {");
    const ws = p3.indexOf("if (cfg.wallSnap) {");
    assert(at > 0 && ws > at, `${name}: place3's ceiling-device branch must come before its wallSnap branch (${at}, ${ws})`);
    const ceil = p3.slice(at, ws);
    assert(ceil.includes('flash3("Click the floor inside the building, under where it should hang.");'), `${name}: a click outside the building is refused with a sentence`);
    assert(ceil.includes("const iw = cfg.width * scale, ih = slabDepthFt(cfg) * scale;"), `${name}: clamped by the plan's own size reads`);
    assert(ceil.includes("Math.max(mgX + iw / 2, Math.min(pageX, mgX + pWpx - iw / 2))") && ceil.includes("Math.max(mgY + ih / 2, Math.min(pageY, mgY + pHpx - ih / 2))"), `${name}: held inside the footprint`);
    assert(ceil.includes("commitPlaced3({ id: idCounter++, type: tool, x, y, rotation: 0, wall: null, widthFt: cfg.width, heightFt: cfg.height, ...ssElecStamps(cfg) });"),
      `${name}: committed with the 2D free branch's fields and the stamps`);
    // (d) the wallSnap candidate: depthIn and the stamps, BEFORE the collision checks read it.
    const wsBlock = lift(p3, name, "if (cfg.wallSnap) {", "if (tool === \"loft\") {");
    const cand = wsBlock.indexOf("...(cfg.depthIn != null ? { depthIn: cfg.depthIn } : {}), ...ssElecStamps(cfg) };");
    assert(cand > 0 && cand < wsBlock.indexOf("checkDoorCollision(candidate"), `${name}: place3's wallSnap candidate is stamped before it is checked`);
    // (e) the picker stand-in is still refused: nothing may commit it.
    assert(p3.includes("if (cfg.isShelfPicker || cfg.isElecItemPicker || cfg.isVentPicker) {"), `${name}: place3 still refuses the Electrical Items stand-in`);
  }
});

Deno.test("the pointer: a ceiling device skips the wall pick; a wall device drags as a slab; a ceiling device drags free", () => {
  for (const [name, src] of TWINS) {
    const down = region(src, name, "onPtr3Down");
    assert(down.includes("const hitW = cfg.electricalItemId && !cfg.wallSnap ? null : pickWall3(ev);"), `${name}: onPtr3Down aims a ceiling device at the floor`);
    // The floor plane it falls to is aimed before it is read (dragPlane_test's rule, restated here).
    assert(/dragPlane\.set\(new THREE\.Vector3\(0, 1, 0\), 0\);\n\s*const p = raycaster\.ray\.intersectPlane\(dragPlane, dragHit\);/.test(down), `${name}: the floor plane is set before the placement raycast`);
    const mv = region(src, name, "onPtr3Move");
    // (g) the slab branch admits a wall device, and aims at its DRAWN height.
    assertEquals(once(mv, "} else if (ssSlabModel(it.type, itemTypes) || (c.wallSnap && it.electricalItemId)) {"), 1, `${name}: the slab drag admits a wall device`);
    assert(mv.includes("const elecB = it.electricalItemId ? elecBox3(it) : null;"), `${name}: a wall device's plane is at its drawn height`);
    // The ceiling branch: after the prop branch, aimed before it reads, clamped, never quantised.
    const ci = mv.indexOf("} else if (it.electricalItemId && !c.wallSnap) {");
    assert(ci > mv.indexOf("// The loft drag above, minus everything a loft needs"), `${name}: the ceiling drag branch follows the prop branch`);
    const cb = mv.slice(ci, mv.indexOf("ev.preventDefault();", ci));
    assert(cb.indexOf("dragPlane.set(") >= 0 && cb.indexOf("dragPlane.set(") < cb.indexOf("intersectPlane(dragPlane"), `${name}: the ceiling drag sets its plane first`);
    // ...at the height it was grabbed at, once per gesture: dragged in or out from under a loft the
    // fitting is re-hung, and a plane that followed it would flip it across the loft's edge.
    assert(cb.includes("if (dragging3.elecY == null) {") && cb.includes("dragPlane.set(new THREE.Vector3(0, 1, 0), -dragging3.elecY);"), `${name}: the ceiling drag's plane is taken once per gesture`);
    assert(cb.includes("Math.max(halfW, Math.min(p.x + bldgW / 2, bldgW - halfW))") && cb.includes("Math.max(halfH, Math.min(p.z + bldgH / 2, bldgH - halfH))"), `${name}: held inside the footprint`);
    assert(!/Math\.round\(/.test(cb), `${name}: the ceiling drag must not quantise`);
    assert(cb.includes("commitLive(it, { x: nx, y: ny }, { interior: true });"), `${name}: committed live, interior-scoped`);
  }
});

Deno.test("the drawing: itemId only behind the tool, and the outline at the drawn height", () => {
  for (const [name, src] of TWINS) {
    const be = region(src, name, "buildElectrical3D");
    // (f)
    assertEquals(once(be, "g.userData = { ...(c && c.electricalItemId ? { itemId: it.id } : {}), ssElec: String(it.electricalItemId), ssElecFor: it.id };"), 1,
      `${name}: a device group carries itemId only while its tool exists`);
    assertEquals(once(be, "itemId:"), 1, `${name}: no other itemId in buildElectrical3D`);
    assert(be.includes("m.userData.noShadow = true;"), `${name}: devices still cast no shadow`);
    // UNDER A LOFT: the ceiling branch reads the loft the renderer draws (loftElevOf), with the list
    // buildInterior hands it, and only a loft that reaches the fitting moves it (loftHeight_test runs it).
    assert(be.includes("(itemsNow || []).forEach((lf) => {") && be.includes("const top = loftElevOf(lf);") && be.includes("if (top > cH0 - drop) cH = Math.min(cH, top - D3.LOFT_T);"),
      `${name}: a ceiling fitting under a loft hangs from the loft`);
    assert(src.includes("if (it.electricalItemId) { buildElectrical3D(it, c, itemsNow); return; }") && !src.includes("buildElectrical3D(it, c);"), `${name}: buildInterior hands it the items`);
    const ph = region(src, name, "placeHighlight");
    assert(ph.indexOf("if (it.electricalItemId && c.electricalItemId) {") >= 0 && ph.indexOf("if (it.electricalItemId && c.electricalItemId) {") < ph.indexOf("if (c.wallOnly) {"),
      `${name}: placeHighlight outlines a device before the wallOnly branch`);
    assert(ph.includes("const bb = elecBox3(it);"), `${name}: the outline reads the drawn box`);
    const eb = region(src, name, "elecBox3");
    assert(eb.includes("x.userData.ssElecFor === it.id") && eb.includes("new THREE.Box3().setFromObject(g)"), `${name}: elecBox3 measures the device's own group`);
  }
});

Deno.test("the chooser: one button, a card per offered item with no price, and only the main mount offers it", () => {
  for (const [name, src] of TWINS) {
    const ui = region(src, name, "sheetAndRow");
    assertEquals(once(ui, 'data-ss-elec3d="1"'), 1, `${name}: one Electrical Items button`);
    assert(ui.includes("{placeableElec && placeableElec.length > 0 && (() => {"), `${name}: the button needs placeableElec`);
    assert(ui.includes('pick3.kind === "elec" ? "Pick an electrical item"'), `${name}: the sheet's title`);
    const cards = lift(ui, name, '{pick3.kind === "elec" && (placeableElec || [])', '{pick3.kind !== "elec" && (pick3.kind === "door"');
    assert(cards.includes("data-ss-elec3d-card={k}"), `${name}: one card per key`);
    assert(cards.includes("onClick={() => { setPick3(null); setTool3(k); if (!interior) setInterior(true); }}"), `${name}: a card arms the item's own tool, with Look inside`);
    // Code only (its comment says "NO PRICE"); a template's ${…} is not a dollar sign.
    const cardCode = cards.replace(/\{\/\*[\s\S]*?\*\/\}/g, "").replace(/\/\/[^\n]*/g, "");
    assert(!/price|fmtMoney|\$(?!\{)/i.test(cardCode), `${name}: a chooser card shows a price`);
    // The button never arms the stand-in key: it toggles the sheet or disarms a device.
    const btn = lift(ui, name, 'data-ss-elec3d="1"', "</button>");
    assert(!btn.includes("setTool3(\"elecItemPicker\")") && !/setTool3\([^)]*isElecItemPicker/.test(btn), `${name}: the button arms the stand-in`);
    assert(ui.includes('pick3.kind !== "ramp" && pick3.kind !== "elec" && roOffer'), `${name}: no rough-opening tile on the electrical sheet`);
    assert(ui.includes('electricalItemId && !itemTypes[tool3].wallSnap ? "click the floor under where it hangs"'), `${name}: a ceiling device's hint`);
    // Mounts: the full editor is handed the item tools, the calibration preview is not, and both
    // still keep the stand-in out of paletteKeys.
    assertEquals(once(src, "placeableElec={Object.keys(elecItemTools)}"), 1, `${name}: placeableElec on one mount`);
    const cal = lift(src, name, "const cal3dPreview = ", "// ── ADVANCED (2026-09-28)");
    assert(cal.includes("<Structure3DViewer") && !cal.includes("placeableElec={"), `${name}: the calibration preview offers no electrical chooser`);
    assertEquals(once(src, "!ITEMS[k].isElecItemPicker &&"), 2, `${name}: both mounts' paletteKeys still exclude the stand-in`);
  }
});
