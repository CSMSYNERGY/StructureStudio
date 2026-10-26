// What tests/harness/doorLooks.mjs and doorLookSpecs.mjs both read off a door in the compiled designer's 3D:
// every mesh of a door's opening group (doorMeshes, its digest and its parts), and block N's rays (N_PAGE).
// Moved here unchanged from doorLooks.mjs (door looks P2, 2026-10-27) so the look harness fires the same rays.
import { createHash } from "node:crypto";

// Every mesh of one door's opening group: what it is, where, and in what.
export async function doorMeshes(page, itemId) {
  return page.evaluate((id) => {
    const E = window.__ss3dEngine;
    E.scene.updateMatrixWorld(true);
    const og = E.model.openingsGroup.children.find((g) => g.userData && g.userData.itemId === id);
    if (!og) return null;
    const r4 = (v) => Math.round(v * 10000) / 10000;
    const wallMap = E.model.wallMat && E.model.wallMat.map ? E.model.wallMat.map.uuid : null;
    const out = [];
    og.traverse((o) => {
      if (!o.isMesh || !o.geometry) return;
      const m = Array.isArray(o.material) ? o.material[0] : o.material;
      const p = o.geometry.parameters || {};
      o.geometry.computeBoundingBox();
      const bb = o.geometry.boundingBox.clone().applyMatrix4(o.matrixWorld);
      out.push({
        geom: o.geometry.type, box: p.width != null ? [r4(p.width), r4(p.height), r4(p.depth)] : null,
        pos: [r4(o.position.x), r4(o.position.y), r4(o.position.z)], rot: [r4(o.rotation.x), r4(o.rotation.y), r4(o.rotation.z)],
        mat: m ? m.type : null, color: m && m.color ? "#" + m.color.getHexString() : null,
        rough: m && m.roughness != null ? r4(m.roughness) : null, metal: m && m.metalness != null ? r4(m.metalness) : null,
        transparent: !!(m && m.transparent), opacity: m && m.opacity != null ? r4(m.opacity) : null, map: !!(m && m.map), visible: o.visible,
        part: (o.userData && o.userData.ssDoorPart) || null, wallMap: !!(m && m.map && m.map.uuid === wallMap),
        min: [r4(bb.min.x), r4(bb.min.y), r4(bb.min.z)], max: [r4(bb.max.x), r4(bb.max.y), r4(bb.max.z)],
      });
    });
    return out;
  }, itemId);
}
export const digestOf = (meshes) => createHash("sha256")
  .update(JSON.stringify(meshes.map(({ part: _p, min: _a, max: _b, wallMap: _w, gap: _g, ...m }) => m))).digest("hex").slice(0, 16);
export const countParts = (meshes) => meshes.reduce((o, m) => { if (m.part) o[m.part] = (o[m.part] || 0) + 1; return o; }, {});
export const sameCounts = (a, b) => JSON.stringify(Object.keys(a).sort().map((k) => [k, a[k]])) === JSON.stringify(Object.keys(b).sort().map((k) => [k, b[k]]));

// The page side of N: find the door's group (an outside wall's by itemId, a partition's by where it
// stands), its opening off the casing, then fire the rays. Also every mesh as doorMeshes describes it,
// for the digest, and the closures' measurements for N2-N4.
export const N_PAGE = ({ sel, yaws, reach }) => {
  const E = window.__ss3dEngine;
  E.scene.updateMatrixWorld(true);
  const V = E.camera.position.constructor;
  const wbox = (o) => {
    if (!o.geometry.boundingBox) o.geometry.computeBoundingBox();
    const b = o.geometry.boundingBox, mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
    for (let k = 0; k < 8; k++) {
      const v = new V(k & 1 ? b.max.x : b.min.x, k & 2 ? b.max.y : b.min.y, k & 4 ? b.max.z : b.min.z).applyMatrix4(o.matrixWorld);
      [v.x, v.y, v.z].forEach((c, i) => { mn[i] = Math.min(mn[i], c); mx[i] = Math.max(mx[i], c); });
    }
    return { mn, mx, c: mn.map((v, i) => (v + mx[i]) / 2) };
  };
  const meshesOf = (g) => { const out = []; g.traverse((o) => { if (o.isMesh && o.geometry) out.push(o); }); return out; };
  let grp, trims;
  if (sel.itemId != null) {
    grp = E.model.openingsGroup.children.find((g) => g.userData && g.userData.itemId === sel.itemId);
    if (!grp) return { error: "no group for item " + sel.itemId };
    trims = grp.children.slice(0, 3);
  } else {
    const dgs = [];
    E.model.interiorGroup.traverse((o) => { if (o.userData && o.userData.ssPartitionOpening === "door") dgs.push(o); });
    const cOf = (g) => { const ms = meshesOf(g).map(wbox); const mn = [0, 2].map((i) => Math.min(...ms.map((b) => b.mn[i]))), mx = [0, 2].map((i) => Math.max(...ms.map((b) => b.mx[i]))); return [(mn[0] + mx[0]) / 2, (mn[1] + mx[1]) / 2]; };
    grp = dgs.find((g) => { const c = cOf(g); return Math.hypot(c[0] - sel.part[0], c[1] - sel.part[1]) < 0.5; });
    if (!grp) return { error: "no partition door at " + sel.part.join(",") };
    trims = meshesOf(grp.parent).filter((o) => o.userData && o.userData.ssPartitionTrim).filter((o) => {
      const c = wbox(o).c; return Math.hypot(c[0] - sel.part[0], c[2] - sel.part[1]) < sel.hw + 0.4;
    });
  }
  (window.__nGrps = window.__nGrps || {})[sel.key] = grp;   // N6 pictures it alone
  // The opening, off its casing: the two jambs (tall) and the head.
  const tb = trims.map((o) => ({ o, b: wbox(o) }));
  const jambs = tb.filter((t) => t.b.mx[1] - t.b.mn[1] > 2), head = tb.find((t) => t.b.mx[1] - t.b.mn[1] < 1);
  if (jambs.length !== 2 || !head) return { error: `casing not found (${jambs.length} jambs, head ${!!head})` };
  const c0 = new V(...jambs[0].b.c), c1 = new V(...jambs[1].b.c);
  const U = c1.clone().sub(c0); U.y = 0; const dist = U.length(); U.normalize();
  const N = new V(U.z, 0, -U.x);
  const P0 = c0.clone().add(c1).multiplyScalar(0.5);
  // The wall's outward side (outside walls: away from the building's centre, the origin).
  if (sel.itemId != null && N.x * P0.x + N.z * P0.z < 0) N.multiplyScalar(-1);
  // The door's own outward side: where its hardware stands (to 0.19 ft past the slab's centre, where its
  // back is 0.08). An outside wall's already is; a partition's is its side a.
  const isPhoto0 = (o) => { const m = Array.isArray(o.material) ? o.material[0] : o.material; return !!(m && m.isMeshBasicMaterial && m.map && m.alphaTest > 0); };
  const slab0 = meshesOf(grp).find((o) => o.geometry.parameters && Math.abs(o.geometry.parameters.depth - 0.16) < 1e-6 && !isPhoto0(o));
  if (sel.itemId == null && slab0) {
    const acr = (p) => (p[0] - P0.x) * N.x + (p[2] - P0.z) * N.z, sc = acr(wbox(slab0).c);
    let lo = Infinity, hi = -Infinity;
    meshesOf(grp).forEach((o) => { const b = wbox(o); [b.mn, b.mx].forEach((p) => { lo = Math.min(lo, acr(p) - sc); hi = Math.max(hi, acr(p) - sc); }); });
    if (-lo > hi) N.multiplyScalar(-1);
  }
  const fw = jambs[0].o.geometry.parameters.width;
  const a0 = -dist / 2 + fw / 2, a1 = dist / 2 - fw / 2;
  const y0 = Math.min(jambs[0].b.mn[1], jambs[1].b.mn[1]), y1 = head.b.mn[1];
  const along = (p) => (p[0] - P0.x) * U.x + (p[2] - P0.z) * U.z, across = (p) => (p[0] - P0.x) * N.x + (p[2] - P0.z) * N.z;
  // The blockers: every visible CLOSED BOX of the door and its casing that stands square to the wall, less
  // the photo layer (its cut-out areas are clear) and the room behind a door's glass. A box turned in the
  // wall's plane (a brace) or a mesh of another shape (nonBox) is left out: it could only add cover, so
  // leaving it out can fail a door, never pass one, and it keeps N1's cells exact.
  const visible = (o) => { for (let n = o; n; n = n.parent) if (n.visible === false) return false; return true; };
  const isPhoto = (o) => { const m = Array.isArray(o.material) ? o.material[0] : o.material; return !!(m && m.isMeshBasicMaterial && m.map && m.alphaTest > 0); };
  const pool = [...new Set([...meshesOf(grp), ...trims])];
  const nonBox = [...new Set(pool.filter((o) => o.geometry.type !== "BoxGeometry").map((o) => o.geometry.type))];
  const unit = (v) => { const l = Math.hypot(v[0], v[1], v[2]); return v.map((c) => c / l); };
  const wallAxes = [[U.x, 0, U.z], [0, 1, 0], [N.x, 0, N.z]];
  const square = (o) => {
    const e = o.matrixWorld.elements;
    return [[e[0], e[1], e[2]], [e[4], e[5], e[6]], [e[8], e[9], e[10]]].map(unit)
      .every((ax) => wallAxes.some((w) => Math.abs(Math.abs(ax[0] * w[0] + ax[1] * w[1] + ax[2] * w[2]) - 1) < 1e-6));
  };
  const blockers = pool.filter((o) => visible(o) && !(o.userData && o.userData.ssGlassRoom) && !isPhoto(o) && o.geometry.type === "BoxGeometry" && square(o)).map((o) => {
    if (!o.geometry.boundingBox) o.geometry.computeBoundingBox();
    const b = o.geometry.boundingBox, inv = o.matrixWorld.clone().invert().elements, as = [], ys = [], ns = [];
    for (let k = 0; k < 8; k++) {
      const v = new V(k & 1 ? b.max.x : b.min.x, k & 2 ? b.max.y : b.min.y, k & 4 ? b.max.z : b.min.z).applyMatrix4(o.matrixWorld), p = [v.x, v.y, v.z];
      as.push(along(p)); ys.push(v.y); ns.push(across(p));
    }
    return { e: inv, mn: [b.min.x, b.min.y, b.min.z], mx: [b.max.x, b.max.y, b.max.z], vol: (b.max.x - b.min.x) * (b.max.y - b.min.y) * (b.max.z - b.min.z),
      a: [Math.min(...as), Math.max(...as)], y: [Math.min(...ys), Math.max(...ys)], n: [Math.min(...ns), Math.max(...ns)] };
  }).sort((p, q) => q.vol - p.vol);
  const tf = (e, x, y, z) => [e[0] * x + e[4] * y + e[8] * z + e[12], e[1] * x + e[5] * y + e[9] * z + e[13], e[2] * x + e[6] * y + e[10] * z + e[14]];
  const segHits = (p, q) => {
    for (const k of blockers) {
      const lp = tf(k.e, p[0], p[1], p[2]), lq = tf(k.e, q[0], q[1], q[2]);
      let t0 = 0, t1 = 1, hit = true;
      for (let i = 0; i < 3 && hit; i++) {
        const d = lq[i] - lp[i];
        if (Math.abs(d) < 1e-12) { if (lp[i] < k.mn[i] || lp[i] > k.mx[i]) hit = false; continue; }
        let ta = (k.mn[i] - lp[i]) / d, tb2 = (k.mx[i] - lp[i]) / d;
        if (ta > tb2) { const t = ta; ta = tb2; tb2 = t; }
        t0 = Math.max(t0, ta); t1 = Math.min(t1, tb2);
        if (t0 > t1) hit = false;
      }
      if (hit) return true;
    }
    return false;
  };
  // N1, EXACTLY, at each yaw (0 is square on; the others are turned about the vertical, the way a customer
  // orbits). A level line at yaw th that crosses the wall line `a` along runs through a blocker exactly
  // when `a` lies in [a_lo + min(n tan th), a_hi + max(n tan th)] (n over the box's depth, across the wall)
  // and its height in the box's: the box's SHADOW on the wall line at that yaw, itself a rectangle. Cut the
  // opening at every shadow's edges and each cell between the cuts lies wholly inside some shadow or wholly
  // outside all of them, so ONE ray through each cell's middle answers for every line through that cell:
  // no grid to step over a gap however thin, and no part of a gap a closure leaves open goes untested.
  // Each ray is also held to the shadow it should be in (`incons` must stay 0), which checks this sum.
  // Every other line through the wall runs into the wall, so these are all the lines there are; a line is
  // the same line whichever face it is fired from, and a closed box hides what is behind it from either
  // side, so one pass per yaw is both faces (and both rooms of a partition) at once. (This replaced a
  // 40 x 60 grid fired from both faces: each of its lines was fired twice, and it sampled each gap at one
  // column or row, so a closure that left part of a gap open still passed.)
  const region = (a, y) => (a - a0 < 0.06 || a1 - a < 0.06 ? "jamb" : y1 - y < 0.06 ? "head" : y - y0 < 0.06 ? "floor" : Math.abs(a - (a0 + a1) / 2) < 0.04 ? "centre" : "field");
  const cuts = (vals, lo, hi) => [...new Set([lo, hi, ...vals.filter((x) => x > lo && x < hi)].map((x) => Math.round(x * 1e6) / 1e6))].sort((p, q) => p - q);
  let total = 0, misses = 0, open0 = 0, incons = 0;
  const byRegion = {}, byView = {}, sample = [];
  for (const deg of yaws) {
    const th = (deg * Math.PI) / 180, tn = Math.tan(th), dx = -N.x * Math.cos(th) + U.x * Math.sin(th), dz = -N.z * Math.cos(th) + U.z * Math.sin(th);
    const shadows = blockers.map((k) => ({ a: [k.a[0] + Math.min(k.n[0] * tn, k.n[1] * tn), k.a[1] + Math.max(k.n[0] * tn, k.n[1] * tn)], y: k.y }));
    const As = cuts(shadows.flatMap((s) => s.a), a0, a1), Ys = cuts(shadows.flatMap((s) => s.y), y0, y1);
    for (let i = 0; i + 1 < As.length; i++) for (let j = 0; j + 1 < Ys.length; j++) {
      const da = As[i + 1] - As[i], dy = Ys[j + 1] - Ys[j];
      if (da < 1e-6 || dy < 1e-6) continue;
      const a = (As[i] + As[i + 1]) / 2, y = (Ys[j] + Ys[j + 1]) / 2, P = [P0.x + U.x * a, y, P0.z + U.z * a];
      total++;
      const hit = segHits([P[0] - dx * reach, y, P[2] - dz * reach], [P[0] + dx * reach, y, P[2] + dz * reach]);
      if (hit !== shadows.some((s) => a >= s.a[0] && a <= s.a[1] && y >= s.y[0] && y <= s.y[1])) incons++;
      if (hit) continue;
      misses++;
      if (deg === 0) open0 += da * dy;
      const r = region(a, y), v = `${deg}deg`;
      byRegion[r] = (byRegion[r] || 0) + 1; byView[v] = (byView[v] || 0) + 1;
      if (sample.length < 4) sample.push(`${r}@a${(As[i] - a0).toFixed(3)}..${(As[i + 1] - a0).toFixed(3)},y${(Ys[j] - y0).toFixed(3)}..${(Ys[j + 1] - y0).toFixed(3)},${v}`);
    }
  }
  // The closures, measured: across the wall from the leaf slab's own centre, and along / up against the
  // opening; and whether any sits in the room behind a door's glass.
  const leafSlab = meshesOf(grp).find((o) => o.geometry.parameters && Math.abs(o.geometry.parameters.depth - 0.16) < 1e-6 && !isPhoto(o));
  const slabC = leafSlab ? across(wbox(leafSlab).c) : 0;
  const rooms = meshesOf(grp).filter((o) => o.userData && o.userData.ssDoorPart === "windowInterior").map(wbox);
  const gaps = meshesOf(grp).filter((o) => o.userData && o.userData.ssDoorGap).map((o) => {
    const b = wbox(o), xs = [], ns = [];
    for (let k = 0; k < 8; k++) { const p = [k & 1 ? b.mx[0] : b.mn[0], 0, k & 4 ? b.mx[2] : b.mn[2]]; xs.push(along(p)); ns.push(across(p) - slabC); }
    const inRoom = rooms.some((r) => [0, 1, 2].every((i) => b.mn[i] < r.mx[i] - 1e-4 && b.mx[i] > r.mn[i] + 1e-4));
    return { kind: o.userData.ssDoorGap, color: "#" + o.material.color.getHexString(), a: [Math.min(...xs), Math.max(...xs)], y: [b.mn[1], b.mx[1]], n: [Math.min(...ns), Math.max(...ns)], inRoom };
  });
  // The leaf's own colour: the slab's.
  const slabColor = leafSlab ? "#" + leafSlab.material.color.getHexString() : null;
  // The stiles' colour, which the astragal wears darkened: a built look's frame (ssDoorPart "frame"); every
  // other door here frames itself in its own colour (no trim colour of its own), the slab's.
  const framePart = meshesOf(grp).find((o) => o.userData && o.userData.ssDoorPart === "frame");
  const frameColor = framePart ? "#" + framePart.material.color.getHexString() : slabColor;
  // Every mesh as doorMeshes() describes it (its digest).
  const r4 = (v) => Math.round(v * 10000) / 10000;
  const wallMap = E.model.wallMat && E.model.wallMat.map ? E.model.wallMat.map.uuid : null;
  const meshes = meshesOf(grp).map((o) => {
    const m = Array.isArray(o.material) ? o.material[0] : o.material, p = o.geometry.parameters || {};
    return { geom: o.geometry.type, box: p.width != null ? [r4(p.width), r4(p.height), r4(p.depth)] : null,
      pos: [r4(o.position.x), r4(o.position.y), r4(o.position.z)], rot: [r4(o.rotation.x), r4(o.rotation.y), r4(o.rotation.z)],
      mat: m ? m.type : null, color: m && m.color ? "#" + m.color.getHexString() : null,
      rough: m && m.roughness != null ? r4(m.roughness) : null, metal: m && m.metalness != null ? r4(m.metalness) : null,
      transparent: !!(m && m.transparent), opacity: m && m.opacity != null ? r4(m.opacity) : null, map: !!(m && m.map), visible: o.visible,
      part: (o.userData && o.userData.ssDoorPart) || null, wallMap: !!(m && m.map && m.map.uuid === wallMap),
      gap: !!(o.userData && o.userData.ssDoorGap) };
  });
  return { total, misses, open0, incons, byRegion, byView, sample, nonBox, gaps, slabColor, frameColor, rooms: rooms.length, meshes,
    frame: { P0: [P0.x, P0.y, P0.z], U: [U.x, U.z], N: [N.x, N.z], a0, a1, y0, y1, fw } };
};
