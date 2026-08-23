import assert from "node:assert/strict";
import { test } from "node:test";
import {
  analyzeSkillAmbiguity,
  parseSkillAgentResponse,
  skillAgentFromBody,
  validateSkillAgentSelection
} from "../src/skill-agent.js";

const MANIFEST = {
  stone_hash: "m".repeat(64),
  commit_sha: "a".repeat(40),
  path: "skills/manifest.json"
};

function candidate(id, score, extra = {}) {
  return {
    skill_id: id,
    title: extra.title || id,
    path: `skills/${id.replaceAll(".", "/")}/SKILL.md`,
    version: "1.0.0",
    score,
    reasons: extra.reasons || [`token_overlap:${Math.max(1, Math.floor(score / 2))}`],
    missing_tools: [],
    dependencies: extra.dependencies || []
  };
}

function makeDeps(recommendations) {
  return {
    async resolveSkillsFromBody(body) {
      return {
        ok: true,
        chain: body.chain || "cairnstone-v6-skills",
        task: body.task,
        manifest: MANIFEST,
        boot: ["core.orient"],
        recommendations
      };
    },
    async listSkillsFromBody() {
      return {
        ok: true,
        manifest: MANIFEST,
        skills: recommendations.map(item => ({
          id: item.skill_id,
          title: item.title,
          version: item.version,
          description: `Accepted description for ${item.skill_id}`,
          tags: item.skill_id.split("."),
          triggers: [`route ${item.skill_id}`],
          requires_tools: [],
          dependencies: item.dependencies || []
        }))
      };
    }
  };
}

test("ambiguity detection keeps clear deterministic rankings out of the model path", () => {
  assert.deepEqual(analyzeSkillAmbiguity([]), {
    ambiguous: false,
    reason: "no_candidates",
    top_score: null,
    second_score: null,
    score_gap: null
  });
  assert.equal(analyzeSkillAmbiguity([candidate("a", 22), candidate("b", 8)]).ambiguous, false);
  const close = analyzeSkillAmbiguity([candidate("a", 10), candidate("b", 9)]);
  assert.equal(close.ambiguous, true);
  assert.equal(close.reason, "close_candidate_scores");
  assert.equal(close.score_gap, 1);
});

test("model response parsing accepts fenced JSON but selection validation rejects unknown skills", () => {
  const parsed = parseSkillAgentResponse({ response: "```json\n{\"selected_skill_ids\":[\"accepted.one\"],\"confidence\":\"high\"}\n```" });
  assert.equal(parsed.ok, true);
  const accepted = [candidate("accepted.one", 10), candidate("accepted.two", 9)];
  assert.equal(validateSkillAgentSelection(parsed.value, accepted, 2).ok, true);
  const rejected = validateSkillAgentSelection({ selected_skill_ids: ["unaccepted.skill"] }, accepted, 2);
  assert.equal(rejected.ok, false);
  assert.equal(rejected.error, "selection_outside_accepted_candidates");
  assert.deepEqual(rejected.unknown_skill_ids, ["unaccepted.skill"]);
});

test("auto mode stays deterministic when the score gap is clear and never calls AI", async () => {
  const recommendations = [candidate("github.actions-triage", 24), candidate("github.repo-file-read", 8)];
  let aiCalls = 0;
  const result = await skillAgentFromBody({ task: "The GitHub Actions deploy failed", mode: "auto", max_skills: 2 }, {
    AI: { async run() { aiCalls += 1; throw new Error("should not run"); } }
  }, makeDeps(recommendations));
  assert.equal(result.ok, true);
  assert.equal(result.selection_source, "deterministic");
  assert.equal(aiCalls, 0);
  assert.equal(result.recommendations[0].skill_id, "github.actions-triage");
  assert.equal(result.policy.mutation_authority, false);
  assert.equal(result.policy.execution_authority, false);
});

test("ambiguous routing can use the model but only within accepted deterministic candidates", async () => {
  const recommendations = [
    candidate("github.pull-request-triage", 12),
    candidate("github.branch-protection-inspection", 11)
  ];
  let aiCalls = 0;
  const env = {
    AI: {
      async run(_model, request) {
        aiCalls += 1;
        const userPrompt = request.messages.find(message => message.role === "user").content;
        assert.match(userPrompt, /github\.pull-request-triage/);
        assert.match(userPrompt, /github\.branch-protection-inspection/);
        return {
          response: JSON.stringify({
            selected_skill_ids: ["github.branch-protection-inspection"],
            confidence: "high",
            rationale: { "github.branch-protection-inspection": "The task is specifically about merge protection rules." }
          })
        };
      }
    }
  };
  const result = await skillAgentFromBody({
    task: "My PR is blocked and I need to know whether branch protection or PR state is responsible.",
    mode: "auto",
    max_skills: 1
  }, env, makeDeps(recommendations));
  assert.equal(result.ok, true);
  assert.equal(aiCalls, 1);
  assert.equal(result.selection_source, "model_assisted");
  assert.deepEqual(result.model_assist.selected_skill_ids, ["github.branch-protection-inspection"]);
  assert.equal(result.recommendations[0].skill_id, "github.branch-protection-inspection");
  assert.match(result.recommendations[0].model_rationale, /merge protection/);
  assert.equal(result.manifest.stone_hash, MANIFEST.stone_hash);
  assert.equal(result.policy.accepted_state_only, true);
  assert.equal(result.policy.model_can_expand_candidate_set, false);
});

test("an invented model skill ID fails closed to the deterministic baseline", async () => {
  const recommendations = [candidate("github.pull-request-triage", 10), candidate("github.branch-protection-inspection", 9)];
  const result = await skillAgentFromBody({ task: "Ambiguous GitHub routing", mode: "model", max_skills: 1 }, {
    AI: { async run() { return { response: '{"selected_skill_ids":["github.secret-unaccepted-skill"],"confidence":"high"}' }; } }
  }, makeDeps(recommendations));
  assert.equal(result.ok, true);
  assert.equal(result.selection_source, "deterministic_fallback");
  assert.equal(result.model_assist.used, false);
  assert.equal(result.model_assist.fallback_reason, "selection_outside_accepted_candidates");
  assert.equal(result.recommendations[0].skill_id, "github.pull-request-triage");
  assert.ok(!result.recommendations.some(item => item.skill_id === "github.secret-unaccepted-skill"));
});

test("model failure and missing AI binding both preserve deterministic routing", async () => {
  const recommendations = [candidate("cairnstone.source-freshness", 9), candidate("cairnstone.repo-reconcile", 8)];
  const failed = await skillAgentFromBody({ task: "Check repo drift", mode: "model", max_skills: 1 }, {
    AI: { async run() { throw new Error("provider unavailable"); } }
  }, makeDeps(recommendations));
  assert.equal(failed.selection_source, "deterministic_fallback");
  assert.match(failed.model_assist.fallback_reason, /^model_error:/);
  assert.equal(failed.recommendations[0].skill_id, "cairnstone.source-freshness");

  const missing = await skillAgentFromBody({ task: "Check repo drift", mode: "model", max_skills: 1 }, {}, makeDeps(recommendations));
  assert.equal(missing.selection_source, "deterministic_fallback");
  assert.equal(missing.model_assist.fallback_reason, "ai_binding_missing");
  assert.equal(missing.recommendations[0].skill_id, "cairnstone.source-freshness");
});
