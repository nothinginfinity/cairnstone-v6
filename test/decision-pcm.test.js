import test from "node:test";
import assert from "node:assert/strict";
import { derivePcmNextActionCandidates, routePcmDecision } from "../src/decision-pcm.js";
import { CODE_SESSION_COMPILE_CONTEXT_TOOL_DEFINITION } from "../src/code-session.js";
import { DEFAULT_TOOL_BROKER_REGISTRY } from "../src/model-router.js";
import { sha256Text, stableJson } from "../src/agent-bootstrap.js";

const FIND_SCHEMA = {
  type: "object",
  required: ["query"],
  properties: {
    query: { type: "string" },
    chain: { type: "string", description: "Restrict to one chain" },
    stone_hash: { type: "string", description: "Restrict to one stone (full or >=8-char short hash)" },
    top_k: { type: "number", description: "Max matches, default 5" },
    match_mode: { type: "string", enum: ["any", "all", "phrase"], description: "Default 'any' (OR across terms). 'all' requires every term present. 'phrase' requires the exact adjacent sequence. A fully-quoted query is always treated as a phrase." },
    expand: { type: "boolean", description: "If true, expand the top hits' raw content inline (max 3)" },
    context_lines: { type: "number", description: "Context lines around expanded refs, default 20" }
  }
};
const REG = [
  {
    tool_id: "cairnstone_find_v2",
    handler: "cairnstone_find_v2",
    risk_class: "read",
    authorization: "automatic",
    available: true,
    input_schema: FIND_SCHEMA
  },
  {
    tool_id: "cairnstone_workspace_diff",
    handler: "cairnstone_workspace_diff",
    risk_class: "read",
    authorization: "scoped_grant",
    available: true,
    input_schema: { type: "object" }
  },
  {
    tool_id: "cairnstone_code_session_compile_context",
    handler: "cairnstone_code_session_compile_context",
    risk_class: "read",
    authorization: "scoped_grant",
    available: true,
    input_schema: CODE_SESSION_COMPILE_CONTEXT_TOOL_DEFINITION.inputSchema
  }
];
const CATALOG = [
  { name: "cairnstone_find_v2", description: "search", inputSchema: FIND_SCHEMA },
  { name: "cairnstone_workspace_diff", description: "diff", inputSchema: { type: "object" } },
  { name: "cairnstone_code_session_compile_context", description: "compile", inputSchema: CODE_SESSION_COMPILE_CONTEXT_TOOL_DEFINITION.inputSchema }
];
const DEPS = { decisionRegistry: REG, mcpToolDefinitions: CATALOG };

function context(overrides = {}) {
  return {
    ok: true,
    code_session_id: "cs:demo",
    session_revision: 4,
    content_identity: { context_digest: "sha256:abc", session_revision: 4 },
    next_safe_continuation: {
      action: "inspect_blockers",
      rationale: "lifecycle_blocked_requires_human_or_ledger_resolution",
      safe_to_continue: false
    },
    unresolved_issues: [{ title: "merge conflict" }],
    ...overrides
  };
}

test("compile_context schema advertises include_decision and matches broker overlay", async () => {
  assert.equal("include_decision" in CODE_SESSION_COMPILE_CONTEXT_TOOL_DEFINITION.inputSchema.properties, true);
  const overlay = DEFAULT_TOOL_BROKER_REGISTRY.find((e) => e.tool_id === "cairnstone_code_session_compile_context");
  const canon = "sha256:" + await sha256Text(stableJson(CODE_SESSION_COMPILE_CONTEXT_TOOL_DEFINITION.inputSchema));
  const reg = "sha256:" + await sha256Text(stableJson(overlay.input_schema));
  assert.equal(canon, reg);
});

test("blocked session yields unique inspect_blockers and hydrates automatic find_v2", async () => {
  const cands = derivePcmNextActionCandidates(context());
  assert.deepEqual(cands.map((c) => c.id), ["inspect_blockers"]);
  const result = await routePcmDecision(context(), DEPS);
  assert.equal(result.ok, true);
  assert.equal(result.status, "resolved");
  assert.equal(result.next_action.selected.id, "inspect_blockers");
  assert.equal(result.tool_route.hydrated.ok, true);
  assert.equal(result.tool_route.selected.id, "cairnstone_find_v2");
});

test("scoped-grant mapped tools stay proposals and do not pretend hydrate", async () => {
  const result = await routePcmDecision(context({
    next_safe_continuation: { action: "read_only_continue", rationale: "stable", safe_to_continue: true }
  }), DEPS);
  assert.equal(result.ok, true);
  assert.equal(result.status, "needs_scoped_grant");
  assert.equal(result.tool_route.status, "needs_scoped_grant");
  assert.equal(result.tool_route.hydrated, null);
  assert.equal(result.execution_authority, false);
});

test("schema disagreement on mapped automatic tool fail-closes PCM", async () => {
  const bad = {
    decisionRegistry: [{ ...REG[0], input_schema: { type: "object" } }],
    mcpToolDefinitions: CATALOG
  };
  const result = await routePcmDecision(context(), bad);
  assert.equal(result.ok, false);
  assert.equal(result.status, "schema_disagreement");
});

test("scoped_grant missing canonical mcpTools definition fail-closes", async () => {
  const result = await routePcmDecision(context({
    next_safe_continuation: { action: "read_only_continue", rationale: "stable", safe_to_continue: true }
  }), { decisionRegistry: REG, mcpToolDefinitions: CATALOG.filter((t) => t.name !== "cairnstone_code_session_compile_context") });
  assert.equal(result.ok, false);
  assert.equal(result.status, "unavailable");
});

test("scoped_grant schema drift fail-closes", async () => {
  const result = await routePcmDecision(context({
    next_safe_continuation: { action: "read_only_continue", rationale: "stable", safe_to_continue: true }
  }), {
    decisionRegistry: REG,
    mcpToolDefinitions: CATALOG.map((t) => t.name === "cairnstone_code_session_compile_context"
      ? { ...t, inputSchema: { type: "object", properties: { other: { type: "string" } } } }
      : t)
  });
  assert.equal(result.ok, false);
  assert.equal(result.status, "schema_disagreement");
});

test("missing context fails closed", async () => {
  const result = await routePcmDecision({ ok: false }, DEPS);
  assert.equal(result.ok, false);
  assert.equal(result.error, "pcm_context_required");
});
