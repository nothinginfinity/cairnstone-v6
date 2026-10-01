// V7.7.11i.4a — authenticated correspondence projection for the object inspector.
//
// Invariants under test:
//   - identity is a verified signed mailbox capability (mail.read:self); an
//     asserted principal id, a URL parameter, or a graph edge never authorizes;
//   - authorization is the object-specific delivery row (recipient-only);
//   - an unauthorized-but-authenticated caller sees exactly what anonymous sees;
//   - the inspector is read-only: only SELECTs, no delivery/read-state change;
//   - no body, no other-recipient disclosure, no capability echo.

import assert from "node:assert/strict";
import { test } from "node:test";
import worker, { handleMcpRpc } from "../src/index.js";
import { OBJECT_INSPECTOR_SCHEMA, objectInspectFromBody } from "../src/object-inspector.js";
import { issueMailboxCapabilityFromBody } from "../src/worker-session.js";

const SECRET_ENV = { CAIRNSTONE_MAILBOX_CAPABILITY_SECRET: "inspector-i4a-secret" };

const RECIPIENT = "claude:test-recipient";
const OTHER = "chatgpt:test-other";
const SENDER = "grok:test-sender";

const FOCAL_MSG = "1".repeat(64); // correspondence Stone delivered to RECIPIENT
const OTHER_MSG = "2".repeat(64); // correspondence Stone NOT delivered to RECIPIENT
const SENT_ONLY = "3".repeat(64); // RECIPIENT is only the sender
const SAFE = "4".repeat(64); // ordinary Stone
const RELATED_OWN = "5".repeat(64); // correspondence Stone delivered to RECIPIENT
const SHARED_DUP = "6".repeat(64); // second stone sharing a message_id with FOCAL for RECIPIENT

function makeStone(hash, overrides = {}) {
  return {
    hash,
    title: `Stone ${hash[0]}`,
    author: "test:actor",
    created_at: "2026-10-01T00:00:00.000Z",
    repo: "nothinginfinity/cairnstone-v6",
    commit_sha: "7".repeat(40),
    chain_hash: "cairnstone-v6-project-memory",
    path: `project-memory/${hash[0]}.md`,
    stone_json: JSON.stringify({ layers: { lod5: `Summary ${hash[0]}` } }),
    ...overrides
  };
}

function delivery(stone_hash, recipient_id, overrides = {}) {
  return {
    stone_hash,
    message_id: `msg:m-${stone_hash[0]}`,
    sender_id: SENDER,
    recipient_id,
    thread_id: `thread:t-${stone_hash[0]}`,
    status: "delivered",
    created_at: "2026-10-01T01:00:00.000Z",
    delivered_at: "2026-10-01T01:00:00.000Z",
    read_at: null,
    ...overrides
  };
}

function makeEnv({ deliveries = [], edges = [], writes = [] } = {}) {
  const stones = new Map([FOCAL_MSG, OTHER_MSG, SENT_ONLY, SAFE, RELATED_OWN, SHARED_DUP]
    .map(hash => [hash, makeStone(hash)]));
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
              if (sql.includes("SELECT message_id, sender_id")) {
                return deliveries
                  .filter(row => row.stone_hash === bound[0] && row.recipient_id === bound[1])
                  .at(0) || null;
              }
              if (sql.includes("AND recipient_id = ?")) {
                return deliveries.some(row => row.stone_hash === bound[0] && row.recipient_id === bound[1])
                  ? { stone_hash: bound[0] }
                  : null;
              }
              return deliveries.some(row => row.stone_hash === bound[0]) ? { stone_hash: bound[0] } : null;
            }
            if (sql.includes("FROM chain_heads")) return null;
            if (sql.includes("FROM path_heads")) return null;
            if (sql.includes("FROM stones WHERE hash")) return stones.get(bound[0]) || null;
            return null;
          },
          async all() {
            if (sql.includes("SELECT DISTINCT stone_hash FROM correspondence_deliveries")) {
              const hashes = [...new Set(deliveries
                .filter(row => row.recipient_id === bound[0] && row.message_id === bound[1])
                .map(row => row.stone_hash))];
              return { results: hashes.slice(0, 2).map(stone_hash => ({ stone_hash })) };
            }
            if (sql.includes("FROM stone_edges WHERE from_hash")) {
              return { results: edges.filter(edge => edge.from_hash === bound[0]).slice(0, bound[1]) };
            }
            if (sql.includes("FROM stone_edges WHERE to_hash")) {
              return { results: edges.filter(edge => edge.to_hash === bound[0]).slice(0, bound[1]) };
            }
            return { results: [] };
          }
        };
      }
    }
  };
}

async function mint(principal, scopes = ["mail.read:self"], env = SECRET_ENV) {
  const issued = await issueMailboxCapabilityFromBody({ principal_actor_id: principal, scopes }, env);
  assert.equal(issued.ok, true);
  return issued.mailbox_capability;
}

const baseDeliveries = () => [
  delivery(FOCAL_MSG, RECIPIENT, { message_id: "msg:focal-message" }),
  delivery(FOCAL_MSG, OTHER, { message_id: "msg:focal-message" }),
  delivery(OTHER_MSG, OTHER),
  delivery(SENT_ONLY, OTHER, { sender_id: RECIPIENT }),
  delivery(RELATED_OWN, RECIPIENT)
];

async function inspect(env, body) {
  return objectInspectFromBody(body, env, { viewerAuth: true });
}

test("V7.7.11i.4a authenticated recipient hydrates a correspondence Stone with a minimal, body-free projection", async () => {
  const env = makeEnv({ deliveries: baseDeliveries() });
  const token = await mint(RECIPIENT);
  const result = await inspect(env, {
    object_ref: `stone:${FOCAL_MSG}`,
    principal_actor_id: RECIPIENT,
    mailbox_capability: token
  });
  assert.equal(result.ok, true);
  assert.equal(result.inspection_status, "hydrated");
  assert.equal(result.restricted, false);
  assert.equal(result.access.basis, "correspondence_recipient");
  assert.equal(result.access.principal_scoped, true);
  assert.equal(result.stone.hash, FOCAL_MSG);
  assert.deepEqual(result.viewer, {
    authenticated: true,
    principal_actor_id: RECIPIENT,
    scope: "mail.read:self",
    basis: "mailbox_capability"
  });
  assert.equal(result.correspondence.recipient_id, RECIPIENT);
  assert.equal(result.correspondence.sender_id, SENDER);
  assert.equal(result.correspondence.message_id, "msg:focal-message");
  assert.equal(result.correspondence.content_access.body_returned, false);
  assert.equal(result.correspondence.other_recipients_disclosed, false);
  assert.equal(result.policy.authenticated_projection, true);
  assert.equal(result.policy.delivery_state_mutated, false);
  assert.equal(result.policy.message_body_returned, false);
  assert.equal(result.policy.relationship_grants_visibility, false);
  assert.equal(result.policy.accepted_state_authority, false);
  // The other recipient's identity must not appear anywhere in the projection.
  assert.equal(JSON.stringify(result).includes(OTHER), false);
});

test("V7.7.11i.4a valid capability for a non-recipient yields exactly the anonymous restricted envelope", async () => {
  const env = makeEnv({ deliveries: baseDeliveries() });
  const anonymous = await objectInspectFromBody({ object_ref: `stone:${OTHER_MSG}` }, env);
  const authedNonRecipient = await inspect(env, {
    object_ref: `stone:${OTHER_MSG}`,
    principal_actor_id: RECIPIENT,
    mailbox_capability: await mint(RECIPIENT)
  });
  assert.equal(anonymous.inspection_status, "restricted");
  assert.equal(authedNonRecipient.inspection_status, "restricted");
  const strip = ({ viewer, policy, ...rest }) => rest;
  assert.deepEqual(strip(authedNonRecipient), strip(anonymous));
  assert.equal(authedNonRecipient.stone, null);
  assert.equal(authedNonRecipient.graph, null);
});

test("V7.7.11i.4a authorization is recipient-only: a mere sender is not authorized", async () => {
  const env = makeEnv({ deliveries: baseDeliveries() });
  const result = await inspect(env, {
    object_ref: `stone:${SENT_ONLY}`,
    principal_actor_id: RECIPIENT,
    mailbox_capability: await mint(RECIPIENT)
  });
  assert.equal(result.inspection_status, "restricted");
  assert.equal(result.stone, null);
});

test("V7.7.11i.4a every unusable capability fails closed with a stable reason and no echo", async () => {
  const env = makeEnv({ deliveries: baseDeliveries() });
  const good = await mint(RECIPIENT);

  const realNow = Date.now;
  Date.now = () => realNow() - 3600 * 1000;
  const expired = await mint(RECIPIENT);
  Date.now = realNow;

  const wrongSecret = await mint(RECIPIENT, ["mail.read:self"], { CAIRNSTONE_MAILBOX_CAPABILITY_SECRET: "some-other-secret" });
  const replyOnly = await mint(RECIPIENT, ["mail.reply:self"]);
  const otherPrincipalToken = await mint(OTHER);

  const cases = [
    ["expired", { principal_actor_id: RECIPIENT, mailbox_capability: expired }],
    ["wrong signing secret", { principal_actor_id: RECIPIENT, mailbox_capability: wrongSecret }],
    ["missing scope", { principal_actor_id: RECIPIENT, mailbox_capability: replyOnly }],
    ["principal mismatch", { principal_actor_id: RECIPIENT, mailbox_capability: otherPrincipalToken }],
    ["garbage token", { principal_actor_id: RECIPIENT, mailbox_capability: "not.a-capability" }],
    ["capability without principal", { mailbox_capability: good }],
    ["principal without capability", { principal_actor_id: RECIPIENT }],
    ["malformed principal", { principal_actor_id: "not an actor id", mailbox_capability: good }]
  ];
  for (const [label, extra] of cases) {
    const result = await inspect(env, { object_ref: `stone:${FOCAL_MSG}`, ...extra });
    assert.equal(result.ok, false, label);
    assert.equal(result.schema, OBJECT_INSPECTOR_SCHEMA, label);
    assert.equal(result.error, "inspector_viewer_authentication_failed", label);
    assert.equal(typeof result.reason, "string", label);
    assert.equal(result.viewer.authenticated, false, label);
    assert.equal(result.stone, undefined, label);
    const serialized = JSON.stringify(result);
    assert.equal(serialized.includes(extra.mailbox_capability || "\u0000"), false, `${label}: token echoed`);
    assert.equal(serialized.includes(OTHER), false, `${label}: other principal echoed`);
  }
});

test("V7.7.11i.4a a rejected capability fails closed even for an otherwise public Stone", async () => {
  const env = makeEnv({ deliveries: baseDeliveries() });
  const result = await inspect(env, {
    object_ref: `stone:${SAFE}`,
    principal_actor_id: RECIPIENT,
    mailbox_capability: "garbage"
  });
  assert.equal(result.ok, false);
  assert.equal(result.error, "inspector_viewer_authentication_failed");
});

test("V7.7.11i.4a surfaces that do not opt in reject a presented capability instead of honoring or ignoring it", async () => {
  const env = makeEnv({ deliveries: baseDeliveries() });
  const token = await mint(RECIPIENT);
  const body = { object_ref: `stone:${FOCAL_MSG}`, principal_actor_id: RECIPIENT, mailbox_capability: token };

  const direct = await objectInspectFromBody(body, env);
  assert.equal(direct.ok, false);
  assert.equal(direct.reason, "viewer_authentication_not_available_on_this_surface");

  const rpc = await handleMcpRpc({
    jsonrpc: "2.0",
    id: 9,
    method: "tools/call",
    params: { name: "cairnstone_object_inspect", arguments: body }
  }, env);
  assert.equal(rpc.result.isError, true);
  assert.equal(rpc.result.structuredContent.reason, "viewer_authentication_not_available_on_this_surface");
  assert.equal(JSON.stringify(rpc).includes(token), false);
});

test("V7.7.11i.4a msg: refs resolve only through the authenticated principal's own delivery", async () => {
  const env = makeEnv({ deliveries: baseDeliveries() });
  const authed = await inspect(env, {
    object_ref: "msg:focal-message",
    principal_actor_id: RECIPIENT,
    mailbox_capability: await mint(RECIPIENT)
  });
  assert.equal(authed.ok, true);
  assert.equal(authed.kind, "msg");
  assert.equal(authed.resolved_from, "msg");
  assert.equal(authed.resolved_object_ref, `stone:${FOCAL_MSG}`);
  assert.equal(authed.inspection_status, "hydrated");

  const nonRecipient = await inspect(env, {
    object_ref: "msg:focal-message",
    principal_actor_id: "claude:nobody-here",
    mailbox_capability: await mint("claude:nobody-here")
  });
  const anonymous = await objectInspectFromBody({ object_ref: "msg:focal-message" }, env);
  assert.equal(nonRecipient.inspection_status, "link_only");
  const strip = ({ viewer, policy, ...rest }) => rest;
  assert.deepEqual(strip(nonRecipient), strip(anonymous));
});

test("V7.7.11i.4a an ambiguous msg: ref fails closed to link-only instead of guessing an object", async () => {
  const env = makeEnv({
    deliveries: [
      delivery(FOCAL_MSG, RECIPIENT, { message_id: "msg:dup" }),
      delivery(SHARED_DUP, RECIPIENT, { message_id: "msg:dup", sender_id: "grok:second-sender" })
    ]
  });
  const result = await inspect(env, {
    object_ref: "msg:dup",
    principal_actor_id: RECIPIENT,
    mailbox_capability: await mint(RECIPIENT)
  });
  assert.equal(result.ok, true);
  assert.equal(result.inspection_status, "link_only");
  assert.equal(result.hydration.reason, "ambiguous_message_ref");
  assert.equal(result.stone, undefined);
});

test("V7.7.11i.4a ac1: refs hydrate only for an authorized recipient, otherwise stay link-only", async () => {
  const env = makeEnv({ deliveries: baseDeliveries() });
  const authed = await inspect(env, {
    object_ref: `ac1:${FOCAL_MSG}`,
    principal_actor_id: RECIPIENT,
    mailbox_capability: await mint(RECIPIENT)
  });
  assert.equal(authed.inspection_status, "hydrated");
  assert.equal(authed.kind, "ac1");
  assert.equal(authed.resolved_from, "ac1");

  const denied = await inspect(env, {
    object_ref: `ac1:${OTHER_MSG}`,
    principal_actor_id: RECIPIENT,
    mailbox_capability: await mint(RECIPIENT)
  });
  assert.equal(denied.inspection_status, "link_only");
  assert.equal(denied.stone, undefined);

  const anonymous = await objectInspectFromBody({ object_ref: `ac1:${FOCAL_MSG}` }, env);
  assert.equal(anonymous.inspection_status, "link_only");
});

test("V7.7.11i.4a relationships upgrade only the related objects the principal actually received", async () => {
  const env = makeEnv({
    deliveries: baseDeliveries(),
    edges: [
      { from_hash: FOCAL_MSG, to_hash: SAFE, edge_type: "references", note: "to safe stone" },
      { from_hash: FOCAL_MSG, to_hash: RELATED_OWN, edge_type: "references", note: "to my own message" },
      { from_hash: FOCAL_MSG, to_hash: OTHER_MSG, edge_type: "references", note: "SECRET other private note" }
    ]
  });
  const result = await inspect(env, {
    object_ref: `stone:${FOCAL_MSG}`,
    principal_actor_id: RECIPIENT,
    mailbox_capability: await mint(RECIPIENT)
  });
  const byHash = new Map(result.related.map(item => [item.hash, item]));
  assert.equal(byHash.get(SAFE).restricted, false);
  assert.equal(byHash.get(RELATED_OWN).restricted, false);
  assert.equal(byHash.get(RELATED_OWN).access_basis, "correspondence_recipient");
  assert.equal(byHash.get(RELATED_OWN).title, "Stone 5");
  assert.equal(byHash.get(OTHER_MSG).restricted, true);
  assert.equal(byHash.get(OTHER_MSG).title, undefined);
  assert.equal(result.restricted_related_count, 1);

  const notes = Object.fromEntries(result.edges.outbound.map(edge => [edge.to_hash, edge.note]));
  assert.equal(notes[SAFE], "to safe stone");
  assert.equal(notes[RELATED_OWN], "to my own message");
  assert.equal(notes[OTHER_MSG], null);
  assert.equal(JSON.stringify(result).includes("SECRET other private note"), false);
  assert.equal(JSON.stringify(result.graph).includes("Stone 2"), false);
});

test("V7.7.11i.4a the inspector issues only SELECTs: no delivery/read-state mutation, no head movement", async () => {
  const writes = [];
  const env = makeEnv({
    deliveries: baseDeliveries(),
    edges: [{ from_hash: FOCAL_MSG, to_hash: RELATED_OWN, edge_type: "references", note: null }],
    writes
  });
  const token = await mint(RECIPIENT);
  for (const ref of [`stone:${FOCAL_MSG}`, `ac1:${FOCAL_MSG}`, "msg:focal-message", `stone:${OTHER_MSG}`]) {
    await inspect(env, { object_ref: ref, principal_actor_id: RECIPIENT, mailbox_capability: token });
  }
  assert.deepEqual(writes, []);
});

test("V7.7.11i.4a no output ever contains the capability or a capability-shaped field", async () => {
  const env = makeEnv({ deliveries: baseDeliveries() });
  const token = await mint(RECIPIENT);
  const result = await inspect(env, {
    object_ref: `stone:${FOCAL_MSG}`,
    principal_actor_id: RECIPIENT,
    mailbox_capability: token
  });
  const serialized = JSON.stringify(result);
  assert.equal(serialized.includes(token), false);
  // No capability-shaped *field*. (viewer.basis carries the descriptive value
  // "mailbox_capability" naming how the viewer authenticated; that is a label.)
  assert.equal(/"(mailbox|workspace)_capability"\s*:/.test(serialized), false);
  assert.equal(result.object_link.secret_bearer_in_url, false);
  assert.equal(result.object_link.https_url.includes("capability"), false);
});

test("V7.7.11i.4a HTTP: POST /v1/object-inspect authenticates in the body and is never cacheable", async () => {
  const env = makeEnv({ deliveries: baseDeliveries() });
  const token = await mint(RECIPIENT);
  const post = body => worker.fetch(new Request("https://cairnstone.test/v1/object-inspect", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  }), env);

  const ok = await post({ object_ref: `stone:${FOCAL_MSG}`, principal_actor_id: RECIPIENT, mailbox_capability: token });
  assert.equal(ok.status, 200);
  assert.equal(ok.headers.get("cache-control"), "private, no-store");
  const okJson = await ok.json();
  assert.equal(okJson.inspection_status, "hydrated");
  assert.equal(okJson.correspondence.recipient_id, RECIPIENT);

  const bad = await post({ object_ref: `stone:${FOCAL_MSG}`, principal_actor_id: RECIPIENT, mailbox_capability: "garbage" });
  assert.equal(bad.status, 401);
  assert.equal(bad.headers.get("cache-control"), "private, no-store");
  assert.equal((await bad.json()).error, "inspector_viewer_authentication_failed");

  const anonymous = await post({ object_ref: `stone:${FOCAL_MSG}` });
  assert.equal(anonymous.status, 200);
  assert.equal((await anonymous.json()).inspection_status, "restricted");
});

test("V7.7.11i.4a HTTP: GET /inspect never reads a capability from the URL", async () => {
  const env = makeEnv({ deliveries: baseDeliveries() });
  const token = await mint(RECIPIENT);
  const url = new URL("https://cairnstone.test/inspect");
  url.searchParams.set("ref", `stone:${FOCAL_MSG}`);
  url.searchParams.set("format", "json");
  url.searchParams.set("principal_actor_id", RECIPIENT);
  url.searchParams.set("mailbox_capability", token);
  const response = await worker.fetch(new Request(url, { method: "GET" }), env);
  const body = await response.json();
  assert.equal(body.inspection_status, "restricted");
  assert.equal(body.viewer.authenticated, false);
  assert.equal(JSON.stringify(body).includes(token), false);
});
