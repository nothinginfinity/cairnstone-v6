import test from "node:test";
import assert from "node:assert/strict";
import { routeDecision, parseScorerResponse } from "../src/decision-scorer.js";

const TWO = [
  { id: "cairnstone_find_v2", capability: "stone.search" },
  { id: "cairnstone_ask_scope", capability: "scope.retrieve" }
];

test("unique candidate never calls AI", async () => {
  let called = 0;
  const env = { AI: { run: async () => { called += 1; return { response: "{}" }; } } };
  const result = await routeDecision({
    kind: "tool_route",
    task: "search",
    candidates: [TWO[0]],
    env
  });
  assert.equal(result.ok, true);
  assert.equal(result.policy_outcome, "deterministic_winner");
  assert.equal(result.scorer_attempted, false);
  assert.equal(called, 0);
  assert.equal(result.execution_authority, false);
});

test("Workers AI selection is validated against candidate ids", async () => {
  const env = {
    AI: {
      run: async () => ({ response: '{\"selected_id\":\"cairnstone_find_v2\",\"confidence\":0.7}' })
    }
  };
  const result = await routeDecision({
    kind: "tool_route",
    task: "search stones",
    candidates: TWO,
    mode: "model",
    env
  });
  assert.equal(result.ok, true);
  assert.equal(result.selected.id, "cairnstone_find_v2");
  assert.equal(result.receipt.scorer_source, "workers_ai");
  assert.equal(result.execution_authority, false);
});

test("invented model id is rejected and does not execute", async () => {
  const env = {
    AI: {
      run: async () => ({ response: '{\"selected_id\":\"invented_tool\",\"confidence\":0.9}' })
    }
  };
  const result = await routeDecision({
    kind: "tool_route",
    candidates: TWO,
    mode: "model",
    env
  });
  assert.equal(result.ok, false);
  assert.equal(result.policy_outcome, "invented_candidate_rejected");
  assert.equal(result.invented_candidate_executable, false);
});

test("missing AI binding leaves decision unresolved", async () => {
  const result = await routeDecision({
    kind: "tool_route",
    candidates: TWO,
    mode: "auto"
  });
  assert.equal(result.ok, false);
  assert.equal(result.policy_outcome, "ambiguous_no_winner");
  assert.equal(result.scorer_fallback, "ai_binding_missing");
});

test("malformed model JSON falls back unresolved", async () => {
  const env = { AI: { run: async () => ({ response: "not-json" }) } };
  const result = await routeDecision({
    kind: "tool_route",
    candidates: TWO,
    mode: "model",
    env
  });
  assert.equal(result.ok, false);
  assert.equal(result.scorer_fallback, "malformed_model_output");
});

test("parseScorerResponse extracts JSON object from wrapper text", () => {
  const parsed = parseScorerResponse({ response: 'Sure. {\"selected_id\":\"cairnstone_find_v2\",\"confidence\":0.2}' });
  assert.equal(parsed.ok, true);
  assert.equal(parsed.selected_id, "cairnstone_find_v2");
});
