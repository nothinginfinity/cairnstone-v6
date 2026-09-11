import test from "node:test";
import assert from "node:assert/strict";
import { issueMailboxCapabilityFromBody } from "../src/worker-session.js";
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
