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
  const messages = Object.fromEntries(sessions.map(({ id }) => [id, []]));
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
    HTMLMediaElement.prototype.play = function () {
      window.plays = (window.plays || 0) + 1;
      setTimeout(() => this.dispatchEvent(new Event("ended")), 0);
      return Promise.resolve();
    };
  });
  await page.route("**/api/auth/status", (r) => r.fulfill({ json: { user: null } }));
  await page.route("**/api/sessions", (r) => r.fulfill({ json: { sessions } }));
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
  await page.route("**/api/goals", (r) => r.fulfill({ json: [] }));
  await page.route("**/api/tts", async (r) => {
    if (options.onTts) {
      return options.onTts(r);
    }
    return r.fulfill({ status: 200, contentType: "audio/mpeg", body: "audio" });
  });
  await page.goto("/");
  await expect(page.locator("#sessionTitle")).toHaveText(sessions[0].title);
  return { sent, messages, errors, sessions };
}

test("Chrome voice confirmation flow takes two explicit turns and never auto-sends", async ({ page }) => {
  const { sent, errors } = await setup(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("button", { name: "Start hands-free" }).click();
  await expect(page.locator("#voiceStatus")).toHaveAttribute("data-state", "starting");
  const listeningColor = "rgb(196, 242, 140)";
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
  await page.evaluate(() => window.emit("Discard this"));
  await page.waitForTimeout(2_900);
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
  await page.getByText("Type instead", { exact: true }).click();
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
