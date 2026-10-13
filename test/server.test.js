import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import http from "node:http";
import { once } from "node:events";

async function listen(server) {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return server.address().port;
}

test("server polls sessions, filters children, and proxies message send", async () => {
  let prompted = null;
  let ttsAuth = null;
  let ttsInput = null;
  const upstream = http.createServer(async (req, res) => {
    res.setHeader("content-type", "application/json");
    if (req.url === "/api/session?limit=100&order=desc&parentID=null") {
      res.end(
        JSON.stringify({
          data: [
            { id: "root-1", title: "Root session", time: { updated: 100 } },
            { id: "child-1", parentID: "root-1", title: "Child" },
          ],
          cursor: { next: null, previous: null },
        }),
      );
    } else if (req.url === "/api/session/active") {
      res.end(JSON.stringify({ data: { "root-1": { type: "running" } } }));
    } else if (req.url === "/api/session/root-1/message?limit=1&order=desc") {
      res.end(
        JSON.stringify({
          data: [
            {
              type: "assistant",
              content: [{ type: "text", text: "Latest work" }],
            },
          ],
          cursor: { next: null, previous: null },
        }),
      );
    } else if (req.url === "/api/session/root-1/prompt") {
      let body = "";
      for await (const chunk of req) {
        body += chunk;
      }
      prompted = JSON.parse(body);
      res.statusCode = 204;
      res.end();
    } else {
      res.statusCode = 404;
      res.end(JSON.stringify({ error: "Not found" }));
    }
  });
  const upstreamPort = await listen(upstream);
  const tts = http.createServer(async (req, res) => {
    ttsAuth = req.headers.authorization;
    let body = "";
    for await (const chunk of req) {
      body += chunk;
    }
    ttsInput = JSON.parse(body).input;
    res.writeHead(200, { "content-type": "audio/mpeg" });
    res.end(Buffer.from("fake-audio"));
  });
  const ttsPort = await listen(tts);
  const childEnv = { ...process.env };
  childEnv.OPENAI_API_KEY = "test-key";
  delete childEnv.OIDC_ISSUER;
  delete childEnv.OIDC_CLIENT_ID;
  delete childEnv.OIDC_CLIENT_SECRET;
  const unused = await new Promise((resolve) => {
    const probe = http.createServer();
    probe.listen(0, "127.0.0.1", () => {
      const port = probe.address().port;
      probe.close(() => resolve(port));
    });
  });
  const child = spawn(process.execPath, ["server.js"], {
    env: {
      ...childEnv,
      HOST: "127.0.0.1",
      PORT: String(unused),
      OPENCODE_URL: `http://127.0.0.1:${upstreamPort}`,
      OPENAI_TTS_URL: `http://127.0.0.1:${ttsPort}/v1/audio/speech`,
      DATA_FILE: `/tmp/opencode/test-goals-${unused}.json`,
    },
    stdio: "ignore",
  });
  try {
    await new Promise((resolve, reject) => {
      const started = Date.now();
      const attempt = async () => {
        try {
          const response = await fetch(
            `http://127.0.0.1:${unused}/api/sessions`,
          );
          if (response.ok) {
            return resolve();
          }
        } catch {}
        if (Date.now() - started > 5000) {
          return reject(new Error("server did not start"));
        }
        setTimeout(attempt, 50);
      };
      attempt();
    });
    const sessionsResponse = await fetch(
      `http://127.0.0.1:${unused}/api/sessions`,
    );
    const data = await sessionsResponse.json();
    assert.equal(data.sessions.length, 1);
    assert.equal(data.sessions[0].latest, "Latest work");
    assert.equal(data.sessions[0].status, "running");
    assert.equal(data.sessions[0].latestRole, "assistant");
    const messageResponse = await fetch(
      `http://127.0.0.1:${unused}/api/sessions/root-1/message`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: `http://127.0.0.1:${unused}`,
        },
        body: JSON.stringify({ text: "  hello  " }),
      },
    );
    assert.equal(messageResponse.status, 202);
    assert.equal(prompted.text, "hello");
    const pageResponse = await fetch(`http://127.0.0.1:${unused}/`);
    assert.equal(pageResponse.status, 200);
    assert.match(
      pageResponse.headers.get("content-security-policy"),
      /media-src 'self' blob:/,
    );
    const badPrompt = await fetch(
      `http://127.0.0.1:${unused}/api/sessions/child-1/message`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: `http://127.0.0.1:${unused}`,
        },
        body: JSON.stringify({ text: "must not reach a child" }),
      },
    );
    assert.equal(badPrompt.status, 403);
    const traversal = await fetch(
      `http://127.0.0.1:${unused}/%2e%2e%2fserver.js`,
    );
    assert.equal(traversal.status, 404);
    const ttsStatus = await fetch(`http://127.0.0.1:${unused}/api/tts/status`);
    assert.deepEqual(await ttsStatus.json(), { enabled: true });
    const audio = await fetch(`http://127.0.0.1:${unused}/api/tts`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: `http://127.0.0.1:${unused}`,
      },
      body: JSON.stringify({ text: "Speak the current plan" }),
    });
    assert.equal(audio.status, 200);
    assert.equal(audio.headers.get("content-type"), "audio/mpeg");
    assert.equal(await audio.text(), "fake-audio");
    assert.equal(ttsAuth, "Bearer test-key");
    assert.equal(ttsInput, "Speak the current plan");
    const createGoal = await fetch(`http://127.0.0.1:${unused}/api/goals`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: `http://127.0.0.1:${unused}`,
      },
      body: JSON.stringify({
        title: "Cloud goal",
        description: "Keep sessions aligned",
      }),
    });
    assert.equal(createGoal.status, 201);
    const goal = await createGoal.json();
    assert.equal(goal.title, "Cloud goal");
    const sendPlan = await fetch(
      `http://127.0.0.1:${unused}/api/goals/${goal.id}/send`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: `http://127.0.0.1:${unused}`,
        },
        body: JSON.stringify({ sessionId: "root-1" }),
      },
    );
    assert.equal(sendPlan.status, 202);
    assert.match(prompted.text, /Cloud goal/);
    assert.match(prompted.text, /Keep sessions aligned/);
    const broadcastPlan = await fetch(
      `http://127.0.0.1:${unused}/api/plan/send`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: `http://127.0.0.1:${unused}`,
        },
        body: JSON.stringify({ sessionIds: ["root-1"] }),
      },
    );
    assert.equal(broadcastPlan.status, 202);
    assert.match(prompted.text, /Executive plan update/);
    const broadcastChild = await fetch(
      `http://127.0.0.1:${unused}/api/plan/send`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: `http://127.0.0.1:${unused}`,
        },
        body: JSON.stringify({ sessionIds: ["child-1"] }),
      },
    );
    assert.equal(broadcastChild.status, 400);
    const updateGoal = await fetch(
      `http://127.0.0.1:${unused}/api/goals/${goal.id}`,
      {
        method: "PATCH",
        headers: {
          "content-type": "application/json",
          origin: `http://127.0.0.1:${unused}`,
        },
        body: JSON.stringify({ status: "in-progress" }),
      },
    );
    assert.equal((await updateGoal.json()).status, "in-progress");
    const removeGoal = await fetch(
      `http://127.0.0.1:${unused}/api/goals/${goal.id}`,
      {
        method: "DELETE",
        headers: { origin: `http://127.0.0.1:${unused}` },
      },
    );
    assert.deepEqual(await removeGoal.json(), { deleted: true });
  } finally {
    child.kill();
    upstream.close();
    tts.close();
  }
});
