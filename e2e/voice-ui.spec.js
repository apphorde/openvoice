import { test, expect } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  page.on("pageerror", (error) => {
    throw error;
  });
});

async function prepareVoiceApp(page, { sessions, onSend, onTts } = {}) {
  const sessionList = sessions || [
    { id: "root-a", title: "Project A", directory: "/a", status: "idle" },
  ];
  const messages = Object.fromEntries(
    sessionList.map((session) => [session.id, []]),
  );
  const sent = [];
  await page.addInitScript(() => {
    HTMLMediaElement.prototype.play = function () {
      window.audioPlays = (window.audioPlays || 0) + 1;
      setTimeout(() => this.dispatchEvent(new Event("ended")), 0);
      return Promise.resolve();
    };
    window.SpeechRecognition = class {
      start() {
        window.activeRecognition = this;
        window.recognitionStarts = (window.recognitionStarts || 0) + 1;
      }
      stop() {
        this.onend?.();
      }
    };
    window.emitVoice = (transcript) => {
      const results = [Object.assign([{ transcript }], { isFinal: true })];
      results.item = (index) => results[index];
      window.activeRecognition?.onresult?.({ resultIndex: 0, results });
    };
  });
  await page.route("**/api/auth/status", (route) =>
    route.fulfill({ json: { enabled: false, user: null } }),
  );
  await page.route("**/api/sessions", (route) =>
    route.fulfill({ json: { sessions: sessionList } }),
  );
  await page.route("**/api/sessions/*/messages**", (route) => {
    const sessionID = new URL(route.request().url()).pathname.split("/")[3];
    return route.fulfill({ json: { messages: messages[sessionID] || [] } });
  });
  await page.route("**/api/sessions/*/message", async (route) => {
    const sessionID = new URL(route.request().url()).pathname.split("/")[3];
    const text = route.request().postDataJSON().text;
    sent.push({ sessionID, text });
    if (onSend) {
      await onSend(route, { sessionID, text, messages });
    } else {
      messages[sessionID].push(
        { id: `user-${sent.length}`, role: "user", text },
        {
          id: `assistant-${sent.length}`,
          role: "assistant",
          text: "Done.",
          completed: true,
          finish: "stop",
        },
      );
      await route.fulfill({ status: 202, json: {} });
    }
  });
  await page.route("**/api/goals", (route) => route.fulfill({ json: [] }));
  await page.route("**/api/tts", async (route) => {
    if (onTts) {
      await onTts(route);
    } else {
      await route.fulfill({
        status: 200,
        contentType: "audio/mpeg",
        body: "audio",
      });
    }
  });
  await page.goto("/");
  return { messages, sent };
}

test("voice-first conversation, session switching, typed fallback, and tucked-away goals", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.addInitScript(() => {
    HTMLMediaElement.prototype.play = function () {
      window.audioPlays = (window.audioPlays || 0) + 1;
      setTimeout(() => this.dispatchEvent(new Event("ended")), 0);
      return Promise.resolve();
    };
  });
  await page.addInitScript(() => {
    window.SpeechRecognition = class {
      start() {
        window.activeRecognition = this;
        window.recognitionStarts = (window.recognitionStarts || 0) + 1;
        if (window.recognitionStarts === 1) {
          const results = [
            Object.assign([{ transcript: "Check deployment status" }], {
              isFinal: true,
            }),
          ];
          results.item = (index) => results[index];
          setTimeout(() => this.onresult?.({ resultIndex: 0, results }), 10);
        }
      }
      stop() {
        this.onend?.();
      }
    };
    window.emitVoice = (transcript) => {
      const results = [Object.assign([{ transcript }], { isFinal: true })];
      results.item = (index) => results[index];
      window.activeRecognition?.onresult?.({ resultIndex: 0, results });
    };
  });
  let sentText;
  let conversationMessages = [
    {
      id: "reply-ui",
      role: "assistant",
      text: "Ready when you are.",
      time: Date.now(),
      completed: true,
      finish: "stop",
    },
  ];
  await page.route("**/api/auth/status", (route) =>
    route.fulfill({ json: { enabled: false, user: null } }),
  );
  await page.route("**/api/sessions", (route) =>
    route.fulfill({
      json: {
        sessions: [
          {
            id: "root-ui",
            title: "Main project",
            directory: "/workspace/main",
            status: "idle",
          },
        ],
      },
    }),
  );
  await page.route("**/api/sessions/root-ui/messages**", (route) =>
    route.fulfill({
      json: {
        messages: conversationMessages,
      },
    }),
  );
  await page.route("**/api/sessions/root-ui/message", async (route) => {
    sentText = route.request().postDataJSON().text;
    if (sentText === "Check deployment status") {
      conversationMessages = [
        ...conversationMessages,
        { id: "user-voice", role: "user", text: sentText },
        {
          id: "assistant-voice",
          role: "assistant",
          text: "Deployment is healthy.",
          completed: true,
          finish: "stop",
        },
      ];
    } else if (sentText === "Check follow-up status") {
      conversationMessages = [
        ...conversationMessages,
        { id: "user-follow-up", role: "user", text: sentText },
        {
          id: "assistant-follow-up",
          role: "assistant",
          text: "The follow-up is clear.",
          completed: true,
          finish: "stop",
        },
      ];
    }
    await route.fulfill({ status: 202, json: {} });
  });
  await page.route("**/api/goals", (route) => route.fulfill({ json: [] }));
  await page.route("**/api/tts", (route) =>
    route.fulfill({
      status: 200,
      contentType: "audio/mpeg",
      body: "mock audio",
    }),
  );

  await page.goto("/");
  await expect(page.locator("#sessionTitle")).toHaveText("Main project");
  await expect(page.getByText("Ready when you are.")).toBeVisible();
  await expect(page.locator("#goalsPanel")).not.toHaveAttribute("open", "");
  await page.getByRole("button", { name: /Start hands-free/ }).click();
  await expect.poll(() => sentText).toBe("Check deployment status");
  await expect(page.getByText("Deployment is healthy.")).toBeVisible();
  await expect
    .poll(() => page.evaluate(() => window.recognitionStarts))
    .toBeGreaterThan(1);
  await expect
    .poll(() => page.evaluate(() => window.audioPlays))
    .toBeGreaterThan(0);
  await page.evaluate(() => window.emitVoice("Check follow-up status"));
  await expect.poll(() => sentText).toBe("Check follow-up status");
  await expect(page.getByText("The follow-up is clear.")).toBeVisible();
  await expect
    .poll(() => page.evaluate(() => window.audioPlays))
    .toBeGreaterThan(1);
  await page.getByRole("button", { name: /Stop listening/ }).click();
  await page.getByText("Type instead", { exact: true }).click();
  await page.getByPlaceholder("Write an instruction…").fill("Please check now");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect.poll(() => sentText).toBe("Please check now");
  await expect(page.locator("#voiceStatus")).toContainText(
    "Waiting for the reply",
  );

  await page.screenshot({
    path: "/tmp/opencode/session-voice-voice-first.png",
    fullPage: true,
  });
});

test("only speaks complete assistant replies, then waits for completion", async ({
  page,
}) => {
  const { messages, sent } = await prepareVoiceApp(page, {
    onSend: async (route, { sessionID, text, messages: allMessages }) => {
      allMessages[sessionID].push(
        { id: "user-partial", role: "user", text },
        {
          id: "assistant-partial",
          role: "assistant",
          text: "Still composing",
          completed: false,
        },
      );
      await route.fulfill({ status: 202, json: {} });
    },
  });
  await page.getByRole("button", { name: /Start hands-free/ }).click();
  await page.evaluate(() => window.emitVoice("Ask for an update"));
  await expect.poll(() => sent.length).toBe(1);
  await expect(page.getByText("Still composing")).toBeVisible();
  await page.waitForTimeout(300);
  expect(await page.evaluate(() => window.audioPlays || 0)).toBe(0);

  messages["root-a"].push({
    id: "assistant-final",
    role: "assistant",
    text: "Final answer.",
    completed: true,
    finish: "stop",
  });
  await expect(page.getByText("Final answer.")).toBeVisible({ timeout: 5_000 });
  await expect.poll(() => page.evaluate(() => window.audioPlays)).toBe(1);
});

test("stopping while TTS is pending prevents playback and stale state updates", async ({
  page,
}) => {
  let releaseTts;
  let interceptedTts = false;
  await prepareVoiceApp(page, {
    onTts: async (route) => {
      interceptedTts = true;
      await new Promise((resolve) => {
        releaseTts = async () => {
          await route.fulfill({
            status: 200,
            contentType: "audio/mpeg",
            body: "audio",
          });
          resolve();
        };
      });
    },
  });
  await page.getByRole("button", { name: /Start hands-free/ }).click();
  await page.evaluate(() => window.emitVoice("Play a response"));
  await expect.poll(() => interceptedTts).toBe(true);
  await page.getByRole("button", { name: /Stop listening/ }).click();
  await releaseTts();
  await page.waitForTimeout(100);
  expect(await page.evaluate(() => window.audioPlays || 0)).toBe(0);
  await expect(page.locator("#voiceStatus")).toContainText("Hands-free paused");
  await expect(
    page.getByRole("button", { name: /Start hands-free/ }),
  ).toHaveAttribute("aria-pressed", "false");
});

test("send errors pause hands-free without retrying", async ({ page }) => {
  const { sent } = await prepareVoiceApp(page, {
    onSend: (route) =>
      route.fulfill({ status: 503, json: { error: "Unavailable" } }),
  });
  await page.getByRole("button", { name: /Start hands-free/ }).click();
  await page.evaluate(() => window.emitVoice("Send once"));
  await expect.poll(() => sent.length).toBe(1);
  await expect(page.locator("#voiceStatus")).toContainText(
    "Message not sent: Unavailable",
  );
  await expect(
    page.getByRole("button", { name: /Start hands-free/ }),
  ).toHaveAttribute("aria-pressed", "false");
  await page.waitForTimeout(1_500);
  expect(sent).toHaveLength(1);
  expect(await page.evaluate(() => window.recognitionStarts)).toBe(1);
});

test("assistant turn failures are surfaced without speaking or retrying", async ({
  page,
}) => {
  const { sent } = await prepareVoiceApp(page, {
    onSend: async (route, { sessionID, text, messages }) => {
      messages[sessionID].push(
        { id: "failed-user", role: "user", text },
        {
          id: "failed-assistant",
          role: "assistant",
          text: "Partial failed output",
          completed: true,
          finish: "error",
        },
      );
      await route.fulfill({ status: 202, json: {} });
    },
  });
  await page.getByRole("button", { name: /Start hands-free/ }).click();
  await page.evaluate(() => window.emitVoice("Ask and fail"));
  await expect.poll(() => sent.length).toBe(1);
  await expect(page.locator("#voiceStatus")).toContainText(
    "The assistant could not complete that reply.",
  );
  expect(await page.evaluate(() => window.audioPlays || 0)).toBe(0);
  expect(await page.evaluate(() => window.recognitionStarts)).toBe(1);
});

test("switching sessions cancels a pending dictated send", async ({ page }) => {
  const { sent } = await prepareVoiceApp(page, {
    sessions: [
      { id: "root-a", title: "Project A", directory: "/a", status: "idle" },
      { id: "root-b", title: "Project B", directory: "/b", status: "idle" },
    ],
  });
  await page.getByRole("button", { name: /Start hands-free/ }).click();
  await page.evaluate(() => window.emitVoice("Do not send after switch"));
  await page.getByText("Switch", { exact: true }).click();
  await page.getByRole("button", { name: /Project B/ }).click();
  await page.evaluate(() =>
    window.emitVoice("Late result from the stopped microphone"),
  );
  await page.waitForTimeout(1_500);
  expect(sent).toHaveLength(0);
  await expect(page.locator("#sessionTitle")).toHaveText("Project B");
  await expect(
    page.getByRole("button", { name: /Start hands-free/ }),
  ).toHaveAttribute("aria-pressed", "false");
});

test("TTS failure pauses without reopening the microphone", async ({
  page,
}) => {
  await prepareVoiceApp(page, {
    onTts: (route) =>
      route.fulfill({ status: 502, json: { error: "Speech unavailable" } }),
  });
  await page.getByRole("button", { name: /Start hands-free/ }).click();
  await page.evaluate(() => window.emitVoice("Please reply"));
  await expect(page.locator("#voiceStatus")).toContainText(
    "Could not play reply",
  );
  await expect(
    page.getByRole("button", { name: /Start hands-free/ }),
  ).toHaveAttribute("aria-pressed", "false");
  expect(await page.evaluate(() => window.recognitionStarts)).toBe(1);
});

test("a response arriving after a session switch cannot overwrite the new history", async ({
  page,
}) => {
  let finishSend;
  let sendStarted = false;
  const { sent, messages } = await prepareVoiceApp(page, {
    sessions: [
      { id: "root-a", title: "Project A", directory: "/a", status: "idle" },
      { id: "root-b", title: "Project B", directory: "/b", status: "idle" },
    ],
    onSend: async (route) => {
      sendStarted = true;
      await new Promise((resolve) => {
        finishSend = async () => {
          await route.fulfill({ status: 202, json: {} });
          resolve();
        };
      });
    },
  });
  messages["root-b"].push({
    id: "history-b",
    role: "assistant",
    text: "History for project B.",
    completed: true,
    finish: "stop",
  });
  await page.getByRole("button", { name: /Start hands-free/ }).click();
  await page.evaluate(() => window.emitVoice("Wait for project A"));
  await expect.poll(() => sendStarted).toBe(true);
  await page.getByText("Switch", { exact: true }).click();
  await page.getByRole("button", { name: /Project B/ }).click();
  await expect(page.getByText("History for project B.")).toBeVisible();
  await finishSend();
  await page.waitForTimeout(150);
  await expect(page.locator("#sessionTitle")).toHaveText("Project B");
  await expect(page.getByText("Wait for project A")).toHaveCount(0);
  expect(await page.evaluate(() => window.audioPlays || 0)).toBe(0);
  expect(sent).toEqual([{ sessionID: "root-a", text: "Wait for project A" }]);
});
