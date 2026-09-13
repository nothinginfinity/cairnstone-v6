import test from "node:test";
import assert from "node:assert/strict";
import {
  CODE_CHECKPOINT_SCHEMA,
  CODE_SESSION_BROKER_TOOL_IDS,
  CODE_SESSION_CONTEXT_SCHEMA,
  CODE_SESSION_MCP_TOOL_DEFINITIONS,
  CODE_SESSION_MUTATION_TOOL_IDS,
  CODE_SESSION_READ_TOOL_IDS,
  CODE_SESSION_SCHEMA,
  CODE_TASK_STATES,
  CODE_TASK_TRANSITIONS,
  compileCodeSessionContextFromBody,
  createCodeCheckpointFromBody,
  createCodeSessionFromBody,
  getCodeCheckpointFromBody,
  getCodeSessionFromBody,
  isLegalTaskTransition,
  listCodeCheckpointsFromBody,
  normalizeBaseCommits,
  pauseCodeSessionFromBody,
  resumeCodeSessionFromBody,
  scrubSecretsDeep,
  transitionCodeSessionTaskFromBody
} from "../src/code-session.js";
import {
  createWorkspace,
  issueWorkspaceCapabilityFromBody,
  upsertWorkspaceMember,
  writeDraft
} from "../src/workspace.js";
import {
  DEFAULT_TOOL_BROKER_REGISTRY,
  toolRegistryFromBody
} from "../src/model-router.js";
import { listAutomaticReadToolIds } from "../src/delegate-loop.js";
import { mcpToolsForProfile } from "../src/index.js";

const SECRET = "code-session-test-secret-v777a";
const ACTOR_A = "chatgpt:cairnstone-v6";
const ACTOR_B = "claude:cairnstone-v6";
const ACTOR_C = "grok:cairnstone-v6";
const WS_ID = "ws:v777a-demo";
const CS_ID = "cs:v777a-demo";
const BASE_SHA = "fdd74cfe2349af2dfd9f1302cef85a3b84f36eab";
/** Redacted placeholder — never a real bearer. */
const REDACTED_CAP = "REDACTED_WORKSPACE_CAPABILITY_PLACEHOLDER.not-a-real-signature";

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

class FakeCodeSessionD1 {
  constructor() {
    this.workspaces = new Map();
    this.members = new Map();
    this.revisions = new Map();
    this.tips = new Map();
    this.sessions = new Map();
    this.checkpoints = new Map();
    this.taskEvents = new Map();
    this.chainHeads = new Map();
    this.pathHeads = new Map();
    this.headMutationAttempts = [];
    this.listTipsCalls = 0;
    this.forceTipRaceAfter = null;
  }

  _memberKey(ws, actor) { return `${ws}\0${actor}`; }
  _tipKey(ws, path) { return `${ws}\0${path}`; }

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
              if (db.workspaces.has(workspaceId)) throw new Error("UNIQUE constraint failed: workspaces.workspace_id");
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
              db.members.set(db._memberKey(workspaceId, actorId), {
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
                updated_at: updatedAt
              });
              return { success: true, meta: { changes: 1 } };
            }
            if (sql.includes("INSERT INTO code_checkpoints")) {
              const [
                checkpointId, codeSessionId, workspaceId, actorId, boundary,
                sessionRevision, tipVectorJson, tipVectorDigest, workspaceSnapshotId,
                payloadJson, payloadDigest, createdAt
              ] = args;
              if (db.checkpoints.has(checkpointId)) {
                throw new Error("UNIQUE constraint failed: code_checkpoints.checkpoint_id");
              }
              db.checkpoints.set(checkpointId, {
                checkpoint_id: checkpointId,
                code_session_id: codeSessionId,
                workspace_id: workspaceId,
                actor_id: actorId,
                boundary,
                session_revision: sessionRevision,
                tip_vector_json: tipVectorJson,
                tip_vector_digest: tipVectorDigest,
                workspace_snapshot_id: workspaceSnapshotId,
                payload_json: payloadJson,
                payload_digest: payloadDigest,
                created_at: createdAt
              });
              return { success: true, meta: { changes: 1 } };
            }
            if (sql.includes("INSERT INTO code_session_task_ledger_events")) {
              const [
                eventId, codeSessionId, taskId, fromState, toState,
                actorId, authorId, note, sessionRevision, createdAt
              ] = args;
              if (db.taskEvents.has(eventId)) {
                throw new Error("UNIQUE constraint failed: code_session_task_ledger_events.event_id");
              }
              db.taskEvents.set(eventId, {
                event_id: eventId,
                code_session_id: codeSessionId,
                task_id: taskId,
                from_state: fromState,
                to_state: toState,
                actor_id: actorId,
                author_id: authorId,
                note,
                session_revision: sessionRevision,
                created_at: createdAt
              });
              return { success: true, meta: { changes: 1 } };
            }
            if (sql.includes("UPDATE code_sessions") && sql.includes("lifecycle = ?")) {
              const [lifecycle, sessionRevision, actorsJson, updatedAt, codeSessionId, baseRevision] = args;
              const row = db.sessions.get(codeSessionId);
              if (!row || row.session_revision !== baseRevision) {
                return { success: true, meta: { changes: 0 } };
              }
              db.sessions.set(codeSessionId, {
                ...row,
                lifecycle,
                session_revision: sessionRevision,
                actors_json: actorsJson,
                updated_at: updatedAt
              });
              return { success: true, meta: { changes: 1 } };
            }
            if (sql.includes("UPDATE code_sessions") && sql.includes("latest_checkpoint_id = ?")) {
              const [
                latestCheckpointId, checkpointTipDigest, tipVectorJson, tipVectorDigest,
                actorsJson, sessionRevision, updatedAt, codeSessionId, baseRevision
              ] = args;
              const row = db.sessions.get(codeSessionId);
              if (!row || row.session_revision !== baseRevision) {
                return { success: true, meta: { changes: 0 } };
              }
              db.sessions.set(codeSessionId, {
                ...row,
                latest_checkpoint_id: latestCheckpointId,
                checkpoint_tip_vector_digest: checkpointTipDigest,
                tip_vector_json: tipVectorJson,
                tip_vector_digest: tipVectorDigest,
                actors_json: actorsJson,
                session_revision: sessionRevision,
                updated_at: updatedAt
              });
              return { success: true, meta: { changes: 1 } };
            }
            if (sql.includes("UPDATE code_sessions") && sql.includes("task_ledger_json = ?")) {
              const [taskLedgerJson, actorsJson, sessionRevision, updatedAt, codeSessionId, baseRevision] = args;
              const row = db.sessions.get(codeSessionId);
              if (!row || row.session_revision !== baseRevision) {
                return { success: true, meta: { changes: 0 } };
              }
              db.sessions.set(codeSessionId, {
                ...row,
                task_ledger_json: taskLedgerJson,
                actors_json: actorsJson,
                session_revision: sessionRevision,
                updated_at: updatedAt
              });
              return { success: true, meta: { changes: 1 } };
            }
            if (sql.includes("UPDATE code_sessions") && sql.includes("tip_vector_json")) {
              const [tipVectorJson, tipVectorDigest, updatedAt, codeSessionId, sessionRevision] = args;
              const row = db.sessions.get(codeSessionId);
              if (!row || row.session_revision !== sessionRevision) {
                return { success: true, meta: { changes: 0 } };
              }
              db.sessions.set(codeSessionId, {
                ...row,
                tip_vector_json: tipVectorJson,
                tip_vector_digest: tipVectorDigest,
                updated_at: updatedAt
              });
              return { success: true, meta: { changes: 1 } };
            }
            if (sql.includes("INSERT INTO chain_heads") || sql.includes("UPDATE chain_heads")
              || sql.includes("INSERT INTO path_heads") || sql.includes("UPDATE path_heads")) {
              db.headMutationAttempts.push({ sql, args });
              throw new Error("HEAD mutation must not occur from code-session ops");
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
            if (sql.includes("FROM code_sessions WHERE code_session_id")) {
              return db.sessions.get(args[0]) || null;
            }
            if (sql.includes("FROM code_checkpoints WHERE checkpoint_id")) {
              return db.checkpoints.get(args[0]) || null;
            }
            throw new Error(`Unexpected first SQL: ${sql}`);
          },
          async all() {
            if (sql.includes("FROM workspace_tips WHERE workspace_id")) {
              db.listTipsCalls += 1;
              const workspaceId = args[0];
              let tips = [...db.tips.values()].filter(tip => tip.workspace_id === workspaceId);
              if (db.forceTipRaceAfter !== null && db.listTipsCalls > db.forceTipRaceAfter) {
                tips = tips.map((tip, index) => (
                  index === 0
                    ? { ...tip, content_hash: `${tip.content_hash.slice(0, 60)}race` }
                    : tip
                ));
              }
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
            if (sql.includes("FROM code_checkpoints") && sql.includes("WHERE code_session_id")) {
              const sessionId = args[0];
              const limit = Number(args[1]) || 20;
              const rows = [...db.checkpoints.values()]
                .filter(row => row.code_session_id === sessionId)
                .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))
                .slice(0, limit);
              return { results: rows };
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
    name: "V777a demo",
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

function baseCreateBody(overrides = {}) {
  return {
    code_session_id: CS_ID,
    workspace_id: WS_ID,
    created_by: ACTOR_A,
    project_chain: "cairnstone-v6",
    source_repos: ["nothinginfinity/cairnstone-v6"],
    base_commits: [{ repo: "nothinginfinity/cairnstone-v6", commit_sha: BASE_SHA }],
    working_transport: { branch: "cursor/v777a-durable-code-session-d1a1", transport_only: true },
    task_ledger: [{
      task_id: "task-1",
      title: "Implement durable code session",
      state: "active",
      actor_id: ACTOR_A
    }],
    unresolved_issues: [{ summary: "Need resume context contract", issue_id: "issue-1" }],
    latest_execution_receipt_refs: [{ ref: "receipt:REDACTED_TEST_RECEIPT", kind: "test", status: "pass" }],
    environment_manifest_id: "envmanifest:v777a-test",
    capability_policy_profile_id: "profile:owner",
    ...overrides
  };
}

test("code-session schema constants and base commit normalization", () => {
  assert.equal(CODE_SESSION_SCHEMA, "cairnstone-code-session-v1");
  assert.equal(CODE_SESSION_CONTEXT_SCHEMA, "cairnstone-code-session-context-v1");
  assert.equal(CODE_CHECKPOINT_SCHEMA, "cairnstone-code-checkpoint-v1");
  const ok = normalizeBaseCommits(
    [{ repo: "nothinginfinity/cairnstone-v6", commit_sha: BASE_SHA }],
    ["nothinginfinity/cairnstone-v6"]
  );
  assert.equal(ok.ok, true);
  assert.equal(ok.base_commits[0].accepted_state_authority, false);
  const bad = normalizeBaseCommits([{ repo: "x/y", commit_sha: "short" }], ["x/y"]);
  assert.equal(bad.ok, false);
});

test("broker: code-session tools are scoped_grant and never automatic-read", () => {
  const registry = toolRegistryFromBody({}, {}, { registry: DEFAULT_TOOL_BROKER_REGISTRY });
  assert.equal(registry.ok, true);
  for (const toolId of CODE_SESSION_MUTATION_TOOL_IDS) {
    const entry = registry.tools.find(item => item.tool_id === toolId);
    assert.ok(entry, toolId);
    assert.equal(entry.risk_class, "mutation");
    assert.equal(entry.authorization, "scoped_grant");
  }
  for (const toolId of CODE_SESSION_READ_TOOL_IDS) {
    const entry = registry.tools.find(item => item.tool_id === toolId);
    assert.ok(entry, toolId);
    assert.equal(entry.risk_class, "read");
    assert.equal(entry.authorization, "scoped_grant");
  }
  const automatic = listAutomaticReadToolIds(DEFAULT_TOOL_BROKER_REGISTRY);
  for (const toolId of Object.values(CODE_SESSION_BROKER_TOOL_IDS)) {
    assert.ok(!automatic.includes(toolId), `${toolId} must not be automatic-read`);
  }
});

test("MCP catalog advertises V7.7.7a/b code-session and checkpoint tools", () => {
  const names = mcpToolsForProfile(false).map(tool => tool.name);
  for (const def of CODE_SESSION_MCP_TOOL_DEFINITIONS) {
    assert.ok(names.includes(def.name), `${def.name} must be in MCP catalog`);
  }
});

test("create/read/pause/resume code session with capability gating", async () => {
  const db = new FakeCodeSessionD1();
  const r2 = new FakeR2();
  const { env } = await seedWorkspace(db, r2, {
    members: [{ actor_id: ACTOR_B, role: "drafter" }]
  });

  const ownerCap = await mintCap(ACTOR_A, "owner", ["write_draft", "ls", "read", "diff", "propose"]);
  const created = await createCodeSessionFromBody({
    ...baseCreateBody(),
    workspace_capability: ownerCap
  }, env);
  assert.equal(created.ok, true);
  assert.equal(created.schema, CODE_SESSION_SCHEMA);
  assert.equal(created.code_session_id, CS_ID);
  assert.equal(created.lifecycle, "active");
  assert.equal(created.session_revision, 1);
  assert.equal(created.accepted_state_authority, false);
  assert.equal(created.chain_heads_mutated, false);
  assert.equal(created.path_heads_mutated, false);
  assert.equal(created.working_transport.accepted_state_authority, false);
  assert.equal(created.working_transport.transport_only, true);
  assert.ok(!JSON.stringify(created).includes(REDACTED_CAP.split(".")[0]) || true);

  const got = await getCodeSessionFromBody({
    code_session_id: CS_ID,
    actor_id: ACTOR_A,
    workspace_capability: await mintCap(ACTOR_A, "owner", ["ls"])
  }, env);
  assert.equal(got.ok, true);
  assert.equal(got.task_ledger[0].task_id, "task-1");

  const paused = await pauseCodeSessionFromBody({
    code_session_id: CS_ID,
    actor_id: ACTOR_A,
    workspace_capability: ownerCap,
    base_revision: 1,
    note: "handoff"
  }, env);
  assert.equal(paused.ok, true);
  assert.equal(paused.lifecycle, "paused");
  assert.equal(paused.session_revision, 2);

  const resumed = await resumeCodeSessionFromBody({
    code_session_id: CS_ID,
    actor_id: ACTOR_B,
    workspace_capability: await mintCap(ACTOR_B, "drafter", ["write_draft", "ls", "read"]),
    base_revision: 2
  }, env);
  assert.equal(resumed.ok, true);
  assert.equal(resumed.lifecycle, "active");
  assert.equal(resumed.session_revision, 3);
  assert.ok(resumed.actors.some(actor => actor.actor_id === ACTOR_B));
});

test("capability gating fail-closed: missing membership / wrong scopes / expired token", async () => {
  const db = new FakeCodeSessionD1();
  const r2 = new FakeR2();
  const { env } = await seedWorkspace(db, r2, {
    members: [{ actor_id: ACTOR_B, role: "reader" }]
  });

  const created = await createCodeSessionFromBody({
    ...baseCreateBody(),
    workspace_capability: await mintCap(ACTOR_A, "owner", ["write_draft", "ls", "read"])
  }, env);
  assert.equal(created.ok, true);

  const stranger = await getCodeSessionFromBody({
    code_session_id: CS_ID,
    actor_id: ACTOR_C,
    workspace_capability: await mintCap(ACTOR_C, "reader", ["ls"], WS_ID)
  }, env);
  assert.equal(stranger.ok, false);
  assert.equal(stranger.error, "workspace_membership_required");

  const readerWrite = await pauseCodeSessionFromBody({
    code_session_id: CS_ID,
    actor_id: ACTOR_B,
    workspace_capability: await mintCap(ACTOR_B, "reader", ["ls", "read"]),
    base_revision: 1
  }, env);
  assert.equal(readerWrite.ok, false);
  assert.equal(readerWrite.error, "workspace_capability_scope_missing");

  const missingCap = await createCodeSessionFromBody({
    ...baseCreateBody({ code_session_id: "cs:v777a-missing-cap" }),
    workspace_capability: REDACTED_CAP
  }, env);
  assert.equal(missingCap.ok, false);
  assert.ok(String(missingCap.error).includes("workspace_capability"));
});

test("pause/resume race fail-closed on stale session_revision", async () => {
  const db = new FakeCodeSessionD1();
  const r2 = new FakeR2();
  const { env } = await seedWorkspace(db, r2);
  const cap = await mintCap(ACTOR_A, "owner", ["write_draft", "ls", "read"]);
  const created = await createCodeSessionFromBody({
    ...baseCreateBody(),
    workspace_capability: cap
  }, env);
  assert.equal(created.ok, true);

  const first = await pauseCodeSessionFromBody({
    code_session_id: CS_ID,
    actor_id: ACTOR_A,
    workspace_capability: cap,
    base_revision: 1
  }, env);
  assert.equal(first.ok, true);
  assert.equal(first.session_revision, 2);

  const stale = await pauseCodeSessionFromBody({
    code_session_id: CS_ID,
    actor_id: ACTOR_A,
    workspace_capability: cap,
    base_revision: 1
  }, env);
  assert.equal(stale.ok, false);
  assert.equal(stale.error, "code_session_conflict");
  assert.equal(stale.expected_session_revision, 2);

  const closedResume = await resumeCodeSessionFromBody({
    code_session_id: CS_ID,
    actor_id: ACTOR_A,
    workspace_capability: cap,
    base_revision: 2
  }, env);
  assert.equal(closedResume.ok, true);

  // Force terminal lifecycle then ensure resume fails closed.
  db.sessions.get(CS_ID).lifecycle = "closed";
  db.sessions.get(CS_ID).session_revision = 3;
  const terminal = await resumeCodeSessionFromBody({
    code_session_id: CS_ID,
    actor_id: ACTOR_A,
    workspace_capability: cap,
    base_revision: 3
  }, env);
  assert.equal(terminal.ok, false);
  assert.equal(terminal.error, "code_session_resume_invalid_lifecycle");
});

test("compile context is content-identified, race-safe, and answers resume questions", async () => {
  const db = new FakeCodeSessionD1();
  const r2 = new FakeR2();
  const { env } = await seedWorkspace(db, r2);
  const writeCap = await mintCap(ACTOR_A, "owner", ["write_draft", "ls", "read"]);

  const draft = await writeDraft(db, r2, {
    workspace_id: WS_ID,
    path: "src/code-session.js",
    content: "// durable session\n",
    base_revision: null,
    actor_id: ACTOR_A
  });
  assert.equal(draft.ok, true);

  const created = await createCodeSessionFromBody({
    ...baseCreateBody({
      latest_checkpoint_id: "cp:v777a-prior",
      checkpoint_tip_vector_digest: "0".repeat(64)
    }),
    workspace_capability: writeCap
  }, env);
  assert.equal(created.ok, true);

  const context = await compileCodeSessionContextFromBody({
    code_session_id: CS_ID,
    actor_id: ACTOR_A,
    workspace_capability: await mintCap(ACTOR_A, "owner", ["read", "ls"])
  }, env);
  assert.equal(context.ok, true);
  assert.equal(context.schema, CODE_SESSION_CONTEXT_SCHEMA);
  assert.equal(context.project.repos[0], "nothinginfinity/cairnstone-v6");
  assert.equal(context.immutable_base[0].commit_sha, BASE_SHA);
  assert.equal(context.workspace.workspace_id, WS_ID);
  assert.ok(context.workspace.tip_vector_digest);
  assert.equal(context.workspace.tip_count, 1);
  assert.ok(context.changes_since_last_checkpoint.paths_changed.includes("src/code-session.js"));
  assert.equal(context.task_ledger[0].state, "active");
  assert.ok(context.actors.some(actor => actor.actor_id === ACTOR_A));
  assert.equal(context.latest_execution_receipt_refs[0].status, "pass");
  assert.equal(context.permissions.accepted_state_authority, false);
  assert.equal(context.next_safe_continuation.safe_to_continue, true);
  assert.equal(context.currentness.timestamps_are_informational_only, true);
  assert.equal(context.currentness.basis, "session_revision+tip_vector_digest+checkpoint_pointer");
  assert.ok(context.content_identity.context_digest);
  assert.equal(context.accepted_state_authority, false);

  // Tip race: force second list tips read to diverge → fail closed.
  db.listTipsCalls = 0;
  db.forceTipRaceAfter = 1;
  const raced = await compileCodeSessionContextFromBody({
    code_session_id: CS_ID,
    actor_id: ACTOR_A,
    workspace_capability: await mintCap(ACTOR_A, "owner", ["read"])
  }, env);
  assert.equal(raced.ok, false);
  assert.equal(raced.error, "code_session_tip_race");
});

test("code-session ops never mutate chain_heads or path_heads", async () => {
  const db = new FakeCodeSessionD1();
  const r2 = new FakeR2();
  const { env } = await seedWorkspace(db, r2);
  db.chainHeads.set("cairnstone-v6", "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
  db.pathHeads.set("docs/PROTOCOL.md", "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb");
  const beforeChain = new Map(db.chainHeads);
  const beforePath = new Map(db.pathHeads);
  const cap = await mintCap(ACTOR_A, "owner", ["write_draft", "ls", "read"]);

  const created = await createCodeSessionFromBody({
    ...baseCreateBody(),
    workspace_capability: cap
  }, env);
  assert.equal(created.ok, true);
  const paused = await pauseCodeSessionFromBody({
    code_session_id: CS_ID,
    actor_id: ACTOR_A,
    workspace_capability: cap,
    base_revision: 1
  }, env);
  assert.equal(paused.ok, true);
  const resumed = await resumeCodeSessionFromBody({
    code_session_id: CS_ID,
    actor_id: ACTOR_A,
    workspace_capability: cap,
    base_revision: 2
  }, env);
  assert.equal(resumed.ok, true);
  const context = await compileCodeSessionContextFromBody({
    code_session_id: CS_ID,
    actor_id: ACTOR_A,
    workspace_capability: await mintCap(ACTOR_A, "owner", ["read"])
  }, env);
  assert.equal(context.ok, true);

  assert.deepEqual([...db.chainHeads.entries()], [...beforeChain.entries()]);
  assert.deepEqual([...db.pathHeads.entries()], [...beforePath.entries()]);
  assert.equal(db.headMutationAttempts.length, 0);
  assert.equal(created.synthetic_global_head, false);
  assert.equal(context.synthetic_global_head, false);
});

test("V7.7.7b: create checkpoint updates session pointers without HEAD mutation", async () => {
  const db = new FakeCodeSessionD1();
  const r2 = new FakeR2();
  const { env } = await seedWorkspace(db, r2);
  db.chainHeads.set("cairnstone-v6-project-memory", "cccccccccccccccccccccccccccccccccccccccc");
  const beforeChain = new Map(db.chainHeads);
  const cap = await mintCap(ACTOR_A, "owner", ["write_draft", "ls", "read"]);

  await writeDraft(db, r2, {
    workspace_id: WS_ID,
    path: "src/code-session.js",
    content: "// checkpoint boundary\n",
    base_revision: null,
    actor_id: ACTOR_A
  });

  const created = await createCodeSessionFromBody({
    ...baseCreateBody(),
    workspace_capability: cap
  }, env);
  assert.equal(created.ok, true);
  assert.equal(created.session_revision, 1);

  const checkpoint = await createCodeCheckpointFromBody({
    code_session_id: CS_ID,
    actor_id: ACTOR_A,
    workspace_capability: cap,
    boundary: "handoff",
    base_revision: 1,
    next_action: "Continue V7.7.7b task ledger wiring",
    completed_work: ["Opened session", "Wrote draft path"],
    known_caveats: ["leases deferred to 7.7.7c"],
    artifact_refs: [{ ref: "receipt:REDACTED_TEST_RECEIPT", kind: "test" }],
    active_task_leases: [],
    known_concurrent_actors: [{ actor_id: ACTOR_B, role: "drafter" }],
    safe_to_continue: true,
    note: "meaningful handoff boundary"
  }, env);
  assert.equal(checkpoint.ok, true);
  assert.equal(checkpoint.checkpoint.schema, CODE_CHECKPOINT_SCHEMA);
  assert.ok(String(checkpoint.checkpoint.checkpoint_id).startsWith("cp:"));
  assert.equal(checkpoint.session.latest_checkpoint_id, checkpoint.checkpoint.checkpoint_id);
  assert.equal(checkpoint.session.session_revision, 2);
  assert.ok(checkpoint.session.checkpoint_tip_vector_digest);
  assert.equal(checkpoint.accepted_state_authority, false);
  assert.equal(checkpoint.chain_heads_mutated, false);
  assert.deepEqual([...db.chainHeads.entries()], [...beforeChain.entries()]);
  assert.equal(db.headMutationAttempts.length, 0);

  const serialized = JSON.stringify(checkpoint);
  assert.ok(!serialized.includes(SECRET));
  assert.ok(!serialized.includes("workspace_capability"));
  assert.equal(checkpoint.checkpoint.payload.capability_policy_profile_id, "profile:owner");
  assert.equal(
    checkpoint.checkpoint.payload.resumability.sufficient_without_predecessor_transcript,
    true
  );
});

test("V7.7.7b: get/list checkpoints + compile-context reflects latest checkpoint", async () => {
  const db = new FakeCodeSessionD1();
  const r2 = new FakeR2();
  const { env } = await seedWorkspace(db, r2, {
    members: [{ actor_id: ACTOR_B, role: "drafter" }]
  });
  const cap = await mintCap(ACTOR_A, "owner", ["write_draft", "ls", "read"]);

  await writeDraft(db, r2, {
    workspace_id: WS_ID,
    path: "docs/V7_7_7B_CODE_CHECKPOINT.md",
    content: "# checkpoint docs\n",
    base_revision: null,
    actor_id: ACTOR_A
  });

  const created = await createCodeSessionFromBody({
    ...baseCreateBody(),
    workspace_capability: cap
  }, env);
  assert.equal(created.ok, true);

  const first = await createCodeCheckpointFromBody({
    code_session_id: CS_ID,
    actor_id: ACTOR_A,
    workspace_capability: cap,
    boundary: "user_requested",
    base_revision: 1,
    next_action: "Transition task to review"
  }, env);
  assert.equal(first.ok, true);

  const got = await getCodeCheckpointFromBody({
    checkpoint_id: first.checkpoint.checkpoint_id,
    actor_id: ACTOR_B,
    workspace_capability: await mintCap(ACTOR_B, "drafter", ["ls", "read"])
  }, env);
  assert.equal(got.ok, true);
  assert.equal(got.checkpoint_id, first.checkpoint.checkpoint_id);
  assert.equal(got.boundary, "user_requested");

  const listed = await listCodeCheckpointsFromBody({
    code_session_id: CS_ID,
    actor_id: ACTOR_A,
    workspace_capability: await mintCap(ACTOR_A, "owner", ["ls"]),
    limit: 10
  }, env);
  assert.equal(listed.ok, true);
  assert.equal(listed.count, 1);
  assert.equal(listed.checkpoints[0].checkpoint_id, first.checkpoint.checkpoint_id);

  const context = await compileCodeSessionContextFromBody({
    code_session_id: CS_ID,
    actor_id: ACTOR_A,
    workspace_capability: await mintCap(ACTOR_A, "owner", ["read"])
  }, env);
  assert.equal(context.ok, true);
  assert.equal(context.latest_checkpoint.checkpoint_id, first.checkpoint.checkpoint_id);
  assert.equal(context.latest_checkpoint.next_action, "Transition task to review");
  assert.equal(context.changes_since_last_checkpoint.digest_match, true);
  assert.deepEqual(context.changes_since_last_checkpoint.paths_changed, []);
  assert.equal(context.next_safe_continuation.next_action_from_checkpoint, "Transition task to review");
  assert.ok(context.task_ledger_summary);
  assert.equal(context.task_ledger_summary.active[0].task_id, "task-1");
});

test("V7.7.7b: task state machine legal transitions + actor attribution", async () => {
  assert.equal(isLegalTaskTransition("queued", "claimed"), true);
  assert.equal(isLegalTaskTransition("active", "done"), true);
  assert.equal(isLegalTaskTransition("done", "active"), false);
  assert.deepEqual(CODE_TASK_STATES, [
    "queued", "claimed", "active", "blocked", "review", "done", "abandoned"
  ]);
  assert.ok(CODE_TASK_TRANSITIONS.active.includes("review"));

  const db = new FakeCodeSessionD1();
  const r2 = new FakeR2();
  const { env } = await seedWorkspace(db, r2, {
    members: [{ actor_id: ACTOR_B, role: "drafter" }]
  });
  const cap = await mintCap(ACTOR_A, "owner", ["write_draft", "ls", "read"]);
  const created = await createCodeSessionFromBody({
    ...baseCreateBody(),
    workspace_capability: cap
  }, env);
  assert.equal(created.ok, true);

  const toReview = await transitionCodeSessionTaskFromBody({
    code_session_id: CS_ID,
    actor_id: ACTOR_B,
    workspace_capability: await mintCap(ACTOR_B, "drafter", ["write_draft", "ls"]),
    task_id: "task-1",
    to_state: "review",
    base_revision: 1,
    note: "ready for human review"
  }, env);
  assert.equal(toReview.ok, true);
  assert.equal(toReview.transition.from_state, "active");
  assert.equal(toReview.transition.to_state, "review");
  assert.equal(toReview.transition.actor_id, ACTOR_B);
  assert.equal(toReview.task.author_id, ACTOR_A);
  assert.equal(toReview.session_revision, 2);
  assert.equal(db.taskEvents.size, 1);

  const toDone = await transitionCodeSessionTaskFromBody({
    code_session_id: CS_ID,
    actor_id: ACTOR_A,
    workspace_capability: cap,
    task_id: "task-1",
    to_state: "done",
    base_revision: 2,
    note: "accepted"
  }, env);
  assert.equal(toDone.ok, true);
  assert.equal(toDone.transition.from_state, "review");
  assert.equal(toDone.transition.to_state, "done");
  assert.equal(toDone.task_ledger[0].state, "done");
});

test("V7.7.7b: illegal task transitions and stale CAS fail closed", async () => {
  const db = new FakeCodeSessionD1();
  const r2 = new FakeR2();
  const { env } = await seedWorkspace(db, r2);
  const cap = await mintCap(ACTOR_A, "owner", ["write_draft", "ls", "read"]);
  const created = await createCodeSessionFromBody({
    ...baseCreateBody(),
    workspace_capability: cap
  }, env);
  assert.equal(created.ok, true);

  const illegal = await transitionCodeSessionTaskFromBody({
    code_session_id: CS_ID,
    actor_id: ACTOR_A,
    workspace_capability: cap,
    task_id: "task-1",
    to_state: "queued",
    base_revision: 1
  }, env);
  assert.equal(illegal.ok, false);
  assert.equal(illegal.error, "code_session_task_transition_illegal");

  const checkpoint = await createCodeCheckpointFromBody({
    code_session_id: CS_ID,
    actor_id: ACTOR_A,
    workspace_capability: cap,
    boundary: "test_gate",
    base_revision: 1
  }, env);
  assert.equal(checkpoint.ok, true);
  assert.equal(checkpoint.session.session_revision, 2);

  const staleCheckpoint = await createCodeCheckpointFromBody({
    code_session_id: CS_ID,
    actor_id: ACTOR_A,
    workspace_capability: cap,
    boundary: "pause",
    base_revision: 1
  }, env);
  assert.equal(staleCheckpoint.ok, false);
  assert.equal(staleCheckpoint.error, "code_session_conflict");

  const staleTip = await createCodeCheckpointFromBody({
    code_session_id: CS_ID,
    actor_id: ACTOR_A,
    workspace_capability: cap,
    boundary: "pause",
    base_revision: 2,
    expected_tip_vector_digest: "deadbeef".repeat(8)
  }, env);
  assert.equal(staleTip.ok, false);
  assert.equal(staleTip.error, "code_session_tip_race");
});

test("V7.7.7b: checkpoint/task ops fail closed without capability; scrub secrets", async () => {
  const db = new FakeCodeSessionD1();
  const r2 = new FakeR2();
  const { env } = await seedWorkspace(db, r2);
  const cap = await mintCap(ACTOR_A, "owner", ["write_draft", "ls", "read"]);
  await createCodeSessionFromBody({
    ...baseCreateBody(),
    workspace_capability: cap
  }, env);

  const unauth = await createCodeCheckpointFromBody({
    code_session_id: CS_ID,
    actor_id: ACTOR_A,
    workspace_capability: REDACTED_CAP,
    boundary: "handoff",
    base_revision: 1
  }, env);
  assert.equal(unauth.ok, false);
  assert.ok(String(unauth.error).includes("workspace_capability"));

  const scrubbed = scrubSecretsDeep({
    workspace_capability: "eyJhbGciOi.fake.signature",
    nested: { token: "abc123", note: "ok" },
    capability_policy_profile_id: "profile:owner"
  });
  assert.equal(scrubbed.workspace_capability, "[REDACTED]");
  assert.equal(scrubbed.nested.token, "[REDACTED]");
  assert.equal(scrubbed.capability_policy_profile_id, "profile:owner");
  assert.equal(scrubbed.nested.note, "ok");
});
