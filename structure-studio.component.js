// structure-studio.component.js — the ONE shared designer module, loaded by BOTH
// index.html and portal.html via <script src=... type="text/babel">. Hand-mirrored
// twin of StructureStudio.jsx (the ES-module canon) in the babel/global-destructure
// dialect — every body/wrapper edit lands in BOTH files (see CLAUDE.md).
// Self-contained on purpose: Babel compiles each text/babel block independently, so
// nothing here leans on the host page's consts; the page mounts alias the globals
// published at the bottom. No createRoot here — mounting is the host page's job.
const {useState,useRef,useCallback,useEffect,useMemo,Component}=React;
const { createPortal } = ReactDOM;

// Password input with a show/hide (eye) toggle. Forwards all input props; `wrapStyle`
// carries any flex/grid sizing onto the positioned wrapper so layouts are preserved.
function PasswordInput({ style, wrapStyle, ...rest }) {
  const [show, setShow] = useState(false);
  return (
    <div style={{ position: "relative", width: "100%", boxSizing: "border-box", ...wrapStyle }}>
      <input {...rest} type={show ? "text" : "password"} style={{ ...style, width: "100%", boxSizing: "border-box", paddingRight: 38 }} />
      <button type="button" tabIndex={-1} aria-label={show ? "Hide password" : "Show password"} title={show ? "Hide password" : "Show password"} onMouseDown={(e) => e.preventDefault()} onClick={() => setShow((v) => !v)} style={{ position: "absolute", top: 0, right: 0, height: "100%", width: 34, display: "flex", alignItems: "center", justifyContent: "center", background: "transparent", border: "none", padding: 0, margin: 0, cursor: "pointer", color: "#64748B" }}>
        {show ? (
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M9.88 9.88a3 3 0 1 0 4.24 4.24" /><path d="M10.73 5.08A10.43 10.43 0 0 1 12 5c7 0 10 7 10 7a13.16 13.16 0 0 1-1.67 2.68" /><path d="M6.61 6.61A13.526 13.526 0 0 0 2 12s3 7 10 7a9.74 9.74 0 0 0 5.39-1.61" /><line x1="2" x2="22" y1="2" y2="22" /></svg>
        ) : (
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z" /><circle cx="12" cy="12" r="3" /></svg>
        )}
      </button>
    </div>
  );
}
const { createClient } = window.supabase;

// ─── Supabase project ───
// Single shared project across all white-label tenants. The anon key is browser-safe
// (RLS + capability RPCs); the service-role key never leaves the Edge Functions.
const SUPABASE_URL = "https://jzeamjbhdrsbygdnphbm.supabase.co";
const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imp6ZWFtamJoZHJzYnlnZG5waGJtIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzczNDIwNDMsImV4cCI6MjA5MjkxODA0M30.YawJS7aiyTbQdwVnzndyKwD2ejNGYhdBSiectURvxwY";

// Address-autocomplete key used when a tenant's config row doesn't carry its own
// googleMapsApiKey.
const DEFAULT_GOOGLE_MAPS_API_KEY = "AIzaSyDEKe7mODI2xKnUQ5-z7L0ZZnUfBgE6dok";

// ─── Default tenant ───
// When neither ?client= nor a tenant subdomain nor a design owner resolves a
// client, the loader fetches this client's config from public.client_configs.
// There is no in-source config copy — the table row is the source of truth.
// To change Junior Barns, edit the row, not this file.
const DEFAULT_CLIENT_ID = "junior-barns";

// ─── STRUCTURE STUDIO ENGINE ───
const WALL_THICKNESS = 6;

// Built-in annotation tools that are merged into ITEMS for every client.
// Distinct from `layoutItems` in config (which the client controls): these
// are universal drawing aids — a free-text note and a freeform line.
const BUILT_IN_TOOLS = {
  textNote: { label: "Note", color: "#0F172A", icon: "📝", shortLabel: "Note", noteType: true, width: 4, height: 1 },
  line: { label: "Line", color: "#475569", icon: "📏", shortLabel: "Line", lineType: true, width: 4, height: 0 },
};

// Legacy render safety-net. When a tenant HIDES a built-in option (deactivates it in
// client_layout_items so it drops out of get_config's layoutItems), its already-placed items on
// SAVED designs would otherwise lose their render config and vanish. This provides the standard
// built-in door/window/ramp definitions for RENDERING ONLY (noPalette → never a placeable tool),
// so old quotes keep drawing correctly forever. Spread FIRST in ITEMS so a tenant that still has
// the item ACTIVE overrides it with their own config (and it shows in the palette as normal); it
// only fills the gap for a HIDDEN item. Dimensions/colors mirror the layout_item_types master.
const LEGACY_LAYOUT_FALLBACK = {
  singleDoor: { label: "Single Door (36\")", icon: "🚪", color: "#D97706", width: 3, height: 0.5, shortLabel: "SD", wallOnly: true, noPalette: true },
  doubleDoor: { label: "Double Door (60\")", icon: "🚪🚪", color: "#B45309", width: 5, height: 0.5, shortLabel: "DD", wallOnly: true, noPalette: true },
  window: { label: "Window (24\")", icon: "🪟", color: "#0EA5E9", width: 2, height: 0.5, shortLabel: "W", wallOnly: true, noPalette: true },
  // NOTE: ramp is NOT here — it's fully self-contained now (SIMPLE_RAMP_CFG below), decoupled from
  // the built-in `ramp` layout item, so a tenant's ramp works whether or not that legacy row exists.
};

// Title-case a building-style name for display (designs store either the label
// "Farmland" or the lowercase key "cabin").
function capWords(s) { return String(s || "").replace(/\b\w/g, (c) => c.toUpperCase()); }

// Board-and-batten door glyph for the palette buttons (single + double), modeled on the
// real shed doors: cream frame, vertical planks, a mid cross-rail, black T-hinges, and a
// latch. Replaces the generic door emoji so the button reads as the actual product.
function DoorIcon({ double = false }) {
  const FRAME = "#ECE4D3", PANEL = "#B99A82", PLANK = "#8B7058", IRON = "#2C2A28";
  const leaf = (x, w, hingeLeft) => {
    const planks = [];
    for (let i = 1; i <= 3; i++) { const px = x + (w * i) / 4; planks.push(<line key={i} x1={px} y1={2.6} x2={px} y2={15.4} stroke={PLANK} strokeWidth={0.4} />); }
    const hx = hingeLeft ? x + 0.5 : x + w - 1.8;
    return (
      <g key={x}>
        <rect x={x} y={1} width={w} height={16} rx={0.5} fill={FRAME} stroke="#B5A98E" strokeWidth={0.7} />
        <rect x={x + 1.1} y={2.2} width={w - 2.2} height={13.6} fill={PANEL} />
        {planks}
        <rect x={x + 1.1} y={8.1} width={w - 2.2} height={1.2} fill={FRAME} />
        <rect x={hx} y={3.4} width={1.3} height={0.9} fill={IRON} />
        <rect x={hx} y={12.8} width={1.3} height={0.9} fill={IRON} />
      </g>
    );
  };
  if (double) {
    return (
      <svg width={18} height={16} viewBox="0 0 20 18" style={{ display: "block" }} aria-hidden="true">
        {leaf(0.5, 9, true)}
        {leaf(10.5, 9, false)}
        <rect x={9.2} y={8.3} width={1.6} height={0.9} fill={IRON} />
      </svg>
    );
  }
  return (
    <svg width={11} height={16} viewBox="0 0 12 18" style={{ display: "block" }} aria-hidden="true">
      {leaf(0.5, 11, true)}
      <rect x={9.4} y={8.2} width={1.4} height={0.9} fill={IRON} />
    </svg>
  );
}

// Closest point distance from (px,py) to the segment (x1,y1)-(x2,y2)
function _distToSeg(px, py, x1, y1, x2, y2) {
  const dx = x2 - x1, dy = y2 - y1;
  const lenSq = dx * dx + dy * dy;
  let t = lenSq ? ((px - x1) * dx + (py - y1) * dy) / lenSq : 0;
  t = Math.max(0, Math.min(1, t));
  const cx = x1 + t * dx, cy = y1 + t * dy;
  return Math.sqrt((px - cx) * (px - cx) + (py - cy) * (py - cy));
}

// Treat each wall as a line segment; pick the wall closest to the click.
// Returns null only when the click is too far from any wall to be reasonable.
function getWallFromClick(x, y, pW, pH, mgX, mgY) {
  const ix = x - mgX, iy = y - mgY, T = 80;
  const walls = [
    { wall: "north", d: _distToSeg(ix, iy, 0, 0, pW, 0) },
    { wall: "south", d: _distToSeg(ix, iy, 0, pH, pW, pH) },
    { wall: "west",  d: _distToSeg(ix, iy, 0, 0, 0, pH) },
    { wall: "east",  d: _distToSeg(ix, iy, pW, 0, pW, pH) },
  ];
  walls.sort((a, b) => a.d - b.d);
  return walls[0].d <= T ? walls[0].wall : null;
}

function snapToWall(wall, cx, cy, iW, iH, pW, pH, mgX, mgY) {
  const hw = iW / 2;
  switch (wall) {
    case "north": return { x: Math.max(mgX + hw, Math.min(cx, mgX + pW - hw)), y: mgY, rotation: 0, wall };
    case "south": return { x: Math.max(mgX + hw, Math.min(cx, mgX + pW - hw)), y: mgY + pH, rotation: 0, wall };
    case "west":  return { x: mgX, y: Math.max(mgY + hw, Math.min(cy, mgY + pH - hw)), rotation: 90, wall };
    case "east":  return { x: mgX + pW, y: Math.max(mgY + hw, Math.min(cy, mgY + pH - hw)), rotation: 90, wall };
    default: return { x: cx, y: cy, rotation: 0, wall: null };
  }
}

function snapToWallInterior(wall, cx, cy, iW, iH, pW, pH, mgX, mgY) {
  switch (wall) {
    case "north": return { x: Math.max(mgX + iW / 2, Math.min(cx, mgX + pW - iW / 2)), y: mgY + iH / 2, rotation: 0, wall };
    case "south": return { x: Math.max(mgX + iW / 2, Math.min(cx, mgX + pW - iW / 2)), y: mgY + pH - iH / 2, rotation: 0, wall };
    case "west":  return { x: mgX + iH / 2, y: Math.max(mgY + iW / 2, Math.min(cy, mgY + pH - iW / 2)), rotation: 90, wall };
    case "east":  return { x: mgX + pW - iH / 2, y: Math.max(mgY + iW / 2, Math.min(cy, mgY + pH - iW / 2)), rotation: 90, wall };
    default: return { x: cx, y: cy, rotation: 0, wall: null };
  }
}

// Always returns a wall — used as a fallback when the click is ambiguous or far
// from the plan. Uses segment distance so corner clicks resolve to the closer side.
function getNearestWall(x, y, pW, pH, mgX, mgY) {
  const ix = x - mgX, iy = y - mgY;
  const walls = [
    { wall: "north", d: _distToSeg(ix, iy, 0, 0, pW, 0) },
    { wall: "south", d: _distToSeg(ix, iy, 0, pH, pW, pH) },
    { wall: "west",  d: _distToSeg(ix, iy, 0, 0, 0, pH) },
    { wall: "east",  d: _distToSeg(ix, iy, pW, 0, pW, pH) },
  ];
  walls.sort((a, b) => a.d - b.d);
  return walls[0].wall;
}

function checkDoorCollision(ni, nc, existing, itemTypes, sc) {
  if (!ni.wall) return false;
  const niw = (ni.widthFt || nc.width) * sc;
  for (const it of existing) {
    const c = itemTypes[it.type];
    if (!c || !c.wallOnly || it.type === "window") continue;
    // Only check doors on the same wall
    if (it.wall !== ni.wall) continue;
    const iw = (it.widthFt || c.width) * sc;
    // Check overlap along the wall axis
    if (ni.wall === "north" || ni.wall === "south") {
      if (Math.abs(ni.x - it.x) < (niw / 2) + (iw / 2) + 4) return true;
    } else {
      if (Math.abs(ni.y - it.y) < (niw / 2) + (iw / 2) + 4) return true;
    }
  }
  return false;
}

// Does a wall-mounted item (door / window / rough opening) at `sn` overlap a WORKBENCH on the
// same wall? checkDoorCollision above deliberately only compares wallOnly items to each other, and
// a workbench is wallSnap, so it is skipped there — which meant the invariant was enforced in one
// direction only: dragging a workbench into a door showed "A door is blocking this wall!", while
// dragging the DOOR onto the workbench silently succeeded and produced exactly the layout that
// toast exists to prevent, rasterized into the PDF and sent to the shop. Same math as the
// workbench-side check, read from the other side.
function checkWorkbenchOverlap(sn, widthFtPx, existing, itemTypes, sc) {
  if (!sn.wall) return false;
  const isH = sn.wall === "north" || sn.wall === "south";
  const candPos = isH ? sn.x : sn.y;
  const candHalf = widthFtPx / 2;
  for (const ob of existing) {
    if (ob.type !== "workbench" || ob.wall !== sn.wall) continue;
    const obHalf = ((ob.widthFt || (itemTypes[ob.type] && itemTypes[ob.type].width)) * sc) / 2;
    const obPos = isH ? ob.x : ob.y;
    if (Math.abs(candPos - obPos) < candHalf + obHalf - 2) return true;
  }
  return false;
}

function parseSize(s) {
  if (!s) return null;
  const m = s.match(/(\d+)\s*[x×✕]\s*(\d+)/i); // accept Unicode ×/✕ size labels too, not just ASCII x — else the building silently stays at the default size (audit #F2)
  return m ? { w: parseInt(m[1]), h: parseInt(m[2]) } : null;
}

// Check if a loft (edges in ft) has both ends of at least one axis attached to walls or other lofts
function checkLoftAttached(l, r, t, b, bldgW, bldgH, otherLoftEdges) {
  const tol = 0.3;
  const atWall = (val, wallVal) => Math.abs(val - wallVal) < tol;
  const touchesLoft = (edge, oKey, pMin, pMax, opMin, opMax) =>
    otherLoftEdges.some((o) => Math.abs(edge - o[oKey]) < tol && pMin < o[opMax] - tol && pMax > o[opMin] + tol);

  const leftOk = atWall(l, 0) || touchesLoft(l, "r", t, b, "t", "b");
  const rightOk = atWall(r, bldgW) || touchesLoft(r, "l", t, b, "t", "b");
  if (leftOk && rightOk) return true;

  const topOk = atWall(t, 0) || touchesLoft(t, "b", l, r, "l", "r");
  const bottomOk = atWall(b, bldgH) || touchesLoft(b, "t", l, r, "l", "r");
  if (topOk && bottomOk) return true;

  return false;
}

// ─── Page geometry, as a pure function of the building size ───────────────────
// The component derives scale/mgX/mgY from bldgW/bldgH on every render. Reflowing
// a layout after a size change needs the SAME derivation for the OLD size, to turn
// stored page-pixels back into feet — so the formula lives here, called twice
// (old, new), instead of being inlined once in the render body.
const SS_PAGE = { W: 850, H: 1100, TEXT_AREA_H: 340, TOP_LABEL_PAD: 30, BOT_LABEL_PAD: 30, RAMP_SPACE_FT: 2 };
// Narrowest canvas ROW that can carry the plan and the docked 3D panel side by side:
// plan floor 560 + gap 12 + panel floor 320 + row padding 40 = 932, rounded to 960.
// Measured on the ROW, never on window.innerWidth: the portal sidebar is 240px and
// collapses to 68px at max-width:900px, so the designer host is ~661px at a 901px
// viewport but ~832px at 900px — a viewport threshold would switch the dock ON for
// the narrower layout and OFF for the wider one.
const SS_DOCK_MIN_ROW_W = 960;
// Settings -> Designer -> 3D docks the same panel beside a FORM, not beside a building plan,
// and a form needs less room to stay usable: the calibration grids are
// repeat(auto-fit, minmax(150px,1fr)) and still give two columns at ~390px, whereas the plan
// SVG has a real drawing to keep legible. 960 would refuse to dock on a 1280px window (the
// Settings row measures ~954 there), which is most of the laptops a style gets calibrated on.
const SS_DOCK_MIN_CAL_W = 760;
function pageGeom(bldgW, bldgH) {
  const visibleH = SS_PAGE.H - SS_PAGE.TEXT_AREA_H;
  const scale = Math.min(
    (SS_PAGE.W * 0.70) / bldgW,
    (visibleH * 0.70) / bldgH,
    (visibleH - SS_PAGE.TOP_LABEL_PAD - SS_PAGE.BOT_LABEL_PAD) / (bldgH + 2 * SS_PAGE.RAMP_SPACE_FT)
  );
  const pW = bldgW * scale, pH = bldgH * scale;
  return { scale, pW, pH, mgX: (SS_PAGE.W - pW) / 2, mgY: SS_PAGE.RAMP_SPACE_FT * scale + SS_PAGE.TOP_LABEL_PAD };
}

// Where a ramp sits for a given door position — the ramp is derived, never placed.
// Uses the ramp's OWN depth (heightFt) rather than the 2 ft default, so a catalog
// ramp with a longer run stays where it was drawn.
function rampPosFor(rmp, sn, g) {
  const depthPx = ((rmp && rmp.heightFt) || SS_PAGE.RAMP_SPACE_FT) * g.scale;
  if (sn.wall === "north") return { x: sn.x, y: g.mgY - depthPx / 2, rotation: 0, wall: "north" };
  if (sn.wall === "south") return { x: sn.x, y: g.mgY + g.pH + depthPx / 2, rotation: 0, wall: "south" };
  if (sn.wall === "west") return { x: g.mgX - depthPx / 2, y: sn.y, rotation: 90, wall: "west" };
  if (sn.wall === "east") return { x: g.mgX + g.pW + depthPx / 2, y: sn.y, rotation: 90, wall: "east" };
  return null;
}

// Items the customer sizes themselves, so shrinking one to fit a smaller building
// preserves their intent. A DOOR is not in this list on purpose: a 6 ft double door
// quietly becoming 4 ft would change what they are buying.
const SS_SHRINKABLE = { workbench: true, roughOpening: true, loft: true };
const SS_WALL_ORDER = { north: ["south", "east", "west"], south: ["north", "east", "west"], east: ["west", "north", "south"], west: ["east", "north", "south"] };

/**
 * Move every placed item into the equivalent legal position for a new building size.
 *
 * PURE — returns { items, events } and mutates nothing, so the caller can inspect the
 * events and decide whether to commit. That is what makes "revert the size change when
 * something cannot be placed" possible without ever leaving a half-reflowed layout.
 *
 * events: { id, type, label, kind } where kind is "movedWall" | "resized" | "blocked".
 * Sliding along the SAME wall is deliberately not an event — it is what the customer
 * expects when a building grows or shrinks, and reporting it would bury the two things
 * they do need to know.
 */
function reflowItems(items, prev, next, ITEMS) {
  const A = pageGeom(prev.w, prev.h), B = pageGeom(next.w, next.h);
  const events = [];
  const byId = new Map();
  const placed = [];                       // already-reflowed items, for collision tests
  const labelOf = (it) => (ITEMS[it.type] && ITEMS[it.type].label) || it.type;

  // Try to seat a wall item at `wantFt` along `wall`, sliding to the nearest clear spot.
  // Returns the snap result, or null when the wall has no room.
  const seat = (it, cfg, wall, wantFt, wFt, hFt) => {
    const isH = wall === "north" || wall === "south";
    const wallLen = isH ? next.w : next.h;
    const half = wFt / 2;
    if (wFt > wallLen) return null;
    const lo = half, hi = wallLen - half;
    const start = Math.max(lo, Math.min(wantFt, hi));
    // Search outward from the wanted spot in 0.25 ft steps, nearest first.
    for (let d = 0; d <= (hi - lo) + 0.25; d += 0.25) {
      for (const c of (d === 0 ? [start] : [start - d, start + d])) {
        if (c < lo - 0.001 || c > hi + 0.001) continue;
        const px = (isH ? B.mgX : B.mgY) + c * B.scale;
        const sn = cfg.wallSnap
          ? snapToWallInterior(wall, isH ? px : B.mgX, isH ? B.mgY : px, wFt * B.scale, hFt * B.scale, B.pW, B.pH, B.mgX, B.mgY)
          : snapToWall(wall, isH ? px : B.mgX, isH ? B.mgY : px, wFt * B.scale, hFt * B.scale, B.pW, B.pH, B.mgX, B.mgY);
        const cand = { ...it, ...sn, widthFt: wFt, heightFt: hFt };
        if (checkDoorCollision(cand, { ...cfg, width: wFt }, placed, ITEMS, B.scale)) continue;
        if (checkWorkbenchOverlap(sn, wFt * B.scale, placed, ITEMS, B.scale)) continue;
        return sn;
      }
    }
    return null;
  };

  // ── Pass 1: everything except ramps (which are derived from their door) ──
  for (const it of items) {
    const cfg = ITEMS[it.type];
    // Annotations live in PAGE space, deliberately independent of the building —
    // moving them with the plan would be a regression, not a completion.
    if (!cfg || cfg.lineType || it.type === "textNote" || it.type === "line") { byId.set(it.id, it); continue; }
    if (cfg.doorSnap) continue;            // pass 2

    const isWall = (cfg.wallOnly || cfg.wallSnap) && it.wall;
    if (isWall) {
      const isH = it.wall === "north" || it.wall === "south";
      const wantFt = isH ? (it.x - A.mgX) / A.scale : (it.y - A.mgY) / A.scale;
      const hFt = it.heightFt || cfg.height;
      let wFt = it.widthFt || cfg.width;
      const wallLen = isH ? next.w : next.h;
      if (wFt > wallLen && SS_SHRINKABLE[it.type]) {
        const shrunk = Math.max(it.type === "roughOpening" ? 0.5 : 2, wallLen);
        if (shrunk !== wFt) { wFt = shrunk; events.push({ id: it.id, type: it.type, label: labelOf(it), kind: "resized", to: wFt }); }
      }
      let sn = seat(it, cfg, it.wall, wantFt, wFt, hFt);
      let movedWall = false;
      if (!sn) {
        for (const w2 of (SS_WALL_ORDER[it.wall] || [])) {
          const isH2 = w2 === "north" || w2 === "south";
          sn = seat(it, cfg, w2, (isH2 ? next.w : next.h) / 2, wFt, hFt);
          if (sn) { movedWall = true; break; }
        }
      }
      if (!sn) { events.push({ id: it.id, type: it.type, label: labelOf(it), kind: "blocked" }); byId.set(it.id, it); continue; }
      if (movedWall) events.push({ id: it.id, type: it.type, label: labelOf(it), kind: "movedWall", to: sn.wall });
      const nit = { ...it, ...sn, widthFt: wFt };
      byId.set(it.id, nit); placed.push(nit);
      continue;
    }

    if (it.type === "loft") {
      let wFt = it.widthFt || cfg.width, hFt = it.heightFt || cfg.height;
      let cxFt = (it.x - A.mgX) / A.scale, cyFt = (it.y - A.mgY) / A.scale;
      // A loft placed by clicking is seeded widthFt = bldgW (a snapshot of the building
      // width). If it spanned wall to wall, it should still span wall to wall.
      if (Math.abs(wFt - prev.w) < 0.35) { wFt = next.w; cxFt = next.w / 2; }
      else cxFt = cxFt * (next.w / prev.w);
      cyFt = cyFt * (next.h / prev.h);
      const wasW = wFt, wasH = hFt;
      wFt = Math.max(2, Math.min(wFt, next.w));
      hFt = Math.max(2, Math.min(hFt, next.h));
      if (wFt > next.w || hFt > next.h) { events.push({ id: it.id, type: it.type, label: labelOf(it), kind: "blocked" }); byId.set(it.id, it); continue; }
      if (wFt !== wasW || hFt !== wasH) events.push({ id: it.id, type: it.type, label: labelOf(it), kind: "resized", to: wFt });
      cxFt = Math.max(wFt / 2, Math.min(cxFt, next.w - wFt / 2));
      cyFt = Math.max(hFt / 2, Math.min(cyFt, next.h - hFt / 2));
      const nit = { ...it, x: B.mgX + cxFt * B.scale, y: B.mgY + cyFt * B.scale, widthFt: wFt, heightFt: hFt };
      byId.set(it.id, nit); placed.push(nit);
      continue;
    }

    // Free-floating: keep it inside the new box.
    const wFt = it.widthFt || cfg.width, hFt = it.heightFt || cfg.height;
    let cxFt = ((it.x - A.mgX) / A.scale) * (next.w / prev.w);
    let cyFt = ((it.y - A.mgY) / A.scale) * (next.h / prev.h);
    cxFt = Math.max(wFt / 2, Math.min(cxFt, next.w - wFt / 2));
    cyFt = Math.max(hFt / 2, Math.min(cyFt, next.h - hFt / 2));
    const nit = { ...it, x: B.mgX + cxFt * B.scale, y: B.mgY + cyFt * B.scale };
    byId.set(it.id, nit); placed.push(nit);
  }

  // ── Pass 2: ramps follow their door, or go with it ──
  for (const it of items) {
    const cfg = ITEMS[it.type];
    if (!cfg || !cfg.doorSnap) continue;
    const door = byId.get(it.snapDoorId);
    const pos = door && door.wall ? rampPosFor(it, door, B) : null;
    if (!pos) continue;                    // orphaned ramp is dropped, as when its door is deleted
    byId.set(it.id, { ...it, ...pos });
  }

  return { items: items.map((it) => byId.get(it.id)).filter(Boolean), events };
}

// Point on a note box's border in the direction of a target — where the note's
// leader (pointer) line starts, so the dashed line begins at the pill's edge
// instead of its center. If the target is inside the box, returns the target
// itself (degenerate line; callers skip drawing when start ≈ end).
function noteEdgePoint(cx, cy, w, h, tx, ty) {
  const dx = tx - cx, dy = ty - cy;
  if (!dx && !dy) return { x: cx, y: cy };
  const t = Math.min(
    dx ? (w / 2) / Math.abs(dx) : Infinity,
    dy ? (h / 2) / Math.abs(dy) : Infinity,
    1
  );
  return { x: cx + dx * t, y: cy + dy * t };
}

// Determine which positional wall (north/south/east/west) is the FRONT
// based on door placement. Double door wins over single door.
function getFrontWall(items) {
  // Catalog fixture doors count as doors too; a double-leaf (built-in doubleDoor, or a
  // fixture whose operation is "double") wins over a single, same as before.
  const doubles = items.filter((i) => i.wall && (i.type === "doubleDoor" || (i.type === "fixtureDoor" && i.operation === "double")));
  if (doubles.length > 0) return doubles[0].wall;
  const singles = items.filter((i) => i.wall && (i.type === "singleDoor" || i.type === "fixtureDoor"));
  if (singles.length > 0) return singles[0].wall;
  return null;
}

// ── Fixtures catalog (Options → Doors) → placeable designer tools + rendering ──────
// Each active catalog door (from get_fixtures) becomes a palette tool keyed `fx:<id>`
// (wallOnly, carrying its own width in feet). Placing one creates a stable `fixtureDoor`
// item that SNAPSHOTS the door's spec (name/width/price/swing/operation) so a later catalog
// edit never changes a saved design. FIXTURE_DOOR_CFG is the render cfg for those placed
// items; `noPalette` keeps it out of the tool row (only the fx: tools are shown).
const FIXTURE_DOOR_COLOR = "#D97706";         // matches the built-in Single Door glyph
const FIXTURE_DOOR_COLOR_DOUBLE = "#B45309";  // matches the built-in Double Door glyph
// Amber like the built-in doors, darker for a double so it reads the same as doubleDoor.
function fixtureDoorColor(item) { return item && item.operation === "double" ? FIXTURE_DOOR_COLOR_DOUBLE : FIXTURE_DOOR_COLOR; }
const FIXTURE_DOOR_CFG = { label: "Door", color: FIXTURE_DOOR_COLOR, wallOnly: true, width: 3, height: 0.5, shortLabel: "DOOR", noPalette: true, isFixtureDoor: true };
// The single "Door" palette tool. Arming it and clicking a wall opens the door picker
// (below) instead of placing immediately — the shopper chooses WHICH door (and its swing/
// operation where more than one is offered) in the popup.
const DOOR_PICKER_CFG = { label: "Door", color: FIXTURE_DOOR_COLOR, wallOnly: true, width: 3, height: 0.5, shortLabel: "DOOR", isDoorPicker: true };
// Custom ramps (custom mode). The "Ramp" tool attaches to a door (doorSnap) and opens the ramp
// picker. A placed custom ramp is a normal type:"ramp" item — so it reuses ALL the existing ramp
// machinery (render, door-snap follow, delete-cascade, z-order) — but carries the chosen style's
// own width/length + a priced snapshot (vs the simple built-in ramp which takes the door's width).
const FIXTURE_RAMP_COLOR = "#0284C7";
const RAMP_PICKER_CFG = { label: "Ramp", color: FIXTURE_RAMP_COLOR, icon: "⬛", doorSnap: true, width: 3, height: 2, shortLabel: "RAMP", isRampPicker: true };
// Simple ramp — a fully self-contained option (render + placement), NO longer the built-in `ramp`
// layout item. Auto-widths to the door it attaches to (handled in handleClick's doorSnap branch,
// same as before). Stone color matches the old built-in so already-placed ramps look identical.
// ITEMS.ramp is ALWAYS this cfg (so every placed type:"ramp" renders), placeable only when the
// tenant offers a simple ramp (rampSettings.enabled + simple mode).
const SIMPLE_RAMP_CFG = { label: "Ramp", color: "#78716C", icon: "⬛", doorSnap: true, width: 3, height: 3, shortLabel: "RAMP", isSimpleRamp: true };
// Catalog windows. The "Window" tool is wall-placed (like the door picker). A placed catalog
// window is a normal type:"window" item — so it reuses the built-in window's render (mullions,
// wall bar), collision, and payload — but carries the chosen style's width + a priced snapshot
// (built-in windows have no fixtureItemId; that's how the two are told apart in pricing).
const FIXTURE_WINDOW_COLOR = "#0EA5E9";
const WINDOW_PICKER_CFG = { label: "Window", color: FIXTURE_WINDOW_COLOR, icon: "🪟", wallOnly: true, width: 2, height: 0.5, shortLabel: "WIN", isWindowPicker: true };
function fixtureInitialSwing(fx) {
  if (fx.swingIn && fx.swingOut) return fx.swingDefault || "in";
  if (fx.swingIn) return "in";
  if (fx.swingOut) return "out";
  return null;
}
function fixtureInitialOperation(fx) {
  if (fx.opSlideUp) return "slideup";
  if (fx.opDouble) return "double";
  if (fx.opRight && fx.opLeft) return fx.opDefault || "right";
  if (fx.opRight) return "right";
  if (fx.opLeft) return "left";
  return null;
}
// Color defaults for a catalog door (colors feature, migration 116). fixed → the owner's
// fixed color or none (today's rendering); paint → the door-flagged palette's default;
// match → the color whose label equals the building's CURRENT body/trim paint selection,
// falling back to the palette default. Trim fields ride only when the door is two-tone
// (hasTrimColor). Returns full {id,label,hex} triples so placements can snapshot them.
function fixtureDoorColorDefaults(fx, doorColors, paintBody, paintTrim) {
  const list = Array.isArray(doorColors) ? doorColors : [];
  const byLabel = (lbl) => (lbl ? list.find((c) => c.label === lbl) : null);
  const fallback = () => list.find((c) => c.isDefault) || list[0] || null;
  const out = { colorId: null, colorLabel: null, colorHex: null, trimColorId: null, trimColorLabel: null, trimColorHex: null };
  const mode = fx && fx.colorMode;
  if (mode === "paint" || mode === "match") {
    const main = (mode === "match" && byLabel(paintBody)) || fallback();
    if (main) { out.colorId = main.id; out.colorLabel = main.label || null; out.colorHex = main.hex || null; }
    if (fx.hasTrimColor) {
      const trim = (mode === "match" && byLabel(paintTrim)) || fallback();
      if (trim) { out.trimColorId = trim.id; out.trimColorLabel = trim.label || null; out.trimColorHex = trim.hex || null; }
    }
  } else if (fx && fx.fixedColor && fx.fixedColor.id) {
    out.colorId = fx.fixedColor.id; out.colorLabel = fx.fixedColor.label || null; out.colorHex = fx.fixedColor.hex || null;
  }
  return out;
}
// The window-color default: the flagged default, else the first. One list serves every
// catalog window (that's the point — no duplicate window rows per color).
function fixtureWindowColorDefault(windowColors) {
  const list = Array.isArray(windowColors) ? windowColors : [];
  return list.find((c) => c.isDefault) || list[0] || null;
}
// Which of the client's window colors THIS window comes in (119): no windowColorIds on
// the fixture = all of them; an id list = exactly those (a stale/deleted id just never
// matches). Every window placement path — picker, included chip, 3D — offers/defaults
// from this filtered list, never the raw one.
function windowColorsFor(fx, windowColors) {
  const list = Array.isArray(windowColors) ? windowColors : [];
  if (!fx || !Array.isArray(fx.windowColorIds)) return list;
  const s = new Set(fx.windowColorIds.map(String));
  return list.filter((c) => s.has(String(c.id)));
}
// The color fields a PLACED fixture snapshots (ids for server-side price re-resolution,
// labels for descriptions, hexes for 2D/3D rendering). Every door stamp site — place,
// swap, included-chip, 3D placement — writes all six so a swap can never leak the old
// door's colors; windows stamp the three main fields only.
function doorColorStamps(dc, tc) {
  return {
    colorId: dc ? dc.id : null, colorLabel: dc ? (dc.label || null) : null, colorHex: dc ? (dc.hex || null) : null,
    trimColorId: tc ? tc.id : null, trimColorLabel: tc ? (tc.label || null) : null, trimColorHex: tc ? (tc.hex || null) : null,
  };
}
function windowColorStamps(c) {
  return { colorId: c ? c.id : null, colorLabel: c ? (c.label || null) : null, colorHex: c ? (c.hex || null) : null };
}
function buildFixtureTools(fixtures) {
  const out = {};
  (Array.isArray(fixtures) ? fixtures : []).forEach((fx) => {
    if (!fx || (fx.category && fx.category !== "door")) return;
    const wIn = Number(fx.widthIn) || 36;
    out[`fx:${fx.id}`] = {
      label: fx.name || "Door", color: FIXTURE_DOOR_COLOR, icon: "🚪",
      wallOnly: true, width: wIn / 12, height: 0.5,
      shortLabel: (fx.name || "DOOR").toUpperCase().slice(0, 10), fixture: fx,
    };
  });
  return out;
}
// Swing/operation-aware door glyph. `out` combines the wall side (like the built-in
// singleDoor/doubleDoor) with the door's in/out swing (in = mirror of out). Hinge side
// comes from operation (right/left); "double" = two leaves; "slideup" = a segmented
// garage/roll-up panel with no arc.
function fixtureDoorOut(item) {
  const outBase = item.wall === "north" || item.wall === "east";
  return item.swing === "in" ? !outBase : outBase;
}
function fixtureDoorSVG(item, iw, color) {
  const stroke = color + "60", op = item.operation, out = fixtureDoorOut(item);
  if (op === "slideup") {
    return <g>{[-iw / 4, 0, iw / 4].map((lx, k) => <line key={k} x1={lx} y1={-5} x2={lx} y2={5} stroke="#FFF" strokeWidth={1.5} />)}</g>;
  }
  if (op === "double") {
    const r = iw * 0.4, s = out ? -1 : 1;
    return (<><path d={`M ${-iw / 2 + r} 0 A ${r} ${r} 0 0 ${out ? 0 : 1} ${-iw / 2} ${s * r}`} fill="none" stroke={stroke} strokeWidth={1.5} strokeDasharray="4 3" /><path d={`M ${iw / 2 - r} 0 A ${r} ${r} 0 0 ${out ? 1 : 0} ${iw / 2} ${s * r}`} fill="none" stroke={stroke} strokeWidth={1.5} strokeDasharray="4 3" /><line x1={0} y1={-5} x2={0} y2={5} stroke="#FFF" strokeWidth={1.5} /></>);
  }
  const r = iw * 0.8, rightHinge = op === "right", ey = out ? -r : r;
  const sx = rightHinge ? iw / 2 - r : -iw / 2 + r, ex = rightHinge ? iw / 2 : -iw / 2;
  const sweep = rightHinge ? (out ? 1 : 0) : (out ? 0 : 1);
  return <path d={`M ${sx} 0 A ${r} ${r} 0 0 ${sweep} ${ex} ${ey}`} fill="none" stroke={stroke} strokeWidth={1.5} strokeDasharray="4 3" />;
}
function fixtureDoorCanvas(ctx, item, iw, color) {
  const op = item.operation, out = fixtureDoorOut(item);
  if (op === "slideup") {
    ctx.strokeStyle = "#FFF"; ctx.lineWidth = 1.5;
    [-iw / 4, 0, iw / 4].forEach((lx) => { ctx.beginPath(); ctx.moveTo(lx, -5); ctx.lineTo(lx, 5); ctx.stroke(); });
    return;
  }
  ctx.strokeStyle = color + "60"; ctx.lineWidth = 1.5; ctx.setLineDash([4, 3]);
  if (op === "double") {
    const r = iw * 0.4;
    ctx.beginPath(); ctx.arc(-iw / 2, 0, r, 0, out ? -Math.PI / 2 : Math.PI / 2, out); ctx.stroke();
    ctx.beginPath(); ctx.arc(iw / 2, 0, r, Math.PI, out ? 3 * Math.PI / 2 : Math.PI / 2, !out); ctx.stroke();
    ctx.setLineDash([]); ctx.strokeStyle = "#FFF"; ctx.lineWidth = 1.5; ctx.beginPath(); ctx.moveTo(0, -5); ctx.lineTo(0, 5); ctx.stroke();
    return;
  }
  const r = iw * 0.8, rightHinge = op === "right";
  if (rightHinge) { ctx.beginPath(); ctx.arc(iw / 2, 0, r, Math.PI, out ? 3 * Math.PI / 2 : Math.PI / 2, !out); ctx.stroke(); }
  else { ctx.beginPath(); ctx.arc(-iw / 2, 0, r, 0, out ? -Math.PI / 2 : Math.PI / 2, out); ctx.stroke(); }
  ctx.setLineDash([]);
}
// Door sizes are stored in inches; show them as feet/inches on the plan + in the picker.
function fmtFtIn(inches) {
  const n = Number(inches);
  if (!isFinite(n) || n <= 0) return "";
  const ft = Math.floor(n / 12), inch = Math.round((n - ft * 12) * 100) / 100;
  if (ft === 0) return inch + '"';
  if (inch === 0) return ft + "'";
  return ft + "'" + inch + '"';
}
// Door placement picker. Doors are grouped by STYLE (exact name): one card per style; picking a
// style with more than one size reveals a size chooser, then swing/operation where more than one
// is offered, then place.
function DoorPicker({ doors, showPricing, doorColors, paintBody, paintTrim, onCancel, onPlace }) {
  const styles = useMemo(() => {
    const m = new Map();
    doors.forEach((d) => {
      const k = d.name || "Door";
      if (!m.has(k)) m.set(k, { name: k, imageUrl: d.imageUrl || null, sizes: [] });
      const g = m.get(k); g.sizes.push(d); if (!g.imageUrl && d.imageUrl) g.imageUrl = d.imageUrl;
    });
    return [...m.values()];
  }, [doors]);
  const [style, setStyle] = useState(styles.length === 1 ? styles[0] : null);
  const [sel, setSel] = useState((styles.length === 1 && styles[0].sizes.length === 1) ? styles[0].sizes[0] : null);
  const [swing, setSwing] = useState(null);
  const [operation, setOperation] = useState(null);
  // Chosen colors as full palette OBJECTS (id/label/hex/doorRate) so onPlace can snapshot
  // them. Reset per selection like swing/operation: fixed mode gets the owner's fixed
  // color, match mode starts on the building's current body/trim paint picks.
  const [doorColor, setDoorColor] = useState(null);
  const [trimColor, setTrimColor] = useState(null);
  const colorList = Array.isArray(doorColors) ? doorColors : [];
  useEffect(() => {
    if (!sel) { setSwing(null); setOperation(null); setDoorColor(null); setTrimColor(null); return; }
    setSwing(fixtureInitialSwing(sel));
    setOperation(fixtureInitialOperation(sel));
    const d = fixtureDoorColorDefaults(sel, colorList, paintBody, paintTrim);
    setDoorColor(colorList.find((c) => c.id === d.colorId) || (d.colorId ? { id: d.colorId, label: d.colorLabel, hex: d.colorHex } : null));
    setTrimColor(colorList.find((c) => c.id === d.trimColorId) || null);
  }, [sel]);
  const pickStyle = (st) => { setStyle(st); setSel(st.sizes.length === 1 ? st.sizes[0] : null); };
  const swingOpts = sel ? [sel.swingIn && "in", sel.swingOut && "out"].filter(Boolean) : [];
  const opOpts = sel ? [sel.opRight && "right", sel.opLeft && "left", sel.opDouble && "double", sel.opSlideUp && "slideup"].filter(Boolean) : [];
  // Color choices only exist for paint/match modes; a single-entry palette auto-assigns
  // silently, exactly like a single-swing door shows no Swing block.
  const colorable = !!(sel && (sel.colorMode === "paint" || sel.colorMode === "match"));
  const colorOpts = colorable ? colorList : [];
  const OP_LABEL = { right: "Right", left: "Left", double: "Double", slideup: "Slide up" };
  const money = (n) => "$" + Number(n).toLocaleString();
  const chip = (key, on, label, onClick) => (
    <div key={key} onClick={onClick} style={{ padding: "6px 14px", borderRadius: 20, fontSize: 13, fontWeight: 600, cursor: "pointer",
      border: `2px solid ${on ? FIXTURE_DOOR_COLOR : "#E2E8F0"}`, background: on ? "#FEF3C7" : "#FFF", color: on ? "#92400E" : "#334155" }}>{label}</div>
  );
  // A color chip: swatch dot + label + the color's flat per-door price when shown.
  const colorChip = (c, on, onClick) => (
    <div key={c.id} onClick={onClick} style={{ display: "flex", alignItems: "center", gap: 6, padding: "6px 12px", borderRadius: 20, fontSize: 13, fontWeight: 600, cursor: "pointer",
      border: `2px solid ${on ? FIXTURE_DOOR_COLOR : "#E2E8F0"}`, background: on ? "#FEF3C7" : "#FFF", color: on ? "#92400E" : "#334155" }}>
      <span style={{ width: 14, height: 14, borderRadius: "50%", background: c.hex || "#CCC", border: "1px solid rgba(0,0,0,0.2)", flexShrink: 0 }} />
      {c.label}{showPricing && Number(c.doorRate) > 0 ? ` · +${money(c.doorRate)}` : ""}
    </div>
  );
  return (
    <div onClick={onCancel} style={{ position: "fixed", inset: 0, background: "rgba(15,23,42,0.45)", zIndex: 9000, display: "flex", alignItems: "center", justifyContent: "center", padding: 16 }}>
      <div onClick={(e) => e.stopPropagation()} style={{ background: "#FFF", borderRadius: 14, width: "min(560px, 96vw)", maxHeight: "88vh", overflow: "auto", padding: 20, boxShadow: "0 20px 60px rgba(0,0,0,0.3)", fontFamily: "system-ui, -apple-system, sans-serif" }}>
        <div style={{ fontSize: 17, fontWeight: 800, color: "#1E293B", marginBottom: 4 }}>Choose a door</div>
        <div style={{ fontSize: 13, color: "#64748B", marginBottom: 14 }}>{style && style.sizes.length > 1 ? "Pick a size." : "Pick a door to place on this wall."}</div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(150px, 1fr))", gap: 10, marginBottom: 16 }}>
          {styles.map((st) => {
            const on = style && style.name === st.name;
            const one = st.sizes.length === 1 ? st.sizes[0] : null;
            const sub = one ? `${fmtFtIn(one.widthIn)} × ${fmtFtIn(one.heightIn)}${showPricing && one.price != null ? ` · ${money(one.price)}` : ""}` : `${st.sizes.length} sizes`;
            return (
              <div key={st.name} onClick={() => pickStyle(st)} style={{ border: `2px solid ${on ? FIXTURE_DOOR_COLOR : "#E2E8F0"}`, borderRadius: 10, overflow: "hidden", cursor: "pointer", background: "#FFF" }}>
                {st.imageUrl ? <img src={st.imageUrl} alt="" style={{ width: "100%", height: 90, objectFit: "cover", display: "block" }} />
                  : <div style={{ height: 90, background: "#F1F5F9", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 26 }}>🚪</div>}
                <div style={{ padding: "8px 10px" }}>
                  <div style={{ fontSize: 13, fontWeight: 700, color: "#1E293B" }}>{st.name}</div>
                  <div style={{ fontSize: 11.5, color: "#64748B" }}>{sub}</div>
                </div>
              </div>
            );
          })}
        </div>
        {style && style.sizes.length > 1 && (
          <div style={{ marginBottom: 14 }}>
            <div style={{ fontSize: 12, fontWeight: 700, color: "#334155", marginBottom: 6 }}>Size</div>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>{style.sizes.map((d) => chip(d.id, sel && sel.id === d.id, `${fmtFtIn(d.widthIn)} × ${fmtFtIn(d.heightIn)}${showPricing && d.price != null ? ` · ${money(d.price)}` : ""}`, () => setSel(d)))}</div>
          </div>
        )}
        {sel && swingOpts.length > 1 && (
          <div style={{ marginBottom: 12 }}>
            <div style={{ fontSize: 12, fontWeight: 700, color: "#334155", marginBottom: 6 }}>Swing</div>
            <div style={{ display: "flex", gap: 8 }}>{swingOpts.map((o) => chip(o, swing === o, o === "in" ? "In-swing" : "Out-swing", () => setSwing(o)))}</div>
          </div>
        )}
        {sel && opOpts.length > 1 && (
          <div style={{ marginBottom: 14 }}>
            <div style={{ fontSize: 12, fontWeight: 700, color: "#334155", marginBottom: 6 }}>Operation</div>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>{opOpts.map((o) => chip(o, operation === o, OP_LABEL[o], () => setOperation(o)))}</div>
          </div>
        )}
        {colorable && colorOpts.length > 1 && (
          <div style={{ marginBottom: 12 }}>
            <div style={{ fontSize: 12, fontWeight: 700, color: "#334155", marginBottom: 6 }}>Color</div>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>{colorOpts.map((c) => colorChip(c, doorColor && doorColor.id === c.id, () => setDoorColor(c)))}</div>
          </div>
        )}
        {colorable && sel.hasTrimColor && colorOpts.length > 1 && (
          <div style={{ marginBottom: 14 }}>
            <div style={{ fontSize: 12, fontWeight: 700, color: "#334155", marginBottom: 6 }}>Trim color</div>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>{colorOpts.map((c) => colorChip(c, trimColor && trimColor.id === c.id, () => setTrimColor(c)))}</div>
          </div>
        )}
        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 4 }}>
          <button onClick={onCancel} style={{ padding: "9px 16px", borderRadius: 8, border: "1px solid #CBD5E1", background: "#FFF", color: "#334155", fontWeight: 600, cursor: "pointer" }}>Cancel</button>
          <button onClick={() => sel && onPlace(sel, swing, operation, doorColor, sel.hasTrimColor ? trimColor : null)} disabled={!sel} style={{ padding: "9px 18px", borderRadius: 8, border: "none", background: sel ? FIXTURE_DOOR_COLOR : "#CBD5E1", color: "#FFF", fontWeight: 700, cursor: sel ? "pointer" : "default" }}>Place door</button>
        </div>
      </div>
    </div>
  );
}

// Map a positional wall to a display label (FRONT/BACK/LEFT/RIGHT)
// based on which wall is currently FRONT. Returns null if no front set.
//
// VIEWPOINT: a customer standing OUTSIDE the building, in front of the doors, looking
// at them. LEFT/RIGHT are that person's left and right — what they'd say pointing at
// the real building — NOT what a plan reader sees on screen. For a north- or
// south-facing front those two are mirror images of each other, which is exactly what
// makes this easy to get wrong.
//
// Facing the front wall, the customer's left is the direction they face rotated 90°
// counter-clockwise on the compass:
//
//   front   customer faces   LEFT    RIGHT
//   north   south            east    west
//   south   north            west    east
//   east    west             south   north
//   west    east             north   south
//
// (Plan orientation, per getWallFromClick: north = top of the canvas, south = bottom,
// west = left, east = right.)
//
// FIXED 2026-07-26 (reported by Junior Barns): the north and south rows were inverted.
// They described an INSIDE-looking-out viewpoint while east/west already used
// outside-looking-in, so a door on the north or south wall reported its sides
// backwards while an end-wall door read correctly — an inconsistency, not a uniform
// flip. This function is the single source of truth for the on-screen labels, the
// exported PNG/PDF, and the `wall` field in the submit payload, so it drives the
// emailed estimate too. Check any edit against the table above, not against a
// screenshot of the plan.
function getDisplayLabel(positionalWall, frontWall) {
  if (!frontWall || !positionalWall) return null;
  const map = {
    north: { north: "FRONT", south: "BACK",  east: "LEFT",  west: "RIGHT" },
    south: { south: "FRONT", north: "BACK",  west: "LEFT",  east: "RIGHT" },
    east:  { east: "FRONT",  west: "BACK",   south: "LEFT", north: "RIGHT" },
    west:  { west: "FRONT",  east: "BACK",   north: "LEFT", south: "RIGHT" },
  };
  return map[frontWall][positionalWall];
}

// How to name a wall in a sentence to the customer. getDisplayLabel is relative to the
// FRONT, and there is no front until a door is placed — it returns null, which rendered as
// "moved to the null wall". Naming a direction we cannot actually derive would be worse
// than not naming one, so say "another wall" until a door defines the front.
function wallPhrase(positionalWall, frontWall) {
  const d = getDisplayLabel(positionalWall, frontWall);
  return d ? "the " + d.toLowerCase() + " wall" : "another wall";
}

// A ramp sits centered on the OUTSIDE of its door, so its placement is fully
// derived from the door's position/wall + the ramp's depth. One source of
// truth used by ramp placement AND by the 2D/3D door drags, so ramps follow
// their door wherever it goes.
function rampPlacementForDoor(door, rampDepthFt, pW, pH, mgX, mgY, scale) {
  const dPx = (rampDepthFt || 2) * scale;
  switch (door.wall) {
    case "north": return { x: door.x, y: mgY - dPx / 2, rotation: 0, wall: "north" };
    case "south": return { x: door.x, y: mgY + pH + dPx / 2, rotation: 0, wall: "south" };
    case "west":  return { x: mgX - dPx / 2, y: door.y, rotation: 90, wall: "west" };
    case "east":  return { x: mgX + pW + dPx / 2, y: door.y, rotation: 90, wall: "east" };
    default: return null;
  }
}

// ─── Layout add-on pricing (browser mirror of submit-estimate's pushItem) ─────────
// Compute one display row per priceable placed item type, applying the SAME 7
// pricing_method formulas the edge function uses so the prices shown on the plan match
// the emailed estimate to the penny. Needs C.layoutPricing ({key:{rate,method,byStyle}})
// and C.sizePricing ({styleKey:{sizeLabel:{basePrice,widthFt,lengthFt}}}) — both are
// present only when the tenant's show_pricing is on (else {} → returns no rows).
const LAYOUT_PRICE_ORDER = ["singleDoor", "doubleDoor", "window", "workbench", "loft", "ramp"];
function normSizeLabel(s) { return String(s || "").toLowerCase().replace(/[×✕]/g, "x").replace(/\s+/g, ""); }
function fmtMoney2(n) { const v = Number(n) || 0; const s = "$" + Math.abs(v).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }); return v < 0 ? "−" + s : s; }
// Building / Paint Colors / Roof summary for the "Details" section, in the SAME order they appear
// on the GHL estimate (Building, Paint, Roof). Prices use the same sizePricing + color rate/method
// the estimate uses (total is null when show_pricing is off). The Roof row shows only when the
// tenant offers roof colors (some color flagged shingle/metal).
// Origin allowlist for the postMessage prefill/config listeners — same-origin,
// the structurestudio.app family, and localhost (dev). Without it, a malicious
// page that frames or window.opens the designer can inject selections/contact or
// remount the app with an attacker-controlled config. If a tenant ever embeds the
// designer from its own domain via postMessage, add that origin here.
function ssAllowedOrigin(origin) {
  try {
    if (!origin || origin === "null") return false;
    if (origin === window.location.origin) return true;
    const h = new URL(origin).hostname;
    return h === "structurestudiosuite.com" || h.endsWith(".structurestudiosuite.com") || h === "structurestudio.app" || h.endsWith(".structurestudio.app") || h === "localhost" || h === "127.0.0.1";
  } catch { return false; }
}

function computeSelectionRows(sel, paintColors, C, items) {
  const styleKey = sel && sel.style;
  const showP = !!(C && C.showPricing);
  const colors = Array.isArray(C && C.colors) ? C.colors : [];
  const szMap = (C && C.sizePricing && styleKey) ? C.sizePricing[styleKey] : null;
  let szRow = null;
  if (szMap && sel && sel.size) {
    szRow = szMap[sel.size];
    if (!szRow) { const want = normSizeLabel(sel.size); for (const k in szMap) { if (normSizeLabel(k) === want) { szRow = szMap[k]; break; } } }
  }
  const bW = (szRow && szRow.widthFt != null) ? Number(szRow.widthFt) : 0;
  const bL = (szRow && szRow.lengthFt != null) ? Number(szRow.lengthFt) : 0;
  const buildingArea = bW * bL, buildingPerimeter = 2 * (bW + bL);
  const buildingPrice = (szRow && szRow.basePrice != null) ? Number(szRow.basePrice) : 0;
  const charge = (c) => {
    if (!c) return 0;
    const rate = Number(c.rate) || 0;
    if (rate <= 0) return 0;
    switch (c.pricingMethod || "each") {
      case "sqft_building": return rate * buildingArea;
      case "perimeter_building": return rate * buildingPerimeter;
      case "pct_building_price": return (rate / 100) * buildingPrice;
      case "pct_estimate_total": return 0;
      default: return rate;
    }
  };
  const pick = (label, pred) => {
    const v = String(label || "").trim(); if (!v) return null;
    const list = colors.filter(pred);
    return list.find((c) => c.label === v) || list.find((c) => c.allowCustom) || null;
  };
  const styleLabel = (((C && C.buildingStyles) || []).find((s) => s.value === styleKey) || {}).label || styleKey || "";
  const rows = [];
  // Declined included items are itemized UNDER the building line (one per line), same as the GHL
  // estimate — the building line's bold label is just the style + size, and the gray detail lists
  // the original price + each declined item; the credits reduce the building total.
  const layoutPricing = (C && C.layoutPricing) || {};
  const resolveLp = (key) => { const lp = layoutPricing[key]; if (!lp) return null; const ov = (lp.byStyle && styleKey) ? lp.byStyle[styleKey] : null; return { rate: Number(ov && ov.rate != null ? ov.rate : lp.rate) || 0, method: (ov && ov.method) || lp.method || "each" }; };
  const stEntry = ((C && C.buildingStyles) || []).find((s) => s.value === styleKey);
  const pickSize = (map) => { if (!map || typeof map !== "object" || !(sel && sel.size)) return null; if (map[sel.size] != null) return map[sel.size]; const want = normSizeLabel(sel.size); for (const k in map) { if (normSizeLabel(k) === want) return map[k]; } return null; };
  const rawQ = stEntry ? pickSize(stEntry.sizeInclusionQty) : null;
  const qmap = (rawQ && typeof rawQ === "object" && !Array.isArray(rawQ)) ? rawQ : null;
  const legacyArr = !qmap && stEntry ? pickSize(stEntry.sizeInclusions) : null;
  let includedNow = {};
  if (qmap) includedNow = qmap; else if (Array.isArray(legacyArr)) { for (const k of legacyArr) includedNow[k] = 1; }
  const declinedKeys = (sel && Array.isArray(sel.declinedItems)) ? sel.declinedItems : [];
  const declinedLines = []; let declinedTotal = 0;
  if (sel && sel.size) {
    for (const k of declinedKeys) {
      if (includedNow[k] == null) continue;
      // Catalog fixture inclusion (key = fixture id): credit its snapshot price × the included qty.
      const fxDecl = (Array.isArray(C.fixtures) ? C.fixtures : []).find((f) => String(f.id) === k);
      if (fxDecl) {
        const q0 = Math.max(1, Number(includedNow[k]) || 1);
        const credit0 = Math.round((fxDecl.price != null ? Number(fxDecl.price) : 0) * q0 * 100) / 100;
        if (credit0 <= 0) continue;
        declinedLines.push(`${fxDecl.name || "Item"} declined (−${fmtMoney2(credit0)})`);
        declinedTotal += credit0;
        continue;
      }
      const rp = resolveLp(k); if (!rp || !(rp.rate > 0)) continue;
      const q = rp.method === "pct_estimate_total" ? 1 : Math.max(1, Number(includedNow[k]) || 1);
      let unitValue = rp.rate;
      switch (rp.method) {
        case "sqft_building": unitValue = rp.rate * buildingArea; break;
        case "perimeter_building": unitValue = rp.rate * buildingPerimeter; break;
        case "pct_building_price": unitValue = (rp.rate / 100) * buildingPrice; break;
        default: break;
      }
      unitValue = Math.round(unitValue * 100) / 100;
      const credit = Math.round(unitValue * q * 100) / 100;
      if (credit <= 0) continue;
      const label = (C.layoutItems && C.layoutItems[k] && C.layoutItems[k].label) || (LEGACY_LAYOUT_FALLBACK[k] && LEGACY_LAYOUT_FALLBACK[k].label) || k;
      declinedLines.push(`${label} declined (−${fmtMoney2(credit)})`);
      declinedTotal += credit;
    }
  }
  // Under-placed included area items (loft, and any sqft_option inclusion): a smaller placed
  // area than the included amount credits the shortfall (mirrors submit-estimate's pushItem,
  // which credits sqft_option under-placement). Only when actually placed and not declined — a
  // fully-absent include is handled by the decline flow, not auto-credited. Kept method-scoped
  // to sqft_option so it stays in lock-step with the edge (lineal_ft is NOT under-credited).
  if (sel && sel.size && Array.isArray(items)) {
    for (const k in includedNow) {
      if (declinedKeys.includes(k)) continue;
      const rpk = resolveLp(k);
      if (!rpk || rpk.method !== "sqft_option" || !(rpk.rate > 0)) continue;
      const incQ = Number(includedNow[k]) || 0;
      if (incQ <= 0) continue;
      const placedSqft = Math.round(items.filter((i) => i.type === k).reduce((s, i) => s + (Number(i.widthFt) || 0) * (Number(i.heightFt) || 0), 0));
      if (placedSqft > 0 && placedSqft < incQ) {
        const credit = Math.round(rpk.rate * (incQ - placedSqft) * 100) / 100;
        if (credit > 0) {
          const lbl = (C.layoutItems && C.layoutItems[k] && C.layoutItems[k].label) || (LEGACY_LAYOUT_FALLBACK[k] && LEGACY_LAYOUT_FALLBACK[k].label) || k;
          declinedLines.push(`${lbl} smaller than included: ${incQ - placedSqft} sq ft credited (−${fmtMoney2(credit)})`);
          declinedTotal += credit;
        }
      }
    }
  }
  declinedTotal = Math.round(declinedTotal * 100) / 100;
  const styleSize = [styleLabel, sel && sel.size].filter(Boolean).join(" ") || "—";
  const buildingDetail = declinedLines.length ? [`Original building price: ${fmtMoney2(buildingPrice)}`, ...declinedLines].join("\n") : "";
  rows.push({ key: "building", label: styleSize, detail: buildingDetail, total: showP ? Math.max(0, buildingPrice - declinedTotal) : null });
  const painted = sel && sel.paint === "Painted";
  let pDetail = "Unpainted", pTotal = 0;
  if (painted) {
    const body = pick(paintColors && paintColors.body, (c) => c.siding);
    const trim = pick(paintColors && paintColors.trim, (c) => c.trim);
    const seen = {};
    [body, trim].forEach((c) => { if (c && c.id && !seen[c.id]) { seen[c.id] = 1; pTotal += charge(c); } });
    pDetail = `Body: ${(paintColors && paintColors.body) || "TBD"}, Trim: ${(paintColors && paintColors.trim) || "TBD"}`;
  }
  rows.push({ key: "paint", label: "Paint Colors", detail: pDetail, total: showP ? pTotal : null });
  const offersRoof = colors.some((c) => c.shingle || c.metal);
  if (offersRoof) {
    const rt = (sel && sel.roofType) || "";
    let rDetail = "No roof selected", rTotal = 0;
    if (rt) {
      const rc = pick(sel && sel.roofColor, (c) => (rt === "Metal" ? c.metal : c.shingle));
      rTotal = charge(rc);
      rDetail = (sel && sel.roofColor) ? `${rt} — ${sel.roofColor}` : `${rt} — (color TBD)`;
    }
    rows.push({ key: "roof", label: "Roof", detail: rDetail, total: showP ? rTotal : null });
  }
  return rows;
}
// Only allow a design's image_url to be used as a clickable href when it is an
// https Supabase-storage (or same-origin) URL. image_url is stored verbatim by the
// anon-granted save_design RPC, so a hostile caller could stash a javascript: or
// off-site phishing URL; gate it before it reaches an <a href>. Returns null if unsafe. (audit #F8)
function ssSafeUrl(u) {
  try {
    const url = new URL(u, window.location.origin);
    if (url.protocol !== "https:") return null;
    const h = url.hostname;
    return (h === window.location.hostname || h.endsWith(".supabase.co")) ? u : null;
  } catch { return null; }
}

function computeLayoutPricingRows(items, sel, customOptions, C, paintColors) {
  if (!C || !C.showPricing || !C.layoutPricing) return { rows: [] };
  const pricing = C.layoutPricing;
  const styleKey = sel && sel.style;
  // Resolve rate + method for an item_key: a per-style override wins over the default,
  // matching submit-estimate's layoutRates precedence.
  const resolve = (key) => {
    const lp = pricing[key];
    if (!lp) return null;
    const ov = (lp.byStyle && styleKey) ? lp.byStyle[styleKey] : null;
    return {
      rate: Number(ov && ov.rate != null ? ov.rate : lp.rate) || 0,
      method: (ov && ov.method) || lp.method || "each",
    };
  };
  // Building geometry + base price for the building-dependent methods, from the selected
  // size (0 when the size isn't priced/matched — same $0 the estimate would show).
  const szMap = (C.sizePricing && styleKey) ? C.sizePricing[styleKey] : null;
  let szRow = null;
  if (szMap && sel && sel.size) {
    szRow = szMap[sel.size];
    if (!szRow) { const want = normSizeLabel(sel.size); for (const k in szMap) { if (normSizeLabel(k) === want) { szRow = szMap[k]; break; } } }
  }
  const bW = (szRow && szRow.widthFt != null) ? Number(szRow.widthFt) : 0;
  const bL = (szRow && szRow.lengthFt != null) ? Number(szRow.lengthFt) : 0;
  const buildingArea = bW * bL;
  const buildingPerimeter = 2 * (bW + bL);
  const buildingPrice = (szRow && szRow.basePrice != null) ? Number(szRow.basePrice) : 0;

  // Roll placed items into counts + per-measure quantities. Ramps split two ways: CUSTOM ramps
  // (a catalog style with a snapshot price) price like fixture doors; SIMPLE ramps (the built-in
  // ramp) price from the tenant's single ramp price when set, else the legacy layout "ramp" rate.
  const rampSettings = C.rampSettings || null;
  const rampSimplePriced = !!(rampSettings && rampSettings.price != null);
  let singleDoors = 0, doubleDoors = 0, builtinWindows = 0, lofts = 0, loftSqft = 0;
  const workbenchFt = [];
  const customRamps = [], simpleRamps = [];
  const customWindows = [];
  for (const it of items) {
    if (it.type === "singleDoor") singleDoors++;
    else if (it.type === "doubleDoor") doubleDoors++;
    // Catalog windows (own snapshot price) price below like fixture doors; built-in windows
    // (no fixtureItemId) keep pricing via the layout "window" rate.
    else if (it.type === "window") { if (it.fixtureItemId && it.price != null) customWindows.push(it); else builtinWindows++; }
    else if (it.type === "workbench") workbenchFt.push(Number(it.widthFt) || 0);
    else if (it.type === "loft") { lofts++; loftSqft += (Number(it.widthFt) || 0) * (Number(it.heightFt) || 0); }
    else if (it.type === "ramp") { if (it.fixtureItemId && it.price != null) customRamps.push(it); else simpleRamps.push(it); }
  }
  loftSqft = Math.round(loftSqft);
  const totalWorkbenchFt = workbenchFt.reduce((s, f) => s + f, 0);
  const measures = {
    singleDoor: { count: singleDoors },
    doubleDoor: { count: doubleDoors },
    window:     { count: builtinWindows },
    workbench:  { count: workbenchFt.length, lengthFt: totalWorkbenchFt },
    loft:       { count: lofts, optionSqft: loftSqft },
    // Legacy layout "ramp" row applies only to simple ramps that AREN'T priced by the new ramp
    // settings — otherwise ramps price below (custom by snapshot, simple by ramp settings).
    ramp:       { count: rampSimplePriced ? 0 : simpleRamps.length },
  };

  const lineFor = (rate, method, m) => {
    const count = m.count || 0;
    switch (method) {
      case "lineal_ft":          return { qty: m.lengthFt != null ? m.lengthFt : count, total: rate * (m.lengthFt != null ? m.lengthFt : count), unit: fmtMoney2(rate) + " / ft" };
      case "sqft_option":        return { qty: m.optionSqft != null ? m.optionSqft : count, total: rate * (m.optionSqft != null ? m.optionSqft : count), unit: fmtMoney2(rate) + " / sq ft" };
      case "sqft_building":      return { qty: count, total: rate * buildingArea * count, unit: fmtMoney2(rate) + " / sq ft of building" };
      case "perimeter_building": return { qty: count, total: rate * buildingPerimeter * count, unit: fmtMoney2(rate) + " / ft of perimeter" };
      case "pct_building_price": return { qty: count, total: (rate / 100) * buildingPrice * count, unit: rate + "% of building price" };
      case "pct_estimate_total": return { qty: count, total: null, pct: rate, unit: rate + "% of subtotal" };
      case "each":
      default:                   return { qty: count, total: rate * count, unit: fmtMoney2(rate) + " each" };
    }
  };

  // Included quantities for this style+size (part of the base price → not re-charged; only the
  // amount placed BEYOND the inclusion is charged, matching submit-estimate's pushItem).
  const incForRows = (() => {
    const st = (C.buildingStyles || []).find((s) => s.value === styleKey);
    if (!st || !sel || !sel.size) return {};
    const pick = (map) => { if (!map || typeof map !== "object") return null; if (map[sel.size] != null) return map[sel.size]; const want = normSizeLabel(sel.size); for (const k in map) { if (normSizeLabel(k) === want) return map[k]; } return null; };
    const q = pick(st.sizeInclusionQty);
    if (q && typeof q === "object" && !Array.isArray(q)) { const o = {}; for (const k in q) o[k] = Math.max(1, Number(q[k]) || 1); return o; }
    const arr = pick(st.sizeInclusions); const o = {}; if (Array.isArray(arr)) for (const k of arr) o[k] = 1; return o;
  })();

  const rows = [];
  const deferred = [];
  let nonPctSubtotal = 0;
  for (const key of LAYOUT_PRICE_ORDER) {
    const m = measures[key];
    if (!m || !m.count) continue;
    const rp = resolve(key);
    if (!rp) continue;
    const label = (C.layoutItems && C.layoutItems[key] && C.layoutItems[key].label) || (LEGACY_LAYOUT_FALLBACK[key] && LEGACY_LAYOUT_FALLBACK[key].label) || key;
    // Net out the included quantity for this item (loft = sq ft, others = count).
    const inc = incForRows[key] || 0;
    const placedMeasure = rp.method === "lineal_ft" ? (m.lengthFt || 0) : rp.method === "sqft_option" ? (m.optionSqft || 0) : (m.count || 0);
    const chargeable = Math.max(0, placedMeasure - inc);
    if (inc > 0 && chargeable <= 0) {
      rows.push({ key, label: label + " (included)", qty: placedMeasure, unit: "included", total: 0, method: rp.method });
      continue;
    }
    let mNet = m;
    if (inc > 0) mNet = rp.method === "lineal_ft" ? { ...m, lengthFt: chargeable } : rp.method === "sqft_option" ? { ...m, optionSqft: chargeable } : { ...m, count: chargeable };
    const ln = lineFor(rp.rate, rp.method, mNet);
    // Measured inclusions (loft = sq ft, workbench = ft): show the TOTAL placed measure as the
    // row quantity so it reads accurately, but keep charging only the excess beyond the included
    // amount. "each" items (doors/windows) keep the netted count.
    const measured = rp.method === "lineal_ft" || rp.method === "sqft_option";
    const dispQty = (measured && inc > 0) ? placedMeasure : ln.qty;
    // Measured item with an inclusion (loft/workbench): spell out the full calc — placed, included,
    // billable — WORD-FOR-WORD the same as the estimate's loft line, so the two match.
    let unit;
    if (measured && inc > 0) {
      const u2 = rp.method === "sqft_option" ? "sq ft" : "ft";
      unit = [`${placedMeasure} ${u2} placed`, `${inc} ${u2} included in base price`, `${chargeable} ${u2} billable @ ${fmtMoney2(rp.rate)}/${u2}`].join(" · ");
    } else {
      unit = ln.unit;
    }
    const row = { key, label, qty: dispQty, unit, total: ln.total, method: rp.method };
    rows.push(row);
    if (ln.total == null) deferred.push({ row, pct: ln.pct });
    else nonPctSubtotal += ln.total;
  }

  // Catalog fixture doors (Options → Doors): each carries its OWN snapshotted price, not a
  // per-key rate — so they price separately from the layout items above. Identical doors
  // (same name + price + COLORS) collapse into one line with a qty; a color choice splits
  // the group, so its unit price (fixture + color door-rates) stays honest per line.
  //
  // Inclusions are a SHARED POOL per fixture id: incForRows[fid] covers the first N of that
  // door ACROSS color groups (consumed in placement order), because color splits mean one
  // fixture id can span several groups — netting the full inclusion per group would give the
  // inclusion away multiple times. An included unit nets the whole grouped price, color
  // surcharge included (mirrored exactly in submit-estimate so preview == email).
  const doorRateOf = (cid) => {
    if (!cid) return 0;
    const c = (Array.isArray(C.colors) ? C.colors : []).find((x) => x && x.id === cid);
    return c ? (Number(c.doorRate) || 0) : 0;
  };
  // Color door-rates apply only when the CUSTOMER chose the color (paint/match modes). A
  // fixed-color door stamps its color for 3D/description, but its price already includes
  // that one color — charging the paint-a-door rate on top would surprise the owner.
  // submit-estimate applies the same rule from fixture_items.color_mode server-side.
  const doorColorPriced = (fid) => {
    const f = fid ? (Array.isArray(C.fixtures) ? C.fixtures : []).find((x) => x && x.id === fid) : null;
    return !!(f && (f.colorMode === "paint" || f.colorMode === "match"));
  };
  const incRemaining = {};
  const takeIncluded = (fid, qty) => {
    if (!fid || !incForRows[fid]) return 0;
    if (!(fid in incRemaining)) incRemaining[fid] = Number(incForRows[fid]) || 0;
    const take = Math.min(qty, incRemaining[fid]);
    incRemaining[fid] -= take;
    return take;
  };
  const fxGroups = {};
  const fxOrder = [];
  for (const it of items) {
    if (it.type !== "fixtureDoor") continue;
    const price = it.price != null ? Number(it.price) : 0;
    const fid = it.fixtureItemId || `${it.doorName || "Door"}|${price}`;
    const gk = `${fid}|${it.colorId || ""}|${it.trimColorId || ""}`;
    if (!fxGroups[gk]) {
      const colorBits = [it.colorLabel, it.trimColorLabel ? `${it.trimColorLabel} trim` : null].filter(Boolean);
      const priced = doorColorPriced(it.fixtureItemId);
      fxGroups[gk] = {
        label: (it.doorName || "Door") + (colorBits.length ? ` — ${colorBits.join(" / ")}` : ""),
        price: price + (priced ? doorRateOf(it.colorId) + doorRateOf(it.trimColorId) : 0),
        qty: 0, fid: it.fixtureItemId || null,
      };
      fxOrder.push(gk);
    }
    fxGroups[gk].qty++;
  }
  for (const gk of fxOrder) {
    const g = fxGroups[gk];
    const inc = takeIncluded(g.fid, g.qty);
    const chargeable = Math.max(0, g.qty - inc);
    if (g.price > 0 && inc > 0 && chargeable <= 0) {
      rows.push({ key: `fx:${gk}`, label: g.label + " (included)", qty: g.qty, unit: "included", total: 0, method: "each" });
      continue;
    }
    if (!(g.price > 0)) continue;   // $0 / unpriced = free, no line
    const total = Math.round(g.price * chargeable * 100) / 100;
    rows.push({ key: `fx:${gk}`, label: g.label, qty: chargeable, unit: fmtMoney2(g.price) + " each" + (inc > 0 ? ` · ${inc} included` : ""), total, method: "each" });
    nonPctSubtotal += total;
  }

  // Catalog windows (Options → Windows): each carries its OWN snapshot price, grouped by
  // style + color like doors (unit = window price + the color's flat per-window rate).
  // Built-in windows already priced above via the layout "window" rate. Same shared
  // inclusion pool per fixture id as doors.
  const windowRateOf = (cid) => {
    if (!cid) return 0;
    const c = (Array.isArray(C.windowColors) ? C.windowColors : []).find((x) => x && x.id === cid);
    return c ? (Number(c.rate) || 0) : 0;
  };
  const winGroups = {};
  const winOrder = [];
  for (const it of customWindows) {
    const price = it.price != null ? Number(it.price) : 0;
    const fid = it.fixtureItemId || `${it.windowName || "Window"}|${price}`;
    const gk = `${fid}|${it.colorId || ""}`;
    if (!winGroups[gk]) {
      winGroups[gk] = {
        label: (it.windowName || "Window") + (it.colorLabel ? ` — ${it.colorLabel}` : ""),
        price: price + windowRateOf(it.colorId),
        qty: 0, fid: it.fixtureItemId || null,
      };
      winOrder.push(gk);
    }
    winGroups[gk].qty++;
  }
  for (const gk of winOrder) {
    const g = winGroups[gk];
    const inc = takeIncluded(g.fid, g.qty);
    const chargeable = Math.max(0, g.qty - inc);
    if (g.price > 0 && inc > 0 && chargeable <= 0) {
      rows.push({ key: `win:${gk}`, label: g.label + " (included)", qty: g.qty, unit: "included", total: 0, method: "each" });
      continue;
    }
    if (!(g.price > 0)) continue;   // $0 / unpriced = free, no line
    const total = Math.round(g.price * chargeable * 100) / 100;
    rows.push({ key: `win:${gk}`, label: g.label, qty: chargeable, unit: fmtMoney2(g.price) + " each" + (inc > 0 ? ` · ${inc} included` : ""), total, method: "each" });
    nonPctSubtotal += total;
  }

  // Catalog ramps (Options → Ramps). Custom ramps carry their own snapshot price (grouped by
  // style like doors); simple ramps price from the tenant's single ramp price — "each" per ramp,
  // or "per_ft" × the attached door's width. Both feed the % base like any add-on.
  const rampGroups = {};
  for (const it of customRamps) {
    const price = it.price != null ? Number(it.price) : 0;
    const fid = it.fixtureItemId || `${it.rampName || "Ramp"}|${price}`;
    if (!rampGroups[fid]) rampGroups[fid] = { label: it.rampName || "Ramp", price, qty: 0, fid: it.fixtureItemId || null };
    rampGroups[fid].qty++;
  }
  for (const fid in rampGroups) {
    const g = rampGroups[fid];
    const inc = (g.fid && incForRows[g.fid]) ? Number(incForRows[g.fid]) : 0;
    const chargeable = Math.max(0, g.qty - inc);
    if (g.price > 0 && inc > 0 && chargeable <= 0) {
      rows.push({ key: `ramp:${fid}`, label: g.label + " (included)", qty: g.qty, unit: "included", total: 0, method: "each" });
      continue;
    }
    if (!(g.price > 0)) continue;   // $0 / unpriced = free, no line
    const total = Math.round(g.price * chargeable * 100) / 100;
    rows.push({ key: `ramp:${fid}`, label: g.label, qty: chargeable, unit: fmtMoney2(g.price) + " each" + (inc > 0 ? ` · ${inc} included` : ""), total, method: "each" });
    nonPctSubtotal += total;
  }
  if (rampSimplePriced && simpleRamps.length) {
    const rampPrice = Number(rampSettings.price) || 0;
    const perFt = rampSettings.method === "per_ft";
    if (rampPrice > 0) {
      if (perFt) {
        // Price per foot of the attached door's width. fixture doors carry their real width
        // (widthIn); built-in doors fall back to the ramp's stored widthFt.
        let totalFt = 0;
        for (const r of simpleRamps) {
          const door = items.find((d) => d.id === r.snapDoorId);
          let dw = Number(r.widthFt) || 0;
          if (door && door.type === "fixtureDoor" && door.widthIn) dw = Number(door.widthIn) / 12;
          totalFt += dw;
        }
        totalFt = Math.round(totalFt * 100) / 100;
        if (totalFt > 0) { const total = Math.round(rampPrice * totalFt * 100) / 100; rows.push({ key: "ramp:simple", label: "Ramp", qty: totalFt, unit: fmtMoney2(rampPrice) + " / ft", total, method: "lineal_ft" }); nonPctSubtotal += total; }
      } else {
        const total = Math.round(rampPrice * simpleRamps.length * 100) / 100;
        rows.push({ key: "ramp:simple", label: "Ramp", qty: simpleRamps.length, unit: fmtMoney2(rampPrice) + " each", total, method: "each" });
        nonPctSubtotal += total;
      }
    }
  }

  // Resolve pct_estimate_total rows LAST against the same base the edge function uses:
  // building (NET of declined-item credits — submit-estimate bakes them into the
  // building line BEFORE the % pass) + paint/roof + all non-% add-ons + rough
  // openings + custom options (delivery excluded, matching submit-estimate).
  if (deferred.length) {
    const roRate = (resolve("roughOpening") || { rate: 0 }).rate;
    const roCount = items.filter((i) => i.type === "roughOpening").length;
    const customTotal = (customOptions || []).reduce((s, co) => {
      if (!co || !co.name || !String(co.name).trim()) return s;
      const amt = parseFloat(co.amount) || 0;
      const q = co.qty ? Math.abs(parseInt(co.qty, 10)) || 1 : 1; // abs: the edge bills |qty|
      // Only POSITIVE custom options are line items in the % base; negatives are
      // credits applied outside it, matching submit-estimate.
      return s + Math.max(0, amt) * q;
    }, 0);
    // Paint + roof color charges are line items too, so the % base must include
    // them exactly as submit-estimate does — otherwise the previewed % line is
    // lower than the emailed estimate.
    const selRowsForBase = computeSelectionRows(sel, paintColors, C, items);
    const selectionTaxable = selRowsForBase
      .filter((r) => r.key === "paint" || r.key === "roof")
      .reduce((s, r) => s + (Number(r.total) || 0), 0);
    const buildingRow = selRowsForBase.find((r) => r.key === "building");
    const netBuilding = buildingRow && buildingRow.total != null ? Number(buildingRow.total) : buildingPrice;
    const base = netBuilding + selectionTaxable + nonPctSubtotal + roRate * roCount + customTotal;
    for (const d of deferred) d.row.total = (d.pct / 100) * base * (d.row.qty || 1); // ×count: the server bills GHL line = qty×amount, so the preview must scale by count too or it under-shows (audit #F1)
  }

  // (Declined included items are no longer shown here — they're itemized under the building line
  // by computeSelectionRows, matching the GHL estimate.)
  return { rows };
}

// Which placed items does a Details "Options on your plan" row cover? Built-in rows key by
// the item TYPE, but catalog rows carry synthetic keys — fx:/win:/ramp:<fixture id, or the
// "name|price" fallback> and "ramp:simple" — that match no item's type, and the layout
// "window"/"ramp" rows mean only the BUILT-IN subset (catalog ones price on their own rows).
// The row's × button and pick-one-to-remove mode both need this mapping; matching on
// `i.type === key` made the × a silent no-op for every catalog row — the customer could not
// remove a charged item from Details and might submit believing they had (audit 2026-08-20).
// Mirrors the grouping in computeLayoutPricingRows above — keep the two in sync.
function priceRowMatcher(key) {
  const isCatalog = (i) => !!i.fixtureItemId && i.price != null;   // same test the grouping uses
  if (key === "window") return (i) => i.type === "window" && !isCatalog(i);
  if (key === "ramp" || key === "ramp:simple") return (i) => i.type === "ramp" && !isCatalog(i);
  const sep = key.indexOf(":");
  if (sep < 0) return (i) => i.type === key;
  const kind = key.slice(0, sep), fid = key.slice(sep + 1);
  // Group id exactly as the row was built: the fixture id when the snapshot carries one,
  // else the name|price fallback (String(): the row key came from template interpolation).
  const gid = (i, name) => String(i.fixtureItemId || `${name}|${i.price != null ? Number(i.price) : 0}`);
  // Door/window keys carry trailing color segments (`fid|colorId|trimColorId` /
  // `fid|colorId`) since a color choice splits the group. Split from the RIGHT — the
  // name|price fallback fid itself contains a "|".
  if (kind === "fx") {
    const p2 = fid.lastIndexOf("|"), p1 = fid.lastIndexOf("|", p2 - 1);
    const gfid = fid.slice(0, p1), cId = fid.slice(p1 + 1, p2), tId = fid.slice(p2 + 1);
    return (i) => i.type === "fixtureDoor" && gid(i, i.doorName || "Door") === gfid
      && String(i.colorId || "") === cId && String(i.trimColorId || "") === tId;
  }
  if (kind === "win") {
    const p1 = fid.lastIndexOf("|");
    const gfid = fid.slice(0, p1), cId = fid.slice(p1 + 1);
    return (i) => i.type === "window" && isCatalog(i) && gid(i, i.windowName || "Window") === gfid
      && String(i.colorId || "") === cId;
  }
  if (kind === "ramp") return (i) => i.type === "ramp" && isCatalog(i) && gid(i, i.rampName || "Ramp") === fid;
  return () => false;
}

let idCounter = 1;

// 10-char short code in format SS-XXXXXXXXXX. Alphabet drops 0/O/I/1 to avoid
// look-alikes when read aloud or shared. 32^10 ≈ 2^50 combinations — the code is
// the capability for loading/saving a design via the RPCs, so it must not be
// guessable. (Legacy 6-char codes from before the RPC data path still load fine.)
const _SHORT_ALPHA = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
function genShortCode() {
  let s = "";
  for (let i = 0; i < 10; i++) s += _SHORT_ALPHA[Math.floor(Math.random() * _SHORT_ALPHA.length)];
  return `SS-${s}`;
}

// Pick readable text for a tenant-accent background: dark slate on light accents
// (mint, yellow), white on dark ones (navy, barn red). WCAG relative luminance,
// hex-only — the codebase already assumes hex accents (see the `${accent}50` shadows).
function textOnAccent(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex || "").trim());
  if (!m) return "#FFFFFF";
  const [r, g, b] = [0, 2, 4].map((i) => {
    const c = parseInt(m[1].slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b > 0.4 ? "#1E293B" : "#FFFFFF";
}

// Progressive US phone formatter: "8163003600" -> "(816) 300-3600".
// Caps at 10 digits; partial inputs format as "(816", "(816) 30", etc.
// Display only — strip back to digits before sending to GHL.
// Display formatter for the customer's phone field. Also the onChange transform, so
// whatever this returns is what gets STORED in designs.contact and read by every
// downstream matcher.
//
// 🚨 IT USED TO DESTROY DATA. The old body opened with:
//
//     const d = (v || "").replace(/\D/g, "").slice(0, 10);
//
// On an eleven-digit number typed with its country code, `slice(0, 10)` keeps the
// leading 1 as the start of the area code and THROWS THE LAST DIGIT AWAY:
//
//     "+1 707 362 5667"  ->  digits 17073625667  ->  sliced 1707362566  ->  "(170) 736-2566"
//
// The number is not merely formatted oddly, it is unrecoverable — the final digit exists
// nowhere in the row afterwards. Two live contacts were found in this state on 2026-08-25
// when migration 130's backfill grouped designs by phone and the same person appeared
// twice, once under each spelling. Any note or activity written against a contact would
// have landed on whichever of their two rows they happened to create that day.
//
// The rules below are ported from `formatPhone` in the portal, which has always been
// correct. They are duplicated rather than shared because the portal and the designer are
// separate bundles with no common scope; if a third caller ever appears, that is the point
// to lift this into a shared module rather than copy it again.
//
// The load-bearing change is that there is NO TRUNCATION anywhere. Anything this cannot
// confidently format is returned untouched, because passing a number through unstyled is
// recoverable and silently shortening one is not.
function formatPhoneDisplay(v) {
  const raw = String(v == null ? "" : v);
  const t = raw.trim();
  // An explicit non-US country code: leave it completely alone. A US mask applied to a UK
  // or Mexican number produces something that looks valid and is not.
  if (/^\+/.test(t) && !/^\+\s*1\b/.test(t) && !/^\+\s*1\d/.test(t)) return raw;
  const plus1Typed = /^\+\s*1/.test(t);
  let d = raw.replace(/\D/g, "");
  let cc = false;
  if (plus1Typed && d[0] === "1") { d = d.slice(1); cc = true; }
  else if (d.length === 11 && d[0] === "1") { d = d.slice(1); cc = true; }
  // Still too long after removing a country code — an extension, a typo, or a format we do
  // not know. Hand it back verbatim. This is the line the old version did not have.
  if (d.length > 10) return raw;
  const p = cc ? "+1 " : "";
  if (!d) return cc ? "+1 " : "";
  if (d.length <= 3) return p + d;
  if (d.length <= 6) return `${p}(${d.slice(0, 3)}) ${d.slice(3)}`;
  return `${p}(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}`;
}

// Lazy-load Google Maps JS API via the official inline bootstrap loader. Resolves
// to window.google. Rejects if no key. Idempotent: returns the same promise on
// subsequent calls.
//
// The bootstrap snippet (from Google's docs) synchronously installs
// window.google.maps.importLibrary, then defers the actual script download until
// importLibrary is first called. This is the only supported way to reach
// PlaceAutocompleteElement and other Places API (New) entry points; passing
// loading=async or libraries=places in the URL is NOT enough to expose
// importLibrary in practice.
// See: https://developers.google.com/maps/documentation/javascript/load-maps-js-api
let _googleMapsLoadPromise = null;
function loadGoogleMapsPlaces(apiKey) {
  if (typeof window === "undefined") return Promise.reject(new Error("no window"));
  if (!apiKey) return Promise.reject(new Error("Google Maps API key not configured"));
  if (window.google && window.google.maps && typeof window.google.maps.importLibrary === "function") {
    return Promise.resolve(window.google);
  }
  if (_googleMapsLoadPromise) return _googleMapsLoadPromise;
  _googleMapsLoadPromise = new Promise((resolve, reject) => {
    try {
      ((g)=>{var h,a,k,p="The Google Maps JavaScript API",c="google",l="importLibrary",q="__ib__",m=document,b=window;b=b[c]||(b[c]={});var d=b.maps||(b.maps={}),r=new Set,e=new URLSearchParams,u=()=>h||(h=new Promise(async(f,n)=>{await (a=m.createElement("script"));e.set("libraries",[...r]+"");for(k in g)e.set(k.replace(/[A-Z]/g,t=>"_"+t[0].toLowerCase()),g[k]);e.set("callback",c+".maps."+q);a.src=`https://maps.${c}apis.com/maps/api/js?`+e;d[q]=f;a.onerror=()=>h=n(Error(p+" could not load."));a.nonce=m.querySelector("script[nonce]")?.nonce||"";m.head.append(a)}));d[l]?console.warn(p+" only loads once. Ignoring:",g):d[l]=(f,...n)=>r.add(f)&&u().then(()=>d[l](f,...n))})({key: apiKey, v: "weekly"});
      resolve(window.google);
    } catch (err) {
      _googleMapsLoadPromise = null;
      reject(err);
    }
  });
  return _googleMapsLoadPromise;
}

// ─── Per-option building-style scoping ───
// An option may declare `buildingStyles: ["Urban", "Northwood"]` to limit when
// it's shown. Without that field (or with an empty array) the option always
// applies. Unrestricted options also show before any style is picked; scoped
// options hide until the user picks a style they target.
function isOptionApplicable(opt, styleValue) {
  if (!opt || !Array.isArray(opt.buildingStyles) || opt.buildingStyles.length === 0) return true;
  return !!styleValue && opt.buildingStyles.includes(styleValue);
}

// ─── 3D VIEW ENGINE ───
// Parametric 3D: every mesh below is computed from the same layout/catalog state
// the 2D plan renders from (bldgW/bldgH in feet, items in page coordinates, style
// + paint selections). No model assets, no 3D SaaS — Three.js (MIT) is lazy-loaded
// as a browser-native ES module only when the customer opens the 3D view, so the
// initial page load pays nothing. See STRUCTURESTUDIO_3D_PLAN.md.
const THREE_VERSION = "0.167.0";
// Browser-native dynamic import via Function indirection. The import() KEYWORD
// can't appear in this shared component body: Babel-standalone (index.html)
// rewrites it to an async require() wrapper that explodes at call time, and
// bundlers try to resolve the URL at build time. Constructing the import inside
// a Function keeps it invisible to both — the browser runs the real thing.
// (index.html already needs eval for Babel itself, so no new CSP constraint.)
function nativeImport(u) {
  return new Function("u", "return import(u)")(u);
}
let _threeLoadPromise = null;
function loadThree() {
  if (_threeLoadPromise) return _threeLoadPromise;
  const base = `https://esm.sh/three@${THREE_VERSION}`;
  _threeLoadPromise = Promise.all([
    nativeImport(`${base}`),
    nativeImport(`${base}/examples/jsm/controls/OrbitControls.js`),
  ]).then(([THREE, oc]) => ({ THREE, OrbitControls: oc.OrbitControls }))
    .catch((err) => { _threeLoadPromise = null; throw err; });
  return _threeLoadPromise;
}

// ─── Building scan (094): read a phone LiDAR export, measure it, keep the parametric model ───
// A scan is a REFERENCE, never the customer-facing model. The file is one fused shell of
// triangles with no idea which part is a wall, so it cannot be edited, priced or quoted. What
// it IS good for is measurements — LiDAR output is metric — and, later, appearance. So we
// measure it and drive the parametric building from the numbers.
//
// Loaded separately from loadThree so a shopper opening the 3D view never pays for it. The
// esm.sh specifier MUST interpolate the same fully-pinned THREE_VERSION: the subpath build
// imports three by a RELATIVE path inside its own version directory, so an exact match is what
// guarantees ONE three instance. A looser range (three@0.167 resolves to 0.167.1) or
// ?external=three (emits a bare "three" specifier these no-build pages cannot resolve) both
// break instanceof in ways that surface as nonsense errors.
let _gltfLoadPromise = null;
function loadGLTFLoader() {
  if (_gltfLoadPromise) return _gltfLoadPromise;
  const base = `https://esm.sh/three@${THREE_VERSION}`;
  _gltfLoadPromise = loadThree()
    .then((bundle) => nativeImport(`${base}/examples/jsm/loaders/GLTFLoader.js`)
      .then((m) => ({ THREE: bundle.THREE, GLTFLoader: m.GLTFLoader })))
    .catch((err) => { _gltfLoadPromise = null; throw err; });
  return _gltfLoadPromise;
}

const SCAN_MAX_BYTES = 60 * 1024 * 1024;   // matches the models bucket cap in 094
const M_TO_FT = 1 / 0.3048;

// Cheap gate BEFORE any WebGL or geometry decode: the GLB container is a 12-byte header then
// length-prefixed chunks, and the JSON chunk alone (a few hundred KB of a 40 MB file) answers
// every question worth refusing on. Runs on any phone — no three.js, no GPU.
function scanInspectGlb(buf) {
  const dv = new DataView(buf);
  if (buf.byteLength < 20) return { err: "That file is too small to be a scan." };
  if (dv.getUint32(0, true) !== 0x46546C67) return { err: "That is not a .glb file — its header does not say glTF. Re-export as GLB." };
  const version = dv.getUint32(4, true);
  if (version !== 2) return { err: `That scan is glTF version ${version}; this needs version 2. Re-export as GLB 2.0.` };
  let off = 12, json = null;
  while (off + 8 <= buf.byteLength) {
    const len = dv.getUint32(off, true), type = dv.getUint32(off + 4, true);
    const start = off + 8;
    if (start + len > buf.byteLength) break;
    if (type === 0x4E4F534A) { json = new TextDecoder().decode(new Uint8Array(buf, start, len)); break; }
    off = start + len + ((4 - (len % 4)) % 4);
  }
  if (!json) return { err: "That scan has no readable glTF data." };
  let doc;
  try { doc = JSON.parse(json); } catch (_e) { return { err: "That scan's glTF data is malformed." }; }
  // Compression extensions need decoder modules we deliberately do not ship. Saying which
  // export setting to change beats a stack trace from inside the loader.
  const needed = [].concat(doc.extensionsRequired || [], doc.extensionsUsed || []);
  const hard = ["KHR_draco_mesh_compression", "EXT_meshopt_compression", "KHR_texture_basisu"];
  const hit = hard.find((x) => needed.indexOf(x) !== -1);
  if (hit) return { err: `That scan uses ${hit}, which needs a decoder we don't load. Re-export it without compression (Draco/meshopt) or texture compression.` };
  // A GLB may legally point at external files. One that does would fire cross-origin fetches
  // and arrive half-empty, so refuse it rather than measure a partial building.
  const ext = []
    .concat((doc.buffers || []).map((b) => b && b.uri), (doc.images || []).map((i) => i && i.uri))
    .filter((u) => typeof u === "string" && !/^data:/i.test(u));
  if (ext.length) return { err: "That export references separate files. Re-export as a single self-contained GLB." };
  return { doc };
}

// Sample points ON THE SURFACE, area-weighted, not at the vertices. This is the correction
// that makes the whole thing work: occupancy and density are surface properties, and a scan
// exporter is free to emit a few huge triangles, so iterating POSITION would put four points
// on a whole wall and every histogram below would read noise. Triangle interiors sampled in
// proportion to area give a density that means something regardless of tessellation.
function scanSamplePoints(THREE, root, budget) {
  root.updateMatrixWorld(true);
  const meshes = [];
  root.traverse((o) => { if (o.isMesh && o.geometry && o.geometry.getAttribute("position")) meshes.push(o); });
  if (!meshes.length) return null;
  const tri = [], areas = [];
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
  const ab = new THREE.Vector3(), ac = new THREE.Vector3(), cr = new THREE.Vector3();
  let total = 0;
  for (const m of meshes) {
    const pos = m.geometry.getAttribute("position");
    const idx = m.geometry.getIndex();
    const n = idx ? idx.count : pos.count;
    for (let i = 0; i + 2 < n; i += 3) {
      const i0 = idx ? idx.getX(i) : i, i1 = idx ? idx.getX(i + 1) : i + 1, i2 = idx ? idx.getX(i + 2) : i + 2;
      a.fromBufferAttribute(pos, i0).applyMatrix4(m.matrixWorld);
      b.fromBufferAttribute(pos, i1).applyMatrix4(m.matrixWorld);
      c.fromBufferAttribute(pos, i2).applyMatrix4(m.matrixWorld);
      ab.subVectors(b, a); ac.subVectors(c, a);
      const area = cr.crossVectors(ab, ac).length() * 0.5;
      if (!(area > 0)) continue;
      tri.push(a.x, a.y, a.z, b.x, b.y, b.z, c.x, c.y, c.z);
      areas.push(area); total += area;
    }
  }
  if (!tri.length || !(total > 0)) return null;
  const want = Math.max(2000, Math.min(budget || 120000, 200000));
  const pts = new Float64Array(want * 3);
  let k = 0;
  for (let t = 0; t < areas.length && k < want; t++) {
    // Proportional allocation, with every triangle guaranteed at least one point so a small
    // but meaningful face (a gable end) is never sampled away entirely.
    let take = Math.max(1, Math.round((areas[t] / total) * want));
    const o = t * 9;
    for (let s = 0; s < take && k < want; s++) {
      let u = Math.random(), v = Math.random();
      if (u + v > 1) { u = 1 - u; v = 1 - v; }           // fold into the triangle
      const w = 1 - u - v;
      pts[k * 3]     = tri[o] * w + tri[o + 3] * u + tri[o + 6] * v;
      pts[k * 3 + 1] = tri[o + 1] * w + tri[o + 4] * u + tri[o + 7] * v;
      pts[k * 3 + 2] = tri[o + 2] * w + tri[o + 5] * u + tri[o + 8] * v;
      k++;
    }
  }
  return { pts, count: k, triangles: areas.length, area: total };
}

// Turn sampled surface points into the handful of numbers the parametric model needs, all in
// METRES until the single conversion at the end. The sequence matters: find the ground before
// any height, because bbox.min.y is always some artefact (a curb, drift, a dark hole) and
// using it puts every height 10-40 cm out.
function scanMeasure(sample) {
  const { pts, count } = sample;
  if (!count) return { err: "That scan has no geometry to measure." };
  let minY = Infinity, maxY = -Infinity;
  for (let i = 0; i < count; i++) { const y = pts[i * 3 + 1]; if (y < minY) minY = y; if (y > maxY) maxY = y; }
  const span = maxY - minY;
  if (!(span > 0.5)) return { err: "That scan is too flat to be a building." };

  // GROUND = the densest horizontal slab in the lower part of the scan. In any yard capture
  // that is the ground, and it is far more reliable than the lowest point.
  const BIN = 0.02, lowCut = minY + span * 0.4;
  const bins = new Map();
  for (let i = 0; i < count; i++) {
    const y = pts[i * 3 + 1];
    if (y > lowCut) continue;
    const k = Math.floor((y - minY) / BIN);
    bins.set(k, (bins.get(k) || 0) + 1);
  }
  // Best 3-bin WINDOW, not single bin: a real lawn undulates a few centimetres,
  // spreading the ground across neighbouring bins; a flat synthetic ground
  // dominates any window with one bin, so fixtures measure identically.
  let bestBin = -1, bestN = 0;
  bins.forEach((n, k) => {
    const w3 = n + (bins.get(k - 1) || 0) + (bins.get(k + 1) || 0);
    if (w3 > bestN) { bestN = w3; bestBin = k; }
  });
  const ground = bestBin >= 0 ? minY + (bestBin + 0.5) * BIN : minY;

  // WAIST CUT kills most junk for free: ground, grass, driveway, low clutter, the operator's
  // feet. What is left is the building (plus anything tall next to it, which is why the
  // builder confirms the numbers rather than us trusting them).
  const waist = ground + 1.2;
  let wall = [];
  for (let i = 0; i < count; i++) {
    const y = pts[i * 3 + 1];
    if (y >= waist) wall.push(pts[i * 3], y, pts[i * 3 + 2]);
  }
  let wn = wall.length / 3;
  if (wn < 50) return { err: "That scan does not have enough of a building above ground level to measure." };
  const warnFlags = [];

  // COMPONENT ISOLATION: a fence, parked truck or tree clears the waist cut
  // but does not touch the building. Rasterise the waist-up points onto a
  // 15 cm plan grid, flood-fill 8-connected occupied cells, keep the biggest
  // island. If that island holds under 60% of the points the scan is probably
  // sparse/hole-riddled rather than cluttered — measure everything and warn,
  // instead of silently measuring a fragment.
  {
    const CELL = 0.15;
    let mnx = Infinity, mnz = Infinity, mxx = -Infinity, mxz = -Infinity;
    for (let i = 0; i < wn; i++) {
      const x = wall[i * 3], z = wall[i * 3 + 2];
      if (x < mnx) mnx = x; if (x > mxx) mxx = x;
      if (z < mnz) mnz = z; if (z > mxz) mxz = z;
    }
    const gw = Math.max(1, Math.min(4096, Math.ceil((mxx - mnx) / CELL) + 1));
    const gh = Math.max(1, Math.min(4096, Math.ceil((mxz - mnz) / CELL) + 1));
    if (gw * gh <= 2000000) {
      const counts = new Int32Array(gw * gh);
      const cellIdx = new Int32Array(wn);
      for (let i = 0; i < wn; i++) {
        const cx = Math.min(gw - 1, Math.max(0, Math.floor((wall[i * 3] - mnx) / CELL)));
        const cz = Math.min(gh - 1, Math.max(0, Math.floor((wall[i * 3 + 2] - mnz) / CELL)));
        const idx = cz * gw + cx;
        cellIdx[i] = idx;
        counts[idx]++;
      }
      const label = new Int32Array(gw * gh);          // 0 = unvisited/empty
      const occupied = (idx) => counts[idx] >= 3;
      let nextLabel = 0;
      const labelPts = [];                             // points per label (1-based)
      const stack = [];
      for (let seed = 0; seed < gw * gh; seed++) {
        if (label[seed] || !occupied(seed)) continue;
        nextLabel++;
        let acc = 0;
        stack.length = 0;
        stack.push(seed);
        label[seed] = nextLabel;
        while (stack.length) {
          const c = stack.pop();
          acc += counts[c];
          const cx = c % gw, cz = (c / gw) | 0;
          for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) {
            if (!dx && !dz) continue;
            const nx = cx + dx, nz = cz + dz;
            if (nx < 0 || nz < 0 || nx >= gw || nz >= gh) continue;
            const nIdx = nz * gw + nx;
            if (!label[nIdx] && occupied(nIdx)) { label[nIdx] = nextLabel; stack.push(nIdx); }
          }
        }
        labelPts[nextLabel] = acc;
      }
      let bestLabel = 0, bestPts = 0;
      for (let l = 1; l <= nextLabel; l++) { if (labelPts[l] > bestPts) { bestPts = labelPts[l]; bestLabel = l; } }
      if (bestLabel && bestPts >= wn * 0.6) {
        const keep = [];
        for (let i = 0; i < wn; i++) {
          if (label[cellIdx[i]] === bestLabel) keep.push(wall[i * 3], wall[i * 3 + 1], wall[i * 3 + 2]);
        }
        if (keep.length >= 150) { wall = keep; wn = keep.length / 3; }
      } else if (bestLabel && bestPts < wn * 0.6) {
        warnFlags.push("scattered");
      }
    }
  }

  // ORIENTED footprint. A phone's X/Z axes are wherever the AR session happened to start, so a
  // building at an angle to them has an axis-aligned box up to 41% too big in BOTH directions.
  // Sweep the yaw and keep the angle whose rectangle is smallest.
  let bestA = 0, bestArea = Infinity, bestW = 0, bestD = 0;
  for (let deg = 0; deg < 90; deg += 1) {
    const t = deg * Math.PI / 180, cs = Math.cos(t), sn = Math.sin(t);
    let lo1 = Infinity, hi1 = -Infinity, lo2 = Infinity, hi2 = -Infinity;
    for (let i = 0; i < wn; i++) {
      const x = wall[i * 3], z = wall[i * 3 + 2];
      const u = x * cs + z * sn, v = -x * sn + z * cs;
      if (u < lo1) lo1 = u; if (u > hi1) hi1 = u;
      if (v < lo2) lo2 = v; if (v > hi2) hi2 = v;
    }
    const w = hi1 - lo1, d = hi2 - lo2, area = w * d;
    if (area < bestArea) { bestArea = area; bestA = t; bestW = w; bestD = d; }
  }

  // EAVE vs PEAK from a SPAN profile in the building's own axes. Span, not cross-sectional
  // area: a scan is a hollow shell full of holes (windows, the doorway, drop-out where
  // tracking failed), so any area/flood-fill measure collapses at a random height. Walls hold
  // their span; a roof narrows. The axis that collapses names the ridge, which gives the roof
  // type for free.
  const cs = Math.cos(bestA), sn = Math.sin(bestA);
  const peak = maxY;
  const BAND = 0.05;
  const nb = Math.max(1, Math.ceil((peak - waist) / BAND));
  // PERCENTILE band spans (P98-P2), not min/max: doubled shells, stray tracking
  // points and speckle otherwise widen every band, and the widened bands are
  // exactly what the wall/eave/overhang separations below have to read.
  const cnt = new Int32Array(nb);
  const bandOf = new Int32Array(wn);
  for (let i = 0; i < wn; i++) {
    const bi = Math.min(nb - 1, Math.max(0, Math.floor((wall[i * 3 + 1] - waist) / BAND)));
    bandOf[i] = bi; cnt[bi]++;
  }
  const bu = new Array(nb), bv = new Array(nb), fill = new Int32Array(nb);
  for (let b = 0; b < nb; b++) { if (cnt[b]) { bu[b] = new Float64Array(cnt[b]); bv[b] = new Float64Array(cnt[b]); } }
  for (let i = 0; i < wn; i++) {
    const b = bandOf[i];
    const x = wall[i * 3], z = wall[i * 3 + 2];
    bu[b][fill[b]] = x * cs + z * sn;
    bv[b][fill[b]] = -x * sn + z * cs;
    fill[b]++;
  }
  const su = new Float64Array(nb), sv = new Float64Array(nb);
  const suWide = new Float64Array(nb), svWide = new Float64Array(nb);
  const uMid = new Float64Array(nb), vMid = new Float64Array(nb);
  for (let b = 0; b < nb; b++) {
    if (cnt[b] < 5) continue;
    bu[b].sort(); bv[b].sort();
    const p2 = Math.floor(0.02 * (cnt[b] - 1)), p98 = Math.ceil(0.98 * (cnt[b] - 1));
    su[b] = bu[b][p98] - bu[b][p2]; uMid[b] = (bu[b][p98] + bu[b][p2]) / 2;
    sv[b] = bv[b][p98] - bv[b][p2]; vMid[b] = (bv[b][p98] + bv[b][p2]) / 2;
    // A wider read (P99.9) for the OVERHANG bands only: the roof's outer rim
    // is by construction the extreme of its band, and the 2% trim shaved a
    // real 6 cm off it. Everything structural stays on the trimmed spans.
    const p01 = Math.floor(0.001 * (cnt[b] - 1)), p999 = Math.ceil(0.999 * (cnt[b] - 1));
    suWide[b] = bu[b][p999] - bu[b][p01];
    svWide[b] = bv[b][p999] - bv[b][p01];
  }

  // WALL FOOTPRINT from the lowest wall bands, NOT the all-points sweep box:
  // on any real building the roof overhangs the walls, so the sweep rectangle
  // is the ROOF footprint - width and depth came out 2x the overhang too big,
  // and the customer's building grew a size. The waist sits at 1.2m, safely
  // under the overhang shadow of any wall a person can stand next to.
  const lowBands = [];
  for (let b = 0; b < nb && lowBands.length < 6; b++) { if (cnt[b] >= 5) lowBands.push(b); }
  if (!lowBands.length) return { err: "That scan does not have enough of a building above ground level to measure." };
  const med = (arr) => { const s = arr.slice().sort((a, q) => a - q); return s[(s.length - 1) >> 1]; };
  const wallU = med(lowBands.map((b) => su[b]));
  const wallV = med(lowBands.map((b) => sv[b]));

  // WALL TOP band walk with an UPPER bound too: near the eave the overhanging
  // roof edge widens the band past the wall span, and the old ">= 92% only"
  // rule happily called those roof bands "wall".
  let wallTopBand = lowBands[0];
  for (let b = 0; b < nb; b++) {
    if (cnt[b] < 5) continue;
    if (su[b] >= wallU * 0.92 && su[b] <= wallU * 1.06 && sv[b] >= wallV * 0.92 && sv[b] <= wallV * 1.06) wallTopBand = b;
  }
  let eaveY = waist + (wallTopBand + 1) * BAND;      // band-walk estimate; refined below

  // Ridge axis: the axis that KEEPS its span above the wall top holds the ridge.
  let uTop = 0, vTop = 0, tn = 0;
  for (let b = wallTopBand + 1; b < nb; b++) { if (cnt[b] < 5) continue; uTop += su[b]; vTop += sv[b]; tn++; }
  if (tn) { uTop /= tn; vTop /= tn; }
  const ridgeAlongU = uTop >= vTop;
  const wallAcross = ridgeAlongU ? wallV : wallU;
  const wallAlong = ridgeAlongU ? wallU : wallV;

  // Roof bands: everything clearly above the wall top.
  const roofY = [], roofS = [], roofAlong = [], roofMid = [];
  for (let b = wallTopBand + 2; b < nb; b++) {
    if (cnt[b] < 5) continue;
    const sp = ridgeAlongU ? sv[b] : su[b];
    if (!(sp > 0)) continue;
    roofY.push(waist + (b + 0.5) * BAND);
    roofS.push(sp);
    roofAlong.push(ridgeAlongU ? su[b] : sv[b]);
    roofMid.push(ridgeAlongU ? vMid[b] : uMid[b]);
  }
  const lsFit = (xs, ys, i0, i1) => {   // least squares over [i0, i1)
    let n = 0, sx = 0, sy = 0, sxx = 0, sxy = 0;
    for (let i = i0; i < i1; i++) { n++; sx += xs[i]; sy += ys[i]; sxx += xs[i] * xs[i]; sxy += xs[i] * ys[i]; }
    const denom = n * sxx - sx * sx;
    if (n < 2 || Math.abs(denom) < 1e-9) return null;
    const slope = (n * sxy - sx * sy) / denom;
    const icept = (sy - slope * sx) / n;
    let sse = 0;
    for (let i = i0; i < i1; i++) { const e = ys[i] - (icept + slope * xs[i]); sse += e * e; }
    return { slope, icept, sse, n };
  };

  // PITCH from the roof's TAPER (see the fixture story in git history: a
  // threshold eave biased the pitch a whole 1/12 step), and the TRUE EAVE from
  // where the fitted roof line crosses the wall span - the roof plane passes
  // through the wall-top corner whether or not it overhangs, so this crossing
  // is overhang-immune where any band threshold is not.
  const rise0 = Math.max(0, peak - eaveY);
  let pitch = wallAcross > 0.2 ? rise0 / (wallAcross / 2) : 0;
  const roofFit = lsFit(roofY, roofS, 0, roofS.length);
  if (roofFit && roofFit.slope < -1e-6 && roofFit.n >= 3) {
    pitch = -2 / roofFit.slope;
    const cross = (wallAcross - roofFit.icept) / roofFit.slope;
    if (cross > waist && cross < peak) eaveY = cross;
  }

  // OVERHANG. Across the ridge: bands just BELOW the eave hold the roof's
  // overhanging edge, wider than the wall span - the widest of them names the
  // edge. Along the ridge: a gable roof clears the end walls by the overhang
  // at every roof height, so the mean along-span excess reads it directly.
  let overhangM = 0;
  {
    let maxBelow = wallAcross;
    for (let b = 0; b < nb; b++) {
      if (cnt[b] < 5) continue;
      const y = waist + (b + 0.5) * BAND;
      if (y < eaveY - 0.7 || y > eaveY) continue;
      const sp = ridgeAlongU ? svWide[b] : suWide[b];
      if (sp > maxBelow) maxBelow = sp;
    }
    const ovAcross = Math.max(0, (maxBelow - wallAcross) / 2);
    let ovAlong = 0;
    let alongN = 0, alongSum = 0;
    for (let b = wallTopBand + 2; b < nb; b++) {
      if (cnt[b] < 5) continue;
      alongSum += ridgeAlongU ? suWide[b] : svWide[b];
      alongN++;
    }
    if (alongN) ovAlong = Math.max(0, (alongSum / alongN - wallAlong) / 2);
    overhangM = (ovAcross + ovAlong) / 2;
    if (Math.abs(ovAcross - ovAlong) > 0.15) warnFlags.push("overhang");
  }

  let eave = Math.max(0.3, eaveY - ground);   // gambrel refines eaveY below and re-derives this
  const peakH = peak - ground;
  const rise = Math.max(0, peak - eaveY);

  // Classification. Midpoint drift separates what the old "both axes taper"
  // proxy conflated: a symmetric gable's across-midpoint holds still, a
  // saltbox's drifts toward the ridge, a mono-pitch shed's drifts at half the
  // taper rate (the "ridge" IS one eave). A two-segment fit whose upper leg
  // sheds span markedly faster than the lower is a gambrel - the farmland
  // barn profile the one-line fit used to average into a wrong gable.
  let roofType = "gable";
  let ridgeOffset = 0;
  let gambrel = null;
  if (rise < 0.15) {
    roofType = "shed"; pitch = 0.25;
  } else if (roofS.length >= 6) {
    // Gambrel: best two-segment split vs the single line.
    let best2 = null;
    for (let k = 3; k <= roofS.length - 3; k++) {
      const lo = lsFit(roofY, roofS, 0, k);
      const hi = lsFit(roofY, roofS, k, roofS.length);
      if (!lo || !hi) continue;
      const sse = lo.sse + hi.sse;
      if (!best2 || sse < best2.sse) best2 = { sse, lo, hi };
    }
    const drift = lsFit(roofY, roofMid, 0, roofMid.length);
    const halfTaper = roofFit ? -roofFit.slope / 2 : 0;
    const r = drift && halfTaper > 1e-6 ? drift.slope / halfTaper : 0;
    if (best2 && roofFit && best2.lo.slope < -1e-6 && best2.hi.slope < -1e-6 &&
        best2.sse < roofFit.sse * 0.5 && Math.abs(best2.hi.slope) >= Math.abs(best2.lo.slope) * 1.7) {
      roofType = "gambrel";
      const kneeY = (best2.hi.icept - best2.lo.icept) / (best2.lo.slope - best2.hi.slope);
      const kneeSpan = best2.lo.icept + best2.lo.slope * kneeY;
      const crossG = (wallAcross - best2.lo.icept) / best2.lo.slope;
      const eaveG = crossG > waist && crossG < peak ? crossG : eaveY;
      const half = wallAcross / 2;
      gambrel = {
        kneeU: Math.max(0, Math.min(1, kneeSpan / wallAcross)),
        kneeRise: Math.max(0, Math.min(1, (kneeY - eaveG) / half)),
        ridgeRise: Math.max(0, Math.min(1.5, (peak - eaveG) / half)),
      };
      eaveY = eaveG;
      eave = Math.max(0.3, eaveY - ground);   // the single-line crossing sat above the true gambrel eave
      pitch = -2 / best2.lo.slope;
    } else if (Math.abs(r) > 0.8) {
      roofType = "shed";
      pitch = wallAcross > 0.2 ? rise / wallAcross : 0.25;   // shed rise spans the WHOLE across span
    } else if (Math.abs(r) > 0.16 && drift) {
      const driftTotal = drift.slope * rise;
      ridgeOffset = Math.max(-0.35, Math.min(0.35, driftTotal / wallAcross));
      if (Math.abs(ridgeOffset) < 0.05) ridgeOffset = 0;
    }
    // Both axes tapering hard above the eave reads as a hip roof - we can't
    // build one, so say so instead of silently calling it something else.
    if (roofType === "gable" && roofAlong.length >= 3) {
      const alongFit = lsFit(roofY, roofAlong, 0, roofAlong.length);
      if (alongFit && alongFit.slope < -0.5 && roofFit && alongFit.slope < roofFit.slope * 0.5) warnFlags.push("hip");
    }
  }

  // Plan-view centre of the WALL rectangle (the calibration turntable frames
  // the scan with it): mid of the wall-band extents, rotated back to world.
  let centerX = 0, centerZ = 0;
  {
    let luo = Infinity, huo = -Infinity, lvo = Infinity, hvo = -Infinity;
    lowBands.forEach((b) => {
      const p2 = Math.floor(0.02 * (cnt[b] - 1)), p98 = Math.ceil(0.98 * (cnt[b] - 1));
      if (bu[b][p2] < luo) luo = bu[b][p2]; if (bu[b][p98] > huo) huo = bu[b][p98];
      if (bv[b][p2] < lvo) lvo = bv[b][p2]; if (bv[b][p98] > hvo) hvo = bv[b][p98];
    });
    const cu = (luo + huo) / 2, cvv = (lvo + hvo) / 2;
    centerX = cu * cs - cvv * sn;
    centerZ = cu * sn + cvv * cs;
  }

  return {
    widthM: Math.max(wallU, wallV), depthM: Math.min(wallU, wallV),
    eaveM: eave, peakM: peakH, pitch, roofType,
    overhangM, ridgeOffset, gambrel,
    headingDeg: bestA * 180 / Math.PI, groundY: ground, sampled: count,
    centerX, centerZ, warnFlags,
  };
}

// Metres to the numbers a builder reads and the spec stores, rounded where rounding helps:
// footprint to the foot (then a caller can snap to a size they actually sell), wall height to
// the half foot, pitch to 0.01 rise-over-run. Pitch is NOT snapped to a 1/12 step: a real
// roof is rarely exactly n:12, and rounding a measured 0.62 up to 0.667 (8:12) visibly
// changes the building. The operator sees the measured value and can type an exact one. The plausibility gate catches a unit error, an unscaled photogrammetry
// export, or a failed isolation — all of which otherwise produce a confident wrong building.
function scanToFeet(m) {
  const ft = (v) => v * M_TO_FT;
  const out = {
    widthFt: Math.round(ft(m.widthM)), depthFt: Math.round(ft(m.depthM)),
    eaveFt: Math.round(ft(m.eaveM) * 2) / 2, peakFt: Math.round(ft(m.peakM) * 2) / 2,
    pitch: Math.max(0, Math.round(m.pitch * 100) / 100), roofType: m.roofType,
    overhangFt: Math.max(0, Math.min(3, Math.round(ft(m.overhangM || 0) * 10) / 10)),
    ridgeOffset: m.ridgeOffset ? Math.round(m.ridgeOffset * 100) / 100 : 0,
    gambrel: m.gambrel
      ? { kneeU: Math.round(m.gambrel.kneeU * 100) / 100, kneeRise: Math.round(m.gambrel.kneeRise * 100) / 100, ridgeRise: Math.round(m.gambrel.ridgeRise * 100) / 100 }
      : null,
    headingDeg: Math.round(m.headingDeg), sampled: m.sampled,
  };
  const bad = [];
  if (out.widthFt < 5 || out.widthFt > 100) bad.push(`width ${out.widthFt} ft`);
  if (out.depthFt < 4 || out.depthFt > 100) bad.push(`depth ${out.depthFt} ft`);
  if (out.eaveFt < 4 || out.eaveFt > 20) bad.push(`wall height ${out.eaveFt} ft`);
  if (out.peakFt < out.eaveFt) bad.push("a peak below the wall");
  const flagText = {
    scattered: "the scan is scattered — its pieces don't connect, so clutter may be included",
    overhang: "the roof overhang reads differently along vs across the building — check it",
    hip: "the roof narrows on all four sides (hip roof?) — StructureStudio builds gable/gambrel/shed roofs",
  };
  const flags = (m.warnFlags || []).map((f) => flagText[f] || f);
  out.warn = bad.length
    ? `These measurements look wrong (${bad.join(", ")}) — the scan may include the ground or something next to the building, or may not be to scale. Check them before saving.`
    : (flags.length ? `Heads up: ${flags.join("; ")}.` : null);
  return out;
}

// Vertical dimensions the layout data model doesn't store yet (plan §6). Until
// wall_height_ft lives in building_sizes and opening heights live on items,
// every style renders with these defaults (feet):
const D3 = {
  WALL_H: 8,          // wall plate height
  DOOR_H: 6.5,        // door opening height
  RO_H: 6.5,          // rough-opening height
  WINDOW_H: 3,        // window opening height
  WINDOW_SILL: 3.5,   // window sill elevation
  LOFT_ELEV: 5.5,     // loft platform top elevation
  LOFT_T: 0.35,       // loft platform thickness
  BENCH_H: 3,         // workbench top height
  WALL_T: 0.3,        // wall thickness
  FLOOR_T: 0.35,      // floor slab thickness (slab top = y 0)
  ROOF_T: 0.2,        // roof panel thickness
  OVERHANG: 0.6,      // roof overhang past the walls
};

// Built-in 3D appearance per building style, keyed by lowercased style value
// (plan §4.2). Each spec: roof { type: shed|gable|gambrel, pitch (rise/run),
// ridgeOffset (gable ridge shifted toward one eave — saltbox looks), overhang,
// gambrel knee/ridge fractions of the half-span }, siding ("batten" adds
// board-and-batten relief strips), colors (unpainted naturals for body/trim/
// roof). A tenant can override or define ANY style's appearance from its
// config row — buildingStyles[].d3 = { roof, siding, colors, wallHeightFt } —
// no code change needed (see d3ResolveStyleSpec).
const D3_STYLE_DEFAULTS = {
  econo:     { roof: { type: "shed", pitch: 0.25, overhang: 0.35 }, siding: null, colors: {} },
  urban:     { roof: { type: "gable", pitch: 0.33, overhang: 0.85 }, siding: null, colors: { body: "#D6CCB6", trim: "#575044", roof: "#3E434A" } },
  northwood: { roof: { type: "gable", pitch: 0.55, overhang: 0.6 }, siding: "batten", colors: { body: "#C7B183", roof: "#4E5560" } },
  farmland:  { roof: { type: "gambrel", kneeU: 0.55, kneeRise: 0.55, ridgeRise: 0.8, overhang: 0.5 }, siding: "batten", colors: { body: "#C2A377", trim: "#8A6F4D", roof: "#5D5348" } },
};
const D3_DEFAULT_ROOF = { type: "gable", pitch: 0.4 };

// ── CLADDING ──────────────────────────────────────────────────────────────────
// The customer-facing exterior material. Carolyn's direction (2026-08-18): call it
// CLADDING, not siding, and offer three genuinely different products rather than one
// texture rotated:
//   lap     horizontal boards, each course overlapping the one below (~6in exposure)
//   panel   vertical 4ft x 8ft sheets with grooves cut INTO the face (T1-11 / EWGWG)
//   agpanel metal sheets whose ribs stand OUT, overlapping at the rib (Panel-Loc Plus)
// `batten` is kept as a FOURTH, non-customer-facing id so the tenants whose styles
// already say "batten" (northwood, farmland) keep their exact current look.
//
// Before this, three sites disagreed about the vocabulary: the texture selector spoke
// lap|groove, the relief branch spoke batten|lap, and d3SidingOverride returned lap|null
// -- so "batten" silently drew the GROOVE texture, and there was no way to say "metal"
// at all. One table, one normalizer, and all three read from it.
//
// tileFtU/tileFtV are how many FEET one 512px texture tile covers, so the pattern is
// anchored to the BUILDING rather than to each wall's own 0..1 UV span.
const D3_CLADDING = {
  lap:     { id: "lap",     label: "Lap Siding",     tex: "lap",     relief: "lap",    stepFt: 0.5,  tileFtU: 8.0, tileFtV: 4.0, bump: 0.45 },
  panel:   { id: "panel",   label: "Panel Siding",   tex: "groove",  relief: null,                   tileFtU: 4.0, tileFtV: 8.0, bump: 0.40 },
  agpanel: { id: "agpanel", label: "Metal",          tex: "agpanel", relief: "rib",    stepFt: 0.75, tileFtU: 3.0, tileFtV: 3.0, bump: 0.60, metal: true },
  // reliefTrim: the proud strip takes TRIM colour, not body. Carolyn, 2026-08-24: board and
  // batten is "boards further apart and it has like a piece of TRIM over the top of it".
  // It is a flag rather than a string compare on id so a future cladding can opt in.
  // `rib` deliberately does NOT: a metal rib is the same sheet of steel, not a second board.
  batten:  { id: "batten",  label: "Board & Batten", tex: "bnb",     relief: "batten", stepFt: 1.5,  tileFtU: 3.0, tileFtV: 8.0, bump: 0.40, reliefTrim: true },
};
// The customer-selectable set, in the order Carolyn named them on 2026-08-24: "panel
// siding, lap siding, board and batten, and metal". `batten` joined the list that day --
// it was rendered but never offered, which is why board & batten could only ever appear
// on a style whose stored spec already said so.
//
// A style may NARROW this via `d3.claddingChoices` (see d3CladdingChoicesFor below) --
// not every builder sells every cladding, and metal in particular is far from universal.
const D3_CLADDING_CHOICES = ["panel", "lap", "batten", "agpanel"];

// Which claddings a given style offers the customer. A style may narrow the list via
// `d3.claddingChoices` -- plenty of builders sell no metal siding at all -- but a style
// that says nothing offers all four, which is what every existing row says by omission.
//
// Rebuilt by filtering OUR list rather than trusting theirs, so the dropdown order is
// always canonical and a stale id in the column cannot reach D3_CLADDING[id].label and
// throw. An empty result means the builder unticked everything, which is a slip rather
// than an instruction -- honouring it literally would leave the customer no cladding to
// pick at all -- so it falls back to the full list.
function d3CladdingChoicesFor(styleCfg) {
  const narrowed = styleCfg && styleCfg.d3 && Array.isArray(styleCfg.d3.claddingChoices)
    ? D3_CLADDING_CHOICES.filter((id) => styleCfg.d3.claddingChoices.indexOf(id) !== -1)
    : [];
  return narrowed.length ? narrowed : D3_CLADDING_CHOICES;
}

// Every value `building_styles.d3.siding` can already hold, mapped onto the table above.
// This is the whole backward-compatibility story and it needs NO migration: today `null`
// and `"batten"` differ only in relief, and `panel` carries no relief, so every existing
// tenant renders exactly as it does now.
function d3NormalizeCladding(v) {
  const s = String(v == null ? "" : v).trim().toLowerCase();
  if (s === "lap" || s === "lapsiding" || s === "lap-siding") return "lap";
  if (s === "batten" || s === "board-and-batten" || s === "bnb") return "batten";
  if (s === "agpanel" || s === "ag" || s === "metal" || s === "panel-loc" || s === "panelloc") return "agpanel";
  return "panel"; // null / "" / "groove" / "panel" / "t111" / anything unrecognised
}

// The roof's cross-section: a polyline of [u, y] points running eave -> ridge -> eave,
// plus the slope segments that get roof slabs.
//
// Extracted out of buildShed3DModel on 2026-08-25 so the calibration panel can DRAW the
// same profile the renderer builds. Two implementations of a gambrel knee would drift on
// the first change, and a drawing that disagrees with the 3D is worse than no drawing --
// the whole point of it is that a builder can trust it.
//
// Pure: no THREE, no DOM. `tallNeg` picks which end of a shed roof is the high one.
function d3RoofProfile(roofCfg, S, H, tallNeg) {
  const cfg = roofCfg || {};
  const prof = [], slopes = [];
  if (cfg.type === "shed") {
    const rise = S * (cfg.pitch || 0.25);
    const A = tallNeg ? [-S / 2, H + rise] : [-S / 2, H];
    const B = tallNeg ? [S / 2, H] : [S / 2, H + rise];
    prof.push([-S / 2, H], A, B, [S / 2, H]);
    slopes.push([A, B]);
  } else if (cfg.type === "gambrel") {
    const s2 = S / 2;
    const kU = s2 * (cfg.kneeU || 0.55);
    const kY = H + s2 * (cfg.kneeRise || 0.55);
    const rY = H + s2 * (cfg.ridgeRise || 0.8);
    prof.push([-s2, H], [-kU, kY], [0, rY], [kU, kY], [s2, H]);
    slopes.push([[-s2, H], [-kU, kY]], [[-kU, kY], [0, rY]], [[0, rY], [kU, kY]], [[kU, kY], [s2, H]]);
  } else {
    const rise = (S / 2) * (cfg.pitch || 0.4);
    // ridgeOffset shifts the ridge toward one eave (saltbox-style asymmetry).
    const ru = S * Math.max(-0.35, Math.min(0.35, cfg.ridgeOffset || 0));
    prof.push([-S / 2, H], [ru, H + rise], [S / 2, H]);
    slopes.push([[-S / 2, H], [ru, H + rise]], [[ru, H + rise], [S / 2, H]]);
  }
  // Drop consecutive duplicate points (the shed profile produces one); the open edge
  // auto-closes along the wall-plate line.
  const dedup = prof.filter((pt, i) => i === 0 || Math.abs(pt[0] - prof[i - 1][0]) > 1e-6 || Math.abs(pt[1] - prof[i - 1][1]) > 1e-6);
  return { prof, slopes, dedup };
}

// Feet as a builder writes them: 4' 7" rather than 0.55 x half-span. This is the whole
// point of the elevation drawing -- Carolyn spent two and a half minutes on 2026-08-24
// failing to match a real gambrel because every control was a dimensionless ratio against
// a referent nothing on screen named ("half in span. Nine. Okay, well that's kind of
// crazy"). Rounded to the nearest inch; 12" rolls up.
function d3FtIn(ft) {
  if (!isFinite(ft)) return "";
  const neg = ft < 0;
  let whole = Math.floor(Math.abs(ft));
  let inch = Math.round((Math.abs(ft) - whole) * 12);
  if (inch === 12) { whole += 1; inch = 0; }
  return (neg ? "-" : "") + whole + "' " + inch + '"';
}

// A dimensioned end-elevation of the style being calibrated, drawn from d3RoofProfile --
// the SAME profile builder the 3D renderer uses, so the drawing cannot disagree with the
// building beside it.
//
// This exists because of one specific failure. On 2026-08-24 Carolyn spent two and a half
// minutes trying to match a real gambrel and could not work out which number to change:
// "I couldn't figure out which numbers to change here ... Half in span. Nine. Okay, well
// that's kind of crazy ... I want them to be able to put in EXACTLY like what this is so
// that they can get this angle to be exactly the way theirs is." The controls are
// dimensionless ratios against a referent nothing on screen named -- `s2 = S / 2` is her
// "half in span", and it appears nowhere in the UI. Every dimension here is therefore
// annotated in FEET AND INCHES, with the ratio in small text underneath, and focusing an
// input highlights the dimension it drives.
//
// Deliberately SVG and not a second 3D view: the preview beside it is a perspective
// three-quarter shot, where dimension lines are unreadable, and it is a shared WebGL
// context that should not grow overlay complexity.
function D3ElevationSVG({ spec, sizeLabel, focusKey }) {
  const roof = (spec && spec.roof) || {};
  const m = /^(\d+(?:\.\d+)?)\s*[xX\u00d7]\s*(\d+(?:\.\d+)?)/.exec(String(sizeLabel || "12x16"));
  const w = m ? parseFloat(m[1]) : 12, d = m ? parseFloat(m[2]) : 16;
  // Mirrors buildShed3DModel's default front wall for a building with no doors placed --
  // fw = bldgH >= bldgW ? "north" : "west" -- which is what the calibration preview shows.
  // tallNeg is true for both of those, so the shed's high end is always on the left here.
  const frontNS = d >= w;
  const uAxisIsX = roof.type === "shed" ? !frontNS : frontNS;
  const S = uAxisIsX ? w : d;
  const H = (spec && spec.wallHeightFt) || 8;
  const OV = roof.overhang != null ? roof.overhang : 0.6;
  const dedup = d3RoofProfile(roof, S, H, true).dedup;
  let peak = H;
  dedup.forEach((p) => { if (p[1] > peak) peak = p[1]; });

  const VW = 360, VH = 210, PL = 54, PR = 54, PT = 14, PB = 34;
  const innerW = VW - PL - PR, innerH = VH - PT - PB;
  const sc = Math.min(innerW / Math.max(S + OV * 2, 1), innerH / Math.max(peak, 1));
  const X = (u) => PL + innerW / 2 + u * sc;
  const Y = (y) => PT + innerH - y * sc;

  // Overhang: extend the outermost slope segment past the wall by OV measured HORIZONTALLY,
  // which is how the renderer measures it (OV is feet past the wall, not along the rafter).
  const ext = (far, near) => {
    const dx = near[0] - far[0], dy = near[1] - far[1];
    if (Math.abs(dx) < 1e-6) return near;
    const k = OV / Math.abs(dx);
    return [near[0] + dx * k, near[1] + dy * k];
  };
  const eaveL = dedup.length > 1 ? ext(dedup[1], dedup[0]) : dedup[0];
  const eaveR = dedup.length > 1 ? ext(dedup[dedup.length - 2], dedup[dedup.length - 1]) : dedup[dedup.length - 1];
  const roofPts = [eaveL].concat(dedup, [eaveR]).map((p) => X(p[0]) + "," + Y(p[1])).join(" ");

  const HL = "#B45309", DIM = "#A16207", INK = "#78350F";
  const on = (k) => focusKey === k;
  const dimStroke = (k) => ({ stroke: on(k) ? HL : DIM, strokeWidth: on(k) ? 2 : 1 });
  const tick = (x, y1, y2, k) => <line x1={x} y1={y1} x2={x} y2={y2} {...dimStroke(k)} />;
  const label = (x, y, main, sub, k, anchor) => (
    <g>
      <text x={x} y={y} textAnchor={anchor || "middle"} style={{ fontSize: 10, fontWeight: 800, fill: on(k) ? HL : INK }}>{main}</text>
      {sub ? <text x={x} y={y + 9} textAnchor={anchor || "middle"} style={{ fontSize: 8, fill: DIM }}>{sub}</text> : null}
    </g>
  );

  const isGam = roof.type === "gambrel";
  const s2 = S / 2;
  const kU = s2 * (roof.kneeU || 0.55), kY = H + s2 * (roof.kneeRise || 0.55);
  const rY = H + s2 * (roof.ridgeRise || 0.8);
  const ru = S * Math.max(-0.35, Math.min(0.35, roof.ridgeOffset || 0));
  const pitch = roof.pitch != null ? roof.pitch : (roof.type === "shed" ? 0.25 : 0.4);

  return (
    <svg viewBox={`0 0 ${VW} ${VH}`} style={{ width: "100%", height: "auto", background: "#FFFBEB", border: "1px solid #FCD34D", borderRadius: 8 }}>
      {/* ground + wall box */}
      <line x1={PL - 10} y1={Y(0)} x2={VW - PR + 10} y2={Y(0)} stroke="#D6D3D1" strokeWidth="1" />
      <rect x={X(-s2)} y={Y(H)} width={s2 * 2 * sc} height={H * sc} fill="#FEF3C7" stroke={INK} strokeWidth="1.2" />
      <polyline points={roofPts} fill="none" stroke={INK} strokeWidth="2" strokeLinejoin="round" />

      {/* WALL HEIGHT, left */}
      {tick(PL - 22, Y(0), Y(H), "wallHeightFt")}
      <line x1={PL - 26} y1={Y(H)} x2={PL - 18} y2={Y(H)} {...dimStroke("wallHeightFt")} />
      <line x1={PL - 26} y1={Y(0)} x2={PL - 18} y2={Y(0)} {...dimStroke("wallHeightFt")} />
      {label(PL - 30, (Y(0) + Y(H)) / 2, d3FtIn(H), "wall", "wallHeightFt", "end")}

      {/* PEAK, right -- read-only, the number a builder actually measures against */}
      {tick(VW - PR + 22, Y(0), Y(peak), null)}
      {label(VW - PR + 26, (Y(0) + Y(peak)) / 2, d3FtIn(peak), "peak", null, "start")}

      {/* SPAN, bottom */}
      <line x1={X(-s2)} y1={Y(0) + 16} x2={X(s2)} y2={Y(0) + 16} stroke={DIM} strokeWidth="1" />
      {label((X(-s2) + X(s2)) / 2, Y(0) + 29, d3FtIn(S), "span", null)}

      {/* OVERHANG, at the left eave */}
      <line x1={X(eaveL[0])} y1={Y(eaveL[1]) - 9} x2={X(-s2)} y2={Y(eaveL[1]) - 9} {...dimStroke("overhang")} />
      {label((X(eaveL[0]) + X(-s2)) / 2, Y(eaveL[1]) - 12, d3FtIn(OV), "eave", "overhang")}

      {/* PITCH -- as x:12, which is the only way a builder states a roof slope */}
      {!isGam && label(X(ru) + (X(s2) - X(ru)) / 2, Y((H + peak) / 2) - 4,
        `${Math.round(pitch * 12)}:12`, `pitch ${(+pitch).toFixed(2)}`, "pitch")}

      {/* RIDGE OFFSET -- only when it is actually doing something */}
      {!isGam && Math.abs(ru) > 0.01 && (
        <g>
          <line x1={X(0)} y1={Y(peak) - 8} x2={X(ru)} y2={Y(peak) - 8} {...dimStroke("ridgeOffset")} />
          {label((X(0) + X(ru)) / 2, Y(peak) - 11, d3FtIn(Math.abs(ru)), "ridge shift", "ridgeOffset")}
        </g>
      )}

      {/* GAMBREL -- the three controls she could not decode */}
      {isGam && (
        <g>
          <line x1={X(0)} y1={Y(kY) + 10} x2={X(kU)} y2={Y(kY) + 10} {...dimStroke("kneeU")} />
          {label((X(0) + X(kU)) / 2, Y(kY) + 22, d3FtIn(kU), "knee out", "kneeU")}
          {tick(X(kU) + 16, Y(H), Y(kY), "kneeRise")}
          {label(X(kU) + 20, (Y(H) + Y(kY)) / 2, d3FtIn(kY - H), "knee up", "kneeRise", "start")}
          {tick(X(0) - 16, Y(H), Y(rY), "ridgeRise")}
          {label(X(0) - 20, (Y(H) + Y(rY)) / 2, d3FtIn(rY - H), "ridge up", "ridgeRise", "end")}
        </g>
      )}
    </svg>
  );
}

// Resolve a style's 3D appearance: tenant config override (the style entry's
// `d3` object) over the built-in per-style defaults, over the generic gable.
// sidingOverride (from d3SidingOverride) wins over everything — it's the
// customer's selected siding upgrade. customerWallHeightFt is the customer's
// wall-height pick from the 3D view (sel.wallHeight) and beats the style's
// default height, like IdeaRoom's wall-raise feature.
function d3ResolveStyleSpec(styleCfg, styleValue, globalWallHeightFt, sidingOverride, customerWallHeightFt) {
  const key = String(styleValue || "").trim().toLowerCase();
  const base = D3_STYLE_DEFAULTS[key] || {};
  const o = (styleCfg && styleCfg.d3) || {};
  return {
    roof: { ...D3_DEFAULT_ROOF, ...(base.roof || {}), ...(o.roof || {}) },
    siding: sidingOverride || (o.siding !== undefined ? o.siding : (base.siding || null)),
    colors: { ...(base.colors || {}), ...(o.colors || {}) },
    // The style's default roof MATERIAL (shingle|metal) — texture + surface
    // response even before the customer picks a roof type; their pick wins.
    roofMaterial: o.roofMaterial === "metal" || o.roofMaterial === "shingle" ? o.roofMaterial : (base.roofMaterial || null),
    // A louvered gable vent, tenant override over the built-in default. This MUST be
    // named here: the literal drops what it does not list, and because openCalEditor
    // seeds from this resolver and onSaveSpec writes the draft back, a dropped key is
    // erased from the column the first time a builder opens and saves the panel.
    gableVent: (o.gableVent && o.gableVent.widthFrac > 0) ? o.gableVent : (base.gableVent || null),
    // Named for the same reason gableVent is: the literal drops what it does not list,
    // and the calibration panel round-trips through this resolver.
    foundation: (o.foundation === "skids" || o.foundation === "slab") ? o.foundation : (base.foundation || null),
    // Third field named for the same reason as the two above, and the one that was actually
    // missing until 2026-08-25. It is worse than the others because the cladding checkboxes
    // READ this spec too (`d3CladdingChoicesFor({ d3: adminCal.spec })`): a style that offers
    // two claddings opened with all four ticked, and saving that screen -- without touching a
    // checkbox -- wrote the widened list back. The narrowing was lost twice over, on display
    // and on save. `undefined` rather than `null` matches what the checkbox handler stores,
    // so an unnarrowed style keeps the key ABSENT from the column instead of growing a null.
    claddingChoices: Array.isArray(o.claddingChoices) ? o.claddingChoices : (base.claddingChoices || undefined),
    wallHeightFt: customerWallHeightFt || o.wallHeightFt || (styleCfg && styleCfg.wallHeightFt) || globalWallHeightFt || 0,
  };
}

// Carolyn (2026-07-02): horizontal lap siding is THE universal upgrade —
// vertical groove panel is standard everywhere. When the customer's selected
// options say "lap siding", the 3D walls switch to horizontal lap boards.
// Explicit config wins: `siding3d: { optionId, lapValue }` in the config blob
// names the option to watch. Without it, any selected option whose id or
// value reads as lap siding (e.g. a "Siding" option set to "Lap Siding")
// triggers the switch — so a tenant just adding the option works untouched.
function d3SidingOverride(config, sel) {
  if (!config || !sel) return null;
  // The explicit Cladding pick wins over everything below. `sel.cladding` is set by the
  // Cladding control in the 2D toolbar; the two legacy paths after it stay for tenants who
  // already wired their own "Siding" option before Cladding existed.
  if (sel.cladding && D3_CLADDING[sel.cladding]) return sel.cladding;
  const s3 = config.siding3d;
  if (s3 && s3.optionId) {
    const v = sel[s3.optionId];
    const lapVal = String(s3.lapValue || "Lap Siding").trim().toLowerCase();
    return v && String(v).trim().toLowerCase() === lapVal ? "lap" : null;
  }
  for (const k in sel) {
    const v = sel[k];
    if (typeof v !== "string") continue;
    if (/lap/i.test(v) && (/sid/i.test(v) || /sid/i.test(k))) return "lap";
  }
  return null;
}

// Natural-material fallbacks for "No Paint" designs (and for palette values the
// browser can't parse — the paint palette stores display names, not hex).
const D3_COLORS = {
  body: "#CDBA92", trim: "#8F7B55", roof: "#565C66",
  floor: "#B7AC99", ground: "#DCE2D8", door: "#77664C",
  glass: "#B9D8EA", loft: "#C2A67D", bench: "#8B7355", ramp: "#9AA0A6",
};

// Curated paint swatches for the 3D color picker. The LABEL is what lands in
// paintColors (and on the estimate — same free-text semantics as the 2D paint
// inputs); the css drives the live 3D material. Colors typed free-form in 2D
// still resolve through d3CssColor.
const D3_SWATCHES = [
  { label: "Barn Red", css: "#8B2E2E" },
  { label: "White", css: "#F2F1EA" },
  { label: "Tan", css: "#D2B48C" },
  { label: "Clay", css: "#B08D57" },
  { label: "Gray", css: "#9AA1A9" },
  { label: "Charcoal", css: "#3F444B" },
  { label: "Blue", css: "#4A6FA5" },
  { label: "Green", css: "#4F6F52" },
  { label: "Brown", css: "#6B4F3A" },
];
// The tenant's own catalog rows for a paint slot, in the {label, css} shape both the 3D
// swatch row and d3SwatchCss speak. `allowCustom` rows are excluded: that row is a
// "type your own" affordance rather than a colour, and it carries no hex, so it would
// render as a dead grey chip.
function d3PaintPool(colors, kind) {
  return (Array.isArray(colors) ? colors : [])
    .filter((c) => c && c.hex && !c.allowCustom && (kind === "trim" ? c.trim : c.siding))
    .map((c) => ({ label: c.label, css: c.hex }));
}

// `pool` is the tenant's catalog (see d3PaintPool) and wins when it has the label.
// Optional and last-resort-free by design: omit it and this behaves exactly as it always
// has, so every existing call site is unchanged.
//
// Why it exists: the 2D picker has always read C.colors, while 3D read a hardcoded nine.
// A customer picking "Mountain Red" in 2D got d3CssColor()'s CSS-NAME GUESS in 3D --
// new Option().style parsing a colour name that is not a CSS colour -- so the two views
// of the same building disagreed. The D3_SWATCHES fallback stays underneath for labels
// the catalog does not carry, which is what keeps an already-saved design rendering after
// its tenant deletes a colour (save_colors is a full-list replace, so that happens).
function d3SwatchCss(label, fallback, pool) {
  if (Array.isArray(pool)) {
    const hit = pool.find((x) => x.label === label);
    if (hit && hit.css) return hit.css;
  }
  return d3SwatchCssBuiltIn(label, fallback);
}
function d3SwatchCssBuiltIn(label, fallback) {
  const s = D3_SWATCHES.find((x) => x.label === label);
  return s ? s.css : d3CssColor(label, fallback);
}

// Phase 5 (plan §6): vertical-dimension fields stamped onto items at placement
// so designs carry their own opening heights/sills/elevations. The 3D reads
// these with D3 fallbacks, so legacy designs (no fields) render identically.
function d3OpeningDefaults(type) {
  if (type === "window") return { openingHeightFt: D3.WINDOW_H, sillFt: D3.WINDOW_SILL };
  if (type === "roughOpening") return { openingHeightFt: D3.RO_H };
  if (type === "singleDoor" || type === "doubleDoor") return { openingHeightFt: D3.DOOR_H };
  return {};
}

// Resolve a palette value ("Red", "Dark Gray", "#AA3322", …) to a CSS color the
// renderer can use. Tries the raw value, then a squashed lowercase form
// ("Dark Gray" → "darkgray"); falls back when neither parses.
function d3CssColor(v, fallback) {
  if (!v || typeof v !== "string" || typeof document === "undefined") return fallback;
  const probe = new Option().style;
  probe.color = v.trim();
  if (probe.color) return v.trim();
  probe.color = v.trim().toLowerCase().replace(/\s+/g, "");
  return probe.color || fallback;
}

// Procedural surface textures for the 3D materials — no image assets (plan
// constraint: parametric only). Each returns a small tileable grayscale
// THREE.CanvasTexture that MULTIPLIES the material's base color (Lambert
// map × color), so the chosen paint / roof color still drives the hue while
// the pattern adds relief:
//   metal   → vertical standing-seam ribs (AgPanel / Panel-Loc look)
//   shingle → staggered horizontal shingle courses (Owens Corning Duration look)
//   lap     → horizontal lap-siding boards
//   groove  → vertical groove / board-and-batten panel (the standard siding look)
// Regenerated per build (cheap) so disposeShed3DModel frees them with the
// material — never a shared texture left disposed under a live model.
// Pattern canvases are rastered ONCE per session (module cache, the grass-
// singleton pattern below): a live drag re-mints only the cheap CanvasTexture
// wrapper per build, so dispose stays safe while the pixels — and the mipmap
// upload cost they used to re-pay every rebuilt frame — are paid once.
// Each kind rasters a COLOR canvas (multiplied by the material color, so it
// stays white-based) and a BUMP canvas (grayscale relief) at 512px, with a
// seeded PRNG so the variegation is identical every session — a quote PDF
// captured today must match one captured tomorrow.
const D3_TEX_KINDS = new Set(["metal", "groove", "lap", "shingle", "agpanel", "bnb"]);
const _d3TexCanvases = {};
function _d3Rng(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function _d3RasterKind(kind) {
  const N = 512;
  const color = document.createElement("canvas"); color.width = color.height = N;
  const bump = document.createElement("canvas"); bump.width = bump.height = N;
  const g = color.getContext("2d");
  const b = bump.getContext("2d");
  const rng = _d3Rng(kind.length * 2654435761 + 20260815);
  g.fillStyle = "#ffffff"; g.fillRect(0, 0, N, N);
  b.fillStyle = "#808080"; b.fillRect(0, 0, N, N);
  if (kind === "shingle") {
    // Architectural asphalt: staggered variegated tabs, deep course shadows,
    // faint vertical weather streaks.
    const row = 64, tab = 86;
    for (let y = 0, r = 0; y < N + row; y += row, r++) {
      const off = (r % 2) * (tab / 2);
      for (let x = -tab; x < N + tab; x += tab) {
        const v = 0.82 + rng() * 0.26;               // per-tab lightness 0.82–1.08
        const gray = Math.round(238 * Math.min(1.04, v));
        g.fillStyle = `rgb(${gray},${gray},${gray})`;
        g.fillRect(x + off, y, tab - 3, row - 4);
        const bv = Math.round(112 + rng() * 48);
        b.fillStyle = `rgb(${bv},${bv},${bv})`;
        b.fillRect(x + off, y, tab - 3, row - 4);
        // tab gap
        g.fillStyle = "rgba(0,0,0,0.35)"; g.fillRect(x + off + tab - 3, y, 3, row - 4);
        b.fillStyle = "#3a3a3a"; b.fillRect(x + off + tab - 3, y, 3, row - 4);
      }
      // course shadow + butt-edge highlight
      g.fillStyle = "rgba(0,0,0,0.42)"; g.fillRect(0, y + row - 4, N, 4);
      g.fillStyle = "rgba(255,255,255,0.10)"; g.fillRect(0, y + row, N, 2);
      b.fillStyle = "#242424"; b.fillRect(0, y + row - 4, N, 4);
    }
    for (let i = 0; i < 26; i++) {                    // weather streaks
      const x = rng() * N;
      g.fillStyle = `rgba(0,0,0,${0.02 + rng() * 0.04})`;
      g.fillRect(x, 0, 1 + rng() * 3, N);
    }
  } else if (kind === "metal") {
    // Standing seam: wide pans with soft cross-pan sheen, paired ribs at each
    // seam, strong bump ridges so the sun catches them.
    const pan = 128;
    for (let x = 0; x < N; x += pan) {
      const grad = g.createLinearGradient(x, 0, x + pan, 0);
      grad.addColorStop(0, "rgba(0,0,0,0.10)");
      grad.addColorStop(0.35, "rgba(255,255,255,0.09)");
      grad.addColorStop(0.65, "rgba(255,255,255,0.02)");
      grad.addColorStop(1, "rgba(0,0,0,0.14)");
      g.fillStyle = grad; g.fillRect(x, 0, pan, N);
      g.fillStyle = "rgba(0,0,0,0.30)"; g.fillRect(x, 0, 3, N);            // seam shadow
      g.fillStyle = "rgba(255,255,255,0.5)"; g.fillRect(x + 3, 0, 3, N);   // rib light
      g.fillStyle = "rgba(0,0,0,0.18)"; g.fillRect(x + 6, 0, 2, N);
      b.fillStyle = "#e8e8e8"; b.fillRect(x + 1, 0, 6, N);                 // rib ridge
      b.fillStyle = "#565656"; b.fillRect(x + 7, 0, 2, N);
    }
  } else if (kind === "agpanel") {
    // Panel-Loc Plus (Central States) — the reference Carolyn sent for WALL metal. This is
    // NOT the standing-seam "metal" raster above: that one is the ROOF look and she
    // explicitly rejected SmartBuild's metal wall view. The distinction that matters is the
    // bump map — these ribs stand OUT (light), where groove's grooves are cut IN (dark).
    // 4 major ribs per tile at tileFtU 3.0 puts them ~9in apart, matching a 36in-coverage
    // panel, with a wider side-lap rib at the tile seam where sheets overlap.
    const rib = N / 4;
    for (let x = 0; x < N; x += rib) {
      const grad = g.createLinearGradient(x, 0, x + rib, 0);
      grad.addColorStop(0, "rgba(0,0,0,0.13)");
      grad.addColorStop(0.30, "rgba(255,255,255,0.07)");
      grad.addColorStop(0.70, "rgba(255,255,255,0.02)");
      grad.addColorStop(1, "rgba(0,0,0,0.10)");
      g.fillStyle = grad; g.fillRect(x, 0, rib, N);
      // the rib itself: shadow on the leading face, highlight on the crown
      g.fillStyle = "rgba(0,0,0,0.34)"; g.fillRect(x, 0, 4, N);
      g.fillStyle = "rgba(255,255,255,0.55)"; g.fillRect(x + 4, 0, 5, N);
      g.fillStyle = "rgba(0,0,0,0.20)"; g.fillRect(x + 9, 0, 3, N);
      b.fillStyle = "#efefef"; b.fillRect(x + 2, 0, 8, N);   // ribs stand OUT
      b.fillStyle = "#4f4f4f"; b.fillRect(x + 10, 0, 2, N);
      // minor striations between ribs — Panel-Loc has them, standing seam does not
      for (let k = 1; k <= 2; k++) {
        const sx = x + (rib * k) / 3;
        g.fillStyle = "rgba(0,0,0,0.07)"; g.fillRect(sx, 0, 1, N);
        b.fillStyle = "#9a9a9a"; b.fillRect(sx, 0, 1, N);
      }
    }
    // side-lap rib at the seam: wider, because that is where two sheets overlap
    g.fillStyle = "rgba(0,0,0,0.28)"; g.fillRect(N - 3, 0, 3, N);
    b.fillStyle = "#f5f5f5"; b.fillRect(N - 3, 0, 3, N);
  } else if (kind === "lap") {
    // Horizontal lap boards: per-board tone, butt shadow, faint grain.
    const board = 64;
    for (let y = 0; y < N; y += board) {
      const v = 0.90 + rng() * 0.16;
      const gray = Math.round(244 * Math.min(1.03, v));
      g.fillStyle = `rgb(${gray},${gray},${gray})`;
      g.fillRect(0, y, N, board);
      for (let i = 0; i < 7; i++) {                  // grain streaks
        g.fillStyle = `rgba(0,0,0,${0.015 + rng() * 0.03})`;
        g.fillRect(0, y + 6 + rng() * (board - 12), N, 1 + rng());
      }
      g.fillStyle = "rgba(0,0,0,0.34)"; g.fillRect(0, y + board - 5, N, 5);   // butt shadow
      g.fillStyle = "rgba(255,255,255,0.16)"; g.fillRect(0, y, N, 2);          // top catch-light
      const bg = b.createLinearGradient(0, y, 0, y + board);                  // board tilt
      bg.addColorStop(0, "#9a9a9a"); bg.addColorStop(0.9, "#6f6f6f"); bg.addColorStop(1, "#2f2f2f");
      b.fillStyle = bg; b.fillRect(0, y, N, board);
    }
  } else if (kind === "bnb") {
    // Board & batten: wide plain boards with a butt seam every half-tile, and NO grooves.
    //
    // batten used to reuse the T1-11 "groove" raster, which cuts a groove every ~8 inches
    // while the proud battens step every 18 -- two patterns at incommensurable spacings on
    // the same wall. That mismatch is why it never read as board & batten no matter how the
    // relief was tuned: 4.0 and 1.5 share no common multiple, so a drawn groove landed under
    // a batten roughly once every twelve feet and looked like a mistake everywhere else.
    //
    // Two seams per 512px tile at tileFtU 3.0 puts one every 1.5 ft -- exactly where the
    // relief loop places a batten -- so the drawn seam and the physical strip coincide BY
    // CONSTRUCTION rather than by tuning.
    const seam = N / 2;
    for (let x = 0; x < N; x += seam) {                // per-board tone
      const v = 0.94 + rng() * 0.10;
      const gray = Math.round(246 * Math.min(1.02, v));
      g.fillStyle = `rgb(${gray},${gray},${gray})`;
      g.fillRect(x, 0, seam, N);
    }
    for (let i = 0; i < 26; i++) {                     // faint vertical grain
      g.fillStyle = `rgba(0,0,0,${0.012 + rng() * 0.022})`;
      g.fillRect(rng() * N, 0, 1 + rng() * 2, N);
    }
    for (let x = 0; x < N; x += seam) {                // the butt seam the batten covers
      g.fillStyle = "rgba(0,0,0,0.28)"; g.fillRect(x, 0, 2, N);
      b.fillStyle = "#5c5c5c"; b.fillRect(x, 0, 2, N);
    }
  } else {
    // "groove" — vertical T1-11 style panel: grooves with soft shoulders + grain.
    const gap = 84;
    for (let i = 0; i < 30; i++) {
      g.fillStyle = `rgba(0,0,0,${0.012 + rng() * 0.025})`;
      g.fillRect(rng() * N, 0, 1 + rng() * 2, N);
    }
    for (let x = 0; x < N; x += gap) {
      g.fillStyle = "rgba(0,0,0,0.10)"; g.fillRect(x - 3, 0, 3, N);
      g.fillStyle = "rgba(0,0,0,0.30)"; g.fillRect(x, 0, 4, N);
      g.fillStyle = "rgba(255,255,255,0.12)"; g.fillRect(x + 4, 0, 2, N);
      b.fillStyle = "#4a4a4a"; b.fillRect(x, 0, 4, N);
      b.fillStyle = "#6a6a6a"; b.fillRect(x - 2, 0, 2, N);
    }
  }
  return { color, bump };
}
function d3MakeTexture(THREE, kind) {
  if (!kind || typeof document === "undefined") return null;
  // Widened from a four-way chain when agpanel arrived (Carolyn's wall-metal cladding).
  if (!D3_TEX_KINDS.has(kind)) return null;
  if (!_d3TexCanvases[kind]) _d3TexCanvases[kind] = _d3RasterKind(kind);
  const tex = new THREE.CanvasTexture(_d3TexCanvases[kind].color);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.anisotropy = 8;   // clamped to the GPU max at upload; kills grazing-angle smear on roofs
  return tex;
}
// Matching relief map (same cached canvas family, same repeat contract as the
// color texture — the caller copies .repeat onto it).
function d3MakeBumpTexture(THREE, kind) {
  if (!kind || typeof document === "undefined") return null;
  if (!_d3TexCanvases[kind]) return null;   // color texture is always made first
  const tex = new THREE.CanvasTexture(_d3TexCanvases[kind].bump);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.anisotropy = 8;
  return tex;
}

// ─── Catalog fixture photos as 3D textures ───
// A builder uploads a straight-on photo of THEIR door/window in the portal
// (Options → Doors/Windows); the 3D masks that photo onto the opening's slab, so
// the customer sees the real product instead of a generic panel. No model
// library to maintain on our side — the builder owns the photo.
//
// Three constraints drive this design:
//  1. `queueRebuild` disposes and rebuilds the dragged item's wall (and before
//     the scoped-rebuild work, the whole model) every animation frame during a
//     drag, so these textures must be shared across builds and must NOT be
//     freed by disposal (hence userData.ssShared, honored by disposeSubtree).
//  2. The renderer draws on demand only, so a photo arriving later has to ask for
//     a frame — d3OnFixtureTexSettle lets the viewer register that listener.
//  3. A texture whose image hasn't loaded renders BLACK. So the cache serves a 1x1
//     canvas in the parametric fill color until the photo arrives — a loading (or
//     permanently failed) photo looks exactly like the painted fallback.
//     The arriving photo becomes a BRAND-NEW texture object and every material
//     built against the placeholder is re-pointed at it. Verified the hard way on
//     three 0.167: swapping `texture.image` (or `texture.source.data`) and setting
//     needsUpdate does NOT re-upload an already-uploaded texture — the GPU kept
//     showing the 1x1 placeholder while `material.map.image.width` read 1024.
//     Only assigning a new texture to `material.map` takes effect. Do not
//     "optimize" this back into a mutation.
//     Re-pointing (rather than rebuilding the model) is also what keeps this
//     working in a BACKGROUNDED tab: requestAnimationFrame does not fire there, so
//     a rebuild-based repaint would never land and the customer would close the
//     view — and snapshot their quote — with blank doors.
// Photos are downscaled to <=1024px: a 4000px phone photo is ~48MB of GPU memory
// per opening, and the 3D has to survive a mid-range phone.
const _d3FxTexCache = new Map();       // url → { tex, status: "loading" | "ready" | "error" }
const _d3FxMatBinds = new Map();       // placeholder tex → Set<material> awaiting the photo
let _d3FxTexPending = 0;
const _d3FxTexWaiters = [];            // one-shot resolvers (see d3WaitFixtureTextures)
const _d3FxTexListeners = new Set();   // per-viewer settle callbacks
const D3_FX_TEX_MAX = 1024;

function _d3FxTexSettle() {
  _d3FxTexPending = Math.max(0, _d3FxTexPending - 1);
  if (_d3FxTexPending === 0) { while (_d3FxTexWaiters.length) { const r = _d3FxTexWaiters.pop(); try { r(); } catch (_e) { /* noop */ } } }
  _d3FxTexListeners.forEach((cb) => { try { cb(); } catch (_e) { /* a listener must never break the load */ } });
}

// Shared, session-lived cache entry for a fixture photo URL: { tex, status }, where
// `tex` is null until the image has decoded. Never evicted — a disposed texture under a
// live model is exactly the hazard the grass-singleton note above warns about, and a
// tenant only has a handful of fixture photos.
//
// There is deliberately NO stand-in texture for the loading state. An earlier version
// served a 1x1 canvas in the door colour, which was wrong twice over: unlit, it landed
// within 12/255 of the SIDING colour, so a photo that never arrived read as a doorless
// wall rather than as the painted door it claims to fall back to. The painted door is now
// a real mesh that is always built, and the photo rides in front of it (see the fill
// branches) — so "loading", "failed" and "no photo" all look identical and correct.
function d3FixtureTexture(THREE, url) {
  if (!url || typeof document === "undefined") return null;
  const hit = _d3FxTexCache.get(url);
  if (hit) return hit;
  const entry = { tex: null, status: "loading" };
  _d3FxTexCache.set(url, entry);
  _d3FxTexPending++;
  const img = new Image();
  // Required: without CORS the downscale canvas is tainted and texImage2D throws.
  // Supabase public buckets send Access-Control-Allow-Origin, so this is clean.
  img.crossOrigin = "anonymous";
  img.onload = () => {
    try {
      const w = img.naturalWidth || img.width, h = img.naturalHeight || img.height;
      const s = Math.min(1, D3_FX_TEX_MAX / Math.max(w, h));
      const dw = Math.max(1, Math.round(w * s)), dh = Math.max(1, Math.round(h * s));
      const out = document.createElement("canvas");
      out.width = dw; out.height = dh;
      // No fill behind it: builders upload background-REMOVED cut-outs (every photo in
      // production is an RGBA PNG that is 50-65% fully transparent), and that alpha has
      // to survive into the texture so the painted door shows through instead of black.
      out.getContext("2d").drawImage(img, 0, 0, dw, dh);
      const photoTex = new THREE.CanvasTexture(out);
      if (THREE.SRGBColorSpace) photoTex.colorSpace = THREE.SRGBColorSpace;  // photos are sRGB
      photoTex.userData = { ssShared: true };     // disposeShed3DModel must skip this map
      entry.tex = photoTex;
      entry.status = "ready";
      // Show the photo on everything already built for it. Assigning a NEW texture is the
      // only thing three 0.167 honours (see the note above), and revealing the mesh here
      // rather than rebuilding keeps this working in a backgrounded tab, where rAF stops.
      const waiting = _d3FxMatBinds.get(entry);
      if (waiting) {
        waiting.forEach((b) => { b.mat.map = photoTex; b.mat.needsUpdate = true; if (b.mesh) b.mesh.visible = true; });
        _d3FxMatBinds.delete(entry);
      }
    } catch (_e) { entry.status = "error"; }       // painted door stays — never a black slab
    _d3FxTexSettle();
  };
  img.onerror = () => {
    entry.status = "error";
    // The materials waiting on this photo keep their painted fallback — but
    // the bind set must go, or it pins disposed materials forever (the load
    // path deletes it on success; this was the missed error path).
    _d3FxMatBinds.delete(entry);
    _d3FxTexSettle();
  };
  img.src = url;
  return entry;
}
// Remember a photo mesh + material built while the image was still loading, so the photo
// can be revealed the moment it lands. Anything built after the load already has it.
function d3BindFixturePhoto(entry, mat, mesh) {
  if (!entry || entry.status !== "loading") return mat;
  let set = _d3FxMatBinds.get(entry);
  if (!set) { set = new Set(); _d3FxMatBinds.set(entry, set); }
  set.add({ mat, mesh });
  return mat;
}
function d3FixtureTexturesPending() { return _d3FxTexPending; }
// Resolves when every in-flight photo has settled, or when the cap elapses —
// the quote PDF must not be captured with placeholder doors, but it must also
// never hang on a dead image host.
function d3WaitFixtureTextures(timeoutMs) {
  if (_d3FxTexPending === 0) return Promise.resolve();
  return new Promise((resolve) => {
    let done = false;
    const fire = () => { if (!done) { done = true; resolve(); } };
    _d3FxTexWaiters.push(fire);
    setTimeout(fire, Math.max(0, timeoutMs || 1500));
  });
}
function d3OnFixtureTexSettle(cb) { _d3FxTexListeners.add(cb); return () => _d3FxTexListeners.delete(cb); }

// ─── Environment (competitor-parity presentation: grass, sky, labels) ───
// SmartBuild-style scene dressing, all procedural canvases — no image assets.
// Grass: mottled two-green field tile. Sky: vertical gradient with soft cloud
// blobs, mapped onto a dome. Labels: flat text planes lying on the grass.
// The grass canvas is generated ONCE per session (module singleton): live-drag
// rebuilds create a fresh CanvasTexture per build (so dispose stays safe) from
// the SAME pixels — otherwise the noise re-rolls every rebuilt frame and the
// whole lawn shimmers while dragging an item.
let _d3GrassCanvas = null;
function d3MakeGrassTexture(THREE) {
  if (typeof document === "undefined") return null;
  if (!_d3GrassCanvas) {
    const N = 256, cv = document.createElement("canvas"); cv.width = cv.height = N;
    const g = cv.getContext("2d");
    g.fillStyle = "#7FA05B"; g.fillRect(0, 0, N, N);
    for (let i = 0; i < 240; i++) {            // mottled patches
      g.fillStyle = Math.random() < 0.5 ? "rgba(104,136,66,0.25)" : "rgba(150,178,100,0.22)";
      g.beginPath(); g.arc(Math.random() * N, Math.random() * N, 4 + Math.random() * 14, 0, Math.PI * 2); g.fill();
    }
    for (let i = 0; i < 900; i++) {            // fine blade speckle
      g.fillStyle = Math.random() < 0.5 ? "rgba(70,96,44,0.35)" : "rgba(172,198,122,0.30)";
      g.fillRect(Math.random() * N, Math.random() * N, 1.3, 2.2);
    }
    _d3GrassCanvas = cv;
  }
  const tex = new THREE.CanvasTexture(_d3GrassCanvas);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.anisotropy = 8;   // the lawn is the biggest grazing-angle surface on screen
  return tex;
}
function d3MakeSkyTexture(THREE) {
  if (typeof document === "undefined") return null;
  const W = 512, H = 512, cv = document.createElement("canvas"); cv.width = W; cv.height = H;
  const g = cv.getContext("2d");
  const grad = g.createLinearGradient(0, 0, 0, H);
  grad.addColorStop(0, "#7EB3E0"); grad.addColorStop(0.55, "#BAD4EA");
  grad.addColorStop(0.82, "#E8F0F6"); grad.addColorStop(1, "#F2F5F3");
  g.fillStyle = grad; g.fillRect(0, 0, W, H);
  for (let i = 0; i < 24; i++) {             // soft clouds in the upper band
    const x = Math.random() * W, y = H * (0.10 + Math.random() * 0.42), r = 20 + Math.random() * 40;
    const cg = g.createRadialGradient(x, y, 0, x, y, r);
    cg.addColorStop(0, "rgba(255,255,255,0.55)"); cg.addColorStop(1, "rgba(255,255,255,0)");
    g.fillStyle = cg;
    g.beginPath(); g.ellipse(x, y, r * 1.9, r * 0.6, 0, 0, Math.PI * 2); g.fill();
  }
  const tex = new THREE.CanvasTexture(cv);
  tex.wrapS = THREE.RepeatWrapping; tex.repeat.set(2, 1); // tile twice around the dome
  return tex;
}
// Flat text plane for on-ground dimension labels ("FRONT - 30'") and the N compass.
// Text canvases are cached by their text (a session sees a handful of distinct
// labels): rebuilds skip measureText/fillText and re-mint only the texture.
const _d3LabelCanvases = new Map();
function d3MakeGroundLabel(THREE, text, hFt) {
  if (typeof document === "undefined") return null;
  let cv = _d3LabelCanvases.get(text);
  if (!cv) {
    const probe = document.createElement("canvas").getContext("2d");
    probe.font = "700 44px Arial";
    cv = document.createElement("canvas");
    cv.width = Math.ceil(probe.measureText(text).width) + 24; cv.height = 64;
    const g = cv.getContext("2d");
    g.font = "700 44px Arial"; g.fillStyle = "rgba(62,48,36,0.85)";
    g.textBaseline = "middle"; g.fillText(text, 12, 34);
    _d3LabelCanvases.set(text, cv);
  }
  const tex = new THREE.CanvasTexture(cv);
  const m = new THREE.Mesh(
    new THREE.PlaneGeometry(hFt * (cv.width / cv.height), hFt),
    new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false })
  );
  m.rotation.x = -Math.PI / 2;               // lie flat on the grass
  return m;
}

// Dev-only build timing: set window.__SS3D_DEBUG = true in the console and
// every model build records a "ss3d:rebuild" performance measure. The flag
// gates all work, so shipped pages pay nothing.
function d3TimedBuild(fn) {
  if (typeof window === "undefined" || !window.__SS3D_DEBUG || typeof performance === "undefined" || !performance.mark) return fn();
  performance.mark("ss3d:rebuild:start");
  const out = fn();
  performance.mark("ss3d:rebuild:end");
  performance.measure("ss3d:rebuild", "ss3d:rebuild:start", "ss3d:rebuild:end");
  return out;
}

// Build the whole parametric building as one Group. World units are FEET; the
// footprint is centered on the origin with the floor top at y=0; +x = east and
// +z = south, matching the 2D plan (page-down = south). Returns { root, wallMat,
// roofGroup } so the viewer can ghost the shell for the "look inside" mode and
// dispose everything on close.
function buildShed3DModel(THREE, p) {
  const { bldgW, bldgH, items, itemTypes, bodyColor, trimColor, frontWall, scale, mgX, mgY } = p;
  // Wall height: config-driven when the tenant sets it (per-style wallHeightFt
  // in the config blob / building_sizes.wall_height_ft once 016 is applied),
  // else the D3 default (plan §6 gap #1).
  const H = p.wallHeightFt || D3.WALL_H, T = D3.WALL_T;
  const root = new THREE.Group();
  // Standard (PBR) materials, not Lambert: with the ACES tone mapping the viewer
  // sets, they are what makes painted siding read as PAINT and a metal roof as
  // METAL instead of flat matte plastic — the single biggest realism lever.
  // Roughness defaults high (wood/asphalt); callers override for metal.
  const mat = (color, extra) => new THREE.MeshStandardMaterial({ color, roughness: 0.85, metalness: 0.0, ...(extra || {}) });
  const wallMat = mat(bodyColor);
  const trimMat = mat(trimColor);
  // Battens are trim-coloured but need their OWN material, not trimMat. trimMat's other
  // users -- corner posts, fascia, rake boards -- all live in roofGroup, which "look
  // inside" hides wholesale, so trimMat has never needed a ghost path. Battens live in
  // wallsGroup and must ghost WITH the walls; teaching trimMat to ghost instead would also
  // ghost every opening casing, which is a visible change nobody asked for.
  const battenMat = mat(trimColor);
  const roofMat = mat(p.roofColor || D3_COLORS.roof);
  // Catalog fixture photos. Resolved LIVE from the catalog by fixtureItemId
  // rather than stamped on the item at placement (unlike price/name, which must
  // not move under a saved quote): re-uploading a better photo improves designs
  // already saved, and an archived fixture — dropped by get_fixtures — quietly
  // falls back to the painted slab instead of leaving a hole.
  const fxById = new Map((Array.isArray(p.fixtures) ? p.fixtures : []).map((fx) => [String(fx.id), fx]));
  // Returns the shared cache ENTRY ({ tex, status }) — not a texture — because the caller
  // needs to know whether the photo has decoded yet to decide if its layer is visible.
  const fixturePhotoTex = (it) => {
    if (it.fixtureItemId == null) return null;                 // built-in door/window
    const fx = fxById.get(String(it.fixtureItemId));
    if (!fx || !fx.imageUrl) return null;
    return d3FixtureTexture(THREE, fx.imageUrl);
  };
  // Cladding texture — multiplies the body color, so the customer's paint still drives
  // the hue while the pattern supplies the relief. One entry in D3_CLADDING decides the
  // raster, the relief style below, and the tile scale.
  const clad = D3_CLADDING[d3NormalizeCladding(p.styleSpec && p.styleSpec.siding)] || D3_CLADDING.panel;
  const wallKind = clad.tex;
  const wallTex = d3MakeTexture(THREE, wallKind);
  if (wallTex) {
    // One tile per tileFt of WORLD FEET: wallBox rewrites every face's UVs to feet, so the
    // repeat is a constant unit conversion, not a per-building guess. (The first cut set a
    // building-averaged repeat against 0..1 face UVs, which anchored nothing -- every face
    // still stretched its tiles to its own length; audit 2026-08-19.)
    wallTex.repeat.set(1 / clad.tileFtU, 1 / clad.tileFtV);
    wallMat.map = wallTex;
    const wallBump = d3MakeBumpTexture(THREE, wallKind);
    if (wallBump) { wallBump.repeat.copy(wallTex.repeat); wallMat.bumpMap = wallBump; wallMat.bumpScale = clad.bump; }
    // Metal reads as metal only with the surface response, not the pattern alone — the
    // same recipe the metal ROOF already uses.
    if (clad.metal) { wallMat.roughness = 0.45; wallMat.metalness = 0.35; }
  }
  const box = (m, w, h, d) => new THREE.Mesh(new THREE.BoxGeometry(w, h, d), m);

  // Page px → world ft (plan §3): same scale/mg the 2D plan renders with.
  const ftX = (px) => (px - mgX) / scale - bldgW / 2;
  const ftZ = (py) => (py - mgY) / scale - bldgH / 2;

  // Environment: grass field to the horizon + on-ground dimension labels
  // (SmartBuild-style landscape; the "Landscape" toggle hides this group).
  const envGroup = new THREE.Group();
  const R2 = Math.max(bldgW, bldgH);
  const groundR = Math.max(60, R2 * 7);      // stays inside the viewer's sky dome
  const grassTex = d3MakeGrassTexture(THREE);
  if (grassTex) grassTex.repeat.set(groundR / 5, groundR / 5);
  const ground = new THREE.Mesh(new THREE.CircleGeometry(groundR, 64),
    new THREE.MeshLambertMaterial({ color: "#9DBE77", ...(grassTex ? { map: grassTex } : {}) }));
  ground.rotation.x = -Math.PI / 2;
  ground.position.y = -D3.FLOOR_T;
  envGroup.add(ground);
  // Dimension labels on the grass for the FRONT and LEFT edges (same display
  // mapping the 2D labels use), plus a small N compass off the NW corner.
  const fwLbl = frontWall || "south";
  const lblH = Math.max(1.3, Math.min(3.2, R2 * 0.055));
  ["FRONT", "LEFT"].forEach((want) => {
    const pos = ["north", "south", "east", "west"].find((w) => getDisplayLabel(w, fwLbl) === want);
    if (!pos) return;
    const len = (pos === "north" || pos === "south") ? bldgW : bldgH;
    const lbl = d3MakeGroundLabel(THREE, `${want} - ${Math.round(len)}'`, lblH);
    if (!lbl) return;
    const off = 2 + lblH;
    const holder = new THREE.Group();
    if (pos === "north") { holder.position.set(0, 0, -bldgH / 2 - off); holder.rotation.y = Math.PI; }
    else if (pos === "south") { holder.position.set(0, 0, bldgH / 2 + off); }
    else if (pos === "west") { holder.position.set(-bldgW / 2 - off, 0, 0); holder.rotation.y = Math.PI / 2; }
    else { holder.position.set(bldgW / 2 + off, 0, 0); holder.rotation.y = -Math.PI / 2; }
    lbl.position.y = -D3.FLOOR_T + 0.04;
    holder.add(lbl);
    envGroup.add(holder);
  });
  const nLbl = d3MakeGroundLabel(THREE, "N", Math.max(1.6, lblH * 1.2));
  if (nLbl) { nLbl.position.set(-bldgW / 2 - R2 * 0.35, -D3.FLOOR_T + 0.04, -bldgH / 2 - R2 * 0.35); envGroup.add(nLbl); }
  root.add(envGroup);
  // Base. A slab by default; runners when the style says so. Everything below is drawn
  // INSIDE the slab's own 0.35 ft band, on purpose: the ground plane, every ramp's rise
  // (which reads D3.FLOOR_T for its drop) and the compass labels are all pinned to that
  // depth, so raising the building to make room for skids would silently leave every ramp
  // short. Same envelope, different reading.
  // `floor` stays in the OUTER scope because the shadow pass below still needs the base
  // mesh by name, whichever branch made it.
  let floor;
  if ((p.styleSpec && p.styleSpec.foundation) !== "skids") {
    floor = box(mat(D3_COLORS.floor), bldgW + 0.2, D3.FLOOR_T, bldgH + 0.2);
    floor.position.y = -D3.FLOOR_T / 2;
    root.add(floor);
  } else {
    // A portable building sits on runners. The shadow gap under the deck is what says
    // "this gets delivered" instead of "this was poured here".
    const DECK_T = 0.12;
    const SKID_T = D3.FLOOR_T - DECK_T;      // reads as a 4x4 under a thin deck
    const SKID_W = 3.5 / 12;
    const deck = box(mat(D3_COLORS.floor), bldgW + 0.2, DECK_T, bldgH + 0.2);
    deck.position.y = -DECK_T / 2;
    root.add(deck);
    floor = deck;
    // Runners follow the LONG axis, the way they are framed and the way a trailer pulls
    // them, and the COUNT is a rule — no unsupported run wider than about 4 ft — so it
    // scales with the building instead of being a number that is right for one size.
    const alongX = bldgW >= bldgH;
    const across = alongX ? bldgH : bldgW;
    const nSkid = Math.max(2, Math.round(across / 4));
    const inset = Math.min(1.0, across * 0.14);
    for (let i = 0; i < nSkid; i++) {
      const t = nSkid === 1 ? 0.5 : i / (nSkid - 1);
      const at = -across / 2 + inset + t * (across - 2 * inset);
      const sk = alongX
        ? box(mat(D3_COLORS.bench), bldgW + 0.2, SKID_T, SKID_W)
        : box(mat(D3_COLORS.bench), SKID_W, SKID_T, bldgH + 0.2);
      sk.position.set(alongX ? 0 : at, -DECK_T - SKID_T / 2, alongX ? at : 0);
      root.add(sk);
    }
  }

  // Wall frames: O = the wall's along=0 end (in x/z), U = unit vector along the
  // wall, N = exterior normal. `along` runs west→east on N/S walls and
  // north→south on E/W walls — exactly how the 2D snap logic measures items.
  const WALLS = {
    north: { len: bldgW, O: [-bldgW / 2, -bldgH / 2], U: [1, 0], N: [0, -1] },
    south: { len: bldgW, O: [-bldgW / 2, bldgH / 2],  U: [1, 0], N: [0, 1] },
    west:  { len: bldgH, O: [-bldgW / 2, -bldgH / 2], U: [0, 1], N: [-1, 0] },
    east:  { len: bldgH, O: [bldgW / 2, -bldgH / 2],  U: [0, 1], N: [1, 0] },
  };
  const wallsGroup = new THREE.Group();     // ghosted in "look inside" mode
  const openingsGroup = new THREE.Group();  // frames + door/window fills (stay solid)

  // Place a box on wall `wf` spanning [a0,a1] along it and [y0,y1] vertically,
  // `out` ft toward the exterior, `depth` ft thick (defaults to wall thickness).
  const wallBox = (m, wf, a0, a1, y0, y1, out, depth) => {
    const b = box(m, a1 - a0, y1 - y0, depth || T);
    // WORLD-FEET UVs -- the actual anchoring. Stock BoxGeometry UVs span 0..1 per face, so
    // with a shared repeat every segment crammed the full tile count into its own face
    // (a 2 ft strip beside a door drew the same course count as a 12 ft wall), and the
    // gable cap -- whose ExtrudeGeometry UVs ARE in profile feet -- tiled 8-24x denser
    // than the wall under it (audit 2026-08-19; setting wallTex.repeat alone never
    // delivered what its comment claimed). Rewriting u/v to wall-run/height FEET makes
    // the single wallMat repeat of 1/tileFt land every face at true scale, keeps the
    // texture's drawn ribs in phase with the proud relief strips (both count feet from
    // the wall origin), and lines the cap's courses up with the wall's at the plate line.
    // The box's thin edge faces get stripe UVs out of this; they are 0.3 ft slivers
    // buried in corner trim, invisible either way.
    const uvA = b.geometry.attributes.uv, posA = b.geometry.attributes.position;
    const cu = (a0 + a1) / 2, cv = (y0 + y1) / 2;
    for (let i = 0; i < uvA.count; i++) uvA.setXY(i, posA.getX(i) + cu, posA.getY(i) + cv);
    uvA.needsUpdate = true;
    const ac = (a0 + a1) / 2;
    b.position.set(
      wf.O[0] + wf.U[0] * ac + wf.N[0] * (out || 0),
      (y0 + y1) / 2,
      wf.O[1] + wf.U[1] * ac + wf.N[1] * (out || 0)
    );
    if (wf.U[0] === 0) b.rotation.y = Math.PI / 2;
    return b;
  };

  // WORLD-FEET UVs for a roof slab -- and the fix for a defect that shipped with the very
  // first textured roof, because this was the ONE textured surface with no UV rewrite.
  //
  // A slab is box(w = along the SLOPE, h = thickness, d = along the RIDGE), and stock
  // BoxGeometry maps its top face u -> local x and v -> local z. So u ran DOWN THE SLOPE
  // and v ran ALONG THE RIDGE, while both rasters are drawn on exactly the opposite
  // assumption:
  //   * metal draws its standing seams at constant canvas-x, i.e. constant u -- so the
  //     seams came out running ALONG THE EAVE. Real standing seam runs eave-to-ridge.
  //   * shingle draws its course shadows at constant canvas-y, i.e. constant v -- so the
  //     courses came out running UP THE SLOPE. Real courses run along the eave.
  // Each is wrong in the opposite direction, so ONE axis swap fixes both. Carolyn's note
  // about the walls -- "metal runs up and down, not this way" (2026-08-24) -- was the same
  // defect on a smaller surface; the walls were already right, the roof never was.
  //
  // u = feet along the ridge, v = feet down the slope, the same unit wallBox uses, so the
  // repeat numbers beside it read as real dimensions instead of tile counts. Phase is
  // arbitrary here (nothing on a roof has to line up with a wall origin), so the box's own
  // centred coordinates go straight in.
  const d3RoofSlabUVs = (slab) => {
    const uvA = slab.geometry.attributes.uv, posA = slab.geometry.attributes.position;
    for (let i = 0; i < uvA.count; i++) uvA.setXY(i, posA.getZ(i), posA.getX(i));
    uvA.needsUpdate = true;
  };

  // Opening vertical extent: item-stamped fields first (Phase 5 — placed items
  // carry openingHeightFt/sillFt), D3 defaults for legacy designs.
  // Catalog fixtures carry their real size as widthIn/heightIn instead of the
  // Phase 5 stamps, so a 7 ft roll-up finally reads taller than a walk door.
  // Everything is clamped to leave a header strip under the plate: the customer
  // can pick 6 ft walls in this very modal, and an unclamped 6'8" door would
  // push its casing into the roof and silently skip the header segment.
  const openingSpan = (it) => {
    const inchesFt = (v) => (Number(v) > 0 ? Number(v) / 12 : null);
    const maxTop = H - 0.2;
    if (it.type === "window") {
      const wh = Math.min(it.openingHeightFt || inchesFt(it.heightIn) || D3.WINDOW_H, maxTop - 0.35);
      let s0 = it.sillFt != null ? it.sillFt : D3.WINDOW_SILL;
      if (s0 + wh > maxTop) s0 = Math.max(0.35, maxTop - wh);   // tall window, short wall: drop the sill
      return [s0, s0 + wh];
    }
    if (it.type === "roughOpening") return [0, Math.min(it.openingHeightFt || D3.RO_H, maxTop)];
    // singleDoor / doubleDoor / fixtureDoor (every catalog door placement)
    return [0, Math.min(it.openingHeightFt || inchesFt(it.heightIn) || D3.DOOR_H, maxTop)];
  };

  // One wall's segments + opening groups, buildable in isolation: the live
  // drag rebuilds ONLY the wall(s) an item left and landed on (rebuildWalls on
  // the returned model) — same code as the full build, so a partial rebuild's
  // output is identical to a full one by construction.
  const buildOneWall = (wname, itemsNow) => {
    const wf = WALLS[wname];
    const ops = itemsNow
      .filter((it) => { const c = itemTypes[it.type]; return c && c.wallOnly && it.wall === wname; })
      .map((it) => {
        const c = itemTypes[it.type];
        const w = it.widthFt || c.width;
        const along = wf.U[0] ? (it.x - mgX) / scale : (it.y - mgY) / scale;
        const a = Math.max(w / 2, Math.min(along, wf.len - w / 2));
        const span = openingSpan(it);
        return { it, a, a0: a - w / 2, a1: a + w / 2, y0: span[0], y1: span[1] };
      })
      .sort((q, r) => q.a0 - r.a0);

    // Union overlapping opening ranges (e.g. a window over a door — the 2D
    // collision check only guards door-vs-door) so wall segments never
    // intersect a hole.
    const ranges = [];
    ops.forEach((o) => {
      const last = ranges[ranges.length - 1];
      if (last && o.a0 < last.a1 - 0.01) {
        last.a1 = Math.max(last.a1, o.a1);
        last.y0 = Math.min(last.y0, o.y0);
        last.y1 = Math.max(last.y1, o.y1);
      } else ranges.push({ a0: o.a0, a1: o.a1, y0: o.y0, y1: o.y1 });
    });

    // Panel-split walls (plan §4.4 fallback strategy, chosen over CSG for the
    // no-build stack): full-height segments between openings, plus sill/header
    // strips below/above each opening range. Segments live in a per-wall group
    // tagged with the wall name so the 3D palette can place new items by
    // clicking a wall.
    const wg = new THREE.Group();
    wg.userData = { wall: wname };
    let cursor = 0;
    ranges.forEach((rg) => {
      if (rg.a0 > cursor + 0.01) wg.add(wallBox(wallMat, wf, cursor, rg.a0, 0, H));
      if (rg.y0 > 0.01) wg.add(wallBox(wallMat, wf, rg.a0, rg.a1, 0, rg.y0));
      if (rg.y1 < H - 0.01) wg.add(wallBox(wallMat, wf, rg.a0, rg.a1, rg.y1, H));
      cursor = rg.a1;
    });
    if (cursor < wf.len - 0.01) wg.add(wallBox(wallMat, wf, cursor, wf.len, 0, H));
    // Cladding relief on the exterior of the full-height segments (strips break at
    // openings, like real cladding). Real geometry on top of the texture, so the material
    // still reads at a grazing angle where a flat map flattens out.
    //   batten  proud VERTICAL battens (board-and-batten)
    //   lap     proud HORIZONTAL course lines, stepped by the same exposure the raster uses
    //   rib     proud vertical metal RIBS (Panel-Loc): narrower and shallower than a batten
    //   null    panel siding has its grooves cut INTO the face, so it gets NO proud strips.
    //           The old code gave it battens, which is the opposite of the real product.
    if (clad.relief) {
      const relief = (b0, b1) => {
        if (b1 - b0 < 0.3) return;
        if (clad.relief === "batten" || clad.relief === "rib") {
          const bs = clad.stepFt;
          const halfW = clad.relief === "rib" ? 0.05 : 0.07;
          const depth = clad.relief === "rib" ? 0.05 : 0.1;
          const reliefMat = clad.reliefTrim ? battenMat : wallMat;
          for (let a = Math.ceil((b0 + 0.2) / bs) * bs; a < b1 - 0.2; a += bs) {
            wg.add(wallBox(reliefMat, wf, a - halfW, a + halfW, 0, H, T / 2 + 0.03, depth));
          }
        } else {
          for (let y = clad.stepFt; y < H - 0.15; y += clad.stepFt) {
            wg.add(wallBox(wallMat, wf, b0 + 0.03, b1 - 0.03, y - 0.04, y + 0.04, T / 2 + 0.03, 0.1));
          }
        }
      };
      let bc = 0;
      ranges.forEach((rg) => { if (rg.a0 > bc + 0.01) relief(bc, rg.a0); bc = rg.a1; });
      if (bc < wf.len - 0.01) relief(bc, wf.len);
    }
    const ogs = [];

    // Frames + fills per opening (trim-colored casing; doors get panels,
    // windows get glass + muntins, rough openings stay empty). Each opening's
    // meshes live in their own tagged group so the 3D drag can raycast-pick
    // the item they belong to.
    ops.forEach((o) => {
      const f = 0.17;
      const og = new THREE.Group();
      og.userData = { itemId: o.it.id, wallItem: true, wall: wname };
      // A two-tone catalog door's chosen TRIM color drives its own casing; everything
      // else keeps the building trim (windows deliberately so — their color is the sash).
      const casingMat = (o.it.type === "fixtureDoor" && o.it.trimColorHex) ? mat(o.it.trimColorHex) : trimMat;
      og.add(wallBox(casingMat, wf, o.a0 - f, o.a0, o.y0, o.y1 + f, 0, T + 0.06));
      og.add(wallBox(casingMat, wf, o.a1, o.a1 + f, o.y0, o.y1 + f, 0, T + 0.06));
      og.add(wallBox(casingMat, wf, o.a0 - f, o.a1 + f, o.y1, o.y1 + f, 0, T + 0.06));
      // A catalog fixture's own photo is masked onto the opening when the builder
      // uploaded one — but it is LAYERED IN FRONT of the parametric door/glass, never
      // instead of it, for two reasons that both bit us:
      //   · builders upload background-REMOVED cut-outs (every photo in production is an
      //     RGBA PNG, 50-65% fully transparent), so the parametric fill is what shows
      //     through the cut-away parts. Without it those pixels rendered pure BLACK, and
      //     that black door went onto the customer's quote.
      //   · while the photo loads (or if it 404s), there is something correct on screen.
      // MeshBasicMaterial for the photo, not Lambert: a photo already carries the light it
      // was shot in, and shading it again reads as a dirty smudge. The photo stretches to
      // the opening on purpose — one photo serves a door's 4/5/6 ft variants, which is the
      // whole point of not keeping a model library.
      const photoLayer = (entry, a0, a1, y0, y1, depth, tintHex) => {
        // alphaTest discards the transparent surround (cheaper and better-sorted than
        // blending it); transparent:true keeps the feathered edges of a soft cut-out.
        const pm = new THREE.MeshBasicMaterial({ map: entry.tex, transparent: true, alphaTest: 0.06 });
        // Chosen fixture color TINTS the photo (three.js multiplies material.color into the
        // map): white product-photo pixels take the color fully, so the mostly-white
        // cut-outs builders upload read as painted. A photo of an already-dark door
        // over-darkens — acceptable; the color choice must show somewhere.
        if (tintHex) { try { pm.color.set(tintHex); } catch (_e) { /* bad hex: leave untinted */ } }
        const mesh = wallBox(pm, wf, a0, a1, y0, y1, 0.02, depth);   // 0.02 ft proud: no z-fight
        mesh.visible = Boolean(entry.tex);        // hidden until the photo has decoded
        d3BindFixturePhoto(entry, pm, mesh);
        og.add(mesh);
      };
      if (o.it.type === "window") {
        og.add(wallBox(trimMat, wf, o.a0 - f, o.a1 + f, o.y0 - f, o.y0, 0, T + 0.06));
        // Sill nose: a slightly wider, deeper board under the casing — the one
        // horizontal shadow line that makes the window read as installed.
        og.add(wallBox(trimMat, wf, o.a0 - f - 0.03, o.a1 + f + 0.03, o.y0 - 0.06, o.y0 + 0.02, T / 2 + 0.04, 0.16));
        // Sash: a slim dark inner ring set INTO the opening. The depth step
        // between casing → sash → glass is what turns the old flat decal into
        // an assembly (the SmartBuild teardown's biggest close-up win).
        const s = 0.09;
        // A catalog window's chosen color drives the sash (and muntins below) — the
        // "frame" a shopper means when they say a black or white window.
        const sashMat = mat(o.it.colorHex || "#3A3F45", { roughness: 0.6 });
        og.add(wallBox(sashMat, wf, o.a0, o.a0 + s, o.y0, o.y1, 0, T * 0.5));
        og.add(wallBox(sashMat, wf, o.a1 - s, o.a1, o.y0, o.y1, 0, T * 0.5));
        og.add(wallBox(sashMat, wf, o.a0, o.a1, o.y1 - s, o.y1, 0, T * 0.5));
        og.add(wallBox(sashMat, wf, o.a0, o.a1, o.y0, o.y0 + s, 0, T * 0.5));
        // Glass you can genuinely see through — the interior showing through
        // the panes is what sells it. Slight blue-green tint, a whisper of
        // metalness for sky glint; depthWrite off so the ghosted look-inside
        // mode never sorts against it.
        og.add(wallBox(mat("#BFE0E8", { transparent: true, opacity: 0.22, roughness: 0.05, metalness: 0.4, side: THREE.DoubleSide, depthWrite: false }), wf, o.a0 + s, o.a1 - s, o.y0 + s, o.y1 - s, 0, 0.05));
        const winEntry = fixturePhotoTex(o.it);
        if (winEntry) {
          photoLayer(winEntry, o.a0 + 0.05, o.a1 - 0.05, o.y0 + 0.05, o.y1 - 0.05, 0.08, o.it.colorHex || null);
        } else {
          // Muntin GRID sized to the sash (a lone cross read flat): 2-3 columns
          // by width, double-hung rail across the middle. Sash-colored so a black
          // window reads black through the grid, not building-trim.
          const ww = o.a1 - o.a0, wh = o.y1 - o.y0;
          const cols = Math.max(2, Math.min(3, Math.round(ww / 1.1)));
          for (let ci = 1; ci < cols; ci++) {
            const a = o.a0 + (ww * ci) / cols;
            og.add(wallBox(sashMat, wf, a - 0.03, a + 0.03, o.y0 + s, o.y1 - s, 0, 0.09));
          }
          const midY = o.y0 + wh / 2;
          og.add(wallBox(sashMat, wf, o.a0 + s, o.a1 - s, midY - 0.035, midY + 0.035, 0, 0.09));
        }
      } else if (o.it.type === "singleDoor" || o.it.type === "doubleDoor" || o.it.type === "fixtureDoor") {
        const photoEntry = fixturePhotoTex(o.it);
        {
          // The chosen door color drives the slab; no color chosen (built-ins, fixed-mode
          // doors with no palette row) keeps the hard-coded natural brown as before.
          const doorMat = mat(o.it.colorHex || D3_COLORS.door);
          if (o.it.type === "doubleDoor" || o.it.operation === "double") {
            og.add(wallBox(doorMat, wf, o.a0 + 0.05, o.a - 0.03, 0.05, o.y1 - 0.05, 0, 0.16));
            og.add(wallBox(doorMat, wf, o.a + 0.03, o.a1 - 0.05, 0.05, o.y1 - 0.05, 0, 0.16));
          } else {
            if (o.it.operation === "slideup" && !photoEntry) {
              // Roll-up read: reuse the lap texture as ~1 ft horizontal panel
              // seams, matching the segmented glyph the 2D plan draws.
              const seamTex = d3MakeTexture(THREE, "lap");
              if (seamTex) { seamTex.repeat.set(1, Math.max(2, Math.round(o.y1 - 0.1))); doorMat.map = seamTex; }
            }
            og.add(wallBox(doorMat, wf, o.a0 + 0.05, o.a1 - 0.05, 0.05, o.y1 - 0.05, 0, 0.16));
            if (!photoEntry && o.it.operation !== "slideup") {
              // Raised panels + a handle on a plain hinged slab — the relief
              // shadows are what stop it reading as a painted rectangle.
              const pa0 = o.a0 + 0.22, pa1 = o.a1 - 0.22, ph = o.y1 - 0.05;
              og.add(wallBox(doorMat, wf, pa0, pa1, ph * 0.55, ph - 0.18, 0.1, 0.05));
              og.add(wallBox(doorMat, wf, pa0, pa1, 0.22, ph * 0.45, 0.1, 0.05));
              og.add(wallBox(mat("#6B7280", { metalness: 0.6, roughness: 0.3 }), wf, o.a1 - 0.38, o.a1 - 0.24, 3.0, 3.14, 0.12, 0.08));
            }
          }
        }
        // One photo layer even for a double or a roll-up: the photo already shows both
        // leaves / the panel seams, so splitting it would draw them twice.
        if (photoEntry) photoLayer(photoEntry, o.a0 + 0.05, o.a1 - 0.05, 0.05, o.y1 - 0.05, 0.16, o.it.colorHex || null);
      }
      ogs.push(og);
    });
    return { wg, ogs };
  };
  Object.keys(WALLS).forEach((wname) => {
    const built = buildOneWall(wname, items);
    wallsGroup.add(built.wg);
    built.ogs.forEach((og) => openingsGroup.add(og));
  });

  // ── Roof (plan §4.2): a solid extruded profile in body color (its caps ARE
  // the gable/gambrel end walls) with roof-colored overhanging slope slabs on
  // top. Ridge runs front↔back so the gable end faces the customer's FRONT
  // (derived from door placement, same rule the 2D labels use); the econo shed
  // slope descends front→back. No doors yet → longer axis.
  const roofGroup = new THREE.Group();
  const roofCfg = (p.styleSpec && p.styleSpec.roof) || D3_DEFAULT_ROOF;
  const OV = roofCfg.overhang != null ? roofCfg.overhang : D3.OVERHANG;
  // Eave finish. An AFFIRMATIVE test on purpose: absent, null, "fascia" and any junk
  // all fall through to the fascia branch, so no tenant who has not opted in moves.
  const EAVE_OPEN = roofCfg.eave === "open";
  // Raw, unpainted 2x stock for the tails. Created lazily so a model with no open eave
  // never mints it — a material built and never attached to a mesh is never reached by
  // the disposal walk, and is the one thing here that could actually leak.
  let _tailMat = null;
  const tailMat = () => (_tailMat || (_tailMat = mat(D3_COLORS.bench, { roughness: 0.95 })));
  const fw = frontWall || (bldgH >= bldgW ? "north" : "west");
  const frontNS = fw === "north" || fw === "south";
  // Profile u-axis: the axis the roof profile spans across. For gable/gambrel
  // the ridge is perpendicular to the front; for the shed the SLOPE runs
  // front→back, so the axes swap.
  const uAxisIsX = roofCfg.type === "shed" ? !frontNS : frontNS;
  const S = uAxisIsX ? bldgW : bldgH;   // profile span
  const L = uAxisIsX ? bldgH : bldgW;   // extrusion length
  // One profile builder, shared with the calibration panel's elevation drawing.
  const _rp = d3RoofProfile(roofCfg, S, H, fw === "north" || fw === "west");
  const prof = _rp.prof;      // profile polygon points [u, y], eave→ridge→eave
  const slopes = _rp.slopes;  // top edges [[A,B], …] that get roof slabs
  const dedup = _rp.dedup;
  const shape = new THREE.Shape();
  dedup.forEach((pt, i) => (i === 0 ? shape.moveTo(pt[0], pt[1]) : shape.lineTo(pt[0], pt[1])));
  const rg = new THREE.Group(); // local space: x = profile u, y = up, z = 0..L along the ridge
  // The gable END FACES are this extrusion's caps, and they are the wall above the plate
  // line — so they must carry the CLADDING, or the siding visibly stops at the plate and
  // the peak is a flat wedge. That is what Carolyn pointed at: "this needs to go on up,
  // on the top" (2026-08-18).
  //
  // It used to be flat body color deliberately, because sampling the wall texture through
  // profile-unit UVs "painted a smeared pale wedge". The fix is the material GROUP, not a
  // different texture: ExtrudeGeometry emits group 0 = the two caps and group 1 = the swept
  // sides, and its default WorldUVGenerator gives the caps UVs equal to profile-space
  // (u, y) in FEET — the same world-anchored convention the walls now use — so wallMat
  // tiles across the gable at true scale and in phase with the wall below it.
  //
  // gableMat stays and becomes the SOFFIT material (the swept underside), which keeps
  // applyShellMode's existing ghost block and the live body-color write working unchanged.
  // The guard matters: group ordering is a three.js internal, not a documented API, so a
  // shape that does not produce exactly two groups falls back to today's behaviour rather
  // than painting the soffit with cladding — which would look like the very defect this
  // fixes, with a false green light.
  const gableMat = mat(bodyColor);
  const gableGeom = new THREE.ExtrudeGeometry(shape, { depth: L, bevelEnabled: false });
  // U-PHASE. ExtrudeGeometry's WorldUVGenerator gives the caps UVs in profile-space feet,
  // which is the same unit wallBox uses -- but a DIFFERENT ORIGIN. The wall's u runs 0..S
  // from the wall origin; the cap's runs -S/2..+S/2 from the building centre. So the two
  // are out of phase by exactly S/2 unless the half-span happens to be a whole number of
  // tiles. On a 14 ft wall at tileFtU 3.0 that is a third of a tile: every groove, rib and
  // seam visibly jogs sideways as it crosses the plate line. Shifting u by S/2 lines them
  // up. v needs no shift -- both conventions already measure height from y = 0, which is
  // why the horizontal lap courses were the one pattern that always matched.
  {
    const guv = gableGeom.attributes.uv;
    if (guv) {
      for (let i = 0; i < guv.count; i++) guv.setX(i, guv.getX(i) + S / 2);
      guv.needsUpdate = true;
    }
  }
  rg.add(new THREE.Mesh(gableGeom,
    (gableGeom.groups && gableGeom.groups.length === 2) ? [wallMat, gableMat] : gableMat));

  // Height of the roof profile at a given profile-u. The profile is just the dedup'd top
  // polyline, so one piecewise-linear walk serves gable, gambrel and shed alike.
  const profYAt = (u) => {
    for (let i = 0; i + 1 < dedup.length; i++) {
      const A = dedup[i], B = dedup[i + 1];
      const lo = Math.min(A[0], B[0]), hi = Math.max(A[0], B[0]);
      if (u < lo - 1e-6 || u > hi + 1e-6) continue;
      if (Math.abs(B[0] - A[0]) < 1e-6) return Math.max(A[1], B[1]);
      return A[1] + ((u - A[0]) / (B[0] - A[0])) * (B[1] - A[1]);
    }
    return H;
  };

  // ── LEAN-TO (2026-08-25) ──────────────────────────────────────────────────────────
  // A shed-roofed appendage off ONE eave wall: the second of the two things "lean-to"
  // means in this trade. The first -- a standalone single-slope building -- has always
  // shipped as roof.type "shed", which is why that option now reads "Single slant".
  //
  // ADDITIVE, not a new roof type, and that is load-bearing rather than stylistic. One
  // Supabase project serves beta and production off one `building_styles.d3` table, and
  // the production profile builder's `else` catches every unknown type and draws a GABLE.
  // A new type would therefore show production customers a plain gable the moment someone
  // calibrated a lean-to on beta. As extra keys, an older renderer ignores them and draws
  // the base building -- the appendage is missing, which is honest, rather than the roof
  // being wrong, which is not.
  //
  // Lives in rg, so "look inside" hides it with the roof. That is the right reading: you
  // are looking inside the MAIN building, and an open lean-to has no inside.
  const leanW = roofCfg.leanToWidthFt || 0;
  if (leanW > 0.5) {
    const drop = Math.min(roofCfg.leanToDropFt != null ? roofCfg.leanToDropFt : 1, H - 1.5);
    const dir = roofCfg.leanToSide === "left" ? -1 : 1;   // which eave it hangs off
    const u0 = dir * (S / 2), u1 = u0 + dir * leanW;
    const y0 = H, y1 = H - drop;
    const du = u1 - u0, dy = y1 - y0;
    const slen = Math.sqrt(du * du + dy * dy) || 1;
    const ux = du / slen, uy = dy / slen;
    // One slab, running from the main wall out past the free edge by the eave overhang.
    const lslab = box(roofMat, slen + OV, D3.ROOF_T, L + OV * 2);
    d3RoofSlabUVs(lslab);
    lslab.rotation.z = Math.atan2(dy, du);
    lslab.position.set((u0 + u1) / 2 + ux * OV / 2,
                       (y0 + y1) / 2 + uy * OV / 2 + D3.ROOF_T / 2,
                       L / 2);
    rg.add(lslab);
    // Posts at the free edge. Two is what a shed lot actually builds under 12 ft; longer
    // runs get a third rather than an unsupported header.
    const nPost = L > 12 ? 3 : 2;
    const inset = Math.min(0.8, L * 0.08);
    for (let i = 0; i < nPost; i++) {
      const t = nPost === 1 ? 0.5 : i / (nPost - 1);
      const post = box(trimMat, 0.3, y1, 0.3);
      post.position.set(u1, y1 / 2, inset + t * (L - 2 * inset));
      rg.add(post);
    }
    const hdr = box(trimMat, 0.35, 0.5, L);     // header tying the posts together
    hdr.position.set(u1, y1 - 0.25, L / 2);
    rg.add(hdr);
  }

  // ── DORMER (2026-08-25) ──────────────────────────────────────────────────────────
  // COSMETIC BY CONSTRUCTION, and that is a deliberate limit rather than a shortcut.
  // There is no CSG in this renderer, so the dormer sits ON the slope and intersects the
  // roof slab instead of cutting a hole through it. From outside that reads correctly --
  // the dormer face is opaque either way -- and "look inside" hides the whole roofGroup,
  // so the missing opening is never visible from within either. A real roof cut-out needs
  // a boolean op this engine has no business growing three weeks before a trade show.
  //
  // Skipped on a shed roof: a dormer on a single slope is a shed dormer, which is a
  // different massing, and drawing a gable dormer there would be wrong rather than simple.
  const dormW = roofCfg.dormerWidthFt || 0;
  if (dormW > 0.5 && roofCfg.type !== "shed") {
    const dRise = roofCfg.dormerRiseFt != null ? roofCfg.dormerRiseFt : 2.5;
    // offsetU is a fraction of the HALF-SPAN, so it reads the way kneeU does. Held off
    // the ridge and the eave so the dormer cannot overhang either edge.
    const fr = Math.max(-0.85, Math.min(0.85, roofCfg.dormerOffsetU != null ? roofCfg.dormerOffsetU : 0.45));
    const dU = (S / 2) * fr;
    const baseY = profYAt(dU);
    const dDepth = 2.0;
    const dormMat = mat(bodyColor);
    const body = box(dormMat, dDepth, dRise, dormW);
    body.position.set(dU, baseY + dRise / 2, L / 2);
    rg.add(body);
    // A little gable cap, so it does not read as a packing crate glued to the roof.
    const capRise = Math.max(0.5, dormW * 0.22);
    const half = dormW / 2;
    const clen = Math.sqrt(half * half + capRise * capRise);
    [-1, 1].forEach((sgn) => {
      const cap = box(roofMat, dDepth + 0.6, D3.ROOF_T, clen);
      d3RoofSlabUVs(cap);
      cap.rotation.x = sgn * Math.atan2(capRise, half);
      cap.position.set(dU, baseY + dRise + capRise / 2, L / 2 + sgn * half / 2);
      rg.add(cap);
    });
  }

  // PROUD RELIEF DOES NOT STOP AT THE PLATE LINE.
  //
  // The clad.relief loop lives inside buildOneWall and runs nowhere else, so on a batten or
  // metal style the PHYSICAL vertical strips stopped dead at the wall plate while the flat
  // texture on the cap carried on above them. From any three-quarter view that reads exactly
  // as "the siding doesn't go straight up" -- which is what Carolyn has now said three times
  // (2026-08-18, and again 2026-08-24: "this going up, it has to go straight up"). Giving
  // the cap the wall texture, which is what the 08-18 fix did, was necessary and not
  // sufficient: the texture matched and the geometry still stopped.
  //
  // Strips are placed at u = k*stepFt - S/2 so they stay IN PHASE with the wall strips
  // below, which step from the wall origin -- the same S/2 that just fixed the texture.
  // Each is clipped to the profile above it, so it stops on the roof line instead of poking
  // through the slab. They live in rg, so "look inside" hides them with the roof, exactly
  // like the cap they sit on.
  if (clad.relief === "batten" || clad.relief === "rib") {
    const bs = clad.stepFt;
    const halfW = clad.relief === "rib" ? 0.05 : 0.07;
    const depth = clad.relief === "rib" ? 0.05 : 0.1;
    const reliefMat = clad.reliefTrim ? battenMat : wallMat;
    // ⚠️ CLIP TO THE LOWEST PROFILE ACROSS THE STRIP'S WIDTH, NEVER ITS CENTRE.
    // A batten is a BOX: its top is flat. The roof above it is not. Taking profYAt(u) at the
    // strip's centre puts that flat top at the centre height, so on any slope the upper
    // corner stands proud of the roof plane by halfW x slope — about an inch and a half on a
    // gambrel's lower pitch, which is exactly the row of red slivers poking through the
    // shingles along the rake and at the knee (reported 2026-08-26 with a screenshot:
    // "I need uniformity in this, it should not break").
    //
    // Sampling both edges is not enough on a gambrel: the KNEE is a peak that can sit inside
    // a strip, where both edges read lower than the middle. So every profile vertex falling
    // within the strip is sampled too, and the minimum wins. The strip then always stops ON
    // or just under the roof line — never through it — at every u, on every roof type.
    for (let k = 1; k * bs < S; k++) {
      const u = k * bs - S / 2;
      let yTop = Math.min(profYAt(u - halfW), profYAt(u), profYAt(u + halfW));
      for (let i = 0; i < dedup.length; i++) {
        const vx = dedup[i][0];
        if (vx > u - halfW && vx < u + halfW) yTop = Math.min(yTop, profYAt(vx));
      }
      if (yTop <= H + 0.05) continue;            // below the plate: the wall already has it
      [-(depth / 2) - 0.02, L + (depth / 2) + 0.02].forEach((z) => {
        const st = box(reliefMat, halfW * 2, yTop - H, depth);
        st.position.set(u, (H + yTop) / 2, z);
        rg.add(st);
      });
    }
  }
  // Roof texture: metal standing-seam vs shingle courses. The customer's
  // roof-type pick wins; the STYLE's own roofMaterial (photo-derived, in d3)
  // fills in before any pick — a bare flat-color slab was the single biggest
  // "this looks fake" tell. Metal also gets a metal SURFACE (lower roughness,
  // some metalness) so the sun actually glints off the pans.
  const roofKind = p.roofType === "Metal" ? "metal"
    : p.roofType === "Shingle" ? "shingle"
    : (p.styleSpec && (p.styleSpec.roofMaterial === "metal" || p.styleSpec.roofMaterial === "shingle") ? p.styleSpec.roofMaterial : "shingle");
  // Roof tile size in FEET, as (along the ridge, down the slope), paired with the
  // world-feet UV rewrite on each slab. A `repeat` without that rewrite anchors nothing --
  // the same lesson the walls learned in the 2026-08-19 audit, where a repeat whose comment
  // claimed world anchoring was in fact dividing each face's own 0..1 span.
  //
  // metal: the raster lays 4 standing-seam pans across one 512px tile, so 6 ft along the
  //   ridge puts a seam every 18 inches -- a real pan width. It is uniform down the pan,
  //   so the second number only bounds anisotropy.
  // shingle: 6 tabs across and 8 courses down per tile, so 6 x 4 ft gives 12-inch tabs and
  //   a 6-inch course exposure.
  //
  // The old expression was Math.round(S / 1.5) into the u slot -- a tile COUNT derived from
  // the profile span, fed to an axis that was itself the wrong one. On a 12 ft half-span
  // that packed about 9 tiles x 4 pans into the slope: a line every 2.4 inches. Corduroy.
  const roofTileU = 6.0;                               // along the ridge
  const roofTileV = roofKind === "metal" ? 8.0 : 4.0;  // down the slope
  const roofTex = d3MakeTexture(THREE, roofKind);
  if (roofTex) {
    roofTex.repeat.set(1 / roofTileU, 1 / roofTileV);
    roofMat.map = roofTex; roofMat.needsUpdate = true;
    const roofBump = d3MakeBumpTexture(THREE, roofKind);
    if (roofBump) { roofBump.repeat.copy(roofTex.repeat); roofMat.bumpMap = roofBump; roofMat.bumpScale = roofKind === "metal" ? 0.5 : 0.35; }
    if (roofKind === "metal") { roofMat.roughness = 0.45; roofMat.metalness = 0.35; }
    else { roofMat.roughness = 0.95; roofMat.metalness = 0.0; }
  }
  let profPeak = -Infinity;
  dedup.forEach((pt) => { if (pt[1] > profPeak) profPeak = pt[1]; });
  // A slope's endpoint is an INTERIOR JOINT when another slope shares it: a gable ridge,
  // or a gambrel knee. Everything else is a free edge that should really overhang.
  const jointPartnerAt = (pt, self) => slopes.find((o) => o !== self
    && ((Math.abs(o[0][0] - pt[0]) < 1e-6 && Math.abs(o[0][1] - pt[1]) < 1e-6)
     || (Math.abs(o[1][0] - pt[0]) < 1e-6 && Math.abs(o[1][1] - pt[1]) < 1e-6))) || null;
  slopes.forEach((sl) => {
    const A = sl[0], B = sl[1];
    const du = B[0] - A[0], dy = B[1] - A[1];
    const slen = Math.sqrt(du * du + dy * dy);
    const ux = du / slen, uy = dy / slen;
    const nx = -dy / slen, ny = du / slen; // 2D normal of the slope, pointing up-outward
    // PER-END extensions. This slab used to be `slen + OV * 2` centred on the slope
    // midpoint, i.e. it overhung the RIDGE by the full eave overhang as well as the eave.
    // Both gable halves therefore crossed above the peak and poked through each other
    // (~0.22 ft of visible crossed blades at pitch 0.4 / OV 0.6) -- what Carolyn meant by
    // "we don't build roofs like that" (2026-08-18). The ridge cap below is only CAPW wide
    // and shifted inward, so it could never hide it.
    //
    // A free edge keeps the real overhang. An interior joint extends exactly to the
    // OFFSET-POLYGON VERTEX: both slabs' top faces sit `t` above their slope lines and
    // intersect at Q = P + t*(n1+n2)/(1 + n1.n2); each slab runs to Q measured along its
    // own direction, so the faces meet with no crossing and no gap. For a symmetric ridge
    // this reduces to the old t*tan(a) (0.032 ft at pitch 0.4). It replaces a per-slope
    // tan that was only valid for symmetric joints: at a gambrel KNEE the two angles
    // differ, and per-slope tan gave 0.098/0.036 ft where the true meeting point needs
    // 0.019 ft from both sides -- the crossed-blades bug again at one-sixth scale.
    // Verified numerically against both profiles before landing (audit 2026-08-19).
    const t = D3.ROOF_T / 2 + 0.02;
    const jointExt = (P, dirInX, dirInY) => {
      const o = jointPartnerAt(P, sl);
      if (!o) return OV;                     // free edge: the real eave overhang
      const odu = o[1][0] - o[0][0], ody = o[1][1] - o[0][1];
      const olen = Math.sqrt(odu * odu + ody * ody) || 1;
      const onx = -ody / olen, ony = odu / olen;
      const dot = nx * onx + ny * ony;
      const qx = t * (nx + onx) / (1 + dot), qy = t * (ny + ony) / (1 + dot);
      return Math.max(0, qx * dirInX + qy * dirInY);
    };
    const extA = jointExt(A, -ux, -uy);      // the slab extends beyond A along -u
    const extB = jointExt(B, ux, uy);
    const slab = box(roofMat, slen + extA + extB, D3.ROOF_T, L + OV * 2);
    d3RoofSlabUVs(slab);
    slab.rotation.z = Math.atan2(dy, du);
    const shift = (extB - extA) / 2;   // recentre: the ends no longer extend equally
    slab.position.set(
      (A[0] + B[0]) / 2 + ux * shift + nx * t,
      (A[1] + B[1]) / 2 + uy * shift + ny * t,
      L / 2
    );
    rg.add(slab);
    // Eave fascia: a trim board hung on the slab's LOW edge, the finish
    // carpentry that stops a roof reading as a floating slab. Positioned with
    // the SAME normal offset the slab itself carries, or it hangs visibly
    // detached at some angles. Only slopes that reach the wall plate get one
    // (a gambrel's upper legs do not).
    const lowEnd = A[1] <= B[1] ? A : B;
    if (lowEnd[1] <= H + 0.01) {
      const towardLow = lowEnd === A ? -1 : 1;
      // The eave end ON the slope line. Every eave detail registers against this point:
      // at a free edge jointExt returns OV, so the slab's end face is the plane through
      // here. Factored out of the fascia's own expression WITHOUT reordering its float
      // ops, so the fascia below is bit-for-bit where it has always been.
      const eaveU = lowEnd[0] + towardLow * ux * OV;
      const eaveY = lowEnd[1] + towardLow * uy * OV;
      if (!EAVE_OPEN) {
        const edgeU = eaveU + nx * (D3.ROOF_T / 2 + 0.02);
        const edgeY = eaveY + ny * (D3.ROOF_T / 2 + 0.02);
        const fascia = box(trimMat, 0.14, 0.4, L + OV * 2);
        fascia.position.set(edgeU, edgeY - 0.14, L / 2);
        rg.add(fascia);
      } else {
        // OPEN EAVE — raw 2x rafter tails, square-cut, projecting one 2x4 depth below
        // the roof deck at 24 in on centre. On the building this was measured from it is
        // the highest-contrast element there is, and a painted fascia is precisely what
        // it is NOT: the two are alternatives, never both.
        const TAIL_W = 0.125;                 // 1.5 in stock, measured ALONG the ridge (z)
        const TAIL_H = 0.34;                  // tall enough that the top buries in the slab
        const TAIL_DROP = 3.5 / 12;           // visible projection below the deck underside
        // The slab underside sits at n = +0.02. Dropping the tail's bottom face
        // TAIL_DROP below that puts its top at n = +0.068 — inside the slab's
        // [0.02, 0.22] band, so nothing pokes through the roof and no daylight shows
        // between tail and deck.
        const tailN = 0.02 - TAIL_DROP + TAIL_H / 2;
        const tailLen = OV + 0.5;             // outboard face flush with the slab end,
                                              // inboard end buried behind the wall
        const tailU = eaveU - towardLow * ux * (tailLen / 2) + nx * tailN;
        const tailY = eaveY - towardLow * uy * (tailLen / 2) + ny * tailN;
        const tailRot = Math.atan2(dy, du);   // same rotation as the slab it hangs under
        const addTail = (z) => {
          const tl = box(tailMat(), tailLen, TAIL_H, TAIL_W);
          tl.rotation.z = tailRot;
          tl.position.set(tailU, tailY, z);
          rg.add(tl);
        };
        // COUNT IS A RULE, not a number. Bays are laid across the wall span z in [0, L]
        // and rounded to whole bays, so both gable walls always carry an end rafter and
        // no stub bay is left over. An 8x8 at 24 o.c. gives 4 bays and 5 tails, which is
        // exactly what the walk-around video shows.
        const tailStep = L / Math.max(1, Math.round(L / Math.max(0.5, (roofCfg.tailSpacingIn || 24) / 12)));
        for (let z = 0; z <= L + 1e-6; z += tailStep) addTail(Math.min(z, L));
        // Fly-rafter tails, one under each rake about 10 in outboard of the gable wall.
        // Skipped when the overhang is too shallow to hold one.
        const flyOut = Math.min(OV - 0.1, 10 / 12);
        if (flyOut > 0.15) { addTail(-flyOut); addTail(L + flyOut); }
      }
    }
    // Ridge cap: one angled board LYING ON each slope that reaches the peak
    // (both halves of a gable, the upper legs of a gambrel) — a flat box can
    // never seat on the V of two pitches, which is why the first cut floated.
    const highEnd = A[1] >= B[1] ? A : B;
    if (roofCfg.type !== "shed" && highEnd[1] >= profPeak - 0.01) {
      const towardHigh = highEnd === A ? -1 : 1;
      const CAPW = 0.55;
      // Same rewrite as the slabs: a standing-seam ridge cap really does carry its seams
      // across it, and without this the cap keeps stock 0..1 UVs and reads as flat colour
      // beside a correctly tiled roof.
      const capBoard = box(roofMat, CAPW, 0.06, L + OV * 2);
      d3RoofSlabUVs(capBoard);
      capBoard.rotation.z = Math.atan2(dy, du);
      capBoard.position.set(
        highEnd[0] - towardHigh * ux * (CAPW / 2 - 0.06) + nx * (D3.ROOF_T + 0.05),
        highEnd[1] - towardHigh * uy * (CAPW / 2 - 0.06) + ny * (D3.ROOF_T + 0.05),
        L / 2
      );
      rg.add(capBoard);
    }
    // Rake boards: trim running up the roof edge at each gable end. Without
    // them the slab's raw end face reads unfinished — every rake on the
    // SmartBuild reference building is boarded (teardown polish list).
    // Same per-end extensions and recentre as the slab they trim. These kept the old
    // symmetric `slen + OV*2` when the slab got its miter (052c79d), so two trim boards
    // crossed 0.6 ft past the ridge at every gable end -- the exact crossed-blades look
    // the miter had just removed, reintroduced in trim color (audit 2026-08-19).
    [-OV + 0.05, L + OV - 0.05].forEach((z) => {
      const rake = box(trimMat, slen + extA + extB, 0.32, 0.1);
      rake.rotation.z = Math.atan2(dy, du);
      rake.position.set(
        (A[0] + B[0]) / 2 + ux * shift + nx * (D3.ROOF_T / 2 - 0.08),
        (A[1] + B[1]) / 2 + uy * shift + ny * (D3.ROOF_T / 2 - 0.08),
        z
      );
      rg.add(rake);
    });
  });
  // ── Louvered gable vent, both ends ──────────────────────────────────────────────────
  // Applied boxes proud of the extrusion's end CAPS (local z = 0 and z = L), NOT a hole
  // in the profile: one hole extrudes the whole length L and punches out through the far
  // gable as a tunnel, which reveals nothing (the prism is solid) and whose inner faces
  // belong to the soffit material that "look inside" ghosts. Applied is also how casing,
  // muntins, relief strips, fascia, rake and ridge cap are every one of them built.
  const gv = (p.styleSpec && p.styleSpec.gableVent) || null;
  if (gv && gv.widthFrac > 0 && profPeak > H + 0.9) {
    // Horizontal extent of the gable polygon at height y. Generic on purpose: ridgeOffset
    // skews a gable and a gambrel end is a five-point pentagon, so a hard-coded
    // (S/2)*(1 - (y-H)/rise) would be right for exactly one of the three roof types.
    const profSpanAt = (y) => {
      let lo = Infinity, hi = -Infinity;
      for (let i = 0; i + 1 < dedup.length; i++) {
        const P = dedup[i], Q = dedup[i + 1];
        if ((P[1] - y) * (Q[1] - y) > 1e-12) continue;   // both ends the same side of y
        const dY = Q[1] - P[1];
        if (Math.abs(dY) < 1e-9) {
          lo = Math.min(lo, P[0], Q[0]); hi = Math.max(hi, P[0], Q[0]);
        } else {
          const u = P[0] + (Q[0] - P[0]) * ((y - P[1]) / dY);
          lo = Math.min(lo, u); hi = Math.max(hi, u);
        }
      }
      return hi > lo ? [lo, hi] : null;
    };
    // The vent sits LOW in the triangle, on a short sill above the plate — not centred
    // in it. That is what the walk-around shows, and on a shallow pitch it is the whole
    // ballgame: an 8 ft gable at 5:12 is only 1.7 ft tall, so a mid-height vent has to
    // shrink by a third to clear the rakes while the same vent on a sill fits at full
    // width. Centring cost 6 inches of a 24 inch vent before this was measured.
    const VENT_SILL = 2 / 12;
    let vW = S * Math.min(0.6, Math.max(0.05, gv.widthFrac));
    let vH = vW / 2;                                     // 2:1 wide-to-tall, as measured
    let vCy = H + VENT_SILL + vH / 2;
    // Shrink to fit. The TOP corners are the tight point, and the passes converge because
    // a narrower vent is also shorter and therefore has more room above it.
    for (let k = 0; k < 3; k++) {
      const sp = profSpanAt(vCy + vH / 2);
      const avail = sp ? (sp[1] - sp[0]) - 0.5 : 0;      // keep 3 in clear of each rake
      if (vW <= avail) break;
      vW = Math.max(0, avail); vH = vW / 2; vCy = H + VENT_SILL + vH / 2;
    }
    const spC = profSpanAt(vCy);
    const vCu = spC ? (spC[0] + spC[1]) / 2 : 0;         // centred even on a skewed ridge
    if (vW >= 0.8 && vH >= 0.35) {
      const ventMat = mat("#2A2E33", { roughness: 0.9 });
      const ltex = d3MakeTexture(THREE, "lap");          // blade lines, same trick the
      if (ltex) {                                        // roll-up door already uses
        ltex.repeat.set(1, Math.max(3, Math.round(vH / 0.25)));
        ventMat.map = ltex; ventMat.needsUpdate = true;
      }
      const F = 0.12;                                    // trim board width
      // The cap plane is the wall MID-plane, so 0.15 only reaches the siding face:
      // 0.20 for the trim and 0.16 for the louvers leaves the blades recessed inside
      // their own frame, which is what reads as louvered rather than as a grey rectangle.
      [[0, -1], [L, 1]].forEach(function (end) {
        const z0 = end[0], s = end[1];
        const put = (m, w, h, d, du_, dy_, off) => {
          const b = box(m, w, h, d);
          b.position.set(vCu + du_, vCy + dy_, z0 + s * off);
          rg.add(b);
        };
        put(ventMat, vW, vH, 0.06, 0, 0, 0.16);                        // louver face
        put(trimMat, vW + F * 2, F, 0.10, 0, (vH + F) / 2, 0.20);      // head
        put(trimMat, vW + F * 2, F, 0.10, 0, -(vH + F) / 2, 0.20);     // sill
        put(trimMat, F, vH + F * 2, 0.10, -(vW + F) / 2, 0, 0.20);     // left jamb
        put(trimMat, F, vH + F * 2, 0.10, (vW + F) / 2, 0, 0.20);      // right jamb
      });
    }
  }
  if (uAxisIsX) { rg.position.z = -L / 2; }
  else { rg.rotation.y = -Math.PI / 2; rg.position.x = L / 2; }
  roofGroup.add(rg);
  // Corner trim boards live in roofGroup so "look inside" hides them with the roof.
  [[-bldgW / 2, -bldgH / 2], [bldgW / 2, -bldgH / 2], [-bldgW / 2, bldgH / 2], [bldgW / 2, bldgH / 2]].forEach((c) => {
    const post = box(trimMat, T + 0.14, H, T + 0.14);
    post.position.set(c[0], H / 2, c[1]);
    roofGroup.add(post);
  });

  // ── Interior + attached items (plan §4.3, §4.5, §4.6) ──
  // Same isolation as buildOneWall: rebuildInterior repopulates this group
  // alone when a loft/workbench/ramp moves during a live drag.
  const interiorGroup = new THREE.Group();
  const buildInterior = (itemsNow) => itemsNow.forEach((it) => {
    const c = itemTypes[it.type];
    if (!c) return;
    // Plan annotations, one more view of them: the note's text as a plaque
    // lying at its plan position, the line as a thin strip between its
    // endpoints. Text edits stay a 2D affordance.
    if (c.noteType) {
      const lbl = d3MakeGroundLabel(THREE, String(it.text || "Note").replace(/\s+/g, " ").slice(0, 60), 0.9);
      if (lbl) {
        const ng = new THREE.Group();
        ng.userData = { itemId: it.id, floorItem: true };
        lbl.position.set(ftX(it.x), 0.06, ftZ(it.y));
        ng.add(lbl);
        interiorGroup.add(ng);
      }
      return;
    }
    if (c.lineType) {
      const x1 = ftX(it.x1), z1 = ftZ(it.y1), x2 = ftX(it.x2), z2 = ftZ(it.y2);
      const len = Math.sqrt((x2 - x1) * (x2 - x1) + (z2 - z1) * (z2 - z1));
      if (len > 0.05) {
        const ng = new THREE.Group();
        ng.userData = { itemId: it.id, floorItem: true };
        const strip = box(mat("#475569"), len, 0.05, 0.12);
        strip.position.set((x1 + x2) / 2, 0.05, (z1 + z2) / 2);
        strip.rotation.y = -Math.atan2(z2 - z1, x2 - x1);
        ng.add(strip);
        interiorGroup.add(ng);
      }
      return;
    }
    if (it.type === "loft") {
      const w = it.widthFt || c.width, d = it.heightFt || c.height;
      const elev = it.elevationFt || D3.LOFT_ELEV; // Phase 5 field, D3 fallback
      const cx = ftX(it.x), cz = ftZ(it.y);
      const lg = new THREE.Group();
      lg.userData = { itemId: it.id, floorItem: true };
      const plat = box(mat(D3_COLORS.loft), w, D3.LOFT_T, d);
      plat.position.set(cx, elev - D3.LOFT_T / 2, cz);
      lg.add(plat);
      const ph = elev - D3.LOFT_T;
      [[-1, -1], [1, -1], [-1, 1], [1, 1]].forEach((sgn) => {
        const post = box(mat(D3_COLORS.bench), 0.28, ph, 0.28);
        post.position.set(cx + sgn[0] * (w / 2 - 0.25), ph / 2, cz + sgn[1] * (d / 2 - 0.25));
        lg.add(post);
      });
      interiorGroup.add(lg);
    } else if (it.type === "workbench") {
      const w = it.widthFt || c.width, d = it.heightFt || c.height;
      const g = new THREE.Group();
      const benchMat = mat(D3_COLORS.bench);
      const top = box(benchMat, w, 0.22, d);
      top.position.y = D3.BENCH_H - 0.11;
      g.add(top);
      [[-1, -1], [1, -1], [-1, 1], [1, 1]].forEach((sgn) => {
        const leg = box(benchMat, 0.18, D3.BENCH_H - 0.22, 0.18);
        leg.position.set(sgn[0] * (w / 2 - 0.15), (D3.BENCH_H - 0.22) / 2, sgn[1] * (d / 2 - 0.15));
        g.add(leg);
      });
      if (it.rotation === 90) g.rotation.y = Math.PI / 2;
      g.position.set(ftX(it.x), 0, ftZ(it.y));
      g.userData = { itemId: it.id, floorItem: true };
      interiorGroup.add(g);
    } else if (it.type === "ramp") {
      const wf = WALLS[it.wall];
      if (!wf) return;
      const w = it.widthFt || 3;
      const along = wf.U[0] ? (it.x - mgX) / scale : (it.y - mgY) / scale;
      const run = 3, drop = D3.FLOOR_T;
      const g = new THREE.Group();
      const deck = box(mat(D3_COLORS.ramp), w, 0.12, Math.sqrt(run * run + drop * drop));
      deck.rotation.x = Math.atan2(drop, run); // far end drops to grade
      deck.position.set(0, -drop / 2 + 0.06, run / 2);
      g.add(deck);
      g.rotation.y = Math.atan2(wf.N[0], wf.N[1]); // local +z → exterior normal
      g.position.set(
        wf.O[0] + wf.U[0] * along + wf.N[0] * (T / 2),
        0,
        wf.O[1] + wf.U[1] * along + wf.N[1] * (T / 2)
      );
      interiorGroup.add(g);
    }
    // textNote / line: 2D annotations with no 3D representation (plan §4.7).
  });
  buildInterior(items);

  root.add(wallsGroup);
  root.add(openingsGroup);
  root.add(roofGroup);
  root.add(interiorGroup);
  // Sun shadows (SmartBuild's "Show Shadows"): solid building meshes cast,
  // the grass receives. Transparent fills (glass) don't cast; labels neither.
  const setShadowFlags = (grp) => grp.traverse((o) => { if (o.isMesh) { o.castShadow = !(o.material && o.material.transparent); o.receiveShadow = false; } });
  setShadowFlags(root);
  envGroup.traverse((o) => { if (o.isMesh) o.castShadow = false; });
  ground.receiveShadow = true;
  floor.receiveShadow = true;

  // Scoped rebuilds for the live drag. sharedMats = the model-lifetime wall and
  // trim materials that per-wall disposal must keep (their maps ride along, so
  // the siding texture survives too). builtFrontWall lets the flush detect a
  // FRONT flip, which needs the full path (roof + ground labels re-home).
  const sharedMats = new Set([wallMat, trimMat, battenMat]);
  const model = { root, envGroup, wallMat, trimMat, battenMat, gableMat, roofGroup, openingsGroup, wallsGroup, interiorGroup, builtFrontWall: frontWall };
  model.rebuildWalls = (names, itemsNow) => {
    names.forEach((wname) => {
      if (!WALLS[wname]) return;
      const oldWg = wallsGroup.children.find((g) => g.userData && g.userData.wall === wname);
      if (oldWg) { wallsGroup.remove(oldWg); disposeSubtree(oldWg, sharedMats); }
      openingsGroup.children
        .filter((g) => g.userData && g.userData.wall === wname)
        .forEach((og) => { openingsGroup.remove(og); disposeSubtree(og, sharedMats); });
      const built = buildOneWall(wname, itemsNow);
      setShadowFlags(built.wg);
      wallsGroup.add(built.wg);
      built.ogs.forEach((og) => { setShadowFlags(og); openingsGroup.add(og); });
    });
  };
  model.rebuildInterior = (itemsNow) => {
    Array.from(interiorGroup.children).forEach((g) => { interiorGroup.remove(g); disposeSubtree(g, null); });
    buildInterior(itemsNow);
    setShadowFlags(interiorGroup);
  };
  return model;
}

// Forget pending fixture-photo binds whose materials were just disposed — a
// scoped drag rebuild otherwise leaves one dead bind per rebuilt frame while a
// photo is still in flight, and the arriving photo would write into thousands
// of disposed materials.
function d3UnbindFixtureMats(mats) {
  _d3FxMatBinds.forEach((set, entry) => {
    set.forEach((b) => { if (mats.has(b.mat)) set.delete(b); });
    if (set.size === 0) _d3FxMatBinds.delete(entry);
  });
}

// Free one subtree's geometries and owned materials. `sharedMats` (a Set or
// null) names materials owned by the model as a whole — wall/trim during a
// per-wall rebuild — that must survive; shared fixture-photo maps are skipped
// the same way disposeShed3DModel always has (ssShared).
function disposeSubtree(obj, sharedMats) {
  const mats = new Set();
  obj.traverse((o) => {
    if (o.geometry) o.geometry.dispose();
    if (o.material) (Array.isArray(o.material) ? o.material : [o.material]).forEach((m) => mats.add(m));
  });
  if (sharedMats) sharedMats.forEach((m) => mats.delete(m));
  // Fixture photo textures are shared across every rebuild (see d3FixtureTexture)
  // — disposing one here would blank every catalog door on the first drag frame.
  // Bump maps are per-build mints like color maps and dispose with them.
  mats.forEach((m) => {
    if (m.map && !(m.map.userData && m.map.userData.ssShared)) m.map.dispose();
    if (m.bumpMap && !(m.bumpMap.userData && m.bumpMap.userData.ssShared)) m.bumpMap.dispose();
    m.dispose();
  });
  d3UnbindFixtureMats(mats);
}

// A default 3/4 view of the building, rendered OFF-SCREEN, with no 3D modal involved.
//
// WHY THIS EXISTS. The quote's 3D page and the customer's quote-card thumbnail only ever
// appeared when someone had opened the 3D view and pressed "Use this view in my quote".
// Most reps never do, so most customers received paperwork showing a floor plan and nothing
// that looks like a building — the single most persuasive thing we can put in front of them.
// This is the fallback, taken at submit time when no shot was armed.
//
// It deliberately reuses the D3Viewer's OWN framing (34° lens, dist = R*3.66, the front
// three-quarter OUT map keyed on frontWall) rather than inventing a camera: the fallback and
// the hand-picked shot should look like the same product, and a second set of magic numbers
// would drift from the first the next time either is tuned.
//
// Never throws — every caller treats a null as "no 3D page", which is exactly the behaviour
// that shipped before this existed.
async function renderDefault3DShot(p) {
  let renderer = null;
  let model = null;
  try {
    const { THREE } = await loadThree();
    const W = 1200, H = 900;
    const cv = document.createElement("canvas");
    cv.width = W; cv.height = H;
    renderer = new THREE.WebGLRenderer({ canvas: cv, antialias: true, preserveDrawingBuffer: true });
    renderer.setPixelRatio(1);
    renderer.setClearColor("#E7EEF5", 1);
    if (THREE.SRGBColorSpace && "outputColorSpace" in renderer) renderer.outputColorSpace = THREE.SRGBColorSpace;

    const scene = new THREE.Scene();
    scene.background = new THREE.Color("#E7EEF5");
    const spec = p.style3d || { roof: D3_DEFAULT_ROOF, siding: null, colors: {}, wallHeightFt: 0 };
    const bodyCss = p.painted ? d3SwatchCss(p.paintBody, D3_COLORS.body, p.bodyColors) : (spec.colors.body || D3_COLORS.body);
    const trimCss = p.painted ? d3SwatchCss(p.paintTrim, D3_COLORS.trim, p.trimColors) : (spec.colors.trim || D3_COLORS.trim);
    const roofCss = p.roofColorHex || spec.colors.roof || D3_COLORS.roof;
    model = buildShed3DModel(THREE, {
      bldgW: p.bldgW, bldgH: p.bldgH, wallHeightFt: spec.wallHeightFt, styleSpec: spec,
      roofColor: roofCss, roofType: p.roofType, items: p.items, itemTypes: p.itemTypes,
      bodyColor: bodyCss, trimColor: trimCss, frontWall: p.frontWall,
      scale: p.scale, mgX: p.mgX, mgY: p.mgY, fixtures: p.fixtures,
    });
    scene.add(model.root);
    scene.add(new THREE.HemisphereLight(0xDCE9FF, 0x8D8573, 1.5));

    const fw = p.frontWall || "south";
    const OUT = { north: [0.35, -1], south: [0.35, 1], west: [-1, 0.35], east: [1, 0.35] }[fw] || [0.35, 1];
    const R = Math.max(p.bldgW, p.bldgH) * 0.5 + D3.WALL_H;
    const dist = R * 3.66;
    const outLen = Math.sqrt(OUT[0] * OUT[0] + OUT[1] * OUT[1]);
    const camX = (OUT[0] / outLen) * dist, camZ = (OUT[1] / outLen) * dist;
    const sun = new THREE.DirectionalLight(0xFFF3E0, 2.6);
    sun.position.set(camX * 0.8, dist * 0.9, camZ * 0.8);
    scene.add(sun);
    const camera = new THREE.PerspectiveCamera(34, W / H, 0.1, dist * 10);
    camera.position.set(camX, dist * 0.5, camZ);
    camera.lookAt(0, D3.WALL_H * 0.45, 0);

    renderer.render(scene, camera);
    // Catalog fixture photos (a door's real photo on its slab) load asynchronously. Reading
    // the canvas before they land ships a building with blank doors, so wait the same
    // bounded 1.5s the shutter waits and re-render if any arrived.
    if (d3FixtureTexturesPending() > 0) {
      await d3WaitFixtureTextures(1500);
      renderer.render(scene, camera);
    }
    const url = cv.toDataURL("image/jpeg", 0.9);
    // A lost context yields "data:," — treat that as no snapshot rather than a broken page.
    if (!url || url.length < 512) return null;
    return { url, w: W, h: H };
  } catch (_e) {
    return null;
  } finally {
    if (model) { try { disposeShed3DModel(model); } catch (_e) { /* nothing left to free */ } }
    if (renderer) {
      try { renderer.dispose(); if (renderer.forceContextLoss) renderer.forceContextLoss(); } catch (_e) { /* context already gone */ }
    }
  }
}

// Free every geometry/material a buildShed3DModel() group holds — Three.js
// doesn't GC WebGL resources, and drag-to-move rebuilds the model live.
function disposeShed3DModel(model) {
  disposeSubtree(model.root, null);
}

// Full-screen orbitable 3D view of the current design. Mounted only while open:
// builds the scene on mount, disposes every geometry/material on unmount (Three
// doesn't GC WebGL resources). Renders on demand — no animation loop, so an idle
// scene costs zero GPU. Calls onSnapshot({ url, w, h }) when the customer
// captures a view — and automatically on close if they never did — so the
// submit flow can add the 3D page to the quote PDF.
function Structure3DViewer({ bldgW, bldgH, items, itemTypes, styleValue, painted, paintBody, paintTrim, frontWall, scale, mgX, mgY, accent, style3d, roofType, roofColorHex, fixtures, doorColors, windowColors, bodyColors, trimColors, paletteKeys, placeableDoors, placeableWindows, placeableRamps, paintEnabled, onPaintChange, onWallHeight, onItemAdd, onItemMove, onItemDelete, onItemSelect, onSnapshot, onClose }) {
  const canvasRef = useRef(null);
  const wrapRef = useRef(null);
  const engineRef = useRef(null);
  const capturedRef = useRef(false);
  const [phase, setPhase] = useState("loading"); // loading | ready | error
  const [interior, setInterior] = useState(false);
  // SmartBuild-style view options: roof on/off, landscape (grass/sky/labels)
  // on/off, and the 3×3 camera-preset popover.
  const [roofOn, setRoofOn] = useState(true);
  const [envOn, setEnvOn] = useState(true);
  const [viewsOpen, setViewsOpen] = useState(false);
  const [shotTaken, setShotTaken] = useState(false);
  const [closing, setClosing] = useState(false);   // close-time auto-capture in progress (photo wait + readback can take ~2s)
  // Armed palette tool for placing new wall items in 3D (§10.4). Mirrored into
  // a ref so the native pointer handlers read the current value.
  const [tool3, setTool3] = useState(null);
  const tool3Ref = useRef(null);
  useEffect(() => {
    tool3Ref.current = tool3;
    const c = canvasRef.current;
    if (c) c.style.cursor = tool3 ? "crosshair" : "";
  }, [tool3]);
  // In-viewer catalog chooser (door/window/ramp picker tools). The 2D picker
  // modals live outside the 3D modal's liveItems world, so choosing there
  // could not rebuild this scene — the 3D flow keeps its own small sheet and
  // commits through the same onItemAdd pipeline as every other placement.
  const [pick3, setPick3] = useState(null);   // { kind: door|window|ramp, wall, ptx, pty, door }
  // Refusal feedback (the 2D toasts' 3D counterpart) — shown in the hint slot.
  const [msg3, setMsg3] = useState(null);
  // The item selected by tapping in 3D — drives the footer's Remove button.
  // { id, label } or null; kept in step with every onItemSelect report.
  const [sel3d, setSel3d] = useState(null);
  // Paint picker selection; labels flow into paintColors (same free-text
  // semantics as the 2D paint inputs).
  const [paintSel, setPaintSel] = useState({ body: painted ? (paintBody || "") : "", trim: painted ? (paintTrim || "") : "" });
  // Customer wall-height pick (IdeaRoom's wall-raise, per Carolyn 2026-07-02).
  // Rebuilds the model live and commits to sel.wallHeight via onWallHeight.
  const [wallHSel, setWallHSel] = useState((style3d && style3d.wallHeightFt) || D3.WALL_H);
  const pickWallHeight = (h) => {
    setWallHSel(h);
    const e = engineRef.current;
    if (e && e.setWallHeight) e.setWallHeight(h);
    if (onWallHeight) onWallHeight(h);
    capturedRef.current = false; // height change makes any earlier shot stale
    setShotTaken(false);
  };
  const pickColor = (kind, label) => {
    const next = kind === "none" ? { body: "", trim: "" } : { ...paintSel, [kind]: label };
    setPaintSel(next);
    const e = engineRef.current;
    if (e && e.setLiveColors) e.setLiveColors(next.body, next.trim);
    if (onPaintChange) onPaintChange(next);
    capturedRef.current = false; // color change makes any earlier shot stale
    setShotTaken(false);
  };

  useEffect(() => {
    let disposed = false;
    loadThree().then((bundle) => {
      const THREE = bundle.THREE, OrbitControls = bundle.OrbitControls;
      if (disposed || !canvasRef.current) return;
      // preserveDrawingBuffer stays OFF: it taxes every frame on tile-based
      // mobile GPUs, and the only read-back — capture() — renders explicitly
      // in the same task before toDataURL, which the spec guarantees is valid.
      const renderer = new THREE.WebGLRenderer({ canvas: canvasRef.current, antialias: true, preserveDrawingBuffer: false });
      // DPR policy: full sharpness at rest, capped resolution while a finger
      // is down on a coarse-pointer device. A DPR-3 phone clamped to 2 still
      // pushes ~1.3M pixels through MSAA on this full-screen canvas; during an
      // orbit/drag nobody can see the extra sharpness, and the release renders
      // one crisp frame at base DPR. Desktop pointers never change.
      const baseDpr = Math.min(window.devicePixelRatio || 1, 2);
      const coarsePointer = typeof window.matchMedia === "function" && window.matchMedia("(pointer: coarse)").matches;
      const interactDpr = Math.min(baseDpr, 1.25);
      renderer.setPixelRatio(baseDpr);
      const setInteractDpr = (on) => {
        if (!coarsePointer || interactDpr === baseDpr) return;
        const want = on ? interactDpr : baseDpr;
        if (renderer.getPixelRatio() !== want) { renderer.setPixelRatio(want); if (!on) render(); }
      };
      renderer.shadowMap.enabled = true;                 // SmartBuild-style sun shadows
      renderer.shadowMap.type = THREE.PCFSoftShadowMap;
      // Filmic tone mapping is what lets the PBR materials read as real
      // surfaces — flat Linear output was a big part of the "toy render" look.
      renderer.toneMapping = THREE.ACESFilmicToneMapping;
      renderer.toneMappingExposure = 1.15;
      // The sun is a fixed directional light with a fixed ortho shadow camera,
      // so the shadow map is VIEW-INDEPENDENT: orbiting re-renders the same
      // depth map for nothing (a full 2048² PCFSoft pass per pointermove).
      // Render it only when the scene actually changes - every mutation path
      // funnels through queueRebuild's flush or applyShellMode, which set
      // needsUpdate; setLiveColors doesn't (paint never moves geometry).
      renderer.shadowMap.autoUpdate = false;
      renderer.shadowMap.needsUpdate = true;
      const scene = new THREE.Scene();
      scene.background = new THREE.Color("#E7EEF5");
      // Per-style appearance (roof profile/pitch/overhang, siding relief,
      // natural material colors, wall height) resolved by the parent from the
      // tenant's config + built-in defaults.
      const spec = style3d || { roof: D3_DEFAULT_ROOF, siding: null, colors: {}, wallHeightFt: 0 };
      // Live paint colors — swatch picks update these and recolor materials in
      // place; drag rebuilds read the same vars so colors survive rebuilds.
      // Unpainted falls back to the STYLE's natural material colors.
      let liveBodyCss = painted ? d3SwatchCss(paintBody, D3_COLORS.body, bodyColors) : (spec.colors.body || D3_COLORS.body);
      let liveTrimCss = painted ? d3SwatchCss(paintTrim, D3_COLORS.trim, trimColors) : (spec.colors.trim || D3_COLORS.trim);
      const roofCss = roofColorHex || spec.colors.roof || D3_COLORS.roof;
      const model = d3TimedBuild(() => buildShed3DModel(THREE, { bldgW, bldgH, wallHeightFt: spec.wallHeightFt, styleSpec: spec, roofColor: roofCss, roofType, items, itemTypes, bodyColor: liveBodyCss, trimColor: liveTrimCss, frontWall, scale, mgX, mgY, fixtures }));
      scene.add(model.root);
      // Sky-tinted fill + warm sun: under ACES, white-on-white lighting reads
      // as overcast plastic; a blue-ish ambient with a warm key is what makes
      // painted siding and shingle relief look sunlit.
      scene.add(new THREE.HemisphereLight(0xDCE9FF, 0x8D8573, 1.5));
      // Start the camera on the FRONT side (same wall the 2D labels call FRONT),
      // nudged sideways for a three-quarter view; the sun follows the camera side.
      const fw = frontWall || "south";
      const OUT = { north: [0.35, -1], south: [0.35, 1], west: [-1, 0.35], east: [1, 0.35] }[fw] || [0.35, 1];
      const R = Math.max(bldgW, bldgH) * 0.5 + D3.WALL_H;
      // 34° lens (was 45°): the long-lens architectural look — less perspective
      // distortion on the box, matching how buildings are photographed. dist
      // carries the tan(22.5°)/tan(17°) ≈ 1.355 factor so framing is unchanged,
      // and everything sized off dist (sky dome, far plane, orbit limits, sun)
      // scales with it.
      const dist = R * 3.66;
      const outLen = Math.sqrt(OUT[0] * OUT[0] + OUT[1] * OUT[1]);
      const camX = (OUT[0] / outLen) * dist, camZ = (OUT[1] / outLen) * dist;
      const sun = new THREE.DirectionalLight(0xFFF3E0, 2.6);
      sun.position.set(camX * 0.8, dist * 0.9, camZ * 0.8);
      // Shadow camera sized to the building footprint (grass receives the shadow).
      sun.castShadow = true;
      sun.shadow.mapSize.width = sun.shadow.mapSize.height = 2048;
      const shR = Math.max(bldgW, bldgH) * 1.6 + 8;
      sun.shadow.camera.left = -shR; sun.shadow.camera.right = shR;
      sun.shadow.camera.top = shR; sun.shadow.camera.bottom = -shR;
      sun.shadow.camera.near = 0.5; sun.shadow.camera.far = dist * 4;
      sun.shadow.bias = -0.0005;
      // Ortho shadow cameras bake their projection at construction — without
      // this the bounds above are ignored and shadows clip to a ~10ft box.
      sun.shadow.camera.updateProjectionMatrix();
      scene.add(sun);
      // far covers the sky dome even at controls.maxDistance (2.5d + 6.5d < 10d).
      const camera = new THREE.PerspectiveCamera(34, 1, 0.1, dist * 10);
      camera.position.set(camX, dist * 0.5, camZ);
      // Sky dome: gradient + soft clouds on the inside of a hemisphere, slightly
      // past the horizon so no gap shows between grass edge and sky. Hidden by
      // the Landscape toggle along with the model's envGroup.
      const skyTex = d3MakeSkyTexture(THREE);
      const sky = skyTex ? new THREE.Mesh(
        new THREE.SphereGeometry(dist * 6.5, 32, 16, 0, Math.PI * 2, 0, Math.PI / 2 + 0.14),
        new THREE.MeshBasicMaterial({ map: skyTex, side: THREE.BackSide, depthWrite: false })
      ) : null;
      if (sky) { sky.position.y = -0.5; scene.add(sky); }
      // SmartBuild-style camera presets (3×3 grid), azimuth relative to the
      // FRONT wall so "F" always faces the side the 2D labels call FRONT.
      const setViewPreset = (relDeg, polDeg) => {
        const e = engineRef.current;
        if (!e) return;
        const t = e.controls.target;
        const r = e.camera.position.distanceTo(t) || dist;
        // Front azimuth resolved at CALL time — dragging the only door to a
        // different wall re-homes the front (roof + labels already follow).
        const liveFw = getFrontWall(liveItems) || fw;
        const az = ({ south: 0, north: Math.PI, east: Math.PI / 2, west: -Math.PI / 2 }[liveFw] || 0) + (relDeg * Math.PI) / 180;
        const phi = ((90 - polDeg) * Math.PI) / 180;   // measured from straight up
        e.camera.position.set(
          t.x + r * Math.sin(phi) * Math.sin(az),
          t.y + r * Math.cos(phi),
          t.z + r * Math.sin(phi) * Math.cos(az)
        );
        e.camera.lookAt(t);
        e.controls.update();
        e.render();
      };

      // ── Drag-to-move wall items (first slice of Phase 6, plan §10.5) ──
      // Doors/windows/rough openings drag along the walls exactly like the 2D
      // drag: the pointer ray becomes page coordinates and runs the SAME module
      // functions the 2D uses (getWallFromClick → getNearestWall → snapToWall),
      // wall switching included; like 2D, no collision check while moving. The
      // final position commits through onItemMove so the 2D plan, saved design,
      // and estimate all see the move. The pointerdown handler is registered
      // BEFORE OrbitControls is constructed, so stopImmediatePropagation keeps
      // a grab on an item from also starting an orbit.
      const canvas = canvasRef.current;
      const pWpx = bldgW * scale, pHpx = bldgH * scale;
      let liveItems = items;
      let dragging3 = null;      // { id, moved }
      let lastHoverId = null;
      let rebuildScope = null;   // accumulated for the next frame: { full, walls:Set, interior }
      let canvasRect = null;     // getBoundingClientRect cache - a layout read per pointermove forces layout of the whole page (the 2D SVG included)
      let lastSentSelect = null; // last item id reported via onItemSelect - a no-op tap shouldn't re-render the parent
      const raycaster = new THREE.Raycaster();
      const ndc = new THREE.Vector2();
      const dragPlane = new THREE.Plane();
      const dragHit = new THREE.Vector3();
      const highlight = new THREE.LineSegments(
        new THREE.EdgesGeometry(new THREE.BoxGeometry(1, 1, 1)),
        new THREE.LineBasicMaterial({ color: 0xFBBF24 })
      );
      highlight.visible = false;
      scene.add(highlight);
      const applyShellMode = (e) => {
        e.model.roofGroup.visible = !e.interior && e.roofOn !== false;
        if (e.model.envGroup) e.model.envGroup.visible = e.envOn !== false;
        if (e.sky) e.sky.visible = e.envOn !== false;
        // Ghosted walls must stop casting shadows too — 14%-opacity walls
        // throwing full-dark shadows reads as a rendering bug.
        e.model.wallsGroup.traverse((o) => { if (o.isMesh) o.castShadow = !e.interior; });
        e.model.wallMat.transparent = !!e.interior;
        e.model.wallMat.opacity = e.interior ? 0.14 : 1;
        e.model.wallMat.depthWrite = !e.interior;
        e.model.wallMat.needsUpdate = true;
        if (e.model.gableMat) {
          // The gable/end faces carry their own material (UV mismatch with the
          // wall texture) but must ghost in step with the walls.
          e.model.gableMat.transparent = !!e.interior;
          e.model.gableMat.opacity = e.interior ? 0.14 : 1;
          e.model.gableMat.depthWrite = !e.interior;
          e.model.gableMat.needsUpdate = true;
        }
        if (e.model.battenMat) {
          // Board & batten's proud strips sit ON the walls in wallsGroup, so without this
          // "look inside" leaves a cage of opaque battens floating over a ghosted building.
          e.model.battenMat.transparent = !!e.interior;
          e.model.battenMat.opacity = e.interior ? 0.14 : 1;
          e.model.battenMat.depthWrite = !e.interior;
          e.model.battenMat.needsUpdate = true;
        }
        // Every caller changed what casts or shows shadow (rebuild flush, roof
        // toggle, look-inside) - re-render the cached shadow map next frame.
        e.renderer.shadowMap.needsUpdate = true;
      };
      const setRay = (ev) => {
        // The modal is position:fixed inset:0, so the rect only moves on a
        // viewport resize - resize() invalidates, pointerdown re-primes.
        if (!canvasRect) canvasRect = canvas.getBoundingClientRect();
        const rc = canvasRect;
        ndc.x = ((ev.clientX - rc.left) / rc.width) * 2 - 1;
        ndc.y = -((ev.clientY - rc.top) / rc.height) * 2 + 1;
        raycaster.setFromCamera(ndc, camera);
      };
      // Pick a movable item: wall openings (doors/windows/ROs) or floor items
      // (lofts/workbenches). Ramps carry no itemId tag on purpose — 2D can't
      // drag them either.
      const pickItem3 = (ev) => {
        const e = engineRef.current;
        if (!e) return null;
        setRay(ev);
        const hits = raycaster.intersectObjects([e.model.openingsGroup, e.model.interiorGroup], true);
        for (let h = 0; h < hits.length; h++) {
          let n = hits[h].object;
          while (n && !(n.userData && n.userData.itemId)) n = n.parent;
          if (n) { const it = liveItems.find((i) => i.id === n.userData.itemId); if (it) return it; }
        }
        return null;
      };
      // Pick a wall (for the 3D placement palette).
      const pickWall3 = (ev) => {
        const e = engineRef.current;
        if (!e) return null;
        setRay(ev);
        const hits = raycaster.intersectObjects([e.model.wallsGroup], true);
        for (let h = 0; h < hits.length; h++) {
          let n = hits[h].object;
          while (n && !(n.userData && n.userData.wall)) n = n.parent;
          if (n) return { wall: n.userData.wall, point: hits[h].point };
        }
        return null;
      };
      // Vertical extent of an opening — item-stamped fields first (Phase 5), then a
      // catalog fixture's own heightIn, then D3 defaults for legacy items. Mirrors
      // the builder's openingSpan, INCLUDING its clamps, so drag highlights track
      // a wall-height pick (spec.wallHeightFt is mutated live by setWallHeight).
      const openSpanOf = (it) => {
        const inchesFt = (v) => (Number(v) > 0 ? Number(v) / 12 : null);
        const maxTop = (spec.wallHeightFt || D3.WALL_H) - 0.2;
        if (it.type === "window") {
          const wh = Math.min(it.openingHeightFt || inchesFt(it.heightIn) || D3.WINDOW_H, maxTop - 0.35);
          let s0 = it.sillFt != null ? it.sillFt : D3.WINDOW_SILL;
          if (s0 + wh > maxTop) s0 = Math.max(0.35, maxTop - wh);
          return [s0, s0 + wh];
        }
        if (it.type === "roughOpening") return [0, Math.min(it.openingHeightFt || D3.RO_H, maxTop)];
        return [0, Math.min(it.openingHeightFt || inchesFt(it.heightIn) || D3.DOOR_H, maxTop)];
      };
      const placeHighlight = (it) => {
        const c = itemTypes[it.type] || {};
        if (c.wallOnly) {
          const w = it.widthFt || c.width || 3;
          const ns = it.wall === "north" || it.wall === "south";
          const len = ns ? bldgW : bldgH;
          const along = ns ? (it.x - mgX) / scale : (it.y - mgY) / scale;
          const a = Math.max(w / 2, Math.min(along, len - w / 2)) - len / 2;
          const sp = openSpanOf(it);
          highlight.scale.set(w + 0.3, sp[1] - sp[0] + 0.3, D3.WALL_T + 0.4);
          highlight.rotation.y = ns ? 0 : Math.PI / 2;
          highlight.position.set(
            ns ? a : (it.wall === "west" ? -bldgW / 2 : bldgW / 2),
            (sp[0] + sp[1]) / 2,
            ns ? (it.wall === "north" ? -bldgH / 2 : bldgH / 2) : a
          );
          return;
        }
        // Floor items: outline the loft platform / workbench body.
        const w = it.widthFt || c.width || 4;
        const d0 = it.heightFt || c.height || 2;
        const rot = it.rotation === 90;
        const cx = (it.x - mgX) / scale - bldgW / 2;
        const cz = (it.y - mgY) / scale - bldgH / 2;
        highlight.rotation.y = 0;
        if (it.type === "loft") {
          const elev = it.elevationFt || D3.LOFT_ELEV;
          highlight.scale.set(w + 0.3, D3.LOFT_T + 0.3, d0 + 0.3);
          highlight.position.set(cx, elev - D3.LOFT_T / 2, cz);
        } else {
          highlight.scale.set((rot ? d0 : w) + 0.3, D3.BENCH_H + 0.3, (rot ? w : d0) + 0.3);
          highlight.position.set(cx, D3.BENCH_H / 2, cz);
        }
      };
      // Queue a rebuild for the next frame, coalescing scopes: a drag passes
      // { walls: [...] } / { interior: true } and only that part of the model
      // is torn down and rebuilt (~a tenth of the full cost, which used to run
      // EVERY drag frame). No argument = the full path — wall height, palette
      // placement, and anything else structural. A FRONT flip is detected at
      // flush time and upgrades a scoped rebuild to full, because the roof and
      // ground labels re-home with the front.
      const queueRebuild = (scope) => {
        const full = !scope || scope.full === true;
        if (rebuildScope) {
          if (full) rebuildScope.full = true;
          else {
            (scope.walls || []).forEach((w) => rebuildScope.walls.add(w));
            if (scope.interior) rebuildScope.interior = true;
          }
          return;
        }
        rebuildScope = { full, walls: new Set(full ? [] : scope.walls || []), interior: !full && Boolean(scope.interior) };
        requestAnimationFrame(() => {
          const sc = rebuildScope;
          rebuildScope = null;
          const e = engineRef.current;
          if (!e || !sc) return;
          // Recompute FRONT from the live items — dragging the only door to a
          // different wall re-orients the roof exactly like the 2D labels.
          const nf = getFrontWall(liveItems) || frontWall;
          if (sc.full || nf !== e.model.builtFrontWall) {
            scene.remove(e.model.root);
            disposeShed3DModel(e.model);
            e.model = d3TimedBuild(() => buildShed3DModel(THREE, { bldgW, bldgH, wallHeightFt: spec.wallHeightFt, styleSpec: spec, roofColor: roofCss, roofType, items: liveItems, itemTypes, bodyColor: liveBodyCss, trimColor: liveTrimCss, frontWall: nf, scale, mgX, mgY, fixtures }));
            scene.add(e.model.root);
          } else {
            d3TimedBuild(() => {
              if (sc.walls.size) e.model.rebuildWalls(Array.from(sc.walls), liveItems);
              if (sc.interior) e.model.rebuildInterior(liveItems);
            });
          }
          applyShellMode(e);
          render();
        });
      };
      // Wall-height picks mutate the working spec and rebuild — walls, openings
      // and roof all recompute from the new plate height.
      const setWallHeight = (h) => {
        spec.wallHeightFt = h || 0;
        queueRebuild();
      };
      // Swatch picks recolor the live materials in place — no rebuild needed.
      // Clearing paint returns to the style's natural material colors.
      const setLiveColors = (bodyLabel, trimLabel) => {
        liveBodyCss = bodyLabel ? d3SwatchCss(bodyLabel, D3_COLORS.body, bodyColors) : (spec.colors.body || D3_COLORS.body);
        liveTrimCss = trimLabel ? d3SwatchCss(trimLabel, D3_COLORS.trim, trimColors) : (spec.colors.trim || D3_COLORS.trim);
        const e = engineRef.current;
        if (!e) return;
        e.model.wallMat.color.set(liveBodyCss);
        if (e.model.gableMat) e.model.gableMat.color.set(liveBodyCss);
        e.model.trimMat.color.set(liveTrimCss);
        // Battens are trim-coloured, and they are a separate material, so they need the
        // write too -- otherwise picking a trim swatch recolours everything except the one
        // detail that makes board & batten legible.
        if (e.model.battenMat) e.model.battenMat.color.set(liveTrimCss);
        render();
      };
      // ── 3D placement pipeline (every item class, §10.4) ──
      // Each branch below is the 2D handleClick branch for that class, fed
      // page coordinates from the 3D ray instead of an SVG click: same module
      // snap/collision functions, same stamped fields, committed through the
      // same onItemAdd callback. Never invent a 3D-only placement rule here.
      const flash3 = (m) => {
        setMsg3(m);
        setTimeout(() => setMsg3((cur) => (cur === m ? null : cur)), 4000);
      };
      const itemLabel3 = (type) => (itemTypes[type] && (itemTypes[type].shortLabel || itemTypes[type].label)) || type;
      const commitPlaced3 = (ni) => {
        liveItems = liveItems.concat([ni]);
        if (onItemAdd) onItemAdd(ni);
        if (onItemSelect) { lastSentSelect = ni.id; onItemSelect(ni.id); }
        setSel3d({ id: ni.id, label: itemLabel3(ni.type) });
        capturedRef.current = false;
        setShotTaken(false);
        setTool3(null);
        queueRebuild();
      };
      // Remove the selected item — same one-liner semantics as the 2D delSel,
      // ramp cascade included (a deleted door takes its ramp along).
      const deleteItem3 = (id) => {
        if (!id) return;
        liveItems = liveItems.filter((i) => i.id !== id && !(i.type === "ramp" && i.snapDoorId === id));
        if (onItemDelete) onItemDelete(id);
        if (onItemSelect) { lastSentSelect = null; onItemSelect(null); }
        setSel3d(null);
        capturedRef.current = false;
        setShotTaken(false);
        queueRebuild();
      };
      // Catalog door/window from the in-viewer chooser (also the included-chip
      // path): the FIXTURE stamps are what the estimate prices from — placing
      // these as their raw tool key was the bug that made 3D-placed included
      // fixtures invisible to pricing.
      const placeFixture3 = (fx, type, ptx, pty) => {
        const w = getWallFromClick(ptx, pty, pWpx, pHpx, mgX, mgY) || getNearestWall(ptx, pty, pWpx, pHpx, mgX, mgY);
        const widthFt = (Number(fx.widthIn) || (type === "window" ? 24 : 36)) / 12;
        const sn = snapToWall(w, ptx, pty, widthFt * scale, 0.5 * scale, pWpx, pHpx, mgX, mgY);
        let ni;
        if (type === "window") {
          ni = { id: idCounter++, type: "window", ...sn, widthFt, heightFt: 0.5, fixtureItemId: fx.id, windowName: fx.name || "Window",
            planLabel: (fx.planLabel && String(fx.planLabel).trim()) || (fx.name || "WIN").toUpperCase().slice(0, 6),
            price: (fx.price != null ? fx.price : null), widthIn: Number(fx.widthIn) || null, heightIn: Number(fx.heightIn) || null,
            ...windowColorStamps(fixtureWindowColorDefault(windowColorsFor(fx, windowColors))) };
        } else {
          const swing = fx.swingDefault || (fx.swingOut ? "out" : fx.swingIn ? "in" : null);
          const operation = fx.opDefault || (fx.opDouble ? "double" : fx.opSlideUp ? "slideup" : fx.opRight ? "right" : fx.opLeft ? "left" : null);
          ni = { id: idCounter++, type: "fixtureDoor", ...sn, widthFt, heightFt: 0.5, fixtureItemId: fx.id, doorName: fx.name || "Door",
            planLabel: (fx.planLabel && String(fx.planLabel).trim()) || (fx.name || "DOOR").toUpperCase().slice(0, 6),
            price: (fx.price != null ? fx.price : null), widthIn: Number(fx.widthIn) || null, heightIn: Number(fx.heightIn) || null, swing, operation,
            // The in-viewer picker has no color step (matching its no-swing/op contract):
            // stamp the door's defaults; the shopper refines via the 2D swap flow.
            ...fixtureDoorColorDefaults(fx, doorColors, paintBody, paintTrim) };
        }
        if (checkDoorCollision(ni, { width: widthFt }, liveItems, itemTypes, scale)) {
          flash3("Something's already there — pick a different spot on the wall.");
          return false;
        }
        commitPlaced3(ni);
        return true;
      };
      const placeRamp3 = (fx, door) => {
        const rampDepth = (Number(fx.heightIn) || 0) / 12 || 2;   // 2 = RAMP_SPACE_FT
        const rp = rampPlacementForDoor(door, rampDepth, pWpx, pHpx, mgX, mgY, scale);
        if (!rp) return false;
        const ni = { id: idCounter++, type: "ramp", ...rp, widthFt: (Number(fx.widthIn) || 36) / 12, heightFt: rampDepth, snapDoorId: door.id,
          fixtureItemId: fx.id, rampName: fx.name || "Ramp",
          planLabel: (fx.planLabel && String(fx.planLabel).trim()) || (fx.name || "RAMP").toUpperCase().slice(0, 6),
          price: (fx.price != null ? fx.price : null), widthIn: Number(fx.widthIn) || null, heightIn: Number(fx.heightIn) || null };
        commitPlaced3(ni);
        return true;
      };
      const place3 = (tool, cfg, pageX, pageY) => {
        // Same dispatch order as 2D handleClick: pickers → included chips →
        // doorSnap → wallSnap → loft → wallOnly built-ins.
        if (cfg.isDoorPicker || cfg.isWindowPicker) {
          const w = getWallFromClick(pageX, pageY, pWpx, pHpx, mgX, mgY) || getNearestWall(pageX, pageY, pWpx, pHpx, mgX, mgY);
          setPick3({ kind: cfg.isDoorPicker ? "door" : "window", wall: w, ptx: pageX, pty: pageY });
          setTool3(null);
          return;
        }
        if (cfg.includedFixture && !cfg.doorSnap) {
          placeFixture3(cfg.includedFixture, cfg.includedFixture.category === "window" ? "window" : "fixtureDoor", pageX, pageY);
          return;
        }
        // Annotation tools — same stamps as the 2D branches; the page-bound
        // clamps approximate PAGE_W/TEXT_BAND_TOP (page-layout values the
        // viewer doesn't carry) closely enough to keep the item on the page.
        if (cfg.noteType) {
          commitPlaced3({ id: idCounter++, type: tool,
            x: Math.max(20, Math.min(pageX, mgX * 2 + pWpx - 20)),
            y: Math.max(20, Math.min(pageY, mgY + pHpx + 40)),
            rotation: 0, wall: null, widthPx: 160, heightPx: 40, text: "Note" });
          return;
        }
        if (cfg.lineType) {
          const halfLenPx = ((cfg.width || 4) / 2) * scale;
          const cx = Math.max(20, Math.min(pageX, mgX * 2 + pWpx - 20));
          const cy = Math.max(20, Math.min(pageY, mgY + pHpx + 40));
          commitPlaced3({ id: idCounter++, type: tool, wall: null,
            x1: Math.max(0, cx - halfLenPx), y1: cy,
            x2: Math.min(mgX * 2 + pWpx, cx + halfLenPx), y2: cy });
          return;
        }
        if (cfg.doorSnap) {
          const doors = liveItems.filter((i) => i.type === "singleDoor" || i.type === "doubleDoor" || i.type === "fixtureDoor");
          if (!doors.length) { flash3("Place a door first, then add a ramp to it."); return; }
          let closest = null, minDist = Infinity;
          doors.forEach((d) => { const dx = pageX - d.x, dy = pageY - d.y; const dist = Math.sqrt(dx * dx + dy * dy); if (dist < minDist) { minDist = dist; closest = d; } });
          if (!closest) return;
          if (liveItems.find((i) => i.type === "ramp" && i.snapDoorId === closest.id)) { flash3("This door already has a ramp. Delete it first to replace."); return; }
          if (cfg.isRampPicker) { setPick3({ kind: "ramp", door: closest }); setTool3(null); return; }
          if (cfg.includedFixture) { placeRamp3(cfg.includedFixture, closest); return; }
          const doorCfg = itemTypes[closest.type];
          const rampDepth = 2;   // RAMP_SPACE_FT — visual run out from the door
          const rp = rampPlacementForDoor(closest, rampDepth, pWpx, pHpx, mgX, mgY, scale);
          if (!rp) return;
          commitPlaced3({ id: idCounter++, type: tool, ...rp, widthFt: closest.widthFt || (doorCfg ? doorCfg.width : 3), heightFt: rampDepth, snapDoorId: closest.id });
          return;
        }
        if (cfg.wallSnap) {
          const nw = getNearestWall(pageX, pageY, pWpx, pHpx, mgX, mgY);
          const sn = snapToWallInterior(nw, pageX, pageY, cfg.width * scale, cfg.height * scale, pWpx, pHpx, mgX, mgY);
          const candidate = { id: idCounter, type: tool, ...sn, widthFt: cfg.width, heightFt: cfg.height };
          if (checkDoorCollision(candidate, cfg, liveItems, itemTypes, scale)) {
            flash3("A door is blocking this wall — try a different wall, or move the door first.");
            return;
          }
          const isH = sn.wall === "north" || sn.wall === "south";
          const candPos = isH ? sn.x : sn.y;
          const candHalf = cfg.width * scale / 2;
          for (let i = 0; i < liveItems.length; i++) {
            const ob = liveItems[i];
            if (ob.type !== "workbench" || ob.wall !== sn.wall) continue;
            const obW = (ob.widthFt || itemTypes[ob.type].width) * scale / 2;
            const obPos = isH ? ob.x : ob.y;
            if (Math.abs(candPos - obPos) < candHalf + obW - 2) {
              flash3("Another workbench is in the way. Try a different spot on the wall.");
              return;
            }
          }
          idCounter++;   // only burned on success, like 2D
          commitPlaced3(candidate);
          return;
        }
        if (tool === "loft") {
          // Auto-span wall-to-wall at the clicked position — the 2D rule.
          const loftH = cfg.height || 4;
          const cyFtRound = Math.max(loftH / 2, Math.min(Math.round((pageY - mgY) / scale), bldgH - loftH / 2));
          const nL = 0, nR = bldgW, nT = cyFtRound - loftH / 2, nB = cyFtRound + loftH / 2;
          const otherLofts = liveItems.filter((i) => i.type === "loft");
          for (let i = 0; i < otherLofts.length; i++) {
            const o = otherLofts[i];
            const ow = (o.widthFt || cfg.width) / 2, oh = (o.heightFt || cfg.height) / 2;
            const ocx = (o.x - mgX) / scale, ocy = (o.y - mgY) / scale;
            if (nL < ocx + ow - 0.1 && nR > ocx - ow + 0.1 && nT < ocy + oh - 0.1 && nB > ocy - oh + 0.1) {
              flash3("Can't place a loft overlapping another loft — click a different spot.");
              return;
            }
          }
          commitPlaced3({ id: idCounter++, type: "loft", x: mgX + (bldgW / 2) * scale, y: mgY + cyFtRound * scale, rotation: 0, wall: null, widthFt: bldgW, heightFt: loftH, elevationFt: D3.LOFT_ELEV });
          return;
        }
        // wallOnly built-ins (config singleDoor/doubleDoor/window/roughOpening)
        const w2 = getWallFromClick(pageX, pageY, pWpx, pHpx, mgX, mgY) || getNearestWall(pageX, pageY, pWpx, pHpx, mgX, mgY);
        const sn = snapToWall(w2, pageX, pageY, cfg.width * scale, cfg.height * scale, pWpx, pHpx, mgX, mgY);
        const cand = { id: -1, type: tool, ...sn, widthFt: cfg.width, heightFt: cfg.height };
        if (checkDoorCollision(cand, cfg, liveItems, itemTypes, scale)) {
          flash3("Something is already on that spot. Pick a clear part of the wall.");
          return;
        }
        if (checkWorkbenchOverlap(sn, cfg.width * scale, liveItems, itemTypes, scale)) {
          flash3("A workbench is on that wall — place this somewhere else on the wall.");
          return;
        }
        commitPlaced3({ id: idCounter++, type: tool, ...sn, widthFt: cfg.width, heightFt: cfg.height, ...d3OpeningDefaults(tool) });
      };
      const onPtr3Down = (ev) => {
        if (ev.button !== undefined && ev.button !== 0) return;
        canvasRect = canvas.getBoundingClientRect();   // re-prime the cache at gesture start
        // Armed palette tool: click to place via place3 — wall items use the
        // wall hit, floor items (workbench/loft/ramp) fall back to the ground
        // plane, so every class the 2D palette offers places here too.
        // Clicking the sky keeps the tool armed and lets the orbit through.
        const tool = tool3Ref.current;
        if (tool) {
          const cfg = itemTypes[tool];
          if (!cfg) return;
          const hitW = pickWall3(ev);
          let pageX = null, pageY = null;
          if (hitW) {
            pageX = mgX + (hitW.point.x + bldgW / 2) * scale;
            pageY = mgY + (hitW.point.z + bldgH / 2) * scale;
          } else {
            setRay(ev);
            dragPlane.set(new THREE.Vector3(0, 1, 0), 0);
            const p = raycaster.ray.intersectPlane(dragPlane, dragHit);
            const lim = Math.max(bldgW, bldgH) * 4;
            if (p && Math.abs(p.x) <= lim && Math.abs(p.z) <= lim) {
              pageX = mgX + (p.x + bldgW / 2) * scale;
              pageY = mgY + (p.z + bldgH / 2) * scale;
            }
          }
          if (pageX !== null) {
            ev.stopImmediatePropagation();
            ev.preventDefault();
            place3(tool, cfg, pageX, pageY);
          }
          return;
        }
        const it = pickItem3(ev);
        if (!it) {
          // An orbit is starting and hover raycasts pause while a button is
          // held - drop any hover outline so it can't ride along stale.
          if (lastHoverId != null) { lastHoverId = null; highlight.visible = false; render(); }
          return;
        }
        ev.stopImmediatePropagation();
        ev.preventDefault();
        controls.enabled = false;
        dragging3 = { id: it.id, moved: false };
        setInteractDpr(true);
        lastHoverId = it.id;
        placeHighlight(it);
        highlight.visible = true;
        canvas.style.cursor = "grabbing";
        try { canvas.setPointerCapture(ev.pointerId); } catch (_) { /* synthetic pointer */ }
        render();
      };
      // Apply a live position change during a drag: update the working items,
      // move the outline, rebuild (throttled). `scope` names the wall(s)/
      // interior the change touched so the rebuild stays scoped; omitted = full.
      const commitLive = (it, patch, scope) => {
        liveItems = liveItems.map((i) => (i.id === it.id ? { ...i, ...patch } : i));
        dragging3.moved = true;
        placeHighlight(liveItems.find((i) => i.id === it.id));
        queueRebuild(scope);
      };
      const onPtr3Move = (ev) => {
        if (dragging3) {
          const it = liveItems.find((i) => i.id === dragging3.id);
          if (!it) return;
          const c = itemTypes[it.type] || {};
          setRay(ev);
          if (c.wallOnly) {
            // Doors/windows/ROs: pick against the horizontal plane at the
            // opening's mid-height so the item lands on whichever wall the
            // cursor is nearest — same feel as the 2D drag following the mouse.
            const sp = openSpanOf(it);
            dragPlane.set(new THREE.Vector3(0, 1, 0), -((sp[0] + sp[1]) / 2));
            let p = raycaster.ray.intersectPlane(dragPlane, dragHit);
            const lim = Math.max(bldgW, bldgH) * 4;
            if (!p || Math.abs(p.x) > lim || Math.abs(p.z) > lim) {
              // Grazing angle — track against the item's current wall plane instead.
              if (it.wall === "north") dragPlane.set(new THREE.Vector3(0, 0, 1), bldgH / 2);
              else if (it.wall === "south") dragPlane.set(new THREE.Vector3(0, 0, 1), -bldgH / 2);
              else if (it.wall === "west") dragPlane.set(new THREE.Vector3(1, 0, 0), bldgW / 2);
              else dragPlane.set(new THREE.Vector3(1, 0, 0), -bldgW / 2);
              p = raycaster.ray.intersectPlane(dragPlane, dragHit);
              if (!p) return;
            }
            const pageX = mgX + (p.x + bldgW / 2) * scale;
            const pageY = mgY + (p.z + bldgH / 2) * scale;
            const wFt = it.widthFt || c.width || 3;
            const w = getWallFromClick(pageX, pageY, pWpx, pHpx, mgX, mgY) || getNearestWall(pageX, pageY, pWpx, pHpx, mgX, mgY);
            const sn = snapToWall(w, pageX, pageY, wFt * scale, (c.height || 0.5) * scale, pWpx, pHpx, mgX, mgY);
            if (sn.x !== it.x || sn.y !== it.y || sn.wall !== it.wall) {
              // The door's ramp follows live — same derived placement as 2D.
              const ramp = liveItems.find((i) => i.type === "ramp" && i.snapDoorId === it.id);
              let rampMoved = false;
              if (ramp) {
                const rp = rampPlacementForDoor(sn, ramp.heightFt, pWpx, pHpx, mgX, mgY, scale);
                if (rp) { liveItems = liveItems.map((i) => (i.id === ramp.id ? { ...i, ...rp } : i)); rampMoved = true; }
              }
              commitLive(it, sn, { walls: [it.wall, sn.wall], interior: rampMoved });
            }
          } else if (it.type === "workbench") {
            // Same rules as the 2D wallSnap drag: snap to the nearest wall's
            // interior, blocked by doors and other benches on that wall.
            dragPlane.set(new THREE.Vector3(0, 1, 0), -(D3.BENCH_H / 2));
            const p = raycaster.ray.intersectPlane(dragPlane, dragHit);
            if (!p) return;
            const pageX = mgX + (p.x + bldgW / 2) * scale;
            const pageY = mgY + (p.z + bldgH / 2) * scale;
            const wFt = it.widthFt || c.width || 6;
            const nw = getNearestWall(pageX, pageY, pWpx, pHpx, mgX, mgY);
            const sn = snapToWallInterior(nw, pageX, pageY, wFt * scale, (c.height || 2) * scale, pWpx, pHpx, mgX, mgY);
            const others = liveItems.filter((i) => i.id !== it.id);
            if (checkDoorCollision({ ...it, ...sn }, { ...c, width: wFt }, others, itemTypes, scale)) return;
            const isH = sn.wall === "north" || sn.wall === "south";
            const candPos = isH ? sn.x : sn.y;
            const candHalf = wFt * scale / 2;
            for (let oi = 0; oi < others.length; oi++) {
              const ob = others[oi];
              if (ob.type !== "workbench" || ob.wall !== sn.wall) continue;
              const obW = (ob.widthFt || (itemTypes[ob.type] || {}).width || 6) * scale / 2;
              const obPos = isH ? ob.x : ob.y;
              if (Math.abs(candPos - obPos) < candHalf + obW - 2) return;
            }
            if (sn.x !== it.x || sn.y !== it.y || sn.wall !== it.wall) commitLive(it, sn, { interior: true });
          } else if (it.type === "loft") {
            // Same rules as the 2D free drag: integer-foot rounding, wall +
            // loft edge snapping, overlap reject; unattached positions are
            // allowed mid-drag (the 2D banner warns about them).
            const elev = it.elevationFt || D3.LOFT_ELEV;
            dragPlane.set(new THREE.Vector3(0, 1, 0), -elev);
            const p = raycaster.ray.intersectPlane(dragPlane, dragHit);
            if (!p) return;
            const wFt = it.widthFt || c.width || 6, hFt = it.heightFt || c.height || 4;
            const halfW = wFt / 2, halfH = hFt / 2;
            const snapFt = 1;
            let cxFt = Math.round(p.x + bldgW / 2);
            let cyFt = Math.round(p.z + bldgH / 2);
            if (cxFt - halfW < snapFt) cxFt = halfW;
            else if (cxFt + halfW > bldgW - snapFt) cxFt = bldgW - halfW;
            if (cyFt - halfH < snapFt) cyFt = halfH;
            else if (cyFt + halfH > bldgH - snapFt) cyFt = bldgH - halfH;
            const otherLofts = liveItems.filter((i) => i.type === "loft" && i.id !== it.id);
            let l = cxFt - halfW, r = cxFt + halfW, t = cyFt - halfH, b = cyFt + halfH;
            for (let oi = 0; oi < otherLofts.length; oi++) {
              const o = otherLofts[oi];
              const oW = (o.widthFt || 6) / 2, oH = (o.heightFt || 4) / 2;
              const oCx = (o.x - mgX) / scale, oCy = (o.y - mgY) / scale;
              const oL = oCx - oW, oR = oCx + oW, oT = oCy - oH, oB = oCy + oH;
              if (t < oB && b > oT) {
                if (Math.abs(r - oL) < snapFt) cxFt = oL - halfW;
                else if (Math.abs(l - oR) < snapFt) cxFt = oR + halfW;
              }
              if (l < oR && r > oL) {
                if (Math.abs(b - oT) < snapFt) cyFt = oT - halfH;
                else if (Math.abs(t - oB) < snapFt) cyFt = oB + halfH;
              }
              l = cxFt - halfW; r = cxFt + halfW; t = cyFt - halfH; b = cyFt + halfH;
            }
            cxFt = Math.max(halfW, Math.min(cxFt, bldgW - halfW));
            cyFt = Math.max(halfH, Math.min(cyFt, bldgH - halfH));
            const fL = cxFt - halfW, fR = cxFt + halfW, fT = cyFt - halfH, fB = cyFt + halfH;
            for (let oi = 0; oi < otherLofts.length; oi++) {
              const o = otherLofts[oi];
              const oW2 = (o.widthFt || 6) / 2, oH2 = (o.heightFt || 4) / 2;
              const oCx2 = (o.x - mgX) / scale, oCy2 = (o.y - mgY) / scale;
              if (fL < oCx2 + oW2 - 0.1 && fR > oCx2 - oW2 + 0.1 && fT < oCy2 + oH2 - 0.1 && fB > oCy2 - oH2 + 0.1) return;
            }
            const nx = mgX + cxFt * scale, ny = mgY + cyFt * scale;
            if (nx !== it.x || ny !== it.y) commitLive(it, { x: nx, y: ny }, { interior: true });
          }
          ev.preventDefault();
          return;
        }
        // Hover affordance: grab cursor + amber outline over movable items
        // (crosshair while a palette tool is armed). A held button means an
        // orbit is in progress - skip the raycast entirely; OrbitControls owns
        // the gesture and hover feedback would be invisible anyway.
        if (tool3Ref.current) return;
        if (ev.buttons !== 0) return;
        const hov = pickItem3(ev);
        canvas.style.cursor = hov ? "grab" : "";
        const hid = hov ? hov.id : null;
        if (hid !== lastHoverId) {
          lastHoverId = hid;
          if (hov) placeHighlight(hov);
          highlight.visible = !!hov;
          render();
        }
      };
      const onPtr3Up = (ev) => {
        if (!dragging3) return;
        const d = dragging3;
        dragging3 = null;
        controls.enabled = true;
        setInteractDpr(false);
        canvas.style.cursor = "";
        try { canvas.releasePointerCapture(ev.pointerId); } catch (_) { /* not captured */ }
        highlight.visible = false;
        lastHoverId = null;
        render();
        if (d.moved) {
          const moved = liveItems.find((i) => i.id === d.id);
          if (moved && onItemMove) onItemMove(moved.id, { x: moved.x, y: moved.y, rotation: moved.rotation, wall: moved.wall });
          // A moved door commits its ramp's new derived position too.
          const ramp = liveItems.find((i) => i.type === "ramp" && i.snapDoorId === d.id);
          if (ramp && onItemMove) onItemMove(ramp.id, { x: ramp.x, y: ramp.y, rotation: ramp.rotation, wall: ramp.wall });
          // The design changed under any earlier shot — re-arm capture-on-close.
          capturedRef.current = false;
          setShotTaken(false);
        }
        // Selection syncs to the 2D view (§10.5) — a tap selects, a drag
        // selects what it moved. Tapping the already-selected item again is a
        // no-op and shouldn't re-render the parent (unless it moved).
        if (onItemSelect && (d.moved || d.id !== lastSentSelect)) { lastSentSelect = d.id; onItemSelect(d.id); }
        const selIt = liveItems.find((i) => i.id === d.id);
        setSel3d(selIt ? { id: selIt.id, label: itemLabel3(selIt.type) } : null);
      };
      canvas.addEventListener("pointerdown", onPtr3Down, true);
      canvas.addEventListener("pointermove", onPtr3Move);
      canvas.addEventListener("pointerup", onPtr3Up);
      canvas.addEventListener("pointercancel", onPtr3Up);
      const disposeInteraction = () => {
        canvas.removeEventListener("pointerdown", onPtr3Down, true);
        canvas.removeEventListener("pointermove", onPtr3Move);
        canvas.removeEventListener("pointerup", onPtr3Up);
        canvas.removeEventListener("pointercancel", onPtr3Up);
        scene.remove(highlight);
        highlight.geometry.dispose();
        highlight.material.dispose();
      };

      const controls = new OrbitControls(camera, canvasRef.current);
      controls.target.set(0, D3.WALL_H * 0.45, 0);
      controls.maxPolarAngle = Math.PI * 0.495; // never below the ground plane
      controls.minDistance = R * 1.1;
      controls.maxDistance = dist * 2.5;
      controls.update();
      const render = () => renderer.render(scene, camera);
      // Orbit renders are rAF-coalesced: wheel and high-rate trackpads fire
      // "change" faster than the display refreshes, and each render is a full
      // frame. Only the orbit path goes through this - the fixture-photo
      // settle and capture() below keep their DIRECT render calls, which must
      // work in a backgrounded tab where rAF never fires.
      let renderQueued = false;
      const scheduleRender = () => {
        if (renderQueued) return;
        renderQueued = true;
        requestAnimationFrame(() => { renderQueued = false; render(); });
      };
      controls.addEventListener("change", scheduleRender);
      controls.addEventListener("start", () => setInteractDpr(true));
      controls.addEventListener("end", () => setInteractDpr(false));
      const resize = () => {
        const el = wrapRef.current;
        if (!el) return;
        canvasRect = null;   // the cached pointer-math rect is stale now
        renderer.setSize(el.clientWidth, el.clientHeight, false);
        camera.aspect = el.clientWidth / Math.max(1, el.clientHeight);
        camera.updateProjectionMatrix();
        render();
      };
      const ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver(resize) : null;
      if (ro && wrapRef.current) ro.observe(wrapRef.current);
      // The window listener is only the fallback for environments without
      // ResizeObserver — wired together, every window resize ran resize()
      // (and its render) twice.
      if (!ro) window.addEventListener("resize", resize);
      // A fixture photo that arrives after the scene is built has already been swapped
      // into its materials by the cache (see d3FixtureTexture) — all that is left is
      // asking for a frame, since this renderer draws on demand. Deliberately a direct
      // render, NOT queueRebuild: rAF does not fire in a backgrounded tab, and a
      // customer who switches tabs must not come back to blank doors.
      // Also un-arm any snapshot already taken: it shows placeholder slabs, so the
      // close handler should replace it with the real thing.
      const offFxTex = d3OnFixtureTexSettle(() => {
        const e2 = engineRef.current;
        if (!e2) return;
        e2.render();
        // The shot taken before this photo landed shows a painted door, not the builder's.
        // Drop it on BOTH sides: the modal's own button state AND the parent's stored shot,
        // which otherwise kept the toolbar claiming "3D checked" for a stale image.
        capturedRef.current = false;
        setShotTaken(false);
        onSnapshot(null);
      });
      engineRef.current = { renderer, scene, camera, controls, model, sky, sun, render, resize, ro, applyShellMode, setViewPreset, disposeInteraction, setLiveColors, setWallHeight, place3Fixture: placeFixture3, place3Ramp: placeRamp3, delete3: deleteItem3, offFxTex, baseDpr, interior: false, roofOn: true, envOn: true };
      // Dev-only: expose the engine for the perf-measurement protocol.
      if (typeof window !== "undefined" && window.__SS3D_DEBUG) window.__ss3dEngine = engineRef.current;
      resize();
      setPhase("ready");
    }).catch((err) => {
      console.error("3D view failed to load:", err);
      if (!disposed) setPhase("error");
    });
    return () => {
      disposed = true;
      const e = engineRef.current;
      if (!e) return;
      engineRef.current = null;
      window.removeEventListener("resize", e.resize);
      if (e.ro) e.ro.disconnect();
      if (e.offFxTex) e.offFxTex();   // no rendering into a disposed renderer, no setState after unmount
      e.controls.dispose();
      e.disposeInteraction();
      disposeShed3DModel(e.model);
      if (e.sky) { e.sky.geometry.dispose(); if (e.sky.material.map) e.sky.material.map.dispose(); e.sky.material.dispose(); }
      if (e.sun && e.sun.shadow && e.sun.shadow.map) e.sun.shadow.map.dispose(); // renderer.dispose() won't free the shadow target
      e.renderer.dispose();
    };
  // The modal mounts fresh on every open and the 2D designer can't change
  // underneath it, so the scene builds exactly once per mount.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // "Look inside": hide the roof, ghost the walls; door/window frames, floor
  // and interior items stay solid so lofts/workbenches read clearly. Roof and
  // Landscape toggles ride the same path so they survive live rebuilds too.
  useEffect(() => {
    const e = engineRef.current;
    if (!e) return;
    e.interior = interior;             // survives live rebuilds during drags
    e.roofOn = roofOn;
    e.envOn = envOn;
    e.applyShellMode(e);
    e.render();
  }, [interior, roofOn, envOn, phase]);

  const capture = () => {
    const e = engineRef.current;
    if (!e) return null;
    // The quote page must be sharp even if a touch interaction just lowered
    // the DPR — restore base resolution before the frame we read back.
    if (e.baseDpr && e.renderer.getPixelRatio() !== e.baseDpr) e.renderer.setPixelRatio(e.baseDpr);
    e.render(); // fresh buffer right before reading it back
    try {
      const c = e.renderer.domElement;
      // A collapsed canvas (a hidden/backgrounded tab, or a resize race) makes toDataURL
      // return the bare "data:," and a 0x0 page. That passed the caller's !shot check and
      // became an empty page 2 of the quote with degenerate placement maths — better to
      // report no snapshot and keep the plan-only PDF.
      if (!c.width || !c.height) return null;
      const url = c.toDataURL("image/jpeg", 0.9);
      if (!url || url.length < 128) return null;
      return { url, w: c.width, h: c.height };
    } catch (_) { return null; }
  };
  // This image becomes page 2 of the quote the customer signs against, so it must
  // never be read while a fixture photo is still loading — that would ship a quote
  // showing blank placeholder doors. Capped so a dead image host can't hang the
  // shutter; a warm cache waits for nothing.
  // The photo lands directly in the materials, and capture() renders before it reads
  // the buffer, so waiting for the loads is the whole guard. No animation frame is
  // involved on purpose — see the settle listener.
  const awaitFixturePhotos = () => (d3FixtureTexturesPending() > 0 ? d3WaitFixtureTextures(1500) : Promise.resolve());
  const takeSnapshot = async () => {
    await awaitFixturePhotos();
    const shot = capture();
    if (!shot) return;                 // also covers a close mid-await
    capturedRef.current = true;
    onSnapshot(shot);
    setShotTaken(true);
  };
  const handleClose = async () => {
    if (closing) return;
    // Never-captured close still contributes the last viewed angle — opening
    // the 3D view at all means the customer gets the 3D page in their quote.
    // The photo wait (up to 1.5s) + readback + JPEG encode used to freeze the
    // ✕ with zero feedback — the `closing` overlay owns that gap now.
    if (!capturedRef.current && phase === "ready") {
      setClosing(true);
      await awaitFixturePhotos();
      const shot = capture();
      if (shot) onSnapshot(shot);
    }
    onClose();
  };

  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(15,23,42,0.9)", zIndex: 1100, display: "flex", flexDirection: "column" }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "10px 16px", background: "#0F172A" }}>
        <div style={{ color: "#F8FAFC", fontWeight: 800, fontSize: 15 }}>
          3D Preview
          <span style={{ color: "#94A3B8", fontWeight: 600, fontSize: 12, marginLeft: 10 }}>{bldgW}×{bldgH} ft — drag to orbit · drag items to move them · scroll to zoom</span>
        </div>
        <button onClick={handleClose} disabled={closing} style={{ background: "none", border: "none", color: closing ? "#64748B" : "#CBD5E1", fontSize: 22, cursor: closing ? "default" : "pointer", lineHeight: 1 }}>✕</button>
      </div>
      <div ref={wrapRef} style={{ flex: 1, position: "relative", minHeight: 0 }}>
        <canvas ref={canvasRef} style={{ width: "100%", height: "100%", display: "block", touchAction: "none" }} />
        {phase === "loading" && (
          <div style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center", color: "#E2E8F0", fontWeight: 700 }}>Building your 3D model…</div>
        )}
        {phase === "error" && (
          <div style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center", color: "#FCA5A5", fontWeight: 700, textAlign: "center", padding: 20 }}>
            Couldn't load the 3D viewer — check your connection, then close and try again.
          </div>
        )}
        {closing && (
          <div style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center", background: "rgba(15,23,42,0.45)", color: "#E2E8F0", fontWeight: 700 }}>Saving your 3D view…</div>
        )}
        {/* In-viewer catalog chooser: the 3D counterpart of the 2D DoorPicker/
            WindowPicker/RampPicker modals. Choosing commits through the engine's
            place3Fixture/place3Ramp (closure functions published on engineRef),
            so the placed item lands in THIS scene's liveItems and rebuilds. */}
        {pick3 && (
          <div style={{ position: "absolute", left: "50%", bottom: 14, transform: "translateX(-50%)", background: "#0F172A", border: "1px solid #334155", borderRadius: 12, padding: 12, zIndex: 40, width: "min(540px, 92%)", maxHeight: 300, overflowY: "auto", boxShadow: "0 12px 40px rgba(0,0,0,0.5)" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
              <span style={{ color: "#E2E8F0", fontSize: 13, fontWeight: 800 }}>
                {pick3.kind === "door" ? "Pick a door" : pick3.kind === "window" ? "Pick a window" : "Pick a ramp"}
              </span>
              <button onClick={() => setPick3(null)} style={{ background: "none", border: "none", color: "#94A3B8", fontSize: 18, cursor: "pointer", lineHeight: 1 }}>✕</button>
            </div>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 8, justifyContent: "center" }}>
              {(pick3.kind === "door" ? (placeableDoors || []) : pick3.kind === "window" ? (placeableWindows || []) : (placeableRamps || [])).map((fx) => (
                <button key={fx.id}
                  onClick={() => {
                    const e = engineRef.current;
                    if (!e) return;
                    const ok = pick3.kind === "ramp"
                      ? e.place3Ramp(fx, pick3.door)
                      : e.place3Fixture(fx, pick3.kind === "window" ? "window" : "fixtureDoor", pick3.ptx, pick3.pty);
                    if (ok !== false) setPick3(null);
                  }}
                  style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 4, background: "#1E293B", border: "1px solid #334155", borderRadius: 8, padding: 8, cursor: "pointer", width: 108 }}>
                  {fx.imageUrl
                    ? <img src={fx.imageUrl} alt="" style={{ width: 84, height: 64, objectFit: "contain" }} />
                    : <span style={{ fontSize: 28 }}>{pick3.kind === "window" ? "🪟" : pick3.kind === "ramp" ? "📐" : "🚪"}</span>}
                  <span style={{ color: "#CBD5E1", fontSize: 11, fontWeight: 700, textAlign: "center" }}>{fx.name}</span>
                  {fx.widthIn ? <span style={{ color: "#64748B", fontSize: 10 }}>{fx.widthIn}" wide</span> : null}
                </button>
              ))}
            </div>
          </div>
        )}
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 8, padding: "10px 16px", background: "#0F172A" }}>
        {/* Add-item palette: every class places with the same pipeline as 2D clicks */}
        <div style={{ display: "flex", gap: 6, alignItems: "center", justifyContent: "center", flexWrap: "wrap" }}>
          <span style={{ color: "#64748B", fontSize: 11, fontWeight: 800, textTransform: "uppercase", letterSpacing: "0.05em" }}>Add</span>
          {/* The placeable set is handed in by the parent — the SAME list the 2D tool row
              builds — rather than re-derived here. Deriving it locally is what went wrong:
              this palette filtered on `wallOnly` alone, so it offered render-only types
              (built-in singleDoor/doubleDoor/window, the fixtureDoor stand-in) whose
              placements carry none of the fixture stamps the estimate prices from, plus
              `internalOnly` staff items that the public 2D palette deliberately hides.
              The door/window/ramp PICKER tools are handled by the in-viewer chooser
              (pick3) — the 2D picker modals commit outside this scene's liveItems, so
              routing them there would place items the open viewer never draws. */}
          {(paletteKeys || []).map((k) => (
            <button key={k} onClick={() => {
              const arming = tool3 !== k;
              setTool3(arming ? k : null);
              // Arming a tool flips the view to the side the item lands on
              // (Ahsan 2026-08-18): interior items (bench/loft) are invisible
              // behind walls with the roof on, and wall/exterior items are
              // disorienting to place from the ghost view. Notes/lines are
              // visible either way and force nothing. The Look inside button
              // stays the manual toggle.
              if (arming) {
                const kc = itemTypes[k];
                if ((kc.wallSnap || k === "loft") && !interior) setInterior(true);
                else if ((kc.wallOnly || kc.doorSnap) && interior) setInterior(false);
              }
            }} disabled={phase !== "ready"}
              style={{ background: tool3 === k ? accent : "#1E293B", color: tool3 === k ? "#FFF" : "#CBD5E1", border: "1px solid #334155", borderRadius: 7, padding: "6px 10px", fontSize: 12, fontWeight: 700, cursor: "pointer", opacity: phase === "ready" ? 1 : 0.5 }}>
              {itemTypes[k].icon} {itemTypes[k].shortLabel || itemTypes[k].label}
            </button>
          ))}
          {tool3 && !msg3 && <span style={{ color: accent, fontSize: 12, fontWeight: 700 }}>← {itemTypes[tool3] && itemTypes[tool3].doorSnap ? "click near a door" : itemTypes[tool3] && (itemTypes[tool3].wallOnly || itemTypes[tool3].wallSnap) ? "click a wall" : "click the floor"}</span>}
          {msg3 && <span style={{ color: "#FCA5A5", fontSize: 12, fontWeight: 700 }}>{msg3}</span>}
          {sel3d && !tool3 && (
            <button onClick={() => { const e = engineRef.current; if (e && e.delete3) e.delete3(sel3d.id); }}
              style={{ background: "#7F1D1D", color: "#FECACA", border: "1px solid #991B1B", borderRadius: 7, padding: "6px 10px", fontSize: 12, fontWeight: 700, cursor: "pointer" }}>
              🗑 Remove {sel3d.label}
            </button>
          )}
        </div>
        {/* Wall height — rebuilds live; the pick rides into the saved design + estimate */}
        <div style={{ display: "flex", gap: 6, alignItems: "center", justifyContent: "center", flexWrap: "wrap" }}>
          <span style={{ color: "#64748B", fontSize: 11, fontWeight: 800, textTransform: "uppercase", letterSpacing: "0.05em" }}>Wall height</span>
          {[6, 7, 8, 9, 10].map((h) => (
            <button key={h} onClick={() => pickWallHeight(h)} disabled={phase !== "ready"}
              style={{ background: wallHSel === h ? accent : "#1E293B", color: wallHSel === h ? "#FFF" : "#CBD5E1", border: "1px solid #334155", borderRadius: 7, padding: "6px 10px", fontSize: 12, fontWeight: 700, cursor: "pointer", opacity: phase === "ready" ? 1 : 0.5 }}>
              {h} ft
            </button>
          ))}
        </div>
        {/* Paint colors: labels land in paintColors (and the estimate); swatch hex drives the 3D */}
        {paintEnabled && (
          <div style={{ display: "flex", gap: 14, alignItems: "center", justifyContent: "center", flexWrap: "wrap" }}>
            {["body", "trim"].map((kind) => {
              // The tenant's catalog if they have one for this slot, otherwise the built-in
              // nine. NOT hidden-when-empty: junior-barns -- the demo tenant -- has no named
              // colours at all (migration 009 says so), so hiding would strip a working
              // control off the expo demo to make a point about consistency. Falling back
              // leaves every existing tenant exactly as they are and upgrades the ones who
              // have actually built a palette.
              const sw = (kind === "trim" ? trimColors : bodyColors);
              const pool = (sw && sw.length) ? sw : D3_SWATCHES;
              return (
              <div key={kind} style={{ display: "flex", gap: 5, alignItems: "center" }}>
                <span style={{ color: "#64748B", fontSize: 11, fontWeight: 800, textTransform: "uppercase", letterSpacing: "0.05em" }}>{kind}</span>
                {pool.map((s) => (
                  <button key={s.label} title={s.label} onClick={() => pickColor(kind, s.label)} disabled={phase !== "ready"}
                    style={{ width: 20, height: 20, borderRadius: 99, background: s.css, cursor: "pointer", padding: 0, border: paintSel[kind] === s.label ? "2px solid #FBBF24" : "1px solid #334155" }} />
                ))}
              </div>
            );})}
            <button onClick={() => pickColor("none")} disabled={phase !== "ready"} style={{ background: "#1E293B", color: "#94A3B8", border: "1px solid #334155", borderRadius: 7, padding: "4px 9px", fontSize: 11, fontWeight: 700, cursor: "pointer" }}>✕ No paint</button>
          </div>
        )}
        <div style={{ display: "flex", gap: 10, alignItems: "center", justifyContent: "center", flexWrap: "wrap" }}>
          {/* SmartBuild-style view options: camera presets + Roof/Landscape layer toggles */}
          <div style={{ position: "relative" }}>
            {viewsOpen && (
              <div style={{ position: "absolute", bottom: "115%", left: "50%", transform: "translateX(-50%)", background: "#0F172A", border: "1px solid #334155", borderRadius: 10, padding: 7, display: "grid", gridTemplateColumns: "repeat(3, 52px)", gap: 5, zIndex: 5 }}>
                {[
                  { l: "↖ FL", a: -45, p: 26 }, { l: "F", a: 0, p: 22 }, { l: "FR ↗", a: 45, p: 26 },
                  { l: "← L", a: -90, p: 20 }, { l: "⬒ Top", a: 0, p: 86 }, { l: "R →", a: 90, p: 20 },
                  { l: "↙ BL", a: -135, p: 26 }, { l: "B", a: 180, p: 22 }, { l: "BR ↘", a: 135, p: 26 },
                ].map((v) => (
                  <button key={v.l} onClick={() => { const e = engineRef.current; if (e && e.setViewPreset) e.setViewPreset(v.a, v.p); setViewsOpen(false); }}
                    style={{ background: "#1E293B", color: "#CBD5E1", border: "1px solid #334155", borderRadius: 6, padding: "7px 2px", fontSize: 11, fontWeight: 700, cursor: "pointer" }}>{v.l}</button>
                ))}
              </div>
            )}
            <button onClick={() => setViewsOpen((v) => !v)} disabled={phase !== "ready"} style={{ background: viewsOpen ? accent : "#1E293B", color: viewsOpen ? "#FFF" : "#E2E8F0", border: "1px solid #334155", borderRadius: 8, padding: "9px 14px", fontSize: 13, fontWeight: 700, cursor: "pointer", opacity: phase === "ready" ? 1 : 0.5 }}>
              🎥 Views {viewsOpen ? "▾" : "▴"}
            </button>
          </div>
          <button onClick={() => setRoofOn((v) => !v)} disabled={phase !== "ready"} title="Show/hide the roof" style={{ background: roofOn ? "#1E293B" : "#475569", color: "#E2E8F0", border: "1px solid #334155", borderRadius: 8, padding: "9px 14px", fontSize: 13, fontWeight: 700, cursor: "pointer", opacity: phase === "ready" ? 1 : 0.5 }}>
            ⛺ Roof {roofOn ? "" : "off"}
          </button>
          <button onClick={() => setEnvOn((v) => !v)} disabled={phase !== "ready"} title="Show/hide grass, sky and labels" style={{ background: envOn ? "#1E293B" : "#475569", color: "#E2E8F0", border: "1px solid #334155", borderRadius: 8, padding: "9px 14px", fontSize: 13, fontWeight: 700, cursor: "pointer", opacity: phase === "ready" ? 1 : 0.5 }}>
            🌿 Landscape {envOn ? "" : "off"}
          </button>
          <button onClick={() => setInterior((v) => !v)} disabled={phase !== "ready"} style={{ background: "#1E293B", color: "#E2E8F0", border: "1px solid #334155", borderRadius: 8, padding: "9px 16px", fontSize: 13, fontWeight: 700, cursor: "pointer", opacity: phase === "ready" ? 1 : 0.5 }}>
          {interior ? "🏠 Show exterior" : "👁 Look inside"}
        </button>
        <button onClick={takeSnapshot} disabled={phase !== "ready"} style={{ background: accent, color: "#FFF", border: "none", borderRadius: 8, padding: "9px 18px", fontSize: 13, fontWeight: 800, cursor: "pointer", opacity: phase === "ready" ? 1 : 0.5 }}>
          {shotTaken ? "✓ Added to quote — retake?" : "📸 Use this view in my quote"}
        </button>
        </div>
      </div>
    </div>
  );
}

// ─── Docked view-only 3D (Carolyn, 2026-08-19) ────────────────────────────────
// Which part of the 3D an `items` change touched. buildOneWall selects on
// c.wallOnly ALONE; buildInterior builds EVERYTHING else — lofts, workbenches
// (wallSnap), ramps (doorSnap), notes (noteType, a ground plaque) and lines
// (lineType, a strip). Anything not attributable returns { full: true }: a full
// rebuild is ~11ms, a stale wall standing beside a corrected plan is a bug the
// customer sees. The identity compare is exact and O(n) because every 2D
// mutation is `setItems((p) => p.map((i) => i.id === X ? {...i, ...} : i))`,
// which returns the SAME object for every untouched row.
function d3ScopeForItemsChange(prev, next, itemTypes) {
  if (prev === next) return null;
  const walls = new Set();
  let interior = false, full = false;
  const index = (arr) => { const m = new Map(); (arr || []).forEach((i) => m.set(i.id, i)); return m; };
  const pm = index(prev), nm = index(next);
  const touch = (it) => {
    if (!it) return;
    const c = itemTypes[it.type];
    if (!c) { full = true; return; }          // unknown class — never guess
    if (c.wallOnly) { if (it.wall) walls.add(it.wall); else full = true; return; }
    interior = true;                          // loft | workbench | ramp | note | line
  };
  const ids = new Set();
  pm.forEach((_v, k) => ids.add(k));
  nm.forEach((_v, k) => ids.add(k));
  ids.forEach((id) => {
    const a = pm.get(id), b = nm.get(id);
    if (a === b) return;
    touch(a); touch(b);
  });
  return full ? { full: true } : { walls: Array.from(walls), interior };
}

/**
 * Structure3DPanel — the 3D docked BESIDE the 2D plan instead of over it.
 *
 * Carolyn drew this on the 2026-08-19 call: the floor plan keeps the left of the
 * canvas, the 3D takes a column on the right, and the same toolbar button toggles
 * it. Scope, confirmed by Ahsan: the customer can ROTATE AROUND THE BUILDING AND
 * LOOK AT IT. Nothing more. No placing, no dragging, no wall height, no colors,
 * no snapshot, no roof/landscape/look-inside toggles — every one of those stays
 * the full-screen Structure3DViewer's job, and this file does not touch it.
 *
 * "View-only" is not a flag that could be flipped: this component simply never
 * registers pointer handlers, never builds a raycaster, and never caches a canvas
 * rect. That also means the whole class of scroll-stale-rect bugs cannot occur.
 *
 * Gating: rendered INSIDE the same `view3dOn` expression that gates the 3D button
 * — never hoisted above it — so a tenant without the grant cannot reach, render,
 * or discover it. There is no second switch to forget.
 *
 * Deliberate differences from the modal, all justified by a ~380px canvas:
 *   shadow map 2048 → 1024 (largest single GPU allocation, invisible at this size)
 *   DPR cap 2 → 1.75
 *   controls.enablePan → false (in a narrow panel a pan walks the building
 *     off-screen with no reset control to bring it back)
 *   forceContextLoss() on teardown — the modal omits it; the repo's throwaway
 *     GLB-scan renderer does call it, and this surface mounts far more often.
 */
function Structure3DPanel({ bldgW, bldgH, items, itemTypes, painted, paintBody, paintTrim, frontWall, scale, mgX, mgY, style3d, roofType, roofColorHex, fixtures, bodyColors, trimColors, fitHeightFt = 0, suspended, canEdit, onEdit, onClose }) {
  const canvasRef = useRef(null);
  const wrapRef = useRef(null);
  const engineRef = useRef(null);
  const [phase, setPhase] = useState("loading");   // loading | ready | error

  // Latest props, readable from inside the mount effect's closures. Assigned
  // during render (not in an effect) so a flush scheduled this frame already
  // sees this frame's values — this is what avoids the frozen-props trap.
  const pRef = useRef(null);
  pRef.current = { bldgW, bldgH, items, itemTypes, painted, paintBody, paintTrim, frontWall, scale, mgX, mgY, style3d, roofType, roofColorHex, fixtures, fitHeightFt };

  // Every geometry input that is NOT `items`, flattened to a scalar string.
  // d3ResolveStyleSpec returns a fresh object (with fresh nested roof/colors)
  // on every parent render, so an object in a dep array would rebuild the whole
  // model on every mousemove. Scalars cannot do that.
  // Stringify the WHOLE resolved spec instead of hand-picking fields. d3ResolveStyleSpec
  // returns a small plain object with stable key order, so this is still a cheap scalar —
  // but unlike a field list it cannot drift out of step with what buildShed3DModel reads.
  // The hand-picked version silently missed roofMaterial, roof.overhang and the gambrel
  // knee numbers, so two styles differing only in those left a stale roof standing beside
  // a corrected plan until some unrelated edit happened to force a full rebuild.
  const geomSig = JSON.stringify([style3d, roofType || "", roofColorHex || "", painted ? 1 : 0, paintBody || "", paintTrim || "", scale, mgX, mgY, fitHeightFt || 0]);

  useEffect(() => {
    let disposed = false;
    loadThree().then((bundle) => {
      const THREE = bundle.THREE, OrbitControls = bundle.OrbitControls;
      if (disposed || !canvasRef.current) return;
      const canvas = canvasRef.current;
      const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: false });
      renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.75));
      renderer.shadowMap.enabled = true;
      renderer.shadowMap.type = THREE.PCFSoftShadowMap;
      renderer.toneMapping = THREE.ACESFilmicToneMapping;
      renderer.toneMappingExposure = 1.15;
      // Same view-independent sun as the modal: orbiting must not re-render the
      // depth map. Every geometry mutation below re-arms needsUpdate by hand.
      renderer.shadowMap.autoUpdate = false;
      renderer.shadowMap.needsUpdate = true;

      const scene = new THREE.Scene();
      scene.background = new THREE.Color("#E7EEF5");

      const specOf = (p) => p.style3d || { roof: D3_DEFAULT_ROOF, siding: null, colors: {}, wallHeightFt: 0 };
      const bodyOf = (p) => (p.painted ? d3SwatchCss(p.paintBody, D3_COLORS.body, p.bodyColors) : (specOf(p).colors.body || D3_COLORS.body));
      const trimOf = (p) => (p.painted ? d3SwatchCss(p.paintTrim, D3_COLORS.trim, p.trimColors) : (specOf(p).colors.trim || D3_COLORS.trim));
      const roofOf = (p) => p.roofColorHex || specOf(p).colors.roof || D3_COLORS.roof;
      const buildArgs = (p, fw) => {
        const spec = specOf(p);
        return { bldgW: p.bldgW, bldgH: p.bldgH, wallHeightFt: spec.wallHeightFt, styleSpec: spec, roofColor: roofOf(p), roofType: p.roofType, items: p.items, itemTypes: p.itemTypes, bodyColor: bodyOf(p), trimColor: trimOf(p), frontWall: fw, scale: p.scale, mgX: p.mgX, mgY: p.mgY, fixtures: p.fixtures };
      };

      const p0 = pRef.current;
      const fw0 = p0.frontWall || "south";
      // The builder gets the RAW nullable frontWall, exactly as the modal does — fw0's
      // "south" default exists for the camera lookup only. Defaulting it into the builder
      // would give a doorless design a different roof here than in the full-screen view and
      // the quote snapshot, and would leave model.builtFrontWall on a different domain from
      // the value the flush below compares it against.
      const model = d3TimedBuild(() => buildShed3DModel(THREE, buildArgs(p0, p0.frontWall)));
      scene.add(model.root);
      scene.add(new THREE.HemisphereLight(0xDCE9FF, 0x8D8573, 1.5));

      // Camera framing — identical maths to the modal so the docked view and the
      // full-screen view read as the same building from the same angle. Every
      // constant below derives ONLY from bldgW/bldgH and the fit height, which is
      // exactly why the parent remounts this component on a size change and on nothing
      // else -- a height change re-aims in place via applyFraming instead.
      //
      // fitHeightFt is the VERTICAL half of the framing, and it is opt-in. The designer's
      // dock passes nothing, so fitH is exactly D3.WALL_H and every number below is the
      // arithmetic it always was. Settings -> Designer -> 3D passes the DRAFT wall height,
      // because there the wall height is the number being typed: framed for 8ft, a 16ft
      // wall puts the ridge outside the frustum, and this panel has no pan to recover it.
      const OUT = { north: [0.35, -1], south: [0.35, 1], west: [-1, 0.35], east: [1, 0.35] }[fw0] || [0.35, 1];
      const fitH = (p) => Math.max(D3.WALL_H, Number(p.fitHeightFt) || 0);
      const frameFor = (p) => { const r = Math.max(p.bldgW, p.bldgH) * 0.5 + fitH(p); return { R: r, dist: r * 3.66 }; };
      const f0 = frameFor(p0);
      const R = f0.R, dist = f0.dist;
      const outLen = Math.sqrt(OUT[0] * OUT[0] + OUT[1] * OUT[1]);
      const camX = (OUT[0] / outLen) * dist, camZ = (OUT[1] / outLen) * dist;

      const sun = new THREE.DirectionalLight(0xFFF3E0, 2.6);
      sun.position.set(camX * 0.8, dist * 0.9, camZ * 0.8);
      sun.castShadow = true;
      sun.shadow.mapSize.width = sun.shadow.mapSize.height = 1024;
      const shR = Math.max(p0.bldgW, p0.bldgH) * 1.6 + 8;
      sun.shadow.camera.left = -shR; sun.shadow.camera.right = shR;
      sun.shadow.camera.top = shR; sun.shadow.camera.bottom = -shR;
      sun.shadow.camera.near = 0.5; sun.shadow.camera.far = dist * 4;
      sun.shadow.bias = -0.0005;
      sun.shadow.camera.updateProjectionMatrix();
      scene.add(sun);

      const camera = new THREE.PerspectiveCamera(34, 1, 0.1, dist * 10);
      camera.position.set(camX, dist * 0.5, camZ);

      // The sky dome stays. buildShed3DModel sizes the grass disc to "stay inside
      // the viewer's sky dome" — drop the dome and the customer sees a green disc
      // floating in flat grey.
      const skyTex = d3MakeSkyTexture(THREE);
      const sky = skyTex ? new THREE.Mesh(
        new THREE.SphereGeometry(dist * 6.5, 32, 16, 0, Math.PI * 2, 0, Math.PI / 2 + 0.14),
        new THREE.MeshBasicMaterial({ map: skyTex, side: THREE.BackSide, depthWrite: false })
      ) : null;
      if (sky) { sky.position.y = -0.5; scene.add(sky); }

      const controls = new OrbitControls(camera, canvas);
      controls.target.set(0, fitH(p0) * 0.45, 0);
      controls.maxPolarAngle = Math.PI * 0.495;   // never below the ground plane
      controls.minDistance = R * 1.1;
      controls.maxDistance = dist * 2.5;
      // No pan. The modal leaves it on because a full-screen canvas can afford a
      // lost building; a 380px panel with no reset control cannot.
      controls.enablePan = false;
      controls.update();

      const render = () => renderer.render(scene, camera);
      let renderQueued = false;
      const scheduleRender = () => {
        if (renderQueued) return;
        renderQueued = true;
        requestAnimationFrame(() => { renderQueued = false; if (engineRef.current) render(); });
      };
      controls.addEventListener("change", scheduleRender);

      const resize = () => {
        const el = wrapRef.current;
        if (!el) return;
        const w = el.clientWidth, h = el.clientHeight;
        if (!w || !h) return;                     // collapsed/hidden: nothing to size to
        renderer.setSize(w, h, false);
        camera.aspect = Math.max(1, w) / Math.max(1, h);
        camera.updateProjectionMatrix();
        render();
      };
      const ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver(resize) : null;
      if (ro && wrapRef.current) ro.observe(wrapRef.current);
      if (!ro) window.addEventListener("resize", resize);

      // A builder's fixture photo that lands after the scene was built is already
      // swapped into its materials by the cache — all that is left is asking for a
      // frame. Direct render, not rAF: a backgrounded tab never fires rAF and the
      // customer must not return to blank doors. Unlike the modal this NEVER
      // touches snapshot state; the panel does not own a snapshot.
      const offFxTex = d3OnFixtureTexSettle(() => {
        const e2 = engineRef.current;
        if (e2) e2.render();
      });

      // ── Scoped, rAF-coalesced rebuilds ──
      let pending = null;
      const flush = () => {
        const sc = pending; pending = null;
        const e = engineRef.current;
        if (!e || !sc) return;
        const p = pRef.current;
        const nf = getFrontWall(p.items) || p.frontWall;
        if (sc.full || nf !== e.model.builtFrontWall) {
          scene.remove(e.model.root);
          disposeShed3DModel(e.model);
          e.model = d3TimedBuild(() => buildShed3DModel(THREE, buildArgs(p, nf)));
          scene.add(e.model.root);
        } else {
          d3TimedBuild(() => {
            if (sc.walls && sc.walls.length) e.model.rebuildWalls(sc.walls, p.items);
            if (sc.interior) e.model.rebuildInterior(p.items);
          });
        }
        renderer.shadowMap.needsUpdate = true;    // geometry moved: the cached depth map is stale
        render();
      };
      const queue = (scope) => {
        const full = !scope || scope.full === true;
        if (pending) {
          if (full) pending.full = true;
          else {
            (scope.walls || []).forEach((w) => { if (pending.walls.indexOf(w) === -1) pending.walls.push(w); });
            if (scope.interior) pending.interior = true;
          }
          return;
        }
        pending = { full, walls: full ? [] : (scope.walls || []).slice(), interior: !full && Boolean(scope.interior) };
        requestAnimationFrame(flush);
      };

      let builtItems = p0.items;
      engineRef.current = {
        renderer, scene, camera, controls, model, sky, sun, render, resize, ro, offFxTex,
        applyItems: (next) => {
          const scope = d3ScopeForItemsChange(builtItems, next, pRef.current.itemTypes);
          builtItems = next;
          if (scope) queue(scope);
        },
        applyFull: () => { builtItems = pRef.current.items; queue({ full: true }); },
        // Re-frame WITHOUT rebuilding and WITHOUT remounting. Only reachable when the
        // caller passes fitHeightFt, so the designer's dock keeps its documented "never
        // re-aim the camera under someone who has just orbited" behaviour -- nothing there
        // changes the building's height without also changing bldgW/bldgH, which remounts.
        // The camera is NOT moved by hand: re-pointing controls.target re-aims in place and
        // controls.update() clamps the orbit radius into the new [min,max] itself, so a
        // building that grew pushes the camera out and one that shrank does not jump. The
        // orbit ANGLE survives; only the look-at height and the distance clamps move.
        // No render() here -- the applyFull() that always accompanies this queues one.
        applyFraming: () => {
          const p = pRef.current;
          const f = frameFor(p);
          controls.target.set(0, fitH(p) * 0.45, 0);
          controls.minDistance = f.R * 1.1;
          controls.maxDistance = f.dist * 2.5;
          // Grow-only: the sky dome was sized dist*6.5 from the MOUNT-time distance and is
          // never rebuilt here, so pulling far back in after a big height is dialled down
          // again could clip the dome and leave a green disc in flat grey.
          camera.far = Math.max(camera.far, f.dist * 10);
          camera.updateProjectionMatrix();
          controls.update();
        },
      };
      canvas.addEventListener("webglcontextlost", (ev) => { ev.preventDefault(); setPhase("error"); });
      // preventDefault above is what asks the browser to restore the context. Without a
      // matching restore listener it comes back and the panel stays stuck behind a dead
      // error overlay for the rest of the session.
      canvas.addEventListener("webglcontextrestored", () => {
        setPhase("ready");
        renderer.shadowMap.needsUpdate = true;
        render();   // direct, not rAF — a backgrounded tab never fires rAF
      });
      if (typeof window !== "undefined" && window.__SS3D_DEBUG) window.__ss3dPanel = engineRef.current;
      resize();
      setPhase("ready");
    }).catch((err) => {
      console.error("3D panel failed to load:", err);
      if (!disposed) setPhase("error");
    });
    return () => {
      disposed = true;
      const e = engineRef.current;
      if (!e) return;
      engineRef.current = null;
      window.removeEventListener("resize", e.resize);
      if (e.ro) e.ro.disconnect();
      if (e.offFxTex) e.offFxTex();
      e.controls.dispose();
      disposeShed3DModel(e.model);
      if (e.sky) { e.sky.geometry.dispose(); if (e.sky.material.map) e.sky.material.map.dispose(); e.sky.material.dispose(); }
      if (e.sun && e.sun.shadow && e.sun.shadow.map) e.sun.shadow.map.dispose();
      e.renderer.dispose();
      // The modal omits this. This surface toggles open and shut far more often,
      // and browsers cap live WebGL contexts hard — dropping it deterministically
      // is the difference between "the 3D stopped working after a while" and not.
      if (e.renderer.forceContextLoss) e.renderer.forceContextLoss();
    };
  // Mount once per building size — the parent's `key` handles the rest. The shadow and
  // orbit constants bake from bldgW/bldgH, so a size change genuinely needs a fresh scene.
  // Be honest about one more thing that bakes at mount: the opening camera angle and the
  // sun position derive from the FRONT wall. If the front re-homes later (dragging the only
  // door to another wall) the geometry follows on the next rebuild but the camera keeps its
  // current angle. That is deliberate — re-aiming the camera under someone who has just
  // orbited to the view they wanted is worse than a slightly stale opening angle, and
  // orbiting is this panel's whole affordance.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Live follow: the plan moves, the 3D moves. `suspended` is in the dep array on
  // purpose — releasing a drag flips it false and re-runs this effect, which is
  // what flushes the edit even though onPtrUp never touches `items` itself.
  useEffect(() => {
    const e = engineRef.current;
    if (e && !suspended) e.applyItems(items);
  }, [items, suspended]);

  // Style, cladding, roof, paint, zoom: rebuild in place, no remount, so a
  // free-text roof colour cannot churn a WebGL context per keystroke.
  useEffect(() => {
    const e = engineRef.current;
    if (!e) return;
    // Framing first: applyFull queues the rAF that actually paints, so this costs no
    // frame. Guarded on fitHeightFt so a caller that never passes one is untouched.
    if (fitHeightFt) e.applyFraming();
    e.applyFull();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [geomSig]);

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", background: "#FFF", border: "1px solid #E2E8F0", borderRadius: 12, boxShadow: "0 4px 24px rgba(0,0,0,0.08)", overflow: "hidden" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 10px 8px 12px", borderBottom: "1px solid #E2E8F0", background: "#F8FAFC", flexShrink: 0 }}>
        <span style={{ fontSize: 12, fontWeight: 700, color: "#334155" }}>3D view</span>
        <span style={{ fontSize: 11, color: "#94A3B8" }}>{bldgW}×{bldgH} ft · drag to rotate · scroll to zoom</span>
        <button onClick={onClose} title="Hide the 3D view" aria-label="Hide the 3D view"
          style={{ marginLeft: "auto", background: "transparent", border: "none", color: "#64748B", fontSize: 16, lineHeight: 1, cursor: "pointer", padding: "2px 4px" }}>✕</button>
      </div>
      <div ref={wrapRef} style={{ flex: 1, position: "relative", minHeight: 0, background: "#E7EEF5" }}>
        <canvas ref={canvasRef} style={{ width: "100%", height: "100%", display: "block", touchAction: "none" }} />
        {phase !== "ready" && (
          <div style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center", color: "#64748B", fontSize: 12, textAlign: "center", padding: 16, pointerEvents: "none" }}>
            {phase === "error" ? "The 3D view couldn't load. Close and open it again." : "Building the 3D view…"}
          </div>
        )}
      </div>
      {canEdit && (
        <div style={{ padding: 8, borderTop: "1px solid #E2E8F0", background: "#F8FAFC", flexShrink: 0 }}>
          {/* S lives inside the main component, out of reach from module scope, so
              the panel spells its one button out. Values copied verbatim from S.btn
              so the dock button and the toolbar button stay visually identical. */}
          <button onClick={onEdit} style={{ background: "#7C3AED", color: "#FFF", border: "none", borderRadius: 6, padding: "7px 12px", fontSize: 12, fontWeight: 700, cursor: "pointer", width: "100%" }}>⛶ Edit in 3D</button>
        </div>
      )}
    </div>
  );
}

// ─── MAIN COMPONENT ───
// Custom color dropdown: a native <select> can't render a color swatch per option, so this
// shows a color chip + name in the closed button and in each list row (matching the palette).
function ColorSelect({ value, colors, onPick }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  useEffect(() => {
    if (!open) return;
    const h = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    document.addEventListener("mousedown", h);
    document.addEventListener("touchstart", h);
    return () => { document.removeEventListener("mousedown", h); document.removeEventListener("touchstart", h); };
  }, [open]);
  const sel = colors.find((c) => c.label === value);
  const chip = (hex) => <span style={{ width: 14, height: 14, borderRadius: 3, background: hex || "transparent", border: "1px solid rgba(0,0,0,0.25)", flexShrink: 0, display: "inline-block" }} />;
  return (
    <div ref={ref} style={{ position: "relative", flex: 1, minWidth: 0 }}>
      <button type="button" onClick={() => setOpen((o) => !o)}
        style={{ width: "100%", display: "flex", alignItems: "center", gap: 6, border: "1px solid #CBD5E1", borderRadius: 6, padding: "5px 8px", fontSize: 12, background: "#FFF", cursor: "pointer", color: sel ? "#334155" : "#94A3B8" }}>
        {sel && chip(sel.hex)}
        <span style={{ flex: 1, textAlign: "left", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{sel ? sel.label : "Select…"}</span>
        <span style={{ fontSize: 10, color: "#94A3B8" }}>▾</span>
      </button>
      {open && (
        <div style={{ position: "absolute", top: "calc(100% + 2px)", left: 0, right: 0, zIndex: 30, background: "#FFF", border: "1px solid #CBD5E1", borderRadius: 6, boxShadow: "0 6px 18px rgba(0,0,0,0.15)", maxHeight: 220, overflowY: "auto" }}>
          {colors.map((c) => (
            <div key={c.id || c.label} onClick={() => { onPick(c.label); setOpen(false); }}
              style={{ display: "flex", alignItems: "center", gap: 8, padding: "7px 10px", cursor: "pointer", fontSize: 12, background: c.label === value ? "#F1F5F9" : "#FFF", color: "#334155" }}>
              {chip(c.hex)}<span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{c.label}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// Lead-capture gate shown BEFORE the designer (the customer link is a lead-gen tool).
// Collects name + phone and fires a best-effort GHL lead capture (capture-lead edge fn) the
// moment they continue. Rendered by StructureStudioInner as a body-portaled overlay when
// !gatePassed && !isAdmin && !embedded — the designer renders BEHIND it, dimmed/blurred and
// marked inert (no pointer/keyboard/focus) until the gate is passed.
// NOTE: a phone-as-login "find my saved designs" flow was intentionally deferred — it needs
// SMS/OTP verification, else a low-entropy phone could expose a customer's saved address.
function LeadGate({ config, supabase, accent, onPass, onClose }) {
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [busy, setBusy] = useState(false);
  const digits = phone.replace(/\D/g, "");
  const valid = name.trim().length > 0 && digits.length === 10;
  const brand = (config && config.branding) || {};
  const acc = accent || "#3D3672";

  const start = () => {
    if (!valid || busy) return;
    setBusy(true);
    // Best-effort lead capture to the tenant's GHL — never block entry on it.
    try { supabase.functions.invoke("capture-lead", { body: { clientId: config.clientId, name: name.trim(), phone } }); } catch (_e) {}
    onPass({ name: name.trim(), phone });
  };
  const inp = { width: "100%", boxSizing: "border-box", border: "1px solid #CBD5E1", borderRadius: 8, padding: "10px 12px", fontSize: 14, margin: "4px 0 12px" };

  return (
    <div style={{ position: "fixed", inset: 0, zIndex: 9999, background: "rgba(15,23,42,0.42)", backdropFilter: "blur(2.5px)", WebkitBackdropFilter: "blur(2.5px)", display: "flex", alignItems: "center", justifyContent: "center", padding: 16 }}>
      <div style={{ position: "relative", background: "#FFF", borderRadius: 16, maxWidth: 420, width: "100%", padding: 24, boxShadow: "0 20px 60px rgba(0,0,0,0.3)", fontFamily: "'Segoe UI', system-ui, -apple-system, sans-serif" }}>
        {onClose && (
          <button type="button" onClick={onClose} aria-label="Close" title="Close"
            style={{ position: "absolute", top: 10, right: 12, background: "transparent", border: "none", fontSize: 20, color: "#94A3B8", cursor: "pointer", lineHeight: 1, padding: 4 }}>
            ×
          </button>
        )}
        {brand.logo
          ? <img src={brand.logo} alt={brand.companyName || "logo"} style={{ height: 40, objectFit: "contain", marginBottom: 12 }} />
          : <div style={{ fontWeight: 800, fontSize: 18, color: acc, marginBottom: 12 }}>{brand.companyName || "Design Studio"}</div>}
        <div style={{ fontSize: 20, fontWeight: 800, color: "#0F172A", marginBottom: 4 }}>Let's design your building</div>
        <div style={{ fontSize: 13, color: "#64748B", marginBottom: 18 }}>Enter your name and phone to get started.</div>
        <label style={{ fontSize: 12, fontWeight: 700, color: "#475569" }}>Name</label>
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Your name" style={inp} autoFocus />
        <label style={{ fontSize: 12, fontWeight: 700, color: "#475569" }}>Phone</label>
        <input type="tel" inputMode="tel" value={formatPhoneDisplay(phone)} onChange={(e) => setPhone(formatPhoneDisplay(e.target.value))}
          onKeyDown={(e) => e.key === "Enter" && start()} placeholder="(555) 555-5555" style={{ ...inp, margin: "4px 0 16px" }} />
        <button onClick={start} disabled={!valid || busy}
          style={{ width: "100%", background: valid && !busy ? acc : "#94A3B8", color: "#FFF", border: "none", borderRadius: 10, padding: "12px", fontSize: 15, fontWeight: 700, cursor: valid && !busy ? "pointer" : "default" }}>
          {busy ? "Starting…" : "Start Designing →"}
        </button>
      </div>
    </div>
  );
}

// Ramp placement picker (custom mode). Like DoorPicker but no swing/operation: pick a ramp
// STYLE (exact name), then its size, then place it on the door the tool was dropped near.
function RampPicker({ ramps, showPricing, onCancel, onPlace }) {
  const styles = useMemo(() => {
    const m = new Map();
    ramps.forEach((d) => {
      const k = d.name || "Ramp";
      if (!m.has(k)) m.set(k, { name: k, imageUrl: d.imageUrl || null, sizes: [] });
      const g = m.get(k); g.sizes.push(d); if (!g.imageUrl && d.imageUrl) g.imageUrl = d.imageUrl;
    });
    return [...m.values()];
  }, [ramps]);
  const [style, setStyle] = useState(styles.length === 1 ? styles[0] : null);
  const [sel, setSel] = useState((styles.length === 1 && styles[0].sizes.length === 1) ? styles[0].sizes[0] : null);
  const pickStyle = (st) => { setStyle(st); setSel(st.sizes.length === 1 ? st.sizes[0] : null); };
  const money = (n) => "$" + Number(n).toLocaleString();
  const chip = (key, on, label, onClick) => (
    <div key={key} onClick={onClick} style={{ padding: "6px 14px", borderRadius: 20, fontSize: 13, fontWeight: 600, cursor: "pointer",
      border: `2px solid ${on ? FIXTURE_RAMP_COLOR : "#E2E8F0"}`, background: on ? "#E0F2FE" : "#FFF", color: on ? "#075985" : "#334155" }}>{label}</div>
  );
  return (
    <div onClick={onCancel} style={{ position: "fixed", inset: 0, background: "rgba(15,23,42,0.45)", zIndex: 9000, display: "flex", alignItems: "center", justifyContent: "center", padding: 16 }}>
      <div onClick={(e) => e.stopPropagation()} style={{ background: "#FFF", borderRadius: 14, width: "min(560px, 96vw)", maxHeight: "88vh", overflow: "auto", padding: 20, boxShadow: "0 20px 60px rgba(0,0,0,0.3)", fontFamily: "system-ui, -apple-system, sans-serif" }}>
        <div style={{ fontSize: 17, fontWeight: 800, color: "#1E293B", marginBottom: 4 }}>Choose a ramp</div>
        <div style={{ fontSize: 13, color: "#64748B", marginBottom: 14 }}>{style && style.sizes.length > 1 ? "Pick a size." : "Pick a ramp for this door."}</div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(150px, 1fr))", gap: 10, marginBottom: 16 }}>
          {styles.map((st) => {
            const on = style && style.name === st.name;
            const one = st.sizes.length === 1 ? st.sizes[0] : null;
            const sub = one ? `${fmtFtIn(one.widthIn)} × ${fmtFtIn(one.heightIn)}${showPricing && one.price != null ? ` · ${money(one.price)}` : ""}` : `${st.sizes.length} sizes`;
            return (
              <div key={st.name} onClick={() => pickStyle(st)} style={{ border: `2px solid ${on ? FIXTURE_RAMP_COLOR : "#E2E8F0"}`, borderRadius: 10, overflow: "hidden", cursor: "pointer", background: "#FFF" }}>
                {st.imageUrl ? <img src={st.imageUrl} alt="" style={{ width: "100%", height: 90, objectFit: "cover", display: "block" }} />
                  : <div style={{ height: 90, background: "#F1F5F9", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 24 }}>⬛</div>}
                <div style={{ padding: "8px 10px" }}>
                  <div style={{ fontSize: 13, fontWeight: 700, color: "#1E293B" }}>{st.name}</div>
                  <div style={{ fontSize: 11.5, color: "#64748B" }}>{sub}</div>
                </div>
              </div>
            );
          })}
        </div>
        {style && style.sizes.length > 1 && (
          <div style={{ marginBottom: 14 }}>
            <div style={{ fontSize: 12, fontWeight: 700, color: "#334155", marginBottom: 6 }}>Size</div>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>{style.sizes.map((d) => chip(d.id, sel && sel.id === d.id, `${fmtFtIn(d.widthIn)} × ${fmtFtIn(d.heightIn)}${showPricing && d.price != null ? ` · ${money(d.price)}` : ""}`, () => setSel(d)))}</div>
          </div>
        )}
        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 4 }}>
          <button onClick={onCancel} style={{ padding: "9px 16px", borderRadius: 8, border: "1px solid #CBD5E1", background: "#FFF", color: "#334155", fontWeight: 600, cursor: "pointer" }}>Cancel</button>
          <button onClick={() => sel && onPlace(sel)} disabled={!sel} style={{ padding: "9px 18px", borderRadius: 8, border: "none", background: sel ? FIXTURE_RAMP_COLOR : "#CBD5E1", color: "#FFF", fontWeight: 700, cursor: sel ? "pointer" : "default" }}>Place ramp</button>
        </div>
      </div>
    </div>
  );
}

// Window placement picker. Like RampPicker (style → size, no swing/operation), but the placed
// item goes on a wall. "Choose a window" / "Place window".
function WindowPicker({ windows, showPricing, windowColors, onCancel, onPlace }) {
  const styles = useMemo(() => {
    const m = new Map();
    windows.forEach((d) => {
      const k = d.name || "Window";
      if (!m.has(k)) m.set(k, { name: k, imageUrl: d.imageUrl || null, sizes: [] });
      const g = m.get(k); g.sizes.push(d); if (!g.imageUrl && d.imageUrl) g.imageUrl = d.imageUrl;
    });
    return [...m.values()];
  }, [windows]);
  const [style, setStyle] = useState(styles.length === 1 ? styles[0] : null);
  const [sel, setSel] = useState((styles.length === 1 && styles[0].sizes.length === 1) ? styles[0].sizes[0] : null);
  // The chosen window color (full object). The offered list is PER WINDOW — each catalog
  // row carries which of the client's colors it comes in (windowColorsFor) — so the
  // options and the default reset with the selected size, like a door's swing. A
  // single-color (or empty) list shows no Color block at all.
  const [color, setColor] = useState(null);
  const colorOpts = sel ? windowColorsFor(sel, windowColors) : [];
  useEffect(() => {
    setColor(sel ? fixtureWindowColorDefault(windowColorsFor(sel, windowColors)) : null);
  }, [sel]);
  const pickStyle = (st) => { setStyle(st); setSel(st.sizes.length === 1 ? st.sizes[0] : null); };
  const money = (n) => "$" + Number(n).toLocaleString();
  const chip = (key, on, label, onClick) => (
    <div key={key} onClick={onClick} style={{ padding: "6px 14px", borderRadius: 20, fontSize: 13, fontWeight: 600, cursor: "pointer",
      border: `2px solid ${on ? FIXTURE_WINDOW_COLOR : "#E2E8F0"}`, background: on ? "#E0F2FE" : "#FFF", color: on ? "#075985" : "#334155" }}>{label}</div>
  );
  const colorChip = (c, on, onClick) => (
    <div key={c.id} onClick={onClick} style={{ display: "flex", alignItems: "center", gap: 6, padding: "6px 12px", borderRadius: 20, fontSize: 13, fontWeight: 600, cursor: "pointer",
      border: `2px solid ${on ? FIXTURE_WINDOW_COLOR : "#E2E8F0"}`, background: on ? "#E0F2FE" : "#FFF", color: on ? "#075985" : "#334155" }}>
      <span style={{ width: 14, height: 14, borderRadius: "50%", background: c.hex || "#CCC", border: "1px solid rgba(0,0,0,0.2)", flexShrink: 0 }} />
      {c.label}{showPricing && Number(c.rate) > 0 ? ` · +${money(c.rate)}` : ""}
    </div>
  );
  return (
    <div onClick={onCancel} style={{ position: "fixed", inset: 0, background: "rgba(15,23,42,0.45)", zIndex: 9000, display: "flex", alignItems: "center", justifyContent: "center", padding: 16 }}>
      <div onClick={(e) => e.stopPropagation()} style={{ background: "#FFF", borderRadius: 14, width: "min(560px, 96vw)", maxHeight: "88vh", overflow: "auto", padding: 20, boxShadow: "0 20px 60px rgba(0,0,0,0.3)", fontFamily: "system-ui, -apple-system, sans-serif" }}>
        <div style={{ fontSize: 17, fontWeight: 800, color: "#1E293B", marginBottom: 4 }}>Choose a window</div>
        <div style={{ fontSize: 13, color: "#64748B", marginBottom: 14 }}>{style && style.sizes.length > 1 ? "Pick a size." : "Pick a window for this wall."}</div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(150px, 1fr))", gap: 10, marginBottom: 16 }}>
          {styles.map((st) => {
            const on = style && style.name === st.name;
            const one = st.sizes.length === 1 ? st.sizes[0] : null;
            const sub = one ? `${fmtFtIn(one.widthIn)} × ${fmtFtIn(one.heightIn)}${showPricing && one.price != null ? ` · ${money(one.price)}` : ""}` : `${st.sizes.length} sizes`;
            return (
              <div key={st.name} onClick={() => pickStyle(st)} style={{ border: `2px solid ${on ? FIXTURE_WINDOW_COLOR : "#E2E8F0"}`, borderRadius: 10, overflow: "hidden", cursor: "pointer", background: "#FFF" }}>
                {st.imageUrl ? <img src={st.imageUrl} alt="" style={{ width: "100%", height: 90, objectFit: "cover", display: "block" }} />
                  : <div style={{ height: 90, background: "#F1F5F9", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 24 }}>🪟</div>}
                <div style={{ padding: "8px 10px" }}>
                  <div style={{ fontSize: 13, fontWeight: 700, color: "#1E293B" }}>{st.name}</div>
                  <div style={{ fontSize: 11.5, color: "#64748B" }}>{sub}</div>
                </div>
              </div>
            );
          })}
        </div>
        {style && style.sizes.length > 1 && (
          <div style={{ marginBottom: 14 }}>
            <div style={{ fontSize: 12, fontWeight: 700, color: "#334155", marginBottom: 6 }}>Size</div>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>{style.sizes.map((d) => chip(d.id, sel && sel.id === d.id, `${fmtFtIn(d.widthIn)} × ${fmtFtIn(d.heightIn)}${showPricing && d.price != null ? ` · ${money(d.price)}` : ""}`, () => setSel(d)))}</div>
          </div>
        )}
        {sel && colorOpts.length > 1 && (
          <div style={{ marginBottom: 14 }}>
            <div style={{ fontSize: 12, fontWeight: 700, color: "#334155", marginBottom: 6 }}>Color</div>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>{colorOpts.map((c) => colorChip(c, color && color.id === c.id, () => setColor(c)))}</div>
          </div>
        )}
        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 4 }}>
          <button onClick={onCancel} style={{ padding: "9px 16px", borderRadius: 8, border: "1px solid #CBD5E1", background: "#FFF", color: "#334155", fontWeight: 600, cursor: "pointer" }}>Cancel</button>
          <button onClick={() => sel && onPlace(sel, color)} disabled={!sel} style={{ padding: "9px 18px", borderRadius: 8, border: "none", background: sel ? FIXTURE_WINDOW_COLOR : "#CBD5E1", color: "#FFF", fontWeight: 700, cursor: sel ? "pointer" : "default" }}>Place window</button>
        </div>
      </div>
    </div>
  );
}

// ── Walk-around video → the frames a vision model can read the SHAPE from ──────────
// A builder films one slow lap of a real building and we draft that style's d3 spec from
// it. The video NEVER leaves the device: it is decoded by a <video> element, sampled onto
// a <canvas>, and only the handful of JPEGs below are ever uploaded. That is not just a
// privacy nicety — a 190MB phone video cannot go through an edge function, and the
// existing photo path already accepts exactly this kind of JPEG.
//
// The hard part is WHICH frames. Sampling at equal time intervals looks obvious and is
// wrong: people pause at the corners (where two faces and the roof rake are visible at
// once — the most shape-informative viewpoint there is) and hurry along the flat sides, so
// equal-time sampling spends its budget wherever the operator dawdled and can miss a whole
// elevation. Sampling at equal CUMULATIVE VISUAL CHANGE self-corrects: standing still
// accumulates nothing and costs nothing.
//
// The probe pass that measures change also gets sharpness for free — it has already
// decoded those frames — so each chosen viewpoint can be nudged to whichever of its
// neighbours is least motion-blurred without spending another seek.
const SS_VID_FRAMES = 8;          // four elevations + four corners, whatever the pacing
const SS_VID_PROBE_MAX = 36;      // seeks are ~50-100ms; this bounds the probe at ~3s
const SS_VID_LONG_EDGE = 1280;    // ~1200 image tokens per frame, ~200KB of JPEG
const SS_VID_QUALITY = 0.8;

// 'seeked' can fire before the new frame is actually painted into the element, so a
// drawImage on that tick can copy the PREVIOUS one. requestVideoFrameCallback is the API
// built for exactly this — but like requestAnimationFrame it is driven by the compositor,
// and NEITHER fires in a backgrounded tab. That is not hypothetical: an early cut of this
// used a double-rAF barrier and a 20-second clip took 124 SECONDS to sample with the tab
// in the background, versus under two in the foreground. (Same class of trap as the 3D
// photo-arrival repaint, which is a direct render() for this reason.)
//
// So the barrier races the callback against a timer and takes whichever lands first, and
// it is only asked for on the eight CAPTURE seeks. The probe pass skips it: a probe frame
// one behind shifts the change curve imperceptibly, and paying a throttled timer on all
// thirty-odd of them is what made the background case pathological.
function ssSettleFrame(v) {
  return new Promise((resolve) => {
    let done = false;
    const finish = () => { if (!done) { done = true; resolve(); } };
    if (typeof v.requestVideoFrameCallback === "function") {
      try { v.requestVideoFrameCallback(finish); } catch (_) { /* fall through to the timer */ }
    }
    setTimeout(finish, 40);
  });
}

function ssSeekTo(v, t, settle) {
  return new Promise((resolve, reject) => {
    let done = false;
    const timer = setTimeout(() => { if (!done) { done = true; cleanup(); reject(new Error("The video stalled while seeking.")); } }, 8000);
    const onSeeked = () => {
      if (done) return;
      done = true; cleanup();
      if (settle) ssSettleFrame(v).then(resolve);
      else resolve();
    };
    const onErr = () => { if (!done) { done = true; cleanup(); reject(new Error("The video could not be decoded.")); } };
    function cleanup() {
      clearTimeout(timer);
      v.removeEventListener("seeked", onSeeked);
      v.removeEventListener("error", onErr);
    }
    v.addEventListener("seeked", onSeeked);
    v.addEventListener("error", onErr);
    try { v.currentTime = Math.max(0, t); } catch (e) { done = true; cleanup(); reject(e); }
  });
}

// Mean absolute difference between two luma signatures, 0..255. Cheap, and insensitive to
// the exposure drift a phone does continuously while walking.
function ssLumaDelta(a, b) {
  if (!a || !b || a.length !== b.length) return 0;
  let s = 0;
  for (let i = 0; i < a.length; i++) s += Math.abs(a[i] - b[i]);
  return s / a.length;
}

// Sum of horizontal neighbour differences: a blurred frame has fewer hard edges, so a
// lower score. Only ever compared against its own neighbours, so the absolute value and
// the tiny probe resolution do not matter.
function ssLumaSharpness(luma, w, h) {
  let s = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 1; x < w; x++) s += Math.abs(luma[y * w + x] - luma[y * w + x - 1]);
  }
  return s / (w * h);
}

async function ssExtractOrbitFrames(file, onStep) {
  const url = URL.createObjectURL(file);
  const v = document.createElement("video");
  v.muted = true;
  v.playsInline = true;
  v.preload = "auto";
  v.crossOrigin = "anonymous";
  v.src = url;
  const done = () => { try { v.removeAttribute("src"); v.load(); } catch (_) {} URL.revokeObjectURL(url); };
  try {
    if (onStep) onStep("Opening the video…");
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("That video took too long to open. Try a shorter clip.")), 20000);
      v.addEventListener("loadedmetadata", () => { clearTimeout(timer); resolve(); }, { once: true });
      v.addEventListener("error", () => { clearTimeout(timer); reject(new Error("Your browser could not read that video file.")); }, { once: true });
    });
    // A zero width after metadata means the container parsed but the codec did not — the
    // usual culprit is an iPhone .mov in HEVC opened on a browser without the licence.
    if (!v.videoWidth || !v.videoHeight) {
      throw new Error("Your browser cannot decode that video. On an iPhone, set Camera → Formats → Most Compatible and film it again.");
    }
    const dur = Number(v.duration);
    if (!isFinite(dur) || dur < 4) throw new Error("That clip is too short — walk one slow lap, about 30 to 60 seconds.");
    if (dur > 300) throw new Error("That video is over 5 minutes. One slow lap of the building is all we need.");

    // ── probe: low-res luma at ~1.2 samples/second, capped ─────────────────────────
    const N = Math.max(12, Math.min(SS_VID_PROBE_MAX, Math.round(dur * 1.2)));
    const pw = 32, ph = 18;
    const pc = document.createElement("canvas");
    pc.width = pw; pc.height = ph;
    const pctx = pc.getContext("2d", { willReadFrequently: true });
    const probes = [];
    let prev = null;
    for (let i = 0; i < N; i++) {
      if (onStep && i % 6 === 0) onStep(`Looking through the video… ${Math.round((i / N) * 100)}%`);
      const t = dur * ((i + 0.5) / N);
      await ssSeekTo(v, t, false);
      pctx.drawImage(v, 0, 0, pw, ph);
      const d = pctx.getImageData(0, 0, pw, ph).data;
      const luma = new Float32Array(pw * ph);
      for (let p = 0, q = 0; p < d.length; p += 4, q++) luma[q] = 0.299 * d[p] + 0.587 * d[p + 1] + 0.114 * d[p + 2];
      probes.push({ t, change: ssLumaDelta(prev, luma), sharp: ssLumaSharpness(luma, pw, ph) });
      prev = luma;
    }

    // ── choose viewpoints at equal cumulative change ──────────────────────────────
    const cum = [];
    let run = 0;
    for (const p of probes) { run += p.change; cum.push(run); }
    const total = run;
    let picks;
    if (total < 1e-3) {
      // Nothing moved: a tripod shot, or a probe that read the same frame every time.
      // Equal time is the only meaningful fallback, and it is what the caller expects.
      picks = Array.from({ length: SS_VID_FRAMES }, (_, k) => Math.min(probes.length - 1, Math.round(((k + 0.5) / SS_VID_FRAMES) * (probes.length - 1))));
    } else {
      picks = [];
      let at = 0;
      for (let k = 0; k < SS_VID_FRAMES; k++) {
        const want = ((k + 0.5) / SS_VID_FRAMES) * total;
        while (at < cum.length - 1 && cum[at] < want) at++;
        picks.push(at);
      }
    }
    // Nudge each pick to the sharpest of itself and its immediate neighbours. Free: those
    // frames were already decoded during the probe.
    picks = picks.map((i) => {
      let best = i;
      for (const j of [i - 1, i + 1]) {
        if (j >= 0 && j < probes.length && probes[j].sharp > probes[best].sharp) best = j;
      }
      return best;
    });
    // De-duplicate while keeping walk order — two targets can land on one probe when the
    // operator swung round a corner fast.
    const seen = new Set();
    picks = picks.filter((i) => (seen.has(i) ? false : (seen.add(i), true)));

    // ── capture at full resolution ────────────────────────────────────────────────
    const scale = Math.min(1, SS_VID_LONG_EDGE / Math.max(v.videoWidth, v.videoHeight));
    const cw = Math.max(2, Math.round(v.videoWidth * scale));
    const ch = Math.max(2, Math.round(v.videoHeight * scale));
    const cv = document.createElement("canvas");
    cv.width = cw; cv.height = ch;
    const cctx = cv.getContext("2d");
    const out = [];
    for (let k = 0; k < picks.length; k++) {
      if (onStep) onStep(`Capturing view ${k + 1} of ${picks.length}…`);
      await ssSeekTo(v, probes[picks[k]].t, true);
      cctx.drawImage(v, 0, 0, cw, ch);
      out.push({ t: probes[picks[k]].t, dataUrl: cv.toDataURL("image/jpeg", SS_VID_QUALITY) });
    }
    if (!out.length) throw new Error("No usable frames came out of that video.");
    return out;
  } finally {
    done();
  }
}

function StructureStudioInner({ config, embedded = false, onSaved = null, openDesign = null, setup3d = null, view3d = false, calibrationOnly = false }) {
  const C = config;
  // ── Which surface is this? THE discriminator between the two mounts of this module ──
  //   embedded = true  → the Designer tab inside portal.html: business users building
  //                      quotes for customers (discounts, delivery fees, full tooling).
  //   embedded = false → the PUBLIC customer-facing page (index.html / tenant subdomains /
  //                      the "try it" link on marketing sites): anonymous shed-shoppers.
  // New surface differences gate on one of these two flags — never on a new prop, never on
  // sniffing the URL. If a feature is for the business, use `embedded`; if it is lead- or
  // customer-flavoured (contact gates, silent lead capture), use `customerFacing`.
  const customerFacing = !embedded;
  // Is 3D on for this viewer? Two DIFFERENT authorities on purpose:
  //   embedded (the portal designer) -> the `view3d` prop, which the portal derives from
  //     featureOn("view_3d") -- i.e. entitlement, which also makes every operator true.
  //   public page -> `C.view3d` from get_config (migration 110), sourced from the operator
  //     grant table only. index.html is anonymous and can never call portal-billing, so it
  //     cannot use the entitlement path at all.
  // A tenant whose staff can see 3D in their portal does NOT automatically expose it to
  // shoppers: that needs a real grant row, which is the point of the split.
  const view3dOn = embedded ? !!view3d : !!C.view3d;
  const doorFixtures = useMemo(() => (Array.isArray(C.fixtures) ? C.fixtures : []).filter((f) => f && (f.category || "door") === "door"), [C.fixtures]);
  const rampFixtures = useMemo(() => (Array.isArray(C.fixtures) ? C.fixtures : []).filter((f) => f && (f.category || "") === "ramp"), [C.fixtures]);
  const windowFixtures = useMemo(() => (Array.isArray(C.fixtures) ? C.fixtures : []).filter((f) => f && (f.category || "") === "window"), [C.fixtures]);
  // Internal-only fixtures: the rep (embedded) designer can place them, but the customer-facing page
  // must NOT offer them as placement options. These "placeable" lists drive the PICKERS + picker
  // buttons only; the full memos above still feed isArchivedItem / swap / render so an already-placed
  // internal-only fixture keeps rendering for the customer and never reads as archived.
  const placeableDoors = customerFacing ? doorFixtures.filter((f) => !f.internalOnly) : doorFixtures;
  const placeableRamps = customerFacing ? rampFixtures.filter((f) => !f.internalOnly) : rampFixtures;
  const placeableWindows = customerFacing ? windowFixtures.filter((f) => !f.internalOnly) : windowFixtures;
  // Colors offered on fixtures: doors pick from the palette rows ticked for Doors
  // (get_config emits the flag + a show_pricing-gated doorRate); windows have their own
  // small per-client list (get_fixtures emits windowColors). Both feed the pickers and
  // the default stamps on included-chip / 3D placements.
  const doorPaintColors = useMemo(() => (Array.isArray(C.colors) ? C.colors : []).filter((c) => c && c.door), [C.colors]);
  const windowColorList = useMemo(() => (Array.isArray(C.windowColors) ? C.windowColors : []), [C.windowColors]);
  // Memoized, not inline at the mount: the docked 3D panel keeps props alive across
  // rebuilds, and handing it a fresh array identity on every keystroke is how a cheap
  // prop turns into a churning one.
  const bodyPaintPool = useMemo(() => d3PaintPool(C.colors, "body"), [C.colors]);
  const trimPaintPool = useMemo(() => d3PaintPool(C.colors, "trim"), [C.colors]);
  // Ramp is self-contained now (SIMPLE_RAMP_CFG), driven by the Ramp settings — NOT the built-in
  // `ramp` layout item. Custom mode → the ramp picker (catalog styles); simple mode + offered → the
  // simple ramp tool; otherwise render-only (old ramps still draw, but no new placement).
  const rampMode = ((C.rampSettings && C.rampSettings.mode) || "simple");
  const rampEnabled = !!(C.rampSettings && C.rampSettings.enabled);
  const rampCustom = rampMode === "custom" && placeableRamps.length > 0;
  const [sel, setSel] = useState(() => {
    const init = { style: "", size: "", roofType: "", roofColor: "", cladding: "" };
    C.options.forEach((o) => { init[o.id] = o.type === "counter" ? o.options[0] : ""; });
    return init;
  });
  // Catalog fixtures the current size INCLUDES → a placement tool keyed by the fixture id. Each
  // renders in the "included — place or decline" row and, when armed, drops that EXACT fixture on
  // the next wall click (doors/windows) or door (ramps). Empty until a style+size is chosen; the
  // built-in door/window/ramp keep their own catalog pickers.
  const includedFixtureTools = (() => {
    const out = {};
    if (!sel.style || !sel.size) return out;
    const st = (C.buildingStyles || []).find((s) => s.value === sel.style);
    if (!st) return out;
    const pickInc = (map) => { if (!map || typeof map !== "object") return null; if (map[sel.size] != null) return map[sel.size]; const want = normSizeLabel(sel.size); for (const k in map) { if (normSizeLabel(k) === want) return map[k]; } return null; };
    let qmap = pickInc(st.sizeInclusionQty);
    if (!qmap || typeof qmap !== "object" || Array.isArray(qmap)) { const arr = pickInc(st.sizeInclusions); qmap = {}; if (Array.isArray(arr)) arr.forEach((k) => { qmap[k] = 1; }); }
    const fixtures = Array.isArray(C.fixtures) ? C.fixtures : [];
    for (const k in qmap) {
      const fx = fixtures.find((f) => String(f.id) === k);
      if (!fx) continue;   // built-in keys (loft etc.) are handled by their own ITEMS entry
      if (customerFacing && fx.internalOnly) continue;   // internal-only: rep can place it, customer can't add/decline it
      const cat = fx.category || "door";
      out[k] = {
        label: fx.name || "Item",
        color: cat === "window" ? FIXTURE_WINDOW_COLOR : cat === "ramp" ? FIXTURE_RAMP_COLOR : FIXTURE_DOOR_COLOR,
        icon: cat === "window" ? "🪟" : cat === "ramp" ? "⬛" : "🚪",
        shortLabel: (fx.planLabel && String(fx.planLabel).trim()) || (fx.name || "ITEM").toUpperCase().slice(0, 4),
        wallOnly: cat !== "ramp", doorSnap: cat === "ramp",
        width: (Number(fx.widthIn) || 36) / 12, height: 0.5,
        includedFixture: { ...fx },   // placement marker: drop THIS specific fixture
      };
    }
    return out;
  })();
  const ITEMS = { ...LEGACY_LAYOUT_FALLBACK, ...C.layoutItems, ...BUILT_IN_TOOLS, fixtureDoor: FIXTURE_DOOR_CFG,
    ...(placeableDoors.length ? { doorPicker: DOOR_PICKER_CFG } : {}),
    ...(rampCustom ? { rampPicker: RAMP_PICKER_CFG } : {}),
    // Ramp is ALWAYS the self-contained SIMPLE_RAMP_CFG (overrides any built-in `ramp` layout item),
    // so every placed ramp renders. Placeable only when the tenant offers a SIMPLE ramp; custom mode
    // and not-offered are render-only (the picker handles custom placement).
    ramp: { ...SIMPLE_RAMP_CFG, noPalette: !(rampMode === "simple" && rampEnabled) },
    // Catalog windows add a "Window" picker tool; the built-in window stays as-is (like doors).
    ...(placeableWindows.length ? { windowPicker: WINDOW_PICKER_CFG } : {}),
    // Included catalog fixtures (place-or-decline chips), keyed by fixture id.
    ...includedFixtureTools };
  const [swapId, setSwapId] = useState(null);       // id of a placed catalog fixture being SWAPPED to another
  const [doorPick, setDoorPick] = useState(null);   // { wall, ptx, pty } while the door picker modal is open
  const [rampPick, setRampPick] = useState(null);   // { door } while the ramp picker modal is open
  const [windowPick, setWindowPick] = useState(null);   // { wall, ptx, pty } while the window picker modal is open
  // A PLACED item is "archived" (option retired) if: a catalog fixture whose fixture is no longer
  // in the active list (get_fixtures drops archived), or a built-in whose layoutItems cfg is flagged
  // archived (get_config keeps it, noPalette+archived). Archived items still render on the design;
  // the rep is nudged to Swap them for a current option. Never blocks rendering.
  const isArchivedItem = (it) => {
    if (!it) return false;
    if (it.fixtureItemId) {
      const pool = it.type === "window" ? windowFixtures : it.type === "ramp" ? rampFixtures : doorFixtures;
      return !pool.some((f) => String(f.id) === String(it.fixtureItemId));
    }
    const c = ITEMS[it.type];
    return !!(c && c.archived);
  };
  const accent = C.branding.accentColor || "#D97706";
  // White-label initials for the logo placeholder shown when no logo is set.
  const initials = (C.branding.companyName || "").split(" ").filter(Boolean).slice(0, 2).map((w) => w[0]).join("").toUpperCase() || "SS";
  // Admin gate: ?admin=1 surfaces the GHL credentials panel. The credentials never
  // round-trip through the browser — admin types them in, the Edge Function stores
  // them in Supabase, and customers' browsers never see them.
  // Never true when embedded: the URL is the HOST page's (the portal), and
  // /portal.html?admin=1 must not surface the operator panel inside a tenant portal.
  const isAdmin = useMemo(() => {
    if (embedded) return false;
    if (typeof window === "undefined") return false;
    return new URLSearchParams(window.location.search).get("admin") === "1";
  }, [embedded]);
  // The 3D calibration editor is reachable by an operator on the public page AND by the
  // builder in their own portal (the host opts in by passing setup3d, and only does so for
  // owner/admin roles). This must stay SEPARATE from isAdmin: isAdmin also unlocks the GHL
  // credentials panel, and the whole reason it is forced false when embedded is that
  // /portal.html?admin=1 must never surface that panel inside a tenant's portal.
  const showCal3D = isAdmin || Boolean(setup3d);

  // Options the user currently sees. Options without scoping are always in the
  // list; scoped options join/leave as the user picks/changes building style.
  const visibleOptions = useMemo(
    () => C.options.filter((o) => isOptionApplicable(o, sel.style)),
    [C.options, sel.style]
  );

  // Roof colors come from the same palette (shingle/metal flags). A roof type is only offered
  // when the tenant has >=1 active color in it; roof pricing is the chosen color's rate
  // (server-side), exactly like paint. Empty until the owner adds roof colors in the portal.
  const roofColorsFor = (type) => {
    const list = Array.isArray(C.colors) ? C.colors : [];
    return type === "Shingle" ? list.filter((c) => c.shingle) : type === "Metal" ? list.filter((c) => c.metal) : [];
  };
  const roofTypes = ["Shingle", "Metal"].filter((t) => roofColorsFor(t).length > 0);
  // Cladding is a fixed FOUR (we ship a texture for each; a tenant cannot invent a fifth),
  // narrowable per style. Empty string = "builder's standard", i.e. fall through to the
  // style's own d3.siding, which is what every existing design does today.
  //
  // Keyed off the CURRENTLY SELECTED style, so switching style re-reads the list. A
  // customer mid-design on a metal-capable style who switches to one that is not keeps
  // sel.cladding pointing at "agpanel" -- harmless, because the estimate resolves it
  // through D3_CLADDING and the 3D renderer draws whatever the id says; the dropdown
  // simply no longer offers it. Clearing it instead would silently undo a deliberate pick
  // the moment someone browsed a neighbouring style.
  //
  // Offered ONLY where 3D is on for this viewer. Cladding is visual-only in v1 -- the pick
  // manifests nowhere but the 3D view (plus a line of text on the estimate) -- so on a
  // tenant without the 3D grant it was a dropdown that visibly did nothing, shipped to
  // every public designer without opt-in (audit 2026-08-19). Gating it on view3dOn keeps
  // an ungranted tenant's page byte-identical to before cladding existed, and the control
  // appears together with 3D as each builder is switched on.
  const claddingChoices = view3dOn
    ? d3CladdingChoicesFor(C.buildingStyles.find((s) => s.value === sel.style))
    : [];
  // The paint option renders inline beside the Roof Options (same row), not in
  // the option list below — see the Size/Roof/Paint row and renderPaintFields.
  const paintOpt = visibleOptions.find((o) => o.type === "counter" && o.id === "paint") || null;

  // When the building style changes, snap any now-inapplicable option back to
  // its default so a stale "Painted" (etc.) selection can't be silently sent
  // along in the submit payload.
  useEffect(() => {
    setSel((prev) => {
      let changed = false;
      const next = { ...prev };
      C.options.forEach((opt) => {
        if (isOptionApplicable(opt, prev.style)) return;
        const def = opt.type === "counter" ? opt.options[0] : "";
        if (next[opt.id] !== def) { next[opt.id] = def; changed = true; }
      });
      return changed ? next : prev;
    });
  }, [sel.style, C.options]);

  // Phase 4a: which placeable items are INCLUDED (free) with the selected
  // style+size — from get_config's per-style sizeInclusions map. Everything else
  // is an "additional" (chargeable) option. Empty until a style+size is chosen.
  // includedItemQty maps item key -> included quantity (loft = sq ft, doors = count)
  // from the parallel sizeInclusionQty map; configs predating migration 039 fall
  // back to quantity 1 per included key.
  const includedItemQty = useMemo(() => {
    if (!sel.style || !sel.size) return {};
    const st = C.buildingStyles.find((s) => s.value === sel.style);
    if (!st) return {};
    // Size labels can drift between "12x16" and "12×16" (CSV rewrite vs. saved design),
    // so fall back to a normalized-label match like the sizePricing lookup does.
    const pick = (map) => {
      if (!map || typeof map !== "object") return null;
      if (map[sel.size] != null) return map[sel.size];
      const want = normSizeLabel(sel.size);
      for (const k in map) { if (normSizeLabel(k) === want) return map[k]; }
      return null;
    };
    const qmap = pick(st.sizeInclusionQty);
    if (qmap && typeof qmap === "object" && !Array.isArray(qmap)) {
      const out = {};
      for (const k in qmap) out[k] = Math.max(1, Number(qmap[k]) || 1);
      return out;
    }
    const arr = pick(st.sizeInclusions);
    const out = {};
    if (Array.isArray(arr)) for (const k of arr) out[k] = 1;
    return out;
  }, [sel.style, sel.size, C.buildingStyles]);
  const includedItemKeys = useMemo(() => Object.keys(includedItemQty), [includedItemQty]);

  const [contact, setContact] = useState({ name: "", phone: "", email: "", street: "", city: "", state: "", zip: "" });
  // Lead-capture gate: shoppers give name + phone before designing (the customer link is a
  // lead-gen tool). Bypassed for a returning shopper arriving via a saved-design link (?id=,
  // which loads their contact), the operator preview (?admin=1), and once remembered in this
  // browser. See <LeadGate/> rendered at the top of the return.
  const [gatePassed, setGatePassed] = useState(() => {
    try {
      const params = new URLSearchParams(location.search);
      if (params.get("id") || params.get("admin") === "1") return true;
      if (localStorage.getItem("ss_gate_" + (C.clientId || ""))) return true;
    } catch (_e) {}
    return false;
  });
  // Default each side to the tenant's default palette color (e.g. "Unpainted"); a saved
  // design overrides this from design.paint_colors on load.
  const [paintColors, setPaintColors] = useState(() => {
    const list = Array.isArray(C.colors) ? C.colors : [];
    const dflt = (k) => { const d = list.find((c) => (k === "body" ? c.siding : c.trim) && c.isDefault); return d ? d.label : ""; };
    return { body: dflt("body"), trim: dflt("trim") };
  });
  // Tracks when the shopper picked an "allow custom" color and is typing an exact value
  // (so the custom text box stays open even while paintColors.body/trim is momentarily "").
  const [paintCustom, setPaintCustom] = useState({ body: false, trim: false });
  // Roof: type (Shingle/Metal) + color live in `sel` (saved with the design); this tracks the
  // transient "typing a custom roof color" state, same as paintCustom.
  const [roofCustom, setRoofCustom] = useState(false);
  const [customOptions, setCustomOptions] = useState([]);
  const [roDimensions, setRoDimensions] = useState({});
  const [bldgW, setShedW] = useState(10);
  const [bldgH, setShedH] = useState(12);
  const [activeTool, setActiveTool] = useState(null);
  const [items, setItems] = useState([]);
  const [selectedId, setSelectedId] = useState(null);
  const [editingNoteId, setEditingNoteId] = useState(null); // note being typed in-place on the canvas
  // Pick-one-to-remove mode ({ type }): entered from a Details row's × when several
  // "each"-priced items of that type are placed — the plan highlights them and the
  // rest of the page is blocked until the user clicks one (or cancels).
  const [pendingRemoval, setPendingRemoval] = useState(null);
  // "+ Add Delivery Fee" clicked — shows the delivery row before a value is typed.
  const [deliveryOpen, setDeliveryOpen] = useState(false);
  useEffect(() => {
    // Reopened designs restore sel.deliveryFee without deliveryOpen; latch the row
    // open so clearing the amount mid-edit doesn't unmount the input underneath the
    // user (only the row's × closes it).
    if (!deliveryOpen && String(sel.deliveryFee || "") !== "") setDeliveryOpen(true);
  }, [deliveryOpen, sel.deliveryFee]);
  useEffect(() => {
    if (!pendingRemoval) return;
    // ESC cancels. Every other key is swallowed in the capture phase: the scrim only
    // blocks POINTERS, so without this Tab+Enter could still fire buttons underneath
    // it (another row's ×, even Get Quote) while the page looks blocked.
    const onKey = (e) => {
      if (e.key === "Escape") { setPendingRemoval(null); return; }
      e.preventDefault(); e.stopPropagation();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [pendingRemoval]);
  useEffect(() => {
    // Auto-exit pick mode if the last item of the target row disappears. priceRowMatcher,
    // not a type compare: pendingRemoval.type is a Details ROW key, and catalog rows carry
    // fx:/win:/ramp: keys that match no item's type — the type compare exited pick mode
    // instantly for those rows (audit 2026-08-20).
    if (pendingRemoval && !items.some(priceRowMatcher(pendingRemoval.type))) setPendingRemoval(null);
  }, [items, pendingRemoval]);
  const [dragging, setDragging] = useState(null);
  const [resizing, setResizing] = useState(null);
  const [showExport, setShowExport] = useState(false);
  const [exportUrl, setExportUrl] = useState(null);
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [submitError, setSubmitError] = useState(null);
  // After a successful save, holds { code, viewUrl, imageUrl } for the success screen
  const [savedDesign, setSavedDesign] = useState(null);
  // Current design's short code (set when a design is loaded or saved). Drives the
  // "all designs on this estimate" version list shown in the editor + success screen.
  const [designCode, setDesignCode] = useState(null);
  // All versions of the current design (this estimate), newest first.
  const [estimateVersions, setEstimateVersions] = useState([]);
  // Which version is currently loaded in the editor (null = the latest). Marks "Viewing".
  const [viewingVersion, setViewingVersion] = useState(null);
  // Whether the "all designs on this estimate" dropdown is expanded (collapsed by default).
  const [versionsOpen, setVersionsOpen] = useState(false);
  // "Additional options" (custom line items) is collapsed by default behind a subtle toggle.
  const [additionalOpen, setAdditionalOpen] = useState(false);
  // Every enabled contact field filled, phone a real 10 digits — the same bar submitQuote
  // enforces. Drives the public Details gate: a shopper sees quote details only after
  // giving full contact info (which is what makes them a capturable lead).
  const contactComplete = useMemo(() => {
    const req = ["name", "email", "phone", "street", "city", "state", "zip"].filter((f) => C.contactFields.includes(f));
    if (req.some((f) => !String(contact[f] || "").trim())) return false;
    if (C.contactFields.includes("phone") && String(contact.phone || "").replace(/\D/g, "").length !== 10) return false;
    return true;
  }, [contact, C.contactFields]);
  // The public Details section is locked until the contact form is complete. Content is
  // ALSO gated on this (not just the click), so emptying a field after opening re-locks
  // the details instead of leaving prices on screen behind a stale open state.
  const detailsLocked = customerFacing && !contactComplete;
  // Silent lead save, once per page load, the first time a shopper opens Details: they
  // have just typed full contact info and asked to see prices — that IS a lead, even if
  // they never press submit. Best-effort fire-and-forget (capture-lead validates and
  // upserts into the tenant's GHL); it must never block or break the designer.
  const leadCapturedRef = useRef(false);
  const captureLeadSilently = () => {
    if (!customerFacing || leadCapturedRef.current || !contactComplete) return;
    leadCapturedRef.current = true;
    try {
      supabase.functions.invoke("capture-lead", { body: {
        clientId: C.clientId,
        source: "details",     // vs the gate's default — "asked for prices" ranks higher
        name: String(contact.name || "").trim(),
        phone: String(contact.phone || "").trim(),
        email: String(contact.email || "").trim(),
        street: String(contact.street || "").trim(),
        city: String(contact.city || "").trim(),
        state: String(contact.state || "").trim(),
        zip: String(contact.zip || "").trim(),
      } });
    } catch (_e) { /* lead capture must never break the designer */ }
  };
  // Draft-design capture (migration 063). The same Details-open moment that captures the
  // lead also saves WHAT they designed, as a status='draft' designs row — so the portal
  // can open a browsing lead's actual floor plan even though they never pressed submit.
  // A later real submit reuses the same short_code (currentDesignIdRef) and save_design
  // promotes the row to 'sent'. Silent and best-effort like the lead capture: no PDF is
  // rendered, no URL is rewritten, nothing changes for the visitor.
  const draftStateRef = useRef(null);  // JSON of the last draft-saved payload (skip no-op re-saves)
  const isDraftRef = useRef(false);    // the row behind currentDesignIdRef is a draft, safe to re-save
  const saveDraftSilently = () => {
    if (!customerFacing || !supabase) return;
    // Never write over a row we didn't create as a draft: someone re-opening a SUBMITTED
    // design from a share link must not have it silently rewritten by browsing further.
    if (currentDesignIdRef.current && !isDraftRef.current) return;
    if (!sel.style && !sel.size && items.length === 0) return; // nothing designed yet
    const body = {
      p_contact: contact,
      p_selections: sel,
      p_paint_colors: paintColors,
      p_items: items,
      p_custom_options: customOptions,
      p_ro_dimensions: roDimensions,
      p_bldg_w: bldgW,
      p_bldg_h: bldgH,
    };
    const snapshot = JSON.stringify(body);
    if (snapshot === draftStateRef.current) return; // unchanged since the last draft save
    const code = currentDesignIdRef.current || genShortCode();
    (async () => {
      try {
        const { error } = await supabase.rpc("save_design", {
          p_code: code,
          p_client_id: C.clientId,
          ...body,
          p_image_url: null,   // drafts carry no PDF; save_design preserves any existing one
          p_status: "draft",   // the ONLY status the RPC accepts from an anon caller
        });
        if (error) return;     // best-effort: a failed draft save is invisible by design
        currentDesignIdRef.current = code;
        isDraftRef.current = true;
        draftStateRef.current = snapshot;
      } catch (_e) { /* draft save must never break the designer */ }
    })();
  };
  // ─── Inventory (migration 075) — embedded-only ───
  // inventoryUnitRef: the unit a "Send estimate" flow came from; the submit success path
  // links the new design back to it. inventoryMaster: non-null while an inventory MASTER
  // design (status='inventory') is open — submit is blocked (a master must never become a
  // customer estimate) and the save button flips to "Update Inventory Building".
  const inventoryUnitRef = useRef(null);
  // The inventory unit an ALREADY-SAVED design was quoted from (designs.inventory_unit_id,
  // read at load). Distinct from inventoryUnitRef, which arms a not-yet-submitted
  // send-estimate flow — this one survives reopening the estimate later.
  const [designUnit, setDesignUnit] = useState(null);   // { id, serial, lifecycle } | null
  // Staff chose "Design a new build instead" on a locked estimate: the plan unlocks and
  // the next submit saves a NEW version that is no longer tied to the unit.
  const [newBuildMode, setNewBuildMode] = useState(false);
  const [inventoryMaster, setInventoryMaster] = useState(null); // { code, unitId, priceCents, locationId } | null
  const [invDialog, setInvDialog] = useState(null); // { busy, err, price, done } | null — price/confirm only (location is inline now)
  // The inventory Save bar (inline location dropdown + button) appears ONLY for a NEW inventory
  // build ("+ New inventory building" → openDesign.blank) or an OPENED inventory master — never on
  // an ordinary customer design. Location is chosen inline, beside the Save button.
  const [inventoryNew, setInventoryNew] = useState(false);
  const [invLocations, setInvLocations] = useState([]);   // [{id, name, city}]
  const [invLocationId, setInvLocationId] = useState(""); // where this building sits
  const invLocLoadedRef = useRef(false);
  // PLAN LOCK (Carolyn, 2026-08-02): "Building is BUILT". An estimate for an inventory
  // building describes a structure that already physically exists, so its floor plan,
  // size, style, roof and colours are not negotiable — only the money lines are (custom
  // options, discount, delivery). Applies to the send-estimate flow AND to reopening that
  // estimate later, on the public share link too. NEVER applies to the inventory MASTER
  // itself (that is the builder editing their own building via "Update Inventory
  // Building"), and staff can lift it deliberately with "Design a new build instead".
  //
  // …but only once the building actually EXISTS (migration 102). A unit can now be sold
  // while it is still Requested or in the build queue, and locking those would mean the buyer
  // of a building that has not been cut yet cannot change anything about it — the opposite of
  // what a pre-build sale is for. So the lock keys on the ladder, not on the mere existence
  // of a link. UNKNOWN FAILS TOWARD LOCKED: that is today's behaviour, so this can only ever
  // loosen where we are sure. (Seven rungs since migration 105 — `accepted` retired; the
  // built rank is 3 — see _shared/inventoryLifecycle.ts, which owns the ladder.)
  const INV_BUILT_RANK = 3;
  const INV_RANKS = { requested: 0, in_queue: 1, scheduled_build: 2, built: 3,
    scheduled_delivery: 4, at_location: 5, delivered: 6 };
  const unitIsBuilt = !designUnit || !designUnit.lifecycle
    || (INV_RANKS[designUnit.lifecycle] ?? INV_BUILT_RANK) >= INV_BUILT_RANK;
  const planLocked = Boolean(
    (inventoryUnitRef.current || designUnit) && !inventoryMaster && !newBuildMode && unitIsBuilt
  );
  // The canvas handlers are useCallbacks with their own dep arrays — reading the lock
  // through a ref keeps them from capturing a stale value (and from re-creating on every
  // lock change). Assigned during render on purpose: a useEffect sync would lag one
  // render, and one render is long enough to drag an item on a building that is built.
  const planLockedRef = useRef(false);
  planLockedRef.current = planLocked;
  // The pre-tax building total, mirroring the Details subtotal WITHOUT the customer-
  // specific lines (delivery, discounts) — an asking price describes the building alone.
  const inventoryQuotePrefill = () => {
    try {
      const selRows = computeSelectionRows(sel, paintColors, C, items);
      const priceRows = C.showPricing ? computeLayoutPricingRows(items, sel, customOptions, C, paintColors).rows : [];
      const roList = items.filter((i) => i.type === "roughOpening");
      const lp = C.layoutPricing && C.layoutPricing.roughOpening;
      const ov = (lp && lp.byStyle && sel.style) ? lp.byStyle[sel.style] : null;
      const roRate = lp ? (Number(ov && ov.rate != null ? ov.rate : lp.rate) || 0) : 0;
      const customTotal = (customOptions || []).reduce((s, r) => {
        const amt = Math.max(0, parseFloat(r && r.amount) || 0);
        const q = r && r.qty ? Math.abs(parseInt(r.qty, 10)) || 1 : 1;
        return s + amt * q;
      }, 0);
      return Math.max(0,
        selRows.reduce((s, r) => s + (Number(r.total) || 0), 0)
        + priceRows.reduce((s, r) => s + (Number(r.total) || 0), 0)
        + (C.showPricing ? roList.length * roRate : 0)
        + customTotal);
    } catch (_e) { return 0; }
  };
  // Load the tenant's locations once we enter an inventory context (new build or opened master),
  // so the inline location dropdown by the Save button is ready. targetClientId names the tenant
  // explicitly — the component's supabase client lacks portal.html's operator view-as injection.
  useEffect(() => {
    if (!embedded || !supabase || invLocLoadedRef.current) return;
    if (!(inventoryNew || inventoryMaster)) return;
    invLocLoadedRef.current = true;
    (async () => {
      try {
        const { data } = await supabase.functions.invoke("portal-settings",
          { body: { action: "list_locations", targetClientId: C.clientId } });
        if (data && Array.isArray(data.locations)) setInvLocations(data.locations);
      } catch (_e) { /* locations are optional */ }
    })();
  }, [embedded, supabase, inventoryNew, inventoryMaster, C.clientId]);

  const openInventoryDialog = () => {
    if (!sel.style || !sel.size) { setSubmitError("Pick a Building Style and Size before saving to inventory."); return; }
    setSubmitError(null);
    const isUpdate = Boolean(inventoryMaster && inventoryMaster.unitId);
    const prefill = isUpdate && inventoryMaster.priceCents != null
      ? inventoryMaster.priceCents / 100
      : inventoryQuotePrefill();
    // Location is chosen on the inline dropdown beside the Save button; this dialog only confirms price.
    setInvDialog({ busy: false, err: null, price: prefill > 0 ? String(Math.round(prefill * 100) / 100) : "", done: null });
  };
  const saveInventory = async () => {
    if (!invDialog || invDialog.busy) return;
    setInvDialog((d) => ({ ...d, busy: true, err: null }));
    try {
      const isUpdate = Boolean(inventoryMaster && inventoryMaster.unitId);
      const code = isUpdate ? inventoryMaster.code : genShortCode();
      // Render + upload the plan PDF — the same steps submitQuote runs, deliberately
      // duplicated rather than extracted: refactoring the money path for a reuse win
      // is a bad trade. Best-effort: an upload failure must not lose the unit.
      let imageUrl = null;
      try {
        const canvas = renderExportCanvas();
        const jpegDataUrl = canvas.toDataURL("image/jpeg", 0.92);
        const jpegBin = atob(jpegDataUrl.split(",")[1]);
        const jpegBytes = new Uint8Array(jpegBin.length);
        for (let i = 0; i < jpegBin.length; i++) jpegBytes[i] = jpegBin.charCodeAt(i);
        // Multi-page builder (beta-2.0 replaced the single-page one): the 3D snapshot,
        // when the builder took one, rides along as page 2 — same as submitQuote.
        const invPages = [{ bytes: jpegBytes, w: canvas.width, h: canvas.height }];
        const invShot3d = render3DSnapshotRef.current;
        if (invShot3d) invPages.push({ bytes: dataUrlToBytes(invShot3d.url), w: invShot3d.w, h: invShot3d.h });
        const blob = buildPdfFromJpegPages(invPages);
        const filePath = `${C.clientId}/${code}-${Date.now()}.pdf`;
        const up = await supabase.storage.from("floor-plans")
          .upload(filePath, blob, { upsert: false, contentType: "application/pdf", cacheControl: "0" });
        if (!up.error) imageUrl = supabase.storage.from("floor-plans").getPublicUrl(filePath).data.publicUrl;
      } catch (_e) { /* PDF is nice-to-have here; the unit row matters more */ }
      // A typo must never become $0 on the lot. `Number("12,5o0")` is NaN, and the old
      // `|| 0` turned that into a building publicly listed at $0.
      const priceStr = String(invDialog.price ?? "").replace(/[$,\s]/g, "");
      let askingPriceCents = null;
      if (priceStr !== "") {
        const n = Number(priceStr);
        if (!Number.isFinite(n) || n < 0) {
          setInvDialog((d) => d && { ...d, busy: false, err: "Enter the asking price as a number, e.g. 8950 — or leave it blank." });
          return;
        }
        askingPriceCents = Math.round(n * 100);
      }
      const { data, error } = await supabase.functions.invoke("portal-settings", { body: {
        action: "save_inventory", targetClientId: C.clientId,
        ...(isUpdate ? { unitId: inventoryMaster.unitId } : { shortCode: code }),
        imageUrl, askingPriceCents, locationId: invLocationId || null,
        selections: sel, paintColors, items, customOptions, roDimensions, bldgW, bldgH,
      } });
      if (error) {
        let m = "Save failed — try again.";
        try { const b = await error.context.clone().json(); if (b && b.error) m = b.error; } catch (_e) { /* keep generic */ }
        throw new Error(m);
      }
      if (!data || data.error) throw new Error((data && data.error) || "Save failed — try again.");
      setInvDialog((d) => ({ ...d, busy: false, done: { serial: data.serial ?? null, updated: isUpdate } }));
      if (!isUpdate) {
        // The design on screen IS now this unit's master — further saves are updates.
        currentDesignIdRef.current = code;
        setDesignCode(code);
        setInventoryMaster({ code, unitId: data.unitId, priceCents: askingPriceCents, locationId: invLocationId || null });
      } else {
        setInventoryMaster((m) => m && { ...m, priceCents: askingPriceCents, locationId: invLocationId || null });
      }
      if (onSaved) onSaved();
    } catch (e) {
      setInvDialog((d) => ({ ...d, busy: false, err: e.message || String(e) }));
    }
  };
  // Details NEVER auto-opens. If the form drops back to incomplete (a cleared field, the
  // address search resetting values), the section CLOSES — so re-completing the form can
  // never resurface it without a fresh click. Without this, an earlier open survived the
  // re-lock and the rows reappeared "by themselves" the moment the last field was filled.
  useEffect(() => {
    if (detailsLocked && additionalOpen) setAdditionalOpen(false);
  }, [detailsLocked]);
  // The lead save keys off VISIBILITY, not the click handler: whatever path reveals the
  // details, the contact is saved. The ref in captureLeadSilently keeps it once per load,
  // and its customerFacing guard keeps the portal designer out entirely. The draft save
  // rides the same moment: who they are (lead) and what they designed (draft) together.
  useEffect(() => {
    if (additionalOpen && !detailsLocked) { captureLeadSilently(); saveDraftSilently(); }
  }, [additionalOpen, detailsLocked]);
  const [toast, setToast] = useState(null);
  // ─── 3D view state ───
  const [show3D, setShow3D] = useState(false);
  // ── Docked view-only 3D (Carolyn 2026-08-19) ──
  // Mutually exclusive with show3D for free: the panel renders INSIDE the
  // {!(show3D || adminCalPreview)} guard below, so two live WebGL contexts are
  // structurally impossible rather than merely avoided.
  const [dock3D, setDock3D] = useState(false);
  // The CALIBRATION dock's own visibility (Settings -> Designer -> 3D). Defaults ON: Carolyn
  // asked for the preview to just be there beside the settings, not behind a button. The ✕ on
  // the panel header hides it and the toggle in the panel's button row brings it back.
  // Separate state from dock3D, not a shared one: DesignerTab and DesignerSettings each mount
  // their OWN <SS/> instance, so these two docks never see each other's state anyway.
  const [calDock3D, setCalDock3D] = useState(true);
  // Boolean only. Storing the measured width would setState on every frame of a
  // window drag, on top of the SVG re-render that already costs.
  const [dockCapable, setDockCapable] = useState(false);
  const canvasRowObsRef = useRef(null);
  // Which threshold this mount measures against. `calibrationOnly` is a prop that is fixed for
  // a mount's lifetime, so the callback identity below never actually changes at runtime and
  // no observer churn happens -- the dep is there because the closure reads it.
  const dockMinW = calibrationOnly ? SS_DOCK_MIN_CAL_W : SS_DOCK_MIN_ROW_W;
  // Callback ref, NOT useEffect([]) — the observed row unmounts whenever the
  // full-screen 3D opens, and an effect-attached observer would keep watching a
  // detached node, freezing dockCapable after the first trip through the editor.
  const canvasRowRef = useCallback((node) => {
    if (canvasRowObsRef.current) { canvasRowObsRef.current.disconnect(); canvasRowObsRef.current = null; }
    if (!node || typeof ResizeObserver === "undefined") return;
    // Coarse pointer is a touch-trap guard, not a width proxy: an iPad in landscape
    // is wide enough to dock, but the canvas sets touchAction:"none" for orbit, so a
    // finger on the panel could never scroll the designer host — the only scroller.
    const coarse = typeof window.matchMedia === "function" && window.matchMedia("(pointer: coarse)").matches;
    const measure = () => {
      const w = node.clientWidth || 0;
      // Zero means the row is not being rendered right now — the portal keeps the Designer
      // mounted but hidden while the builder is on another tab. It does NOT mean "too
      // narrow", and treating it that way collapsed the dock on every tab switch.
      if (!w) return;
      // 40px of hysteresis on the way down, so an appearing scrollbar cannot
      // oscillate the rule at the threshold.
      setDockCapable((prev) => !coarse && (prev ? w >= dockMinW - 40 : w >= dockMinW));
    };
    // Measure SYNCHRONOUSLY here, and let the observer handle changes after.
    // ResizeObserver delivery rides the rendering steps, so its first callback is
    // not guaranteed to land before the customer clicks the 3D button — and in a
    // backgrounded tab it never lands at all. Waiting for it would silently open
    // the full-screen modal on a wide screen that should have docked.
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(node);
    canvasRowObsRef.current = ro;
  }, [dockMinW]);
  useEffect(() => () => { if (canvasRowObsRef.current) canvasRowObsRef.current.disconnect(); }, []);
  // Narrowing collapses the dock. Deliberately does NOT open the full-screen modal
  // instead: a modal appearing because someone dragged a window edge is hostile,
  // and the button is right there.
  // PORTAL ONLY for now (Carolyn, 2026-08-20). index.html and portal.html load the SAME
  // compiled bundle, so without the `embedded` term the dock would also appear on the
  // anonymous public designer for any tenant holding a view_3d grant. `embedded` is true
  // only when the portal's Designer tab is hosting us. Shipping it to the public page
  // later is exactly this one term.
  const dockOn = dockCapable && embedded;
  useEffect(() => { if (!dockOn && dock3D) setDock3D(false); }, [dockOn, dock3D]);
  // Losing the grant mid-session must close the dock, not leave it rendering. The portal
  // refetches entitlements on every session-token refresh, so view3dOn genuinely can flip
  // true -> false with the designer still mounted — an operator revoking view_3d, or a
  // grant simply reaching its expiry. The render site is gated on view3dOn as well; this
  // clears the state sitting behind that gate so nothing stale survives a re-grant.
  useEffect(() => { if (!view3dOn && dock3D) setDock3D(false); }, [view3dOn, dock3D]);
  // Latest captured 3D snapshot ({ url, w, h } — a JPEG data-URL) — becomes
  // page 2 of the quote PDF on submit/download. Kept in a ref (it's large and
  // never rendered); has3DSnapshot mirrors it for button labels.
  const render3DSnapshotRef = useRef(null);
  const [has3DSnapshot, setHas3DSnapshot] = useState(false);
  const svgRef = useRef(null);
  // After a drag or resize gesture ends, the trailing click on the SVG
  // would otherwise re-run the hit test and deselect the item if the cursor
  // ended outside its bounds. This ref signals "ignore the click that follows".
  const justGesturedRef = useRef(false);
  // Gesture-movement tracking: a press only counts as a drag/resize (and thus
  // swallows its trailing click) if the pointer actually moved past a jitter
  // threshold. A stationary click must SURVIVE so clicking a selected note can
  // enter in-place edit — an unconditional swallow made notes uneditable.
  const movedRef = useRef(false);
  const gestureStartRef = useRef(null); // {x,y} in client px at pointer-down

  // PostMessage listener
  useEffect(() => {
    const handler = (e) => {
      if (!ssAllowedOrigin(e.origin)) return;
      if (e.data && e.data.type === "structureConfig") {
        const d = e.data;
        setSel((p) => { const n = { ...p }; Object.keys(d).forEach((k) => { if (k !== "type" && k in n) n[k] = d[k]; }); return n; });
        if (d.name || d.phone || d.email) {
          setContact((p) => ({ ...p, name: d.name || p.name, phone: d.phone || p.phone, email: d.email || p.email, street: d.street || p.street, city: d.city || p.city, state: d.state || p.state, zip: d.zip || p.zip }));
          if (d.name && d.phone) setGatePassed(true);   // host pre-satisfied the lead gate
        }
      }
    };
    window.addEventListener("message", handler);
    return () => window.removeEventListener("message", handler);
  }, []);

  // ─── Supabase client (browser-safe anon key, baked-in — config rows can't
  // redirect the data connection) ───
  const supabase = useMemo(() => createClient(SUPABASE_URL, SUPABASE_ANON_KEY), []);

  // Tracks the design currently being edited (set on load via ?id=, then on save)
  const currentDesignIdRef = useRef(null);
  // GHL identifiers for the design currently being edited. When set (loaded from
  // the saved row or returned by the Edge Function), the next submit becomes a
  // PUT/update of the existing GHL estimate instead of a POST/create.
  const ghlContactIdRef = useRef(null);
  const ghlEstimateIdRef = useRef(null);
  const ghlEstimateNumberRef = useRef(null);
  // Mirrors ghlEstimateIdRef in state so the submit button can re-render its label
  // ("Get Quote" vs "Resubmit for Updated Estimate") when a design loads.
  const [hasExistingEstimate, setHasExistingEstimate] = useState(false);

  // Admin panel state — only used when isAdmin
  const [adminPwd, setAdminPwd] = useState("");
  const [adminLocId, setAdminLocId] = useState("");
  const [adminApiKey, setAdminApiKey] = useState("");
  const [adminBusy, setAdminBusy] = useState(false);
  const [adminStatus, setAdminStatus] = useState(null); // {configured, ghlLocationIdMasked, updatedAt} | null
  const [adminMsg, setAdminMsg] = useState(null);       // {ok, msg} | null
  // 3D style calibration (operator): tune a style's d3 spec against its
  // four-side reference photos, preview live, save to the config row.
  const [adminCal, setAdminCal] = useState(null);        // { styleValue, spec, photos: [url×4] } | null
  const [adminCalMsg, setAdminCalMsg] = useState(null);  // {ok, msg} | null
  // Which calibration input has focus, so the elevation can highlight the dimension that
  // input drives. This IS the answer to "I couldn't figure out which numbers to change".
  const [calFocus, setCalFocus] = useState(null);
  const [adminCalBusy, setAdminCalBusy] = useState(false);
  const [adminCalPreview, setAdminCalPreview] = useState(false);
  // Walk-around video → shape. `urls` caches the uploaded frames so a re-draft re-spends
  // the one metered AI call and not eight uploads; `observed` is what the video showed
  // about doors, windows and vents, which the spec has no field for.
  const [adminCalVideo, setAdminCalVideo] = useState({ busy: false, step: null, err: null, count: 0, urls: null, observed: null, read: 0 });
  // Building scan (094): { busy, step, err, measured, file, status } for the selected style.
  const [scan, setScan] = useState({ busy: false, step: null, err: null, measured: null, file: null, status: "none", aiReady: null });
  // Prevents the size-change effect from clearing items when we're rehydrating
  // a saved design (sel.size and items get set together).
  const prevSizeRef = useRef("");
  // Outcomes of a size-change reflow. `reflowNote` is advisory (items moved wall or were
  // shortened); `sizeBlock` is the refusal — { from, to, items } — shown when something
  // could not be placed at all, with the size already reverted.
  const [reflowNote, setReflowNote] = useState(null);
  const [sizeBlock, setSizeBlock] = useState(null);

  // Google Places "search for address" widget that auto-fills the four address
  // fields below it. Uses google.maps.places.PlaceAutocompleteElement (Places API
  // New) — the replacement for the deprecated Autocomplete class. The element
  // brings its own input + dropdown; we mount it into a container <div> and
  // listen for gmp-select. On selection we resolve the chosen place's address
  // components and populate street / city / state / zip. When the key is empty,
  // this is a no-op and the container renders empty (the row hides itself).
  const attachStreetAutocomplete = useCallback((container) => {
    const mapsKey = C.googleMapsApiKey || DEFAULT_GOOGLE_MAPS_API_KEY;
    if (!container || !mapsKey) return;
    loadGoogleMapsPlaces(mapsKey).then(async (google) => {
      if (!container.isConnected) return;
      const { PlaceAutocompleteElement } = await google.maps.importLibrary("places");
      const pa = new PlaceAutocompleteElement({ includedRegionCodes: ["us"] });
      // Google's gmp-place-autocomplete now uses a CLOSED shadow root, so its
      // inner input can't be styled from here (pa.shadowRoot is null). The HOST
      // element is stylable from outside, though: give it the same light-gray
      // border/radius as S.sel and pin its height to the sibling address fields
      // so the search box lines up with them instead of Google's tall default.
      pa.style.width = "100%";
      pa.style.display = "block";
      pa.style.boxSizing = "border-box";
      pa.style.border = "1px solid #CBD5E1";
      pa.style.borderRadius = "6px";
      // Font properties inherit across the closed shadow boundary (Google's inner
      // input uses font: inherit), so set them on the host to match S.sel.
      pa.style.fontFamily = "Arial, sans-serif";
      pa.style.fontSize = "13px";
      pa.style.fontWeight = "600";
      pa.style.color = "#000";
      // Force a light theme so the search box matches the white sibling address
      // fields — the gmp element otherwise defaults to a dark background, which
      // looked like the brand color "bleeding" into the search box. color-scheme
      // crosses the closed shadow boundary; backgroundColor covers the host.
      pa.style.colorScheme = "light";
      pa.style.backgroundColor = "#FFF";
      container.replaceChildren(pa);

      let sizeTries = 0;
      const sizeToFields = () => {
        const ref = document.querySelector('input[autocomplete="street-address"], input[autocomplete="postal-code"], input[autocomplete="address-level2"]');
        const h = ref ? Math.round(ref.getBoundingClientRect().height) : 0;
        if (h) { pa.style.height = h + "px"; return; }
        if (sizeTries++ < 20) requestAnimationFrame(sizeToFields);
        else pa.style.height = "28px";
      };
      requestAnimationFrame(sizeToFields);

      pa.addEventListener("gmp-select", async (ev) => {
        const place = ev.placePrediction.toPlace();
        await place.fetchFields({ fields: ["addressComponents"] });
        const comps = place.addressComponents || [];
        const find = (type) => {
          const c = comps.find((x) => (x.types || []).includes(type));
          return c ? (c.longText || c.shortText || "") : "";
        };
        const street = [find("street_number"), find("route")].filter(Boolean).join(" ");
        const city = find("locality") || find("sublocality") || find("postal_town");
        const state = find("administrative_area_level_1"); // full state name to match <select> options
        const zip = (find("postal_code") || "").replace(/\D/g, "").slice(0, 5);
        setContact((p) => ({
          ...p,
          ...(street ? { street } : {}),
          ...(city ? { city } : {}),
          ...(state ? { state } : {}),
          ...(zip ? { zip } : {}),
        }));
      });
    }).catch((err) => {
      console.warn("[StructureStudio] Google Maps autocomplete unavailable:", err.message);
    });
  }, [C.googleMapsApiKey]);

  // Auto-update building size, REFLOWING the layout instead of destroying it.
  //
  // This used to `setItems([])` on any size change — the customer lost their whole plan
  // with no warning. Worse, it missed a case: changing the STYLE blanks the size, which
  // recorded a blank into prevSizeRef, so the next size pick saw a falsy previous value
  // and skipped the wipe. The items survived carrying page-pixels computed from the OLD
  // scale/mgX/mgY, which left doors floating off their walls — and, because they then
  // failed their own wallOnly rule, unable to be dragged back. That is the bug Carolyn
  // reported. Comparing parsed DIMENSIONS rather than label strings closes it — PROVIDED
  // the skip branch leaves the ref alone: it used to record sel.size (the blank) into the
  // ref, so the follow-up size pick saw prev=null, skipped the reflow, and re-stranded
  // every item exactly as described above. The ref now only ever holds the last size that
  // actually took effect, so style-then-size reflows from the real old dimensions
  // (audit 2026-08-20).
  //
  // reflowItems is pure, so the result is inspected BEFORE committing: if anything cannot
  // be placed at all, the size change is reverted and the customer is told what to remove.
  useEffect(() => {
    const p = parseSize(sel.size);
    if (!p) return;   // blank/unparseable (a style click just blanked it): keep the last real size
    const prev = parseSize(prevSizeRef.current);
    if (prev && (prev.w !== p.w || prev.h !== p.h) && items.length) {
      const { items: nextItems, events } = reflowItems(items, prev, p, ITEMS);
      const blocked = events.filter((e) => e.kind === "blocked");
      if (blocked.length) {
        // Nothing has changed yet — put the size back and let them decide.
        setSizeBlock({ from: prevSizeRef.current, to: sel.size, items: blocked });
        setSel((s) => ({ ...s, size: prevSizeRef.current }));
        return;                       // prevSizeRef stays put; the revert re-runs this effect
      }
      setItems(nextItems);
      setSelectedId(null);
      const notable = events.filter((e) => e.kind === "movedWall" || e.kind === "resized");
      if (notable.length) setReflowNote(notable);
    }
    setShedW(p.w); setShedH(p.h);
    prevSizeRef.current = sel.size;
  }, [sel.size]);

  // Snap a loaded layout back onto legal positions. Designs saved before the size-change
  // reflow existed can carry items stranded off their walls by an old style-then-size
  // change — they render floating and, failing their own placement rule, cannot be dragged
  // back. Passing the SAME dimensions in and out makes the geometry conversion an identity,
  // so nothing moves that was already legal; the clamps and collision checks do the repair.
  // Silent by design: someone opening a link did not do anything to be told about.
  const repairLoaded = (loaded, sizeLabel) => {
    const d = parseSize(sizeLabel);
    if (!d || !loaded.length) return loaded;
    try { return reflowItems(loaded, d, d, ITEMS).items; } catch (_e) { return loaded; }
  };

  // ─── Load a saved design by short code ───
  // Shared by the public ?id= URL path and the portal's openDesign prop below — the two
  // must hydrate identically (GHL refs, draft flag, optional version snapshot, id counter).
  const loadDesignByCode = async (id, vParam, isCancelled = () => false) => {
    // Capability RPC: returns the one row matching the code (or nothing).
    // Direct table reads are blocked for the anon key after cutover.
    const { data: rows, error } = await supabase.rpc("load_design", { p_code: id });
    const data = Array.isArray(rows) ? rows[0] : rows;
    // Returns TRUE only when the design actually loaded. Callers act on the result:
    // the openDesign effect must not arm inventory state (unitId / asNew reset) against
    // whatever design is still on the canvas when the RPC failed or the row is gone —
    // that grafted unit B's id onto unit A's design and let an update overwrite B.
    if (isCancelled() || error || !data) return false;
    // The persistent portal designer can be sitting on the submit-success screen when an
    // Open request arrives — without this the OLD design's success screen would keep
    // covering the newly loaded one. No-op on the public ?id= path (fresh mount, false).
    setSubmitted(false);
    setSubmitError(null);
    currentDesignIdRef.current = data.short_code;
    setDesignCode(data.short_code);
    // A re-opened draft may keep draft-saving; any other status locks the row against
    // silent rewrites (saveDraftSilently refuses non-draft rows). Embedded mounts never
    // draft-save at all (customerFacing guard), so there this flag is inert.
    isDraftRef.current = data.status === "draft";
    // Inventory master (075)? Mark it: submit gets blocked and the inventory button
    // flips to update mode. unitId is enriched by the openDesign effect (the portal
    // sends it); a master reached any other way still blocks submit.
    setInventoryMaster(data.status === "inventory"
      ? { code: data.short_code, unitId: null, priceCents: null, locationId: null }
      : null);
    // Opening an existing design is never a NEW inventory build; a master's location is seeded
    // by the openDesign enrichment below.
    setInventoryNew(false);
    setInvLocationId("");
    // An estimate quoted FROM an inventory building carries the link on the row, so
    // reopening it later (portal or public share link) locks the plan again. The serial
    // is a nicety for the banner: readable to a signed-in tenant under inventory_units'
    // owner-select policy, absent for an anon visitor — never let it block the lock.
    setNewBuildMode(false);
    if (data.inventory_unit_id) {
      // lifecycle stays null here on purpose. It is DERIVED from build_jobs + delivery_stops
      // (see _shared/inventoryLifecycle.ts) — not a column this read could fetch, and
      // re-deriving it in the browser would be a third copy of a rule that must not drift.
      // Null means "unknown", which fails toward LOCKED — the behaviour this path has always
      // had, and staff still have "Design a new build instead" to lift it deliberately. The
      // Inventory tab, which does know, passes it through openDesign below.
      setDesignUnit({ id: data.inventory_unit_id, serial: null, lifecycle: null });
      supabase.from("inventory_units").select("serial").eq("id", data.inventory_unit_id).maybeSingle()
        .then(({ data: u }) => { if (u && !isCancelled()) setDesignUnit((p) => ({ ...(p || {}), id: data.inventory_unit_id, serial: u.serial })); },
              () => {});
    } else {
      setDesignUnit(null);
    }
    // Hydrate GHL refs so a re-submit becomes an update of the same estimate.
    ghlContactIdRef.current = data.ghl_contact_id || null;
    ghlEstimateIdRef.current = data.ghl_estimate_id || null;
    ghlEstimateNumberRef.current = data.ghl_estimate_number || null;
    setHasExistingEstimate(!!(data.ghl_estimate_id || data.ss_quote_number));

    // Optionally open a specific saved version for review/resubmit. The design DATA
    // comes from that version's snapshot; the GHL refs above stay from the current
    // row so a resubmit updates the same one estimate rather than creating a new one.
    let design = data;
    if (Number.isFinite(vParam) && vParam > 0) {
      const { data: vrows } = await supabase.rpc("load_design_version", { p_code: id, p_version: vParam });
      const vrow = Array.isArray(vrows) ? vrows[0] : vrows;
      if (!isCancelled() && vrow) design = vrow;
    }
    if (isCancelled()) return false;
    setViewingVersion(Number.isFinite(vParam) && vParam > 0 ? vParam : null);

    setContact(data.contact || { name: "", email: "", phone: "", street: "", city: "", state: "", zip: "" });
    // Pre-set prevSizeRef to what sel.size is ABOUT to become, so the size effect doesn't
    // treat this load as a user size-change and wipe the items set below (same guard
    // openVersion uses). "" (not the old size) because sel is REBUILT below, not merged.
    prevSizeRef.current = (design.selections || {}).size || "";
    // Rebuild sel from pristine defaults rather than merging over the persistent portal
    // designer's current selections: a design saved before an option existed (e.g. rows
    // from before roofType/roofColor shipped) must not inherit the previously opened
    // design's values for those keys. Mirrors the sel useState initializer.
    setSel(() => {
      const base = { style: "", size: "", roofType: "", roofColor: "", cladding: "" };
      C.options.forEach((o) => { base[o.id] = o.type === "counter" ? o.options[0] : ""; });
      return { ...base, ...(design.selections || {}) };
    });
    setPaintColors(design.paint_colors || { body: "", trim: "" });
    setPaintCustom({ body: false, trim: false });
    setCustomOptions(design.custom_options || []);
    setRoDimensions(design.ro_dimensions || {});
    // Items must be set after sel.size has propagated; the prevSizeRef guard
    // above keeps the size effect from wiping them.
    const loadedItems = repairLoaded(Array.isArray(design.items) ? design.items : [], (design.selections || {}).size);
    setItems(loadedItems);
    // The persistent portal mount can carry a selection/note-edit from the PREVIOUS
    // design; item ids are small integers that collide across designs, so a stale
    // selectedId would put the Delete/Rotate toolbar on an arbitrary item of this one.
    setSelectedId(null);
    setEditingNoteId(null);
    // Keep the global id counter ahead of any restored ids so the next placement can't
    // reuse an existing id (which collided in select/drag/delete/resize).
    idCounter = Math.max(idCounter, 0, ...loadedItems.map((i) => Number(i.id) || 0)) + 1;
    return true;
  };

  // ─── Load saved design from ?id=SS-XXXXXX on the URL ───
  useEffect(() => {
    if (!supabase) return;
    // Embedded mounts never read the HOST page's URL — /portal.html?id=SS-… must not
    // hydrate the in-portal designer with an arbitrary design code.
    if (embedded) return;
    const params = new URLSearchParams(window.location.search);
    const id = params.get("id");
    if (!id) return;
    let cancelled = false;
    loadDesignByCode(id, parseInt(params.get("v") || "", 10), () => cancelled);
    return () => { cancelled = true; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [supabase, embedded]);

  // ─── Open a design on demand (portal Designer tab) ───
  // The portal's Designs/Contacts "Open" buttons hand the persistent embedded designer an
  // { code, version } request instead of linking to the public page. Business users must
  // NEVER review a customer's design on the public page: it silently captures leads and
  // saves drafts (capture-lead / saveDraftSilently), so staff browsing there would corrupt
  // the very activity Contacts reports. Embedded-only; the public page keeps its ?id= path.
  // Each click sends a fresh object (identity change re-fires this even for the same code).
  useEffect(() => {
    if (!embedded || !supabase || !openDesign) return;
    // "+ New inventory building" sends { blank: true } with no code: clear the canvas so
    // a brand-new building never starts from the design that happened to be open. Without
    // this, clicking New while another unit's MASTER was loaded left the submit bar saying
    // "Update Inventory Building" — saving would have rewritten that other unit.
    if (openDesign.blank) {
      if (items.length > 0 || sel.style || sel.size) {
        if (!window.confirm("Start a new building? This clears what's currently in the Designer tab.")) return;
      }
      setItems([]);
      setSel((p) => { const n = { ...p }; Object.keys(n).forEach((k) => n[k] = ""); return n; });
      setContact({ name: "", phone: "", email: "", street: "", city: "", state: "", zip: "" });
      setPaintColors({ body: "", trim: "" });
      setCustomOptions([]);
      setRoDimensions({});
      setSelectedId(null);
      setEditingNoteId(null);
      currentDesignIdRef.current = null;
      isDraftRef.current = false;
      draftStateRef.current = null;
      ghlContactIdRef.current = null;
      ghlEstimateIdRef.current = null;
      ghlEstimateNumberRef.current = null;
      inventoryUnitRef.current = null;
      setInventoryMaster(null);
      setDesignUnit(null);
      setNewBuildMode(false);
      setInventoryNew(true);   // "+ New inventory building" → show the inventory Save bar + location dropdown
      setInvLocationId("");
      setHasExistingEstimate(false);
      setDesignCode(null);
      setEstimateVersions([]);
      setViewingVersion(null);
      setSubmitted(false);
      setSubmitError(null);
      return;
    }
    if (!openDesign.code) return;
    // The persistent Designer tab may hold in-progress work — hand-built, or a previously
    // opened design mid-edit. The old public links opened a NEW tab and could never
    // destroy it; this in-place load can, so it asks first (the same courtesy the
    // portal's openAccount extends before its remount discards the designer).
    if (items.length > 0 || sel.style || sel.size) {
      if (!window.confirm("Opening this design will replace what's currently in the Designer tab. Continue?")) return;
    }
    let cancelled = false;
    (async () => {
      const loaded = await loadDesignByCode(String(openDesign.code), Number(openDesign.version) || null, () => cancelled);
      // A failed load leaves the PREVIOUS design on the canvas. Arming inventory state
      // here would point it at a building nobody can see: "Update Inventory Building"
      // would then overwrite the clicked unit's master with the old design, and a
      // Send-estimate would link the wrong floor plan to that unit.
      if (cancelled || !loaded) {
        if (!cancelled) setSubmitError("That design could not be opened — check your connection and try again.");
        return;
      }
      if (openDesign.asNew) {
        // "Send estimate" from Inventory: the unit's design becomes a FRESH estimate for
        // a new customer — a new short_code is minted at submit, the contact starts
        // blank, no GHL identity carries over, and the master itself stays untouched.
        // Many customers can each get their own estimate on the same physical building.
        currentDesignIdRef.current = null;
        setDesignCode(null);
        isDraftRef.current = false;
        draftStateRef.current = null;
        ghlContactIdRef.current = null;
        ghlEstimateIdRef.current = null;
        ghlEstimateNumberRef.current = null;
        setHasExistingEstimate(false);
        setViewingVersion(null);
        setContact({ name: "", email: "", phone: "", street: "", city: "", state: "", zip: "" });
        setInventoryMaster(null);
        // asNew is a NEW quote on that building: the lock comes from the armed ref, and
        // designUnit (which tracks a SAVED row's link) must not also be set yet.
        setDesignUnit(openDesign.inventoryUnitId
          ? { id: openDesign.inventoryUnitId, serial: openDesign.unitSerial ?? null,
              // The Inventory tab knows where the building is on the ladder, so it says so —
              // that is what lets a not-yet-built unit be quoted with an editable plan.
              lifecycle: openDesign.unitLifecycle ?? null }
          : null);
        setNewBuildMode(false);
        inventoryUnitRef.current = openDesign.inventoryUnitId || null;
      } else if (openDesign.newBuild) {
        // "Quote a new build for this customer" from a sold building's estimate list. Exactly
        // what the in-designer "Design a new build instead" button does — the plan unlocks and
        // unitToLink resolves to null at submit, so the new version reads New rather than
        // inheriting the sold unit. No extra confirm here: openInDesigner already asked about
        // replacing what is in the Designer tab, and the user clicked a button that says this.
        inventoryUnitRef.current = null;
        setNewBuildMode(true);
      } else {
        inventoryUnitRef.current = null;
        if (openDesign.unit) {
          // Inventory "Open": enrich the master marker so update mode knows its unit.
          setInventoryMaster((m) => m && {
            ...m,
            unitId: openDesign.unit.unitId,
            priceCents: openDesign.unit.askingPriceCents ?? null,
            locationId: openDesign.unit.locationId ?? null,
          });
          setInvLocationId(openDesign.unit.locationId || ""); // seed the inline location dropdown
        }
      }
    })();
    return () => { cancelled = true; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [supabase, embedded, openDesign]);

  // On the submit-success screen, load every version of this design (this estimate) so the
  // customer/rep can see and reopen all designs on the estimate. Capability read by code.
  useEffect(() => {
    if (!supabase || !designCode) { setEstimateVersions([]); return; }
    let cancelled = false;
    (async () => {
      const { data, error } = await supabase.rpc("list_design_versions", { p_code: designCode });
      if (cancelled || error) return;
      setEstimateVersions(Array.isArray(data) ? data : []);
    })();
    return () => { cancelled = true; };
  }, [supabase, designCode, submitted]);

  // Switch to another saved version in place (no page reload). Loads that version's design
  // data and keeps the current GHL refs (same estimate), marking it as the one being viewed.
  const openVersion = useCallback(async (version) => {
    if (!supabase || !designCode) return;
    const { data: vrows, error } = await supabase.rpc("load_design_version", { p_code: designCode, p_version: version });
    const vrow = Array.isArray(vrows) ? vrows[0] : vrows;
    if (error || !vrow) return;
    const vsel = vrow.selections || {};
    // Pre-set prevSizeRef to this version's size so the size effect doesn't treat it as a
    // user size-change and wipe the items we're loading (same guard the initial load uses).
    prevSizeRef.current = vsel.size || prevSizeRef.current;
    // Rebuild from pristine defaults, NEVER merge over the live sel: a version saved
    // before a key existed (cladding, roofType...) must not inherit whatever the user
    // picked five clicks ago in the current session -- the same rule the design-load
    // path already follows (audit 2026-08-19).
    setSel(() => {
      const base = { style: "", size: "", roofType: "", roofColor: "", cladding: "" };
      C.options.forEach((o) => { base[o.id] = o.type === "counter" ? o.options[0] : ""; });
      return { ...base, ...vsel };
    });
    setPaintColors(vrow.paint_colors || { body: "", trim: "" });
    setPaintCustom({ body: false, trim: false });
    setCustomOptions(vrow.custom_options || []);
    setRoDimensions(vrow.ro_dimensions || {});
    const loadedItems = repairLoaded(Array.isArray(vrow.items) ? vrow.items : [], (vrow.selections || {}).size);
    setItems(loadedItems);
    setSelectedId(null);
    idCounter = Math.max(idCounter, 0, ...loadedItems.map((i) => Number(i.id) || 0)) + 1;
    setViewingVersion(version);
    if (!embedded) {
      const p = new URLSearchParams(window.location.search);
      p.set("v", String(version));
      window.history.replaceState({}, "", `?${p.toString()}`);
    }
  }, [supabase, designCode, embedded]);

  // ─── Page-based geometry: on-screen mirrors the 8.5"×11" export 1:1 ───
  // The SVG viewBox IS the export page. Notes/lines live in page coordinates,
  // so wherever they sit on screen is exactly where they print.
  const PAGE_W = SS_PAGE.W, PAGE_H = SS_PAGE.H;
  const TEXT_AREA_H = SS_PAGE.TEXT_AREA_H;  // bottom band reserved for auto customer info
  const TOP_LABEL_PAD = SS_PAGE.TOP_LABEL_PAD; // space for size + FRONT labels above plan
  const BOT_LABEL_PAD = SS_PAGE.BOT_LABEL_PAD; // space for size + BACK labels below plan
  const RAMP_SPACE_FT = SS_PAGE.RAMP_SPACE_FT; // a ramp shows 2 ft past its wall (visual)
  const visibleH = PAGE_H - TEXT_AREA_H;
  // Plan dynamically scales: caps in three directions ensure a ramp fits
  // both north and south plus 70% target sizing.
  //   1) width ≤ 70% of page (so the plan never spans the full sheet)
  //   2) height ≤ 70% of the visible top area
  //   3) plan + 2 ramps + 2 label pads ≤ visibleH (so south + north ramps fit)
  // Top-bias: the plan sits RAMP_SPACE_FT*scale + TOP_LABEL_PAD from the top so a north
  // ramp + labels fit; the third scale constraint guarantees room for a south ramp below.
  // Derived by pageGeom() so the reflow can compute the OLD page geometry the same way.
  const { scale, pW, pH, mgX, mgY } = pageGeom(bldgW, bldgH);
  const cW = PAGE_W, cH = PAGE_H;
  const TEXT_BAND_TOP = PAGE_H - TEXT_AREA_H;

  // ─── Display frame: zoom-to-fit crop of the sheet (DISPLAY-ONLY) ───
  // Everything above (scale, mgX, mgY) is shared with the print/export path and
  // is untouched. The frame only decides which part of the sheet the on-screen
  // SVG shows (its viewBox) and how large it renders — the plan plus a wide
  // margin band for notes/lines, expanded to include any annotation already
  // placed outside it (saved designs), clamped to the sheet. Because the
  // element's aspect ratio always matches the frame's, on-screen px-per-page-px
  // stays uniform on both axes and getSvgPt's single-ratio math stays exact.
  const NOTE_MARGIN = 170; // page px kept beside the plan for notes (~20% of sheet width per side)
  const frame = (() => {
    let x0 = Math.max(0, mgX - NOTE_MARGIN);
    let x1 = Math.min(PAGE_W, mgX + pW + NOTE_MARGIN);
    let y0 = 0;
    let y1 = Math.min(TEXT_BAND_TOP, mgY + pH + RAMP_SPACE_FT * scale + BOT_LABEL_PAD + 40);
    items.forEach((it) => {
      if (it.type === "textNote") {
        const w = it.widthPx || 160, h = it.heightPx || 40;
        // Left pad is wider (28) so the docked leader handle (cx -w/2-18, r7)
        // is never clipped out of the frame for notes near the sheet's edge.
        x0 = Math.min(x0, it.x - w / 2 - 28); x1 = Math.max(x1, it.x + w / 2 + 12);
        y0 = Math.min(y0, it.y - h / 2 - 12); y1 = Math.max(y1, it.y + h / 2 + 12);
        if (it.leader) {
          x0 = Math.min(x0, it.leader.x - 12); x1 = Math.max(x1, it.leader.x + 12);
          y0 = Math.min(y0, it.leader.y - 12); y1 = Math.max(y1, it.leader.y + 12);
        }
      } else if (it.type === "line") {
        x0 = Math.min(x0, Math.min(it.x1, it.x2) - 12); x1 = Math.max(x1, Math.max(it.x1, it.x2) + 12);
        y0 = Math.min(y0, Math.min(it.y1, it.y2) - 12); y1 = Math.max(y1, Math.max(it.y1, it.y2) + 12);
      }
    });
    x0 = Math.max(0, x0); y0 = Math.max(0, y0);
    x1 = Math.min(PAGE_W, x1); y1 = Math.min(TEXT_BAND_TOP, y1);
    return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
  })();
  // On-screen size: full container width up to a height cap. maxWidth is derived
  // from the cap so the element's aspect always equals the frame's (no letterbox).
  const DISP_MAX_H = 760;
  const dispMaxW = Math.round(Math.min(1010, (frame.w * DISP_MAX_H) / frame.h));
  // Ref so pointer-math reads the CURRENT frame even from stale-closured handlers.
  const frameRef = useRef(frame);
  frameRef.current = frame;

  // Get sizes for selected style
  const selectedStyle = C.buildingStyles.find((s) => s.value === sel.style);
  const sizeOpts = selectedStyle && Array.isArray(selectedStyle.sizes) ? selectedStyle.sizes : (C.defaultSizes || []);
  const frontWall = getFrontWall(items);
  // Detect unattached lofts for warning banner
  const lofts = items.filter((i) => i.type === "loft");
  const unattachedLofts = lofts.filter((lf) => {
    const w = (lf.widthFt || 6) / 2, h = (lf.heightFt || 4) / 2;
    const cx = (lf.x - mgX) / scale, cy = (lf.y - mgY) / scale;
    const others = lofts.filter((o) => o.id !== lf.id).map((o) => {
      const ow = (o.widthFt || 6) / 2, oh = (o.heightFt || 4) / 2;
      const ocx = (o.x - mgX) / scale, ocy = (o.y - mgY) / scale;
      return { l: ocx - ow, r: ocx + ow, t: ocy - oh, b: ocy + oh };
    });
    return !checkLoftAttached(cx - w, cx + w, cy - h, cy + h, bldgW, bldgH, others);
  });

  // A 3D snapshot must always show the layout it ships with: drop it whenever
  // anything that feeds the 3D scene changes — any selection counts, since
  // options can change the 3D look too (e.g. the lap-siding upgrade). Also
  // fires on design load, which is correct — the customer re-captures from
  // the reopened design.
  useEffect(() => {
    render3DSnapshotRef.current = null;
    setHas3DSnapshot(false);
  }, [items, sel, paintColors, bldgW, bldgH]);

  // ─── INTERACTION HANDLERS ───
  const getSvgPt = useCallback((e) => {
    const svg = svgRef.current;
    if (!svg) return { x: 0, y: 0 };
    const r = svg.getBoundingClientRect();
    const cx = e.touches ? e.touches[0].clientX : e.clientX;
    const cy = e.touches ? e.touches[0].clientY : e.clientY;
    // The viewBox is the zoom-to-fit display frame — a crop of the sheet whose
    // aspect ratio always matches the element's, so ONE ratio maps both axes.
    // Read the frame through the ref so this stays exact even when a handler
    // closed over an older render (the frame moves as items/sizes change).
    const f = frameRef.current;
    const sx = f.w / r.width;
    return { x: f.x + (cx - r.left) * sx, y: f.y + (cy - r.top) * sx };
  }, []);

  const handleClick = useCallback((e) => {
    if (dragging) return;
    if (planLockedRef.current) return;   // inventory estimate: the building is already built
    // Not captured yet: any attempt to work the canvas pops the lead gate instead.
    if (gateRequired) { setGateOpen(true); return; }
    // Swallow the click that fires immediately after a drag/resize gesture —
    // otherwise the hit test below would deselect items the user just resized.
    if (justGesturedRef.current) {
      justGesturedRef.current = false;
      return;
    }
    // Pick-one-to-remove mode: the pulsing overlays are the only click targets
    // (they handle their own clicks); every other canvas action is disabled.
    if (pendingRemoval) return;
    const pt = getSvgPt(e);
    if (!activeTool) {
      const hit = [...items].reverse().find((it) => {
        const c = ITEMS[it.type]; if (!c) return false;
        if (c.lineType) {
          // Distance from click to the line segment
          const A = pt.x - it.x1, B = pt.y - it.y1;
          const C2 = it.x2 - it.x1, D = it.y2 - it.y1;
          const lenSq = C2 * C2 + D * D;
          let t = lenSq ? (A * C2 + B * D) / lenSq : 0;
          t = Math.max(0, Math.min(1, t));
          const dx = pt.x - (it.x1 + t * C2), dy = pt.y - (it.y1 + t * D);
          return Math.sqrt(dx * dx + dy * dy) < 8;
        }
        if (c.noteType) {
          const w = it.widthPx || 160, h = it.heightPx || 40;
          return Math.abs(pt.x - it.x) < w / 2 + 4 && Math.abs(pt.y - it.y) < h / 2 + 4;
        }
        // Use the item's actual stored size, not the config default — the
        // workbench/loft/RO can be resized past their default and still need
        // to be selectable at their visual bounds.
        const iwFt = it.widthFt || c.width;
        const ihFt = it.heightFt || c.height;
        const iw = iwFt * scale, ih = ihFt * scale;
        const rot = it.rotation === 90 || it.rotation === 270; const hw = (rot ? ih : iw) / 2; const hh = (rot ? iw : ih) / 2; // 270° swaps the visual bbox just like 90° (audit #F5)
        return Math.abs(pt.x - it.x) < hw + 5 && Math.abs(pt.y - it.y) < hh + 5;
      });
      // Clicking an ALREADY-selected note starts typing in place (works for
      // double-click and tap-tap alike; the justGestured guard above keeps a
      // drag's trailing click from triggering it).
      if (hit && hit.id === selectedId && ITEMS[hit.type] && ITEMS[hit.type].noteType) { setEditingNoteId(hit.id); return; }
      if (!hit || hit.id !== editingNoteId) setEditingNoteId(null);
      setSelectedId(hit ? hit.id : null); return;
    }
    const cfg = ITEMS[activeTool]; if (!cfg) return;
    // The single "Door" tool: don't place yet — remember the wall + click point and open the
    // door picker, which chooses the door + swing/operation and then places it (placePickedDoor).
    if (cfg.isDoorPicker) {
      const w = getWallFromClick(pt.x, pt.y, pW, pH, mgX, mgY) || getNearestWall(pt.x, pt.y, pW, pH, mgX, mgY);
      setDoorPick({ wall: w, ptx: pt.x, pty: pt.y });
      setActiveTool(null); setToast(null);
      return;
    }
    // The "Window" tool: like the door picker but no swing/operation — remember the wall + point
    // and open the window picker, which places the chosen catalog window (placePickedWindow).
    if (cfg.isWindowPicker) {
      const w = getWallFromClick(pt.x, pt.y, pW, pH, mgX, mgY) || getNearestWall(pt.x, pt.y, pW, pH, mgX, mgY);
      setWindowPick({ wall: w, ptx: pt.x, pty: pt.y });
      setActiveTool(null); setToast(null);
      return;
    }
    // An INCLUDED catalog door/window chip is armed → drop that EXACT fixture here (no picker).
    // Included ramps are doorSnap and handled in the doorSnap branch below.
    if (cfg.includedFixture && !cfg.doorSnap) {
      const fx = cfg.includedFixture;
      const w = getWallFromClick(pt.x, pt.y, pW, pH, mgX, mgY) || getNearestWall(pt.x, pt.y, pW, pH, mgX, mgY);
      const widthFt = (Number(fx.widthIn) || (fx.category === "window" ? 24 : 36)) / 12;
      // Wider than the clicked wall = snapToWall's clamp degenerates and the fixture
      // overhangs the building corner; refuse up front, as the door picker does
      // (audit 2026-08-20).
      if (widthFt > (w === "north" || w === "south" ? pW : pH) / scale + 1e-6) {
        setToast(`That ${fx.category === "window" ? "window" : "door"} is wider than this wall — pick a longer wall.`);
        setTimeout(() => setToast(null), 4000); return;
      }
      const iwPx2 = widthFt * scale, ihPx2 = 0.5 * scale;
      const sn = snapToWall(w, pt.x, pt.y, iwPx2, ihPx2, pW, pH, mgX, mgY);
      let ni;
      if (fx.category === "window") {
        ni = { id: idCounter++, type: "window", ...sn, widthFt, heightFt: 0.5, fixtureItemId: fx.id, windowName: fx.name || "Window",
          planLabel: (fx.planLabel && String(fx.planLabel).trim()) || (fx.name || "WIN").toUpperCase().slice(0, 6),
          price: (fx.price != null ? fx.price : null), widthIn: Number(fx.widthIn) || null, heightIn: Number(fx.heightIn) || null,
          ...windowColorStamps(fixtureWindowColorDefault(windowColorsFor(fx, windowColorList))) };
      } else {
        const swing = fx.swingDefault || (fx.swingOut ? "out" : fx.swingIn ? "in" : null);
        const operation = fx.opDefault || (fx.opDouble ? "double" : fx.opSlideUp ? "slideup" : fx.opRight ? "right" : fx.opLeft ? "left" : null);
        ni = { id: idCounter++, type: "fixtureDoor", ...sn, widthFt, heightFt: 0.5, fixtureItemId: fx.id, doorName: fx.name || "Door",
          planLabel: (fx.planLabel && String(fx.planLabel).trim()) || (fx.name || "DOOR").toUpperCase().slice(0, 6),
          price: (fx.price != null ? fx.price : null), widthIn: Number(fx.widthIn) || null, heightIn: Number(fx.heightIn) || null, swing, operation,
          // No picker on the included-chip path — stamp the door's color defaults, same
          // contract as its swing/operation defaults above.
          ...fixtureDoorColorDefaults(fx, doorPaintColors, paintColors.body, paintColors.trim) };
      }
      if (checkDoorCollision(ni, { width: widthFt }, items, ITEMS, scale)) {
        setToast("Something's already there — pick a different spot on the wall."); setTimeout(() => setToast(null), 4000); return;
      }
      // Workbench check too, as the built-in wall placement below runs — checkDoorCollision
      // skips workbenches, so an included chip could drop its door/window straight onto one
      // (audit 2026-08-20).
      if (checkWorkbenchOverlap(sn, iwPx2, items, ITEMS, scale)) {
        setToast("A workbench is on that wall — place this somewhere else on the wall."); setTimeout(() => setToast(null), 4000); return;
      }
      setItems((p) => [...p, ni]); setSelectedId(ni.id); setActiveTool(null); setToast(null);
      return;
    }
    const iwPx = cfg.width * scale; const ihPx = cfg.height * scale;
    let wall = getWallFromClick(pt.x, pt.y, pW, pH, mgX, mgY);
    // Wall-only items always go on a wall; if the click missed the threshold,
    // fall back to the nearest wall so the placement still happens.
    if (cfg.wallOnly && !wall) wall = getNearestWall(pt.x, pt.y, pW, pH, mgX, mgY);

    // Annotation tools (note + line): free placement anywhere on the visible
    // page area (above the auto info band), not just inside the plan rectangle.
    if (cfg.noteType) {
      const ni = {
        id: idCounter++, type: activeTool,
        x: Math.max(20, Math.min(pt.x, PAGE_W - 20)),
        y: Math.max(20, Math.min(pt.y, TEXT_BAND_TOP - 20)),
        rotation: 0, wall: null,
        widthPx: 160, heightPx: 40,   // user-resizable box; text flows inside
        text: "Note",
      };
      setItems((p) => [...p, ni]);
      setSelectedId(ni.id);
      setEditingNoteId(ni.id);  // start typing in the note immediately (text pre-selected)
      setActiveTool(null);
      setToast(null);
      return;
    }
    if (cfg.lineType) {
      const halfLenPx = (cfg.width / 2) * scale;
      const cx = Math.max(20, Math.min(pt.x, PAGE_W - 20));
      const cy = Math.max(20, Math.min(pt.y, TEXT_BAND_TOP - 20));
      const ni = {
        id: idCounter++, type: activeTool, wall: null,
        x1: Math.max(0, cx - halfLenPx), y1: cy,
        x2: Math.min(PAGE_W, cx + halfLenPx), y2: cy,
      };
      setItems((p) => [...p, ni]);
      setSelectedId(ni.id);
      setActiveTool(null);
      setToast(null);
      return;
    }

    // Door-snap items (ramp): find nearest door and snap to its outside
    if (cfg.doorSnap) {
      // fixtureDoor counts as a door here. It is the item type EVERY catalog door placement
      // creates, and it is treated as a door everywhere else — getFrontWall, checkDoorCollision via
      // wallOnly, the payload doors[] schedule — but the ramp tool filtered it out, so a shopper who
      // placed the tenant's own catalog door (a slide-up or garage door, the most natural ramp
      // companion) got "Place a door first, then add a ramp to it." with a door plainly on the plan.
      // Catalog doors are live: fixture_items has active category='door' rows today.
      const doors = items.filter((i) => i.type === "singleDoor" || i.type === "doubleDoor" || i.type === "fixtureDoor");
      if (doors.length === 0) {
        setToast("Place a door first, then add a ramp to it.");
        setTimeout(() => setToast(null), 5000);
        return;
      }
      // Find closest door to click
      let closest = null; let minDist = Infinity;
      doors.forEach((d) => { const dx = pt.x - d.x; const dy = pt.y - d.y; const dist = Math.sqrt(dx * dx + dy * dy); if (dist < minDist) { minDist = dist; closest = d; } });
      if (!closest) return;
      // Check if this door already has a ramp
      const existingRamp = items.find((i) => i.type === "ramp" && i.snapDoorId === closest.id);
      if (existingRamp) {
        setToast("This door already has a ramp. Delete it first to replace.");
        setTimeout(() => setToast(null), 5000);
        return;
      }
      // Custom ramp: open the picker for THIS door — placePickedRamp creates the ramp item.
      if (cfg.isRampPicker) { setRampPick({ door: closest }); setActiveTool(null); setToast(null); return; }
      // An INCLUDED catalog ramp chip: attach that EXACT ramp to this door (like a custom ramp).
      if (cfg.includedFixture) {
        const fx = cfg.includedFixture;
        const widthFt = (Number(fx.widthIn) || 36) / 12;
        const rDepth = (Number(fx.heightIn) || 0) / 12 || RAMP_SPACE_FT;
        const rDepthPx = rDepth * scale;
        let rx, ry, rot;
        if (closest.wall === "north") { rx = closest.x; ry = mgY - rDepthPx / 2; rot = 0; }
        else if (closest.wall === "south") { rx = closest.x; ry = mgY + pH + rDepthPx / 2; rot = 0; }
        else if (closest.wall === "west") { rx = mgX - rDepthPx / 2; ry = closest.y; rot = 90; }
        else if (closest.wall === "east") { rx = mgX + pW + rDepthPx / 2; ry = closest.y; rot = 90; }
        else return;
        const ni = { id: idCounter++, type: "ramp", x: rx, y: ry, rotation: rot, wall: closest.wall, widthFt, heightFt: rDepth, snapDoorId: closest.id,
          fixtureItemId: fx.id, rampName: fx.name || "Ramp", planLabel: (fx.planLabel && String(fx.planLabel).trim()) || (fx.name || "RAMP").toUpperCase().slice(0, 6),
          price: (fx.price != null ? fx.price : null), widthIn: Number(fx.widthIn) || null, heightIn: Number(fx.heightIn) || null };
        setItems((p) => [...p, ni]); setSelectedId(ni.id); setActiveTool(null); setToast(null);
        return;
      }
      const doorCfg = ITEMS[closest.type];
      const doorW = doorCfg ? doorCfg.width : 3;
      const rampDepth = RAMP_SPACE_FT; // visual ramp depth in feet
      const rp = rampPlacementForDoor(closest, rampDepth, pW, pH, mgX, mgY, scale);
      if (!rp) return;
      const ni = { id: idCounter++, type: activeTool, ...rp, widthFt: doorW, heightFt: rampDepth, snapDoorId: closest.id };
      setItems((p) => [...p, ni]);
      setActiveTool(null);
      setToast(null);
      return;
    }

    // (cfg.wallOnly is always assigned a wall above — no need to abort here)
    let ni;
    if (cfg.wallSnap) {
      const clickedWall = wall || getNearestWall(pt.x, pt.y, pW, pH, mgX, mgY);
      const sn = snapToWallInterior(clickedWall, pt.x, pt.y, iwPx, ihPx, pW, pH, mgX, mgY);
      const candidate = { id: idCounter, type: activeTool, ...sn, widthFt: cfg.width, heightFt: cfg.height };
      const others = items.filter((i) => i.id !== candidate.id);
      if (checkDoorCollision(candidate, cfg, others, ITEMS, scale)) {
        setToast("A door is blocking this wall! Try clicking a different wall, or move the door first.");
        setTimeout(() => setToast(null), 5000);
        return;
      }
      // Check workbench overlap on same wall during placement
      const isH = sn.wall === "north" || sn.wall === "south";
      const candPos = isH ? sn.x : sn.y;
      const candHalf = cfg.width * scale / 2;
      for (const ob of others) {
        if (ob.type !== "workbench" || ob.wall !== sn.wall) continue;
        const obW = (ob.widthFt || ITEMS[ob.type].width) * scale / 2;
        const obPos = isH ? ob.x : ob.y;
        if (Math.abs(candPos - obPos) < candHalf + obW - 2) {
          setToast("Another workbench is in the way. Try a different spot on the wall.");
          setTimeout(() => setToast(null), 4000);
          return;
        }
      }
      ni = candidate;
      idCounter++;
    } else if (activeTool === "loft") {
      // Auto-span wall-to-wall (full building width), positioned at click Y
      const loftH = cfg.height; // default 4ft
      const cyFtRound = Math.max(loftH / 2, Math.min(Math.round((pt.y - mgY) / scale), bldgH - loftH / 2));
      const cxFt = bldgW / 2;
      const nL = 0, nR = bldgW, nT = cyFtRound - loftH / 2, nB = cyFtRound + loftH / 2;
      // Prevent overlap with other lofts
      const otherLofts = items.filter((i) => i.type === "loft");
      for (const o of otherLofts) {
        const ow = (o.widthFt || cfg.width) / 2, oh = (o.heightFt || cfg.height) / 2;
        const ocx = (o.x - mgX) / scale, ocy = (o.y - mgY) / scale;
        if (nL < ocx + ow - 0.1 && nR > ocx - ow + 0.1 && nT < ocy + oh - 0.1 && nB > ocy - oh + 0.1) {
          setToast("Can't place a loft overlapping another loft. Move the existing one or click a different spot.");
          setTimeout(() => setToast(null), 4000);
          return;
        }
      }
      ni = { id: idCounter++, type: "loft", x: mgX + cxFt * scale, y: mgY + cyFtRound * scale, rotation: 0, wall: null, widthFt: bldgW, heightFt: loftH, elevationFt: D3.LOFT_ELEV };
    } else if (wall) {
      const sn = snapToWall(wall, pt.x, pt.y, iwPx, ihPx, pW, pH, mgX, mgY);
      // Placing a door/window/RO had NO overlap check at all, so one could be click-placed straight
      // on top of another door, or onto a workbench’s wall span. Both checks now run here, matching
      // the wallSnap (workbench) branch, so the invariant holds whichever item is the one moving.
      const cand = { id: -1, type: activeTool, ...sn, widthFt: cfg.width, heightFt: cfg.height };
      if (checkDoorCollision(cand, cfg, items, ITEMS, scale)) {
        setToast("Something is already on that spot. Pick a clear part of the wall.");
        setTimeout(() => setToast(null), 4000);
        return;
      }
      if (checkWorkbenchOverlap(sn, iwPx, items, ITEMS, scale)) {
        setToast("A workbench is on that wall — place this somewhere else on the wall.");
        setTimeout(() => setToast(null), 4000);
        return;
      }
      ni = { id: idCounter++, type: activeTool, ...sn, widthFt: cfg.width, heightFt: cfg.height, ...d3OpeningDefaults(activeTool) };
    } else {
      const x = Math.max(mgX + iwPx / 2, Math.min(pt.x, mgX + pW - iwPx / 2));
      const y = Math.max(mgY + ihPx / 2, Math.min(pt.y, mgY + pH - ihPx / 2));
      ni = { id: idCounter++, type: activeTool, x, y, rotation: 0, wall: null, widthFt: cfg.width, heightFt: cfg.height };
    }
    setItems((p) => [...p, ni]);
    setActiveTool(null);
    setToast(null);
  }, [activeTool, dragging, getSvgPt, items, mgX, mgY, pW, pH, scale, ITEMS, pendingRemoval, selectedId, editingNoteId, gateRequired, doorPaintColors, windowColorList, paintColors]);

  // Place the door chosen in the picker at the remembered wall/click point. Snapshots the
  // door's spec (so a later catalog edit never changes this saved design) + the shopper's
  // swing/operation choice onto a stable `fixtureDoor` item.
  const placePickedDoor = useCallback((fx, swing, operation, doorColor, trimColor) => {
    // Swap mode: replace the selected door in place with the chosen door — keeping its wall,
    // but RE-LEGALIZED for the new width. The swap used to keep x/y verbatim with no bounds,
    // collision, or workbench check — the one mutation path with none — so swapping to a
    // wider door overlapped its neighbors, or hung past the building corner near an end,
    // straight into the exported PDF (audit 2026-08-20). Same checks + refusals as click
    // placement; when the new door cannot fit, nothing changes and the old door stays.
    if (swapId != null && fx) {
      const wFt = (Number(fx.widthIn) || 36) / 12;
      const cur = items.find((it) => it.id === swapId);
      if (!cur || !cur.wall) { setSwapId(null); setDoorPick(null); return; }
      if (wFt > (cur.wall === "north" || cur.wall === "south" ? pW : pH) / scale + 1e-6) {
        setToast("That door is wider than this wall — pick a narrower door.");
        setTimeout(() => setToast(null), 4000);
        setSwapId(null); setDoorPick(null);
        return;
      }
      const sn = snapToWall(cur.wall, cur.x, cur.y, wFt * scale, 0.5 * scale, pW, pH, mgX, mgY);
      const others = items.filter((it) => it.id !== swapId);
      if (checkDoorCollision({ ...cur, ...sn, widthFt: wFt }, { width: wFt }, others, ITEMS, scale)) {
        setToast("That door doesn't fit here — something else is in the way on this wall.");
        setTimeout(() => setToast(null), 4000);
        setSwapId(null); setDoorPick(null);
        return;
      }
      if (checkWorkbenchOverlap(sn, wFt * scale, others, ITEMS, scale)) {
        setToast("A workbench is on that wall — the wider door would overlap it.");
        setTimeout(() => setToast(null), 4000);
        setSwapId(null); setDoorPick(null);
        return;
      }
      setItems((p) => p.map((it) => {
        if (it.id === swapId) return { ...it, ...sn, type: "fixtureDoor", fixtureItemId: fx.id, doorName: fx.name || "Door",
          planLabel: (fx.planLabel && String(fx.planLabel).trim()) || (fx.name || "DOOR").toUpperCase().slice(0, 6),
          price: (fx.price != null ? fx.price : null), widthIn: Number(fx.widthIn) || null, heightIn: Number(fx.heightIn) || null,
          // Drop the height a BUILT-IN placement stamped: openingHeightFt wins over heightIn
          // in openingSpan, so keeping it here would draw this fixture at the old 6'6" no
          // matter what the builder's door actually measures.
          openingHeightFt: undefined, sillFt: undefined,
          // All six color fields set EXPLICITLY (nulls when absent) — same stale-field
          // discipline as openingHeightFt: the old door's colors must never survive a swap.
          ...doorColorStamps(doorColor, fx.hasTrimColor ? trimColor : null),
          widthFt: wFt, swing: swing || it.swing || null, operation: operation || it.operation || null };
        // The re-clamp can shift the door; its ramp is derived geometry and must follow,
        // exactly like the drag path — else it detaches into the rasterized PDF.
        if (it.type === "ramp" && it.snapDoorId === swapId) {
          const rp = rampPlacementForDoor(sn, it.heightFt, pW, pH, mgX, mgY, scale);
          return rp ? { ...it, ...rp } : it;
        }
        return it;
      }));
      setSwapId(null); setDoorPick(null); setToast(null); return;
    }
    if (!doorPick || !fx) return;
    const widthFt = (Number(fx.widthIn) || 36) / 12;
    // A door wider than the clicked wall can never be legal: snapToWall's clamp degenerates
    // (its max bound exceeds its min bound) and parks the door overhanging the building
    // corner — on the plan, in the exported PDF, and as an opening wider than the wall in
    // 3D. reflowItems' seat() already refuses wFt > wallLen on size change; enforce the
    // same invariant at placement (audit 2026-08-20).
    if (widthFt > (doorPick.wall === "north" || doorPick.wall === "south" ? pW : pH) / scale + 1e-6) {
      setToast("That door is wider than this wall — pick a longer wall or a narrower door.");
      setTimeout(() => setToast(null), 4000);
      setDoorPick(null);
      return;
    }
    const iwPx = widthFt * scale, ihPx = 0.5 * scale;
    const sn = snapToWall(doorPick.wall, doorPick.ptx, doorPick.pty, iwPx, ihPx, pW, pH, mgX, mgY);
    const ni = {
      id: idCounter++, type: "fixtureDoor", ...sn, widthFt, heightFt: 0.5,
      fixtureItemId: fx.id, doorName: fx.name || "Door",
      planLabel: (fx.planLabel && String(fx.planLabel).trim()) || (fx.name || "DOOR").toUpperCase().slice(0, 6),
      price: (fx.price != null ? fx.price : null),
      widthIn: Number(fx.widthIn) || null, heightIn: Number(fx.heightIn) || null,
      swing: swing || null, operation: operation || null,
      ...doorColorStamps(doorColor, fx.hasTrimColor ? trimColor : null),
    };
    if (checkDoorCollision(ni, { width: widthFt }, items, ITEMS, scale)) {
      setToast("A door is already there — pick a different spot on the wall.");
      setTimeout(() => setToast(null), 4000);
      setDoorPick(null);
      return;
    }
    // Same second check as the built-in wall placement and the drag path: checkDoorCollision
    // skips workbenches (wallSnap, not wallOnly), so a picked catalog door landed straight
    // on a workbench — the exact layout checkWorkbenchOverlap exists to prevent
    // (audit 2026-08-20).
    if (checkWorkbenchOverlap(sn, iwPx, items, ITEMS, scale)) {
      setToast("A workbench is on that wall — place this somewhere else on the wall.");
      setTimeout(() => setToast(null), 4000);
      setDoorPick(null);
      return;
    }
    setItems((p) => [...p, ni]);
    setSelectedId(ni.id);
    setDoorPick(null);
    setToast(null);
  }, [swapId, doorPick, items, mgX, mgY, pW, pH, scale, ITEMS]);

  // Place the window style chosen in the picker at the remembered wall/point. A catalog window is
  // a normal type:"window" item (reuses the built-in window render/collision/payload) carrying the
  // style's width + a priced snapshot; fixtureItemId is what marks it as a catalog (vs built-in) window.
  const placePickedWindow = useCallback((fx, windowColor) => {
    // Swap mode: same re-legalization as the door swap above — the new width is re-clamped
    // to the wall and collision/workbench-checked before committing; the old swap kept x/y
    // verbatim with no checks at all (audit 2026-08-20).
    if (swapId != null && fx) {
      const wFt = (Number(fx.widthIn) || 24) / 12;
      const cur = items.find((it) => it.id === swapId);
      if (!cur || !cur.wall) { setSwapId(null); setWindowPick(null); return; }
      if (wFt > (cur.wall === "north" || cur.wall === "south" ? pW : pH) / scale + 1e-6) {
        setToast("That window is wider than this wall — pick a narrower window.");
        setTimeout(() => setToast(null), 4000);
        setSwapId(null); setWindowPick(null);
        return;
      }
      const sn = snapToWall(cur.wall, cur.x, cur.y, wFt * scale, 0.5 * scale, pW, pH, mgX, mgY);
      const others = items.filter((it) => it.id !== swapId);
      if (checkDoorCollision({ ...cur, ...sn, widthFt: wFt }, { width: wFt }, others, ITEMS, scale)) {
        setToast("That window doesn't fit here — something else is in the way on this wall.");
        setTimeout(() => setToast(null), 4000);
        setSwapId(null); setWindowPick(null);
        return;
      }
      if (checkWorkbenchOverlap(sn, wFt * scale, others, ITEMS, scale)) {
        setToast("A workbench is on that wall — the wider window would overlap it.");
        setTimeout(() => setToast(null), 4000);
        setSwapId(null); setWindowPick(null);
        return;
      }
      setItems((p) => p.map((it) => it.id === swapId ? { ...it, ...sn, type: "window", fixtureItemId: fx.id, windowName: fx.name || "Window",
        planLabel: (fx.planLabel && String(fx.planLabel).trim()) || (fx.name || "WIN").toUpperCase().slice(0, 6),
        price: (fx.price != null ? fx.price : null), widthIn: Number(fx.widthIn) || null, heightIn: Number(fx.heightIn) || null,
        // As on the door swap: a built-in window stamped openingHeightFt/sillFt, and those
        // beat the catalog window's own heightIn in openingSpan. Color fields likewise set
        // explicitly so the old window's color never survives the swap.
        openingHeightFt: undefined, sillFt: undefined, ...windowColorStamps(windowColor), widthFt: wFt } : it));
      setSwapId(null); setWindowPick(null); setToast(null); return;
    }
    if (!windowPick || !fx) return;
    const widthFt = (Number(fx.widthIn) || 24) / 12;
    // Wider than the clicked wall = snapToWall's clamp degenerates and the window overhangs
    // the building corner; refuse up front, as the door picker does (audit 2026-08-20).
    if (widthFt > (windowPick.wall === "north" || windowPick.wall === "south" ? pW : pH) / scale + 1e-6) {
      setToast("That window is wider than this wall — pick a longer wall or a narrower window.");
      setTimeout(() => setToast(null), 4000);
      setWindowPick(null);
      return;
    }
    const iwPx = widthFt * scale, ihPx = 0.5 * scale;
    const sn = snapToWall(windowPick.wall, windowPick.ptx, windowPick.pty, iwPx, ihPx, pW, pH, mgX, mgY);
    const ni = {
      id: idCounter++, type: "window", ...sn, widthFt, heightFt: 0.5,
      fixtureItemId: fx.id, windowName: fx.name || "Window",
      planLabel: (fx.planLabel && String(fx.planLabel).trim()) || (fx.name || "WIN").toUpperCase().slice(0, 6),
      price: (fx.price != null ? fx.price : null),
      widthIn: Number(fx.widthIn) || null, heightIn: Number(fx.heightIn) || null,
      ...windowColorStamps(windowColor),
    };
    if (checkDoorCollision(ni, { width: widthFt }, items, ITEMS, scale)) {
      setToast("Something's already there — pick a different spot on the wall.");
      setTimeout(() => setToast(null), 4000);
      setWindowPick(null);
      return;
    }
    // Workbench check too, as the built-in wall placement runs — checkDoorCollision skips
    // workbenches, so a picked catalog window landed straight on one (audit 2026-08-20).
    if (checkWorkbenchOverlap(sn, iwPx, items, ITEMS, scale)) {
      setToast("A workbench is on that wall — place this somewhere else on the wall.");
      setTimeout(() => setToast(null), 4000);
      setWindowPick(null);
      return;
    }
    setItems((p) => [...p, ni]);
    setSelectedId(ni.id);
    setWindowPick(null);
    setToast(null);
  }, [swapId, windowPick, items, mgX, mgY, pW, pH, scale, ITEMS]);

  // Place the ramp style chosen in the picker on the remembered door. A custom ramp is a normal
  // type:"ramp" item (so all ramp machinery applies) but takes the style's OWN width + length
  // (length = the ramp's run/depth out from the door) and snapshots its spec + price.
  const placePickedRamp = useCallback((fx) => {
    // Swap mode: the stored x/y were derived from the OLD depth (a ramp sits centered
    // depth/2 OUTSIDE the wall), so keeping them while changing heightFt left a deeper
    // ramp extending inside the building on the plan — until its door was next dragged,
    // the only thing that recomputed it. Re-derive the position from the door for the
    // NEW depth, exactly like the drag path (audit 2026-08-20).
    if (swapId != null && fx) {
      const wFt = (Number(fx.widthIn) || 36) / 12;
      const dpt = (Number(fx.heightIn) || 0) / 12 || RAMP_SPACE_FT;
      setItems((p) => p.map((it) => {
        if (it.id !== swapId) return it;
        const door = p.find((d) => d.id === it.snapDoorId);
        const rp = door && door.wall ? rampPlacementForDoor(door, dpt, pW, pH, mgX, mgY, scale) : null;
        return { ...it, ...(rp || {}), type: "ramp", fixtureItemId: fx.id, rampName: fx.name || "Ramp",
          planLabel: (fx.planLabel && String(fx.planLabel).trim()) || (fx.name || "RAMP").toUpperCase().slice(0, 6),
          price: (fx.price != null ? fx.price : null), widthIn: Number(fx.widthIn) || null, heightIn: Number(fx.heightIn) || null,
          widthFt: wFt, heightFt: dpt };
      }));
      setSwapId(null); setRampPick(null); setToast(null); return;
    }
    if (!rampPick || !fx) return;
    const door = rampPick.door;
    const widthFt = (Number(fx.widthIn) || 36) / 12;
    const rampDepth = (Number(fx.heightIn) || 0) / 12 || RAMP_SPACE_FT;   // style length = run out from the door
    const rampDepthPx = rampDepth * scale;
    let rx, ry, rot;
    if (door.wall === "north") { rx = door.x; ry = mgY - rampDepthPx / 2; rot = 0; }
    else if (door.wall === "south") { rx = door.x; ry = mgY + pH + rampDepthPx / 2; rot = 0; }
    else if (door.wall === "west") { rx = mgX - rampDepthPx / 2; ry = door.y; rot = 90; }
    else if (door.wall === "east") { rx = mgX + pW + rampDepthPx / 2; ry = door.y; rot = 90; }
    else { setRampPick(null); return; }
    const ni = {
      id: idCounter++, type: "ramp", x: rx, y: ry, rotation: rot, wall: door.wall,
      widthFt, heightFt: rampDepth, snapDoorId: door.id,
      fixtureItemId: fx.id, rampName: fx.name || "Ramp",
      planLabel: (fx.planLabel && String(fx.planLabel).trim()) || (fx.name || "RAMP").toUpperCase().slice(0, 6),
      price: (fx.price != null ? fx.price : null),
      widthIn: Number(fx.widthIn) || null, heightIn: Number(fx.heightIn) || null,
    };
    setItems((p) => [...p, ni]);
    setSelectedId(ni.id);
    setRampPick(null);
    setToast(null);
  }, [swapId, rampPick, mgX, mgY, pW, pH, scale, RAMP_SPACE_FT]);

  const onPtrDown = useCallback((e, item) => {
    e.stopPropagation();
    if (planLockedRef.current) return;   // no selecting or dragging a building that exists
    if (gateRequired) { setGateOpen(true); return; }
    if (pendingRemoval) return; // pick mode: overlays handle the pick; no select/drag
    if (activeTool) return;
    movedRef.current = false;
    gestureStartRef.current = { x: e.touches ? e.touches[0].clientX : e.clientX, y: e.touches ? e.touches[0].clientY : e.clientY };
    setSelectedId(item.id);
    const cfg = ITEMS[item.type];
    if (resizing || (cfg && cfg.doorSnap)) return; // don't drag ramps or while resizing
    const pt = getSvgPt(e);
    if (cfg && cfg.lineType) {
      // Line is stored as two endpoints; track midpoint offset + half-deltas
      // so a body drag translates both endpoints rigidly.
      const midX = (item.x1 + item.x2) / 2, midY = (item.y1 + item.y2) / 2;
      setDragging({
        id: item.id, kind: "line",
        ox: pt.x - midX, oy: pt.y - midY,
        halfDx: (item.x2 - item.x1) / 2, halfDy: (item.y2 - item.y1) / 2,
      });
      return;
    }
    setDragging({ id: item.id, ox: pt.x - item.x, oy: pt.y - item.y, startX: item.x, startY: item.y });
  }, [activeTool, getSvgPt, resizing, ITEMS, pendingRemoval, gateRequired]);

  const startResize = useCallback((e, item, handle) => {
    e.preventDefault();
    if (planLockedRef.current) return;
    movedRef.current = false;
    gestureStartRef.current = { x: e.touches ? e.touches[0].clientX : e.clientX, y: e.touches ? e.touches[0].clientY : e.clientY };
    const pt = getSvgPt(e);
    setResizing({
      id: item.id, handle, startPt: pt,
      origWidthFt: item.widthFt, origHeightFt: item.heightFt,
      origWidthPx: item.widthPx, origHeightPx: item.heightPx,
      origX: item.x, origY: item.y,
    });
  }, [getSvgPt]);

  const getResizeBounds = useCallback((item) => {
    const isHoriz = item.wall === "north" || item.wall === "south";
    const wallLen = isHoriz ? bldgW : bldgH;
    
    let minEdge = 0; // wall start in ft
    let maxEdge = wallLen; // wall end in ft
    
    // Find obstacles on same wall
    items.forEach((other) => {
      if (other.id === item.id || other.wall !== item.wall) return;
      const oCfg = ITEMS[other.type];
      if (!oCfg) return;
      const oW = other.widthFt || oCfg.width;
      const oPos = isHoriz ? (other.x - mgX) / scale : (other.y - mgY) / scale;
      const oLeft = oPos - oW / 2;
      const oRight = oPos + oW / 2;
      
      const itemPos = isHoriz ? (item.x - mgX) / scale : (item.y - mgY) / scale;
      if (oRight <= itemPos) minEdge = Math.max(minEdge, oRight);
      if (oLeft >= itemPos) maxEdge = Math.min(maxEdge, oLeft);
    });

    return { minEdge, maxEdge, isHoriz };
  }, [items, ITEMS, bldgW, bldgH, mgX, mgY, scale]);

  const onPtrMove = useCallback((e) => {
    // Mark the gesture as a real drag/resize once the pointer travels past a
    // small jitter threshold — onPtrUp uses this to decide whether the
    // trailing click should be swallowed (see movedRef declaration).
    if (gestureStartRef.current && !movedRef.current) {
      const gx = e.touches ? e.touches[0].clientX : e.clientX;
      const gy = e.touches ? e.touches[0].clientY : e.clientY;
      if (Math.abs(gx - gestureStartRef.current.x) > 4 || Math.abs(gy - gestureStartRef.current.y) > 4) movedRef.current = true;
    }
    if (resizing) {
      const pt = getSvgPt(e);
      const it = items.find((i) => i.id === resizing.id);
      if (!it) return;

      // Note leader (pointer) drag: the target dot follows the cursor anywhere
      // on the visible sheet. Dropping it back onto the note removes the
      // pointer (handled in onPtrUp so the handle doesn't snap away mid-drag).
      if (it.type === "textNote" && resizing.handle === "leader") {
        const nx = Math.max(0, Math.min(pt.x, PAGE_W));
        const ny = Math.max(0, Math.min(pt.y, TEXT_BAND_TOP));
        setItems((p) => p.map((i) => i.id === resizing.id ? { ...i, leader: { x: nx, y: ny } } : i));
        return;
      }

      // Text-note resize: drag the bottom-right corner. The top-left stays
      // pinned, so the box grows toward the cursor and the text reflows live.
      if (it.type === "textNote") {
        const tlX = resizing.origX - resizing.origWidthPx / 2;
        const tlY = resizing.origY - resizing.origHeightPx / 2;
        const newW = Math.max(80, Math.min(pt.x - tlX, PAGE_W - tlX - 4));
        const newH = Math.max(28, Math.min(pt.y - tlY, TEXT_BAND_TOP - tlY - 4));
        setItems((p) => p.map((i) => i.id === resizing.id ? {
          ...i,
          widthPx: newW,
          heightPx: newH,
          x: tlX + newW / 2,
          y: tlY + newH / 2,
        } : i));
        return;
      }

      // Line endpoint drag: snap the endpoint to the cursor, clamped to the visible page area
      if (it.type === "line") {
        const newX = Math.max(0, Math.min(pt.x, PAGE_W));
        const newY = Math.max(0, Math.min(pt.y, TEXT_BAND_TOP));
        setItems((p) => p.map((i) => i.id === resizing.id ? {
          ...i,
          ...(resizing.handle === "ep1" ? { x1: newX, y1: newY } : { x2: newX, y2: newY }),
        } : i));
        return;
      }

      // Loft: free-floating 4-sided resize with collision
      if (it.type === "loft") {
        const hd = resizing.handle;
        const mouseXft = Math.round((pt.x - mgX) / scale);
        const mouseYft = Math.round((pt.y - mgY) / scale);
        const origCxFt = (resizing.origX - mgX) / scale;
        const origCyFt = (resizing.origY - mgY) / scale;
        const origW = resizing.origWidthFt;
        const origH = resizing.origHeightFt;
        let oL = Math.round(origCxFt - origW / 2), oR = oL + origW;
        let oT = Math.round(origCyFt - origH / 2), oB = oT + origH;
        let nL = oL, nR = oR, nT = oT, nB = oB;
        if (hd === "right") nR = Math.max(oL + 2, Math.min(mouseXft, bldgW));
        else if (hd === "left") nL = Math.min(oR - 2, Math.max(mouseXft, 0));
        else if (hd === "bottom") nB = Math.max(oT + 2, Math.min(mouseYft, bldgH));
        else if (hd === "top") nT = Math.min(oB - 2, Math.max(mouseYft, 0));

        // Check overlap with other lofts — clamp edge if it would overlap
        const otherLofts = items.filter((i) => i.type === "loft" && i.id !== resizing.id);
        for (const o of otherLofts) {
          const ow = (o.widthFt || 6) / 2, oh = (o.heightFt || 4) / 2;
          const ocx = (o.x - mgX) / scale, ocy = (o.y - mgY) / scale;
          const olL = ocx - ow, olR = ocx + ow, olT = ocy - oh, olB = ocy + oh;
          // Only clamp if the other dimensions overlap (2D check)
          if (nT < olB && nB > olT) { // vertically overlapping
            if (hd === "right" && nR > olL && oL < olL) nR = Math.round(olL);
            if (hd === "left" && nL < olR && oR > olR) nL = Math.round(olR);
          }
          if (nL < olR && nR > olL) { // horizontally overlapping
            if (hd === "bottom" && nB > olT && oT < olT) nB = Math.round(olT);
            if (hd === "top" && nT < olB && oB > olB) nT = Math.round(olB);
          }
        }

        const nW = Math.max(2, nR - nL), nH = Math.max(2, nB - nT);
        setItems((p) => p.map((i) => i.id === resizing.id ? {
          ...i, widthFt: nW, heightFt: nH,
          x: mgX + (nL + nR) / 2 * scale,
          y: mgY + (nT + nB) / 2 * scale,
        } : i));
        return;
      }

      // Wall-attached 1D resize: workbench snaps to integer feet, rough
      // opening resizes smoothly to whatever width the user drags to.
      const isHoriz = it.wall === "north" || it.wall === "south";
      const isRO = it.type === "roughOpening";

      // Mouse position in feet along the wall axis
      const mouseFt = isHoriz ? (pt.x - mgX) / scale : (pt.y - mgY) / scale;
      const mouseFtVal = isRO ? mouseFt : Math.round(mouseFt);

      const origCenterFt = isHoriz ? (resizing.origX - mgX) / scale : (resizing.origY - mgY) / scale;
      const origLeft = isRO
        ? (origCenterFt - resizing.origWidthFt / 2)
        : Math.round(origCenterFt - resizing.origWidthFt / 2);
      const origRight = origLeft + resizing.origWidthFt;

      const origItem = { ...it, x: resizing.origX, y: resizing.origY, widthFt: resizing.origWidthFt };
      const { minEdge, maxEdge } = getResizeBounds(origItem);

      const minWidth = isRO ? 0.5 : 2;

      let newLeft = origLeft, newRight = origRight;
      if (resizing.handle === "max") {
        newRight = Math.max(origLeft + minWidth, Math.min(mouseFtVal, isRO ? maxEdge : Math.floor(maxEdge)));
      } else {
        newLeft = Math.min(origRight - minWidth, Math.max(mouseFtVal, isRO ? minEdge : Math.ceil(minEdge)));
      }

      const newWidthFt = newRight - newLeft;
      const newCenterFt = (newLeft + newRight) / 2;
      const newPos = (isHoriz ? mgX : mgY) + newCenterFt * scale;

      setItems((p) => p.map((i) => i.id === resizing.id ? {
        ...i,
        widthFt: newWidthFt,
        x: isHoriz ? newPos : i.x,
        y: isHoriz ? i.y : newPos,
      } : i));
      return;
    }
    if (!dragging) return;
    const pt = getSvgPt(e);
    const it = items.find((i) => i.id === dragging.id);
    if (!it) return;
    const cfg = ITEMS[it.type]; if (!cfg) return;

    // Line body drag: translate both endpoints by the same delta, clamped so
    // neither endpoint leaves the visible page area.
    if (dragging.kind === "line") {
      const newMidX = pt.x - dragging.ox, newMidY = pt.y - dragging.oy;
      const ahx = Math.abs(dragging.halfDx), ahy = Math.abs(dragging.halfDy);
      const cMidX = Math.max(ahx, Math.min(newMidX, PAGE_W - ahx));
      const cMidY = Math.max(ahy, Math.min(newMidY, TEXT_BAND_TOP - ahy));
      setItems((p) => p.map((i) => i.id === dragging.id ? {
        ...i,
        x1: cMidX - dragging.halfDx, y1: cMidY - dragging.halfDy,
        x2: cMidX + dragging.halfDx, y2: cMidY + dragging.halfDy,
      } : i));
      return;
    }

    const rx = pt.x - dragging.ox; const ry = pt.y - dragging.oy;
    const iWidthFt = it.widthFt || cfg.width;
    if (cfg.wallOnly) {
      // Always snap to nearest wall during drag so the door follows the mouse
      // and doesn't get stuck off-wall. The door's ramp (if any) follows too —
      // its placement is derived from the door's position/wall.
      const w = getWallFromClick(rx, ry, pW, pH, mgX, mgY) || getNearestWall(rx, ry, pW, pH, mgX, mgY);
      const sn = snapToWall(w, rx, ry, iWidthFt * scale, cfg.height * scale, pW, pH, mgX, mgY);
      // Refuse the move rather than commit an overlap — same posture as the workbench branch
      // below, which simply returns. Without this, dragging a door onto another door or onto a
      // workbench silently succeeded, producing the exact layout the workbench-side toast prevents.
      const dOthers = items.filter((i) => i.id !== dragging.id);
      const dCand = { ...it, ...sn, widthFt: iWidthFt };
      if (checkDoorCollision(dCand, { ...cfg, width: iWidthFt }, dOthers, ITEMS, scale)) return;
      if (checkWorkbenchOverlap(sn, iWidthFt * scale, dOthers, ITEMS, scale)) return;
      // A ramp snapped to this door must follow it (position + wall); otherwise it
      // detaches and the stale geometry is rasterized into the exported PDF. (audit #F4)
      // rampPlacementForDoor honours the ramp's own depth (catalog ramps vary), so it
      // supersedes the fixed-depth relocRamp beta shipped for the same fix.
      setItems((p) => p.map((i) => {
        if (i.id === dragging.id) return { ...i, ...sn };
        if (i.type === "ramp" && i.snapDoorId === dragging.id) {
          const rp = rampPlacementForDoor(sn, i.heightFt, pW, pH, mgX, mgY, scale);
          return rp ? { ...i, ...rp } : i;
        }
        return i;
      }));
    } else if (cfg.wallSnap) {
      const nw = getNearestWall(rx, ry, pW, pH, mgX, mgY);
      const sn = snapToWallInterior(nw, rx, ry, iWidthFt * scale, cfg.height * scale, pW, pH, mgX, mgY);
      const cand = { ...it, ...sn };
      // Check collision with doors AND other workbenches on same wall
      const others = items.filter((i) => i.id !== dragging.id);
      if (checkDoorCollision(cand, { ...cfg, width: iWidthFt }, others, ITEMS, scale)) return;
      // Check workbench overlap on same wall
      const isH = sn.wall === "north" || sn.wall === "south";
      const candPos = isH ? sn.x : sn.y;
      const candHalf = iWidthFt * scale / 2;
      for (const ob of others) {
        if (ob.type !== "workbench" || ob.wall !== sn.wall) continue;
        const obW = (ob.widthFt || ITEMS[ob.type].width) * scale / 2;
        const obPos = isH ? ob.x : ob.y;
        if (Math.abs(candPos - obPos) < candHalf + obW - 2) return; // overlap
      }
      setItems((p) => p.map((i) => i.id === dragging.id ? { ...i, ...sn } : i));
    } else {
      // Notes drag anywhere on the visible page (no plan constraint)
      if (cfg.noteType) {
        const x = Math.max(20, Math.min(rx, PAGE_W - 20));
        const y = Math.max(20, Math.min(ry, TEXT_BAND_TOP - 20));
        setItems((p) => p.map((i) => i.id === dragging.id ? { ...i, x, y } : i));
        return;
      }

      const iHeightFt = it.heightFt || cfg.height;
      const halfW = iWidthFt / 2, halfH = iHeightFt / 2;
      const snapFt = 1; // snap threshold in feet

      // Convert desired position to feet
      let cxFt = (rx - mgX) / scale;
      let cyFt = (ry - mgY) / scale;

      // Round to integer feet
      cxFt = Math.round(cxFt);
      cyFt = Math.round(cyFt);

      // Snap edges to walls
      if (cxFt - halfW < snapFt) cxFt = halfW;
      else if (cxFt + halfW > bldgW - snapFt) cxFt = bldgW - halfW;
      if (cyFt - halfH < snapFt) cyFt = halfH;
      else if (cyFt + halfH > bldgH - snapFt) cyFt = bldgH - halfH;

      // Snap edges to other lofts
      if (it.type === "loft") {
        const otherLofts = items.filter((i) => i.type === "loft" && i.id !== dragging.id);
        let l = cxFt - halfW, r = cxFt + halfW, t = cyFt - halfH, b = cyFt + halfH;
        for (const o of otherLofts) {
          const oW = (o.widthFt || cfg.width) / 2, oH = (o.heightFt || cfg.height) / 2;
          const oCx = (o.x - mgX) / scale, oCy = (o.y - mgY) / scale;
          const oL = oCx - oW, oR = oCx + oW, oT = oCy - oH, oB = oCy + oH;
          if (t < oB && b > oT) {
            if (Math.abs(r - oL) < snapFt) cxFt = oL - halfW;
            else if (Math.abs(l - oR) < snapFt) cxFt = oR + halfW;
          }
          if (l < oR && r > oL) {
            if (Math.abs(b - oT) < snapFt) cyFt = oT - halfH;
            else if (Math.abs(t - oB) < snapFt) cyFt = oB + halfH;
          }
          l = cxFt - halfW; r = cxFt + halfW; t = cyFt - halfH; b = cyFt + halfH;
        }

        // Constrain to building
        cxFt = Math.max(halfW, Math.min(cxFt, bldgW - halfW));
        cyFt = Math.max(halfH, Math.min(cyFt, bldgH - halfH));

        // Check overlap — reject if overlapping any loft
        const fL = cxFt - halfW, fR = cxFt + halfW, fT = cyFt - halfH, fB = cyFt + halfH;
        for (const o of otherLofts) {
          const oW2 = (o.widthFt || cfg.width) / 2, oH2 = (o.heightFt || cfg.height) / 2;
          const oCx2 = (o.x - mgX) / scale, oCy2 = (o.y - mgY) / scale;
          if (fL < oCx2 + oW2 - 0.1 && fR > oCx2 - oW2 + 0.1 && fT < oCy2 + oH2 - 0.1 && fB > oCy2 - oH2 + 0.1) return;
        }

        // Validate attachment — both ends of at least one axis must touch walls or other lofts
        const olEdges = otherLofts.map((o) => {
          const ow = (o.widthFt || cfg.width) / 2, oh = (o.heightFt || cfg.height) / 2;
          const ox = (o.x - mgX) / scale, oy = (o.y - mgY) / scale;
          return { l: ox - ow, r: ox + ow, t: oy - oh, b: oy + oh };
        });
        if (!checkLoftAttached(fL, fR, fT, fB, bldgW, bldgH, olEdges)) {
          setItems((p) => p.map((i) => i.id === dragging.id ? { ...i, x: mgX + cxFt * scale, y: mgY + cyFt * scale } : i));
          return;
        }
      } else {
        cxFt = Math.max(halfW, Math.min(cxFt, bldgW - halfW));
        cyFt = Math.max(halfH, Math.min(cyFt, bldgH - halfH));
      }

      const x = mgX + cxFt * scale;
      const y = mgY + cyFt * scale;
      setItems((p) => p.map((i) => i.id === dragging.id ? { ...i, x, y } : i));
    }
  }, [dragging, resizing, getSvgPt, items, mgX, mgY, pW, pH, scale, ITEMS, getResizeBounds]);

  const onPtrUp = useCallback(() => {
    // Dropping a note's leader handle back onto the note removes the pointer
    // ("drag it home to delete it") — checked on release, not mid-drag, so the
    // handle doesn't vanish under the cursor while crossing the note.
    if (resizing && resizing.handle === "leader") {
      setItems((p) => p.map((i) => {
        if (i.id !== resizing.id || !i.leader) return i;
        const w = i.widthPx || 160, h = i.heightPx || 40;
        const inside = Math.abs(i.leader.x - i.x) < w / 2 + 6 && Math.abs(i.leader.y - i.y) < h / 2 + 6;
        return inside ? { ...i, leader: undefined } : i;
      }));
    }
    setDragging(null);
    setResizing(null);
    // Swallow the trailing click ONLY if the gesture actually moved — a
    // stationary press must remain a click so clicking a selected note can
    // enter in-place edit (an unconditional swallow made notes uneditable).
    justGesturedRef.current = movedRef.current;
    movedRef.current = false;
    gestureStartRef.current = null;
  }, [resizing]);

  useEffect(() => {
    if (dragging || resizing) {
      window.addEventListener("mousemove", onPtrMove); window.addEventListener("mouseup", onPtrUp);
      window.addEventListener("touchmove", onPtrMove, { passive: false }); window.addEventListener("touchend", onPtrUp);
      return () => { window.removeEventListener("mousemove", onPtrMove); window.removeEventListener("mouseup", onPtrUp); window.removeEventListener("touchmove", onPtrMove); window.removeEventListener("touchend", onPtrUp); };
    }
  }, [dragging, resizing, onPtrMove, onPtrUp]);

  // Deleting a door also removes its attached ramp — a ramp can't exist
  // without the door it's snapped to.
  const delSel = () => { if (selectedId) { setItems((p) => p.filter((i) => i.id !== selectedId && !(i.type === "ramp" && i.snapDoorId === selectedId))); setSelectedId(null); setEditingNoteId(null); } };
  // Rotate the selection.
  //
  // Lofts are handled by SWAPPING widthFt/heightFt rather than by setting a rotation angle, and
  // that is the whole fix for the rotated-loft class of bug. Both renderers honour `rotation` (SVG
  // transform, canvas ctx.rotate) and the hit test swaps the bbox for 90/270 — but EVERY piece of
  // loft geometry ignored it: the loft-vs-loft overlap checks, the resize clamps, the drag
  // containment clamp (halfW/halfH from the UNROTATED widthFt/heightFt) and checkLoftAttached /
  // the unattachedLofts banner. So one click on Rotate could leave a 10x4 loft rendering as 4x10,
  // sticking 3ft outside the north wall with no warning, visually overlapping another loft, and
  // reporting attached/unattached wrongly — and that geometry is what gets rasterized into the PDF
  // the customer signs against and the shop builds from.
  //
  // A loft is an axis-aligned resizable rectangle, so a 90-degree turn IS a width/height swap;
  // expressing it that way keeps `rotation` at 0 and leaves every invariant above valid as
  // written, instead of teaching six separate places about rotation. The swap is validated exactly
  // like a drag: clamp the centre back inside the building, then refuse if the new footprint would
  // overlap another loft or no longer fit.
  //
  // doorSnap items (ramps) are excluded too: a ramp's position and rotation are DERIVED from the
  // door it is attached to, and it deliberately cannot be dragged — rotating it only desynced it
  // from its door.
  const rotSel = () => {
    if (!selectedId) return;
    const sel = items.find((i) => i.id === selectedId);
    if (!sel) return;
    const c = ITEMS[sel.type];
    if (c && (c.wallOnly || c.wallSnap || c.lineType || c.doorSnap)) return;

    if (sel.type === "loft") {
      const curW = sel.widthFt || c.width, curH = sel.heightFt || c.height;
      const newW = curH, newH = curW;
      if (newW > bldgW || newH > bldgH) {
        setToast("Turning this loft won't fit inside the building. Resize it first.");
        setTimeout(() => setToast(null), 4000);
        return;
      }
      const halfW = newW / 2, halfH = newH / 2;
      let cxFt = (sel.x - mgX) / scale, cyFt = (sel.y - mgY) / scale;
      cxFt = Math.max(halfW, Math.min(cxFt, bldgW - halfW));
      cyFt = Math.max(halfH, Math.min(cyFt, bldgH - halfH));
      const fL = cxFt - halfW, fR = cxFt + halfW, fT = cyFt - halfH, fB = cyFt + halfH;
      for (const o of items) {
        if (o.id === sel.id || o.type !== "loft") continue;
        const oW = (o.widthFt || c.width) / 2, oH = (o.heightFt || c.height) / 2;
        const oCx = (o.x - mgX) / scale, oCy = (o.y - mgY) / scale;
        if (fL < oCx + oW - 0.1 && fR > oCx - oW + 0.1 && fT < oCy + oH - 0.1 && fB > oCy - oH + 0.1) {
          setToast("Turning this loft would overlap another loft. Move one of them first.");
          setTimeout(() => setToast(null), 4000);
          return;
        }
      }
      setItems((p) => p.map((i) => i.id !== selectedId ? i : {
        ...i, widthFt: newW, heightFt: newH, rotation: 0,
        x: mgX + cxFt * scale, y: mgY + cyFt * scale,
      }));
      return;
    }

    setItems((p) => p.map((i) => i.id !== selectedId ? i : { ...i, rotation: ((i.rotation || 0) + 90) % 360 }));
  };
  const clearAll = () => { setItems([]); setSelectedId(null); setEditingNoteId(null); };

  // ─── EXPORT RENDERING (shared by Export modal, PDF, and submit) ───
  // The on-screen SVG already uses page coordinates (cW × cH = 850 × 1100),
  // so the export is a straight 2× DPR rasterization — same scale, same mgX/mgY,
  // same item positions. No coordinate conversion needed.
  const renderExportCanvas = () => {
    const dpr = 2;
    const canvas = document.createElement("canvas");
    canvas.width = cW * dpr; canvas.height = cH * dpr;
    const ctx = canvas.getContext("2d"); ctx.scale(dpr, dpr);
    ctx.fillStyle = "#FFF"; ctx.fillRect(0, 0, cW, cH);

    // Grid + plan border
    ctx.strokeStyle = "#E8ECF1"; ctx.lineWidth = 0.5;
    for (let fx = 0; fx <= bldgW; fx++) { const x = mgX + fx * scale; ctx.beginPath(); ctx.moveTo(x, mgY); ctx.lineTo(x, mgY + pH); ctx.stroke(); }
    for (let fy = 0; fy <= bldgH; fy++) { const y = mgY + fy * scale; ctx.beginPath(); ctx.moveTo(mgX, y); ctx.lineTo(mgX + pW, y); ctx.stroke(); }
    ctx.strokeStyle = "#1E293B"; ctx.lineWidth = WALL_THICKNESS; ctx.strokeRect(mgX, mgY, pW, pH);

    // Items render in page coordinates directly — same as the SVG.
    // Ramps render first so other items (workbench, doors, etc) sit on top of them.
    [...items].sort((a, b) => (a.type === "ramp" ? 0 : 1) - (b.type === "ramp" ? 0 : 1)).forEach((item) => {
      const cfg = ITEMS[item.type]; if (!cfg) return;

      // Line: free-angle segment between two endpoints (page coords)
      if (cfg.lineType) {
        ctx.save();
        ctx.strokeStyle = cfg.color; ctx.lineWidth = 2.5; ctx.lineCap = "round";
        ctx.beginPath();
        ctx.moveTo(item.x1, item.y1);
        ctx.lineTo(item.x2, item.y2);
        ctx.stroke();
        ctx.restore();
        return;
      }

      // Text Note: resizable pill with word-wrapped text (page coords)
      if (cfg.noteType) {
        const text = (item.text || "").trim() || "Note";
        const w = item.widthPx || 160;
        const h = item.heightPx || 40;
        const padX = 8;
        // Leader (pointer) line: dashed from the pill's edge to the target dot.
        // Drawn first (absolute page coords) so the pill sits on top of it.
        if (item.leader) {
          const ep = noteEdgePoint(item.x, item.y, w, h, item.leader.x, item.leader.y);
          const ldx = item.leader.x - ep.x, ldy = item.leader.y - ep.y;
          if (Math.sqrt(ldx * ldx + ldy * ldy) > 10) {
            ctx.save();
            ctx.strokeStyle = cfg.color; ctx.lineWidth = 1.5; ctx.setLineDash([5, 4]);
            ctx.beginPath(); ctx.moveTo(ep.x, ep.y); ctx.lineTo(item.leader.x, item.leader.y); ctx.stroke();
            ctx.setLineDash([]);
            ctx.fillStyle = cfg.color;
            ctx.beginPath(); ctx.arc(item.leader.x, item.leader.y, 3.5, 0, Math.PI * 2); ctx.fill();
            ctx.restore();
          }
        }
        ctx.save();
        ctx.translate(item.x, item.y);
        ctx.fillStyle = "#FFFBEB"; ctx.strokeStyle = cfg.color; ctx.lineWidth = 1.25;
        const r = 4;
        ctx.beginPath();
        ctx.moveTo(-w / 2 + r, -h / 2);
        ctx.lineTo(w / 2 - r, -h / 2);
        ctx.quadraticCurveTo(w / 2, -h / 2, w / 2, -h / 2 + r);
        ctx.lineTo(w / 2, h / 2 - r);
        ctx.quadraticCurveTo(w / 2, h / 2, w / 2 - r, h / 2);
        ctx.lineTo(-w / 2 + r, h / 2);
        ctx.quadraticCurveTo(-w / 2, h / 2, -w / 2, h / 2 - r);
        ctx.lineTo(-w / 2, -h / 2 + r);
        ctx.quadraticCurveTo(-w / 2, -h / 2, -w / 2 + r, -h / 2);
        ctx.fill(); ctx.stroke();
        ctx.font = "600 12px sans-serif";
        ctx.fillStyle = cfg.color; ctx.textAlign = "center"; ctx.textBaseline = "middle";
        // Word-wrap to fit the box width
        const maxW = w - padX * 2;
        const words = text.split(/\s+/);
        const lines = [];
        let line = "";
        for (const word of words) {
          const test = line ? line + " " + word : word;
          if (ctx.measureText(test).width > maxW && line) {
            lines.push(line); line = word;
          } else {
            line = test;
          }
        }
        if (line) lines.push(line);
        const lineHeight = 14;
        const totalH = lines.length * lineHeight;
        let ly = -totalH / 2 + lineHeight / 2;
        for (const ln of lines) { ctx.fillText(ln, 0, ly); ly += lineHeight; }
        ctx.restore();
        return;
      }

      // Plan-bound items: position is already in page coords; widths are in feet
      const itemW = item.widthFt || cfg.width;
      const itemH = item.heightFt || cfg.height;
      const iw = itemW * scale; const ih = itemH * scale;
      ctx.save(); ctx.translate(item.x, item.y); ctx.rotate((item.rotation * Math.PI) / 180);
      if (item.type === "loft") {
        ctx.fillStyle = cfg.color + "25"; ctx.strokeStyle = cfg.color; ctx.lineWidth = 2; ctx.setLineDash([6, 4]);
        ctx.fillRect(-iw / 2, -ih / 2, iw, ih); ctx.strokeRect(-iw / 2, -ih / 2, iw, ih); ctx.setLineDash([]);
        ctx.save();
        ctx.beginPath(); ctx.rect(-iw / 2, -ih / 2, iw, ih); ctx.clip();
        ctx.strokeStyle = cfg.color + "40"; ctx.lineWidth = 1;
        for (let d = -iw; d < iw + ih; d += 12) { ctx.beginPath(); ctx.moveTo(-iw / 2 + d, -ih / 2); ctx.lineTo(-iw / 2 + d - ih, ih / 2); ctx.stroke(); }
        ctx.restore();
      } else if (cfg.wallOnly) {
        // Rounded rect for door/window bar (matches SVG rx=1)
        const barH = 10, barR = 1;
        ctx.fillStyle = item.type === "roughOpening" ? "#FFFFFF" : item.type === "fixtureDoor" ? fixtureDoorColor(item) : cfg.color;
        ctx.beginPath();
        ctx.moveTo(-iw / 2 + barR, -barH / 2);
        ctx.lineTo(iw / 2 - barR, -barH / 2);
        ctx.quadraticCurveTo(iw / 2, -barH / 2, iw / 2, -barH / 2 + barR);
        ctx.lineTo(iw / 2, barH / 2 - barR);
        ctx.quadraticCurveTo(iw / 2, barH / 2, iw / 2 - barR, barH / 2);
        ctx.lineTo(-iw / 2 + barR, barH / 2);
        ctx.quadraticCurveTo(-iw / 2, barH / 2, -iw / 2, barH / 2 - barR);
        ctx.lineTo(-iw / 2, -barH / 2 + barR);
        ctx.quadraticCurveTo(-iw / 2, -barH / 2, -iw / 2 + barR, -barH / 2);
        ctx.fill();
        if (item.type === "roughOpening") { ctx.strokeStyle = "#000000"; ctx.lineWidth = 1.5; ctx.stroke(); }
        if (item.type === "singleDoor") {
          ctx.strokeStyle = cfg.color + "60"; ctx.lineWidth = 1.5; ctx.setLineDash([4, 3]);
          const out = item.wall === "north" || item.wall === "east";
          ctx.beginPath(); ctx.arc(-iw / 2, 0, iw * 0.8, 0, out ? -Math.PI / 2 : Math.PI / 2, out); ctx.stroke(); ctx.setLineDash([]);
        } else if (item.type === "doubleDoor") {
          ctx.strokeStyle = cfg.color + "60"; ctx.lineWidth = 1.5; ctx.setLineDash([4, 3]);
          const out = item.wall === "north" || item.wall === "east";
          const r = iw * 0.4;
          // Left leaf: hinge at left edge of door
          ctx.beginPath(); ctx.arc(-iw / 2, 0, r, 0, out ? -Math.PI / 2 : Math.PI / 2, out); ctx.stroke();
          // Right leaf: hinge at right edge of door
          ctx.beginPath(); ctx.arc(iw / 2, 0, r, Math.PI, out ? 3 * Math.PI / 2 : Math.PI / 2, !out); ctx.stroke();
          ctx.setLineDash([]); ctx.strokeStyle = "#FFF"; ctx.lineWidth = 1.5; ctx.beginPath(); ctx.moveTo(0, -5); ctx.lineTo(0, 5); ctx.stroke();
        } else if (item.type === "fixtureDoor") {
          fixtureDoorCanvas(ctx, item, iw, fixtureDoorColor(item));
        } else if (item.type === "window") {
          ctx.strokeStyle = "#FFF"; ctx.lineWidth = 1.5;
          [0, -iw / 4, iw / 4].forEach((lx) => { ctx.beginPath(); ctx.moveTo(lx, -4); ctx.lineTo(lx, 4); ctx.stroke(); });
        }
      } else {
        ctx.fillStyle = cfg.color + (item.type === "ramp" ? "12" : "30");
        ctx.strokeStyle = cfg.color + (item.type === "ramp" ? "80" : "FF");
        ctx.lineWidth = item.type === "ramp" ? 1.5 : 2;
        ctx.fillRect(-iw / 2, -ih / 2, iw, ih); ctx.strokeRect(-iw / 2, -ih / 2, iw, ih);
      }
      ctx.fillStyle = "#1E293B"; ctx.font = "bold 11px sans-serif"; ctx.textAlign = "center";
      if (item.type === "workbench") { ctx.fillText(`${itemW} ft`, 0, 0); ctx.font = "9px sans-serif"; ctx.fillText("Workbench", 0, 13); }
      else if (item.type === "ramp") { ctx.textAlign = "left"; ctx.fillText(item.planLabel || "RAMP", -iw / 2 + 5, 4); }
      else if (item.type === "loft") { ctx.fillStyle = cfg.color; ctx.fillText("LOFT", 0, 0); ctx.font = "10px sans-serif"; ctx.globalAlpha = 0.7; ctx.fillText(`${itemW}×${itemH} ft`, 0, 14); ctx.globalAlpha = 1; }
      else {
        const lblY = cfg.wallOnly ? ((item.wall === "north" || item.wall === "east") ? 14 : -10) : 4;
        let label = cfg.shortLabel;
        if (item.type === "fixtureDoor") label = item.planLabel || cfg.shortLabel;
        if (item.type === "window") label = item.planLabel || cfg.shortLabel;
        if (item.type === "roughOpening") {
          const idx = items.filter((i) => i.type === "roughOpening").findIndex((r) => r.id === item.id);
          label = `RO-${idx + 1}`;
        }
        // Doors + windows prefix their width, e.g. "6' DD".
        if (item.type === "singleDoor" || item.type === "doubleDoor" || item.type === "fixtureDoor" || item.type === "window") {
          const w = fmtFtIn((item.widthFt || cfg.width) * 12);
          if (w) label = `${w} ${label}`;
        }
        ctx.fillText(label, 0, lblY);
      }
      ctx.restore();
    });

    // Size labels + FRONT/BACK/LEFT/RIGHT — drawn after items so a centered ramp doesn't paint over the building chrome.
    ctx.fillStyle = "#475569"; ctx.font = "bold 13px sans-serif"; ctx.textAlign = "center";
    ctx.fillText(`${bldgW} ft`, mgX + pW / 2, mgY - 16);
    ctx.fillText(`${bldgW} ft`, mgX + pW / 2, mgY + pH + 26);
    ctx.save(); ctx.translate(mgX - 20, mgY + pH / 2); ctx.rotate(-Math.PI / 2); ctx.fillText(`${bldgH} ft`, 0, 0); ctx.restore();
    ctx.save(); ctx.translate(mgX + pW + 24, mgY + pH / 2); ctx.rotate(Math.PI / 2); ctx.fillText(`${bldgH} ft`, 0, 0); ctx.restore();
    if (frontWall) {
      ctx.fillStyle = "#94A3B8"; ctx.font = "10px sans-serif";
      ctx.fillText(getDisplayLabel("north", frontWall), mgX + pW / 2, mgY - 32);
      ctx.fillText(getDisplayLabel("south", frontWall), mgX + pW / 2, mgY + pH + 42);
      ctx.save(); ctx.translate(mgX - 38, mgY + pH / 2); ctx.rotate(-Math.PI / 2); ctx.fillText(getDisplayLabel("west", frontWall), 0, 0); ctx.restore();
      ctx.save(); ctx.translate(mgX + pW + 42, mgY + pH / 2); ctx.rotate(Math.PI / 2); ctx.fillText(getDisplayLabel("east", frontWall), 0, 0); ctx.restore();
    }

    // ─── Bottom text band ───
    const TEXT_X = 36;
    const TEXT_RIGHT = cW - 36;
    const TEXT_W = TEXT_RIGHT - TEXT_X;
    const textTop = TEXT_BAND_TOP;
    let textY = textTop + 24;

    // Separator
    ctx.strokeStyle = "#E2E8F0"; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(TEXT_X, textTop); ctx.lineTo(TEXT_RIGHT, textTop); ctx.stroke();

    const customerName = contact.name || "Customer";
    const customerAddr = [contact.street, contact.city, contact.state, contact.zip].filter(Boolean).join(", ");

    // Line 1: Name (left) | Size + Style (right)
    ctx.fillStyle = "#1E293B"; ctx.font = "bold 16px sans-serif";
    ctx.textAlign = "left"; ctx.fillText(customerName, TEXT_X, textY);
    ctx.textAlign = "right"; ctx.fillText(`${bldgW}×${bldgH}  ${sel.style || ""}`, TEXT_RIGHT, textY);
    textY += 22;

    // Line 2-3: Contact info + address
    ctx.fillStyle = "#64748B"; ctx.font = "13px sans-serif"; ctx.textAlign = "left";
    const infoLine = [contact.phone, contact.email].filter(Boolean).join("  •  ");
    if (infoLine) { ctx.fillText(infoLine, TEXT_X, textY); textY += 17; }
    if (customerAddr) { ctx.fillText(customerAddr, TEXT_X, textY); textY += 19; }

    // Build bullet list (paint + placed items + custom options)
    const bullets = [];
    if (sel.paint === "Painted") {
      const body = paintColors.body || "TBD"; const trim = paintColors.trim || "TBD";
      bullets.push(`Painted — Body: ${body}, Trim: ${trim}`);
    } else { bullets.push("Unpainted"); }
    if (sel.roofType) bullets.push(`Roof — ${sel.roofType}${sel.roofColor ? `: ${sel.roofColor}` : ""}`);
    const sdCount = items.filter((i) => i.type === "singleDoor").length;
    const ddCount = items.filter((i) => i.type === "doubleDoor").length;
    if (sdCount > 0) bullets.push(`Single Door${sdCount > 1 ? " ×" + sdCount : ""}`);
    if (ddCount > 0) bullets.push(`Double Door${ddCount > 1 ? " ×" + ddCount : ""}`);
    // Catalog fixture doors — one bullet per placed door with its full spec (name, size,
    // swing, operation), driven by the placed items so ANY catalog door lists automatically
    // (nothing hard-coded per door). Windows/ramps will slot in the same way later.
    items.filter((i) => i.type === "fixtureDoor").forEach((d) => {
      const parts = [];
      if (d.widthIn && d.heightIn) parts.push(`${fmtFtIn(d.widthIn)}×${fmtFtIn(d.heightIn)}`);
      const sw = d.swing === "in" ? "in-swing" : d.swing === "out" ? "out-swing" : "";
      if (sw) parts.push(sw);
      const op = d.operation === "slideup" ? "slide up" : d.operation === "double" ? "double" : d.operation === "right" ? "right hinge" : d.operation === "left" ? "left hinge" : "";
      if (op) parts.push(op);
      if (d.colorLabel) parts.push(d.trimColorLabel ? `${d.colorLabel} / ${d.trimColorLabel} trim` : d.colorLabel);
      bullets.push(`${d.doorName || "Door"}${parts.length ? " — " + parts.join(", ") : ""}`);
    });
    // Catalog windows get their own spec bullet (name, size, color) like doors; the plain
    // count line now covers built-in windows only.
    items.filter((i) => i.type === "window" && i.fixtureItemId).forEach((w) => {
      const parts = [];
      if (w.widthIn && w.heightIn) parts.push(`${fmtFtIn(w.widthIn)}×${fmtFtIn(w.heightIn)}`);
      if (w.colorLabel) parts.push(w.colorLabel);
      bullets.push(`${w.windowName || "Window"}${parts.length ? " — " + parts.join(", ") : ""}`);
    });
    const winCount = items.filter((i) => i.type === "window" && !i.fixtureItemId).length;
    if (winCount > 0) bullets.push(`Window${winCount > 1 ? "s ×" + winCount : ""}`);
    items.filter((i) => i.type === "workbench").forEach((wb) => bullets.push(`${wb.widthFt}ft Workbench`));
    const loftItems = items.filter((i) => i.type === "loft");
    if (loftItems.length > 0) {
      const loftSqft = Math.round(loftItems.reduce((s, l) => s + (Number(l.widthFt) || 0) * (Number(l.heightFt) || 0), 0));
      bullets.push(`Loft${loftItems.length > 1 ? " ×" + loftItems.length : ""} — ${loftSqft} sq ft`);
    }
    const rampCount = items.filter((i) => i.type === "ramp").length;
    if (rampCount > 0) bullets.push(`Ramp${rampCount > 1 ? " ×" + rampCount : ""}`);
    items.filter((i) => i.type === "roughOpening").forEach((ro, idx) => {
      const d = (roDimensions[ro.id] || "").trim();
      const label = `RO-${idx + 1}`;
      bullets.push(d ? `${label} — ${d}` : label);
    });
    // Lines and notes are not bulleted — they already render at their position on the page.
    customOptions.forEach((co) => {
      if (co.name && co.name.trim()) {
        const q = co.qty && parseInt(co.qty) > 0 ? ` (×${co.qty})` : "";
        bullets.push(co.name.trim() + q);
      }
    });

    // 2-column bullets
    if (bullets.length > 0) {
      textY += 6;
      ctx.fillStyle = "#334155"; ctx.font = "13px sans-serif"; ctx.textAlign = "left";
      const colW = TEXT_W / 2;
      const half = Math.ceil(bullets.length / 2);
      for (let i = 0; i < half; i++) {
        ctx.fillText("•  " + bullets[i], TEXT_X, textY);
        if (i + half < bullets.length) ctx.fillText("•  " + bullets[i + half], TEXT_X + colW, textY);
        textY += 18;
      }
    }

    return canvas;
  };

  const generatePNG = () => renderExportCanvas().toDataURL("image/png");

  const exportPNG = () => {
    setExportUrl(generatePNG()); setShowExport(true);
  };

  // ─── ADMIN: GHL credentials management ───
  // Both helpers call the admin-save-settings Edge Function; the password is verified
  // server-side against ADMIN_PASSWORD. The API key, once saved, is never returned to
  // the browser — checkAdminStatus only reports configured/not + a masked location ID.
  const checkAdminStatus = async () => {
    if (!supabase) { setAdminMsg({ ok: false, msg: "Supabase not configured." }); return; }
    if (!adminPwd) { setAdminMsg({ ok: false, msg: "Enter the admin password first." }); return; }
    setAdminBusy(true); setAdminMsg(null);
    try {
      const { data, error } = await supabase.functions.invoke("admin-save-settings", {
        body: { adminPassword: adminPwd, clientId: C.clientId, action: "status" },
      });
      if (error) throw new Error(error.message || "Status check failed");
      if (!data?.ok) throw new Error(data?.error || "Status check failed");
      setAdminStatus(data);
    } catch (e) {
      setAdminMsg({ ok: false, msg: e.message }); setAdminStatus(null);
    } finally { setAdminBusy(false); }
  };
  const saveAdminSettings = async () => {
    if (!supabase) { setAdminMsg({ ok: false, msg: "Supabase not configured." }); return; }
    if (!adminPwd || !adminLocId || !adminApiKey) {
      setAdminMsg({ ok: false, msg: "Fill in admin password, location ID, and API key." });
      return;
    }
    setAdminBusy(true); setAdminMsg(null);
    try {
      const { data, error } = await supabase.functions.invoke("admin-save-settings", {
        body: { adminPassword: adminPwd, clientId: C.clientId, ghlLocationId: adminLocId, ghlApiKey: adminApiKey },
      });
      if (error) throw new Error(error.message || "Save failed");
      if (!data?.ok) throw new Error(data?.error || "Save failed");
      setAdminMsg({ ok: true, msg: "GHL settings saved." });
      setAdminApiKey(""); // Clear the key from React state once it's persisted
      // Refresh status indicator
      const { data: st } = await supabase.functions.invoke("admin-save-settings", {
        body: { adminPassword: adminPwd, clientId: C.clientId, action: "status" },
      });
      if (st?.ok) setAdminStatus(st);
    } catch (e) {
      setAdminMsg({ ok: false, msg: e.message });
    } finally { setAdminBusy(false); }
  };

  // ─── ADMIN: 3D style calibration handlers ───
  // The four-side photos are the calibration REFERENCE (the IdeaRoom onboarding
  // workflow): a human — or the calibrate-style function — reads the roof/
  // siding/color parameters off them into the style's d3 spec; the parametric
  // engine renders from the spec, never from the photos.
  // The size labels available for the style being calibrated. Same precedence the scan's
  // closest-match list uses (a style's own `sizes`, falling back to the tenant default set)
  // and the same tolerance for string-or-{label} entries, because both read the same
  // catalog shape. Keyed off adminCal.styleValue rather than sel.style: on this surface the
  // calibrated style and the "selected" style are the same thing, and reading sel.style
  // would make the list empty until a size had already been picked.
  const calSizeOpts = () => {
    const st = ((C && C.buildingStyles) || []).find((x) => x.value === (adminCal && adminCal.styleValue));
    const labels = st && Array.isArray(st.sizes) && st.sizes.length ? st.sizes : ((C && C.defaultSizes) || []);
    return labels.map((l) => (typeof l === "string" ? l : (l && l.label))).filter(Boolean);
  };
  // The sample building the calibration preview renders on. Writes sel, which the [sel.size]
  // effect turns into bldgW/bldgH -- so the 3D panel remounts and re-frames for the new
  // footprint. Only ever called from the calibrationOnly surface: in the full designer this
  // same panel sits over a customer's plan, and moving their style/size would clear it.
  const calSetSize = (label) => setSel((p) => ({ ...p, style: adminCal.styleValue, size: label }));
  // The size closest to the middle of the list by floor area — a fairer test of a roof pitch
  // or a gambrel knee than the component's 10x12 default, which is the smallest thing anyone
  // sells. Median rather than mean so one 14x40 in the list cannot drag the pick to the end.
  const calMidSize = (styleValue) => {
    const st = ((C && C.buildingStyles) || []).find((x) => x.value === styleValue);
    const labels = st && Array.isArray(st.sizes) && st.sizes.length ? st.sizes : ((C && C.defaultSizes) || []);
    const sized = labels
      .map((l) => (typeof l === "string" ? l : (l && l.label)))
      .filter(Boolean)
      .map((label) => ({ label, p: parseSize(label) }))
      .filter((x) => x.p)
      .sort((a, b) => (a.p.w * a.p.h) - (b.p.w * b.p.h));
    return sized.length ? sized[Math.floor((sized.length - 1) / 2)].label : "";
  };
  const openCalEditor = (s) => {
    setAdminCalMsg(null);
    setAdminCalPreview(false);
    setAdminCal({
      styleValue: s.value,
      spec: d3ResolveStyleSpec(s, s.value, C.wallHeightFt),
      // s.d3Photos is empty as of migration 093: these are a builder's photos of their own
      // REAL buildings, and get_config is the call the anonymous customer page makes, so they
      // are no longer in that payload. The portal re-fetches them over its authenticated
      // session below; the standalone ?admin=1 path has no session and so starts blank.
      photos: (s.d3Photos || []).concat(["", "", "", ""]).slice(0, 4),
    });
    // Put the preview on a representative building instead of the component's 10x12 default
    // (sel.size starts "", so the [sel.size] effect has never fired on this surface and
    // bldgW/bldgH sit at their useState values). calibrationOnly ONLY: this same panel also
    // renders over the full designer on the ?admin=1 operator path, where writing sel would
    // change the style and size out from under a customer's plan and clear it.
    if (calibrationOnly) {
      const mid = calMidSize(s.value);
      if (mid) setSel((p) => ({ ...p, style: s.value, size: mid }));
    }
    setScan({ busy: false, step: null, err: null, measured: null, file: null, status: "none", aiReady: null });
    // Reset with the scan: cached frame URLs belong to the style they were filmed for, and
    // carrying them across would draft the next style from the previous building.
    setAdminCalVideo({ busy: false, step: null, err: null, count: 0, urls: null, observed: null, read: 0 });
    // One authenticated read gives everything the customer config deliberately does not carry:
    // the reference photos (a builder's own buildings — see 093), this style's scan status, and
    // whether AI drafting is even configured on the server.
    if (setup3d && setup3d.onLoadStyle3D) {
      setup3d.onLoadStyle3D(s.value).then((meta) => {
        if (!meta) return;
        setAdminCal((p) => (p && p.styleValue === s.value && Array.isArray(meta.photos) && meta.photos.length
          ? { ...p, photos: meta.photos.filter(Boolean).concat(["", "", "", ""]).slice(0, 4) }
          : p));
        setScan((p) => ({ ...p, status: meta.modelStatus || "none", aiReady: meta.aiReady !== false }));
      }).catch(() => { /* a convenience read; never block the editor */ });
    }
  };
  const calSet = (patch) => setAdminCal((p) => ({ ...p, spec: { ...p.spec, ...patch } }));
  const calSetRoof = (patch) => setAdminCal((p) => ({ ...p, spec: { ...p.spec, roof: { ...p.spec.roof, ...patch } } }));
  const calSetColor = (k, v) => setAdminCal((p) => ({ ...p, spec: { ...p.spec, colors: { ...p.spec.colors, [k]: v } } }));
  const calSetPhoto = (i, v) => setAdminCal((p) => { const ph = p.photos.slice(); ph[i] = v; return { ...p, photos: ph }; });
  // A drafted spec MERGES into the draft rather than replacing it: the model reports only
  // what the photos actually show, so anything it leaves out keeps the value the editor
  // (or the style default) already had.
  const applyDraftedSpec = (d3) => setAdminCal((p) => ({
    ...p,
    spec: {
      // ...p.spec FIRST, for the same reason d3ResolveStyleSpec names every key: an object
      // literal keeps only what it lists. Without this line a photo draft silently blanked
      // roofMaterial, gableVent, foundation and claddingChoices -- fields the model is never
      // even ASKED about by SPEC_PROMPT, so they could only ever be erased, never replaced.
      ...p.spec,
      roof: { ...p.spec.roof, ...(d3.roof || {}) },
      siding: d3.siding !== undefined ? d3.siding : p.spec.siding,
      colors: { ...p.spec.colors, ...(d3.colors || {}) },
      wallHeightFt: d3.wallHeightFt || p.spec.wallHeightFt,
    },
  }));

  // The SHAPE-only merge, for a draft read off a walk-around video. It deliberately does
  // NOT reuse applyDraftedSpec above: sanitizeD3Spec ALWAYS emits `siding` — line 69 of
  // _shared/styleD3.ts collapses anything it does not recognise to null — so
  // `d3.siding !== undefined` is true even when the model said nothing about cladding, and
  // the builder's setting would be silently reset to plain on every video draft. A
  // shape-only feature that quietly wipes cladding is exactly the kind of bug that ships
  // unnoticed, because the roof it was asked to fix does get better.
  //
  // Colours are left alone for the same reason plus a better one: the customer repaints the
  // building in the configurator anyway, so a colour averaged off one overcast clip is not
  // worth overwriting a deliberate choice with.
  // 2026-08-25: this no longer carries a siding line at all. VIDEO_SHAPE_PROMPT stopped
  // ASKING for siding, which is a stronger guarantee than a caller remembering not to
  // apply it: a prompt that never mentions cladding cannot return a guess about it. The
  // old two-value allow-list here would also have quietly become WRONG the moment the
  // vocabulary widened to four, because it would have kept waving batten and lap through
  // while silently dropping panel and metal.
  const applyDraftedShape = (d3) => setAdminCal((p) => ({
    ...p,
    spec: {
      ...p.spec,
      roof: { ...p.spec.roof, ...((d3 && d3.roof) || {}) },
      wallHeightFt: (d3 && d3.wallHeightFt) || p.spec.wallHeightFt,
      // gableVent and foundation are TOP-LEVEL, so a `roof`-only merge silently drops
      // them and the video draft looks like it read nothing about vents or skids. Each
      // keeps its existing value when the model omits the key, so "the frames never
      // showed the bottom of the building" leaves the builder's setting alone rather
      // than resetting it to a slab.
      gableVent: (d3 && d3.gableVent && d3.gableVent.widthFrac > 0) ? d3.gableVent : p.spec.gableVent,
      foundation: (d3 && (d3.foundation === "skids" || d3.foundation === "slab")) ? d3.foundation : p.spec.foundation,
      // Third top-level field, same trap: the renderer textures the roof from this before
      // any customer roof-type pick, so a video that read "metal" and had it dropped here
      // would show shingles on a metal building and look like the model got it wrong.
      roofMaterial: (d3 && (d3.roofMaterial === "shingle" || d3.roofMaterial === "metal")) ? d3.roofMaterial : p.spec.roofMaterial,
    },
  }));
  const copyCalJson = () => {
    const out = JSON.stringify({ d3: adminCal.spec, d3Photos: adminCal.photos.filter(Boolean) }, null, 2);
    try {
      navigator.clipboard.writeText(out);
      setAdminCalMsg({ ok: true, msg: "d3 JSON copied — paste into this style's building_styles.d3 column." });
    } catch (_) {
      setAdminCalMsg({ ok: false, msg: "Clipboard blocked — JSON: " + out });
    }
  };
  // Photo slots can take an upload in the portal (the host owns the authed call); the
  // public page keeps pasting URLs, since it has no session to upload with.
  const calUploadPhoto = async (i, file) => {
    if (!file || !(setup3d && setup3d.onUploadPhoto)) return;
    if (file.size > 3_000_000) { setAdminCalMsg({ ok: false, msg: "That photo is over 3MB — please use a smaller one." }); return; }
    setAdminCalBusy(true); setAdminCalMsg(null);
    try {
      const url = await setup3d.onUploadPhoto(file);
      if (!url) throw new Error("Upload returned no URL.");
      calSetPhoto(i, url);
      setAdminCalMsg({ ok: true, msg: "Photo uploaded." });
    } catch (e) {
      setAdminCalMsg({ ok: false, msg: e.message || "Upload failed" });
    } finally { setAdminCalBusy(false); }
  };

  // ─── Walk-around video → this style's shape ───────────────────────────────────────────
  // The counterpart to the .glb scan below, for the builder who has a phone and no scanning
  // app. Frames are cut out of the video in the browser (ssExtractOrbitFrames, module
  // scope) and uploaded as ordinary style photos; the video file itself never leaves the
  // device. The AI then reads the SHAPE off them — roof type, pitch, overhang, wall height.
  //
  // `cachedUrls` is how a re-draft avoids re-uploading: picking a file always passes null
  // (a new video must not be read from the previous one's frames — the trap scanPick avoids
  // by clearing renderUrls), and the "Read it again" button passes the cached array. Making
  // it an argument rather than reading state inside the closure keeps that decision at the
  // call site, where it is visible.
  const calibrateFromVideo = async (file, cachedUrls) => {
    if (!(setup3d && setup3d.onUploadPhoto && setup3d.onDraftFromVideo)) return;
    if (adminCalVideo.busy || adminCalBusy) return;
    if (!file && !(cachedUrls && cachedUrls.length)) return;
    setAdminCalVideo((p) => ({ ...p, busy: true, err: null, step: "Opening the video…" }));
    setAdminCalBusy(true);
    setAdminCalMsg(null);
    try {
      let urls = cachedUrls;
      if (!urls) {
        const frames = await ssExtractOrbitFrames(file, (s) => setAdminCalVideo((p) => ({ ...p, step: s })));
        urls = [];
        for (let i = 0; i < frames.length; i++) {
          setAdminCalVideo((p) => ({ ...p, step: `Sending view ${i + 1} of ${frames.length}…` }));
          const f = new File([dataUrlToBytes(frames[i].dataUrl)], `walk-${i + 1}.jpg`, { type: "image/jpeg" });
          const url = await setup3d.onUploadPhoto(f);
          if (!url) throw new Error("Upload returned no URL.");
          urls.push(url);
        }
        setAdminCalVideo((p) => ({ ...p, urls, count: urls.length }));
        // Spread the four kept thumbnails ACROSS the walk instead of taking the first four,
        // so the slots show four different sides rather than four views of the front.
        const stride = Math.max(1, Math.floor(urls.length / 4));
        for (let slot = 0; slot < 4; slot++) {
          const src = urls[Math.min(urls.length - 1, slot * stride)];
          if (src) calSetPhoto(slot, src);
        }
      }
      setAdminCalVideo((p) => ({ ...p, step: "Reading the shape…" }));
      const res = await setup3d.onDraftFromVideo(urls, adminCal.styleValue);
      applyDraftedShape(res && res.d3);
      const read = (res && res.frames) || urls.length;
      setAdminCalVideo((p) => ({ ...p, busy: false, step: null, observed: (res && res.observed) || null, read }));
      setAdminCalMsg({ ok: true, msg: `Shape read from ${read} views of your walk-around. Colours and cladding are untouched — preview it, adjust anything, then Save.` });
    } catch (e) {
      setAdminCalVideo((p) => ({ ...p, busy: false, step: null, err: (e && e.message) || "Could not read that video." }));
    } finally {
      setAdminCalBusy(false);
    }
  };

  // ─── Building scan: read it, measure it, then drive the parametric model from the numbers ──
  // Measuring happens BEFORE any upload, on purpose: nothing is stored until we know the file
  // is a usable GLB of something building-shaped, and the builder has seen the numbers.
  const scanDisposeScene = (scene) => {
    scene.traverse((o) => {
      if (o.geometry) o.geometry.dispose();
      const mats = o.material ? (Array.isArray(o.material) ? o.material : [o.material]) : [];
      mats.forEach((mm) => { if (mm.map) mm.map.dispose(); mm.dispose(); });
    });
  };
  // Read + gate + measure. Returns the LIVE scene too — the turntable renders
  // it — so CALLERS own disposal via scanDisposeScene; a 40MB scan must never
  // sit in memory behind the editor.
  const scanReadGlb = async (file) => {
    if (file.size > SCAN_MAX_BYTES) {
      throw new Error(`That scan is ${(file.size / 1048576).toFixed(0)}MB. Export it at Medium or High instead of Ultra — the limit is ${SCAN_MAX_BYTES / 1048576}MB.`);
    }
    const buf = await file.arrayBuffer();
    // Header gate first: no three.js, no GPU, works on a phone, and refuses the whole class
    // of files that would otherwise fail deep inside the loader with an opaque message.
    const gate = scanInspectGlb(buf);
    if (gate.err) throw new Error(gate.err);
    const { THREE, GLTFLoader } = await loadGLTFLoader();
    const gltf = await new GLTFLoader().parseAsync(buf, "");
    if (!(gltf.scene instanceof THREE.Object3D)) throw new Error("Two copies of three.js loaded — check the version pin.");
    const sample = scanSamplePoints(THREE, gltf.scene, 120000);
    if (!sample) { scanDisposeScene(gltf.scene); throw new Error("That scan has no mesh in it."); }
    const metric = scanMeasure(sample);
    if (metric.err) { scanDisposeScene(gltf.scene); throw new Error(metric.err); }
    return { THREE, scene: gltf.scene, metric, measured: scanToFeet(metric) };
  };
  const scanPick = async (file) => {
    if (!file) return;
    // Full replacement on purpose (drops renderUrls — a new file needs new
    // renders) but the style's status, the aiReady probe and the builder's
    // device pick survive.
    setScan({ busy: true, step: "Reading the scan…", err: null, measured: null, file: null, status: scan.status, aiReady: scan.aiReady, device: scan.device });
    try {
      const { scene, measured } = await scanReadGlb(file);
      scanDisposeScene(scene);
      setScan({ busy: false, step: null, err: null, measured, file, status: scan.status, aiReady: scan.aiReady, device: scan.device });
    } catch (e) {
      setScan({ busy: false, step: null, err: e.message || "Could not read that scan.", measured: null, file: null, status: scan.status, aiReady: scan.aiReady, device: scan.device });
    }
  };
  // Four three-quarter turntable JPEGs of the raw scan, framed off the
  // measured geometry. MeshBasicMaterial swap on purpose: photogrammetry
  // textures carry the light they were captured in — lighting them again
  // shades them wrong, and an unlit standard material renders black.
  const scanRenderTurntable = (THREE, scene, metric) => {
    const W = 1024, H = 768;
    const cv = document.createElement("canvas");
    cv.width = W; cv.height = H;
    const renderer = new THREE.WebGLRenderer({ canvas: cv, antialias: true, preserveDrawingBuffer: true });
    renderer.setPixelRatio(1);
    renderer.setClearColor("#E7EEF5", 1);
    const swapped = [];
    scene.traverse((o) => {
      if (!o.isMesh) return;
      const orig = Array.isArray(o.material) ? o.material[0] : o.material;
      const mat = new THREE.MeshBasicMaterial({
        map: (orig && orig.map) || null,
        vertexColors: Boolean(o.geometry && o.geometry.getAttribute && o.geometry.getAttribute("color")),
        side: THREE.DoubleSide,
      });
      if (!mat.map && !mat.vertexColors) mat.color.set("#8A857C");
      swapped.push({ mesh: o, orig: o.material, mat });
      o.material = mat;
    });
    const cam = new THREE.PerspectiveCamera(45, W / H, 0.05, 1000);
    const target = new THREE.Vector3(metric.centerX || 0, (metric.groundY || 0) + (metric.peakM || 2) * 0.45, metric.centerZ || 0);
    const dist = Math.max(2, 2.3 * Math.max(metric.widthM || 2, metric.peakM || 2));
    const elev = (18 * Math.PI) / 180;
    const shots = [];
    for (let i = 0; i < 4; i++) {
      const az = (((metric.headingDeg || 0) + i * 90 + 22.5) * Math.PI) / 180;
      cam.position.set(
        target.x + dist * Math.cos(elev) * Math.sin(az),
        target.y + dist * Math.sin(elev),
        target.z + dist * Math.cos(elev) * Math.cos(az)
      );
      cam.lookAt(target);
      renderer.render(scene, cam);
      shots.push(cv.toDataURL("image/jpeg", 0.85));
    }
    swapped.forEach((s) => { s.mesh.material = s.orig; s.mat.dispose(); });
    renderer.dispose();
    if (renderer.forceContextLoss) renderer.forceContextLoss();
    return shots;
  };
  // One button: measure → apply → (when AI is on) render the scan from four
  // sides → upload the renders as the style's photos → let the AI read siding
  // and colours → merge — then re-assert the measured geometry ON TOP: the
  // tape measure beats the vision model wherever they disagree. Renders are
  // cached per picked file, so a retry re-spends only the AI call (10/day cap).
  const scanGenerate = async () => {
    const file = scan.file;
    if (!file || scan.busy) return;
    setScan((p) => ({ ...p, busy: true, err: null, step: "Reading the scan…" }));
    try {
      const { THREE, scene, metric, measured } = await scanReadGlb(file);
      setScan((p) => ({ ...p, measured, step: "Applying measurements…" }));
      scanApplyMeasured(measured);
      const exact = scanSizeMatchesFor(measured).find((s) => s.score === 0);
      if (exact) scanApplySize(exact.label);
      const aiOn = scan.aiReady !== false && setup3d && setup3d.onDraftFromPhotos && setup3d.onUploadPhoto;
      if (!aiOn) {
        scanDisposeScene(scene);
        setScan((p) => ({ ...p, busy: false, step: null }));
        setAdminCalMsg({ ok: true, msg: "Measured and applied. AI look-drafting is off for this site — siding and colours stay as they are; tune them by hand, or ask CSM Synergy to switch AI on." });
        return;
      }
      let urls = scan.renderUrls || null;
      let shots = null;
      if (!urls) {
        setScan((p) => ({ ...p, step: "Rendering the scan…" }));
        shots = scanRenderTurntable(THREE, scene, metric);
      }
      scanDisposeScene(scene);
      if (!urls) {
        urls = [];
        for (let i = 0; i < shots.length; i++) {
          setScan((p) => ({ ...p, step: `Uploading view ${i + 1} of 4…` }));
          const f = new File([dataUrlToBytes(shots[i])], `scan-view-${i + 1}.jpg`, { type: "image/jpeg" });
          const url = await setup3d.onUploadPhoto(f);
          if (!url) throw new Error("Upload returned no URL.");
          urls.push(url);
          calSetPhoto(i, url);
        }
        setScan((p) => ({ ...p, renderUrls: urls }));
      }
      setScan((p) => ({ ...p, step: "Reading the look with AI…" }));
      const d3 = await setup3d.onDraftFromPhotos(urls, adminCal.styleValue);
      applyDraftedSpec(d3);
      scanApplyMeasured(measured);
      setScan((p) => ({ ...p, busy: false, step: null }));
      const roofNote = d3 && d3.roof && d3.roof.type && d3.roof.type !== measured.roofType
        ? ` (the AI read the roof as ${d3.roof.type}; keeping the measured ${measured.roofType})` : "";
      setAdminCalMsg({ ok: true, msg: `Generated from the scan: measured geometry + AI siding/colours${roofNote}. Preview it, tweak, then Save.` });
    } catch (e) {
      setScan((p) => ({ ...p, busy: false, step: null, err: e.message || "Could not generate from that scan." }));
    }
  };
  // Push the measured numbers into the draft spec. Geometry owns dimensions; the AI photo read
  // (and the builder's eye) still own siding and colour, which a scan's phone-white-balanced
  // texture is genuinely bad at.
  const scanApplyMeasured = (m) => {
    calSet({ wallHeightFt: m.eaveFt });
    const roof = { type: m.roofType, pitch: m.pitch, overhang: m.overhangFt || 0 };
    if (m.roofType === "gambrel" && m.gambrel) {
      roof.kneeU = m.gambrel.kneeU; roof.kneeRise = m.gambrel.kneeRise; roof.ridgeRise = m.gambrel.ridgeRise;
    }
    if (m.roofType === "gable" && m.ridgeOffset) roof.ridgeOffset = m.ridgeOffset;
    calSetRoof(roof);
  };
  const scanApply = () => {
    const m = scan.measured;
    if (!m) return;
    scanApplyMeasured(m);
    setAdminCalMsg({ ok: true, msg: `Using the scan: ${m.widthFt}×${m.depthFt} ft, ${m.eaveFt} ft walls, ${m.roofType} roof at ${m.pitch}${m.overhangFt ? `, ${m.overhangFt} ft overhang` : ""}. Preview it, then save.` });
  };
  // Closest sizes this style sells, orientation-agnostic; empty when nothing
  // is within 4 ft total. The scan can SUGGEST but never create a size —
  // sizes carry pricing (the NULL-base-price contract), so a miss is the
  // builder's cue to add the size under Settings → Catalog first.
  const scanSizeMatchesFor = (m) => {
    if (!m) return [];
    const st = ((C && C.buildingStyles) || []).find((s) => s.value === (adminCal && adminCal.styleValue));
    const labels = st && Array.isArray(st.sizes) && st.sizes.length ? st.sizes : ((C && C.defaultSizes) || []);
    const out = [];
    labels.forEach((label) => {
      const p = parseSize(typeof label === "string" ? label : label && label.label);
      if (!p) return;
      const score = Math.abs(Math.max(p.w, p.h) - Math.max(m.widthFt, m.depthFt))
        + Math.abs(Math.min(p.w, p.h) - Math.min(m.widthFt, m.depthFt));
      out.push({ label: typeof label === "string" ? label : label.label, score });
    });
    out.sort((a, b) => a.score - b.score);
    return out.filter((s) => s.score <= 4).slice(0, 3);
  };
  const scanApplySize = (label) => {
    calSetSize(label);
    setAdminCalMsg({ ok: true, msg: `Canvas set to ${label} on this style — the resize cleared any placed items.` });
  };
  // Store the scan against the style so it can be re-measured later (an algorithm improvement
  // should not need the builder to walk round the building again). The capture kind rides in
  // the meta: LiDAR and photogrammetry meshes earn different trust later.
  const scanUpload = async () => {
    if (!scan.file || !(setup3d && setup3d.onUploadModel && setup3d.onSaveModel)) return;
    setScan((p) => ({ ...p, busy: true, step: "Uploading…", err: null }));
    try {
      const path = await setup3d.onUploadModel(scan.file, adminCal.styleValue);
      if (!path) throw new Error("Upload returned no path.");
      const meta = scan.device
        ? { ...scan.measured, capture: scan.device === "iphone-pro" ? "lidar" : "photogrammetry", device: scan.device }
        : scan.measured;
      await setup3d.onSaveModel(adminCal.styleValue, path, meta);
      setScan((p) => ({ ...p, busy: false, step: null, status: "uploaded" }));
      setAdminCalMsg({ ok: true, msg: "Scan saved to this style." });
    } catch (e) {
      setScan((p) => ({ ...p, busy: false, step: null, err: e.message || "Upload failed" }));
    }
  };
  // Pull the stored scan back down and run it through the same read-and-measure
  // path a fresh file takes — after which Generate works on it too.
  const scanFetchStored = async () => {
    if (!(setup3d && setup3d.onLoadModelUrl) || scan.busy) return;
    setScan((p) => ({ ...p, busy: true, err: null, step: "Fetching the stored scan…" }));
    try {
      const url = await setup3d.onLoadModelUrl(adminCal.styleValue);
      if (!url) throw new Error("No scan is stored for this style yet.");
      const resp = await fetch(url);
      if (!resp.ok) throw new Error("Could not download the stored scan.");
      const blob = await resp.blob();
      const file = new File([blob], "stored-scan.glb", { type: "model/gltf-binary" });
      await scanPick(file);
    } catch (e) {
      setScan((p) => ({ ...p, busy: false, step: null, err: e.message || "Could not fetch the stored scan." }));
    }
  };
  const scanSetStatus = async (status) => {
    if (!(setup3d && setup3d.onSetModelStatus)) return;
    setScan((p) => ({ ...p, busy: true, err: null }));
    try {
      await setup3d.onSetModelStatus(adminCal.styleValue, status);
      setScan((p) => ({ ...p, busy: false, status }));
      setAdminCalMsg({ ok: true, msg: status === "locked" ? "3D setup locked for this style." : "3D setup unlocked." });
    } catch (e) {
      setScan((p) => ({ ...p, busy: false, err: e.message || "Could not change that." }));
    }
  };

  // Both writes below have two callers with different credentials. In the portal the host
  // passes `setup3d` and owns the I/O, because it holds the signed-in session — THIS
  // component's supabase client is the anon one, and calling portal-settings with it would
  // 401 at resolveTenant. On the public page (?admin=1) there is no session at all, so the
  // operator path keeps going through admin-save-settings with the shared password.
  const saveCalSpec = async () => {
    if (setup3d && setup3d.onSaveSpec) {
      setAdminCalBusy(true); setAdminCalMsg(null);
      try {
        await setup3d.onSaveSpec(adminCal.styleValue, adminCal.spec, adminCal.photos.filter(Boolean));
        setAdminCalMsg({ ok: true, msg: "Saved. Customers see this on their next page load; reopen the Designer tab to refresh it here." });
      } catch (e) {
        setAdminCalMsg({ ok: false, msg: e.message || "Save failed" });
      } finally { setAdminCalBusy(false); }
      return;
    }
    if (!adminPwd) { setAdminCalMsg({ ok: false, msg: "Enter the admin password first (top row)." }); return; }
    setAdminCalBusy(true); setAdminCalMsg(null);
    try {
      const { data, error } = await supabase.functions.invoke("admin-save-settings", {
        body: { adminPassword: adminPwd, clientId: C.clientId, action: "save_style_d3", styleValue: adminCal.styleValue, d3: adminCal.spec, d3Photos: adminCal.photos.filter(Boolean) },
      });
      if (error) throw new Error(error.message || "Save failed");
      if (!data || !data.ok) throw new Error((data && data.error) || "Save failed");
      setAdminCalMsg({ ok: true, msg: "Saved — reload the page to see it live." });
    } catch (e) {
      setAdminCalMsg({ ok: false, msg: e.message + " (Or use Copy d3 JSON and set building_styles.d3 by hand.)" });
    } finally { setAdminCalBusy(false); }
  };
  const calibrateFromPhotos = async () => {
    const photos = adminCal.photos.filter(Boolean);
    if (photos.length === 0) { setAdminCalMsg({ ok: false, msg: "Add at least one photo first." }); return; }
    if (setup3d && setup3d.onDraftFromPhotos) {
      setAdminCalBusy(true); setAdminCalMsg(null);
      try {
        const d3 = await setup3d.onDraftFromPhotos(photos, adminCal.styleValue);
        if (!d3) throw new Error("The draft came back empty.");
        applyDraftedSpec(d3);
        setAdminCalMsg({ ok: true, msg: "Draft read from your photos — preview it, tweak anything, then save." });
      } catch (e) {
        setAdminCalMsg({ ok: false, msg: e.message || "Drafting failed" });
      } finally { setAdminCalBusy(false); }
      return;
    }
    if (!adminPwd) { setAdminCalMsg({ ok: false, msg: "Enter the admin password first (top row)." }); return; }
    setAdminCalBusy(true); setAdminCalMsg(null);
    try {
      const { data, error } = await supabase.functions.invoke("calibrate-style", {
        body: { adminPassword: adminPwd, photoUrls: photos, styleLabel: adminCal.styleValue },
      });
      if (error) throw new Error(error.message || "Calibration failed");
      if (!data || !data.ok || !data.d3) throw new Error((data && data.error) || "Calibration failed");
      applyDraftedSpec(data.d3);
      setAdminCalMsg({ ok: true, msg: "Draft spec read from the photos — preview it, tweak, then save." });
    } catch (e) {
      setAdminCalMsg({ ok: false, msg: e.message + " (On the public page this needs calibrate-style deployed; in the portal it runs through Settings.)" });
    } finally { setAdminCalBusy(false); }
  };

  // ─── SUBMIT QUOTE ───
  const submitQuote = async () => {
    // An inventory MASTER is the lot building itself, never a customer estimate — a
    // submit here would convert it (save_design promotion + a GHL estimate) and every
    // unit list/serial would point at a customer's quote. Quoting an inventory building
    // goes through the Inventory tab's "Send estimate", which loads it as a fresh design.
    if (inventoryMaster && currentDesignIdRef.current === inventoryMaster.code) {
      setSubmitError("This is an inventory building. Use “Send estimate” on the Inventory tab to quote it to a customer, or “Update Inventory Building” to save design changes.");
      return;
    }
    // Validate every contact field that's enabled in the config. Address fields
    // are required because downstream tax calc needs the full address.
    const FIELD_LABEL = { name: "Name", email: "Email", phone: "Phone", street: "Street Address", city: "City", state: "State", zip: "Zip" };
    const missing = ["name", "email", "phone", "street", "city", "state", "zip"]
      .filter((f) => C.contactFields.includes(f) && !String(contact[f] || "").trim())
      .map((f) => FIELD_LABEL[f]);
    if (missing.length > 0) {
      setSubmitError(`Please fill in: ${missing.join(", ")}.`);
      return;
    }
    if (C.contactFields.includes("phone") && contact.phone.replace(/\D/g, "").length !== 10) {
      setSubmitError("Phone number must be 10 digits.");
      return;
    }
    if (C.contactFields.includes("zip") && !/^\d{5}$/.test(contact.zip)) {
      setSubmitError("Zip must be 5 digits.");
      return;
    }
    if (!sel.style || !sel.size) {
      setSubmitError("Please select a Building Style and Size.");
      return;
    }
    // Every included item must be placed on the layout, or explicitly declined.
    const declinedKeys = Array.isArray(sel.declinedItems) ? sel.declinedItems : [];
    const unplacedIncluded = includedItemKeys.filter((k) => !declinedKeys.includes(k) && !items.some((it) => it.type === k || it.fixtureItemId === k));
    if (unplacedIncluded.length > 0) {
      const names = unplacedIncluded.map((k) => (ITEMS[k] && ITEMS[k].label) || k).join(", ");
      setSubmitError(`Please place all included items on your layout, or decline the ones you don't want: ${names}.`);
      return;
    }
    if (!supabase) {
      setSubmitError("Storage isn't configured. Contact support.");
      return;
    }

    setSubmitting(true);
    setSubmitError(null);

    try {
      // 1. Render the export canvas — page 1 of the quote PDF. If the customer
      //    opened the 3D view, the captured snapshot rides along as page 2 of the
      //    SAME PDF (same storage path, so the {client_id}/SS-….pdf storage policy
      //    and the Edge Function's attachment handling are untouched).
      const canvas = renderExportCanvas();

      // 2. Reuse the existing short_code if we loaded one; otherwise mint a fresh one
      const shortCode = currentDesignIdRef.current || genShortCode();
      // Store the PDF under a per-tenant prefix ({client_id}/<code>-<ts>.pdf). The
      // timestamp suffix keeps each submitted version's PDF instead of overwriting the
      // previous one (design_versions history); the storage policy allows the -<digits>.
      const filePath = `${C.clientId}/${shortCode}-${Date.now()}.pdf`;

      // 3. Upload the PDF to the floor-plans bucket. The filename is unique per
      //    submit (short_code + timestamp) so there is never a conflict — use a
      //    plain insert (upsert:false), NOT an upsert. This matters for security:
      //    a storage upsert's RETURNING requires a public SELECT policy, and that
      //    same SELECT policy is what lets anyone list() a tenant prefix and
      //    enumerate every design short_code. A plain insert needs no SELECT
      //    policy, so the listable policy can be dropped (see 042_floor_plans_no_list).
      //    Uses the same hand-built JPEG-in-PDF wrapper that downloadPDF uses.
      const fullSheetDataUrl = canvas.toDataURL("image/jpeg", 0.92);
      // The PLAN-ONLY image (Carolyn 2026-08-25): everywhere the PNG is used — the order
      // screen's floor-plan card — the sheet's bottom customer-info band is noise, so the
      // image crops to the drawing: the full visible band above TEXT_AREA_H vertically,
      // and the plan plus a label margin horizontally (wall labels + rotated dimensions
      // sit ~70px outside the walls). The PDF keeps the FULL sheet — it IS the document.
      const dpr2 = canvas.width / cW;
      const cropX = Math.max(0, Math.round((mgX - 70) * dpr2));
      const cropW = Math.min(canvas.width - cropX, Math.round((pW + 140) * dpr2));
      const cropH = Math.round((cH - TEXT_AREA_H) * dpr2);
      const planCanvas = document.createElement("canvas");
      planCanvas.width = cropW; planCanvas.height = cropH;
      const pctx = planCanvas.getContext("2d");
      pctx.fillStyle = "#FFF"; pctx.fillRect(0, 0, cropW, cropH);
      pctx.drawImage(canvas, cropX, 0, cropW, cropH, 0, 0, cropW, cropH);
      const planJpegDataUrl = planCanvas.toDataURL("image/jpeg", 0.92);
      const pdfPages = [{ bytes: dataUrlToBytes(fullSheetDataUrl), w: canvas.width, h: canvas.height }];
      // An armed shot always wins — if the rep framed the building deliberately, that is
      // the view the customer should see. Only when nobody opened 3D at all do we render a
      // default one, so a quote is never sent without a picture of the building.
      let shot3d = render3DSnapshotRef.current;
      if (!shot3d) {
        shot3d = await renderDefault3DShot({
          bldgW, bldgH, items, itemTypes: ITEMS, frontWall,
          painted: sel.paint === "Painted", paintBody: paintColors.body, paintTrim: paintColors.trim,
          scale, mgX, mgY,
          style3d: d3ResolveStyleSpec(selectedStyle, sel.style, C.wallHeightFt, d3SidingOverride(C, sel), sel.wallHeight),
          roofType: sel.roofType,
          roofColorHex: (() => { const rc = (Array.isArray(C.colors) ? C.colors : []).find((c) => c.label === sel.roofColor && (sel.roofType === "Metal" ? c.metal : c.shingle)); return (rc && rc.hex) ? rc.hex : ""; })(),
          fixtures: C.fixtures, bodyColors: bodyPaintPool, trimColors: trimPaintPool,
        });
      }
      if (shot3d) pdfPages.push({ bytes: dataUrlToBytes(shot3d.url), w: shot3d.w, h: shot3d.h });
      const blob = buildPdfFromJpegPages(pdfPages);
      const { error: upErr } = await supabase.storage
        .from("floor-plans")
        .upload(filePath, blob, { upsert: false, contentType: "application/pdf", cacheControl: "0" });
      if (upErr) throw new Error(`PDF upload failed: ${upErr.message}`);

      const { data: urlData } = supabase.storage.from("floor-plans").getPublicUrl(filePath);
      const imageUrl = urlData.publicUrl;

      // 3b. The same images as plain JPEGs (migration 127): the portal's order screen shows
      // the floor plan (and the 3D shot when one was captured) as <img> cards — an image
      // beats an embedded PDF viewer in a small card. BEST-EFFORT: these are presentation,
      // and a failed upload must never block the quote. Timestamped names match the widened
      // storage policy shape ({client}/SS-<code>-plan-<ts>.jpg / -3d-<ts>.jpg) and keep the
      // anon-no-update invariant — every submit ADDS a fresh pair.
      let planImageUrl = null;
      let view3dImageUrl = null;
      try {
        const ts = Date.now();
        const planPath = `${C.clientId}/${shortCode}-plan-${ts}.jpg`;
        const planUp = await supabase.storage.from("floor-plans")
          .upload(planPath, dataUrlToBytes(planJpegDataUrl), { upsert: false, contentType: "image/jpeg", cacheControl: "0" });
        if (!planUp.error) planImageUrl = supabase.storage.from("floor-plans").getPublicUrl(planPath).data.publicUrl;
        if (shot3d) {
          const shotPath = `${C.clientId}/${shortCode}-3d-${ts}.jpg`;
          const shotUp = await supabase.storage.from("floor-plans")
            .upload(shotPath, dataUrlToBytes(shot3d.url), { upsert: false, contentType: "image/jpeg", cacheControl: "0" });
          if (!shotUp.error) view3dImageUrl = supabase.storage.from("floor-plans").getPublicUrl(shotPath).data.publicUrl;
        }
      } catch (_e) { /* image cards degrade to the PDF link; the quote is unaffected */ }

      // 4. Save the design row via the capability RPC (insert on first save,
      //    update on subsequent saves; keyed by the unguessable short code).
      //    The RPC also pins client_id — a saved design can never be re-homed
      //    to a different tenant.
      const { error: dbErr } = await supabase.rpc("save_design", {
        p_code: shortCode,
        p_client_id: C.clientId,
        p_contact: contact,
        p_selections: sel,
        p_paint_colors: paintColors,
        p_items: items,
        p_custom_options: customOptions,
        p_ro_dimensions: roDimensions,
        p_bldg_w: bldgW,
        p_bldg_h: bldgH,
        p_image_url: imageUrl,
      });
      if (dbErr) throw new Error(`Save failed: ${dbErr.message}`);

      // 5. Update the URL so a refresh / share-link reopens the same design.
      //    Keep the ?client= tenant param so the link reopens with the right branding.
      //    Embedded (in-portal): the page URL is /portal.html and carries no ?client,
      //    so build the share link from the config's tenant + the public root instead
      //    — and never rewrite the host page's URL.
      const shareParams = new URLSearchParams();
      const tenantParam = embedded ? C.clientId : new URLSearchParams(window.location.search).get("client");
      if (tenantParam) shareParams.set("client", tenantParam);
      shareParams.set("id", shortCode);
      const viewUrl = `${window.location.origin}${embedded ? "/" : window.location.pathname}?${shareParams.toString()}`;
      if (!embedded) window.history.replaceState({}, "", `?${shareParams.toString()}`);
      currentDesignIdRef.current = shortCode;
      // If this code began life as a silent draft, save_design just promoted it to 'sent'
      // — from here on it is a submitted design and draft saves must leave it alone.
      isDraftRef.current = false;
      draftStateRef.current = null;
      // Estimate sent from an inventory unit ("Send estimate"): tie the new design to its
      // unit so the Inventory tab lists it. Best-effort — a link failure must never break
      // a submitted estimate; the fire-and-forget catch keeps it silent.
      // Tie this submission to its inventory building — or deliberately UNTIE it when
      // staff designed a fresh build for the same customer ("Design a new build
      // instead"), so the new version reads New rather than inheriting Inventory.
      // newBuildMode is the ONLY thing that unties. An ordinary resubmit of a reopened
      // inventory estimate (adding a discount, say) must RE-STAMP the same unit: the
      // openDesign path deliberately clears inventoryUnitRef, so reading only that ref
      // sent unitId:null and silently severed the quote from its building — the lock then
      // survived exactly one submit and the unit never flipped Sold on acceptance.
      const unitToLink = newBuildMode
        ? null
        : (inventoryUnitRef.current || (designUnit && designUnit.id) || null);
      if (embedded && (unitToLink || (newBuildMode && designUnit))) {
        try {
          supabase.functions.invoke("portal-settings", { body: {
            action: "link_design_to_unit", targetClientId: C.clientId,
            shortCode, unitId: unitToLink,
          } }).catch(() => {});
        } catch (_e) { /* never block the estimate on the label */ }
        if (unitToLink) setDesignUnit((d) => d && d.id === unitToLink ? d : { id: unitToLink, serial: null });
        else { setDesignUnit(null); setNewBuildMode(false); }
      }
      setDesignCode(shortCode);
      setViewingVersion(null);

      const payload = {
        // New fields — n8n can use these for GHL linking + image embed
        designId: shortCode,
        imageUrl,
        // Plain-image twins of the plan PDF (migration 127) — the order screen's sidebar
        // cards. Persisted by submit-estimate's SS branch only; null when an upload failed.
        planImageUrl,
        view3dImageUrl,
        viewUrl,
        source: "StructureStudio",
        clientId: C.clientId,
        deliveryFee: Number(sel.deliveryFee) || 0,
        // Included items the customer declined → the estimate adds a deduction line per item.
        declinedItems: (Array.isArray(sel.declinedItems) ? sel.declinedItems : [])
          .filter((k) => includedItemKeys.includes(k))
          .map((k) => ({ key: k, label: (ITEMS[k] && ITEMS[k].label) || k })),
        contact: {
          name: contact.name,
          email: contact.email,
          // Strip display formatting; n8n/GHL store raw digits.
          phone: contact.phone.replace(/\D/g, ""),
          street: contact.street,
          city: contact.city,
          state: contact.state,
          zip: contact.zip,
        },
        selections: {
          buildingStyle: sel.style,
          buildingSize: sel.size,
          paint: sel.paint || "No Paint",
          ...(sel.paint === "Painted" ? { paintBodyColor: paintColors.body || "TBD", paintTrimColor: paintColors.trim || "TBD" } : {}),
          // Customer's 3D wall-height pick (feet). Additive — absent when the
          // customer never touched it; pricing hookup is a catalog follow-up.
          ...(sel.wallHeight ? { wallHeightFt: sel.wallHeight } : {}),
          // Send roof fields whenever the tenant offers roofs (any shingle/metal color), even if
          // unselected, so the estimate always shows the Roof line in order.
          ...((Array.isArray(C.colors) && C.colors.some((c) => c.shingle || c.metal)) ? { roofType: sel.roofType || "", roofColor: sel.roofColor || "" } : {}),
          // Cladding (Carolyn 2026-08-18). VISUAL ONLY in v1 -- it is recorded on the design
          // and reported here so the estimate template can surface it, but it carries no
          // price and adds no line to the estimate. Pricing bolts on later the way Roof and
          // Paint already do (a rate + pricing_method on the catalog row, priced server-side
          // in submit-estimate) without changing this key.
          //
          // ADDITIVE and permanent: only sent when the customer actually chose something, so
          // tenants on the old frontend emit nothing. n8n/GoHighLevel read named fields, so a
          // new key is safe -- renaming or removing one is not. Do not rename it.
          // Both spellings on purpose: `cladding` is the human label the estimate template
          // prints; `claddingId` is the stable id the design row stores (p_selections holds
          // sel verbatim), so a consumer never has to reverse-map display text.
          ...(sel.cladding && D3_CLADDING[sel.cladding] ? { cladding: D3_CLADDING[sel.cladding].label, claddingId: sel.cladding } : {}),
        },
        floorPlanItems: items.map((item) => {
          const displayLabel = getDisplayLabel(item.wall, frontWall);
          if (item.type === "line") {
            const dxFt = (item.x2 - item.x1) / scale;
            const dyFt = (item.y2 - item.y1) / scale;
            return {
              type: "line",
              wall: null,
              lengthFt: Math.round(Math.sqrt(dxFt * dxFt + dyFt * dyFt) * 100) / 100,
              angleDeg: Math.round(Math.atan2(dyFt, dxFt) * 180 / Math.PI * 10) / 10,
            };
          }
          if (item.type === "textNote") {
            return { type: "textNote", wall: null, text: (item.text || "").trim() };
          }
          return {
            type: item.type,
            wall: displayLabel ? displayLabel.toLowerCase() : (item.wall || null),
            ...(item.type === "workbench" ? { lengthFt: item.widthFt } : {}),
            ...(item.type === "fixtureDoor" ? { name: item.doorName, widthIn: item.widthIn, heightIn: item.heightIn, swing: item.swing, operation: item.operation, price: (item.price != null ? Number(item.price) : null), fixtureItemId: item.fixtureItemId || null, colorId: item.colorId || null, colorLabel: item.colorLabel || null, trimColorId: item.trimColorId || null, trimColorLabel: item.trimColorLabel || null } : {}),
            ...(item.type === "ramp" ? { name: item.rampName || null, widthIn: item.widthIn || null, heightIn: item.heightIn || null, price: (item.price != null ? Number(item.price) : null), fixtureItemId: item.fixtureItemId || null } : {}),
            ...(item.type === "window" && item.fixtureItemId ? { name: item.windowName || null, widthIn: item.widthIn || null, heightIn: item.heightIn || null, price: (item.price != null ? Number(item.price) : null), fixtureItemId: item.fixtureItemId, colorId: item.colorId || null, colorLabel: item.colorLabel || null } : {}),
          };
        }),
        // Catalog door schedule: one row per placed fixture door, with its snapshotted spec +
        // price. submit-estimate turns each into a priced estimate line. Kept separate from
        // itemSummary (which counts the built-in door types) so the estimate engine has the
        // full per-door detail, not just a count.
        doors: items.filter((i) => i.type === "fixtureDoor").map((d) => {
          const lbl = getDisplayLabel(d.wall, frontWall);
          return {
            name: d.doorName || "Door",
            widthIn: d.widthIn != null ? Number(d.widthIn) : null,
            heightIn: d.heightIn != null ? Number(d.heightIn) : null,
            swing: d.swing || null,
            operation: d.operation || null,
            price: d.price != null ? Number(d.price) : null,
            wall: lbl ? lbl.toLowerCase() : (d.wall || null),
            fixtureItemId: d.fixtureItemId || null,
            // Color choice: ids are what submit-estimate re-resolves prices from (never the
            // snapshot); labels are fallback display only.
            colorId: d.colorId || null,
            colorLabel: d.colorLabel || null,
            trimColorId: d.trimColorId || null,
            trimColorLabel: d.trimColorLabel || null,
          };
        }),
        // Ramp schedule: one row per placed ramp. Custom ramps carry their snapshot price; simple
        // ramps leave price null and submit-estimate prices them from the tenant's ramp settings
        // (each, or per_ft × the attached door width, passed here as doorWidthFt).
        ramps: items.filter((i) => i.type === "ramp").map((r) => {
          const door = items.find((d) => d.id === r.snapDoorId);
          let doorWidthFt = r.widthFt != null ? Number(r.widthFt) : null;
          if (door && door.type === "fixtureDoor" && door.widthIn) doorWidthFt = Number(door.widthIn) / 12;
          const lbl = getDisplayLabel(r.wall, frontWall);
          return {
            name: r.rampName || null,
            widthIn: r.widthIn != null ? Number(r.widthIn) : null,
            heightIn: r.heightIn != null ? Number(r.heightIn) : null,
            price: r.price != null ? Number(r.price) : null,
            doorWidthFt: doorWidthFt != null ? Math.round(doorWidthFt * 100) / 100 : null,
            wall: lbl ? lbl.toLowerCase() : (r.wall || null),
            fixtureItemId: r.fixtureItemId || null,
          };
        }),
        // Catalog window schedule: one row per placed catalog window (has fixtureItemId), with its
        // snapshot price. Built-in windows aren't here — they're counted in itemSummary.windows.
        windows: items.filter((i) => i.type === "window" && i.fixtureItemId).map((w) => {
          const lbl = getDisplayLabel(w.wall, frontWall);
          return {
            name: w.windowName || "Window",
            widthIn: w.widthIn != null ? Number(w.widthIn) : null,
            heightIn: w.heightIn != null ? Number(w.heightIn) : null,
            price: w.price != null ? Number(w.price) : null,
            wall: lbl ? lbl.toLowerCase() : (w.wall || null),
            fixtureItemId: w.fixtureItemId || null,
            colorId: w.colorId || null,
            colorLabel: w.colorLabel || null,
          };
        }),
        itemSummary: {
          singleDoors: items.filter((i) => i.type === "singleDoor").length,
          doubleDoors: items.filter((i) => i.type === "doubleDoor").length,
          // Built-in windows only (catalog windows are priced from windows[] by snapshot).
          windows: items.filter((i) => i.type === "window" && !i.fixtureItemId).length,
          workbenches: items.filter((i) => i.type === "workbench").map((i) => {
            const lbl = getDisplayLabel(i.wall, frontWall);
            return { wall: lbl ? lbl.toLowerCase() : i.wall, lengthFt: i.widthFt };
          }),
          lofts: items.filter((i) => i.type === "loft").length,
          loftSqft: Math.round(items.filter((i) => i.type === "loft").reduce((s, i) => s + (i.widthFt || 0) * (i.heightFt || 0), 0)),
          ramp: items.filter((i) => i.type === "ramp").length,   // count — ramp is priced "each" (one per door)
          lines: items.filter((i) => i.type === "line").length,
          notes: items.filter((i) => i.type === "textNote").map((n) => (n.text || "").trim()).filter(Boolean),
        },
        customOptions: customOptions.filter((co) => co.name && co.name.trim()).map((co) => ({
          name: co.name.trim(),
          qty: co.qty ? parseInt(co.qty) || 0 : 0,
          amount: co.amount ? parseFloat(co.amount) || 0 : 0,
        })),
        // Discounts → GHL invoice discount total (each shows as a $0 "Discount — <desc>" line).
        discounts: (Array.isArray(sel.discounts) ? sel.discounts : [])
          .map((d) => ({ description: String(d.description || "").trim(), amount: Math.abs(parseFloat(d.amount) || 0) }))
          .filter((d) => d.amount > 0),
        roughOpenings: items.filter((i) => i.type === "roughOpening").map((ro, idx) => ({
          name: `RO-${idx + 1}`,
          dimensions: (roDimensions[ro.id] || "").trim(),
          qty: 1,
        })),
        submittedAt: new Date().toISOString(),
      };

      // Call the submit-estimate Edge Function. It looks up the GHL credentials for
      // this clientId in Supabase (admin-configured), then either creates a new GHL
      // estimate or updates the existing one for this design and emails it.
      // ⚠️ This `betaMode` flag is TELEMETRY ONLY and does not redirect anything. It is
      // detected from the deploy host (beta.* on either apex, or a beta--* branch preview),
      // which nobody opts into — so it must never gain a side effect, or every submission
      // from the beta host would divert (and hard-fail for tenants with no test inbox).
      //
      // What DOES redirect is the tenant's own beta_mode switch in Settings → Branding →
      // Testing (restored 2026-08-07): with it on, submit-estimate mails that tenant's
      // beta_email instead of the customer, and refuses the submission outright if no valid
      // test inbox is set rather than falling back to the customer. So on a tenant WITHOUT
      // that switch on, a verification submit carrying a real lead's details still emails
      // that customer a live branded quote — turn beta mode on first, or use an address you
      // control. An earlier QA-inbox redirect pointed at one hard-coded non-deliverable
      // address so beta estimates silently failed to send; the per-tenant address plus the
      // refuse-if-unset rule are what make this version safe to have back.
      const betaMode = typeof window !== "undefined" && /(^|\.)beta(\.|--)/.test(window.location.hostname);
      const { data: result, error: fnErr } = await supabase.functions.invoke("submit-estimate", {
        body: { ...payload, betaMode },
      });
      // supabase-js flattens a non-2xx Edge Function response to the generic
      // "Edge Function returned a non-2xx status code". The function's real reason
      // (e.g. a GHL validation message like an invalid zip-for-state) lives in the
      // JSON body on fnErr.context — surface it so failures aren't a mystery.
      if (fnErr) {
        let detail = fnErr.message || "Submit failed";
        try {
          if (fnErr.context && typeof fnErr.context.json === "function") {
            const errBody = await fnErr.context.json();
            if (errBody && errBody.error) detail = errBody.error;
          }
        } catch (_) { /* body unreadable — keep the generic message */ }
        throw new Error(detail);
      }
      if (!result?.ok) throw new Error(result?.error || "Submit failed");

      // Persist the returned GHL IDs so subsequent edits update the same estimate.
      if (result.contactId) ghlContactIdRef.current = result.contactId;
      if (result.estimateId) {
        ghlEstimateIdRef.current = result.estimateId;
        setHasExistingEstimate(true);
      } else if (result.issuedBy === "structurestudio" && result.quoteNumber) {
        // SS-mode tenants (migration 121): no GHL estimate exists, but the quote does —
        // and 9-ALT reuses its number on resubmit, so the button must flip to "Resubmit".
        setHasExistingEstimate(true);
      }
      if (result.estimateNumber) ghlEstimateNumberRef.current = result.estimateNumber;

      setSavedDesign({
        code: shortCode,
        viewUrl,
        imageUrl,
        estimateNumber: result.estimateNumber || null,
        updated: !!result.updated,
        // SS-mode extras: which word to use, the printable document, and whether the
        // customer actually got an email (a missing address must be visible, not silent).
        ssQuote: result.issuedBy === "structurestudio",
        quotePdfUrl: result.quotePdfUrl || null,
        quoteEmailed: result.issuedBy === "structurestudio" ? result.quoteEmailed === true : null,
        quoteEmailReason: result.quoteEmailReason || null,
        changeOrder: result.changeOrder || null,
      });
      setSubmitted(true);
      // Embedded (in-portal) mounts: tell the host page a design was submitted so it
      // can refresh its lists. Fired only after the full submit-estimate success so
      // estimateNumber/updated are real; purely additive — no payload change.
      if (typeof onSaved === "function") {
        try { onSaved({ code: shortCode, clientId: C.clientId, viewUrl, imageUrl, estimateNumber: result.estimateNumber || null, updated: !!result.updated }); } catch (_e) {}
      }
    } catch (err) {
      setSubmitError(err.message || "Something went wrong submitting your quote. Please try again.");
      console.error("Submit error:", err);
      if (window.ssLogError) window.ssLogError("designer", (err && err.message) || "submit failed", null, { phase: "submitQuote", stack: err && err.stack ? String(err.stack).slice(0, 2000) : null });
    } finally {
      setSubmitting(false);
    }
  };

  const downloadPNG = () => { if (!exportUrl) return; const a = document.createElement("a"); a.href = exportUrl; const nameSlug = contact.name.trim().replace(/\s+/g, "-").toLowerCase() || "customer"; a.download = `structurestudio-${nameSlug}-${bldgW}x${bldgH}.png`; a.click(); };

  const dataUrlToBytes = (dataUrl) => {
    const bin = atob(dataUrl.split(",")[1]);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes;
  };

  // Build a US-Letter PDF embedding one JPEG per page ({ bytes, w, h } each),
  // aspect-fit. Page 1 (the floor-plan canvas) is letter-shaped already so it
  // fills the page edge-to-edge exactly as before; other aspect ratios (the 3D
  // snapshot) get a small margin and center on the page. Self-contained — no
  // external PDF library.
  const buildPdfFromJpegPages = (pages) => {
    const PT_W = 612, PT_H = 792;
    const enc = new TextEncoder();
    const chunks = [];
    let totalLen = 0;
    const offsets = [];
    const pushStr = (s) => { const b = enc.encode(s); chunks.push(b); totalLen += b.length; };
    const pushBytes = (b) => { chunks.push(b); totalLen += b.length; };

    // Header + binary marker so PDF readers treat the file as binary
    pushStr("%PDF-1.4\n%\xC4\xE5\xF2\xE5\xEB\xA7\xF3\xA0\xD0\xC4\xC6\n");

    offsets[1] = totalLen;
    pushStr("1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n");

    offsets[2] = totalLen;
    const kids = pages.map((_, i) => `${3 + i * 3} 0 R`).join(" ");
    pushStr(`2 0 obj\n<< /Type /Pages /Kids [${kids}] /Count ${pages.length} >>\nendobj\n`);

    pages.forEach((pg, i) => {
      const pageObj = 3 + i * 3, imgObj = pageObj + 1, contObj = pageObj + 2;
      // Letter-ratio images (the 2D canvas) fill the page; others get a margin.
      const margin = Math.abs(pg.w / pg.h - PT_W / PT_H) < 0.01 ? 0 : 18;
      const s = Math.min((PT_W - margin * 2) / pg.w, (PT_H - margin * 2) / pg.h);
      const dw = pg.w * s, dh = pg.h * s;
      const dx = (PT_W - dw) / 2, dy = (PT_H - dh) / 2;
      const contentBytes = enc.encode(`q ${dw.toFixed(2)} 0 0 ${dh.toFixed(2)} ${dx.toFixed(2)} ${dy.toFixed(2)} cm /Im0 Do Q\n`);

      offsets[pageObj] = totalLen;
      pushStr(`${pageObj} 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PT_W} ${PT_H}] /Resources << /XObject << /Im0 ${imgObj} 0 R >> /ProcSet [/PDF /ImageC] >> /Contents ${contObj} 0 R >>\nendobj\n`);

      offsets[imgObj] = totalLen;
      pushStr(`${imgObj} 0 obj\n<< /Type /XObject /Subtype /Image /Width ${pg.w} /Height ${pg.h} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${pg.bytes.length} >>\nstream\n`);
      pushBytes(pg.bytes);
      pushStr("\nendstream\nendobj\n");

      offsets[contObj] = totalLen;
      pushStr(`${contObj} 0 obj\n<< /Length ${contentBytes.length} >>\nstream\n`);
      pushBytes(contentBytes);
      pushStr("endstream\nendobj\n");
    });

    const maxObj = 2 + pages.length * 3;
    const xrefOffset = totalLen;
    let xref = `xref\n0 ${maxObj + 1}\n0000000000 65535 f \n`;
    for (let i = 1; i <= maxObj; i++) xref += String(offsets[i]).padStart(10, "0") + " 00000 n \n";
    pushStr(xref);
    pushStr(`trailer\n<< /Size ${maxObj + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`);

    const out = new Uint8Array(totalLen);
    let off = 0;
    for (const c of chunks) { out.set(c, off); off += c.length; }
    return new Blob([out], { type: "application/pdf" });
  };

  const downloadPDF = () => {
    const canvas = renderExportCanvas();
    const pages = [{ bytes: dataUrlToBytes(canvas.toDataURL("image/jpeg", 0.92)), w: canvas.width, h: canvas.height }];
    const shot3d = render3DSnapshotRef.current;
    if (shot3d) pages.push({ bytes: dataUrlToBytes(shot3d.url), w: shot3d.w, h: shot3d.h });
    const blob = buildPdfFromJpegPages(pages);
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    const nameSlug = contact.name.trim().replace(/\s+/g, "-").toLowerCase() || "customer";
    a.download = `structurestudio-${nameSlug}-${bldgW}x${bldgH}.pdf`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  // ─── STYLES ───
  const S = {
    sel: { border: "1px solid #CBD5E1", borderRadius: 6, padding: "5px 8px", fontSize: 13, fontWeight: 600, background: "#FFF", minWidth: 90 },
    lbl: { fontSize: 11, fontWeight: 700, color: "#64748B", textTransform: "uppercase", letterSpacing: "0.06em" },
    btn: (bg, fg) => ({ background: bg, color: fg, border: "none", borderRadius: 6, padding: "5px 12px", fontSize: 12, fontWeight: 700, cursor: "pointer" }),
    card: (active) => ({
      cursor: "pointer", borderRadius: 10, overflow: "hidden", transition: "all 0.2s",
      border: `3px solid ${active ? accent : "#E2E8F0"}`,
      boxShadow: active ? `0 0 0 2px ${accent}, 0 4px 12px ${accent}40` : "0 2px 8px rgba(0,0,0,0.06)",
      transform: active ? "scale(1.03)" : "scale(1)",
    }),
    cardLabel: (active) => ({
      padding: "6px 8px", textAlign: "center", fontWeight: 700, fontSize: 11,
      background: active ? "#FFFBEB" : "#FAFBFC", color: active ? "#92400E" : "#334155",
    }),
    check: { position: "absolute", top: 4, right: 4, width: 20, height: 20, borderRadius: 99, background: accent, display: "flex", alignItems: "center", justifyContent: "center", color: "#FFF", fontSize: 11, fontWeight: 800 },
    pill: (active) => ({
      padding: "8px 14px", borderRadius: 8, cursor: "pointer", fontWeight: 700, fontSize: 13, transition: "all 0.15s",
      border: `2px solid ${active ? accent : "#E2E8F0"}`,
      background: active ? "#FFFBEB" : "#FAFBFC", color: active ? "#92400E" : "#334155",
      boxShadow: active ? `0 0 0 2px ${accent}` : "none",
    }),
  };

  // ─── PAINT FIELDS (inline, beside Roof Options) ───
  // Body/Trim color pickers backed by the tenant palette (portal Colors tab).
  // Moved out of renderOption so the paint option can sit beside the roof
  // colors in the Size row, while other counter options keep rendering as
  // pill rows below. Logic is unchanged: "Unpainted" is just the tenant's
  // default palette color (owner-priced in the Colors tab) — it is NOT
  // synthesized here. sel.paint ("No Paint"/"Painted") stays the
  // save/load/estimate contract and is derived from the picks: the build is
  // "Painted" once a chosen Body/Trim color differs from that side's default
  // color (or is a custom color).
  const renderPaintFields = (opt) => {
    const palette = Array.isArray(C.colors) ? C.colors : [];
    // flex-basis 170px (not flex:1) so on a phone each color field wraps onto
    // its own full-width row instead of overflowing the page horizontally.
    const PAINT_LBL = { display: "flex", alignItems: "center", gap: 4, flex: "1 1 170px", fontSize: 12, fontWeight: 600, color: "#475569", minWidth: 0 };
    const PAINT_INPUT = { flex: 1, minWidth: 0, border: "1px solid #CBD5E1", borderRadius: 6, padding: "5px 8px", fontSize: 12, outline: "none" };
    const defaultLabel = (k) => {
      const d = palette.find((c) => (k === "body" ? c.siding : c.trim) && c.isDefault);
      return d ? d.label : "";
    };
    const sidePainted = (k, v, custom) => custom || (!!v && v !== defaultLabel(k));
    const paintField = (kind) => {
      const colors = palette.filter((c) => (kind === "body" ? c.siding : c.trim));
      const val = paintColors[kind] || "";
      const set = (v) => setPaintColors((p) => ({ ...p, [kind]: v }));
      const labelTxt = kind === "body" ? "Body:" : "Trim:";
      const other = kind === "body" ? "trim" : "body";
      // No palette configured for this side → free-text. Any text on either side = painted.
      if (colors.length === 0) {
        return (
          <label style={PAINT_LBL}>{labelTxt}
            <input type="text" value={val}
              onChange={(e) => { const v = e.target.value; set(v); setSel((p) => ({ ...p, [opt.id]: (v || paintColors[other]) ? "Painted" : "No Paint" })); }}
              placeholder="Enter color or leave blank" style={PAINT_INPUT} />
          </label>
        );
      }
      const match = colors.find((c) => c.label === val && !c.allowCustom);
      const customColor = colors.find((c) => c.allowCustom);
      const isCustom = paintCustom[kind] || (!match && !!val && !!customColor);
      const selectVal = isCustom && customColor ? customColor.label : (match ? match.label : "");
      const onSel = (label) => {
        const c = colors.find((x) => x.label === label);
        const custom = !!(c && c.allowCustom);
        if (custom) { setPaintCustom((p) => ({ ...p, [kind]: true })); set(""); }
        else { setPaintCustom((p) => ({ ...p, [kind]: false })); set(label); }
        // Recompute the build's paint state from both sides (a custom pick counts as painted).
        const painted = sidePainted(kind, custom ? "" : label, custom) || sidePainted(other, paintColors[other], paintCustom[other]);
        setSel((p) => ({ ...p, [opt.id]: painted ? "Painted" : "No Paint" }));
      };
      return (
        <div style={{ ...PAINT_LBL, gap: 4 }}>
          <span>{labelTxt}</span>
          <ColorSelect value={selectVal} colors={colors} onPick={onSel} />
          {isCustom && (
            <input type="text" value={val} onChange={(e) => set(e.target.value)} placeholder="Exact color" style={PAINT_INPUT} />
          )}
        </div>
      );
    };
    return (
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center", minWidth: 0 }}>
        {opt.img && (
          <div style={{ flex: "0 0 auto", width: 100, borderRadius: 10, overflow: "hidden", border: "2px solid #E2E8F0" }}>
            <img src={opt.img} alt={opt.label} style={{ width: "100%", height: 80, objectFit: "cover", display: "block" }} />
          </div>
        )}
        {paintField("body")}
        {paintField("trim")}
      </div>
    );
  };

  // ─── OPTION RENDERER ───
  const renderOption = (opt) => {
    if (opt.type === "image_cards") {
      return (
        <div key={opt.id} style={{ marginBottom: 14 }}>
          <span style={{ ...S.lbl, display: "block", marginBottom: 8 }}>{opt.label}</span>
          <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
            {opt.choices.map((ch) => {
              const active = sel[opt.id] === ch.value;
              return (
                <div key={ch.value} onClick={() => setSel((p) => ({ ...p, [opt.id]: ch.value }))} style={{ ...S.card(active), width: 130, flex: "0 0 auto" }}>
                  {ch.img ? (
                    <div style={{ position: "relative" }}>
                      <img src={ch.img} alt={ch.label} style={{ width: "100%", height: 85, objectFit: "cover", display: "block" }} />
                      {active && <div style={S.check}>✓</div>}
                    </div>
                  ) : (
                    <div style={{ height: 85, background: active ? "#FEF3C7" : "#F1F5F9", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 13, fontWeight: 700, color: active ? "#92400E" : "#64748B", position: "relative" }}>
                      {ch.label.includes("None") || ch.label.includes("No ") ? "None" : ch.label}
                      {active && <div style={S.check}>✓</div>}
                    </div>
                  )}
                  <div style={S.cardLabel(active)}>{ch.label}</div>
                </div>
              );
            })}
          </div>
        </div>
      );
    }
    if (opt.type === "counter") {
      // Paint renders inline beside Roof Options (see the Size/Roof/Paint row
      // and renderPaintFields); the map below filters it out — guard anyway.
      if (opt.id === "paint") return null;
      const hasImage = !!opt.img;
      return (
        <div key={opt.id} style={{ marginBottom: 14 }}>
          <span style={{ ...S.lbl, display: "block", marginBottom: 8 }}>{opt.label}</span>
          <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "flex-start" }}>
            {hasImage && (
              <div style={{ flex: "0 0 auto", width: 100, borderRadius: 10, overflow: "hidden", border: "2px solid #E2E8F0" }}>
                <img src={opt.img} alt={opt.label} style={{ width: "100%", height: 80, objectFit: "cover", display: "block" }} />
              </div>
            )}
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap", flex: 1, alignItems: "center", minWidth: 0 }}>
              {opt.options.map((o) => (
                <div key={o} onClick={() => setSel((p) => ({ ...p, [opt.id]: o }))} style={{ ...S.pill(sel[opt.id] === o), flexShrink: 0 }}>{o}</div>
              ))}
            </div>
          </div>
        </div>
      );
    }
    return null;
  };

  // ─── RENDER ───
  // Lead-capture gate (name + phone), shown as a dimmed/blurred modal over the live page.
  // While the modal is open the designer subtree is marked `inert` and page scroll is
  // locked; the gate is portaled to <body> so it stays interactive outside that subtree.
  // The gate is INTERACTION-triggered (Ahsan 2026-07-24): the page loads fully
  // visible and browsable; the popup appears only when a not-yet-captured visitor
  // tries to work the 2D canvas (arm a tool, place, or drag an item). gatePassed
  // (remembered browsers, ?id= reopens), the operator preview (isAdmin), and
  // embedded portal mounts never see it.
  const gateRequired = !gatePassed && !isAdmin && !embedded;
  const [gateOpen, setGateOpen] = useState(false);
  const showGate = gateRequired && gateOpen;
  // Gate identity chip (public page only): who this browser is remembered as, plus a
  // reset. contact.name is live right after passing the gate; the localStorage copy
  // covers return visits (the gate flag alone carries no name).
  const gateName = useMemo(() => {
    const live = (contact.name || "").trim();
    if (live) return live.split(/\s+/)[0];
    try { return ((localStorage.getItem("ss_gate_name_" + (C.clientId || "")) || "").trim().split(/\s+/)[0]) || ""; } catch (_e) { return ""; }
  }, [contact.name, C.clientId]);
  const resetGate = () => {
    try {
      localStorage.removeItem("ss_gate_" + (C.clientId || ""));
      localStorage.removeItem("ss_gate_name_" + (C.clientId || ""));
    } catch (_e) {}
    // Strip the design code (and version) from the URL — a bare reload would keep
    // ?id=, which re-passes the gate and rehydrates the same contact, making the
    // button a no-op on share-link reopens and post-submit pages.
    const p = new URLSearchParams(window.location.search);
    p.delete("id"); p.delete("v");
    window.location.replace(window.location.pathname + (p.toString() ? "?" + p.toString() : ""));
  };
  const gateBgRef = useRef(null);
  useEffect(() => {
    const el = gateBgRef.current;
    if (el) { if (showGate) el.setAttribute("inert", ""); else el.removeAttribute("inert"); }
    document.body.style.overflow = showGate ? "hidden" : "";
    return () => { document.body.style.overflow = ""; };
  }, [showGate]);
  const gateEl = showGate ? (
    <LeadGate config={C} supabase={supabase} accent={accent}
      onClose={() => setGateOpen(false)}
      onPass={(info) => {
        if (info && (info.name || info.phone)) setContact((p) => ({ ...p, name: info.name || p.name, phone: info.phone || p.phone }));
        try {
          localStorage.setItem("ss_gate_" + (C.clientId || ""), "1");
          if (info && info.name) localStorage.setItem("ss_gate_name_" + (C.clientId || ""), info.name);
        } catch (_e) {}
        setGatePassed(true);
        setGateOpen(false);
      }} />
  ) : null;
  // ── 3D Style Calibration ───────────────────────────────────────────────
  // 3D Style Calibration. Two ways in: the operator panel on the public page
  //     (?admin=1), and -- through the setup3d contract -- the BUILDER inside their own
  //     portal, which is the point of the feature. Deliberately a sibling of the admin
  //     panel rather than a child: that panel also carries the GHL credentials, which
  //     must never surface inside a tenant portal.
  // Held in a variable rather than written inline: Settings → Designer → 3D mounts
  // this component with `calibrationOnly` and renders ONLY this panel, so the panel
  // has to be reachable from two different returns.
  // Frames from a walk-around are views 1-4 of one lap, not four staged elevations —
  // labelling them Front/Back/Left/Right would be a guess about where the walk started.
  // A plain const, deliberately: everything from here down is JSX held in a variable, and
  // a hook below the calibrationOnly early return would change hook order between the two
  // returns (React #310 — this file has form for it).
  // The four Front/Back/Left/Right slots are GONE. Ahsan on the 2026-08-24 call, when
  // Carolyn asked "are you still thinking of leaving that in there?": "No, I'll remove it
  // because now we have added the video option now."
  //
  // What survives is the same four slots used READ-ONLY as thumbnails of the frames the
  // walk-around video produced -- the video path spreads four of its eight frames across
  // them, and seeing what the model actually looked at is the whole reason a builder trusts
  // the drafted shape. `d3_photos` and upload_style_photo stay exactly as they are; only the
  // manual entry path and the photo-draft button are removed.
  const photoLabels = ["View 1", "View 2", "View 3", "View 4"];
  const cal3dPanel = showCal3D && (
        <div style={{ background: "#FFFBEB", borderBottom: "1px solid #FCD34D", padding: "12px 20px" }}>
          <span style={{ fontWeight: 700, fontSize: 13, color: "#92400E" }}>🧊 3D Style Calibration</span>
          <span style={{ fontSize: 11, color: "#92400E", marginLeft: 8 }}>
            {setup3d
              ? "Pick one of your styles, add photos of a real building, tune it against the live 3D preview, then Save. This is what your customers see in 3D."
              : "Pick a style, paste its four-side photo URLs, tune the spec against the live preview, then Save (or Copy JSON into building_styles.d3)."}
          </span>
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap", margin: "8px 0" }}>
            {C.buildingStyles.map((s) => (
              <button key={s.value} onClick={() => openCalEditor(s)}
                style={{ ...S.btn(adminCal && adminCal.styleValue === s.value ? "#92400E" : "#FFF", adminCal && adminCal.styleValue === s.value ? "#FFF" : "#92400E"), border: "1px solid #FCD34D" }}>
                {s.label}
              </button>
            ))}
          </div>
          {adminCal && (
            <div>
              {/* ── Building scan. Only in the portal: it needs the builder's own session to
                  upload into a private bucket, and a scan is theirs, not ours. The scan is a
                  REFERENCE — we measure it and build the parametric model from the numbers,
                  because the mesh itself cannot be edited, priced or quoted. ── */}
              {/* ── Walk-around video. The low-friction path: any phone, no app, no
                  export step. It reads the SHAPE only — size, colour and material are
                  settings the customer changes afterwards, so nothing here needs to be
                  measured. Gated on onUploadPhoto/onDraftFromVideo rather than
                  onUploadModel: this path needs no `models` bucket at all. ── */}
              {setup3d && setup3d.onUploadPhoto && setup3d.onDraftFromVideo && (
                <div style={{ border: "1px solid #FCD34D", borderRadius: 8, background: "#FFF", padding: "10px 12px", marginBottom: 10 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                    <span style={{ fontWeight: 800, fontSize: 12.5, color: "#92400E" }}>🎥 Walk-around video</span>
                    <span style={{ fontSize: 11, fontWeight: 700, color: "#047857", background: "#ECFDF5", borderRadius: 5, padding: "2px 6px" }}>easiest</span>
                  </div>
                  <p style={{ margin: "6px 0 8px", fontSize: 11.5, color: "#92400E", lineHeight: 1.5 }}>
                    Film one slow lap of a real building — phone sideways, whole building in frame, about 30 to 60 seconds.
                    We read the roof shape, pitch, overhang and wall height off it and set this style up to match.
                    <b> The video stays on your phone</b> — only a few still frames are sent.
                  </p>
                  <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                    <label style={{ ...S.btn("#92400E", "#FFF"), fontSize: 12, cursor: adminCalVideo.busy || scan.status === "locked" ? "default" : "pointer", opacity: scan.status === "locked" ? 0.5 : 1, marginBottom: 0 }}>
                      {adminCalVideo.busy ? (adminCalVideo.step || "Working…") : "Choose a walk-around video"}
                      <input type="file" accept="video/*" disabled={adminCalVideo.busy || adminCalBusy || scan.status === "locked"}
                        onChange={(e) => {
                          const f = e.target.files && e.target.files[0];
                          e.target.value = "";
                          if (!f) return;
                          // A NEW file must never be read from the previous one's frames.
                          setAdminCalVideo({ busy: false, step: null, err: null, count: 0, urls: null, observed: null, read: 0 });
                          calibrateFromVideo(f, null);
                        }}
                        style={{ display: "none" }} />
                    </label>
                    {adminCalVideo.urls && !adminCalVideo.busy && (
                      <button onClick={() => calibrateFromVideo(null, adminCalVideo.urls)}
                        title="Re-read the same frames. Costs one AI draft, no re-upload."
                        style={{ ...S.btn("#FFF", "#7C3AED"), border: "1px solid #DDD6FE", fontSize: 12 }}>Read it again</button>
                    )}
                  </div>
                  {adminCalVideo.err && <div style={{ marginTop: 8, fontSize: 11.5, color: "#DC2626", fontWeight: 600 }}>{adminCalVideo.err}</div>}
                  {adminCalVideo.read > 0 && !adminCalVideo.busy && (
                    <div style={{ marginTop: 8, fontSize: 12, color: "#0F172A" }}>
                      <b>{adminCalVideo.read} views</b> read from your walk-around.
                      {adminCalVideo.observed && (
                        <div style={{ marginTop: 6, display: "grid", gap: 3, fontSize: 11.5, color: "#334155" }}>
                          {adminCalVideo.observed.roofNote && <div><b>Roof:</b> {adminCalVideo.observed.roofNote}</div>}
                          {adminCalVideo.observed.eave && <div><b>Eave:</b> {adminCalVideo.observed.eave}</div>}
                          {adminCalVideo.observed.doors && <div><b>Doors:</b> {adminCalVideo.observed.doors}</div>}
                          {adminCalVideo.observed.windows && <div><b>Windows:</b> {adminCalVideo.observed.windows}</div>}
                          {adminCalVideo.observed.vents && <div><b>Vents:</b> {adminCalVideo.observed.vents}</div>}
                          {adminCalVideo.observed.confidence && (
                            <div style={{ color: adminCalVideo.observed.confidence === "low" ? "#B45309" : "#64748B" }}>
                              Confidence: <b>{adminCalVideo.observed.confidence}</b>
                              {adminCalVideo.observed.confidence !== "high" ? " — check the roof numbers below against the building." : ""}
                            </div>
                          )}
                        </div>
                      )}
                      {/* Said every time, not only on low confidence: a ground-level camera
                          NEVER sees the roof planes, and the two roof shapes the spec cannot
                          express are the two a builder is most likely to film. */}
                      <div style={{ marginTop: 6, fontSize: 11.5, color: "#B45309", lineHeight: 1.5 }}>
                        Roofs are read from the ground, so check the pitch below. Doors, windows and vents are placed in the designer — the video only sets the building's shape.
                      </div>
                    </div>
                  )}
                </div>
              )}
              {setup3d && setup3d.onUploadModel && (
                <div style={{ border: "1px solid #FCD34D", borderRadius: 8, background: "#FFF", padding: "10px 12px", marginBottom: 10 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                    <span style={{ fontWeight: 800, fontSize: 12.5, color: "#92400E" }}>📐 Scan of a real building</span>
                    {scan.status !== "none" && (
                      <span style={{ fontSize: 11, fontWeight: 800, borderRadius: 5, padding: "2px 6px",
                        background: scan.status === "locked" ? "#ECFDF5" : "#F1F5F9",
                        color: scan.status === "locked" ? "#047857" : "#475569" }}>
                        {scan.status === "locked" ? "locked" : scan.status}
                      </span>
                    )}
                    <span style={{ flex: 1 }} />
                    {scan.status === "locked"
                      ? <button onClick={() => scanSetStatus("uploaded")} disabled={scan.busy} style={{ ...S.btn("#FFF", "#92400E"), border: "1px solid #FCD34D", fontSize: 11.5 }}>Unlock</button>
                      : <button onClick={() => scanSetStatus("locked")} disabled={scan.busy || scan.status === "none"} style={{ ...S.btn("#FFF", "#047857"), border: "1px solid #A7F3D0", fontSize: 11.5 }}>Lock this 3D setup</button>}
                  </div>
                  <p style={{ margin: "6px 0 8px", fontSize: 11.5, color: "#92400E", lineHeight: 1.5 }}>
                    Walk around one of your real buildings with a phone scanning app and export a <b>.glb</b>. We read its
                    size and roof shape and set the 3D up to match — the scan itself is never shown to customers.
                  </p>
                  <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap", marginBottom: 6 }}>
                    <span style={{ fontSize: 11, fontWeight: 700, color: "#92400E" }}>Your phone:</span>
                    {[["iphone-pro", "iPhone Pro (LiDAR)"], ["iphone", "other iPhone"], ["android", "Android"]].map(([k, lbl]) => (
                      <button key={k} onClick={() => setScan((p) => ({ ...p, device: p.device === k ? null : k }))}
                        style={{ ...S.btn(scan.device === k ? "#92400E" : "#FFF", scan.device === k ? "#FFF" : "#92400E"), border: "1px solid #FCD34D", fontSize: 11, padding: "3px 8px" }}>
                        {lbl}
                      </button>
                    ))}
                  </div>
                  {scan.device && (
                    <p style={{ margin: "0 0 8px", fontSize: 11, color: "#78350F", lineHeight: 1.5 }}>
                      {scan.device === "iphone-pro" && <>Scaniverse (free, no account): <b>New Scan → Mesh</b>, walk slowly all the way around, process on-device, then <b>Share → Export Model → GLB</b>. LiDAR gives the cleanest mesh.</>}
                      {scan.device === "iphone" && <>No LiDAR on this model — Scaniverse still works in photo mode: circle the building slowly in good light, expect a rougher mesh, then <b>Share → Export Model → GLB</b>.</>}
                      {scan.device === "android" && <>Android phones scan by photos: use <b>Scaniverse</b> (free) or <b>Kiri Engine</b> (free account) — circle the building slowly in good light, then export as <b>GLB</b>.</>}
                    </p>
                  )}
                  <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                    <label style={{ ...S.btn("#92400E", "#FFF"), fontSize: 12, cursor: scan.busy || scan.status === "locked" ? "default" : "pointer", opacity: scan.status === "locked" ? 0.5 : 1, marginBottom: 0 }}>
                      {scan.busy ? (scan.step || "Working…") : "Choose a .glb scan"}
                      <input type="file" accept=".glb,model/gltf-binary" disabled={scan.busy || scan.status === "locked"}
                        onChange={(e) => { const f = e.target.files && e.target.files[0]; e.target.value = ""; scanPick(f); }}
                        style={{ display: "none" }} />
                    </label>
                    {scan.status !== "none" && !scan.measured && !scan.busy && setup3d && setup3d.onLoadModelUrl && (
                      <button onClick={scanFetchStored} style={{ ...S.btn("#FFF", "#0E7490"), border: "1px solid #A5F3FC", fontSize: 12 }}>Re-measure the stored scan</button>
                    )}
                    {scan.measured && !scan.busy && (
                      <>
                        <button onClick={scanGenerate} disabled={adminCalPreview}
                          title={scan.aiReady === false
                            ? "AI is off for this site — this applies the measurements only."
                            : "Measure, render the scan from four sides, and let AI read the siding + colours."}
                          style={{ ...S.btn("#7C3AED", "#FFF"), fontSize: 12, opacity: adminCalPreview ? 0.5 : 1 }}>✨ Generate 3D from this scan</button>
                        <button onClick={scanApply} style={{ ...S.btn("#0E7490", "#FFF"), fontSize: 12 }}>Use these measurements</button>
                        <button onClick={scanUpload} style={{ ...S.btn("#FFF", "#92400E"), border: "1px solid #FCD34D", fontSize: 12 }}>Save the scan to this style</button>
                      </>
                    )}
                  </div>
                  {scan.err && <div style={{ marginTop: 8, fontSize: 11.5, color: "#DC2626", fontWeight: 600 }}>{scan.err}</div>}
                  {scan.measured && (
                    <div style={{ marginTop: 8, fontSize: 12, color: "#0F172A" }}>
                      <b>{scan.measured.widthFt} × {scan.measured.depthFt} ft</b>{" · "}
                      walls <b>{scan.measured.eaveFt} ft</b>{" · "}
                      peak <b>{scan.measured.peakFt} ft</b>{" · "}
                      <b>{scan.measured.roofType}</b> roof, pitch <b>{scan.measured.pitch}</b>
                      {scan.measured.overhangFt ? <>{", overhang "}<b>{scan.measured.overhangFt} ft</b></> : null}
                      {scan.measured.gambrel && (
                        <span style={{ color: "#64748B" }}>{" "}(knee {scan.measured.gambrel.kneeU} / rise {scan.measured.gambrel.kneeRise} / ridge {scan.measured.gambrel.ridgeRise})</span>
                      )}
                      <span style={{ color: "#64748B" }}>{" "}(from {scan.measured.sampled.toLocaleString()} surface points)</span>
                      {scan.measured.warn && <div style={{ marginTop: 4, color: "#B45309", fontWeight: 600 }}>⚠ {scan.measured.warn}</div>}
                      {(() => {
                        const matches = scanSizeMatchesFor(scan.measured);
                        if (matches.length) {
                          return (
                            <div style={{ marginTop: 6, display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
                              <span style={{ fontSize: 11, fontWeight: 700, color: "#92400E" }}>Closest sizes you sell:</span>
                              {matches.map((s) => (
                                <button key={s.label} onClick={() => scanApplySize(s.label)}
                                  style={{ ...S.btn("#FFF", "#0E7490"), border: "1px solid #A5F3FC", fontSize: 11.5, padding: "3px 8px" }}>
                                  {s.label}{s.score === 0 ? " ✓" : ` (±${s.score} ft)`}
                                </button>
                              ))}
                            </div>
                          );
                        }
                        return (
                          <div style={{ marginTop: 6, fontSize: 11.5, color: "#B45309", fontWeight: 600 }}>
                            You don't sell a {scan.measured.widthFt}×{scan.measured.depthFt} — add it under Settings → Catalog, or pick your closest size.
                          </div>
                        );
                      })()}
                    </div>
                  )}
                </div>
              )}
              {/* The drawing sits directly ABOVE the numbers it explains, and directly
                  beside the reference-photo thumbnails, so "film it, then nudge the
                  drawing" becomes the obvious workflow. The fitting engine already exists
                  (walk-around video / draft from photos) -- it was just undiscoverable
                  behind a wall of raw ratios. */}
              <div style={{ marginBottom: 8 }}>
                <D3ElevationSVG spec={adminCal.spec} sizeLabel={sel.size} focusKey={calFocus} />
                <div style={{ fontSize: 10, color: "#A16207", marginTop: 3 }}>
                  End elevation at {sel.size || "this size"}. Click a number below and its dimension lights up.
                </div>
              </div>
              <div style={{ display: "grid", gap: 8, gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", marginBottom: 8 }}>
                <label style={{ fontSize: 11, color: "#92400E", fontWeight: 700 }}>Roof type
                  <select value={adminCal.spec.roof.type} onChange={(e) => calSetRoof({ type: e.target.value })} style={{ ...S.sel, width: "100%", boxSizing: "border-box" }}>
                    {/* "Single slant" is what ShedPro and Carolyn both call a shed roof.
                        The value stays "shed" -- this is a label, not a new roof type. */}
                    <option value="gable">Gable (two slopes)</option>
                    <option value="shed">Single slant (shed roof)</option>
                    <option value="gambrel">Gambrel (barn)</option>
                  </select>
                </label>
                <label style={{ fontSize: 11, color: "#92400E", fontWeight: 700 }}>Pitch (rise/run)
                  <input type="number" step="0.05" value={adminCal.spec.roof.pitch != null ? adminCal.spec.roof.pitch : 0.4} onChange={(e) => calSetRoof({ pitch: parseFloat(e.target.value) || 0 })} onFocus={() => setCalFocus("pitch")} onBlur={() => setCalFocus(null)} style={{ ...S.sel, width: "100%", boxSizing: "border-box" }} />
                </label>
                <label style={{ fontSize: 11, color: "#92400E", fontWeight: 700 }}>Overhang (ft)
                  <input type="number" step="0.05" value={adminCal.spec.roof.overhang != null ? adminCal.spec.roof.overhang : 0.6} onChange={(e) => calSetRoof({ overhang: parseFloat(e.target.value) || 0 })} onFocus={() => setCalFocus("overhang")} onBlur={() => setCalFocus(null)} style={{ ...S.sel, width: "100%", boxSizing: "border-box" }} />
                </label>
                <label style={{ fontSize: 11, color: "#92400E", fontWeight: 700 }}>Ridge offset (−0.35…0.35)
                  <input type="number" step="0.05" value={adminCal.spec.roof.ridgeOffset != null ? adminCal.spec.roof.ridgeOffset : 0} onChange={(e) => calSetRoof({ ridgeOffset: parseFloat(e.target.value) || 0 })} onFocus={() => setCalFocus("ridgeOffset")} onBlur={() => setCalFocus(null)} style={{ ...S.sel, width: "100%", boxSizing: "border-box" }} />
                </label>
                <label style={{ fontSize: 11, color: "#92400E", fontWeight: 700 }}>Wall height (ft)
                  <input type="number" step="0.5" value={adminCal.spec.wallHeightFt || 8} onChange={(e) => calSet({ wallHeightFt: parseFloat(e.target.value) || 0 })} onFocus={() => setCalFocus("wallHeightFt")} onBlur={() => setCalFocus(null)} style={{ ...S.sel, width: "100%", boxSizing: "border-box" }} />
                </label>
                {/* The empty "plain" option is gone (2026-08-25). It was the LABEL FOR null,
                    which the renderer draws as panel siding -- so it named a thing the
                    customer never sees and meant nothing to the builder reading it.
                    Normalising the value through d3NormalizeCladding maps a stored null to
                    "panel", so an untouched style shows exactly what it already renders and
                    the pixels do not move; the first save just writes it down explicitly. */}
                <label style={{ fontSize: 11, color: "#92400E", fontWeight: 700 }}>Siding (this style&rsquo;s standard)
                  <select value={d3NormalizeCladding(adminCal.spec.siding)} onChange={(e) => calSet({ siding: e.target.value })} style={{ ...S.sel, width: "100%", boxSizing: "border-box" }}>
                    <option value="panel">Panel siding (SmartSide, DuraTemp, T1-11)</option>
                    <option value="lap">Lap siding</option>
                    <option value="batten">Board &amp; batten</option>
                    <option value="agpanel">Metal</option>
                  </select>
                </label>
              </div>
              {/* Which of the four this style OFFERS the customer. Carolyn, 2026-08-24:
                  "they don't offer metal here, but there's some other clients that do."

                  All four ticked is the SAME as saying nothing, so that case stores
                  nothing at all -- an untouched style keeps a spec byte-identical to the
                  one it has today, and a builder who never opens this row is unaffected. */}
              <div style={{ marginBottom: 8 }}>
                <div style={{ fontSize: 11, color: "#92400E", fontWeight: 700, marginBottom: 4 }}>Cladding this style offers the customer</div>
                <div style={{ display: "flex", flexWrap: "wrap", gap: 12 }}>
                  {D3_CLADDING_CHOICES.map((id) => {
                    const offered = d3CladdingChoicesFor({ d3: adminCal.spec });
                    const on = offered.indexOf(id) !== -1;
                    return (
                      <label key={id} style={{ fontSize: 11, color: "#92400E", display: "flex", alignItems: "center", gap: 4, cursor: "pointer" }}>
                        <input
                          type="checkbox"
                          checked={on}
                          onChange={() => {
                            const next = D3_CLADDING_CHOICES.filter((c) => (c === id ? !on : offered.indexOf(c) !== -1));
                            // Nothing ticked is a slip, not an instruction -- it would leave
                            // the customer no cladding at all -- and everything ticked is the
                            // default. Both store `undefined`, which JSON.stringify drops, so
                            // the column stays absent rather than growing a list saying nothing.
                            const store = (next.length === 0 || next.length === D3_CLADDING_CHOICES.length) ? undefined : next;
                            calSet({ claddingChoices: store });
                          }}
                        />
                        {D3_CLADDING[id].label}
                      </label>
                    );
                  })}
                </div>
              </div>
              {/* LEAN-TO and DORMER. Both are off at zero width, which is why they sit in
                  their own row rather than the main grid -- a builder who wants neither
                  should not have to read four controls to establish that. */}
              <div style={{ display: "grid", gap: 8, gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", marginBottom: 8 }}>
                <label style={{ fontSize: 11, color: "#92400E", fontWeight: 700 }}>Lean-to width (ft, 0 = none)
                  <input type="number" step="0.5" min="0" value={adminCal.spec.roof.leanToWidthFt != null ? adminCal.spec.roof.leanToWidthFt : 0} onChange={(e) => calSetRoof({ leanToWidthFt: parseFloat(e.target.value) || 0 })} style={{ ...S.sel, width: "100%", boxSizing: "border-box" }} />
                </label>
                {(adminCal.spec.roof.leanToWidthFt || 0) > 0.5 && (
                  <label style={{ fontSize: 11, color: "#92400E", fontWeight: 700 }}>Lean-to drop (ft)
                    <input type="number" step="0.25" min="0" value={adminCal.spec.roof.leanToDropFt != null ? adminCal.spec.roof.leanToDropFt : 1} onChange={(e) => calSetRoof({ leanToDropFt: parseFloat(e.target.value) || 0 })} style={{ ...S.sel, width: "100%", boxSizing: "border-box" }} />
                  </label>
                )}
                {(adminCal.spec.roof.leanToWidthFt || 0) > 0.5 && (
                  <label style={{ fontSize: 11, color: "#92400E", fontWeight: 700 }}>Lean-to side
                    <select value={adminCal.spec.roof.leanToSide || "right"} onChange={(e) => calSetRoof({ leanToSide: e.target.value })} style={{ ...S.sel, width: "100%", boxSizing: "border-box" }}>
                      <option value="right">Right eave</option>
                      <option value="left">Left eave</option>
                    </select>
                  </label>
                )}
                {adminCal.spec.roof.type !== "shed" && (
                  <label style={{ fontSize: 11, color: "#92400E", fontWeight: 700 }}>Dormer width (ft, 0 = none)
                    <input type="number" step="0.5" min="0" value={adminCal.spec.roof.dormerWidthFt != null ? adminCal.spec.roof.dormerWidthFt : 0} onChange={(e) => calSetRoof({ dormerWidthFt: parseFloat(e.target.value) || 0 })} style={{ ...S.sel, width: "100%", boxSizing: "border-box" }} />
                  </label>
                )}
                {adminCal.spec.roof.type !== "shed" && (adminCal.spec.roof.dormerWidthFt || 0) > 0.5 && (
                  <label style={{ fontSize: 11, color: "#92400E", fontWeight: 700 }}>Dormer rise (ft)
                    <input type="number" step="0.25" min="0" value={adminCal.spec.roof.dormerRiseFt != null ? adminCal.spec.roof.dormerRiseFt : 2.5} onChange={(e) => calSetRoof({ dormerRiseFt: parseFloat(e.target.value) || 0 })} style={{ ...S.sel, width: "100%", boxSizing: "border-box" }} />
                  </label>
                )}
                {adminCal.spec.roof.type !== "shed" && (adminCal.spec.roof.dormerWidthFt || 0) > 0.5 && (
                  <label style={{ fontSize: 11, color: "#92400E", fontWeight: 700 }}>Dormer position (&minus;1 &hellip; 1)
                    <input type="number" step="0.05" value={adminCal.spec.roof.dormerOffsetU != null ? adminCal.spec.roof.dormerOffsetU : 0.45} onChange={(e) => calSetRoof({ dormerOffsetU: parseFloat(e.target.value) || 0 })} style={{ ...S.sel, width: "100%", boxSizing: "border-box" }} />
                  </label>
                )}
              </div>
              {adminCal.spec.roof.type === "gambrel" && (
                <div style={{ display: "grid", gap: 8, gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", marginBottom: 8 }}>
                  <label style={{ fontSize: 11, color: "#92400E", fontWeight: 700 }}>Gambrel knee position (0–1)
                    <input type="number" step="0.05" value={adminCal.spec.roof.kneeU != null ? adminCal.spec.roof.kneeU : 0.55} onChange={(e) => calSetRoof({ kneeU: parseFloat(e.target.value) || 0 })} onFocus={() => setCalFocus("kneeU")} onBlur={() => setCalFocus(null)} style={{ ...S.sel, width: "100%", boxSizing: "border-box" }} />
                  </label>
                  <label style={{ fontSize: 11, color: "#92400E", fontWeight: 700 }}>Knee rise (× half-span)
                    <input type="number" step="0.05" value={adminCal.spec.roof.kneeRise != null ? adminCal.spec.roof.kneeRise : 0.55} onChange={(e) => calSetRoof({ kneeRise: parseFloat(e.target.value) || 0 })} onFocus={() => setCalFocus("kneeRise")} onBlur={() => setCalFocus(null)} style={{ ...S.sel, width: "100%", boxSizing: "border-box" }} />
                  </label>
                  <label style={{ fontSize: 11, color: "#92400E", fontWeight: 700 }}>Ridge rise (× half-span)
                    <input type="number" step="0.05" value={adminCal.spec.roof.ridgeRise != null ? adminCal.spec.roof.ridgeRise : 0.8} onChange={(e) => calSetRoof({ ridgeRise: parseFloat(e.target.value) || 0 })} onFocus={() => setCalFocus("ridgeRise")} onBlur={() => setCalFocus(null)} style={{ ...S.sel, width: "100%", boxSizing: "border-box" }} />
                  </label>
                </div>
              )}
              <div style={{ display: "grid", gap: 8, gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", marginBottom: 8 }}>
                {/* Carolyn, 2026-08-24: "this body color and trim color and roof color needs to
                    go with the colors that are in THEIR database ... it's going to be so much
                    easier for them."

                    The hex box STAYS. These three are the UNPAINTED natural-material colours
                    -- bare wood, galvalume -- which are deliberately not paint-catalog rows,
                    and styleD3.ts enforces hex-only on the column. The picker is sugar over
                    the same input: choosing a catalog colour writes its hex into the field, so
                    there is no server change, no migration and no new save action. A builder
                    who wants a colour that is not in their catalog can still type one.

                    Roof pulls from shingle OR metal rows because the unpainted roof colour is
                    a roofing product, not a paint. */}
                {["body", "trim", "roof"].map((k) => {
                  const pool = (Array.isArray(C.colors) ? C.colors : []).filter((c) =>
                    (k === "body" ? c.siding : k === "trim" ? c.trim : (c.shingle || c.metal)) && c.hex && !c.allowCustom);
                  return (
                  <label key={k} style={{ fontSize: 11, color: "#92400E", fontWeight: 700, textTransform: "capitalize" }}>{k} color (unpainted)
                    <div style={{ display: "flex", gap: 4, alignItems: "center" }}>
                      <input type="text" placeholder="#hex or blank" value={adminCal.spec.colors[k] || ""} onChange={(e) => calSetColor(k, e.target.value)} style={{ ...S.sel, width: "100%", boxSizing: "border-box" }} />
                      <span style={{ width: 22, height: 22, borderRadius: 4, border: "1px solid #FCD34D", background: adminCal.spec.colors[k] || "#EEE", flexShrink: 0 }} />
                    </div>
                    {/* Hidden rather than shown-empty when the tenant has no colours of this
                        kind on file: an empty picker beside a working text box reads as broken. */}
                    {pool.length > 0 && (
                      <select
                        value=""
                        onChange={(e) => { if (e.target.value) calSetColor(k, e.target.value); }}
                        title="Pick from your colour catalog"
                        style={{ ...S.sel, width: "100%", boxSizing: "border-box", marginTop: 4, fontWeight: 400 }}
                      >
                        <option value="">Pick from your colours…</option>
                        {pool.map((c) => <option key={c.label} value={c.hex}>{c.label}</option>)}
                      </select>
                    )}
                  </label>
                );})}
              </div>
              <div style={{ display: "grid", gap: 8, gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", marginBottom: 8 }}>
                {/* READ-ONLY. These are the frames the walk-around video produced, shown so a
                    builder can see what the model actually looked at -- not slots to fill in.
                    Nothing renders at all before a video has been read, rather than four
                    empty boxes implying there is something to do here. */}
                {adminCalVideo.count > 0 && photoLabels.map((side, i) => (
                  adminCal.photos[i] ? (
                    <div key={side} style={{ fontSize: 11, color: "#92400E", fontWeight: 700 }}>
                      {side}
                      <div style={{ marginTop: 3 }}>
                        <img src={adminCal.photos[i]} alt={side} style={{ width: "100%", maxWidth: 120, height: 72, objectFit: "cover", borderRadius: 4, border: "1px solid #FCD34D" }} />
                      </div>
                    </div>
                  ) : null
                ))}
              </div>
              <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                {/* The sample building the preview renders on. calibrationOnly ONLY, for the
                    same reason calSetSize is: over the full designer this row sits above a
                    customer's plan, and a size change there would clear it. A pitch or a
                    gambrel knee reads completely differently on a 10x12 than on a 12x32, so
                    calibrating against one fixed small shell was the actual problem. */}
                {calibrationOnly && calSizeOpts().length > 0 && (
                  <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, fontWeight: 700, color: "#92400E" }}>
                    Preview on
                    <select value={sel.size || ""} onChange={(e) => calSetSize(e.target.value)}
                      style={{ ...S.sel, minWidth: 110, border: "1px solid #FCD34D" }}>
                      {calSizeOpts().map((sz) => <option key={sz} value={sz}>{sz}</option>)}
                    </select>
                  </label>
                )}
                {/* Full screen stays even with the dock up: it is the ONLY 3D on a narrow or
                    touch screen (where dockOn is false), and the bigger view on a wide one. */}
                <button onClick={() => setAdminCalPreview(true)}
                  title={calibrationOnly && dockOn ? "Open the 3D at full screen" : "Preview this style in 3D"}
                  style={{ ...S.btn("#7C3AED", "#FFF"), padding: "8px 14px", fontSize: 13 }}>
                  {calibrationOnly && dockOn ? "⛶ Full screen 3D" : "🧊 Preview in 3D"}
                </button>
                {/* Without this the ✕ on the docked panel's header would be a one-way door.
                    Same wording as the designer toolbar's dock toggle, deliberately. dockOn
                    requires `embedded`, so this never appears on the ?admin=1 page, which
                    renders this same const from the full return. */}
                {calibrationOnly && dockOn && (
                  <button onClick={() => setCalDock3D((v) => !v)}
                    style={{ ...S.btn("#FFF", "#7C3AED"), border: "1px solid #DDD6FE", fontSize: 12 }}>
                    {calDock3D ? "🧊 Hide 3D" : "🧊 Show 3D"}
                  </button>
                )}
                {/* Copy-JSON is the operator's escape hatch when a save path is down; a
                    builder has no use for it and no place to paste it. */}
                {!setup3d && <button onClick={copyCalJson} style={{ ...S.btn("#FFF", "#92400E"), border: "1px solid #FCD34D", fontSize: 12 }}>Copy d3 JSON</button>}
                {/* Disabled with a reason when the Anthropic key is not set on the server: the
                    browser cannot see an edge secret, so `aiReady` from the catalog action is the
                    only way to avoid offering a button that always fails. */}
                {/* "Draft from photos (AI)" removed 2026-08-25 with the four manual slots it
                    fed. One way in -- the walk-around video -- rather than two paths to the
                    same spec, one of which asked a builder to stage four photographs.
                    calibrateFromPhotos and onDraftFromPhotos remain wired for the operator
                    scan path; only this entry point is gone. */}
                <button onClick={saveCalSpec} disabled={adminCalBusy} style={{ ...S.btn(adminCalBusy ? "#9CA3AF" : "#92400E", "#FFF"), padding: "8px 14px", fontSize: 13, cursor: adminCalBusy ? "wait" : "pointer" }}>
                  {adminCalBusy ? "Saving…" : (setup3d ? "Save 3D look" : "Save to config")}
                </button>
              </div>
              {adminCalMsg && (
                <div style={{ marginTop: 8, fontSize: 12, color: adminCalMsg.ok ? "#166534" : "#DC2626", fontWeight: 600, wordBreak: "break-all" }}>
                  {adminCalMsg.msg}
                </div>
              )}
            </div>
          )}
        </div>
  );
  // Operator calibration preview: the current layout rendered with the
  //     DRAFT spec being edited — tune numbers against the reference photos.
  const cal3dPreview = showCal3D && adminCal && adminCalPreview && (
        <Structure3DViewer
          bldgW={bldgW} bldgH={bldgH} items={items} itemTypes={ITEMS}
          styleValue={adminCal.styleValue} frontWall={frontWall}
          painted={false} paintBody="" paintTrim=""
          scale={scale} mgX={mgX} mgY={mgY} accent={accent}
          style3d={adminCal.spec}
          fixtures={C.fixtures} doorColors={doorPaintColors} windowColors={windowColorList} bodyColors={bodyPaintPool} trimColors={trimPaintPool}
          paletteKeys={Object.keys(ITEMS).filter((k) => ITEMS[k] && !ITEMS[k].noPalette && (embedded || !ITEMS[k].internalOnly))}
          placeableDoors={placeableDoors} placeableWindows={placeableWindows} placeableRamps={placeableRamps}
          paintEnabled={false}
          onSnapshot={() => {}}
          onClose={() => setAdminCalPreview(false)}
        />
  );

  // Settings → Designer → 3D. The calibration editor needs everything this component
  // already computes (the style list, the resolved config, the live 3D preview), so the
  // portal mounts the whole component and takes just this surface — no toolbar, no
  // canvas, no estimate. Every hook above still runs, which is what keeps hook order
  // identical between this return and the full designer below.
  if (calibrationOnly) {
    // Side-by-side since 2026-08-22 (Carolyn): "in the same way that the designer Tab now has
    // the 3D view on the side of the layout, I want that same thing happening in the designer
    // settings so as we change the view settings we can immediately see what it is doing in
    // the 3D and adjust accordingly." Same Structure3DPanel, same dock-capability rule, one
    // different width threshold, and the DRAFT spec instead of the saved one.
    //
    // `adminCal` is in the term because the form body only renders once a style is picked —
    // a 3D panel beside nothing but the style chips is a WebGL context spent on decoration.
    const calDock = Boolean(adminCal) && view3dOn && dockOn && calDock3D;
    return (
      <div style={{ fontFamily: "'Segoe UI', system-ui, -apple-system, sans-serif" }}>
        {showCal3D
          ? (
            /* Measured on the ROW, like the designer's canvas row, for the same reason: the
               portal sidebar collapses from 240px to 68px at max-width:900px, so a viewport
               threshold would switch the dock ON for the narrower layout and OFF for the
               wider one. alignItems:"flex-start" is also what leaves the sticky column room
               to move — the flex default (stretch) makes it full-height and inert. */
            <div ref={canvasRowRef} style={{ display: "flex", alignItems: "flex-start", gap: !adminCalPreview && calDock ? 12 : 0 }}>
              {/* minWidth:0 is load-bearing, same as the canvas row: the form's auto-fit grids
                  have an intrinsic min-content width, so without it the row overflows
                  sideways instead of reflowing six columns down to three. */}
              <div style={{ flex: "1 1 auto", minWidth: 0 }}>{cal3dPanel}</div>
              {/* The `!adminCalPreview` term sits ON the render site and is never read from a
                  variable — that is what makes the docked panel and the full-screen viewer
                  below structurally unable to hold two WebGL contexts at once, the same
                  guarantee {!(show3D || adminCalPreview)} gives the full designer. React runs
                  this subtree's cleanup (dispose + forceContextLoss) before mounting the
                  modal in the same commit. */}
              {!adminCalPreview && calDock && (
                /* top:74, not the designer's 12: this mounts inside the portal's NORMALLY
                   SCROLLING .ss-inner, under a position:sticky .ss-topbar ~62px tall. top:12
                   would park the panel behind it. */
                <div style={{ flex: "0 0 clamp(320px, 34%, 480px)", height: "min(560px, 72vh)", position: "sticky", top: 74, marginTop: 12, marginRight: 12 }}>
                  <Structure3DPanel
                    /* Remount on the sample building's size and nothing else — same rule as
                       the designer. Wall height deliberately does NOT remount: fitHeightFt
                       re-frames in place, because here the height is what is being typed. */
                    key={`${bldgW}x${bldgH}`}
                    bldgW={bldgW} bldgH={bldgH} items={items} itemTypes={ITEMS}
                    /* The DRAFT spec, NOT d3ResolveStyleSpec(...) — an unsaved slider showing
                       up here is the whole feature. painted/roofType/roofColorHex are pinned
                       to what cal3dPreview passes, so the docked view and the full-screen one
                       cannot disagree about what a style looks like. */
                    style3d={adminCal.spec}
                    fitHeightFt={adminCal.spec.wallHeightFt || 0}
                    painted={false} paintBody="" paintTrim=""
                    roofType="" roofColorHex=""
                    frontWall={frontWall} scale={scale} mgX={mgX} mgY={mgY}
                    fixtures={C.fixtures} doorColors={doorPaintColors} windowColors={windowColorList} bodyColors={bodyPaintPool} trimColors={trimPaintPool}
                    /* Nothing drags on this surface, and no canEdit: there is no plan to edit
                       here, so the panel's "⛶ Edit in 3D" footer never renders. */
                    suspended={false}
                    onClose={() => setCalDock3D(false)}
                  />
                </div>
              )}
            </div>
          )
          : <div style={{ fontSize: 13, color: "#64748B" }}>3D isn't turned on for this account yet.</div>}
        {cal3dPreview}
      </div>
    );
  }
  return (
    <div ref={gateBgRef} style={{ fontFamily: "'Segoe UI', system-ui, -apple-system, sans-serif", background: "#F8FAFC", minHeight: embedded ? "100%" : "100vh" }}>
      {gateEl && createPortal(gateEl, document.body)}
      {doorPick && createPortal(<DoorPicker doors={placeableDoors} showPricing={!!C.showPricing} doorColors={doorPaintColors} paintBody={paintColors.body} paintTrim={paintColors.trim} onCancel={() => { setDoorPick(null); setSwapId(null); }} onPlace={placePickedDoor} />, document.body)}
      {rampPick && createPortal(<RampPicker ramps={placeableRamps} showPricing={!!C.showPricing} onCancel={() => { setRampPick(null); setSwapId(null); }} onPlace={placePickedRamp} />, document.body)}
      {windowPick && createPortal(<WindowPicker windows={placeableWindows} showPricing={!!C.showPricing} windowColors={windowColorList} onCancel={() => { setWindowPick(null); setSwapId(null); }} onPlace={placePickedWindow} />, document.body)}
      {/* Size change refused: something on the plan has nowhere to go in the smaller
          building. The size is ALREADY back to what it was (the reflow is computed before
          anything is committed), so this only has to explain and get out of the way. */}
      {sizeBlock && createPortal(
        <div onClick={() => setSizeBlock(null)} style={{ position: "fixed", inset: 0, background: "rgba(15,23,42,0.45)", zIndex: 9000, display: "flex", alignItems: "center", justifyContent: "center", padding: 16 }}>
          <div onClick={(e) => e.stopPropagation()} style={{ background: "#FFF", borderRadius: 14, width: "min(520px, 96vw)", maxHeight: "88vh", overflow: "auto", padding: 20, boxShadow: "0 20px 60px rgba(0,0,0,0.3)" }}>
            <div style={{ fontSize: 17, fontWeight: 800, color: "#1E293B", marginBottom: 6 }}>
              {sizeBlock.items.length === 1 ? "One item won't fit" : `${sizeBlock.items.length} items won't fit`} in a {sizeBlock.to}
            </div>
            <div style={{ fontSize: 13, color: "#64748B", lineHeight: 1.5, marginBottom: 14 }}>
              Everything else would have moved across fine, but there's nowhere to put:
            </div>
            <ul style={{ margin: "0 0 16px", paddingLeft: 20, fontSize: 13.5, color: "#1E293B", lineHeight: 1.7 }}>
              {sizeBlock.items.map((e) => <li key={e.id}><b>{e.label}</b></li>)}
            </ul>
            <div style={{ fontSize: 13, color: "#64748B", lineHeight: 1.5, marginBottom: 16 }}>
              Your building is still <b>{sizeBlock.from}</b> and nothing on the plan has changed.
              Delete {sizeBlock.items.length === 1 ? "it" : "them"} — or make room by removing something
              else — then pick the size again.
            </div>
            <div style={{ display: "flex", justifyContent: "flex-end" }}>
              <button type="button" onClick={() => setSizeBlock(null)} style={{ background: accent, color: "#FFF", border: "none", borderRadius: 8, padding: "9px 18px", fontSize: 13.5, fontWeight: 700, cursor: "pointer", fontFamily: "inherit" }}>Got it</button>
            </div>
          </div>
        </div>, document.body)}
      {/* Header — suppressed when embedded (the portal supplies its own topbar). The
          public page is customers-only: no Business Login link (Carolyn 2026-07-24);
          instead a gate identity chip shows who this browser is remembered as. */}
      {!embedded && (
      <div style={{ background: C.branding.headerBg || "linear-gradient(135deg, #1E293B 0%, #334155 100%)", color: "#FFF", padding: "14px 20px", display: "flex", alignItems: "center", gap: 12 }}>
        {C.branding.logo
          ? <img src={C.branding.logo} alt={C.branding.companyName || "logo"} style={{ width: 34, height: 34, borderRadius: 8, objectFit: "contain", flexShrink: 0, background: "rgba(255,255,255,0.12)" }} />
          : <div style={{ width: 34, height: 34, background: accent, borderRadius: 8, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 15, fontWeight: 800, flexShrink: 0, letterSpacing: "-0.05em", color: "#FFF" }}>{initials}</div>}
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 17, fontWeight: 700, letterSpacing: "-0.02em" }}>{C.branding.companyName || "Design Studio"}</div>
          <div style={{ fontSize: 11, color: "#94A3B8", marginTop: 1 }}>{C.branding.tagline || "Design & Quote"}</div>
        </div>
        <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 4, flexShrink: 0 }}>
          {gatePassed && !isAdmin && (
            <div style={{ display: "flex", alignItems: "center", gap: 8, whiteSpace: "nowrap" }}>
              <span style={{ fontSize: 12, color: "#E2E8F0" }}>{gateName ? `Designing as ${gateName}` : "Welcome back"}</span>
              <button type="button" onClick={resetGate} title="Clear this browser's saved visitor and start fresh"
                style={{ fontSize: 11, fontWeight: 700, color: "#FFF", background: "rgba(255,255,255,0.14)", border: "1px solid rgba(255,255,255,0.3)", borderRadius: 8, padding: "4px 10px", cursor: "pointer" }}>
                Not you? Start over
              </button>
            </div>
          )}
          <div style={{ fontSize: 10, color: "#94A3B8", whiteSpace: "nowrap" }}>Powered by Structure Studio</div>
        </div>
      </div>
      )}

      {/* Admin Panel — only visible with ?admin=1. Lets the operator save GHL Location ID + API Key for this client.
          The API key is stored in Supabase (RLS-locked) and only ever read by the submit-estimate Edge Function. */}
      {isAdmin && (
        <div style={{ background: "#FEF3C7", borderBottom: "2px solid #F59E0B", padding: "14px 20px" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
            <span style={{ fontWeight: 700, fontSize: 14, color: "#92400E" }}>🔒 GHL Integration — Admin</span>
            <span style={{ fontSize: 11, color: "#92400E" }}>Client: <code>{C.clientId}</code></span>
          </div>
          <p style={{ margin: "0 0 10px", fontSize: 12, color: "#92400E" }}>
            Set the GHL Location ID and Private Integration Token for this client. Once saved, credentials live in Supabase and are only read server-side — they never reach customer browsers.
          </p>
          <div style={{ display: "grid", gap: 8, gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))" }}>
            <PasswordInput value={adminPwd} onChange={(e) => setAdminPwd(e.target.value)} placeholder="Admin password" style={{ ...S.sel, width: "100%", boxSizing: "border-box" }} />
            <input type="text" value={adminLocId} onChange={(e) => setAdminLocId(e.target.value)} placeholder="GHL Location ID" style={{ ...S.sel, width: "100%", boxSizing: "border-box" }} />
            <PasswordInput value={adminApiKey} onChange={(e) => setAdminApiKey(e.target.value)} placeholder="GHL API Key (pit-…)" style={{ ...S.sel, width: "100%", boxSizing: "border-box" }} />
          </div>
          <div style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 10, flexWrap: "wrap" }}>
            <button onClick={saveAdminSettings} disabled={adminBusy} style={{ ...S.btn(adminBusy ? "#9CA3AF" : "#92400E", "#FFF"), padding: "8px 18px", fontSize: 13, cursor: adminBusy ? "wait" : "pointer" }}>
              {adminBusy ? "Saving…" : "Save GHL Settings"}
            </button>
            <button onClick={checkAdminStatus} disabled={adminBusy || !adminPwd} style={{ ...S.btn("#FFF", "#92400E"), border: "1px solid #FCD34D", fontSize: 12 }}>
              Check status
            </button>
            {adminStatus && adminStatus.configured && (
              <span style={{ fontSize: 12, color: "#166534", fontWeight: 600 }}>
                ✓ Configured — Loc {adminStatus.ghlLocationIdMasked}, saved {new Date(adminStatus.updatedAt).toLocaleString()}
              </span>
            )}
            {adminStatus && !adminStatus.configured && (
              <span style={{ fontSize: 12, color: "#92400E", fontWeight: 600 }}>Not yet configured for this client.</span>
            )}
          </div>
          {adminMsg && (
            <div style={{ marginTop: 8, fontSize: 12, color: adminMsg.ok ? "#166534" : "#DC2626", fontWeight: 600 }}>
              {adminMsg.msg}
            </div>
          )}
        </div>
      )}

      {cal3dPanel}

      {/* Inventory estimate: the building already exists, so the plan is read-only. The
          money lines below (custom options, discount, delivery) stay fully editable —
          that is the whole point of quoting one lot building to several customers. */}
      {planLocked && (
        <div style={{ background: "#EFF6FF", borderBottom: "1px solid #BFDBFE", padding: "11px 20px", display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
          <span style={{ fontSize: 13, fontWeight: 700, color: "#1E3A8A" }}>
            🔒 Inventory building{designUnit && designUnit.serial != null ? ` #${designUnit.serial}` : ""} — already built, so the plan can't be changed.
          </span>
          <span style={{ fontSize: 12.5, color: "#1E40AF", fontWeight: 600 }}>
            Custom options, a discount and a delivery fee can still be added below.
          </span>
          {embedded && (
            <button type="button" onClick={() => {
              if (!window.confirm("Design a brand-new building for this customer instead?\n\nThe plan unlocks so you can change anything. Submitting saves it as another version of this quote, no longer tied to the inventory building.")) return;
              setNewBuildMode(true);
              inventoryUnitRef.current = null;
            }} style={{ marginLeft: "auto", background: "#FFF", color: "#1D4ED8", border: "1.5px solid #93C5FD", borderRadius: 8, padding: "7px 14px", fontSize: 12.5, fontWeight: 800, cursor: "pointer", whiteSpace: "nowrap" }}>
              Design a new build instead
            </button>
          )}
        </div>
      )}
      {/* Started on an inventory building, then staff chose to design fresh. */}
      {embedded && newBuildMode && designUnit && (
        <div style={{ background: "#F0FDF4", borderBottom: "1px solid #BBF7D0", padding: "10px 20px", fontSize: 12.5, fontWeight: 700, color: "#15803D" }}>
          ✎ Designing a new build for this customer — submitting saves it as another version, no longer tied to building{designUnit.serial != null ? ` #${designUnit.serial}` : ""}.
        </div>
      )}
      {/* Quoting a spec build that has NOT been built yet (migration 102 made this reachable:
          a customer can buy a building that is still in the queue). The plan is deliberately
          editable here — but the rep needs to know that what they change is what the shop
          will make, which is a very different thing from adjusting a quote. */}
      {embedded && !planLocked && !newBuildMode && designUnit && designUnit.lifecycle
        && (INV_RANKS[designUnit.lifecycle] ?? INV_BUILT_RANK) < INV_BUILT_RANK && (
        <div style={{ background: "#FFFBEB", borderBottom: "1px solid #FDE68A", padding: "10px 20px", fontSize: 12.5, fontWeight: 700, color: "#92400E" }}>
          ⚠ Building{designUnit.serial != null ? ` #${designUnit.serial}` : ""} isn’t built yet — what you change here is what gets built.
        </div>
      )}
      {/* Configuration Panel — style, size, roof, paint and options all describe the
          BUILDING, so the whole panel goes inert together when the plan is locked. One
          gate here beats fifteen `disabled` props that a new control would silently miss. */}
      {(
        // A real <fieldset disabled> — pointerEvents alone leaves every <select>/<input>
        // in the tab order, so a keyboard user could still change Building Size, and the
        // size effect wipes every item off a plan that describes a building already built.
        // fieldset disables form controls including via keyboard; pointerEvents covers the
        // style cards, which are clickable divs rather than controls. Both, deliberately.
        <fieldset disabled={planLocked || undefined} aria-disabled={planLocked || undefined}
          style={{ border: "none", margin: 0, minWidth: 0, background: "#FFF", borderBottom: "2px solid #E2E8F0", padding: "14px 20px",
            ...(planLocked ? { pointerEvents: "none", opacity: 0.62 } : {}) }}>
          {/* Building Styles */}
          <div style={{ marginBottom: 14 }}>
            <span style={{ ...S.lbl, display: "block", marginBottom: 8 }}>Select Your Building Style</span>
            <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
              {C.buildingStyles.map((s) => {
                const active = sel.style === s.value;
                return (
                  <div key={s.value} onClick={() => setSel((p) => ({ ...p, style: s.value, size: "" }))}
                    style={{ ...S.card(active), flex: "1 1 120px", maxWidth: 160 }}>
                    <div style={{ position: "relative" }}>
                      <img src={s.img} alt={s.label} style={{ width: "100%", height: 100, objectFit: "cover", display: "block" }} />
                      {active && <div style={S.check}>✓</div>}
                    </div>
                    <div style={S.cardLabel(active)}>{s.label}</div>
                  </div>
                );
              })}
            </div>
          </div>

          {/* Building Size + Roof Options + Cladding + Paint — one row. Cladding sits between
              the roof and the paint, which is exactly where Carolyn drew it (2026-08-18). */}
          {(sizeOpts.length > 0 || roofTypes.length > 0 || claddingChoices.length > 0 || paintOpt) && (
            <div style={{ display: "flex", gap: 24, flexWrap: "wrap", alignItems: "flex-start", marginBottom: 14 }}>
              {sizeOpts.length > 0 && (
                <div>
                  <span style={{ ...S.lbl, display: "block", marginBottom: 8 }}>Building Size</span>
                  <select value={sel.size || ""} onChange={(e) => setSel((p) => ({ ...p, size: e.target.value }))}
                    style={{ minWidth: 160, border: "1px solid #CBD5E1", borderRadius: 6, padding: "5px 8px", fontSize: 12, color: sel.size ? "#334155" : "#94A3B8", background: "#FFF", cursor: "pointer" }}>
                    <option value="" disabled>Select a size…</option>
                    {sizeOpts.map((s) => <option key={s} value={s}>{s}</option>)}
                  </select>
                </div>
              )}
              {roofTypes.length > 0 && (() => {
                // Roof color list depends on the chosen type. Custom-color handling mirrors paint.
                const roofList = roofColorsFor(sel.roofType);
                const rMatch = roofList.find((c) => c.label === sel.roofColor && !c.allowCustom);
                const rCustomColor = roofList.find((c) => c.allowCustom);
                const rIsCustom = roofCustom || (!rMatch && !!sel.roofColor && !!rCustomColor);
                const rSelectVal = rIsCustom && rCustomColor ? rCustomColor.label : (rMatch ? rMatch.label : "");
                const onRoofType = (type) => {
                  const dflt = roofColorsFor(type).find((c) => c.isDefault);
                  setRoofCustom(false);
                  setSel((p) => ({ ...p, roofType: type, roofColor: dflt ? dflt.label : "" }));
                };
                const onRoofColor = (label) => {
                  const c = roofList.find((x) => x.label === label);
                  if (c && c.allowCustom) { setRoofCustom(true); setSel((p) => ({ ...p, roofColor: "" })); }
                  else { setRoofCustom(false); setSel((p) => ({ ...p, roofColor: label })); }
                };
                return (
                  <div style={{ flex: 1, minWidth: 240 }}>
                    <span style={{ ...S.lbl, display: "block", marginBottom: 8 }}>Roof Options</span>
                    <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
                      <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, fontWeight: 600, color: "#475569" }}>Type:
                        <select value={sel.roofType || ""} onChange={(e) => onRoofType(e.target.value)}
                          style={{ minWidth: 130, border: "1px solid #CBD5E1", borderRadius: 6, padding: "5px 8px", fontSize: 12, color: sel.roofType ? "#334155" : "#94A3B8", background: "#FFF", cursor: "pointer" }}>
                          <option value="">Select…</option>
                          {roofTypes.map((t) => <option key={t} value={t}>{t}</option>)}
                        </select>
                      </label>
                      <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, fontWeight: 600, color: "#475569", flex: "1 1 200px", minWidth: 0 }}>
                        <span>Color:</span>
                        {sel.roofType
                          ? <ColorSelect value={rSelectVal} colors={roofList} onPick={onRoofColor} />
                          : <span style={{ flex: 1, fontSize: 12, color: "#94A3B8", fontStyle: "italic", fontWeight: 500 }}>pick a roof type first</span>}
                        {rIsCustom && sel.roofType && (
                          <input type="text" value={sel.roofColor || ""} onChange={(e) => setSel((p) => ({ ...p, roofColor: e.target.value }))} placeholder="Exact color"
                            style={{ flex: 1, minWidth: 0, border: "1px solid #CBD5E1", borderRadius: 6, padding: "5px 8px", fontSize: 12, outline: "none" }} />
                        )}
                      </div>
                    </div>
                  </div>
                );
              })()}
              {claddingChoices.length > 0 && (
                <div>
                  <span style={{ ...S.lbl, display: "block", marginBottom: 8 }}>Cladding</span>
                  <select value={sel.cladding || ""} onChange={(e) => setSel((p) => ({ ...p, cladding: e.target.value || "" }))}
                    style={{ minWidth: 160, border: "1px solid #CBD5E1", borderRadius: 6, padding: "5px 8px", fontSize: 12, color: sel.cladding ? "#334155" : "#94A3B8", background: "#FFF", cursor: "pointer" }}>
                    <option value="">Builder's standard</option>
                    {claddingChoices.map((id) => <option key={id} value={id}>{D3_CLADDING[id].label}</option>)}
                  </select>
                </div>
              )}
              {paintOpt && (
                <div style={{ flex: 1, minWidth: 260 }}>
                  <span style={{ ...S.lbl, display: "block", marginBottom: 8 }}>{paintOpt.label}</span>
                  {renderPaintFields(paintOpt)}
                </div>
              )}
            </div>
          )}

          {/* Dynamic Options (filtered by selected building style — see isOptionApplicable).
              Paint is excluded — it renders inline beside the roof colors above. */}
          {visibleOptions.filter((o) => o !== paintOpt).map((opt) => renderOption(opt))}
        </fieldset>
      )}

      {unattachedLofts.length > 0 && (
        <div style={{ background: "#FEF3C7", borderBottom: "1px solid #FCD34D", padding: "10px 16px", fontSize: 12, color: "#92400E" }}>
          <div style={{ fontWeight: 700, marginBottom: 4 }}>⚠️ Loft support warning — {unattachedLofts.length} loft{unattachedLofts.length > 1 ? "s" : ""} not properly supported</div>
          <div style={{ fontWeight: 500 }}>Each loft must have <b>both ends</b> of at least one axis (left+right OR top+bottom) resting on a wall or another loft. Adjust position or size to fix.</div>
        </div>
      )}

      {/* What the size change did to the layout. A strip rather than the toast, because
          the toast's headline is hard-coded to "Can't place here" (wrong here) and it
          self-dismisses in 4s — this is something the customer needs to still be able to
          read after they look back at the plan. Sliding along the same wall is deliberately
          NOT reported: it is what anyone expects when a building grows or shrinks, and
          listing it would bury the two changes that actually matter. */}
      {reflowNote && reflowNote.length > 0 && (
        <div style={{ background: "#EFF6FF", borderBottom: "1px solid #BFDBFE", padding: "10px 16px", fontSize: 12, color: "#1E3A8A", display: "flex", gap: 10, alignItems: "flex-start" }}>
          <span style={{ flexShrink: 0 }}>📐</span>
          <div style={{ flex: 1 }}>
            <div style={{ fontWeight: 700, marginBottom: 4 }}>Your layout moved to fit the new size</div>
            <div style={{ fontWeight: 500 }}>
              {reflowNote.map((e, i) => (
                <span key={e.id}>
                  {i > 0 ? "; " : ""}
                  <b>{e.label}</b>{e.kind === "movedWall"
                    ? ` moved to ${wallPhrase(e.to, frontWall)}`
                    : ` was shortened to ${e.to} ft`}
                </span>
              ))}
              . Everything else kept its place.
            </div>
          </div>
          <button type="button" onClick={() => setReflowNote(null)}
            style={{ background: "none", border: "none", color: "#1E3A8A", cursor: "pointer", fontSize: 15, fontWeight: 800, lineHeight: 1, flexShrink: 0 }}>✕</button>
        </div>
      )}

      {/* Tool Palette. The ROW stays — Export and the 3D teaser live in it and neither
          touches the building. Only the plan-editing controls inside it go away when the
          plan is locked (hiding the whole row took Export with it). */}
      <div style={{ background: "#FFF", borderBottom: "1px solid #E2E8F0", padding: "10px 20px", display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
        {!planLocked && (() => {
          const btn = ([key, cfg]) => (
            <button key={key} onClick={() => { if (gateRequired) { setGateOpen(true); return; } setActiveTool(activeTool === key ? null : key); setSelectedId(null); }}
              style={{
                display: "inline-flex", alignItems: "center", gap: 4, padding: "5px 10px", borderRadius: 7, fontSize: 12, fontWeight: 600, cursor: "pointer", transition: "all 0.15s", position: "relative",
                background: activeTool === key ? cfg.color : "#F8FAFC",
                color: activeTool === key ? "#FFF" : "#334155",
                border: `2px solid ${activeTool === key ? cfg.color : "#E2E8F0"}`,
              }}>
              <span style={{ fontSize: 14, display: "inline-flex", alignItems: "center" }}>{key === "singleDoor" || key === "doorPicker" ? <DoorIcon /> : key === "doubleDoor" ? <DoorIcon double /> : cfg.icon}</span>{cfg.label}
              {(cfg.wallOnly || cfg.wallSnap) && <span style={{ fontSize: 9, opacity: 0.7, background: activeTool === key ? "rgba(255,255,255,0.25)" : "#F1F5F9", borderRadius: 3, padding: "1px 4px" }}>wall</span>}
            </button>
          );
          const entries = Object.entries(ITEMS).filter(([, c]) => c && !c.noPalette && (embedded || !c.internalOnly));
          const incl = includedItemKeys.length ? entries.filter(([k]) => includedItemKeys.includes(k)) : [];
          const addl = includedItemKeys.length ? entries.filter(([k]) => !includedItemKeys.includes(k)) : entries;
          // Decline control for an included item: X it off (a deduction line is added on the
          // estimate). Declined items don't have to be placed on the layout.
          const declined = Array.isArray(sel.declinedItems) ? sel.declinedItems : [];
          const toggleDecline = (key) => {
            const cur = Array.isArray(sel.declinedItems) ? sel.declinedItems : [];
            const declining = !cur.includes(key);
            if (declining) {
              // Declining removes it from the layout (like Delete) — a declined item can't be placed,
              // so any already-placed instances are cleared (cascading a door's snapped ramp, like
              // delSel) and the tool is deselected if active.
              setItems((its) => {
                const removedIds = new Set(its.filter((it) => it.type === key || it.fixtureItemId === key).map((it) => it.id));
                return its.filter((it) => !(it.type === key || it.fixtureItemId === key) && !(it.type === "ramp" && removedIds.has(it.snapDoorId)));
              });
              setActiveTool((t) => (t === key ? null : t));
              setSelectedId(null);
            }
            setSel((p) => {
              const c = Array.isArray(p.declinedItems) ? p.declinedItems : [];
              return { ...p, declinedItems: c.includes(key) ? c.filter((k) => k !== key) : [...c, key] };
            });
          };
          // Included chips show the included quantity when it's more than a single unit
          // (loft quantities are square footage; everything else is a count).
          const withQty = (key, cfg) => {
            const q = includedItemQty[key] || 1;
            if (q <= 1) return cfg;
            return { ...cfg, label: key === "loft" ? `${cfg.label} (${q} sq ft)` : `${cfg.label} ×${q}` };
          };
          const inclBtn = ([key, rawCfg]) => { const cfg = withQty(key, rawCfg); return declined.includes(key)
            ? (
              <span key={key} title="You declined this included item — it'll show as a deduction on your estimate"
                style={{ display: "inline-flex", alignItems: "center", gap: 6, padding: "5px 10px", borderRadius: 7, fontSize: 12, fontWeight: 600, background: "#F1F5F9", color: "#94A3B8", border: "2px dashed #CBD5E1" }}>
                <span style={{ textDecoration: "line-through" }}>{cfg.label}</span>
                <button onClick={() => toggleDecline(key)} title="Add it back" style={{ background: "transparent", border: "none", cursor: "pointer", color: "#334155", fontWeight: 700, fontSize: 11 }}>Undo</button>
              </span>
            )
            : (
              <span key={key} style={{ display: "inline-flex", alignItems: "center" }}>
                {btn([key, cfg])}
                <button onClick={() => toggleDecline(key)} title={`Decline ${cfg.label} (deduction)`}
                  style={{ marginLeft: 2, background: "transparent", border: "none", cursor: "pointer", color: "#94A3B8", fontWeight: 800, fontSize: 13, lineHeight: 1 }}>✕</button>
              </span>
            ); };
          if (incl.length === 0) {
            return (<>
              <span style={{ ...S.lbl, marginRight: 4, fontSize: 10 }}>Place:</span>
              {addl.map(btn)}
            </>);
          }
          // Included items on their own row, a full-width horizontal rule, then the additional
          // options below (width:100% children force line breaks inside the wrapping flex row).
          return (<>
            <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 6, width: "100%" }}>
              <span style={{ ...S.lbl, marginRight: 4, fontSize: 10, color: "#15803D" }}>✓ Included — place or decline:</span>
              {incl.map(inclBtn)}
            </div>
            <div style={{ width: "100%", borderTop: "1px solid #CBD5E1", margin: "2px 0" }} />
            <span style={{ ...S.lbl, marginRight: 4, fontSize: 10 }}>Additional options:</span>
            {addl.map(btn)}
          </>);
        })()}
        {activeTool && <span style={{ fontSize: 11, color: accent, fontWeight: 600, marginLeft: 6 }}>← {ITEMS[activeTool] && ITEMS[activeTool].doorSnap ? "Click near a door" : `Click ${ITEMS[activeTool] && (ITEMS[activeTool].wallOnly || ITEMS[activeTool].wallSnap) ? "a wall" : "the layout"}`}</span>}
        <div style={{ marginLeft: "auto", display: "flex", gap: 6, alignItems: "center" }}>
          {selectedId && (() => {
            // Swap: change a placed door/window/ramp (built-in OR catalog) to a current catalog one,
            // in place. Deliberate click only — dragging/nudging never opens it. Essential for
            // replacing an ARCHIVED item; hidden if there's nothing to swap to.
            const si = items.find((i) => i.id === selectedId);
            if (!si) return null;
            if (planLocked) return null;
            const isDoor = si.type === "fixtureDoor" || si.type === "singleDoor" || si.type === "doubleDoor";
            const isWin = si.type === "window";
            const isRamp = si.type === "ramp";
            if (!(isDoor || isWin || isRamp)) return null;
            const pool = isDoor ? placeableDoors : isWin ? placeableWindows : placeableRamps;
            if (!pool || pool.length === 0) return null;
            const archived = isArchivedItem(si);
            const openSwap = () => {
              setSwapId(si.id); setActiveTool(null); setToast(null);
              if (isDoor) setDoorPick({ swap: true }); else if (isWin) setWindowPick({ swap: true }); else setRampPick({ swap: true });
            };
            return <>
              {archived && <span style={{ fontSize: 11, fontWeight: 700, color: "#B45309" }}>⚠ Archived — swap it →</span>}
              <button onClick={openSwap} style={{ ...S.btn(archived ? "#FEF3C7" : "#ECFEFF", archived ? "#B45309" : "#0891B2"), border: `1px solid ${archived ? "#FCD34D" : "#A5F0FC"}` }}>⇄ Swap</button>
            </>;
          })()}
          {selectedId && !planLocked && (
            <>
              <button onClick={rotSel} style={{ ...S.btn("#EEF2FF", "#4F46E5"), border: "1px solid #C7D2FE" }}>↻ Rotate</button>
              <button onClick={delSel} style={{ ...S.btn("#FEF2F2", "#DC2626"), border: "1px solid #FECACA" }}>✕ Delete</button>
            </>
          )}
          {/* Export survives the lock — printing the plan changes nothing about it. */}
          {!planLocked && <button onClick={clearAll} style={{ ...S.btn("#F1F5F9", "#64748B"), border: "1px solid #E2E8F0" }}>Clear</button>}
          {/* 3D is gated by the lock too: the 3D modal edits items through its own handlers,
              so opening it on an inventory unit would bypass planLocked. A view-only 3D for
              locked plans is a planned follow-up. (Beta's "coming soon" 3D teaser is
              superseded on this branch — the real button ships here.) */}
          {/* The gate has to hold here too: the 3D view is not a preview, it PLACES and
              DRAGS items through the same pipeline as the 2D canvas, so without this an
              anonymous shopper could design a whole building without ever being asked who
              they are — which is the one thing the gate exists to prevent. */}
          {/* planLocked is relaxed for the DOCK only. The comment above is why: the
              modal edits items through its own handlers, so it would bypass the lock.
              The panel registers no handlers at all — it is the "view-only 3D for
              locked plans" that comment names as the planned follow-up. Its "Edit in
              3D" button is hidden when locked, and setShow3D is unreachable from here
              whenever dockOn, so there is no one-click route into the editor. */}
          {(!planLocked || dockOn) && view3dOn && (
            <button onClick={() => {
              if (gateRequired) { setGateOpen(true); return; }
              if (dockOn) setDock3D((v) => !v);
              else setShow3D(true);   // narrow or touch: byte-identical to before
            }} style={S.btn(dock3D ? "#5B21B6" : "#7C3AED", "#FFF")}>
              {/* No ✓ badge in docked mode: the snapshot is cleared on every
                  items/sel/paint/size change, so a tick beside a live panel would
                  flicker off on every keystroke and read as a bug. */}
              {dock3D ? "🧊 Hide 3D" : dockOn ? "🧊 3D View" : (has3DSnapshot ? "🧊 3D ✓" : "🧊 3D View")}
            </button>
          )}
          {/* Not granted 3D yet: keep the marketing teaser shoppers already see on the
              public designer, so a tenant without the feature sees NO change. Portal
              users never get the teaser - business users see 3D Design in their nav. */}
          {!view3dOn && customerFacing && (
            <button disabled title="See your building in 3D — coming soon"
              style={{ ...S.btn("#F8FAFC", "#94A3B8"), border: "1px dashed #CBD5E1", cursor: "default", display: "inline-flex", alignItems: "center", gap: 5 }}>
              3D
              <span style={{ fontSize: 9, fontWeight: 800, letterSpacing: 0.4, textTransform: "uppercase", background: "#75E6DA", color: "#0F4C46", borderRadius: 5, padding: "1.5px 5px" }}>Coming&nbsp;soon</span>
            </button>
          )}
          <button onClick={exportPNG} style={S.btn("#059669", "#FFF")}>📷 Export</button>
        </div>
      </div>

      {/* (The old "Note text:" banner is gone — notes are edited by typing
          directly in the note on the canvas: click a selected note, or place a
          new one, and the caret appears in the pill itself.) */}

      {/* Pick-one-to-remove mode: dim + block the whole page except the plan (the svg
          elevates above the scrim), pulse-highlight the candidates, and ask the user
          to click the one to remove. Cancel (or ESC) exits without removing. */}
      {pendingRemoval && (() => {
        const prCfg = ITEMS[pendingRemoval.type];
        // Row label first: catalog rows' keys (fx:<id> …) are not ITEMS keys, and a raw
        // key is not a user-facing name (audit 2026-08-20).
        const prLbl = pendingRemoval.label || (prCfg && prCfg.label) || pendingRemoval.type;
        return (
          <>
            <div style={{ position: "fixed", inset: 0, background: "rgba(15,23,42,0.45)", zIndex: 900 }} />
            <div style={{ position: "fixed", top: 14, left: "50%", transform: "translateX(-50%)", zIndex: 902, background: "#1E293B", color: "#FFF", borderRadius: 10, padding: "10px 16px", display: "flex", alignItems: "center", gap: 12, boxShadow: "0 8px 30px rgba(0,0,0,0.35)", maxWidth: "92vw", boxSizing: "border-box" }}>
              <span style={{ fontSize: 13, fontWeight: 600 }}>Removing one {prLbl} — click a highlighted item on the plan.</span>
              <button onClick={() => setPendingRemoval(null)}
                style={{ background: "rgba(255,255,255,0.12)", color: "#FFF", border: "1px solid rgba(255,255,255,0.35)", borderRadius: 6, padding: "4px 12px", fontSize: 12, fontWeight: 700, cursor: "pointer", flexShrink: 0 }}>Cancel</button>
            </div>
          </>
        );
      })()}

      {/* SVG Canvas. Unmounted while a full-screen 3D surface covers it: the
          hundreds of SVG nodes otherwise re-render on every 3D-driven state
          change and make every pointer-math layout read pay for the whole
          tree. Both svgRef consumers (getSvgPt, scrollIntoView) null-guard,
          and the PDF export draws from state, not this DOM. */}
      {!(show3D || adminCalPreview) && (
      <div ref={canvasRowRef} style={{ display: "flex", justifyContent: dock3D ? "flex-start" : "center", alignItems: "flex-start", gap: dock3D ? 12 : 0, padding: "16px 20px", background: "#F1F5F9", cursor: activeTool ? "crosshair" : dragging ? "grabbing" : "default" }}>
        {/* minWidth:0 is load-bearing: flex items default to min-width:auto and an
            SVG with height:auto has an intrinsic size, so without it this row
            overflows sideways instead of letting the plan shrink beside the panel. */}
        <div style={{ flex: "1 1 auto", minWidth: 0, display: "flex", justifyContent: "center" }}>
        <svg ref={svgRef} viewBox={`${frame.x} ${frame.y} ${frame.w} ${frame.h}`}
          style={{ width: "100%", maxWidth: dispMaxW, height: "auto", background: "#FFF", borderRadius: 12, boxShadow: pendingRemoval ? "0 0 0 3px #F59E0B, 0 4px 24px rgba(0,0,0,0.35)" : "0 4px 24px rgba(0,0,0,0.08)", border: "1px solid #E2E8F0", userSelect: "none", position: "relative", zIndex: pendingRemoval ? 901 : "auto" }}
          onClick={handleClick}>
          {/* Visible page background — only the area above the auto info band */}
          <rect x={0} y={0} width={cW} height={TEXT_BAND_TOP} fill="#FFF" />
          {/* Plan rectangle and grid */}
          <rect x={mgX} y={mgY} width={pW} height={pH} fill="#FAFBFD" />
          {Array.from({ length: Math.floor(bldgW) + 1 }, (_, i) => <line key={`gx${i}`} x1={mgX + i * scale} y1={mgY} x2={mgX + i * scale} y2={mgY + pH} stroke="#E8ECF1" strokeWidth={0.5} />)}
          {Array.from({ length: Math.floor(bldgH) + 1 }, (_, i) => <line key={`gy${i}`} x1={mgX} y1={mgY + i * scale} x2={mgX + pW} y2={mgY + i * scale} stroke="#E8ECF1" strokeWidth={0.5} />)}
          <rect x={mgX} y={mgY} width={pW} height={pH} fill="none" stroke="#1E293B" strokeWidth={WALL_THICKNESS} />

          {[...items].sort((a, b) => (a.type === "ramp" ? 0 : 1) - (b.type === "ramp" ? 0 : 1)).map((item) => {
            const cfg = ITEMS[item.type]; if (!cfg) return null;
            const isSel = item.id === selectedId;

            // ─── Line: rendered as a free-angle segment with two endpoint handles ───
            if (cfg.lineType) {
              const midX = (item.x1 + item.x2) / 2, midY = (item.y1 + item.y2) / 2;
              return (
                <g key={item.id} style={{ cursor: activeTool ? "crosshair" : "grab" }}>
                  {/* Wide invisible hit zone makes the line easy to grab */}
                  <line x1={item.x1} y1={item.y1} x2={item.x2} y2={item.y2}
                    stroke="transparent" strokeWidth={14} strokeLinecap="round"
                    onMouseDown={(e) => onPtrDown(e, item)} onTouchStart={(e) => onPtrDown(e, item)} />
                  <line x1={item.x1} y1={item.y1} x2={item.x2} y2={item.y2}
                    stroke={cfg.color} strokeWidth={isSel ? 3 : 2.5} strokeLinecap="round"
                    pointerEvents="none" />
                  {isSel && (
                    <>
                      <line x1={item.x1} y1={item.y1} x2={item.x2} y2={item.y2}
                        stroke="#3B82F6" strokeWidth={1} strokeDasharray="4 3" pointerEvents="none" />
                      {/* Endpoint handles: drag to change length and angle freely */}
                      <circle cx={item.x1} cy={item.y1} r={7} fill="#FFF" stroke="#3B82F6" strokeWidth={2}
                        style={{ cursor: "move" }}
                        onMouseDown={(e) => { e.stopPropagation(); startResize(e, item, "ep1"); }}
                        onTouchStart={(e) => { e.stopPropagation(); startResize(e, item, "ep1"); }} />
                      <circle cx={item.x2} cy={item.y2} r={7} fill="#FFF" stroke="#3B82F6" strokeWidth={2}
                        style={{ cursor: "move" }}
                        onMouseDown={(e) => { e.stopPropagation(); startResize(e, item, "ep2"); }}
                        onTouchStart={(e) => { e.stopPropagation(); startResize(e, item, "ep2"); }} />
                    </>
                  )}
                  {/* Length label only while resizing/dragging */}
                  {isSel && (resizing && resizing.id === item.id) && (() => {
                    const lenFt = Math.sqrt(((item.x2 - item.x1) / scale) ** 2 + ((item.y2 - item.y1) / scale) ** 2);
                    return (
                      <g transform={`translate(${midX},${midY - 14})`} pointerEvents="none">
                        <rect x={-26} y={-11} width={52} height={20} rx={5} fill="#1E293B" />
                        <text x={0} y={3} textAnchor="middle" fill="#FFF" fontSize={11} fontWeight="700">{lenFt.toFixed(1)} ft</text>
                      </g>
                    );
                  })()}
                </g>
              );
            }

            // ─── Text Note: resizable box; text is edited IN PLACE on the canvas ───
            if (cfg.noteType) {
              const w = item.widthPx || 160;
              const h = item.heightPx || 40;
              const isEditing = editingNoteId === item.id;
              // Leader target in coords relative to this g's translate.
              const lt = item.leader ? { x: item.leader.x - item.x, y: item.leader.y - item.y } : null;
              return (
                <g key={item.id} transform={`translate(${item.x},${item.y})`}
                  onMouseDown={(e) => { if (isEditing) return; onPtrDown(e, item); }}
                  onTouchStart={(e) => { if (isEditing) return; onPtrDown(e, item); }}
                  style={{ cursor: isEditing ? "text" : activeTool ? "crosshair" : "grab" }}>
                  {/* Leader (pointer) line: dashed, from the pill edge to the target dot.
                      Rendered under the pill; hidden while the target sits on the note. */}
                  {lt && (() => {
                    const ep = noteEdgePoint(0, 0, w, h, lt.x, lt.y);
                    const dx = lt.x - ep.x, dy = lt.y - ep.y;
                    if (Math.sqrt(dx * dx + dy * dy) <= 10) return null;
                    return (
                      <g pointerEvents="none">
                        <line x1={ep.x} y1={ep.y} x2={lt.x} y2={lt.y} stroke={cfg.color} strokeWidth={1.5} strokeDasharray="5 4" />
                        <circle cx={lt.x} cy={lt.y} r={3.5} fill={cfg.color} />
                      </g>
                    );
                  })()}
                  {isSel && <rect x={-w / 2 - 4} y={-h / 2 - 4} width={w + 8} height={h + 8} fill="none" stroke="#3B82F6" strokeWidth={2} strokeDasharray="4 2" rx={6} />}
                  {/* Background pill */}
                  <rect x={-w / 2} y={-h / 2} width={w} height={h} fill="#FFFBEB" stroke={cfg.color} strokeWidth={1.25} rx={4} />
                  {/* HTML inside SVG — native word-wrap; contentEditable when editing.
                      The editable div is UNCONTROLLED (text set once via ref, state
                      synced onInput/onBlur) so React never rewrites it mid-keystroke
                      and the caret stays put. display:block while editing avoids
                      Chrome's flex-contentEditable caret quirks. */}
                  <foreignObject x={-w / 2} y={-h / 2} width={w} height={h}>
                    {isEditing ? (
                      <div xmlns="http://www.w3.org/1999/xhtml" key={"edit" + item.id}
                        contentEditable suppressContentEditableWarning
                        ref={(el) => {
                          if (el && el.dataset.init !== "1") {
                            el.dataset.init = "1";
                            el.textContent = item.text || "";
                            setTimeout(() => {
                              el.focus();
                              // Select-all so typing replaces the "Note" placeholder.
                              try { const s = window.getSelection(); const rg = document.createRange(); rg.selectNodeContents(el); s.removeAllRanges(); s.addRange(rg); } catch (_e) { /* selection APIs unavailable */ }
                            }, 0);
                          }
                        }}
                        onMouseDown={(e) => e.stopPropagation()}
                        onTouchStart={(e) => e.stopPropagation()}
                        onClick={(e) => e.stopPropagation()}
                        onPaste={(e) => {
                          // Paste as PLAIN text: rich-HTML pastes would render their own
                          // markup mid-edit, and textContent drops element boundaries so
                          // multi-line pastes would silently concatenate without spaces.
                          e.preventDefault();
                          const t = ((e.clipboardData && e.clipboardData.getData("text/plain")) || "").replace(/\s+/g, " ");
                          document.execCommand("insertText", false, t);
                        }}
                        onInput={(e) => { const v = e.currentTarget.textContent; setItems((p) => p.map((i) => i.id === item.id ? { ...i, text: v } : i)); }}
                        onKeyDown={(e) => { e.stopPropagation(); if (e.key === "Enter" || e.key === "Escape") { e.preventDefault(); e.currentTarget.blur(); } }}
                        onBlur={(e) => { const v = (e.currentTarget.textContent || "").trim(); setItems((p) => p.map((i) => i.id === item.id ? { ...i, text: v } : i)); setEditingNoteId(null); }}
                        style={{
                          width: "100%", height: "100%",
                          padding: "4px 8px",
                          boxSizing: "border-box",
                          font: "600 12px sans-serif",
                          color: cfg.color,
                          lineHeight: 1.3,
                          textAlign: "center",
                          wordWrap: "break-word",
                          overflowWrap: "break-word",
                          overflow: "hidden",
                          whiteSpace: "pre-wrap",
                          outline: "none", cursor: "text",
                          userSelect: "text", WebkitUserSelect: "text",
                        }} />
                    ) : (
                      <div xmlns="http://www.w3.org/1999/xhtml" key={"view" + item.id} style={{
                        width: "100%", height: "100%",
                        padding: "4px 8px",
                        boxSizing: "border-box",
                        font: "600 12px sans-serif",
                        color: cfg.color,
                        lineHeight: 1.3,
                        textAlign: "center",
                        wordWrap: "break-word",
                        overflowWrap: "break-word",
                        overflow: "hidden",
                        display: "flex", alignItems: "center", justifyContent: "center",
                      }}>{item.text || "Note"}</div>
                    )}
                  </foreignObject>
                  {/* Selected chrome: resize handle (BR), delete ✕ (TR), leader handle */}
                  {isSel && (
                    <>
                      {/* Larger transparent click zone for forgiving grab. Also stop the
                          trailing CLICK: with the movement-aware gesture guard, a
                          no-move press on this handle would otherwise bubble a live
                          click to the svg and pop the note into edit mode. */}
                      <rect x={w / 2 - 14} y={h / 2 - 14} width={28} height={28}
                        fill="transparent" style={{ cursor: "nwse-resize" }}
                        onClick={(e) => e.stopPropagation()}
                        onMouseDown={(e) => { e.stopPropagation(); startResize(e, item, "br"); }}
                        onTouchStart={(e) => { e.stopPropagation(); startResize(e, item, "br"); }} />
                      {/* Visible handle */}
                      <rect x={w / 2 - 7} y={h / 2 - 7} width={14} height={14}
                        fill="#3B82F6" stroke="#FFF" strokeWidth={1.5} rx={2} pointerEvents="none" />
                      {/* Delete ✕ at the note's top-right corner */}
                      <g transform={`translate(${w / 2 + 2},${-h / 2 - 2})`} style={{ cursor: "pointer" }}
                        onMouseDown={(e) => e.stopPropagation()}
                        onTouchStart={(e) => e.stopPropagation()}
                        onClick={(e) => { e.stopPropagation(); delSel(); }}>
                        <circle r={9} fill="#DC2626" stroke="#FFF" strokeWidth={1.5} />
                        <line x1={-3.5} y1={-3.5} x2={3.5} y2={3.5} stroke="#FFF" strokeWidth={1.8} strokeLinecap="round" />
                        <line x1={-3.5} y1={3.5} x2={3.5} y2={-3.5} stroke="#FFF" strokeWidth={1.8} strokeLinecap="round" />
                      </g>
                      {/* Leader handle: at the target when set, docked beside the note
                          when not. Drag it onto the plan to point the note at something;
                          drop it back on the note to remove the pointer. */}
                      {!isEditing && (() => {
                        const hx = lt ? lt.x : -w / 2 - 18, hy = lt ? lt.y : 0;
                        return (
                          <g>
                            {!lt && <line x1={-w / 2} y1={0} x2={hx + 7} y2={hy} stroke="#94A3B8" strokeWidth={1} strokeDasharray="2 3" pointerEvents="none" />}
                            <circle cx={hx} cy={hy} r={7} fill="#FFF" stroke="#3B82F6" strokeWidth={2}
                              style={{ cursor: "move" }}
                              onClick={(e) => e.stopPropagation()}
                              onMouseDown={(e) => { e.stopPropagation(); startResize(e, item, "leader"); }}
                              onTouchStart={(e) => { e.stopPropagation(); startResize(e, item, "leader"); }}>
                              <title>Drag to point this note at something · drop back on the note to remove</title>
                            </circle>
                          </g>
                        );
                      })()}
                    </>
                  )}
                </g>
              );
            }

            const itemW = item.widthFt || cfg.width;
            const itemH = item.heightFt || cfg.height;
            const iw = itemW * scale; const ih = itemH * scale;
            const isWB = item.type === "workbench";
            return (
              <g key={item.id} transform={`translate(${item.x},${item.y}) rotate(${item.rotation})`}
                onMouseDown={(e) => onPtrDown(e, item)} onTouchStart={(e) => onPtrDown(e, item)} style={{ cursor: activeTool ? "crosshair" : "grab" }}>
                {isSel && <rect x={-iw / 2 - 4} y={(cfg.wallOnly ? -8 : -ih / 2) - 4} width={iw + 8} height={(cfg.wallOnly ? 16 : ih) + 8} fill="none" stroke="#3B82F6" strokeWidth={2} strokeDasharray="4 2" rx={3} />}
                {/* Archived-option marker (screen only — NOT drawn on the exported/submitted plan). */}
                {isArchivedItem(item) && (<>
                  <rect x={-iw / 2 - 3} y={(cfg.wallOnly ? -8 : -ih / 2) - 3} width={iw + 6} height={(cfg.wallOnly ? 16 : ih) + 6} fill="none" stroke="#F59E0B" strokeWidth={2} strokeDasharray="2 2" rx={3} />
                  {/* Sit the badge beyond the item's own label (which is at ±10-14 on wallOnly) so the two never overlap. */}
                  <text x={0} y={cfg.wallOnly ? ((item.wall === "north" || item.wall === "east") ? 27 : -23) : (-ih / 2 - 6)} textAnchor="middle" fontSize={9} fontWeight="800" fill="#B45309">⚠ archived</text>
                </>)}
                {item.type === "loft" ? (
                  <>
                    <defs><clipPath id={`loftClip${item.id}`}><rect x={-iw / 2} y={-ih / 2} width={iw} height={ih} rx={2} /></clipPath></defs>
                    <rect x={-iw / 2} y={-ih / 2} width={iw} height={ih} fill={cfg.color + "18"} stroke={cfg.color} strokeWidth={2} strokeDasharray="6 4" rx={2} />
                    <g opacity={0.15} clipPath={`url(#loftClip${item.id})`}>{Array.from({ length: Math.ceil((iw + ih) / 10) + 2 }, (_, d) => <line key={d} x1={-iw / 2 + d * 10} y1={-ih / 2} x2={-iw / 2 + d * 10 - ih} y2={ih / 2} stroke={cfg.color} strokeWidth={1} />)}</g>
                    <text x={0} y={4} textAnchor="middle" fill={cfg.color} fontSize={10} fontWeight="700">LOFT</text>
                    <text x={0} y={16} textAnchor="middle" fill={cfg.color} fontSize={9} opacity={0.7}>{itemW}×{itemH} ft</text>
                    {isSel && (() => {
                      const hz = Math.min(Math.max(ih / 3, 22), 36, ih * 0.5);
                      const vz = Math.min(Math.max(iw / 3, 22), 36, iw * 0.5);
                      return (
                        <>
                          <rect x={-vz / 2} y={-ih / 2 - 1} width={vz} height={hz / 2 + 1} fill="transparent" style={{ cursor: "ns-resize" }}
                            onMouseDown={(e) => { e.stopPropagation(); startResize(e, item, "top"); }}
                            onTouchStart={(e) => { e.stopPropagation(); startResize(e, item, "top"); }} />
                          <rect x={-vz / 2} y={ih / 2 - hz / 2} width={vz} height={hz / 2 + 1} fill="transparent" style={{ cursor: "ns-resize" }}
                            onMouseDown={(e) => { e.stopPropagation(); startResize(e, item, "bottom"); }}
                            onTouchStart={(e) => { e.stopPropagation(); startResize(e, item, "bottom"); }} />
                          <rect x={-iw / 2 - 1} y={-hz / 2} width={vz / 2 + 1} height={hz} fill="transparent" style={{ cursor: "ew-resize" }}
                            onMouseDown={(e) => { e.stopPropagation(); startResize(e, item, "left"); }}
                            onTouchStart={(e) => { e.stopPropagation(); startResize(e, item, "left"); }} />
                          <rect x={iw / 2 - vz / 2} y={-hz / 2} width={vz / 2 + 1} height={hz} fill="transparent" style={{ cursor: "ew-resize" }}
                            onMouseDown={(e) => { e.stopPropagation(); startResize(e, item, "right"); }}
                            onTouchStart={(e) => { e.stopPropagation(); startResize(e, item, "right"); }} />
                          <line x1={-vz / 3} y1={-ih / 2} x2={vz / 3} y2={-ih / 2} stroke="#3B82F6" strokeWidth={3} strokeLinecap="round" pointerEvents="none" />
                          <line x1={-vz / 3} y1={ih / 2} x2={vz / 3} y2={ih / 2} stroke="#3B82F6" strokeWidth={3} strokeLinecap="round" pointerEvents="none" />
                          <line x1={-iw / 2} y1={-hz / 3} x2={-iw / 2} y2={hz / 3} stroke="#3B82F6" strokeWidth={3} strokeLinecap="round" pointerEvents="none" />
                          <line x1={iw / 2} y1={-hz / 3} x2={iw / 2} y2={hz / 3} stroke="#3B82F6" strokeWidth={3} strokeLinecap="round" pointerEvents="none" />
                        </>
                      );
                    })()}
                  </>
                ) : cfg.wallOnly ? (
                  <>
                    {item.type === "roughOpening" ? (
                      <rect x={-iw / 2} y={-5} width={iw} height={10} fill="#FFFFFF" stroke="#000000" strokeWidth={1.5} rx={1} />
                    ) : (
                      <rect x={-iw / 2} y={-5} width={iw} height={10} fill={item.type === "fixtureDoor" ? fixtureDoorColor(item) : cfg.color} rx={1} />
                    )}
                    {item.type === "singleDoor" && (() => {
                      const r = iw * 0.8, out = item.wall === "north" || item.wall === "east";
                      return <path d={`M ${-iw / 2 + r} 0 A ${r} ${r} 0 0 ${out ? 0 : 1} ${-iw / 2} ${out ? -r : r}`} fill="none" stroke={cfg.color + "60"} strokeWidth={1.5} strokeDasharray="4 3" />;
                    })()}
                    {item.type === "doubleDoor" && (() => {
                      const r = iw * 0.4, out = item.wall === "north" || item.wall === "east";
                      const s = out ? -1 : 1;
                      return (
                        <>
                          <path d={`M ${-iw / 2 + r} 0 A ${r} ${r} 0 0 ${out ? 0 : 1} ${-iw / 2} ${s * r}`} fill="none" stroke={cfg.color + "60"} strokeWidth={1.5} strokeDasharray="4 3" />
                          <path d={`M ${iw / 2 - r} 0 A ${r} ${r} 0 0 ${out ? 1 : 0} ${iw / 2} ${s * r}`} fill="none" stroke={cfg.color + "60"} strokeWidth={1.5} strokeDasharray="4 3" />
                          <line x1={0} y1={-5} x2={0} y2={5} stroke="#FFF" strokeWidth={1.5} />
                        </>
                      );
                    })()}
                    {item.type === "fixtureDoor" && fixtureDoorSVG(item, iw, fixtureDoorColor(item))}
                    {item.type === "window" && <g><line x1={0} y1={-4} x2={0} y2={4} stroke="#FFF" strokeWidth={1.5} /><line x1={-iw / 4} y1={-4} x2={-iw / 4} y2={4} stroke="#FFF" strokeWidth={1} /><line x1={iw / 4} y1={-4} x2={iw / 4} y2={4} stroke="#FFF" strokeWidth={1} /></g>}
                    <text x={0} y={(item.wall === "north" || item.wall === "east") ? 14 : -10} textAnchor="middle" fill="#1E293B" fontSize={9} fontWeight="700">{(() => {
                      if (item.type === "roughOpening") {
                        const idx = items.filter((i) => i.type === "roughOpening").findIndex((r) => r.id === item.id);
                        return `RO-${idx + 1}`;
                      }
                      const base = ((item.type === "fixtureDoor" || item.type === "window") && item.planLabel) ? item.planLabel : cfg.shortLabel;
                      // Doors + windows prefix their width, e.g. "6' DD", so the size reads off the plan.
                      const isDoorOrWin = item.type === "singleDoor" || item.type === "doubleDoor" || item.type === "fixtureDoor" || item.type === "window";
                      const w = isDoorOrWin ? fmtFtIn((item.widthFt || cfg.width) * 12) : "";
                      return w ? `${w} ${base}` : base;
                    })()}</text>
                    {/* RO resize handles — drag end to change width freely */}
                    {item.type === "roughOpening" && isSel && (() => {
                      const cursor = (item.wall === "north" || item.wall === "south") ? "ew-resize" : "ns-resize";
                      const endZoneW = Math.min(Math.max(iw / 5, 10), 22, iw * 0.4);
                      return (
                        <>
                          <rect x={-iw / 2 + 1} y={-4} width={endZoneW - 2} height={8}
                            fill="#3B82F640" stroke="#3B82F680" strokeWidth={1} pointerEvents="none" rx={1} />
                          <rect x={iw / 2 - endZoneW + 1} y={-4} width={endZoneW - 2} height={8}
                            fill="#3B82F640" stroke="#3B82F680" strokeWidth={1} pointerEvents="none" rx={1} />
                          <rect x={-iw / 2 - 4} y={-9} width={endZoneW + 4} height={18}
                            fill="transparent" style={{ cursor }}
                            onMouseDown={(e) => { e.stopPropagation(); startResize(e, item, "min"); }}
                            onTouchStart={(e) => { e.stopPropagation(); startResize(e, item, "min"); }} />
                          <rect x={iw / 2 - endZoneW} y={-9} width={endZoneW + 4} height={18}
                            fill="transparent" style={{ cursor }}
                            onMouseDown={(e) => { e.stopPropagation(); startResize(e, item, "max"); }}
                            onTouchStart={(e) => { e.stopPropagation(); startResize(e, item, "max"); }} />
                        </>
                      );
                    })()}
                  </>
                ) : (
                  <>
                    <rect x={-iw / 2} y={-ih / 2} width={iw} height={ih} fill={cfg.color + (item.type === "ramp" ? "12" : "30")} stroke={cfg.color + (item.type === "ramp" ? "80" : "FF")} strokeWidth={item.type === "ramp" ? 1.5 : 2} rx={2} />
                    {item.type === "ramp" ? (
                      <text x={-iw / 2 + 5} y={4} textAnchor="start" fill={cfg.color} fontSize={9} fontWeight="700">{item.planLabel || "RAMP"}</text>
                    ) : isWB ? (
                      <>
                        <text x={0} y={0} textAnchor="middle" fill={cfg.color} fontSize={11} fontWeight="700">{itemW} ft</text>
                        <text x={0} y={13} textAnchor="middle" fill={cfg.color} fontSize={8} opacity={0.7}>Workbench</text>
                      </>
                    ) : (
                      <>
                        <text x={0} y={2} textAnchor="middle" fill={cfg.color} fontSize={10} fontWeight="700">{cfg.shortLabel}</text>
                        <text x={0} y={14} textAnchor="middle" fill={cfg.color} fontSize={8} opacity={0.7}>{itemW}×{itemH}</text>
                      </>
                    )}
                    {isWB && isSel && (() => {
                      const isHoriz = item.wall === "north" || item.wall === "south";
                      const cursor = isHoriz ? "ew-resize" : "ns-resize";
                      const endZoneW = Math.min(Math.max(iw / 4, 16), 30, iw * 0.45);
                      const handleX1 = -iw / 2 + endZoneW / 2;
                      const handleX2 = iw / 2 - endZoneW / 2;
                      return (
                        <>
                          <rect x={-iw / 2 + 1} y={-ih / 2 + 1} width={endZoneW - 2} height={ih - 2}
                            fill="#3B82F618" stroke="#3B82F680" strokeWidth={1.5} pointerEvents="none" rx={2} />
                          <rect x={iw / 2 - endZoneW + 1} y={-ih / 2 + 1} width={endZoneW - 2} height={ih - 2}
                            fill="#3B82F618" stroke="#3B82F680" strokeWidth={1.5} pointerEvents="none" rx={2} />
                          <text x={handleX1} y={5} textAnchor="middle" fill="#3B82F6" fontSize={14} fontWeight="700" pointerEvents="none">◄</text>
                          <text x={handleX2} y={5} textAnchor="middle" fill="#3B82F6" fontSize={14} fontWeight="700" pointerEvents="none">►</text>
                          <rect x={-iw / 2} y={-ih / 2} width={endZoneW} height={ih}
                            fill="transparent" style={{ cursor }}
                            onMouseDown={(e) => { e.stopPropagation(); startResize(e, item, "min"); }}
                            onTouchStart={(e) => { e.stopPropagation(); startResize(e, item, "min"); }} />
                          <rect x={iw / 2 - endZoneW} y={-ih / 2} width={endZoneW} height={ih}
                            fill="transparent" style={{ cursor }}
                            onMouseDown={(e) => { e.stopPropagation(); startResize(e, item, "max"); }}
                            onTouchStart={(e) => { e.stopPropagation(); startResize(e, item, "max"); }} />
                        </>
                      );
                    })()}
                  </>
                )}
              </g>
            );
          })}
          {/* Building dimension + FRONT/BACK/LEFT/RIGHT labels — rendered AFTER items so a centered ramp doesn't paint over the building chrome. */}
          <text x={mgX + pW / 2} y={mgY - 16} textAnchor="middle" fill="#475569" fontSize={13} fontWeight="bold">{bldgW} ft</text>
          <text x={mgX + pW / 2} y={mgY + pH + 26} textAnchor="middle" fill="#475569" fontSize={13} fontWeight="bold">{bldgW} ft</text>
          <text x={mgX - 20} y={mgY + pH / 2} textAnchor="middle" fill="#475569" fontSize={13} fontWeight="bold" transform={`rotate(-90,${mgX - 20},${mgY + pH / 2})`}>{bldgH} ft</text>
          <text x={mgX + pW + 24} y={mgY + pH / 2} textAnchor="middle" fill="#475569" fontSize={13} fontWeight="bold" transform={`rotate(90,${mgX + pW + 24},${mgY + pH / 2})`}>{bldgH} ft</text>
          {frontWall && (
            <>
              <text x={mgX + pW / 2} y={mgY - 32} textAnchor="middle" fill="#94A3B8" fontSize={10} fontWeight="600" letterSpacing="0.1em">{getDisplayLabel("north", frontWall)}</text>
              <text x={mgX + pW / 2} y={mgY + pH + 42} textAnchor="middle" fill="#94A3B8" fontSize={10} fontWeight="600" letterSpacing="0.1em">{getDisplayLabel("south", frontWall)}</text>
              <text x={mgX - 38} y={mgY + pH / 2} textAnchor="middle" fill="#94A3B8" fontSize={10} fontWeight="600" letterSpacing="0.1em" transform={`rotate(-90,${mgX - 38},${mgY + pH / 2})`}>{getDisplayLabel("west", frontWall)}</text>
              <text x={mgX + pW + 42} y={mgY + pH / 2} textAnchor="middle" fill="#94A3B8" fontSize={10} fontWeight="600" letterSpacing="0.1em" transform={`rotate(90,${mgX + pW + 42},${mgY + pH / 2})`}>{getDisplayLabel("east", frontWall)}</text>
            </>
          )}
          {resizing && (() => {
            const ri = items.find((i) => i.id === resizing.id);
            if (!ri || ri.type === "line" || !Number.isFinite(ri.widthFt)) return null; // line shows its own length inline; notes have no widthFt → skip the 'ft' badge (audit #F3)
            return (
              <g transform={`translate(${ri.x},${ri.y - 28})`}>
                <rect x={-30} y={-12} width={60} height={24} rx={6} fill="#1E293B" />
                <text x={0} y={4} textAnchor="middle" fill="#FFF" fontSize={13} fontWeight="700">{Math.round(ri.widthFt * 10) / 10} ft</text>
              </g>
            );
          })()}
          {/* Pick-one-to-remove overlays: pulsing ring over every candidate; clicking one removes it.
              Rendered last so the rings (and their click targets) sit above everything else.
              priceRowMatcher: the pending type is a Details ROW key, and catalog rows' keys
              match no item's type (audit 2026-08-20). */}
          {pendingRemoval && items.filter(priceRowMatcher(pendingRemoval.type)).map((it) => {
            const c = ITEMS[it.type]; if (!c) return null;
            const iwFt = it.widthFt || c.width, ihFt = it.heightFt || c.height;
            const iw = iwFt * scale, ih = ihFt * scale;
            const rot = it.rotation === 90 || it.rotation === 270;
            const hw = (rot ? ih : iw) / 2, hh = (rot ? iw : ih) / 2;
            return (
              <rect key={`pr-${it.id}`} x={it.x - hw - 5} y={it.y - hh - 5} width={hw * 2 + 10} height={hh * 2 + 10} rx={5}
                fill="rgba(220,38,38,0.10)" stroke="#DC2626" strokeWidth={2.5} style={{ cursor: "pointer" }}
                onMouseDown={(e) => e.stopPropagation()} onTouchStart={(e) => e.stopPropagation()}
                onClick={(e) => { e.stopPropagation(); setItems((p) => p.filter((x) => x.id !== it.id && !(x.type === "ramp" && x.snapDoorId === it.id))); setPendingRemoval(null); setSelectedId(null); }}>
                <animate attributeName="stroke-opacity" values="1;0.25;1" dur="1.1s" repeatCount="indefinite" />
              </rect>
            );
          })}
        </svg>
        </div>
        {view3dOn && dock3D && (
          /* Width and height are pure CSS — never derived from `frame` or dispMaxW,
             which recompute on every render and would realloc the drawing buffer at
             mousemove rate. sticky (not fixed) because the designer host is the
             scroller; fixed would escape it and float over the whole portal. */
          <div style={{ flex: "0 0 clamp(320px, 36%, 520px)", height: "min(620px, 68vh)", position: "sticky", top: 12 }}>
            <Structure3DPanel
              /* Remount on building size and NOTHING else: every camera, shadow and
                 orbit constant in the panel bakes from bldgW/bldgH at mount. Size
                 comes from a <select>, so this is rare and correct. Style, cladding,
                 roof and paint all rebuild in place with no context churn. */
              key={`${bldgW}x${bldgH}`}
              bldgW={bldgW} bldgH={bldgH} items={items} itemTypes={ITEMS}
              painted={sel.paint === "Painted"} paintBody={paintColors.body} paintTrim={paintColors.trim}
              frontWall={frontWall} scale={scale} mgX={mgX} mgY={mgY}
              style3d={d3ResolveStyleSpec(selectedStyle, sel.style, C.wallHeightFt, d3SidingOverride(C, sel), sel.wallHeight)}
              roofType={sel.roofType}
              roofColorHex={(() => { const rc = (Array.isArray(C.colors) ? C.colors : []).find((c) => c.label === sel.roofColor && (sel.roofType === "Metal" ? c.metal : c.shingle)); return (rc && rc.hex) ? rc.hex : ""; })()}
              fixtures={C.fixtures} doorColors={doorPaintColors} windowColors={windowColorList} bodyColors={bodyPaintPool} trimColors={trimPaintPool}
              suspended={Boolean(dragging || resizing)}
              canEdit={!planLocked}
              onEdit={() => { setDock3D(false); setShow3D(true); }}
              onClose={() => setDock3D(false)}
            />
          </div>
        )}
      </div>
      )}

      {/* Customer Information (above Submit Bar) */}
      {!submitted && (
        <div style={{ background: "#FFF", borderTop: "2px solid #E2E8F0", padding: "14px 20px" }}>
          <span style={{ ...S.lbl, display: "block", marginBottom: 10, fontSize: 12 }}>Customer Information</span>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 10, marginBottom: 10 }}>
            {C.contactFields.includes("name") && (
              <div style={{ flex: "1 1 180px" }}>
                <span style={{ ...S.lbl, fontSize: 10, display: "block", marginBottom: 3 }}>Name *</span>
                <input type="text" value={contact.name} onChange={(e) => setContact((p) => ({ ...p, name: e.target.value }))} placeholder="Full Name" style={{ ...S.sel, width: "100%", boxSizing: "border-box" }} />
              </div>
            )}
            {C.contactFields.includes("email") && (
              <div style={{ flex: "1 1 200px" }}>
                <span style={{ ...S.lbl, fontSize: 10, display: "block", marginBottom: 3 }}>Email *</span>
                <input type="email" value={contact.email} onChange={(e) => setContact((p) => ({ ...p, email: e.target.value }))} placeholder="email@example.com" style={{ ...S.sel, width: "100%", boxSizing: "border-box" }} />
              </div>
            )}
            {C.contactFields.includes("phone") && (
              <div style={{ flex: "1 1 140px" }}>
                <span style={{ ...S.lbl, fontSize: 10, display: "block", marginBottom: 3 }}>Phone *</span>
                <input type="tel" inputMode="tel" autoComplete="tel" value={formatPhoneDisplay(contact.phone)} onChange={(e) => setContact((p) => ({ ...p, phone: formatPhoneDisplay(e.target.value) }))} placeholder="(555) 555-5555" style={{ ...S.sel, width: "100%", boxSizing: "border-box" }} />
              </div>
            )}
          </div>
          {(C.googleMapsApiKey || DEFAULT_GOOGLE_MAPS_API_KEY) && C.contactFields.includes("street") && (
            <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 10 }}>
              <span style={{ ...S.lbl, fontSize: 10, whiteSpace: "nowrap" }}>Search for address</span>
              <div ref={attachStreetAutocomplete} style={{ flex: 1, minWidth: 0, display: "flex", alignItems: "stretch", boxSizing: "border-box" }} />
              {(() => {
                // Open Google Maps directly to the address typed in the fields below. Built from the
                // customer's own street/city/state/zip; disabled until at least one is filled.
                const addr = [contact.street, contact.city, contact.state, contact.zip].map((s) => (s || "").trim()).filter(Boolean).join(", ");
                return (
                  <button type="button" disabled={!addr}
                    onClick={() => { if (addr) window.open(`https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(addr)}`, "_blank", "noopener,noreferrer"); }}
                    title={addr ? "Open this address in Google Maps" : "Enter an address below first"}
                    style={{ ...S.btn("#EEF2FF", "#4F46E5"), border: "1px solid #C7D2FE", flexShrink: 0, whiteSpace: "nowrap", display: "inline-flex", alignItems: "center", gap: 4, opacity: addr ? 1 : 0.5, cursor: addr ? "pointer" : "not-allowed" }}>
                    📍 View Property
                  </button>
                );
              })()}
            </div>
          )}
          {(C.contactFields.includes("street") || C.contactFields.includes("city")) && (
            <div style={{ display: "flex", flexWrap: "wrap", gap: 10 }}>
              {C.contactFields.includes("street") && (
                <div style={{ flex: "2 1 200px" }}>
                  <span style={{ ...S.lbl, fontSize: 10, display: "block", marginBottom: 3 }}>Street Address *</span>
                  <input type="text" autoComplete="street-address" value={contact.street} onChange={(e) => setContact((p) => ({ ...p, street: e.target.value }))} placeholder="123 Main St" style={{ ...S.sel, width: "100%", boxSizing: "border-box" }} />
                </div>
              )}
              {C.contactFields.includes("city") && (
                <div style={{ flex: "1 1 130px" }}>
                  <span style={{ ...S.lbl, fontSize: 10, display: "block", marginBottom: 3 }}>City *</span>
                  <input type="text" autoComplete="address-level2" value={contact.city} onChange={(e) => setContact((p) => ({ ...p, city: e.target.value }))} placeholder="City" style={{ ...S.sel, width: "100%", boxSizing: "border-box" }} />
                </div>
              )}
              {C.contactFields.includes("state") && (
                <div style={{ flex: "1 1 160px" }}>
                  <span style={{ ...S.lbl, fontSize: 10, display: "block", marginBottom: 3 }}>State *</span>
                  <select autoComplete="address-level1" value={contact.state} onChange={(e) => setContact((p) => ({ ...p, state: e.target.value }))} style={{ ...S.sel, width: "100%", boxSizing: "border-box", color: contact.state ? undefined : "#94A3B8" }}>
                    <option value="">Select state…</option>
                    {["Alabama","Alaska","Arizona","Arkansas","California","Colorado","Connecticut","Delaware","District of Columbia","Florida","Georgia","Hawaii","Idaho","Illinois","Indiana","Iowa","Kansas","Kentucky","Louisiana","Maine","Maryland","Massachusetts","Michigan","Minnesota","Mississippi","Missouri","Montana","Nebraska","Nevada","New Hampshire","New Jersey","New Mexico","New York","North Carolina","North Dakota","Ohio","Oklahoma","Oregon","Pennsylvania","Rhode Island","South Carolina","South Dakota","Tennessee","Texas","Utah","Vermont","Virginia","Washington","West Virginia","Wisconsin","Wyoming"].map((s) => <option key={s} value={s} style={{ color: "#1E293B" }}>{s}</option>)}
                  </select>
                </div>
              )}
              {C.contactFields.includes("zip") && (
                <div style={{ flex: "0 1 100px" }}>
                  <span style={{ ...S.lbl, fontSize: 10, display: "block", marginBottom: 3 }}>Zip *</span>
                  <input type="text" inputMode="numeric" autoComplete="postal-code" value={contact.zip} onChange={(e) => setContact((p) => ({ ...p, zip: e.target.value.replace(/\D/g, "").slice(0, 5) }))} placeholder="00000" maxLength={5} style={{ ...S.sel, width: "100%", boxSizing: "border-box" }} />
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {/* Additional options (layout pricing, rough openings, custom options, delivery
          fee) — collapsible; relocated below the address, just above the submit bar. */}
      {!submitted && (
        <div style={{ background: "#FFF", borderTop: "2px solid #E2E8F0", padding: "14px 20px" }}>
          {/* Public gate: Details opens only once the contact form is complete — the moment
              a shopper asks to see prices with full contact info, they are silently saved
              as a lead (and their design as a draft). Customer-facing this is a REAL bar
              in the tenant's accent: it is the page's "see your price" affordance and the
              capture moment, so it must not read as a footnote — and it keeps a right-side
              label in EVERY state (locked explains how to unlock, unlocked invites the
              click; an empty right side made the bar look broken the moment the form was
              completed). Embedded keeps the quiet header business users know. */}
          <div onClick={() => { if (!detailsLocked) setAdditionalOpen((o) => !o); }}
            style={{
              display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10,
              cursor: detailsLocked ? "default" : "pointer", userSelect: "none",
              ...(customerFacing ? {
                // Unlocked = a SOLID accent bar with the submit button's shadow — it is the
                // page's "see your price" call to action and reads like one. Locked stays
                // quiet: the contact form is the customer's current job, not this bar.
                background: detailsLocked ? "#F8FAFC" : accent,
                border: `1.5px solid ${detailsLocked ? "#E2E8F0" : accent}`,
                borderRadius: 10, padding: "14px 18px",
                boxShadow: detailsLocked ? "none" : `0 4px 14px ${accent}50`,
                transition: "all 0.2s",
              } : {}),
            }}>
            {/* Text color comes from textOnAccent(): the accent is tenant-configured, so a
                fixed color fails someone — white vanished on structure-studio's mint,
                dark slate would vanish on a navy. Luminance decides per tenant. */}
            <span style={{ fontSize: customerFacing ? 14.5 : 12, fontWeight: customerFacing ? 800 : 700, color: customerFacing && !detailsLocked ? textOnAccent(accent) : "#64748B", letterSpacing: 0.2 }}>Details</span>
            {detailsLocked
              ? <span style={{ fontSize: customerFacing ? 12.5 : 11.5, fontWeight: 600, color: customerFacing ? "#64748B" : "#94A3B8", textAlign: "right" }}>🔒 Enter all your contact information to see the quote details.</span>
              : customerFacing
                ? <span style={{ fontSize: 13, fontWeight: 800, color: textOnAccent(accent), textAlign: "right" }}>{additionalOpen ? "Hide quote details ▾" : "See your quote details ▸"}</span>
                : <span style={{ fontSize: 11, color: "#94A3B8" }}>{additionalOpen ? "▾" : "▸"}</span>}
          </div>
          {additionalOpen && !detailsLocked && (() => {
            // ── Invoice-style detail rows ─────────────────────────────────────────
            // Every row shares the same right-anchored grid: [qty 50px] [amount 85px]
            // [action 28px], gap 6 — so every amount lines up in one column. Rows with
            // no action get a 28px spacer; rows with no qty just omit that cell.
            const selRows = computeSelectionRows(sel, paintColors, C, items);
            const priceRows = C.showPricing ? computeLayoutPricingRows(items, sel, customOptions, C, paintColors).rows : [];
            const roList = items.filter((i) => i.type === "roughOpening");
            // Rough-opening rate: same per-style resolution as the estimate (layoutPricing,
            // byStyle override wins) — the old C.layoutPrices read was a stale key that
            // showed $0.00 while the estimate charged the real rate.
            const roRate = (() => {
              const lp = C.layoutPricing && C.layoutPricing.roughOpening;
              if (!lp) return 0;
              const ov = (lp.byStyle && sel.style) ? lp.byStyle[sel.style] : null;
              return Number(ov && ov.rate != null ? ov.rate : lp.rate) || 0;
            })();
            const customTotal = customOptions.reduce((s, r) => {
              if (!r || !r.name || !String(r.name).trim()) return s;
              const amt = Math.max(0, parseFloat(r.amount) || 0);
              const q = r.qty ? Math.abs(parseInt(r.qty, 10)) || 1 : 1; // abs: the edge bills |qty|
              return s + amt * q;
            }, 0);
            const discountTotal = (sel.discounts || []).reduce((s, r) => s + Math.max(0, parseFloat(r && r.amount) || 0), 0);
            const deliveryAmt = parseFloat(sel.deliveryFee) || 0;
            const showDelivery = deliveryOpen || String(sel.deliveryFee || "") !== "";
            // Mirrors the estimate's pre-tax total: all line items + delivery − discounts.
            const subtotal = Math.max(0,
              selRows.reduce((s, r) => s + (Number(r.total) || 0), 0)
              + priceRows.reduce((s, r) => s + (Number(r.total) || 0), 0)
              + (C.showPricing ? roList.length * roRate : 0)
              + customTotal + deliveryAmt - discountTotal);
            const qtyCell = { width: 50, flex: "0 0 auto", textAlign: "center", fontSize: 12, color: "#64748B", border: "1px solid #E2E8F0", borderRadius: 6, padding: "6px 0", background: "#F8FAFC", boxSizing: "border-box" };
            const amtCell = { width: 85, flex: "0 0 auto", textAlign: "right", fontSize: 12, fontWeight: 600, color: "#334155", border: "1px solid #E2E8F0", borderRadius: 6, padding: "6px 8px", background: "#F8FAFC", boxSizing: "border-box" };
            const amtInputWrap = { display: "flex", alignItems: "center", border: "1px solid #CBD5E1", borderRadius: 6, padding: "0 6px", background: "#FFF", width: 85, flex: "0 0 auto", boxSizing: "border-box" };
            const actSpacer = { width: 28, flex: "0 0 auto" };
            const delBtn = { background: "#FEF2F2", color: "#DC2626", border: "1px solid #FECACA", borderRadius: 6, width: 28, height: 30, cursor: "pointer", fontSize: 14, fontWeight: 700, flexShrink: 0 };
            const dashBtn = { background: "#F1F5F9", color: "#334155", border: "1px dashed #94A3B8", borderRadius: 6, padding: "6px 12px", fontSize: 12, fontWeight: 600, cursor: "pointer" };
            return (
          <div style={{ marginTop: 8 }}>
            {/* Building, Paint Colors, Roof — same order as the estimate; price shown when enabled. */}
            <div style={{ marginBottom: 4 }}>
              {selRows.map((r) => (
                <div key={r.key} style={{ display: "flex", gap: 6, alignItems: "center", marginBottom: 6 }}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 12, fontWeight: 700, color: "#334155" }}>{r.label}</div>
                    <div style={{ fontSize: 10.5, color: "#94A3B8", whiteSpace: "pre-line" }}>{r.detail}</div>
                  </div>
                  {r.total != null && (<>
                    <div style={amtCell}>{fmtMoney2(r.total)}</div>
                    <div style={actSpacer} />
                  </>)}
                </div>
              ))}
            </div>
            {priceRows.length > 0 && (
              <div style={{ marginTop: 14 }}>
                <div style={{ ...S.lbl, marginBottom: 8 }}>Options on your plan</div>
                {priceRows.map((r) => (
                  <div key={r.key} style={{ display: "flex", gap: 6, alignItems: "center", marginBottom: 6 }}>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: 12, fontWeight: 700, color: "#334155" }}>{r.label}</div>
                      <div style={{ fontSize: 10.5, color: "#94A3B8" }}>{r.unit}</div>
                    </div>
                    <div style={qtyCell}>{Number.isInteger(r.qty) ? r.qty : Number(r.qty).toFixed(1)}</div>
                    <div style={amtCell}>{fmtMoney2(r.total)}</div>
                    {/* Removing a placed item is a PLAN edit, and this row sits outside the
                        canvas and outside the configuration panel — so it needs its own
                        guard, or the lock is bypassable from Details (on the customer's
                        share link too). */}
                    {!planLocked && <button title={r.method === "each" ? "Remove one from the plan" : "Remove from the plan"}
                      onClick={() => {
                        // "each"-priced items step down one at a time (when several are
                        // placed, the plan asks which one); everything else clears the line
                        // and removes everything on it from the layout. priceRowMatcher, not
                        // `i.type === r.key`: catalog rows carry fx:/win:/ramp: keys that
                        // match no item's type, so this × removed nothing for exactly the
                        // rows that carry a price (audit 2026-08-20). The row label rides
                        // along so pick mode can name the item (its key is not ITEMS-keyed).
                        const match = priceRowMatcher(r.key);
                        const placed = items.filter(match);
                        if (r.method === "each" && placed.length > 1) {
                          setPendingRemoval({ type: r.key, label: r.label });
                          setSelectedId(null); setActiveTool(null);
                          setTimeout(() => { try { svgRef.current && svgRef.current.scrollIntoView({ behavior: "smooth", block: "center" }); } catch (_) {} }, 0);
                        } else {
                          // Cascade like delSel: removing a door also removes its snapped ramp.
                          const removedIds = new Set(placed.map((i) => i.id));
                          setItems((p) => p.filter((i) => !match(i) && !(i.type === "ramp" && removedIds.has(i.snapDoorId))));
                          setSelectedId(null);
                        }
                      }}
                      style={delBtn}>×</button>}
                  </div>
                ))}
              </div>
            )}

            {roList.length > 0 && (
              <div style={{ marginTop: 14 }}>
                {roList.map((ro, idx) => {
                  const dim = roDimensions[ro.id] || "";
                  const invalid = !dim.trim();
                  return (
                    <div key={ro.id} style={{ display: "flex", gap: 6, alignItems: "center", marginBottom: 6 }}>
                      <span style={{ flex: "0 0 auto", fontSize: 12, fontWeight: 700, color: "#334155", minWidth: 60 }}>RO-{idx + 1}</span>
                      <input type="text" value={dim} placeholder='Enter Rough Opening size: e.g. 3 x 6 or 29⅞ × 34½"'
                        readOnly={planLocked || undefined}
                        onChange={(e) => { if (planLocked) return; setRoDimensions((p) => ({ ...p, [ro.id]: e.target.value })); }}
                        style={{ flex: 1, minWidth: 0, border: `1px solid ${invalid ? "#DC2626" : "#CBD5E1"}`, borderRadius: 6, padding: "6px 8px", fontSize: 12, outline: "none", background: invalid ? "#FEF2F2" : "#FFF" }} />
                      {C.showPricing && (<>
                        <div style={qtyCell}>1</div>
                        <div style={amtCell}>{fmtMoney2(roRate)}</div>
                      </>)}
                      {!planLocked && <button title="Remove this rough opening from the plan"
                        onClick={() => { setItems((p) => p.filter((i) => i.id !== ro.id)); setSelectedId(null); }}
                        style={delBtn}>×</button>}
                    </div>
                  );
                })}
              </div>
            )}

            {/* Custom options — added charges, one invoice row each. */}
            {customOptions.length > 0 && (
              <div style={{ marginTop: 14 }}>
                {customOptions.map((row, idx) => {
                  const invalid = !row.name || !row.name.trim();
                  return (
                    <div key={idx} style={{ display: "flex", gap: 6, alignItems: "center", marginBottom: 6 }}>
                      <input type="text" value={row.name} placeholder="Item name (required)"
                        onChange={(e) => setCustomOptions((p) => p.map((r, i) => i === idx ? { ...r, name: e.target.value } : r))}
                        style={{ flex: 1, minWidth: 0, border: `1px solid ${invalid ? "#DC2626" : "#CBD5E1"}`, borderRadius: 6, padding: "6px 8px", fontSize: 12, outline: "none", background: invalid ? "#FEF2F2" : "#FFF", wordBreak: "break-word" }} />
                      <input type="number" min="0" value={row.qty} placeholder="Qty"
                        onChange={(e) => { const v = e.target.value.replace(/[^0-9]/g, ""); setCustomOptions((p) => p.map((r, i) => i === idx ? { ...r, qty: v } : r)); }}
                        style={{ width: 50, flex: "0 0 auto", border: "1px solid #CBD5E1", borderRadius: 6, padding: "6px 4px", fontSize: 12, outline: "none", textAlign: "center", boxSizing: "border-box" }} />
                      <div style={amtInputWrap}>
                        <span style={{ fontSize: 12, color: "#64748B", marginRight: 2, flexShrink: 0 }}>$</span>
                        <input type="number" min="0" value={row.amount} placeholder="0.00"
                          onChange={(e) => setCustomOptions((p) => p.map((r, i) => i === idx ? { ...r, amount: e.target.value.replace(/[^0-9.]/g, "") } : r))}
                          style={{ flex: 1, minWidth: 0, width: "100%", border: "none", padding: "6px 0", fontSize: 12, outline: "none" }} />
                      </div>
                      <button onClick={() => setCustomOptions((p) => p.filter((_, i) => i !== idx))} style={delBtn}>×</button>
                    </div>
                  );
                })}
              </div>
            )}

            {/* Discounts — reduce the estimate total. Editable ONLY in the portal: on the
                public side a rep-applied discount renders read-only, because an editable
                row would let a shopper reopen their share link, inflate their own discount
                and resubmit — the estimate is rebuilt from these values. */}
            {(sel.discounts || []).length > 0 && (
              <div style={{ marginTop: 14 }}>
                {(sel.discounts || []).map((row, idx) => (
                  <div key={idx} style={{ display: "flex", gap: 6, alignItems: "center", marginBottom: 6 }}>
                    {embedded ? (
                      <input type="text" value={row.description || ""} placeholder="Discount description"
                        onChange={(e) => setSel((p) => ({ ...p, discounts: (p.discounts || []).map((r, i) => i === idx ? { ...r, description: e.target.value } : r) }))}
                        style={{ flex: 1, minWidth: 0, border: "1px solid #CBD5E1", borderRadius: 6, padding: "6px 8px", fontSize: 12, outline: "none", background: "#FFF", wordBreak: "break-word" }} />
                    ) : (
                      <div style={{ flex: 1, minWidth: 0, fontSize: 12, fontWeight: 700, color: "#334155", padding: "6px 0", wordBreak: "break-word" }}>{row.description || "Discount"}</div>
                    )}
                    {embedded ? (
                      <div style={amtInputWrap}>
                        <span style={{ fontSize: 12, color: "#64748B", marginRight: 2, flexShrink: 0, whiteSpace: "nowrap" }}>−$</span>
                        <input type="number" min="0" value={row.amount || ""} placeholder="0.00"
                          onChange={(e) => { const v = e.target.value.replace(/[^0-9.]/g, ""); setSel((p) => ({ ...p, discounts: (p.discounts || []).map((r, i) => i === idx ? { ...r, amount: v } : r) })); }}
                          style={{ flex: 1, minWidth: 0, width: "100%", border: "none", padding: "6px 0", fontSize: 12, outline: "none" }} />
                      </div>
                    ) : (
                      <div style={{ width: 85, textAlign: "right", fontSize: 12, fontWeight: 700, color: "#059669", flexShrink: 0 }}>−${Number(row.amount || 0).toFixed(2)}</div>
                    )}
                    {embedded
                      ? <button onClick={() => setSel((p) => ({ ...p, discounts: (p.discounts || []).filter((_, i) => i !== idx) }))} style={delBtn}>×</button>
                      : <span style={{ width: 28, flexShrink: 0 }} />}
                  </div>
                ))}
              </div>
            )}

            {/* Delivery fee — last line before the subtotal (below the discounts); rendered once
                "+ Add Delivery Fee" is clicked or a fee is already set; × clears and hides it. */}
            {showDelivery && (
              <div style={{ marginTop: 14, display: "flex", gap: 6, alignItems: "center", marginBottom: 6 }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 12, fontWeight: 700, color: "#334155" }}>Delivery Fee</div>
                  <div style={{ fontSize: 10.5, color: "#94A3B8" }}>Non-taxable line on the estimate</div>
                </div>
                {embedded ? (
                  <div style={amtInputWrap}>
                    <span style={{ fontSize: 12, color: "#64748B", marginRight: 2, flexShrink: 0 }}>$</span>
                    <input type="text" inputMode="decimal" value={sel.deliveryFee || ""} placeholder="0.00"
                      onChange={(e) => { const v = e.target.value.replace(/[^0-9.]/g, ""); setSel((p) => ({ ...p, deliveryFee: v })); }}
                      style={{ flex: 1, minWidth: 0, width: "100%", border: "none", padding: "6px 0", fontSize: 12, outline: "none" }} />
                  </div>
                ) : (
                  <div style={{ width: 85, textAlign: "right", fontSize: 12, fontWeight: 700, color: "#334155", flexShrink: 0 }}>${Number(sel.deliveryFee || 0).toFixed(2)}</div>
                )}
                {embedded
                  ? <button title="Remove the delivery fee"
                      onClick={() => { setDeliveryOpen(false); setSel((p) => ({ ...p, deliveryFee: "" })); }}
                      style={delBtn}>×</button>
                  : <span style={{ width: 28, flexShrink: 0 }} />}
              </div>
            )}

            {/* Subtotal — pre-tax; tax is address-based and applied on the estimate. */}
            {C.showPricing && (
              <div style={{ display: "flex", gap: 6, alignItems: "center", borderTop: "2px solid #E2E8F0", marginTop: 12, paddingTop: 8 }}>
                <div style={{ flex: 1, minWidth: 0, fontSize: 12, fontWeight: 800, color: "#1E293B" }}>
                  Subtotal <span style={{ fontWeight: 600, color: "#94A3B8", fontSize: 10.5 }}>(before tax)</span>
                </div>
                <div style={{ width: 85, flex: "0 0 auto", textAlign: "right", fontSize: 13, fontWeight: 800, color: "#1E293B", padding: "6px 8px", boxSizing: "border-box" }}>{fmtMoney2(subtotal)}</div>
                <div style={actSpacer} />
              </div>
            )}

            {/* Add buttons — below the subtotal, invoice-footer style. */}
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 12 }}>
              <button onClick={() => setCustomOptions((p) => [...p, { name: "", qty: "", amount: "" }])} style={dashBtn}>+ Add Custom Option</button>
              {/* Business-only: a shopper must not be able to discount their own quote or
                  invent a delivery fee. Rows already ON a reopened design still render —
                  a rep-applied discount is part of the customer's real quote. */}
              {embedded && <button onClick={() => setSel((p) => ({ ...p, discounts: [...(p.discounts || []), { description: "", amount: "" }] }))} style={dashBtn}>+ Add Discount</button>}
              {embedded && !showDelivery && <button onClick={() => setDeliveryOpen(true)} style={dashBtn}>+ Add Delivery Fee</button>}
            </div>
            <div style={{ fontSize: 10.5, color: "#94A3B8", marginTop: 6 }}>
              Custom options add charges · discounts reduce the estimate total · delivery is added as a non-taxable line.
            </div>
          </div>
            );
          })()}
        </div>
      )}

      {/* Save-to-Inventory dialog (embedded-only; opened from the Submit Bar button). */}
      {embedded && invDialog && (
        <div onClick={() => setInvDialog(null)}
          style={{ position: "fixed", inset: 0, background: "rgba(15,23,42,0.45)", zIndex: 9000, display: "flex", alignItems: "center", justifyContent: "center", padding: 16 }}>
          <div onClick={(e) => e.stopPropagation()}
            style={{ background: "#FFF", borderRadius: 14, width: "min(440px, 96vw)", padding: 20, boxShadow: "0 20px 60px rgba(0,0,0,0.3)", fontFamily: "system-ui, -apple-system, sans-serif" }}>
            {invDialog.done ? (
              <React.Fragment>
                <div style={{ fontSize: 17, fontWeight: 800, color: "#15803D", marginBottom: 6 }}>
                  {invDialog.done.updated
                    ? "Inventory building updated"
                    : `Requested${invDialog.done.serial != null ? ` — Serial #${invDialog.done.serial}` : ""}`}
                </div>
                <div style={{ fontSize: 13, color: "#475569", marginBottom: 16 }}>
                  {invDialog.done.updated
                    ? <>Find it on your portal's Inventory tab.</>
                    : <>Find it on your portal's Inventory tab, and put it on the <strong>Build Schedule</strong> when
                       you're ready to make it. You can quote it to a customer at any time — a building can be
                       sold before it's built.</>}
                </div>
                <div style={{ display: "flex", justifyContent: "flex-end" }}>
                  <button type="button" onClick={() => setInvDialog(null)}
                    style={{ background: "#1E293B", color: "#FFF", border: "none", borderRadius: 8, padding: "9px 18px", fontSize: 13, fontWeight: 700, cursor: "pointer" }}>Done</button>
                </div>
              </React.Fragment>
            ) : (
              <React.Fragment>
                <div style={{ fontSize: 17, fontWeight: 800, color: "#1E293B", marginBottom: 4 }}>
                  {inventoryMaster && inventoryMaster.unitId ? "Update inventory building" : "Request this build"}
                </div>
                <div style={{ fontSize: 12.5, color: "#64748B", marginBottom: 14, lineHeight: 1.5 }}>
                  {inventoryMaster && inventoryMaster.unitId
                    ? "Saves your design changes to this building. Its serial number and any estimates already sent are unaffected."
                    : "No customer needed. This goes on your Inventory list as a REQUEST and takes the next serial number automatically — it isn't on the lot yet, and won't show as available to sell until it's built and brought to a location."}
                </div>
                {invDialog.err && (
                  <div style={{ background: "#FEF2F2", border: "1px solid #FECACA", borderRadius: 8, padding: "8px 12px", marginBottom: 12, color: "#DC2626", fontSize: 12.5, fontWeight: 600 }}>{invDialog.err}</div>
                )}
                {(() => { const loc = invLocations.find((l) => String(l.id) === String(invLocationId)); const name = loc ? (loc.city && loc.city !== loc.name ? `${loc.name} — ${loc.city}` : loc.name) : "none yet"; return (
                  <div style={{ fontSize: 12.5, color: "#475569", marginBottom: 12 }}>Location: <b>{name}</b></div>
                ); })()}
                <label style={{ display: "block", fontSize: 10.5, fontWeight: 800, letterSpacing: 0.5, textTransform: "uppercase", color: "#94A3B8", marginBottom: 4 }}>Asking price</label>
                <input value={invDialog.price} inputMode="decimal" placeholder="0.00"
                  onChange={(e) => setInvDialog((d) => d && { ...d, price: e.target.value })}
                  disabled={invDialog.busy}
                  style={{ width: "100%", boxSizing: "border-box", border: "1px solid #E2E8F0", borderRadius: 8, padding: "9px 10px", fontSize: 13.5, background: "#FFF", color: "#1E293B" }} />
                <div style={{ fontSize: 11, color: "#94A3B8", margin: "5px 0 14px" }}>
                  Starts at this design's quoted price — a markdown here never changes your catalog.
                </div>
                <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
                  {/* Never disabled: a stalled edge call must not trap the builder behind a
                      full-screen overlay with unsaved canvas work. Closing only drops the
                      dialog — an in-flight save still completes on the server. */}
                  <button type="button" onClick={() => setInvDialog(null)}
                    style={{ background: "#F1F5F9", color: "#334155", border: "1px solid #E2E8F0", borderRadius: 8, padding: "9px 16px", fontSize: 13, fontWeight: 700, cursor: "pointer" }}>Cancel</button>
                  <button type="button" onClick={saveInventory} disabled={invDialog.busy}
                    style={{ background: invDialog.busy ? "#9CA3AF" : accent, color: "#FFF", border: "none", borderRadius: 8, padding: "9px 18px", fontSize: 13, fontWeight: 800, cursor: invDialog.busy ? "wait" : "pointer" }}>
                    {invDialog.busy ? "Saving…" : (inventoryMaster && inventoryMaster.unitId ? "Save changes" : "Send request")}
                  </button>
                </div>
              </React.Fragment>
            )}
          </div>
        </div>
      )}

      {/* Submit Bar */}
      {!submitted && (
        <div style={{ background: "#FFF", borderTop: "2px solid #E2E8F0", padding: "16px 20px" }}>
          {submitError && (
            <div style={{ background: "#FEF2F2", border: "1px solid #FECACA", borderRadius: 8, padding: "10px 14px", marginBottom: 12, color: "#DC2626", fontSize: 13, fontWeight: 600 }}>
              {submitError}
            </div>
          )}
          <div style={{ display: "flex", gap: 10, alignItems: "center", justifyContent: "space-between" }}>
            <p style={{ margin: 0, fontSize: 12, color: "#64748B", flex: 1 }}>
              {(inventoryNew || inventoryMaster)
                ? (inventoryMaster && inventoryMaster.unitId
                  ? <>Design the building and pick its location, then click <strong>Update Inventory Building</strong>.</>
                  : <>Design the building and pick where it will sit, then click <strong>Request this build</strong>. It lands on your Inventory list as a request — put it on the Build Schedule when you're ready to make it.</>)
                : hasExistingEstimate
                ? <>Update your selections, then click <strong>Resubmit for Updated Estimate</strong> to refresh and re-send your quote.</>
                : <>Place your options on the layout above, then click <strong>Get Quote</strong> to receive a detailed estimate.</>}
            </p>
            {/* Business users can send this design to the lot instead of a customer.
                Embedded-only: inventory is a portal feature; customers never see it. */}
            {embedded && (inventoryNew || inventoryMaster) && (
              <div style={{ display: "flex", alignItems: "center", gap: 8, whiteSpace: "nowrap" }}>
                {/* Where this building sits — inline so it's set right beside the Save button. */}
                <select
                  value={invLocationId}
                  onChange={(e) => setInvLocationId(e.target.value)}
                  title="Location — where this building sits on your lot"
                  style={{
                    border: "1.5px solid #CBD5E1", borderRadius: 10, padding: "12px 12px",
                    fontSize: 14, fontWeight: 700, color: "#334155", background: "#FFF",
                    cursor: "pointer", maxWidth: 210,
                  }}
                >
                  <option value="">{invLocations.length ? "No location yet" : "Loading locations…"}</option>
                  {invLocations.map((l) => (
                    <option key={l.id} value={l.id}>{l.name}{l.city ? ` — ${l.city}` : ""}</option>
                  ))}
                </select>
                <button
                  type="button"
                  onClick={openInventoryDialog}
                  disabled={submitting || Boolean(invDialog && invDialog.busy)}
                  style={{
                    background: (submitting || (invDialog && invDialog.busy)) ? "#9CA3AF" : accent, color: "#FFF",
                    border: "none", borderRadius: 10, padding: "12px 22px", fontSize: 14, fontWeight: 800,
                    cursor: (submitting || (invDialog && invDialog.busy)) ? "wait" : "pointer",
                    letterSpacing: "-0.01em", whiteSpace: "nowrap",
                    boxShadow: (submitting || (invDialog && invDialog.busy)) ? "none" : `0 4px 14px ${accent}50`,
                  }}
                >
                  {inventoryMaster && inventoryMaster.unitId ? "Update Inventory Building" : "Request this build"}
                </button>
              </div>
            )}
            {/* Get Quote is a customer action — hidden while building/editing an inventory unit
                (a lot building is quoted later via "Send estimate" on the Inventory tab). */}
            {!(inventoryNew || inventoryMaster) && (
              <button
                onClick={submitQuote}
                disabled={submitting}
                style={{
                  background: submitting ? "#9CA3AF" : accent, color: "#FFF", border: "none", borderRadius: 10,
                  padding: "12px 32px", fontSize: 16, fontWeight: 800, cursor: submitting ? "wait" : "pointer",
                  letterSpacing: "-0.01em", boxShadow: submitting ? "none" : `0 4px 14px ${accent}50`,
                  transition: "all 0.2s", minWidth: 160,
                }}
              >
                {submitting ? "Submitting..." : (hasExistingEstimate ? "Resubmit for Updated Estimate" : "Get Quote")}
              </button>
            )}
          </div>
          {estimateVersions.length > 0 && (() => {
            const cur = viewingVersion == null ? estimateVersions[0] : (estimateVersions.find((v) => v.version === viewingVersion) || estimateVersions[0]);
            const others = estimateVersions.filter((v) => v.version !== cur.version);
            const csel = cur.selections || {};
            return (
              <div style={{ marginTop: 14, borderTop: "1px solid #F1F5F9", paddingTop: 12 }}>
                <div style={{ fontSize: 11, fontWeight: 700, color: "#64748B", textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 4 }}>All designs on this estimate</div>
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, padding: "8px 0" }}>
                  <div style={{ minWidth: 0 }}>
                    <span style={{ fontSize: 13, fontWeight: 700, color: "#1E293B" }}>{[capWords(csel.style), csel.size].filter(Boolean).join(" ") || "Design"}</span>
                    <span style={{ fontSize: 12, color: "#94A3B8", fontWeight: 600 }}> · v{cur.version} (viewing)</span>
                    {others.length > 0 && (
                      <button onClick={() => setVersionsOpen((o) => !o)} style={{ marginLeft: 8, background: "transparent", border: "none", padding: 0, cursor: "pointer", color: accent, fontSize: 12, fontWeight: 700 }}>
                        {versionsOpen ? "▴ hide" : `▾ ${estimateVersions.length} versions`}
                      </button>
                    )}
                  </div>
                  <div style={{ whiteSpace: "nowrap", flexShrink: 0 }}>
                    <span style={{ color: "#94A3B8", fontWeight: 700, marginRight: 12, fontSize: 13 }}>Viewing</span>
                    {ssSafeUrl(cur.image_url) && <a href={ssSafeUrl(cur.image_url)} target="_blank" rel="noopener" style={{ color: "#334155", fontWeight: 700, textDecoration: "none", fontSize: 13 }}>PDF</a>}
                  </div>
                </div>
                {versionsOpen && others.map((v) => {
                  const vsel = v.selections || {};
                  let dstr = ""; try { dstr = new Date(v.created_at).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }); } catch { /* ignore */ }
                  return (
                    <div key={v.version} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, padding: "7px 0 7px 12px", borderTop: "1px solid #F1F5F9", background: "#F8FAFC" }}>
                      <div style={{ minWidth: 0, fontSize: 13, color: "#64748B" }}>↳ v{v.version} · {[capWords(vsel.style), vsel.size].filter(Boolean).join(" ") || "Design"}{dstr ? ` · ${dstr}` : ""}</div>
                      <div style={{ whiteSpace: "nowrap", flexShrink: 0 }}>
                        <button onClick={() => openVersion(v.version)} style={{ background: "transparent", border: "none", padding: 0, cursor: "pointer", color: accent, fontWeight: 700, marginRight: 12, fontSize: 13 }}>Open</button>
                        {ssSafeUrl(v.image_url) && <a href={ssSafeUrl(v.image_url)} target="_blank" rel="noopener" style={{ color: "#334155", fontWeight: 700, textDecoration: "none", fontSize: 13 }}>PDF</a>}
                      </div>
                    </div>
                  );
                })}
              </div>
            );
          })()}
        </div>
      )}

      {/* Success Screen */}
      {submitted && (
        <div style={{ background: "#F0FDF4", borderTop: "2px solid #BBF7D0", padding: "32px 20px", textAlign: "center" }}>
          <div style={{ fontSize: 48, marginBottom: 12 }}>✅</div>
          <h3 style={{ margin: "0 0 8px", fontSize: 20, fontWeight: 700, color: "#166534" }}>
            {savedDesign && savedDesign.ssQuote
              ? (savedDesign.updated ? "Quote Updated!" : "Quote Created!")
              : (savedDesign && savedDesign.updated ? "Estimate Updated!" : "Quote Request Submitted!")}
          </h3>
          <p style={{ margin: 0, fontSize: 14, color: "#15803D", maxWidth: 460, marginLeft: "auto", marginRight: "auto" }}>
            {savedDesign && savedDesign.ssQuote
              ? (savedDesign.quoteEmailed
                ? `Thank you, ${contact.name || ""}! The quote has been emailed with a link to view and sign it.`
                : `Thank you, ${contact.name || ""}! The quote is ready — print it or share the link below.`)
              : (savedDesign && savedDesign.updated
                ? `Thank you, ${contact.name || ""}! Your existing estimate has been updated and re-sent by email.`
                : `Thank you, ${contact.name || ""}! We've received your building configuration and layout. A team member will prepare your detailed estimate and reach out shortly.`)}
          </p>
          {savedDesign && savedDesign.changeOrder && (
            /* This revision changed a SIGNED order (migration 126): the customer must
               acknowledge it before the order can be invoiced. */
            <div style={{ maxWidth: 520, margin: "14px auto 0", background: "#FEF3C7", border: "1px solid #FDE68A", color: "#B45309", borderRadius: 10, padding: "10px 14px", fontSize: 13, fontWeight: 600, textAlign: "left" }}>
              This changes an order the customer already signed — change order
              {savedDesign.changeOrder.coNo != null ? ` CO-${savedDesign.changeOrder.coNo}` : ""} needs their
              approval (they sign from their quote page, or record their verbal OK on the order). Invoicing
              waits until it's acknowledged.
            </div>
          )}
          {savedDesign && savedDesign.ssQuote && savedDesign.quoteEmailed === false && (
            /* The quote exists but no email went out (no address on file, or the tenant's
               sending domain isn't live). Silence here reads as "the customer got it". */
            <div style={{ maxWidth: 520, margin: "14px auto 0", background: "#FEF3C7", border: "1px solid #FDE68A", color: "#B45309", borderRadius: 10, padding: "10px 14px", fontSize: 13, fontWeight: 600, textAlign: "left" }}>
              Not emailed{savedDesign.quoteEmailReason ? ` — ${savedDesign.quoteEmailReason}` : ""}. Print the quote or copy the customer link below and send it yourself.
            </div>
          )}
          {savedDesign && (
            <div style={{ maxWidth: 520, margin: "20px auto 0", background: "#FFF", border: "1px solid #BBF7D0", borderRadius: 10, padding: 14, textAlign: "left" }}>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 10 }}>
                <span style={{ fontSize: 11, fontWeight: 700, color: "#64748B", textTransform: "uppercase", letterSpacing: "0.06em" }}>Design ID</span>
                <span style={{ fontSize: 16, fontWeight: 800, color: "#1E293B", letterSpacing: "0.05em", fontFamily: "monospace" }}>{savedDesign.code}</span>
              </div>
              {savedDesign.estimateNumber && (
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 10 }}>
                  <span style={{ fontSize: 11, fontWeight: 700, color: "#64748B", textTransform: "uppercase", letterSpacing: "0.06em" }}>{savedDesign.ssQuote ? "Quote #" : "Estimate #"}</span>
                  {/* SS numbers carry the builder's own prefix and render verbatim; EST- is GHL's. */}
                  <span style={{ fontSize: 14, fontWeight: 700, color: "#1E293B", fontFamily: "monospace" }}>{savedDesign.ssQuote ? savedDesign.estimateNumber : `EST-${savedDesign.estimateNumber}`}</span>
                </div>
              )}
              {savedDesign.ssQuote && (
                <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 4 }}>
                  {savedDesign.quotePdfUrl && (
                    <a href={savedDesign.quotePdfUrl} target="_blank" rel="noopener"
                      style={{ ...S.btn(accent, "#FFF"), padding: "9px 16px", fontSize: 13, textDecoration: "none" }}>
                      Print quote (PDF)
                    </a>
                  )}
                  <button type="button"
                    onClick={(e) => {
                      const link = `${window.location.origin}/my-quotes?client=${encodeURIComponent(C.clientId)}`;
                      const btn = e.currentTarget;
                      const done = () => { btn.textContent = "Copied ✓"; setTimeout(() => { btn.textContent = "Copy customer link"; }, 2000); };
                      if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(link).then(done, done);
                      else { window.prompt("Copy the customer link:", link); }
                    }}
                    style={{ ...S.btn("#FFF", accent), border: `2px solid ${accent}`, padding: "9px 16px", fontSize: 13 }}>
                    Copy customer link
                  </button>
                </div>
              )}
            </div>
          )}
          {estimateVersions.length > 0 && (() => {
            const cur = estimateVersions[0];
            const others = estimateVersions.slice(1);
            const csel = cur.selections || {};
            return (
              <div style={{ maxWidth: 520, margin: "16px auto 0", background: "#FFF", border: "1px solid #BBF7D0", borderRadius: 10, padding: 14, textAlign: "left" }}>
                <div style={{ fontSize: 11, fontWeight: 700, color: "#64748B", textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 4 }}>All designs on this estimate</div>
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, padding: "8px 0" }}>
                  <div style={{ minWidth: 0 }}>
                    <span style={{ fontSize: 13, fontWeight: 700, color: "#1E293B" }}>{[capWords(csel.style), csel.size].filter(Boolean).join(" ") || "Design"}</span>
                    <span style={{ fontSize: 12, color: "#94A3B8", fontWeight: 600 }}> · v{cur.version} (current)</span>
                    {others.length > 0 && (
                      <button onClick={() => setVersionsOpen((o) => !o)} style={{ marginLeft: 8, background: "transparent", border: "none", padding: 0, cursor: "pointer", color: accent, fontSize: 12, fontWeight: 700 }}>
                        {versionsOpen ? "▴ hide" : `▾ ${estimateVersions.length} versions`}
                      </button>
                    )}
                  </div>
                  {ssSafeUrl(cur.image_url) && <a href={ssSafeUrl(cur.image_url)} target="_blank" rel="noopener" style={{ color: "#334155", fontWeight: 700, textDecoration: "none", fontSize: 13, whiteSpace: "nowrap", flexShrink: 0 }}>PDF</a>}
                </div>
                {versionsOpen && others.map((v) => {
                  const vsel = v.selections || {};
                  let dstr = ""; try { dstr = new Date(v.created_at).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }); } catch { /* ignore */ }
                  return (
                    <div key={v.version} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, padding: "7px 0 7px 12px", borderTop: "1px solid #F1F5F9", background: "#F8FAFC" }}>
                      <div style={{ minWidth: 0, fontSize: 13, color: "#64748B" }}>↳ v{v.version} · {[capWords(vsel.style), vsel.size].filter(Boolean).join(" ") || "Design"}{dstr ? ` · ${dstr}` : ""}</div>
                      <div style={{ whiteSpace: "nowrap", flexShrink: 0 }}>
                        <button onClick={() => { setSubmitted(false); openVersion(v.version); }} style={{ background: "transparent", border: "none", padding: 0, cursor: "pointer", color: accent, fontWeight: 700, marginRight: 12, fontSize: 13 }}>Open</button>
                        {ssSafeUrl(v.image_url) && <a href={ssSafeUrl(v.image_url)} target="_blank" rel="noopener" style={{ color: "#334155", fontWeight: 700, textDecoration: "none", fontSize: 13 }}>PDF</a>}
                      </div>
                    </div>
                  );
                })}
              </div>
            );
          })()}
          <div style={{ display: "flex", gap: 10, justifyContent: "center", flexWrap: "wrap", marginTop: 20 }}>
            <button
              onClick={() => { setSubmitted(false); }}
              style={{ ...S.btn("#FFF", accent), border: `2px solid ${accent}`, padding: "10px 24px", fontSize: 14 }}
            >
              Review to make additional changes
            </button>
            <button
              onClick={() => {
                setSubmitted(false);
                setSavedDesign(null);
                setItems([]);
                setSel((p) => { const n = { ...p }; Object.keys(n).forEach((k) => n[k] = ""); return n; });
                setContact({ name: "", phone: "", email: "", street: "", city: "", state: "", zip: "" });
                setPaintColors({ body: "", trim: "" });
                setCustomOptions([]);
                setRoDimensions({});
                currentDesignIdRef.current = null;
                isDraftRef.current = false;
                draftStateRef.current = null;
                ghlContactIdRef.current = null;
                ghlEstimateIdRef.current = null;
                ghlEstimateNumberRef.current = null;
                // Inventory state MUST reset with everything else: a stale inventoryUnitRef
                // would silently link the NEXT, unrelated customer's estimate to the last
                // unit quoted — and that estimate going accepted would then flip a building
                // that never sold to Sold, false-warning every real prospect on it.
                inventoryUnitRef.current = null;
                setInventoryMaster(null);
                setDesignUnit(null);
                setNewBuildMode(false);
                setHasExistingEstimate(false);
                setDesignCode(null);
                setEstimateVersions([]);
                setViewingVersion(null);
                if (!embedded) window.history.replaceState({}, "", window.location.pathname);
              }}
              style={{ ...S.btn(accent, "#FFF"), padding: "10px 24px", fontSize: 14 }}
            >
              Start New Quote
            </button>
          </div>
        </div>
      )}
      {toast && (
        <div style={{ position: "fixed", top: 20, left: "50%", transform: "translateX(-50%)", zIndex: 1100, maxWidth: 460, width: "90%" }}>
          <div style={{
            background: "#FFFBEB", border: "2px solid #F59E0B", borderRadius: 12, padding: "14px 20px",
            boxShadow: "0 8px 30px rgba(0,0,0,0.15)", display: "flex", gap: 12, alignItems: "flex-start",
          }}>
            <span style={{ fontSize: 24, lineHeight: 1, flexShrink: 0 }}>⚠️</span>
            <div style={{ flex: 1 }}>
              <div style={{ fontWeight: 700, fontSize: 14, color: "#92400E", marginBottom: 4 }}>Can't place here</div>
              <div style={{ fontSize: 13, color: "#A16207", lineHeight: 1.4 }}>{toast}</div>
            </div>
            <button onClick={() => setToast(null)} style={{ background: "none", border: "none", fontSize: 18, cursor: "pointer", color: "#92400E", flexShrink: 0, padding: 0 }}>✕</button>
          </div>
        </div>
      )}

      {cal3dPreview}

      {show3D && (
        <Structure3DViewer
          bldgW={bldgW} bldgH={bldgH} items={items} itemTypes={ITEMS}
          styleValue={sel.style} frontWall={frontWall}
          painted={sel.paint === "Painted"} paintBody={paintColors.body} paintTrim={paintColors.trim}
          scale={scale} mgX={mgX} mgY={mgY} accent={accent}
          style3d={d3ResolveStyleSpec(selectedStyle, sel.style, C.wallHeightFt, d3SidingOverride(C, sel), sel.wallHeight)}
          roofType={sel.roofType}
          roofColorHex={(() => { const rc = (Array.isArray(C.colors) ? C.colors : []).find((c) => c.label === sel.roofColor && (sel.roofType === "Metal" ? c.metal : c.shingle)); return (rc && rc.hex) ? rc.hex : ""; })()}
          fixtures={C.fixtures} doorColors={doorPaintColors} windowColors={windowColorList} bodyColors={bodyPaintPool} trimColors={trimPaintPool}
          paletteKeys={Object.keys(ITEMS).filter((k) => ITEMS[k] && !ITEMS[k].noPalette && (embedded || !ITEMS[k].internalOnly))}
          placeableDoors={placeableDoors} placeableWindows={placeableWindows} placeableRamps={placeableRamps}
          paintEnabled={C.options.some((o) => o.id === "paint" && isOptionApplicable(o, sel.style))}
          onPaintChange={(pc) => {
            setPaintColors({ body: pc.body, trim: pc.trim });
            setSel((p) => ({ ...p, paint: (pc.body || pc.trim) ? "Painted" : "No Paint" }));
          }}
          onWallHeight={(h) => setSel((p) => ({ ...p, wallHeight: h }))}
          onItemAdd={(ni) => setItems((p) => [...p, ni])}
          onItemSelect={(id) => setSelectedId(id)}
          onItemMove={(id, sn) => setItems((p) => p.map((i) => (i.id === id ? { ...i, ...sn } : i)))}
          onItemDelete={(id) => { setItems((p) => p.filter((i) => i.id !== id && !(i.type === "ramp" && i.snapDoorId === id))); setSelectedId(null); }}
          onSnapshot={(shot) => { render3DSnapshotRef.current = shot || null; setHas3DSnapshot(Boolean(shot)); }}
          onClose={() => setShow3D(false)}
        />
      )}

      {showExport && (
        <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.6)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 1000, padding: 20 }} onClick={() => { setShowExport(false); setExportUrl(null); }}>
          <div style={{ background: "#FFF", borderRadius: 16, padding: 24, maxWidth: 580, width: "100%", boxShadow: "0 20px 60px rgba(0,0,0,0.2)" }} onClick={(e) => e.stopPropagation()}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
              <h3 style={{ margin: 0, fontSize: 18, fontWeight: 700, color: "#1E293B" }}>{(C.branding.companyName || "Design Studio")} Export</h3>
              <button onClick={() => { setShowExport(false); setExportUrl(null); }} style={{ background: "none", border: "none", fontSize: 20, cursor: "pointer", color: "#94A3B8" }}>✕</button>
            </div>
            {exportUrl && (
              <>
                <img src={exportUrl} alt="Floor Plan" style={{ width: "100%", borderRadius: 8, border: "1px solid #E2E8F0" }} />
                <div style={{ display: "flex", gap: 8, marginTop: 16 }}>
                  <button onClick={downloadPDF} style={{ flex: 1, ...S.btn("#B91C1C", "#FFF"), padding: 10, fontSize: 14 }}>⬇ Download PDF</button>
                  <button onClick={downloadPNG} style={{ flex: 1, ...S.btn("#1E293B", "#FFF"), padding: 10, fontSize: 14 }}>⬇ Download PNG</button>
                  <button onClick={() => { fetch(exportUrl).then((r) => r.blob()).then((b) => { navigator.clipboard.write([new ClipboardItem({ "image/png": b })]).catch(() => {}); }); }}
                    style={{ flex: 1, ...S.btn("#F1F5F9", "#334155"), border: "1px solid #E2E8F0", padding: 10, fontSize: 14 }}>📋 Copy</button>
                </div>
                <p style={{ fontSize: 11, color: "#94A3B8", marginTop: 12, textAlign: "center" }}>8.5"×11" letter — attach to your GHL estimate or invoice</p>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// ─── FeedbackWidget: REMOVED from the designer (2026-07-26) ───
// The bug/feature widget now lives in portal.html only. A submission has to be
// attributable to a signed-in portal user and their tenant (portal-feedback resolves
// both server-side from the JWT), and the public designer's visitors are anonymous
// shed-shoppers who should never have seen a "Report a bug" button on a tenant's
// customer-facing page. Mirror note: StructureStudio.jsx dropped its
// `import FeedbackWidget from "./FeedbackWidget.jsx"` in the same change.

// ─── Client-config loader (default export) ───
// Every page load fetches the tenant's config from public.client_configs — there
// is no in-source copy of any client. Resolution order:
//   1. `config` prop (e.g. supplied by index.html's postMessage re-render handler)
//      wins and is used as-is, no fetch.
//   2. `?client=<id>` URL param — explicit override, wins over hostname.
//   3. Subdomain — `juniorbarns.structurestudio.app` → "juniorbarns", on either
//      apex we serve (structurestudio.app and structurestudiosuite.com — both live
//      during the migration). Skipped for the apexes themselves, IPs, localhost,
//      *.pages.dev / *.netlify.app / *.workers.dev deploy hosts, and the reserved
//      env labels (www/beta/dev/staging/app).
//   4. `?id=<short_code>` share-link — the design row records its owning tenant;
//      resolved via the load_design RPC (NOT a direct table read — that dies at
//      cutover) so a rep clicking someone else's link gets that tenant's branding.
//   5. Fallback: DEFAULT_CLIENT_ID.
// On fetch failure (network error or unknown client_id) we render an error screen
// with a retry button rather than silently falling back to a wrong-tenant config.
// The fetched config's clientId is always forced to the row key so a config blob
// can never point a tenant's designs at another tenant.

// A partial config row (e.g. branding-only) would crash the designer mid-render,
// so fail loud on the error screen instead. Every row must be authored complete —
// see the onboarding runbook in CLAUDE.md.
const REQUIRED_CONFIG_KEYS = ["branding", "contactFields", "buildingStyles", "defaultSizes", "options", "layoutItems"];

// Catches render-time throws inside the designer (e.g. a malformed-but-complete
// config row that passes REQUIRED_CONFIG_KEYS but has a bad nested shape) so the
// user gets a recoverable message instead of a blank white screen.
class DesignerErrorBoundary extends Component {
  constructor(props) { super(props); this.state = { err: null }; }
  static getDerivedStateFromError(err) { return { err }; }
  componentDidCatch(err) { console.error("[StructureStudio] designer render error:", err); if (window.ssLogError) window.ssLogError("designer", (err && err.message) || "render error", err && err.name, { phase: "render", stack: err && err.stack ? String(err.stack).slice(0, 2000) : null }); }
  render() {
    if (this.state.err) {
      return (
        <div style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", minHeight: this.props.embedded ? "40vh" : "100vh", padding: "0 24px", fontFamily: "system-ui, -apple-system, sans-serif", color: "#1E293B", textAlign: "center" }}>
          <div style={{ fontSize: 18, fontWeight: 700, marginBottom: 8 }}>This designer couldn't be displayed</div>
          <div style={{ fontSize: 13, color: "#64748B", maxWidth: 480, marginBottom: 4 }}>There's a problem with this builder's configuration. Please contact support.</div>
          <button onClick={() => window.location.reload()} style={{ marginTop: 20, padding: "8px 16px", background: "#1E293B", color: "#FFF", border: "none", borderRadius: 6, fontSize: 13, cursor: "pointer" }}>Reload</button>
        </div>
      );
    }
    return this.props.children;
  }
}

// Cutover marker: lets us verify from the deployed site which data path this
// bundle uses (multi-tenant RPC vs. legacy direct table access).
console.log("[StructureStudio] multi-tenant build: config-loader + RPC data path");

function StructureStudio({ config: configProp = null, clientId: clientIdProp = null, embedded = false, onSaved = null, openDesign = null, setup3d = null, view3d = false, calibrationOnly = false }) {
  // state shape: { status: "ready", config } | { status: "loading" } | { status: "error", clientId, message }
  const [state, setState] = useState(() => (
    configProp ? { status: "ready", config: configProp } : { status: "loading" }
  ));

  // White-label the browser tab: show the tenant's business name once config loads.
  // Skipped when embedded — the host page (the portal) owns its own tab title.
  useEffect(() => {
    if (embedded) return;
    if (state.status === "ready" && typeof document !== "undefined") {
      document.title = (state.config.branding && state.config.branding.companyName) || "Design Studio";
    }
  }, [state]);

  useEffect(() => {
    if (state.status !== "loading") return;
    if (typeof window === "undefined") return;
    const params = new URLSearchParams(window.location.search);
    // Embedded hosts (the owner portal) pass the tenant directly; the URL never
    // decides the tenant for an embedded mount.
    let clientId = clientIdProp || params.get("client");
    const designShortCode = params.get("id");
    // Tenant subdomains: derive a client_id from <sub>.<apex> on EITHER apex we serve.
    // Both are live during the Netlify → Cloudflare migration (structurestudio.app is
    // production today; structurestudiosuite.com is where we are moving, beta already
    // on it), so a branded link must resolve identically on both — supporting only the
    // old apex breaks every tenant's subdomain the day production cuts over, and only
    // the new one breaks them all today. Retire an entry here when its apex is retired.
    // Anything else (either apex itself, *.pages.dev / *.netlify.app / *.workers.dev
    // deploy hosts, localhost, IPs, env labels) falls through — a deploy hostname is
    // never a tenant.
    if (!clientId) {
      const host = window.location.hostname.toLowerCase();
      const TENANT_APEXES = ["structurestudio.app", "structurestudiosuite.com"];
      const RESERVED_SUBDOMAINS = ["www", "beta", "dev", "staging", "app"];
      for (const base of TENANT_APEXES) {
        if (!host.endsWith("." + base)) continue;
        const sub = host.slice(0, host.length - base.length - 1);
        if (sub && !sub.includes(".") && !RESERVED_SUBDOMAINS.includes(sub)) clientId = sub;
        break;
      }
    }
    // Bare product root: no tenant link (?client= / subdomain) and no design code.
    // This isn't any tenant's page — it's where business owners land, so send
    // them to the portal; they copy their customer design link from the dashboard.
    if (!clientId && !designShortCode) {
      if (embedded) {
        // An embedded mount must never navigate the host page — redirecting to
        // /portal.html from inside the portal would loop. Show the error screen.
        setState({ status: "error", clientId: "", message: "No client id was supplied to the embedded designer." });
        return;
      }
      // Carry the query AND hash across. Supabase delivers auth-email outcomes in the
      // URL — `#access_token=…&type=invite|recovery` (implicit), `?code=…` (PKCE), or
      // `#error=…&error_code=otp_expired` — and a bare replace("/portal") DESTROYS them,
      // so the portal booted with a clean URL, found no session, and showed a login form
      // instead of the set-password screen. That is the "invite/reset link just takes me
      // to login" bug (Carolyn, 2026-07-28). It reaches this page at all whenever the
      // link's redirect_to is not in Supabase's allow-list, because Supabase then falls
      // back to Site URL (the apex root). portal.html already handles all three shapes.
      window.location.replace("/portal" + window.location.search + window.location.hash);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const sb = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
        // Share-link path: ?id=<short_code> without ?client= or a tenant subdomain
        // means someone opened a saved design's bare link. The design row records
        // which tenant owns it; look that up so the right config wraps the load.
        if (!clientId && designShortCode) {
          const { data: rows, error: dErr } = await sb.rpc("load_design", { p_code: designShortCode });
          const design = Array.isArray(rows) ? rows[0] : rows;
          if (cancelled) return;
          if (dErr || !design || !design.client_id) {
            console.warn(`Design "${designShortCode}" not found while resolving client; using default.`, dErr);
            clientId = DEFAULT_CLIENT_ID;
          } else {
            clientId = design.client_id;
          }
        }
        if (!clientId) clientId = DEFAULT_CLIENT_ID;
        // Fetch this tenant's config via the get_config RPC (capability read),
        // not a direct client_configs table query: anon can no longer bulk-read
        // every tenant's config — only the one client_id it asks for. The RPC is
        // SECURITY DEFINER, so it keeps working after the table's anon SELECT is
        // revoked at cutover. Returns the config jsonb, or null for an unknown
        // client (→ the error screen, same as a missing row used to do).
        const { data: cfg, error } = await sb.rpc("get_config", { p_client_id: clientId });
        if (cancelled) return;
        if (error || !cfg) {
          console.warn(`Could not load config for client "${clientId}":`, error);
          setState({ status: "error", clientId, message: (error && error.message) || "Configuration not found." });
          return;
        }
        const missing = REQUIRED_CONFIG_KEYS.filter((k) => !cfg[k]);
        if (missing.length > 0) {
          setState({ status: "error", clientId, message: `Configuration row is incomplete (missing: ${missing.join(", ")}).` });
          return;
        }
        // Fixtures catalog (Options → Doors; windows/ramps later) — best-effort: a failure
        // just means no catalog doors in the palette, it never blocks the designer.
        let fixtures = [], rampSettings = null, windowColors = [];
        try {
          const fxRes = await sb.rpc("get_fixtures", { p_client_id: clientId });
          const fx = fxRes && fxRes.data;
          if (!cancelled && fx) {
            // get_fixtures returns either the legacy array or { items, ramp, windowColors }.
            if (Array.isArray(fx)) fixtures = fx;
            else {
              if (Array.isArray(fx.items)) fixtures = fx.items;
              if (fx.ramp) rampSettings = fx.ramp;
              if (Array.isArray(fx.windowColors)) windowColors = fx.windowColors;
            }
          }
        } catch (_e) { /* non-fatal */ }
        if (cancelled) return;
        setState({ status: "ready", config: { ...cfg, clientId, fixtures, rampSettings, windowColors } });
      } catch (e) {
        if (cancelled) return;
        console.warn("Client config fetch error:", e);
        setState({ status: "error", clientId: clientId || DEFAULT_CLIENT_ID, message: (e && e.message) || "Network error." });
      }
    })();
    return () => { cancelled = true; };
  }, [state.status]);

  if (state.status === "loading") {
    return (
      <div style={{ display: "flex", alignItems: "center", justifyContent: "center", minHeight: embedded ? "40vh" : "100vh", fontFamily: "system-ui, -apple-system, sans-serif", color: "#64748B", fontSize: 14 }}>
        Loading…
      </div>
    );
  }
  if (state.status === "error") {
    return (
      <div style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", minHeight: embedded ? "40vh" : "100vh", padding: "0 24px", fontFamily: "system-ui, -apple-system, sans-serif", color: "#1E293B", textAlign: "center" }}>
        <div style={{ fontSize: 18, fontWeight: 700, marginBottom: 8 }}>Could not load configuration</div>
        <div style={{ fontSize: 13, color: "#64748B", marginBottom: 4 }}>Client: <code>{state.clientId}</code></div>
        <div style={{ fontSize: 13, color: "#64748B", maxWidth: 480 }}>{state.message}</div>
        <button onClick={() => setState({ status: "loading" })} style={{ marginTop: 20, padding: "8px 16px", background: "#1E293B", color: "#FFF", border: "none", borderRadius: 6, fontSize: 13, cursor: "pointer" }}>Retry</button>
      </div>
    );
  }
  return <DesignerErrorBoundary embedded={embedded}><StructureStudioInner config={state.config} embedded={embedded} onSaved={onSaved} openDesign={openDesign} setup3d={setup3d} view3d={view3d} calibrationOnly={calibrationOnly} /></DesignerErrorBoundary>;
}

// Publish for the host pages' thin mount blocks (cross-block const sharing does not
// exist under Babel-standalone; JSX also needs a capitalized in-scope identifier).
window.StructureStudio = StructureStudio;
window.ssAllowedOrigin = ssAllowedOrigin;
