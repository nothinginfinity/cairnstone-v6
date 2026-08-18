import assert from "node:assert/strict";
import { test } from "node:test";
import { repoStoneShouldInclude, buildRepoOrientationContent } from "../src/repo-stones-operation.js";

test("repoStoneShouldInclude accepts supported source and spec files", () => {
  assert.equal(repoStoneShouldInclude("README.md", 100), true);
  assert.equal(repoStoneShouldInclude("src/index.js", 100), true);
  assert.equal(repoStoneShouldInclude("workers/demo/index.ts", 100), true);
  assert.equal(repoStoneShouldInclude("schema/example.json", 100), true);
});

test("repoStoneShouldInclude rejects noisy or oversized files", () => {
  assert.equal(repoStoneShouldInclude("node_modules/pkg/index.js", 100), false);
  assert.equal(repoStoneShouldInclude("dist/bundle.js", 100), false);
  assert.equal(repoStoneShouldInclude("package-lock.json", 100), false);
  assert.equal(repoStoneShouldInclude("src/index.js", 900001), false);
});

test("repoStoneShouldInclude honors extra exclude fragments", () => {
  assert.equal(repoStoneShouldInclude("examples/demo.md", 100, { exclude: ["examples/"] }), false);
});

test("buildRepoOrientationContent creates a map with created, skipped, and failed files", () => {
  const text = buildRepoOrientationContent({
    owner: "nothinginfinity",
    repo: "cairngraph",
    ref: "main",
    chain: "cairngraph",
    created: [{ path: "README.md", stone_hash: "abc" }],
    skipped: [{ path: "dist/bundle.js", reason: "ignored" }],
    failed: [{ path: "bad.txt", error: "fetch_failed" }]
  });
  assert.match(text, /nothinginfinity\/cairngraph Repository Orientation/);
  assert.match(text, /README.md -> abc/);
  assert.match(text, /dist\/bundle.js: ignored/);
  assert.match(text, /bad.txt: fetch_failed/);
});
