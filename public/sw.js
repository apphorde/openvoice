const CACHE = "session-voice-v1";
self.addEventListener("install", (e) =>
  e.waitUntil(
    caches
      .open(CACHE)
      .then((c) =>
        c.addAll(["/", "/style.css", "/app.js", "/manifest.json", "/icon.svg"]),
      ),
  ),
);
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));
self.addEventListener("fetch", (e) => {
  if (
    e.request.method === "GET" &&
    new URL(e.request.url).origin === location.origin
  ) {
    e.respondWith(fetch(e.request).catch(() => caches.match(e.request)));
  }
});
