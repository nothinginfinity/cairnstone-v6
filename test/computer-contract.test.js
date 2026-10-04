import test from "node:test";
import assert from "node:assert/strict";
import {
  assertContractEnvelope,
  assertHomeState,
  assertLifecycleTransition,
  canCompleteControlledTransition,
  restoreHome,
  promoteRuntimeRootToHome,
  claimUncommittedRecoveredFromGit,
  unexpectedRuntimeLossRestore,
  assertProviderAdapter,
  assertHomeStorageAdapter,
  assertHumanSession,
  assertAgentGrant,
  agentMayCrossBoundary,
  revokeAgentGrant,
  childWithinParentCeilings,
  terminalGrantsAuthorities,
  assertNetworkPolicy,
  assertPreviewCapability,
  networkAllows,
  assertAuditEvent,
  isProviderNeutralComputerId,
  BACKEND_CLASS_CONTRACTS,
  REQUIRED_AUDIT_EVENTS,
} from "../src/computer-contract.js";

const base = {
  schema: "cairnstone-computer-v1",
  computer_id: "pc:acct_owner1:abc123def4567890",
  owner_account_id: "acct_owner1",
  backend_class: "H",
  lifecycle: "registered",
  accepted_state_authority: false,
  provider_runtime_id: null,
};

test("computer_id is provider-neutral and not a runtime alias", () => {
  assert.equal(isProviderNeutralComputerId(base.computer_id), true);
  assert.equal(isProviderNeutralComputerId("container:cf-sandbox-1"), false);
  const bad = assertContractEnvelope({ ...base, computer_id: "pc:acct_owner1:cloudflarebox123456" });
  assert.equal(bad.ok, false);
  const alias = assertContractEnvelope({ ...base, provider_runtime_id: base.computer_id });
  assert.equal(alias.ok, false);
});

test("computer_id owner segment must match owner_account_id", () => {
  const ok = assertContractEnvelope(base);
  assert.equal(ok.ok, true);

  const mismatched = assertContractEnvelope({
    ...base,
    computer_id: "pc:other_owner:abc123def4567890",
    owner_account_id: "acct_owner1",
  });
  assert.equal(mismatched.ok, false);
  assert.ok(mismatched.errors.includes("owner_mismatch"));
});

test("accepted_state_authority must stay false and forbidden authorities are rejected", () => {
  const result = assertContractEnvelope({ ...base, accepted_state_authority: true });
  assert.equal(result.ok, false);
  assert.ok(result.errors.includes("accepted_state_authority"));

  const smuggled = assertContractEnvelope({ ...base, deploy_authority: true });
  assert.equal(smuggled.ok, false);
  assert.ok(smuggled.errors.includes("forbidden_deploy_authority"));
});

test("backend class contracts mark V and C as interface-only", () => {
  assert.equal(BACKEND_CLASS_CONTRACTS.H.default_target, true);
  assert.equal(BACKEND_CLASS_CONTRACTS.V.interface_only, true);
  assert.equal(BACKEND_CLASS_CONTRACTS.C.interface_only, true);
  assert.equal(BACKEND_CLASS_CONTRACTS.S.durable_home, false);
});

test("invalid home generation/state combinations fail closed", () => {
  assert.equal(
    assertHomeState({ status: "clean", generation: 2, last_successful_generation: 1 }).ok,
    false,
  );
  assert.equal(
    assertHomeState({ status: "dirty", generation: 1, last_successful_generation: 2 }).ok,
    false,
  );
  assert.equal(
    assertHomeState({ status: "weird", generation: 1, last_successful_generation: 1 }).ok,
    false,
  );
  const envelope = assertContractEnvelope({
    ...base,
    home: { status: "clean", generation: 3, last_successful_generation: 2 },
  });
  assert.equal(envelope.ok, false);
  assert.ok(envelope.errors.includes("clean_requires_committed_generation"));
});

test("lifecycle transitions reject illegal jumps", () => {
  assert.equal(assertLifecycleTransition("registered", "stopped").ok, true);
  assert.equal(assertLifecycleTransition("running", "sleeping").ok, false);
  assert.equal(assertLifecycleTransition("running", "checkpointing").ok, true);
  assert.equal(assertLifecycleTransition("restore_failed", "running").ok, false);
});

test("controlled sleep fails closed while home is dirty", () => {
  const result = canCompleteControlledTransition({
    action: "sleep",
    home: { status: "dirty", generation: 2, last_successful_generation: 1 },
  });
  assert.equal(result.ok, false);
  assert.equal(result.report_complete, false);
  assert.equal(result.reason, "durable_home_checkpoint_required");
});

test("controlled destroy completes only after committed clean generation", () => {
  const result = canCompleteControlledTransition({
    action: "destroy",
    home: { status: "clean", generation: 3, last_successful_generation: 3 },
  });
  assert.equal(result.ok, true);
  assert.equal(result.next, "runtime_destroyed");
});

test("controlled transition rejects invalid home fixture", () => {
  const result = canCompleteControlledTransition({
    action: "sleep",
    home: { status: "clean", generation: 1, last_successful_generation: 2 },
  });
  assert.equal(result.ok, false);
  assert.equal(result.report_complete, false);
});

test("restore never mounts an empty home", () => {
  const result = restoreHome({
    lastSuccessfulGeneration: 4,
    emptyHomeOffered: true,
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "empty_home_forbidden");
});

test("restore rejects future and invalid explicit generations", () => {
  const future = restoreHome({
    lastSuccessfulGeneration: 4,
    requestedGeneration: 5,
  });
  assert.equal(future.ok, false);
  assert.equal(future.reason, "future_generation");
  assert.equal(future.lifecycle, "restore_failed");

  const invalidZero = restoreHome({
    lastSuccessfulGeneration: 4,
    requestedGeneration: 0,
  });
  assert.equal(invalidZero.ok, false);
  assert.equal(invalidZero.reason, "invalid_generation");

  const invalidFloat = restoreHome({
    lastSuccessfulGeneration: 4,
    requestedGeneration: 2.5,
  });
  assert.equal(invalidFloat.ok, false);
  assert.equal(invalidFloat.reason, "invalid_generation");

  const earlier = restoreHome({
    lastSuccessfulGeneration: 4,
    requestedGeneration: 2,
  });
  assert.equal(earlier.ok, true);
  assert.equal(earlier.generation, 2);
  assert.equal(earlier.explicit_earlier, true);

  const current = restoreHome({
    lastSuccessfulGeneration: 4,
    requestedGeneration: 4,
  });
  assert.equal(current.ok, true);
  assert.equal(current.generation, 4);
  assert.equal(current.explicit_earlier, false);
});

test("runtime root cannot be promoted and uncommitted git laundering fails", () => {
  assert.equal(promoteRuntimeRootToHome().ok, false);
  assert.equal(claimUncommittedRecoveredFromGit({ claimedFromRemoteClone: true }).ok, false);
  assert.equal(claimUncommittedRecoveredFromGit({ claimedFromRemoteClone: false }).ok, true);
});

test("unexpected runtime loss requires known home and surfaced uncommitted boundary", () => {
  const missingBoundary = unexpectedRuntimeLossRestore({
    lastSuccessfulGeneration: 3,
    emptyHomeOffered: false,
    uncommittedLossSurfaced: false,
  });
  assert.equal(missingBoundary.ok, false);
  assert.equal(missingBoundary.reason, "uncommitted_loss_boundary_required");

  const ok = unexpectedRuntimeLossRestore({
    lastSuccessfulGeneration: 3,
    emptyHomeOffered: false,
    uncommittedLossSurfaced: true,
  });
  assert.equal(ok.ok, true);
  assert.equal(ok.generation, 3);
  assert.equal(ok.reconstruct_committed_git, true);
});

test("provider and home storage adapters stay identity-safe", () => {
  const providerOk = assertProviderAdapter({
    computer_id: base.computer_id,
    provider: "cloudflare",
    provider_runtime_id: "cf-runtime-abc",
    backend_class: "H",
    accepted_state_authority: false,
  });
  assert.equal(providerOk.ok, true);

  const providerAlias = assertProviderAdapter({
    computer_id: base.computer_id,
    provider: "cloudflare",
    provider_runtime_id: base.computer_id,
    backend_class: "H",
    accepted_state_authority: false,
  });
  assert.equal(providerAlias.ok, false);

  const homeOk = assertHomeStorageAdapter({
    computer_id: base.computer_id,
    home_profile_ref: "home:acct_owner1:profile1",
    status: "clean",
    generation: 1,
    last_successful_generation: 1,
    runtime_root_promotable: false,
    accepted_state_authority: false,
  });
  assert.equal(homeOk.ok, true);

  const promotable = assertHomeStorageAdapter({
    computer_id: base.computer_id,
    home_profile_ref: "home:acct_owner1:profile1",
    status: "clean",
    generation: 1,
    last_successful_generation: 1,
    runtime_root_promotable: true,
    accepted_state_authority: false,
  });
  assert.equal(promotable.ok, false);
  assert.ok(promotable.errors.includes("runtime_root_promotable"));
});

test("human session requires owner panes and rejects authority smuggling", () => {
  const ok = assertHumanSession({
    session_plane: "human",
    computer_id: base.computer_id,
    owner_account_id: "acct_owner1",
    panes: ["browser", "file", "terminal"],
    approval_method: "passkey",
    accepted_state_authority: false,
  });
  assert.equal(ok.ok, true);

  const badPane = assertHumanSession({
    session_plane: "human",
    computer_id: base.computer_id,
    owner_account_id: "acct_owner1",
    panes: ["desktop_stream"],
    accepted_state_authority: false,
  });
  assert.equal(badPane.ok, false);

  const smuggled = assertHumanSession({
    session_plane: "human",
    computer_id: base.computer_id,
    owner_account_id: "acct_owner1",
    panes: ["browser"],
    accepted_state_authority: false,
    spend_authority: true,
  });
  assert.equal(smuggled.ok, false);
});

test("agent session does not inherit human vault or browser profile", () => {
  const grant = {
    session_plane: "agent",
    computer_id: base.computer_id,
    actor_id: "agent_1",
    revoked: false,
    boundaries: ["workspace_read"],
    accepted_state_authority: false,
  };
  assert.equal(assertAgentGrant(grant).ok, true);
  assert.equal(agentMayCrossBoundary(grant, "credential_vault"), false);
  assert.equal(agentMayCrossBoundary(grant, "browser_profile"), false);
  assert.equal(agentMayCrossBoundary(grant, "workspace_read"), true);
  assert.equal(agentMayCrossBoundary({ ...grant, revoked: true }, "workspace_read"), false);

  const vaultInBoundaries = assertAgentGrant({
    ...grant,
    boundaries: ["credential_vault"],
  });
  assert.equal(vaultInBoundaries.ok, false);
});

test("agent revocation terminates processes without deleting the computer", () => {
  const revoked = revokeAgentGrant({
    session_plane: "agent",
    computer_id: base.computer_id,
    actor_id: "agent_1",
    revoked: false,
    boundaries: ["workspace_read"],
    accepted_state_authority: false,
  });
  assert.equal(revoked.ok, true);
  assert.equal(revoked.grant.revoked, true);
  assert.equal(revoked.terminate_actor_processes, true);
  assert.equal(revoked.delete_logical_computer, false);
});

test("child agents cannot exceed parent grant or budget ceilings", () => {
  const parent = {
    session_plane: "agent",
    revoked: false,
    boundaries: ["workspace_read", "terminal"],
    parent_task_run_id: "tr_1",
    budget_ceiling: 10,
  };
  assert.equal(
    childWithinParentCeilings(
      { revoked: false, boundaries: ["workspace_read"], parent_task_run_id: "tr_1", budget_used: 3 },
      parent,
    ).ok,
    true,
  );
  assert.equal(
    childWithinParentCeilings(
      { revoked: false, boundaries: ["workspace_read", "network_extra"], parent_task_run_id: "tr_1", budget_used: 1 },
      parent,
    ).reason,
    "boundary_ceiling_exceeded",
  );
  assert.equal(
    childWithinParentCeilings(
      { revoked: false, boundaries: ["workspace_read"], parent_task_run_id: "tr_1", budget_used: 11 },
      parent,
    ).reason,
    "budget_ceiling_exceeded",
  );
});

test("terminal access does not grant privileged authorities", () => {
  const human = terminalGrantsAuthorities({ panes: ["terminal"] });
  assert.equal(human.ok, true);
  assert.equal(human.authorities.deploy, false);
  assert.equal(human.authorities.accepted_state, false);
  assert.equal(human.authorities.credential, false);
  assert.equal(human.authorities.spend, false);
  assert.equal(human.authorities.unrestricted_network, false);
});

test("network policy and preview capability shapes fail closed", () => {
  assert.equal(assertNetworkPolicy({ default_inbound_public: false, egress_allowlist: ["github.com"] }).ok, true);
  assert.equal(assertNetworkPolicy({ default_inbound_public: true, egress_allowlist: ["github.com"] }).ok, false);
  assert.equal(assertPreviewCapability({ capability_id: "cap_1", expires_at: "2026-10-05T00:00:00Z" }).ok, true);
  assert.equal(assertPreviewCapability({ capability_id: "cap_1", expires_at: "not-a-date" }).ok, false);
});

test("network default denies public inbound and expired preview", () => {
  const policy = { default_inbound_public: false, egress_allowlist: ["github.com"] };
  assert.equal(networkAllows(policy, { kind: "inbound_public" }).ok, false);
  assert.equal(networkAllows(policy, { kind: "egress", host: "evil.example" }).ok, false);
  const preview = networkAllows(policy, {
    kind: "preview",
    capability_id: "cap_1",
    expires_at: "2026-10-04T00:00:00Z",
    now: "2026-10-04T01:00:00Z",
  });
  assert.equal(preview.ok, false);
  assert.equal(preview.reason, "preview_expired");
});

test("network preview denies malformed expires_at or now", () => {
  const policy = { default_inbound_public: false, egress_allowlist: ["github.com"] };
  const badExpires = networkAllows(policy, {
    kind: "preview",
    capability_id: "cap_1",
    expires_at: "not-a-date",
    now: "2026-10-04T00:00:00Z",
  });
  assert.equal(badExpires.ok, false);
  assert.equal(badExpires.reason, "invalid_preview_time");

  const badNow = networkAllows(policy, {
    kind: "preview",
    capability_id: "cap_1",
    expires_at: "2026-10-05T00:00:00Z",
    now: "also-not-a-date",
  });
  assert.equal(badNow.ok, false);
  assert.equal(badNow.reason, "invalid_preview_time");
});

test("networkAllows rejects missing or non-object request/policy", () => {
  const policy = { default_inbound_public: false, egress_allowlist: ["github.com"] };
  assert.equal(networkAllows(policy, null).reason, "invalid_request");
  assert.equal(networkAllows(policy, undefined).reason, "invalid_request");
  assert.equal(networkAllows(null, { kind: "egress", host: "github.com" }).reason, "inbound_default");
  assert.equal(networkAllows(policy, { kind: "weird" }).reason, "unknown_request_kind");
});

test("semantic audit events require attribution fields", () => {
  assert.ok(REQUIRED_AUDIT_EVENTS.includes("home.restore_failed"));
  const ok = assertAuditEvent({
    event_kind: "grant.revoked",
    computer_id: base.computer_id,
    actor_id: "owner_1",
    at: "2026-10-04T20:00:00Z",
    attribution: "owner_revoke",
  });
  assert.equal(ok.ok, true);

  const missing = assertAuditEvent({
    event_kind: "grant.revoked",
    computer_id: base.computer_id,
    actor_id: "owner_1",
    at: "2026-10-04T20:00:00Z",
  });
  assert.equal(missing.ok, false);
  assert.ok(missing.errors.includes("attribution"));

  const unknownKind = assertAuditEvent({
    event_kind: "not.an.event",
    computer_id: base.computer_id,
    actor_id: "owner_1",
    at: "2026-10-04T20:00:00Z",
    attribution: "x",
  });
  assert.equal(unknownKind.ok, false);
});
