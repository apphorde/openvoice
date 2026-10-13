import test from "node:test";
import assert from "node:assert/strict";
import { isSubjectAllowed } from "../src/auth-policy.js";

test("OIDC subject allowlist permits an explicitly allowed subject and denies others", () => {
  const allowlist = ["user-a", "user-b"];
  assert.equal(isSubjectAllowed("user-a", allowlist), true);
  assert.equal(isSubjectAllowed("user-c", allowlist), false);
});

test("an empty OIDC subject allowlist permits any verified subject", () => {
  assert.equal(isSubjectAllowed("verified-subject", []), true);
});
