import assert from "node:assert/strict";
import { test } from "node:test";
import {
  AGENT_PROFILE_SCHEMA_V1,
  CAIRNSTONE_MAINTAINER_PROFILE,
  GROUNDING_CLASSES,
  classifyGroundingTask,
  getAgentProfile,
  planProfileGroundingReads,
  validateAgentProfile
} from "../src/profiles.js";

function validGroundingPolicy() {
  return {
    grounding_classes_enabled: [...GROUNDING_CLASSES],
    live_read_tools_by_domain: {
      tool_authorizations: ["cairnstone_tool_authorization_list", "cairnstone_tool_authorization_status"]
    },
    accepted_state_authority: "chain_head_and_path_head",
    historical_evidence_policy: "graph_linked_evidence_only",
    fallback_on_unavailable_live_read: "fail_closed_explicit_degraded",
    citation_provenance: { require_citations: true, prefer_head_linked_evidence: true },
    max_live_read_turns: 4
  };
}

function validProfile(overrides = {}) {
  return {
    schema: AGENT_PROFILE_SCHEMA_V1,
    profile_id: "cairnstone-maintainer",
    version: "0.1.0",
    scope: { chain: "cairnstone-v6-project-memory" },
    grounding_policy: validGroundingPolicy(),
    tool_allowlist: ["cairnstone_tool_authorization_list", "cairnstone_tool_authorization_status"],
    confirmation_policy: { human_confirmation_required_for_mutation: true },
    ac1_identity: { actor_id: "claude:cairnstone-maintainer" },
    ...overrides
  };
}

test("V7.4.0 a minimal well-formed profile validates cleanly", () => {
  const result = validateAgentProfile(validProfile());
  assert.deepEqual(result, { ok: true, errors: [] });
});

test("V7.4.0 rejects a profile missing grounding_policy", () => {
  const profile = validProfile();
  delete profile.grounding_policy;
  const result = validateAgentProfile(profile);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some(e => e.startsWith("grounding_policy:")));
});

test("V7.4.0 rejects an unknown grounding class", () => {
  const profile = validProfile();
  profile.grounding_policy.grounding_classes_enabled = ["operational_current", "made_up_class"];
  const result = validateAgentProfile(profile);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some(e => e.includes("made_up_class")));
});

test("V7.4.0 rejects a fallback policy that could silently answer as current", () => {
  const profile = validProfile();
  profile.grounding_policy.fallback_on_unavailable_live_read = "answer_from_memory";
  const result = validateAgentProfile(profile);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some(e => e.startsWith("grounding_policy.fallback_on_unavailable_live_read:")));
});

test("V7.4.0 rejects citation_provenance that does not prefer head-linked evidence", () => {
  const profile = validProfile();
  profile.grounding_policy.citation_provenance = { require_citations: true, prefer_head_linked_evidence: false };
  const result = validateAgentProfile(profile);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some(e => e.startsWith("grounding_policy.citation_provenance.prefer_head_linked_evidence:")));
});

test("V7.4.0 rejects an out-of-range max_live_read_turns", () => {
  const profile = validProfile();
  profile.grounding_policy.max_live_read_turns = 0;
  const result = validateAgentProfile(profile);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some(e => e.startsWith("grounding_policy.max_live_read_turns:")));
});

test("V7.4.0 rejects a profile that tries to grant mutation or execution authority", () => {
  const withMutation = validateAgentProfile(validProfile({ mutation_authority: true }));
  assert.equal(withMutation.ok, false);
  assert.ok(withMutation.errors.some(e => e.startsWith("mutation_authority:")));

  const withExecution = validateAgentProfile(validProfile({ execution_authority: true }));
  assert.equal(withExecution.ok, false);
  assert.ok(withExecution.errors.some(e => e.startsWith("execution_authority:")));
});

test("V7.4.0 rejects a confirmation_policy that lowers human confirmation for mutation", () => {
  const profile = validProfile({ confirmation_policy: { human_confirmation_required_for_mutation: false } });
  const result = validateAgentProfile(profile);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some(e => e.startsWith("confirmation_policy.human_confirmation_required_for_mutation:")));
});

test("V7.4.0 rejects a malformed ac1_identity.actor_id", () => {
  const profile = validProfile({ ac1_identity: { actor_id: "not-namespaced" } });
  const result = validateAgentProfile(profile);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some(e => e.startsWith("ac1_identity.actor_id:")));
});

test("V7.4.0 rejects a non-empty-string tool_allowlist entry", () => {
  const profile = validProfile({ tool_allowlist: ["cairnstone_tool_authorization_list", ""] });
  const result = validateAgentProfile(profile);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some(e => e.startsWith("tool_allowlist:")));
});

test("V7.4.0 rejects a non-object profile without throwing", () => {
  assert.deepEqual(validateAgentProfile(null), { ok: false, errors: ["profile must be an object"] });
  assert.deepEqual(validateAgentProfile("nope"), { ok: false, errors: ["profile must be an object"] });
  assert.deepEqual(validateAgentProfile(undefined), { ok: false, errors: ["profile must be an object"] });
});

test("V7.4.0 optional fields (ac1_identity, tool_allowlist, confirmation_policy) are not required", () => {
  const profile = validProfile();
  delete profile.ac1_identity;
  delete profile.tool_allowlist;
  delete profile.confirmation_policy;
  const result = validateAgentProfile(profile);
  assert.deepEqual(result, { ok: true, errors: [] });
});

test("V7.4.0 cairnstone-maintainer fixture is stable, scoped, and authority-free", () => {
  const resolved = getAgentProfile("cairnstone-maintainer");
  assert.equal(resolved.ok, true);
  assert.equal(resolved.profile.profile_id, "cairnstone-maintainer");
  assert.equal(resolved.profile.version, "0.1.0");
  assert.equal(resolved.profile.scope.chain, "cairnstone-v6-project-memory");
  assert.equal(resolved.profile.execution_authority, false);
  assert.equal(resolved.profile.mutation_authority, false);
  assert.equal(resolved.profile.confirmation_policy.human_confirmation_required_for_mutation, true);
  assert.deepEqual(validateAgentProfile(CAIRNSTONE_MAINTAINER_PROFILE), { ok: true, errors: [] });
});

test("V7.4.0 exact acceptance prompt classifies operational_current and plans live approval discovery", () => {
  const classification = classifyGroundingTask("What are the most recent authorizations I approved");
  assert.equal(classification.grounding_class, "operational_current");
  assert.equal(classification.domain, "tool_authorizations");
  assert.equal(classification.intent, "recent_approved_authorizations");
  const plan = planProfileGroundingReads(CAIRNSTONE_MAINTAINER_PROFILE, classification);
  assert.equal(plan.ok, true);
  assert.deepEqual(plan.reads, [
    { tool_id: "cairnstone_tool_authorization_list", arguments: { decision: "approved", limit: 5 } }
  ]);
});

test("V7.4.0 known authorization lifecycle question uses status read", () => {
  const id = "sha256:" + "a".repeat(64);
  const classification = classifyGroundingTask(`Is authorization ${id} already consumed?`);
  assert.equal(classification.grounding_class, "operational_current");
  assert.equal(classification.intent, "authorization_status");
  const plan = planProfileGroundingReads(CAIRNSTONE_MAINTAINER_PROFILE, classification);
  assert.deepEqual(plan.reads, [
    { tool_id: "cairnstone_tool_authorization_status", arguments: { authorization_request_id: id } }
  ]);
});

test("V7.4.0 explanatory history does not trigger a live operational read", () => {
  const classification = classifyGroundingTask("Why did the V7.3.3 authorization schema need repair?");
  assert.equal(classification.grounding_class, "historical_explanatory");
  const plan = planProfileGroundingReads(CAIRNSTONE_MAINTAINER_PROFILE, classification);
  assert.deepEqual(plan, { ok: true, reads: [] });
});

test("V7.4.0 profile read planner fails closed when domain tool is removed from the allowlist", () => {
  const profile = structuredClone(CAIRNSTONE_MAINTAINER_PROFILE);
  profile.tool_allowlist = profile.tool_allowlist.filter(id => id !== "cairnstone_tool_authorization_list");
  const classification = classifyGroundingTask("What are the most recent authorizations I approved");
  const plan = planProfileGroundingReads(profile, classification);
  assert.equal(plan.ok, false);
  assert.equal(plan.error, "profile_live_read_not_allowed");
});

test("V7.4.0 profile budgets must be positive integers", () => {
  const profile = structuredClone(CAIRNSTONE_MAINTAINER_PROFILE);
  profile.budgets.max_output_tokens = 0;
  const result = validateAgentProfile(profile);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some(e => e.startsWith("budgets.max_output_tokens:")));
});
