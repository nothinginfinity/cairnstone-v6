import test from "node:test";
import assert from "node:assert/strict";
import { routeDecision } from "../src/decision-scorer.js";
import { scoreWithJev } from "../src/decision-jev.js";

const TWO = [
  { id: "cairnstone_find_v2", capability: "stone.search" },
  { id: "cairnstone_ask_scope", capability: "scope.retrieve" }
];

test("mode=jev without JEV_URL fails closed and does not invent", async () => {
  const result = await routeDecision({
    kind: "tool_route",
    candidates: TWO,
    mode: "jev"
  });
  assert.equal(result.ok, false);
  assert.equal(result.scorer_fallback, "jev_not_configured");
  assert.equal(result.execution_authority, false);
});

test("auto mode never calls Jev even when configured", async () => {
  let jevCalled = 0;
  const env = {
    JEV_URL: "https://jev.example/score",
    AI: { run: async () => ({ response: '{\"selected_id\":\"cairnstone_find_v2\",\"confidence\":0.4}' }) }
  };
  const result = await routeDecision({
    kind: "tool_route",
    candidates: TWO,
    mode: "auto",
    env,
    scoreJev: async () => {
      jevCalled += 1;
      return { ok: false, error: "should_not_run" };
    }
  });
  assert.equal(jevCalled, 0);
  assert.equal(result.ok, true);
  assert.equal(result.receipt.scorer_source, "workers_ai");
});

test("mode=jev uses adapter and revalidates id", async () => {
  const env = { JEV_URL: "https://jev.example/score" };
  const result = await routeDecision({
    kind: "tool_route",
    candidates: TWO,
    mode: "jev",
    env,
    scoreJev: async () => ({ ok: true, selected_id: "cairnstone_ask_scope", confidence: 0.3, model: "jev" })
  });
  assert.equal(result.ok, true);
  assert.equal(result.selected.id, "cairnstone_ask_scope");
  assert.equal(result.receipt.scorer_source, "jev");
  assert.equal(result.execution_authority, false);
});

test("scoreWithJev maps HTTP failure", async () => {
  const scored = await scoreWithJev({
    env: { JEV_URL: "https://jev.example/score" },
    kind: "tool_route",
    candidates: TWO,
    fetchImpl: async () => ({ ok: false, status: 503 })
  });
  assert.equal(scored.ok, false);
  assert.equal(scored.error, "jev_http_503");
});
