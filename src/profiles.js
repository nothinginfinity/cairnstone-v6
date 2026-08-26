// V7.4.0 -- minimal provider-neutral agent profile schema/identity contract.
//
// This module defines and validates the shape of a reusable CairnStone agent
// profile, with a first-class `grounding_policy` section (the missing piece
// identified by the V7.4.0 plan Stone: a fresh-context model correctly
// recalled historical V7.3.3 facts but cited superseded evidence instead of
// the final accepted evidence, and checked live authorization status only
// after answering from memory rather than before).
//
// Deliberately schema-only for this slice: it does not wire grounding-class
// classification into any request path, does not define the
// `cairnstone-maintainer` profile fixture, and does not change any existing
// tool behavior. Those are later V7.4 engineering-order steps (3, 4, 6).
//
// A profile is configuration, never project-memory or execution authority:
// it can never grant execution or mutation authority, and it can only
// narrow -- never promote -- historical evidence into live/current
// authority. See docs/AI_OPERATING_GUIDE.md and the V7.4.0 plan Stone
// (project-memory/v740-operational-grounding-agent-profile-plan.md) for the
// full rationale this contract is built against.

export const AGENT_PROFILE_SCHEMA_V1 = "cairnstone-agent-profile-v1";

export const GROUNDING_CLASSES = Object.freeze([
  "operational_current",
  "accepted_state",
  "historical_explanatory"
]);

export const ACCEPTED_STATE_AUTHORITY_VALUES = Object.freeze([
  "chain_head_and_path_head"
]);

export const HISTORICAL_EVIDENCE_POLICY_VALUES = Object.freeze([
  "graph_linked_evidence_only"
]);

export const FALLBACK_ON_UNAVAILABLE_LIVE_READ_VALUES = Object.freeze([
  "fail_closed_explicit_degraded"
]);

const MIN_LIVE_READ_TURNS = 1;
const MAX_LIVE_READ_TURNS = 25;
const ACTOR_ID_RE = /^[a-z0-9_-]+:[a-z0-9_.-]+$/i;

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function pushError(errors, path, message) {
  errors.push(`${path}: ${message}`);
}

function validateGroundingPolicy(policy, errors, path) {
  if (!isObject(policy)) {
    pushError(errors, path, "must be an object");
    return;
  }

  const enabled = policy.grounding_classes_enabled;
  if (!Array.isArray(enabled) || enabled.length === 0) {
    pushError(errors, `${path}.grounding_classes_enabled`, "must be a non-empty array");
  } else {
    for (const cls of enabled) {
      if (!GROUNDING_CLASSES.includes(cls)) {
        pushError(errors, `${path}.grounding_classes_enabled`, `unknown grounding class '${cls}'`);
      }
    }
  }

  const liveReadTools = policy.live_read_tools_by_domain;
  if (!isObject(liveReadTools)) {
    pushError(errors, `${path}.live_read_tools_by_domain`, "must be an object mapping operational domain to an array of tool ids");
  } else {
    for (const [domain, tools] of Object.entries(liveReadTools)) {
      if (!Array.isArray(tools) || tools.some(tool => !isNonEmptyString(tool))) {
        pushError(errors, `${path}.live_read_tools_by_domain.${domain}`, "must be an array of non-empty tool id strings");
      }
    }
  }

  if (!ACCEPTED_STATE_AUTHORITY_VALUES.includes(policy.accepted_state_authority)) {
    pushError(errors, `${path}.accepted_state_authority`, `must be one of ${ACCEPTED_STATE_AUTHORITY_VALUES.join(", ")}`);
  }

  if (!HISTORICAL_EVIDENCE_POLICY_VALUES.includes(policy.historical_evidence_policy)) {
    pushError(errors, `${path}.historical_evidence_policy`, `must be one of ${HISTORICAL_EVIDENCE_POLICY_VALUES.join(", ")}`);
  }

  if (!FALLBACK_ON_UNAVAILABLE_LIVE_READ_VALUES.includes(policy.fallback_on_unavailable_live_read)) {
    pushError(
      errors,
      `${path}.fallback_on_unavailable_live_read`,
      `must be one of ${FALLBACK_ON_UNAVAILABLE_LIVE_READ_VALUES.join(", ")} -- a profile may never silently answer a current-state question from historical memory alone`
    );
  }

  const citation = policy.citation_provenance;
  if (
    !isObject(citation) ||
    typeof citation.require_citations !== "boolean" ||
    typeof citation.prefer_head_linked_evidence !== "boolean"
  ) {
    pushError(errors, `${path}.citation_provenance`, "must be an object with boolean require_citations and prefer_head_linked_evidence");
  } else if (citation.prefer_head_linked_evidence !== true) {
    pushError(
      errors,
      `${path}.citation_provenance.prefer_head_linked_evidence`,
      "must be true -- canonical/head-linked evidence must outrank superseded historical matches"
    );
  }

  const maxTurns = policy.max_live_read_turns;
  if (!Number.isInteger(maxTurns) || maxTurns < MIN_LIVE_READ_TURNS || maxTurns > MAX_LIVE_READ_TURNS) {
    pushError(errors, `${path}.max_live_read_turns`, `must be an integer between ${MIN_LIVE_READ_TURNS} and ${MAX_LIVE_READ_TURNS}`);
  }
}

/**
 * Deterministically validate a candidate agent profile object against the
 * V7.4.0 minimal profile schema/identity contract. Pure and synchronous;
 * never throws and never performs any I/O. Returns
 * { ok: true, errors: [] } or { ok: false, errors: string[] }.
 */
export function validateAgentProfile(profile) {
  const errors = [];
  if (!isObject(profile)) {
    return { ok: false, errors: ["profile must be an object"] };
  }

  if (profile.schema !== AGENT_PROFILE_SCHEMA_V1) {
    pushError(errors, "schema", `must equal '${AGENT_PROFILE_SCHEMA_V1}'`);
  }
  if (!isNonEmptyString(profile.profile_id)) {
    pushError(errors, "profile_id", "must be a non-empty string");
  }
  if (!isNonEmptyString(profile.version)) {
    pushError(errors, "version", "must be a non-empty string");
  }

  if (!isObject(profile.scope) || !isNonEmptyString(profile.scope.chain)) {
    pushError(errors, "scope.chain", "must be a non-empty string identifying the profile's owning CairnStone chain");
  }

  validateGroundingPolicy(profile.grounding_policy, errors, "grounding_policy");

  // A profile is configuration, never project-memory or execution authority.
  // These fields must never be set to true at the profile level; the V7.3
  // human-confirmed authorization boundary is the only place mutation
  // authority is ever granted, and only after an explicit human decision.
  if (profile.execution_authority === true) {
    pushError(errors, "execution_authority", "a profile must never grant execution authority");
  }
  if (profile.mutation_authority === true) {
    pushError(errors, "mutation_authority", "a profile must never grant mutation authority");
  }

  if (profile.ac1_identity !== undefined) {
    if (
      !isObject(profile.ac1_identity) ||
      !isNonEmptyString(profile.ac1_identity.actor_id) ||
      !ACTOR_ID_RE.test(profile.ac1_identity.actor_id)
    ) {
      pushError(errors, "ac1_identity.actor_id", "when present, must be a non-empty 'namespace:identifier' string");
    }
  }

  if (profile.tool_allowlist !== undefined) {
    if (!Array.isArray(profile.tool_allowlist) || profile.tool_allowlist.some(tool => !isNonEmptyString(tool))) {
      pushError(errors, "tool_allowlist", "when present, must be an array of non-empty tool id strings");
    }
  }

  if (profile.confirmation_policy !== undefined) {
    if (!isObject(profile.confirmation_policy) || typeof profile.confirmation_policy.human_confirmation_required_for_mutation !== "boolean") {
      pushError(errors, "confirmation_policy.human_confirmation_required_for_mutation", "when confirmation_policy is present, this must be a boolean");
    } else if (profile.confirmation_policy.human_confirmation_required_for_mutation !== true) {
      pushError(
        errors,
        "confirmation_policy.human_confirmation_required_for_mutation",
        "must be true -- a profile may narrow but never lower the V7.3 human-confirmation requirement"
      );
    }
  }

  return errors.length === 0 ? { ok: true, errors: [] } : { ok: false, errors };
}
