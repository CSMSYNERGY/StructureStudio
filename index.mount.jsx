// ── Thin mount. The full designer body lives in structure-studio.component.js — the ONE
// shared module loaded by BOTH this page and portal.html. The hand-mirrored pair is now
// StructureStudio.jsx ↔ structure-studio.component.js (this file carries no component code).
// Served origin required: Babel FETCHES the src sibling, so file:// opens are CORS-blocked
// — sanity-check via a local server (python -m http.server), never by double-clicking.
const StructureStudio = window.StructureStudio;
const ssAllowedOrigin = window.ssAllowedOrigin;

// Supabase coordinates for the error logger below — duplicated from the module on
// purpose (Babel blocks don't share top-level consts; the anon key is browser-safe).
const SUPABASE_URL = "https://jzeamjbhdrsbygdnphbm.supabase.co";
const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imp6ZWFtamJoZHJzYnlnZG5waGJtIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzczNDIwNDMsImV4cCI6MjA5MjkxODA0M30.YawJS7aiyTbQdwVnzndyKwD2ejNGYhdBSiectURvxwY";

// ── Central error logging → Supabase app_errors (via the log_error RPC). Best-effort:
// never throws, never blocks the app. Auto-captures uncaught errors + unhandled promise
// rejections; the component also reports submit/render failures via window.ssLogError. ──
const SS_ERR_SOURCE = "designer";
function ssLogError(source, message, code, context) {
  try {
    const params = new URLSearchParams(location.search);
    fetch(SUPABASE_URL + "/rest/v1/rpc/log_error", {
      method: "POST", keepalive: true,
      headers: { "Content-Type": "application/json", "apikey": SUPABASE_ANON_KEY, "Authorization": "Bearer " + SUPABASE_ANON_KEY },
      body: JSON.stringify({
        p_source: String(source || SS_ERR_SOURCE).slice(0, 100),
        p_message: String(message == null ? "" : (message.message || message)).slice(0, 4000),
        p_code: code == null ? null : String(code).slice(0, 100),
        p_client_id: window.__SS_CLIENT_ID__ || params.get("client") || null,
        p_url: location.href.slice(0, 600),
        p_context: context || null,
      }),
    }).catch(() => {});
  } catch (_) { /* logging must never break the app */ }
}
window.ssLogError = ssLogError;
window.addEventListener("error", (e) => ssLogError(SS_ERR_SOURCE, (e && e.message) || "window.onerror", e && e.error && e.error.name,
  { stack: e && e.error && e.error.stack ? String(e.error.stack).slice(0, 2000) : null, file: e && e.filename, line: e && e.lineno }));
window.addEventListener("unhandledrejection", (e) => { const r = e && e.reason; ssLogError(SS_ERR_SOURCE, (r && r.message) || String(r), r && r.name,
  { stack: r && r.stack ? String(r.stack).slice(0, 2000) : null }); });

// The shared module is the ONE dependency the boot guard cannot check for us. Babel fetches
// src'd text/babel files by XHR AFTER the guard has run, so when
// structure-studio.component.js does not load, all four library globals are present, the
// guard stays correctly silent, and `StructureStudio` here is undefined. Rendering undefined
// throws React error #130 ("element type is invalid") and leaves a PERMANENTLY BLANK page:
// that is what GOOGLEBOT got on 2026-08-06 while crawling a tenant's shopfront (app_errors
// 96ce38ff). So check before rendering, and reuse the guard's own failure screen.
//
// A falsy read here means the module block never executed AT ALL — it cannot mean a partial
// or still-in-flight load. The module declares `function StructureStudio(…)` at top level,
// which publishes itself onto window the instant the block starts running, before any of its
// own statements. Verified all four ways it can fail: a 404'd module (falsy, caught here), a
// module that throws mid-run (truthy via that hoisting — renders the config-error screen, a
// different and already-reported bug), and one whose explicit publish line was deleted
// (truthy, renders perfectly). So this can never fire on a page that was going to work.
if (!StructureStudio) {
  // ssBootFail is the guard's renderer; the ?? branch is for the case where even the guard
  // was lost, which must still not be silent.
  if (window.ssBootFail) window.ssBootFail(["structure-studio.component.compiled.js"], "boot_component_missing");
  else {
    document.getElementById("root").textContent = "Couldn't load the designer. Please reload the page.";
    ssLogError("boot", "boot aborted: the shared component module did not load (structure-studio.component.compiled.js), and the boot guard was absent", "boot_component_missing", { app: "designer", missing: ["structure-studio.component.compiled.js"] });
  }
} else {
  const root=ReactDOM.createRoot(document.getElementById("root"));
  root.render(<StructureStudio/>);
  // Host-supplied config remount (embedding API). Origin-gated, config required, and
  // reuses the single root above (creating a new root per message leaked one each time).
  window.addEventListener("message",(e)=>{if(ssAllowedOrigin(e.origin)&&e.data&&e.data.type==="structureConfig"&&e.data.config){root.render(<StructureStudio config={e.data.config}/>);}});
}

// The boot guard's DOMContentLoaded check reads this sentinel: a compiled app
// script that ran to completion is the definition of "the app booted". Without
// it, a 404'd or syntax-broken app artifact was a silent blank page - the one
// failure class the old inline-babel world could not even see.
window.__ssAppBooted = true;
