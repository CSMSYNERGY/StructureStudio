import { useState, useRef, useCallback, useEffect, useMemo, Component } from "react";
import { createPortal } from "react-dom";
import { createClient } from "@supabase/supabase-js";
import FeedbackWidget from "./FeedbackWidget.jsx";

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
  const niw = nc.width * sc;
  for (const it of existing) {
    const c = itemTypes[it.type];
    if (!c || !c.wallOnly || it.type === "window") continue;
    // Only check doors on the same wall
    if (it.wall !== ni.wall) continue;
    const iw = c.width * sc;
    // Check overlap along the wall axis
    if (ni.wall === "north" || ni.wall === "south") {
      if (Math.abs(ni.x - it.x) < (niw / 2) + (iw / 2) + 4) return true;
    } else {
      if (Math.abs(ni.y - it.y) < (niw / 2) + (iw / 2) + 4) return true;
    }
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
  const doubleDoors = items.filter((i) => i.type === "doubleDoor" && i.wall);
  if (doubleDoors.length > 0) return doubleDoors[0].wall;
  const singleDoors = items.filter((i) => i.type === "singleDoor" && i.wall);
  if (singleDoors.length > 0) return singleDoors[0].wall;
  return null;
}

// Map a positional wall to a display label (FRONT/BACK/LEFT/RIGHT)
// based on which wall is currently FRONT. Returns null if no front set.
// LEFT/RIGHT are determined from outside the building looking at the front.
function getDisplayLabel(positionalWall, frontWall) {
  if (!frontWall || !positionalWall) return null;
  const map = {
    north: { north: "FRONT", south: "BACK",  west: "LEFT",  east: "RIGHT" },
    south: { south: "FRONT", north: "BACK",  east: "LEFT",  west: "RIGHT" },
    east:  { east: "FRONT",  west: "BACK",   south: "LEFT", north: "RIGHT" },
    west:  { west: "FRONT",  east: "BACK",   north: "LEFT", south: "RIGHT" },
  };
  return map[frontWall][positionalWall];
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
    return h === "structurestudio.app" || h.endsWith(".structurestudio.app") || h === "localhost" || h === "127.0.0.1";
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
      const label = (C.layoutItems && C.layoutItems[k] && C.layoutItems[k].label) || k;
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
          const lbl = (C.layoutItems && C.layoutItems[k] && C.layoutItems[k].label) || k;
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

  // Roll placed items into counts + per-measure quantities. Ramp is priced "each" like
  // doors/windows — its qty is the number of ramps placed (one per door).
  let singleDoors = 0, doubleDoors = 0, windows = 0, lofts = 0, loftSqft = 0, ramps = 0;
  const workbenchFt = [];
  for (const it of items) {
    if (it.type === "singleDoor") singleDoors++;
    else if (it.type === "doubleDoor") doubleDoors++;
    else if (it.type === "window") windows++;
    else if (it.type === "workbench") workbenchFt.push(Number(it.widthFt) || 0);
    else if (it.type === "loft") { lofts++; loftSqft += (Number(it.widthFt) || 0) * (Number(it.heightFt) || 0); }
    else if (it.type === "ramp") ramps++;
  }
  loftSqft = Math.round(loftSqft);
  const totalWorkbenchFt = workbenchFt.reduce((s, f) => s + f, 0);
  const measures = {
    singleDoor: { count: singleDoors },
    doubleDoor: { count: doubleDoors },
    window:     { count: windows },
    workbench:  { count: workbenchFt.length, lengthFt: totalWorkbenchFt },
    loft:       { count: lofts, optionSqft: loftSqft },
    ramp:       { count: ramps },
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
    const label = (C.layoutItems && C.layoutItems[key] && C.layoutItems[key].label) || key;
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
    const incNote = (measured && inc > 0) ? ` · ${inc} ${rp.method === "sqft_option" ? "sq ft" : "ft"} included` : "";
    const row = { key, label, qty: dispQty, unit: ln.unit + incNote, total: ln.total, method: rp.method };
    rows.push(row);
    if (ln.total == null) deferred.push({ row, pct: ln.pct });
    else nonPctSubtotal += ln.total;
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

// Progressive US phone formatter: "8163003600" -> "(816) 300-3600".
// Caps at 10 digits; partial inputs format as "(816", "(816) 30", etc.
// Display only — strip back to digits before sending to GHL.
function formatPhoneDisplay(v) {
  const d = (v || "").replace(/\D/g, "").slice(0, 10);
  if (d.length === 0) return "";
  if (d.length <= 3) return `(${d}`;
  if (d.length <= 6) return `(${d.slice(0, 3)}) ${d.slice(3)}`;
  return `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}`;
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

function StructureStudioInner({ config, embedded = false, onSaved = null }) {
  const C = config;
  const ITEMS = { ...C.layoutItems, ...BUILT_IN_TOOLS };
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

  const [sel, setSel] = useState(() => {
    const init = { style: "", size: "", roofType: "", roofColor: "" };
    C.options.forEach((o) => { init[o.id] = o.type === "counter" ? o.options[0] : ""; });
    return init;
  });

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
    // Auto-exit pick mode if the last item of the target type disappears.
    if (pendingRemoval && !items.some((i) => i.type === pendingRemoval.type)) setPendingRemoval(null);
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
  const [toast, setToast] = useState(null);
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
  // Prevents the size-change effect from clearing items when we're rehydrating
  // a saved design (sel.size and items get set together).
  const prevSizeRef = useRef("");

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

  // Auto-update building size. Only clear items when the user *changes* the
  // size (not on first set, and not when loading a saved design).
  useEffect(() => {
    const p = parseSize(sel.size);
    if (p) {
      setShedW(p.w); setShedH(p.h);
      if (prevSizeRef.current && prevSizeRef.current !== sel.size) {
        setItems([]); setSelectedId(null);
      }
    }
    prevSizeRef.current = sel.size;
  }, [sel.size]);

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
    (async () => {
      // Capability RPC: returns the one row matching the code (or nothing).
      // Direct table reads are blocked for the anon key after cutover.
      const { data: rows, error } = await supabase.rpc("load_design", { p_code: id });
      const data = Array.isArray(rows) ? rows[0] : rows;
      if (cancelled || error || !data) return;
      currentDesignIdRef.current = data.short_code;
      setDesignCode(data.short_code);
      // Hydrate GHL refs so a re-submit becomes an update of the same estimate.
      ghlContactIdRef.current = data.ghl_contact_id || null;
      ghlEstimateIdRef.current = data.ghl_estimate_id || null;
      ghlEstimateNumberRef.current = data.ghl_estimate_number || null;
      setHasExistingEstimate(!!data.ghl_estimate_id);

      // Optionally open a specific saved version (?v=N) for review/resubmit. The design
      // DATA comes from that version's snapshot; the GHL refs above stay from the current
      // row so a resubmit updates the same one estimate rather than creating a new one.
      let design = data;
      const vParam = parseInt(params.get("v") || "", 10);
      if (Number.isFinite(vParam) && vParam > 0) {
        const { data: vrows } = await supabase.rpc("load_design_version", { p_code: id, p_version: vParam });
        const vrow = Array.isArray(vrows) ? vrows[0] : vrows;
        if (!cancelled && vrow) design = vrow;
      }
      if (cancelled) return;
      setViewingVersion(Number.isFinite(vParam) && vParam > 0 ? vParam : null);

      setContact(data.contact || { name: "", email: "", phone: "", street: "", city: "", state: "", zip: "" });
      setSel((prev) => ({ ...prev, ...(design.selections || {}) }));
      setPaintColors(design.paint_colors || { body: "", trim: "" });
      setPaintCustom({ body: false, trim: false });
      setCustomOptions(design.custom_options || []);
      setRoDimensions(design.ro_dimensions || {});
      // Items must be set after sel.size has propagated; the prevSizeRef guard
      // above keeps the size effect from wiping them.
      const loadedItems = Array.isArray(design.items) ? design.items : [];
      setItems(loadedItems);
      // Keep the global id counter ahead of any restored ids so the next placement can't
      // reuse an existing id (which collided in select/drag/delete/resize).
      idCounter = Math.max(idCounter, 0, ...loadedItems.map((i) => Number(i.id) || 0)) + 1;
    })();
    return () => { cancelled = true; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [supabase, embedded]);

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
    setSel((prev) => ({ ...prev, ...vsel }));
    setPaintColors(vrow.paint_colors || { body: "", trim: "" });
    setPaintCustom({ body: false, trim: false });
    setCustomOptions(vrow.custom_options || []);
    setRoDimensions(vrow.ro_dimensions || {});
    const loadedItems = Array.isArray(vrow.items) ? vrow.items : [];
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
  const PAGE_W = 850, PAGE_H = 1100;
  const TEXT_AREA_H = 340;          // bottom band reserved for auto customer info
  const TOP_LABEL_PAD = 30;         // space for size + FRONT labels above plan
  const BOT_LABEL_PAD = 30;         // space for size + BACK labels below plan
  const RAMP_SPACE_FT = 2;          // a ramp shows 2 ft past its wall (visual)
  const visibleH = PAGE_H - TEXT_AREA_H;
  // Plan dynamically scales: caps in three directions ensure a ramp fits
  // both north and south plus 70% target sizing.
  //   1) width ≤ 70% of page (so the plan never spans the full sheet)
  //   2) height ≤ 70% of the visible top area
  //   3) plan + 2 ramps + 2 label pads ≤ visibleH (so south + north ramps fit)
  const scale = Math.min(
    (PAGE_W * 0.70) / bldgW,
    (visibleH * 0.70) / bldgH,
    (visibleH - TOP_LABEL_PAD - BOT_LABEL_PAD) / (bldgH + 2 * RAMP_SPACE_FT)
  );
  const pW = bldgW * scale, pH = bldgH * scale;
  const mgX = (PAGE_W - pW) / 2;
  // Top-bias: plan sits idealRoom from the top so a north ramp + labels fit.
  // The third scale constraint guarantees there's also enough room for a south
  // ramp + label below the plan.
  const idealRoom = RAMP_SPACE_FT * scale + TOP_LABEL_PAD;
  const mgY = idealRoom;
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
      const doors = items.filter((i) => i.type === "singleDoor" || i.type === "doubleDoor");
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
      const doorCfg = ITEMS[closest.type];
      const doorW = doorCfg ? doorCfg.width : 3;
      const rampDepth = RAMP_SPACE_FT; // visual ramp depth in feet
      const rampDepthPx = rampDepth * scale;
      const rampWidthPx = doorW * scale;
      let rx, ry, rot;
      if (closest.wall === "north") { rx = closest.x; ry = mgY - rampDepthPx / 2; rot = 0; }
      else if (closest.wall === "south") { rx = closest.x; ry = mgY + pH + rampDepthPx / 2; rot = 0; }
      else if (closest.wall === "west") { rx = mgX - rampDepthPx / 2; ry = closest.y; rot = 90; }
      else if (closest.wall === "east") { rx = mgX + pW + rampDepthPx / 2; ry = closest.y; rot = 90; }
      else return;
      const ni = { id: idCounter++, type: activeTool, x: rx, y: ry, rotation: rot, wall: closest.wall, widthFt: doorW, heightFt: rampDepth, snapDoorId: closest.id };
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
      ni = { id: idCounter++, type: "loft", x: mgX + cxFt * scale, y: mgY + cyFtRound * scale, rotation: 0, wall: null, widthFt: bldgW, heightFt: loftH };
    } else if (wall) {
      const sn = snapToWall(wall, pt.x, pt.y, iwPx, ihPx, pW, pH, mgX, mgY);
      ni = { id: idCounter++, type: activeTool, ...sn, widthFt: cfg.width, heightFt: cfg.height };
    } else {
      const x = Math.max(mgX + iwPx / 2, Math.min(pt.x, mgX + pW - iwPx / 2));
      const y = Math.max(mgY + ihPx / 2, Math.min(pt.y, mgY + pH - ihPx / 2));
      ni = { id: idCounter++, type: activeTool, x, y, rotation: 0, wall: null, widthFt: cfg.width, heightFt: cfg.height };
    }
    setItems((p) => [...p, ni]);
    setActiveTool(null);
    setToast(null);
  }, [activeTool, dragging, getSvgPt, items, mgX, mgY, pW, pH, scale, ITEMS, pendingRemoval, selectedId, editingNoteId, gateRequired]);

  const onPtrDown = useCallback((e, item) => {
    e.stopPropagation();
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
      // and doesn't get stuck off-wall.
      const w = getWallFromClick(rx, ry, pW, pH, mgX, mgY) || getNearestWall(rx, ry, pW, pH, mgX, mgY);
      const sn = snapToWall(w, rx, ry, iWidthFt * scale, cfg.height * scale, pW, pH, mgX, mgY);
      // A ramp snapped to this door must follow it (position + wall); otherwise it
      // detaches and the stale geometry is rasterized into the exported PDF. (audit #F4)
      const rampDepthPx = RAMP_SPACE_FT * scale;
      const relocRamp = (rmp) => {
        if (sn.wall === "north") return { ...rmp, x: sn.x, y: mgY - rampDepthPx / 2, rotation: 0, wall: "north" };
        if (sn.wall === "south") return { ...rmp, x: sn.x, y: mgY + pH + rampDepthPx / 2, rotation: 0, wall: "south" };
        if (sn.wall === "west")  return { ...rmp, x: mgX - rampDepthPx / 2, y: sn.y, rotation: 90, wall: "west" };
        if (sn.wall === "east")  return { ...rmp, x: mgX + pW + rampDepthPx / 2, y: sn.y, rotation: 90, wall: "east" };
        return rmp;
      };
      setItems((p) => p.map((i) =>
        i.id === dragging.id ? { ...i, ...sn }
        : (i.type === "ramp" && i.snapDoorId === dragging.id ? relocRamp(i) : i)
      ));
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

  const delSel = () => { if (selectedId) { setItems((p) => p.filter((i) => i.id !== selectedId && !(i.type === "ramp" && i.snapDoorId === selectedId))); setSelectedId(null); setEditingNoteId(null); } };
  const rotSel = () => { if (!selectedId) return; setItems((p) => p.map((i) => { if (i.id !== selectedId) return i; const c = ITEMS[i.type]; if (c && (c.wallOnly || c.wallSnap || c.lineType)) return i; return { ...i, rotation: ((i.rotation || 0) + 90) % 360 }; })); };
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
        ctx.fillStyle = item.type === "roughOpening" ? "#FFFFFF" : cfg.color;
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
      else if (item.type === "ramp") { ctx.textAlign = "left"; ctx.fillText("RAMP", -iw / 2 + 5, 4); }
      else if (item.type === "loft") { ctx.fillStyle = cfg.color; ctx.fillText("LOFT", 0, 0); ctx.font = "10px sans-serif"; ctx.globalAlpha = 0.7; ctx.fillText(`${itemW}×${itemH} ft`, 0, 14); ctx.globalAlpha = 1; }
      else {
        const lblY = cfg.wallOnly ? ((item.wall === "north" || item.wall === "east") ? 14 : -10) : 4;
        let label = cfg.shortLabel;
        if (item.type === "roughOpening") {
          const idx = items.filter((i) => i.type === "roughOpening").findIndex((r) => r.id === item.id);
          label = `RO-${idx + 1}`;
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
    const winCount = items.filter((i) => i.type === "window").length;
    if (winCount > 0) bullets.push(`Window${winCount > 1 ? "s ×" + winCount : ""}`);
    items.filter((i) => i.type === "workbench").forEach((wb) => bullets.push(`${wb.widthFt}ft Workbench`));
    const loftCount = items.filter((i) => i.type === "loft").length;
    if (loftCount > 0) bullets.push(`Loft${loftCount > 1 ? " ×" + loftCount : ""}`);
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

  // ─── SUBMIT QUOTE ───
  const submitQuote = async () => {
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
    const unplacedIncluded = includedItemKeys.filter((k) => !declinedKeys.includes(k) && !items.some((it) => it.type === k));
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
      // 1. Render the export canvas — wrapped in a single-page letter PDF and uploaded to
      //    Storage. The submit-estimate Edge Function attaches that PDF to the GHL estimate.
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
      const jpegDataUrl = canvas.toDataURL("image/jpeg", 0.92);
      const jpegBin = atob(jpegDataUrl.split(",")[1]);
      const jpegBytes = new Uint8Array(jpegBin.length);
      for (let i = 0; i < jpegBin.length; i++) jpegBytes[i] = jpegBin.charCodeAt(i);
      const blob = buildPdfFromJpegBytes(jpegBytes, canvas.width, canvas.height);
      const { error: upErr } = await supabase.storage
        .from("floor-plans")
        .upload(filePath, blob, { upsert: false, contentType: "application/pdf", cacheControl: "0" });
      if (upErr) throw new Error(`PDF upload failed: ${upErr.message}`);

      const { data: urlData } = supabase.storage.from("floor-plans").getPublicUrl(filePath);
      const imageUrl = urlData.publicUrl;

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
      setDesignCode(shortCode);
      setViewingVersion(null);

      const payload = {
        // New fields — n8n can use these for GHL linking + image embed
        designId: shortCode,
        imageUrl,
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
          // Send roof fields whenever the tenant offers roofs (any shingle/metal color), even if
          // unselected, so the estimate always shows the Roof line in order.
          ...((Array.isArray(C.colors) && C.colors.some((c) => c.shingle || c.metal)) ? { roofType: sel.roofType || "", roofColor: sel.roofColor || "" } : {}),
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
          };
        }),
        itemSummary: {
          singleDoors: items.filter((i) => i.type === "singleDoor").length,
          doubleDoors: items.filter((i) => i.type === "doubleDoor").length,
          windows: items.filter((i) => i.type === "window").length,
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
      // betaMode (detected from the deploy host, e.g. beta.structurestudio.app or a
      // beta--* branch preview) makes the Edge Function redirect the estimate email
      // to the internal QA inbox instead of the customer. The per-client beta_mode
      // switch in client_settings does the same thing server-side.
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
      }
      if (result.estimateNumber) ghlEstimateNumberRef.current = result.estimateNumber;

      setSavedDesign({
        code: shortCode,
        viewUrl,
        imageUrl,
        estimateNumber: result.estimateNumber || null,
        updated: !!result.updated,
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

  // Build a single-page US-Letter PDF that embeds a JPEG of the canvas.
  // Self-contained (no external library): the canvas is letter-shaped already, so
  // the JPEG is stretched to fill the 612×792 pt page (8.5"×11" at 72 DPI).
  const buildPdfFromJpegBytes = (jpegBytes, jpegW, jpegH) => {
    const PT_W = 612, PT_H = 792;
    const enc = new TextEncoder();
    const contentStream = `q ${PT_W} 0 0 ${PT_H} 0 0 cm /Im0 Do Q\n`;
    const contentBytes = enc.encode(contentStream);

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
    pushStr("2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n");

    offsets[3] = totalLen;
    pushStr(`3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PT_W} ${PT_H}] /Resources << /XObject << /Im0 4 0 R >> /ProcSet [/PDF /ImageC] >> /Contents 5 0 R >>\nendobj\n`);

    offsets[4] = totalLen;
    pushStr(`4 0 obj\n<< /Type /XObject /Subtype /Image /Width ${jpegW} /Height ${jpegH} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpegBytes.length} >>\nstream\n`);
    pushBytes(jpegBytes);
    pushStr("\nendstream\nendobj\n");

    offsets[5] = totalLen;
    pushStr(`5 0 obj\n<< /Length ${contentBytes.length} >>\nstream\n`);
    pushBytes(contentBytes);
    pushStr("endstream\nendobj\n");

    const xrefOffset = totalLen;
    let xref = "xref\n0 6\n0000000000 65535 f \n";
    for (let i = 1; i <= 5; i++) xref += String(offsets[i]).padStart(10, "0") + " 00000 n \n";
    pushStr(xref);
    pushStr(`trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`);

    const out = new Uint8Array(totalLen);
    let off = 0;
    for (const c of chunks) { out.set(c, off); off += c.length; }
    return new Blob([out], { type: "application/pdf" });
  };

  const downloadPDF = () => {
    const canvas = renderExportCanvas();
    const dataUrl = canvas.toDataURL("image/jpeg", 0.92);
    const bin = atob(dataUrl.split(",")[1]);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const blob = buildPdfFromJpegBytes(bytes, canvas.width, canvas.height);
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
  return (
    <div ref={gateBgRef} style={{ fontFamily: "'Segoe UI', system-ui, -apple-system, sans-serif", background: "#F8FAFC", minHeight: embedded ? "100%" : "100vh" }}>
      {gateEl && createPortal(gateEl, document.body)}
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

      {/* Configuration Panel */}
      {(
        <div style={{ background: "#FFF", borderBottom: "2px solid #E2E8F0", padding: "14px 20px" }}>
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

          {/* Building Size + Roof Options + Paint — one row; paint sits beside the roof colors. */}
          {(sizeOpts.length > 0 || roofTypes.length > 0 || paintOpt) && (
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
        </div>
      )}

      {unattachedLofts.length > 0 && (
        <div style={{ background: "#FEF3C7", borderBottom: "1px solid #FCD34D", padding: "10px 16px", fontSize: 12, color: "#92400E" }}>
          <div style={{ fontWeight: 700, marginBottom: 4 }}>⚠️ Loft support warning — {unattachedLofts.length} loft{unattachedLofts.length > 1 ? "s" : ""} not properly supported</div>
          <div style={{ fontWeight: 500 }}>Each loft must have <b>both ends</b> of at least one axis (left+right OR top+bottom) resting on a wall or another loft. Adjust position or size to fix.</div>
        </div>
      )}

      {/* Tool Palette */}
      <div style={{ background: "#FFF", borderBottom: "1px solid #E2E8F0", padding: "10px 20px", display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
        {(() => {
          const btn = ([key, cfg]) => (
            <button key={key} onClick={() => { if (gateRequired) { setGateOpen(true); return; } setActiveTool(activeTool === key ? null : key); setSelectedId(null); }}
              style={{
                display: "inline-flex", alignItems: "center", gap: 4, padding: "5px 10px", borderRadius: 7, fontSize: 12, fontWeight: 600, cursor: "pointer", transition: "all 0.15s", position: "relative",
                background: activeTool === key ? cfg.color : "#F8FAFC",
                color: activeTool === key ? "#FFF" : "#334155",
                border: `2px solid ${activeTool === key ? cfg.color : "#E2E8F0"}`,
              }}>
              <span style={{ fontSize: 14, display: "inline-flex", alignItems: "center" }}>{key === "singleDoor" ? <DoorIcon /> : key === "doubleDoor" ? <DoorIcon double /> : cfg.icon}</span>{cfg.label}
              {(cfg.wallOnly || cfg.wallSnap) && <span style={{ fontSize: 9, opacity: 0.7, background: activeTool === key ? "rgba(255,255,255,0.25)" : "#F1F5F9", borderRadius: 3, padding: "1px 4px" }}>wall</span>}
            </button>
          );
          const entries = Object.entries(ITEMS);
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
                const removedIds = new Set(its.filter((it) => it.type === key).map((it) => it.id));
                return its.filter((it) => it.type !== key && !(it.type === "ramp" && removedIds.has(it.snapDoorId)));
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
        <div style={{ marginLeft: "auto", display: "flex", gap: 6 }}>
          {selectedId && (
            <>
              <button onClick={rotSel} style={{ ...S.btn("#EEF2FF", "#4F46E5"), border: "1px solid #C7D2FE" }}>↻ Rotate</button>
              <button onClick={delSel} style={{ ...S.btn("#FEF2F2", "#DC2626"), border: "1px solid #FECACA" }}>✕ Delete</button>
            </>
          )}
          <button onClick={clearAll} style={{ ...S.btn("#F1F5F9", "#64748B"), border: "1px solid #E2E8F0" }}>Clear</button>
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
        const prLbl = (prCfg && prCfg.label) || pendingRemoval.type;
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

      {/* SVG Canvas */}
      <div style={{ display: "flex", justifyContent: "center", padding: "16px 20px", background: "#F1F5F9", cursor: activeTool ? "crosshair" : dragging ? "grabbing" : "default" }}>
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
                      <rect x={-iw / 2} y={-5} width={iw} height={10} fill={cfg.color} rx={1} />
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
                    {item.type === "window" && <g><line x1={0} y1={-4} x2={0} y2={4} stroke="#FFF" strokeWidth={1.5} /><line x1={-iw / 4} y1={-4} x2={-iw / 4} y2={4} stroke="#FFF" strokeWidth={1} /><line x1={iw / 4} y1={-4} x2={iw / 4} y2={4} stroke="#FFF" strokeWidth={1} /></g>}
                    <text x={0} y={(item.wall === "north" || item.wall === "east") ? 14 : -10} textAnchor="middle" fill="#1E293B" fontSize={9} fontWeight="700">{(() => {
                      if (item.type !== "roughOpening") return cfg.shortLabel;
                      const idx = items.filter((i) => i.type === "roughOpening").findIndex((r) => r.id === item.id);
                      return `RO-${idx + 1}`;
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
                      <text x={-iw / 2 + 5} y={4} textAnchor="start" fill={cfg.color} fontSize={9} fontWeight="700">RAMP</text>
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
              Rendered last so the rings (and their click targets) sit above everything else. */}
          {pendingRemoval && items.filter((i) => i.type === pendingRemoval.type).map((it) => {
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
          <div onClick={() => setAdditionalOpen((o) => !o)}
            style={{ display: "flex", alignItems: "center", justifyContent: "space-between", cursor: "pointer", userSelect: "none" }}>
            <span style={{ fontSize: 11, fontWeight: 600, color: "#CBD5E1", letterSpacing: 0.2 }}>Details</span>
            <span style={{ fontSize: 11, color: "#CBD5E1" }}>{additionalOpen ? "▾" : "▸"}</span>
          </div>
          {additionalOpen && (() => {
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
                    <button title={r.method === "each" ? "Remove one from the plan" : "Remove from the plan"}
                      onClick={() => {
                        // "each"-priced items step down one at a time (when several are
                        // placed, the plan asks which one); everything else clears the line
                        // and removes all of that type from the layout.
                        const placed = items.filter((i) => i.type === r.key);
                        if (r.method === "each" && placed.length > 1) {
                          setPendingRemoval({ type: r.key });
                          setSelectedId(null); setActiveTool(null);
                          setTimeout(() => { try { svgRef.current && svgRef.current.scrollIntoView({ behavior: "smooth", block: "center" }); } catch (_) {} }, 0);
                        } else {
                          // Cascade like delSel: removing a door also removes its snapped ramp.
                          const removedIds = new Set(placed.map((i) => i.id));
                          setItems((p) => p.filter((i) => i.type !== r.key && !(i.type === "ramp" && removedIds.has(i.snapDoorId))));
                          setSelectedId(null);
                        }
                      }}
                      style={delBtn}>×</button>
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
                        onChange={(e) => setRoDimensions((p) => ({ ...p, [ro.id]: e.target.value }))}
                        style={{ flex: 1, minWidth: 0, border: `1px solid ${invalid ? "#DC2626" : "#CBD5E1"}`, borderRadius: 6, padding: "6px 8px", fontSize: 12, outline: "none", background: invalid ? "#FEF2F2" : "#FFF" }} />
                      {C.showPricing && (<>
                        <div style={qtyCell}>1</div>
                        <div style={amtCell}>{fmtMoney2(roRate)}</div>
                      </>)}
                      <button title="Remove this rough opening from the plan"
                        onClick={() => { setItems((p) => p.filter((i) => i.id !== ro.id)); setSelectedId(null); }}
                        style={delBtn}>×</button>
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

            {/* Discounts — reduce the estimate total. */}
            {(sel.discounts || []).length > 0 && (
              <div style={{ marginTop: 14 }}>
                {(sel.discounts || []).map((row, idx) => (
                  <div key={idx} style={{ display: "flex", gap: 6, alignItems: "center", marginBottom: 6 }}>
                    <input type="text" value={row.description || ""} placeholder="Discount description"
                      onChange={(e) => setSel((p) => ({ ...p, discounts: (p.discounts || []).map((r, i) => i === idx ? { ...r, description: e.target.value } : r) }))}
                      style={{ flex: 1, minWidth: 0, border: "1px solid #CBD5E1", borderRadius: 6, padding: "6px 8px", fontSize: 12, outline: "none", background: "#FFF", wordBreak: "break-word" }} />
                    <div style={amtInputWrap}>
                      <span style={{ fontSize: 12, color: "#64748B", marginRight: 2, flexShrink: 0, whiteSpace: "nowrap" }}>−$</span>
                      <input type="number" min="0" value={row.amount || ""} placeholder="0.00"
                        onChange={(e) => { const v = e.target.value.replace(/[^0-9.]/g, ""); setSel((p) => ({ ...p, discounts: (p.discounts || []).map((r, i) => i === idx ? { ...r, amount: v } : r) })); }}
                        style={{ flex: 1, minWidth: 0, width: "100%", border: "none", padding: "6px 0", fontSize: 12, outline: "none" }} />
                    </div>
                    <button onClick={() => setSel((p) => ({ ...p, discounts: (p.discounts || []).filter((_, i) => i !== idx) }))} style={delBtn}>×</button>
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
                <div style={amtInputWrap}>
                  <span style={{ fontSize: 12, color: "#64748B", marginRight: 2, flexShrink: 0 }}>$</span>
                  <input type="text" inputMode="decimal" value={sel.deliveryFee || ""} placeholder="0.00"
                    onChange={(e) => { const v = e.target.value.replace(/[^0-9.]/g, ""); setSel((p) => ({ ...p, deliveryFee: v })); }}
                    style={{ flex: 1, minWidth: 0, width: "100%", border: "none", padding: "6px 0", fontSize: 12, outline: "none" }} />
                </div>
                <button title="Remove the delivery fee"
                  onClick={() => { setDeliveryOpen(false); setSel((p) => ({ ...p, deliveryFee: "" })); }}
                  style={delBtn}>×</button>
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
              <button onClick={() => setSel((p) => ({ ...p, discounts: [...(p.discounts || []), { description: "", amount: "" }] }))} style={dashBtn}>+ Add Discount</button>
              {!showDelivery && <button onClick={() => setDeliveryOpen(true)} style={dashBtn}>+ Add Delivery Fee</button>}
            </div>
            <div style={{ fontSize: 10.5, color: "#94A3B8", marginTop: 6 }}>
              Custom options add charges · discounts reduce the estimate total · delivery is added as a non-taxable line.
            </div>
          </div>
            );
          })()}
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
              {hasExistingEstimate
                ? <>Update your selections, then click <strong>Resubmit for Updated Estimate</strong> to refresh and re-send your quote.</>
                : <>Place your options on the layout above, then click <strong>Get Quote</strong> to receive a detailed estimate.</>}
            </p>
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
            {savedDesign && savedDesign.updated ? "Estimate Updated!" : "Quote Request Submitted!"}
          </h3>
          <p style={{ margin: 0, fontSize: 14, color: "#15803D", maxWidth: 460, marginLeft: "auto", marginRight: "auto" }}>
            {savedDesign && savedDesign.updated
              ? `Thank you, ${contact.name || ""}! Your existing estimate has been updated and re-sent by email.`
              : `Thank you, ${contact.name || ""}! We've received your building configuration and layout. A team member will prepare your detailed estimate and reach out shortly.`}
          </p>
          {savedDesign && (
            <div style={{ maxWidth: 520, margin: "20px auto 0", background: "#FFF", border: "1px solid #BBF7D0", borderRadius: 10, padding: 14, textAlign: "left" }}>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 10 }}>
                <span style={{ fontSize: 11, fontWeight: 700, color: "#64748B", textTransform: "uppercase", letterSpacing: "0.06em" }}>Design ID</span>
                <span style={{ fontSize: 16, fontWeight: 800, color: "#1E293B", letterSpacing: "0.05em", fontFamily: "monospace" }}>{savedDesign.code}</span>
              </div>
              {savedDesign.estimateNumber && (
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 10 }}>
                  <span style={{ fontSize: 11, fontWeight: 700, color: "#64748B", textTransform: "uppercase", letterSpacing: "0.06em" }}>Estimate #</span>
                  <span style={{ fontSize: 14, fontWeight: 700, color: "#1E293B", fontFamily: "monospace" }}>EST-{savedDesign.estimateNumber}</span>
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
                ghlContactIdRef.current = null;
                ghlEstimateIdRef.current = null;
                ghlEstimateNumberRef.current = null;
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

// ─── Client-config loader (default export) ───
// Every page load fetches the tenant's config from public.client_configs — there
// is no in-source copy of any client. Resolution order:
//   1. `config` prop (e.g. supplied by index.html's postMessage re-render handler)
//      wins and is used as-is, no fetch.
//   2. `?client=<id>` URL param — explicit override, wins over hostname.
//   3. Subdomain — `juniorbarns.structurestudio.app` → "juniorbarns". Skipped for
//      the apex, IPs, localhost, *.pages.dev / *.netlify.app deploy hosts, and the
//      reserved env labels (www/beta/dev/staging/app).
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

export default function StructureStudio({ config: configProp = null, clientId: clientIdProp = null, embedded = false, onSaved = null }) {
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
    // Tenant subdomains: only derive a client_id from <sub>.structurestudio.app.
    // Anything else (apex, *.pages.dev / *.netlify.app deploy hosts, localhost,
    // IPs, env labels) falls through — a deploy hostname is never a tenant.
    if (!clientId) {
      const host = window.location.hostname;
      const BASE = "structurestudio.app";
      const RESERVED_SUBDOMAINS = ["www", "beta", "dev", "staging", "app"];
      if (host.endsWith("." + BASE)) {
        const sub = host.slice(0, host.length - BASE.length - 1).toLowerCase();
        if (sub && !sub.includes(".") && !RESERVED_SUBDOMAINS.includes(sub)) clientId = sub;
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
      window.location.replace("/portal.html");
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
        setState({ status: "ready", config: { ...cfg, clientId } });
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
      <>
        <div style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", minHeight: embedded ? "40vh" : "100vh", padding: "0 24px", fontFamily: "system-ui, -apple-system, sans-serif", color: "#1E293B", textAlign: "center" }}>
          <div style={{ fontSize: 18, fontWeight: 700, marginBottom: 8 }}>Could not load configuration</div>
          <div style={{ fontSize: 13, color: "#64748B", marginBottom: 4 }}>Client: <code>{state.clientId}</code></div>
          <div style={{ fontSize: 13, color: "#64748B", maxWidth: 480 }}>{state.message}</div>
          <button onClick={() => setState({ status: "loading" })} style={{ marginTop: 20, padding: "8px 16px", background: "#1E293B", color: "#FFF", border: "none", borderRadius: 6, fontSize: 13, cursor: "pointer" }}>Retry</button>
        </div>
        {!embedded && <FeedbackWidget />}
      </>
    );
  }
  return (
    <>
      <DesignerErrorBoundary embedded={embedded}><StructureStudioInner config={state.config} embedded={embedded} onSaved={onSaved} /></DesignerErrorBoundary>
      {!embedded && <FeedbackWidget />}
    </>
  );
}