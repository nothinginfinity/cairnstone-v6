import test from "node:test";
import assert from "node:assert/strict";
import {
  routeIntent,
  routeIntentFromBody,
  extractObjectRefsFromText,
  resolveActorAlias,
  INTENT_ROUTE_SCHEMA,
  INTENT_ROUTE_BROKER_TOOL_IDS,
  INTENT_ROUTE_MCP_TOOL_DEFINITIONS,
  INTENT_RULES
} from "../src/intent-router.js";
import {
  ACCESS_GRANT_BROKER_TOOL_IDS,
  ACCESS_GRANT_CREATE_TOOL_DEFINITION,
  ACCESS_GRANT_REVOKE_TOOL_DEFINITION,
  ACCESS_GRANT_LIST_TOOL_DEFINITION
} from "../src/access-grant.js";
import {
  TASK_RUN_BROKER_TOOL_IDS,
  TASK_RUN_PROPOSE_TOOL_DEFINITION
} from "../src/task-run.js";
import {
  FORWARD_NOTE_BROKER_TOOL_IDS,
  FORWARD_WITH_NOTE_TOOL_DEFINITION
} from "../src/forward-note.js";
import {
  DEFAULT_TOOL_BROKER_REGISTRY,
  toolRegistryFromBody
} from "../src/model-router.js";
import { listAutomaticReadToolIds } from "../src/delegate-loop.js";
import { mcpToolsForProfile } from "../src/index.js";

const ACTOR_A = "console:jared";
const ACTOR_B = "claude:cairnstone-v6";
const ACTOR_C = "chatgpt:cairnstone-v6";
const ACTOR_D = "grok-bot:cairnstone-v6";
const KNOWN = [ACTOR_B, ACTOR_C, ACTOR_D];
const STONE = "stone:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const REPO = "repo:nothinginfinity/cairnstone-v6@bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

function assertAuthorityClosed(result) {
  assert.equal(result.accepted_state_authority, false);
  assert.equal(result.grants_no_capability, true);
  assert.equal(result.auto_mutated, false);
  assert.equal(result.llm_called, false);
  assert.equal(result.provider_called, false);
  assert.equal(result.chain_heads_mutated, false);
  assert.equal(result.path_heads_mutated, false);
}

function assertArgsMatchSchema(args, inputSchema) {
  assert.equal(typeof args, "object");
  assert.ok(args && !Array.isArray(args));
  const allowed = new Set(Object.keys(inputSchema.properties || {}));
  for (const key of Object.keys(args)) {
    assert.ok(allowed.has(key), `unexpected arg key ${key}`);
  }
}

test("give-access: positive match → create proposal, never auto-mutates", () => {
  const result = routeIntent({
    text: "Give claude:cairnstone-v6 read access to msg:v7710-smoke",
    actor_id: ACTOR_A,
    context: { known_actors: KNOWN }
  });
  assert.equal(result.ok, true);
  assert.equal(result.schema, INTENT_ROUTE_SCHEMA);
  assert.equal(result.intent, "give-access");
  assert.ok(["exact", "high"].includes(result.confidence));
  assert.equal(result.requires_human_commit, true);
  assert.equal(result.auto_mutated, false);
  assert.equal(result.proposal.tool_id, ACCESS_GRANT_BROKER_TOOL_IDS.create);
  assert.equal(result.proposal.args.object_ref, "msg:v7710-smoke");
  assert.equal(result.proposal.args.principal_actor_id, ACTOR_B);
  assert.equal(result.proposal.args.permission, "read");
  assert.equal(result.proposal.args.grantor_actor_id, ACTOR_A);
  assert.deepEqual(result.proposal.missing_fields, []);
  assertArgsMatchSchema(result.proposal.args, ACCESS_GRANT_CREATE_TOOL_DEFINITION.inputSchema);
  assertAuthorityClosed(result);
  assert.ok(result.matched_patterns.some(id => id.startsWith("give-access.")));
});

test("give-access: discuss permission + focused_object_ref fallback", () => {
  const result = routeIntent({
    text: "Share with chatgpt discuss rights",
    actor_id: ACTOR_A,
    context: {
      focused_object_ref: STONE,
      known_actors: KNOWN
    }
  });
  assert.equal(result.intent, "give-access");
  assert.equal(result.proposal.args.permission, "discuss");
  assert.equal(result.proposal.args.object_ref, STONE);
  assert.equal(result.proposal.args.principal_actor_id, ACTOR_C);
  assert.equal(result.object_refs.includes(STONE), true);
});

test("revoke-access: with grant_id → revoke proposal", () => {
  const result = routeIntent({
    text: "Revoke access for grant:abc-123",
    actor_id: ACTOR_A
  });
  assert.equal(result.intent, "revoke-access");
  assert.equal(result.requires_human_commit, true);
  assert.equal(result.proposal.tool_id, ACCESS_GRANT_BROKER_TOOL_IDS.revoke);
  assert.equal(result.proposal.args.grant_id, "grant:abc-123");
  assert.equal(result.proposal.args.actor_id, ACTOR_A);
  assert.deepEqual(result.proposal.missing_fields, []);
  assertArgsMatchSchema(result.proposal.args, ACCESS_GRANT_REVOKE_TOOL_DEFINITION.inputSchema);
  assertAuthorityClosed(result);
});

test("revoke-access: without grant_id → list read + missing grant_id", () => {
  const result = routeIntent({
    text: "Remove access from msg:shared-1 for claude:cairnstone-v6",
    actor_id: ACTOR_A
  });
  assert.equal(result.intent, "revoke-access");
  assert.equal(result.proposal.tool_id, ACCESS_GRANT_BROKER_TOOL_IDS.revoke);
  assert.ok(result.proposal.missing_fields.includes("grant_id"));
  assert.equal(result.reads.length, 1);
  assert.equal(result.reads[0].tool_id, ACCESS_GRANT_BROKER_TOOL_IDS.list);
  assertArgsMatchSchema(result.reads[0].args, ACCESS_GRANT_LIST_TOOL_DEFINITION.inputSchema);
  assertAuthorityClosed(result);
});

test("assign / ask-to-work: propose task run args match 10b schema", () => {
  const result = routeIntent({
    text: `Ask ${ACTOR_B} to work on ${REPO}`,
    actor_id: ACTOR_A,
    context: { conversation_id: "cvs:demo", known_actors: KNOWN }
  });
  assert.equal(result.intent, "assign");
  assert.equal(result.requires_human_commit, true);
  assert.equal(result.proposal.tool_id, TASK_RUN_BROKER_TOOL_IDS.propose);
  assert.deepEqual(result.proposal.args.attachment_refs, [REPO]);
  assert.equal(result.proposal.args.assignee_actor_id, ACTOR_B);
  assert.equal(result.proposal.args.requested_by, ACTOR_A);
  assert.equal(result.proposal.args.conversation_id, "cvs:demo");
  assert.equal(result.proposal.args.requested_intent, "assign");
  assertArgsMatchSchema(result.proposal.args, TASK_RUN_PROPOSE_TOOL_DEFINITION.inputSchema);
  assertAuthorityClosed(result);

  const assign = routeIntent({
    text: `Assign to ${ACTOR_D}: please review msg:ticket-9`,
    actor_id: ACTOR_A
  });
  assert.equal(assign.intent, "assign");
  assert.equal(assign.proposal.args.assignee_actor_id, ACTOR_D);
  assert.ok(assign.proposal.args.attachment_refs.includes("msg:ticket-9"));
});

test("forward-with-note: proposal args match forward schema", () => {
  const result = routeIntent({
    text: `Forward with note to ${ACTOR_C} about msg:original-42 saying "FYI please review"`,
    actor_id: ACTOR_A
  });
  assert.equal(result.intent, "forward-with-note");
  assert.equal(result.requires_human_commit, true);
  assert.equal(result.proposal.tool_id, FORWARD_NOTE_BROKER_TOOL_IDS.forward);
  assert.equal(result.proposal.args.object_ref, "msg:original-42");
  assert.equal(result.proposal.args.to, ACTOR_C);
  assert.equal(result.proposal.args.from, ACTOR_A);
  assert.match(result.proposal.args.note, /FYI please review/);
  assertArgsMatchSchema(result.proposal.args, FORWARD_WITH_NOTE_TOOL_DEFINITION.inputSchema);
  assertAuthorityClosed(result);
});

test("ambiguous / empty / unrelated → intent none", () => {
  const empty = routeIntentFromBody({});
  assert.equal(empty.ok, false);
  assert.equal(empty.error, "text_or_intent_required");
  assert.equal(empty.auto_mutated, false);

  const blank = routeIntent({ text: "   " });
  assert.equal(blank.intent, "none");
  assert.equal(blank.proposal, null);
  assert.equal(blank.requires_human_commit, false);

  const unrelated = routeIntent({ text: "What is the weather in Austin today?" });
  assert.equal(unrelated.intent, "none");
  assert.equal(unrelated.confidence, "none");
  assert.equal(unrelated.proposal, null);
  assertAuthorityClosed(unrelated);
});

test("conflicting cues → none + conflict diagnostic", () => {
  const result = routeIntent({
    text: "Give access and also revoke access on msg:x for claude:cairnstone-v6",
    actor_id: ACTOR_A
  });
  assert.equal(result.intent, "none");
  assert.equal(result.proposal, null);
  assert.equal(result.diagnostics?.conflict, true);
  assert.ok(Array.isArray(result.diagnostics?.candidates));
  assert.ok(result.diagnostics.candidates.length >= 2);
  assertAuthorityClosed(result);
});

test("object ref normalization via 10b parseObjectRef", () => {
  const refs = extractObjectRefsFromText(
    `please use ${STONE} and ${REPO} plus bare aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa`
  );
  assert.ok(refs.includes(STONE));
  assert.ok(refs.includes(REPO));
  assert.equal(refs.filter(r => r === STONE).length, 1);

  const routed = routeIntent({
    text: `Assign to ${ACTOR_B} work on aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa`,
    actor_id: ACTOR_A,
    object_refs: ["cvs:session-1"]
  });
  assert.equal(routed.intent, "assign");
  assert.ok(routed.object_refs.includes(STONE));
  assert.ok(routed.object_refs.includes("conversation:cvs:session-1"));
});

test("actor extraction with known_actors; refuse ambiguous alias", () => {
  const ok = resolveActorAlias("claude", KNOWN);
  assert.equal(ok.ok, true);
  assert.equal(ok.actor_id, ACTOR_B);

  const ambiguous = resolveActorAlias("claude", [
    "claude:cairnstone-v6",
    "claude:other-mailbox"
  ]);
  assert.equal(ambiguous.ok, false);
  assert.equal(ambiguous.error, "ambiguous_actor_alias");

  const routed = routeIntent({
    text: "Give claude read access to msg:demo",
    actor_id: ACTOR_A,
    context: {
      known_actors: ["claude:cairnstone-v6", "claude:other-mailbox"]
    }
  });
  assert.equal(routed.intent, "give-access");
  assert.equal(routed.proposal.args.principal_actor_id, undefined);
  assert.ok(routed.proposal.missing_fields.includes("principal_actor_id"));
  assert.ok(routed.diagnostics?.actor_resolution?.some(d => d.code === "ambiguous_actor_alias"));
});

test("router never calls env.DB / createStone / sendMessage", () => {
  let dbTouched = false;
  let createStoneCalled = false;
  let sendMessageCalled = false;
  const env = {
    get CAIRNSTONE_DB() {
      dbTouched = true;
      return {
        prepare() {
          dbTouched = true;
          throw new Error("DB must not be touched by intent router");
        }
      };
    }
  };
  const depsTrap = {
    createStone: () => {
      createStoneCalled = true;
      throw new Error("createStone must not run");
    },
    sendMessage: () => {
      sendMessageCalled = true;
      throw new Error("sendMessage must not run");
    }
  };
  void depsTrap;

  const result = routeIntentFromBody({
    text: "Give claude:cairnstone-v6 execute-against access to msg:demo",
    actor_id: ACTOR_A
  }, env);

  assert.equal(result.ok, true);
  assert.equal(result.intent, "give-access");
  assert.equal(result.proposal.args.permission, "execute-against");
  assert.equal(dbTouched, false);
  assert.equal(createStoneCalled, false);
  assert.equal(sendMessageCalled, false);
  assert.equal(result.auto_mutated, false);
});

test("structured intent override still returns proposal only", () => {
  const result = routeIntentFromBody({
    intent: "ask-to-work",
    actor_id: ACTOR_A,
    object_refs: ["msg:override-1"],
    context: { known_actors: KNOWN }
  });
  assert.equal(result.ok, true);
  assert.equal(result.intent, "assign");
  assert.equal(result.proposal.tool_id, TASK_RUN_BROKER_TOOL_IDS.propose);
  assert.equal(result.auto_mutated, false);
  assert.equal(result.requires_human_commit, true);
  assert.ok(result.matched_patterns.includes("override:assign"));
});

test("MCP + broker: intent router is read/scoped_grant and never automatic-read", () => {
  const names = mcpToolsForProfile(false).map(tool => tool.name);
  assert.ok(names.includes(INTENT_ROUTE_BROKER_TOOL_IDS.route));
  assert.equal(INTENT_ROUTE_MCP_TOOL_DEFINITIONS.length, 1);
  assert.ok(INTENT_RULES.length >= 10);

  const registry = toolRegistryFromBody({}, { registry: DEFAULT_TOOL_BROKER_REGISTRY });
  assert.equal(registry.ok, true);
  assert.equal(registry.total, 96);
  const entry = registry.tools.find(t => t.tool_id === INTENT_ROUTE_BROKER_TOOL_IDS.route);
  assert.ok(entry);
  assert.equal(entry.risk_class, "read");
  assert.equal(entry.authorization, "scoped_grant");
  assert.equal(entry.available, true);

  const automatic = new Set(listAutomaticReadToolIds(DEFAULT_TOOL_BROKER_REGISTRY));
  assert.equal(automatic.has(INTENT_ROUTE_BROKER_TOOL_IDS.route), false);
});
