// V7.6.0 -- small/medium/mature packageBody fixtures for computeContextProfile
//
// The "mature" fixture uses the REAL, full path_heads array captured live
// from cairnstone-v6-project-memory (see live-path-heads-snapshot.json,
// captured via cairnstone_resume_chain on 2026-08-30). "small" and "medium"
// take the first 5 / 30 entries of that same real array -- these are
// genuine production authority records, not synthetic data, so scaling
// comparisons across tiers reflect how a real chain's cost actually grows.
//
// Only the non-authority sections (instructions length, skills count,
// memory item count) are synthesized per tier, since those aren't part of
// the captured snapshot and don't need to be for a profiler byte-accounting
// test -- what matters for this fixture set is real, varying authority
// scale, which is exactly what the roadmap's acceptance criteria are about.

import liveSnapshot from "./live-path-heads-snapshot.json" with { type: "json" };

const TIERS = {
  small: { pathHeadCount: 5, instructionsChars: 400, skillsCount: 1, memoryItemCount: 0 },
  medium: { pathHeadCount: 30, instructionsChars: 4000, skillsCount: 3, memoryItemCount: 3 },
  mature: { pathHeadCount: liveSnapshot.path_heads.length, instructionsChars: 18000, skillsCount: 5, memoryItemCount: 6 }
};

function buildMemoryItem(index) {
  return {
    path: `project-memory/synthetic-evidence-${index}.md`,
    ref_id: `ref-${index}`,
    authority_class: index % 2 === 0 ? "ACCEPTED" : "HISTORICAL",
    line_start: 1,
    line_end: 40 + index,
    freshness: null
  };
}

function buildSkill(index) {
  return { skill_id: `core.synthetic-${index}`, skill_version: "1.0.0" };
}

/**
 * Build a packageBody-shaped fixture for one tier ("small" | "medium" |
 * "mature"). Shape matches the real object agentBootstrapFromBody compiles,
 * so it can be fed directly into computeBootstrapPackageProfile the same
 * way the live code path does.
 */
export function buildFixturePackageBody(tier) {
  const spec = TIERS[tier];
  if (!spec) throw new Error(`unknown fixture tier: ${tier}`);

  const pathHeads = liveSnapshot.path_heads.slice(0, spec.pathHeadCount);
  const instructionsContent = "x".repeat(spec.instructionsChars);

  return {
    schema: "cairnstone-agent-context-v1",
    actor: { actor_id: `test:fixture-${tier}` },
    request: { task: `V7.6.0 fixture run (${tier})`, chain: liveSnapshot.chain },
    runtime: { cairnstone_version: "0.5.19", protocol: "FSL-CCR Stone v6", compiled_at: liveSnapshot.captured_at },
    authority: {
      chain: liveSnapshot.chain,
      chain_head: liveSnapshot.chain_head,
      path_heads: pathHeads,
      timestamp_ordering_used: false
    },
    instructions: { content: instructionsContent, authority_chain: liveSnapshot.chain },
    coordination: { recipient_id: `test:fixture-${tier}`, unread_count: 0, items: [] },
    skills: { accepted_bundle: Array.from({ length: spec.skillsCount }, (_, i) => buildSkill(i)) },
    memory: { items: Array.from({ length: spec.memoryItemCount }, (_, i) => buildMemoryItem(i)), truncated: false },
    capabilities: { max_context_tokens: 200000, supports_tool_calls: true, tools: [] },
    policy: {
      context_compiler_called_llm: false,
      execution_authority: false,
      mutation_authority: false,
      provider_credentials_in_package: false,
      accepted_state_only_for_authority: true,
      mutable_branch_is_authority: false
    },
    limits: { effective_max_package_bytes: 64000, package_bytes: 0, skills_bytes: 0, memory_bytes: 0, instructions_bytes: 0, truncated: false }
  };
}

export const FIXTURE_TIERS = Object.keys(TIERS);
export const FIXTURE_TIER_SPECS = TIERS;
