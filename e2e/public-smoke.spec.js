import { test, expect } from "@playwright/test";

test("public deployment health, OIDC redirect, and API boundary", async ({ request, baseURL }) => {
  test.skip(!process.env.SESSION_VOICE_BASE_URL, "Requires an explicit OIDC-protected deployment URL");
  const health = await request.get(`${baseURL}/healthz`);
  expect(health.status()).toBe(200);
  expect(await health.json()).toEqual({ healthy: true });

  const protectedPage = await request.get(`${baseURL}/`, { maxRedirects: 0 });
  expect(protectedPage.status()).toBe(302);
  expect(protectedPage.headers().location).toBe("/auth/login");
  expect(protectedPage.headers()["cache-control"]).toBe("no-store");

  const protectedApi = await request.get(`${baseURL}/api/sessions`, {
    maxRedirects: 0,
  });
  expect(protectedApi.status()).toBe(401);
  expect(protectedApi.headers()["cache-control"]).toBe("no-store");

  const protectedConversation = await request.get(`${baseURL}/api/sessions/private/messages`, {
    maxRedirects: 0,
  });
  expect(protectedConversation.status()).toBe(401);
  expect(protectedConversation.headers()["cache-control"]).toBe("no-store");

  const login = await request.get(`${baseURL}/auth/login`, {
    maxRedirects: 0,
  });
  expect(login.status()).toBe(302);
  const location = new URL(login.headers().location);
  expect(location.origin).toBe(process.env.EXPECTED_OIDC_ORIGIN || "https://auth.api.apphor.de");
  expect(location.pathname).toBe("/authorize");
});
