import { useState, useRef, useCallback, useEffect, useMemo } from "react";
import { createClient } from "@supabase/supabase-js";

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
  const m = s.match(/(\d+)\s*x\s*(\d+)/i);
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
function StructureStudioInner({ config }) {
  const C = config;
  const ITEMS = { ...C.layoutItems, ...BUILT_IN_TOOLS };
  const accent = C.branding.accentColor || "#D97706";
  // Admin gate: ?admin=1 surfaces the GHL credentials panel. The credentials never
  // round-trip through the browser — admin types them in, the Edge Function stores
  // them in Supabase, and customers' browsers never see them.
  const isAdmin = useMemo(() => {
    if (typeof window === "undefined") return false;
    return new URLSearchParams(window.location.search).get("admin") === "1";
  }, []);

  const [sel, setSel] = useState(() => {
    const init = { style: "", size: "" };
    C.options.forEach((o) => { init[o.id] = o.type === "counter" ? o.options[0] : ""; });
    return init;
  });

  // Options the user currently sees. Options without scoping are always in the
  // list; scoped options join/leave as the user picks/changes building style.
  const visibleOptions = useMemo(
    () => C.options.filter((o) => isOptionApplicable(o, sel.style)),
    [C.options, sel.style]
  );

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

  const [contact, setContact] = useState({ name: "", phone: "", email: "", street: "", city: "", state: "", zip: "" });
  const [paintColors, setPaintColors] = useState({ body: "", trim: "" });
  const [customOptions, setCustomOptions] = useState([]);
  const [roDimensions, setRoDimensions] = useState({});
  const [bldgW, setShedW] = useState(10);
  const [bldgH, setShedH] = useState(12);
  const [activeTool, setActiveTool] = useState(null);
  const [items, setItems] = useState([]);
  const [selectedId, setSelectedId] = useState(null);
  const [dragging, setDragging] = useState(null);
  const [resizing, setResizing] = useState(null);
  const [showExport, setShowExport] = useState(false);
  const [exportUrl, setExportUrl] = useState(null);
  const [configOpen, setConfigOpen] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [submitError, setSubmitError] = useState(null);
  // After a successful save, holds { code, viewUrl, imageUrl } for the success screen
  const [savedDesign, setSavedDesign] = useState(null);
  const [toast, setToast] = useState(null);
  const svgRef = useRef(null);
  // After a drag or resize gesture ends, the trailing click on the SVG
  // would otherwise re-run the hit test and deselect the item if the cursor
  // ended outside its bounds. This ref signals "ignore the click that follows".
  const justGesturedRef = useRef(false);

  // PostMessage listener
  useEffect(() => {
    const handler = (e) => {
      if (e.data && e.data.type === "structureConfig") {
        const d = e.data;
        setSel((p) => { const n = { ...p }; Object.keys(d).forEach((k) => { if (k !== "type" && k in n) n[k] = d[k]; }); return n; });
        if (d.name || d.phone || d.email) {
          setContact((p) => ({ ...p, name: d.name || p.name, phone: d.phone || p.phone, email: d.email || p.email, street: d.street || p.street, city: d.city || p.city, state: d.state || p.state, zip: d.zip || p.zip }));
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
      // Hydrate GHL refs so a re-submit becomes an update of the same estimate.
      ghlContactIdRef.current = data.ghl_contact_id || null;
      ghlEstimateIdRef.current = data.ghl_estimate_id || null;
      ghlEstimateNumberRef.current = data.ghl_estimate_number || null;
      setHasExistingEstimate(!!data.ghl_estimate_id);
      setContact(data.contact || { name: "", email: "", phone: "", street: "", city: "", state: "", zip: "" });
      setSel(data.selections || {});
      setPaintColors(data.paint_colors || { body: "", trim: "" });
      setCustomOptions(data.custom_options || []);
      setRoDimensions(data.ro_dimensions || {});
      // Items must be set after sel.size has propagated; the prevSizeRef guard
      // above keeps the size effect from wiping them.
      setItems(Array.isArray(data.items) ? data.items : []);
    })();
    return () => { cancelled = true; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [supabase]);

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

  // Get sizes for selected style
  const selectedStyle = C.buildingStyles.find((s) => s.value === sel.style);
  const sizeOpts = selectedStyle ? selectedStyle.sizes : (C.defaultSizes || []);
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
    // The SVG preserves aspect ratio, so the same scale factor applies to both
    // axes. Use the X ratio for both — using cH on Y was wrong because the
    // viewBox is cropped to TEXT_BAND_TOP, not the full page height.
    const sx = cW / r.width;
    return { x: (cx - r.left) * sx, y: (cy - r.top) * sx };
  }, [cW]);

  const handleClick = useCallback((e) => {
    if (dragging) return;
    // Swallow the click that fires immediately after a drag/resize gesture —
    // otherwise the hit test below would deselect items the user just resized.
    if (justGesturedRef.current) {
      justGesturedRef.current = false;
      return;
    }
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
        const rot = it.rotation === 90; const hw = (rot ? ih : iw) / 2; const hh = (rot ? iw : ih) / 2;
        return Math.abs(pt.x - it.x) < hw + 5 && Math.abs(pt.y - it.y) < hh + 5;
      });
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
      setSelectedId(ni.id);   // auto-select so the editor banner appears
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
  }, [activeTool, dragging, getSvgPt, items, mgX, mgY, pW, pH, scale, ITEMS]);

  const onPtrDown = useCallback((e, item) => {
    e.stopPropagation(); if (activeTool) return;
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
  }, [activeTool, getSvgPt, resizing, ITEMS]);

  const startResize = useCallback((e, item, handle) => {
    e.preventDefault();
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
    if (resizing) {
      const pt = getSvgPt(e);
      const it = items.find((i) => i.id === resizing.id);
      if (!it) return;

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
      setItems((p) => p.map((i) => i.id === dragging.id ? { ...i, ...sn } : i));
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
    setDragging(null);
    setResizing(null);
    // Mark this gesture so the trailing click doesn't deselect the item.
    justGesturedRef.current = true;
  }, []);

  useEffect(() => {
    if (dragging || resizing) {
      window.addEventListener("mousemove", onPtrMove); window.addEventListener("mouseup", onPtrUp);
      window.addEventListener("touchmove", onPtrMove, { passive: false }); window.addEventListener("touchend", onPtrUp);
      return () => { window.removeEventListener("mousemove", onPtrMove); window.removeEventListener("mouseup", onPtrUp); window.removeEventListener("touchmove", onPtrMove); window.removeEventListener("touchend", onPtrUp); };
    }
  }, [dragging, resizing, onPtrMove, onPtrUp]);

  const delSel = () => { if (selectedId) { setItems((p) => p.filter((i) => i.id !== selectedId)); setSelectedId(null); } };
  const rotSel = () => { if (!selectedId) return; setItems((p) => p.map((i) => { if (i.id !== selectedId) return i; const c = ITEMS[i.type]; if (c && (c.wallOnly || c.wallSnap || c.lineType)) return i; return { ...i, rotation: ((i.rotation || 0) + 90) % 360 }; })); };
  const clearAll = () => { setItems([]); setSelectedId(null); };

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
    } else { bullets.push("No Paint"); }
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
      const filePath = `${shortCode}.pdf`;

      // 3. Upload the PDF to the floor-plans bucket (overwrites if it already exists).
      //    Uses the same hand-built JPEG-in-PDF wrapper that downloadPDF uses.
      const jpegDataUrl = canvas.toDataURL("image/jpeg", 0.92);
      const jpegBin = atob(jpegDataUrl.split(",")[1]);
      const jpegBytes = new Uint8Array(jpegBin.length);
      for (let i = 0; i < jpegBin.length; i++) jpegBytes[i] = jpegBin.charCodeAt(i);
      const blob = buildPdfFromJpegBytes(jpegBytes, canvas.width, canvas.height);
      const { error: upErr } = await supabase.storage
        .from("floor-plans")
        .upload(filePath, blob, { upsert: true, contentType: "application/pdf", cacheControl: "0" });
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
      const shareParams = new URLSearchParams();
      const tenantParam = new URLSearchParams(window.location.search).get("client");
      if (tenantParam) shareParams.set("client", tenantParam);
      shareParams.set("id", shortCode);
      const viewUrl = `${window.location.origin}${window.location.pathname}?${shareParams.toString()}`;
      window.history.replaceState({}, "", `?${shareParams.toString()}`);
      currentDesignIdRef.current = shortCode;

      const payload = {
        // New fields — n8n can use these for GHL linking + image embed
        designId: shortCode,
        imageUrl,
        viewUrl,
        source: "StructureStudio",
        clientId: C.clientId,
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
          ramp: items.filter((i) => i.type === "ramp").length > 0 ? "yes" : "no",
          lines: items.filter((i) => i.type === "line").length,
          notes: items.filter((i) => i.type === "textNote").map((n) => (n.text || "").trim()).filter(Boolean),
        },
        customOptions: customOptions.filter((co) => co.name && co.name.trim()).map((co) => ({
          name: co.name.trim(),
          qty: co.qty ? parseInt(co.qty) || 0 : 0,
          amount: co.amount ? parseFloat(co.amount) || 0 : 0,
        })),
        roughOpenings: items.filter((i) => i.type === "roughOpening").map((ro, idx) => ({
          name: `RO-${idx + 1}`,
          dimensions: (roDimensions[ro.id] || "").trim(),
          qty: 1,
          amount: 100,
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
      if (fnErr) throw new Error(fnErr.message || "Submit failed");
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
    } catch (err) {
      setSubmitError(err.message || "Something went wrong submitting your quote. Please try again.");
      console.error("Submit error:", err);
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
      const isPaint = opt.id === "paint";
      const isPainted = isPaint && sel[opt.id] === "Painted";
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
            <div style={{ display: "flex", gap: 6, flexWrap: hasImage ? "wrap" : "nowrap", flex: 1, alignItems: "center", maxWidth: hasImage ? "calc(100% - 110px)" : undefined }}>
              {opt.options.map((o) => (
                <div key={o} onClick={() => { setSel((p) => ({ ...p, [opt.id]: o })); if (isPaint && o === "No Paint") setPaintColors({ body: "", trim: "" }); }} style={{ ...S.pill(sel[opt.id] === o), flexShrink: 0 }}>{o}</div>
              ))}
              {isPainted && (
                <>
                  <label style={{ display: "flex", alignItems: "center", gap: 4, flex: 1, fontSize: 12, fontWeight: 600, color: "#475569", minWidth: 0 }}>
                    Body:
                    <input type="text" value={paintColors.body} onChange={(e) => setPaintColors((p) => ({ ...p, body: e.target.value }))}
                      placeholder="Enter color or TBD"
                      style={{ flex: 1, minWidth: 0, border: "1px solid #CBD5E1", borderRadius: 6, padding: "5px 8px", fontSize: 12, outline: "none" }} />
                  </label>
                  <label style={{ display: "flex", alignItems: "center", gap: 4, flex: 1, fontSize: 12, fontWeight: 600, color: "#475569", minWidth: 0 }}>
                    Trim:
                    <input type="text" value={paintColors.trim} onChange={(e) => setPaintColors((p) => ({ ...p, trim: e.target.value }))}
                      placeholder="Enter color or TBD"
                      style={{ flex: 1, minWidth: 0, border: "1px solid #CBD5E1", borderRadius: 6, padding: "5px 8px", fontSize: 12, outline: "none" }} />
                  </label>
                </>
              )}
            </div>
          </div>
        </div>
      );
    }
    return null;
  };

  // ─── RENDER ───
  return (
    <div style={{ fontFamily: "'Segoe UI', system-ui, -apple-system, sans-serif", background: "#F8FAFC", minHeight: "100vh" }}>
      {/* Header */}
      <div style={{ background: C.branding.headerBg || "linear-gradient(135deg, #1E293B 0%, #334155 100%)", color: "#FFF", padding: "14px 20px", display: "flex", alignItems: "center", gap: 12 }}>
        <div style={{ width: 34, height: 34, background: accent, borderRadius: 8, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 15, fontWeight: 800, flexShrink: 0, letterSpacing: "-0.05em", color: "#FFF" }}>SS</div>
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 17, fontWeight: 700, letterSpacing: "-0.02em" }}>StructureStudio</div>
          <div style={{ fontSize: 11, color: "#94A3B8", marginTop: 1 }}>{C.branding.companyName} — {C.branding.tagline || "Design & Quote"}</div>
        </div>
        <button onClick={() => setConfigOpen(!configOpen)} style={{ ...S.btn(configOpen ? "#FFF" : "rgba(255,255,255,0.15)", configOpen ? "#1E293B" : "#FFF"), border: "1px solid rgba(255,255,255,0.25)" }}>
          {configOpen ? "▴ Hide" : "▾ Show"} Options
        </button>
      </div>

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
            <input type="password" value={adminPwd} onChange={(e) => setAdminPwd(e.target.value)} placeholder="Admin password" style={{ ...S.sel, width: "100%", boxSizing: "border-box" }} />
            <input type="text" value={adminLocId} onChange={(e) => setAdminLocId(e.target.value)} placeholder="GHL Location ID" style={{ ...S.sel, width: "100%", boxSizing: "border-box" }} />
            <input type="password" value={adminApiKey} onChange={(e) => setAdminApiKey(e.target.value)} placeholder="GHL API Key (pit-…)" style={{ ...S.sel, width: "100%", boxSizing: "border-box" }} />
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
      {configOpen && (
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

          {/* Building Size */}
          {sizeOpts.length > 0 && (
            <div style={{ marginBottom: 14 }}>
              <span style={{ ...S.lbl, display: "block", marginBottom: 8 }}>Building Size</span>
              <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                {sizeOpts.map((s) => <div key={s} onClick={() => setSel((p) => ({ ...p, size: s }))} style={S.pill(sel.size === s)}>{s}</div>)}
              </div>
            </div>
          )}

          {/* Dynamic Options (filtered by selected building style — see isOptionApplicable) */}
          {visibleOptions.map((opt) => renderOption(opt))}

          {/* Custom/Additional Options */}
          <div style={{ marginTop: 6 }}>
            <div style={{ ...S.lbl, marginBottom: 8 }}>Additional Options</div>
            {customOptions.map((row, idx) => {
              const invalid = !row.name || !row.name.trim();
              return (
                <div key={idx} style={{ display: "flex", gap: 6, alignItems: "flex-start", marginBottom: 6 }}>
                  <input type="text" value={row.name} placeholder="Item name (required)"
                    onChange={(e) => setCustomOptions((p) => p.map((r, i) => i === idx ? { ...r, name: e.target.value } : r))}
                    style={{ flex: "1 1 55%", minWidth: 0, border: `1px solid ${invalid ? "#DC2626" : "#CBD5E1"}`, borderRadius: 6, padding: "6px 8px", fontSize: 12, outline: "none", background: invalid ? "#FEF2F2" : "#FFF", wordBreak: "break-word" }} />
                  <input type="number" value={row.qty} placeholder="Qty"
                    onChange={(e) => setCustomOptions((p) => p.map((r, i) => i === idx ? { ...r, qty: e.target.value } : r))}
                    style={{ width: 50, border: "1px solid #CBD5E1", borderRadius: 6, padding: "6px 6px", fontSize: 12, outline: "none", textAlign: "center" }} />
                  <div style={{ display: "flex", alignItems: "center", border: "1px solid #CBD5E1", borderRadius: 6, padding: "0 6px", background: "#FFF", width: 85 }}>
                    <span style={{ fontSize: 12, color: "#64748B", marginRight: 2 }}>$</span>
                    <input type="number" value={row.amount} placeholder="0.00"
                      onChange={(e) => setCustomOptions((p) => p.map((r, i) => i === idx ? { ...r, amount: e.target.value } : r))}
                      style={{ width: "100%", border: "none", padding: "6px 0", fontSize: 12, outline: "none" }} />
                  </div>
                  <button onClick={() => setCustomOptions((p) => p.filter((_, i) => i !== idx))}
                    style={{ background: "#FEF2F2", color: "#DC2626", border: "1px solid #FECACA", borderRadius: 6, width: 28, height: 30, cursor: "pointer", fontSize: 14, fontWeight: 700, flexShrink: 0 }}>×</button>
                </div>
              );
            })}
            <button onClick={() => setCustomOptions((p) => [...p, { name: "", qty: "", amount: "" }])}
              style={{ background: "#F1F5F9", color: "#334155", border: "1px dashed #94A3B8", borderRadius: 6, padding: "6px 12px", fontSize: 12, fontWeight: 600, cursor: "pointer" }}>
              + Add Custom Option
            </button>
          </div>

          {items.filter((i) => i.type === "roughOpening").length > 0 && (
            <div style={{ marginTop: 14 }}>
              <div style={{ ...S.lbl, marginBottom: 8 }}>Rough Openings ($100 each)</div>
              {items.filter((i) => i.type === "roughOpening").map((ro, idx) => {
                const dim = roDimensions[ro.id] || "";
                const invalid = !dim.trim();
                return (
                  <div key={ro.id} style={{ display: "flex", gap: 6, alignItems: "center", marginBottom: 6 }}>
                    <span style={{ flex: "0 0 auto", fontSize: 12, fontWeight: 700, color: "#334155", minWidth: 60 }}>RO-{idx + 1}</span>
                    <input type="text" value={dim} placeholder='e.g. 3 x 6 or 29⅞ × 34½"'
                      onChange={(e) => setRoDimensions((p) => ({ ...p, [ro.id]: e.target.value }))}
                      style={{ flex: 1, minWidth: 0, border: `1px solid ${invalid ? "#DC2626" : "#CBD5E1"}`, borderRadius: 6, padding: "6px 8px", fontSize: 12, outline: "none", background: invalid ? "#FEF2F2" : "#FFF" }} />
                    <span style={{ fontSize: 12, color: "#64748B", fontWeight: 600 }}>$100</span>
                  </div>
                );
              })}
            </div>
          )}
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
        <span style={{ ...S.lbl, marginRight: 4, fontSize: 10 }}>Place:</span>
        {Object.entries(ITEMS).map(([key, cfg]) => (
            <button key={key} onClick={() => { setActiveTool(activeTool === key ? null : key); setSelectedId(null); }}
              style={{
                display: "inline-flex", alignItems: "center", gap: 4, padding: "5px 10px", borderRadius: 7, fontSize: 12, fontWeight: 600, cursor: "pointer", transition: "all 0.15s", position: "relative",
                background: activeTool === key ? cfg.color : "#F8FAFC",
                color: activeTool === key ? "#FFF" : "#334155",
                border: `2px solid ${activeTool === key ? cfg.color : "#E2E8F0"}`,
              }}>
              <span style={{ fontSize: 14 }}>{cfg.icon}</span>{cfg.label}
              {(cfg.wallOnly || cfg.wallSnap) && <span style={{ fontSize: 9, opacity: 0.7, background: activeTool === key ? "rgba(255,255,255,0.25)" : "#F1F5F9", borderRadius: 3, padding: "1px 4px" }}>wall</span>}
            </button>
        ))}
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

      {/* Inline editor — appears when a Text Note is selected */}
      {(() => {
        const sel = selectedId ? items.find((i) => i.id === selectedId) : null;
        if (!sel || sel.type !== "textNote") return null;
        return (
          <div style={{ background: "#FFFBEB", borderBottom: "1px solid #FDE68A", padding: "10px 20px", display: "flex", gap: 10, alignItems: "center" }}>
            <span style={{ ...S.lbl, fontSize: 11 }}>Note text:</span>
            <input
              type="text"
              autoFocus
              value={sel.text || ""}
              placeholder="Type your note..."
              onChange={(e) => {
                const v = e.target.value;
                setItems((p) => p.map((i) => i.id === sel.id ? { ...i, text: v } : i));
              }}
              style={{ flex: 1, border: "1px solid #FCD34D", borderRadius: 6, padding: "7px 10px", fontSize: 13, outline: "none", background: "#FFF" }}
            />
            <button onClick={delSel} style={{ ...S.btn("#FEF2F2", "#DC2626"), border: "1px solid #FECACA" }}>✕ Delete</button>
          </div>
        );
      })()}

      {/* SVG Canvas */}
      <div style={{ display: "flex", justifyContent: "center", padding: "16px 20px", background: "#F1F5F9", cursor: activeTool ? "crosshair" : dragging ? "grabbing" : "default" }}>
        <svg ref={svgRef} viewBox={`0 0 ${cW} ${TEXT_BAND_TOP}`}
          style={{ width: "100%", maxWidth: cW, height: "auto", background: "#FFF", borderRadius: 12, boxShadow: "0 4px 24px rgba(0,0,0,0.08)", border: "1px solid #E2E8F0", userSelect: "none" }}
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

            // ─── Text Note: resizable box with text that flows inside ───
            if (cfg.noteType) {
              const w = item.widthPx || 160;
              const h = item.heightPx || 40;
              return (
                <g key={item.id} transform={`translate(${item.x},${item.y})`}
                  onMouseDown={(e) => onPtrDown(e, item)} onTouchStart={(e) => onPtrDown(e, item)}
                  style={{ cursor: activeTool ? "crosshair" : "grab" }}>
                  {isSel && <rect x={-w / 2 - 4} y={-h / 2 - 4} width={w + 8} height={h + 8} fill="none" stroke="#3B82F6" strokeWidth={2} strokeDasharray="4 2" rx={6} />}
                  {/* Background pill */}
                  <rect x={-w / 2} y={-h / 2} width={w} height={h} fill="#FFFBEB" stroke={cfg.color} strokeWidth={1.25} rx={4} />
                  {/* HTML inside SVG — gives us native word-wrap */}
                  <foreignObject x={-w / 2} y={-h / 2} width={w} height={h}>
                    <div xmlns="http://www.w3.org/1999/xhtml" style={{
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
                  </foreignObject>
                  {/* Bottom-right corner resize handle (shown when selected) */}
                  {isSel && (
                    <>
                      {/* Larger transparent click zone for forgiving grab */}
                      <rect x={w / 2 - 14} y={h / 2 - 14} width={28} height={28}
                        fill="transparent" style={{ cursor: "nwse-resize" }}
                        onMouseDown={(e) => { e.stopPropagation(); startResize(e, item, "br"); }}
                        onTouchStart={(e) => { e.stopPropagation(); startResize(e, item, "br"); }} />
                      {/* Visible handle */}
                      <rect x={w / 2 - 7} y={h / 2 - 7} width={14} height={14}
                        fill="#3B82F6" stroke="#FFF" strokeWidth={1.5} rx={2} pointerEvents="none" />
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
            if (!ri || ri.type === "line") return null; // line shows its own length label inline
            return (
              <g transform={`translate(${ri.x},${ri.y - 28})`}>
                <rect x={-30} y={-12} width={60} height={24} rx={6} fill="#1E293B" />
                <text x={0} y={4} textAnchor="middle" fill="#FFF" fontSize={13} fontWeight="700">{Math.round(ri.widthFt * 10) / 10} ft</text>
              </g>
            );
          })()}
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
              <div style={{ display: "flex", gap: 6, marginBottom: 6, alignItems: "center" }}>
                <span style={{ fontSize: 11, color: "#64748B", flex: "0 0 auto", minWidth: 70 }}>View / edit:</span>
                <input readOnly value={savedDesign.viewUrl}
                  style={{ flex: 1, fontSize: 11, padding: "5px 8px", border: "1px solid #E2E8F0", borderRadius: 5, background: "#F8FAFC", fontFamily: "monospace", outline: "none" }}
                  onClick={(e) => e.target.select()} />
                <button onClick={() => { navigator.clipboard.writeText(savedDesign.viewUrl).catch(() => {}); }}
                  style={{ ...S.btn("#F1F5F9", "#334155"), border: "1px solid #E2E8F0", padding: "4px 10px", fontSize: 11 }}>📋</button>
              </div>
              <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
                <span style={{ fontSize: 11, color: "#64748B", flex: "0 0 auto", minWidth: 70 }}>Image PNG:</span>
                <input readOnly value={savedDesign.imageUrl}
                  style={{ flex: 1, fontSize: 11, padding: "5px 8px", border: "1px solid #E2E8F0", borderRadius: 5, background: "#F8FAFC", fontFamily: "monospace", outline: "none" }}
                  onClick={(e) => e.target.select()} />
                <button onClick={() => { navigator.clipboard.writeText(savedDesign.imageUrl).catch(() => {}); }}
                  style={{ ...S.btn("#F1F5F9", "#334155"), border: "1px solid #E2E8F0", padding: "4px 10px", fontSize: 11 }}>📋</button>
              </div>
            </div>
          )}
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
              window.history.replaceState({}, "", window.location.pathname);
            }}
            style={{ ...S.btn("#166534", "#FFF"), marginTop: 20, padding: "10px 24px", fontSize: 14 }}
          >
            Start New Quote
          </button>
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
              <h3 style={{ margin: 0, fontSize: 18, fontWeight: 700, color: "#1E293B" }}>StructureStudio Export</h3>
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

// Cutover marker: lets us verify from the deployed site which data path this
// bundle uses (multi-tenant RPC vs. legacy direct table access).
console.log("[StructureStudio] multi-tenant build: config-loader + RPC data path");

export default function StructureStudio({ config: configProp = null }) {
  // state shape: { status: "ready", config } | { status: "loading" } | { status: "error", clientId, message }
  const [state, setState] = useState(() => (
    configProp ? { status: "ready", config: configProp } : { status: "loading" }
  ));

  useEffect(() => {
    if (state.status !== "loading") return;
    if (typeof window === "undefined") return;
    const params = new URLSearchParams(window.location.search);
    let clientId = params.get("client");
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
        const { data, error } = await sb
          .from("client_configs")
          .select("config")
          .eq("client_id", clientId)
          .maybeSingle();
        if (cancelled) return;
        if (error || !data || !data.config) {
          console.warn(`Could not load config for client "${clientId}":`, error);
          setState({ status: "error", clientId, message: (error && error.message) || "Configuration not found." });
          return;
        }
        const missing = REQUIRED_CONFIG_KEYS.filter((k) => !data.config[k]);
        if (missing.length > 0) {
          setState({ status: "error", clientId, message: `Configuration row is incomplete (missing: ${missing.join(", ")}).` });
          return;
        }
        setState({ status: "ready", config: { ...data.config, clientId } });
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
      <div style={{ display: "flex", alignItems: "center", justifyContent: "center", minHeight: "100vh", fontFamily: "system-ui, -apple-system, sans-serif", color: "#64748B", fontSize: 14 }}>
        Loading…
      </div>
    );
  }
  if (state.status === "error") {
    return (
      <div style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", minHeight: "100vh", padding: "0 24px", fontFamily: "system-ui, -apple-system, sans-serif", color: "#1E293B", textAlign: "center" }}>
        <div style={{ fontSize: 18, fontWeight: 700, marginBottom: 8 }}>Could not load configuration</div>
        <div style={{ fontSize: 13, color: "#64748B", marginBottom: 4 }}>Client: <code>{state.clientId}</code></div>
        <div style={{ fontSize: 13, color: "#64748B", maxWidth: 480 }}>{state.message}</div>
        <button onClick={() => setState({ status: "loading" })} style={{ marginTop: 20, padding: "8px 16px", background: "#1E293B", color: "#FFF", border: "none", borderRadius: 6, fontSize: 13, cursor: "pointer" }}>Retry</button>
      </div>
    );
  }
  return <StructureStudioInner config={state.config} />;
}