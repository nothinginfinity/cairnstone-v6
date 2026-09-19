import test from "node:test";
import assert from "node:assert/strict";
import { derivePcmNextActionCandidates, routePcmDecision } from "../src/decision-pcm.js";

const REG = [
  {
    tool_id: "cairnstone_find_v2",
    handler: "cairnstone_find_v2",
    risk_class: "read",
    authorization: "automatic",
    available: true,
    description: "search stones",
    input_schema: { type: "object", properties: { query: { type: "string" } } }
  },
  {
    tool_id: "cairnstone_code_session_compile_context",
    handler: "cairnstone_code_session_compile_context",
    risk_class: "read",
    authorization: "automatic",
    available: true,
    description: "compile code session context",
    input_schema: { type: "object" }
  }
];
const CATALOG = [
  { name: "cairnstone_find_v2", description: "search stones", inputSchema: REG[0].input_schema },
  { name: "cairnstone_code_session_compile_context", description: "compile code session context", inputSchema: { type: "object" } }
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
      safe_to_continue: false,
      unresolved_issues: [{ title: "merge conflict" }]
    },
    unresolved_issues: [{ title: "merge conflict" }],
    task_ledger_summary: { active: [{ task_id: "task:1", title: "fix hydrate" }] },
    accepted_state_authority: false,
    ...overrides
  };
}

test("blocked session yields unique inspect_blockers next_action", () => {
  const cands = derivePcmNextActionCandidates(context());
  assert.deepEqual(cands.map((c) => c.id), ["inspect_blockers"]);
});

test("two actors compiling the same context get the same bounded decision", async () => {
  const shared = context();
  const a = await routePcmDecision(shared, DEPS);
  const b = await routePcmDecision(shared, DEPS);
  assert.equal(a.ok, true);
  assert.equal(a.next_action.selected.id, "inspect_blockers");
  assert.equal(a.next_action.policy_outcome, "deterministic_winner");
  assert.equal(a.tool_route.selected.id, "cairnstone_find_v2");
  assert.equal(a.tool_route.hydrated.ok, true);
  assert.equal(a.execution_authority, false);
  assert.equal(a.lease_authority, false);
  assert.equal(JSON.stringify(a.next_action.selected), JSON.stringify(b.next_action.selected));
  assert.equal(a.tool_route.hydrated.contract.schema_hash, b.tool_route.hydrated.contract.schema_hash);
});

test("active read-only continue hydrates compile_context and never mutates", async () => {
  const result = await routePcmDecision(context({
    next_safe_continuation: { action: "read_only_continue", rationale: "stable", safe_to_continue: true }
  }), DEPS);
  assert.equal(result.next_action.selected.id, "read_only_continue");
  assert.equal(result.tool_route.selected.id, "cairnstone_code_session_compile_context");
  assert.equal(result.mutation_authority, false);
  assert.equal(result.task_transition_authority, false);
});

test("missing context fails closed", async () => {
  const result = await routePcmDecision({ ok: false }, DEPS);
  assert.equal(result.ok, false);
  assert.equal(result.error, "pcm_context_required");
});
