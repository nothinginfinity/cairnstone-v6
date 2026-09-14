import test from "node:test";
import assert from "node:assert/strict";
import {
  CODE_SESSION_CONSOLE_BROKER_TOOL_IDS,
  CODE_SESSION_CONSOLE_MCP_TOOL_DEFINITIONS,
  CODE_SESSION_CONSOLE_MUTATION_TOOL_IDS,
  CODE_SESSION_CONSOLE_READ_TOOL_IDS,
  CODE_SESSION_CONSOLE_VIEW_SCHEMA,
  buildConsoleActionCatalog,
  buildConsoleViewFromContext,
  codeSessionConsoleViewFromBody,
  deriveConsoleActors,
  lifecycleDisplay,
  summarizeConsoleTests
} from "../src/code-session-console.js";
import {
  compileCodeSessionContextFromBody,
  createCodeSessionFromBody
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

const SECRET = "code-session-console-test-secret-v777f";
const ACTOR_A = "chatgpt:cairnstone-v6";
const ACTOR_B = "claude:cairnstone-v6";
const ACTOR_C = "grok:cairnstone-v6";
const ACTOR_BOT = "grok-bot:cairnstone-v6";
const WS_ID = "ws:v777f-demo";
const CS_ID = "cs:v777f-demo";
const BASE_SHA = "a9514d75be0ffc674e7ce097e736568b90412eb0";
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

/** Minimal D1 covering workspace + code-session + checkpoints + empty receipts list. */
class FakeConsoleD1 {
  constructor() {
    this.workspaces = new Map();
    this.members = new Map();
    this.revisions = new Map();
    this.tips = new Map();
    this.sessions = new Map();
    this.checkpoints = new Map();
    this.leases = new Map();
    this.receipts = new Map();
    this.chainHeads = new Map();
    this.pathHeads = new Map();
    this.headMutationAttempts = [];
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
            if (sql.includes("INSERT INTO workspace_revisions")) {
              const [revisionId, workspaceId, path, contentHash, authorActorId, createdAt, parentRevisionId, content] = args;
              db.revisions.set(revisionId, {
                revision_id: revisionId,
                workspace_id: workspaceId,
                path,
                content_hash: contentHash,
                author_actor_id: authorActorId,
                created_at: createdAt,
                parent_revision_id: parentRevisionId,
                content
              });
              return { success: true, meta: { changes: 1 } };
            }
            if (sql.includes("INSERT INTO workspace_tips") && sql.includes("ON CONFLICT")) {
              const [workspaceId, path, revisionId, contentHash, updatedAt] = args;
              db.tips.set(db._tipKey(workspaceId, path), {
                workspace_id: workspaceId,
                path,
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
            if (sql.includes("INSERT INTO code_checkpoints")) {
              const [
                checkpointId, codeSessionId, workspaceId, actorId, boundary,
                sessionRevision, tipVectorJson, tipVectorDigest, workspaceSnapshotId,
                payloadJson, payloadDigest, createdAt
              ] = args;
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
            if (sql.includes("INSERT INTO code_session_task_events")) {
              return { success: true, meta: { changes: 1 } };
            }
            if (sql.includes("INSERT INTO code_session_leases")) {
              const [
                leaseId, codeSessionId, workspaceId, actorId, taskId, pathPrefixesJson,
                acquiredAt, renewedAt, expiresAt, checkpointId, status
              ] = args;
              db.leases.set(leaseId, {
                lease_id: leaseId,
                code_session_id: codeSessionId,
                workspace_id: workspaceId,
                actor_id: actorId,
                task_id: taskId,
                path_prefixes_json: pathPrefixesJson,
                path_prefix_json: pathPrefixesJson,
                acquired_at: acquiredAt,
                renewed_at: renewedAt,
                expires_at: expiresAt,
                checkpoint_id: checkpointId,
                status: status || "active",
                session_revision: 1,
                created_at: acquiredAt,
                updated_at: renewedAt || acquiredAt
              });
              return { success: true, meta: { changes: 1 } };
            }
            if (sql.includes("UPDATE code_session_leases")) {
              if (sql.includes("expires_at <=") || sql.includes("status = 'expired'")) {
                const [updatedAt, codeSessionId, nowIso] = args;
                let changes = 0;
                for (const [key, row] of db.leases.entries()) {
                  if (row.code_session_id === codeSessionId && row.status === "active") {
                    if (!nowIso || String(row.expires_at) <= String(nowIso)) {
                      db.leases.set(key, { ...row, status: "expired", updated_at: updatedAt });
                      changes += 1;
                    }
                  }
                }
                return { success: true, meta: { changes } };
              }
              return { success: true, meta: { changes: 0 } };
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
            if (sql.includes("UPDATE code_sessions") && sql.includes("actors_json = ?")
              && !sql.includes("latest_checkpoint_id")) {
              const [actorsJson, updatedAt, codeSessionId] = args;
              const row = db.sessions.get(codeSessionId);
              if (!row) return { success: true, meta: { changes: 0 } };
              db.sessions.set(codeSessionId, { ...row, actors_json: actorsJson, updated_at: updatedAt });
              return { success: true, meta: { changes: 1 } };
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
            if (sql.includes("FROM workspace_capability_denylist")) return null;
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
            if (sql.includes("FROM code_session_leases WHERE lease_id")) {
              return db.leases.get(args[0]) || null;
            }
            if (sql.includes("FROM environment_manifests")) return null;
            if (sql.includes("FROM code_session_sandbox_attachments")) return null;
            if (sql.includes("FROM code_session_execution_receipts WHERE receipt_id")) {
              return db.receipts.get(args[0]) || null;
            }
            throw new Error(`Unexpected first SQL: ${sql}`);
          },
          async all() {
            if (sql.includes("FROM workspace_tips WHERE workspace_id")) {
              const workspaceId = args[0];
              let tips = [...db.tips.values()].filter(tip => tip.workspace_id === workspaceId);
              tips.sort((a, b) => a.path.localeCompare(b.path));
              return { results: tips };
            }
            if (sql.includes("FROM workspace_members WHERE workspace_id")) {
              return {
                results: [...db.members.values()]
                  .filter(member => member.workspace_id === args[0])
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
            if (sql.includes("FROM code_session_leases") && sql.includes("WHERE code_session_id")) {
              const sessionId = args[0];
              const limit = Number(args[1]) || 50;
              const rows = [...db.leases.values()]
                .filter(row => row.code_session_id === sessionId)
                .sort((a, b) => String(b.expires_at).localeCompare(String(a.expires_at)))
                .slice(0, limit);
              return { results: rows };
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
            if (sql.includes("COUNT(*)") || sql.includes("count(*)")) {
              return { results: [{ c: 0 }] };
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

async function seed(db) {
  const env = testEnv(db);
  await createWorkspace(db, {
    workspace_id: WS_ID,
    name: "Student Loan Advisor",
    created_by: "operator:cairnstone-console"
  });
  for (const [actor, role] of [
    [ACTOR_A, "drafter"],
    [ACTOR_B, "drafter"],
    [ACTOR_C, "drafter"],
    [ACTOR_BOT, "proposer"]
  ]) {
    await upsertWorkspaceMember(db, { workspace_id: WS_ID, actor_id: actor, role });
  }
  return env;
}

async function mintCap(actor, role, scopes) {
  const issued = await issueWorkspaceCapabilityFromBody({
    workspace_id: WS_ID,
    actor_id: actor,
    membership_role: role,
    scopes,
    ttl_seconds: 3600
  }, {
    CAIRNSTONE_WORKSPACE_CAPABILITY_SECRET: SECRET
  });
  assert.equal(issued.ok, true);
  return issued.workspace_capability;
}

test("pure: deriveConsoleActors + summarizeConsoleTests + action catalog", () => {
  const now = Date.parse("2026-09-14T00:00:00.000Z");
  const actors = deriveConsoleActors({
    actors: [
      { actor_id: ACTOR_B, role: "drafter" },
      { actor_id: ACTOR_A, role: "drafter" },
      { actor_id: ACTOR_C, role: "drafter" },
      { actor_id: ACTOR_BOT, role: "proposer" }
    ],
    active_task_leases: [
      { actor_id: ACTOR_B, lease_id: "lease:1", task_id: "parser", path_prefixes: ["src/parser"] }
    ],
    task_ledger: [
      { task_id: "t1", title: "Advisor Workspace refactor", state: "active", actor_id: ACTOR_B },
      { task_id: "t2", title: "Review", state: "review", actor_id: ACTOR_C }
    ],
    checkpoints: [
      {
        checkpoint_id: "cp:1",
        actor_id: ACTOR_A,
        created_at: "2026-09-13T23:46:00.000Z"
      }
    ],
    nowMs: now
  });

  const byId = Object.fromEntries(actors.map(a => [a.actor_id, a]));
  assert.equal(byId[ACTOR_B].status, "active");
  assert.equal(byId[ACTOR_B].display, "Claude");
  assert.match(String(byId[ACTOR_B].detail), /parser/);
  assert.equal(byId[ACTOR_A].status, "paused");
  assert.match(String(byId[ACTOR_A].detail), /checkpoint/);
  assert.equal(byId[ACTOR_C].status, "reviewing");
  assert.equal(byId[ACTOR_BOT].status, "release owner");

  const tests = summarizeConsoleTests([
    {
      receipt_id: "rcpt:1",
      command_class: "test",
      status: "pass",
      exit_code: 0,
      payload: { tests_passed: 184, tests_total: 184 }
    }
  ]);
  assert.equal(tests.summary, "184 / 184 passing");
  assert.equal(tests.passed, 184);
  assert.equal(tests.total, 184);

  const actions = buildConsoleActionCatalog({
    code_session_id: CS_ID,
    workspace_id: WS_ID,
    project_chain: "cairnstone-v6-project-memory"
  });
  assert.equal(actions.invite_agent.plane, "v7.7.6_workspace_invite");
  assert.equal(actions.invite_agent.rest.mint, "POST /v1/workspace-invites");
  assert.equal(actions.invite_agent.mcp_claim, "cairnstone_workspace_invite_claim");
  assert.match(actions.invite_agent.continuation_prompt, /Check your CairnStone inbox/);
  assert.equal(actions.propose_merge.mcp, "cairnstone_workspace_propose_accept");
  assert.equal(actions.propose_merge.accepted_state_authority, false);
  assert.equal(actions.propose_merge.requires_scope, "propose");
  assert.ok(!JSON.stringify(actions).includes("Bearer"));
  assert.ok(!JSON.stringify(actions).includes(REDACTED_CAP));
});

test("pure: buildConsoleViewFromContext shapes operator surface", () => {
  const view = buildConsoleViewFromContext({
    context: {
      ok: true,
      code_session_id: CS_ID,
      session_revision: 3,
      lifecycle: "active",
      project: { chain: "cairnstone-v6-project-memory", repos: ["nothinginfinity/cairnstone-v6"] },
      workspace: {
        workspace_id: WS_ID,
        tip_count: 15,
        tip_vector_digest: "digest:abc",
        tree_stats: { tip_count: 15 }
      },
      actors: [
        { actor_id: ACTOR_B, role: "drafter" },
        { actor_id: ACTOR_BOT, role: "proposer" }
      ],
      active_task_leases: [],
      known_concurrent_actors: [],
      task_ledger: [
        { task_id: "t1", title: "Advisor Workspace refactor", state: "active", actor_id: ACTOR_B }
      ],
      task_ledger_summary: {
        active: [{ task_id: "t1", title: "Advisor Workspace refactor", state: "active", actor_id: ACTOR_B }]
      },
      changes_since_last_checkpoint: {
        paths_changed: ["a.js", "b.js", "c.js"],
        changed_path_details: [
          { path: "a.js", change: "modified" },
          { path: "b.js", change: "modified" },
          { path: "c.js", change: "added" }
        ]
      },
      unresolved_issues: [],
      latest_checkpoint: null,
      environment_sandbox: {
        secrets_absent: true,
        sandbox_local_execution_only: true,
        production_mutation_authority: false,
        accepted_state_authority: false
      },
      permissions: {
        actor_id: ACTOR_B,
        membership_role: "drafter",
        scopes: ["ls", "read"],
        capability_policy_profile_id: "policy:demo"
      },
      next_safe_continuation: { action: "continue_active_task", safe_to_continue: true },
      content_identity: { context_digest: "ctx:1" }
    },
    workspace: { name: "Student Loan Advisor", workspace_id: WS_ID },
    checkpoints: [],
    receipts: [
      {
        receipt_id: "rcpt:1",
        command_class: "test",
        status: "pass",
        exit_code: 0,
        payload: { passed: 184, total: 184 }
      }
    ]
  });

  assert.equal(view.ok, true);
  assert.equal(view.schema, CODE_SESSION_CONSOLE_VIEW_SCHEMA);
  assert.equal(view.project.name, "Student Loan Advisor");
  assert.equal(view.persistent_code_session.display, "Active");
  assert.equal(view.current_task.title, "Advisor Workspace refactor");
  assert.equal(view.working_tree.modified, 2);
  assert.equal(view.working_tree.added, 1);
  assert.equal(view.working_tree.conflicts, 0);
  assert.equal(view.tests.summary, "184 / 184 passing");
  assert.equal(view.accepted_state_authority, false);
  assert.equal(view.console_grants_no_new_authority, true);
  assert.equal(view.secrets_absent, true);
  assert.equal(view.operator_surface.buttons.length, 5);
  assert.equal(view.actions.invite_agent.plane, "v7.7.6_workspace_invite");
  assert.equal(lifecycleDisplay("paused"), "Paused");
});

test("integration: console_view aggregates live session without HEAD mutation or secrets", async () => {
  const db = new FakeConsoleD1();
  const env = await seed(db);
  const writeCap = await mintCap(ACTOR_B, "drafter", ["write_draft", "ls", "read"]);
  const readCap = await mintCap(ACTOR_B, "drafter", ["ls", "read"]);

  const created = await createCodeSessionFromBody({
    code_session_id: CS_ID,
    workspace_id: WS_ID,
    created_by: ACTOR_B,
    project_chain: "cairnstone-v6-project-memory",
    source_repos: ["nothinginfinity/cairnstone-v6"],
    base_commits: [{ repo: "nothinginfinity/cairnstone-v6", commit_sha: BASE_SHA }],
    actors: [
      { actor_id: ACTOR_A, role: "drafter" },
      { actor_id: ACTOR_B, role: "drafter" },
      { actor_id: ACTOR_C, role: "drafter" },
      { actor_id: ACTOR_BOT, role: "proposer" }
    ],
    task_ledger: [
      { task_id: "task:refactor", title: "Advisor Workspace refactor", state: "active", actor_id: ACTOR_B }
    ],
    workspace_capability: writeCap
  }, env);
  assert.equal(created.ok, true);

  // Seed tip / checkpoint / lease / receipt rows directly for aggregation coverage.
  const tipHash = "a".repeat(64);
  db.tips.set(`${WS_ID}\0src/advisor.js`, {
    workspace_id: WS_ID,
    path: "src/advisor.js",
    revision_id: "rev:1",
    content_hash: tipHash,
    updated_at: new Date().toISOString()
  });
  db.tips.set(`${WS_ID}\0src/new.js`, {
    workspace_id: WS_ID,
    path: "src/new.js",
    revision_id: "rev:2",
    content_hash: "b".repeat(64),
    updated_at: new Date().toISOString()
  });
  db.checkpoints.set("cp:v777f-1", {
    checkpoint_id: "cp:v777f-1",
    code_session_id: CS_ID,
    workspace_id: WS_ID,
    actor_id: ACTOR_A,
    boundary: "handoff",
    session_revision: 1,
    tip_vector_json: "[]",
    tip_vector_digest: "digest:prior",
    workspace_snapshot_id: null,
    payload_json: JSON.stringify({
      task: { current_task: "Advisor Workspace refactor", next_action: "continue" },
      safe_to_continue: true
    }),
    payload_digest: "digest:cp",
    created_at: new Date(Date.now() - 14 * 60 * 1000).toISOString()
  });
  const session = db.sessions.get(CS_ID);
  db.sessions.set(CS_ID, {
    ...session,
    latest_checkpoint_id: "cp:v777f-1",
    checkpoint_tip_vector_digest: "digest:prior"
  });
  db.leases.set("lease:v777f-1", {
    lease_id: "lease:v777f-1",
    code_session_id: CS_ID,
    workspace_id: WS_ID,
    actor_id: ACTOR_B,
    task_id: "task:refactor",
    path_prefixes_json: JSON.stringify(["src/advisor.js"]),
    path_prefix_json: JSON.stringify(["src/advisor.js"]),
    acquired_at: new Date().toISOString(),
    renewed_at: new Date().toISOString(),
    expires_at: new Date(Date.now() + 600000).toISOString(),
    checkpoint_id: "cp:v777f-1",
    status: "active",
    session_revision: 1,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString()
  });
  db.receipts.set("rcpt:v777f-test", {
    receipt_id: "rcpt:v777f-test",
    code_session_id: CS_ID,
    workspace_id: WS_ID,
    environment_manifest_id: null,
    sandbox_attachment_id: null,
    actor_id: ACTOR_B,
    command_class: "test",
    command_summary: "npm test",
    status: "pass",
    exit_code: 0,
    duration_ms: 1200,
    tip_vector_digest: null,
    artifact_refs_json: "[]",
    log_ref: null,
    payload_json: JSON.stringify({ tests_passed: 184, tests_total: 184 }),
    payload_digest: "digest:tests",
    secrets_absent: 1,
    production_mutation: 0,
    accepted_state_authority: 0,
    created_at: new Date().toISOString()
  });

  const view = await codeSessionConsoleViewFromBody({
    code_session_id: CS_ID,
    actor_id: ACTOR_B,
    workspace_capability: readCap
  }, env);

  assert.equal(view.ok, true);
  assert.equal(view.schema, CODE_SESSION_CONSOLE_VIEW_SCHEMA);
  assert.equal(view.project.name, "Student Loan Advisor");
  assert.equal(view.persistent_code_session.lifecycle, "active");
  assert.equal(view.current_task.title, "Advisor Workspace refactor");
  assert.ok(view.actors.some(a => a.actor_id === ACTOR_B && a.status === "active"));
  assert.equal(view.tests.summary, "184 / 184 passing");
  assert.match(view.working_tree.summary, /modified|added/);
  assert.equal(view.actions.invite_agent.mcp_claim, "cairnstone_workspace_invite_claim");
  assert.equal(view.actions.send_message.mcp, "cairnstone_send_message");
  assert.equal(view.actions.checkpoints.mcp_list, "cairnstone_code_checkpoint_list");
  assert.ok(view.actions.view_work.mcp.includes("cairnstone_workspace_tree_ls"));
  assert.equal(view.actions.propose_merge.mcp, "cairnstone_workspace_propose_accept");
  assert.equal(view.accepted_state_authority, false);
  assert.equal(view.console_grants_no_new_authority, true);
  assert.equal(view.secrets_absent, true);
  assert.equal(db.headMutationAttempts.length, 0);

  const serialized = JSON.stringify(view);
  assert.ok(!serialized.includes(writeCap));
  assert.ok(!serialized.includes(readCap));
  assert.ok(!serialized.includes(SECRET));

  const denied = await codeSessionConsoleViewFromBody({
    code_session_id: CS_ID,
    actor_id: ACTOR_B,
    workspace_capability: REDACTED_CAP
  }, env);
  assert.equal(denied.ok, false);

  const context = await compileCodeSessionContextFromBody({
    code_session_id: CS_ID,
    actor_id: ACTOR_B,
    workspace_capability: readCap
  }, env);
  assert.equal(context.ok, true);
  assert.equal(context.accepted_state_authority, false);
});

test("broker + MCP: console_view is scoped_grant read, not automatic-read", () => {
  assert.deepEqual(CODE_SESSION_CONSOLE_READ_TOOL_IDS, [
    CODE_SESSION_CONSOLE_BROKER_TOOL_IDS.view
  ]);
  assert.deepEqual(CODE_SESSION_CONSOLE_MUTATION_TOOL_IDS, []);

  const registry = toolRegistryFromBody({}, {}, { registry: DEFAULT_TOOL_BROKER_REGISTRY });
  assert.equal(registry.ok, true);
  assert.equal(registry.total, 68);

  const entry = registry.tools.find(item => item.tool_id === CODE_SESSION_CONSOLE_BROKER_TOOL_IDS.view);
  assert.ok(entry);
  assert.equal(entry.risk_class, "read");
  assert.equal(entry.authorization, "scoped_grant");

  const automatic = listAutomaticReadToolIds(DEFAULT_TOOL_BROKER_REGISTRY);
  assert.ok(!automatic.includes(CODE_SESSION_CONSOLE_BROKER_TOOL_IDS.view));

  const names = mcpToolsForProfile(false).map(tool => tool.name);
  for (const def of CODE_SESSION_CONSOLE_MCP_TOOL_DEFINITIONS) {
    assert.ok(names.includes(def.name), `${def.name} must be in MCP catalog`);
  }
});
