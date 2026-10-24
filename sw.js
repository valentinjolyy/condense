/* Service worker : l'app s'ouvre instantanément, même hors connexion. */
const VERSION = "condense-v2";
const SHELL = ["./", "index.html", "app.css", "app.js", "manifest.webmanifest", "icons/icon-192.png", "icons/apple-touch-icon.png"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== VERSION).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET") return;
  // Données et code : réseau d'abord (toujours frais), cache en secours
  if (url.origin === location.origin) {
    e.respondWith(
      fetch(e.request).then((r) => {
        if (r.ok) {
          const copy = r.clone();
          const key = url.pathname.includes("/data/") ? new Request(url.origin + url.pathname) : e.request;
          caches.open(VERSION).then((c) => c.put(key, copy));
        }
        return r;
      }).catch(() => caches.match(url.pathname.includes("/data/") ? new Request(url.origin + url.pathname) : e.request))
    );
    return;
  }
  // Polices Google : cache d'abord
  if (url.hostname.endsWith("gstatic.com") || url.hostname.endsWith("googleapis.com")) {
    e.respondWith(caches.match(e.request).then((m) => m || fetch(e.request).then((r) => {
      const copy = r.clone(); caches.open(VERSION).then((c) => c.put(e.request, copy)); return r;
    })));
  }
});
