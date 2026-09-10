import test from "node:test";
import assert from "node:assert/strict";
import {
  WORKSPACE_BROKER_TOOL_IDS,
  WORKSPACE_MUTATION_TOOL_IDS,
  WORKSPACE_READ_TOOL_IDS,
  WORKSPACE_MCP_TOOL_DEFINITIONS,
  WORKSPACE_ROLE_SCOPES,
  canonicalizeWorkspacePath,
  capabilityHasExactScopes,
  createWorkspace,
  createWorkspaceFromBody,
  diffWorkspaceFromBody,
  freezeWorkspaceSnapshot,
  issueWorkspaceCapabilityFromBody,
  listWorkspacesFromBody,
  lsWorkspaceFromBody,
  narrowScopesToMembership,
  proposeAcceptWorkspaceFromBody,
  readDraft,
  readWorkspaceFromBody,
  statWorkspaceFromBody,
  upsertWorkspaceMember,
  verifyWorkspaceCapability,
  workspaceCapabilitySecret,
  writeDraft,
  writeDraftFromBody
} from "../src/workspace.js";
import {
  DEFAULT_TOOL_BROKER_REGISTRY,
  toolRegistryFromBody
} from "../src/model-router.js";
import { listAutomaticReadToolIds } from "../src/delegate-loop.js";
import { mcpToolsForProfile } from "../src/index.js";

const TEST_ENV_SECRET = { CAIRNSTONE_WORKSPACE_CAPABILITY_SECRET: "workspace-test-secret-v775c" };
const ACTOR_A = "chatgpt:cairnstone-v6";
const ACTOR_B = "claude:cairnstone-v6";
const ACTOR_C = "grok-bot:cairnstone-v6";
const WS_ID = "ws:v775c-demo";
const OBSERVED_SHA = "05e6f0e40c95d7f217fa1550bdb098923b300c81";

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

class FakeWorkspaceD1 {
  constructor() {
    this.workspaces = new Map();
    this.members = new Map();
    this.revisions = new Map();
    this.tips = new Map();
    this.snapshots = new Map();
    this.chainHeads = new Map();
    this.pathHeads = new Map();
  }

  _memberKey(ws, actor) {
    return `${ws}\0${actor}`;
  }

  _tipKey(ws, path) {
    return `${ws}\0${path}`;
  }

  prepare(sql) {
    const db = this;
    return {
      bind(...args) {
        const bound = {
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
            if (sql.includes("INSERT OR IGNORE INTO workspace_snapshots")) {
              const [snapshotId, workspaceId, tipVectorJson, tipVectorDigest, createdBy, createdAt] = args;
              if (!db.snapshots.has(snapshotId)) {
                db.snapshots.set(snapshotId, {
                  snapshot_id: snapshotId,
                  workspace_id: workspaceId,
                  tip_vector_json: tipVectorJson,
                  tip_vector_digest: tipVectorDigest,
                  created_by: createdBy,
                  created_at: createdAt
                });
              }
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
            throw new Error(`Unexpected run SQL: ${sql}`);
          },
          async first() {
            if (sql.includes("FROM workspaces WHERE workspace_id")) {
              const [workspaceId] = args;
              return db.workspaces.get(workspaceId) || null;
            }
            if (sql.includes("FROM workspace_members WHERE workspace_id = ? AND actor_id = ?")) {
              const [workspaceId, actorId] = args;
              return db.members.get(db._memberKey(workspaceId, actorId)) || null;
            }
            if (sql.includes("FROM workspace_tips")) {
              const [workspaceId, path] = args;
              return db.tips.get(db._tipKey(workspaceId, path)) || null;
            }
            if (sql.includes("FROM workspace_revisions WHERE revision_id")) {
              const [revisionId] = args;
              return db.revisions.get(revisionId) || null;
            }
            if (sql.includes("FROM workspace_snapshots WHERE snapshot_id")) {
              const [snapshotId] = args;
              return db.snapshots.get(snapshotId) || null;
            }
            throw new Error(`Unexpected first SQL: ${sql}`);
          },
          async all() {
            if (sql.includes("FROM workspace_members WHERE workspace_id = ?") && sql.includes("ORDER BY actor_id")) {
              const [workspaceId] = args;
              const rows = [...db.members.values()]
                .filter(row => row.workspace_id === workspaceId)
                .sort((a, b) => a.actor_id.localeCompare(b.actor_id));
              return { results: rows };
            }
            if (sql.includes("FROM workspace_tips WHERE workspace_id = ?")) {
              const [workspaceId, exactOrNull, likeOrUndefined] = args;
              let rows = [...db.tips.values()].filter(row => row.workspace_id === workspaceId);
              if (sql.includes("path = ? OR path LIKE ?")) {
                const exact = exactOrNull;
                const prefix = String(exactOrNull || "");
                rows = rows.filter(row => row.path === exact || row.path.startsWith(`${prefix}/`));
              }
              rows.sort((a, b) => a.path.localeCompare(b.path));
              return { results: rows };
            }
            if (sql.includes("FROM workspace_members m") && sql.includes("INNER JOIN workspaces")) {
              const [actorId, limit] = args;
              const rows = [...db.members.values()]
                .filter(row => row.actor_id === actorId)
                .map(row => {
                  const ws = db.workspaces.get(row.workspace_id);
                  return ws
                    ? {
                      workspace_id: ws.workspace_id,
                      name: ws.name,
                      created_by: ws.created_by,
                      created_at: ws.created_at,
                      updated_at: ws.updated_at,
                      status: ws.status,
                      membership_role: row.role
                    }
                    : null;
                })
                .filter(Boolean)
                .sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at)) || a.workspace_id.localeCompare(b.workspace_id))
                .slice(0, limit);
              return { results: rows };
            }
            throw new Error(`Unexpected all SQL: ${sql}`);
          }
        };
        return bound;
      }
    };
  }
}

function testEnv(db, r2) {
  return {
    ...TEST_ENV_SECRET,
    CAIRNSTONE_DB: db,
    CAIRNSTONE_RAW: r2
  };
}

async function mintCapability(actorId, role, scopes, workspaceId = WS_ID, extra = {}) {
  const issued = await issueWorkspaceCapabilityFromBody({
    principal_actor_id: actorId,
    workspace_id: workspaceId,
    membership_role: role,
    scopes,
    ...extra
  }, TEST_ENV_SECRET);
  assert.equal(issued.ok, true, issued.error);
  return issued.workspace_capability;
}

async function seedWorkspace() {
  const db = new FakeWorkspaceD1();
  const r2 = new FakeR2();
  const created = await createWorkspace(db, {
    workspace_id: WS_ID,
    name: "V775c demo",
    created_by: ACTOR_A
  });
  assert.equal(created.ok, true);
  await upsertWorkspaceMember(db, { workspace_id: WS_ID, actor_id: ACTOR_B, role: "drafter" });
  return { db, r2, env: testEnv(db, r2) };
}

test("workspace capability secret fails closed and never falls back to mailbox/operator secrets", () => {
  assert.equal(workspaceCapabilitySecret({}), null);
  assert.equal(workspaceCapabilitySecret({
    CAIRNSTONE_MAILBOX_CAPABILITY_SECRET: "mailbox",
    CAIRNSTONE_OPERATOR_TOKEN: "operator"
  }), null);
  assert.equal(workspaceCapabilitySecret(TEST_ENV_SECRET), "workspace-test-secret-v775c");
});

test("verifyWorkspaceCapability fails closed when secret missing", async () => {
  const issued = await issueWorkspaceCapabilityFromBody({
    principal_actor_id: ACTOR_A,
    workspace_id: WS_ID,
    membership_role: "drafter",
    scopes: ["read", "write_draft"]
  }, TEST_ENV_SECRET);
  assert.equal(issued.ok, true);

  const missing = await verifyWorkspaceCapability(issued.workspace_capability, {
    expectedActorId: ACTOR_A,
    expectedWorkspaceId: WS_ID,
    requiredScopes: ["write_draft"]
  }, {});
  assert.equal(missing.ok, false);
  assert.equal(missing.error, "workspace_capability_not_configured");

  const mintMissing = await issueWorkspaceCapabilityFromBody({
    principal_actor_id: ACTOR_A,
    workspace_id: WS_ID,
    membership_role: "reader",
    scopes: ["read"]
  }, { CAIRNSTONE_OPERATOR_TOKEN: "nope" });
  assert.equal(mintMissing.ok, false);
  assert.equal(mintMissing.error, "workspace_capability_not_configured");
});

test("capability mint/verify binds actor, workspace, purpose, and exact scopes", async () => {
  const issued = await issueWorkspaceCapabilityFromBody({
    principal_actor_id: ACTOR_A,
    workspace_id: WS_ID,
    membership_role: "proposer",
    scopes: ["ls", "read", "write_draft"],
    path_prefix: "drafts"
  }, TEST_ENV_SECRET);
  assert.equal(issued.ok, true);
  assert.equal(issued.policy.write_draft_implies_propose, false);

  const ok = await verifyWorkspaceCapability(issued.workspace_capability, {
    expectedActorId: ACTOR_A,
    expectedWorkspaceId: WS_ID,
    requiredScopes: ["write_draft"],
    path: "drafts/a.md"
  }, TEST_ENV_SECRET);
  assert.equal(ok.ok, true);
  assert.equal(ok.workspace_id, WS_ID);
  assert.deepEqual(ok.scopes, ["ls", "read", "write_draft"]);

  const wrongActor = await verifyWorkspaceCapability(issued.workspace_capability, {
    expectedActorId: ACTOR_B,
    expectedWorkspaceId: WS_ID,
    requiredScopes: ["read"]
  }, TEST_ENV_SECRET);
  assert.equal(wrongActor.error, "workspace_capability_principal_mismatch");

  const wrongWs = await verifyWorkspaceCapability(issued.workspace_capability, {
    expectedActorId: ACTOR_A,
    expectedWorkspaceId: "ws:other",
    requiredScopes: ["read"]
  }, TEST_ENV_SECRET);
  assert.equal(wrongWs.error, "workspace_capability_workspace_mismatch");

  const outsidePrefix = await verifyWorkspaceCapability(issued.workspace_capability, {
    expectedActorId: ACTOR_A,
    expectedWorkspaceId: WS_ID,
    requiredScopes: ["read"],
    path: "other/a.md"
  }, TEST_ENV_SECRET);
  assert.equal(outsidePrefix.error, "workspace_path_outside_capability_prefix");
});

test("write_draft scope does not imply propose (exact scope separation)", async () => {
  const widened = narrowScopesToMembership(["write_draft", "propose"], "drafter");
  assert.equal(widened.ok, false);
  assert.equal(widened.error, "workspace_capability_widens_membership");

  const issued = await issueWorkspaceCapabilityFromBody({
    principal_actor_id: ACTOR_A,
    workspace_id: WS_ID,
    membership_role: "drafter",
    scopes: ["write_draft", "read"]
  }, TEST_ENV_SECRET);
  assert.equal(issued.ok, true);
  assert.equal(capabilityHasExactScopes(issued.scopes, ["write_draft"]), true);
  assert.equal(capabilityHasExactScopes(issued.scopes, ["propose"]), false);

  const proposeDenied = await verifyWorkspaceCapability(issued.workspace_capability, {
    expectedActorId: ACTOR_A,
    expectedWorkspaceId: WS_ID,
    requiredScopes: ["propose"]
  }, TEST_ENV_SECRET);
  assert.equal(proposeDenied.ok, false);
  assert.equal(proposeDenied.error, "workspace_capability_scope_missing");
  assert.deepEqual(proposeDenied.missing, ["propose"]);

  assert.deepEqual(WORKSPACE_ROLE_SCOPES.reader, ["diff", "ls", "read"]);
  assert.ok(!WORKSPACE_ROLE_SCOPES.drafter.includes("propose"));
  assert.ok(WORKSPACE_ROLE_SCOPES.proposer.includes("propose"));
});

test("path hardening rejects traversal, absolute, NUL, symlink patterns, and secrets", () => {
  assert.equal(canonicalizeWorkspacePath("docs/a.md").ok, true);
  assert.equal(canonicalizeWorkspacePath("../secrets").error, "workspace_path_invalid");
  assert.equal(canonicalizeWorkspacePath("/etc/passwd").detail, "absolute_path");
  assert.equal(canonicalizeWorkspacePath("a\0b").detail, "nul_byte");
  assert.equal(canonicalizeWorkspacePath("foo/.symlink").detail, "symlink_pattern");
  assert.equal(canonicalizeWorkspacePath(".env").error, "workspace_path_denied_secret");
  assert.equal(canonicalizeWorkspacePath("config/id_rsa").error, "workspace_path_denied_secret");
  assert.equal(canonicalizeWorkspacePath("certs/prod.pem").error, "workspace_path_denied_secret");
  assert.equal(canonicalizeWorkspacePath("C:/windows").detail, "absolute_path");
});

test("writeDraft CAS: create then conflict on stale base_revision (no LWW)", async () => {
  const { db, r2 } = await seedWorkspace();

  const first = await writeDraft(db, r2, {
    workspace_id: WS_ID,
    path: "notes/hello.md",
    content: "hello",
    base_revision: null,
    actor_id: ACTOR_A
  });
  assert.equal(first.ok, true);
  assert.equal(first.stones_written, 0);
  assert.equal(first.chain_heads_mutated, false);
  assert.equal(first.path_heads_mutated, false);
  assert.ok(first.revision_id);
  assert.ok(first.content_hash);

  const stale = await writeDraft(db, r2, {
    workspace_id: WS_ID,
    path: "notes/hello.md",
    content: "stale writer",
    base_revision: null,
    actor_id: ACTOR_B
  });
  assert.equal(stale.ok, false);
  assert.equal(stale.error, "workspace_conflict");
  assert.equal(stale.current_tip.revision_id, first.revision_id);
  assert.equal(stale.current_tip.content_hash, first.content_hash);

  const wrongBase = await writeDraft(db, r2, {
    workspace_id: WS_ID,
    path: "notes/hello.md",
    content: "wrong base",
    base_revision: "deadbeef",
    actor_id: ACTOR_B
  });
  assert.equal(wrongBase.error, "workspace_conflict");
  assert.equal(wrongBase.current_tip.revision_id, first.revision_id);

  const second = await writeDraft(db, r2, {
    workspace_id: WS_ID,
    path: "notes/hello.md",
    content: "hello world",
    base_revision: first.revision_id,
    actor_id: ACTOR_B
  });
  assert.equal(second.ok, true);
  assert.equal(second.parent_revision_id, first.revision_id);
  assert.notEqual(second.revision_id, first.revision_id);

  const read = await readDraft(db, r2, { workspace_id: WS_ID, path: "notes/hello.md" });
  assert.equal(read.ok, true);
  assert.equal(read.content, "hello world");
  assert.equal(read.revision_id, second.revision_id);
  assert.equal(read.accepted_state_authority, false);
});

test("broker registry: workspace mutations are never automatic-read", () => {
  const registry = toolRegistryFromBody({});
  assert.equal(registry.ok, true);
  assert.equal(registry.total, 35);

  for (const toolId of WORKSPACE_MUTATION_TOOL_IDS) {
    const entry = registry.tools.find(item => item.tool_id === toolId);
    assert.ok(entry, `${toolId} must be registered`);
    assert.equal(entry.risk_class, "mutation");
    assert.equal(entry.authorization, "scoped_grant");
  }
  for (const toolId of WORKSPACE_READ_TOOL_IDS) {
    const entry = registry.tools.find(item => item.tool_id === toolId);
    assert.ok(entry, `${toolId} must be registered`);
    assert.equal(entry.risk_class, "read");
    assert.equal(entry.authorization, "scoped_grant");
  }

  const create = registry.tools.find(item => item.tool_id === WORKSPACE_BROKER_TOOL_IDS.create);
  assert.deepEqual(create.input_schema.required, ["name", "created_by", "workspace_id", "workspace_capability"]);

  const automatic = listAutomaticReadToolIds(DEFAULT_TOOL_BROKER_REGISTRY);
  for (const toolId of Object.values(WORKSPACE_BROKER_TOOL_IDS)) {
    assert.ok(!automatic.includes(toolId), `${toolId} must not be automatic-read`);
  }
});

test("MCP tools/list advertises 5c workspace tools including propose_accept", () => {
  const names = mcpToolsForProfile(false).map(tool => tool.name);
  for (const def of WORKSPACE_MCP_TOOL_DEFINITIONS) {
    assert.ok(names.includes(def.name), `${def.name} must be in MCP catalog`);
  }
  assert.equal(names.includes(WORKSPACE_BROKER_TOOL_IDS.propose_accept), true);
});

test("MCP create requires owner capability; optional github_bind accepted", async () => {
  const db = new FakeWorkspaceD1();
  const r2 = new FakeR2();
  const env = testEnv(db, r2);
  const wsId = "ws:v775c-create";

  const ownerCap = await mintCapability(ACTOR_A, "owner", ["write_draft", "ls", "read"], wsId);
  const created = await createWorkspaceFromBody({
    name: "Create demo",
    created_by: ACTOR_A,
    workspace_id: wsId,
    workspace_capability: ownerCap
  }, env);
  assert.equal(created.ok, true);
  assert.equal(created.workspace_id, wsId);
  assert.equal(created.accepted_state_authority, false);

  const drafterCap = await mintCapability(ACTOR_B, "drafter", ["write_draft"], "ws:v775c-create-2");
  const deniedRole = await createWorkspaceFromBody({
    name: "Nope",
    created_by: ACTOR_B,
    workspace_id: "ws:v775c-create-2",
    workspace_capability: drafterCap
  }, env);
  assert.equal(deniedRole.error, "workspace_create_requires_owner_capability");

  const bindWs = "ws:v775c-create-3";
  const bindCreated = await createWorkspaceFromBody({
    name: "Bind",
    created_by: ACTOR_A,
    workspace_id: bindWs,
    workspace_capability: await mintCapability(ACTOR_A, "owner", ["write_draft"], bindWs),
    github_bind: { owner: "nothinginfinity", repo: "cairnstone-v6", ref: "main", root_path: "src" }
  }, env);
  assert.equal(bindCreated.ok, true);
  assert.equal(bindCreated.github_bind.owner, "nothinginfinity");
  assert.equal(bindCreated.github_bind.root_path, "src");

  const badRoot = await createWorkspaceFromBody({
    name: "Bad root",
    created_by: ACTOR_A,
    workspace_id: "ws:v775c-create-4",
    workspace_capability: await mintCapability(ACTOR_A, "owner", ["write_draft"], "ws:v775c-create-4"),
    github_bind: { owner: "o", repo: "r", root_path: "../etc" }
  }, env);
  assert.equal(badRoot.error, "invalid_workspace_github_bind_root_path");
});

test("cross-actor: two members share draft; third without grant denied; CAS conflict via MCP", async () => {
  const { env } = await seedWorkspace();

  const capAWrite = await mintCapability(ACTOR_A, "owner", ["ls", "read", "write_draft", "diff"]);
  const capBWrite = await mintCapability(ACTOR_B, "drafter", ["ls", "read", "write_draft", "diff"]);
  const capBRead = await mintCapability(ACTOR_B, "drafter", ["ls", "read", "diff"]);

  const written = await writeDraftFromBody({
    workspace_id: WS_ID,
    path: "shared/plan.md",
    content: "shared draft v1",
    base_revision: null,
    actor_id: ACTOR_A,
    workspace_capability: capAWrite
  }, env);
  assert.equal(written.ok, true);
  assert.equal(written.stones_written, 0);
  assert.equal(written.chain_heads_mutated, false);

  const readB = await readWorkspaceFromBody({
    workspace_id: WS_ID,
    path: "shared/plan.md",
    actor_id: ACTOR_B,
    workspace_capability: capBRead
  }, env);
  assert.equal(readB.ok, true);
  assert.equal(readB.content, "shared draft v1");
  assert.equal(readB.revision_id, written.revision_id);

  const lsB = await lsWorkspaceFromBody({
    workspace_id: WS_ID,
    actor_id: ACTOR_B,
    workspace_capability: capBRead,
    prefix: "shared"
  }, env);
  assert.equal(lsB.ok, true);
  assert.equal(lsB.total, 1);
  assert.equal(lsB.entries[0].path, "shared/plan.md");

  const listB = await listWorkspacesFromBody({
    actor_id: ACTOR_B,
    workspace_capability: capBRead
  }, env);
  assert.equal(listB.ok, true);
  assert.equal(listB.workspaces.some(row => row.workspace_id === WS_ID), true);

  const statA = await statWorkspaceFromBody({
    workspace_id: WS_ID,
    actor_id: ACTOR_A,
    workspace_capability: capAWrite
  }, env);
  assert.equal(statA.ok, true);
  assert.equal(statA.tip_count, 1);
  assert.equal(statA.members.length, 2);

  // Third actor: semantic actor string alone is not enough.
  const noCap = await readWorkspaceFromBody({
    workspace_id: WS_ID,
    path: "shared/plan.md",
    actor_id: ACTOR_C,
    workspace_capability: ""
  }, env);
  assert.equal(noCap.error, "workspace_capability_required");

  // Capability minted for C but no membership grant → denied.
  const capC = await mintCapability(ACTOR_C, "reader", ["ls", "read", "diff"]);
  const deniedMember = await readWorkspaceFromBody({
    workspace_id: WS_ID,
    path: "shared/plan.md",
    actor_id: ACTOR_C,
    workspace_capability: capC
  }, env);
  assert.equal(deniedMember.error, "workspace_membership_required");

  // Wrong principal using A's capability.
  const wrongPrincipal = await readWorkspaceFromBody({
    workspace_id: WS_ID,
    path: "shared/plan.md",
    actor_id: ACTOR_C,
    workspace_capability: capAWrite
  }, env);
  assert.equal(wrongPrincipal.error, "workspace_capability_principal_mismatch");

  // Wrong workspace id.
  const wrongWs = await readWorkspaceFromBody({
    workspace_id: "ws:other",
    path: "shared/plan.md",
    actor_id: ACTOR_A,
    workspace_capability: capAWrite
  }, env);
  assert.equal(wrongWs.error, "workspace_capability_workspace_mismatch");

  // Stale CAS via MCP.
  const conflict = await writeDraftFromBody({
    workspace_id: WS_ID,
    path: "shared/plan.md",
    content: "stale",
    base_revision: null,
    actor_id: ACTOR_B,
    workspace_capability: capBWrite
  }, env);
  assert.equal(conflict.error, "workspace_conflict");
  assert.equal(conflict.current_tip.revision_id, written.revision_id);

  const updated = await writeDraftFromBody({
    workspace_id: WS_ID,
    path: "shared/plan.md",
    content: "shared draft v2",
    base_revision: written.revision_id,
    actor_id: ACTOR_B,
    workspace_capability: capBWrite
  }, env);
  assert.equal(updated.ok, true);

  const diff = await diffWorkspaceFromBody({
    workspace_id: WS_ID,
    path: "shared/plan.md",
    actor_id: ACTOR_A,
    workspace_capability: capAWrite,
    against_revision: written.revision_id
  }, env);
  assert.equal(diff.ok, true);
  assert.equal(diff.changed, true);
  assert.equal(diff.github_bind, null);
  assert.equal(diff.observed_commit_sha, null);
  assert.match(diff.diff.unified, /shared draft v2/);
});

test("MCP path deny + write_draft capability cannot call propose_accept", async () => {
  const { env } = await seedWorkspace();
  const capWrite = await mintCapability(ACTOR_A, "owner", ["ls", "read", "write_draft", "diff"]);

  const pathDenied = await writeDraftFromBody({
    workspace_id: WS_ID,
    path: "../etc/passwd",
    content: "nope",
    base_revision: null,
    actor_id: ACTOR_A,
    workspace_capability: capWrite
  }, env);
  assert.equal(pathDenied.error, "workspace_path_invalid");

  const secretDenied = await writeDraftFromBody({
    workspace_id: WS_ID,
    path: ".env",
    content: "SECRET=1",
    base_revision: null,
    actor_id: ACTOR_A,
    workspace_capability: capWrite
  }, env);
  assert.equal(secretDenied.error, "workspace_path_denied_secret");

  const proposeDenied = await proposeAcceptWorkspaceFromBody({
    workspace_id: WS_ID,
    actor_id: ACTOR_A,
    workspace_capability: capWrite
  }, env);
  assert.equal(proposeDenied.error, "workspace_capability_scope_missing");
  assert.deepEqual(proposeDenied.missing, ["propose"]);
});

test("propose_accept freezes immutable snapshot digest; write/propose never move HEADs; race fails closed", async () => {
  const { db, r2, env } = await seedWorkspace();
  const capWrite = await mintCapability(ACTOR_A, "owner", ["ls", "read", "write_draft", "diff", "propose"]);

  const written = await writeDraftFromBody({
    workspace_id: WS_ID,
    path: "proposal/note.md",
    content: "ready for review",
    base_revision: null,
    actor_id: ACTOR_A,
    workspace_capability: capWrite
  }, env);
  assert.equal(written.ok, true);
  assert.equal(written.chain_heads_mutated, false);
  assert.equal(written.path_heads_mutated, false);
  assert.equal(written.stones_written, 0);

  const chainHeadsBefore = db.chainHeads.size;
  const pathHeadsBefore = db.pathHeads.size;

  let createdStoneBody = null;
  const proposed = await proposeAcceptWorkspaceFromBody({
    workspace_id: WS_ID,
    actor_id: ACTOR_A,
    workspace_capability: capWrite,
    title: "Review packet",
    paths: ["proposal/note.md"]
  }, env, {
    createStone: async body => {
      createdStoneBody = body;
      assert.equal(body.set_as_head, false);
      assert.equal(body.metadata.accepted_state_authority, false);
      assert.match(body.content, /tip_vector_digest/);
      return { ok: true, stone_hash: "a".repeat(64) };
    }
  });
  assert.equal(proposed.ok, true, proposed.error);
  assert.ok(proposed.workspace_snapshot_id);
  assert.ok(proposed.tip_vector_digest);
  assert.equal(proposed.accepted_state_authority, false);
  assert.equal(proposed.chain_heads_mutated, false);
  assert.equal(proposed.path_heads_mutated, false);
  assert.equal(proposed.stones_written, 1);
  assert.equal(proposed.proposal_packet.workspace_snapshot_id, proposed.workspace_snapshot_id);
  assert.equal(proposed.proposal_packet.tip_vector_digest, proposed.tip_vector_digest);
  assert.equal(proposed.proposal_packet.accepted_state_authority, false);
  assert.equal(createdStoneBody.metadata.workspace_snapshot_id, proposed.workspace_snapshot_id);
  assert.equal(db.snapshots.has(proposed.workspace_snapshot_id), true);
  assert.equal(db.chainHeads.size, chainHeadsBefore);
  assert.equal(db.pathHeads.size, pathHeadsBefore);

  // Snapshot race: mutate tip between compile reads via instrumented freeze path.
  const tipKey = db._tipKey(WS_ID, "proposal/note.md");
  const originalTip = { ...db.tips.get(tipKey) };
  let reads = 0;
  const racingDb = {
    prepare(sql) {
      if (sql.includes("FROM workspace_tips WHERE workspace_id = ? AND path = ?")) {
        return {
          bind(...args) {
            return {
              async first() {
                reads += 1;
                if (reads === 2) {
                  // Second read during freeze recheck sees a different tip.
                  return {
                    ...originalTip,
                    revision_id: "raced-revision",
                    content_hash: "raced-hash"
                  };
                }
                return db.prepare(sql).bind(...args).first();
              }
            };
          }
        };
      }
      return db.prepare(sql);
    }
  };
  const raced = await freezeWorkspaceSnapshot(racingDb, {
    workspace_id: WS_ID,
    created_by: ACTOR_A,
    paths: ["proposal/note.md"]
  });
  assert.equal(raced.error, "workspace_snapshot_race");
  assert.equal(raced.accepted_state_authority, false);

  // Direct race through propose_accept after concurrent write.
  const updated = await writeDraft(db, r2, {
    workspace_id: WS_ID,
    path: "proposal/note.md",
    content: "changed during propose",
    base_revision: written.revision_id,
    actor_id: ACTOR_A
  });
  assert.equal(updated.ok, true);

  // Re-propose after change succeeds with new digest (immutable prior snapshot retained).
  const proposed2 = await proposeAcceptWorkspaceFromBody({
    workspace_id: WS_ID,
    actor_id: ACTOR_A,
    workspace_capability: capWrite,
    paths: ["proposal/note.md"]
  }, env, {
    createStone: async () => ({ ok: true, stone_hash: "b".repeat(64) })
  });
  assert.equal(proposed2.ok, true);
  assert.notEqual(proposed2.tip_vector_digest, proposed.tip_vector_digest);
  assert.notEqual(proposed2.workspace_snapshot_id, proposed.workspace_snapshot_id);
  assert.equal(proposed2.chain_heads_mutated, false);
  assert.equal(proposed2.path_heads_mutated, false);
});

test("optional GitHub diff/propose reports immutable observed commit SHA", async () => {
  const db = new FakeWorkspaceD1();
  const r2 = new FakeR2();
  const env = testEnv(db, r2);
  const wsId = "ws:v775c-gh";
  const ownerCap = await mintCapability(ACTOR_A, "owner", ["write_draft", "ls", "read", "diff", "propose"], wsId);

  const created = await createWorkspaceFromBody({
    name: "GH bind",
    created_by: ACTOR_A,
    workspace_id: wsId,
    workspace_capability: ownerCap,
    github_bind: { owner: "nothinginfinity", repo: "cairnstone-v6", ref: "main" }
  }, env);
  assert.equal(created.ok, true);

  const written = await writeDraftFromBody({
    workspace_id: wsId,
    path: "src/workspace.js",
    content: "export const x = 1;\n",
    base_revision: null,
    actor_id: ACTOR_A,
    workspace_capability: ownerCap
  }, env);
  assert.equal(written.ok, true);

  const resolveOk = async (owner, repo, ref) => ({
    ok: true,
    requested_ref: ref,
    observed_commit_sha: OBSERVED_SHA,
    already_resolved: false
  });

  const diff = await diffWorkspaceFromBody({
    workspace_id: wsId,
    path: "src/workspace.js",
    actor_id: ACTOR_A,
    workspace_capability: ownerCap
  }, env, { resolveGitHubCommit: resolveOk });
  assert.equal(diff.ok, true);
  assert.equal(diff.observed_commit_sha, OBSERVED_SHA);
  assert.equal(diff.github_bind.observed_commit_sha, OBSERVED_SHA);
  assert.equal(diff.github_bind.requested_ref, "main");
  assert.equal(diff.github_bind.transport_only, true);

  const proposed = await proposeAcceptWorkspaceFromBody({
    workspace_id: wsId,
    actor_id: ACTOR_A,
    workspace_capability: ownerCap,
    github_pr: { number: 8, url: "https://github.com/nothinginfinity/cairnstone-v6/pull/8" }
  }, env, {
    resolveGitHubCommit: resolveOk,
    createStone: async body => {
      assert.equal(body.commit, OBSERVED_SHA);
      assert.equal(body.metadata.observed_commit_sha, OBSERVED_SHA);
      return { ok: true, stone_hash: "c".repeat(64) };
    }
  });
  assert.equal(proposed.ok, true);
  assert.equal(proposed.observed_commit_sha, OBSERVED_SHA);
  assert.equal(proposed.proposal_packet.github_pr.number, 8);
  assert.equal(proposed.proposal_packet.github_pr.observed_commit_sha, OBSERVED_SHA);
  assert.equal(proposed.accepted_state_authority, false);

  const unresolved = await diffWorkspaceFromBody({
    workspace_id: wsId,
    path: "src/workspace.js",
    actor_id: ACTOR_A,
    workspace_capability: ownerCap
  }, env, {
    resolveGitHubCommit: async () => ({ ok: false, error: "github_commit_resolution_failed", detail: "404" })
  });
  assert.equal(unresolved.error, "github_commit_resolution_failed");
});

test("MCP handlers fail closed without workspace secret (no mailbox/operator fallback)", async () => {
  const { db, r2 } = await seedWorkspace();
  const cap = await mintCapability(ACTOR_A, "owner", ["read", "ls"]);
  const env = {
    CAIRNSTONE_DB: db,
    CAIRNSTONE_RAW: r2,
    CAIRNSTONE_MAILBOX_CAPABILITY_SECRET: "mailbox",
    CAIRNSTONE_OPERATOR_TOKEN: "operator"
  };
  const result = await readWorkspaceFromBody({
    workspace_id: WS_ID,
    path: "shared/plan.md",
    actor_id: ACTOR_A,
    workspace_capability: cap
  }, env);
  assert.equal(result.error, "workspace_capability_not_configured");
});
