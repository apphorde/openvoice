import test from "node:test";
import assert from "node:assert/strict";
import { rootSessions, latestExcerpt } from "../src/utils.js";

test("rootSessions excludes children and sorts by update time", () => {
  const input = [
    { id: "child", parentID: "root" },
    { id: "old", time: { created: 1 } },
    { id: "new", time: { updated: 3 } },
  ];
  assert.deepEqual(
    rootSessions(input).map((session) => session.id),
    ["new", "old"],
  );
});

test("rootSessions handles malformed input", () => {
  assert.deepEqual(rootSessions(null), []);
});

test("latestExcerpt extracts text and caps length", () => {
  assert.equal(latestExcerpt(null), "");
  assert.equal(
    latestExcerpt({
      parts: [{ type: "text", text: " hello  there " }, { type: "image" }],
    }),
    "hello there",
  );
  const excerpt = latestExcerpt({
    parts: [{ type: "text", text: "x".repeat(200) }],
  });
  assert.ok(excerpt.length <= 180);
  assert.ok(excerpt.endsWith("…"));
});
