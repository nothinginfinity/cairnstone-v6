import test from "node:test";
import assert from "node:assert/strict";
import {
  assertContractEnvelope,
  canCompleteControlledTransition,
  restoreHome,
  agentMayCrossBoundary,
  networkAllows,
  isProviderNeutralComputerId,
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

test("accepted_state_authority must stay false", () => {
  const result = assertContractEnvelope({ ...base, accepted_state_authority: true });
  assert.equal(result.ok, false);
  assert.ok(result.errors.includes("accepted_state_authority"));
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

test("agent session does not inherit human vault or browser profile", () => {
  const grant = { session_plane: "agent", revoked: false, boundaries: ["workspace_read"] };
  assert.equal(agentMayCrossBoundary(grant, "credential_vault"), false);
  assert.equal(agentMayCrossBoundary(grant, "browser_profile"), false);
  assert.equal(agentMayCrossBoundary(grant, "workspace_read"), true);
  assert.equal(agentMayCrossBoundary({ ...grant, revoked: true }, "workspace_read"), false);
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
