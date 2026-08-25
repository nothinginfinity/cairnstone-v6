import assert from "node:assert/strict";
import { test } from "node:test";
import {
  AGENT_CONTEXT_SCHEMA,
  executeToolIntentFromBody,
  requestToolAuthorizationFromBody,
  recomputePackageId,
  TOOL_AUTHORIZATION_REQUEST_CHAIN,
  TOOL_AUTHORIZATION_REQUEST_SCHEMA,
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

test("V7.3.2 creates an immutable pending human-confirmation request without invoking the target mutation", async () => {
  const pkg = await withAvailableTools(["cairnstone_commit_v2"]);
  const intent = {
    intent_id: "sha256:" + "5".repeat(64),
    tool_id: "cairnstone_commit_v2",
    arguments: { chain: "cairnstone-v6-project-memory", author: "test:fixture", content: "candidate" }
  };
  let targetInvoked = false;
  let persisted = null;
  const result = await requestToolAuthorizationFromBody({
    context_package: pkg,
    tool_intent: intent,
    request_ir_id: "sha256:" + "6".repeat(64),
    model: { provider: "deepseek", model: "deepseek-chat" },
    turn_id: "turn:v732-test",
    justification: "Proposed canonical update; wait for explicit human approval."
  }, {}, {
    invokeTool: async () => { targetInvoked = true; return { ok: true }; },
    createStone: async body => { persisted = body; return { ok: true, stone_hash: "authorization-request-stone" }; }
  });

  assert.equal(result.ok, true);
  assert.equal(result.schema, TOOL_AUTHORIZATION_REQUEST_SCHEMA);
  assert.equal(result.request_created, true);
  assert.equal(result.decision, "require_authorization");
  assert.equal(result.required_authorization, "human_confirmation");
  assert.equal(result.authorization_request.status, "pending");
  assert.equal(result.authorization_request.authorization.consumed, false);
  assert.equal(result.authorization_request.target.tool_id, "cairnstone_commit_v2");
  assert.deepEqual(result.authorization_request.target.arguments, intent.arguments);
  assert.equal(result.execution.target_tool_invoked, false);
  assert.equal(result.execution.target_mutation_performed, false);
  assert.equal(result.execution.executed, false);
  assert.equal(result.execution.tools_executed, 0);
  assert.equal(result.policy.authorization_consumed, false);
  assert.equal(targetInvoked, false);
  assert.equal(result.receipt.chain, TOOL_AUTHORIZATION_REQUEST_CHAIN);
  assert.equal(persisted.chain, TOOL_AUTHORIZATION_REQUEST_CHAIN);
  assert.equal(persisted.set_as_head, false);
  assert.equal(persisted.metadata.status, "pending");
  assert.ok(result.authorization_request_id.startsWith("sha256:"));
});

test("V7.3.2 produces a stable authorization_request_id for the same proposed mutation", async () => {
  const pkg = await withAvailableTools(["cairnstone_commit_v2"]);
  const body = {
    context_package: pkg,
    tool_intent: { tool_id: "cairnstone_commit_v2", arguments: { chain: "x", author: "test:fixture", content: "same" } },
    request_ir_id: "sha256:" + "7".repeat(64),
    model: { provider: "workers-ai", model: "fixture" },
    turn_id: "turn:same",
    justification: "same"
  };
  const deps = { createStone: async () => ({ ok: true, stone_hash: "stone" }) };
  const first = await requestToolAuthorizationFromBody(body, {}, deps);
  const second = await requestToolAuthorizationFromBody(body, {}, deps);
  assert.equal(first.authorization_request_id, second.authorization_request_id);
  assert.equal(first.decision_id, second.decision_id);
});

test("V7.3.2 supports scoped-grant mutation requests but still performs zero target mutation", async () => {
  const pkg = await withAvailableTools(["cairnstone_send_message"]);
  let invoked = false;
  const result = await requestToolAuthorizationFromBody({
    context_package: pkg,
    tool_intent: { tool_id: "cairnstone_send_message", arguments: { from: "test:a", to: ["test:b"], content: "candidate message" } }
  }, {}, {
    invokeTool: async () => { invoked = true; return {}; },
    createStone: async () => ({ ok: true, stone_hash: "scoped-request" })
  });
  assert.equal(result.request_created, true);
  assert.equal(result.required_authorization, "scoped_grant");
  assert.equal(result.execution.target_mutation_performed, false);
  assert.equal(invoked, false);
});

test("V7.3.2 does not create an authorization request for an automatic read intent", async () => {
  const pkg = await withAvailableTools(["cairnstone_health"]);
  let persisted = false;
  const result = await requestToolAuthorizationFromBody({
    context_package: pkg,
    tool_intent: { tool_id: "cairnstone_health", arguments: {} }
  }, {}, { createStone: async () => { persisted = true; return { ok: true, stone_hash: "unused" }; } });
  assert.equal(result.ok, true);
  assert.equal(result.request_created, false);
  assert.equal(result.decision, "allow");
  assert.equal(result.authorization_request, null);
  assert.equal(result.execution.target_tool_invoked, false);
  assert.equal(persisted, false);
});

test("V7.3.2 rejects embedded approval/execute bypass fields instead of treating them as authority", async () => {
  const pkg = await withAvailableTools(["cairnstone_commit_v2"]);
  const result = await requestToolAuthorizationFromBody({
    context_package: pkg,
    tool_intent: { tool_id: "cairnstone_commit_v2", arguments: {}, confirmed: true }
  }, {}, { createStone: async () => ({ ok: true, stone_hash: "unused" }) });
  assert.equal(result.ok, false);
  assert.equal(result.error, "authorization_bypass_not_accepted");
  assert.equal(result.field, "tool_intent.confirmed");
});

test("V7.3.2 re-verifies package identity before creating a pending mutation request", async () => {
  const pkg = await withAvailableTools(["cairnstone_commit_v2"]);
  pkg.request.task = "tampered";
  let persisted = false;
  const result = await requestToolAuthorizationFromBody({
    context_package: pkg,
    tool_intent: { tool_id: "cairnstone_commit_v2", arguments: {} }
  }, {}, { createStone: async () => { persisted = true; return { ok: true, stone_hash: "unused" }; } });
  assert.equal(result.ok, false);
  assert.equal(result.error, "invalid_context_package");
  assert.equal(result.detail, "package_id_hash_mismatch");
  assert.equal(persisted, false);
});

test("V7.3.2 fails closed when the pending authorization request cannot be persisted", async () => {
  const pkg = await withAvailableTools(["cairnstone_commit_v2"]);
  const result = await requestToolAuthorizationFromBody({
    context_package: pkg,
    tool_intent: { tool_id: "cairnstone_commit_v2", arguments: {} }
  }, {}, { createStone: async () => ({ ok: false, error: "synthetic" }) });
  assert.equal(result.ok, false);
  assert.equal(result.error, "authorization_request_persist_failed");
  assert.equal(result.execution.target_mutation_performed, false);
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
