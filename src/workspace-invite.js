// V7.7.6a — Secure workspace invitation + recipient-authenticated claim/revoke.
//
// Operator REST mints/revokes invites. Recipient claim requires a signed
// mailbox capability proving the intended principal. The issued workspace
// bearer is returned only on the claim response and is never persisted in
// invite rows, AC1, or accepted state.

import { sha256Text, stableJson } from "./agent-bootstrap.js";
import { verifyMailboxCapability } from "./worker-session.js";
import {
  WORKSPACE_CAPABILITY_DEFAULT_TTL_SECONDS,
  WORKSPACE_CAPABILITY_MAX_TTL_SECONDS,
  WORKSPACE_MEMBER_ROLES,
  canonicalizeWorkspacePath,
  issueWorkspaceCapabilityFromBody,
  narrowScopesToMembership,
  upsertWorkspaceMember,
  verifyWorkspaceCapability
} from "./workspace.js";

export const WORKSPACE_INVITE_SCHEMA = "cairnstone-workspace-invite-v1";
export const WORKSPACE_INVITE_CLAIM_SCOPE = "mail.read:self";
export const WORKSPACE_INVITE_STATES = Object.freeze(["pending", "claimed", "expired", "revoked"]);
export const WORKSPACE_INVITE_MAX_TTL_SECONDS = 7 * 24 * 3600;
export const WORKSPACE_INVITE_DEFAULT_TTL_SECONDS = 24 * 3600;

export const WORKSPACE_INVITE_CLAIM_TOOL_ID = "cairnstone_workspace_invite_claim";

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function clampInt(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isInteger(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

function actorId(value, field) {
  const text = String(value || "").trim();
  if (!/^[a-z0-9][a-z0-9._-]{0,63}:[a-z0-9][a-z0-9._-]{0,127}$/i.test(text)) {
    throw new Error(`${field}_invalid`);
  }
  return text;
}

function workspaceId(value) {
  const text = String(value || "").trim();
  if (!text || text.length > 200) throw new Error("workspace_id_invalid");
  return text;
}

function publicInviteRecord(row) {
  return {
    schema: WORKSPACE_INVITE_SCHEMA,
    invite_id: row.invite_id,
    workspace_id: row.workspace_id,
    principal_actor_id: row.principal_actor_id,
    membership_role: row.membership_role,
    scopes: typeof row.scopes_json === "string" ? JSON.parse(row.scopes_json) : row.scopes,
    path_prefix: row.path_prefix || null,
    issued_by: row.issued_by,
    issued_at: row.issued_at,
    expires_at: row.expires_at,
    state: row.state,
    invite_fingerprint: row.invite_fingerprint,
    claimed_at: row.claimed_at || null,
    claimed_by: row.claimed_by || null,
    grant_expires_at: row.grant_expires_at || null,
    revoked_at: row.revoked_at || null,
    revoked_by: row.revoked_by || null,
    policy: {
      accepted_state_authority: false,
      execution_authority: false,
      mutation_authority: false,
      write_draft_implies_propose: false,
      bearer_in_invite_record: false
    }
  };
}

export async function computeInviteFingerprint(fields) {
  return sha256Text(stableJson({
    schema: WORKSPACE_INVITE_SCHEMA,
    invite_id: fields.invite_id,
    workspace_id: fields.workspace_id,
    principal_actor_id: fields.principal_actor_id,
    membership_role: fields.membership_role,
    scopes: fields.scopes,
    path_prefix: fields.path_prefix || null,
    issued_by: fields.issued_by,
    issued_at: fields.issued_at,
    expires_at: fields.expires_at
  }));
}

export function invitePublicNotice(invite) {
  const record = invite;
  return {
    schema: "cairnstone-workspace-invite-notice-v1",
    invite_id: record.invite_id,
    workspace_id: record.workspace_id,
    principal_actor_id: record.principal_actor_id,
    membership_role: record.membership_role,
    scopes: record.scopes,
    path_prefix: record.path_prefix || null,
    invite_fingerprint: record.invite_fingerprint,
    expires_at: record.expires_at,
    state: record.state,
    instruction: "Check your CairnStone work inbox, then claim this invite with your authenticated mailbox capability. Do not paste workspace bearers into Stones or messages."
  };
}

async function selectInvite(db, invite_id) {
  return db.prepare(
    `SELECT invite_id, workspace_id, principal_actor_id, membership_role, scopes_json, path_prefix,
            issued_by, issued_at, expires_at, state, invite_fingerprint, claimed_at, claimed_by,
            grant_nonce, grant_expires_at, revoked_at, revoked_by
       FROM workspace_invites WHERE invite_id = ?`
  ).bind(invite_id).first();
}

export async function getWorkspaceGrantDeny(db, grant_nonce) {
  if (!db || !grant_nonce) return null;
  return db.prepare(
    `SELECT grant_nonce, invite_id, workspace_id, principal_actor_id, revoked_at, revoked_by
       FROM workspace_capability_denylist WHERE grant_nonce = ?`
  ).bind(grant_nonce).first();
}

export async function mintWorkspaceInviteFromBody(body = {}, env = {}, issuedBy = "operator:cairnstone-console") {
  if (!env?.CAIRNSTONE_DB) return { ok: false, error: "missing_d1_binding", binding: "CAIRNSTONE_DB" };
  const db = env.CAIRNSTONE_DB;
  let principalActorId;
  let wsId;
  try {
    principalActorId = actorId(body.principal_actor_id, "principal_actor_id");
    wsId = workspaceId(body.workspace_id);
  } catch (error) {
    return { ok: false, error: "invalid_workspace_invite_principal", detail: String(error.message || error) };
  }

  const workspace = await db.prepare("SELECT workspace_id FROM workspaces WHERE workspace_id = ?").bind(wsId).first();
  if (!workspace) return { ok: false, error: "workspace_not_found", workspace_id: wsId };

  const membershipRole = String(body.membership_role || "").trim();
  if (!WORKSPACE_MEMBER_ROLES.includes(membershipRole)) {
    return { ok: false, error: "invalid_workspace_membership_role", allowed_roles: [...WORKSPACE_MEMBER_ROLES] };
  }
  const narrowed = narrowScopesToMembership(body.scopes, membershipRole);
  if (!narrowed.ok) return narrowed;

  let pathPrefix = null;
  if (body.path_prefix !== undefined && body.path_prefix !== null && body.path_prefix !== "") {
    const prefixResult = canonicalizeWorkspacePath(body.path_prefix);
    if (!prefixResult.ok) return { ok: false, error: "invalid_workspace_path_prefix", detail: prefixResult };
    pathPrefix = prefixResult.path;
  }

  const ttlSeconds = clampInt(body.ttl_seconds, 60, WORKSPACE_INVITE_MAX_TTL_SECONDS, WORKSPACE_INVITE_DEFAULT_TTL_SECONDS);
  const now = new Date();
  const issuedAt = now.toISOString();
  const expiresAt = new Date(now.getTime() + ttlSeconds * 1000).toISOString();
  const inviteId = typeof crypto.randomUUID === "function" ? crypto.randomUUID() : `inv-${now.getTime()}`;
  const fingerprint = await computeInviteFingerprint({
    invite_id: inviteId,
    workspace_id: wsId,
    principal_actor_id: principalActorId,
    membership_role: membershipRole,
    scopes: narrowed.scopes,
    path_prefix: pathPrefix,
    issued_by: issuedBy,
    issued_at: issuedAt,
    expires_at: expiresAt
  });

  await db.prepare(
    `INSERT INTO workspace_invites (
       invite_id, workspace_id, principal_actor_id, membership_role, scopes_json, path_prefix,
       issued_by, issued_at, expires_at, state, invite_fingerprint
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)`
  ).bind(
    inviteId,
    wsId,
    principalActorId,
    membershipRole,
    JSON.stringify(narrowed.scopes),
    pathPrefix,
    issuedBy,
    issuedAt,
    expiresAt,
    fingerprint
  ).run();

  const invite = publicInviteRecord({
    invite_id: inviteId,
    workspace_id: wsId,
    principal_actor_id: principalActorId,
    membership_role: membershipRole,
    scopes: narrowed.scopes,
    path_prefix: pathPrefix,
    issued_by: issuedBy,
    issued_at: issuedAt,
    expires_at: expiresAt,
    state: "pending",
    invite_fingerprint: fingerprint
  });

  return {
    ok: true,
    schema: WORKSPACE_INVITE_SCHEMA,
    invite,
    notice: invitePublicNotice(invite),
    workspace_capability: null
  };
}

export async function revokeWorkspaceInviteFromBody(body = {}, env = {}, revokedBy = "operator:cairnstone-console") {
  if (!env?.CAIRNSTONE_DB) return { ok: false, error: "missing_d1_binding", binding: "CAIRNSTONE_DB" };
  if (!isNonEmptyString(body.invite_id)) return { ok: false, error: "invite_id_required" };
  const db = env.CAIRNSTONE_DB;
  const row = await selectInvite(db, body.invite_id.trim());
  if (!row) return { ok: false, error: "workspace_invite_not_found" };
  if (row.state === "revoked") {
    return { ok: true, already_revoked: true, invite: publicInviteRecord(row) };
  }

  const now = new Date().toISOString();
  await db.prepare(
    `UPDATE workspace_invites
        SET state = 'revoked', revoked_at = ?, revoked_by = ?
      WHERE invite_id = ?`
  ).bind(now, revokedBy, row.invite_id).run();

  if (row.grant_nonce) {
    await db.prepare(
      `INSERT OR IGNORE INTO workspace_capability_denylist
         (grant_nonce, invite_id, workspace_id, principal_actor_id, revoked_at, revoked_by)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).bind(row.grant_nonce, row.invite_id, row.workspace_id, row.principal_actor_id, now, revokedBy).run();
  }

  const updated = await selectInvite(db, row.invite_id);
  return { ok: true, invite: publicInviteRecord(updated), active_grant_revoked: Boolean(row.grant_nonce) };
}

export async function claimWorkspaceInviteFromBody(body = {}, env = {}) {
  if (!env?.CAIRNSTONE_DB) return { ok: false, error: "missing_d1_binding", binding: "CAIRNSTONE_DB" };
  if (!isNonEmptyString(body.invite_id)) return { ok: false, error: "invite_id_required" };
  if (!isNonEmptyString(body.mailbox_capability)) return { ok: false, error: "mailbox_capability_required" };

  let requestedActor;
  try { requestedActor = actorId(body.actor_id, "actor_id"); }
  catch (error) { return { ok: false, error: "invalid_workspace_invite_actor", detail: String(error.message || error) }; }

  const mailbox = await verifyMailboxCapability(
    body.mailbox_capability,
    requestedActor,
    [WORKSPACE_INVITE_CLAIM_SCOPE],
    env
  );
  if (!mailbox.ok) return mailbox;

  const db = env.CAIRNSTONE_DB;
  const row = await selectInvite(db, body.invite_id.trim());
  if (!row) return { ok: false, error: "workspace_invite_not_found" };

  const nowMs = Date.now();
  if (row.state === "revoked") return { ok: false, error: "workspace_invite_revoked", invite_id: row.invite_id };
  if (row.state === "expired" || Date.parse(row.expires_at) <= nowMs) {
    if (row.state === "pending") {
      await db.prepare(`UPDATE workspace_invites SET state = 'expired' WHERE invite_id = ? AND state = 'pending'`).bind(row.invite_id).run();
    }
    return { ok: false, error: "workspace_invite_expired", invite_id: row.invite_id };
  }
  if (row.principal_actor_id !== mailbox.principal_actor_id) {
    return {
      ok: false,
      error: "workspace_invite_principal_mismatch",
      invite_principal_actor_id: row.principal_actor_id
    };
  }

  const scopes = JSON.parse(row.scopes_json);
  const capabilityTtl = clampInt(
    body.capability_ttl_seconds,
    30,
    WORKSPACE_CAPABILITY_MAX_TTL_SECONDS,
    WORKSPACE_CAPABILITY_DEFAULT_TTL_SECONDS
  );

  const issued = await issueWorkspaceCapabilityFromBody({
    principal_actor_id: row.principal_actor_id,
    workspace_id: row.workspace_id,
    membership_role: row.membership_role,
    scopes,
    path_prefix: row.path_prefix,
    ttl_seconds: capabilityTtl,
    invite_id: row.invite_id
  }, env);
  if (!issued.ok) return issued;

  const verifiedIssued = await verifyWorkspaceCapability(issued.workspace_capability, {
    expectedActorId: row.principal_actor_id,
    expectedWorkspaceId: row.workspace_id,
    requiredScopes: scopes
  }, env);
  const grantNonce = verifiedIssued.ok ? (verifiedIssued.nonce || null) : null;

  if (row.state === "pending") {
    const claimedAt = new Date().toISOString();
    await db.prepare(
      `UPDATE workspace_invites
          SET state = 'claimed', claimed_at = ?, claimed_by = ?, grant_nonce = ?, grant_expires_at = ?
        WHERE invite_id = ? AND state = 'pending'`
    ).bind(claimedAt, mailbox.principal_actor_id, grantNonce, issued.expires_at, row.invite_id).run();
  } else if (row.state === "claimed") {
    await db.prepare(
      `UPDATE workspace_invites
          SET grant_nonce = ?, grant_expires_at = ?
        WHERE invite_id = ? AND state = 'claimed' AND principal_actor_id = ?`
    ).bind(grantNonce, issued.expires_at, row.invite_id, mailbox.principal_actor_id).run();
  } else {
    return { ok: false, error: "workspace_invite_not_claimable", state: row.state };
  }

  const existingMember = await db.prepare(
    `SELECT role FROM workspace_members WHERE workspace_id = ? AND actor_id = ?`
  ).bind(row.workspace_id, row.principal_actor_id).first();
  if (!existingMember) {
    await upsertWorkspaceMember(db, {
      workspace_id: row.workspace_id,
      actor_id: row.principal_actor_id,
      role: row.membership_role
    });
  }

  const updated = await selectInvite(db, row.invite_id);
  const invite = publicInviteRecord(updated);
  return {
    ok: true,
    schema: WORKSPACE_INVITE_SCHEMA,
    invite,
    notice: invitePublicNotice(invite),
    workspace_capability: issued.workspace_capability,
    workspace_capability_expires_at: issued.expires_at,
    scopes: issued.scopes,
    membership_role: issued.membership_role,
    policy: issued.policy,
    replay: row.state === "claimed"
  };
}

export async function getWorkspaceInviteFromBody(body = {}, env = {}) {
  if (!env?.CAIRNSTONE_DB) return { ok: false, error: "missing_d1_binding", binding: "CAIRNSTONE_DB" };
  if (!isNonEmptyString(body.invite_id)) return { ok: false, error: "invite_id_required" };
  const row = await selectInvite(env.CAIRNSTONE_DB, body.invite_id.trim());
  if (!row) return { ok: false, error: "workspace_invite_not_found" };
  return { ok: true, invite: publicInviteRecord(row), notice: invitePublicNotice(publicInviteRecord(row)) };
}

export const WORKSPACE_INVITE_CLAIM_TOOL_DEFINITION = Object.freeze({
  name: WORKSPACE_INVITE_CLAIM_TOOL_ID,
  description: "V7.7.6a: claim a non-secret workspace invite. Requires a signed mailbox capability proving the intended principal. Returns a short-lived workspace capability. Never accepted-state authority.",
  inputSchema: {
    type: "object",
    required: ["invite_id", "actor_id", "mailbox_capability"],
    properties: {
      invite_id: { type: "string" },
      actor_id: { type: "string" },
      mailbox_capability: { type: "string" },
      capability_ttl_seconds: { type: "number", minimum: 30, maximum: 3600 }
    },
    additionalProperties: false
  }
});

export function workspaceInvitePublicSafe(value) {
  const text = stableJson(value);
  return !/workspace_capability":"[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/.test(text) || isObject(value);
}
