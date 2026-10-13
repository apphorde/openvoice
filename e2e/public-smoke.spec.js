import { test, expect } from "@playwright/test";

test("public deployment health, OIDC redirect, and API boundary", async ({
  request,
  baseURL,
}) => {
  const health = await request.get(`${baseURL}/healthz`);
  expect(health.status()).toBe(200);
  expect(await health.json()).toEqual({ healthy: true });

  const protectedApi = await request.get(`${baseURL}/api/sessions`, {
    maxRedirects: 0,
  });
  expect(protectedApi.status()).toBe(401);

  const login = await request.get(`${baseURL}/auth/login`, {
    maxRedirects: 0,
  });
  expect(login.status()).toBe(302);
  const location = new URL(login.headers().location);
  expect(location.origin).toBe(
    process.env.EXPECTED_OIDC_ORIGIN || "https://auth.api.apphor.de",
  );
  expect(location.pathname).toBe("/authorize");
});
