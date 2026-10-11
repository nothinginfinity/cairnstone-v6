// S0a — private-realm actor guard on the unauthenticated legacy AC1 surface.
// Roadmap Gate S0 (Stone 3fcdb359...): a legacy caller must not be able to name an
// address in the private realm. Default mode is OFF so nothing changes until enabled.

import test from "node:test";
import assert from "node:assert/strict";
import worker, { handleMcpRpc } from "../src/index.js";
import {
  AC1_MAILBOX_TOOLS,
  DEFAULT_REALM_GUARD_MODE,
  PRIVATE_REALM_NAMESPACES,
  applyRealmGuard,
  findPrivateRealmActorFields,
  isPrivateRealmActor,
  resolveRealmGuardMode
} from "../src/realm-guard.js";

const LEGACY_ACTORS = [
  "chatgpt:chat",
  "chatgpt:cairnstone-v6",
  "claude:cairnstone-v6",
  "claude:chat",
  "grok:cairnstone-v6",
  "grok-xcom:cairnstone-v6",
  "perplexity:chat",
  "perplexity-2:cairnstone-v6",
  "chatgpt-2:chat",
  "agent:claude:jared",
  "agent:chatgpt:jared"
];

const PRIVATE_ACTORS = [
  "prin:abc123",
  "conn:abc123",
  "home:abc123",
  "acct:abc123",
  "ten:abc123",
  "inbox:default",
  "INBOX:abc",
  "home_abc123",
  "ibx_abc123",
  "chatgpt:ibx_abc123",
  "PRIN:ABC123",
  "  prin:abc123  ",
  "prin_abc123",
  "conn_abc123",
  "chatgpt:prin_abc123",
  "claude:conn_abc123"
];

function rpc(name, args, env, extra = {}) {
  return handleMcpRpc(
    { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } },
    env,
    { core: false, ...extra }
  );
}

function payload(result) {
  return JSON.parse(result.result.content[0].text);
}

test("default mode is off and unknown values fall back to off", () => {
  assert.equal(DEFAULT_REALM_GUARD_MODE, "off");
  assert.equal(resolveRealmGuardMode({}), "off");
  assert.equal(resolveRealmGuardMode(undefined), "off");
  assert.equal(resolveRealmGuardMode({ AC1_REALM_GUARD: "ENFORCE" }), "enforce");
  assert.equal(resolveRealmGuardMode({ AC1_REALM_GUARD: " shadow " }), "shadow");
  assert.equal(resolveRealmGuardMode({ AC1_REALM_GUARD: "strict" }), "off");
  assert.equal(resolveRealmGuardMode({ AC1_REALM_GUARD: 1 }), "off");
});

test("every historical legacy actor is outside the private realm", () => {
  for (const actor of LEGACY_ACTORS) assert.equal(isPrivateRealmActor(actor), false, actor);
});

test("private realm namespaces and minted id prefixes are recognised, including case/space variants", () => {
  for (const actor of PRIVATE_ACTORS) assert.equal(isPrivateRealmActor(actor), true, actor);
  for (const ns of PRIVATE_REALM_NAMESPACES) assert.equal(isPrivateRealmActor(`${ns}:x`), true, ns);
});

test("non-string and empty values are never private", () => {
  for (const value of [undefined, null, "", "   ", 0, {}, [], true]) assert.equal(isPrivateRealmActor(value), false);
});

test("field inspection covers from, recipient_id, actor_id, worker_actor_id and to[]", () => {
  const found = findPrivateRealmActorFields("cairnstone_send_message", {
    from: "prin:a",
    recipient_id: "conn:b",
    actor_id: "home:c",
    worker_actor_id: "acct:d",
    to: ["chatgpt:chat", "ten:e"]
  });
  assert.equal(found.applicable, true);
  assert.deepEqual([...found.fields].sort(), ["actor_id", "from", "recipient_id", "to", "worker_actor_id"]);
});

test("a string `to` is inspected too", () => {
  const found = findPrivateRealmActorFields("cairnstone_forward_with_note", { from: "claude:chat", to: "prin:a" });
  assert.deepEqual(found.fields, ["to"]);
});

test("tools outside the AC1 mailbox set are not inspected", () => {
  const found = findPrivateRealmActorFields("cairnstone_search", { query: "x", actor_id: "prin:a" });
  assert.equal(found.applicable, false);
  assert.deepEqual(found.fields, []);
});

test("malformed arguments never throw", () => {
  for (const args of [undefined, null, "x", 5, [], [1, 2]]) {
    assert.doesNotThrow(() => findPrivateRealmActorFields("cairnstone_get_inbox", args));
  }
});

test("off mode allows everything, including private realm names (no behaviour change by default)", () => {
  for (const tool of AC1_MAILBOX_TOOLS) {
    assert.equal(applyRealmGuard(tool, { from: "prin:a", recipient_id: "prin:a", to: ["prin:b"] }, {}), null, tool);
  }
});

test("shadow mode allows but reports the would-deny without echoing the address", () => {
  const warnings = [];
  const result = applyRealmGuard(
    "cairnstone_get_inbox",
    { recipient_id: "prin:secretvalue" },
    { AC1_REALM_GUARD: "shadow" },
    { warn: entry => warnings.push(entry) }
  );
  assert.equal(result, null);
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0].event, "ac1_realm_guard_would_deny");
  assert.equal(warnings[0].tool, "cairnstone_get_inbox");
  assert.deepEqual(warnings[0].fields, ["recipient_id"]);
  assert.doesNotMatch(JSON.stringify(warnings), /secretvalue/);
});

test("shadow mode stays silent for legacy actors", () => {
  const warnings = [];
  const result = applyRealmGuard(
    "cairnstone_get_inbox",
    { recipient_id: "chatgpt:chat" },
    { AC1_REALM_GUARD: "shadow" },
    { warn: entry => warnings.push(entry) }
  );
  assert.equal(result, null);
  assert.equal(warnings.length, 0);
});

test("enforce denies every AC1 mailbox tool for every private actor field", () => {
  const env = { AC1_REALM_GUARD: "enforce" };
  const fieldsByShape = [
    { recipient_id: "prin:a" },
    { from: "prin:a", to: ["claude:chat"], content: "x" },
    { from: "claude:chat", to: ["prin:a"], content: "x" },
    { actor_id: "conn:a", content: "x" },
    { worker_actor_id: "home:a" }
  ];
  for (const tool of AC1_MAILBOX_TOOLS) {
    for (const args of fieldsByShape) {
      const denied = applyRealmGuard(tool, args, env);
      assert.ok(denied, `${tool} ${JSON.stringify(args)}`);
      assert.equal(denied.ok, false);
      assert.equal(denied.status, 403);
      assert.equal(denied.error, "private_realm_actor_forbidden");
      assert.equal(denied.accepted_state_authority, false);
      assert.doesNotMatch(JSON.stringify(denied), /prin:a|conn:a|home:a/);
    }
  }
});

test("enforce allows legacy actors untouched", () => {
  const env = { AC1_REALM_GUARD: "enforce" };
  for (const actor of LEGACY_ACTORS) {
    assert.equal(applyRealmGuard("cairnstone_get_inbox", { recipient_id: actor }, env), null, actor);
    assert.equal(applyRealmGuard("cairnstone_send_message", { from: actor, to: [LEGACY_ACTORS[0]], content: "hi" }, env), null, actor);
  }
});

test("authenticated calls are never handled by the legacy guard", () => {
  const env = { AC1_REALM_GUARD: "enforce" };
  const authContext = { principal_id: "prin_abc123", account_id: "acct_x", tenant_id: "ten_x", connection_id: "conn_x" };
  assert.equal(applyRealmGuard("cairnstone_get_inbox", { recipient_id: "prin_abc123" }, env, { authContext }), null);
});

test("the guard never touches the database or auth tables", () => {
  let touched = 0;
  const env = new Proxy({ AC1_REALM_GUARD: "enforce" }, {
    get(target, prop) {
      if (prop === "CAIRNSTONE_DB" || prop === "CAIRNSTONE_AUTH_DB") touched += 1;
      return target[prop];
    }
  });
  applyRealmGuard("cairnstone_get_inbox", { recipient_id: "prin:a" }, env);
  applyRealmGuard("cairnstone_get_inbox", { recipient_id: "chatgpt:chat" }, env);
  assert.equal(touched, 0);
});

test("dispatch: legacy MCP call naming a private actor is denied before any storage access", async () => {
  const env = { AC1_REALM_GUARD: "enforce" };
  for (const [tool, args] of [
    ["cairnstone_get_inbox", { recipient_id: "prin:victim" }],
    ["cairnstone_list_threads", { recipient_id: "prin:victim" }],
    ["cairnstone_get_thread", { recipient_id: "prin:victim", thread_id: "t" }],
    ["cairnstone_read_message", { recipient_id: "prin:victim", message_id: "m" }],
    ["cairnstone_get_notes", { actor_id: "prin:victim" }],
    ["cairnstone_note_self", { actor_id: "prin:victim", content: "x" }],
    ["cairnstone_send_message", { from: "prin:victim", to: ["claude:chat"], content: "x" }],
    ["cairnstone_send_message", { from: "claude:chat", to: ["prin:victim"], content: "x" }],
    ["cairnstone_dispatch_handoff", { from: "claude:chat", to: ["prin:victim"], task: "t", chain: "c" }]
  ]) {
    const res = await rpc(tool, args, env);
    assert.equal(res.result.isError, true, tool);
    const body = payload(res);
    assert.equal(body.error, "private_realm_actor_forbidden", tool);
  }
});

test("dispatch: with the guard off the same call is not rejected by the guard", async () => {
  const res = await rpc("cairnstone_get_inbox", { recipient_id: "prin:victim" }, {});
  const text = res.result ? res.result.content[0].text : JSON.stringify(res.error);
  assert.doesNotMatch(text, /private_realm_actor_forbidden/);
});

test("dispatch: enforce does not reject a legacy actor", async () => {
  const res = await rpc("cairnstone_get_inbox", { recipient_id: "chatgpt:chat" }, { AC1_REALM_GUARD: "enforce" });
  const text = res.result ? res.result.content[0].text : JSON.stringify(res.error);
  assert.doesNotMatch(text, /private_realm_actor_forbidden/);
});

test("REST forward-with-note is guarded the same way", async () => {
  const env = { AC1_REALM_GUARD: "enforce" };
  const denied = await worker.fetch(new Request("https://cairnstone.test/v1/correspondence/forward-with-note", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ from: "claude:chat", to: ["prin:victim"], note: "x" })
  }), env);
  assert.equal(denied.status, 403);
  assert.equal((await denied.json()).error, "private_realm_actor_forbidden");

  const off = await worker.fetch(new Request("https://cairnstone.test/v1/correspondence/forward-with-note", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ from: "claude:chat", to: ["prin:victim"], note: "x" })
  }), {});
  assert.notEqual((await off.clone().json().catch(() => ({}))).error, "private_realm_actor_forbidden");
});
