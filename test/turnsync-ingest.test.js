import test from "node:test";
import assert from "node:assert/strict";
import {
  TURNSYNC_APPEND_TOOL_ID,
  selectTurnSyncActor,
  turnSyncAppendFromBody
} from "../src/turnsync-ingest.js";
import { DEFAULT_TOOL_BROKER_REGISTRY } from "../src/model-router.js";
import { listAutomaticReadToolIds } from "../src/delegate-loop.js";
import { mcpToolsForProfile } from "../src/index.js";

const AUTH = {
  account_id: "acct_demo",
  tenant_id: "tenant_demo",
  connection_id: "conn_chatgpt",
  principal_id: "principal:chatgpt"
};

function connection(overrides = {}) {
  return {
    connection_id: "conn_chatgpt",
    principal_id: "principal:chatgpt",
    account_id: "acct_demo",
    tenant_id: "tenant_demo",
    status: "active",
    client_family: "chatgpt",
    routing_aliases_json: JSON.stringify(["chatgpt:cairnstone-v6"]),
    ...overrides
  };
}

function body(overrides = {}) {
  return {
    conversation_id: "cvs:demo",
    turn_id: "turn:provider:001",
    message_id: "cmsg:provider:001",
    role: "assistant",
    turn_type: "provider_turn",
    content_preview: "Completed the requested analysis.",
    ...overrides
  };
}

test("selectTurnSyncActor defaults to the single routing alias for the current active connection", () => {
  const got = selectTurnSyncActor(AUTH, connection());
  assert.equal(got.ok, true);
  assert.equal(got.actor_id, "chatgpt:cairnstone-v6");
  assert.ok(got.allowed_actor_ids.includes("principal:chatgpt"));
  assert.ok(got.allowed_actor_ids.includes("chatgpt:cairnstone-v6"));
  assert.equal(got.accepted_state_authority, false);
});

test("selectTurnSyncActor requires an exact owned actor when a connection has multiple aliases", () => {
  const row = connection({
    routing_aliases_json: JSON.stringify(["grok:cairnstone-v6", "grok-bot:cairnstone-v6"])
  });
  const ambiguous = selectTurnSyncActor(AUTH, row);
  assert.equal(ambiguous.ok, false);
  assert.equal(ambiguous.error, "turnsync_actor_id_required_for_connection");

  const selected = selectTurnSyncActor(AUTH, row, "grok-bot:cairnstone-v6");
  assert.equal(selected.ok, true);
  assert.equal(selected.actor_id, "grok-bot:cairnstone-v6");

  const denied = selectTurnSyncActor(AUTH, row, "claude:cairnstone-v6");
  assert.equal(denied.ok, false);
  assert.equal(denied.error, "turnsync_actor_not_owned_by_connection");
});

test("append bridge derives the session revision server-side and binds the selected actor", async () => {
  const calls = [];
  const got = await turnSyncAppendFromBody(body({ actor_id: "untrusted:caller-value", base_revision: 999 }), {
    CAIRNSTONE_DB: {}
  }, {
    resolveTurnSyncActor: async () => ({
      ok: true,
      actor_id: "chatgpt:cairnstone-v6",
      connection_id: "conn_chatgpt",
      client_family: "chatgpt"
    }),
    replayOrConflict: async () => null,
    getConversationSession: async () => ({ conversation_id: "cvs:demo", session_revision: 7, message_log: [] }),
    appendConversationTurn: async (_db, args) => {
      calls.push(args);
      return {
        ok: true,
        turn: { turn_id: args.turn_id, message_id: args.message_id, actor_id: args.actor_id },
        conversation_session: { conversation_id: args.conversation_id, session_revision: args.base_revision + 1 }
      };
    }
  });

  assert.equal(got.ok, true);
  assert.equal(got.replayed, false);
  assert.equal(got.retry_count, 0);
  assert.equal(got.sync_policy_evaluated, false);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].actor_id, "chatgpt:cairnstone-v6");
  assert.equal(calls[0].base_revision, 7);
});

test("append bridge retries one clean CAS conflict without asking the provider to manage revisions", async () => {
  const revisions = [];
  let sessionRevision = 4;
  const got = await turnSyncAppendFromBody(body(), { CAIRNSTONE_DB: {} }, {
    resolveTurnSyncActor: async () => ({ ok: true, actor_id: "chatgpt:cairnstone-v6" }),
    replayOrConflict: async () => null,
    getConversationSession: async () => ({ conversation_id: "cvs:demo", session_revision: sessionRevision++, message_log: [] }),
    appendConversationTurn: async (_db, args) => {
      revisions.push(args.base_revision);
      if (revisions.length === 1) {
        return { ok: false, error: "conversation_session_conflict", expected_session_revision: 5 };
      }
      return {
        ok: true,
        turn: { turn_id: args.turn_id, message_id: args.message_id, actor_id: args.actor_id },
        conversation_session: { conversation_id: args.conversation_id, session_revision: args.base_revision + 1 }
      };
    }
  });

  assert.equal(got.ok, true);
  assert.equal(got.retry_count, 1);
  assert.deepEqual(revisions, [4, 5]);
});

test("append bridge returns an idempotent replay result before mutation when durable identity already exists", async () => {
  let appendCalls = 0;
  const replay = {
    ok: true,
    schema: "cairnstone-turnsync-append-v1",
    replayed: true,
    turn: { turn_id: "turn:provider:001", message_id: "cmsg:provider:001" },
    conversation_session: { conversation_id: "cvs:demo", session_revision: 8 },
    sync_policy_evaluated: false,
    accepted_state_authority: false
  };
  const got = await turnSyncAppendFromBody(body(), { CAIRNSTONE_DB: {} }, {
    resolveTurnSyncActor: async () => ({ ok: true, actor_id: "chatgpt:cairnstone-v6" }),
    replayOrConflict: async () => replay,
    getConversationSession: async () => ({ conversation_id: "cvs:demo", session_revision: 8 }),
    appendConversationTurn: async () => { appendCalls += 1; return { ok: true }; }
  });

  assert.equal(got.ok, true);
  assert.equal(got.replayed, true);
  assert.equal(appendCalls, 0);
});

test("append bridge fails closed without Core-auth context in the real actor resolver", async () => {
  const denied = await turnSyncAppendFromBody(body(), { CAIRNSTONE_DB: {} });
  assert.equal(denied.ok, false);
  assert.equal(denied.error, "authenticated_account_context_required");
});

test("TurnSync append is catalogued as scoped mutation, never automatic read", () => {
  const names = mcpToolsForProfile(false).map(tool => tool.name);
  assert.ok(names.includes(TURNSYNC_APPEND_TOOL_ID));
  const entry = DEFAULT_TOOL_BROKER_REGISTRY.find(tool => tool.tool_id === TURNSYNC_APPEND_TOOL_ID);
  assert.ok(entry);
  assert.equal(entry.risk_class, "mutation");
  assert.equal(entry.authorization, "scoped_grant");
  assert.equal(listAutomaticReadToolIds(DEFAULT_TOOL_BROKER_REGISTRY).includes(TURNSYNC_APPEND_TOOL_ID), false);
});
