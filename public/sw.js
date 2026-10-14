const CACHE = "session-voice-v5";
self.addEventListener("install", (e) =>
  e.waitUntil(
    caches
      .open(CACHE)
      .then((c) => c.addAll(["/", "/app.css", "/app.bundle.js", "/li3-config.js", "/manifest.json", "/icon.svg"])),
  ),
);
self.addEventListener("activate", (e) =>
  e.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  ),
);
self.addEventListener("fetch", (e) => {
  if (e.request.method === "GET" && new URL(e.request.url).origin === location.origin) {
    e.respondWith(fetch(e.request).catch(() => caches.match(e.request)));
  }
});
