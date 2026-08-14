// GENERATED FILE — do not edit. Compiled from index.mount.jsx (sha256 74c9f8af51a4)
// by scripts/compile.mjs using vendored babel-standalone 7.23.9. Rebuild: npm run compile
;(function () {
if (window.__ssBootBlocked) return; // the boot guard neutralises compiled scripts via this flag
"use strict";

// ── Thin mount for index.html. The full designer body lives in
// structure-studio.component.js — the ONE shared module loaded (compiled) by BOTH this
// page and portal.html. The hand-mirrored pair is StructureStudio.jsx ↔
// structure-studio.component.js; THIS file compiles to index.mount.compiled.js via
// `npm run compile` (scripts/compile.mjs) — edit here, never the artifact.
var StructureStudio = window.StructureStudio;
var ssAllowedOrigin = window.ssAllowedOrigin;

// Supabase coordinates for the error logger below — duplicated from the module on
// purpose (each compiled artifact is an isolated scope; the anon key is browser-safe).
var SUPABASE_URL = "https://jzeamjbhdrsbygdnphbm.supabase.co";
var SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imp6ZWFtamJoZHJzYnlnZG5waGJtIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzczNDIwNDMsImV4cCI6MjA5MjkxODA0M30.YawJS7aiyTbQdwVnzndyKwD2ejNGYhdBSiectURvxwY";

// ── Central error logging → Supabase app_errors (via the log_error RPC). Best-effort:
// never throws, never blocks the app. Auto-captures uncaught errors + unhandled promise
// rejections; the component also reports submit/render failures via window.ssLogError. ──
var SS_ERR_SOURCE = "designer";
function ssLogError(source, message, code, context) {
  try {
    var params = new URLSearchParams(location.search);
    fetch(SUPABASE_URL + "/rest/v1/rpc/log_error", {
      method: "POST",
      keepalive: true,
      headers: {
        "Content-Type": "application/json",
        "apikey": SUPABASE_ANON_KEY,
        "Authorization": "Bearer " + SUPABASE_ANON_KEY
      },
      body: JSON.stringify({
        p_source: String(source || SS_ERR_SOURCE).slice(0, 100),
        p_message: String(message == null ? "" : message.message || message).slice(0, 4000),
        p_code: code == null ? null : String(code).slice(0, 100),
        p_client_id: window.__SS_CLIENT_ID__ || params.get("client") || null,
        p_url: location.href.slice(0, 600),
        p_context: context || null
      })
    })["catch"](function () {});
  } catch (_) {/* logging must never break the app */}
}
window.ssLogError = ssLogError;
window.addEventListener("error", function (e) {
  return ssLogError(SS_ERR_SOURCE, e && e.message || "window.onerror", e && e.error && e.error.name, {
    stack: e && e.error && e.error.stack ? String(e.error.stack).slice(0, 2000) : null,
    file: e && e.filename,
    line: e && e.lineno
  });
});
window.addEventListener("unhandledrejection", function (e) {
  var r = e && e.reason;
  ssLogError(SS_ERR_SOURCE, r && r.message || String(r), r && r.name, {
    stack: r && r.stack ? String(r.stack).slice(0, 2000) : null
  });
});

// The shared module is the ONE dependency the boot guard cannot check itself. Its compiled
// artifact loads with `defer` ahead of this one, so when it does not load (404, or served
// as HTML by a bad route) `StructureStudio` here is undefined. Rendering undefined throws
// React error #130 ("element type is invalid") and leaves a PERMANENTLY BLANK page: that
// is what GOOGLEBOT got on 2026-08-06 while crawling a tenant's shopfront (app_errors
// 96ce38ff). So check before rendering, and reuse the guard's own failure screen.
//
// A falsy read here means the module artifact did not run to its publish line. Under the
// compiled wrapper (an isolated function scope) the ONLY publish is the explicit
// `window.StructureStudio = …` at the module's end — so a module that throws MID-RUN now
// also lands here (boot_component_missing) instead of half-publishing via hoisting and
// rendering the config-error screen, which is stricter and better-reported than before.
if (!StructureStudio) {
  // ssBootFail is the guard's renderer; the ?? branch is for the case where even the guard
  // was lost, which must still not be silent.
  if (window.ssBootFail) window.ssBootFail(["structure-studio.component.compiled.js"], "boot_component_missing");else {
    document.getElementById("root").textContent = "Couldn't load the designer. Please reload the page.";
    ssLogError("boot", "boot aborted: the shared component module did not load (structure-studio.component.compiled.js), and the boot guard was absent", "boot_component_missing", {
      app: "designer",
      missing: ["structure-studio.component.compiled.js"]
    });
  }
} else {
  var root = ReactDOM.createRoot(document.getElementById("root"));
  root.render( /*#__PURE__*/React.createElement(StructureStudio, null));
  // Host-supplied config remount (embedding API). Origin-gated, config required, and
  // reuses the single root above (creating a new root per message leaked one each time).
  window.addEventListener("message", function (e) {
    if (ssAllowedOrigin(e.origin) && e.data && e.data.type === "structureConfig" && e.data.config) {
      root.render( /*#__PURE__*/React.createElement(StructureStudio, {
        config: e.data.config
      }));
    }
  });
}

// The boot guard's DOMContentLoaded check reads this sentinel: a compiled app
// script that ran to completion is the definition of "the app booted". Without
// it, a 404'd or syntax-broken app artifact was a silent blank page - the one
// failure class the old inline-babel world could not even see.
window.__ssAppBooted = true;
}).call(window);
