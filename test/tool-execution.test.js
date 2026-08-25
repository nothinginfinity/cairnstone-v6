import assert from "node:assert/strict";
import { test } from "node:test";
import {
  AGENT_CONTEXT_SCHEMA,
  executeToolIntentFromBody,
  recomputePackageId,
  TOOL_EXECUTION_RECEIPT_SCHEMA,
  toolPolicyPreviewFromBody
} from "../src/model-router.js";

// Same fixture shape as test/model-router.test.js -- duplicated locally
// (rather than imported) so this file has no ordering dependency on that one.
function baseFixturePackage() {
  return {
    ok: true,
    schema: AGENT_CONTEXT_SCHEMA,
    package_id: null,
    actor: { actor_id: "test:fixture" },
    request: { task: "fixture task", chain: "cairnstone-v6-project-memory" },
    runtime: { cairnstone_version: "test", protocol: "FSL-CCR Stone v6", compiled_at: "2026-08-24T00:00:00.000Z" },
    authority: {
      chain: "cairnstone-v6-project-memory",
      chain_head: { stone_hash: "chain-head-hash", path: "project-memory/x.md", repo: null, commit_sha: null },
      path_heads: [
        { path: "docs/AI_OPERATING_GUIDE.md", stone_hash: "instructions-stone", repo: "nothinginfinity/cairnstone-v6", commit_sha: "55ec7b749fc8c21431d67c268646b43f60337612" }
      ],
      timestamp_ordering_used: false
    },
    instructions: {
      path: "docs/AI_OPERATING_GUIDE.md",
      stone_hash: "instructions-stone",
      repo: "nothinginfinity/cairnstone-v6",
      commit_sha: "55ec7b749fc8c21431d67c268646b43f60337612",
      content_identity: { sha256: "abc", git_blob_sha: "4448e428eba37d0e687e7ca402b6c473757ad1da", bytes: 3 },
      content: "Fixture instructions.",
      truncated: false
    },
    coordination: { recipient_id: "test:fixture", unread_count: 0, items: [] },
    skills: {
      chain: "cairnstone-v6-skills",
      manifest_head: "skills-head",
      resolution_mode: "deterministic",
      boot: [],
      recommendations: [],
      ambiguous: false,
      accepted_bundle: { bundle_identity: { algorithm: "sha256", sha256: "bundle" }, skills: [] }
    },
    memory: { query: "fixture", items: [], truncated: false },
    capabilities: { available_tools: ["cairnstone_health"], missing_required_tools: [], supports_tool_calls: true },
    policy: {
      context_compiler_called_llm: false,
      execution_authority: false,
      mutation_authority: false,
      provider_credentials_in_package: false,
      accepted_state_only_for_authority: true,
      mutable_branch_is_authority: false
    },
    limits: { effective_max_package_bytes: 64000, package_bytes: 1000, skills_bytes: 0, memory_bytes: 0, instructions_bytes: 22, truncated: false }
  };
}

async function withAvailableTools(toolIds) {
  const pkg = baseFixturePackage();
  pkg.capabilities.available_tools = [...toolIds];
  pkg.package_id = await recomputePackageId(pkg);
  return pkg;
}

test("V7.3.1 executes an allowed automatic-read intent outside any provider adapter and issues a receipt", async () => {
  const pkg = await withAvailableTools(["cairnstone_health"]);
  const intent = { intent_id: "sha256:" + "3".repeat(64), tool_id: "cairnstone_health", arguments: {} };

  let invokedWith = null;
  let createdReceiptBody = null;
  const result = await executeToolIntentFromBody({ context_package: pkg, tool_intent: intent }, {}, {
    invokeTool: async (handlerName, handlerArgs) => {
      invokedWith = { handlerName, handlerArgs };
      return { ok: true, version: "0.5.10" };
    },
    createStone: async body => {
      createdReceiptBody = body;
      return { ok: true, stone_hash: "receipt-hash-1" };
    }
  });

  assert.equal(result.ok, true);
  assert.equal(result.schema, TOOL_EXECUTION_RECEIPT_SCHEMA);
  assert.equal(result.executed, true);
  assert.equal(result.decision, "allow");
  assert.equal(result.package_id, pkg.package_id);
  assert.equal(result.tool_id, "cairnstone_health");
  assert.deepEqual(result.result, { ok: true, version: "0.5.10" });
  assert.equal(result.output_truncated, false);
  assert.equal(result.execution.executed, true);
  assert.equal(result.execution.execution_authority, false);
  assert.equal(result.execution.mutation_authority, false);
  assert.equal(result.receipt.stone_hash, "receipt-hash-1");
  assert.equal(result.receipt.chain, "cairnstone-v7-tool-execution-receipts");
  assert.ok(result.execution_id.startsWith("sha256:"));
  assert.equal(invokedWith.handlerName, "cairnstone_health");
  assert.equal(createdReceiptBody.chain, "cairnstone-v7-tool-execution-receipts");
  assert.equal(createdReceiptBody.set_as_head, false);
  assert.equal(createdReceiptBody.metadata.decision_id, result.decision_id);
  assert.equal(result.budgets.turn_tool_calls_so_far, 1);
});

test("V7.3.1 decision_id for an executed call matches the standalone preview's decision_id for the identical intent", async () => {
  const pkg = await withAvailableTools(["cairnstone_health"]);
  const intent = { intent_id: "sha256:" + "4".repeat(64), tool_id: "cairnstone_health", arguments: {} };

  const preview = await toolPolicyPreviewFromBody({ context_package: pkg, tool_intent: intent });
  const executed = await executeToolIntentFromBody({ context_package: pkg, tool_intent: intent }, {}, {
    invokeTool: async () => ({ ok: true }),
    createStone: async () => ({ ok: true, stone_hash: "receipt-hash-2" })
  });

  assert.equal(preview.decision_id, executed.decision_id);
});

test("V7.3.1 never invokes a mutation-class tool even though its risk_class/authorization would require_authorization", async () => {
  const pkg = await withAvailableTools(["cairnstone_commit_v2"]);
  let invoked = false;
  const result = await executeToolIntentFromBody({
    context_package: pkg,
    tool_intent: {
      tool_id: "cairnstone_commit_v2",
      arguments: { chain: "cairnstone-v6-project-memory", author: "test:fixture", content: "candidate" }
    }
  }, {}, {
    invokeTool: async () => { invoked = true; return { ok: true }; },
    createStone: async () => ({ ok: true, stone_hash: "should-not-be-called" })
  });

  assert.equal(invoked, false);
  assert.equal(result.executed, false);
  assert.equal(result.decision, "require_authorization");
  assert.equal(result.authorization_required, true);
  assert.equal(result.receipt, null);
  assert.equal(result.execution.can_execute_now, false);
});

test("V7.3.1 fails closed when the intent's tool is absent from V7.0 capability evidence", async () => {
  const pkg = await withAvailableTools(["cairnstone_health"]);
  let invoked = false;
  const result = await executeToolIntentFromBody({
    context_package: pkg,
    tool_intent: { tool_id: "cairnstone_resume_chain", arguments: { chain: "cairnstone-v6-project-memory" } }
  }, {}, {
    invokeTool: async () => { invoked = true; return {}; },
    createStone: async () => ({ ok: true, stone_hash: "unused" })
  });

  assert.equal(invoked, false);
  assert.equal(result.executed, false);
  assert.equal(result.decision, "deny");
  assert.equal(result.execution_denied_reason, "capability_not_in_context");
});

test("V7.3.1 a caller-supplied execution_allowlist can narrow but never widen the read-only-automatic set", async () => {
  const pkg = await withAvailableTools(["cairnstone_health"]);
  let invoked = false;
  const result = await executeToolIntentFromBody({
    context_package: pkg,
    tool_intent: { tool_id: "cairnstone_health", arguments: {} },
    execution_allowlist: ["cairnstone_find_v2"]
  }, {}, {
    invokeTool: async () => { invoked = true; return {}; },
    createStone: async () => ({ ok: true, stone_hash: "unused" })
  });

  assert.equal(invoked, false);
  assert.equal(result.executed, false);
  assert.equal(result.execution_denied_reason, "not_in_read_only_execution_allowlist");
});

test("V7.3.1 enforces the per-turn tool-call budget and denies without invoking once exhausted", async () => {
  const pkg = await withAvailableTools(["cairnstone_health"]);
  let invoked = false;
  const result = await executeToolIntentFromBody({
    context_package: pkg,
    tool_intent: { tool_id: "cairnstone_health", arguments: {} },
    budgets: { max_tool_calls_per_turn: 2, turn_tool_calls_so_far: 2 }
  }, {}, {
    invokeTool: async () => { invoked = true; return {}; },
    createStone: async () => ({ ok: true, stone_hash: "unused" })
  });

  assert.equal(invoked, false);
  assert.equal(result.executed, false);
  assert.equal(result.execution_denied_reason, "turn_tool_call_budget_exceeded");
});

test("V7.3.1 fails closed (not thrown) when the underlying handler invocation throws", async () => {
  const pkg = await withAvailableTools(["cairnstone_health"]);
  const result = await executeToolIntentFromBody({
    context_package: pkg,
    tool_intent: { tool_id: "cairnstone_health", arguments: {} }
  }, {}, {
    invokeTool: async () => { throw new Error("boom"); },
    createStone: async () => ({ ok: true, stone_hash: "unused" })
  });

  assert.equal(result.ok, true);
  assert.equal(result.executed, false);
  assert.equal(result.decision, "error");
  assert.equal(result.execution_denied_reason, "tool_invocation_failed");
});

test("V7.3.1 enforces the max_output_bytes budget by truncating and omitting the full result", async () => {
  const pkg = await withAvailableTools(["cairnstone_health"]);
  const bigResult = { ok: true, payload: "x".repeat(1000) };
  const result = await executeToolIntentFromBody({
    context_package: pkg,
    tool_intent: { tool_id: "cairnstone_health", arguments: {} },
    budgets: { max_output_bytes: 256 }
  }, {}, {
    invokeTool: async () => bigResult,
    createStone: async () => ({ ok: true, stone_hash: "receipt-hash-3" })
  });

  assert.equal(result.executed, true);
  assert.equal(result.output_truncated, true);
  assert.equal(result.result, null);
  assert.ok(typeof result.result_preview === "string" && result.result_preview.length > 0);
});

test("V7.3.1 re-verifies the V7.0 package hash before ever executing", async () => {
  const pkg = await withAvailableTools(["cairnstone_health"]);
  pkg.request.task = "tampered after package identity was minted";
  let invoked = false;
  const result = await executeToolIntentFromBody({
    context_package: pkg,
    tool_intent: { tool_id: "cairnstone_health", arguments: {} }
  }, {}, {
    invokeTool: async () => { invoked = true; return {}; }
  });

  assert.equal(invoked, false);
  assert.equal(result.ok, false);
  assert.equal(result.error, "invalid_context_package");
  assert.equal(result.detail, "package_id_hash_mismatch");
});

test("V7.3.1 rejects a tool intent that already claims execution", async () => {
  const pkg = await withAvailableTools(["cairnstone_health"]);
  const result = await executeToolIntentFromBody({
    context_package: pkg,
    tool_intent: { tool_id: "cairnstone_health", arguments: {}, executed: true }
  }, {}, { invokeTool: async () => ({}) });

  assert.equal(result.ok, false);
  assert.equal(result.error, "invalid_tool_intent");
  assert.equal(result.detail, "tool_intent_already_executed");
});
