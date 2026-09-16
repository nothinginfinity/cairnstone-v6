import test from "node:test";
import assert from "node:assert/strict";
import {
  parseObjectRef,
  resolveObjectRef,
  resolveAttachmentRefsFromBody,
  ATTACHMENT_REF_BROKER_TOOL_IDS,
  ATTACHMENT_REF_MCP_TOOL_DEFINITIONS
} from "../src/attachment-refs.js";
import {
  createAccessGrantFromBody,
  getAccessGrantFromBody,
  listAccessGrantsFromBody,
  revokeAccessGrantFromBody,
  markAccessGrantFirstReadFromBody,
  ACCESS_GRANT_BROKER_TOOL_IDS,
  ACCESS_GRANT_MUTATION_TOOL_IDS,
  ACCESS_GRANT_READ_TOOL_IDS,
  ACCESS_GRANT_PERMISSIONS,
  ACCESS_GRANT_SCHEMA
} from "../src/access-grant.js";
import {
  proposeTaskRunFromBody,
  getTaskRunFromBody,
  listTaskRunsFromBody,
  TASK_RUN_BROKER_TOOL_IDS,
  TASK_RUN_MUTATION_TOOL_IDS,
  TASK_RUN_READ_TOOL_IDS,
  TASK_RUN_SCHEMA
} from "../src/task-run.js";
import {
  buildForwardNoteContent,
  forwardWithNoteFromBody,
  FORWARD_NOTE_BROKER_TOOL_IDS,
  FORWARD_NOTE_SCHEMA
} from "../src/forward-note.js";
import {
  createConversationSessionFromBody
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
const STONE_HASH = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const REPO_SHA = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

class FakeV7710bD1 {
  constructor() {
    this.grants = new Map();
    this.taskRuns = new Map();
    this.sessions = new Map();
    this.turns = new Map();
    this.stones = new Map([
      [STONE_HASH, {
        hash: STONE_HASH,
        title: "Demo stone",
        author: ACTOR_A,
        created_at: "2026-09-15T00:00:00.000Z",
        repo: "nothinginfinity/cairnstone-v6",
        commit_sha: REPO_SHA,
        chain_hash: "cairnstone-v6-project-memory",
        path: "docs/demo.md"
      }]
    ]);
    this.deliveries = new Map();
    this.codeSessions = new Map();
    this.grounded = new Map();
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
            if (sql.includes("INSERT INTO access_grants")) {
              const [
                grantId, schema, objectRef, principal, permission, grantor,
                createdAt, expiresAt, notify
              ] = args;
              if (db.grants.has(grantId)) {
                throw new Error("UNIQUE constraint failed: access_grants.grant_id");
              }
              db.grants.set(grantId, {
                grant_id: grantId,
                schema,
                object_ref: objectRef,
                principal_actor_id: principal,
                permission,
                grantor_actor_id: grantor,
                created_at: createdAt,
                expires_at: expiresAt,
                revoked_at: null,
                status: "granted",
                first_read_at: null,
                notify,
                notify_message_id: null,
                notify_stone_hash: null,
                accepted_state_authority: 0
              });
              return { success: true, meta: { changes: 1 } };
            }
            if (sql.includes("UPDATE access_grants") && sql.includes("notify_message_id")) {
              const [messageId, stoneHash, grantId] = args;
              const row = db.grants.get(grantId);
              if (row) {
                db.grants.set(grantId, {
                  ...row,
                  notify_message_id: messageId,
                  notify_stone_hash: stoneHash
                });
              }
              return { success: true, meta: { changes: row ? 1 : 0 } };
            }
            if (sql.includes("UPDATE access_grants") && sql.includes("status = 'revoked'")) {
              const [revokedAt, grantId] = args;
              const row = db.grants.get(grantId);
              if (!row || row.status === "revoked") {
                return { success: true, meta: { changes: 0 } };
              }
              db.grants.set(grantId, { ...row, status: "revoked", revoked_at: revokedAt });
              return { success: true, meta: { changes: 1 } };
            }
            if (sql.includes("UPDATE access_grants") && sql.includes("status = 'first_read'")) {
              const [firstReadAt, grantId] = args;
              const row = db.grants.get(grantId);
              if (!row || row.status !== "granted") {
                return { success: true, meta: { changes: 0 } };
              }
              db.grants.set(grantId, { ...row, status: "first_read", first_read_at: firstReadAt });
              return { success: true, meta: { changes: 1 } };
            }
            if (sql.includes("INSERT INTO task_runs")) {
              if (sql.includes("required_capabilities_json") || args.length >= 16) {
                const [
                  taskRunId, schema, conversationId, parentTurnId, requestedBy,
                  assignee, intent, attachmentRefsJson, objectRefsJson, note,
                  capsJson, policy, budgetJson, parentId, delegationDepth,
                  createdAt, updatedAt
                ] = args;
                if (db.taskRuns.has(taskRunId)) {
                  throw new Error("UNIQUE constraint failed: task_runs.task_run_id");
                }
                db.taskRuns.set(taskRunId, {
                  task_run_id: taskRunId,
                  schema,
                  status: "proposed",
                  conversation_id: conversationId,
                  parent_turn_id: parentTurnId,
                  requested_by: requestedBy,
                  assignee_actor_id: assignee,
                  requested_intent: intent,
                  intent_mode: "propose-action",
                  attachment_refs_json: attachmentRefsJson,
                  object_refs_json: objectRefsJson,
                  note,
                  dispatch_state: "not_dispatched",
                  selected_executor_id: null,
                  required_capabilities_json: capsJson || "[]",
                  policy_preset: policy || null,
                  budget_envelope_json: budgetJson || null,
                  parent_task_run_id: parentId || null,
                  child_task_run_ids_json: "[]",
                  delegation_depth: delegationDepth || 0,
                  created_at: createdAt,
                  updated_at: updatedAt,
                  cancelled_at: null,
                  accepted_state_authority: 0
                });
                return { success: true, meta: { changes: 1 } };
              }
              const [
                taskRunId, schema, conversationId, parentTurnId, requestedBy,
                assignee, intent, attachmentRefsJson, objectRefsJson, note,
                createdAt, updatedAt
              ] = args;
              if (db.taskRuns.has(taskRunId)) {
                throw new Error("UNIQUE constraint failed: task_runs.task_run_id");
              }
              db.taskRuns.set(taskRunId, {
                task_run_id: taskRunId,
                schema,
                status: "proposed",
                conversation_id: conversationId,
                parent_turn_id: parentTurnId,
                requested_by: requestedBy,
                assignee_actor_id: assignee,
                requested_intent: intent,
                intent_mode: "propose-action",
                attachment_refs_json: attachmentRefsJson,
                object_refs_json: objectRefsJson,
                note,
                dispatch_state: "not_dispatched",
                selected_executor_id: null,
                created_at: createdAt,
                updated_at: updatedAt,
                cancelled_at: null,
                accepted_state_authority: 0
              });
              return { success: true, meta: { changes: 1 } };
            }
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
            if (sql.includes("FROM access_grants WHERE grant_id")) {
              return db.grants.get(args[0]) || null;
            }
            if (sql.includes("FROM task_runs WHERE task_run_id")) {
              return db.taskRuns.get(args[0]) || null;
            }
            if (sql.includes("FROM stones WHERE hash")) {
              return db.stones.get(args[0]) || null;
            }
            if (sql.includes("FROM correspondence_deliveries") && sql.includes("message_id")) {
              for (const row of db.deliveries.values()) {
                if (row.message_id === args[0]) return row;
              }
              return null;
            }
            if (sql.includes("FROM code_sessions WHERE code_session_id")) {
              return db.codeSessions.get(args[0]) || null;
            }
            if (sql.includes("FROM conversation_sessions WHERE conversation_id")) {
              return db.sessions.get(args[0]) || null;
            }
            if (sql.includes("FROM conversation_turns WHERE turn_id")) {
              return db.turns.get(args[0]) || null;
            }
            if (sql.includes("FROM conversation_turns WHERE message_id")) {
              for (const row of db.turns.values()) {
                if (row.message_id === args[0]) return row;
              }
              return null;
            }
            if (sql.includes("FROM grounded_responses WHERE response_id")) {
              return db.grounded.get(args[0]) || null;
            }
            return null;
          },
          async all() {
            if (sql.includes("FROM access_grants")) {
              const [actorA, actorB, principalFilter, , grantorFilter, , objectRefFilter, , status, , lim] = args;
              const results = [...db.grants.values()].filter(row => {
                const visible = row.principal_actor_id === actorA || row.grantor_actor_id === actorB
                  || row.principal_actor_id === actorB || row.grantor_actor_id === actorA;
                if (!visible) return false;
                if (principalFilter && row.principal_actor_id !== principalFilter) return false;
                if (grantorFilter && row.grantor_actor_id !== grantorFilter) return false;
                if (objectRefFilter && row.object_ref !== objectRefFilter) return false;
                if (status && row.status !== status) return false;
                return true;
              }).sort((a, b) => String(b.created_at).localeCompare(String(a.created_at))).slice(0, lim);
              return { results };
            }
            if (sql.includes("FROM task_runs")) {
              const actorA = args[0];
              const status = args[3];
              const conversationId = args[5];
              const assignee = args[7];
              const lim = args[args.length - 1];
              const results = [...db.taskRuns.values()].filter(row => {
                const visible = row.requested_by === actorA || row.assignee_actor_id === actorA
                  || row.human_committed_by === actorA;
                if (!visible) return false;
                if (status && row.status !== status) return false;
                if (conversationId && row.conversation_id !== conversationId) return false;
                if (assignee && row.assignee_actor_id !== assignee) return false;
                return true;
              }).sort((a, b) => String(b.created_at).localeCompare(String(a.created_at))).slice(0, lim);
              return { results };
            }
            if (sql.includes("FROM conversation_turns")) {
              const conversationId = args[0];
              const results = [...db.turns.values()]
                .filter(row => row.conversation_id === conversationId)
                .sort((a, b) => a.seq - b.seq);
              return { results };
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

test("parseObjectRef covers stone/ac1/msg/repo/session/conversation/turn/response", () => {
  assert.equal(parseObjectRef(`stone:${STONE_HASH}`).kind, "stone");
  assert.equal(parseObjectRef(`ac1:${STONE_HASH}`).kind, "ac1");
  assert.equal(parseObjectRef("msg:demo-1").kind, "msg");
  const repo = parseObjectRef(`repo:nothinginfinity/cairnstone-v6@${REPO_SHA}`);
  assert.equal(repo.ok, true);
  assert.equal(repo.kind, "repo");
  assert.equal(repo.commit_sha, REPO_SHA);
  assert.equal(parseObjectRef("repo:nothinginfinity/cairnstone-v6@main").ok, false);
  assert.equal(parseObjectRef("session:cs:demo").kind, "session");
  assert.equal(parseObjectRef("cvs:demo").kind, "conversation");
  assert.equal(parseObjectRef("turn:demo-1").kind, "turn");
  assert.equal(parseObjectRef("response:gr-1").kind, "response");
});

test("resolveObjectRef returns bounded orientation without granting capability", async () => {
  const db = new FakeV7710bD1();
  const resolved = await resolveObjectRef(db, `stone:${STONE_HASH}`);
  assert.equal(resolved.ok, true);
  assert.equal(resolved.unresolved, false);
  assert.equal(resolved.orientation.found, true);
  assert.equal(resolved.accepted_state_authority, false);
  assert.equal(resolved.grants_no_capability, true);
  assert.equal(resolved.capability_granted, false);
  assert.equal(db.headMutationAttempts.length, 0);
});

test("access grant lifecycle: create → first_read → revoke", async () => {
  const db = new FakeV7710bD1();
  const created = await createAccessGrantFromBody({
    grant_id: "grant:demo-1",
    object_ref: `msg:original-1`,
    principal_actor_id: ACTOR_B,
    permission: "read",
    grantor_actor_id: ACTOR_A,
    notify: false
  }, envFor(db));
  assert.equal(created.ok, true);
  assert.equal(created.access_grant.schema, ACCESS_GRANT_SCHEMA);
  assert.equal(created.access_grant.status, "granted");
  assert.equal(created.access_grant.permission_policy.implies_execute, false);
  assert.equal(created.access_grant.accepted_state_authority, false);

  const first = await markAccessGrantFirstReadFromBody({
    grant_id: "grant:demo-1",
    actor_id: ACTOR_B
  }, envFor(db));
  assert.equal(first.ok, true);
  assert.equal(first.access_grant.status, "first_read");
  assert.ok(first.access_grant.first_read_at);

  const revoked = await revokeAccessGrantFromBody({
    grant_id: "grant:demo-1",
    actor_id: ACTOR_A
  }, envFor(db));
  assert.equal(revoked.ok, true);
  assert.equal(revoked.access_grant.status, "revoked");
  assert.equal(revoked.revoke_semantics, "future_access_only");

  const listed = await listAccessGrantsFromBody({
    actor_id: ACTOR_A,
    object_ref: "msg:original-1"
  }, envFor(db));
  assert.equal(listed.ok, true);
  assert.equal(listed.grants.length, 1);
  assert.equal(listed.grants[0].status, "revoked");
  assert.equal(db.headMutationAttempts.length, 0);
});

test("read/discuss never imply execute; execute-against is recorded only", async () => {
  const db = new FakeV7710bD1();
  for (const permission of ACCESS_GRANT_PERMISSIONS) {
    const created = await createAccessGrantFromBody({
      grant_id: `grant:perm-${permission}`,
      object_ref: `stone:${STONE_HASH}`,
      principal_actor_id: ACTOR_B,
      permission,
      grantor_actor_id: ACTOR_A
    }, envFor(db));
    assert.equal(created.ok, true);
    assert.equal(created.access_grant.permission_policy.implies_execute, false);
    assert.equal(created.access_grant.permission_policy.implies_mutate, false);
    assert.equal(created.execute_implied, false);
    if (permission === "execute-against") {
      assert.equal(created.access_grant.permission_policy.execute_against_recorded_only, true);
    }
  }
});

test("task run propose is non-dispatching and references same object refs", async () => {
  const db = new FakeV7710bD1();
  const objectRef = `msg:assign-target`;
  const proposed = await proposeTaskRunFromBody({
    task_run_id: "tr:demo-1",
    actor_id: ACTOR_A,
    assignee_actor_id: ACTOR_B,
    attachment_refs: [objectRef],
    note: "please work on this"
  }, envFor(db));
  assert.equal(proposed.ok, true);
  assert.equal(proposed.task_run.schema, TASK_RUN_SCHEMA);
  assert.equal(proposed.task_run.status, "proposed");
  assert.equal(proposed.task_run.dispatch_state, "not_dispatched");
  assert.equal(proposed.task_run.dispatched, false);
  assert.equal(proposed.task_run.executor_invoked, false);
  assert.equal(proposed.task_run.access_granted_by_assign, false);
  assert.deepEqual(proposed.task_run.attachment_refs, [objectRef]);
  assert.equal(proposed.task_run.proposal.dispatchable, true);
  assert.equal(proposed.task_run.proposal.requires_human_dispatch, true);

  const got = await getTaskRunFromBody({
    task_run_id: "tr:demo-1",
    actor_id: ACTOR_A
  }, envFor(db));
  assert.equal(got.ok, true);
  assert.equal(got.task_run.dispatch_state, "not_dispatched");

  const listed = await listTaskRunsFromBody({ actor_id: ACTOR_B }, envFor(db));
  assert.equal(listed.ok, true);
  assert.equal(listed.task_runs.length, 1);
  assert.equal(db.headMutationAttempts.length, 0);
});

test("forward with note creates AC1 referencing original without being default share", async () => {
  const built = buildForwardNoteContent({
    note: "FYI — please review",
    object_ref: "msg:original-42",
    from: ACTOR_A,
    to: [ACTOR_C]
  });
  assert.equal(built.ok, true);
  assert.match(built.content, /cairnstone-forward-note-v1/);
  assert.match(built.content, /msg:original-42/);
  assert.match(built.content, /default_share_path":false/);

  const sentBodies = [];
  const forwarded = await forwardWithNoteFromBody({
    from: ACTOR_A,
    to: [ACTOR_C],
    note: "FYI — please review",
    object_ref: "msg:original-42",
    message_id: "msg:forward-1"
  }, {}, {
    sendMessage: async (body) => {
      sentBodies.push(body);
      return {
        ok: true,
        message_id: body.message_id,
        thread_id: body.thread_id || body.message_id,
        stone_hash: STONE_HASH,
        deliveries: [{ recipient_id: ACTOR_C, status: "delivered" }]
      };
    }
  });
  assert.equal(forwarded.ok, true);
  assert.equal(forwarded.schema, FORWARD_NOTE_SCHEMA);
  assert.equal(forwarded.is_default_share_path, false);
  assert.equal(forwarded.distinct_from_give_access, true);
  assert.equal(forwarded.copies_canonical_payload, false);
  assert.equal(sentBodies.length, 1);
  assert.match(sentBodies[0].content, /msg:original-42/);
});

test("attachment resolve can apply onto conversation session attachment_set", async () => {
  const db = new FakeV7710bD1();
  const created = await createConversationSessionFromBody({
    conversation_id: "cvs:attach-demo",
    created_by: ACTOR_A,
    attachment_set: [`stone:${STONE_HASH}`, `repo:nothinginfinity/cairnstone-v6@${REPO_SHA}`]
  }, envFor(db));
  assert.equal(created.ok, true);
  assert.equal(created.attachment_set[0].unresolved, true);

  const resolved = await resolveAttachmentRefsFromBody({
    actor_id: ACTOR_A,
    conversation_id: "cvs:attach-demo",
    apply: true,
    base_revision: 1
  }, envFor(db));
  assert.equal(resolved.ok, true);
  assert.equal(resolved.applied, true);
  assert.equal(resolved.resolved_count, 2);
  assert.equal(resolved.attachment_set[0].unresolved, false);
  assert.equal(resolved.attachment_set[0].kind, "stone");
  assert.equal(resolved.attachment_set[1].kind, "repo");
  assert.equal(resolved.accepted_state_authority, false);
  assert.equal(db.headMutationAttempts.length, 0);
});

test("access/task/forward/attachment tools are MCP+broker scoped and never automatic-read", () => {
  const names = mcpToolsForProfile(false).map(tool => tool.name);
  const expected = [
    ...Object.values(ATTACHMENT_REF_BROKER_TOOL_IDS),
    ...Object.values(ACCESS_GRANT_BROKER_TOOL_IDS),
    ...Object.values(TASK_RUN_BROKER_TOOL_IDS),
    ...Object.values(FORWARD_NOTE_BROKER_TOOL_IDS)
  ];
  for (const id of expected) {
    assert.ok(names.includes(id), `missing MCP tool ${id}`);
  }
  assert.equal(ATTACHMENT_REF_MCP_TOOL_DEFINITIONS.length, 1);

  const registry = toolRegistryFromBody({}, { registry: DEFAULT_TOOL_BROKER_REGISTRY });
  assert.equal(registry.ok, true);
  assert.equal(registry.total, 94);
  const byId = new Map(registry.tools.map(tool => [tool.tool_id, tool]));
  for (const id of [...ACCESS_GRANT_MUTATION_TOOL_IDS, ...TASK_RUN_MUTATION_TOOL_IDS, ...Object.values(FORWARD_NOTE_BROKER_TOOL_IDS)]) {
    assert.equal(byId.get(id).risk_class, "mutation");
    if (id === TASK_RUN_BROKER_TOOL_IDS.dispatch) {
      assert.equal(byId.get(id).authorization, "human_confirmation");
    } else {
      assert.equal(byId.get(id).authorization, "scoped_grant");
    }
  }
  for (const id of [...ACCESS_GRANT_READ_TOOL_IDS, ...TASK_RUN_READ_TOOL_IDS, ...Object.values(ATTACHMENT_REF_BROKER_TOOL_IDS)]) {
    assert.equal(byId.get(id).risk_class, "read");
    assert.equal(byId.get(id).authorization, "scoped_grant");
  }

  const automatic = new Set(listAutomaticReadToolIds());
  for (const id of expected) {
    assert.equal(automatic.has(id), false, `${id} must not be automatic-read`);
  }
});

test("grant get forbidden for unrelated actor; principal cannot revoke", async () => {
  const db = new FakeV7710bD1();
  await createAccessGrantFromBody({
    grant_id: "grant:forbid-1",
    object_ref: "msg:x",
    principal_actor_id: ACTOR_B,
    permission: "discuss",
    grantor_actor_id: ACTOR_A
  }, envFor(db));

  const denied = await getAccessGrantFromBody({
    grant_id: "grant:forbid-1",
    actor_id: ACTOR_C
  }, envFor(db));
  assert.equal(denied.ok, false);
  assert.equal(denied.error, "access_grant_actor_forbidden");

  const principalRevoke = await revokeAccessGrantFromBody({
    grant_id: "grant:forbid-1",
    actor_id: ACTOR_B
  }, envFor(db));
  assert.equal(principalRevoke.ok, false);
  assert.equal(principalRevoke.error, "access_grant_revoke_forbidden");
});
