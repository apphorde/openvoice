import { test, expect } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  page.on("pageerror", (error) => {
    throw error;
  });
});

async function setup(page, options = {}) {
  const sessions = options.sessions || [
    { id: "a", title: "Project A", status: "idle" },
    { id: "b", title: "Project B", status: "idle" },
  ];
  const messages = Object.fromEntries(sessions.map(({ id }) => [id, options.messages?.[id] || []]));
  const goals = [];
  const sent = [];
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.addInitScript(() => {
    window.recognizers = [];
    window.SpeechRecognition = class {
      start() {
        window.recognizers.push(this);
        window.recognition = this;
        this.starts = (this.starts || 0) + 1;
        if (window.autoStart) {
          setTimeout(() => this.onstart?.(), window.autoStart);
        }
      }
      stop() {
        if (window.autoEnd) {
          setTimeout(() => this.onend?.(), window.autoEnd);
        } else {
          this.onend?.();
        }
      }
    };
    window.emitRecognitionStart = (index = window.recognizers.length - 1) => window.recognizers[index]?.onstart?.();
    window.endRecognition = (index = window.recognizers.length - 1) => window.recognizers[index]?.onend?.();
    window.emit = (text, final = true, index = window.recognizers.length - 1) => {
      const results = [Object.assign([{ transcript: text }], { isFinal: final })];
      results.item = (i) => results[i];
      window.recognizers[index]?.onresult?.({ resultIndex: 0, results });
    };
    window.emitSegments = (segments, index = window.recognizers.length - 1) => {
      const results = segments.map(({ text, final = true }) =>
        Object.assign([{ transcript: text }], { isFinal: final }),
      );
      results.item = (i) => results[i];
      window.recognizers[index]?.onresult?.({ resultIndex: 0, results });
    };
    window.emitSnapshot = (segments, resultIndex = 0, index = window.recognizers.length - 1) => {
      const results = segments.map(({ text, final = false }) =>
        Object.assign([{ transcript: text }], { isFinal: final }),
      );
      results.item = (i) => results[i];
      window.recognizers[index]?.onresult?.({ resultIndex, results });
    };
    HTMLMediaElement.prototype.play = function () {
      window.plays = (window.plays || 0) + 1;
      setTimeout(() => this.dispatchEvent(new Event("ended")), 0);
      return Promise.resolve();
    };
  });
  await page.route("**/api/auth/status", (r) => r.fulfill({ json: { user: null } }));
  await page.route("**/api/sessions", async (r) => {
    if (r.request().method() === "POST") {
      const created = { id: `new-${sessions.length}`, title: "New session", status: "idle" };
      sessions.push(created);
      messages[created.id] = [];
      return r.fulfill({ json: { id: created.id } });
    }
    return r.fulfill({ json: { sessions } });
  });
  await page.route("**/api/sessions/*/messages**", (r) => {
    const id = new URL(r.request().url()).pathname.split("/")[3];
    return r.fulfill({ json: { messages: messages[id] || [] } });
  });
  await page.route("**/api/sessions/*/message", async (r) => {
    const id = new URL(r.request().url()).pathname.split("/")[3];
    const text = r.request().postDataJSON().text;
    sent.push({ id, text });
    if (options.onSend) {
      return options.onSend(r, { id, text, messages, sent });
    }
    messages[id].push(
      { id: `u-${sent.length}`, role: "user", text },
      { id: `a-${sent.length}`, role: "assistant", text: "All set", completed: true, finish: "stop" },
    );
    return r.fulfill({ status: 202, json: {} });
  });
  await page.route("**/api/goals", async (r) => {
    if (r.request().method() === "POST") {
      const input = r.request().postDataJSON();
      goals.push({ id: `goal-${goals.length + 1}`, ...input, status: "open" });
      return r.fulfill({ status: 201, json: goals.at(-1) });
    }
    return r.fulfill({ json: goals });
  });
  await page.route("**/api/goals/*", async (r) => {
    const id = new URL(r.request().url()).pathname.split("/").at(-1);
    const goalIndex = goals.findIndex((goal) => goal.id === id);
    if (r.request().method() === "PATCH" && goalIndex >= 0) {
      goals[goalIndex] = { ...goals[goalIndex], ...r.request().postDataJSON() };
      return r.fulfill({ json: goals[goalIndex] });
    }
    if (r.request().method() === "DELETE" && goalIndex >= 0) {
      goals.splice(goalIndex, 1);
      return r.fulfill({ status: 204, body: "" });
    }
    return r.fulfill({ status: 404, json: { error: "Not found" } });
  });
  await page.route("**/api/plan/send", (r) => r.fulfill({ json: { sent: 2, failed: 0 } }));
  await page.route("**/api/tts", async (r) => {
    if (options.onTts) {
      return options.onTts(r);
    }
    return r.fulfill({ status: 200, contentType: "audio/mpeg", body: "audio" });
  });
  await page.goto("/");
  await expect(page.locator("#sessionTitle")).toHaveText(sessions[0].title);
  return { sent, messages, errors, sessions, goals };
}

test("Chrome voice confirmation flow takes two explicit turns and never auto-sends", async ({ page }) => {
  const { sent, errors } = await setup(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("button", { name: "Start hands-free" }).click();
  await expect(page.locator("#voiceStatus")).toHaveAttribute("data-state", "starting");
  const listeningColor = "rgb(117, 149, 255)";
  await expect(page.locator("#voice")).not.toHaveCSS("background-color", listeningColor);
  await page.evaluate(() => window.emitRecognitionStart());
  await expect(page.locator("#voiceStatus")).toHaveAttribute("data-state", "listening");
  await expect(page.locator("#voice")).toHaveCSS("background-color", listeningColor);
  await page.evaluate(() => window.emit("First dictated words"));
  await page.waitForTimeout(2_950);
  await expect(page.locator("#voiceStatus")).toHaveAttribute("data-state", "review");
  await expect(page.locator("#voice")).not.toHaveCSS("background-color", listeningColor);
  await expect(page.locator("#voiceDraft")).toHaveValue("First dictated words");
  await page.waitForTimeout(1500);
  expect(sent).toEqual([]);
  await page.screenshot({ path: "/tmp/opencode/session-voice-mobile.png", fullPage: true });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.screenshot({ path: "/tmp/opencode/session-voice-desktop.png", fullPage: true });
  await page.locator("#voiceDraft").fill("Corrected first turn");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect.poll(() => sent.length).toBe(1);
  await page
    .getByRole("button", { name: "Send", exact: true })
    .click({ timeout: 500 })
    .catch(() => {});
  expect(sent).toHaveLength(1);
  await expect(page.locator("#voiceStatus")).toHaveAttribute("data-state", "starting");
  await page.evaluate(() => window.emitRecognitionStart());
  await expect(page.locator("#voiceStatus")).toHaveAttribute("data-state", "listening");
  await page.evaluate(() => window.emit("Second dictated turn"));
  await page.waitForTimeout(2_900);
  await expect(page.locator("#voiceDraft")).toHaveValue("Second dictated turn");
  expect(sent).toHaveLength(1);
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect.poll(() => sent.length).toBe(2);
  await expect(page.locator("#voiceStatus")).toHaveAttribute("data-state", "starting");
  await page.evaluate(() => window.emitRecognitionStart());
  await expect(page.locator("#voiceStatus")).toHaveAttribute("data-state", "listening");
  expect(sent.map(({ text }) => text)).toEqual(["Corrected first turn", "Second dictated turn"]);
  await page.getByRole("button", { name: "Stop voice" }).click();
  await expect(page.locator("#voiceStatus")).toHaveAttribute("data-state", "off");
  expect(errors).toEqual([]);
});

test("voice-first mode can switch to full conversation and back", async ({ page }) => {
  await setup(page);
  await expect(page.getByRole("heading", { name: "Voice note" })).toBeVisible();
  await expect(page.locator("#conversation")).toBeHidden();
  await page.getByRole("button", { name: "Open chat history" }).click();
  await expect(page.locator("#conversation")).toBeVisible();
  await expect(page.locator("#conversation")).toHaveCSS("display", "flex");
  await expect(page.getByRole("button", { name: "Back to voice note" })).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator("#keyboardInput")).toBeVisible();
  await page.screenshot({ path: "/tmp/opencode/session-voice-chat-mobile.png", fullPage: true });
  await page.getByRole("button", { name: "Back to voice note" }).click();
  await expect(page.locator("#conversation")).toBeHidden();
  await expect(page.getByRole("heading", { name: "Voice note" })).toBeVisible();
});

test("goals are tucked into the session menu but remain available", async ({ page }) => {
  await setup(page);
  await expect(page.locator("#goalsPanel")).toBeHidden();
  await page.getByText("Switch", { exact: true }).click();
  await page.getByText(/Executive goals/).click();
  await expect(page.locator("#goalForm")).toBeVisible();
});

test("Li3 session and goal templates support create, status, delete, and plan actions", async ({ page }) => {
  const { sessions, goals } = await setup(page);
  await page.getByText("Switch", { exact: true }).click();
  await page.getByRole("button", { name: "Start new session" }).click();
  await expect(page.locator("#sessionTitle")).toHaveText("New session");
  await page.getByText("Switch", { exact: true }).click();
  await page.getByText(/Executive goals/).click();
  await page.getByLabel("Goal", { exact: true }).fill("Li3 migration goal");
  await page.getByLabel("Success criteria").fill("Reactive goal management works");
  await page.getByRole("button", { name: "Add goal" }).click();
  await expect(page.getByText("Li3 migration goal — Reactive goal management works")).toBeVisible();
  await page.getByRole("combobox", { name: "Goal status" }).selectOption("in-progress");
  await expect.poll(() => goals[0]?.status).toBe("in-progress");
  await page.getByRole("button", { name: "Delete Li3 migration goal" }).click();
  await expect(page.getByText("Li3 migration goal — Reactive goal management works")).toBeHidden();
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "Send plan to all top-level sessions" }).click();
  await expect(page.locator("#goalNotice")).toHaveText("Sent to 2; 0 failed.");
  expect(sessions).toHaveLength(3);
  expect(goals).toHaveLength(0);
});

test("stop and delayed recognizer events preserve editable review; resume and discard work", async ({ page }) => {
  const { sent } = await setup(page);
  await page.getByRole("button", { name: "Start hands-free" }).click();
  await page.evaluate(() => window.emitRecognitionStart());
  await page.evaluate(() => window.emit("Keep this draft"));
  const stopped = page.evaluate(() => window.recognizers[0].stop());
  await stopped;
  await expect(page.locator("#voiceDraft")).toHaveValue("Keep this draft");
  await page.locator("#voiceDraft").fill("Corrected while stopped");
  await page.getByRole("button", { name: "Stop voice" }).click();
  await expect(page.locator("#voiceDraft")).toHaveValue("Corrected while stopped");
  await page.evaluate(() => window.emit("Late unfinalized event", true, 0));
  await expect(page.locator("#voiceDraft")).toHaveValue("Corrected while stopped");
  await page.getByRole("button", { name: "Resume dictation" }).click();
  await expect(page.locator("#voiceStatus")).toHaveAttribute("data-state", "starting");
  await page.evaluate(() => window.emitRecognitionStart());
  await expect(page.locator("#voiceStatus")).toHaveAttribute("data-state", "listening");
  await page.evaluate(() => window.emitSnapshot([{ text: "Discard this" }]));
  await page.evaluate(() => window.emitSnapshot([{ text: "Discard this now" }]));
  await page.waitForTimeout(2_950);
  await expect(page.locator("#voiceDraft")).toHaveValue("Corrected while stopped Discard this now");
  await page.getByRole("button", { name: "Discard" }).click();
  await expect(page.locator("#voiceDraft")).toBeHidden();
  expect(sent).toEqual([]);
});

test("only onstart turns status green; stale events cannot interrupt recovery and fatal errors pause", async ({
  page,
}) => {
  const { errors } = await setup(page);
  await page.evaluate(() => {
    window.autoStart = 0;
    window.autoEnd = 80;
  });
  await page.getByRole("button", { name: "Start hands-free" }).click();
  await expect(page.locator("#voiceStatus")).toHaveAttribute("data-state", "starting");
  await page.evaluate(() => window.emitRecognitionStart());
  await expect(page.locator("#voiceStatus")).toHaveAttribute("data-state", "listening");
  await page.evaluate(() => window.endRecognition());
  await expect(page.locator("#voiceStatus")).not.toHaveAttribute("data-state", "listening");
  await expect.poll(() => page.evaluate(() => window.recognizers.length)).toBe(2);
  await page.evaluate(() => window.emitRecognitionStart());
  await page.evaluate(() => window.recognizers[0].onerror?.({ error: "network" }));
  await expect(page.locator("#voiceStatus")).toHaveAttribute("data-state", "listening");
  await page.evaluate(() => window.recognizers[1].onerror?.({ error: "network" }));
  await expect(page.locator("#voiceStatus")).toHaveAttribute("data-state", "error");
  await page.waitForTimeout(500);
  expect(await page.evaluate(() => window.recognizers.length)).toBe(2);
  expect(errors).toEqual([]);
});

test("typed fallback sends explicitly and failures retain corrected draft without retry", async ({ page }) => {
  const { sent } = await setup(page, {
    onSend: (route) => route.fulfill({ status: 503, json: { error: "Unavailable" } }),
  });
  await page.getByRole("button", { name: "Open chat history" }).click();
  await page.locator("#prompt").fill("Typed instruction");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect.poll(() => sent.length).toBe(1);
  await expect(page.locator("#voiceStatus")).toHaveAttribute("data-state", "error");
  await expect(page.locator("#voiceDraft")).toHaveValue("Typed instruction");
  await page.waitForTimeout(300);
  expect(sent).toHaveLength(1);
});

test("partial assistant replies are not sent to TTS", async ({ page }) => {
  const { sent, messages } = await setup(page, {
    onSend: async (route, { id, text }) => {
      messages[id].push(
        { id: "partial-user", role: "user", text },
        { id: "partial-assistant", role: "assistant", text: "Still composing", completed: false },
      );
      await route.fulfill({ status: 202, json: {} });
    },
  });
  await page.getByRole("button", { name: "Start hands-free" }).click();
  await page.evaluate(() => window.emitRecognitionStart());
  await page.evaluate(() => window.emit("Ask for partial reply"));
  await page.waitForTimeout(2_900);
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect.poll(() => sent.length).toBe(1);
  await page.waitForTimeout(400);
  expect(await page.evaluate(() => window.plays || 0)).toBe(0);
  expect(sent).toHaveLength(1);
});

test("pending TTS cancellation prevents playback after voice mode stops", async ({ page }) => {
  let releaseTts;
  let ttsRequested = false;
  const { sent } = await setup(page, {
    onTts: (route) =>
      new Promise((resolve) => {
        ttsRequested = true;
        releaseTts = async () => {
          await route.fulfill({ status: 200, contentType: "audio/mpeg", body: "audio" });
          resolve();
        };
      }),
  });
  await page.getByRole("button", { name: "Start hands-free" }).click();
  await page.evaluate(() => window.emitRecognitionStart());
  await page.evaluate(() => window.emit("Ask for a reply"));
  await page.waitForTimeout(2_900);
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect.poll(() => ttsRequested).toBe(true);
  await page.getByRole("button", { name: "Stop voice" }).click();
  await releaseTts();
  await page.waitForTimeout(100);
  expect(await page.evaluate(() => window.plays || 0)).toBe(0);
  expect(sent).toHaveLength(1);
});

test("session switch clears draft and isolates stale events", async ({ page }) => {
  const { sent } = await setup(page);
  await page.getByRole("button", { name: "Start hands-free" }).click();
  await page.evaluate(() => window.emitRecognitionStart());
  await page.evaluate(() => window.emit("Switch must clear me"));
  await page.waitForTimeout(2_900);
  await page.getByText("Switch", { exact: true }).click();
  await page.getByRole("button", { name: /Project B/ }).click();
  await expect(page.locator("#voiceDraft")).toBeHidden();
  await page.evaluate(() => window.emit("Stale result", true, 0));
  await expect(page.locator("#voiceDraft")).toBeHidden();
  expect(sent).toEqual([]);
});

test("a disappeared session never transfers its draft to the replacement", async ({ page }) => {
  const { sent, sessions } = await setup(page);
  await page.getByRole("button", { name: "Start hands-free" }).click();
  await page.evaluate(() => window.emitRecognitionStart());
  await page.evaluate(() => window.emit("Only for project A"));
  await expect(page.locator("#voiceDraft")).toBeVisible();
  sessions.shift();
  await expect(page.locator("#sessionTitle")).toHaveText("Project B");
  await expect(page.locator("#draftPanel")).toBeHidden();
  await expect(page.locator("#voiceDraft")).toHaveValue("");
  await page.evaluate(() => window.emit("Stale words for A", true, 0));
  expect(sent).toEqual([]);
  await expect(page.locator("#voice")).toHaveAttribute("data-state", "off");
});

test("send and TTS delays show non-listening states and disable duplicate confirmation", async ({ page }) => {
  let sendRoute;
  let ttsRoute;
  const { sent, messages } = await setup(page, {
    onSend: (route) => {
      sendRoute = route;
    },
    onTts: (route) => {
      ttsRoute = route;
    },
  });
  await page.getByRole("button", { name: "Start hands-free" }).click();
  await page.evaluate(() => window.emitRecognitionStart());
  await page.evaluate(() => window.emit("Ready to send"));
  await expect(page.locator("#voiceDraft")).toBeVisible();
  await page.locator("#sendDraft").click();
  await expect.poll(() => Boolean(sendRoute)).toBe(true);
  await expect(page.locator("#voice")).toHaveAttribute("data-state", "waiting");
  await expect(page.locator("#sendDraft")).toBeDisabled();
  messages.a.push({ id: "answer", role: "assistant", text: "A complete response", completed: true, finish: "stop" });
  await sendRoute.fulfill({ status: 202, json: {} });
  await expect.poll(() => Boolean(ttsRoute)).toBe(true);
  await expect(page.locator("#voice")).toHaveAttribute("data-state", "speaking");
  expect(sent).toHaveLength(1);
  await ttsRoute.fulfill({ status: 502, json: { error: "Speech unavailable" } });
  await expect(page.locator("#voice")).toHaveAttribute("data-state", "error");
  await expect(page.getByRole("button", { name: "Start hands-free" })).toBeVisible();
});

test("late final results improve the draft before review and edits survive subsequent stop", async ({ page }) => {
  const { sent } = await setup(page);
  await page.getByRole("button", { name: "Start hands-free" }).click();
  await page.evaluate(() => window.emitRecognitionStart());
  await page.evaluate(() => window.emit("unfinal words", false));
  await page.evaluate(() => {
    window.recognition.stop = function () {
      setTimeout(() => window.emit("Final corrected words"), 10);
      setTimeout(() => this.onend?.(), 30);
    };
  });
  await expect(page.locator("#voiceDraft")).toHaveValue("Final corrected words");
  await page.locator("#voiceDraft").fill("My own correction");
  await page.getByRole("button", { name: "Stop voice" }).click();
  await expect(page.locator("#voiceDraft")).toHaveValue("My own correction");
  expect(sent).toEqual([]);
});

test("a final Chrome transcript snapshot replaces its earlier interim revision", async ({ page }) => {
  const { sent } = await setup(page);
  await page.getByRole("button", { name: "Start hands-free" }).click();
  await page.evaluate(() => window.emitRecognitionStart());
  await page.evaluate(() => window.emitSnapshot([{ text: "I want you", final: false }]));
  await expect(page.locator("#transcriptPreview")).toHaveText("I want you");
  await page.evaluate(() => window.emitSnapshot([{ text: "I want you to look", final: false }]));
  await expect(page.locator("#transcriptPreview")).toHaveText("I want you to look");
  await page.evaluate(() => window.emitSnapshot([{ text: "I want you to look at the screenshots", final: true }]));
  await page.waitForTimeout(2_950);
  await expect(page.locator("#voiceDraft")).toHaveValue("I want you to look at the screenshots");
  expect(sent).toEqual([]);
});

test("Li3 bindings run under blob-only script CSP", async ({ page }) => {
  const consoleErrors = [];
  page.on("console", (message) => {
    if (message.type() === "error") {
      consoleErrors.push(message.text());
    }
  });
  const documentResponse = page.waitForResponse((response) => response.request().resourceType() === "document");
  await setup(page);
  const response = await documentResponse;
  const csp = response.headers()["content-security-policy"];
  expect(csp).toContain("script-src 'self' blob:");
  expect(csp).not.toContain("unsafe-eval");
  await expect(page.getByRole("button", { name: "Open chat history" })).toBeVisible();
  await page.getByRole("button", { name: "Open chat history" }).click();
  await expect(page.locator("#conversation")).toBeVisible();
  expect(consoleErrors.filter((message) => /content security policy|unsafe-eval|blob:/i.test(message))).toEqual([]);
  expect(consoleErrors).toEqual([]);
  await page.route("**/csp-eval-probe.js", (route) =>
    route.fulfill({
      contentType: "text/javascript",
      body: 'try { window.evalProbe = Function("return true")(); } catch (error) { window.evalProbe = error.name; }',
    }),
  );
  await page.evaluate(() => {
    window.cspViolations = [];
    document.addEventListener("securitypolicyviolation", (event) => {
      window.cspViolations.push({ directive: event.effectiveDirective, blockedURI: event.blockedURI });
    });
    const inline = document.createElement("script");
    inline.textContent = "window.inlineScriptRan = true";
    document.body.append(inline);
    const evalProbe = document.createElement("script");
    evalProbe.src = "/csp-eval-probe.js";
    document.body.append(evalProbe);
  });
  await expect.poll(() => page.evaluate(() => window.cspViolations.length)).toBeGreaterThanOrEqual(2);
  expect(await page.evaluate(() => window.inlineScriptRan)).toBeUndefined();
  expect(await page.evaluate(() => window.evalProbe)).toBe("EvalError");
  expect(await page.evaluate(() => window.cspViolations)).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ blockedURI: "inline" }),
      expect.objectContaining({ blockedURI: "eval" }),
    ]),
  );
});

test("sanitized Markdown cannot inject active Li3 bindings", async ({ page }) => {
  await setup(page, {
    messages: {
      a: [
        {
          id: "unsafe-markdown",
          role: "assistant",
          text: '<button on-click="window.markdownInjected = true">Click me</button><script>window.markdownInjected = true</script>',
        },
      ],
    },
  });
  await page.getByRole("button", { name: "Open chat history" }).click();
  const conversation = page.locator("#conversation");
  await expect(conversation.locator("article")).toHaveCount(1);
  await expect(conversation.locator("article > div")).toHaveCSS("font-size", "14px");
  await expect(conversation.locator("script, [on-click]")).toHaveCount(0);
  await expect(conversation.getByRole("button", { name: "Click me" })).toHaveCount(1);
  await conversation.getByRole("button", { name: "Click me" }).click();
  expect(await page.evaluate(() => window.markdownInjected)).toBeUndefined();
});

test("cumulative Chrome revisions replace interim text instead of appending it", async ({ page }) => {
  const { sent } = await setup(page);
  await page.getByRole("button", { name: "Start hands-free" }).click();
  await page.evaluate(() => window.emitRecognitionStart());
  for (const phrase of ["this", "this is", "this is an", "this is an example"]) {
    await page.evaluate((text) => window.emitSnapshot([{ text }]), phrase);
    await expect(page.locator("#transcriptPreview")).toHaveText(phrase);
  }
  await page.waitForTimeout(2_950);
  await expect(page.locator("#voiceDraft")).toHaveValue("this is an example");
  expect(sent).toEqual([]);
});

test("cumulative full-text result snapshots append only words not already shown", async ({ page }) => {
  const { sent } = await setup(page);
  await page.getByRole("button", { name: "Start hands-free" }).click();
  await page.evaluate(() => window.emitRecognitionStart());
  for (const phrase of [
    "let's",
    "let's review",
    "let's review the",
    "let's review the overall",
    "let's review the overall navigation",
    "let's review the overall navigation instruction",
    "let's review the overall navigation instruction for",
    "let's review the overall navigation instruction for a while",
  ]) {
    await page.evaluate((text) => window.emitSnapshot([{ text }]), phrase);
    await expect(page.locator("#transcriptPreview")).toHaveText(phrase);
  }
  await page.waitForTimeout(2_950);
  await expect(page.locator("#voiceDraft")).toHaveValue("let's review the overall navigation instruction for a while");
  expect(sent).toEqual([]);
});

test("Chrome incremental result events retain final segments and revise only current interim", async ({ page }) => {
  const { sent } = await setup(page);
  await page.getByRole("button", { name: "Start hands-free" }).click();
  await page.evaluate(() => window.emitRecognitionStart());
  await page.evaluate(() => window.emitSnapshot([{ text: "this", final: true }, { text: "is" }]));
  await expect(page.locator("#transcriptPreview")).toHaveText("this is");
  await page.evaluate(() => window.emitSnapshot([{ text: "this", final: true }, { text: "is an" }], 1));
  await expect(page.locator("#transcriptPreview")).toHaveText("this is an");
  await expect.poll(() => sent.length).toBe(0);
});

test("repeated spoken words in separate Chrome results are preserved", async ({ page }) => {
  const { sent } = await setup(page);
  await page.getByRole("button", { name: "Start hands-free" }).click();
  await page.evaluate(() => window.emitRecognitionStart());
  await page.evaluate(() => window.emitSegments([{ text: "go" }, { text: "go" }]));
  await page.waitForTimeout(2_950);
  await expect(page.locator("#voiceDraft")).toHaveValue("go go");
  expect(sent).toEqual([]);
});

test("a repeated prefix across independent final Chrome segments is preserved", async ({ page }) => {
  await setup(page);
  await page.getByRole("button", { name: "Start hands-free" }).click();
  await page.evaluate(() => window.emitRecognitionStart());
  await page.evaluate(() => window.emitSegments([{ text: "I" }, { text: "I think" }]));
  await page.waitForTimeout(2_950);
  await expect(page.locator("#voiceDraft")).toHaveValue("I I think");
});

test("unchanged polling preserves conversation nodes and a focused session option", async ({ page }) => {
  await setup(page);
  await page.getByText("Switch", { exact: true }).click();
  await page.getByRole("button", { name: /Project B/ }).focus();
  await page.evaluate(() => {
    window.originalOption = document.activeElement;
    window.originalMessage = document.querySelector("#conversation").firstElementChild;
  });
  await page.waitForResponse((r) => new URL(r.url()).pathname.endsWith("/messages"));
  expect(
    await page.evaluate(
      () =>
        document.activeElement === window.originalOption &&
        document.querySelector("#conversation").firstElementChild === window.originalMessage,
    ),
  ).toBe(true);
});

test("a send response arriving after switching sessions cannot clear or speak another session", async ({ page }) => {
  let pending;
  const { sent } = await setup(page, {
    onSend: (route) => {
      pending = route;
    },
  });
  await page.getByRole("button", { name: "Start hands-free" }).click();
  await page.evaluate(() => window.emitRecognitionStart());
  await page.evaluate(() => window.emit("Instruction for A"));
  await expect(page.locator("#voiceDraft")).toBeVisible();
  await page.locator("#sendDraft").click();
  await expect.poll(() => Boolean(pending)).toBe(true);
  await page.getByText("Switch", { exact: true }).click();
  await page.getByRole("button", { name: /Project B/ }).click();
  await page.getByRole("button", { name: "Start hands-free" }).click();
  await page.evaluate(() => window.emitRecognitionStart());
  await page.evaluate(() => window.emit("Private draft for B"));
  await expect(page.locator("#voiceDraft")).toHaveValue("Private draft for B");
  await pending.fulfill({ status: 202, json: {} });
  await page.waitForTimeout(100);
  await expect(page.locator("#voiceDraft")).toHaveValue("Private draft for B");
  expect(sent).toEqual([{ id: "a", text: "Instruction for A" }]);
  expect(await page.evaluate(() => window.plays || 0)).toBe(0);
});
