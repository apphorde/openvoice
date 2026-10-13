import { readFile } from "node:fs/promises";
import { test, expect } from "@playwright/test";

async function authenticate(context) {
  const jarPath = process.env.AUTH_LAB_COOKIE_JAR;
  test.skip(!jarPath, "Set AUTH_LAB_COOKIE_JAR for the Auth Lab OIDC flow");
  const jar = await readFile(jarPath, "utf8");
  const cookieLine = jar
    .split("\n")
    .find(
      (line) =>
        line.includes("auth.lab.apphor.de") && line.includes("connect.sid"),
    );
  if (!cookieLine) {
    throw new Error(
      "Auth Lab automation session cookie not found in cookie jar",
    );
  }
  const [rawDomain, , path, secure, , name, value] = cookieLine.split("\t");
  const domain = rawDomain.replace(/^#HttpOnly_/, "");
  await context.addCookies([
    {
      name,
      value,
      domain,
      path,
      httpOnly: true,
      secure: secure === "TRUE",
      sameSite: "Lax",
    },
  ]);
}

test("OIDC login, authenticated PWA, goals, logout, and protected access", async ({
  browser,
  baseURL,
}) => {
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
  });
  await authenticate(context);
  await context.addInitScript(() => {
    window.SpeechRecognition = class {
      start() {
        const alternatives = [{ transcript: "Check all project goals" }];
        const results = [alternatives];
        results.item = (index) => results[index];
        this.onresult?.({ resultIndex: 0, results });
      }
      stop() {
        this.onend?.();
      }
    };
  });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.route("**/api/sessions", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        sessions: [
          {
            id: "root-e2e",
            title: "Executive cloud session",
            directory: "/workspace/cloud",
            status: "idle",
            latest: "Waiting for direction",
            latestRole: "user",
            time: Date.now(),
          },
        ],
        updatedAt: new Date().toISOString(),
        error: null,
      }),
    }),
  );
  await page.route("**/api/sessions/root-e2e/messages**", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        messages: [
          {
            id: "answer-1",
            role: "assistant",
            text: "Ready for instructions.",
            time: Date.now(),
          },
        ],
      }),
    }),
  );
  await page.route("**/api/plan/send", async (route) => {
    expect(route.request().postDataJSON().sessionIds).toEqual(["root-e2e"]);
    await route.fulfill({
      status: 202,
      contentType: "application/json",
      body: JSON.stringify({ sent: 1, failed: 0 }),
    });
  });
  await page.route("**/api/sessions/root-e2e/message", async (route) => {
    expect(route.request().postDataJSON().text).toBe(
      "Please summarize progress",
    );
    await route.fulfill({
      status: 202,
      contentType: "application/json",
      body: "{}",
    });
  });

  await page.goto(baseURL);
  await expect(page).toHaveTitle(/OpenVoice/);
  await expect(page.getByText("Ready for instructions.")).toBeVisible();
  await expect(page.locator("#goalsPanel")).not.toHaveAttribute("open", "");
  await page.getByText("Switch", { exact: true }).click();
  await page.getByRole("button", { name: /Executive cloud session/ }).click();
  await expect(page.locator("#sessionTitle")).toHaveText(
    "Executive cloud session",
  );
  await page.getByRole("button", { name: /Start hands-free/ }).click();
  await expect(page.locator("#transcriptPreview")).toContainText(
    "Check all project goals",
  );
  await page.getByRole("button", { name: /Stop listening/ }).click();
  await page.getByText("Type instead", { exact: true }).click();
  await page
    .getByPlaceholder("Write an instruction…")
    .fill("Please summarize progress");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(page.locator("#voiceStatus")).toContainText(
    "Waiting for the reply",
  );

  await page.getByText(/Executive goals/).click();
  const title = `E2E goal ${Date.now()}`;
  await page.getByLabel("Goal", { exact: true }).fill(title);
  await page
    .getByLabel("Success criteria")
    .fill("Verify cross-session plan storage");
  await page.getByRole("button", { name: "Add goal" }).click();
  await expect(page.getByText(title)).toBeVisible();
  page.once("dialog", (dialog) => dialog.accept());
  await page
    .getByRole("button", { name: "Send plan to all top-level sessions" })
    .click();
  await expect(page.locator("#goalNotice")).toContainText(
    "Sent to 1; 0 failed.",
  );
  await page.screenshot({
    path: "/tmp/opencode/session-voice-mobile.png",
    fullPage: true,
  });

  await page.getByRole("button", { name: "Log out" }).click();
  await page.waitForURL(/\/signed-out$/);
  const protectedApi = await page.request.get(`${baseURL}/api/goals`);
  expect(protectedApi.status()).toBe(401);
  expect(errors).toEqual([]);
  await context.close();
});
