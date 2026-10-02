// V7.7.11i.4b — scoped inspector authorization.
// object.inspect:self establishes viewer identity only. Object families keep
// their own ACL. Sender projection is asymmetric and body/recipient/delivery-free.

import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_TOOL_BROKER_REGISTRY } from "../src/model-router.js";
import {
  OBJECT_INSPECT_SCOPED_TOOL_ID,
  OBJECT_INSPECT_SELF_SCOPE,
  OBJECT_INSPECT_TOOL_DEFINITION,
  objectInspectFromBody,
  objectInspectScopedFromBody
} from "../src/object-inspector.js";
import { issueMailboxCapabilityFromBody } from "../src/worker-session.js";

const SECRET_ENV = { CAIRNSTONE_MAILBOX_CAPABILITY_SECRET: "inspector-i4b-secret" };
const SENDER = "grok:test-sender";
const RECIPIENT = "claude:test-recipient";
const OTHER = "chatgpt:test-other";
const STRANGER = "claude:test-stranger";
const STONE = "a".repeat(64);
const RELATED = "b".repeat(64);
const PUBLIC = "c".repeat(64);

function stone(hash) {
  return {
    hash,
    title: `Title ${hash[0]}`,
    author: "test:actor",
    created_at: "2026-10-01T00:00:00.000Z",
    repo: null,
    commit_sha: null,
    chain_hash: null,
    path: null,
    stone_json: JSON.stringify({
      layers: { lod5: `SECRET-BODY-SUMMARY ${hash[0]}` },
      content: "raw message body must never leak"
    })
  };
}

function makeEnv(deliveries, edges = [], writes = []) {
  const stones = new Map([[STONE, stone(STONE)], [RELATED, stone(RELATED)], [PUBLIC, stone(PUBLIC)]]);
  return {
    ...SECRET_ENV,
    CAIRNSTONE_PUBLIC_BASE_URL: "https://example.test",
    CAIRNSTONE_DB: {
      prepare(sql) {
        if (!/^\s*SELECT/i.test(sql)) writes.push(sql);
        let bound = [];
        return {
          bind(...args) { bound = args; return this; },
          async run() { writes.push(`RUN:${sql}`); return {}; },
          async first() {
            if (sql.includes("FROM correspondence_deliveries")) {
              if (sql.includes("AND sender_id = ?") && sql.includes("message_id, thread_id")) {
                return deliveries.find(row => row.stone_hash === bound[0] && row.sender_id === bound[1]) || null;
              }
              if (sql.includes("AND sender_id = ?")) {
                return deliveries.some(row => row.stone_hash === bound[0] && row.sender_id === bound[1])
                  ? { stone_hash: bound[0] }
                  : null;
              }
              if (sql.includes("SELECT message_id, sender_id")) {
                return deliveries.find(row => row.stone_hash === bound[0] && row.recipient_id === bound[1]) || null;
              }
              if (sql.includes("AND recipient_id = ?")) {
                return deliveries.some(row => row.stone_hash === bound[0] && row.recipient_id === bound[1])
                  ? { stone_hash: bound[0] }
                  : null;
              }
              return deliveries.some(row => row.stone_hash === bound[0]) ? { stone_hash: bound[0] } : null;
            }
            if (sql.includes("FROM stones WHERE hash")) return stones.get(bound[0]) || null;
            return null;
          },
          async all() {
            if (sql.includes("SELECT DISTINCT stone_hash")) {
              const field = sql.includes("sender_id = ?") ? "sender_id" : "recipient_id";
              const hashes = [...new Set(deliveries
                .filter(row => row[field] === bound[0] && row.message_id === bound[1])
                .map(row => row.stone_hash))];
              return { results: hashes.slice(0, 2).map(stone_hash => ({ stone_hash })) };
            }
            if (sql.includes("FROM stone_edges WHERE from_hash")) {
              return { results: edges.filter(edge => edge.from_hash === bound[0]) };
            }
            if (sql.includes("FROM stone_edges WHERE to_hash")) {
              return { results: edges.filter(edge => edge.to_hash === bound[0]) };
            }
            return { results: [] };
          }
        };
      }
    },
    writes
  };
}

async function mint(principal, scopes = [OBJECT_INSPECT_SELF_SCOPE]) {
  const issued = await issueMailboxCapabilityFromBody({ principal_actor_id: principal, scopes }, SECRET_ENV);
  assert.equal(issued.ok, true, issued.error || "mint");
  return issued.mailbox_capability;
}

const deliveries = [
  {
    stone_hash: STONE,
    message_id: "msg:sent-1",
    sender_id: SENDER,
    recipient_id: RECIPIENT,
    thread_id: "thread:sent",
    status: "read",
    created_at: "2026-10-01T01:00:00.000Z",
    delivered_at: "2026-10-01T01:00:01.000Z",
    read_at: "2026-10-01T02:00:00.000Z"
  },
  {
    stone_hash: STONE,
    message_id: "msg:sent-1",
    sender_id: SENDER,
    recipient_id: OTHER,
    thread_id: "thread:sent",
    status: "delivered",
    created_at: "2026-10-01T01:00:00.000Z",
    delivered_at: "2026-10-01T01:00:01.000Z",
    read_at: null
  },
  {
    stone_hash: RELATED,
    message_id: "msg:related",
    sender_id: OTHER,
    recipient_id: RECIPIENT,
    thread_id: "thread:related",
    status: "delivered",
    created_at: "2026-10-01T03:00:00.000Z",
    delivered_at: "2026-10-01T03:00:00.000Z",
    read_at: null
  }
];

test("V7.7.11i.4b automatic inspect stays automatic and scoped tool is scoped_grant", () => {
  const automatic = DEFAULT_TOOL_BROKER_REGISTRY.find(tool => tool.tool_id === "cairnstone_object_inspect");
  const scoped = DEFAULT_TOOL_BROKER_REGISTRY.find(tool => tool.tool_id === OBJECT_INSPECT_SCOPED_TOOL_ID);
  assert.equal(automatic.authorization, "automatic");
  assert.equal(automatic.risk_class, "read");
  assert.equal(scoped.authorization, "scoped_grant");
  assert.equal(scoped.risk_class, "read");
  assert.equal(OBJECT_INSPECT_TOOL_DEFINITION.inputSchema.additionalProperties, false);
  assert.equal(OBJECT_INSPECT_TOOL_DEFINITION.inputSchema.properties.mailbox_capability, undefined);
  assert.equal(scoped.input_schema.properties.mailbox_capability.type, "string");
});

test("V7.7.11i.4b sender projection omits recipients, delivery state, and body", async () => {
  const capability = await mint(SENDER);
  const env = makeEnv(deliveries, [{
    from_hash: STONE,
    to_hash: RELATED,
    edge_type: "references",
    note: "do-not-grant"
  }]);
  const result = await objectInspectScopedFromBody({
    object_ref: `stone:${STONE}`,
    principal_actor_id: SENDER,
    mailbox_capability: capability
  }, env);
  assert.equal(result.inspection_status, "hydrated");
  assert.equal(result.access.basis, "correspondence_sender");
  assert.equal(result.access.identity_scope_authorizes_objects, false);
  assert.equal(result.correspondence.sender_id, SENDER);
  assert.equal(result.correspondence.message_id, "msg:sent-1");
  assert.equal(result.correspondence.thread_id, "thread:sent");
  assert.equal(result.correspondence.delivery_state_disclosed, false);
  assert.equal(result.correspondence.recipient_list_disclosed, false);
  assert.equal(result.correspondence.message_body_disclosed, false);
  assert.equal(result.correspondence.recipient_id, undefined);
  assert.equal(result.correspondence.status, undefined);
  assert.equal(result.correspondence.delivery_status, undefined);
  assert.equal(result.correspondence.read_at, undefined);
  assert.equal(result.stone.lod5, undefined);
  const serialized = JSON.stringify(result);
  assert.equal(serialized.includes(RECIPIENT), false);
  assert.equal(serialized.includes(OTHER), false);
  assert.equal(serialized.includes("SECRET-BODY-SUMMARY"), false);
  assert.equal(serialized.includes("raw message body"), false);
  assert.equal(serialized.includes(capability), false);
  assert.equal(result.related[0].restricted, true);
  assert.equal(result.policy.delivery_state_mutated, false);
  assert.equal(result.policy.message_body_returned, false);
  assert.equal(env.writes.length, 0);
});

test("V7.7.11i.4b recipient projection is unchanged and preferred over sender", async () => {
  const capability = await mint(RECIPIENT);
  const result = await objectInspectScopedFromBody({
    object_ref: `stone:${STONE}`,
    principal_actor_id: RECIPIENT,
    mailbox_capability: capability
  }, makeEnv(deliveries));
  assert.equal(result.access.basis, "correspondence_recipient");
  assert.equal(result.correspondence.recipient_id, RECIPIENT);
  assert.equal(result.correspondence.delivery_status, "read");
  assert.equal(result.correspondence.other_recipients_disclosed, false);
  assert.equal(JSON.stringify(result).includes(OTHER), false);
  assert.equal(result.correspondence.content_access.body_returned, false);
});

test("V7.7.11i.4b unauthorized authenticated caller matches anonymous restricted envelope", async () => {
  const capability = await mint(STRANGER);
  const env = makeEnv(deliveries);
  const authed = await objectInspectScopedFromBody({
    object_ref: `stone:${STONE}`,
    principal_actor_id: STRANGER,
    mailbox_capability: capability
  }, env);
  const anon = await objectInspectFromBody({ object_ref: `stone:${STONE}` }, env);
  assert.equal(authed.inspection_status, "restricted");
  assert.equal(authed.restriction_reason, anon.restriction_reason);
  assert.equal(authed.stone, null);
  assert.equal(authed.edges, null);
  assert.equal(JSON.stringify(authed).includes(RECIPIENT), false);
  assert.equal(JSON.stringify(authed).includes("SECRET-BODY"), false);
});

test("V7.7.11i.4b mail.read:self does not satisfy object.inspect:self", async () => {
  const capability = await mint(SENDER, ["mail.read:self"]);
  const result = await objectInspectScopedFromBody({
    object_ref: `stone:${STONE}`,
    principal_actor_id: SENDER,
    mailbox_capability: capability
  }, makeEnv(deliveries));
  assert.equal(result.ok, false);
  assert.equal(result.error, "inspector_viewer_authentication_failed");
  assert.equal(JSON.stringify(result).includes(capability), false);
});

test("V7.7.11i.4b automatic surface still rejects a presented capability and does not authorize senders", async () => {
  const capability = await mint(SENDER);
  const rejected = await objectInspectFromBody({
    object_ref: `stone:${STONE}`,
    principal_actor_id: SENDER,
    mailbox_capability: capability
  }, makeEnv(deliveries));
  assert.equal(rejected.error, "inspector_viewer_authentication_failed");
  assert.equal(rejected.reason, "viewer_authentication_not_available_on_this_surface");
  const senderOnLegacy = await objectInspectFromBody({
    object_ref: `stone:${STONE}`,
    principal_actor_id: SENDER,
    mailbox_capability: await mint(SENDER, ["mail.read:self"])
  }, makeEnv(deliveries), { viewerAuth: true });
  assert.equal(senderOnLegacy.inspection_status, "restricted");
});

test("V7.7.11i.4b object.inspect:self does not authorize non-correspondence families", async () => {
  const capability = await mint(SENDER);
  const result = await objectInspectScopedFromBody({
    object_ref: "session:cs:not-a-grant",
    principal_actor_id: SENDER,
    mailbox_capability: capability
  }, makeEnv(deliveries));
  assert.equal(result.inspection_status, "link_only");
  assert.equal(result.stone, undefined);
});

test("V7.7.11i.4c access grant hydrates only for grantor or principal", async () => {
  const grantorCap = await mint(SENDER);
  const strangerCap = await mint(STRANGER);
  const grant = {
    grant_id: "grant:demo-1",
    object_ref: `stone:${STONE}`,
    principal_actor_id: RECIPIENT,
    permission: "read",
    grantor_actor_id: SENDER,
    created_at: "2026-10-01T04:00:00.000Z",
    expires_at: null,
    revoked_at: null,
    status: "active"
  };
  function env() {
    return {
      ...SECRET_ENV,
      CAIRNSTONE_PUBLIC_BASE_URL: "https://example.test",
      CAIRNSTONE_DB: {
        prepare(sql) {
          let bound = [];
          return {
            bind(...args) { bound = args; return this; },
            async first() {
              if (sql.includes("FROM access_grants WHERE grant_id")) {
                return bound[0] === grant.grant_id ? grant : null;
              }
              return null;
            },
            async all() { return { results: [] }; }
          };
        }
      }
    };
  }
  const allowed = await objectInspectScopedFromBody({
    object_ref: "grant:demo-1",
    principal_actor_id: SENDER,
    mailbox_capability: grantorCap
  }, env());
  assert.equal(allowed.inspection_status, "hydrated");
  assert.equal(allowed.access.basis, "access_grant_party");
  assert.equal(allowed.access.identity_scope_authorizes_objects, false);
  assert.equal(allowed.access_grant.viewer_role, "grantor");
  assert.equal(allowed.access_grant.capability_disclosed, false);
  const denied = await objectInspectScopedFromBody({
    object_ref: "grant:demo-1",
    principal_actor_id: STRANGER,
    mailbox_capability: strangerCap
  }, env());
  assert.equal(denied.inspection_status, "link_only");
  assert.equal(denied.access_grant, undefined);
  assert.equal(JSON.stringify(denied).includes(RECIPIENT), false);
  const automatic = await objectInspectFromBody({ object_ref: "grant:demo-1" }, env());
  assert.equal(automatic.inspection_status, "link_only");
  assert.equal(automatic.access_grant, undefined);
});

test("V7.7.11i.4c task run hydrates only for requester, assignee, or human commit", async () => {
  const assigneeCap = await mint(RECIPIENT);
  const strangerCap = await mint(STRANGER);
  const task = {
    task_run_id: "tr:demo-1",
    status: "proposed",
    requested_by: SENDER,
    assignee_actor_id: RECIPIENT,
    human_committed_by: null,
    requested_intent: "ask-to-work",
    created_at: "2026-10-01T05:00:00.000Z",
    updated_at: "2026-10-01T05:00:00.000Z"
  };
  function env() {
    return {
      ...SECRET_ENV,
      CAIRNSTONE_PUBLIC_BASE_URL: "https://example.test",
      CAIRNSTONE_DB: {
        prepare(sql) {
          let bound = [];
          return {
            bind(...args) { bound = args; return this; },
            async first() {
              if (sql.includes("FROM task_runs WHERE task_run_id")) return bound[0] === task.task_run_id ? task : null;
              return null;
            },
            async all() { return { results: [] }; }
          };
        }
      }
    };
  }
  const allowed = await objectInspectScopedFromBody({
    object_ref: "tr:demo-1",
    principal_actor_id: RECIPIENT,
    mailbox_capability: assigneeCap
  }, env());
  assert.equal(allowed.access.basis, "task_run_party");
  assert.equal(allowed.task_run.viewer_roles.includes("assignee"), true);
  assert.equal(allowed.task_run.route_receipt_disclosed, false);
  assert.equal(allowed.task_run.result_body_disclosed, false);
  const denied = await objectInspectScopedFromBody({
    object_ref: "tr:demo-1",
    principal_actor_id: STRANGER,
    mailbox_capability: strangerCap
  }, env());
  assert.equal(denied.inspection_status, "link_only");
  assert.equal(JSON.stringify(denied).includes(SENDER), false);
  const mailScope = await mint(RECIPIENT, ["mail.read:self"]);
  const rejected = await objectInspectScopedFromBody({
    object_ref: "tr:demo-1",
    principal_actor_id: RECIPIENT,
    mailbox_capability: mailScope
  }, env());
  assert.equal(rejected.ok, false);
});
