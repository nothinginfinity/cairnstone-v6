import test from "node:test";
import assert from "node:assert/strict";
import {
  EVENT_JOURNAL_SCHEMA,
  EVENT_JOURNAL_MAX_DETAIL_BYTES,
  buildEventJournalRecord,
  appendEventJournal,
  listEventJournal,
  encodeEventCursor,
  decodeEventCursor
} from "../src/event-journal.js";

const FIXED_NOW = "2026-10-03T00:00:00.000Z";
const UUID = "00000000-0000-4000-8000-000000000001";

function options() {
  return { now: () => FIXED_NOW, randomUUID: () => UUID };
}

test("builds authority-closed semantic event with bounded metadata", () => {
  const result = buildEventJournalRecord({
    event_type: "stone.created",
    actor_id: "chatgpt:cairnstone-v6",
    object_ref: "stone:abc123",
    chain: "cairnstone-v6-project-memory",
    stone_hash: "abc123",
    detail: { title: "example" }
  }, options());

  assert.equal(result.ok, true);
  assert.equal(result.event.schema, EVENT_JOURNAL_SCHEMA);
  assert.equal(result.event.event_id, `evt:${UUID}`);
  assert.equal(result.event.occurred_at, FIXED_NOW);
  assert.equal(result.event.accepted_state_authority, false);
  assert.equal(result.event.chain_heads_mutated, false);
  assert.equal(result.event.path_heads_mutated, false);
  assert.deepEqual(result.event.detail, { title: "example" });
});

test("rejects secret-bearing detail keys recursively", () => {
  const result = buildEventJournalRecord({
    event_type: "stone.created",
    detail: { nested: { oauth_token: "nope" } }
  }, options());
  assert.equal(result.ok, false);
  assert.equal(result.error, "secret_bearing_detail_rejected");
});

test("rejects detail beyond UTF-8 byte budget", () => {
  const result = buildEventJournalRecord({
    event_type: "stone.created",
    detail: { payload: "x".repeat(EVENT_JOURNAL_MAX_DETAIL_BYTES + 1) }
  }, options());
  assert.equal(result.ok, false);
  assert.equal(result.error, "detail_too_large");
});

test("validates lod level", () => {
  const bad = buildEventJournalRecord({ event_type: "stone.lod.read", lod_level: "lod6" }, options());
  assert.equal(bad.ok, false);
  const good = buildEventJournalRecord({ event_type: "stone.lod.read", lod_level: "lod5" }, options());
  assert.equal(good.ok, true);
});

test("cursor round trip is opaque and exclusive-ready", () => {
  const cursor = encodeEventCursor({ occurred_at: FIXED_NOW, event_id: "evt:xyz" });
  assert.match(cursor, /^ej1\./);
  assert.equal(cursor.includes(FIXED_NOW), false);
  const decoded = decodeEventCursor(cursor);
  assert.deepEqual(decoded, { ok: true, occurred_at: FIXED_NOW, event_id: "evt:xyz" });
});

test("append binds event row with accepted authority hard-closed in SQL", async () => {
  const calls = [];
  const db = {
    prepare(sql) {
      const state = { sql, args: [] };
      calls.push(state);
      return {
        bind(...args) { state.args = args; return this; },
        async run() { return { success: true }; }
      };
    }
  };
  const result = await appendEventJournal(db, {
    event_type: "head.path.changed",
    chain: "cairnstone-v6-project-memory",
    path: "project-memory/example.md",
    from_state: "old",
    to_state: "new"
  }, options());

  assert.equal(result.ok, true);
  assert.match(calls[0].sql, /accepted_state_authority/);
  assert.match(calls[0].sql, /VALUES \([\s\S]*0\)/);
  assert.equal(result.event.accepted_state_authority, false);
});

test("list applies cursor ordering, filters, limit clamp, and returns authority-closed rows", async () => {
  let seenSql = "";
  let seenArgs = [];
  const row = {
    event_id: "evt:2",
    schema: EVENT_JOURNAL_SCHEMA,
    event_type: "stone.created",
    event_class: "semantic",
    source: "journal",
    occurred_at: "2026-10-02T23:00:00.000Z",
    actor_id: "chatgpt:cairnstone-v6",
    object_ref: "stone:2",
    subject_ref: null,
    chain_name: "cairnstone-v6-project-memory",
    path: null,
    stone_hash: "2",
    related_hash: null,
    from_state: null,
    to_state: null,
    lod_level: null,
    observed_commit_sha: null,
    content_sha256: null,
    request_correlation_id: null,
    detail_json: "{}",
    accepted_state_authority: 0
  };
  const db = {
    prepare(sql) {
      seenSql = sql;
      return {
        bind(...args) { seenArgs = args; return this; },
        async all() { return { results: [row] }; }
      };
    }
  };
  const after = encodeEventCursor({ occurred_at: FIXED_NOW, event_id: "evt:9" });
  const result = await listEventJournal(db, {
    actor_id: "chatgpt:cairnstone-v6",
    chain: "cairnstone-v6-project-memory",
    after_cursor: after,
    limit: 500
  });

  assert.equal(result.ok, true);
  assert.match(seenSql, /actor_id = \?/);
  assert.match(seenSql, /chain_name = \?/);
  assert.match(seenSql, /occurred_at < \?/);
  assert.equal(seenArgs.at(-1), 100);
  assert.equal(result.events[0].accepted_state_authority, false);
  assert.equal(result.events[0].chain, "cairnstone-v6-project-memory");
});
