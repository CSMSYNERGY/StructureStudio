/* StructureStudio website lead form — embed (migration 325, 2026-10-22).
 *
 *   <div data-ss-form="your-builder-id/FORM-ID"></div>
 *   <script src="https://app.structurestudiosuite.com/form-embed.js" async></script>
 *
 * Replaces each placeholder with an iframe of the form (form.html?embed=1) that grows to its content,
 * so the host page scrolls and the frame never does. The host page's address and its utm_/gclid/fbclid
 * parameters ride into the frame, so a submission records where it came from. Form events
 * (ss_form_view, ss_form_start, ss_form_submit) are re-pushed into the HOST page's dataLayer, so the
 * builder's own Google Tag Manager can count conversions. Plain ES5, no dependencies.
 * A near-copy of shop-embed.js on purpose.
 */
(function () {
  "use strict";
  var me = document.currentScript;
  var ORIGIN = (me && me.src) ? me.src.replace(/^(https:\/\/[^/]+).*$/, "$1") : "https://app.structurestudiosuite.com";
  var frames = [];

  function mount(div) {
    if (div.getAttribute("data-ss-mounted")) return;
    var spec = String(div.getAttribute("data-ss-form") || "").trim();
    var m = /^([a-z0-9-]{1,64})\/([0-9a-f-]{36})$/i.exec(spec);
    if (!m) return;
    div.setAttribute("data-ss-mounted", "1");
    var extra = "";
    try {
      var p = new URLSearchParams(location.search);
      ["utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content", "gclid", "fbclid"].forEach(function (k) {
        var v = p.get(k); if (v) extra += "&" + k + "=" + encodeURIComponent(v.slice(0, 200));
      });
    } catch (e) {}
    var f = document.createElement("iframe");
    f.src = ORIGIN + "/form?client=" + encodeURIComponent(m[1].toLowerCase()) + "&id=" + m[2] + "&embed=1&page=" + encodeURIComponent(location.href.slice(0, 500)) + extra;
    f.title = "Contact form";
    f.loading = "lazy";
    f.style.cssText = "width:100%;border:0;display:block;min-height:320px;height:640px;overflow:hidden;background:transparent;";
    f.setAttribute("scrolling", "no");
    div.appendChild(f);
    frames.push(f);
  }

  window.addEventListener("message", function (e) {
    if (e.origin !== ORIGIN || !e.data || e.data.source !== "ss-form") return;
    var f = null;
    for (var i = 0; i < frames.length; i++) if (frames[i].contentWindow === e.source) f = frames[i];
    if (!f) return;
    if (e.data.type === "height" && typeof e.data.height === "number") {
      f.style.height = Math.max(200, Math.min(20000, Math.ceil(e.data.height))) + "px";
    } else if (e.data.type === "scrollTop") {
      // After a submit the form becomes a short thank-you: bring it into view.
      try { f.scrollIntoView({ behavior: "smooth", block: "start" }); } catch (err) {}
    } else if (e.data.type === "event" && typeof e.data.event === "string" && /^ss_form_[a-z_]{1,30}$/.test(e.data.event)) {
      window.dataLayer = window.dataLayer || [];
      var payload = { event: e.data.event };
      var d = e.data.data || {};
      for (var k in d) if (Object.prototype.hasOwnProperty.call(d, k) && typeof d[k] === "string") payload[k] = d[k].slice(0, 200);
      window.dataLayer.push(payload);
    }
  });

  function scan() {
    var list = document.querySelectorAll("[data-ss-form]");
    for (var i = 0; i < list.length; i++) mount(list[i]);
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", scan);
  else scan();
})();
