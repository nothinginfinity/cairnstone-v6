// V7.4 -- generalized provider-neutral agent profile schema/identity contract
// and cross-project profile registry.
//
// V7.4.0 shipped a schema-only contract plus a single hardcoded profile
// (`cairnstone-maintainer`) with grounding-class classification logic
// written as bespoke, profile-specific JavaScript. This module generalizes
// that into a reusable system:
//
//   - `AGENT_PROFILE_REGISTRY` / `getAgentProfile` resolve any accepted
//     profile by id, not just `cairnstone-maintainer`.
//   - `scope.allowed_chains` lets one profile definition operate across more
//     than one CairnStone project-memory chain (the literal "cross-project"
//     part of the V7.4 roadmap ask), while still failing closed on any chain
//     not explicitly listed.
//   - Grounding-class classification is now a small, generic, declarative
//     rule engine (`classification_rules` on a profile's `grounding_policy`)
//     instead of one hand-written function tied to authorization language.
//     Two additional example profiles -- `repo-debugger` and
//     `release-reviewer` -- prove the generalization holds for domains other
//     than tool-authorization lifecycle, using only already-registered,
//     automatic-authorization read tools (no new tool-execution surface is
//     introduced by this slice).
//
// `classifyGroundingTask` keeps its original single-argument
// (`classifyGroundingTask(task)`) call form for exact backward compatibility
// with the V7.4.0 `cairnstone-maintainer` acceptance fixture: that form
// defaults to the maintainer profile's own `classification_rules`, which are
// a faithful declarative transcription of the original V7.4.0 logic, so all
// V7.4.0 acceptance evidence for that profile remains valid unchanged.
//
// A profile is still configuration, never project-memory or execution
// authority: it can never grant execution or mutation authority, and it can
// only narrow -- never promote -- historical evidence into live/current
// authority. See docs/AI_OPERATING_GUIDE.md and the V7.4.0 plan Stone
// (project-memory/v740-operational-grounding-agent-profile-plan.md) for the
// original rationale this contract is built against.

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

// ---------------------------------------------------------------------------
// Declarative grounding-classification rule engine
// ---------------------------------------------------------------------------
//
// A rule is plain, JSON-serializable data (no functions), so profiles remain
// safe to clone (JSON round-trip) and to eventually surface as configuration
// through an API without any code-injection surface. Matching semantics:
//
//   - `all_of_groups`: array of { any_of: string[] } groups. The rule
//     matches only if, for every group, at least one keyword in that group's
//     `any_of` appears in the lowercased task text (case-insensitive
//     substring match). Groups are ANDed; keywords within a group are ORed.
//   - `none_of` (optional): array of keywords; if any appears, the rule does
//     not match, regardless of `all_of_groups`.
//   - `require_extract` (optional): name of an entry in `EXTRACTORS`. The
//     rule only matches if that extractor returns a non-null value for the
//     task text.
//   - `reads_template` (required when `grounding_class` is
//     "operational_current", must be absent/empty otherwise): array of
//     { tool_id, arguments } describing the live reads to plan if this rule
//     fires. Argument values equal to the literal string "$CHAIN" or
//     "$EXTRACTED" are substituted at classification time with the current
//     delegation chain and the extractor's matched value, respectively.
//
// Rules are evaluated in array order; the first match wins. A profile with
// no `classification_rules` (or an empty array) can still receive
// `accepted_state` / `historical_explanatory` results via the shared
// built-in fallback rule below, but can never automatically classify
// anything as `operational_current` -- it simply has no declared
// operational-current rules to match.

export const EXTRACTORS = Object.freeze({
  authorization_id: text => {
    const match = text.match(/sha256:[0-9a-f]{64}/i);
    return match ? match[0].toLowerCase() : null;
  },
  path_reference: text => {
    const match = text.match(/[\w][\w./-]*\.(?:md|js|jsx|ts|tsx|json|ya?ml|toml|sql)\b/i);
    return match ? match[0] : null;
  }
});

const FALLBACK_CLASSIFICATION_RULE = Object.freeze({
  id: "default_non_operational",
  grounding_class: "historical_explanatory",
  domain: "project_memory",
  intent: "general_grounded_reasoning",
  all_of_groups: [],
  reads_template: []
});

const HISTORICAL_EXPLANATORY_RULE = Object.freeze({
  id: "historical_explanatory_query",
  grounding_class: "historical_explanatory",
  domain: "project_memory",
  intent: "historical_explanation",
  all_of_groups: [
    { any_of: ["why", "how", "explain", "reason", "what happened", "history", "historical"] }
  ],
  reads_template: []
});

// Faithful declarative transcription of the original V7.4.0
// `cairnstone-maintainer` classification logic. Preserved exactly so the
// V7.4.0 acceptance fixture (`What are the most recent authorizations I
// approved`) and its full acceptance matrix remain valid without re-proof.
export const CAIRNSTONE_MAINTAINER_CLASSIFICATION_RULES = Object.freeze([
  Object.freeze({
    id: "known_authorization_live_status",
    grounding_class: "operational_current",
    domain: "tool_authorizations",
    intent: "authorization_status",
    require_extract: "authorization_id",
    all_of_groups: [
      { any_of: ["authorization", "authorizations", "approval", "approvals", "approved"] },
      {
        any_of: [
          "current", "currently", "latest", "most recent", "recent", "still", "now", "already",
          "pending", "approved", "status", "executed", "consumed", "replayed", "failed",
          "succeeded", "complete", "completed"
        ]
      }
    ],
    reads_template: [
      { tool_id: "cairnstone_tool_authorization_status", arguments: { authorization_request_id: "$EXTRACTED" } }
    ]
  }),
  Object.freeze({
    id: "authorization_discovery_pending",
    grounding_class: "operational_current",
    domain: "tool_authorizations",
    intent: "recent_pending_authorizations",
    none_of: ["approved"],
    all_of_groups: [
      { any_of: ["authorization", "authorizations", "approval", "approvals", "approved"] },
      { any_of: ["pending"] }
    ],
    reads_template: [
      { tool_id: "cairnstone_tool_authorization_list", arguments: { status: "pending", limit: 5 } }
    ]
  }),
  Object.freeze({
    id: "authorization_discovery_live_first",
    grounding_class: "operational_current",
    domain: "tool_authorizations",
    intent: "recent_approved_authorizations",
    all_of_groups: [
      { any_of: ["authorization", "authorizations", "approval", "approvals", "approved"] },
      {
        any_of: [
          "current", "currently", "latest", "most recent", "recent", "still", "now", "already",
          "pending", "approved", "status", "executed", "consumed", "replayed", "failed",
          "succeeded", "complete", "completed"
        ]
      }
    ],
    reads_template: [
      { tool_id: "cairnstone_tool_authorization_list", arguments: { decision: "approved", limit: 5 } }
    ]
  }),
  Object.freeze({
    id: "accepted_authority_query",
    grounding_class: "accepted_state",
    domain: "cairnstone_authority",
    intent: "canonical_accepted_state",
    all_of_groups: [
      { any_of: ["current", "canonical", "accepted", "latest"] },
      { any_of: ["head", "accepted state", "project memory", "project-memory", "path head", "chain head"] }
    ],
    reads_template: []
  }),
  HISTORICAL_EXPLANATORY_RULE
]);

// Example generalization: repo-debugger cares about whether accepted
// CairnStone project-memory state is drifted from the live GitHub tree, not
// about authorization lifecycle. It reuses existing, already-registered,
// automatic-authorization read tools (`cairnstone_reconcile_repo`,
// `cairnstone_get_source_freshness`, `cairnstone_check_source_freshness`) --
// this slice introduces no new tool-execution surface.
export const REPO_DEBUGGER_CLASSIFICATION_RULES = Object.freeze([
  Object.freeze({
    id: "repo_drift_live_check",
    grounding_class: "operational_current",
    domain: "repo_state",
    intent: "repo_drift_check",
    all_of_groups: [
      { any_of: ["drift", "drifted", "out of sync", "out-of-sync", "in sync", "stale", "fresh", "freshness", "reconcile"] },
      { any_of: ["current", "currently", "now", "still", "latest", "today"] }
    ],
    reads_template: [
      { tool_id: "cairnstone_reconcile_repo", arguments: { chain: "$CHAIN" } }
    ]
  }),
  Object.freeze({
    id: "repo_path_freshness_check",
    grounding_class: "operational_current",
    domain: "repo_state",
    intent: "path_freshness_check",
    require_extract: "path_reference",
    all_of_groups: [
      { any_of: ["current", "currently", "latest", "up to date", "up-to-date", "fresh", "stale", "outdated", "still accepted"] }
    ],
    reads_template: [
      { tool_id: "cairnstone_get_source_freshness", arguments: { chain: "$CHAIN", path: "$EXTRACTED" } }
    ]
  }),
  Object.freeze({
    id: "repo_debug_history_explanation",
    grounding_class: "historical_explanatory",
    domain: "project_memory",
    intent: "historical_explanation",
    all_of_groups: [
      { any_of: ["why", "how", "explain", "reason", "regression", "root cause", "history", "historical"] }
    ],
    reads_template: []
  }),
  FALLBACK_CLASSIFICATION_RULE
]);

// Example generalization: release-reviewer cares about whether accepted
// release-facing documentation (release notes, changelog, README) is still
// current relative to the live GitHub source, using the same cheap,
// no-GitHub-call `cairnstone_get_source_freshness` read used by
// repo-debugger, applied to a path extracted from the task text.
export const RELEASE_REVIEWER_CLASSIFICATION_RULES = Object.freeze([
  Object.freeze({
    id: "release_doc_freshness_check",
    grounding_class: "operational_current",
    domain: "release_docs",
    intent: "release_doc_freshness_check",
    require_extract: "path_reference",
    all_of_groups: [
      { any_of: ["release notes", "changelog", "release doc", "readme", "roadmap"] },
      { any_of: ["current", "currently", "latest", "up to date", "up-to-date", "fresh", "stale", "outdated", "still"] }
    ],
    reads_template: [
      { tool_id: "cairnstone_get_source_freshness", arguments: { chain: "$CHAIN", path: "$EXTRACTED" } }
    ]
  }),
  Object.freeze({
    id: "release_review_history_explanation",
    grounding_class: "historical_explanatory",
    domain: "project_memory",
    intent: "historical_explanation",
    all_of_groups: [
      { any_of: ["why", "how", "explain", "reason", "history", "historical", "what changed"] }
    ],
    reads_template: []
  }),
  FALLBACK_CLASSIFICATION_RULE
]);

function keywordGroupMatches(group, text) {
  if (!group || !Array.isArray(group.any_of) || group.any_of.length === 0) return false;
  return group.any_of.some(keyword => typeof keyword === "string" && keyword.length > 0 && text.includes(keyword.toLowerCase()));
}

function ruleMatches(rule, text, originalText) {
  if (Array.isArray(rule.none_of) && rule.none_of.some(keyword => typeof keyword === "string" && text.includes(keyword.toLowerCase()))) {
    return { matched: false, extracted: null };
  }
  let extracted = null;
  if (rule.require_extract) {
    const extractor = EXTRACTORS[rule.require_extract];
    extracted = typeof extractor === "function" ? extractor(originalText) : null;
    if (extracted === null || extracted === undefined) return { matched: false, extracted: null };
  }
  const groups = Array.isArray(rule.all_of_groups) ? rule.all_of_groups : [];
  if (groups.length === 0 && rule.id !== FALLBACK_CLASSIFICATION_RULE.id) return { matched: false, extracted: null };
  const allGroupsMatch = groups.every(group => keywordGroupMatches(group, text));
  if (!allGroupsMatch && rule.id !== FALLBACK_CLASSIFICATION_RULE.id) return { matched: false, extracted: null };
  return { matched: true, extracted };
}

function substitutePlaceholder(value, context) {
  if (value === "$CHAIN") return context.chain ?? null;
  if (value === "$EXTRACTED") return context.extracted ?? null;
  return value;
}

function buildReadsFromTemplate(readsTemplate, context) {
  if (!Array.isArray(readsTemplate)) return [];
  return readsTemplate.map(read => ({
    tool_id: read.tool_id,
    arguments: Object.fromEntries(
      Object.entries(read.arguments || {}).map(([key, value]) => [key, substitutePlaceholder(value, context)])
    )
  }));
}

/**
 * Deterministically classify a task's grounding class using a profile's
 * declarative `classification_rules`. Accepts either:
 *   - `classifyGroundingTask(task)` -- backward-compatible single-argument
 *     form, defaulting to the `cairnstone-maintainer` profile's rules; or
 *   - `classifyGroundingTask(profile, task, context?)` -- generalized form
 *     used for any profile. `context.chain`, when supplied, is available to
 *     rules as the "$CHAIN" placeholder.
 * Pure and synchronous; never throws.
 */
export function classifyGroundingTask(profileOrTask, maybeTask, maybeContext) {
  let profile;
  let task;
  let context;
  if (typeof profileOrTask === "string") {
    profile = CAIRNSTONE_MAINTAINER_PROFILE;
    task = profileOrTask;
    context = {};
  } else {
    profile = profileOrTask;
    task = maybeTask;
    context = isObject(maybeContext) ? maybeContext : {};
  }

  const original = typeof task === "string" ? task.trim() : "";
  const text = original.toLowerCase();
  const rules = isObject(profile) && isObject(profile.grounding_policy) && Array.isArray(profile.grounding_policy.classification_rules)
    ? profile.grounding_policy.classification_rules
    : [];

  for (const rule of rules) {
    const { matched, extracted } = ruleMatches(rule, text, original);
    if (!matched) continue;
    const readContext = { chain: context.chain, extracted };
    return {
      grounding_class: rule.grounding_class,
      domain: rule.domain,
      intent: rule.intent,
      matched_rule: rule.id,
      extracted_value: extracted,
      reads: buildReadsFromTemplate(rule.reads_template, readContext)
    };
  }

  const fallbackMatch = ruleMatches(FALLBACK_CLASSIFICATION_RULE, text, original);
  return {
    grounding_class: FALLBACK_CLASSIFICATION_RULE.grounding_class,
    domain: FALLBACK_CLASSIFICATION_RULE.domain,
    intent: FALLBACK_CLASSIFICATION_RULE.intent,
    matched_rule: FALLBACK_CLASSIFICATION_RULE.id,
    extracted_value: fallbackMatch.extracted,
    reads: []
  };
}

/**
 * Plan the live reads (if any) implied by a classification, subject to the
 * profile's domain tool map and tool_allowlist. Fully generic: it never
 * branches on a specific profile_id or intent -- the reads themselves were
 * already computed declaratively by classifyGroundingTask.
 */
export function planProfileGroundingReads(profile, classification) {
  const validation = validateAgentProfile(profile);
  if (!validation.ok) return { ok: false, error: "agent_profile_invalid", errors: validation.errors };
  if (!classification || !profile.grounding_policy.grounding_classes_enabled.includes(classification.grounding_class)) {
    return { ok: false, error: "grounding_class_not_enabled", grounding_class: classification?.grounding_class || null };
  }
  if (classification.grounding_class !== "operational_current") {
    return { ok: true, reads: [] };
  }

  const domainTools = new Set(profile.grounding_policy.live_read_tools_by_domain[classification.domain] || []);
  const profileAllowlist = new Set(profile.tool_allowlist || []);
  const reads = Array.isArray(classification.reads) ? classification.reads : [];

  for (const read of reads) {
    if (!domainTools.has(read.tool_id) || !profileAllowlist.has(read.tool_id)) {
      return { ok: false, error: "profile_live_read_not_allowed", tool_id: read.tool_id, domain: classification.domain };
    }
  }
  return { ok: true, reads };
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

function validateClassificationRules(rules, errors, path) {
  if (rules === undefined) return;
  if (!Array.isArray(rules)) {
    pushError(errors, path, "when present, must be an array of classification rule objects");
    return;
  }
  rules.forEach((rule, index) => {
    const rulePath = `${path}[${index}]`;
    if (!isObject(rule)) {
      pushError(errors, rulePath, "must be an object");
      return;
    }
    if (!isNonEmptyString(rule.id)) pushError(errors, `${rulePath}.id`, "must be a non-empty string");
    if (!GROUNDING_CLASSES.includes(rule.grounding_class)) {
      pushError(errors, `${rulePath}.grounding_class`, `must be one of ${GROUNDING_CLASSES.join(", ")}`);
    }
    if (!isNonEmptyString(rule.domain)) pushError(errors, `${rulePath}.domain`, "must be a non-empty string");
    if (!isNonEmptyString(rule.intent)) pushError(errors, `${rulePath}.intent`, "must be a non-empty string");
    if (rule.all_of_groups !== undefined) {
      if (!Array.isArray(rule.all_of_groups) || rule.all_of_groups.some(group => !isObject(group) || !Array.isArray(group.any_of) || group.any_of.some(kw => typeof kw !== "string" || !kw.length))) {
        pushError(errors, `${rulePath}.all_of_groups`, "when present, must be an array of { any_of: string[] } groups");
      }
    }
    if (rule.none_of !== undefined && (!Array.isArray(rule.none_of) || rule.none_of.some(kw => typeof kw !== "string" || !kw.length))) {
      pushError(errors, `${rulePath}.none_of`, "when present, must be an array of non-empty strings");
    }
    if (rule.require_extract !== undefined && !Object.prototype.hasOwnProperty.call(EXTRACTORS, rule.require_extract)) {
      pushError(errors, `${rulePath}.require_extract`, `unknown extractor '${rule.require_extract}'`);
    }
    const readsTemplate = Array.isArray(rule.reads_template) ? rule.reads_template : [];
    if (rule.grounding_class === "operational_current") {
      if (readsTemplate.length === 0) {
        pushError(errors, `${rulePath}.reads_template`, "operational_current rules must declare at least one read");
      }
    } else if (readsTemplate.length > 0) {
      pushError(errors, `${rulePath}.reads_template`, "only operational_current rules may declare live reads -- a rule may never promote historical/accepted evidence into a live read");
    }
    readsTemplate.forEach((read, readIndex) => {
      if (!isObject(read) || !isNonEmptyString(read.tool_id) || !isObject(read.arguments || {})) {
        pushError(errors, `${rulePath}.reads_template[${readIndex}]`, "must be an object with a non-empty tool_id and an arguments object");
      }
    });
  });
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

  validateClassificationRules(policy.classification_rules, errors, `${path}.classification_rules`);
}

/**
 * Deterministically validate a candidate agent profile object against the
 * V7.4 minimal profile schema/identity contract. Pure and synchronous;
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
  if (profile.scope !== undefined && isObject(profile.scope) && profile.scope.allowed_chains !== undefined) {
    if (!Array.isArray(profile.scope.allowed_chains) || profile.scope.allowed_chains.some(chain => !isNonEmptyString(chain))) {
      pushError(errors, "scope.allowed_chains", "when present, must be an array of non-empty chain-name strings");
    }
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

  if (profile.budgets !== undefined) {
    const budgets = profile.budgets;
    if (!isObject(budgets)) {
      pushError(errors, "budgets", "when present, must be an object");
    } else {
      const positiveIntegerFields = ["max_context_tokens", "max_output_tokens", "delegation_depth"];
      for (const field of positiveIntegerFields) {
        if (!Number.isInteger(budgets[field]) || budgets[field] < 1) {
          pushError(errors, `budgets.${field}`, "must be a positive integer");
        }
      }
    }
  }

  return errors.length === 0 ? { ok: true, errors: [] } : { ok: false, errors };
}

function cloneProfile(value) {
  return JSON.parse(JSON.stringify(value));
}

/**
 * True if `chain` is a chain this profile is permitted to act on: either its
 * primary `scope.chain`, or one of the profile's `scope.allowed_chains`.
 * This is the mechanism that lets one profile definition be reused across
 * multiple CairnStone project-memory chains ("cross-project") while still
 * failing closed for any chain not explicitly listed.
 */
export function profileAllowsChain(profile, chain) {
  if (!isObject(profile) || !isObject(profile.scope) || !isNonEmptyString(chain)) return false;
  if (profile.scope.chain === chain) return true;
  return Array.isArray(profile.scope.allowed_chains) && profile.scope.allowed_chains.includes(chain);
}

export const CAIRNSTONE_MAINTAINER_PROFILE = Object.freeze({
  schema: AGENT_PROFILE_SCHEMA_V1,
  profile_id: "cairnstone-maintainer",
  version: "0.1.0",
  scope: { chain: "cairnstone-v6-project-memory" },
  ac1_identity: { actor_id: "cairnstone:cairnstone-maintainer" },
  grounding_policy: {
    grounding_classes_enabled: [...GROUNDING_CLASSES],
    live_read_tools_by_domain: {
      tool_authorizations: ["cairnstone_tool_authorization_list", "cairnstone_tool_authorization_status"]
    },
    accepted_state_authority: "chain_head_and_path_head",
    historical_evidence_policy: "graph_linked_evidence_only",
    fallback_on_unavailable_live_read: "fail_closed_explicit_degraded",
    citation_provenance: { require_citations: true, prefer_head_linked_evidence: true },
    max_live_read_turns: 4,
    classification_rules: CAIRNSTONE_MAINTAINER_CLASSIFICATION_RULES
  },
  tool_allowlist: [
    "cairnstone_tool_authorization_list",
    "cairnstone_tool_authorization_status",
    "cairnstone_resume_chain",
    "cairnstone_find_v2",
    "cairnstone_expand"
  ],
  confirmation_policy: { human_confirmation_required_for_mutation: true },
  budgets: {
    max_context_tokens: 90000,
    max_output_tokens: 1200,
    delegation_depth: 1
  },
  execution_authority: false,
  mutation_authority: false
});

export const REPO_DEBUGGER_PROFILE = Object.freeze({
  schema: AGENT_PROFILE_SCHEMA_V1,
  profile_id: "repo-debugger",
  version: "0.1.1",
  scope: { chain: "cairnstone-v6-project-memory", allowed_chains: ["praxiq-call"] },
  ac1_identity: { actor_id: "cairnstone:repo-debugger" },
  grounding_policy: {
    grounding_classes_enabled: [...GROUNDING_CLASSES],
    live_read_tools_by_domain: {
      repo_state: ["cairnstone_reconcile_repo", "cairnstone_get_source_freshness", "cairnstone_check_source_freshness"]
    },
    accepted_state_authority: "chain_head_and_path_head",
    historical_evidence_policy: "graph_linked_evidence_only",
    fallback_on_unavailable_live_read: "fail_closed_explicit_degraded",
    citation_provenance: { require_citations: true, prefer_head_linked_evidence: true },
    max_live_read_turns: 4,
    classification_rules: REPO_DEBUGGER_CLASSIFICATION_RULES
  },
  tool_allowlist: [
    "cairnstone_reconcile_repo",
    "cairnstone_get_source_freshness",
    "cairnstone_check_source_freshness",
    "cairnstone_resume_chain",
    "cairnstone_find_v2",
    "cairnstone_expand"
  ],
  confirmation_policy: { human_confirmation_required_for_mutation: true },
  budgets: {
    max_context_tokens: 90000,
    max_output_tokens: 1200,
    delegation_depth: 1
  },
  execution_authority: false,
  mutation_authority: false
});

export const RELEASE_REVIEWER_PROFILE = Object.freeze({
  schema: AGENT_PROFILE_SCHEMA_V1,
  profile_id: "release-reviewer",
  version: "0.1.0",
  scope: { chain: "cairnstone-v6-project-memory", allowed_chains: [] },
  ac1_identity: { actor_id: "cairnstone:release-reviewer" },
  grounding_policy: {
    grounding_classes_enabled: [...GROUNDING_CLASSES],
    live_read_tools_by_domain: {
      release_docs: ["cairnstone_get_source_freshness"]
    },
    accepted_state_authority: "chain_head_and_path_head",
    historical_evidence_policy: "graph_linked_evidence_only",
    fallback_on_unavailable_live_read: "fail_closed_explicit_degraded",
    citation_provenance: { require_citations: true, prefer_head_linked_evidence: true },
    max_live_read_turns: 4,
    classification_rules: RELEASE_REVIEWER_CLASSIFICATION_RULES
  },
  tool_allowlist: [
    "cairnstone_get_source_freshness",
    "cairnstone_resume_chain",
    "cairnstone_find_v2",
    "cairnstone_expand"
  ],
  confirmation_policy: { human_confirmation_required_for_mutation: true },
  budgets: {
    max_context_tokens: 90000,
    max_output_tokens: 1200,
    delegation_depth: 1
  },
  execution_authority: false,
  mutation_authority: false
});

// Cross-project profile registry. Adding a new reusable profile is a
// data-only change: define its fixture and classification rules above, then
// register it here. `getAgentProfile` never special-cases a profile_id in
// code.
export const AGENT_PROFILE_REGISTRY = Object.freeze({
  [CAIRNSTONE_MAINTAINER_PROFILE.profile_id]: CAIRNSTONE_MAINTAINER_PROFILE,
  [REPO_DEBUGGER_PROFILE.profile_id]: REPO_DEBUGGER_PROFILE,
  [RELEASE_REVIEWER_PROFILE.profile_id]: RELEASE_REVIEWER_PROFILE
});

export function getAgentProfile(profileId) {
  const entry = typeof profileId === "string" ? AGENT_PROFILE_REGISTRY[profileId] : undefined;
  if (!entry) {
    return { ok: false, error: "agent_profile_not_found", profile_id: profileId || null };
  }
  const profile = cloneProfile(entry);
  const validation = validateAgentProfile(profile);
  if (!validation.ok) return { ok: false, error: "agent_profile_invalid", errors: validation.errors };
  return { ok: true, profile };
}
