/**
 * V7.7.10n.0 CairnStone Computer contract helpers.
 * Pure validators and state-machine fixtures. No Worker, D1, R2, MCP, or runtime.
 * accepted_state_authority is always false for computer objects.
 *
 * Boundary vs JSON Schema:
 * - docs/computer/cairnstone-computer-v1.schema.json rejects undeclared properties
 *   via additionalProperties:false.
 * - assertContractEnvelope enforces semantic rules the schema cannot express
 *   (owner-segment match, provider-word bans, home consistency, authority exclusions).
 * - FORBIDDEN_AUTHORITIES are fail-closed here: accepted_state_authority must be
 *   exactly false; other forbidden keys must not appear on computer objects.
 */
export const CONTRACT_ID = "cairnstone-computer-v1";
export const SLICE = "V7.7.10n.0";

export const BACKEND_CLASSES = ["S", "H", "V", "C"];
export const DEFAULT_CLASS = "H";

export const BACKEND_CLASS_CONTRACTS = Object.freeze({
  S: {
    kind: "ephemeral_session",
    durable_home: false,
    implemented_in_10n0: false,
    notes: "Ephemeral/session compute adapter contract only.",
  },
  H: {
    kind: "personal_durable_home",
    durable_home: true,
    implemented_in_10n0: false,
    default_target: true,
    notes: "Default personal computer; durable home + replaceable runtime.",
  },
  V: {
    kind: "desktop_stream_interface",
    durable_home: false,
    implemented_in_10n0: false,
    interface_only: true,
    notes: "Interface definition only until later 10n.8 family.",
  },
  C: {
    kind: "multi_computer_interface",
    durable_home: false,
    implemented_in_10n0: false,
    interface_only: true,
    notes: "Interface definition only until later 10n.8 family.",
  },
});

export const LIFECYCLE = [
  "registered",
  "stopped",
  "starting",
  "running",
  "checkpointing",
  "sleeping",
  "destroy_pending",
  "runtime_destroyed",
  "restore_failed",
];

export const LIFECYCLE_TRANSITIONS = Object.freeze({
  registered: ["stopped"],
  stopped: ["starting", "restore_failed"],
  starting: ["running", "stopped"],
  // Controlled sleep/destroy must enter checkpointing first. Unexpected
  // runtime loss is modeled separately (unexpectedRuntimeLossRestore), not
  // via a direct running -> runtime_destroyed transition.
  running: ["checkpointing"],
  checkpointing: ["running", "sleeping", "destroy_pending", "runtime_destroyed"],
  sleeping: ["starting", "stopped"],
  destroy_pending: ["runtime_destroyed", "running"],
  runtime_destroyed: ["stopped", "starting", "restore_failed"],
  restore_failed: ["stopped"],
});

export const HOME_STATUS = ["clean", "dirty", "checkpointing", "checkpoint_failed"];

export const HUMAN_PANES = ["browser", "file", "terminal"];
export const HUMAN_APPROVAL_METHODS = ["passkey", "oauth", "device_code"];

export const AGENT_DEFAULT_DENIALS = Object.freeze([
  "credential_vault",
  "browser_profile",
  "deploy",
  "accepted_state",
  "spend",
  "unrestricted_network",
]);

export const FORBIDDEN_AUTHORITIES = [
  "accepted_state_authority",
  "deploy_authority",
  "credential_vault_read",
  "browser_profile_read",
  "unrestricted_network",
  "spend_authority",
];

export const REQUIRED_AUDIT_EVENTS = Object.freeze([
  "lifecycle.transition",
  "home.checkpoint_failed",
  "home.restore_failed",
  "grant.issued",
  "grant.revoked",
  "network.policy_expanded",
  "runtime.unexpected_loss",
]);

const ID_RE = /^pc:[a-z0-9][a-z0-9_-]{2,63}:[a-z0-9]{16,64}$/;
const OWNER_RE = /^[a-z0-9][a-z0-9_-]{2,63}$/;

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isKnownGeneration(value) {
  return Number.isInteger(value) && value >= 1;
}

export function isProviderNeutralComputerId(computerId) {
  if (typeof computerId !== "string" || !ID_RE.test(computerId)) return false;
  const banned = ["cloudflare", "container", "sandbox", "workers.dev"];
  return !banned.some((part) => computerId.toLowerCase().includes(part));
}

export function ownerSegmentFromComputerId(computerId) {
  if (typeof computerId !== "string") return null;
  const parts = computerId.split(":");
  if (parts.length !== 3 || parts[0] !== "pc" || !parts[1] || !parts[2]) return null;
  return parts[1];
}

export function assertHomeState(home) {
  const errors = [];
  if (!isPlainObject(home)) return { ok: false, errors: ["home"] };
  if (!HOME_STATUS.includes(home.status)) errors.push("home_status");
  if (!isKnownGeneration(home.generation)) errors.push("home_generation");
  if (!isKnownGeneration(home.last_successful_generation)) errors.push("last_successful_generation");
  if (
    isKnownGeneration(home.generation) &&
    isKnownGeneration(home.last_successful_generation) &&
    home.generation < home.last_successful_generation
  ) {
    errors.push("generation_behind_last_successful");
  }
  if (
    home.status === "clean" &&
    isKnownGeneration(home.generation) &&
    isKnownGeneration(home.last_successful_generation) &&
    home.generation !== home.last_successful_generation
  ) {
    errors.push("clean_requires_committed_generation");
  }
  return { ok: errors.length === 0, errors };
}

function collectForbiddenAuthorityErrors(doc) {
  const errors = [];
  if (!isPlainObject(doc)) return errors;
  for (const key of FORBIDDEN_AUTHORITIES) {
    if (key === "accepted_state_authority") continue;
    if (Object.prototype.hasOwnProperty.call(doc, key)) errors.push(`forbidden_${key}`);
  }
  return errors;
}

export function assertContractEnvelope(doc) {
  const errors = [];
  if (!isPlainObject(doc) || doc.schema !== CONTRACT_ID) errors.push("schema");
  if (!isProviderNeutralComputerId(doc?.computer_id)) errors.push("computer_id");
  if (
    typeof doc?.owner_account_id !== "string" ||
    !OWNER_RE.test(doc.owner_account_id) ||
    doc.owner_account_id === doc?.computer_id
  ) {
    errors.push("owner");
  }
  const encodedOwner = ownerSegmentFromComputerId(doc?.computer_id);
  if (
    doc?.owner_account_id &&
    encodedOwner !== null &&
    encodedOwner !== doc.owner_account_id
  ) {
    errors.push("owner_mismatch");
  }
  if (!BACKEND_CLASSES.includes(doc?.backend_class)) errors.push("backend_class");
  if (!LIFECYCLE.includes(doc?.lifecycle)) errors.push("lifecycle");
  if (doc?.accepted_state_authority !== false) errors.push("accepted_state_authority");
  if (doc?.provider_runtime_id && doc.provider_runtime_id === doc.computer_id) {
    errors.push("provider_identity_alias");
  }
  errors.push(...collectForbiddenAuthorityErrors(doc));
  if (doc?.home !== undefined) {
    const home = assertHomeState(doc.home);
    if (!home.ok) errors.push(...home.errors);
  }
  if (doc?.network_policy !== undefined) {
    const policy = assertNetworkPolicy(doc.network_policy);
    if (!policy.ok) errors.push(...policy.errors.map((e) => `network_policy_${e}`));
  }
  return { ok: errors.length === 0, errors };
}

export function assertLifecycleTransition(from, to) {
  if (!LIFECYCLE.includes(from) || !LIFECYCLE.includes(to)) {
    return { ok: false, reason: "unknown_lifecycle_state" };
  }
  const allowed = LIFECYCLE_TRANSITIONS[from] || [];
  if (!allowed.includes(to)) return { ok: false, reason: "illegal_transition" };
  return { ok: true };
}

export function canCompleteControlledTransition({ action, home }) {
  if (!["sleep", "destroy"].includes(action)) return { ok: false, reason: "unknown_action" };
  const homeCheck = assertHomeState(home);
  if (!homeCheck.ok) {
    return { ok: false, reason: homeCheck.errors[0] || "invalid_home", report_complete: false };
  }
  if (home.status === "dirty" || home.status === "checkpointing" || home.status === "checkpoint_failed") {
    return { ok: false, reason: "durable_home_checkpoint_required", report_complete: false };
  }
  if (home.status !== "clean") return { ok: false, reason: "home_not_clean", report_complete: false };
  if (home.generation !== home.last_successful_generation) {
    return { ok: false, reason: "generation_not_committed", report_complete: false };
  }
  return { ok: true, report_complete: true, next: action === "sleep" ? "sleeping" : "runtime_destroyed" };
}

export function restoreHome({ lastSuccessfulGeneration, requestedGeneration, emptyHomeOffered }) {
  if (emptyHomeOffered) return { ok: false, reason: "empty_home_forbidden" };
  if (!isKnownGeneration(lastSuccessfulGeneration)) {
    return { ok: false, reason: "no_known_good_generation", lifecycle: "restore_failed" };
  }
  if (requestedGeneration === undefined || requestedGeneration === null) {
    return { ok: true, generation: lastSuccessfulGeneration, explicit_earlier: false };
  }
  if (!isKnownGeneration(requestedGeneration)) {
    return { ok: false, reason: "invalid_generation", lifecycle: "restore_failed" };
  }
  if (requestedGeneration > lastSuccessfulGeneration) {
    return { ok: false, reason: "future_generation", lifecycle: "restore_failed" };
  }
  if (requestedGeneration === lastSuccessfulGeneration) {
    return { ok: true, generation: lastSuccessfulGeneration, explicit_earlier: false };
  }
  return { ok: true, generation: requestedGeneration, explicit_earlier: true };
}

export function promoteRuntimeRootToHome() {
  return { ok: false, reason: "runtime_root_not_promotable" };
}

export function claimUncommittedRecoveredFromGit({ claimedFromRemoteClone }) {
  if (claimedFromRemoteClone) {
    return { ok: false, reason: "uncommitted_not_recoverable_from_git" };
  }
  return { ok: true };
}

export function unexpectedRuntimeLossRestore({ lastSuccessfulGeneration, emptyHomeOffered, uncommittedLossSurfaced }) {
  if (emptyHomeOffered) {
    return { ok: false, reason: "empty_home_forbidden", lifecycle: "restore_failed" };
  }
  if (!isKnownGeneration(lastSuccessfulGeneration)) {
    return { ok: false, reason: "no_known_good_generation", lifecycle: "restore_failed" };
  }
  if (!uncommittedLossSurfaced) {
    return { ok: false, reason: "uncommitted_loss_boundary_required", lifecycle: "restore_failed" };
  }
  return {
    ok: true,
    generation: lastSuccessfulGeneration,
    reconstruct_committed_git: true,
  };
}

export function assertProviderAdapter(adapter) {
  const errors = [];
  if (!isPlainObject(adapter)) return { ok: false, errors: ["adapter"] };
  if (!isProviderNeutralComputerId(adapter.computer_id)) errors.push("computer_id");
  if (typeof adapter.provider !== "string" || !adapter.provider) errors.push("provider");
  if (typeof adapter.provider_runtime_id !== "string" || !adapter.provider_runtime_id) {
    errors.push("provider_runtime_id");
  }
  if (adapter.provider_runtime_id === adapter.computer_id) errors.push("provider_identity_alias");
  if (!BACKEND_CLASSES.includes(adapter.backend_class)) errors.push("backend_class");
  if (adapter.accepted_state_authority !== false) errors.push("accepted_state_authority");
  errors.push(...collectForbiddenAuthorityErrors(adapter));
  return { ok: errors.length === 0, errors };
}

export function assertHomeStorageAdapter(adapter) {
  const errors = [];
  if (!isPlainObject(adapter)) return { ok: false, errors: ["adapter"] };
  if (!isProviderNeutralComputerId(adapter.computer_id)) errors.push("computer_id");
  if (typeof adapter.home_profile_ref !== "string" || !adapter.home_profile_ref) {
    errors.push("home_profile_ref");
  }
  const home = assertHomeState({
    status: adapter.status,
    generation: adapter.generation,
    last_successful_generation: adapter.last_successful_generation,
  });
  if (!home.ok) errors.push(...home.errors);
  if (adapter.runtime_root_promotable !== false) errors.push("runtime_root_promotable");
  if (adapter.accepted_state_authority !== false) errors.push("accepted_state_authority");
  return { ok: errors.length === 0, errors };
}

export function assertHumanSession(session) {
  const errors = [];
  if (!isPlainObject(session)) return { ok: false, errors: ["session"] };
  if (session.session_plane !== "human") errors.push("session_plane");
  if (!isProviderNeutralComputerId(session.computer_id)) errors.push("computer_id");
  if (typeof session.owner_account_id !== "string" || !OWNER_RE.test(session.owner_account_id)) {
    errors.push("owner");
  }
  const encodedOwner = ownerSegmentFromComputerId(session.computer_id);
  if (encodedOwner && session.owner_account_id && encodedOwner !== session.owner_account_id) {
    errors.push("owner_mismatch");
  }
  if (!Array.isArray(session.panes) || session.panes.length === 0) errors.push("panes");
  else if (session.panes.some((pane) => !HUMAN_PANES.includes(pane))) errors.push("pane_unknown");
  if (session.accepted_state_authority !== false) errors.push("accepted_state_authority");
  if (
    session.approval_method !== undefined &&
    !HUMAN_APPROVAL_METHODS.includes(session.approval_method)
  ) {
    errors.push("approval_method");
  }
  errors.push(...collectForbiddenAuthorityErrors(session));
  return { ok: errors.length === 0, errors };
}

export function assertAgentGrant(grant) {
  const errors = [];
  if (!isPlainObject(grant)) return { ok: false, errors: ["grant"] };
  if (grant.session_plane !== "agent") errors.push("session_plane");
  if (!isProviderNeutralComputerId(grant.computer_id)) errors.push("computer_id");
  if (typeof grant.actor_id !== "string" || !grant.actor_id) errors.push("actor_id");
  if (typeof grant.revoked !== "boolean") errors.push("revoked");
  if (!Array.isArray(grant.boundaries)) errors.push("boundaries");
  else if (grant.boundaries.some((b) => AGENT_DEFAULT_DENIALS.includes(b))) {
    errors.push("default_denial_in_boundaries");
  }
  if (grant.accepted_state_authority !== false) errors.push("accepted_state_authority");
  errors.push(...collectForbiddenAuthorityErrors(grant));
  return { ok: errors.length === 0, errors };
}

export function agentMayCrossBoundary(grant, boundary) {
  if (!grant || grant.revoked) return false;
  if (grant.session_plane !== "agent") return false;
  if (AGENT_DEFAULT_DENIALS.includes(boundary)) return false;
  return Array.isArray(grant.boundaries) && grant.boundaries.includes(boundary);
}

export function revokeAgentGrant(grant) {
  if (!isPlainObject(grant) || grant.session_plane !== "agent") {
    return { ok: false, reason: "invalid_grant" };
  }
  return {
    ok: true,
    grant: { ...grant, revoked: true },
    terminate_actor_processes: true,
    delete_logical_computer: false,
  };
}

function isNonNegativeFiniteNumber(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

export function childWithinParentCeilings(child, parent) {
  if (!isPlainObject(child) || !isPlainObject(parent)) {
    return { ok: false, reason: "invalid_ceiling_inputs" };
  }
  if (child.revoked || parent.revoked) return { ok: false, reason: "revoked" };
  if (!Array.isArray(child.boundaries) || !Array.isArray(parent.boundaries)) {
    return { ok: false, reason: "boundaries_required" };
  }
  if (child.boundaries.some((b) => !parent.boundaries.includes(b))) {
    return { ok: false, reason: "boundary_ceiling_exceeded" };
  }

  // If the parent establishes a task-run ceiling, the child must carry the
  // same parent_task_run_id. Omission or mismatch fails closed.
  if (parent.parent_task_run_id !== undefined && parent.parent_task_run_id !== null) {
    if (typeof parent.parent_task_run_id !== "string" || !parent.parent_task_run_id) {
      return { ok: false, reason: "invalid_parent_task_run_id" };
    }
    if (child.parent_task_run_id === undefined || child.parent_task_run_id === null) {
      return { ok: false, reason: "task_run_linkage_required" };
    }
    if (child.parent_task_run_id !== parent.parent_task_run_id) {
      return { ok: false, reason: "task_run_ceiling_exceeded" };
    }
  }

  // Omitted parent budget_ceiling means no numeric ceiling in this fixture.
  // Present-but-malformed is fail-closed and is not treated like omission.
  if (parent.budget_ceiling !== undefined && parent.budget_ceiling !== null) {
    if (!isNonNegativeFiniteNumber(parent.budget_ceiling)) {
      return { ok: false, reason: "invalid_budget_ceiling" };
    }
    if (child.budget_used !== undefined && child.budget_used !== null) {
      if (!isNonNegativeFiniteNumber(child.budget_used)) {
        return { ok: false, reason: "invalid_budget_used" };
      }
      if (child.budget_used > parent.budget_ceiling) {
        return { ok: false, reason: "budget_ceiling_exceeded" };
      }
    }
  } else if (child.budget_used !== undefined && child.budget_used !== null) {
    if (!isNonNegativeFiniteNumber(child.budget_used)) {
      return { ok: false, reason: "invalid_budget_used" };
    }
  }

  return { ok: true };
}

export function terminalGrantsAuthorities(sessionOrGrant) {
  const authorities = {
    deploy: false,
    accepted_state: false,
    credential: false,
    spend: false,
    unrestricted_network: false,
  };
  if (!isPlainObject(sessionOrGrant)) {
    return { ok: false, reason: "invalid_session", authorities };
  }
  const panes = sessionOrGrant.panes;
  const boundaries = sessionOrGrant.boundaries;
  const hasTerminal =
    (Array.isArray(panes) && panes.includes("terminal")) ||
    (Array.isArray(boundaries) && boundaries.includes("terminal"));
  if (!hasTerminal) return { ok: false, reason: "no_terminal", authorities };
  return { ok: true, authorities };
}

export function assertNetworkPolicy(policy) {
  const errors = [];
  if (!isPlainObject(policy)) return { ok: false, errors: ["policy"] };
  if (policy.default_inbound_public !== false) errors.push("default_inbound_public");
  if (!Array.isArray(policy.egress_allowlist) || policy.egress_allowlist.some((h) => typeof h !== "string" || !h)) {
    errors.push("egress_allowlist");
  }
  return { ok: errors.length === 0, errors };
}

export function assertPreviewCapability(capability) {
  const errors = [];
  if (!isPlainObject(capability)) return { ok: false, errors: ["capability"] };
  if (typeof capability.capability_id !== "string" || !capability.capability_id) {
    errors.push("capability_id");
  }
  const expiresAtMs = Date.parse(capability.expires_at);
  if (!Number.isFinite(expiresAtMs)) errors.push("expires_at");
  return { ok: errors.length === 0, errors };
}

export function networkAllows(policy, request) {
  if (!isPlainObject(policy) || policy.default_inbound_public !== false) {
    return { ok: false, reason: "inbound_default" };
  }
  if (!isPlainObject(request)) return { ok: false, reason: "invalid_request" };
  if (request.kind === "inbound_public") return { ok: false, reason: "no_public_inbound" };
  if (request.kind === "preview") {
    if (!request.capability_id || !request.expires_at) {
      return { ok: false, reason: "preview_capability_required" };
    }
    const expiresAtMs = Date.parse(request.expires_at);
    const nowMs = Date.parse(request.now || "1970-01-01T00:00:00Z");
    if (!Number.isFinite(expiresAtMs) || !Number.isFinite(nowMs)) {
      return { ok: false, reason: "invalid_preview_time" };
    }
    if (expiresAtMs <= nowMs) {
      return { ok: false, reason: "preview_expired" };
    }
    return { ok: true, grants_deploy: false, grants_accepted_state: false };
  }
  if (request.kind !== "egress") return { ok: false, reason: "unknown_request_kind" };
  const host = request.host;
  if (!host || !Array.isArray(policy.egress_allowlist) || !policy.egress_allowlist.includes(host)) {
    return { ok: false, reason: "egress_not_allowlisted" };
  }
  return { ok: true, grants_deploy: false, grants_accepted_state: false };
}

export function assertAuditEvent(event) {
  const errors = [];
  if (!isPlainObject(event)) return { ok: false, errors: ["event"] };
  if (!REQUIRED_AUDIT_EVENTS.includes(event.event_kind)) errors.push("event_kind");
  if (!isProviderNeutralComputerId(event.computer_id)) errors.push("computer_id");
  if (typeof event.actor_id !== "string" || !event.actor_id) errors.push("actor_id");
  if (!Number.isFinite(Date.parse(event.at))) errors.push("at");
  if (typeof event.attribution !== "string" || !event.attribution) errors.push("attribution");
  return { ok: errors.length === 0, errors };
}
