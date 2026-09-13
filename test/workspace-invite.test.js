import test from "node:test";
import assert from "node:assert/strict";
import { stableJson } from "../src/agent-bootstrap.js";
import {
  issueMailboxCapabilityFromBody,
  inspectMailboxCapabilityMetadata,
  preferUnexpiredMailboxCapability,
  verifyMailboxCapability
} from "../src/worker-session.js";
import {
  authorizeWorkspaceRequest,
  createWorkspace
} from "../src/workspace.js";
import {
  WORKSPACE_INVITE_CLAIM_TOOL_ID,
  WORKSPACE_INVITE_SCHEMA,
  claimWorkspaceInviteFromBody,
  mintWorkspaceInviteFromBody,
  revokeWorkspaceInviteFromBody
} from "../src/workspace-invite.js";
import { DEFAULT_TOOL_BROKER_REGISTRY } from "../src/model-router.js";
import { listAutomaticReadToolIds } from "../src/delegate-loop.js";
import { mcpToolsForProfile } from "../src/index.js";

const ACTOR_GROK = "grok:cairnstone-v6";
const ACTOR_CLAUDE = "claude:cairnstone-v6";
const WS_ID = "ws:v776a-invite";
/** Obviously fake redacted placeholder — never a real bearer. */
const FAKE_BEARER_PLACEHOLDER = "REDACTED_MAILBOX_CAPABILITY_PLACEHOLDER.not-a-real-signature";

class FakeInviteD1 {
  constructor() {
    this.workspaces = new Map();
    this.members = new Map();
    this.invites = new Map();
    this.denylist = new Map();
  }
  _memberKey(ws, actor) { return `${ws}\0${actor}`; }
  prepare(sql) {
    const db = this;
    return {
      bind(...args) {
        return {
          async run() {
            if (sql.includes("INSERT INTO workspaces")) {
              const [workspaceId, name, createdBy, createdAt, updatedAt, githubBind] = args;
              db.workspaces.set(workspaceId, { workspace_id: workspaceId, name, created_by: createdBy, created_at: createdAt, updated_at: updatedAt, status: "active", github_bind_json: githubBind });
              return { success: true, meta: { changes: 1 } };
            }
            if (sql.includes("INSERT INTO workspace_members")) {
              const [workspaceId, actorId, role, createdAt] = args;
              db.members.set(db._memberKey(workspaceId, actorId), { workspace_id: workspaceId, actor_id: actorId, role, created_at: createdAt });
              return { success: true, meta: { changes: 1 } };
            }
            if (sql.includes("INSERT INTO workspace_invites")) {
              const [inviteId, workspaceId, principal, role, scopesJson, pathPrefix, issuedBy, issuedAt, expiresAt, fingerprint] = args;
              db.invites.set(inviteId, { invite_id: inviteId, workspace_id: workspaceId, principal_actor_id: principal, membership_role: role, scopes_json: scopesJson, path_prefix: pathPrefix, issued_by: issuedBy, issued_at: issuedAt, expires_at: expiresAt, state: "pending", invite_fingerprint: fingerprint, claimed_at: null, claimed_by: null, grant_nonce: null, grant_expires_at: null, revoked_at: null, revoked_by: null });
              return { success: true, meta: { changes: 1 } };
            }
            if (sql.includes("state = 'revoked'")) {
              const [revokedAt, revokedBy, inviteId] = args;
              const row = db.invites.get(inviteId);
              if (row) db.invites.set(inviteId, { ...row, state: "revoked", revoked_at: revokedAt, revoked_by: revokedBy });
              return { success: true, meta: { changes: row ? 1 : 0 } };
            }
            if (sql.includes("state = 'expired'")) {
              const [inviteId] = args;
              const row = db.invites.get(inviteId);
              if (row && row.state === "pending") db.invites.set(inviteId, { ...row, state: "expired" });
              return { success: true, meta: { changes: 1 } };
            }
            if (sql.includes("state = 'claimed'")) {
              const [claimedAt, claimedBy, grantNonce, grantExpiresAt, inviteId] = args;
              const row = db.invites.get(inviteId);
              if (row && row.state === "pending") db.invites.set(inviteId, { ...row, state: "claimed", claimed_at: claimedAt, claimed_by: claimedBy, grant_nonce: grantNonce, grant_expires_at: grantExpiresAt });
              return { success: true, meta: { changes: row ? 1 : 0 } };
            }
            if (sql.includes("workspace_capability_denylist")) {
              const [grantNonce, inviteId, workspaceId, principal, revokedAt, revokedBy] = args;
              if (!db.denylist.has(grantNonce)) db.denylist.set(grantNonce, { grant_nonce: grantNonce, invite_id: inviteId, workspace_id: workspaceId, principal_actor_id: principal, revoked_at: revokedAt, revoked_by: revokedBy });
              return { success: true, meta: { changes: 1 } };
            }
            if (sql.includes("SET grant_nonce")) {
              const [grantNonce, grantExpiresAt, inviteId] = args;
              const row = db.invites.get(inviteId);
              if (row) db.invites.set(inviteId, { ...row, grant_nonce: grantNonce, grant_expires_at: grantExpiresAt });
              return { success: true, meta: { changes: row ? 1 : 0 } };
            }
            throw new Error(`Unexpected run SQL: ${sql}`);
          },
          async first() {
            if (sql.includes("FROM workspaces WHERE workspace_id")) return db.workspaces.get(args[0]) || null;
            if (sql.includes("FROM workspace_invites WHERE invite_id")) return db.invites.get(args[0]) || null;
            if (sql.includes("FROM workspace_members WHERE workspace_id = ? AND actor_id = ?")) return db.members.get(db._memberKey(args[0], args[1])) || null;
            if (sql.includes("FROM workspace_capability_denylist")) return db.denylist.get(args[0]) || null;
            throw new Error(`Unexpected first SQL: ${sql}`);
          },
          async all() { return { results: [] }; }
        };
      }
    };
  }
}

function envFor(db) {
  return {
    CAIRNSTONE_DB: db,
    CAIRNSTONE_RAW: {},
    CAIRNSTONE_WORKSPACE_CAPABILITY_SECRET: "workspace-invite-secret",
    CAIRNSTONE_MAILBOX_CAPABILITY_SECRET: "mailbox-invite-secret"
  };
}

async function mailboxFor(actor, env) {
  const issued = await issueMailboxCapabilityFromBody({ principal_actor_id: actor, scopes: ["mail.read:self"] }, env);
  assert.equal(issued.ok, true);
  return issued.mailbox_capability;
}

function encodeBase64Url(value) {
  const bytes = new TextEncoder().encode(String(value));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/g, "");
}

async function hmacSha256Base64Url(secret, value) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(value));
  let binary = "";
  for (const byte of new Uint8Array(signature)) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/g, "");
}

/** Forge a signed mailbox ticket with explicit iat/exp for fail-closed tests (fake secret only). */
async function signedMailboxTicket({ actor, scopes = ["mail.read:self"], iat, exp, env }) {
  const payload = {
    schema: "cairnstone-mailbox-capability-v1",
    principal_actor_id: actor,
    scopes: [...scopes].sort(),
    iat,
    exp,
    nonce: `test-nonce-${iat}-${exp}`,
    policy: {
      self_only: true,
      transport_only: true,
      execution_authority: false,
      mutation_authority: false,
      accepted_state_authority: false
    }
  };
  const encodedPayload = encodeBase64Url(stableJson(payload));
  const signature = await hmacSha256Base64Url(env.CAIRNSTONE_MAILBOX_CAPABILITY_SECRET, encodedPayload);
  return `${encodedPayload}.${signature}`;
}

test("V7.7.6a mint is non-secret and principal-bound", async () => {
  const db = new FakeInviteD1();
  const env = envFor(db);
  await createWorkspace(db, { workspace_id: WS_ID, name: "Invite WS", created_by: "operator:cairnstone-console" });
  const minted = await mintWorkspaceInviteFromBody({ workspace_id: WS_ID, principal_actor_id: ACTOR_GROK, membership_role: "drafter", scopes: ["ls", "read", "diff", "write_draft"] }, env, "operator:cairnstone-console");
  assert.equal(minted.ok, true);
  assert.equal(minted.schema, WORKSPACE_INVITE_SCHEMA);
  assert.equal(minted.workspace_capability, null);
  assert.equal(minted.invite.principal_actor_id, ACTOR_GROK);
  assert.equal(minted.invite.state, "pending");
  assert.ok(minted.invite.invite_fingerprint);
});

test("V7.7.6a claim requires mailbox proof and rejects actor substitution", async () => {
  const db = new FakeInviteD1();
  const env = envFor(db);
  await createWorkspace(db, { workspace_id: WS_ID, name: "Invite WS", created_by: "operator:cairnstone-console" });
  const minted = await mintWorkspaceInviteFromBody({ workspace_id: WS_ID, principal_actor_id: ACTOR_GROK, membership_role: "drafter", scopes: ["ls", "read", "write_draft"] }, env);
  const stolen = await claimWorkspaceInviteFromBody({ invite_id: minted.invite.invite_id, actor_id: ACTOR_CLAUDE, mailbox_capability: await mailboxFor(ACTOR_CLAUDE, env) }, env);
  assert.equal(stolen.ok, false);
  assert.equal(stolen.error, "workspace_invite_principal_mismatch");
  const claimed = await claimWorkspaceInviteFromBody({ invite_id: minted.invite.invite_id, actor_id: ACTOR_GROK, mailbox_capability: await mailboxFor(ACTOR_GROK, env) }, env);
  assert.equal(claimed.ok, true);
  assert.ok(claimed.workspace_capability);
  assert.equal(claimed.invite.state, "claimed");
  assert.equal(claimed.policy.accepted_state_authority, false);
  assert.ok(!claimed.scopes.includes("propose"));
});

test("V7.7.6a revoked invite cannot be claimed and active grant is denied", async () => {
  const db = new FakeInviteD1();
  const env = envFor(db);
  await createWorkspace(db, { workspace_id: WS_ID, name: "Invite WS", created_by: "operator:cairnstone-console" });
  const minted = await mintWorkspaceInviteFromBody({ workspace_id: WS_ID, principal_actor_id: ACTOR_GROK, membership_role: "reader", scopes: ["ls", "read"] }, env);
  const claimed = await claimWorkspaceInviteFromBody({ invite_id: minted.invite.invite_id, actor_id: ACTOR_GROK, mailbox_capability: await mailboxFor(ACTOR_GROK, env) }, env);
  assert.equal(claimed.ok, true);
  const revoked = await revokeWorkspaceInviteFromBody({ invite_id: minted.invite.invite_id }, env);
  assert.equal(revoked.ok, true);
  assert.equal(revoked.invite.state, "revoked");
  const after = await claimWorkspaceInviteFromBody({ invite_id: minted.invite.invite_id, actor_id: ACTOR_GROK, mailbox_capability: await mailboxFor(ACTOR_GROK, env) }, env);
  assert.equal(after.ok, false);
  assert.equal(after.error, "workspace_invite_revoked");
  const gated = await authorizeWorkspaceRequest(db, env, { workspace_capability: claimed.workspace_capability, actor_id: ACTOR_GROK, workspace_id: WS_ID, requiredScopes: ["ls"] });
  assert.equal(gated.ok, false);
  assert.equal(gated.error, "workspace_capability_revoked");
});

test("V7.7.6a write_draft invite cannot imply propose", async () => {
  const db = new FakeInviteD1();
  const env = envFor(db);
  await createWorkspace(db, { workspace_id: WS_ID, name: "Invite WS", created_by: "operator:cairnstone-console" });
  const minted = await mintWorkspaceInviteFromBody({ workspace_id: WS_ID, principal_actor_id: ACTOR_GROK, membership_role: "drafter", scopes: ["ls", "read", "write_draft", "propose"] }, env);
  assert.equal(minted.ok, false);
  assert.equal(minted.error, "workspace_capability_widens_membership");
});

test("V7.7.6a claim tool is registered and never automatic-read", () => {
  const tools = mcpToolsForProfile(false);
  assert.ok(tools.some(tool => tool.name === WORKSPACE_INVITE_CLAIM_TOOL_ID));
  const entry = DEFAULT_TOOL_BROKER_REGISTRY.find(tool => tool.tool_id === WORKSPACE_INVITE_CLAIM_TOOL_ID);
  assert.ok(entry);
  assert.equal(entry.risk_class, "mutation");
  assert.ok(!listAutomaticReadToolIds(DEFAULT_TOOL_BROKER_REGISTRY).includes(WORKSPACE_INVITE_CLAIM_TOOL_ID));
});

test("semantic actor string without mailbox capability fails closed", async () => {
  const db = new FakeInviteD1();
  const env = envFor(db);
  await createWorkspace(db, { workspace_id: WS_ID, name: "Invite WS", created_by: "operator:cairnstone-console" });
  const minted = await mintWorkspaceInviteFromBody({ workspace_id: WS_ID, principal_actor_id: ACTOR_GROK, membership_role: "reader", scopes: ["ls"] }, env);
  const naked = await claimWorkspaceInviteFromBody({ invite_id: minted.invite.invite_id, actor_id: ACTOR_GROK }, env);
  assert.equal(naked.ok, false);
  assert.equal(naked.error, "mailbox_capability_required");
});

test("V7.7.6 claim rejects expired mailbox capability fail-closed", async () => {
  const db = new FakeInviteD1();
  const env = envFor(db);
  await createWorkspace(db, { workspace_id: WS_ID, name: "Invite WS", created_by: "operator:cairnstone-console" });
  const minted = await mintWorkspaceInviteFromBody({
    workspace_id: WS_ID,
    principal_actor_id: ACTOR_GROK,
    membership_role: "reader",
    scopes: ["ls", "read"]
  }, env);
  const now = Math.floor(Date.now() / 1000);
  const expired = await signedMailboxTicket({
    actor: ACTOR_GROK,
    iat: now - 120,
    exp: now - 30,
    env
  });
  const claimed = await claimWorkspaceInviteFromBody({
    invite_id: minted.invite.invite_id,
    actor_id: ACTOR_GROK,
    mailbox_capability: expired
  }, env);
  assert.equal(claimed.ok, false);
  assert.equal(claimed.error, "mailbox_capability_expired_or_invalid_time");
  assert.equal(claimed.reason, "expired");
  assert.ok(!JSON.stringify(claimed).includes(expired), "error responses must not echo bearer material");
  assert.equal(db.invites.get(minted.invite.invite_id).state, "pending");
});

test("V7.7.6 claim rejects mail.read:self principal mismatch fail-closed", async () => {
  const db = new FakeInviteD1();
  const env = envFor(db);
  await createWorkspace(db, { workspace_id: WS_ID, name: "Invite WS", created_by: "operator:cairnstone-console" });
  const minted = await mintWorkspaceInviteFromBody({
    workspace_id: WS_ID,
    principal_actor_id: ACTOR_GROK,
    membership_role: "reader",
    scopes: ["ls"]
  }, env);
  // Valid signed mail.read:self ticket for CLAUDE presented while claiming as GROK.
  const wrongPrincipal = await mailboxFor(ACTOR_CLAUDE, env);
  const verified = await verifyMailboxCapability(wrongPrincipal, ACTOR_GROK, ["mail.read:self"], env);
  assert.equal(verified.ok, false);
  assert.equal(verified.error, "mailbox_capability_principal_mismatch");
  assert.equal(verified.principal_actor_id, ACTOR_CLAUDE);
  assert.equal(verified.requested_actor_id, ACTOR_GROK);

  const claimed = await claimWorkspaceInviteFromBody({
    invite_id: minted.invite.invite_id,
    actor_id: ACTOR_GROK,
    mailbox_capability: wrongPrincipal
  }, env);
  assert.equal(claimed.ok, false);
  assert.equal(claimed.error, "mailbox_capability_principal_mismatch");
  assert.equal(db.invites.get(minted.invite.invite_id).state, "pending");
});

test("V7.7.6 claim never persists workspace bearer into invite rows / public invite / notice", async () => {
  const db = new FakeInviteD1();
  const env = envFor(db);
  await createWorkspace(db, { workspace_id: WS_ID, name: "Invite WS", created_by: "operator:cairnstone-console" });
  const minted = await mintWorkspaceInviteFromBody({
    workspace_id: WS_ID,
    principal_actor_id: ACTOR_GROK,
    membership_role: "drafter",
    scopes: ["ls", "read", "write_draft"]
  }, env);
  assert.equal(minted.workspace_capability, null);
  assert.equal(minted.invite.policy.bearer_in_invite_record, false);

  const claimed = await claimWorkspaceInviteFromBody({
    invite_id: minted.invite.invite_id,
    actor_id: ACTOR_GROK,
    mailbox_capability: await mailboxFor(ACTOR_GROK, env)
  }, env);
  assert.equal(claimed.ok, true);
  assert.ok(claimed.workspace_capability);
  assert.ok(claimed.workspace_capability.includes("."), "claim response may return bearer once");

  const row = db.invites.get(minted.invite.invite_id);
  assert.ok(row);
  assert.equal(Object.prototype.hasOwnProperty.call(row, "workspace_capability"), false);
  const rowJson = JSON.stringify(row);
  assert.ok(!rowJson.includes(claimed.workspace_capability), "invite D1 row must not store workspace bearer");
  assert.ok(!/"workspace_capability"/.test(rowJson));

  const publicInviteJson = JSON.stringify(claimed.invite);
  const noticeJson = JSON.stringify(claimed.notice);
  assert.ok(!publicInviteJson.includes(claimed.workspace_capability));
  assert.ok(!noticeJson.includes(claimed.workspace_capability));
  assert.ok(!/"workspace_capability"\s*:/.test(publicInviteJson));
  assert.ok(!/"workspace_capability"\s*:/.test(noticeJson));
  // Documented placeholder must never appear as a real stored secret pattern either.
  assert.ok(!rowJson.includes(FAKE_BEARER_PLACEHOLDER));
});

test("V7.7.6 inspect+prefer picks latest-iat unexpired mailbox ticket (host resolution rule)", async () => {
  const env = envFor(new FakeInviteD1());
  const now = Math.floor(Date.now() / 1000);
  const expired = await signedMailboxTicket({
    actor: ACTOR_GROK,
    iat: now - 900,
    exp: now - 10,
    env
  });
  const olderValid = await signedMailboxTicket({
    actor: ACTOR_GROK,
    iat: now - 120,
    exp: now + 600,
    env
  });
  const newerValid = await signedMailboxTicket({
    actor: ACTOR_GROK,
    iat: now - 30,
    exp: now + 900,
    env
  });
  const tokens = [expired, olderValid, newerValid];
  const inspected = [];
  for (const token of tokens) {
    const meta = await inspectMailboxCapabilityMetadata(token, env);
    assert.equal(meta.ok, true);
    assert.ok(!("mailbox_capability" in meta), "inspect must not echo raw bearer");
    inspected.push(meta);
  }
  assert.equal(inspected[0].usable, false);
  assert.equal(inspected[0].expired, true);
  const preferred = preferUnexpiredMailboxCapability(inspected);
  assert.equal(preferred.ok, true);
  assert.equal(preferred.source_index, 2);
  assert.equal(preferred.iat, now - 30);

  // Invalid signature stays distinct from expiry (clarity without leaking bearer).
  const badSig = `${olderValid.split(".")[0]}.deadbeefsignature`;
  const bad = await inspectMailboxCapabilityMetadata(badSig, env);
  assert.equal(bad.ok, false);
  assert.equal(bad.error, "mailbox_capability_invalid_signature");
});
