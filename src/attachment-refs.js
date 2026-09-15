// V7.7.10b — Typed attachment / object_ref resolvers
//
// Parse + bounded orientation only. NEVER grants capability, NEVER moves
// chain_heads / path_heads, NEVER accepted-state authority.
// Resolves Conversation Session attachment_set placeholders from 10a.

import { stableJson } from "./agent-bootstrap.js";
import {
  getConversationSession,
  normalizeAttachmentSet,
  updateConversationSession
} from "./conversation-session.js";

export const ATTACHMENT_REF_SCHEMA = "cairnstone-attachment-ref-v1";

export const ATTACHMENT_REF_BROKER_TOOL_IDS = Object.freeze({
  resolve: "cairnstone_attachment_ref_resolve"
});

export const ATTACHMENT_REF_READ_TOOL_IDS = Object.freeze([
  ATTACHMENT_REF_BROKER_TOOL_IDS.resolve
]);

const ACTOR_ID_RE = /^[a-z0-9][a-z0-9._-]{0,63}:[a-z0-9][a-z0-9._-]{0,127}$/i;
const HEX40_RE = /^[0-9a-f]{40}$/i;
const HEX64_RE = /^[0-9a-f]{64}$/i;
const MAX_REFS = 50;
const MAX_REF_LEN = 256;

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function authorityClosedFields() {
  return {
    accepted_state_authority: false,
    chain_heads_mutated: false,
    path_heads_mutated: false,
    grants_no_capability: true,
    capability_granted: false,
    orientation_only: true
  };
}

function envDb(env) {
  if (!env?.CAIRNSTONE_DB) {
    return { ok: false, error: "missing_d1_binding", detail: "CAIRNSTONE_DB required" };
  }
  return { ok: true, db: env.CAIRNSTONE_DB };
}

/**
 * Parse a typed object_ref into a normalized descriptor.
 * Does not hit storage; pure validation/normalization.
 */
export function parseObjectRef(raw) {
  if (!isNonEmptyString(raw)) {
    return { ok: false, error: "object_ref_required" };
  }
  const text = String(raw).trim().slice(0, MAX_REF_LEN);
  const lower = text.toLowerCase();

  // stone:<64hex> or bare 64hex
  if (lower.startsWith("stone:")) {
    const hash = text.slice(6).trim().toLowerCase();
    if (!HEX64_RE.test(hash)) {
      return { ok: false, error: "invalid_stone_ref", object_ref: text, detail: "stone:<64hex> required" };
    }
    return {
      ok: true,
      kind: "stone",
      object_ref: `stone:${hash}`,
      canonical_ref: `stone:${hash}`,
      stone_hash: hash
    };
  }
  if (HEX64_RE.test(text)) {
    const hash = text.toLowerCase();
    return {
      ok: true,
      kind: "stone",
      object_ref: `stone:${hash}`,
      canonical_ref: `stone:${hash}`,
      stone_hash: hash
    };
  }

  // ac1:<64hex> — correspondence stone identity
  if (lower.startsWith("ac1:")) {
    const hash = text.slice(4).trim().toLowerCase();
    if (!HEX64_RE.test(hash)) {
      return { ok: false, error: "invalid_ac1_ref", object_ref: text, detail: "ac1:<64hex> required" };
    }
    return {
      ok: true,
      kind: "ac1",
      object_ref: `ac1:${hash}`,
      canonical_ref: `ac1:${hash}`,
      stone_hash: hash
    };
  }

  // msg:…
  if (lower.startsWith("msg:")) {
    const messageId = text;
    if (messageId.length < 5 || messageId.length > MAX_REF_LEN) {
      return { ok: false, error: "invalid_msg_ref", object_ref: text };
    }
    return {
      ok: true,
      kind: "msg",
      object_ref: messageId,
      canonical_ref: messageId,
      message_id: messageId
    };
  }

  // repo:owner/repo@40hex — immutable SHA only (never branch as evidence identity)
  if (lower.startsWith("repo:")) {
    const body = text.slice(5).trim();
    const at = body.lastIndexOf("@");
    if (at <= 0) {
      return {
        ok: false,
        error: "invalid_repo_ref",
        object_ref: text,
        detail: "repo:owner/repo@40hex required; branch refs are not evidence identity"
      };
    }
    const ownerRepo = body.slice(0, at);
    const sha = body.slice(at + 1).trim().toLowerCase();
    const slash = ownerRepo.indexOf("/");
    if (slash <= 0 || slash === ownerRepo.length - 1 || !HEX40_RE.test(sha)) {
      return {
        ok: false,
        error: "invalid_repo_ref",
        object_ref: text,
        detail: "repo:owner/repo@40hex required; never use a branch as evidence identity"
      };
    }
    const owner = ownerRepo.slice(0, slash);
    const repo = ownerRepo.slice(slash + 1);
    if (!/^[A-Za-z0-9_.-]+$/.test(owner) || !/^[A-Za-z0-9_.-]+$/.test(repo)) {
      return { ok: false, error: "invalid_repo_ref", object_ref: text };
    }
    const canonical = `repo:${owner}/${repo}@${sha}`;
    return {
      ok: true,
      kind: "repo",
      object_ref: canonical,
      canonical_ref: canonical,
      owner,
      repo,
      commit_sha: sha,
      evidence_identity: "immutable_sha"
    };
  }

  // session:cs:… or cs:…
  if (lower.startsWith("session:")) {
    const rest = text.slice(8).trim();
    const sessionId = rest.toLowerCase().startsWith("cs:") ? rest : (rest ? `cs:${rest}` : "");
    if (!/^cs:[a-z0-9][a-z0-9._-]{0,127}$/i.test(sessionId)) {
      return { ok: false, error: "invalid_session_ref", object_ref: text, detail: "session:cs:… required" };
    }
    return {
      ok: true,
      kind: "session",
      object_ref: `session:${sessionId}`,
      canonical_ref: `session:${sessionId}`,
      code_session_id: sessionId
    };
  }
  if (lower.startsWith("cs:")) {
    if (!/^cs:[a-z0-9][a-z0-9._-]{0,127}$/i.test(text)) {
      return { ok: false, error: "invalid_session_ref", object_ref: text };
    }
    return {
      ok: true,
      kind: "session",
      object_ref: `session:${text}`,
      canonical_ref: `session:${text}`,
      code_session_id: text
    };
  }

  // conversation:cvs:… / cvs:…
  if (lower.startsWith("conversation:")) {
    const rest = text.slice(13).trim();
    const conversationId = rest.toLowerCase().startsWith("cvs:") ? rest : (rest ? `cvs:${rest}` : "");
    if (!/^cvs:[a-z0-9][a-z0-9._-]{0,127}$/i.test(conversationId)) {
      return { ok: false, error: "invalid_conversation_ref", object_ref: text };
    }
    return {
      ok: true,
      kind: "conversation",
      object_ref: `conversation:${conversationId}`,
      canonical_ref: `conversation:${conversationId}`,
      conversation_id: conversationId
    };
  }
  if (lower.startsWith("cvs:")) {
    if (!/^cvs:[a-z0-9][a-z0-9._-]{0,127}$/i.test(text)) {
      return { ok: false, error: "invalid_conversation_ref", object_ref: text };
    }
    return {
      ok: true,
      kind: "conversation",
      object_ref: `conversation:${text}`,
      canonical_ref: `conversation:${text}`,
      conversation_id: text
    };
  }

  // turn:…
  if (lower.startsWith("turn:")) {
    if (!/^turn:[a-z0-9][a-z0-9._-]{0,127}$/i.test(text)) {
      return { ok: false, error: "invalid_turn_ref", object_ref: text };
    }
    return {
      ok: true,
      kind: "turn",
      object_ref: text,
      canonical_ref: text,
      turn_id: text
    };
  }

  // cmsg:… conversation message identity
  if (lower.startsWith("cmsg:")) {
    if (!/^cmsg:[a-z0-9][a-z0-9._-]{0,127}$/i.test(text)) {
      return { ok: false, error: "invalid_cmsg_ref", object_ref: text };
    }
    return {
      ok: true,
      kind: "cmsg",
      object_ref: text,
      canonical_ref: text,
      message_id: text
    };
  }

  // response:… / grounded-response:… / gr:…
  if (lower.startsWith("response:") || lower.startsWith("grounded-response:") || lower.startsWith("gr:")) {
    let responseId = text;
    if (lower.startsWith("grounded-response:")) responseId = text.slice("grounded-response:".length).trim();
    else if (lower.startsWith("response:")) responseId = text.slice("response:".length).trim();
    else responseId = text.slice(3).trim();
    if (!isNonEmptyString(responseId) || responseId.length > MAX_REF_LEN) {
      return { ok: false, error: "invalid_response_ref", object_ref: text };
    }
    const canonical = `response:${responseId}`;
    return {
      ok: true,
      kind: "response",
      object_ref: canonical,
      canonical_ref: canonical,
      response_id: responseId
    };
  }

  // grant:… / tr:… opaque identity hooks (parse only)
  if (lower.startsWith("grant:")) {
    return {
      ok: true,
      kind: "access_grant",
      object_ref: text,
      canonical_ref: text,
      grant_id: text
    };
  }
  if (lower.startsWith("tr:")) {
    return {
      ok: true,
      kind: "task_run",
      object_ref: text,
      canonical_ref: text,
      task_run_id: text
    };
  }

  return {
    ok: false,
    error: "unsupported_object_ref_kind",
    object_ref: text,
    detail: "Supported: stone:, ac1:, msg:, repo:owner/repo@40hex, session:cs:…, conversation:/cvs:, turn:, cmsg:, response:, grant:, tr:"
  };
}

async function orientStone(db, hash) {
  const row = await db.prepare(
    "SELECT hash, title, author, created_at, repo, commit_sha, chain_hash, path FROM stones WHERE hash = ?"
  ).bind(hash).first();
  if (!row) return { found: false };
  return {
    found: true,
    title: row.title || null,
    author: row.author || null,
    created_at: row.created_at || null,
    repo: row.repo || null,
    commit_sha: row.commit_sha || null,
    chain: row.chain_hash || null,
    path: row.path || null
  };
}

async function orientMessage(db, messageId) {
  const row = await db.prepare(
    `SELECT message_id, stone_hash, sender_id, thread_id, recipient_id, status, created_at
       FROM correspondence_deliveries
      WHERE message_id = ?
      ORDER BY created_at ASC
      LIMIT 1`
  ).bind(messageId).first();
  if (!row) return { found: false };
  return {
    found: true,
    message_id: row.message_id,
    stone_hash: row.stone_hash,
    sender_id: row.sender_id,
    thread_id: row.thread_id,
    sample_recipient_id: row.recipient_id,
    status: row.status,
    created_at: row.created_at
  };
}

async function orientCodeSession(db, codeSessionId) {
  const row = await db.prepare(
    `SELECT code_session_id, workspace_id, project_chain, status, created_at, updated_at
       FROM code_sessions WHERE code_session_id = ?`
  ).bind(codeSessionId).first();
  if (!row) return { found: false };
  return {
    found: true,
    code_session_id: row.code_session_id,
    workspace_id: row.workspace_id || null,
    project_chain: row.project_chain || null,
    status: row.status || null,
    created_at: row.created_at || null,
    updated_at: row.updated_at || null
  };
}

async function orientConversation(db, conversationId) {
  const row = await db.prepare(
    `SELECT conversation_id, status, intent_mode, session_revision, created_by, created_at, updated_at
       FROM conversation_sessions WHERE conversation_id = ?`
  ).bind(conversationId).first();
  if (!row) return { found: false };
  return {
    found: true,
    conversation_id: row.conversation_id,
    status: row.status,
    intent_mode: row.intent_mode,
    session_revision: row.session_revision,
    created_by: row.created_by,
    created_at: row.created_at,
    updated_at: row.updated_at
  };
}

async function orientTurn(db, turnId) {
  const row = await db.prepare(
    `SELECT turn_id, conversation_id, message_id, seq, role, turn_type, actor_id, created_at
       FROM conversation_turns WHERE turn_id = ?`
  ).bind(turnId).first();
  if (!row) return { found: false };
  return {
    found: true,
    turn_id: row.turn_id,
    conversation_id: row.conversation_id,
    message_id: row.message_id,
    seq: row.seq,
    role: row.role,
    turn_type: row.turn_type,
    actor_id: row.actor_id,
    created_at: row.created_at
  };
}

async function orientResponse(db, responseId) {
  const row = await db.prepare(
    `SELECT response_id, schema, question, code_session_id, parent_response_id, created_at, updated_at
       FROM grounded_responses WHERE response_id = ?`
  ).bind(responseId).first();
  if (!row) return { found: false };
  return {
    found: true,
    response_id: row.response_id,
    schema: row.schema || null,
    question_preview: typeof row.question === "string" ? row.question.slice(0, 160) : null,
    code_session_id: row.code_session_id || null,
    parent_response_id: row.parent_response_id || null,
    created_at: row.created_at || null,
    updated_at: row.updated_at || null
  };
}

async function orientGrant(db, grantId) {
  const row = await db.prepare(
    `SELECT grant_id, object_ref, principal_actor_id, permission, status, created_at
       FROM access_grants WHERE grant_id = ?`
  ).bind(grantId).first();
  if (!row) return { found: false };
  return {
    found: true,
    grant_id: row.grant_id,
    object_ref: row.object_ref,
    principal_actor_id: row.principal_actor_id,
    permission: row.permission,
    status: row.status,
    created_at: row.created_at
  };
}

async function orientTaskRun(db, taskRunId) {
  const row = await db.prepare(
    `SELECT task_run_id, status, dispatch_state, requested_by, assignee_actor_id, created_at
       FROM task_runs WHERE task_run_id = ?`
  ).bind(taskRunId).first();
  if (!row) return { found: false };
  return {
    found: true,
    task_run_id: row.task_run_id,
    status: row.status,
    dispatch_state: row.dispatch_state,
    requested_by: row.requested_by,
    assignee_actor_id: row.assignee_actor_id || null,
    created_at: row.created_at
  };
}

/**
 * Resolve one typed object_ref to bounded orientation.
 * Never grants capability or accepted-state authority.
 */
export async function resolveObjectRef(db, raw) {
  const parsed = parseObjectRef(raw);
  if (!parsed.ok) {
    return {
      ok: false,
      ...parsed,
      unresolved: true,
      ...authorityClosedFields()
    };
  }

  let orientation = { found: false };
  try {
    if (parsed.kind === "stone" || parsed.kind === "ac1") {
      orientation = await orientStone(db, parsed.stone_hash);
    } else if (parsed.kind === "msg") {
      orientation = await orientMessage(db, parsed.message_id);
    } else if (parsed.kind === "repo") {
      // Immutable SHA is the identity; orientation is the normalized pin only.
      orientation = {
        found: true,
        owner: parsed.owner,
        repo: parsed.repo,
        commit_sha: parsed.commit_sha,
        evidence_identity: "immutable_sha",
        note: "repo refs pin immutable SHA; never treat a branch as evidence identity"
      };
    } else if (parsed.kind === "session") {
      orientation = await orientCodeSession(db, parsed.code_session_id);
    } else if (parsed.kind === "conversation") {
      orientation = await orientConversation(db, parsed.conversation_id);
    } else if (parsed.kind === "turn") {
      orientation = await orientTurn(db, parsed.turn_id);
    } else if (parsed.kind === "cmsg") {
      orientation = await orientTurnByMessage(db, parsed.message_id);
    } else if (parsed.kind === "response") {
      orientation = await orientResponse(db, parsed.response_id);
    } else if (parsed.kind === "access_grant") {
      orientation = await orientGrant(db, parsed.grant_id);
    } else if (parsed.kind === "task_run") {
      orientation = await orientTaskRun(db, parsed.task_run_id);
    }
  } catch (error) {
    return {
      ok: false,
      error: "attachment_ref_resolve_failed",
      object_ref: parsed.object_ref,
      detail: String(error.message || error),
      unresolved: true,
      ...authorityClosedFields()
    };
  }

  const resolved = orientation.found === true;
  return {
    ok: true,
    schema: ATTACHMENT_REF_SCHEMA,
    kind: parsed.kind,
    object_ref: parsed.canonical_ref || parsed.object_ref,
    canonical_ref: parsed.canonical_ref || parsed.object_ref,
    unresolved: !resolved,
    orientation,
    ...authorityClosedFields()
  };
}

async function orientTurnByMessage(db, messageId) {
  const row = await db.prepare(
    `SELECT turn_id, conversation_id, message_id, seq, role, turn_type, actor_id, created_at
       FROM conversation_turns WHERE message_id = ?`
  ).bind(messageId).first();
  if (!row) return { found: false };
  return {
    found: true,
    turn_id: row.turn_id,
    conversation_id: row.conversation_id,
    message_id: row.message_id,
    seq: row.seq,
    role: row.role,
    turn_type: row.turn_type,
    actor_id: row.actor_id,
    created_at: row.created_at
  };
}

/**
 * Upgrade an attachment_set entry with resolver output.
 */
export function materializeAttachmentEntry(entry, resolved) {
  const base = isObject(entry) ? { ...entry } : { object_ref: String(entry || "") };
  const objectRef = resolved?.object_ref || base.object_ref || base.ref || null;
  return {
    attachment_id: base.attachment_id || null,
    object_ref: objectRef,
    attachment_ref: base.attachment_ref || null,
    kind: resolved?.kind || base.kind || null,
    unresolved: resolved?.ok ? Boolean(resolved.unresolved) : true,
    canonical_ref: resolved?.canonical_ref || objectRef,
    orientation: resolved?.orientation || null,
    accepted_state_authority: false,
    grants_no_capability: true
  };
}

export async function resolveAttachmentSet(db, attachmentSet) {
  const norm = normalizeAttachmentSet(attachmentSet);
  if (!norm.ok) return norm;
  const out = [];
  for (const entry of norm.attachment_set) {
    const raw = entry.object_ref || entry.attachment_ref;
    const resolved = raw ? await resolveObjectRef(db, raw) : {
      ok: false,
      error: "object_ref_required",
      unresolved: true,
      ...authorityClosedFields()
    };
    out.push(materializeAttachmentEntry(entry, resolved));
  }
  return {
    ok: true,
    schema: ATTACHMENT_REF_SCHEMA,
    attachment_set: out,
    resolved_count: out.filter(item => item.unresolved === false).length,
    unresolved_count: out.filter(item => item.unresolved !== false).length,
    ...authorityClosedFields()
  };
}

export async function resolveAttachmentRefsFromBody(body = {}, env = {}) {
  const bindings = envDb(env);
  if (!bindings.ok) return bindings;

  const actorId = isNonEmptyString(body.actor_id) ? body.actor_id.trim() : null;
  if (actorId && !ACTOR_ID_RE.test(actorId)) {
    return { ok: false, error: "invalid_actor_id", ...authorityClosedFields() };
  }

  // Direct refs list
  if (Array.isArray(body.object_refs) || Array.isArray(body.refs) || isNonEmptyString(body.object_ref)) {
    const list = Array.isArray(body.object_refs)
      ? body.object_refs
      : (Array.isArray(body.refs) ? body.refs : [body.object_ref]);
    if (list.length > MAX_REFS) {
      return { ok: false, error: "object_refs_too_large", max: MAX_REFS, ...authorityClosedFields() };
    }
    const resolved = [];
    for (const raw of list) {
      resolved.push(await resolveObjectRef(bindings.db, raw));
    }
    return {
      ok: true,
      schema: ATTACHMENT_REF_SCHEMA,
      resolved,
      ...authorityClosedFields()
    };
  }

  // Attachment set (standalone or from Conversation Session)
  if (body.attachment_set !== undefined) {
    return resolveAttachmentSet(bindings.db, body.attachment_set);
  }

  if (isNonEmptyString(body.conversation_id)) {
    if (!actorId) return { ok: false, error: "actor_id_required", ...authorityClosedFields() };
    const session = await getConversationSession(bindings.db, body.conversation_id);
    if (!session) {
      return { ok: false, error: "conversation_session_not_found", conversation_id: body.conversation_id, ...authorityClosedFields() };
    }
    const members = new Set([session.created_by, ...(session.selected_actors || [])]);
    if (!members.has(actorId)) {
      return {
        ok: false,
        error: "conversation_session_actor_not_member",
        conversation_id: session.conversation_id,
        ...authorityClosedFields()
      };
    }

    const resolvedSet = await resolveAttachmentSet(bindings.db, session.attachment_set);
    if (!resolvedSet.ok) return { ...resolvedSet, ...authorityClosedFields() };

    let conversation_session = null;
    if (body.apply === true) {
      if (!Number.isInteger(body.base_revision)) {
        return { ok: false, error: "base_revision_required", detail: "apply=true requires base_revision", ...authorityClosedFields() };
      }
      const updated = await updateConversationSession(bindings.db, {
        conversation_id: session.conversation_id,
        actor_id: actorId,
        base_revision: body.base_revision,
        attachment_set: resolvedSet.attachment_set
      });
      if (!updated.ok) return { ...updated, ...authorityClosedFields() };
      conversation_session = updated.conversation_session || updated;
    }

    return {
      ok: true,
      schema: ATTACHMENT_REF_SCHEMA,
      conversation_id: session.conversation_id,
      attachment_set: resolvedSet.attachment_set,
      resolved_count: resolvedSet.resolved_count,
      unresolved_count: resolvedSet.unresolved_count,
      applied: Boolean(conversation_session),
      conversation_session,
      ...authorityClosedFields()
    };
  }

  return {
    ok: false,
    error: "attachment_resolve_input_required",
    detail: "Pass object_ref(s), attachment_set, or conversation_id",
    ...authorityClosedFields()
  };
}

export const ATTACHMENT_REF_RESOLVE_TOOL_DEFINITION = Object.freeze({
  name: ATTACHMENT_REF_BROKER_TOOL_IDS.resolve,
  description: "V7.7.10b: resolve/normalize typed object_ref attachments (stone:, ac1:, msg:, repo:owner/repo@40hex, session:cs:…, conversation/turn/response). Bounded orientation only; never grants capability or moves HEADs. Optionally apply resolved attachment_set onto a Conversation Session (CAS).",
  inputSchema: {
    type: "object",
    properties: {
      actor_id: { type: "string" },
      object_ref: { type: "string" },
      object_refs: { type: "array", maxItems: MAX_REFS, items: { type: "string" } },
      refs: { type: "array", maxItems: MAX_REFS, items: { type: "string" } },
      attachment_set: { type: "array", maxItems: 100 },
      conversation_id: { type: "string", description: "cvs:… — resolve session attachment_set" },
      apply: { type: "boolean", description: "When true with conversation_id, CAS-write resolved attachment_set" },
      base_revision: { type: "number", minimum: 1 }
    },
    additionalProperties: false
  }
});

export const ATTACHMENT_REF_MCP_TOOL_DEFINITIONS = Object.freeze([
  ATTACHMENT_REF_RESOLVE_TOOL_DEFINITION
]);

// Stable helper for tests / docs
export function attachmentRefDigest(resolvedList) {
  return stableJson(resolvedList.map(item => ({
    kind: item.kind,
    object_ref: item.object_ref,
    unresolved: item.unresolved
  })));
}
