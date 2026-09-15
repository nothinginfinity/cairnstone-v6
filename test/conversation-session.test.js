import test from "node:test";
import assert from "node:assert/strict";
import {
  CONVERSATION_INTENT_MODES,
  CONVERSATION_SESSION_BROKER_TOOL_IDS,
  CONVERSATION_SESSION_MCP_TOOL_DEFINITIONS,
  CONVERSATION_SESSION_MUTATION_TOOL_IDS,
  CONVERSATION_SESSION_READ_TOOL_IDS,
  CONVERSATION_SESSION_SCHEMA,
  CONVERSATION_TURN_SCHEMA,
  appendConversationTurnFromBody,
  createConversationSessionFromBody,
  getConversationSessionFromBody,
  listConversationSessionsFromBody,
  normalizeAttachmentSet,
  scrubSecretsDeep,
  updateConversationSessionFromBody
} from "../src/conversation-session.js";
import {
  DEFAULT_TOOL_BROKER_REGISTRY,
  toolRegistryFromBody
} from "../src/model-router.js";
import { listAutomaticReadToolIds } from "../src/delegate-loop.js";
import { mcpToolsForProfile } from "../src/index.js";

const ACTOR_A = "chatgpt:cairnstone-v6";
const ACTOR_B = "claude:cairnstone-v6";
const ACTOR_C = "grok:cairnstone-v6";
const CVS_ID = "cvs:v7710a-demo";

class FakeConversationD1 {
  constructor() {
    this.sessions = new Map();
    this.turns = new Map();
    this.chainHeads = new Map([["cairnstone-v6-project-memory", "deadbeef"]]);
    this.pathHeads = new Map([["cairnstone-v6-project-memory\0docs/ROADMAP_V7.md", "cafe"]]);
    this.headMutationAttempts = [];
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
            if (sql.includes("INSERT INTO conversation_sessions")) {
              const [
                conversationId, status, attachmentSetJson, activeScopeJson, selectedActorsJson,
                selectedRepo, selectedChain, codeSessionId, lastResponseIdsJson,
                routingEnvelopeJson, toolReceiptsJson, intentMode, accessGrantIdsJson,
                taskRunIdsJson, workspaceId, createdBy, createdAt, updatedAt
              ] = args;
              if (db.sessions.has(conversationId)) {
                throw new Error("UNIQUE constraint failed: conversation_sessions.conversation_id");
              }
              db.sessions.set(conversationId, {
                conversation_id: conversationId,
                status,
                message_log_json: "[]",
                attachment_set_json: attachmentSetJson,
                active_scope_json: activeScopeJson,
                selected_actors_json: selectedActorsJson,
                selected_repo: selectedRepo,
                selected_chain: selectedChain,
                code_session_id: codeSessionId,
                last_response_ids_json: lastResponseIdsJson,
                routing_envelope_json: routingEnvelopeJson,
                tool_receipts_json: toolReceiptsJson,
                intent_mode: intentMode,
                access_grant_ids_json: accessGrantIdsJson,
                task_run_ids_json: taskRunIdsJson,
                workspace_id: workspaceId,
                session_revision: 1,
                created_by: createdBy,
                created_at: createdAt,
                updated_at: updatedAt,
                accepted_state_authority: 0
              });
              return { success: true, meta: { changes: 1 } };
            }
            if (sql.includes("INSERT INTO conversation_turns")) {
              const [
                turnId, conversationId, messageId, seq, role, turnType, contentRef,
                contentPreview, responseIdsJson, contextPackId, toolReceiptRefsJson,
                attachmentRefsJson, accessGrantIdsJson, objectRefsJson, taskRunIdsJson,
                routingEnvelopeJson, intentMode, actorId, createdAt
              ] = args;
              if (db.turns.has(turnId) || [...db.turns.values()].some(t => t.message_id === messageId)) {
                throw new Error("UNIQUE constraint failed: conversation_turns");
              }
              db.turns.set(turnId, {
                turn_id: turnId,
                conversation_id: conversationId,
                message_id: messageId,
                seq,
                role,
                turn_type: turnType,
                content_ref: contentRef,
                content_preview: contentPreview,
                response_ids_json: responseIdsJson,
                context_pack_id: contextPackId,
                tool_receipt_refs_json: toolReceiptRefsJson,
                attachment_refs_json: attachmentRefsJson,
                access_grant_ids_json: accessGrantIdsJson,
                object_refs_json: objectRefsJson,
                task_run_ids_json: taskRunIdsJson,
                routing_envelope_json: routingEnvelopeJson,
                intent_mode: intentMode,
                actor_id: actorId,
                created_at: createdAt
              });
              return { success: true, meta: { changes: 1 } };
            }
            if (sql.includes("UPDATE conversation_sessions") && sql.includes("message_log_json")) {
              const [
                messageLogJson, lastResponseIdsJson, toolReceiptsJson, routingEnvelopeJson,
                accessGrantIdsJson, taskRunIdsJson, intentMode, sessionRevision, updatedAt,
                conversationId, baseRevision
              ] = args;
              const row = db.sessions.get(conversationId);
              if (!row || row.session_revision !== baseRevision) {
                return { success: true, meta: { changes: 0 } };
              }
              const nextStatus = row.status === "paused" ? "active" : row.status;
              db.sessions.set(conversationId, {
                ...row,
                message_log_json: messageLogJson,
                last_response_ids_json: lastResponseIdsJson,
                tool_receipts_json: toolReceiptsJson,
                routing_envelope_json: routingEnvelopeJson,
                access_grant_ids_json: accessGrantIdsJson,
                task_run_ids_json: taskRunIdsJson,
                intent_mode: intentMode,
                session_revision: sessionRevision,
                updated_at: updatedAt,
                status: nextStatus
              });
              return { success: true, meta: { changes: 1 } };
            }
            if (sql.includes("UPDATE conversation_sessions")) {
              const [
                status, attachmentSetJson, activeScopeJson, selectedActorsJson,
                selectedRepo, selectedChain, codeSessionId, lastResponseIdsJson,
                routingEnvelopeJson, toolReceiptsJson, intentMode, accessGrantIdsJson,
                taskRunIdsJson, workspaceId, sessionRevision, updatedAt,
                conversationId, baseRevision
              ] = args;
              const row = db.sessions.get(conversationId);
              if (!row || row.session_revision !== baseRevision) {
                return { success: true, meta: { changes: 0 } };
              }
              db.sessions.set(conversationId, {
                ...row,
                status,
                attachment_set_json: attachmentSetJson,
                active_scope_json: activeScopeJson,
                selected_actors_json: selectedActorsJson,
                selected_repo: selectedRepo,
                selected_chain: selectedChain,
                code_session_id: codeSessionId,
                last_response_ids_json: lastResponseIdsJson,
                routing_envelope_json: routingEnvelopeJson,
                tool_receipts_json: toolReceiptsJson,
                intent_mode: intentMode,
                access_grant_ids_json: accessGrantIdsJson,
                task_run_ids_json: taskRunIdsJson,
                workspace_id: workspaceId,
                session_revision: sessionRevision,
                updated_at: updatedAt
              });
              return { success: true, meta: { changes: 1 } };
            }
            return { success: true, meta: { changes: 0 } };
          },
          async first() {
            if (sql.includes("FROM conversation_sessions WHERE conversation_id")) {
              const [conversationId] = args;
              return db.sessions.get(conversationId) || null;
            }
            return null;
          },
          async all() {
            if (sql.includes("FROM conversation_turns")) {
              const [conversationId] = args;
              const rows = [...db.turns.values()]
                .filter(row => row.conversation_id === conversationId)
                .sort((a, b) => a.seq - b.seq);
              return { results: rows };
            }
            if (sql.includes("FROM conversation_sessions")) {
              const rows = [...db.sessions.values()]
                .sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at)));
              return { results: rows };
            }
            return { results: [] };
          }
        };
      }
    };
  }
}

function envFor(db) {
  return { CAIRNSTONE_DB: db };
}

test("V7.7.10a schema constants and intent modes", () => {
  assert.equal(CONVERSATION_SESSION_SCHEMA, "cairnstone-conversation-session-v1");
  assert.equal(CONVERSATION_TURN_SCHEMA, "cairnstone-conversation-turn-v1");
  assert.deepEqual([...CONVERSATION_INTENT_MODES], ["read", "compare", "propose-action"]);
  assert.equal(CONVERSATION_SESSION_MCP_TOOL_DEFINITIONS.length, 5);
});

test("normalizeAttachmentSet stores opaque typed refs without resolving", () => {
  const norm = normalizeAttachmentSet([
    "stone:abc123",
    { object_ref: "msg:inbox-1", attachment_ref: "att:1", kind: "message" }
  ]);
  assert.equal(norm.ok, true);
  assert.equal(norm.attachment_set.length, 2);
  assert.equal(norm.attachment_set[0].object_ref, "stone:abc123");
  assert.equal(norm.attachment_set[0].unresolved, true);
  assert.equal(norm.attachment_set[0].accepted_state_authority, false);
  assert.equal(norm.attachment_set[1].attachment_ref, "att:1");
});

test("create → get → append turn → resume survives with authority closed", async () => {
  const db = new FakeConversationD1();
  const headsBefore = {
    chain: new Map(db.chainHeads),
    path: new Map(db.pathHeads)
  };

  const created = await createConversationSessionFromBody({
    conversation_id: CVS_ID,
    created_by: ACTOR_A,
    selected_actors: [ACTOR_B],
    selected_repo: "nothinginfinity/cairnstone-v6",
    selected_chain: "cairnstone-v6-project-memory",
    code_session_id: "cs:optional-bind",
    intent_mode: "read",
    access_grant_ids: ["grant:opaque-1"],
    task_run_ids: ["tr:opaque-1"],
    attachment_set: [{ object_ref: "stone:deadbeef", kind: "stone" }],
    active_scope: "cairnstone-v6-project-memory"
  }, envFor(db));

  assert.equal(created.ok, true);
  assert.equal(created.schema, CONVERSATION_SESSION_SCHEMA);
  assert.equal(created.accepted_state_authority, false);
  assert.equal(created.grants_no_capability, true);
  assert.equal(created.project_memory_promoted, false);
  assert.equal(created.session_revision, 1);
  assert.deepEqual(created.access_grant_ids, ["grant:opaque-1"]);
  assert.deepEqual(created.task_run_ids, ["tr:opaque-1"]);
  assert.ok(created.selected_actors.includes(ACTOR_A));
  assert.ok(created.selected_actors.includes(ACTOR_B));

  const got = await getConversationSessionFromBody({
    conversation_id: CVS_ID,
    actor_id: ACTOR_A
  }, envFor(db));
  assert.equal(got.ok, true);
  assert.equal(got.resume.conversation_id, CVS_ID);
  assert.equal(got.resume.message_count, 0);

  const appended = await appendConversationTurnFromBody({
    conversation_id: CVS_ID,
    actor_id: ACTOR_A,
    base_revision: 1,
    turn_id: "turn:v7710a-1",
    message_id: "cmsg:v7710a-1",
    role: "user",
    content_preview: "What happened overnight?",
    response_ids: ["gr:resp-1"],
    object_refs: ["msg:overnight"],
    access_grant_ids: ["grant:opaque-2"],
    task_run_ids: ["tr:opaque-2"],
    tool_receipt_refs: ["receipt:tool-1"],
    intent_mode: "compare"
  }, envFor(db));

  assert.equal(appended.ok, true);
  assert.equal(appended.turn.schema, CONVERSATION_TURN_SCHEMA);
  assert.equal(appended.turn.turn_id, "turn:v7710a-1");
  assert.equal(appended.turn.message_id, "cmsg:v7710a-1");
  assert.equal(appended.turn.seq, 1);
  assert.equal(appended.conversation_session.session_revision, 2);
  assert.equal(appended.conversation_session.intent_mode, "compare");
  assert.ok(appended.conversation_session.access_grant_ids.includes("grant:opaque-2"));
  assert.ok(appended.conversation_session.task_run_ids.includes("tr:opaque-2"));
  assert.equal(appended.accepted_state_authority, false);

  const resumed = await getConversationSessionFromBody({
    conversation_id: CVS_ID,
    actor_id: ACTOR_B
  }, envFor(db));
  assert.equal(resumed.ok, true);
  assert.equal(resumed.resume.message_count, 1);
  assert.equal(resumed.turns.length, 1);
  assert.equal(resumed.turns[0].turn_id, "turn:v7710a-1");
  assert.equal(resumed.message_log[0].message_id, "cmsg:v7710a-1");
  assert.equal(resumed.accepted_state_authority, false);
  assert.equal(resumed.chain_heads_mutated, false);
  assert.equal(resumed.path_heads_mutated, false);
  assert.equal(resumed.conversation_history_is_not_project_memory, true);

  assert.deepEqual([...db.chainHeads.entries()], [...headsBefore.chain.entries()]);
  assert.deepEqual([...db.pathHeads.entries()], [...headsBefore.path.entries()]);
  assert.equal(db.headMutationAttempts.length, 0);
});

test("update CAS conflict + actor membership fail-closed", async () => {
  const db = new FakeConversationD1();
  const created = await createConversationSessionFromBody({
    conversation_id: CVS_ID,
    created_by: ACTOR_A,
    selected_actors: [ACTOR_B]
  }, envFor(db));
  assert.equal(created.ok, true);

  const denied = await updateConversationSessionFromBody({
    conversation_id: CVS_ID,
    actor_id: ACTOR_C,
    base_revision: 1,
    intent_mode: "propose-action"
  }, envFor(db));
  assert.equal(denied.ok, false);
  assert.equal(denied.error, "conversation_session_actor_not_member");
  assert.equal(denied.accepted_state_authority, false);

  const conflict = await updateConversationSessionFromBody({
    conversation_id: CVS_ID,
    actor_id: ACTOR_A,
    base_revision: 99,
    intent_mode: "propose-action"
  }, envFor(db));
  assert.equal(conflict.ok, false);
  assert.equal(conflict.error, "conversation_session_conflict");

  const updated = await updateConversationSessionFromBody({
    conversation_id: CVS_ID,
    actor_id: ACTOR_B,
    base_revision: 1,
    status: "paused",
    intent_mode: "propose-action",
    task_run_ids: ["tr:proposed"]
  }, envFor(db));
  assert.equal(updated.ok, true);
  assert.equal(updated.status, "paused");
  assert.equal(updated.intent_mode, "propose-action");
  assert.deepEqual(updated.task_run_ids, ["tr:proposed"]);
  assert.equal(updated.session_revision, 2);
});

test("append on paused resumes to active; closed rejects append", async () => {
  const db = new FakeConversationD1();
  await createConversationSessionFromBody({
    conversation_id: CVS_ID,
    created_by: ACTOR_A
  }, envFor(db));
  await updateConversationSessionFromBody({
    conversation_id: CVS_ID,
    actor_id: ACTOR_A,
    base_revision: 1,
    status: "paused"
  }, envFor(db));

  const appended = await appendConversationTurnFromBody({
    conversation_id: CVS_ID,
    actor_id: ACTOR_A,
    base_revision: 2,
    turn_id: "turn:resume-1",
    message_id: "cmsg:resume-1",
    role: "assistant",
    content_preview: "Resumed."
  }, envFor(db));
  assert.equal(appended.ok, true);
  assert.equal(appended.conversation_session.status, "active");

  await updateConversationSessionFromBody({
    conversation_id: CVS_ID,
    actor_id: ACTOR_A,
    base_revision: 3,
    status: "closed"
  }, envFor(db));
  const rejected = await appendConversationTurnFromBody({
    conversation_id: CVS_ID,
    actor_id: ACTOR_A,
    base_revision: 4,
    turn_id: "turn:closed-1",
    message_id: "cmsg:closed-1",
    role: "user"
  }, envFor(db));
  assert.equal(rejected.ok, false);
  assert.equal(rejected.error, "conversation_session_not_appendable");
});

test("list returns only actor-visible sessions", async () => {
  const db = new FakeConversationD1();
  await createConversationSessionFromBody({
    conversation_id: "cvs:mine",
    created_by: ACTOR_A
  }, envFor(db));
  await createConversationSessionFromBody({
    conversation_id: "cvs:shared",
    created_by: ACTOR_B,
    selected_actors: [ACTOR_A]
  }, envFor(db));
  await createConversationSessionFromBody({
    conversation_id: "cvs:other",
    created_by: ACTOR_C
  }, envFor(db));

  const listed = await listConversationSessionsFromBody({
    actor_id: ACTOR_A,
    limit: 10
  }, envFor(db));
  assert.equal(listed.ok, true);
  const ids = listed.conversations.map(c => c.conversation_id).sort();
  assert.deepEqual(ids, ["cvs:mine", "cvs:shared"]);
  assert.equal(listed.accepted_state_authority, false);
});

test("scrubSecretsDeep redacts capability-like keys", () => {
  const scrubbed = scrubSecretsDeep({
    workspace_capability: "secret-bearer",
    nested: { api_key: "k", ok: true }
  });
  assert.equal(scrubbed.workspace_capability, "[REDACTED]");
  assert.equal(scrubbed.nested.api_key, "[REDACTED]");
  assert.equal(scrubbed.nested.ok, true);
});

test("conversation tools are in MCP catalog, broker-scoped, never automatic-read", () => {
  const names = mcpToolsForProfile(false).map(tool => tool.name);
  for (const id of Object.values(CONVERSATION_SESSION_BROKER_TOOL_IDS)) {
    assert.ok(names.includes(id), `missing MCP tool ${id}`);
  }

  const registry = toolRegistryFromBody({}, { registry: DEFAULT_TOOL_BROKER_REGISTRY });
  assert.equal(registry.ok, true);
  const byId = new Map(registry.tools.map(tool => [tool.tool_id, tool]));
  for (const id of CONVERSATION_SESSION_MUTATION_TOOL_IDS) {
    assert.equal(byId.get(id).risk_class, "mutation");
    assert.equal(byId.get(id).authorization, "scoped_grant");
  }
  for (const id of CONVERSATION_SESSION_READ_TOOL_IDS) {
    assert.equal(byId.get(id).risk_class, "read");
    assert.equal(byId.get(id).authorization, "scoped_grant");
  }

  const automatic = new Set(listAutomaticReadToolIds());
  for (const id of Object.values(CONVERSATION_SESSION_BROKER_TOOL_IDS)) {
    assert.equal(automatic.has(id), false, `${id} must not be automatic-read`);
  }
});

test("create rejects non-empty message_log bootstrap and invalid ids", async () => {
  const db = new FakeConversationD1();
  const badLog = await createConversationSessionFromBody({
    conversation_id: CVS_ID,
    created_by: ACTOR_A,
    message_log: [{ role: "user" }]
  }, envFor(db));
  assert.equal(badLog.ok, false);
  assert.equal(badLog.error, "message_log_must_start_empty");

  const badId = await createConversationSessionFromBody({
    conversation_id: "bad-id",
    created_by: ACTOR_A
  }, envFor(db));
  assert.equal(badId.ok, false);
});
