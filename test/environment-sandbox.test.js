import test from "node:test";
import assert from "node:assert/strict";
import {
  ENVIRONMENT_MANIFEST_SCHEMA,
  ENVIRONMENT_SANDBOX_BROKER_TOOL_IDS,
  ENVIRONMENT_SANDBOX_MCP_TOOL_DEFINITIONS,
  ENVIRONMENT_SANDBOX_MUTATION_TOOL_IDS,
  ENVIRONMENT_SANDBOX_READ_TOOL_IDS,
  assertSecretsAbsent,
  attachEnvironmentManifestToSessionFromBody,
  attachSandboxFromBody,
  commandClassAllowedForExecutionClass,
  createEnvironmentManifestFromBody,
  createExecutionReceiptFromBody,
  detachSandboxFromBody,
  getEnvironmentManifestFromBody,
  getSandboxAttachmentFromBody,
  normalizeEnvironmentManifestPayload
} from "../src/environment-sandbox.js";
import {
  compileCodeSessionContextFromBody,
  createCodeSessionFromBody,
  getCodeSessionFromBody
} from "../src/code-session.js";
import {
  createWorkspace,
  issueWorkspaceCapabilityFromBody,
  upsertWorkspaceMember
} from "../src/workspace.js";
import {
  DEFAULT_TOOL_BROKER_REGISTRY,
  toolRegistryFromBody
} from "../src/model-router.js";
import { listAutomaticReadToolIds } from "../src/delegate-loop.js";
import { mcpToolsForProfile } from "../src/index.js";

const SECRET = "environment-sandbox-test-secret-v777e";
const ACTOR_A = "chatgpt:cairnstone-v6";
const ACTOR_B = "claude:cairnstone-v6";
const WS_ID = "ws:v777e-demo";
const CS_ID = "cs:v777e-demo";
const BASE_SHA = "fdd74cfe2349af2dfd9f1302cef85a3b84f36eab";
const REPO = "nothinginfinity/cairnstone-v6";

class FakeR2 {
  constructor() {
    this.objects = new Map();
  }

  async put(key, value) {
    this.objects.set(key, String(value));
    return { key };
  }

  async get(key) {
    if (!this.objects.has(key)) return null;
    const text = this.objects.get(key);
    return { text: async () => text };
  }
}

/**
 * Fake D1 for V7.7.7e environment sandbox + minimal workspace / code-session support.
 * Tracks chain_heads / path_heads SQL attempts (must stay empty).
 */
class FakeEnvironmentSandboxD1 {
  constructor() {
    this.workspaces = new Map();
    this.members = new Map();
    this.revisions = new Map();
    this.tips = new Map();
    this.sessions = new Map();
    this.manifests = new Map();
    this.attachments = new Map();
    this.receipts = new Map();
    this.chainHeads = new Map();
    this.pathHeads = new Map();
    this.headMutationAttempts = [];
  }

  _memberKey(ws, actor) {
    return `${ws}\0${actor}`;
  }

  _tipKey(ws, path) {
    return `${ws}\0${path}`;
  }

  prepare(sql) {
    const db = this;
    const lower = sql.toLowerCase();
    if (lower.includes("chain_heads") || lower.includes("path_heads") || lower.includes("set_path_head")) {
      db.headMutationAttempts.push(sql);
    }
    return {
      bind(...args) {
        return {
          async run() {
            if (sql.includes("INSERT INTO workspaces")) {
              const [workspaceId, name, createdBy, createdAt, updatedAt, githubBind] = args;
              if (db.workspaces.has(workspaceId)) {
                throw new Error("UNIQUE constraint failed: workspaces.workspace_id");
              }
              db.workspaces.set(workspaceId, {
                workspace_id: workspaceId,
                name,
                created_by: createdBy,
                created_at: createdAt,
                updated_at: updatedAt,
                status: "active",
                github_bind_json: githubBind
              });
              return { success: true, meta: { changes: 1 } };
            }
            if (sql.includes("INSERT INTO workspace_members") && sql.includes("ON CONFLICT")) {
              const [workspaceId, actorId, role, createdAt] = args;
              const key = db._memberKey(workspaceId, actorId);
              const prior = db.members.get(key);
              db.members.set(key, {
                workspace_id: workspaceId,
                actor_id: actorId,
                role,
                created_at: prior?.created_at || createdAt
              });
              return { success: true, meta: { changes: 1 } };
            }
            if (sql.includes("INSERT INTO workspace_members")) {
              const [workspaceId, actorId, role, createdAt] = args;
              const key = db._memberKey(workspaceId, actorId);
              if (db.members.has(key)) throw new Error("UNIQUE constraint failed: workspace_members");
              db.members.set(key, {
                workspace_id: workspaceId,
                actor_id: actorId,
                role,
                created_at: createdAt
              });
              return { success: true, meta: { changes: 1 } };
            }
            if (sql.includes("INSERT OR IGNORE INTO workspace_revisions")) {
              const [revisionId, workspaceId, path, parentRevisionId, contentHash, contentBytes, actorId, createdAt] = args;
              if (!db.revisions.has(revisionId)) {
                db.revisions.set(revisionId, {
                  revision_id: revisionId,
                  workspace_id: workspaceId,
                  path,
                  parent_revision_id: parentRevisionId,
                  content_hash: contentHash,
                  content_bytes: contentBytes,
                  actor_id: actorId,
                  created_at: createdAt
                });
              }
              return { success: true, meta: { changes: 1 } };
            }
            if (sql.includes("INSERT INTO workspace_tips")) {
              const [workspaceId, path, revisionId, contentHash, updatedAt] = args;
              const key = db._tipKey(workspaceId, path);
              if (db.tips.has(key)) throw new Error("UNIQUE constraint failed: workspace_tips");
              db.tips.set(key, {
                workspace_id: workspaceId,
                path,
                revision_id: revisionId,
                content_hash: contentHash,
                updated_at: updatedAt
              });
              return { success: true, meta: { changes: 1 } };
            }
            if (sql.includes("UPDATE workspace_tips")) {
              const [revisionId, contentHash, updatedAt, workspaceId, path, baseRevision] = args;
              const key = db._tipKey(workspaceId, path);
              const tip = db.tips.get(key);
              if (!tip || tip.revision_id !== baseRevision) {
                return { success: true, meta: { changes: 0 } };
              }
              db.tips.set(key, {
                ...tip,
                revision_id: revisionId,
                content_hash: contentHash,
                updated_at: updatedAt
              });
              return { success: true, meta: { changes: 1 } };
            }
            if (sql.includes("UPDATE workspaces SET updated_at")) {
              const [updatedAt, workspaceId] = args;
              const row = db.workspaces.get(workspaceId);
              if (row) db.workspaces.set(workspaceId, { ...row, updated_at: updatedAt });
              return { success: true, meta: { changes: row ? 1 : 0 } };
            }
            if (sql.includes("INSERT INTO code_sessions")) {
              const [
                codeSessionId, workspaceId, projectChain, scopeJson, sourceReposJson,
                baseCommitsJson, workingTransportJson, tipVectorJson, tipVectorDigest,
                workspaceSnapshotId, taskLedgerJson, unresolvedIssuesJson, actorsJson,
                environmentManifestId, receiptRefsJson, latestCheckpointId,
                checkpointTipDigest, capabilityPolicyProfileId, createdBy, createdAt, updatedAt
              ] = args;
              if (db.sessions.has(codeSessionId)) {
                throw new Error("UNIQUE constraint failed: code_sessions.code_session_id");
              }
              db.sessions.set(codeSessionId, {
                code_session_id: codeSessionId,
                workspace_id: workspaceId,
                project_chain: projectChain,
                scope_json: scopeJson,
                source_repos_json: sourceReposJson,
                base_commits_json: baseCommitsJson,
                working_transport_json: workingTransportJson,
                tip_vector_json: tipVectorJson,
                tip_vector_digest: tipVectorDigest,
                workspace_snapshot_id: workspaceSnapshotId,
                task_ledger_json: taskLedgerJson,
                unresolved_issues_json: unresolvedIssuesJson,
                actors_json: actorsJson,
                environment_manifest_id: environmentManifestId,
                latest_execution_receipt_refs_json: receiptRefsJson,
                latest_checkpoint_id: latestCheckpointId,
                checkpoint_tip_vector_digest: checkpointTipDigest,
                capability_policy_profile_id: capabilityPolicyProfileId,
                lifecycle: "active",
                session_revision: 1,
                created_by: createdBy,
                created_at: createdAt,
                updated_at: updatedAt,
                latest_sandbox_attachment_id: null
              });
              return { success: true, meta: { changes: 1 } };
            }
            if (sql.includes("INSERT INTO environment_manifests")) {
              const [
                manifestId, workspaceId, codeSessionId, payloadJson, payloadDigest,
                sandboxExecutionClass, createdBy, createdAt
              ] = args;
              if (db.manifests.has(manifestId)) {
                throw new Error("UNIQUE constraint failed: environment_manifests.environment_manifest_id");
              }
              db.manifests.set(manifestId, {
                environment_manifest_id: manifestId,
                workspace_id: workspaceId,
                code_session_id: codeSessionId,
                payload_json: payloadJson,
                payload_digest: payloadDigest,
                sandbox_execution_class: sandboxExecutionClass,
                secrets_absent: 1,
                created_by: createdBy,
                created_at: createdAt,
                accepted_state_authority: 0
              });
              return { success: true, meta: { changes: 1 } };
            }
            if (sql.includes("INSERT INTO code_session_sandbox_attachments")) {
              const [
                attachmentId, codeSessionId, workspaceId, environmentManifestId,
                actorId, adapterProfileId, status, detailJson, attachedAt, updatedAt
              ] = args;
              if (db.attachments.has(attachmentId)) {
                throw new Error("UNIQUE constraint failed: code_session_sandbox_attachments.attachment_id");
              }
              db.attachments.set(attachmentId, {
                attachment_id: attachmentId,
                code_session_id: codeSessionId,
                workspace_id: workspaceId,
                environment_manifest_id: environmentManifestId,
                actor_id: actorId,
                adapter_profile_id: adapterProfileId,
                status,
                detail_json: detailJson,
                attached_at: attachedAt,
                updated_at: updatedAt,
                detached_at: null,
                secrets_absent: 1,
                accepted_state_authority: 0
              });
              return { success: true, meta: { changes: 1 } };
            }
            if (sql.includes("INSERT INTO code_session_execution_receipts")) {
              const [
                receiptId, codeSessionId, workspaceId, environmentManifestId,
                sandboxAttachmentId, actorId, commandClass, commandSummary, status,
                exitCode, durationMs, tipVectorDigest, artifactRefsJson, logRef,
                payloadJson, payloadDigest, createdAt
              ] = args;
              if (db.receipts.has(receiptId)) {
                throw new Error("UNIQUE constraint failed: code_session_execution_receipts.receipt_id");
              }
              db.receipts.set(receiptId, {
                receipt_id: receiptId,
                code_session_id: codeSessionId,
                workspace_id: workspaceId,
                environment_manifest_id: environmentManifestId,
                sandbox_attachment_id: sandboxAttachmentId,
                actor_id: actorId,
                command_class: commandClass,
                command_summary: commandSummary,
                status,
                exit_code: exitCode,
                duration_ms: durationMs,
                tip_vector_digest: tipVectorDigest,
                artifact_refs_json: artifactRefsJson,
                log_ref: logRef,
                payload_json: payloadJson,
                payload_digest: payloadDigest,
                secrets_absent: 1,
                production_mutation: 0,
                accepted_state_authority: 0,
                created_at: createdAt
              });
              return { success: true, meta: { changes: 1 } };
            }
            if (sql.includes("UPDATE code_sessions") && sql.includes("environment_manifest_id = ?")
              && sql.includes("session_revision = ?")) {
              const [manifestId, sessionRevision, updatedAt, codeSessionId, baseRevision] = args;
              const row = db.sessions.get(codeSessionId);
              if (!row || row.session_revision !== baseRevision) {
                return { success: true, meta: { changes: 0 } };
              }
              db.sessions.set(codeSessionId, {
                ...row,
                environment_manifest_id: manifestId,
                session_revision: sessionRevision,
                updated_at: updatedAt
              });
              return { success: true, meta: { changes: 1 } };
            }
            if (sql.includes("UPDATE environment_manifests") && sql.includes("code_session_id = ?")) {
              const [sessionId, manifestId, sessionIdAgain] = args;
              const row = db.manifests.get(manifestId);
              if (!row) return { success: true, meta: { changes: 0 } };
              if (row.code_session_id != null && row.code_session_id !== sessionIdAgain) {
                return { success: true, meta: { changes: 0 } };
              }
              db.manifests.set(manifestId, { ...row, code_session_id: sessionId });
              return { success: true, meta: { changes: 1 } };
            }
            if (sql.includes("UPDATE code_sessions") && sql.includes("latest_sandbox_attachment_id = ?")) {
              const [attachmentId, updatedAt, codeSessionId] = args;
              const row = db.sessions.get(codeSessionId);
              if (!row) return { success: true, meta: { changes: 0 } };
              db.sessions.set(codeSessionId, {
                ...row,
                latest_sandbox_attachment_id: attachmentId,
                updated_at: updatedAt
              });
              return { success: true, meta: { changes: 1 } };
            }
            if (sql.includes("UPDATE code_session_sandbox_attachments")
              && sql.includes("detached_at = ?")) {
              const [status, detailJson, updatedAt, detachedAt, attachmentId, actorId] = args;
              const row = db.attachments.get(attachmentId);
              if (!row || row.actor_id !== actorId) {
                return { success: true, meta: { changes: 0 } };
              }
              db.attachments.set(attachmentId, {
                ...row,
                status,
                detail_json: detailJson,
                updated_at: updatedAt,
                detached_at: detachedAt
              });
              return { success: true, meta: { changes: 1 } };
            }
            if (sql.includes("UPDATE code_sessions")
              && sql.includes("latest_execution_receipt_refs_json = ?")
              && sql.includes("session_revision = ?")) {
              const [refsJson, sessionRevision, updatedAt, codeSessionId, baseRevision] = args;
              const row = db.sessions.get(codeSessionId);
              if (!row || row.session_revision !== baseRevision) {
                return { success: true, meta: { changes: 0 } };
              }
              db.sessions.set(codeSessionId, {
                ...row,
                latest_execution_receipt_refs_json: refsJson,
                session_revision: sessionRevision,
                updated_at: updatedAt
              });
              return { success: true, meta: { changes: 1 } };
            }
            if (sql.includes("UPDATE code_sessions")
              && sql.includes("latest_execution_receipt_refs_json = ?")
              && !sql.includes("session_revision = ?")) {
              const [refsJson, updatedAt, codeSessionId] = args;
              const row = db.sessions.get(codeSessionId);
              if (!row) return { success: true, meta: { changes: 0 } };
              db.sessions.set(codeSessionId, {
                ...row,
                latest_execution_receipt_refs_json: refsJson,
                updated_at: updatedAt
              });
              return { success: true, meta: { changes: 1 } };
            }
            // Compile-context / get-session expire stale leases (none stored in this Fake).
            if (sql.includes("UPDATE code_session_leases") && sql.includes("status = 'expired'")) {
              return { success: true, meta: { changes: 0 } };
            }
            if (sql.includes("INSERT INTO chain_heads") || sql.includes("UPDATE chain_heads")
              || sql.includes("INSERT INTO path_heads") || sql.includes("UPDATE path_heads")) {
              db.headMutationAttempts.push({ sql, args });
              throw new Error("HEAD mutation must not occur from environment-sandbox ops");
            }
            throw new Error(`Unexpected run SQL: ${sql}`);
          },
          async first() {
            if (sql.includes("FROM workspaces WHERE workspace_id")) {
              return db.workspaces.get(args[0]) || null;
            }
            if (sql.includes("FROM workspace_members WHERE workspace_id = ? AND actor_id = ?")) {
              return db.members.get(db._memberKey(args[0], args[1])) || null;
            }
            if (sql.includes("FROM workspace_capability_denylist")) {
              return null;
            }
            if (sql.includes("FROM workspace_tips") && sql.includes("path = ?")) {
              return db.tips.get(db._tipKey(args[0], args[1])) || null;
            }
            if (sql.includes("FROM workspace_revisions WHERE revision_id")) {
              return db.revisions.get(args[0]) || null;
            }
            if (sql.includes("SELECT latest_sandbox_attachment_id FROM code_sessions")) {
              const row = db.sessions.get(args[0]);
              return row ? { latest_sandbox_attachment_id: row.latest_sandbox_attachment_id } : null;
            }
            if (sql.includes("FROM code_sessions WHERE code_session_id")) {
              return db.sessions.get(args[0]) || null;
            }
            if (sql.includes("FROM environment_manifests WHERE environment_manifest_id")) {
              return db.manifests.get(args[0]) || null;
            }
            if (sql.includes("FROM code_session_sandbox_attachments WHERE attachment_id")) {
              return db.attachments.get(args[0]) || null;
            }
            if (sql.includes("FROM code_session_execution_receipts WHERE receipt_id")) {
              return db.receipts.get(args[0]) || null;
            }
            throw new Error(`Unexpected first SQL: ${sql}`);
          },
          async all() {
            if (sql.includes("FROM workspace_tips WHERE workspace_id")) {
              const workspaceId = args[0];
              let tips = [...db.tips.values()].filter(tip => tip.workspace_id === workspaceId);
              if (sql.includes("path LIKE")) {
                const prefix = String(args[1] || "").replace(/%$/, "");
                tips = tips.filter(tip => tip.path.startsWith(prefix));
              }
              tips.sort((a, b) => a.path.localeCompare(b.path));
              return { results: tips };
            }
            if (sql.includes("FROM workspace_members WHERE workspace_id")) {
              const workspaceId = args[0];
              return {
                results: [...db.members.values()]
                  .filter(member => member.workspace_id === workspaceId)
                  .sort((a, b) => a.actor_id.localeCompare(b.actor_id))
              };
            }
            if (sql.includes("FROM code_session_execution_receipts")
              && sql.includes("WHERE code_session_id")) {
              const sessionId = args[0];
              const limit = Number(args[1]) || 20;
              const rows = [...db.receipts.values()]
                .filter(row => row.code_session_id === sessionId)
                .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))
                .slice(0, limit);
              return { results: rows };
            }
            if (sql.includes("FROM code_session_leases")) {
              return { results: [] };
            }
            return { results: [] };
          }
        };
      }
    };
  }
}

function testEnv(db, r2 = new FakeR2()) {
  return {
    CAIRNSTONE_DB: db,
    CAIRNSTONE_RAW: r2,
    CAIRNSTONE_WORKSPACE_CAPABILITY_SECRET: SECRET
  };
}

async function mintCap(actor, role, scopes, workspaceId = WS_ID) {
  const issued = await issueWorkspaceCapabilityFromBody({
    principal_actor_id: actor,
    workspace_id: workspaceId,
    membership_role: role,
    scopes
  }, { CAIRNSTONE_WORKSPACE_CAPABILITY_SECRET: SECRET });
  assert.equal(issued.ok, true);
  return issued.workspace_capability;
}

async function seedWorkspace(db, r2, {
  workspaceId = WS_ID,
  owner = ACTOR_A,
  members = []
} = {}) {
  const created = await createWorkspace(db, {
    workspace_id: workspaceId,
    name: "V777e demo",
    created_by: owner
  });
  assert.equal(created.ok, true);
  for (const member of members) {
    const upserted = await upsertWorkspaceMember(db, {
      workspace_id: workspaceId,
      actor_id: member.actor_id,
      role: member.role
    });
    assert.equal(upserted.ok, true);
  }
  return { db, r2, env: testEnv(db, r2) };
}

function baseSessionBody(overrides = {}) {
  return {
    code_session_id: CS_ID,
    workspace_id: WS_ID,
    created_by: ACTOR_A,
    project_chain: "cairnstone-v6",
    source_repos: [REPO],
    base_commits: [{ repo: REPO, commit_sha: BASE_SHA }],
    working_transport: { branch: "cursor/v777e-environment-sandbox", transport_only: true },
    task_ledger: [{
      task_id: "task-env-1",
      title: "Environment sandbox slice",
      state: "active",
      actor_id: ACTOR_A
    }],
    unresolved_issues: [],
    latest_execution_receipt_refs: [],
    capability_policy_profile_id: "profile:owner",
    ...overrides
  };
}

function baseManifestBody(overrides = {}) {
  return {
    workspace_id: WS_ID,
    created_by: ACTOR_A,
    source_repos: [REPO],
    base_commits: [{ repo: REPO, commit_sha: BASE_SHA }],
    runtime: { languages: [{ name: "node", version: "22" }], toolchains: ["npm"] },
    lockfiles: ["package-lock.json"],
    build_commands: ["npm run build"],
    test_commands: ["npm test"],
    env_bindings: ["NODE_ENV", "CI"],
    sandbox_adapter: { adapter_profile_id: "local-node", provider: "local" },
    sandbox_execution_class: "local_build_test",
    secrets_absent: true,
    ...overrides
  };
}

test("normalizeEnvironmentManifestPayload rejects secrets; accepts secrets_absent", () => {
  const badName = normalizeEnvironmentManifestPayload({
    source_repos: [REPO],
    base_commits: [{ repo: REPO, commit_sha: BASE_SHA }],
    env_bindings: ["API_SECRET_TOKEN"]
  });
  assert.equal(badName.ok, false);
  assert.equal(badName.error, "environment_manifest_env_binding_name_looks_like_secret");

  const badKey = normalizeEnvironmentManifestPayload({
    source_repos: [REPO],
    base_commits: [{ repo: REPO, commit_sha: BASE_SHA }],
    api_key: "should-not-persist"
  });
  assert.equal(badKey.ok, false);
  assert.equal(badKey.error, "secrets_not_absent");

  const withValue = normalizeEnvironmentManifestPayload({
    source_repos: [REPO],
    base_commits: [{ repo: REPO, commit_sha: BASE_SHA }],
    env_bindings: [{ name: "NODE_ENV", value: "production" }]
  });
  assert.equal(withValue.ok, false);
  assert.equal(withValue.error, "environment_manifest_env_binding_values_forbidden");

  const ok = normalizeEnvironmentManifestPayload({
    source_repos: [REPO],
    base_commits: [{ repo: REPO, commit_sha: BASE_SHA }],
    env_bindings: ["NODE_ENV", "CI"],
    sandbox_execution_class: "local_install_build_test",
    secrets_absent: true
  });
  assert.equal(ok.ok, true);
  assert.equal(ok.payload.schema, ENVIRONMENT_MANIFEST_SCHEMA);
  assert.equal(ok.payload.secrets_absent, true);
  assert.equal(ok.payload.accepted_state_authority, false);
  assert.equal(ok.sandbox_execution_class, "local_install_build_test");
});

test("assertSecretsAbsent and commandClassAllowedForExecutionClass basics", () => {
  assert.equal(assertSecretsAbsent({ NODE_ENV: "test" }).ok, true);
  assert.equal(assertSecretsAbsent({ api_key: "x" }).ok, false);
  assert.equal(assertSecretsAbsent({ note: "[REDACTED]" }).ok, false);

  assert.equal(commandClassAllowedForExecutionClass("none", "build"), false);
  assert.equal(commandClassAllowedForExecutionClass("local_build_test", "install"), false);
  assert.equal(commandClassAllowedForExecutionClass("local_build_test", "build"), true);
  assert.equal(commandClassAllowedForExecutionClass("local_install_build_test", "install"), true);
});

test("create + get environment manifest (write_draft / ls)", async () => {
  const db = new FakeEnvironmentSandboxD1();
  const { env } = await seedWorkspace(db, new FakeR2());
  const writeCap = await mintCap(ACTOR_A, "owner", ["write_draft", "ls"]);

  const created = await createEnvironmentManifestFromBody({
    ...baseManifestBody(),
    workspace_capability: writeCap
  }, env);
  assert.equal(created.ok, true);
  assert.ok(created.environment_manifest_id.startsWith("envmanifest:"));
  assert.equal(created.secrets_absent, true);
  assert.equal(created.accepted_state_authority, false);
  assert.equal(created.sandbox_execution_class, "local_build_test");
  assert.deepEqual(created.payload.env_bindings, ["CI", "NODE_ENV"]);

  const got = await getEnvironmentManifestFromBody({
    environment_manifest_id: created.environment_manifest_id,
    actor_id: ACTOR_A,
    workspace_capability: await mintCap(ACTOR_A, "owner", ["ls"])
  }, env);
  assert.equal(got.ok, true);
  assert.equal(got.environment_manifest_id, created.environment_manifest_id);
  assert.equal(got.payload_digest, created.payload_digest);

  const denied = await createEnvironmentManifestFromBody({
    ...baseManifestBody({ environment_manifest_id: "envmanifest:denied-ls-only" }),
    workspace_capability: await mintCap(ACTOR_A, "owner", ["ls"])
  }, env);
  assert.equal(denied.ok, false);
});

test("attach environment to code session with CAS; stale base_revision → conflict", async () => {
  const db = new FakeEnvironmentSandboxD1();
  const { env } = await seedWorkspace(db, new FakeR2());
  const cap = await mintCap(ACTOR_A, "owner", ["write_draft", "ls", "read"]);

  const session = await createCodeSessionFromBody({
    ...baseSessionBody(),
    workspace_capability: cap
  }, env);
  assert.equal(session.ok, true);
  assert.equal(session.session_revision, 1);

  const manifest = await createEnvironmentManifestFromBody({
    ...baseManifestBody({ environment_manifest_id: "envmanifest:v777e-attach" }),
    workspace_capability: cap
  }, env);
  assert.equal(manifest.ok, true);

  const attached = await attachEnvironmentManifestToSessionFromBody({
    code_session_id: CS_ID,
    environment_manifest_id: manifest.environment_manifest_id,
    actor_id: ACTOR_A,
    base_revision: 1,
    workspace_capability: cap
  }, env);
  assert.equal(attached.ok, true);
  assert.equal(attached.session_revision, 2);
  assert.equal(attached.environment_manifest_id, "envmanifest:v777e-attach");
  assert.equal(attached.accepted_state_authority, false);

  const stale = await attachEnvironmentManifestToSessionFromBody({
    code_session_id: CS_ID,
    environment_manifest_id: manifest.environment_manifest_id,
    actor_id: ACTOR_A,
    base_revision: 1,
    workspace_capability: cap
  }, env);
  assert.equal(stale.ok, false);
  assert.equal(stale.error, "code_session_conflict");
  assert.equal(stale.expected_session_revision, 2);
});

test("sandbox attach → get → detach; wrong actor fails; session remains durable", async () => {
  const db = new FakeEnvironmentSandboxD1();
  const { env } = await seedWorkspace(db, new FakeR2(), {
    members: [{ actor_id: ACTOR_B, role: "drafter" }]
  });
  const capA = await mintCap(ACTOR_A, "owner", ["write_draft", "ls", "read"]);
  const capB = await mintCap(ACTOR_B, "drafter", ["write_draft", "ls"]);

  await createCodeSessionFromBody({
    ...baseSessionBody(),
    workspace_capability: capA
  }, env);

  const manifest = await createEnvironmentManifestFromBody({
    ...baseManifestBody({ environment_manifest_id: "envmanifest:v777e-sandbox" }),
    workspace_capability: capA
  }, env);
  assert.equal(manifest.ok, true);

  const envAttach = await attachEnvironmentManifestToSessionFromBody({
    code_session_id: CS_ID,
    environment_manifest_id: manifest.environment_manifest_id,
    actor_id: ACTOR_A,
    base_revision: 1,
    workspace_capability: capA
  }, env);
  assert.equal(envAttach.ok, true);

  const attached = await attachSandboxFromBody({
    code_session_id: CS_ID,
    actor_id: ACTOR_A,
    workspace_capability: capA,
    adapter_profile_id: "local-node",
    status: "ready"
  }, env);
  assert.equal(attached.ok, true);
  assert.ok(attached.attachment_id.startsWith("sandbox:"));
  assert.equal(attached.status, "ready");
  assert.equal(attached.accepted_state_authority, false);
  assert.equal(attached.secrets_absent, true);

  const got = await getSandboxAttachmentFromBody({
    attachment_id: attached.attachment_id,
    actor_id: ACTOR_A,
    workspace_capability: await mintCap(ACTOR_A, "owner", ["ls"])
  }, env);
  assert.equal(got.ok, true);
  assert.equal(got.attachment_id, attached.attachment_id);

  const wrongDetach = await detachSandboxFromBody({
    attachment_id: attached.attachment_id,
    actor_id: ACTOR_B,
    workspace_capability: capB
  }, env);
  assert.equal(wrongDetach.ok, false);
  assert.equal(wrongDetach.error, "sandbox_attachment_actor_mismatch");

  const detached = await detachSandboxFromBody({
    attachment_id: attached.attachment_id,
    actor_id: ACTOR_A,
    workspace_capability: capA,
    status: "detached"
  }, env);
  assert.equal(detached.ok, true);
  assert.equal(detached.status, "detached");
  assert.ok(detached.detached_at);

  const session = await getCodeSessionFromBody({
    code_session_id: CS_ID,
    actor_id: ACTOR_A,
    workspace_capability: await mintCap(ACTOR_A, "owner", ["ls"])
  }, env);
  assert.equal(session.ok, true);
  assert.equal(session.lifecycle, "active");
  assert.equal(session.environment_manifest_id, "envmanifest:v777e-sandbox");
  assert.equal(session.latest_sandbox_attachment_id, attached.attachment_id);
});

test("execution receipt create: install denied for local_build_test; allowed for local_install_build_test", async () => {
  const db = new FakeEnvironmentSandboxD1();
  const { env } = await seedWorkspace(db, new FakeR2());
  const cap = await mintCap(ACTOR_A, "owner", ["write_draft", "ls", "read"]);

  await createCodeSessionFromBody({
    ...baseSessionBody(),
    workspace_capability: cap
  }, env);

  const buildOnly = await createEnvironmentManifestFromBody({
    ...baseManifestBody({
      environment_manifest_id: "envmanifest:v777e-build-only",
      sandbox_execution_class: "local_build_test"
    }),
    workspace_capability: cap
  }, env);
  assert.equal(buildOnly.ok, true);

  const attachedBuild = await attachEnvironmentManifestToSessionFromBody({
    code_session_id: CS_ID,
    environment_manifest_id: buildOnly.environment_manifest_id,
    actor_id: ACTOR_A,
    base_revision: 1,
    workspace_capability: cap
  }, env);
  assert.equal(attachedBuild.ok, true);

  const denied = await createExecutionReceiptFromBody({
    code_session_id: CS_ID,
    actor_id: ACTOR_A,
    workspace_capability: cap,
    command_class: "install",
    command_summary: "npm install",
    status: "pass",
    exit_code: 0
  }, env);
  assert.equal(denied.ok, false);
  assert.equal(denied.error, "command_class_not_allowed_for_sandbox_execution_class");
  assert.equal(denied.sandbox_execution_class, "local_build_test");

  const installOk = await createEnvironmentManifestFromBody({
    ...baseManifestBody({
      environment_manifest_id: "envmanifest:v777e-install-ok",
      sandbox_execution_class: "local_install_build_test",
      install_commands: ["npm install"]
    }),
    workspace_capability: cap
  }, env);
  assert.equal(installOk.ok, true);

  const attachedInstall = await attachEnvironmentManifestToSessionFromBody({
    code_session_id: CS_ID,
    environment_manifest_id: installOk.environment_manifest_id,
    actor_id: ACTOR_A,
    base_revision: 2,
    workspace_capability: cap
  }, env);
  assert.equal(attachedInstall.ok, true);

  const receipt = await createExecutionReceiptFromBody({
    code_session_id: CS_ID,
    actor_id: ACTOR_A,
    workspace_capability: cap,
    command_class: "install",
    command_summary: "npm install",
    status: "pass",
    exit_code: 0,
    duration_ms: 1200
  }, env);
  assert.equal(receipt.ok, true);
  assert.ok(receipt.receipt_id.startsWith("execrcpt:"));
  assert.equal(receipt.command_class, "install");
  assert.equal(receipt.production_mutation, false);
  assert.equal(receipt.accepted_state_authority, false);
  assert.ok(Array.isArray(receipt.latest_execution_receipt_refs));
  assert.equal(receipt.latest_execution_receipt_refs[0].ref, receipt.receipt_id);
  assert.equal(receipt.latest_execution_receipt_refs[0].kind, "install");
});

test("execution receipt rejects secret-bearing payload keys", async () => {
  const db = new FakeEnvironmentSandboxD1();
  const { env } = await seedWorkspace(db, new FakeR2());
  const cap = await mintCap(ACTOR_A, "owner", ["write_draft", "ls", "read"]);

  await createCodeSessionFromBody({
    ...baseSessionBody(),
    workspace_capability: cap
  }, env);

  const manifest = await createEnvironmentManifestFromBody({
    ...baseManifestBody({
      environment_manifest_id: "envmanifest:v777e-secret-reject",
      sandbox_execution_class: "local_build_test"
    }),
    workspace_capability: cap
  }, env);
  await attachEnvironmentManifestToSessionFromBody({
    code_session_id: CS_ID,
    environment_manifest_id: manifest.environment_manifest_id,
    actor_id: ACTOR_A,
    base_revision: 1,
    workspace_capability: cap
  }, env);

  const secretReceipt = await createExecutionReceiptFromBody({
    code_session_id: CS_ID,
    actor_id: ACTOR_A,
    workspace_capability: cap,
    command_class: "test",
    command_summary: "npm test",
    status: "pass",
    detail: { api_key: "should-never-persist" }
  }, env);
  assert.equal(secretReceipt.ok, false);
  assert.equal(secretReceipt.error, "secrets_not_absent");
});

test("compileCodeSessionContextFromBody includes environment_sandbox closed authority", async () => {
  const db = new FakeEnvironmentSandboxD1();
  const { env } = await seedWorkspace(db, new FakeR2());
  const cap = await mintCap(ACTOR_A, "owner", ["write_draft", "ls", "read"]);

  await createCodeSessionFromBody({
    ...baseSessionBody(),
    workspace_capability: cap
  }, env);

  const manifest = await createEnvironmentManifestFromBody({
    ...baseManifestBody({
      environment_manifest_id: "envmanifest:v777e-compile",
      sandbox_execution_class: "local_install_build_test"
    }),
    workspace_capability: cap
  }, env);
  await attachEnvironmentManifestToSessionFromBody({
    code_session_id: CS_ID,
    environment_manifest_id: manifest.environment_manifest_id,
    actor_id: ACTOR_A,
    base_revision: 1,
    workspace_capability: cap
  }, env);
  await attachSandboxFromBody({
    code_session_id: CS_ID,
    actor_id: ACTOR_A,
    workspace_capability: cap,
    status: "ready"
  }, env);

  const context = await compileCodeSessionContextFromBody({
    code_session_id: CS_ID,
    actor_id: ACTOR_A,
    workspace_capability: await mintCap(ACTOR_A, "owner", ["read", "ls"])
  }, env);
  assert.equal(context.ok, true);
  assert.ok(context.environment_sandbox);
  assert.equal(context.environment_sandbox.secrets_absent, true);
  assert.equal(context.environment_sandbox.sandbox_local_execution_only, true);
  assert.equal(context.environment_sandbox.accepted_state_authority, false);
  assert.equal(context.environment_sandbox.production_mutation_authority, false);
  assert.equal(
    context.environment_sandbox.environment_manifest.environment_manifest_id,
    "envmanifest:v777e-compile"
  );
  assert.ok(context.environment_sandbox.sandbox_attachment);
  assert.equal(context.accepted_state_authority, false);
});

test("broker: ENVIRONMENT_SANDBOX tools are scoped_grant; none automatic-read; MCP defs present", () => {
  const registry = toolRegistryFromBody({}, {}, { registry: DEFAULT_TOOL_BROKER_REGISTRY });
  assert.equal(registry.ok, true);
  assert.equal(registry.total, 68);

  for (const toolId of ENVIRONMENT_SANDBOX_MUTATION_TOOL_IDS) {
    const entry = registry.tools.find(item => item.tool_id === toolId);
    assert.ok(entry, toolId);
    assert.equal(entry.risk_class, "mutation");
    assert.equal(entry.authorization, "scoped_grant");
  }
  for (const toolId of ENVIRONMENT_SANDBOX_READ_TOOL_IDS) {
    const entry = registry.tools.find(item => item.tool_id === toolId);
    assert.ok(entry, toolId);
    assert.equal(entry.risk_class, "read");
    assert.equal(entry.authorization, "scoped_grant");
  }

  const automatic = listAutomaticReadToolIds(DEFAULT_TOOL_BROKER_REGISTRY);
  for (const toolId of Object.values(ENVIRONMENT_SANDBOX_BROKER_TOOL_IDS)) {
    assert.ok(!automatic.includes(toolId), `${toolId} must not be automatic-read`);
  }

  const names = mcpToolsForProfile(false).map(tool => tool.name);
  for (const def of ENVIRONMENT_SANDBOX_MCP_TOOL_DEFINITIONS) {
    assert.ok(names.includes(def.name), `${def.name} must be in MCP catalog`);
  }
});

test("no chain_heads/path_heads mutation across environment-sandbox happy path", async () => {
  const db = new FakeEnvironmentSandboxD1();
  const { env } = await seedWorkspace(db, new FakeR2());
  db.chainHeads.set("cairnstone-v6", "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
  db.pathHeads.set("docs/PROTOCOL.md", "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb");
  const beforeChain = new Map(db.chainHeads);
  const beforePath = new Map(db.pathHeads);

  const cap = await mintCap(ACTOR_A, "owner", ["write_draft", "ls", "read"]);
  await createCodeSessionFromBody({
    ...baseSessionBody(),
    workspace_capability: cap
  }, env);

  const manifest = await createEnvironmentManifestFromBody({
    ...baseManifestBody({
      environment_manifest_id: "envmanifest:v777e-heads",
      sandbox_execution_class: "local_install_build_test"
    }),
    workspace_capability: cap
  }, env);
  await attachEnvironmentManifestToSessionFromBody({
    code_session_id: CS_ID,
    environment_manifest_id: manifest.environment_manifest_id,
    actor_id: ACTOR_A,
    base_revision: 1,
    workspace_capability: cap
  }, env);
  const sandbox = await attachSandboxFromBody({
    code_session_id: CS_ID,
    actor_id: ACTOR_A,
    workspace_capability: cap,
    status: "ready"
  }, env);
  await createExecutionReceiptFromBody({
    code_session_id: CS_ID,
    actor_id: ACTOR_A,
    workspace_capability: cap,
    command_class: "test",
    command_summary: "npm test",
    status: "pass",
    exit_code: 0
  }, env);
  await detachSandboxFromBody({
    attachment_id: sandbox.attachment_id,
    actor_id: ACTOR_A,
    workspace_capability: cap
  }, env);
  await compileCodeSessionContextFromBody({
    code_session_id: CS_ID,
    actor_id: ACTOR_A,
    workspace_capability: await mintCap(ACTOR_A, "owner", ["read", "ls"])
  }, env);

  assert.deepEqual([...db.chainHeads.entries()], [...beforeChain.entries()]);
  assert.deepEqual([...db.pathHeads.entries()], [...beforePath.entries()]);
  assert.equal(db.headMutationAttempts.length, 0);
});
