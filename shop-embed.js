/* StructureStudio Online Shop — website embed (2026-10-17).
 *
 *   <div data-ss-shop="your-builder-id"></div>
 *   <script src="https://app.structurestudiosuite.com/shop-embed.js" async></script>
 *
 * Replaces each placeholder with an iframe of the builder's shop (shop.html?embed=1) that grows
 * to its content, so the host page scrolls and the frame never does. Shop events (views,
 * delivery checks, inquiries) are re-pushed into the HOST page's dataLayer, so the builder's
 * own Google Tag Manager sees them too. Plain ES5, no dependencies.
 */
(function () {
  "use strict";
  var me = document.currentScript;
  var ORIGIN = (me && me.src) ? me.src.replace(/^(https:\/\/[^/]+).*$/, "$1") : "https://app.structurestudiosuite.com";
  var frames = [];

  function mount(div) {
    if (div.getAttribute("data-ss-mounted")) return;
    var id = String(div.getAttribute("data-ss-shop") || "").trim().toLowerCase();
    if (!/^[a-z0-9-]{1,64}$/.test(id)) return;
    div.setAttribute("data-ss-mounted", "1");
    var unit = "";
    try { unit = new URLSearchParams(location.search).get("ss_unit") || ""; } catch (e) {}
    var f = document.createElement("iframe");
    f.src = ORIGIN + "/shop?client=" + encodeURIComponent(id) + "&embed=1" + (/^[0-9a-f-]{36}$/i.test(unit) ? "&unit=" + unit : "");
    f.title = "Buildings for sale";
    f.loading = "lazy";
    f.setAttribute("allow", "clipboard-write");
    f.style.cssText = "width:100%;border:0;display:block;min-height:480px;height:900px;overflow:hidden;";
    f.setAttribute("scrolling", "no");
    div.appendChild(f);
    frames.push(f);
  }

  window.addEventListener("message", function (e) {
    if (e.origin !== ORIGIN || !e.data || e.data.source !== "ss-shop") return;
    var f = null;
    for (var i = 0; i < frames.length; i++) if (frames[i].contentWindow === e.source) f = frames[i];
    if (!f) return;
    if (e.data.type === "height" && typeof e.data.height === "number") {
      f.style.height = Math.max(320, Math.min(20000, Math.ceil(e.data.height))) + "px";
    } else if (e.data.type === "scrollTop") {
      try { f.scrollIntoView({ behavior: "smooth", block: "start" }); } catch (err) {}
    } else if (e.data.type === "event" && typeof e.data.event === "string" && /^ss_[a-z_]{1,40}$/.test(e.data.event)) {
      window.dataLayer = window.dataLayer || [];
      var payload = { event: e.data.event };
      var d = e.data.data || {};
      for (var k in d) if (Object.prototype.hasOwnProperty.call(d, k)) payload[k] = d[k];
      window.dataLayer.push(payload);
    }
  });

  function scan() {
    var list = document.querySelectorAll("[data-ss-shop]");
    for (var i = 0; i < list.length; i++) mount(list[i]);
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", scan);
  else scan();
})();
