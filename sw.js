// StructureStudio PWA service worker.
//
// Deliberately MINIMAL: it exists to make the portal installable and to show a
// friendly offline page when a navigation fails. It does NOT cache app assets —
// this site deploys straight from the beta branch and must always serve the
// freshest build, so every request except the offline fallback passes straight
// through to the network. If you add caching later, never cache portal.html /
// index.html or the deploy-on-push model silently breaks.
//
// NOTE: offline.html is cached once at install. If you edit offline.html, bump
// the CACHE version below (v1 -> v2) so browsers re-fetch it.
const CACHE = "ss-pwa-v1";
const OFFLINE_URL = "/offline.html";

self.addEventListener("install", (e) => {
  e.waitUntil(
    caches.open(CACHE).then((c) => c.addAll([OFFLINE_URL])).then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (e) => {
  // Only page navigations get the offline fallback; everything else (API calls,
  // scripts, images) is untouched so failures surface to the app as normal.
  if (e.request.mode !== "navigate") return;
  e.respondWith(fetch(e.request).catch(() => caches.match(OFFLINE_URL)));
});
