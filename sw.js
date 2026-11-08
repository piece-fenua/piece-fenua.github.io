// Réseau d'abord (pour toujours avoir la dernière version), cache si hors ligne
const CACHE = "piece-fenua-v8";
const FILES = ["./", "index.html", "style.css", "app.js", "backend.js", "config.js", "data.js", "icons.js",
  "confidentialite.html", "offres.html", "i18n.js", "lang/ty.js", "manifest.json", "assets/logo.svg", "assets/honu.svg", "assets/vaa.svg", "assets/icon-192.png", "assets/icon-512.png"];

self.addEventListener("install", e => e.waitUntil(caches.open(CACHE).then(c => c.addAll(FILES))));
self.addEventListener("activate", e => e.waitUntil(
  caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))));
self.addEventListener("fetch", e => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.origin !== location.origin) return; // Supabase : jamais en cache
  e.respondWith(
    fetch(e.request)
      .then(r => { const copy = r.clone(); caches.open(CACHE).then(c => c.put(e.request, copy)); return r; })
      .catch(() => caches.match(e.request))
  );
});
