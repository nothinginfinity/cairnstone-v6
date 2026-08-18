import assert from "node:assert/strict";
import { test } from "node:test";
import { createRepoStonesFromBody } from "../src/repo-stones-runtime.js";

function makeDeps(calls) {
  return {
    requireBindings() {},
    requiredString(value, name) {
      if (!value) throw new Error(`Missing ${name}`);
      return String(value);
    },
    safeGitHubPart(value) {
      return String(value || "").trim();
    },
    safeGitHubRef(value) {
      return String(value || "main").trim();
    },
    clamp(value, min, max) {
      if (!Number.isFinite(value)) return min;
      return Math.max(min, Math.min(max, Math.floor(value)));
    },
    async createStoneFromGitHubBody(body) {
      calls.fileStones.push(body);
      return {
        ok: true,
        stone_hash: `stone-${body.path}`,
        refs: 1,
        receipt: { original_bytes: 100 }
      };
    },
    async createStoneFromBody(body) {
      calls.orientation = body;
      return { ok: true, stone_hash: "orientation-hash" };
    },
    async linkStonesFromBody(body) {
      calls.edges.push(body);
      return { ok: true };
    }
  };
}

test("createRepoStonesFromBody stones accepted files and creates orientation edges", async () => {
  const calls = { fileStones: [], edges: [], orientation: null };
  const deps = makeDeps(calls);
  const originalFetch = globalThis.fetch;

  globalThis.fetch = async () => ({
    ok: true,
    async json() {
      return {
        truncated: false,
        tree: [
          { type: "blob", path: "README.md", size: 100, sha: "a" },
          { type: "blob", path: "src/index.js", size: 100, sha: "b" },
          { type: "blob", path: "node_modules/pkg/index.js", size: 100, sha: "c" }
        ]
      };
    }
  });

  try {
    const result = await createRepoStonesFromBody({
      owner: "nothinginfinity",
      repo: "cairngraph",
      author: "tester"
    }, {}, deps);

    assert.equal(result.ok, true);
    assert.equal(result.chain, "cairngraph");
    assert.equal(result.created_count, 2);
    assert.equal(result.skipped_count, 1);
    assert.equal(result.failed_count, 0);
    assert.equal(result.linked_count, 2);
    assert.equal(result.orientation_hash, "orientation-hash");
    assert.equal(calls.fileStones.length, 2);
    assert.equal(calls.edges.length, 2);
    assert.equal(calls.orientation.set_as_head, true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("createRepoStonesFromBody respects max_files", async () => {
  const calls = { fileStones: [], edges: [], orientation: null };
  const deps = makeDeps(calls);
  const originalFetch = globalThis.fetch;

  globalThis.fetch = async () => ({
    ok: true,
    async json() {
      return {
        truncated: false,
        tree: [
          { type: "blob", path: "README.md", size: 100, sha: "a" },
          { type: "blob", path: "ROADMAP.md", size: 100, sha: "b" }
        ]
      };
    }
  });

  try {
    const result = await createRepoStonesFromBody({
      owner: "nothinginfinity",
      repo: "cairngraph",
      author: "tester",
      max_files: 1
    }, {}, deps);

    assert.equal(result.created_count, 1);
    assert.equal(result.skipped.some((item) => item.reason === "max_files_exceeded"), true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
