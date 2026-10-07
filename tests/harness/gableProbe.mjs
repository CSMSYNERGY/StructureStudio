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
// THE FRAME CUT TO FIT (2026-10-07). The 2026-10-06 review, on a dark cabin with an 8 ft recessed porch:
// two posts at each front corner, and the truss not cut to fit. The porch frame is one plane of 4x6
// timber now, its members found by userData.ssPorchFrame, and frameChecks measures every joint: the
// chords meet at the apex and sit on the beam, the king post's top meets both chords, each strut's top
// meets its chord and its foot the beam and the king post, all within 0.01 ft, no member inside another;
// one upright at each porch corner, a corner board at each inside corner, side beams back to the wall.
// The "open" variant (roof.porchGable "open", the style's wood colour) checks the same frame with the
// gable moved to the set-back wall, its vent there, the boarded ceiling and the deck.
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
// The OPEN porch gable (roof.porchGable, 2026-10-07): the same Cabin with the gable over its porch open and
// its timber in a wood colour, so the frame, the deck and the set-back gable are measured too.
const WOOD = "#9a4530";
const OPEN_D3 = { ...PORCH_D3, roof: { ...PORCH_D3.roof, porchGable: "open" }, colors: { ...PORCH_D3.colors, wood: WOOD } };
export const CONFIG_OPEN = {
  ...CONFIG,
  buildingStyles: [style("open", "Open Porch Cabin", OPEN_D3)],
  sizePricing: { open: { [SIZE]: { widthFt: W, lengthFt: L, basePrice: 10000 } } },
  claddingOptions: { open: CLADS },
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
// width/height/depth, its rotation about z, colour, and the item group it belongs to. Since the porch
// frame was cut to fit (2026-10-07) also its tag (userData.ssPorchFrame), and for a member cut to its
// joints (an ExtrudeGeometry) its outline in the frame's plane, read off its own world vertices (x, y:
// this probe's footprint is portrait, so the porch end faces +z). A gable prism (two materials) carries
// the world z of its CAP vertices, because a moved cap no longer bounds the prism (its sides stay put).
export async function sceneMeshes(page) {
  return page.evaluate(() => {
    const E = window.__ss3dEngine;
    const V = E.camera.position.constructor;
    E.scene.updateMatrixWorld(true);
    const hexOf = (m) => { const mm = Array.isArray(m) ? m[m.length - 1] : m; return mm && mm.color ? "#" + mm.color.getHexString() : null; };
    const r3 = (v) => Math.round(v * 1000) / 1000;
    const out = [];
    window.__probeMesh = [];
    const groups = { roof: E.model.roofGroup, openings: E.model.openingsGroup, walls: E.model.wallsGroup, root: E.model.root };
    const seenMesh = new Set();
    Object.keys(groups).forEach((gname) => {
      groups[gname].traverse((o) => {
        if (!o.isMesh || !o.geometry || !o.visible || seenMesh.has(o)) return;
        // root holds every group: only what is in no other (the floor, the porch deck) is "root".
        if (gname === "root") { let q = o, inner = false; while (q) { if (q === E.model.roofGroup || q === E.model.openingsGroup || q === E.model.wallsGroup) inner = true; q = q.parent; } if (inner) return; }
        seenMesh.add(o);
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
        const ud = o.userData || {};
        let poly = null, capZs = null;
        const pos = o.geometry.attributes.position;
        if (ud.ssPorchFrame && o.geometry.type === "ExtrudeGeometry" && pos) {
          const seen = new Map();
          for (let i = 0; i < pos.count; i++) {
            const v = new V().fromBufferAttribute(pos, i).applyMatrix4(o.matrixWorld);
            const key = `${Math.round(v.x * 1e4)},${Math.round(v.y * 1e4)}`;
            if (!seen.has(key)) seen.set(key, [v.x, v.y]);
          }
          poly = [...seen.values()];
        }
        if (Array.isArray(o.material) && o.geometry.type === "ExtrudeGeometry" && o.geometry.groups && o.geometry.groups[0] && pos) {
          const g0 = o.geometry.groups[0], zs = new Set();
          for (let i = g0.start; i < g0.start + g0.count; i++) zs.add(r3(new V().fromBufferAttribute(pos, i).applyMatrix4(o.matrixWorld).z));
          capZs = [...zs].sort((a, b) => a - b);
        }
        window.__probeMesh.push(o);
        out.push({
          i: out.length, group: gname, itemId, gable, geom: o.geometry.type, color: hexOf(o.material), multi: Array.isArray(o.material),
          tag: ud.ssPorchFrame || null, corner: ud.ssPorchCorner || null, poly, capZs,
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
// The porch frame's members are found by their tags (2026-10-07), never by size: the truss used to be
// boxes 0.42 deep, and a member looked up by its size vanishes from the checks the moment it is rebuilt.
export function classifyEnd(meshes, sgn, H, zAt) {
  const zMid = zAt != null ? zAt : sgn * (L / 2);
  const outOf = (m) => ({ back: sgn > 0 ? m.min[2] - zMid : zMid - m.max[2], front: sgn > 0 ? m.max[2] - zMid : zMid - m.min[2] });
  const onEnd = meshes.filter((m) => m.group === "roof" && (sgn > 0 ? m.max[2] > zMid - 0.7 && m.min[2] > zMid - 1.2 : m.min[2] < zMid + 0.7 && m.max[2] < zMid + 1.2));
  const withOut = (m) => ({ ...m, ...outOf(m) });
  // The gable prism: the widest two-material extrusion. Its cap face on this end is the cap vertices'
  // plane nearest it (capZs), wherever the cap stands.
  const prism = meshes.filter((m) => m.group === "roof" && m.geom === "ExtrudeGeometry" && m.multi).sort((a, b) => b.size[0] - a.size[0])[0] || null;
  const capZ = prism && prism.capZs ? (sgn > 0 ? Math.max(...prism.capZs) : Math.min(...prism.capZs)) : null;
  const cap = prism ? { ...prism, face: capZ == null ? (sgn > 0 ? prism.max[2] - zMid : zMid - prism.min[2]) : sgn * (capZ - zMid) } : null;
  const louvre = onEnd.filter((m) => m.color === VENT_DARK && m.min[1] >= H - 0.01).map(withOut);
  const vTrim = louvre.length ? onEnd.filter((m) => m.color === TRIM && m.box && !m.rotZ && !m.tag && m.min[1] >= H - 0.05
    && m.max[1] <= louvre[0].max[1] + 0.2 && m.min[0] >= louvre[0].min[0] - 0.2 && m.max[0] <= louvre[0].max[0] + 0.2).map(withOut) : [];
  const tagged = (t) => onEnd.filter((m) => m.tag === t).map(withOut);
  const chords = tagged("chord"), kingPost = tagged("kingPost")[0] || null, struts = tagged("strut");
  const truss = [...chords, ...(kingPost ? [kingPost] : []), ...struts];
  const braces = struts;
  const header = tagged("beam")[0] || null;
  const posts = tagged("post");
  const strips = onEnd.filter((m) => m.box && !m.rotZ && !m.tag && m.min[1] >= H - 0.01 && m.color !== TRIM && m.color !== VENT_DARK && m.box[0] <= 0.2 && m.box[2] <= 0.11).map(withOut);
  // A flat trim-coloured board lying within 0.25 ft above the header's top: H1's "extra 2x4".
  const boardsOnHeader = header ? onEnd.filter((m) => m.color === TRIM && m.box && !m.rotZ && !m.tag && m !== header
    && m.size[0] > 3 * m.size[1] && m.min[1] >= header.max[1] - 0.02 && m.min[1] <= header.max[1] + 0.25).map(withOut) : [];
  return { zMid, cap, louvre, vTrim, truss, chords, kingPost, struts, braces, header, posts, strips, boardsOnHeader, bandMeshes: onEnd.filter((m) => m.max[1] > H - 0.6).map(withOut) };
}

// ── THE FRAME'S JOINTS (2026-10-07) ─────────────────────────────────────────────────────────────
// Every joint of the porch's timber frame measured off the built geometry: a joint "meets" when the
// vertex that should lie on the other member's face lies within GAP of that member's outline. Outlines
// are convex (each member is a band cut by straight cuts), so the boundary distance and the inside test
// below are exact.
const GAP = 0.01;
const hull = (pts) => {
  const c = pts.reduce((a, q) => [a[0] + q[0] / pts.length, a[1] + q[1] / pts.length], [0, 0]);
  return pts.slice().sort((a, b) => Math.atan2(a[1] - c[1], a[0] - c[0]) - Math.atan2(b[1] - c[1], b[0] - c[0]));
};
const segDist = (p, a, b) => {
  const dx = b[0] - a[0], dy = b[1] - a[1], l2 = dx * dx + dy * dy;
  const t = l2 ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2)) : 0;
  return Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy);
};
const edgeDist = (p, poly) => { const h = hull(poly); let d = Infinity; h.forEach((a, i) => { d = Math.min(d, segDist(p, a, h[(i + 1) % h.length])); }); return d; };
// How far p is INSIDE the convex outline (negative: outside).
const depthIn = (p, poly) => {
  const h = hull(poly); let d = Infinity;
  h.forEach((a, i) => {
    const b = h[(i + 1) % h.length], dx = b[0] - a[0], dy = b[1] - a[1], l = Math.hypot(dx, dy) || 1;
    d = Math.min(d, ((p[0] - a[0]) * dy - (p[1] - a[1]) * dx) / l * -1);
  });
  return d;
};
const rectOf = (m) => [[m.min[0], m.min[1]], [m.max[0], m.min[1]], [m.max[0], m.max[1]], [m.min[0], m.max[1]]];
const f3 = (v) => (v == null ? "?" : Number(v).toFixed(3));

export function frameChecks(ok, tag, e, H, W, { truss = true } = {}) {
  const beam = e.header;
  ok(`[${tag}] frame: one tie beam and two posts`, !!beam && e.posts.length === 2, `beam ${!!beam} posts ${e.posts.length}`);
  if (!beam || e.posts.length !== 2) return;
  const top = beam.max[1];
  ok(`[${tag}] frame: the beam's top is the plate (H)`, Math.abs(top - H) <= GAP, f3(top));
  // ONE PLANE: every member's depth is the beam's.
  const members = [beam, ...e.posts, ...e.truss];
  const off = members.filter((m) => Math.abs(m.min[2] - beam.min[2]) > 0.001 || Math.abs(m.max[2] - beam.max[2]) > 0.001);
  ok(`[${tag}] frame: posts, beam${truss ? ", chords, king post and struts" : ""} share one plane (${members.length} members)`, off.length === 0,
    off.map((m) => `${m.tag} z ${f3(m.min[2])}..${f3(m.max[2])} vs ${f3(beam.min[2])}..${f3(beam.max[2])}`).join("; "));
  ok(`[${tag}] frame: 4x6 timber (0.29 deep)`, Math.abs(beam.size[2] - 0.29) <= 0.002 && Math.abs(beam.size[1] - 0.46) <= 0.002, beam.size.join("x"));
  for (const p of e.posts) {
    const s = Math.sign(p.ctr[0]);
    ok(`[${tag}] frame: the ${s > 0 ? "right" : "left"} post stands under the beam's end (top on its underside, outer face on its end)`,
      Math.abs(p.max[1] - beam.min[1]) <= GAP && Math.abs((s > 0 ? p.max[0] - beam.max[0] : p.min[0] - beam.min[0])) <= GAP,
      `post top ${f3(p.max[1])} beam bottom ${f3(beam.min[1])}; post outer ${f3(s > 0 ? p.max[0] : p.min[0])} beam end ${f3(s > 0 ? beam.max[0] : beam.min[0])}`);
    ok(`[${tag}] frame: the ${s > 0 ? "right" : "left"} post is 5.5 in across the front, 3.5 in deep`, Math.abs(p.size[0] - 0.46) <= 0.002 && Math.abs(p.size[2] - 0.29) <= 0.002, p.size.join("x"));
  }
  if (!truss) return;
  ok(`[${tag}] truss: two chords, a king post, two struts`, e.chords.length === 2 && !!e.kingPost && e.struts.length === 2,
    `chords ${e.chords.length} kp ${!!e.kingPost} struts ${e.struts.length}`);
  if (e.chords.length !== 2 || !e.kingPost) return;
  const [cL, cR] = e.chords.slice().sort((a, b) => a.ctr[0] - b.ctr[0]);
  const kp = e.kingPost;
  // Chords meet at the apex: the two vertices of each that stand off the beam coincide with the other's.
  const apexOf = (c) => c.poly.filter((q) => q[1] > top + 0.05);
  const aL = apexOf(cL), aR = apexOf(cR);
  const apexGap = aL.length === 2 && aR.length === 2 ? Math.max(...aL.map((q) => Math.min(...aR.map((r) => Math.hypot(q[0] - r[0], q[1] - r[1]))))) : Infinity;
  ok(`[${tag}] joint: the chords meet at the apex (plumb cut, gap <= ${GAP})`, apexGap <= GAP, `gap ${f3(apexGap)}`);
  for (const [c, nm] of [[cL, "left"], [cR, "right"]]) {
    const feet = c.poly.filter((q) => q[1] <= top + 0.05);
    ok(`[${tag}] joint: the ${nm} chord's foot sits on the beam (level cut, on the beam)`, feet.length === 2 && feet.every((q) => Math.abs(q[1] - top) <= GAP && q[0] >= beam.min[0] - GAP && q[0] <= beam.max[0] + GAP),
      feet.map((q) => `(${f3(q[0])}, ${f3(q[1])})`).join(" "));
  }
  // The king post: its foot on the beam, every top vertex on a chord's underside.
  const kpFoot = kp.poly.filter((q) => q[1] <= top + 0.05), kpTop = kp.poly.filter((q) => q[1] > top + 0.05);
  ok(`[${tag}] joint: the king post's foot sits on the beam`, kpFoot.length === 2 && kpFoot.every((q) => Math.abs(q[1] - top) <= GAP), kpFoot.map((q) => f3(q[1])).join(" "));
  const kpGap = Math.max(...kpTop.map((q) => Math.min(edgeDist(q, cL.poly), edgeDist(q, cR.poly))));
  ok(`[${tag}] joint: the king post's top meets both chords (cut to both slopes, gap <= ${GAP})`, kpTop.length >= 2 && kpGap <= GAP
    && kpTop.some((q) => edgeDist(q, cL.poly) <= GAP) && kpTop.some((q) => edgeDist(q, cR.poly) <= GAP), `${kpTop.length} top vertices, worst ${f3(kpGap)}`);
  const kpXs = kp.poly.map((q) => q[0]), kpL = Math.min(...kpXs), kpR = Math.max(...kpXs);
  for (const st of e.struts) {
    const s = Math.sign(st.ctr[0] - (kpL + kpR) / 2), nm = s > 0 ? "right" : "left", ch = s > 0 ? cR : cL;
    const side = s > 0 ? kpR : kpL;
    const pts = st.poly.slice();
    const tops = pts.slice().sort((a, b) => b[1] - a[1]).slice(0, 2);
    const topGap = Math.max(...tops.map((q) => edgeDist(q, ch.poly)));
    ok(`[${tag}] joint: the ${nm} strut's top meets its chord (cut to the chord's slope, gap <= ${GAP})`, topGap <= GAP, `worst ${f3(topGap)}`);
    const feet = pts.filter((q) => q[1] <= top + 0.05);
    ok(`[${tag}] joint: the ${nm} strut's foot sits on the beam (level cut)`, feet.length === 2 && feet.every((q) => Math.abs(q[1] - top) <= GAP), feet.map((q) => `(${f3(q[0])}, ${f3(q[1])})`).join(" "));
    const inner = pts.filter((q) => Math.abs(q[0] - side) <= 0.05);
    ok(`[${tag}] joint: the ${nm} strut's inner end stands plumb against the king post (gap <= ${GAP})`,
      inner.length === 2 && inner.every((q) => Math.abs(q[0] - side) <= GAP && edgeDist(q, kp.poly) <= GAP), inner.map((q) => `(${f3(q[0])}, ${f3(q[1])})`).join(" "));
    // At 50 degrees, as the rule always was.
    // Its lower edge: from the foot's outer corner on the beam to the outermost top corner.
    const footOut = feet.slice().sort((a, b) => s * (b[0] - a[0]))[0];
    const topOut = tops.slice().sort((a, b) => s * (b[0] - a[0]))[0];
    const ang = footOut && topOut ? Math.atan2(topOut[1] - footOut[1], s * (topOut[0] - footOut[0])) * 180 / Math.PI : NaN;
    ok(`[${tag}] the ${nm} strut rises at 50 degrees`, Math.abs(ang - 50) < 0.5, `${f3(ang)} deg`);
  }
  // NO OVERLAPS: no vertex of one member is inside another by more than GAP (the beam a rectangle).
  const polys = [["beam", rectOf(beam)], ["chord L", cL.poly], ["chord R", cR.poly], ["king post", kp.poly], ...e.struts.map((m, k) => [`strut ${k}`, m.poly])];
  const clashes = [];
  polys.forEach(([na, pa], i) => polys.forEach(([nb, pb], j) => {
    if (i === j) return;
    pa.forEach((q) => { const d = depthIn(q, pb); if (d > GAP) clashes.push(`${na} vertex (${f3(q[0])}, ${f3(q[1])}) ${f3(d)} inside ${nb}`); });
  }));
  ok(`[${tag}] frame: no member overlaps another`, clashes.length === 0, clashes.slice(0, 3).join("; "));
}

const zr = (m) => `${m.back.toFixed(3)}..${m.front.toFixed(3)}`;
function printEnd(tag, e, H) {
  const lines = [`  ${tag}: cap face out ${e.cap ? e.cap.face.toFixed(3) : "?"}`];
  if (e.header) lines.push(`    header      y ${e.header.min[1].toFixed(3)}..${e.header.max[1].toFixed(3)} (H+${(e.header.max[1] - H).toFixed(3)} top)  out ${zr(e.header)}`);
  e.louvre.forEach((m) => lines.push(`    vent louvre ${m.size[0].toFixed(2)}x${m.size[1].toFixed(2)} centre y ${m.ctr[1].toFixed(3)}  out ${zr(m)}`));
  e.vTrim.forEach((m) => lines.push(`    vent trim   ${m.box.join("x")} y ${m.min[1].toFixed(3)}..${m.max[1].toFixed(3)} (H+${(m.min[1] - H).toFixed(3)})  out ${zr(m)}`));
  e.posts.forEach((m) => lines.push(`    post        ${m.size.join("x")} y ${m.min[1].toFixed(3)}..${m.max[1].toFixed(3)}  x ${m.min[0].toFixed(2)}..${m.max[0].toFixed(2)}  out ${zr(m)}`));
  e.truss.forEach((m) => lines.push(`    truss ${m.tag.padEnd(8)} y ${m.min[1].toFixed(3)}..${m.max[1].toFixed(3)}  x ${m.min[0].toFixed(2)}..${m.max[0].toFixed(2)}  out ${zr(m)}  outline ${(m.poly || []).map((q) => `(${q[0].toFixed(3)},${q[1].toFixed(3)})`).join(" ")}`));
  if (e.strips.length) lines.push(`    gable strips x${e.strips.length}  out ${zr(e.strips[0])}`);
  e.boardsOnHeader.forEach((m) => lines.push(`    ⚠ board on header ${m.box.join("x")} y ${m.min[1].toFixed(3)}..${m.max[1].toFixed(3)} x ${m.min[0].toFixed(2)}..${m.max[0].toFixed(2)}`));
  console.log(lines.join("\n"));
}

// ONE UPRIGHT AT EACH PORCH CORNER (2026-10-07): the posts stand where the footprint corner boards stood, a corner
// board at each inside corner, and a side beam from each post back to that board, at the beam's height.
export function porchCornerChecks(ok, tag, meshes, e, H, depth) {
  const roof = meshes.filter((m) => m.group === "roof" && m.geom === "BoxGeometry");
  const uprights = roof.filter((m) => m.size[1] > H * 0.8 && m.size[0] < 0.8 && m.size[2] < 0.8 && Math.abs(m.ctr[0]) > W / 2 - 0.8 && m.ctr[2] > L / 2 - 1);
  for (const s of [-1, 1]) {
    const here = uprights.filter((m) => Math.sign(m.ctr[0]) === s);
    ok(`[${tag}] corner: ONE upright at the ${s > 0 ? "right" : "left"} front corner, the porch post`, here.length === 1 && here[0].tag === "post",
      here.map((m) => `${m.tag || m.color} x ${f3(m.min[0])}..${f3(m.max[0])} z ${f3(m.min[2])}..${f3(m.max[2])}`).join("; "));
  }
  const inside = roof.filter((m) => m.corner === "inside");
  ok(`[${tag}] corner: a corner board at each inside corner, where the set-back wall meets the side wall`,
    inside.length === 2 && inside.every((m) => Math.abs(Math.abs(m.ctr[0]) - W / 2) < 0.01 && Math.abs(m.ctr[2] - (L / 2 - depth)) < 0.01 && Math.abs(m.max[1] - H) < 0.01),
    inside.map((m) => `x ${f3(m.ctr[0])} z ${f3(m.ctr[2])} top ${f3(m.max[1])}`).join("; "));
  const sbs = meshes.filter((m) => m.tag === "sideBeam");
  const beam = e.header;
  ok(`[${tag}] side beams: one along each open side`, sbs.length === 2, `${sbs.length}`);
  if (!beam || sbs.length !== 2) return;
  for (const sb of sbs) {
    const s = Math.sign(sb.ctr[0]), post = e.posts.find((p) => Math.sign(p.ctr[0]) === s);
    const board = inside.find((m) => Math.sign(m.ctr[0]) === s);
    ok(`[${tag}] side beam ${s > 0 ? "right" : "left"}: from the frame's back face to the inside corner board, at the beam's height, flush with the post`,
      Math.abs(sb.max[2] - beam.min[2]) <= 0.01 && !!board && Math.abs(sb.min[2] - board.max[2]) <= 0.01
        && Math.abs(sb.max[1] - beam.max[1]) <= 0.01 && Math.abs(sb.min[1] - beam.min[1]) <= 0.01
        && !!post && Math.abs((s > 0 ? sb.max[0] - post.max[0] : sb.min[0] - post.min[0])) <= 0.01,
      `z ${f3(sb.min[2])}..${f3(sb.max[2])} (board front ${board && f3(board.max[2])}, frame back ${f3(beam.min[2])}) y ${f3(sb.min[1])}..${f3(sb.max[1])}`);
  }
}

// THE OPEN PORCH GABLE (roof.porchGable "open", 2026-10-07): no cap over the porch, the cap with its siding and
// vent on the set-back wall, the boarded ceiling from the frame back to it, the deck and the timber in wood.
export function openGableChecks(ok, tag, meshes, e, sb, H, depth) {
  ok(`[${tag}] open: no siding over the porch, the cap stands on the set-back wall`, !!e.cap && Math.abs(e.cap.face - (0.15 - depth)) <= 0.011, `cap face out ${e.cap && f3(e.cap.face)}`);
  ok(`[${tag}] open: the style's vent moved to the set-back gable`, sb.louvre.length === 1 && e.louvre.length === 0, `set-back ${sb.louvre.length}, porch end ${e.louvre.length}`);
  const ceil = meshes.filter((m) => m.tag === "ceiling");
  const beam = e.header;
  ok(`[${tag}] open: a boarded ceiling under both slopes`, ceil.length >= 20 && ceil.some((m) => m.ctr[0] < 0) && ceil.some((m) => m.ctr[0] > 0), `${ceil.length} boards`);
  if (ceil.length && beam) {
    const z0 = Math.min(...ceil.map((m) => m.min[2])), z1 = Math.max(...ceil.map((m) => m.max[2]));
    ok(`[${tag}] open: the ceiling runs from the set-back gable to the frame's back face`, Math.abs(z0 - (L / 2 - depth + 0.15)) <= 0.011 && Math.abs(z1 - beam.min[2]) <= 0.011, `z ${f3(z0)}..${f3(z1)}`);
    ok(`[${tag}] open: the ceiling is pine`, ceil.every((m) => m.color === "#c98b4f"), ceil[0].color);
  }
  const frame = meshes.filter((m) => ["post", "beam", "sideBeam", "chord", "kingPost", "strut"].includes(m.tag));
  ok(`[${tag}] open: every frame member takes the wood colour`, frame.length >= 9 && frame.every((m) => m.color === WOOD), [...new Set(frame.map((m) => m.color))].join(" "));
  const deck = meshes.filter((m) => m.tag === "deck");
  ok(`[${tag}] open: the porch floor is decking in the wood colour, set-back wall to the slab's edge`, deck.length > 5 && deck.every((m) => m.color === WOOD)
    && Math.abs(Math.min(...deck.map((m) => m.min[2])) - (L / 2 - depth + 0.15)) <= 0.05 && Math.abs(Math.max(...deck.map((m) => m.max[2])) - (L / 2 + 0.1)) <= 0.05,
    `${deck.length} boards z ${deck.length ? f3(Math.min(...deck.map((m) => m.min[2]))) : "?"}..${deck.length ? f3(Math.max(...deck.map((m) => m.max[2]))) : "?"}`);
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

    const open = styleLabel === "Open Porch Cabin";
    const DEPTH = (config.buildingStyles.find((s) => s.label === styleLabel) || {}).d3?.roof?.porchDepthFt || 6;
    // An open porch gable's cap, and the style vent with it, stand on the set-back wall (2026-10-07).
    const setBack = open ? classifyEnd(meshes, 1, H, L / 2 - DEPTH) : null;
    if (open) printEnd("set-back wall (open porch gable)", setBack, H);
    if (porch) {
      frameChecks(ok, tag, front, H, W, { truss: true });
      porchCornerChecks(ok, tag, meshes, front, H, DEPTH);
      if (open) openGableChecks(ok, tag, meshes, front, setBack, H, DEPTH);
    }
    for (const [name, e] of (open ? [["set-back", setBack], ["back", back]] : [["front", front], ["back", back]])) {
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
  const labelOf = (k) => (k === "porch" ? "Porch Cabin" : k === "plain" ? "Gable Cabin" : k === "open" ? "Open Porch Cabin" : k);
  const spec = process.env.SS_VARIANTS
    || (process.env.SS_CONFIG_FILE ? (process.env.SS_STYLES || "Cabin") + ":"
      : "porch:panel,porch:batten,porch:lap,open:batten,open:panel,plain:panel,plain:batten,plain:lap");
  const results = [];
  for (const v of spec.split(",")) {
    const [st, clad] = v.split(":");
    const cfg = st === "open" && !process.env.SS_CONFIG_FILE ? CONFIG_OPEN : config;
    const tag = `${st.toLowerCase().replace(/\W+/g, "-")}-${clad || "default"}`;
    results.push(await probeVariant({ ok, shots, config: cfg, fixtures, styleLabel: labelOf(st), cladding: clad || null, tag, H, wallVent: !!process.env.PROBE_WALL_VENT }));
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
