import test from "node:test";
import assert from "node:assert/strict";
import {
  WORKSPACE_BROKER_TOOL_IDS,
  WORKSPACE_MUTATION_TOOL_IDS,
  WORKSPACE_READ_TOOL_IDS,
  WORKSPACE_ROLE_SCOPES,
  canonicalizeWorkspacePath,
  capabilityHasExactScopes,
  createWorkspace,
  issueWorkspaceCapabilityFromBody,
  narrowScopesToMembership,
  readDraft,
  upsertWorkspaceMember,
  verifyWorkspaceCapability,
  workspaceCapabilitySecret,
  writeDraft
} from "../src/workspace.js";
import {
  DEFAULT_TOOL_BROKER_REGISTRY,
  toolRegistryFromBody
} from "../src/model-router.js";
import { listAutomaticReadToolIds } from "../src/delegate-loop.js";

const TEST_ENV = { CAIRNSTONE_WORKSPACE_CAPABILITY_SECRET: "workspace-test-secret-v775a" };
const ACTOR_A = "chatgpt:cairnstone-v6";
const ACTOR_B = "claude:cairnstone-v6";
const WS_ID = "ws:v775a-demo";

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
            throw new Error(`Unexpected run SQL: ${sql}`);
          },
          async first() {
            if (sql.includes("FROM workspace_members")) {
              const [workspaceId, actorId] = args;
              return db.members.get(db._memberKey(workspaceId, actorId)) || null;
            }
            if (sql.includes("FROM workspace_tips")) {
              const [workspaceId, path] = args;
              return db.tips.get(db._tipKey(workspaceId, path)) || null;
            }
            throw new Error(`Unexpected first SQL: ${sql}`);
          }
        };
      }
    };
  }
}

async function seedWorkspace() {
  const db = new FakeWorkspaceD1();
  const r2 = new FakeR2();
  const created = await createWorkspace(db, {
    workspace_id: WS_ID,
    name: "V775a demo",
    created_by: ACTOR_A
  });
  assert.equal(created.ok, true);
  await upsertWorkspaceMember(db, { workspace_id: WS_ID, actor_id: ACTOR_B, role: "drafter" });
  return { db, r2 };
}

test("workspace capability secret fails closed and never falls back to mailbox/operator secrets", () => {
  assert.equal(workspaceCapabilitySecret({}), null);
  assert.equal(workspaceCapabilitySecret({
    CAIRNSTONE_MAILBOX_CAPABILITY_SECRET: "mailbox",
    CAIRNSTONE_OPERATOR_TOKEN: "operator"
  }), null);
  assert.equal(workspaceCapabilitySecret(TEST_ENV), "workspace-test-secret-v775a");
});

test("verifyWorkspaceCapability fails closed when secret missing", async () => {
  const issued = await issueWorkspaceCapabilityFromBody({
    principal_actor_id: ACTOR_A,
    workspace_id: WS_ID,
    membership_role: "drafter",
    scopes: ["read", "write_draft"]
  }, TEST_ENV);
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
  }, TEST_ENV);
  assert.equal(issued.ok, true);
  assert.equal(issued.policy.write_draft_implies_propose, false);

  const ok = await verifyWorkspaceCapability(issued.workspace_capability, {
    expectedActorId: ACTOR_A,
    expectedWorkspaceId: WS_ID,
    requiredScopes: ["write_draft"],
    path: "drafts/a.md"
  }, TEST_ENV);
  assert.equal(ok.ok, true);
  assert.equal(ok.workspace_id, WS_ID);
  assert.deepEqual(ok.scopes, ["ls", "read", "write_draft"]);

  const wrongActor = await verifyWorkspaceCapability(issued.workspace_capability, {
    expectedActorId: ACTOR_B,
    expectedWorkspaceId: WS_ID,
    requiredScopes: ["read"]
  }, TEST_ENV);
  assert.equal(wrongActor.error, "workspace_capability_principal_mismatch");

  const wrongWs = await verifyWorkspaceCapability(issued.workspace_capability, {
    expectedActorId: ACTOR_A,
    expectedWorkspaceId: "ws:other",
    requiredScopes: ["read"]
  }, TEST_ENV);
  assert.equal(wrongWs.error, "workspace_capability_workspace_mismatch");

  const outsidePrefix = await verifyWorkspaceCapability(issued.workspace_capability, {
    expectedActorId: ACTOR_A,
    expectedWorkspaceId: WS_ID,
    requiredScopes: ["read"],
    path: "other/a.md"
  }, TEST_ENV);
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
  }, TEST_ENV);
  assert.equal(issued.ok, true);
  assert.equal(capabilityHasExactScopes(issued.scopes, ["write_draft"]), true);
  assert.equal(capabilityHasExactScopes(issued.scopes, ["propose"]), false);

  const proposeDenied = await verifyWorkspaceCapability(issued.workspace_capability, {
    expectedActorId: ACTOR_A,
    expectedWorkspaceId: WS_ID,
    requiredScopes: ["propose"]
  }, TEST_ENV);
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
  // 27 prior + 8 workspace stubs
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

  const automatic = listAutomaticReadToolIds(DEFAULT_TOOL_BROKER_REGISTRY);
  for (const toolId of Object.values(WORKSPACE_BROKER_TOOL_IDS)) {
    assert.ok(!automatic.includes(toolId), `${toolId} must not be automatic-read`);
  }
});
