import assert from "node:assert/strict";
import { test } from "node:test";
import {
  computeBootstrapPackageProfile,
  computeMcpSchemaProfile,
  computeCombinedStartupProfile,
  CONTEXT_PROFILE_SCHEMA
} from "../src/context-profile.js";

function samplePackageBody(overrides = {}) {
  return {
    schema: "cairnstone-agent-context-v1",
    actor: { actor_id: "test:actor" },
    request: { task: "test task", chain: "test-chain" },
    runtime: { cairnstone_version: "0.5.19", protocol: "FSL-CCR Stone v6", compiled_at: "2026-08-30T00:00:00.000Z" },
    authority: {
      chain: "test-chain",
      chain_head: { stone_hash: "abc123", path: "README.md", repo: "org/repo", commit_sha: "deadbeef" },
      path_heads: [
        { path: "README.md", stone_hash: "abc123", repo: "org/repo", commit_sha: "deadbeef" },
        { path: "src/index.js", stone_hash: "def456", repo: "org/repo", commit_sha: "deadbeef" }
      ],
      timestamp_ordering_used: false
    },
    instructions: { content: "x".repeat(200), authority_chain: "test-chain" },
    coordination: { recipient_id: "test:actor", unread_count: 0, items: [] },
    skills: { accepted_bundle: [{ skill_id: "core.orient", skill_version: "1.0.0" }] },
    memory: { items: [], truncated: false },
    capabilities: { max_context_tokens: null, supports_tool_calls: true, tools: [] },
    policy: {
      context_compiler_called_llm: false,
      execution_authority: false,
      mutation_authority: false,
      provider_credentials_in_package: false,
      accepted_state_only_for_authority: true,
      mutable_branch_is_authority: false
    },
    limits: { effective_max_package_bytes: 64000, package_bytes: 0, skills_bytes: 0, memory_bytes: 0, instructions_bytes: 0, truncated: false },
    ...overrides
  };
}

test("computeBootstrapPackageProfile: deterministic on identical input", () => {
  const pkg = samplePackageBody();
  const first = computeBootstrapPackageProfile(pkg);
  const second = computeBootstrapPackageProfile(samplePackageBody());
  assert.equal(first.ok, true);
  assert.deepEqual(first.sections, second.sections);
  assert.equal(first.package_bytes, second.package_bytes);
  assert.equal(first.reconciliation.overhead_bytes, second.reconciliation.overhead_bytes);
});

test("computeBootstrapPackageProfile: section sum reconciles to package_bytes within overhead", () => {
  const pkg = samplePackageBody();
  const profile = computeBootstrapPackageProfile(pkg);
  assert.equal(profile.ok, true);
  // Section-by-section serialization always costs a bit less than the
  // combined serialization (the combined form adds one set of top-level
  // key labels/commas/braces that no bare-value serialization includes)
  // -- overhead must be non-negative and small relative to the whole
  // package, never negative or huge.
  assert.ok(profile.reconciliation.overhead_bytes >= 0);
  assert.ok(profile.reconciliation.overhead_bytes < profile.package_bytes);
});

test("computeBootstrapPackageProfile: larger memory section increases memory_bytes and package_bytes monotonically", () => {
  const small = computeBootstrapPackageProfile(samplePackageBody({ memory: { items: [], truncated: false } }));
  const large = computeBootstrapPackageProfile(samplePackageBody({
    memory: { items: [{ path: "a.md", ref_id: "r1", authority_class: "HISTORICAL", line_start: 1, line_end: 20, freshness: null }], truncated: false }
  }));
  assert.ok(large.sections.memory_bytes > small.sections.memory_bytes);
  assert.ok(large.package_bytes > small.package_bytes);
});

test("computeBootstrapPackageProfile: honors explicit instructionsBytes to match agent-bootstrap.js's own measurement", () => {
  const pkg = samplePackageBody();
  const profile = computeBootstrapPackageProfile(pkg, { instructionsBytes: 999 });
  assert.equal(profile.sections.instructions_bytes, 999);
});

test("computeBootstrapPackageProfile: estimator is labeled non-authoritative", () => {
  const profile = computeBootstrapPackageProfile(samplePackageBody());
  assert.equal(profile.estimator.authoritative, false);
  assert.equal(profile.estimator.bytes_per_token, 4);
});

test("computeBootstrapPackageProfile: custom bytes_per_token_estimate changes token counts only, not byte counts", () => {
  const pkg = samplePackageBody();
  const defaultProfile = computeBootstrapPackageProfile(pkg);
  const customProfile = computeBootstrapPackageProfile(pkg, { bytesPerTokenEstimate: 2 });
  assert.deepEqual(defaultProfile.sections, customProfile.sections);
  assert.equal(customProfile.estimated_tokens.package_tokens, Math.ceil(defaultProfile.package_bytes / 2));
});

test("computeBootstrapPackageProfile: rejects non-object input", () => {
  assert.equal(computeBootstrapPackageProfile(null).ok, false);
  assert.equal(computeBootstrapPackageProfile(undefined).ok, false);
  assert.equal(computeBootstrapPackageProfile("not an object").ok, false);
});

test("computeMcpSchemaProfile: measures exact provided tool definitions, not a hardcoded list", () => {
  const tools = [
    { name: "cairnstone_health", description: "d", inputSchema: { type: "object", properties: {} } },
    { name: "cairnstone_find_v2", description: "longer description here", inputSchema: { type: "object", properties: { query: { type: "string" } } } }
  ];
  const profile = computeMcpSchemaProfile(tools);
  assert.equal(profile.ok, true);
  assert.equal(profile.tool_count, 2);
  assert.equal(profile.per_tool.length, 2);
  assert.equal(profile.per_tool[0].name, "cairnstone_health");
  const expectedPerToolSum = tools.reduce((sum, t) => sum + new TextEncoder().encode(JSON.stringify(t)).length, 0);
  const expectedArrayBytes = new TextEncoder().encode(JSON.stringify(tools)).length;
  assert.equal(profile.per_tool_schema_sum_bytes, expectedPerToolSum);
  assert.equal(profile.definitions_array_bytes, expectedArrayBytes);
  // total_schema_bytes must be the exact array baseline (per chatgpt's
  // V7.6.0 review), not the sum-of-parts, since the array framing
  // ([ ] and inter-element commas) is real payload cost that a per-tool
  // sum silently omits.
  assert.equal(profile.total_schema_bytes, expectedArrayBytes);
  // Array framing overhead should be positive for 2+ tools (comma between
  // elements plus brackets) and exactly account for the gap.
  assert.equal(profile.serialization_overhead_bytes, expectedArrayBytes - expectedPerToolSum);
  assert.ok(profile.serialization_overhead_bytes > 0);
  // Wire-envelope evidence must be reported separately and must not be
  // conflated with the model-visible schema baseline.
  const expectedResultBytes = new TextEncoder().encode(JSON.stringify({ tools })).length;
  assert.equal(profile.tools_list_result_bytes, expectedResultBytes);
  assert.notEqual(profile.tools_list_result_bytes, profile.definitions_array_bytes);
});

test("computeMcpSchemaProfile: empty registry yields zero cost, not an error", () => {
  const profile = computeMcpSchemaProfile([]);
  assert.equal(profile.ok, true);
  assert.equal(profile.tool_count, 0);
  assert.equal(profile.total_schema_bytes, 2); // "[]"
  assert.equal(profile.per_tool_schema_sum_bytes, 0);
  assert.equal(profile.serialization_overhead_bytes, 2);
});

test("computeMcpSchemaProfile: rejects non-array input", () => {
  assert.equal(computeMcpSchemaProfile(null).ok, false);
  assert.equal(computeMcpSchemaProfile({}).ok, false);
});

test("computeCombinedStartupProfile: sums bootstrap + schema profiles", () => {
  const bootstrap = computeBootstrapPackageProfile(samplePackageBody());
  const schema = computeMcpSchemaProfile([{ name: "t", description: "d", inputSchema: {} }]);
  const combined = computeCombinedStartupProfile({ bootstrapProfile: bootstrap, mcpSchemaProfile: schema });
  assert.equal(combined.ok, true);
  assert.equal(combined.total_bytes, bootstrap.package_bytes + schema.total_schema_bytes);
  assert.equal(combined.includes_bootstrap, true);
  assert.equal(combined.includes_mcp_schema, true);
});

test("computeCombinedStartupProfile: works with only one input present", () => {
  const bootstrap = computeBootstrapPackageProfile(samplePackageBody());
  const combined = computeCombinedStartupProfile({ bootstrapProfile: bootstrap });
  assert.equal(combined.includes_bootstrap, true);
  assert.equal(combined.includes_mcp_schema, false);
  assert.equal(combined.total_bytes, bootstrap.package_bytes);
});

test("computeCombinedStartupProfile: computes context_window_pct when maxContextTokens supplied", () => {
  const bootstrap = computeBootstrapPackageProfile(samplePackageBody());
  const combined = computeCombinedStartupProfile({ bootstrapProfile: bootstrap, maxContextTokens: 100000 });
  assert.ok(Number.isFinite(combined.context_window_pct));
  assert.equal(combined.context_window_tokens, 100000);
});

test("computeCombinedStartupProfile: omits context_window_pct when maxContextTokens absent or invalid", () => {
  const bootstrap = computeBootstrapPackageProfile(samplePackageBody());
  const withoutWindow = computeCombinedStartupProfile({ bootstrapProfile: bootstrap });
  assert.equal("context_window_pct" in withoutWindow, false);
  const withZero = computeCombinedStartupProfile({ bootstrapProfile: bootstrap, maxContextTokens: 0 });
  assert.equal("context_window_pct" in withZero, false);
});

test("schema constant is exported and stable", () => {
  assert.equal(CONTEXT_PROFILE_SCHEMA, "cairnstone-context-profile-v1");
});
