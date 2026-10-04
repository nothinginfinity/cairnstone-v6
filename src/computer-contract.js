/**
 * V7.7.10n.0 CairnStone Computer contract helpers.
 * Pure validators and state-machine fixtures. No Worker, D1, R2, MCP, or runtime.
 * accepted_state_authority is always false for computer objects.
 */
export const CONTRACT_ID = "cairnstone-computer-v1";
export const SLICE = "V7.7.10n.0";

export const BACKEND_CLASSES = ["S", "H", "V", "C"];
export const DEFAULT_CLASS = "H";

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

export const HOME_STATUS = ["clean", "dirty", "checkpointing", "checkpoint_failed"];

export const FORBIDDEN_AUTHORITIES = [
  "accepted_state_authority",
  "deploy_authority",
  "credential_vault_read",
  "browser_profile_read",
  "unrestricted_network",
  "spend_authority",
];

const ID_RE = /^pc:[a-z0-9][a-z0-9_-]{2,63}:[a-z0-9]{16,64}$/;

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

export function assertContractEnvelope(doc) {
  const errors = [];
  if (!doc || doc.schema !== CONTRACT_ID) errors.push("schema");
  if (!isProviderNeutralComputerId(doc?.computer_id)) errors.push("computer_id");
  if (!doc?.owner_account_id || doc.owner_account_id === doc?.computer_id) errors.push("owner");
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
  return { ok: errors.length === 0, errors };
}

export function canCompleteControlledTransition({ action, home }) {
  if (!["sleep", "destroy"].includes(action)) return { ok: false, reason: "unknown_action" };
  if (!home) return { ok: false, reason: "missing_home" };
  if (home.status === "dirty" || home.status === "checkpointing" || home.status === "checkpoint_failed") {
    return { ok: false, reason: "durable_home_checkpoint_required", report_complete: false };
  }
  if (home.status !== "clean") return { ok: false, reason: "home_not_clean", report_complete: false };
  if (home.generation !== home.last_successful_generation) {
    return { ok: false, reason: "generation_not_committed", report_complete: false };
  }
  return { ok: true, report_complete: true, next: action === "sleep" ? "sleeping" : "runtime_destroyed" };
}

function isKnownGeneration(value) {
  return Number.isInteger(value) && value >= 1;
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

export function agentMayCrossBoundary(grant, boundary) {
  if (!grant || grant.revoked) return false;
  if (grant.session_plane !== "agent") return false;
  return Array.isArray(grant.boundaries) && grant.boundaries.includes(boundary);
}

export function networkAllows(policy, request) {
  if (!policy || policy.default_inbound_public !== false) return { ok: false, reason: "inbound_default" };
  if (request.kind === "inbound_public") return { ok: false, reason: "no_public_inbound" };
  if (request.kind === "preview") {
    if (!request.capability_id || !request.expires_at) return { ok: false, reason: "preview_capability_required" };
    if (Date.parse(request.expires_at) <= Date.parse(request.now || "1970-01-01T00:00:00Z")) {
      return { ok: false, reason: "preview_expired" };
    }
    return { ok: true, grants_deploy: false, grants_accepted_state: false };
  }
  const host = request.host;
  if (!host || !Array.isArray(policy.egress_allowlist) || !policy.egress_allowlist.includes(host)) {
    return { ok: false, reason: "egress_not_allowlisted" };
  }
  return { ok: true, grants_deploy: false, grants_accepted_state: false };
}
