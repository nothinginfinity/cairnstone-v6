import assert from "node:assert/strict";
import { test } from "node:test";
import { agentBootstrapFromBody } from "../src/agent-bootstrap.js";

const INSTRUCTIONS_PATH = "docs/AI_OPERATING_GUIDE.md";
const VALID_COMMIT_A = "55ec7b749fc8c21431d67c268646b43f60337612";

function makeEnv() {
  return {
    CAIRNSTONE_DB: {
      prepare() {
        return {
          bind() { return this; },
          async all() { return { results: [] }; },
          async first() { return null; }
        };
      }
    },
    CAIRNSTONE_RAW: { async get() { return null; } },
    GITHUB_TOKEN: "test-token"
  };
}

function resumeStateWithHead(hash) {
  return {
    ok: true,
    canonical_head: { hash, path: null, repo: null, commit_sha: null },
    path_heads: [
      { path: INSTRUCTIONS_PATH, stone_hash: "instructions-stone", repo: "nothinginfinity/cairnstone-v6", commit_sha: VALID_COMMIT_A }
    ]
  };
}

function makeDeps(overrides = {}) {
  return {
    resumeChainFromBody: async () => resumeStateWithHead("chain-head-stable"),
    getInboxFromBody: async () => ({ ok: true, messages: [] }),
    resolveSkillsFromBody: async () => ({ ok: true, recommendations: [] }),
    getSkillBundleFromBody: async () => ({ ok: true, manifest_head: "skills-head-stable", bundle_identity: { algorithm: "sha256", sha256: "bundle" }, skills: [] }),
    listSkillsFromBody: async () => ({ ok: true, manifest: { stone_hash: "skills-head-stable" }, boot: [] }),
    version: "test",
    ...overrides
  };
}

function mockGithubFetchOnce() {
  const original = globalThis.fetch;
  const longGuide = "# Operating Guide\n" + "x".repeat(2000) + "\n";
  globalThis.fetch = async () => ({
    ok: true,
    json: async () => ({
      encoding: "base64",
      content: Buffer.from(longGuide).toString("base64"),
      sha: "4448e428eba37d0e687e7ca402b6c473757ad1da"
    })
  });
  return () => { globalThis.fetch = original; };
}

test("V7.0 Test G: chain-HEAD change between snapshot and re-check fails closed with context_compile_race", async () => {
  const restore = mockGithubFetchOnce();
  try {
    let call = 0;
    const deps = makeDeps({
      resumeChainFromBody: async () => {
        call += 1;
        // First call = initial snapshot. Second call = pre-hash re-check.
        // A concurrent writer moves chain_head between them.
        return call === 1 ? resumeStateWithHead("chain-head-BEFORE") : resumeStateWithHead("chain-head-AFTER");
      }
    });

    const result = await agentBootstrapFromBody(
      { actor_id: "test:race", task: "race test", chain: "cairnstone-v6-project-memory" },
      makeEnv(),
      deps
    );

    assert.equal(result.ok, false);
    assert.equal(result.error, "context_compile_race");
  } finally {
    restore();
  }
});

test("V7.0 Test G: skills manifest HEAD change between snapshot and re-check fails closed with context_compile_race", async () => {
  const restore = mockGithubFetchOnce();
  try {
    let call = 0;
    const deps = makeDeps({
      listSkillsFromBody: async () => {
        call += 1;
        return call === 1
          ? { ok: true, manifest: { stone_hash: "skills-head-BEFORE" }, boot: [] }
          : { ok: true, manifest: { stone_hash: "skills-head-AFTER" }, boot: [] };
      }
    });

    const result = await agentBootstrapFromBody(
      { actor_id: "test:race", task: "skills race test", chain: "cairnstone-v6-project-memory" },
      makeEnv(),
      deps
    );

    assert.equal(result.ok, false);
    assert.equal(result.error, "context_compile_race");
  } finally {
    restore();
  }
});

test("V7.0 Test G (negative control): stable authority across the whole compile succeeds with no race", async () => {
  const restore = mockGithubFetchOnce();
  try {
    const result = await agentBootstrapFromBody(
      { actor_id: "test:stable", task: "stable state test", chain: "cairnstone-v6-project-memory" },
      makeEnv(),
      makeDeps()
    );

    assert.equal(result.ok, true);
    assert.equal(result.schema, "cairnstone-agent-context-v1");
    assert.match(result.package_id, /^sha256:[0-9a-f]{64}$/);
    assert.equal(result.policy.execution_authority, false);
    assert.equal(result.policy.mutation_authority, false);
    assert.equal(result.policy.context_compiler_called_llm, false);
  } finally {
    restore();
  }
});

test("V7.0 Test B (regression guard): identical input over identical state yields identical package_id", async () => {
  const restore = mockGithubFetchOnce();
  try {
    const body = { actor_id: "test:determinism", task: "determinism check", chain: "cairnstone-v6-project-memory" };
    const first = await agentBootstrapFromBody(body, makeEnv(), makeDeps());
    const second = await agentBootstrapFromBody(body, makeEnv(), makeDeps());
    assert.equal(first.ok, true);
    assert.equal(second.ok, true);
    assert.equal(first.package_id, second.package_id);
  } finally {
    restore();
  }
});

test("V7.0 Test D/E (regression guard): commit_sha not resolvable to immutable SHA fails closed", async () => {
  const restore = mockGithubFetchOnce();
  try {
    const deps = makeDeps({
      resumeChainFromBody: async () => ({
        ok: true,
        canonical_head: { hash: "chain-head", path: null, repo: null, commit_sha: null },
        path_heads: [
          { path: INSTRUCTIONS_PATH, stone_hash: "instructions-stone", repo: "nothinginfinity/cairnstone-v6", commit_sha: "main" }
        ]
      })
    });

    const result = await agentBootstrapFromBody(
      { actor_id: "test:immutable", task: "immutable commit check", chain: "cairnstone-v6-project-memory" },
      makeEnv(),
      deps
    );

    assert.equal(result.ok, false);
    assert.equal(result.error, "accepted_instruction_source_not_immutable");
  } finally {
    restore();
  }
});

test("V7.0 Test I (regression guard): impossible byte budget fails closed without omitting instructions", async () => {
  const restore = mockGithubFetchOnce();
  try {
    const result = await agentBootstrapFromBody(
      {
        actor_id: "test:bounds",
        task: "size bounds check",
        chain: "cairnstone-v6-project-memory",
        limits: { max_package_bytes: 1000 }
      },
      makeEnv(),
      makeDeps()
    );

    assert.equal(result.ok, false);
    assert.equal(result.error, "package_size_limit_exceeded");
    assert.ok(result.limits.package_bytes > result.limits.effective_max_package_bytes);
    assert.ok(result.limits.instructions_bytes > 0, "instructions must still be measured, never silently omitted");
  } finally {
    restore();
  }
});
