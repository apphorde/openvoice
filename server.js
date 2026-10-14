import http from "node:http";
import { readFile, mkdir, rename, writeFile } from "node:fs/promises";
import { extname, resolve, sep } from "node:path";
import { randomBytes, createHash, createPublicKey, verify as verifySignature } from "node:crypto";
import { fileURLToPath } from "node:url";
import { rootSessions, latestExcerpt, messageText, messageRole } from "./src/utils.js";
import { isSubjectAllowed } from "./src/auth-policy.js";

const dir = fileURLToPath(new URL(".", import.meta.url));
const host = process.env.HOST || "127.0.0.1";
const port = Number(process.env.PORT || 4173);
const loopback = ["127.0.0.1", "::1", "localhost"].includes(host);
const issuer = (process.env.OIDC_ISSUER || "").replace(/\/$/, "");
const clientId = process.env.OIDC_CLIENT_ID;
const clientSecret = process.env.OIDC_CLIENT_SECRET;
const appUrl = (process.env.APP_URL || `http://127.0.0.1:${port}`).replace(/\/$/, "");
if (!loopback && (!issuer || !clientId || !clientSecret || !appUrl.startsWith("https://"))) {
  throw new Error("External binding requires OIDC credentials and an HTTPS APP_URL");
}
const authEnabled = Boolean(issuer && clientId && clientSecret);
const allowedSubs = (process.env.OIDC_ALLOWED_SUBS || "")
  .split(",")
  .map((sub) => sub.trim())
  .filter(Boolean);
const opencode = (process.env.OPENCODE_URL || "http://127.0.0.1:4096").replace(/\/$/, "");
const password = process.env.OPENCODE_SERVER_PASSWORD || process.env.OPENCODE_PASSWORD;
const remoteAuth = password
  ? `Basic ${Buffer.from(`${process.env.OPENCODE_SERVER_USERNAME || "opencode"}:${password}`).toString("base64")}`
  : "";
const dataFile = resolve(process.env.DATA_FILE || resolve(dir, "data/goals.json"));
const identities = new Map();
const rootIds = new Set();
const authFlows = new Map();
const ttsLimits = new Map();
let snapshot = null;
let discovery;
let jwks;

async function api(path, options = {}) {
  const response = await fetch(`${opencode}/api${path}`, {
    ...options,
    signal: AbortSignal.timeout(10000),
    headers: {
      ...(remoteAuth ? { Authorization: remoteAuth } : {}),
      ...(options.body ? { "Content-Type": "application/json" } : {}),
      ...options.headers,
    },
  });
  if (!response.ok) {
    throw new Error(`OpenCode API returned ${response.status}`);
  }
  return response.status === 204 ? null : response.json();
}
function json(res, status, value) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  res.end(JSON.stringify(value));
}
async function body(req, max = 20000) {
  let text = "";
  for await (const chunk of req) {
    text += chunk;
    if (Buffer.byteLength(text) > max) {
      throw Object.assign(new Error("Request too large"), { status: 413 });
    }
  }
  try {
    return JSON.parse(text);
  } catch {
    throw Object.assign(new Error("Invalid JSON"), { status: 400 });
  }
}
async function readAudio(response, maxBytes = 8 * 1024 * 1024) {
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel();
      throw Object.assign(new Error("TTS response too large"), { status: 502 });
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks, size);
}
async function readGoals() {
  try {
    const result = JSON.parse(await readFile(dataFile, "utf8"));
    return Array.isArray(result) ? result : [];
  } catch (error) {
    if (error.code === "ENOENT") {
      return [];
    }
    throw error;
  }
}
async function saveGoals(goals) {
  await mkdir(resolve(dataFile, ".."), { recursive: true });
  const tmp = `${dataFile}.${randomBytes(8).toString("hex")}.tmp`;
  await writeFile(tmp, JSON.stringify(goals, null, 2), { mode: 0o600 });
  await rename(tmp, dataFile);
}
function cookies(req) {
  return Object.fromEntries(
    (req.headers.cookie || "")
      .split(";")
      .map((v) => v.trim().split(/=(.*)/s).slice(0, 2))
      .filter((x) => x.length === 2),
  );
}
function setCookie(res, value, maxAge = 86400) {
  res.setHeader(
    "Set-Cookie",
    `sv_session=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${appUrl.startsWith("https:") ? "; Secure" : ""}`,
  );
}
async function loadIdentity(token) {
  const [h, p, s] = token.split(".");
  const header = JSON.parse(Buffer.from(h, "base64url"));
  const claims = JSON.parse(Buffer.from(p, "base64url"));
  if (header.alg !== "RS256" || !jwks?.keys) {
    throw new Error("Invalid identity token");
  }
  const key = jwks.keys.find((k) => k.kid === header.kid);
  if (
    !key ||
    !verifySignature(
      "RSA-SHA256",
      Buffer.from(`${h}.${p}`),
      createPublicKey({ key, format: "jwk" }),
      Buffer.from(s, "base64url"),
    )
  ) {
    throw new Error("Invalid identity token signature");
  }
  if (
    claims.iss !== issuer ||
    !(claims.aud === clientId || (Array.isArray(claims.aud) && claims.aud.includes(clientId))) ||
    (Array.isArray(claims.aud) && claims.aud.length > 1 && claims.azp !== clientId) ||
    claims.exp <= Date.now() / 1000 ||
    !claims.sub
  ) {
    throw new Error("Invalid identity token claims");
  }
  return {
    sub: claims.sub,
    name: claims.name || claims.preferred_username || claims.email || "User",
  };
}
async function refresh() {
  try {
    const roots = [];
    let cursor;
    do {
      const query = new URLSearchParams({
        limit: "100",
        order: "desc",
        parentID: "null",
      });
      if (cursor) {
        query.set("cursor", cursor);
      }
      const page = await api(`/session?${query.toString()}`);
      roots.push(...rootSessions(page));
      cursor = page.cursor?.next || undefined;
    } while (cursor && roots.length < 1000);
    const active = await api("/session/active").catch(() => ({ data: {} }));
    const result = await Promise.all(
      roots.map(async (s) => {
        const messages = await api(`/session/${encodeURIComponent(s.id)}/message?limit=1&order=desc`).catch(() => ({
          data: [],
        }));
        const last = (messages.data || messages).at(0);
        return {
          id: s.id,
          title: s.title || "Untitled session",
          directory: s.location?.directory || s.directory,
          time: s.time?.updated || s.time?.created,
          status: active.data?.[s.id]?.type || "idle",
          latest: latestExcerpt(last),
          latestRole: messageRole(last),
        };
      }),
    );
    rootIds.clear();
    result.forEach((s) => rootIds.add(s.id));
    snapshot = {
      sessions: result,
      updatedAt: new Date().toISOString(),
      error: null,
    };
  } catch {
    snapshot = {
      sessions: snapshot?.sessions || [],
      updatedAt: snapshot?.updatedAt || null,
      error: "OpenCode unavailable",
    };
  }
}
async function initOidc() {
  if (!authEnabled) {
    return;
  }
  if (!appUrl.startsWith("https://") && !loopback) {
    throw new Error("OIDC requires HTTPS");
  }
  const r = await fetch(`${issuer}/.well-known/openid-configuration`, {
    signal: AbortSignal.timeout(10000),
  });
  if (!r.ok) {
    throw new Error("OIDC discovery failed");
  }
  discovery = await r.json();
  if (discovery.issuer !== issuer || !discovery.code_challenge_methods_supported?.includes("S256")) {
    throw new Error("Unsupported OIDC provider configuration");
  }
  const keys = await fetch(discovery.jwks_uri, {
    signal: AbortSignal.timeout(10000),
  });
  jwks = await keys.json();
}
const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
    const path = url.pathname;
    if (path === "/healthz" && req.method === "GET") {
      return json(res, 200, { healthy: true });
    }
    if (path === "/signed-out" && req.method === "GET") {
      res.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
        "Content-Security-Policy":
          "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'",
        "X-Content-Type-Options": "nosniff",
      });
      return res.end(
        '<!doctype html><meta charset="utf-8"><title>Signed out</title><p>You are signed out.</p><a href="/auth/login">Sign in again</a>',
      );
    }
    if (path === "/auth/login" && req.method === "GET") {
      if (!authEnabled) {
        return json(res, 503, { error: "OIDC is not configured" });
      }
      const now = Date.now();
      for (const [key, flow] of authFlows) {
        if (now - flow.at > 300000) {
          authFlows.delete(key);
        }
      }
      if (authFlows.size >= 250) {
        return json(res, 429, { error: "Too many pending sign-in attempts" });
      }
      const state = randomBytes(32).toString("base64url"),
        nonce = randomBytes(32).toString("base64url"),
        verifier = randomBytes(48).toString("base64url");
      authFlows.set(state, { nonce, verifier, at: Date.now() });
      const target = new URL(discovery.authorization_endpoint);
      Object.entries({
        client_id: clientId,
        redirect_uri: `${appUrl}/auth/callback`,
        response_type: "code",
        scope: "openid profile email",
        state,
        nonce,
        code_challenge: createHash("sha256").update(verifier).digest("base64url"),
        code_challenge_method: "S256",
      }).forEach(([k, v]) => target.searchParams.set(k, v));
      res.writeHead(302, {
        Location: target.href,
        "Cache-Control": "no-store",
      });
      return res.end();
    }
    if (path === "/auth/callback" && req.method === "GET") {
      const flow = authFlows.get(url.searchParams.get("state"));
      authFlows.delete(url.searchParams.get("state"));
      if (!flow || Date.now() - flow.at > 300000 || url.searchParams.has("error") || !url.searchParams.get("code")) {
        return json(res, 400, { error: "Invalid OIDC callback" });
      }
      const response = await fetch(discovery.token_endpoint, {
        method: "POST",
        signal: AbortSignal.timeout(10000),
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code: url.searchParams.get("code"),
          redirect_uri: `${appUrl}/auth/callback`,
          client_id: clientId,
          client_secret: clientSecret,
          code_verifier: flow.verifier,
        }),
      });
      if (!response.ok) {
        return json(res, 401, { error: "OIDC token exchange failed" });
      }
      const result = await response.json(),
        identity = await loadIdentity(result.id_token);
      const claims = JSON.parse(Buffer.from(result.id_token.split(".")[1], "base64url"));
      if (claims.nonce !== flow.nonce) {
        return json(res, 401, { error: "OIDC nonce mismatch" });
      }
      if (!isSubjectAllowed(identity.sub, allowedSubs)) {
        return json(res, 403, { error: "Access denied" });
      }
      const sid = randomBytes(32).toString("base64url");
      identities.set(`auth:${sid}`, {
        ...identity,
        expiresAt: Math.min(claims.exp * 1000, Date.now() + 8 * 60 * 60 * 1000),
      });
      setCookie(res, sid);
      res.writeHead(302, { Location: "/", "Cache-Control": "no-store" });
      return res.end();
    }
    const sid = cookies(req).sv_session;
    let identity = sid && identities.get(`auth:${sid}`);
    if (identity && identity.expiresAt <= Date.now()) {
      identities.delete(`auth:${sid}`);
      identity = null;
    }
    if (authEnabled && !identity) {
      if (path.startsWith("/api/")) {
        return json(res, 401, { error: "Unauthorized" });
      }
      res.writeHead(302, {
        Location: "/auth/login",
        "Cache-Control": "no-store",
      });
      return res.end();
    }
    if (!authEnabled && !loopback) {
      return json(res, 503, { error: "OIDC is required for network access" });
    }
    if (req.method === "POST" || req.method === "PUT" || req.method === "PATCH" || req.method === "DELETE") {
      const origin = req.headers.origin;
      if (!origin || new URL(origin).origin !== appUrl) {
        return json(res, 403, { error: "Invalid origin" });
      }
    }
    if (path === "/auth/logout" && req.method === "POST") {
      if (sid) {
        identities.delete(`auth:${sid}`);
      }
      setCookie(res, "", 0);
      res.writeHead(303, { Location: "/signed-out" });
      return res.end();
    }
    if (req.method === "GET" && path === "/api/sessions") {
      if (!snapshot) {
        await refresh();
      }
      return json(res, 200, snapshot);
    }
    if (req.method === "POST" && path === "/api/sessions") {
      const input = await body(req);
      if (typeof input.type !== "string" || input.type !== "create") {
        return json(res, 400, { error: "Invalid request type" });
      }
      const created = await api("/session", {
        method: "POST",
        body: JSON.stringify({ title: "New session" }),
      });
      await refresh();
      return json(res, 201, created.data || created);
    }
    const conversationMatch = path.match(/^\/api\/sessions\/([^/]+)\/messages$/);
    if (req.method === "GET" && conversationMatch) {
      const id = decodeURIComponent(conversationMatch[1]);
      if (!rootIds.has(id)) {
        return json(res, 404, { error: "Root session not found" });
      }
      const requestedLimit = Number(url.searchParams.get("limit") || 30);
      const limit = Number.isInteger(requestedLimit) ? Math.max(1, Math.min(50, requestedLimit)) : 30;
      const response = await api(`/session/${encodeURIComponent(id)}/message?limit=${limit}&order=desc`);
      const entries = Array.isArray(response) ? response : Array.isArray(response.data) ? response.data : [];
      const messages = entries
        .filter((message) => ["user", "assistant"].includes(messageRole(message)))
        .map((message) => ({
          id: message.id || message.info?.id,
          role: messageRole(message),
          text: messageText(message).slice(0, 6000),
          time: message.time?.created || message.info?.time?.created,
          completed:
            messageRole(message) === "assistant"
              ? typeof (message.time?.completed ?? message.info?.time?.completed) === "number"
              : undefined,
          finish: messageRole(message) === "assistant" ? message.finish || message.info?.finish : undefined,
        }))
        .filter((message) => message.text);
      return json(res, 200, { messages: messages.reverse() });
    }
    if (req.method === "GET" && path === "/api/auth/status") {
      return json(res, 200, {
        enabled: authEnabled,
        user: identity?.name || null,
      });
    }
    if (req.method === "GET" && path === "/api/goals") {
      return json(res, 200, await readGoals());
    }
    if (req.method === "POST" && path === "/api/goals") {
      const input = await body(req);
      if (typeof input.title !== "string" || !input.title.trim() || input.title.length > 200) {
        return json(res, 400, {
          error: "Title is required (max 200 characters)",
        });
      }
      const goals = await readGoals(),
        goal = {
          id: randomBytes(16).toString("hex"),
          title: input.title.trim(),
          description: typeof input.description === "string" ? input.description.slice(0, 4000) : "",
          status: "open",
          createdAt: new Date().toISOString(),
        };
      goals.push(goal);
      await saveGoals(goals);
      return json(res, 201, goal);
    }
    if (req.method === "POST" && path === "/api/plan/send") {
      const input = await body(req);
      if (
        !Array.isArray(input.sessionIds) ||
        input.sessionIds.length === 0 ||
        input.sessionIds.length > 250 ||
        input.sessionIds.some((id) => typeof id !== "string" || !rootIds.has(id))
      ) {
        return json(res, 400, {
          error: "Select 1–250 discovered root sessions",
        });
      }
      const goals = (await readGoals()).filter((goal) => goal.status !== "done");
      if (goals.length === 0) {
        return json(res, 400, {
          error: "Add an open goal before sending the plan",
        });
      }
      const plan = goals
        .map((goal, index) => `${index + 1}. ${goal.title}${goal.description ? `\n   ${goal.description}` : ""}`)
        .join("\n");
      let next = 0;
      let sent = 0;
      let failed = 0;
      const worker = async () => {
        while (next < input.sessionIds.length) {
          const sessionId = input.sessionIds[next++];
          try {
            await api(`/session/${encodeURIComponent(sessionId)}/prompt`, {
              method: "POST",
              body: JSON.stringify({
                text: `Executive plan update — align work with these shared goals:\n\n${plan}`,
              }),
            });
            sent += 1;
          } catch {
            failed += 1;
          }
        }
      };
      await Promise.all(Array.from({ length: Math.min(5, input.sessionIds.length) }, worker));
      return json(res, failed ? 207 : 202, { sent, failed });
    }
    const goalMatch = path.match(/^\/api\/goals\/([a-f0-9]{32})$/);
    if (goalMatch && req.method === "PATCH") {
      const input = await body(req);
      const goals = await readGoals(),
        goal = goals.find((g) => g.id === goalMatch[1]);
      if (!goal) {
        return json(res, 404, { error: "Goal not found" });
      }
      if (input.status !== undefined && !["open", "in-progress", "done"].includes(input.status)) {
        return json(res, 400, { error: "Invalid status" });
      }
      if (input.status) {
        goal.status = input.status;
      }
      if (
        input.title !== undefined &&
        typeof input.title === "string" &&
        input.title.trim() &&
        input.title.length <= 200
      ) {
        goal.title = input.title.trim();
      }
      await saveGoals(goals);
      return json(res, 200, goal);
    }
    if (goalMatch && req.method === "DELETE") {
      const goals = await readGoals(),
        next = goals.filter((g) => g.id !== goalMatch[1]);
      if (next.length === goals.length) {
        return json(res, 404, { error: "Goal not found" });
      }
      await saveGoals(next);
      return json(res, 200, { deleted: true });
    }
    const sendMatch = path.match(/^\/api\/goals\/([a-f0-9]{32})\/send$/);
    if (sendMatch && req.method === "POST") {
      const input = await body(req);
      const goals = await readGoals(),
        goal = goals.find((g) => g.id === sendMatch[1]);
      if (!goal) {
        return json(res, 404, { error: "Goal not found" });
      }
      if (typeof input.sessionId !== "string" || !rootIds.has(input.sessionId)) {
        return json(res, 400, {
          error: "A discovered root session is required",
        });
      }
      await api(`/session/${encodeURIComponent(input.sessionId)}/prompt`, {
        method: "POST",
        body: JSON.stringify({
          text: `${goal.title}${goal.description ? `\n\n${goal.description}` : ""}`,
        }),
      });
      return json(res, 202, { sent: true });
    }
    const messageMatch = path.match(/^\/api\/sessions\/([^/]+)\/message$/);
    if (messageMatch && req.method === "POST") {
      const id = decodeURIComponent(messageMatch[1]),
        input = await body(req);
      if (!rootIds.has(id)) {
        return json(res, 403, {
          error: "Only discovered root sessions can receive prompts",
        });
      }
      if (typeof input.text !== "string" || !input.text.trim() || input.text.length > 16000) {
        return json(res, 400, {
          error: "Text is required (max 16000 characters)",
        });
      }
      await api(`/session/${encodeURIComponent(id)}/prompt`, {
        method: "POST",
        body: JSON.stringify({ text: input.text.trim() }),
      });
      return json(res, 202, { sent: true });
    }
    if (req.method === "GET" && path === "/api/tts/status") {
      return json(res, 200, { enabled: Boolean(process.env.OPENAI_API_KEY) });
    }
    if (req.method === "POST" && path === "/api/tts") {
      if (!process.env.OPENAI_API_KEY) {
        return json(res, 503, { error: "TTS is not configured" });
      }
      const input = await body(req, 5000);
      if (typeof input.text !== "string" || !input.text.trim() || input.text.length > 1000) {
        return json(res, 400, {
          error: "Text is required (max 1000 characters)",
        });
      }
      const key = identity?.sub || req.socket.remoteAddress || "local";
      const now = Date.now();
      for (const [user, usage] of ttsLimits) {
        if (now - usage.startedAt > 60000 && usage.inFlight === 0) {
          ttsLimits.delete(user);
        }
      }
      const usage = ttsLimits.get(key) || {
        startedAt: now,
        count: 0,
        inFlight: 0,
      };
      if (now - usage.startedAt >= 60000) {
        usage.startedAt = now;
        usage.count = 0;
      }
      if (usage.count >= 30 || usage.inFlight >= 2) {
        return json(res, 429, { error: "TTS rate limit exceeded" });
      }
      usage.count += 1;
      usage.inFlight += 1;
      ttsLimits.set(key, usage);
      try {
        const out = await fetch(process.env.OPENAI_TTS_URL || "https://api.openai.com/v1/audio/speech", {
          method: "POST",
          signal: AbortSignal.timeout(20000),
          headers: {
            Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            model: process.env.TTS_MODEL || "tts-1",
            voice: process.env.TTS_VOICE || "alloy",
            input: input.text,
          }),
        });
        if (!out.ok) {
          return json(res, 502, { error: "TTS provider failed" });
        }
        res.writeHead(200, {
          "Content-Type": "audio/mpeg",
          "Cache-Control": "no-store",
          "X-Content-Type-Options": "nosniff",
        });
        return res.end(await readAudio(out));
      } finally {
        usage.inFlight -= 1;
      }
    }
    if (req.method === "GET") {
      const relative = path === "/" ? "index.html" : decodeURIComponent(path.slice(1));
      const root = resolve(dir, "public"),
        file = resolve(root, relative);
      if (file !== root && !file.startsWith(root + sep)) {
        return json(res, 404, { error: "Not found" });
      }
      try {
        const data = await readFile(file);
        const types = {
          ".html": "text/html",
          ".js": "text/javascript",
          ".css": "text/css",
          ".json": "application/json",
          ".svg": "image/svg+xml",
        };
        res.writeHead(200, {
          "Content-Type": `${types[extname(file)] || "application/octet-stream"}; charset=utf-8`,
          "X-Content-Type-Options": "nosniff",
          "X-Frame-Options": "DENY",
          "Referrer-Policy": "same-origin",
          "Content-Security-Policy":
            "default-src 'self'; script-src 'self' blob:; media-src 'self' blob:; object-src 'none'; base-uri 'self'; frame-ancestors 'none'",
          "Cache-Control": "no-store",
        });
        return res.end(data);
      } catch {
        return json(res, 404, { error: "Not found" });
      }
    }
    json(res, 404, { error: "Not found" });
  } catch (e) {
    json(res, e.status || 502, {
      error: e.status ? e.message : "Request failed",
    });
  }
});
await initOidc();
server.listen(port, host);
refresh();
setInterval(refresh, Math.max(2000, Number(process.env.POLL_INTERVAL_MS || 5000))).unref();
