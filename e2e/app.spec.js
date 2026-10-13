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
  await page.route("**/api/plan/send", async (route) => {
    expect(route.request().postDataJSON().sessionIds).toEqual(["root-e2e"]);
    await route.fulfill({
      status: 202,
      contentType: "application/json",
      body: JSON.stringify({ sent: 1, failed: 0 }),
    });
  });

  await page.goto(baseURL);
  await expect(page).toHaveTitle(/Session Voice/);
  await expect(
    page.getByRole("heading", { name: "Executive goals" }),
  ).toBeVisible();
  await page.getByRole("button", { name: /Executive cloud session/ }).click();
  await expect(page.locator("#empty")).toBeHidden();
  await expect(page.locator("#selected")).toBeVisible();
  await page.getByRole("button", { name: /Start voice/ }).click();
  await expect(page.locator("#voiceState")).toHaveText("Listening…");
  await expect(page.locator("#prompt")).toHaveValue("Check all project goals");
  await page.getByRole("button", { name: /Stop voice/ }).click();

  const title = `E2E goal ${Date.now()}`;
  await page.getByLabel("Goal", { exact: true }).fill(title);
  await page
    .getByLabel("Context / success criteria")
    .fill("Verify cross-session plan storage");
  await page.getByRole("button", { name: "Add goal" }).click();
  await expect(page.getByText(title)).toBeVisible();
  page.once("dialog", (dialog) => dialog.accept());
  await page
    .getByRole("button", { name: "Send plan to all root sessions" })
    .click();
  await expect(page.locator("#goalNotice")).toContainText(
    "Plan sent to 1 sessions; 0 failed.",
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
