import test from "node:test";
import assert from "node:assert/strict";
import { routeDecision } from "../src/decision-scorer.js";
import { scoreWithJev, ASK_JEV_TOOL_DEFINITION, JEV_MAX_RESPONSE_BYTES, JEV_WORKERS_AI_MODEL } from "../src/decision-jev.js";
import { DECISION_KINDS } from "../src/decision-plane.js";

const TWO = [
  { id: "cairnstone_find_v2", capability: "stone.search", title: "Find v2", description: "FTS search across stones" },
  { id: "cairnstone_ask_scope", capability: "scope.retrieve", title: "Ask scope", description: "Grounded Q&A over a scope" }
];

test("mode=jev without JEV_URL or AI binding fails closed and does not invent", async () => {
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
    scoreJev: async () => ({ ok: true, selected_id: "cairnstone_ask_scope", confidence: 0.3, model: "jev", transport: "http" })
  });
  assert.equal(result.ok, true);
  assert.equal(result.selected.id, "cairnstone_ask_scope");
  assert.equal(result.receipt.scorer_source, "jev");
  assert.equal(result.receipt.scorer_transport, "http");
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
  assert.equal(scored.transport, "http");
});

test("scoreWithJev fails closed on oversize response", async () => {
  const scored = await scoreWithJev({
    env: { JEV_URL: "https://jev.example/score" },
    kind: "tool_route",
    candidates: TWO,
    maxBytes: 16,
    fetchImpl: async () => ({ ok: true, text: async () => '{\"selected_id\":\"cairnstone_find_v2\"}' })
  });
  assert.equal(scored.ok, false);
  assert.equal(scored.error, "jev_response_too_large");
  assert.ok(scored.bytes > 16);
});

test("scoreWithJev maps abort/timeout", async () => {
  const scored = await scoreWithJev({
    env: { JEV_URL: "https://jev.example/score" },
    kind: "tool_route",
    candidates: TWO,
    fetchImpl: async () => {
      const err = new Error("aborted");
      err.name = "AbortError";
      throw err;
    }
  });
  assert.equal(scored.ok, false);
  assert.equal(scored.error, "jev_timeout");
  assert.equal(scored.transport, "http");
});

test("scoreWithJev uses Workers AI binding when JEV_URL is unset", async () => {
  let model = null;
  let input = null;
  const env = {
    AI: {
      run: async (id, payload) => {
        model = id;
        input = payload;
        return {
          model: "jev-1.13.0",
          answers: {
            selected: {
              type: "choice",
              choice: "cairnstone_find_v2",
              confidence: 0.81,
              probabilities: { cairnstone_find_v2: 0.81, cairnstone_ask_scope: 0.19 }
            }
          }
        };
      }
    }
  };
  const scored = await scoreWithJev({
    env,
    kind: "tool_route",
    task: "Find where a specific file path is accepted in a chain",
    candidates: TWO
  });
  assert.equal(scored.ok, true);
  assert.equal(model, JEV_WORKERS_AI_MODEL);
  assert.equal(scored.selected_id, "cairnstone_find_v2");
  assert.equal(scored.confidence, 0.81);
  assert.equal(scored.transport, "binding");
  assert.equal(input.questions.selected.type, "choice");
  assert.ok(input.questions.selected.criteria.cairnstone_find_v2);
});

test("JEV_URL override wins over AI binding", async () => {
  let bindingCalled = 0;
  const scored = await scoreWithJev({
    env: {
      JEV_URL: "https://jev.example/score",
      AI: {
        run: async () => {
          bindingCalled += 1;
          return { answers: { selected: { type: "choice", choice: "cairnstone_ask_scope" } } };
        }
      }
    },
    kind: "tool_route",
    candidates: TWO,
    fetchImpl: async () => ({ ok: true, text: async () => '{\"selected_id\":\"cairnstone_find_v2\",\"confidence\":0.2}' })
  });
  assert.equal(bindingCalled, 0);
  assert.equal(scored.ok, true);
  assert.equal(scored.selected_id, "cairnstone_find_v2");
  assert.equal(scored.transport, "http");
});

test("binding rejects invented choice and duplicate ids", async () => {
  const invented = await scoreWithJev({
    env: {
      AI: {
        run: async () => ({ answers: { selected: { type: "choice", choice: "not_a_candidate", confidence: 0.9 } } })
      }
    },
    kind: "tool_route",
    candidates: TWO
  });
  assert.equal(invented.ok, true);
  assert.equal(invented.selected_id, "not_a_candidate");
  assert.equal(invented.transport, "binding");

  const dup = await scoreWithJev({
    env: { AI: { run: async () => ({ answers: { selected: { type: "choice", choice: "cairnstone_find_v2" } } }) } },
    kind: "tool_route",
    candidates: [TWO[0], { ...TWO[0] }]
  });
  assert.equal(dup.ok, false);
  assert.equal(dup.error, "jev_duplicate_candidate_id");
});

test("binding timeout and malformed output fail closed", async () => {
  const timed = await scoreWithJev({
    env: {
      AI: {
        run: async () => {
          await new Promise((r) => setTimeout(r, 50));
          return { answers: { selected: { type: "choice", choice: "cairnstone_find_v2" } } };
        }
      }
    },
    kind: "tool_route",
    candidates: TWO,
    timeoutMs: 5
  });
  assert.equal(timed.ok, false);
  assert.equal(timed.error, "jev_timeout");
  assert.equal(timed.transport, "binding");

  const malformed = await scoreWithJev({
    env: { AI: { run: async () => ({ answers: {} }) } },
    kind: "tool_route",
    candidates: TWO
  });
  assert.equal(malformed.ok, false);
  assert.equal(malformed.error, "malformed_model_output");
});

test("ask_jev kind enum matches DECISION_KINDS", () => {
  assert.deepEqual(ASK_JEV_TOOL_DEFINITION.inputSchema.properties.kind.enum, [...DECISION_KINDS]);
  assert.ok(JEV_MAX_RESPONSE_BYTES <= 4096);
});

test("routeDecision records binding transport on success and fallback", async () => {
  const env = {
    AI: {
      run: async () => ({
        answers: { selected: { type: "choice", choice: "cairnstone_ask_scope", confidence: 0.44 } }
      })
    }
  };
  const ok = await routeDecision({
    kind: "tool_route",
    candidates: TWO,
    mode: "jev",
    env
  });
  assert.equal(ok.ok, true);
  assert.equal(ok.receipt.scorer_source, "jev");
  assert.equal(ok.receipt.scorer_transport, "binding");

  const fail = await routeDecision({
    kind: "tool_route",
    candidates: TWO,
    mode: "jev",
    env: {
      AI: {
        run: async () => {
          const err = new Error("aborted");
          err.name = "AbortError";
          throw err;
        }
      }
    }
  });
  assert.equal(fail.ok, false);
  assert.equal(fail.receipt.scorer_source, "jev");
  assert.equal(fail.receipt.scorer_transport, "binding");
  assert.equal(fail.scorer_fallback, "jev_timeout");
});
