import assert from "node:assert/strict";
import { test } from "node:test";
import { agentBootstrapFromBody } from "../src/agent-bootstrap.js";

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

function resumeState() {
  return {
    ok: true,
    canonical_head: { hash: "chain-head-stable", path: null, repo: null, commit_sha: null },
    path_heads: [
      { path: "docs/AI_OPERATING_GUIDE.md", stone_hash: "instructions-stone", repo: "nothinginfinity/cairnstone-v6", commit_sha: VALID_COMMIT_A }
    ]
  };
}

function makeDeps(overrides = {}) {
  return {
    resumeChainFromBody: async () => resumeState(),
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
  const guide = "# Operating Guide\n" + "x".repeat(500) + "\n";
  globalThis.fetch = async () => ({
    ok: true,
    json: async () => ({
      encoding: "base64",
      content: Buffer.from(guide).toString("base64"),
      sha: "4448e428eba37d0e687e7ca402b6c473757ad1da"
    })
  });
  return () => { globalThis.fetch = original; };
}

test("V7.6.0 smoke: include_profile absent -> no diagnostics field, unchanged response shape", async () => {
  const restore = mockGithubFetchOnce();
  try {
    const result = await agentBootstrapFromBody(
      { actor_id: "test:profile", task: "smoke test", chain: "cairnstone-v6-project-memory" },
      makeEnv(),
      makeDeps()
    );
    assert.equal(result.ok, true);
    assert.equal("diagnostics" in result, false);
  } finally {
    restore();
  }
});

test("V7.6.0 smoke: include_profile:true -> diagnostics.bootstrap_package reconciles, mcp_schema null without mcpToolDefinitions dep", async () => {
  const restore = mockGithubFetchOnce();
  try {
    const result = await agentBootstrapFromBody(
      { actor_id: "test:profile", task: "smoke test", chain: "cairnstone-v6-project-memory", include_profile: true },
      makeEnv(),
      makeDeps()
    );
    assert.equal(result.ok, true);
    assert.ok(result.diagnostics);
    assert.equal(result.diagnostics.schema, "cairnstone-context-profile-v1");
    assert.equal(result.diagnostics.bootstrap_package.ok, true);
    assert.ok(result.diagnostics.bootstrap_package.reconciliation.overhead_bytes >= 0);
    assert.equal(result.diagnostics.mcp_schema, null);
    assert.equal(result.diagnostics.combined.includes_bootstrap, true);
    assert.equal(result.diagnostics.combined.includes_mcp_schema, false);
  } finally {
    restore();
  }
});

test("V7.6.0 smoke: include_profile:true with mcpToolDefinitions dep -> mcp_schema populated and combined reflects both", async () => {
  const restore = mockGithubFetchOnce();
  try {
    const tools = [
      { name: "cairnstone_health", description: "d", inputSchema: { type: "object", properties: {} } },
      { name: "cairnstone_agent_bootstrap", description: "d2", inputSchema: { type: "object", properties: { actor_id: { type: "string" } } } }
    ];
    const result = await agentBootstrapFromBody(
      { actor_id: "test:profile", task: "smoke test", chain: "cairnstone-v6-project-memory", include_profile: true },
      makeEnv(),
      makeDeps({ mcpToolDefinitions: tools })
    );
    assert.equal(result.ok, true);
    assert.equal(result.diagnostics.mcp_schema.ok, true);
    assert.equal(result.diagnostics.mcp_schema.tool_count, 2);
    assert.equal(result.diagnostics.combined.includes_mcp_schema, true);
    assert.equal(
      result.diagnostics.combined.total_bytes,
      result.diagnostics.bootstrap_package.package_bytes + result.diagnostics.mcp_schema.total_schema_bytes
    );
  } finally {
    restore();
  }
});

test("V7.6.0 smoke: diagnostics never affects package_id (hashablePayload excludes it)", async () => {
  const restore = mockGithubFetchOnce();
  try {
    const withoutProfile = await agentBootstrapFromBody(
      { actor_id: "test:profile", task: "identity check", chain: "cairnstone-v6-project-memory" },
      makeEnv(),
      makeDeps()
    );
    const withProfile = await agentBootstrapFromBody(
      { actor_id: "test:profile", task: "identity check", chain: "cairnstone-v6-project-memory", include_profile: true },
      makeEnv(),
      makeDeps()
    );
    assert.equal(withoutProfile.ok, true);
    assert.equal(withProfile.ok, true);
    assert.equal(withoutProfile.package_id, withProfile.package_id);
  } finally {
    restore();
  }
});

test("V7.6.0 smoke: STRONG identity regression -- include_profile:true/false yield identical package_id, limits, memory items, and every canonical field (per chatgpt:cairnstone-v6's V7.6.0 review)", async () => {
  const restore = mockGithubFetchOnce();
  try {
    const withoutProfile = await agentBootstrapFromBody(
      { actor_id: "test:strong-identity", task: "strong identity check", chain: "cairnstone-v6-project-memory" },
      makeEnv(),
      makeDeps()
    );
    const withProfile = await agentBootstrapFromBody(
      {
        actor_id: "test:strong-identity",
        task: "strong identity check",
        chain: "cairnstone-v6-project-memory",
        include_profile: true
      },
      makeEnv(),
      makeDeps({ mcpToolDefinitions: [{ name: "x", description: "d", inputSchema: {} }] })
    );

    assert.equal(withoutProfile.ok, true);
    assert.equal(withProfile.ok, true);

    // 1. package_id must be byte-identical.
    assert.equal(withoutProfile.package_id, withProfile.package_id);

    // 2. limits (produced by enforceSizeDiscipline, which must run
    // identically regardless of include_profile) must be deep-equal.
    assert.deepEqual(withoutProfile.limits, withProfile.limits);

    // 3. memory item set/order must be identical -- proves include_profile
    // cannot influence trimming decisions made before profiling runs.
    assert.deepEqual(withoutProfile.memory, withProfile.memory);

    // 4. Every canonical package field must be identical after stripping
    // only the fields that legitimately differ (diagnostics itself, and
    // runtime.compiled_at, which is a real wall-clock timestamp generated
    // independently per call and is correctly excluded from
    // hashablePayload/package_id -- not a profiler side effect). This is
    // the strongest available proof the profiler is purely observational.
    const normalize = obj => {
      const { diagnostics, ...rest } = obj;
      return { ...rest, runtime: { ...rest.runtime, compiled_at: null } };
    };
    assert.deepEqual(normalize(withoutProfile), normalize(withProfile));

    // 5. And the only difference between the two full responses is the
    // presence of `diagnostics` -- confirms no other field was added,
    // removed, or reordered as a side effect of profiling.
    assert.equal("diagnostics" in withoutProfile, false);
    assert.equal("diagnostics" in withProfile, true);
  } finally {
    restore();
  }
});

test("V7.6.0 smoke: include_profile:false behaves identically to absent", async () => {
  const restore = mockGithubFetchOnce();
  try {
    const result = await agentBootstrapFromBody(
      { actor_id: "test:profile", task: "smoke test", chain: "cairnstone-v6-project-memory", include_profile: false },
      makeEnv(),
      makeDeps()
    );
    assert.equal(result.ok, true);
    assert.equal("diagnostics" in result, false);
  } finally {
    restore();
  }
});
