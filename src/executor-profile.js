// V7.7.10d — Executor profile registry + capability-aware route (proposal only)
//
// Operational registry for cairnstone-executor-profile-v1. Distinct from the
// conversational model router (cairnstone_model_route). Routing NEVER
// dispatches, NEVER launches agents, NEVER moves HEADs, NEVER mints capability. accepted_state_authority is always false.

export const EXECUTOR_PROFILE_SCHEMA = "cairnstone-executor-profile-v1";
export const EXECUTOR_ROUTE_RECEIPT_SCHEMA = "cairnstone-executor-route-receipt-v1";

export const EXECUTOR_BROKER_TOOL_IDS = Object.freeze({
  list: "cairnstone_executor_list",
  get: "cairnstone_executor_get",
  health: "cairnstone_executor_health",
  route: "cairnstone_executor_route"
});

export const EXECUTOR_READ_TOOL_IDS = Object.freeze([
  EXECUTOR_BROKER_TOOL_IDS.list,
  EXECUTOR_BROKER_TOOL_IDS.get,
  EXECUTOR_BROKER_TOOL_IDS.health,
  EXECUTOR_BROKER_TOOL_IDS.route
]);

export const EXECUTOR_MUTATION_TOOL_IDS = Object.freeze([]);

export const POLICY_PRESETS = Object.freeze(["economy", "balanced", "best", "manual"]);
export const COST_CLASSES = Object.freeze(["free", "low", "medium", "high", "paid_external"]);
export const LATENCY_CLASSES = Object.freeze(["sync_fast", "sync", "async", "async_long"]);
export const QUALITY_CLASSES = Object.freeze(["deterministic", "specialist", "balanced", "premium"]);

/** V7.7.10d.1 — how context is delivered to an executor. */
export const CONTEXT_MODES = Object.freeze({
  cairnstone_native: "cairnstone_native",
  compiled_context: "compiled_context"
});

/** Route/dispatch receipt encoding of how context was resolved. */
export const CONTEXT_RESOLUTION = Object.freeze({
  reference_only_native: "reference_only_native",
  compiled_transmitted: "compiled_transmitted"
});

export const SUPPORTED_REF_TYPES = Object.freeze([
  "stone_hash",
  "attachment_ref",
  "code_session_id",
  "path_head",
  "repo_sha",
  "access_grant_id",
  "scope",
  "task_run_id",
  "msg_ref"
]);

/** Default ref types CairnStone-native executors can resolve themselves. */
export const NATIVE_SUPPORTED_REF_TYPES = Object.freeze([
  "stone_hash",
  "attachment_ref",
  "code_session_id",
  "path_head",
  "repo_sha",
  "access_grant_id",
  "scope",
  "task_run_id",
  "msg_ref"
]);

/** External compiled executors get a narrower typed-ref surface in the pack. */
export const COMPILED_SUPPORTED_REF_TYPES = Object.freeze([
  "attachment_ref",
  "repo_sha",
  "stone_hash",
  "task_run_id",
  "msg_ref"
]);

/** Bounded compiled-context pack budgets (fail closed past these). */
export const COMPILED_CONTEXT_BUDGET = Object.freeze({
  max_pack_bytes: 48_000,
  max_body_chars: 24_000,
  max_refs: 100,
  max_omission_entries: 64
});

/** Preferred selection order ranks (fabric plan §5). Lower = preferred. */
export const EXECUTOR_SELECTION_RANK = Object.freeze({
  deterministic: 1,
  narrow_specialist: 2,
  inexpensive_model: 3,
  coding_agent: 4,
  premium_general: 5,
  paid_external: 6
});

const ACTOR_ID_RE = /^[a-z0-9][a-z0-9._-]{0,63}:[a-z0-9][a-z0-9._-]{0,127}$/i;
const EXECUTOR_ID_RE = /^exec:[a-z0-9][a-z0-9._-]{0,127}$/i;
const TASK_RUN_ID_RE = /^tr:[a-z0-9][a-z0-9._-]{0,127}$/i;
const MAX_CAPS = 64;
const MAX_REFS = 100;
const MAX_REF_LEN = 256;

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function authorityClosedFields() {
  return {
    accepted_state_authority: false,
    chain_heads_mutated: false,
    path_heads_mutated: false,
    grants_no_capability: true,
    dispatched: false,
    executor_invoked: false,
    model_router_authority: false
  };
}

/**
 * In-code seed registry. Operational only — not accepted-state authority.
 * Adapter contracts for AFO/Copilot/Cursor are stub/dry-run until live hooks exist.
 */
export const SEED_EXECUTOR_PROFILES = Object.freeze([
  Object.freeze({
    schema: EXECUTOR_PROFILE_SCHEMA,
    executor_id: "exec:deterministic-mcp",
    executor_class: "deterministic_mcp",
    adapter_id: "adapter:deterministic-mcp-v1",
    selection_rank: EXECUTOR_SELECTION_RANK.deterministic,
    availability: "available",
    health: Object.freeze({ status: "healthy", adapter_live: true, checked_at: null }),
    capabilities: Object.freeze([
      "repo.read",
      "repo.search",
      "d1.inspect",
      "cloudflare.inspect",
      "stone.read",
      "attachment.resolve"
    ]),
    risk_classes_supported: Object.freeze(["read"]),
    authorization_requirements: Object.freeze(["scoped_grant"]),
    execution_mode: "sync",
    cost_class: "free",
    latency_class: "sync_fast",
    quality_class: "deterministic",
    // V7.7.10d.1 — in-process / CairnStone-connected: resolve refs natively
    context_mode: CONTEXT_MODES.cairnstone_native,
    requires_compiled_context: false,
    supported_ref_types: NATIVE_SUPPORTED_REF_TYPES,
    context_resolution_endpoint: "in_process:cairnstone",
    verification_capabilities: Object.freeze(["receipt.emit", "tool_result.hash"]),
    supported_artifact_types: Object.freeze(["tool_receipt", "orientation"]),
    max_concurrency: 8,
    bounds: Object.freeze({
      max_tool_calls: 1,
      allowlisted_read_tools_only: true,
      mutation_allowed: false
    }),
    notes: "Bounded allowlisted read tools via existing broker; proves specialist path on dispatch. CairnStone-native context."
  }),
  Object.freeze({
    schema: EXECUTOR_PROFILE_SCHEMA,
    executor_id: "exec:afo-specialist",
    executor_class: "afo_specialist",
    adapter_id: "adapter:afo-specialist-v1",
    selection_rank: EXECUTOR_SELECTION_RANK.narrow_specialist,
    availability: "stub",
    health: Object.freeze({ status: "stub", adapter_live: false, dry_run: true, checked_at: null }),
    capabilities: Object.freeze([
      "github.api",
      "repo.search",
      "repo.read",
      "cloudflare.inspect",
      "d1.inspect",
      "background.run"
    ]),
    risk_classes_supported: Object.freeze(["read", "mutation"]),
    authorization_requirements: Object.freeze(["scoped_grant", "human_confirmation"]),
    execution_mode: "async",
    cost_class: "low",
    latency_class: "async",
    quality_class: "specialist",
    // External specialist — needs bounded compiled pack
    context_mode: CONTEXT_MODES.compiled_context,
    requires_compiled_context: true,
    supported_ref_types: COMPILED_SUPPORTED_REF_TYPES,
    context_resolution_endpoint: null,
    verification_capabilities: Object.freeze(["receipt.emit", "artifact.attach"]),
    supported_artifact_types: Object.freeze(["investigation_receipt", "api_result"]),
    max_concurrency: 4,
    bounds: Object.freeze({
      adapter_live: false,
      dry_run_default: true,
      mutation_allowed: false
    }),
    notes: "AFO specialist adapter contract + stub. Live AFO not required for 10d. Compiled context required."
  }),
  Object.freeze({
    schema: EXECUTOR_PROFILE_SCHEMA,
    executor_id: "exec:cairnstone-delegate",
    executor_class: "delegated_model",
    adapter_id: "adapter:cairnstone-delegate-v1",
    selection_rank: EXECUTOR_SELECTION_RANK.inexpensive_model,
    availability: "available",
    health: Object.freeze({ status: "healthy", adapter_live: false, dry_run: true, checked_at: null }),
    capabilities: Object.freeze([
      "repo.read",
      "repo.search",
      "stone.read",
      "synthesis.bounded",
      "reasoning.general"
    ]),
    risk_classes_supported: Object.freeze(["read"]),
    authorization_requirements: Object.freeze(["scoped_grant", "human_confirmation"]),
    execution_mode: "async",
    cost_class: "low",
    latency_class: "async",
    quality_class: "balanced",
    context_mode: CONTEXT_MODES.cairnstone_native,
    requires_compiled_context: false,
    supported_ref_types: NATIVE_SUPPORTED_REF_TYPES,
    context_resolution_endpoint: "in_process:cairnstone_delegate",
    verification_capabilities: Object.freeze(["receipt.emit", "subagent_result"]),
    supported_artifact_types: Object.freeze(["subagent_result", "tool_receipt"]),
    max_concurrency: 2,
    bounds: Object.freeze({
      points_at_existing_delegate_path: true,
      does_not_auto_run: true,
      dry_run_default: true
    }),
    notes: "Points at existing cairnstone_delegate path; does not auto-run on route or propose. CairnStone-native context."
  }),
  Object.freeze({
    schema: EXECUTOR_PROFILE_SCHEMA,
    executor_id: "exec:github-copilot",
    executor_class: "coding_agent",
    adapter_id: "adapter:github-copilot-v1",
    selection_rank: EXECUTOR_SELECTION_RANK.coding_agent,
    availability: "stub",
    health: Object.freeze({ status: "stub", adapter_live: false, dry_run: true, checked_at: null }),
    capabilities: Object.freeze([
      "repo.read",
      "repo.search",
      "repo.edit",
      "repo.diff",
      "repo.pr",
      "repo.test",
      "github.api"
    ]),
    risk_classes_supported: Object.freeze(["read", "mutation", "execution"]),
    authorization_requirements: Object.freeze(["human_confirmation"]),
    execution_mode: "async",
    cost_class: "medium",
    latency_class: "async_long",
    quality_class: "premium",
    // External coding agent — no CairnStone MCP assumed
    context_mode: CONTEXT_MODES.compiled_context,
    requires_compiled_context: true,
    supported_ref_types: COMPILED_SUPPORTED_REF_TYPES,
    context_resolution_endpoint: null,
    verification_capabilities: Object.freeze(["pr.attach", "diff.attach", "test.attach", "receipt.emit"]),
    supported_artifact_types: Object.freeze(["pr", "diff", "test_result", "job_stub"]),
    max_concurrency: 2,
    bounds: Object.freeze({
      adapter_live: false,
      dry_run_default: true,
      requires_immutable_base_sha: true
    }),
    notes: "GitHub Copilot coding-agent adapter contract + dry-run stub. No API keys invented. Compiled context required."
  }),
  Object.freeze({
    schema: EXECUTOR_PROFILE_SCHEMA,
    executor_id: "exec:cursor-cloud",
    executor_class: "coding_agent",
    adapter_id: "adapter:cursor-cloud-v1",
    selection_rank: EXECUTOR_SELECTION_RANK.coding_agent,
    availability: "stub",
    health: Object.freeze({ status: "stub", adapter_live: false, dry_run: true, checked_at: null }),
    capabilities: Object.freeze([
      "repo.read",
      "repo.search",
      "repo.edit",
      "repo.diff",
      "repo.pr",
      "repo.test",
      "background.run"
    ]),
    risk_classes_supported: Object.freeze(["read", "mutation", "execution"]),
    authorization_requirements: Object.freeze(["human_confirmation"]),
    execution_mode: "async",
    cost_class: "medium",
    latency_class: "async_long",
    quality_class: "premium",
    // Cursor often has CairnStone MCP connected — native-capable even while adapter dry-run
    context_mode: CONTEXT_MODES.cairnstone_native,
    requires_compiled_context: false,
    supported_ref_types: NATIVE_SUPPORTED_REF_TYPES,
    context_resolution_endpoint: "mcp:cairnstone",
    verification_capabilities: Object.freeze(["pr.attach", "diff.attach", "test.attach", "receipt.emit"]),
    supported_artifact_types: Object.freeze(["pr", "diff", "test_result", "job_stub"]),
    max_concurrency: 2,
    bounds: Object.freeze({
      adapter_live: false,
      dry_run_default: true,
      requires_immutable_base_sha: true
    }),
    notes: "Cursor/cloud coding-agent adapter contract + dry-run stub. CairnStone-native context capable."
  })
]);

const PROFILE_BY_ID = new Map(SEED_EXECUTOR_PROFILES.map(p => [p.executor_id, p]));

function cloneProfile(profile, { now = null } = {}) {
  const checkedAt = now || new Date().toISOString();
  return {
    ...profile,
    capabilities: [...profile.capabilities],
    risk_classes_supported: [...profile.risk_classes_supported],
    authorization_requirements: [...profile.authorization_requirements],
    verification_capabilities: [...profile.verification_capabilities],
    supported_artifact_types: [...profile.supported_artifact_types],
    supported_ref_types: [...(profile.supported_ref_types || [])],
    context_mode: profile.context_mode || CONTEXT_MODES.compiled_context,
    requires_compiled_context: profile.requires_compiled_context === true
      || profile.context_mode === CONTEXT_MODES.compiled_context,
    context_resolution_endpoint: profile.context_resolution_endpoint || null,
    bounds: { ...profile.bounds },
    health: {
      ...profile.health,
      checked_at: profile.health?.checked_at || checkedAt
    },
    accepted_state_authority: false
  };
}

export function listExecutorProfiles({ executor_class = null, availability = null } = {}) {
  let profiles = SEED_EXECUTOR_PROFILES.map(p => cloneProfile(p));
  if (executor_class) {
    profiles = profiles.filter(p => p.executor_class === String(executor_class).trim());
  }
  if (availability) {
    profiles = profiles.filter(p => p.availability === String(availability).trim());
  }
  return {
    ok: true,
    schema: EXECUTOR_PROFILE_SCHEMA,
    total: profiles.length,
    executors: profiles,
    ...authorityClosedFields()
  };
}

export function getExecutorProfile(executor_id) {
  if (!isNonEmptyString(executor_id) || !EXECUTOR_ID_RE.test(String(executor_id).trim())) {
    return { ok: false, error: "invalid_executor_id", ...authorityClosedFields() };
  }
  const id = String(executor_id).trim();
  const profile = PROFILE_BY_ID.get(id);
  if (!profile) {
    return { ok: false, error: "executor_not_found", executor_id: id, ...authorityClosedFields() };
  }
  return {
    ok: true,
    schema: EXECUTOR_PROFILE_SCHEMA,
    executor: cloneProfile(profile),
    ...authorityClosedFields()
  };
}

export function executorHealth(executor_id = null) {
  const now = new Date().toISOString();
  if (executor_id) {
    const got = getExecutorProfile(executor_id);
    if (!got.ok) return got;
    return {
      ok: true,
      schema: EXECUTOR_PROFILE_SCHEMA,
      checked_at: now,
      executor_id: got.executor.executor_id,
      health: { ...got.executor.health, checked_at: now },
      availability: got.executor.availability,
      adapter_id: got.executor.adapter_id,
      ...authorityClosedFields()
    };
  }
  const items = SEED_EXECUTOR_PROFILES.map(p => ({
    executor_id: p.executor_id,
    availability: p.availability,
    adapter_id: p.adapter_id,
    health: { ...p.health, checked_at: now }
  }));
  return {
    ok: true,
    schema: EXECUTOR_PROFILE_SCHEMA,
    checked_at: now,
    total: items.length,
    executors: items,
    ...authorityClosedFields()
  };
}

function normalizeCapabilityList(input, field = "required_capabilities") {
  const list = Array.isArray(input) ? input : [];
  if (list.length > MAX_CAPS) {
    return { ok: false, error: `${field}_too_large`, max: MAX_CAPS };
  }
  const out = [];
  for (const item of list) {
    if (!isNonEmptyString(item)) {
      return { ok: false, error: `invalid_${field}_entry` };
    }
    const cap = String(item).trim().slice(0, 128);
    if (!/^[a-z][a-z0-9._-]{0,127}$/i.test(cap)) {
      return { ok: false, error: `invalid_${field}_entry`, detail: cap };
    }
    out.push(cap);
  }
  return { ok: true, [field]: [...new Set(out)] };
}

function normalizeRefHints(input) {
  const list = Array.isArray(input) ? input : [];
  if (list.length > MAX_REFS) return { ok: false, error: "attachment_refs_too_large", max: MAX_REFS };
  const out = [];
  for (const item of list) {
    const raw = typeof item === "string"
      ? item
      : (item && typeof item === "object" ? (item.object_ref || item.ref || item.attachment_ref) : null);
    if (!isNonEmptyString(raw)) continue;
    out.push(String(raw).trim().slice(0, MAX_REF_LEN));
  }
  return { ok: true, refs: [...new Set(out)] };
}

/**
 * Infer capability requirements from refs + explicit caps + work hints.
 * Pure heuristic — never grants capability.
 */
export function inferRequiredCapabilities({
  required_capabilities = [],
  attachment_refs = [],
  object_refs = [],
  work_hints = []
} = {}) {
  const caps = new Set(
    (Array.isArray(required_capabilities) ? required_capabilities : [])
      .filter(c => typeof c === "string" && c.trim())
      .map(c => c.trim())
  );
  const refs = [
    ...(Array.isArray(attachment_refs) ? attachment_refs : []),
    ...(Array.isArray(object_refs) ? object_refs : [])
  ].map(r => String(r || ""));
  const hints = (Array.isArray(work_hints) ? work_hints : [])
    .map(h => String(h || "").toLowerCase());

  for (const ref of refs) {
    if (ref.startsWith("repo:")) {
      caps.add("repo.read");
    } else if (ref.startsWith("stone:") || ref.startsWith("msg:") || ref.startsWith("cvs:")) {
      caps.add("stone.read");
    } else if (ref.startsWith("cs:") || ref.startsWith("ws:")) {
      caps.add("repo.read");
    }
  }

  const hintText = hints.join(" ");
  if (/\b(pr|pull.?request|diff|edit|patch|implement|fix|coding)\b/.test(hintText)) {
    caps.add("repo.edit");
    caps.add("repo.diff");
  }
  if (/\b(pr|pull.?request)\b/.test(hintText)) caps.add("repo.pr");
  if (/\btests?\b/.test(hintText)) caps.add("repo.test");
  if (/\b(github|copilot)\b/.test(hintText)) caps.add("github.api");
  if (/\b(d1|sql|database)\b/.test(hintText)) caps.add("d1.inspect");
  if (/\b(cloudflare|worker|wrangler)\b/.test(hintText)) caps.add("cloudflare.inspect");
  if (/\b(reason|judge|architect|compare|synthesize)\b/.test(hintText)) {
    caps.add("reasoning.general");
  }

  if (caps.size === 0) caps.add("stone.read");
  return [...caps].sort();
}

function profileCoversCapabilities(profile, required) {
  const have = new Set(profile.capabilities || []);
  const missing = required.filter(c => !have.has(c));
  return { ok: missing.length === 0, missing };
}

function isFullyDeterministic(required) {
  const deterministicCaps = new Set([
    "repo.read",
    "repo.search",
    "d1.inspect",
    "cloudflare.inspect",
    "stone.read",
    "attachment.resolve"
  ]);
  return required.length > 0 && required.every(c => deterministicCaps.has(c));
}

function requiresCodingAgent(required) {
  return required.some(c => ["repo.edit", "repo.pr", "repo.diff", "repo.test"].includes(c));
}

function costRank(costClass) {
  const order = { free: 0, low: 1, medium: 2, high: 3, paid_external: 4 };
  return order[costClass] ?? 9;
}

function qualityRank(qualityClass) {
  const order = { deterministic: 0, specialist: 1, balanced: 2, premium: 3 };
  return order[qualityClass] ?? 9;
}

function policyAllows(profile, policy, budget) {
  if (policy === "economy" && (profile.cost_class === "high" || profile.cost_class === "paid_external")) {
    return { ok: false, reason: "economy_rejects_high_cost" };
  }
  if (policy === "economy" && profile.selection_rank >= EXECUTOR_SELECTION_RANK.premium_general) {
    return { ok: false, reason: "economy_rejects_premium" };
  }
  if (budget?.max_cost_class) {
    if (costRank(profile.cost_class) > costRank(budget.max_cost_class)) {
      return { ok: false, reason: "budget_max_cost_class_exceeded" };
    }
  }
  if (budget?.allow_paid_external === false && profile.cost_class === "paid_external") {
    return { ok: false, reason: "paid_external_not_allowed" };
  }
  // Soft budget gate: force compiled_context when operator forbids native resolution
  if (budget?.require_compiled_context === true
    && profile.context_mode === CONTEXT_MODES.cairnstone_native) {
    return { ok: false, reason: "budget_requires_compiled_context" };
  }
  if (budget?.forbid_native_context === true
    && profile.context_mode === CONTEXT_MODES.cairnstone_native) {
    return { ok: false, reason: "budget_forbids_native_context" };
  }
  if (Array.isArray(budget?.executor_allowlist) && budget.executor_allowlist.length) {
    if (!budget.executor_allowlist.includes(profile.executor_id)) {
      return { ok: false, reason: "not_in_executor_allowlist" };
    }
  }
  if (Array.isArray(budget?.executor_denylist) && budget.executor_denylist.includes(profile.executor_id)) {
    return { ok: false, reason: "executor_denylist" };
  }
  return { ok: true };
}

function contextModeRank(profile) {
  // Prefer cairnstone_native when capability/cost/rank already equal (10d.1).
  // Never overrides capability fit, risk, budget, or human preferred_executor.
  return profile.context_mode === CONTEXT_MODES.cairnstone_native ? 0 : 1;
}

function compareCandidates(a, b, policy) {
  if (policy === "best") {
    const q = qualityRank(b.quality_class) - qualityRank(a.quality_class);
    if (q !== 0) return q;
    const rank = a.selection_rank - b.selection_rank;
    if (rank !== 0) return rank;
    return contextModeRank(a) - contextModeRank(b);
  }
  if (policy === "economy") {
    const c = costRank(a.cost_class) - costRank(b.cost_class);
    if (c !== 0) return c;
    const rank = a.selection_rank - b.selection_rank;
    if (rank !== 0) return rank;
    return contextModeRank(a) - contextModeRank(b);
  }
  // balanced (default): fabric preferred order, then native context as tiebreaker
  if (a.selection_rank !== b.selection_rank) return a.selection_rank - b.selection_rank;
  const cost = costRank(a.cost_class) - costRank(b.cost_class);
  if (cost !== 0) return cost;
  return contextModeRank(a) - contextModeRank(b);
}

/**
 * Derive context_resolution fields for a selected executor profile.
 * Pure — does not grant capability or dispatch.
 */
export function resolveContextResolution(profile, { selection_reason = null } = {}) {
  const mode = profile?.context_mode === CONTEXT_MODES.cairnstone_native
    ? CONTEXT_MODES.cairnstone_native
    : CONTEXT_MODES.compiled_context;
  const requiresCompiled = mode === CONTEXT_MODES.compiled_context
    || profile?.requires_compiled_context === true;
  const resolution = mode === CONTEXT_MODES.cairnstone_native
    ? CONTEXT_RESOLUTION.reference_only_native
    : CONTEXT_RESOLUTION.compiled_transmitted;
  let reason;
  if (mode === CONTEXT_MODES.cairnstone_native) {
    reason = "executor_cairnstone_aware_resolves_canonical_refs";
  } else if (profile?.requires_compiled_context) {
    reason = "executor_requires_compiled_context_no_cairnstone_access";
  } else {
    reason = "executor_compiled_context_mode";
  }
  if (selection_reason === "preferred_executor") {
    reason = `${reason};human_preferred_executor_honored`;
  }
  return {
    context_mode: mode,
    context_resolution: resolution,
    context_resolution_reason: reason,
    requires_compiled_context: requiresCompiled,
    compiled_pack_required: requiresCompiled,
    supported_ref_types: [...(profile?.supported_ref_types || [])],
    context_resolution_endpoint: profile?.context_resolution_endpoint || null
  };
}

/**
 * Pure capability-aware executor route. NEVER dispatches.
 */
export function routeExecutor({
  required_capabilities = [],
  attachment_refs = [],
  object_refs = [],
  work_hints = [],
  policy_preset = "balanced",
  preferred_executor = null,
  budget_envelope = null,
  parent_task_run_id = null,
  actor_id = null
} = {}) {
  const policy = isNonEmptyString(policy_preset)
    ? String(policy_preset).trim().toLowerCase()
    : "balanced";
  if (!POLICY_PRESETS.includes(policy)) {
    return {
      ok: false,
      error: "invalid_policy_preset",
      allowed: [...POLICY_PRESETS],
      ...authorityClosedFields()
    };
  }

  if (actor_id !== undefined && actor_id !== null && actor_id !== "") {
    if (!isNonEmptyString(actor_id) || !ACTOR_ID_RE.test(String(actor_id).trim())) {
      return { ok: false, error: "invalid_actor_id", ...authorityClosedFields() };
    }
  }

  if (parent_task_run_id !== undefined && parent_task_run_id !== null && parent_task_run_id !== "") {
    if (!TASK_RUN_ID_RE.test(String(parent_task_run_id).trim())) {
      return { ok: false, error: "invalid_parent_task_run_id", ...authorityClosedFields() };
    }
  }

  const capsNorm = normalizeCapabilityList(required_capabilities, "required_capabilities");
  if (!capsNorm.ok) return { ...capsNorm, ...authorityClosedFields() };
  const refsNorm = normalizeRefHints([
    ...(Array.isArray(attachment_refs) ? attachment_refs : []),
    ...(Array.isArray(object_refs) ? object_refs : [])
  ]);
  if (!refsNorm.ok) return { ...refsNorm, ...authorityClosedFields() };

  const inferred = inferRequiredCapabilities({
    required_capabilities: capsNorm.required_capabilities,
    attachment_refs: refsNorm.refs,
    work_hints
  });

  const budget = isObject(budget_envelope) ? budget_envelope : {};
  const fullyDeterministic = isFullyDeterministic(inferred);
  const needsCoding = requiresCodingAgent(inferred);

  const considered = [];
  const rejected = [];
  const eligible = [];

  for (const profile of SEED_EXECUTOR_PROFILES) {
    const cover = profileCoversCapabilities(profile, inferred);
    const policyCheck = policyAllows(profile, policy, budget);
    const entry = {
      executor_id: profile.executor_id,
      executor_class: profile.executor_class,
      selection_rank: profile.selection_rank,
      cost_class: profile.cost_class,
      latency_class: profile.latency_class,
      quality_class: profile.quality_class,
      availability: profile.availability,
      context_mode: profile.context_mode,
      requires_compiled_context: profile.requires_compiled_context === true
    };
    considered.push(entry);

    if (!cover.ok) {
      rejected.push({ ...entry, reason: "missing_capabilities", missing: cover.missing });
      continue;
    }
    if (!policyCheck.ok) {
      rejected.push({ ...entry, reason: policyCheck.reason });
      continue;
    }
    // Prefer not to pick coding agents when work is fully deterministic unless preferred.
    if (fullyDeterministic && profile.selection_rank >= EXECUTOR_SELECTION_RANK.coding_agent
      && preferred_executor !== profile.executor_id) {
      rejected.push({ ...entry, reason: "deterministic_work_prefers_cheaper_executor" });
      continue;
    }
    // Prefer coding agents when repo mutation/PR work required — demote deterministic-only
    // if it cannot cover (already handled by cover check). Keep eligible.
    if (needsCoding && profile.executor_class === "deterministic_mcp"
      && preferred_executor !== profile.executor_id) {
      // deterministic cannot cover repo.edit etc. normally — cover check handles it
    }
    eligible.push(profile);
  }

  let selected = null;
  let selectionReason = null;

  if (policy === "manual") {
    if (!isNonEmptyString(preferred_executor)) {
      return {
        ok: false,
        error: "manual_policy_requires_preferred_executor",
        route_receipt: null,
        ...authorityClosedFields()
      };
    }
  }

  if (isNonEmptyString(preferred_executor)) {
    const prefId = String(preferred_executor).trim();
    if (!EXECUTOR_ID_RE.test(prefId)) {
      return { ok: false, error: "invalid_preferred_executor", ...authorityClosedFields() };
    }
    const pref = eligible.find(p => p.executor_id === prefId);
    if (!pref) {
      const exists = PROFILE_BY_ID.has(prefId);
      return {
        ok: false,
        error: exists ? "preferred_executor_not_eligible" : "preferred_executor_not_found",
        preferred_executor: prefId,
        rejected_candidates: rejected,
        ...authorityClosedFields()
      };
    }
    selected = pref;
    selectionReason = "preferred_executor";
  } else if (eligible.length === 0) {
    return {
      ok: false,
      error: "no_eligible_executor",
      required_capabilities: inferred,
      considered_executors: considered,
      rejected_candidates: rejected,
      ...authorityClosedFields()
    };
  } else {
    const sorted = [...eligible].sort((a, b) => compareCandidates(a, b, policy));
    selected = sorted[0];
    if (fullyDeterministic && selected.selection_rank === EXECUTOR_SELECTION_RANK.deterministic) {
      selectionReason = "fully_deterministic";
    } else if (selected.selection_rank === EXECUTOR_SELECTION_RANK.narrow_specialist) {
      selectionReason = "narrow_specialist_capability_fit";
    } else if (selected.selection_rank === EXECUTOR_SELECTION_RANK.inexpensive_model) {
      selectionReason = "inexpensive_model_backed_specialist";
    } else if (selected.selection_rank === EXECUTOR_SELECTION_RANK.coding_agent) {
      selectionReason = needsCoding ? "coding_agent_repo_work_required" : "coding_agent_selected";
    } else if (selected.selection_rank === EXECUTOR_SELECTION_RANK.premium_general) {
      selectionReason = "premium_general_reasoning_required";
    } else if (selected.selection_rank === EXECUTOR_SELECTION_RANK.paid_external) {
      selectionReason = "paid_external_policy_budget_allow";
    } else {
      selectionReason = `policy_${policy}_rank_${selected.selection_rank}`;
    }
  }

  const routeReceiptId = `errcpt:${crypto.randomUUID()}`;
  const createdAt = new Date().toISOString();
  const contextResolution = resolveContextResolution(selected, { selection_reason: selectionReason });
  const routeReceipt = {
    schema: EXECUTOR_ROUTE_RECEIPT_SCHEMA,
    route_receipt_id: routeReceiptId,
    created_at: createdAt,
    actor_id: actor_id ? String(actor_id).trim() : null,
    parent_task_run_id: parent_task_run_id ? String(parent_task_run_id).trim() : null,
    required_capabilities: inferred,
    attachment_refs: refsNorm.refs,
    policy_preset: policy,
    budget_envelope: {
      max_cost_class: budget.max_cost_class || null,
      allow_paid_external: budget.allow_paid_external !== false,
      require_compiled_context: budget.require_compiled_context === true,
      forbid_native_context: budget.forbid_native_context === true,
      executor_allowlist: Array.isArray(budget.executor_allowlist) ? budget.executor_allowlist : null,
      executor_denylist: Array.isArray(budget.executor_denylist) ? budget.executor_denylist : null
    },
    considered_executors: considered,
    eligible_executors: eligible.map(p => p.executor_id),
    rejected_candidates: rejected,
    selected_executor_id: selected.executor_id,
    selected_executor_class: selected.executor_class,
    selection_reason: selectionReason,
    cost_class: selected.cost_class,
    latency_class: selected.latency_class,
    quality_class: selected.quality_class,
    // V7.7.10d.1 — context mode / resolution on every route receipt
    context_mode: contextResolution.context_mode,
    context_resolution: contextResolution.context_resolution,
    context_resolution_reason: contextResolution.context_resolution_reason,
    requires_compiled_context: contextResolution.requires_compiled_context,
    compiled_pack_required: contextResolution.compiled_pack_required,
    supported_ref_types: contextResolution.supported_ref_types,
    context_resolution_endpoint: contextResolution.context_resolution_endpoint,
    authorization_state: "requires_human_commit",
    dispatched: false,
    executor_invoked: false,
    accepted_state_authority: false
  };

  return {
    ok: true,
    schema: EXECUTOR_ROUTE_RECEIPT_SCHEMA,
    route_receipt: routeReceipt,
    selected_executor: cloneProfile(selected),
    ...authorityClosedFields()
  };
}

export function listExecutorsFromBody(body = {}) {
  return listExecutorProfiles({
    executor_class: body.executor_class || null,
    availability: body.availability || null
  });
}

export function getExecutorFromBody(body = {}) {
  if (!isNonEmptyString(body.executor_id)) {
    return { ok: false, error: "executor_id_required", ...authorityClosedFields() };
  }
  return getExecutorProfile(body.executor_id);
}

export function executorHealthFromBody(body = {}) {
  return executorHealth(body.executor_id || null);
}

export function routeExecutorFromBody(body = {}) {
  return routeExecutor({
    required_capabilities: body.required_capabilities || body.capabilities || [],
    attachment_refs: body.attachment_refs || [],
    object_refs: body.object_refs || [],
    work_hints: body.work_hints || (body.note ? [body.note] : []),
    policy_preset: body.policy_preset || body.policy || "balanced",
    preferred_executor: body.preferred_executor || body.executor_id || null,
    budget_envelope: body.budget_envelope || body.budget || null,
    parent_task_run_id: body.parent_task_run_id || null,
    actor_id: body.actor_id || null
  });
}

export const EXECUTOR_LIST_TOOL_DEFINITION = Object.freeze({
  name: EXECUTOR_BROKER_TOOL_IDS.list,
  description: "V7.7.10d: list cairnstone-executor-profile-v1 seed registry. Operational discovery only; never dispatches; never moves HEADs.",
  inputSchema: {
    type: "object",
    properties: {
      executor_class: { type: "string" },
      availability: { type: "string" }
    },
    additionalProperties: false
  }
});

export const EXECUTOR_GET_TOOL_DEFINITION = Object.freeze({
  name: EXECUTOR_BROKER_TOOL_IDS.get,
  description: "V7.7.10d: get one executor profile by executor_id. Never dispatches.",
  inputSchema: {
    type: "object",
    required: ["executor_id"],
    properties: {
      executor_id: { type: "string", description: "exec:…" }
    },
    additionalProperties: false
  }
});

export const EXECUTOR_HEALTH_TOOL_DEFINITION = Object.freeze({
  name: EXECUTOR_BROKER_TOOL_IDS.health,
  description: "V7.7.10d: cheap executor health snapshot (seed registry). Never dispatches.",
  inputSchema: {
    type: "object",
    properties: {
      executor_id: { type: "string" }
    },
    additionalProperties: false
  }
});

export const EXECUTOR_ROUTE_TOOL_DEFINITION = Object.freeze({
  name: EXECUTOR_BROKER_TOOL_IDS.route,
  description: "V7.7.10d: capability-aware executor route (proposal only). Returns route receipt with authorization_state=requires_human_commit. NEVER dispatches or launches agents. Distinct from cairnstone_model_route.",
  inputSchema: {
    type: "object",
    properties: {
      actor_id: { type: "string" },
      required_capabilities: { type: "array", maxItems: MAX_CAPS, items: { type: "string" } },
      capabilities: { type: "array", maxItems: MAX_CAPS, items: { type: "string" } },
      attachment_refs: { type: "array", maxItems: MAX_REFS, items: { type: "string" } },
      object_refs: { type: "array", maxItems: MAX_REFS, items: { type: "string" } },
      work_hints: { type: "array", maxItems: 32, items: { type: "string" } },
      note: { type: "string" },
      policy_preset: { type: "string", enum: [...POLICY_PRESETS] },
      policy: { type: "string", enum: [...POLICY_PRESETS] },
      preferred_executor: { type: "string" },
      executor_id: { type: "string", description: "alias for preferred_executor" },
      budget_envelope: { type: "object" },
      budget: { type: "object" },
      parent_task_run_id: { type: "string" }
    },
    additionalProperties: false
  }
});

export const EXECUTOR_MCP_TOOL_DEFINITIONS = Object.freeze([
  EXECUTOR_LIST_TOOL_DEFINITION,
  EXECUTOR_GET_TOOL_DEFINITION,
  EXECUTOR_HEALTH_TOOL_DEFINITION,
  EXECUTOR_ROUTE_TOOL_DEFINITION
]);
