import test from "node:test";
import assert from "node:assert/strict";
import { sha256Text } from "../src/agent-bootstrap.js";
import {
  WORKSPACE_TREE_BROKER_TOOL_IDS,
  WORKSPACE_TREE_MUTATION_TOOL_IDS,
  WORKSPACE_TREE_MCP_TOOL_DEFINITIONS,
  deleteDraft,
  deleteDraftFromBody,
  hydrateWorkspaceFromGit,
  recordGitzipTransport,
  renameDraft,
  setGithubTransport,
  treeDiff,
  treeLs,
  writeDraftFromContentRef
} from "../src/workspace-tree.js";
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

const TEST_ENV_SECRET = { CAIRNSTONE_WORKSPACE_CAPABILITY_SECRET: "workspace-tree-test-secret-v777d" };
const ACTOR_A = "chatgpt:cairnstone-v6";
const ACTOR_B = "claude:cairnstone-v6";
const WS_ID = "ws:v777d-demo";
const COMMIT_SHA = "a1b2c3d4e5f60718293a4b5c6d7e8f901234abcd";
const BLOB_SMALL = "1111111111111111111111111111111111111111";
const BLOB_LARGE = "2222222222222222222222222222222222222222";
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

/**
 * Extended Fake D1 for V7.7.7d tree ops + legacy workspace.js seeding.
 * Tracks chain_heads / path_heads SQL attempts (must stay empty).
 */
class FakeWorkspaceTreeD1 {
  constructor() {
    this.workspaces = new Map();
    this.members = new Map();
    this.revisions = new Map();
    this.tips = new Map();
    this.snapshots = new Map();
    this.treeOps = new Map();
    this.gitzipReceipts = new Map();
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
              if (sql.includes("content_encoding") || sql.includes("rename_to_path") || args.length >= 13) {
                const [
                  revisionId, workspaceId, path, parentRevisionId, contentHash, contentBytes,
                  actorId, createdAt, op, contentEncoding, contentRef, gitBlobSha, renameToPath
                ] = args;
                if (!db.revisions.has(revisionId)) {
                  db.revisions.set(revisionId, {
                    revision_id: revisionId,
                    workspace_id: workspaceId,
                    path,
                    parent_revision_id: parentRevisionId,
                    content_hash: contentHash,
                    content_bytes: contentBytes,
                    actor_id: actorId,
                    created_at: createdAt,
                    op,
                    content_encoding: contentEncoding,
                    content_ref: contentRef,
                    git_blob_sha: gitBlobSha,
                    rename_to_path: renameToPath
                  });
                }
                return { success: true, meta: { changes: 1 } };
              }
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
                  created_at: createdAt,
                  op: "write",
                  content_encoding: "utf8_text",
                  content_ref: null,
                  git_blob_sha: null,
                  rename_to_path: null
                });
              }
              return { success: true, meta: { changes: 1 } };
            }
            if (sql.includes("INSERT INTO workspace_tips")) {
              if (sql.includes("content_encoding") || args.length >= 8) {
                const [
                  workspaceId, path, revisionId, contentHash, updatedAt,
                  contentEncoding, contentRef, gitBlobSha
                ] = args;
                const key = db._tipKey(workspaceId, path);
                if (db.tips.has(key)) throw new Error("UNIQUE constraint failed: workspace_tips");
                db.tips.set(key, {
                  workspace_id: workspaceId,
                  path,
                  revision_id: revisionId,
                  content_hash: contentHash,
                  updated_at: updatedAt,
                  content_encoding: contentEncoding || "utf8_text",
                  content_ref: contentRef || null,
                  git_blob_sha: gitBlobSha || null
                });
                return { success: true, meta: { changes: 1 } };
              }
              const [workspaceId, path, revisionId, contentHash, updatedAt] = args;
              const key = db._tipKey(workspaceId, path);
              if (db.tips.has(key)) throw new Error("UNIQUE constraint failed: workspace_tips");
              db.tips.set(key, {
                workspace_id: workspaceId,
                path,
                revision_id: revisionId,
                content_hash: contentHash,
                updated_at: updatedAt,
                content_encoding: "utf8_text",
                content_ref: null,
                git_blob_sha: null
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
            if (sql.includes("INSERT OR IGNORE INTO workspace_tree_ops")) {
              const [
                opId, workspaceId, op, actorId, fromPath, toPath,
                baseRevisionId, resultRevisionId, detailJson, createdAt
              ] = args;
              if (!db.treeOps.has(opId)) {
                db.treeOps.set(opId, {
                  op_id: opId,
                  workspace_id: workspaceId,
                  op,
                  actor_id: actorId,
                  from_path: fromPath,
                  to_path: toPath,
                  base_revision_id: baseRevisionId,
                  result_revision_id: resultRevisionId,
                  detail_json: detailJson,
                  created_at: createdAt
                });
              }
              return { success: true, meta: { changes: 1 } };
            }
            if (sql.includes("INSERT OR IGNORE INTO workspace_gitzip_transport_receipts")) {
              const [
                receiptId, workspaceId, codeSessionId, actorId, proposalSnapshotId,
                refsJson, expectedBase, observed, workingBranch, transportStatus, detailJson, createdAt
              ] = args;
              if (!db.gitzipReceipts.has(receiptId)) {
                db.gitzipReceipts.set(receiptId, {
                  receipt_id: receiptId,
                  workspace_id: workspaceId,
                  code_session_id: codeSessionId,
                  actor_id: actorId,
                  proposal_snapshot_id: proposalSnapshotId,
                  gitzip_content_refs_json: refsJson,
                  expected_base_sha: expectedBase,
                  observed_commit_sha: observed,
                  working_branch: workingBranch,
                  transport_status: transportStatus,
                  detail_json: detailJson,
                  created_at: createdAt,
                  accepted_state_authority: 0
                });
              }
              return { success: true, meta: { changes: 1 } };
            }
            if (sql.includes("UPDATE workspace_tips") && sql.includes("content_encoding")) {
              const [
                revisionId, contentHash, updatedAt, contentEncoding, contentRef, gitBlobSha,
                workspaceId, path, baseRevision
              ] = args;
              const key = db._tipKey(workspaceId, path);
              const tip = db.tips.get(key);
              if (!tip || tip.revision_id !== baseRevision) {
                return { success: true, meta: { changes: 0 } };
              }
              db.tips.set(key, {
                ...tip,
                revision_id: revisionId,
                content_hash: contentHash,
                updated_at: updatedAt,
                content_encoding: contentEncoding,
                content_ref: contentRef,
                git_blob_sha: gitBlobSha
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
            if (sql.includes("DELETE FROM workspace_tips")) {
              const [workspaceId, path, baseRevision] = args;
              const key = db._tipKey(workspaceId, path);
              const tip = db.tips.get(key);
              if (!tip || tip.revision_id !== baseRevision) {
                return { success: true, meta: { changes: 0 } };
              }
              db.tips.delete(key);
              return { success: true, meta: { changes: 1 } };
            }
            if (sql.includes("UPDATE workspaces SET github_bind_json")) {
              const [githubBindJson, updatedAt, workspaceId] = args;
              const row = db.workspaces.get(workspaceId);
              if (!row) return { success: true, meta: { changes: 0 } };
              db.workspaces.set(workspaceId, {
                ...row,
                github_bind_json: githubBindJson,
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
            if (sql.includes("INSERT INTO chain_heads") || sql.includes("UPDATE chain_heads")
              || sql.includes("INSERT INTO path_heads") || sql.includes("UPDATE path_heads")) {
              db.headMutationAttempts.push({ sql, args });
              throw new Error("HEAD mutation must not occur from workspace-tree ops");
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
            if (sql.includes("FROM workspace_capability_denylist")) {
              return null;
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
              const [workspaceId] = args;
              let rows = [...db.tips.values()].filter(row => row.workspace_id === workspaceId);
              if (sql.includes("path = ? OR path LIKE ?")) {
                const exact = args[1];
                const prefix = String(args[1] || "");
                rows = rows.filter(row => row.path === exact || row.path.startsWith(`${prefix}/`));
              }
              rows.sort((a, b) => a.path.localeCompare(b.path));
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

async function seedWorkspace(opts = {}) {
  const db = new FakeWorkspaceTreeD1();
  const r2 = new FakeR2();
  const created = await createWorkspace(db, {
    workspace_id: WS_ID,
    name: "V777d tree demo",
    created_by: ACTOR_A,
    github_bind: opts.github_bind || {
      owner: "nothinginfinity",
      repo: "cairnstone-v6",
      ref: "main",
      transport_only: true
    }
  });
  assert.equal(created.ok, true);
  await upsertWorkspaceMember(db, { workspace_id: WS_ID, actor_id: ACTOR_B, role: "drafter" });
  return { db, r2, env: testEnv(db, r2) };
}

test("deleteDraft CAS success + conflict on stale base_revision", async () => {
  const { db, r2 } = await seedWorkspace();
  const wrote = await writeDraft(db, r2, {
    workspace_id: WS_ID,
    path: "notes/a.md",
    content: "keep me briefly",
    base_revision: null,
    actor_id: ACTOR_A
  });
  assert.equal(wrote.ok, true);

  const deleted = await deleteDraft(db, {
    workspace_id: WS_ID,
    path: "notes/a.md",
    base_revision: wrote.revision_id,
    actor_id: ACTOR_A
  });
  assert.equal(deleted.ok, true);
  assert.equal(deleted.op, "delete");
  assert.equal(deleted.content_encoding, "tombstone");
  assert.equal(deleted.accepted_state_authority, false);
  assert.equal(deleted.chain_heads_mutated, false);
  assert.equal(deleted.path_heads_mutated, false);
  assert.equal(db.tips.has(db._tipKey(WS_ID, "notes/a.md")), false);
  assert.ok(db.treeOps.size >= 1);

  const conflict = await deleteDraft(db, {
    workspace_id: WS_ID,
    path: "notes/a.md",
    base_revision: wrote.revision_id,
    actor_id: ACTOR_A
  });
  assert.equal(conflict.ok, false);
  assert.equal(conflict.error, "workspace_conflict");
  assert.equal(conflict.accepted_state_authority, false);
});

test("renameDraft success + destination exists fail", async () => {
  const { db, r2 } = await seedWorkspace();
  const src = await writeDraft(db, r2, {
    workspace_id: WS_ID,
    path: "src/old.js",
    content: "export const x = 1;\n",
    base_revision: null,
    actor_id: ACTOR_A
  });
  assert.equal(src.ok, true);
  const dest = await writeDraft(db, r2, {
    workspace_id: WS_ID,
    path: "src/taken.js",
    content: "occupied",
    base_revision: null,
    actor_id: ACTOR_A
  });
  assert.equal(dest.ok, true);

  const renamed = await renameDraft(db, {
    workspace_id: WS_ID,
    from_path: "src/old.js",
    to_path: "src/new.js",
    base_revision: src.revision_id,
    actor_id: ACTOR_A
  });
  assert.equal(renamed.ok, true);
  assert.equal(renamed.from_path, "src/old.js");
  assert.equal(renamed.to_path, "src/new.js");
  assert.equal(renamed.op, "rename");
  assert.equal(renamed.accepted_state_authority, false);
  assert.equal(db.tips.has(db._tipKey(WS_ID, "src/old.js")), false);
  assert.equal(db.tips.has(db._tipKey(WS_ID, "src/new.js")), true);

  const blocked = await renameDraft(db, {
    workspace_id: WS_ID,
    from_path: "src/new.js",
    to_path: "src/taken.js",
    base_revision: renamed.revision_id,
    actor_id: ACTOR_A
  });
  assert.equal(blocked.ok, false);
  assert.equal(blocked.error, "workspace_rename_destination_exists");
  assert.equal(blocked.accepted_state_authority, false);
});

test("writeDraftFromContentRef create + CAS update", async () => {
  const { db } = await seedWorkspace();
  const contentSha = await sha256Text("git-blob:ref-demo");
  const ref = `git:nothinginfinity/cairnstone-v6@${COMMIT_SHA}:docs/big.bin`;

  const created = await writeDraftFromContentRef(db, {
    workspace_id: WS_ID,
    path: "docs/big.bin",
    content_ref: ref,
    content_bytes: 900000,
    content_sha256: contentSha,
    git_blob_sha: BLOB_LARGE,
    base_revision: null,
    actor_id: ACTOR_A
  });
  assert.equal(created.ok, true);
  assert.equal(created.content_encoding, "content_ref");
  assert.equal(created.content_ref, ref);
  assert.equal(created.git_blob_sha, BLOB_LARGE);
  assert.equal(created.raw_key, null);
  assert.equal(created.accepted_state_authority, false);

  const tip = db.tips.get(db._tipKey(WS_ID, "docs/big.bin"));
  assert.equal(tip.content_encoding, "content_ref");
  assert.equal(tip.content_ref, ref);

  const nextSha = await sha256Text("git-blob:ref-demo-v2");
  const nextRef = `git:nothinginfinity/cairnstone-v6@${COMMIT_SHA}:docs/big-v2.bin`;
  const updated = await writeDraftFromContentRef(db, {
    workspace_id: WS_ID,
    path: "docs/big.bin",
    content_ref: nextRef,
    content_bytes: 900001,
    content_sha256: nextSha,
    git_blob_sha: BLOB_LARGE,
    base_revision: created.revision_id,
    actor_id: ACTOR_A
  });
  assert.equal(updated.ok, true);
  assert.equal(updated.content_ref, nextRef);
  assert.equal(updated.parent_revision_id, created.revision_id);

  const stale = await writeDraftFromContentRef(db, {
    workspace_id: WS_ID,
    path: "docs/big.bin",
    content_ref: nextRef,
    content_bytes: 1,
    content_sha256: nextSha,
    base_revision: created.revision_id,
    actor_id: ACTOR_A
  });
  assert.equal(stale.ok, false);
  assert.equal(stale.error, "workspace_conflict");
});

test("hydrateWorkspaceFromGit skips existing, content_ref for large, optional inline small", async () => {
  const { db, r2 } = await seedWorkspace();
  const existing = await writeDraft(db, r2, {
    workspace_id: WS_ID,
    path: "pkg/keep.js",
    content: "already here",
    base_revision: null,
    actor_id: ACTOR_A
  });
  assert.equal(existing.ok, true);

  const hydrated = await hydrateWorkspaceFromGit(db, r2, {
    workspace_id: WS_ID,
    actor_id: ACTOR_A,
    owner: "nothinginfinity",
    repo: "cairnstone-v6",
    commit_sha: COMMIT_SHA,
    inline_max_bytes: 1000
  }, {
    fetchGitHubRepoTree: async () => ({
      ok: true,
      entries: [
        { path: "pkg/keep.js", type: "blob", size: 20, sha: BLOB_SMALL },
        { path: "pkg/small.js", type: "blob", size: 40, sha: BLOB_SMALL },
        { path: "pkg/large.bin", type: "blob", size: 500000, sha: BLOB_LARGE }
      ]
    }),
    fetchGitHubFile: async ({ path }) => {
      if (path === "pkg/small.js") return { content: "export const small = true;\n" };
      throw new Error(`unexpected fetch path ${path}`);
    }
  });

  assert.equal(hydrated.ok, true);
  assert.equal(hydrated.transport_only, true);
  assert.equal(hydrated.accepted_state_authority, false);
  assert.equal(hydrated.skipped_count, 1);
  assert.equal(hydrated.skipped[0].path, "pkg/keep.js");
  assert.equal(hydrated.written_count, 1);
  assert.equal(hydrated.written[0].path, "pkg/small.js");
  assert.equal(hydrated.written[0].content_encoding, "utf8_text");
  assert.equal(hydrated.content_ref_count, 1);
  assert.equal(hydrated.content_refs[0].path, "pkg/large.bin");
  assert.ok(String(hydrated.content_refs[0].content_ref).startsWith("git:nothinginfinity/cairnstone-v6@"));
  assert.equal(db.headMutationAttempts.length, 0);
});

test("setGithubTransport records observed_commit_sha with transport_only", async () => {
  const { db } = await seedWorkspace();
  const result = await setGithubTransport(db, {
    workspace_id: WS_ID,
    actor_id: ACTOR_A,
    working_branch: "cursor/v777d-repo-scale-working-tree-64df"
  }, {
    resolveGitHubCommit: async (owner, repo, ref) => {
      assert.equal(owner, "nothinginfinity");
      assert.equal(repo, "cairnstone-v6");
      assert.equal(ref, "cursor/v777d-repo-scale-working-tree-64df");
      return { ok: true, observed_commit_sha: OBSERVED_SHA, requested_ref: ref };
    }
  });

  assert.equal(result.ok, true);
  assert.equal(result.transport_only, true);
  assert.equal(result.accepted_state_authority, false);
  assert.equal(result.observed_commit_sha, OBSERVED_SHA);
  assert.equal(result.working_branch, "cursor/v777d-repo-scale-working-tree-64df");
  assert.equal(result.github_bind.transport_only, true);
  assert.equal(result.github_bind.observed_commit_sha, OBSERVED_SHA);

  const ws = db.workspaces.get(WS_ID);
  const bind = JSON.parse(ws.github_bind_json);
  assert.equal(bind.working_branch, "cursor/v777d-repo-scale-working-tree-64df");
  assert.equal(bind.observed_commit_sha, OBSERVED_SHA);
  assert.equal(bind.transport_only, true);
});

test("treeLs directories + files", async () => {
  const { db, r2 } = await seedWorkspace();
  await writeDraft(db, r2, {
    workspace_id: WS_ID,
    path: "src/a.js",
    content: "a",
    base_revision: null,
    actor_id: ACTOR_A
  });
  await writeDraftFromContentRef(db, {
    workspace_id: WS_ID,
    path: "src/nested/b.bin",
    content_ref: `git:o/r@${COMMIT_SHA}:src/nested/b.bin`,
    content_bytes: 10,
    content_sha256: await sha256Text("b"),
    base_revision: null,
    actor_id: ACTOR_A
  });

  const listed = await treeLs(db, { workspace_id: WS_ID, prefix: "src" });
  assert.equal(listed.ok, true);
  assert.equal(listed.file_count, 2);
  assert.ok(listed.directory_count >= 1);
  assert.ok(listed.entries.some(e => e.type === "directory" && e.path === "src/nested"));
  assert.ok(listed.files.some(f => f.path === "src/a.js" && f.content_encoding === "utf8_text"));
  assert.ok(listed.files.some(f => f.path === "src/nested/b.bin" && f.content_encoding === "content_ref"));
  assert.ok(listed.tip_vector_digest);
  assert.equal(listed.accepted_state_authority, false);
});

test("treeDiff added/modified/deleted", async () => {
  const { db, r2 } = await seedWorkspace();
  const a = await writeDraft(db, r2, {
    workspace_id: WS_ID,
    path: "keep.md",
    content: "v1",
    base_revision: null,
    actor_id: ACTOR_A
  });
  const b = await writeDraft(db, r2, {
    workspace_id: WS_ID,
    path: "gone.md",
    content: "bye",
    base_revision: null,
    actor_id: ACTOR_A
  });
  assert.equal(a.ok, true);
  assert.equal(b.ok, true);

  const against = [
    { path: "keep.md", revision_id: a.revision_id, content_hash: a.content_hash },
    { path: "gone.md", revision_id: b.revision_id, content_hash: b.content_hash },
    { path: "prior-only.md", revision_id: "rev-prior", content_hash: "c".repeat(64) }
  ];

  const a2 = await writeDraft(db, r2, {
    workspace_id: WS_ID,
    path: "keep.md",
    content: "v2",
    base_revision: a.revision_id,
    actor_id: ACTOR_A
  });
  assert.equal(a2.ok, true);
  await deleteDraft(db, {
    workspace_id: WS_ID,
    path: "gone.md",
    base_revision: b.revision_id,
    actor_id: ACTOR_A
  });
  const added = await writeDraft(db, r2, {
    workspace_id: WS_ID,
    path: "new.md",
    content: "fresh",
    base_revision: null,
    actor_id: ACTOR_A
  });
  assert.equal(added.ok, true);

  const diff = await treeDiff(db, { workspace_id: WS_ID, against_tip_vector: against });
  assert.equal(diff.ok, true);
  assert.equal(diff.summary.added, 1);
  assert.equal(diff.summary.modified, 1);
  assert.equal(diff.summary.deleted, 2);
  assert.ok(diff.added.some(t => t.path === "new.md"));
  assert.ok(diff.modified.some(m => m.path === "keep.md"));
  assert.ok(diff.deleted.some(t => t.path === "gone.md"));
  assert.ok(diff.deleted.some(t => t.path === "prior-only.md"));
  assert.equal(diff.accepted_state_authority, false);
});

test("recordGitzipTransport sets gitzip_success_is_not_accepted_state", async () => {
  const { db } = await seedWorkspace();
  const receipt = await recordGitzipTransport(db, {
    workspace_id: WS_ID,
    actor_id: ACTOR_A,
    gitzip_content_refs: [`gitzip:bundle@${COMMIT_SHA}:pkg/large.bin`],
    expected_base_sha: COMMIT_SHA,
    observed_commit_sha: OBSERVED_SHA,
    working_branch: "cursor/v777d-repo-scale-working-tree-64df",
    transport_status: "pushed"
  });
  assert.equal(receipt.ok, true);
  assert.equal(receipt.gitzip_success_is_not_accepted_state, true);
  assert.equal(receipt.gitzip_success_is_not_deploy, true);
  assert.equal(receipt.accepted_state_authority, false);
  assert.equal(receipt.chain_heads_mutated, false);
  assert.equal(receipt.path_heads_mutated, false);
  assert.equal(db.gitzipReceipts.size, 1);
  const row = [...db.gitzipReceipts.values()][0];
  assert.equal(row.accepted_state_authority, 0);
});

test("FromBody auth fail-closed without capability", async () => {
  const { env } = await seedWorkspace();
  const denied = await deleteDraftFromBody({
    workspace_id: WS_ID,
    path: "notes/a.md",
    base_revision: "rev-anything",
    actor_id: ACTOR_A
  }, env);
  assert.equal(denied.ok, false);
  assert.equal(denied.error, "workspace_capability_required");

  const withBadCap = await deleteDraftFromBody({
    workspace_id: WS_ID,
    path: "notes/a.md",
    base_revision: "rev-anything",
    actor_id: ACTOR_A,
    workspace_capability: "not-a-real-capability"
  }, env);
  assert.equal(withBadCap.ok, false);
});

test("broker: WORKSPACE_TREE_MUTATION_TOOL_IDS never in listAutomaticReadToolIds", () => {
  const registry = toolRegistryFromBody({});
  assert.equal(registry.ok, true);
  // V7.7.7e adds nine environment/sandbox/execution-receipt tools (58 -> 67).
  // V7.7.7f adds cairnstone_code_session_console_view (67 -> 68).
  // V7.7.10b adds 10 access-grant/attachment/task-run/forward tools (76 -> 86; V7.7.10c +1 intent router -> 87; V7.7.10d +7 executor/task-run tools -> 94).
  assert.equal(registry.total, 96);

  for (const toolId of WORKSPACE_TREE_MUTATION_TOOL_IDS) {
    const entry = registry.tools.find(item => item.tool_id === toolId);
    assert.ok(entry, `${toolId} must be registered`);
    assert.equal(entry.risk_class, "mutation");
    assert.equal(entry.authorization, "scoped_grant");
  }

  const automatic = listAutomaticReadToolIds(DEFAULT_TOOL_BROKER_REGISTRY);
  for (const toolId of Object.values(WORKSPACE_TREE_BROKER_TOOL_IDS)) {
    assert.ok(!automatic.includes(toolId), `${toolId} must not be automatic-read`);
  }
  for (const toolId of WORKSPACE_TREE_MUTATION_TOOL_IDS) {
    assert.ok(!automatic.includes(toolId), `${toolId} mutation must not be automatic-read`);
  }

  const names = mcpToolsForProfile(false).map(tool => tool.name);
  for (const def of WORKSPACE_TREE_MCP_TOOL_DEFINITIONS) {
    assert.ok(names.includes(def.name), `${def.name} must be in MCP catalog`);
  }
});

test("workspace-tree ops never mutate chain_heads or path_heads", async () => {
  const { db, r2 } = await seedWorkspace();
  db.chainHeads.set("cairnstone-v6", "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
  db.pathHeads.set("docs/PROTOCOL.md", "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb");
  const beforeChain = new Map(db.chainHeads);
  const beforePath = new Map(db.pathHeads);

  const wrote = await writeDraft(db, r2, {
    workspace_id: WS_ID,
    path: "x.md",
    content: "x",
    base_revision: null,
    actor_id: ACTOR_A
  });
  await writeDraftFromContentRef(db, {
    workspace_id: WS_ID,
    path: "y.bin",
    content_ref: `git:o/r@${COMMIT_SHA}:y.bin`,
    content_bytes: 2,
    content_sha256: await sha256Text("y"),
    base_revision: null,
    actor_id: ACTOR_A
  });
  await renameDraft(db, {
    workspace_id: WS_ID,
    from_path: "x.md",
    to_path: "z.md",
    base_revision: wrote.revision_id,
    actor_id: ACTOR_A
  });
  await setGithubTransport(db, {
    workspace_id: WS_ID,
    actor_id: ACTOR_A,
    working_branch: "main",
    observed_commit_sha: OBSERVED_SHA
  });
  await recordGitzipTransport(db, {
    workspace_id: WS_ID,
    actor_id: ACTOR_A,
    gitzip_content_refs: [`gitzip:x@${COMMIT_SHA}:y.bin`],
    transport_status: "recorded"
  });
  await treeLs(db, { workspace_id: WS_ID });
  await treeDiff(db, { workspace_id: WS_ID, against_tip_vector: [] });

  assert.deepEqual([...db.chainHeads.entries()], [...beforeChain.entries()]);
  assert.deepEqual([...db.pathHeads.entries()], [...beforePath.entries()]);
  assert.equal(db.headMutationAttempts.length, 0);
});
