import test from "node:test";
import assert from "node:assert/strict";
import {
  UNIFIED_CONVERSATIONS_SCHEMA,
  UNIFIED_CONVERSATIONS_TOOL_ID,
  compileOwnedIdentityScope,
  unifiedConversationsFromBody
} from "../src/unified-conversations.js";
import {
  DEFAULT_TOOL_BROKER_REGISTRY
} from "../src/model-router.js";
import { listAutomaticReadToolIds } from "../src/delegate-loop.js";
import { mcpToolsForProfile } from "../src/index.js";

const AUTH = {
  account_id: "acct_demo",
  tenant_id: "tenant_demo",
  connection_id: "conn_chatgpt",
  principal_id: "principal:chatgpt"
};

function row(overrides = {}) {
  return {
    connection_id: "conn_chatgpt",
    principal_id: "principal:chatgpt",
    account_id: "acct_demo",
    tenant_id: "tenant_demo",
    status: "active",
    client_family: "chatgpt",
    routing_aliases_json: JSON.stringify(["chatgpt:cairnstone-v6"]),
    created_at: "2026-09-29T18:00:00.000Z",
    ...overrides
  };
}

function scopeFixture() {
  return {
    ok: true,
    account_id: "acct_demo",
    tenant_id: "tenant_demo",
    current_principal_id: "principal:chatgpt",
    current_connection_id: "conn_chatgpt",
    connections: [
      { connection_id: "conn_chatgpt", principal_id: "principal:chatgpt", client_family: "chatgpt", routing_aliases: ["chatgpt:cairnstone-v6"] },
      { connection_id: "conn_grok", principal_id: "principal:grok", client_family: "grok", routing_aliases: ["grok:cairnstone-v6"] }
    ],
    identities: [
      {
        actor_id: "chatgpt:cairnstone-v6",
        client_families: new Set(["chatgpt"]),
        connection_ids: new Set(["conn_chatgpt"]),
        identity_kinds: new Set(["routing_alias"])
      },
      {
        actor_id: "grok:cairnstone-v6",
        client_families: new Set(["grok"]),
        connection_ids: new Set(["conn_grok"]),
        identity_kinds: new Set(["routing_alias"])
      }
    ],
    warnings: [],
    truncated_identities: false
  };
}

test("owned identity scope is derived from active account connections and aliases only", () => {
  const got = compileOwnedIdentityScope(AUTH, [
    row(),
    row({
      connection_id: "conn_grok",
      principal_id: "principal:grok",
      client_family: "grok",
      routing_aliases_json: JSON.stringify(["grok:cairnstone-v6", "grok-bot:cairnstone-v6"]),
      created_at: "2026-09-29T18:01:00.000Z"
    }),
    row({
      connection_id: "conn_other_account",
      principal_id: "principal:other",
      account_id: "acct_other",
      client_family: "claude",
      routing_aliases_json: JSON.stringify(["claude:other"])
    })
  ]);

  assert.equal(got.ok, true);
  assert.equal(got.connections.length, 2);
  const actorIds = got.identities.map(item => item.actor_id);
  assert.deepEqual(actorIds, [
    "chatgpt:cairnstone-v6",
    "grok-bot:cairnstone-v6",
    "grok:cairnstone-v6",
    "principal:chatgpt",
    "principal:grok"
  ]);
  assert.equal(actorIds.includes("claude:other"), false);
  assert.equal(got.accepted_state_authority, false);
});

test("owned identity scope fails closed when authenticated connection is not active", () => {
  const got = compileOwnedIdentityScope(AUTH, [
    row({ status: "revoked" })
  ]);
  assert.equal(got.ok, false);
  assert.equal(got.error, "authenticated_connection_not_active");
  assert.equal(got.accepted_state_authority, false);
});

test("unified view deduplicates records and preserves per-identity visibility provenance", async () => {
  const seen = { sessions: [], tasks: [], threads: [] };
  const got = await unifiedConversationsFromBody({ limit: 20 }, { CAIRNSTONE_DB: {} }, {
    resolveOwnedIdentityScope: async () => scopeFixture(),
    listConversationSessions: async (_db, { actor_id }) => {
      seen.sessions.push(actor_id);
      return {
        ok: true,
        sessions: [{
          conversation_id: "cvs:shared",
          status: "active",
          updated_at: "2026-09-29T18:05:00.000Z",
          selected_actors: ["chatgpt:cairnstone-v6", "grok:cairnstone-v6"]
        }]
      };
    },
    listTaskRuns: async (_db, { actor_id }) => {
      seen.tasks.push(actor_id);
      return {
        ok: true,
        task_runs: [{
          task_run_id: "tr:shared",
          status: "running",
          dispatch_state: "running",
          updated_at: "2026-09-29T18:06:00.000Z"
        }]
      };
    },
    listThreads: async ({ recipient_id }) => {
      seen.threads.push(recipient_id);
      return {
        ok: true,
        threads: [{
          thread_id: "thread:shared",
          latest_at: recipient_id.startsWith("grok")
            ? "2026-09-29T18:08:00.000Z"
            : "2026-09-29T18:07:00.000Z",
          recipient_id
        }]
      };
    }
  });

  assert.equal(got.ok, true);
  assert.equal(got.schema, UNIFIED_CONVERSATIONS_SCHEMA);
  assert.equal(got.counts.conversations, 1);
  assert.equal(got.counts.task_runs, 1);
  assert.equal(got.counts.mailbox_threads, 1);
  assert.equal(got.counts.events, 1);
  assert.equal(got.conversations[0].visible_via.length, 2);
  assert.equal(got.task_runs[0].visible_via.length, 2);
  assert.equal(got.mailbox_threads[0].visible_via.length, 2);
  assert.equal(got.mailbox_threads[0].recipient_views.length, 2);
  assert.equal(got.mailbox_threads[0].latest_at, "2026-09-29T18:08:00.000Z");
  assert.equal(got.events[0].visible_via.length, 2);
  assert.deepEqual(seen.sessions.sort(), ["chatgpt:cairnstone-v6", "grok:cairnstone-v6"]);
  assert.equal(got.policy.arbitrary_actor_read, false);
  assert.equal(got.accepted_state_authority, false);
});

test("actor and provider filters only narrow the server-owned identity set", async () => {
  const called = [];
  const got = await unifiedConversationsFromBody({
    actor_ids: ["grok:cairnstone-v6", "attacker:not-owned"],
    client_families: ["grok"],
    limit: 10
  }, { CAIRNSTONE_DB: {} }, {
    resolveOwnedIdentityScope: async () => scopeFixture(),
    listConversationSessions: async (_db, { actor_id }) => {
      called.push(`session:${actor_id}`);
      return { ok: true, sessions: [] };
    },
    listTaskRuns: async (_db, { actor_id }) => {
      called.push(`task:${actor_id}`);
      return { ok: true, task_runs: [] };
    },
    listThreads: async ({ recipient_id }) => {
      called.push(`thread:${recipient_id}`);
      return { ok: true, threads: [] };
    }
  });

  assert.equal(got.ok, true);
  assert.deepEqual(called, [
    "session:grok:cairnstone-v6",
    "task:grok:cairnstone-v6",
    "thread:grok:cairnstone-v6"
  ]);
  assert.equal(got.identity_scope.identities.length, 1);
  assert.equal(got.identity_scope.identities[0].actor_id, "grok:cairnstone-v6");
});

test("unified conversations tool is advertised as bounded automatic read, while the handler itself requires authenticated account context", async () => {
  const names = mcpToolsForProfile(false).map(tool => tool.name);
  assert.ok(names.includes(UNIFIED_CONVERSATIONS_TOOL_ID));

  const entry = DEFAULT_TOOL_BROKER_REGISTRY.find(tool => tool.tool_id === UNIFIED_CONVERSATIONS_TOOL_ID);
  assert.ok(entry);
  assert.equal(entry.risk_class, "read");
  assert.equal(entry.authorization, "automatic");
  assert.ok(listAutomaticReadToolIds(DEFAULT_TOOL_BROKER_REGISTRY).includes(UNIFIED_CONVERSATIONS_TOOL_ID));

  const denied = await unifiedConversationsFromBody({}, { CAIRNSTONE_DB: {} }, {
    listThreads: async () => ({ ok: true, threads: [] })
  });
  assert.equal(denied.ok, false);
  assert.equal(denied.error, "authenticated_account_context_required");
});
