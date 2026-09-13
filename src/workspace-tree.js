// V7.7.7d — Repo-scale persistent working tree + Git / GitZip backing.
//
// Extends Shared Agent Workspace (V7.7.5) with delete/rename/content_ref tips,
// Git hydrate, GitHub transport-only bind updates, tree ls/diff, and GitZip
// transport receipts. Draft plane only — NEVER accepted-state authority.
// GitHub / GitZip remain version-control transport — never HEADs / never deploy.

import { sha256Text, stableJson } from "./agent-bootstrap.js";
import {
  authorizeWorkspaceRequest,
  buildTipVector,
  canonicalizeWorkspacePath,
  computeRevisionId,
  computeTipVectorDigest,
  getWorkspace,
  getWorkspaceTip,
  hashWorkspaceContent,
  parseGithubBindJson,
  pathWithinPrefix,
  resolveGitHubCommitSha,
  writeDraft
} from "./workspace.js";

export const WORKSPACE_TREE_SLICE = "V7.7.7d";
export const WORKSPACE_TREE_OP_SCHEMA = "cairnstone-workspace-tree-op-v1";
export const WORKSPACE_GITZIP_RECEIPT_SCHEMA = "cairnstone-workspace-gitzip-receipt-v1";
export const WORKSPACE_CONTENT_REF_SCHEMA = "cairnstone-workspace-content-ref-v1";

export const WORKSPACE_HYDRATE_MAX_FILES = 200;
export const WORKSPACE_HYDRATE_INLINE_MAX_BYTES = 262144;
/** Max UTF-8 byte length of a content_ref pointer string (not file body). */
export const WORKSPACE_CONTENT_REF_MAX_BYTES = 2048;

/** Scheme-prefixed content pointer, e.g. git:owner/repo@sha:path or gitzip:… */
export const WORKSPACE_CONTENT_REF_ID_RE =
  /^[a-z][a-z0-9+.-]{0,31}:[^\s\0]{1,2000}$/i;

const FULL_SHA_RE = /^[0-9a-f]{40}$/i;
const CONTENT_SHA_RE = /^[0-9a-f]{64}$/i;
const GITHUB_NAME_RE = /^[A-Za-z0-9_.-]+$/;
const ACTOR_ID_RE = /^[a-z0-9][a-z0-9._-]{0,63}:[a-z0-9][a-z0-9._-]{0,127}$/i;
const WORKSPACE_ID_RE = /^ws:[a-z0-9][a-z0-9._-]{0,127}$/i;

export const WORKSPACE_TREE_BROKER_TOOL_IDS = Object.freeze({
  delete_draft: "cairnstone_workspace_delete_draft",
  rename_draft: "cairnstone_workspace_rename_draft",
  write_content_ref: "cairnstone_workspace_write_content_ref",
  hydrate_from_git: "cairnstone_workspace_hydrate_from_git",
  set_github_transport: "cairnstone_workspace_set_github_transport",
  tree_ls: "cairnstone_workspace_tree_ls",
  tree_diff: "cairnstone_workspace_tree_diff",
  record_gitzip_transport: "cairnstone_workspace_record_gitzip_transport"
});

export const WORKSPACE_TREE_MUTATION_TOOL_IDS = Object.freeze([
  WORKSPACE_TREE_BROKER_TOOL_IDS.delete_draft,
  WORKSPACE_TREE_BROKER_TOOL_IDS.rename_draft,
  WORKSPACE_TREE_BROKER_TOOL_IDS.write_content_ref,
  WORKSPACE_TREE_BROKER_TOOL_IDS.hydrate_from_git,
  WORKSPACE_TREE_BROKER_TOOL_IDS.set_github_transport,
  WORKSPACE_TREE_BROKER_TOOL_IDS.record_gitzip_transport
]);

export const WORKSPACE_TREE_READ_TOOL_IDS = Object.freeze([
  WORKSPACE_TREE_BROKER_TOOL_IDS.tree_ls,
  WORKSPACE_TREE_BROKER_TOOL_IDS.tree_diff
]);

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function actorId(value, field) {
  if (!isNonEmptyString(value)) throw new Error(`Missing required string: ${field}`);
  const text = value.trim();
  if (!ACTOR_ID_RE.test(text)) throw new Error(`Invalid actor id for ${field}`);
  return text;
}

function workspaceId(value, field = "workspace_id") {
  if (!isNonEmptyString(value)) throw new Error(`Missing required string: ${field}`);
  const text = value.trim();
  if (!WORKSPACE_ID_RE.test(text)) throw new Error(`Invalid workspace id for ${field}`);
  return text;
}

function clampInt(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isInteger(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

function utf8ByteLength(text) {
  return new TextEncoder().encode(String(text)).length;
}

function workspaceEnvBindings(env) {
  if (!env?.CAIRNSTONE_DB) return { ok: false, error: "missing_d1_binding", binding: "CAIRNSTONE_DB" };
  if (!env?.CAIRNSTONE_RAW) return { ok: false, error: "missing_r2_binding", binding: "CAIRNSTONE_RAW" };
  return { ok: true, db: env.CAIRNSTONE_DB, r2: env.CAIRNSTONE_RAW };
}

function requireActorField(body, field) {
  try {
    return { ok: true, value: actorId(body?.[field], field) };
  } catch (error) {
    return {
      ok: false,
      error: "invalid_workspace_actor",
      detail: String(error.message || error),
      field
    };
  }
}

function authorityFalse() {
  return {
    accepted_state_authority: false,
    chain_heads_mutated: false,
    path_heads_mutated: false
  };
}

/** CAS conflict helper: returns current tip identity (never last-write-wins). */
export function conflictResult(tip) {
  return {
    ok: false,
    error: "workspace_conflict",
    current_tip: tip
      ? {
        revision_id: tip.revision_id,
        content_hash: tip.content_hash,
        path: tip.path,
        updated_at: tip.updated_at || null,
        content_encoding: tip.content_encoding || null,
        content_ref: tip.content_ref || null,
        git_blob_sha: tip.git_blob_sha || null
      }
      : null,
    ...authorityFalse()
  };
}

function normalizeBaseRevision(base_revision) {
  if (base_revision === undefined || base_revision === null || base_revision === "") {
    return { ok: true, value: null };
  }
  if (!isNonEmptyString(base_revision)) return { ok: false, error: "invalid_base_revision" };
  return { ok: true, value: String(base_revision).trim() };
}

function validateContentRef(content_ref) {
  if (!isNonEmptyString(content_ref)) {
    return { ok: false, error: "invalid_workspace_content_ref", detail: "required" };
  }
  const text = String(content_ref).trim();
  const bytes = utf8ByteLength(text);
  if (bytes > WORKSPACE_CONTENT_REF_MAX_BYTES) {
    return {
      ok: false,
      error: "workspace_content_ref_too_large",
      max_bytes: WORKSPACE_CONTENT_REF_MAX_BYTES,
      bytes
    };
  }
  if (!WORKSPACE_CONTENT_REF_ID_RE.test(text)) {
    return { ok: false, error: "invalid_workspace_content_ref", detail: "id_pattern" };
  }
  return { ok: true, content_ref: text, bytes };
}

function buildGitContentRef(owner, repo, commitSha, path) {
  return `git:${owner}/${repo}@${commitSha}:${path}`;
}

async function getExtendedWorkspaceTip(db, workspace_id, path) {
  return await db.prepare(
    `SELECT workspace_id, path, revision_id, content_hash, updated_at,
            content_encoding, content_ref, git_blob_sha
     FROM workspace_tips WHERE workspace_id = ? AND path = ?`
  ).bind(workspace_id, path).first() || null;
}

async function listExtendedWorkspaceTips(db, workspace_id, prefix = null) {
  let sql = `SELECT workspace_id, path, revision_id, content_hash, updated_at,
                    content_encoding, content_ref, git_blob_sha
             FROM workspace_tips WHERE workspace_id = ?`;
  const binds = [workspace_id];
  if (prefix !== undefined && prefix !== null && prefix !== "") {
    const prefixResult = canonicalizeWorkspacePath(prefix);
    if (!prefixResult.ok) return prefixResult;
    sql += ` AND (path = ? OR path LIKE ?)`;
    binds.push(prefixResult.path, `${prefixResult.path}/%`);
  }
  sql += ` ORDER BY path ASC`;
  const result = await db.prepare(sql).bind(...binds).all();
  return { ok: true, tips: result?.results || [] };
}

async function insertTreeOp(db, {
  workspace_id,
  op,
  actor_id,
  from_path = null,
  to_path = null,
  base_revision_id = null,
  result_revision_id = null,
  detail = {}
} = {}) {
  const createdAt = new Date().toISOString();
  const opId = await sha256Text(stableJson({
    schema: WORKSPACE_TREE_OP_SCHEMA,
    workspace_id,
    op,
    actor_id,
    from_path,
    to_path,
    base_revision_id,
    result_revision_id,
    detail,
    created_at: createdAt,
    slice: WORKSPACE_TREE_SLICE
  }));
  await db.prepare(
    `INSERT OR IGNORE INTO workspace_tree_ops
      (op_id, workspace_id, op, actor_id, from_path, to_path,
       base_revision_id, result_revision_id, detail_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(
    opId,
    workspace_id,
    op,
    actor_id,
    from_path,
    to_path,
    base_revision_id,
    result_revision_id,
    stableJson(detail || {}),
    createdAt
  ).run();
  return { op_id: opId, created_at: createdAt };
}

async function insertRevisionRow(db, {
  revision_id,
  workspace_id,
  path,
  parent_revision_id,
  content_hash,
  content_bytes,
  actor_id,
  created_at,
  op,
  content_encoding,
  content_ref = null,
  git_blob_sha = null,
  rename_to_path = null
}) {
  await db.prepare(
    `INSERT OR IGNORE INTO workspace_revisions
      (revision_id, workspace_id, path, parent_revision_id, content_hash, content_bytes,
       actor_id, created_at, op, content_encoding, content_ref, git_blob_sha, rename_to_path)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(
    revision_id,
    workspace_id,
    path,
    parent_revision_id,
    content_hash,
    content_bytes,
    actor_id,
    created_at,
    op,
    content_encoding,
    content_ref,
    git_blob_sha,
    rename_to_path
  ).run();
}

async function insertTipRow(db, {
  workspace_id,
  path,
  revision_id,
  content_hash,
  updated_at,
  content_encoding,
  content_ref = null,
  git_blob_sha = null
}) {
  await db.prepare(
    `INSERT INTO workspace_tips
      (workspace_id, path, revision_id, content_hash, updated_at,
       content_encoding, content_ref, git_blob_sha)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(
    workspace_id,
    path,
    revision_id,
    content_hash,
    updated_at,
    content_encoding,
    content_ref,
    git_blob_sha
  ).run();
}

async function updateTipCas(db, {
  workspace_id,
  path,
  base_revision,
  revision_id,
  content_hash,
  updated_at,
  content_encoding,
  content_ref = null,
  git_blob_sha = null
}) {
  const updated = await db.prepare(
    `UPDATE workspace_tips
     SET revision_id = ?, content_hash = ?, updated_at = ?,
         content_encoding = ?, content_ref = ?, git_blob_sha = ?
     WHERE workspace_id = ? AND path = ? AND revision_id = ?`
  ).bind(
    revision_id,
    content_hash,
    updated_at,
    content_encoding,
    content_ref,
    git_blob_sha,
    workspace_id,
    path,
    base_revision
  ).run();
  return updated?.meta?.changes ?? updated?.changes ?? 0;
}

async function deleteTipCas(db, workspace_id, path, base_revision) {
  const deleted = await db.prepare(
    `DELETE FROM workspace_tips WHERE workspace_id = ? AND path = ? AND revision_id = ?`
  ).bind(workspace_id, path, base_revision).run();
  return deleted?.meta?.changes ?? deleted?.changes ?? 0;
}

function syntheticDirectoriesFromPaths(paths, prefix = null) {
  const dirs = new Set();
  for (const path of paths) {
    const parts = String(path).split("/");
    let acc = "";
    for (let i = 0; i < parts.length - 1; i += 1) {
      acc = acc ? `${acc}/${parts[i]}` : parts[i];
      if (prefix) {
        if (acc === prefix || acc.startsWith(`${prefix}/`)) dirs.add(acc);
      } else {
        dirs.add(acc);
      }
    }
  }
  return [...dirs].sort((a, b) => a.localeCompare(b));
}

/**
 * CAS delete_draft: tip must match base_revision; inserts tombstone revision;
 * deletes tip under CAS; records workspace_tree_ops. Never HEADs.
 */
export async function deleteDraft(db, {
  workspace_id,
  path,
  base_revision,
  actor_id
} = {}) {
  let wsId;
  let actor;
  try {
    wsId = workspaceId(workspace_id);
    actor = actorId(actor_id, "actor_id");
  } catch (error) {
    return { ok: false, error: "invalid_workspace_delete", detail: String(error.message || error) };
  }

  const pathResult = canonicalizeWorkspacePath(path);
  if (!pathResult.ok) return pathResult;
  const canonicalPath = pathResult.path;

  const baseNorm = normalizeBaseRevision(base_revision);
  if (baseNorm.ok === false) return baseNorm;
  if (baseNorm.value === null) {
    return { ok: false, error: "base_revision_required_for_delete", ...authorityFalse() };
  }
  const baseRevision = baseNorm.value;

  const tip = await getExtendedWorkspaceTip(db, wsId, canonicalPath);
  if (!tip || tip.revision_id !== baseRevision) {
    return conflictResult(tip);
  }

  const now = new Date().toISOString();
  const contentHash = await hashWorkspaceContent("");
  const revisionId = await computeRevisionId({
    workspace_id: wsId,
    path: canonicalPath,
    parent_revision_id: tip.revision_id,
    content_hash: contentHash,
    actor_id: actor
  });

  await insertRevisionRow(db, {
    revision_id: revisionId,
    workspace_id: wsId,
    path: canonicalPath,
    parent_revision_id: tip.revision_id,
    content_hash: contentHash,
    content_bytes: 0,
    actor_id: actor,
    created_at: now,
    op: "delete",
    content_encoding: "tombstone",
    content_ref: null,
    git_blob_sha: null,
    rename_to_path: null
  });

  const changes = await deleteTipCas(db, wsId, canonicalPath, baseRevision);
  if (!changes) {
    const raced = await getExtendedWorkspaceTip(db, wsId, canonicalPath);
    return conflictResult(raced);
  }

  await db.prepare(
    `UPDATE workspaces SET updated_at = ? WHERE workspace_id = ?`
  ).bind(now, wsId).run();

  const treeOp = await insertTreeOp(db, {
    workspace_id: wsId,
    op: "delete",
    actor_id: actor,
    from_path: canonicalPath,
    to_path: null,
    base_revision_id: baseRevision,
    result_revision_id: revisionId,
    detail: { content_encoding: "tombstone" }
  });

  return {
    ok: true,
    workspace_id: wsId,
    path: canonicalPath,
    revision_id: revisionId,
    parent_revision_id: tip.revision_id,
    content_hash: contentHash,
    content_encoding: "tombstone",
    op: "delete",
    op_id: treeOp.op_id,
    actor_id: actor,
    created_at: now,
    ...authorityFalse()
  };
}

/**
 * CAS rename_draft: source tip must match base_revision; dest must not exist.
 * Moves tip source→dest; records rename revision + tree_ops. Never HEADs.
 */
export async function renameDraft(db, {
  workspace_id,
  from_path,
  to_path,
  base_revision,
  actor_id
} = {}) {
  let wsId;
  let actor;
  try {
    wsId = workspaceId(workspace_id);
    actor = actorId(actor_id, "actor_id");
  } catch (error) {
    return { ok: false, error: "invalid_workspace_rename", detail: String(error.message || error) };
  }

  const fromResult = canonicalizeWorkspacePath(from_path);
  if (!fromResult.ok) return fromResult;
  const toResult = canonicalizeWorkspacePath(to_path);
  if (!toResult.ok) return toResult;
  if (fromResult.path === toResult.path) {
    return { ok: false, error: "workspace_rename_same_path", path: fromResult.path, ...authorityFalse() };
  }

  const baseNorm = normalizeBaseRevision(base_revision);
  if (baseNorm.ok === false) return baseNorm;
  if (baseNorm.value === null) {
    return { ok: false, error: "base_revision_required_for_rename", ...authorityFalse() };
  }
  const baseRevision = baseNorm.value;

  const sourceTip = await getExtendedWorkspaceTip(db, wsId, fromResult.path);
  if (!sourceTip || sourceTip.revision_id !== baseRevision) {
    return conflictResult(sourceTip);
  }

  const destTip = await getExtendedWorkspaceTip(db, wsId, toResult.path);
  if (destTip) {
    return {
      ok: false,
      error: "workspace_rename_destination_exists",
      to_path: toResult.path,
      current_tip: {
        revision_id: destTip.revision_id,
        content_hash: destTip.content_hash,
        path: destTip.path
      },
      ...authorityFalse()
    };
  }

  const now = new Date().toISOString();
  const contentHash = sourceTip.content_hash;
  const revisionId = await computeRevisionId({
    workspace_id: wsId,
    path: toResult.path,
    parent_revision_id: sourceTip.revision_id,
    content_hash: contentHash,
    actor_id: actor
  });

  await insertRevisionRow(db, {
    revision_id: revisionId,
    workspace_id: wsId,
    path: fromResult.path,
    parent_revision_id: sourceTip.revision_id,
    content_hash: contentHash,
    content_bytes: 0,
    actor_id: actor,
    created_at: now,
    op: "rename",
    content_encoding: sourceTip.content_encoding || "utf8_text",
    content_ref: sourceTip.content_ref || null,
    git_blob_sha: sourceTip.git_blob_sha || null,
    rename_to_path: toResult.path
  });

  const deleted = await deleteTipCas(db, wsId, fromResult.path, baseRevision);
  if (!deleted) {
    const raced = await getExtendedWorkspaceTip(db, wsId, fromResult.path);
    return conflictResult(raced);
  }

  try {
    await insertTipRow(db, {
      workspace_id: wsId,
      path: toResult.path,
      revision_id: revisionId,
      content_hash: contentHash,
      updated_at: now,
      content_encoding: sourceTip.content_encoding || "utf8_text",
      content_ref: sourceTip.content_ref || null,
      git_blob_sha: sourceTip.git_blob_sha || null
    });
  } catch (error) {
    // Dest raced into existence after our existence check — surface conflict.
    const racedDest = await getExtendedWorkspaceTip(db, wsId, toResult.path);
    return {
      ok: false,
      error: "workspace_rename_destination_exists",
      to_path: toResult.path,
      detail: String(error.message || error),
      current_tip: racedDest
        ? {
          revision_id: racedDest.revision_id,
          content_hash: racedDest.content_hash,
          path: racedDest.path
        }
        : null,
      ...authorityFalse()
    };
  }

  await db.prepare(
    `UPDATE workspaces SET updated_at = ? WHERE workspace_id = ?`
  ).bind(now, wsId).run();

  const treeOp = await insertTreeOp(db, {
    workspace_id: wsId,
    op: "rename",
    actor_id: actor,
    from_path: fromResult.path,
    to_path: toResult.path,
    base_revision_id: baseRevision,
    result_revision_id: revisionId,
    detail: {}
  });

  return {
    ok: true,
    workspace_id: wsId,
    from_path: fromResult.path,
    to_path: toResult.path,
    revision_id: revisionId,
    parent_revision_id: sourceTip.revision_id,
    content_hash: contentHash,
    content_encoding: sourceTip.content_encoding || "utf8_text",
    content_ref: sourceTip.content_ref || null,
    git_blob_sha: sourceTip.git_blob_sha || null,
    op: "rename",
    op_id: treeOp.op_id,
    actor_id: actor,
    created_at: now,
    ...authorityFalse()
  };
}

/**
 * CAS write tip with content_encoding=content_ref (no R2 body).
 * Large/binary content stays on Git/GitZip transport pointers.
 */
export async function writeDraftFromContentRef(db, {
  workspace_id,
  path,
  content_ref,
  content_bytes,
  content_sha256,
  git_blob_sha = null,
  base_revision = null,
  actor_id
} = {}) {
  let wsId;
  let actor;
  try {
    wsId = workspaceId(workspace_id);
    actor = actorId(actor_id, "actor_id");
  } catch (error) {
    return { ok: false, error: "invalid_workspace_content_ref_write", detail: String(error.message || error) };
  }

  const pathResult = canonicalizeWorkspacePath(path);
  if (!pathResult.ok) return pathResult;
  const canonicalPath = pathResult.path;

  const refCheck = validateContentRef(content_ref);
  if (!refCheck.ok) return refCheck;

  if (!isNonEmptyString(content_sha256) || !CONTENT_SHA_RE.test(String(content_sha256).trim())) {
    return { ok: false, error: "invalid_content_sha256", ...authorityFalse() };
  }
  const contentHash = String(content_sha256).trim().toLowerCase();

  const bytes = Number(content_bytes);
  if (!Number.isInteger(bytes) || bytes < 0) {
    return { ok: false, error: "invalid_content_bytes", ...authorityFalse() };
  }

  let gitBlobSha = null;
  if (git_blob_sha !== undefined && git_blob_sha !== null && git_blob_sha !== "") {
    if (!isNonEmptyString(git_blob_sha) || !FULL_SHA_RE.test(String(git_blob_sha).trim())) {
      return { ok: false, error: "invalid_git_blob_sha", ...authorityFalse() };
    }
    gitBlobSha = String(git_blob_sha).trim().toLowerCase();
  }

  const baseNorm = normalizeBaseRevision(base_revision);
  if (baseNorm.ok === false) return baseNorm;
  const baseRevision = baseNorm.value;

  const tip = await getExtendedWorkspaceTip(db, wsId, canonicalPath);
  if (!tip && baseRevision !== null) return conflictResult(null);
  if (tip && baseRevision === null) return conflictResult(tip);
  if (tip && tip.revision_id !== baseRevision) return conflictResult(tip);

  const now = new Date().toISOString();
  const revisionId = await computeRevisionId({
    workspace_id: wsId,
    path: canonicalPath,
    parent_revision_id: tip ? tip.revision_id : null,
    content_hash: contentHash,
    actor_id: actor
  });

  await insertRevisionRow(db, {
    revision_id: revisionId,
    workspace_id: wsId,
    path: canonicalPath,
    parent_revision_id: tip ? tip.revision_id : null,
    content_hash: contentHash,
    content_bytes: bytes,
    actor_id: actor,
    created_at: now,
    op: "write",
    content_encoding: "content_ref",
    content_ref: refCheck.content_ref,
    git_blob_sha: gitBlobSha,
    rename_to_path: null
  });

  if (!tip) {
    try {
      await insertTipRow(db, {
        workspace_id: wsId,
        path: canonicalPath,
        revision_id: revisionId,
        content_hash: contentHash,
        updated_at: now,
        content_encoding: "content_ref",
        content_ref: refCheck.content_ref,
        git_blob_sha: gitBlobSha
      });
    } catch {
      const raced = await getExtendedWorkspaceTip(db, wsId, canonicalPath);
      return conflictResult(raced);
    }
  } else {
    const changes = await updateTipCas(db, {
      workspace_id: wsId,
      path: canonicalPath,
      base_revision: baseRevision,
      revision_id: revisionId,
      content_hash: contentHash,
      updated_at: now,
      content_encoding: "content_ref",
      content_ref: refCheck.content_ref,
      git_blob_sha: gitBlobSha
    });
    if (!changes) {
      const raced = await getExtendedWorkspaceTip(db, wsId, canonicalPath);
      return conflictResult(raced);
    }
  }

  await db.prepare(
    `UPDATE workspaces SET updated_at = ? WHERE workspace_id = ?`
  ).bind(now, wsId).run();

  const treeOp = await insertTreeOp(db, {
    workspace_id: wsId,
    op: "content_ref",
    actor_id: actor,
    from_path: canonicalPath,
    to_path: null,
    base_revision_id: tip ? tip.revision_id : null,
    result_revision_id: revisionId,
    detail: {
      schema: WORKSPACE_CONTENT_REF_SCHEMA,
      content_ref: refCheck.content_ref,
      content_bytes: bytes,
      git_blob_sha: gitBlobSha
    }
  });

  return {
    ok: true,
    workspace_id: wsId,
    path: canonicalPath,
    revision_id: revisionId,
    parent_revision_id: tip ? tip.revision_id : null,
    content_hash: contentHash,
    content_bytes: bytes,
    content_encoding: "content_ref",
    content_ref: refCheck.content_ref,
    git_blob_sha: gitBlobSha,
    op_id: treeOp.op_id,
    actor_id: actor,
    created_at: now,
    raw_key: null,
    ...authorityFalse()
  };
}

function normalizeHydrateTreeEntries(treeResult) {
  const raw = Array.isArray(treeResult?.entries)
    ? treeResult.entries
    : Array.isArray(treeResult?.tree)
      ? treeResult.tree
      : Array.isArray(treeResult)
        ? treeResult
        : null;
  if (!raw) return { ok: false, error: "github_repo_tree_malformed" };
  const blobs = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;
    const type = String(entry.type || entry.kind || "").toLowerCase();
    if (type && type !== "blob" && type !== "file") continue;
    const path = String(entry.path || entry.name || "").replace(/^\/+/, "");
    if (!path) continue;
    const size = Number(entry.size ?? entry.bytes ?? 0);
    const sha = typeof entry.sha === "string"
      ? entry.sha
      : (typeof entry.git_blob_sha === "string" ? entry.git_blob_sha : null);
    blobs.push({
      path,
      size: Number.isFinite(size) && size >= 0 ? size : 0,
      sha: sha && FULL_SHA_RE.test(sha) ? sha.toLowerCase() : null
    });
  }
  return { ok: true, entries: blobs };
}

function mapGitPathToWorkspacePath(gitPath, rootPath, pathPrefix) {
  let relative = gitPath;
  if (rootPath) {
    if (gitPath === rootPath) return null;
    if (!gitPath.startsWith(`${rootPath}/`)) return null;
    relative = gitPath.slice(rootPath.length + 1);
  }
  if (!relative) return null;
  const withPrefix = pathPrefix ? `${pathPrefix}/${relative}` : relative;
  return canonicalizeWorkspacePath(withPrefix);
}

/**
 * Hydrate workspace tips from an immutable Git commit tree.
 * Small files may inline via writeDraft; large/missing → content_ref tips.
 * Skips paths that already have tips. Never accepted-state / never HEADs.
 */
export async function hydrateWorkspaceFromGit(db, r2, {
  workspace_id,
  actor_id,
  owner,
  repo,
  commit_sha,
  root_path = null,
  max_files = WORKSPACE_HYDRATE_MAX_FILES,
  inline_max_bytes = WORKSPACE_HYDRATE_INLINE_MAX_BYTES,
  path_prefix = null
} = {}, deps = {}) {
  let wsId;
  let actor;
  try {
    wsId = workspaceId(workspace_id);
    actor = actorId(actor_id, "actor_id");
  } catch (error) {
    return { ok: false, error: "invalid_workspace_hydrate", detail: String(error.message || error) };
  }

  const ownerName = String(owner || "").trim();
  const repoName = String(repo || "").trim();
  if (!ownerName || !repoName || !GITHUB_NAME_RE.test(ownerName) || !GITHUB_NAME_RE.test(repoName)) {
    return { ok: false, error: "invalid_github_owner_repo", ...authorityFalse() };
  }

  const commitSha = String(commit_sha || "").trim().toLowerCase();
  if (!FULL_SHA_RE.test(commitSha)) {
    return {
      ok: false,
      error: "immutable_commit_sha_required",
      detail: "commit_sha_must_be_40_hex",
      ...authorityFalse()
    };
  }

  if (typeof deps.fetchGitHubRepoTree !== "function") {
    return { ok: false, error: "fetchGitHubRepoTree_required", ...authorityFalse() };
  }

  let rootPath = null;
  if (root_path !== undefined && root_path !== null && root_path !== "") {
    const rootResult = canonicalizeWorkspacePath(root_path);
    if (!rootResult.ok) return { ok: false, error: "invalid_hydrate_root_path", detail: rootResult };
    rootPath = rootResult.path;
  }

  let pathPrefix = null;
  if (path_prefix !== undefined && path_prefix !== null && path_prefix !== "") {
    const prefixResult = canonicalizeWorkspacePath(path_prefix);
    if (!prefixResult.ok) return { ok: false, error: "invalid_hydrate_path_prefix", detail: prefixResult };
    pathPrefix = prefixResult.path;
  }

  const maxFiles = clampInt(max_files, 1, WORKSPACE_HYDRATE_MAX_FILES, WORKSPACE_HYDRATE_MAX_FILES);
  const inlineMax = clampInt(
    inline_max_bytes,
    0,
    WORKSPACE_HYDRATE_INLINE_MAX_BYTES,
    WORKSPACE_HYDRATE_INLINE_MAX_BYTES
  );

  const treeRaw = await deps.fetchGitHubRepoTree({
    owner: ownerName,
    repo: repoName,
    commit_sha: commitSha,
    root_path: rootPath
  });
  if (!treeRaw?.ok && treeRaw?.ok !== undefined) {
    return {
      ok: false,
      error: treeRaw.error || "github_repo_tree_failed",
      detail: treeRaw.detail || null,
      ...authorityFalse()
    };
  }
  const normalized = normalizeHydrateTreeEntries(treeRaw);
  if (!normalized.ok) return { ...normalized, ...authorityFalse() };

  const selected = [];
  for (const entry of normalized.entries) {
    const mapped = mapGitPathToWorkspacePath(entry.path, rootPath, pathPrefix);
    if (!mapped) continue;
    if (!mapped.ok) continue;
    selected.push({ ...entry, workspace_path: mapped.path, git_path: entry.path });
    if (selected.length >= maxFiles) break;
  }

  const written = [];
  const contentRefs = [];
  const skipped = [];
  const errors = [];

  for (const entry of selected) {
    const existing = await getWorkspaceTip(db, wsId, entry.workspace_path);
    if (existing) {
      skipped.push({ path: entry.workspace_path, reason: "tip_exists", revision_id: existing.revision_id });
      continue;
    }

    let inlined = false;
    if (
      typeof deps.fetchGitHubFile === "function"
      && entry.size > 0
      && entry.size <= inlineMax
    ) {
      try {
        const file = await deps.fetchGitHubFile({
          owner: ownerName,
          repo: repoName,
          commit_sha: commitSha,
          path: entry.git_path
        });
        const content = typeof file === "string"
          ? file
          : (typeof file?.content === "string" ? file.content : null);
        if (content !== null && utf8ByteLength(content) <= inlineMax) {
          const wrote = await writeDraft(db, r2, {
            workspace_id: wsId,
            path: entry.workspace_path,
            content,
            base_revision: null,
            actor_id: actor
          });
          if (wrote.ok) {
            written.push({
              path: entry.workspace_path,
              revision_id: wrote.revision_id,
              content_hash: wrote.content_hash,
              content_encoding: "utf8_text",
              git_blob_sha: entry.sha
            });
            inlined = true;
          } else if (wrote.error === "workspace_conflict") {
            skipped.push({ path: entry.workspace_path, reason: "tip_race" });
            inlined = true;
          } else {
            errors.push({ path: entry.workspace_path, error: wrote.error || "inline_write_failed" });
          }
        }
      } catch (error) {
        errors.push({
          path: entry.workspace_path,
          error: "fetchGitHubFile_exception",
          detail: String(error.message || error)
        });
      }
    }

    if (inlined) continue;

    const contentRef = buildGitContentRef(ownerName, repoName, commitSha, entry.git_path);
    const contentSha = entry.sha
      ? await sha256Text(`git-blob:${entry.sha}`)
      : await sha256Text(contentRef);
    const refWrite = await writeDraftFromContentRef(db, {
      workspace_id: wsId,
      path: entry.workspace_path,
      content_ref: contentRef,
      content_bytes: entry.size,
      content_sha256: contentSha,
      git_blob_sha: entry.sha,
      base_revision: null,
      actor_id: actor
    });
    if (refWrite.ok) {
      contentRefs.push({
        path: entry.workspace_path,
        revision_id: refWrite.revision_id,
        content_ref: contentRef,
        content_hash: refWrite.content_hash,
        git_blob_sha: entry.sha
      });
    } else if (refWrite.error === "workspace_conflict") {
      skipped.push({ path: entry.workspace_path, reason: "tip_race" });
    } else {
      errors.push({ path: entry.workspace_path, error: refWrite.error || "content_ref_write_failed" });
    }
  }

  const treeOp = await insertTreeOp(db, {
    workspace_id: wsId,
    op: "hydrate",
    actor_id: actor,
    from_path: rootPath,
    to_path: pathPrefix,
    base_revision_id: null,
    result_revision_id: null,
    detail: {
      owner: ownerName,
      repo: repoName,
      commit_sha: commitSha,
      written: written.length,
      content_refs: contentRefs.length,
      skipped: skipped.length,
      truncated: normalized.entries.length > selected.length
    }
  });

  const summary = await summarizeTreeState(db, wsId);

  return {
    ok: true,
    workspace_id: wsId,
    owner: ownerName,
    repo: repoName,
    commit_sha: commitSha,
    root_path: rootPath,
    path_prefix: pathPrefix,
    max_files: maxFiles,
    inline_max_bytes: inlineMax,
    written,
    content_refs: contentRefs,
    skipped,
    errors,
    written_count: written.length,
    content_ref_count: contentRefs.length,
    skipped_count: skipped.length,
    op_id: treeOp.op_id,
    tip_vector_digest: summary.ok ? summary.tip_vector_digest : null,
    transport_only: true,
    ...authorityFalse()
  };
}

/**
 * Update workspaces.github_bind_json with working_branch + observed_commit_sha.
 * transport_only:true always. Resolves via deps.resolveGitHubCommit or
 * resolveGitHubCommitSha. Never accepted-state authority.
 */
export async function setGithubTransport(db, {
  workspace_id,
  actor_id,
  working_branch,
  working_ref = null,
  observed_commit_sha = null,
  root_path = null
} = {}, deps = {}) {
  let wsId;
  let actor;
  try {
    wsId = workspaceId(workspace_id);
    actor = actorId(actor_id, "actor_id");
  } catch (error) {
    return { ok: false, error: "invalid_workspace_github_transport", detail: String(error.message || error) };
  }

  const workspace = await getWorkspace(db, wsId);
  if (!workspace) return { ok: false, error: "workspace_not_found", workspace_id: wsId, ...authorityFalse() };

  const bindParsed = parseGithubBindJson(workspace.github_bind_json);
  if (!bindParsed.ok) return bindParsed;
  const existing = bindParsed.github_bind || {};

  const owner = String(existing.owner || deps.owner || "").trim();
  const repo = String(existing.repo || deps.repo || "").trim();
  if (!owner || !repo || !GITHUB_NAME_RE.test(owner) || !GITHUB_NAME_RE.test(repo)) {
    return {
      ok: false,
      error: "workspace_github_bind_required",
      detail: "set_github_transport_requires_existing_or_provided_owner_repo",
      ...authorityFalse()
    };
  }

  const branch = isNonEmptyString(working_branch)
    ? String(working_branch).trim()
    : (isNonEmptyString(working_ref) ? String(working_ref).trim() : null);
  if (!branch || branch.length > 256 || branch.includes("\0") || branch.includes("..")) {
    return { ok: false, error: "invalid_working_branch", ...authorityFalse() };
  }

  let rootPath = existing.root_path || null;
  if (root_path !== undefined && root_path !== null && root_path !== "") {
    const rootResult = canonicalizeWorkspacePath(root_path);
    if (!rootResult.ok) return { ok: false, error: "invalid_github_transport_root_path", detail: rootResult };
    rootPath = rootResult.path;
  }

  let observed = observed_commit_sha
    ? String(observed_commit_sha).trim().toLowerCase()
    : null;
  let requestedRef = branch;

  if (observed && !FULL_SHA_RE.test(observed)) {
    return {
      ok: false,
      error: "immutable_commit_sha_required",
      detail: "observed_commit_sha_must_be_40_hex",
      ...authorityFalse()
    };
  }

  if (!observed) {
    const resolver = typeof deps.resolveGitHubCommit === "function"
      ? deps.resolveGitHubCommit
      : (o, r, ref, env) => resolveGitHubCommitSha(o, r, ref, env || deps.env || {});
    const resolved = await resolver(owner, repo, branch, deps.env || {});
    observed = (resolved?.observed_commit_sha || resolved?.sha || "").toLowerCase();
    requestedRef = resolved?.requested_ref || branch;
    if (!resolved?.ok && !FULL_SHA_RE.test(observed)) {
      return {
        ok: false,
        error: resolved?.error || "github_commit_resolution_failed",
        detail: resolved?.detail || null,
        requested_ref: requestedRef,
        ...authorityFalse()
      };
    }
    if (!FULL_SHA_RE.test(observed)) {
      return {
        ok: false,
        error: "github_commit_resolution_failed",
        detail: "immutable_commit_sha_required",
        requested_ref: requestedRef,
        ...authorityFalse()
      };
    }
  }

  const githubBind = {
    owner,
    repo,
    ref: branch,
    working_branch: branch,
    working_ref: branch,
    observed_commit_sha: observed,
    root_path: rootPath,
    transport_only: true
  };

  const now = new Date().toISOString();
  await db.prepare(
    `UPDATE workspaces SET github_bind_json = ?, updated_at = ? WHERE workspace_id = ?`
  ).bind(stableJson(githubBind), now, wsId).run();

  const treeOp = await insertTreeOp(db, {
    workspace_id: wsId,
    op: "set_github_transport",
    actor_id: actor,
    from_path: rootPath,
    to_path: null,
    base_revision_id: null,
    result_revision_id: null,
    detail: {
      working_branch: branch,
      observed_commit_sha: observed,
      transport_only: true
    }
  });

  return {
    ok: true,
    workspace_id: wsId,
    github_bind: githubBind,
    working_branch: branch,
    requested_ref: requestedRef,
    observed_commit_sha: observed,
    transport_only: true,
    op_id: treeOp.op_id,
    updated_at: now,
    actor_id: actor,
    ...authorityFalse()
  };
}

/**
 * Tree listing: files + optional synthetic directories + tip_vector_digest.
 */
export async function treeLs(db, {
  workspace_id,
  prefix = null,
  include_directories = true,
  include_content_refs = true
} = {}) {
  let wsId;
  try {
    wsId = workspaceId(workspace_id);
  } catch (error) {
    return { ok: false, error: "invalid_workspace_tree_ls", detail: String(error.message || error) };
  }

  let canonicalPrefix = null;
  if (prefix !== undefined && prefix !== null && prefix !== "") {
    const prefixResult = canonicalizeWorkspacePath(prefix);
    if (!prefixResult.ok) return prefixResult;
    canonicalPrefix = prefixResult.path;
  }

  const listed = await listExtendedWorkspaceTips(db, wsId, canonicalPrefix);
  if (!listed.ok) return listed;

  const files = [];
  for (const tip of listed.tips) {
    const encoding = tip.content_encoding || "utf8_text";
    if (!include_content_refs && encoding === "content_ref") continue;
    files.push({
      type: "file",
      path: tip.path,
      revision_id: tip.revision_id,
      content_hash: tip.content_hash,
      updated_at: tip.updated_at,
      content_encoding: encoding,
      content_ref: include_content_refs ? (tip.content_ref || null) : null,
      git_blob_sha: tip.git_blob_sha || null
    });
  }

  const entries = [...files];
  if (include_directories) {
    for (const dir of syntheticDirectoriesFromPaths(files.map(f => f.path), canonicalPrefix)) {
      entries.push({ type: "directory", path: dir });
    }
    entries.sort((a, b) => {
      const pathCmp = String(a.path).localeCompare(String(b.path));
      if (pathCmp !== 0) return pathCmp;
      if (a.type === b.type) return 0;
      return a.type === "directory" ? -1 : 1;
    });
  }

  const tipVector = buildTipVector(listed.tips);
  const tipVectorDigest = await computeTipVectorDigest(wsId, tipVector);

  return {
    ok: true,
    workspace_id: wsId,
    prefix: canonicalPrefix,
    entries,
    files,
    file_count: files.length,
    directory_count: include_directories
      ? entries.filter(e => e.type === "directory").length
      : 0,
    tip_vector: tipVector,
    tip_vector_digest: tipVectorDigest,
    ...authorityFalse()
  };
}

/**
 * Diff current tip vector against a prior tip vector (added/modified/deleted/unchanged).
 */
export async function treeDiff(db, {
  workspace_id,
  against_tip_vector = [],
  prefix = null
} = {}) {
  let wsId;
  try {
    wsId = workspaceId(workspace_id);
  } catch (error) {
    return { ok: false, error: "invalid_workspace_tree_diff", detail: String(error.message || error) };
  }

  let canonicalPrefix = null;
  if (prefix !== undefined && prefix !== null && prefix !== "") {
    const prefixResult = canonicalizeWorkspacePath(prefix);
    if (!prefixResult.ok) return prefixResult;
    canonicalPrefix = prefixResult.path;
  }

  const listed = await listExtendedWorkspaceTips(db, wsId, canonicalPrefix);
  if (!listed.ok) return listed;

  const current = buildTipVector(listed.tips);
  const against = buildTipVector(Array.isArray(against_tip_vector) ? against_tip_vector : []);
  const againstMap = new Map(against.map(tip => [tip.path, tip]));
  const currentMap = new Map(current.map(tip => [tip.path, tip]));

  const added = [];
  const modified = [];
  const unchanged = [];
  const deleted = [];

  for (const tip of current) {
    const prior = againstMap.get(tip.path);
    if (!prior) {
      added.push(tip);
    } else if (
      prior.revision_id !== tip.revision_id
      || prior.content_hash !== tip.content_hash
    ) {
      modified.push({ path: tip.path, before: prior, after: tip });
    } else {
      unchanged.push(tip);
    }
  }
  for (const tip of against) {
    if (!currentMap.has(tip.path)) deleted.push(tip);
  }

  const tipVectorDigest = await computeTipVectorDigest(wsId, current);
  const againstDigest = await computeTipVectorDigest(wsId, against);

  return {
    ok: true,
    workspace_id: wsId,
    prefix: canonicalPrefix,
    tip_vector_digest: tipVectorDigest,
    against_tip_vector_digest: againstDigest,
    summary: {
      added: added.length,
      modified: modified.length,
      deleted: deleted.length,
      unchanged: unchanged.length
    },
    added,
    modified,
    deleted,
    unchanged,
    ...authorityFalse()
  };
}

/**
 * Record a GitZip / direct-byte ingress transport receipt.
 * Success here is NEVER accepted-state and NEVER deploy.
 */
export async function recordGitzipTransport(db, {
  workspace_id,
  actor_id,
  code_session_id = null,
  proposal_snapshot_id = null,
  gitzip_content_refs = [],
  expected_base_sha = null,
  observed_commit_sha = null,
  working_branch = null,
  transport_status = "recorded",
  detail = {}
} = {}) {
  let wsId;
  let actor;
  try {
    wsId = workspaceId(workspace_id);
    actor = actorId(actor_id, "actor_id");
  } catch (error) {
    return { ok: false, error: "invalid_workspace_gitzip_receipt", detail: String(error.message || error) };
  }

  const workspace = await getWorkspace(db, wsId);
  if (!workspace) return { ok: false, error: "workspace_not_found", workspace_id: wsId, ...authorityFalse() };

  const status = String(transport_status || "recorded").trim();
  if (!["recorded", "pushed", "failed", "superseded"].includes(status)) {
    return { ok: false, error: "invalid_gitzip_transport_status", ...authorityFalse() };
  }

  const refs = Array.isArray(gitzip_content_refs) ? gitzip_content_refs : [];
  for (const ref of refs) {
    if (typeof ref === "string") {
      const check = validateContentRef(ref);
      if (!check.ok) return check;
    } else if (isObject(ref) && isNonEmptyString(ref.content_ref)) {
      const check = validateContentRef(ref.content_ref);
      if (!check.ok) return check;
    }
  }

  let expectedBase = null;
  if (expected_base_sha !== undefined && expected_base_sha !== null && expected_base_sha !== "") {
    if (!FULL_SHA_RE.test(String(expected_base_sha).trim())) {
      return { ok: false, error: "invalid_expected_base_sha", ...authorityFalse() };
    }
    expectedBase = String(expected_base_sha).trim().toLowerCase();
  }

  let observed = null;
  if (observed_commit_sha !== undefined && observed_commit_sha !== null && observed_commit_sha !== "") {
    if (!FULL_SHA_RE.test(String(observed_commit_sha).trim())) {
      return { ok: false, error: "invalid_observed_commit_sha", ...authorityFalse() };
    }
    observed = String(observed_commit_sha).trim().toLowerCase();
  }

  const createdAt = new Date().toISOString();
  const receiptId = await sha256Text(stableJson({
    schema: WORKSPACE_GITZIP_RECEIPT_SCHEMA,
    workspace_id: wsId,
    actor_id: actor,
    code_session_id: code_session_id || null,
    proposal_snapshot_id: proposal_snapshot_id || null,
    gitzip_content_refs: refs,
    expected_base_sha: expectedBase,
    observed_commit_sha: observed,
    working_branch: working_branch || null,
    transport_status: status,
    created_at: createdAt,
    slice: WORKSPACE_TREE_SLICE
  }));

  await db.prepare(
    `INSERT OR IGNORE INTO workspace_gitzip_transport_receipts
      (receipt_id, workspace_id, code_session_id, actor_id, proposal_snapshot_id,
       gitzip_content_refs_json, expected_base_sha, observed_commit_sha, working_branch,
       transport_status, detail_json, created_at, accepted_state_authority)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`
  ).bind(
    receiptId,
    wsId,
    code_session_id || null,
    actor,
    proposal_snapshot_id || null,
    stableJson(refs),
    expectedBase,
    observed,
    working_branch || null,
    status,
    stableJson(isObject(detail) ? detail : {}),
    createdAt
  ).run();

  return {
    ok: true,
    schema: WORKSPACE_GITZIP_RECEIPT_SCHEMA,
    receipt_id: receiptId,
    workspace_id: wsId,
    code_session_id: code_session_id || null,
    actor_id: actor,
    proposal_snapshot_id: proposal_snapshot_id || null,
    gitzip_content_refs: refs,
    expected_base_sha: expectedBase,
    observed_commit_sha: observed,
    working_branch: working_branch || null,
    transport_status: status,
    created_at: createdAt,
    gitzip_success_is_not_accepted_state: true,
    gitzip_success_is_not_deploy: true,
    ...authorityFalse()
  };
}

/**
 * Compact tree state summary for code-session / checkpoint consumers.
 */
export async function summarizeTreeState(db, workspace_id) {
  let wsId;
  try {
    wsId = workspaceId(workspace_id);
  } catch (error) {
    return { ok: false, error: "invalid_workspace_summarize", detail: String(error.message || error) };
  }

  const listed = await listExtendedWorkspaceTips(db, wsId, null);
  if (!listed.ok) return listed;

  let contentRefCount = 0;
  let gitBlobCount = 0;
  for (const tip of listed.tips) {
    if ((tip.content_encoding || "") === "content_ref" || tip.content_ref) contentRefCount += 1;
    if (tip.git_blob_sha) gitBlobCount += 1;
  }

  const tipVector = buildTipVector(listed.tips);
  const tipVectorDigest = await computeTipVectorDigest(wsId, tipVector);

  return {
    ok: true,
    workspace_id: wsId,
    tip_count: listed.tips.length,
    content_ref_count: contentRefCount,
    git_blob_count: gitBlobCount,
    tip_vector: tipVector,
    tip_vector_digest: tipVectorDigest,
    ...authorityFalse()
  };
}

// ---------------------------------------------------------------------------
// FromBody handlers (capability + membership; mirror workspace.js)
// ---------------------------------------------------------------------------

async function authorizeTreeMutation(body, env, { requiredScopes, path = null }) {
  const bindings = workspaceEnvBindings(env);
  if (!bindings.ok) return { auth: bindings, bindings: null };

  const actor = requireActorField(body, "actor_id");
  if (!actor.ok) return { auth: actor, bindings: null };
  if (!isNonEmptyString(body.workspace_capability)) {
    return { auth: { ok: false, error: "workspace_capability_required" }, bindings: null };
  }

  const auth = await authorizeWorkspaceRequest(bindings.db, env, {
    workspace_capability: body.workspace_capability,
    actor_id: actor.value,
    workspace_id: body.workspace_id,
    requiredScopes,
    path,
    requireMembership: true
  });
  return { auth, bindings };
}

export async function deleteDraftFromBody(body = {}, env = {}) {
  const { auth, bindings } = await authorizeTreeMutation(body, env, {
    requiredScopes: ["write_draft"],
    path: body.path
  });
  if (!auth.ok) return auth;

  return deleteDraft(bindings.db, {
    workspace_id: auth.workspace_id,
    path: body.path,
    base_revision: body.base_revision,
    actor_id: auth.principal_actor_id
  });
}

export async function renameDraftFromBody(body = {}, env = {}) {
  const bindings = workspaceEnvBindings(env);
  if (!bindings.ok) return bindings;

  const actor = requireActorField(body, "actor_id");
  if (!actor.ok) return actor;
  if (!isNonEmptyString(body.workspace_capability)) {
    return { ok: false, error: "workspace_capability_required" };
  }

  const auth = await authorizeWorkspaceRequest(bindings.db, env, {
    workspace_capability: body.workspace_capability,
    actor_id: actor.value,
    workspace_id: body.workspace_id,
    requiredScopes: ["write_draft"],
    path: body.from_path,
    requireMembership: true
  });
  if (!auth.ok) return auth;

  // Capability path_prefix must also cover destination.
  if (auth.path_prefix) {
    const toCanonical = canonicalizeWorkspacePath(body.to_path);
    if (!toCanonical.ok) return toCanonical;
    const destCheck = pathWithinPrefix(toCanonical.path, auth.path_prefix);
    if (!destCheck.ok) return destCheck;
  }

  return renameDraft(bindings.db, {
    workspace_id: auth.workspace_id,
    from_path: body.from_path,
    to_path: body.to_path,
    base_revision: body.base_revision,
    actor_id: auth.principal_actor_id
  });
}

export async function writeContentRefFromBody(body = {}, env = {}) {
  const { auth, bindings } = await authorizeTreeMutation(body, env, {
    requiredScopes: ["write_draft"],
    path: body.path
  });
  if (!auth.ok) return auth;

  return writeDraftFromContentRef(bindings.db, {
    workspace_id: auth.workspace_id,
    path: body.path,
    content_ref: body.content_ref,
    content_bytes: body.content_bytes,
    content_sha256: body.content_sha256,
    git_blob_sha: body.git_blob_sha,
    base_revision: body.base_revision === undefined ? null : body.base_revision,
    actor_id: auth.principal_actor_id
  });
}

export async function hydrateWorkspaceFromGitFromBody(body = {}, env = {}, deps = {}) {
  const { auth, bindings } = await authorizeTreeMutation(body, env, {
    requiredScopes: ["write_draft"],
    path: body.path_prefix || body.root_path || null
  });
  if (!auth.ok) return auth;

  return hydrateWorkspaceFromGit(bindings.db, bindings.r2, {
    workspace_id: auth.workspace_id,
    actor_id: auth.principal_actor_id,
    owner: body.owner,
    repo: body.repo,
    commit_sha: body.commit_sha,
    root_path: body.root_path,
    max_files: body.max_files,
    inline_max_bytes: body.inline_max_bytes,
    path_prefix: body.path_prefix || auth.path_prefix || null
  }, {
    fetchGitHubRepoTree: deps.fetchGitHubRepoTree,
    fetchGitHubFile: deps.fetchGitHubFile
  });
}

export async function setGithubTransportFromBody(body = {}, env = {}, deps = {}) {
  const { auth, bindings } = await authorizeTreeMutation(body, env, {
    requiredScopes: ["write_draft"],
    path: body.root_path || null
  });
  if (!auth.ok) return auth;

  return setGithubTransport(bindings.db, {
    workspace_id: auth.workspace_id,
    actor_id: auth.principal_actor_id,
    working_branch: body.working_branch,
    working_ref: body.working_ref,
    observed_commit_sha: body.observed_commit_sha,
    root_path: body.root_path
  }, {
    resolveGitHubCommit: deps.resolveGitHubCommit || null,
    env,
    owner: body.owner,
    repo: body.repo
  });
}

export async function treeLsFromBody(body = {}, env = {}) {
  const { auth, bindings } = await authorizeTreeMutation(body, env, {
    requiredScopes: ["ls"],
    path: body.prefix || null
  });
  if (!auth.ok) return auth;

  return treeLs(bindings.db, {
    workspace_id: auth.workspace_id,
    prefix: body.prefix,
    include_directories: body.include_directories !== false,
    include_content_refs: body.include_content_refs !== false
  });
}

export async function treeDiffFromBody(body = {}, env = {}) {
  const { auth, bindings } = await authorizeTreeMutation(body, env, {
    requiredScopes: ["diff"],
    path: body.prefix || null
  });
  if (!auth.ok) return auth;

  return treeDiff(bindings.db, {
    workspace_id: auth.workspace_id,
    against_tip_vector: body.against_tip_vector,
    prefix: body.prefix
  });
}

export async function recordGitzipTransportFromBody(body = {}, env = {}) {
  const { auth, bindings } = await authorizeTreeMutation(body, env, {
    requiredScopes: ["write_draft"],
    path: null
  });
  if (!auth.ok) return auth;

  return recordGitzipTransport(bindings.db, {
    workspace_id: auth.workspace_id,
    actor_id: auth.principal_actor_id,
    code_session_id: body.code_session_id,
    proposal_snapshot_id: body.proposal_snapshot_id,
    gitzip_content_refs: body.gitzip_content_refs,
    expected_base_sha: body.expected_base_sha,
    observed_commit_sha: body.observed_commit_sha,
    working_branch: body.working_branch,
    transport_status: body.transport_status,
    detail: body.detail
  });
}

// ---------------------------------------------------------------------------
// MCP tool definitions (additionalProperties:false; never accepted-state)
// ---------------------------------------------------------------------------

const AUTH_PROPS = Object.freeze({
  workspace_id: { type: "string" },
  actor_id: { type: "string" },
  workspace_capability: { type: "string" }
});

export const WORKSPACE_DELETE_DRAFT_TOOL_DEFINITION = Object.freeze({
  name: WORKSPACE_TREE_BROKER_TOOL_IDS.delete_draft,
  description: "V7.7.7d: CAS delete_draft on one workspace tip. Requires base_revision match; inserts tombstone revision and removes tip. Never accepted-state authority; never moves chain_heads/path_heads.",
  inputSchema: {
    type: "object",
    required: ["workspace_id", "path", "base_revision", "actor_id", "workspace_capability"],
    properties: {
      ...AUTH_PROPS,
      path: { type: "string" },
      base_revision: { type: "string" }
    },
    additionalProperties: false
  }
});

export const WORKSPACE_RENAME_DRAFT_TOOL_DEFINITION = Object.freeze({
  name: WORKSPACE_TREE_BROKER_TOOL_IDS.rename_draft,
  description: "V7.7.7d: CAS rename_draft source→dest. Fails if destination tip exists or base_revision is stale. Never accepted-state; never HEADs.",
  inputSchema: {
    type: "object",
    required: ["workspace_id", "from_path", "to_path", "base_revision", "actor_id", "workspace_capability"],
    properties: {
      ...AUTH_PROPS,
      from_path: { type: "string" },
      to_path: { type: "string" },
      base_revision: { type: "string" }
    },
    additionalProperties: false
  }
});

export const WORKSPACE_WRITE_CONTENT_REF_TOOL_DEFINITION = Object.freeze({
  name: WORKSPACE_TREE_BROKER_TOOL_IDS.write_content_ref,
  description: "V7.7.7d: CAS write a content_ref tip (no R2 body). Large/binary content stays on Git/GitZip pointers. Never accepted-state; never HEADs. GitZip≠accept.",
  inputSchema: {
    type: "object",
    required: [
      "workspace_id",
      "path",
      "content_ref",
      "content_bytes",
      "content_sha256",
      "actor_id",
      "workspace_capability"
    ],
    properties: {
      ...AUTH_PROPS,
      path: { type: "string" },
      content_ref: { type: "string" },
      content_bytes: { type: "number", minimum: 0 },
      content_sha256: { type: "string" },
      git_blob_sha: { type: "string" },
      base_revision: { type: ["string", "null"] }
    },
    additionalProperties: false
  }
});

export const WORKSPACE_HYDRATE_FROM_GIT_TOOL_DEFINITION = Object.freeze({
  name: WORKSPACE_TREE_BROKER_TOOL_IDS.hydrate_from_git,
  description: "V7.7.7d: hydrate workspace tips from an immutable 40-hex Git commit tree (skip existing tips; small files may inline; large → content_ref). Transport/backing only — never accepted-state; never HEADs.",
  inputSchema: {
    type: "object",
    required: [
      "workspace_id",
      "owner",
      "repo",
      "commit_sha",
      "actor_id",
      "workspace_capability"
    ],
    properties: {
      ...AUTH_PROPS,
      owner: { type: "string" },
      repo: { type: "string" },
      commit_sha: { type: "string", description: "Immutable 40-hex commit SHA (not a branch)." },
      root_path: { type: "string" },
      path_prefix: { type: "string" },
      max_files: { type: "number", minimum: 1, maximum: WORKSPACE_HYDRATE_MAX_FILES },
      inline_max_bytes: { type: "number", minimum: 0, maximum: WORKSPACE_HYDRATE_INLINE_MAX_BYTES }
    },
    additionalProperties: false
  }
});

export const WORKSPACE_SET_GITHUB_TRANSPORT_TOOL_DEFINITION = Object.freeze({
  name: WORKSPACE_TREE_BROKER_TOOL_IDS.set_github_transport,
  description: "V7.7.7d: record working_branch + observed_commit_sha on workspace github_bind (transport_only:true). GitHub remains VC transport — never accepted-state authority; never HEADs.",
  inputSchema: {
    type: "object",
    required: ["workspace_id", "working_branch", "actor_id", "workspace_capability"],
    properties: {
      ...AUTH_PROPS,
      working_branch: { type: "string" },
      working_ref: { type: "string" },
      observed_commit_sha: { type: "string" },
      root_path: { type: "string" },
      owner: { type: "string" },
      repo: { type: "string" }
    },
    additionalProperties: false
  }
});

export const WORKSPACE_TREE_LS_TOOL_DEFINITION = Object.freeze({
  name: WORKSPACE_TREE_BROKER_TOOL_IDS.tree_ls,
  description: "V7.7.7d: list workspace tree (files + synthetic directories) with tip_vector_digest. Requires ls scope. Never accepted-state; never HEADs.",
  inputSchema: {
    type: "object",
    required: ["workspace_id", "actor_id", "workspace_capability"],
    properties: {
      ...AUTH_PROPS,
      prefix: { type: "string" },
      include_directories: { type: "boolean" },
      include_content_refs: { type: "boolean" }
    },
    additionalProperties: false
  }
});

export const WORKSPACE_TREE_DIFF_TOOL_DEFINITION = Object.freeze({
  name: WORKSPACE_TREE_BROKER_TOOL_IDS.tree_diff,
  description: "V7.7.7d: diff current tip vector vs against_tip_vector (added/modified/deleted/unchanged). Requires diff scope. Never accepted-state; never HEADs.",
  inputSchema: {
    type: "object",
    required: ["workspace_id", "actor_id", "workspace_capability"],
    properties: {
      ...AUTH_PROPS,
      against_tip_vector: {
        type: "array",
        items: {
          type: "object",
          required: ["path", "revision_id", "content_hash"],
          properties: {
            path: { type: "string" },
            revision_id: { type: "string" },
            content_hash: { type: "string" }
          },
          additionalProperties: false
        }
      },
      prefix: { type: "string" }
    },
    additionalProperties: false
  }
});

export const WORKSPACE_RECORD_GITZIP_TRANSPORT_TOOL_DEFINITION = Object.freeze({
  name: WORKSPACE_TREE_BROKER_TOOL_IDS.record_gitzip_transport,
  description: "V7.7.7d: append a GitZip/direct-byte transport receipt. GitZip success is NOT accepted-state and NOT deploy. Never moves chain_heads/path_heads.",
  inputSchema: {
    type: "object",
    required: ["workspace_id", "actor_id", "workspace_capability"],
    properties: {
      ...AUTH_PROPS,
      code_session_id: { type: "string" },
      proposal_snapshot_id: { type: "string" },
      gitzip_content_refs: {
        type: "array",
        items: {
          oneOf: [
            { type: "string" },
            {
              type: "object",
              properties: {
                content_ref: { type: "string" },
                path: { type: "string" },
                content_sha256: { type: "string" }
              },
              additionalProperties: false
            }
          ]
        }
      },
      expected_base_sha: { type: "string" },
      observed_commit_sha: { type: "string" },
      working_branch: { type: "string" },
      transport_status: {
        type: "string",
        enum: ["recorded", "pushed", "failed", "superseded"]
      },
      detail: { type: "object", additionalProperties: true }
    },
    additionalProperties: false
  }
});

export const WORKSPACE_TREE_MCP_TOOL_DEFINITIONS = Object.freeze([
  WORKSPACE_DELETE_DRAFT_TOOL_DEFINITION,
  WORKSPACE_RENAME_DRAFT_TOOL_DEFINITION,
  WORKSPACE_WRITE_CONTENT_REF_TOOL_DEFINITION,
  WORKSPACE_HYDRATE_FROM_GIT_TOOL_DEFINITION,
  WORKSPACE_SET_GITHUB_TRANSPORT_TOOL_DEFINITION,
  WORKSPACE_TREE_LS_TOOL_DEFINITION,
  WORKSPACE_TREE_DIFF_TOOL_DEFINITION,
  WORKSPACE_RECORD_GITZIP_TRANSPORT_TOOL_DEFINITION
]);
