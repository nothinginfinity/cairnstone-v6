import assert from "node:assert/strict";
import { test } from "node:test";
import {
  AGENT_CONTEXT_SCHEMA,
  buildRequestIr,
  DEFAULT_MODEL_CAPABILITY_REGISTRY,
  DELEGATION_RESULT_SCHEMA,
  delegateFromBody,
  MODEL_RESULT_SCHEMA,
  modelCapabilitiesFromBody,
  modelRouteFromBody,
  recomputePackageId,
  TOOL_POLICY_DECISION_SCHEMA,
  TOOL_REGISTRY_SCHEMA,
  toolPolicyPreviewFromBody,
  toolRegistryFromBody,
  validateContextPackage,
  validateModelResultShape
} from "../src/model-router.js";

// A minimal but shape-complete V7.0 fixture package, built the same way
// agent-bootstrap.js assembles one (see hashablePayload in src/agent-bootstrap.js).
// package_id below is computed once via recomputePackageId() in a setup test
// and reused, so this fixture always has a genuinely valid, matching hash --
// not a hand-typed guess.
function baseFixturePackage() {
  return {
    ok: true,
    schema: AGENT_CONTEXT_SCHEMA,
    package_id: null, // filled in by withValidPackageId()
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

async function withValidPackageId(pkg) {
  const clone = structuredClone(pkg);
  clone.package_id = await recomputePackageId(clone);
  return clone;
}

async function withAvailableTools(toolIds) {
  const pkg = baseFixturePackage();
  pkg.capabilities.available_tools = [...toolIds];
  pkg.package_id = await recomputePackageId(pkg);
  return pkg;
}

test("V7.3.0 tool registry is normalized operational configuration with zero execution authority", () => {
  const result = toolRegistryFromBody({});
  assert.equal(result.ok, true);
  assert.equal(result.schema, TOOL_REGISTRY_SCHEMA);
  assert.equal(result.authority, "operational_configuration");
  assert.equal(result.accepted_state_authority, false);
  assert.equal(result.provider_credentials_in_registry, false);
  assert.equal(result.external_model_calls, 0);
  assert.equal(result.tools_executed, 0);
  assert.equal(result.total, 14);

  const health = result.tools.find(item => item.tool_id === "cairnstone_health");
  assert.equal(health.risk_class, "read");
  assert.equal(health.authorization, "automatic");
  assert.equal(health.available, true);
  assert.deepEqual(health.input_schema, { type: "object", properties: {}, additionalProperties: false });

  const commit = result.tools.find(item => item.tool_id === "cairnstone_commit_v2");
  assert.equal(commit.risk_class, "mutation");
  assert.equal(commit.authorization, "human_confirmation");

  const authList = result.tools.find(item => item.tool_id === "cairnstone_tool_authorization_list");
  assert.equal(authList.risk_class, "read");
  assert.equal(authList.authorization, "automatic");
  const authStatus = result.tools.find(item => item.tool_id === "cairnstone_tool_authorization_status");
  assert.equal(authStatus.risk_class, "read");
  assert.equal(authStatus.authorization, "automatic");
});

test("V7.3.0 automatic read policy can allow an intent but remains preview-only and unexecuted", async () => {
  const pkg = await withAvailableTools(["cairnstone_health"]);
  const intent = {
    intent_id: "sha256:" + "1".repeat(64),
    tool_id: "cairnstone_health",
    arguments: {},
    executed: false
  };
  const first = await toolPolicyPreviewFromBody({ context_package: pkg, tool_intent: intent });
  const second = await toolPolicyPreviewFromBody({ context_package: pkg, tool_intent: intent });

  assert.equal(first.ok, true);
  assert.equal(first.schema, TOOL_POLICY_DECISION_SCHEMA);
  assert.equal(first.package_id, pkg.package_id);
  assert.equal(first.decision, "allow");
  assert.equal(first.reason, "read_only_automatic");
  assert.equal(first.authorization_required, false);
  assert.equal(first.registry.risk_class, "read");
  assert.equal(first.evidence.capability_present, true);
  assert.equal(first.evidence.arguments_validation.ok, true);
  assert.equal(first.execution.preview_only, true);
  assert.equal(first.execution.can_execute_now, false);
  assert.equal(first.execution.executed, false);
  assert.equal(first.execution.tools_executed, 0);
  assert.equal(first.policy.model_intent_is_execution_authority, false);
  assert.equal(first.policy.execution_authority, false);
  assert.equal(first.policy.mutation_authority, false);
  assert.equal(first.decision_id, second.decision_id);
});

test("V7.3.0 denies a registered read tool that was not present in the V7.0 capability evidence", async () => {
  const pkg = await withAvailableTools(["cairnstone_health"]);
  const result = await toolPolicyPreviewFromBody({
    context_package: pkg,
    tool_intent: {
      tool_id: "cairnstone_resume_chain",
      arguments: { chain: "cairnstone-v6-project-memory" },
      executed: false
    }
  });
  assert.equal(result.ok, true);
  assert.equal(result.decision, "deny");
  assert.equal(result.reason, "capability_not_in_context");
  assert.equal(result.evidence.capability_present, false);
  assert.equal(result.execution.tools_executed, 0);
});

test("V7.3.0 mutation intent requires authorization even when the V7.0 package exposes the capability", async () => {
  const pkg = await withAvailableTools(["cairnstone_commit_v2"]);
  const result = await toolPolicyPreviewFromBody({
    context_package: pkg,
    tool_intent: {
      intent_id: "sha256:" + "2".repeat(64),
      tool_id: "cairnstone_commit_v2",
      arguments: { chain: "cairnstone-v6-project-memory", author: "test:fixture", content: "candidate" },
      executed: false
    }
  });
  assert.equal(result.ok, true);
  assert.equal(result.decision, "require_authorization");
  assert.equal(result.reason, "human_confirmation");
  assert.equal(result.authorization_required, true);
  assert.equal(result.registry.risk_class, "mutation");
  assert.equal(result.execution.can_execute_now, false);
  assert.equal(result.execution.executed, false);
  assert.equal(result.policy.mutation_authority, false);
});

test("V7.3.0 validates registered JSON input schema before any tool could become eligible", async () => {
  const pkg = await withAvailableTools(["cairnstone_resume_chain"]);
  const result = await toolPolicyPreviewFromBody({
    context_package: pkg,
    tool_intent: {
      tool_id: "cairnstone_resume_chain",
      arguments: {},
      executed: false
    }
  });
  assert.equal(result.ok, true);
  assert.equal(result.decision, "deny");
  assert.equal(result.reason, "arguments_invalid");
  assert.equal(result.evidence.arguments_validation.error, "arguments_missing_required");
  assert.deepEqual(result.evidence.arguments_validation.missing, ["chain"]);
  assert.equal(result.execution.tools_executed, 0);
});

test("V7.3.0 rejects any tool intent that already claims execution", async () => {
  const pkg = await withAvailableTools(["cairnstone_health"]);
  const result = await toolPolicyPreviewFromBody({
    context_package: pkg,
    tool_intent: { tool_id: "cairnstone_health", arguments: {}, executed: true }
  });
  assert.equal(result.ok, false);
  assert.equal(result.error, "invalid_tool_intent");
  assert.equal(result.detail, "tool_intent_already_executed");
});

test("V7.3.0 re-verifies the V7.0 package hash before issuing a policy decision", async () => {
  const pkg = await withAvailableTools(["cairnstone_health"]);
  pkg.request.task = "tampered after package identity was minted";
  const result = await toolPolicyPreviewFromBody({
    context_package: pkg,
    tool_intent: { tool_id: "cairnstone_health", arguments: {}, executed: false }
  });
  assert.equal(result.ok, false);
  assert.equal(result.error, "invalid_context_package");
  assert.equal(result.detail, "package_id_hash_mismatch");
  assert.equal(result.stage, "context_package");
});

test("V7.2 delegate carries the V7.0 package server-side and returns a compact read-only result", async () => {
  const pkg = await withValidPackageId(baseFixturePackage());
  let bootstrapArgs = null;
  const result = await delegateFromBody({
    actor_id: "test:delegate",
    task: "Summarize the accepted state.",
    chain: "cairnstone-v6-project-memory",
    route: { provider: "mock-a", model: "mock-a/text-tools-v1" },
    generation: { max_output_tokens: 256, temperature: 0 }
  }, {}, {
    agentBootstrapFromBody: async args => { bootstrapArgs = args; return pkg; },
    modelRouteFromBody
  });
  assert.equal(result.ok, true);
  assert.equal(result.schema, DELEGATION_RESULT_SCHEMA);
  assert.equal(result.package_id, pkg.package_id);
  assert.match(result.request_ir_id, /^sha256:[0-9a-f]{64}$/);
  assert.equal(result.route.provider, "mock-a");
  assert.equal(result.policy.delegation_mode, "read_only");
  assert.equal(result.policy.execution_authority, false);
  assert.equal(result.policy.mutation_authority, false);
  assert.equal(result.policy.tools_exposed_to_model, 0);
  assert.equal(result.policy.tools_executed, 0);
  assert.equal(result.diagnostics.context_package_returned, false);
  assert.equal(result.diagnostics.server_carried_context_package, true);
  assert.equal(Object.prototype.hasOwnProperty.call(result, "context_package"), false);
  assert.deepEqual(bootstrapArgs.capabilities.tools, []);
  assert.equal(bootstrapArgs.capabilities.supports_tool_calls, false);
});

test("V7.2 delegate forces a tool-free router request and clamps its output budget", async () => {
  const pkg = await withValidPackageId(baseFixturePackage());
  let routedBody = null;
  const result = await delegateFromBody({
    actor_id: "test:delegate", task: "Read only.", chain: "cairnstone-v6-project-memory",
    route: { provider: "mock-a", model: "mock-a/text-tools-v1" },
    generation: { max_output_tokens: 999999, temperature: 9 }
  }, {}, {
    agentBootstrapFromBody: async () => pkg,
    modelRouteFromBody: async body => {
      routedBody = body;
      return {
        ok: true, package_id: pkg.package_id, request_ir_id: "sha256:" + "7".repeat(64),
        route: { provider: "mock-a", model: "mock-a/text-tools-v1", transport: "mock", credential_mode: "none", failover_policy: "none" },
        output: { text: "ok", tool_intents: [], finish_reason: "stop" },
        usage: { input_tokens: 1, output_tokens: 1, cost: null },
        observability: { gateway_id: null, gateway_request_id: null, attempts: [] },
        policy: { tool_intents_only: true, execution_authority: false, mutation_authority: false },
        v7_1_1: { external_model_calls: 0, tools_executed: 0 }
      };
    }
  });
  assert.equal(result.ok, true);
  assert.deepEqual(routedBody.request.tools, []);
  assert.equal(routedBody.request.generation.max_output_tokens, 2048);
  assert.equal(routedBody.request.generation.temperature, 2);
});

test("V7.2 delegate fails closed if a routed model somehow returns a tool intent", async () => {
  const pkg = await withValidPackageId(baseFixturePackage());
  const result = await delegateFromBody({
    actor_id: "test:delegate", task: "Read only.", chain: "cairnstone-v6-project-memory",
    route: { provider: "mock-a", model: "mock-a/text-tools-v1" }
  }, {}, {
    agentBootstrapFromBody: async () => pkg,
    modelRouteFromBody: async () => ({
      ok: true, package_id: pkg.package_id, request_ir_id: "sha256:" + "8".repeat(64),
      route: { provider: "mock-a", model: "mock-a/text-tools-v1", transport: "mock", credential_mode: "none", failover_policy: "none" },
      output: { text: "", tool_intents: [{ tool_id: "cairnstone_health", executed: false }], finish_reason: "tool_calls" },
      usage: { input_tokens: 1, output_tokens: 1, cost: null }, observability: { attempts: [] },
      policy: { tool_intents_only: true, execution_authority: false, mutation_authority: false }
    })
  });
  assert.equal(result.ok, false);
  assert.equal(result.error, "delegation_tool_intent_forbidden");
  assert.equal(result.policy.execution_authority, false);
  assert.equal(result.policy.tools_executed, 0);
});

test("V7.2 delegate stops after a bootstrap failure and never calls the router", async () => {
  let routed = false;
  const result = await delegateFromBody({
    actor_id: "test:delegate", task: "Read only.", chain: "missing-chain",
    route: { provider: "mock-a", model: "mock-a/text-tools-v1" }
  }, {}, {
    agentBootstrapFromBody: async () => ({ ok: false, error: "chain_not_found" }),
    modelRouteFromBody: async () => { routed = true; return { ok: true }; }
  });
  assert.equal(result.ok, false);
  assert.equal(result.error, "delegation_bootstrap_failed");
  assert.equal(result.detail, "chain_not_found");
  assert.equal(routed, false);
});

async function profileBootstrapFixture(args) {
  const pkg = baseFixturePackage();
  pkg.actor.actor_id = args.actor_id;
  pkg.request.task = args.task;
  pkg.request.chain = args.chain;
  pkg.capabilities.available_tools = Array.isArray(args.capabilities?.tools)
    ? args.capabilities.tools.filter(item => item?.available !== false && item?.id).map(item => item.id)
    : [];
  pkg.capabilities.supports_tool_calls = args.capabilities?.supports_tool_calls === true;
  pkg.package_id = await recomputePackageId(pkg);
  return pkg;
}

function successfulProfileRoute(pkg, captured) {
  captured.contextPackage = pkg;
  return {
    ok: true,
    package_id: pkg.package_id,
    request_ir_id: "sha256:" + "9".repeat(64),
    route: { provider: "mock-a", model: "mock-a/text-tools-v1", transport: "mock", credential_mode: "none", failover_policy: "none" },
    output: { text: "grounded current authorization answer", tool_intents: [], finish_reason: "stop" },
    usage: { input_tokens: 1, output_tokens: 1, cost: null },
    observability: { gateway_id: null, gateway_request_id: null, attempts: [] },
    policy: { tool_intents_only: true, execution_authority: false, mutation_authority: false },
    v7_1_1: { external_model_calls: 0, tools_executed: 0 }
  };
}

test("V7.4.0 cairnstone-maintainer grounds the exact acceptance prompt from a governed live read before routing", async () => {
  const events = [];
  const captured = {};
  const successfulId = "sha256:f4b341051dfa51f53c3370d3afaffaf7d53fb5ab8af53d01dae2f58c2ccd0fd3";
  const staleId = "sha256:ea7eb9e1c1f8775d8da469c47db75d2a173faee4f72e974d9db0f014af2a32d8";
  const result = await delegateFromBody({
    actor_id: "test:caller",
    profile_id: "cairnstone-maintainer",
    task: "What are the most recent authorizations I approved",
    chain: "cairnstone-v6-project-memory",
    route: { provider: "mock-a", model: "mock-a/text-tools-v1" }
  }, {}, {
    agentBootstrapFromBody: async args => { events.push(`bootstrap:${args.capabilities?.supports_tool_calls === true ? "grounding" : "final"}`); return profileBootstrapFixture(args); },
    executeReadToolIntent: async body => {
      events.push("live-read");
      assert.equal(body.tool_intent.tool_id, "cairnstone_tool_authorization_list");
      assert.deepEqual(body.tool_intent.arguments, { decision: "approved", limit: 5 });
      return {
        ok: true,
        executed: true,
        result: {
          ok: true,
          schema: "cairnstone-tool-authorization-list-v1",
          total: 2,
          filters: { status: null, decision: "approved", limit: 5 },
          authorizations: [
            { authorization_request_id: successfulId, tool_id: "cairnstone_commit_v2", status: "executed", decision: "approved", consumed: true, terminal: true, execution_receipt_stone_hash: "53685e9fb761c573c7b4fbb989cc215201122f021a5f3b9555fb0ddcc11afcba", outcome: { executed: true, mutation_performed: true, error: null } },
            { authorization_request_id: staleId, tool_id: "cairnstone_commit_v2", status: "guard_failed", decision: "approved", consumed: true, terminal: true, execution_receipt_stone_hash: "c121ea6f687fcb7ff444ed8d90e1a72bb172c24a12f8209c4a893ec0d60f8c91", outcome: { executed: false, mutation_performed: false, error: "authorization_guard_mismatch" } }
          ]
        },
        receipt: { stone_hash: "read-receipt-stone", chain: "cairnstone-v7-tool-execution-receipts" }
      };
    },
    modelRouteFromBody: async body => { events.push("route"); return successfulProfileRoute(body.context_package, captured); }
  });

  assert.equal(result.ok, true);
  assert.deepEqual(events, ["bootstrap:grounding", "live-read", "bootstrap:final", "route"]);
  assert.equal(result.profile.profile_id, "cairnstone-maintainer");
  assert.equal(result.profile.execution_authority, false);
  assert.equal(result.profile.mutation_authority, false);
  assert.equal(result.grounding.classification.grounding_class, "operational_current");
  assert.equal(result.grounding.current_claim_source, "live_operational_read");
  assert.equal(result.grounding.live_reads_executed, 1);
  assert.equal(result.grounding.read_receipts[0].stone_hash, "read-receipt-stone");
  assert.equal(result.grounding.live_reads[0].authorizations[0].authorization_request_id, successfulId);
  assert.equal(result.grounding.live_reads[0].authorizations[1].authorization_request_id, staleId);
  assert.equal(result.policy.tools_exposed_to_model, 0);
  assert.equal(result.policy.tools_executed, 1);
  assert.equal(result.policy.execution_authority, false);
  assert.equal(result.policy.mutation_authority, false);
  assert.match(captured.contextPackage.request.task, /LIVE_OPERATIONAL_READ/);
  assert.match(captured.contextPackage.request.task, new RegExp(successfulId));
  assert.match(captured.contextPackage.request.task, new RegExp(staleId));
  assert.deepEqual(captured.contextPackage.capabilities.available_tools, []);
  assert.equal(captured.contextPackage.capabilities.supports_tool_calls, false);
});

test("V7.4.0 operational-current profile query fails closed before routing when live read execution is unavailable", async () => {
  let routed = false;
  const result = await delegateFromBody({
    actor_id: "test:caller",
    profile_id: "cairnstone-maintainer",
    task: "What are the most recent authorizations I approved",
    chain: "cairnstone-v6-project-memory",
    route: { provider: "mock-a", model: "mock-a/text-tools-v1" }
  }, {}, {
    agentBootstrapFromBody: profileBootstrapFixture,
    modelRouteFromBody: async () => { routed = true; return { ok: true }; }
  });
  assert.equal(result.ok, false);
  assert.equal(result.error, "profile_live_read_unavailable");
  assert.equal(result.grounding.degraded, true);
  assert.equal(routed, false);
});

test("V7.4.0 maintainer profile fails closed outside its accepted chain scope", async () => {
  let bootstrapped = false;
  const result = await delegateFromBody({
    actor_id: "test:caller",
    profile_id: "cairnstone-maintainer",
    task: "What are the most recent authorizations I approved",
    chain: "other-project-chain",
    route: { provider: "mock-a", model: "mock-a/text-tools-v1" }
  }, {}, {
    agentBootstrapFromBody: async args => { bootstrapped = true; return profileBootstrapFixture(args); },
    executeReadToolIntent: async () => ({ ok: true, executed: true }),
    modelRouteFromBody: async () => ({ ok: true })
  });
  assert.equal(result.ok, false);
  assert.equal(result.error, "agent_profile_scope_mismatch");
  assert.equal(bootstrapped, false);
});

test("V7.4 repo-debugger (a second registry profile) grounds a repo-drift question via cairnstone_reconcile_repo", async () => {
  const events = [];
  const captured = {};
  const result = await delegateFromBody({
    actor_id: "test:caller",
    profile_id: "repo-debugger",
    task: "Is cairnstone-v6-project-memory currently drifted from GitHub?",
    chain: "cairnstone-v6-project-memory",
    route: { provider: "mock-a", model: "mock-a/text-tools-v1" }
  }, {}, {
    agentBootstrapFromBody: async args => { events.push(`bootstrap:${args.capabilities?.supports_tool_calls === true ? "grounding" : "final"}`); return profileBootstrapFixture(args); },
    executeReadToolIntent: async body => {
      events.push("live-read");
      assert.equal(body.tool_intent.tool_id, "cairnstone_reconcile_repo");
      assert.deepEqual(body.tool_intent.arguments, { chain: "cairnstone-v6-project-memory" });
      return { ok: true, executed: true, result: { ok: true, added: [], changed: [], removed: [], in_sync: [] } };
    },
    modelRouteFromBody: async body => { events.push("route"); return successfulProfileRoute(body.context_package, captured); }
  });

  assert.equal(result.ok, true);
  assert.deepEqual(events, ["bootstrap:grounding", "live-read", "bootstrap:final", "route"]);
  assert.equal(result.profile.profile_id, "repo-debugger");
  assert.equal(result.grounding.classification.grounding_class, "operational_current");
  assert.equal(result.grounding.classification.domain, "repo_state");
  assert.equal(result.grounding.classification.matched_rule, "repo_drift_live_check");
  assert.equal(result.grounding.live_reads_executed, 1);
  assert.equal(result.policy.execution_authority, false);
  assert.equal(result.policy.mutation_authority, false);
});

test("V7.4.1 repo-debugger reuses one durable profile on praxiq-call and still fails closed on unlisted chains", async () => {
  const events = [];
  const captured = {};
  const allowed = await delegateFromBody({
    actor_id: "test:caller",
    profile_id: "repo-debugger",
    task: "Is praxiq-call currently drifted from GitHub?",
    chain: "praxiq-call",
    route: { provider: "mock-a", model: "mock-a/text-tools-v1" }
  }, {}, {
    agentBootstrapFromBody: async args => { events.push(`bootstrap:${args.capabilities?.supports_tool_calls === true ? "grounding" : "final"}`); return profileBootstrapFixture(args); },
    executeReadToolIntent: async body => {
      events.push("live-read");
      assert.equal(body.tool_intent.tool_id, "cairnstone_reconcile_repo");
      assert.deepEqual(body.tool_intent.arguments, { chain: "praxiq-call" });
      return {
        ok: true,
        executed: true,
        result: {
          ok: true,
          repo: "nothinginfinity/PraXiQ-call",
          observed_commit_sha: "05e6f0e40c95d7f217fa1550bdb098923b300c81",
          snapshot: { immutable: true, tree_truncated: false, observed_files: 10, accepted_paths: 7 },
          summary: { added: 3, changed: 1, removed: 0, in_sync: 6, unknown: 0, total_paths: 10, drifted: 4 },
          tuples: [
            { path: ".github/workflows/deploy.yml", drift_type: "added", current_stone_hash: null, accepted_commit_sha: null, observed_commit_sha: "05e6f0e40c95d7f217fa1550bdb098923b300c81" },
            { path: "src/index.js", drift_type: "changed", current_stone_hash: "3b164a1e", accepted_commit_sha: "f1adaf2da5bee3303e22e88c02fac1e18ac6374e", observed_commit_sha: "05e6f0e40c95d7f217fa1550bdb098923b300c81" }
          ],
          read_only: { chain_heads_written: false, path_heads_written: false, stones_written: false }
        }
      };
    },
    modelRouteFromBody: async body => { events.push("route"); return successfulProfileRoute(body.context_package, captured); }
  });

  assert.equal(allowed.ok, true);
  assert.deepEqual(events, ["bootstrap:grounding", "live-read", "bootstrap:final", "route"]);
  assert.equal(allowed.profile.profile_id, "repo-debugger");
  assert.equal(allowed.profile.version, "0.1.1");
  assert.deepEqual(allowed.profile.scope.allowed_chains, ["praxiq-call"]);
  assert.equal(allowed.grounding.classification.matched_rule, "repo_drift_live_check");
  assert.equal(allowed.grounding.live_reads_executed, 1);
  assert.equal(allowed.grounding.live_reads[0].summary.drifted, 4);
  assert.equal(allowed.grounding.live_reads[0].drifted, true);
  assert.equal(allowed.grounding.live_reads[0].tuples[0].drift_type, "added");
  assert.equal(allowed.policy.tools_exposed_to_model, 0);
  assert.equal(allowed.policy.tools_executed, 1);
  assert.equal(allowed.policy.execution_authority, false);
  assert.equal(allowed.policy.mutation_authority, false);
  assert.deepEqual(captured.contextPackage.capabilities.available_tools, []);
  assert.equal(captured.contextPackage.capabilities.supports_tool_calls, false);
  assert.match(captured.contextPackage.request.task, /\"drifted\":4/);
  assert.match(captured.contextPackage.request.task, /src\\/index\\.js/);

  let touched = false;
  const denied = await delegateFromBody({
    actor_id: "test:caller",
    profile_id: "repo-debugger",
    task: "Is this chain currently drifted from GitHub?",
    chain: "unlisted-project-chain",
    route: { provider: "mock-a", model: "mock-a/text-tools-v1" }
  }, {}, {
    agentBootstrapFromBody: async args => { touched = true; return profileBootstrapFixture(args); },
    executeReadToolIntent: async () => { touched = true; return { ok: true, executed: true }; },
    modelRouteFromBody: async () => { touched = true; return { ok: true }; }
  });
  assert.equal(denied.ok, false);
  assert.equal(denied.error, "agent_profile_scope_mismatch");
  assert.equal(touched, false);
});

test("V7.4 release-reviewer (a third registry profile) grounds a doc-freshness question via cairnstone_get_source_freshness", async () => {
  const events = [];
  const result = await delegateFromBody({
    actor_id: "test:caller",
    profile_id: "release-reviewer",
    task: "Is docs/ROADMAP_V7.md still current on GitHub?",
    chain: "cairnstone-v6-project-memory",
    route: { provider: "mock-a", model: "mock-a/text-tools-v1" }
  }, {}, {
    agentBootstrapFromBody: async args => { events.push("bootstrap"); return profileBootstrapFixture(args); },
    executeReadToolIntent: async body => {
      events.push("live-read");
      assert.equal(body.tool_intent.tool_id, "cairnstone_get_source_freshness");
      assert.deepEqual(body.tool_intent.arguments, { chain: "cairnstone-v6-project-memory", path: "docs/ROADMAP_V7.md" });
      return { ok: true, executed: true, result: { ok: true, checked: true, drifted: false } };
    },
    modelRouteFromBody: async body => successfulProfileRoute(body.context_package, {})
  });

  assert.equal(result.ok, true);
  assert.equal(result.profile.profile_id, "release-reviewer");
  assert.equal(result.grounding.classification.matched_rule, "release_doc_freshness_check");
  assert.equal(result.grounding.classification.extracted_value, "docs/ROADMAP_V7.md");
});

test("V7.4 an unregistered profile_id fails closed without touching bootstrap or routing", async () => {
  let touched = false;
  const result = await delegateFromBody({
    actor_id: "test:caller",
    profile_id: "not-a-real-profile",
    task: "anything",
    chain: "cairnstone-v6-project-memory",
    route: { provider: "mock-a", model: "mock-a/text-tools-v1" }
  }, {}, {
    agentBootstrapFromBody: async args => { touched = true; return profileBootstrapFixture(args); },
    modelRouteFromBody: async () => { touched = true; return { ok: true }; }
  });
  assert.equal(result.ok, false);
  assert.equal(result.error, "agent_profile_not_found");
  assert.equal(touched, false);
});

test("R1: a genuinely valid V7.0 package is accepted", async () => {
  const pkg = await withValidPackageId(baseFixturePackage());
  const result = await validateContextPackage(pkg);
  assert.equal(result.ok, true);
});

test("R1: a tampered package_id fails closed", async () => {
  const pkg = await withValidPackageId(baseFixturePackage());
  pkg.package_id = "sha256:" + "0".repeat(64); // syntactically valid, wrong value
  const result = await validateContextPackage(pkg);
  assert.equal(result.ok, false);
  assert.equal(result.error, "invalid_context_package");
  assert.equal(result.detail, "package_id_hash_mismatch");
});

test("R1: a package whose content was tampered after hashing fails closed", async () => {
  const pkg = await withValidPackageId(baseFixturePackage());
  pkg.request.task = "a different task the hash was never computed over";
  const result = await validateContextPackage(pkg);
  assert.equal(result.ok, false);
  assert.equal(result.detail, "package_id_hash_mismatch");
});

test("R1: execution_authority:true in policy fails closed even with a correct hash", async () => {
  const pkg = baseFixturePackage();
  pkg.policy.execution_authority = true;
  pkg.package_id = await recomputePackageId(pkg); // hash matches, but policy itself is disqualifying
  const result = await validateContextPackage(pkg);
  assert.equal(result.ok, false);
  assert.equal(result.detail, "execution_authority_not_false");
});

test("R2: identical package + identical provider-neutral settings yields identical request_ir_id", async () => {
  const pkg = await withValidPackageId(baseFixturePackage());
  const first = await buildRequestIr(pkg, { tools: ["cairnstone_health"], generation: { max_output_tokens: 800, temperature: 0.1 } });
  const second = await buildRequestIr(pkg, { tools: ["cairnstone_health"], generation: { max_output_tokens: 800, temperature: 0.1 } });
  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  assert.equal(first.value.request_ir_id, second.value.request_ir_id);
});

test("provider identity is not accepted by buildRequestIr and cannot affect request_ir_id", async () => {
  const pkg = await withValidPackageId(baseFixturePackage());
  const withoutProviderField = await buildRequestIr(pkg, { tools: ["cairnstone_health"] });
  // Even if a caller mistakenly stuffs provider/model into options, buildRequestIr
  // has no code path that reads them, so the IR (and its id) must be unaffected.
  const withExtraneousProviderHint = await buildRequestIr(pkg, {
    tools: ["cairnstone_health"],
    provider: "anthropic",
    model: "claude-opus-4-8",
    credential: { mode: "byok", alias: "default" }
  });
  assert.equal(withoutProviderField.ok, true);
  assert.equal(withExtraneousProviderHint.ok, true);
  assert.equal(withoutProviderField.value.request_ir_id, withExtraneousProviderHint.value.request_ir_id);
  assert.equal(withExtraneousProviderHint.value.provider, undefined);
  assert.equal(withExtraneousProviderHint.value.model, undefined);
});

test("changing generation parameters changes request_ir_id (it is part of the effective request)", async () => {
  const pkg = await withValidPackageId(baseFixturePackage());
  const a = await buildRequestIr(pkg, { generation: { max_output_tokens: 800, temperature: 0.1 } });
  const b = await buildRequestIr(pkg, { generation: { max_output_tokens: 1600, temperature: 0.1 } });
  assert.notEqual(a.value.request_ir_id, b.value.request_ir_id);
});

test("buildRequestIr rejects an invalid package before doing any IR work", async () => {
  const pkg = await withValidPackageId(baseFixturePackage());
  pkg.policy.mutation_authority = true;
  const result = await buildRequestIr(pkg, {});
  assert.equal(result.ok, false);
  assert.equal(result.error, "invalid_context_package");
});

test("validateModelResultShape accepts a well-formed unexecuted-tool-intent result", () => {
  const result = validateModelResultShape({
    ok: true,
    schema: MODEL_RESULT_SCHEMA,
    package_id: "sha256:" + "1".repeat(64),
    request_ir_id: "sha256:" + "2".repeat(64),
    route: { provider: "anthropic", model: "claude-opus-4-8", transport: "ai-rest-chat", credential_mode: "byok", failover_policy: "none" },
    output: { text: "ok", tool_intents: [{ intent_id: "sha256:" + "3".repeat(64), tool_id: "cairnstone_health", arguments: {}, policy: { intent_only: true, executed: false, execution_authority: false, mutation_authority: false } }], finish_reason: "stop" },
    usage: { input_tokens: 10, output_tokens: 5, cost: null },
    observability: { gateway_id: null, gateway_request_id: null, attempts: [] },
    policy: { tool_intents_only: true, execution_authority: false, mutation_authority: false }
  });
  assert.equal(result.ok, true);
});

test("validateModelResultShape rejects a result claiming a tool intent was executed", () => {
  const result = validateModelResultShape({
    schema: MODEL_RESULT_SCHEMA,
    package_id: "sha256:" + "1".repeat(64),
    request_ir_id: "sha256:" + "2".repeat(64),
    output: { tool_intents: [{ executed: true }] },
    policy: { tool_intents_only: true, execution_authority: false, mutation_authority: false }
  });
  assert.equal(result.ok, false);
  assert.equal(result.detail, "tool_intent_marked_executed");
});

test("V7.1.1 capability registry is operational configuration, not accepted-state authority", () => {
  const result = modelCapabilitiesFromBody({});
  assert.equal(result.ok, true);
  assert.equal(result.schema, "cairnstone-model-capabilities-v1");
  assert.equal(result.authority, "operational_configuration");
  assert.equal(result.accepted_state_authority, false);
  assert.equal(result.external_model_calls, 0);
  assert.equal(result.total, 12);
  assert.deepEqual(result.models.map(item => item.provider).sort(), ["anthropic", "cerebras", "deepseek", "grok", "groq", "kimi", "mistral", "mock-a", "mock-b", "openai", "sambanova", "workers-ai"]);
  assert.equal(DEFAULT_MODEL_CAPABILITY_REGISTRY.length, 12);
  const workersAi = result.models.find(item => item.provider === "workers-ai");
  assert.equal(workersAi.model, "@cf/meta/llama-3.3-70b-instruct-fp8-fast");
  assert.equal(workersAi.supports.tool_calls, true);
  assert.equal(result.external_model_calls, 0);
});

test("V7.1.1 mock A/B preserve package_id and request_ir_id end-to-end", async () => {
  const pkg = await withValidPackageId(baseFixturePackage());
  const request = { tools: ["cairnstone_health"], generation: { max_output_tokens: 800, temperature: 0.1 } };
  const a = await modelRouteFromBody({
    context_package: pkg,
    route: { provider: "mock-a", model: "mock-a/text-tools-v1" },
    request
  });
  const b = await modelRouteFromBody({
    context_package: pkg,
    route: { provider: "mock-b", model: "mock-b/text-tools-v1" },
    request
  });

  assert.equal(a.ok, true);
  assert.equal(b.ok, true);
  assert.equal(a.package_id, pkg.package_id);
  assert.equal(b.package_id, pkg.package_id);
  assert.equal(a.request_ir_id, b.request_ir_id);
  assert.notEqual(a.route.provider, b.route.provider);
  assert.equal(a.v7_1_1.external_model_calls, 0);
  assert.equal(b.v7_1_1.external_model_calls, 0);
  assert.equal(a.v7_1_1.tools_executed, 0);
  assert.equal(b.v7_1_1.tools_executed, 0);
  assert.equal(a.policy.execution_authority, false);
  assert.equal(b.policy.mutation_authority, false);
  assert.equal(a.observability.attempts[0].mock, true);
  assert.equal(b.observability.attempts[0].mock, true);
});

test("V7.1.1 unsupported provider fails typed after package/IR identities are established", async () => {
  const pkg = await withValidPackageId(baseFixturePackage());
  const result = await modelRouteFromBody({
    context_package: pkg,
    route: { provider: "not-a-provider", model: "not-a-provider/model" },
    request: { tools: ["cairnstone_health"] }
  });
  assert.equal(result.ok, false);
  assert.equal(result.error, "provider_not_supported");
  assert.equal(result.package_id, pkg.package_id);
  assert.match(result.request_ir_id, /^sha256:[0-9a-f]{64}$/);
});

test("V7.1.1 capability mismatch fails before adapter invocation", async () => {
  const pkg = await withValidPackageId(baseFixturePackage());
  const registry = [{
    provider: "mock-no-tools",
    model: "mock-no-tools/text-v1",
    transport: "mock",
    supports: { text: true, streaming: false, tool_calls: false, reasoning: false, vision: false },
    context_window: 32768,
    max_output_tokens: 4096,
    status: "available",
    observed_at: "2026-08-24T00:00:00.000Z"
  }];
  const result = await modelRouteFromBody({
    context_package: pkg,
    route: { provider: "mock-no-tools", model: "mock-no-tools/text-v1" },
    request: { tools: ["cairnstone_health"] }
  }, null, { registry, adapters: {} });
  assert.equal(result.ok, false);
  assert.equal(result.error, "model_capability_mismatch");
  assert.deepEqual(result.missing, ["tool_calls"]);
});

test("V7.1.1 rejects credential material at the router boundary", async () => {
  const pkg = await withValidPackageId(baseFixturePackage());
  const result = await modelRouteFromBody({
    context_package: pkg,
    route: { provider: "mock-a", model: "mock-a/text-tools-v1", credential: { mode: "byok", secret: "must-not-enter-router" } },
    request: { tools: ["cairnstone_health"] }
  });
  assert.equal(result.ok, false);
  assert.equal(result.error, "provider_auth_failed");
  assert.equal(result.detail, "credential_material_not_accepted_in_router");
  assert.equal(JSON.stringify(result).includes("must-not-enter-router"), false);
});

test("V7.1.4 rejects unsupported failover modes", async () => {
  const pkg = await withValidPackageId(baseFixturePackage());
  const result = await modelRouteFromBody({
    context_package: pkg,
    route: { provider: "mock-a", model: "mock-a/text-tools-v1", failover: { mode: "automatic" } },
    request: { tools: ["cairnstone_health"] }
  });
  assert.equal(result.ok, false);
  assert.equal(result.error, "unsupported_route_policy");
  assert.equal(result.detail, "failover_mode_not_supported");
});

test("V7.1.1 adapter errors normalize without losing package/request identities", async () => {
  const pkg = await withValidPackageId(baseFixturePackage());
  const throwingAdapter = {
    can_handle: () => ({ ok: true }),
    encode: requestIr => ({ request_ir_id: requestIr.request_ir_id }),
    invoke: async () => { throw new Error("synthetic timeout"); },
    normalize: () => { throw new Error("unreachable"); },
    normalize_error: (_error, route, requestIr) => ({
      ok: false,
      error: "provider_timeout",
      provider: route.provider,
      model: route.model,
      package_id: requestIr.package_id,
      request_ir_id: requestIr.request_ir_id
    })
  };
  const result = await modelRouteFromBody({
    context_package: pkg,
    route: { provider: "mock-a", model: "mock-a/text-tools-v1" },
    request: { tools: ["cairnstone_health"] }
  }, null, { adapters: { "mock-a": throwingAdapter } });
  assert.equal(result.ok, false);
  assert.equal(result.error, "provider_timeout");
  assert.equal(result.package_id, pkg.package_id);
  assert.match(result.request_ir_id, /^sha256:[0-9a-f]{64}$/);
});

test("V7.1.2 Workers AI adapter invokes AI binding through Gateway and normalizes text + telemetry", async () => {
  const pkg = await withValidPackageId(baseFixturePackage());
  const calls = [];
  const ai = {
    aiGatewayLogId: "gw-log-test",
    run: async (model, input, options) => {
      calls.push({ model, input, options });
      return { response: "workers-ai-ok", usage: { prompt_tokens: 11, completion_tokens: 4 } };
    }
  };
  const result = await modelRouteFromBody({
    context_package: pkg,
    route: { provider: "workers-ai", model: "@cf/meta/llama-3.3-70b-instruct-fp8-fast" },
    request: { tools: [], generation: { max_output_tokens: 128, temperature: 0 } }
  }, { AI: ai });

  assert.equal(result.ok, true);
  assert.equal(result.package_id, pkg.package_id);
  assert.equal(result.route.provider, "workers-ai");
  assert.equal(result.route.credential_mode, "workers_ai_billing");
  assert.equal(result.output.text, "workers-ai-ok");
  assert.equal(result.observability.gateway_id, "default");
  assert.equal(result.observability.gateway_request_id, "gw-log-test");
  assert.equal(result.v7_1_2.external_model_calls, 1);
  assert.equal(result.v7_1_2.tools_executed, 0);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].model, "@cf/meta/llama-3.3-70b-instruct-fp8-fast");
  assert.equal(calls[0].options.gateway.id, "default");
  assert.equal(calls[0].options.gateway.skipCache, true);
  assert.equal(calls[0].options.gateway.collectLog, true);
  assert.deepEqual(Object.keys(calls[0].options.gateway.metadata).sort(), ["model", "package_id", "provider", "request_ir_id"]);
  assert.equal(calls[0].options.gateway.metadata.package_id, pkg.package_id);
  assert.equal(result.policy.execution_authority, false);
  assert.equal(result.policy.mutation_authority, false);
});

test("V7.1.2 Workers AI tool call becomes a validated unexecuted CairnStone intent", async () => {
  const pkg = await withValidPackageId(baseFixturePackage());
  const ai = {
    aiGatewayLogId: "gw-log-tools",
    run: async () => ({
      response: "",
      tool_calls: [{ name: "cs_0_cairnstone_health", arguments: {} }]
    })
  };
  const result = await modelRouteFromBody({
    context_package: pkg,
    route: { provider: "workers-ai", model: "@cf/meta/llama-3.3-70b-instruct-fp8-fast" },
    request: { tools: ["cairnstone_health"], generation: { max_output_tokens: 128, temperature: 0 } }
  }, { AI: ai });

  assert.equal(result.ok, true);
  assert.equal(result.output.tool_intents.length, 1);
  const intent = result.output.tool_intents[0];
  assert.equal(intent.tool_id, "cairnstone_health");
  assert.deepEqual(intent.arguments, {});
  assert.equal(intent.validation.ok, true);
  assert.equal(intent.executed, false);
  assert.equal(intent.policy.intent_only, true);
  assert.equal(intent.policy.execution_authority, false);
  assert.equal(intent.policy.mutation_authority, false);
  assert.equal(result.v7_1_2.tools_executed, 0);
});

test("V7.1.2 gateway route metadata changes transport evidence but never request_ir_id", async () => {
  const pkg = await withValidPackageId(baseFixturePackage());
  const makeAi = logId => ({ aiGatewayLogId: logId, run: async () => ({ response: "ok" }) });
  const request = { tools: [], generation: { max_output_tokens: 128, temperature: 0 } };
  const a = await modelRouteFromBody({
    context_package: pkg,
    route: { provider: "workers-ai", model: "@cf/meta/llama-3.3-70b-instruct-fp8-fast", gateway_id: "default" },
    request
  }, { AI: makeAi("gw-a") });
  const b = await modelRouteFromBody({
    context_package: pkg,
    route: { provider: "workers-ai", model: "@cf/meta/llama-3.3-70b-instruct-fp8-fast", gateway_id: "alternate" },
    request
  }, { AI: makeAi("gw-b") });

  assert.equal(a.ok, true);
  assert.equal(b.ok, true);
  assert.equal(a.package_id, b.package_id);
  assert.equal(a.request_ir_id, b.request_ir_id);
  assert.equal(a.observability.gateway_id, "default");
  assert.equal(b.observability.gateway_id, "alternate");
  assert.equal(a.observability.gateway_request_id, "gw-a");
  assert.equal(b.observability.gateway_request_id, "gw-b");
});

test("V7.1.2 missing Workers AI binding fails typed with established identities", async () => {
  const pkg = await withValidPackageId(baseFixturePackage());
  const result = await modelRouteFromBody({
    context_package: pkg,
    route: { provider: "workers-ai", model: "@cf/meta/llama-3.3-70b-instruct-fp8-fast" },
    request: { tools: [] }
  }, {});
  assert.equal(result.ok, false);
  assert.equal(result.error, "provider_capacity_exceeded");
  assert.equal(result.package_id, pkg.package_id);
  assert.match(result.request_ir_id, /^sha256:[0-9a-f]{64}$/);
});
