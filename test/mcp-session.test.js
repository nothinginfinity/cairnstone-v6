import test from "node:test";
import assert from "node:assert/strict";
import {
  MAX_NATIVE_HYDRATED_TOOLS,
  createMcpCoreSession,
  deleteMcpCoreSession,
  getMcpCoreSession,
  setMcpCoreSessionTools,
  validateNativeHydrationSelection
} from "../src/mcp-session.js";

class FakeD1 {
  constructor() {
    this.rows = new Map();
  }

  prepare(sql) {
    const db = this;
    return {
      bind(...args) {
        return {
          async run() {
            if (sql.startsWith("INSERT INTO mcp_core_sessions")) {
              const [sessionId, profile, hydrated, createdAt, updatedAt, expiresAt] = args;
              const prior = db.rows.get(sessionId);
              db.rows.set(sessionId, {
                session_id: sessionId,
                profile,
                hydrated_tool_ids_json: hydrated,
                created_at: prior?.created_at ?? createdAt,
                updated_at: updatedAt,
                expires_at: expiresAt
              });
              return { success: true, meta: { changes: 1 } };
            }
            if (sql.startsWith("UPDATE mcp_core_sessions")) {
              const [hydrated, updatedAt, expiresAt, sessionId] = args;
              const row = db.rows.get(sessionId);
              if (row) db.rows.set(sessionId, { ...row, hydrated_tool_ids_json: hydrated, updated_at: updatedAt, expires_at: expiresAt });
              return { success: true, meta: { changes: row ? 1 : 0 } };
            }
            if (sql.startsWith("DELETE FROM mcp_core_sessions")) {
              const [sessionId] = args;
              const deleted = db.rows.delete(sessionId);
              return { success: true, meta: { changes: deleted ? 1 : 0 } };
            }
            throw new Error(`Unexpected run SQL: ${sql}`);
          },
          async first() {
            if (sql.startsWith("SELECT session_id,profile,hydrated_tool_ids_json")) {
              const [sessionId] = args;
              return db.rows.get(sessionId) || null;
            }
            throw new Error(`Unexpected first SQL: ${sql}`);
          }
        };
      }
    };
  }
}

const definitions = [
  { name: "cairnstone_health", inputSchema: { type: "object" } },
  { name: "cairnstone_resume_chain", inputSchema: { type: "object" } },
  { name: "cairnstone_get_source_freshness", inputSchema: { type: "object" } },
  { name: "cairnstone_commit_v2", inputSchema: { type: "object" } },
  { name: "cairnstone_list_stones", inputSchema: { type: "object" } }
];
const core = new Set(["cairnstone_health", "cairnstone_resume_chain", "cairnstone_load_tools"]);
const broker = [
  { tool_id: "cairnstone_get_source_freshness", risk_class: "read", authorization: "automatic", available: true },
  { tool_id: "cairnstone_commit_v2", risk_class: "mutation", authorization: "human_confirmation", available: true }
];

test("native selection dedupes, sorts, and excludes tools already in core", () => {
  const result = validateNativeHydrationSelection(
    ["cairnstone_get_source_freshness", "cairnstone_health", "cairnstone_get_source_freshness"],
    definitions,
    core,
    broker
  );
  assert.equal(result.ok, true);
  assert.deepEqual(result.hydrated_tool_ids, ["cairnstone_get_source_freshness"]);
  assert.deepEqual(result.already_core_tool_ids, ["cairnstone_health"]);
});

test("unknown tool IDs reject the whole native selection without persistence", () => {
  const result = validateNativeHydrationSelection(["not_a_tool"], definitions, core, broker);
  assert.equal(result.ok, false);
  assert.equal(result.error, "native_hydration_selection_rejected");
  assert.deepEqual(result.unknown_tool_ids, ["not_a_tool"]);
  assert.equal(result.persisted, false);
});

test("mutation-class tool cannot enter the native direct surface", () => {
  const result = validateNativeHydrationSelection(["cairnstone_commit_v2"], definitions, core, broker);
  assert.equal(result.ok, false);
  assert.equal(result.policy_ineligible[0].risk_class, "mutation");
  assert.equal(result.policy_ineligible[0].authorization, "human_confirmation");
});

test("unclassified catalog tool cannot enter the native direct surface", () => {
  const result = validateNativeHydrationSelection(["cairnstone_list_stones"], definitions, core, broker);
  assert.equal(result.ok, false);
  assert.equal(result.policy_ineligible[0].reason, "broker_classification_missing");
});

test("selection enforces bounded tool count", () => {
  const ids = Array.from({ length: MAX_NATIVE_HYDRATED_TOOLS + 1 }, (_, index) => `tool_${index}`);
  const result = validateNativeHydrationSelection(ids, definitions, core, broker);
  assert.equal(result.ok, false);
  assert.equal(result.error, "native_hydration_tool_limit_exceeded");
});

test("session create/get stores no accepted-state authority and starts empty", async () => {
  const db = new FakeD1();
  const created = await createMcpCoreSession(db, "session-12345678", 1_000_000);
  assert.equal(created.ok, true);
  assert.deepEqual(created.hydrated_tool_ids, []);
  assert.equal(created.accepted_state_authority, false);
  const found = await getMcpCoreSession(db, "session-12345678", 1_001_000);
  assert.equal(found.ok, true);
  assert.deepEqual(found.hydrated_tool_ids, []);
});

test("session tool overlays remain isolated", async () => {
  const db = new FakeD1();
  await createMcpCoreSession(db, "session-aaaaaaaa", 2_000_000);
  await createMcpCoreSession(db, "session-bbbbbbbb", 2_000_000);
  await setMcpCoreSessionTools(db, "session-aaaaaaaa", ["cairnstone_get_source_freshness"], 2_001_000);
  const left = await getMcpCoreSession(db, "session-aaaaaaaa", 2_002_000);
  const right = await getMcpCoreSession(db, "session-bbbbbbbb", 2_002_000);
  assert.deepEqual(left.hydrated_tool_ids, ["cairnstone_get_source_freshness"]);
  assert.deepEqual(right.hydrated_tool_ids, []);
});

test("session expiration fails closed and removes stale state", async () => {
  const db = new FakeD1();
  const created = await createMcpCoreSession(db, "session-expire00", 3_000_000);
  const expiredMs = (created.expires_at + 1) * 1000;
  const result = await getMcpCoreSession(db, "session-expire00", expiredMs);
  assert.equal(result.ok, false);
  assert.equal(result.error, "mcp_session_expired");
  assert.equal(db.rows.has("session-expire00"), false);
});

test("session deletion terminates native hydration state", async () => {
  const db = new FakeD1();
  await createMcpCoreSession(db, "session-delete00", 4_000_000);
  const deleted = await deleteMcpCoreSession(db, "session-delete00");
  assert.equal(deleted.ok, true);
  const result = await getMcpCoreSession(db, "session-delete00", 4_001_000);
  assert.equal(result.ok, false);
  assert.equal(result.error, "mcp_session_not_found");
});
