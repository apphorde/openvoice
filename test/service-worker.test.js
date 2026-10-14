import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";

test("service worker never serves a cached app shell for offline navigations", async () => {
  const source = await readFile(new URL("../public/sw.js", import.meta.url), "utf8");
  const listeners = new Map();
  const entries = new Map([["session-voice-v5", new Set(["/"])]]);
  let cacheFallbacks = 0;
  const caches = {
    open: async (name) => ({
      addAll: async (urls) => entries.set(name, new Set(urls)),
    }),
    keys: async () => [...entries.keys()],
    delete: async (name) => entries.delete(name),
    match: async (request) => {
      cacheFallbacks += 1;
      const path = new URL(request.url).pathname;
      return [...entries.values()].some((urls) => urls.has(path)) ? `cached:${path}` : undefined;
    },
  };

  runInNewContext(source, {
    self: {
      addEventListener: (name, listener) => listeners.set(name, listener),
      clients: { claim: async () => {} },
    },
    caches,
    location: { origin: "https://openvoice.example" },
    URL,
    fetch: async () => {
      throw new Error("offline");
    },
  });

  let installPromise;
  listeners.get("install")({ waitUntil: (promise) => (installPromise = promise) });
  await installPromise;
  assert.equal(entries.get("session-voice-v6").has("/"), false);

  let activatePromise;
  listeners.get("activate")({ waitUntil: (promise) => (activatePromise = promise) });
  await activatePromise;
  assert.equal(entries.has("session-voice-v5"), false);

  let navigationResponse;
  listeners.get("fetch")({
    request: { method: "GET", mode: "navigate", url: "https://openvoice.example/" },
    respondWith: (promise) => (navigationResponse = promise),
  });
  await assert.rejects(navigationResponse, /offline/);
  assert.equal(cacheFallbacks, 0);
});
