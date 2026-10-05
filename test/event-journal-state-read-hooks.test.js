import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { recordLodRead } from "../src/event-journal.js";
import { handleMcpRpc } from "../src/index.js";

const STONE = "d".repeat(64);
const CONTENT = "e".repeat(64);
const OTHER_COMMIT = "f".repeat(40);

function sql(dbPath, statement) {
  return execFileSync("sqlite3", [dbPath, statement], { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }).trim();
}

function setupDb() {
  const dir = mkdtempSync(join(tmpdir(), "event-journal-10f1c-"));
  const dbPath = join(dir, "journal.sqlite");
  const parts = [
    `CREATE TABLE stones (hash TEXT PRIMARY KEY, title TEXT NOT NULL, author TEXT NOT NULL, created_at TEXT NOT NULL, repo TEXT, commit_sha TEXT, parent_hash TEXT, chain_hash TEXT, raw_key TEXT NOT NULL, stone_json TEXT NOT NULL, path TEXT NOT NULL DEFAULT 'content.txt');`,
    `CREATE TABLE source_freshness (
      chain TEXT NOT NULL, path TEXT NOT NULL, owner TEXT NOT NULL, repo TEXT NOT NULL,
      checked_ref TEXT NOT NULL, observed_commit_sha TEXT, observed_at TEXT NOT NULL,
      accepted_stone_hash TEXT, accepted_commit_sha TEXT, drift INTEGER NOT NULL, drift_reason TEXT,
      accepted_content_sha256 TEXT, observed_content_sha256 TEXT, PRIMARY KEY (chain, path)
    );`,
    `CREATE TABLE correspondence_deliveries (
      id TEXT PRIMARY KEY, stone_hash TEXT NOT NULL, message_id TEXT NOT NULL,
      message_fingerprint TEXT NOT NULL, recipient_id TEXT NOT NULL, sender_id TEXT NOT NULL,
      thread_id TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'delivered', created_at TEXT NOT NULL,
      delivered_at TEXT, read_at TEXT, acked_at TEXT, archived_at TEXT, claimed_by TEXT, claimed_at TEXT
    );`,
    readFileSync(new URL("../migrations/0025_v7710f1_event_journal.sql", import.meta.url), "utf8"),
    readFileSync(new URL("../migrations/0027_v7710f1c_semantic_state_read_hooks.sql", import.meta.url), "utf8")
  ];
  execFileSync("sqlite3", [dbPath], { input: parts.join("\n") });
  return { dir, dbPath };
}

test("freshness checks emit outcome events and commit-only changes stay in_sync", () => {
  const { dir, dbPath } = setupDb();
  try {
    sql(dbPath, `INSERT INTO source_freshness
      (chain,path,owner,repo,checked_ref,observed_commit_sha,observed_at,accepted_stone_hash,accepted_commit_sha,drift,drift_reason,accepted_content_sha256,observed_content_sha256)
      VALUES ('chain:test','docs/a.md','nothinginfinity','cairnstone-v6','main','${"a".repeat(40)}','2026-10-05T00:00:00.000Z','${STONE}','${"a".repeat(40)}',0,NULL,'${CONTENT}','${CONTENT}');`);
    sql(dbPath, `UPDATE source_freshness SET observed_commit_sha='${OTHER_COMMIT}', observed_at='2026-10-05T00:00:01.000Z' WHERE chain='chain:test' AND path='docs/a.md';`);
    sql(dbPath, `UPDATE source_freshness SET drift=1, drift_reason='removed', observed_content_sha256=NULL, observed_at='2026-10-05T00:00:02.000Z' WHERE chain='chain:test' AND path='docs/a.md';`);

    const outcomes = sql(dbPath, "SELECT to_state FROM event_journal WHERE event_type='freshness.checked' ORDER BY rowid;").split("\n");
    assert.deepEqual(outcomes, ["in_sync", "in_sync", "removed"]);
    assert.equal(sql(dbPath, "SELECT COUNT(*) FROM event_journal WHERE event_type='freshness.checked' AND to_state='drifted';"), "0");
    assert.equal(sql(dbPath, "SELECT observed_commit_sha FROM event_journal WHERE event_type='freshness.checked' ORDER BY rowid LIMIT 1 OFFSET 1;"), OTHER_COMMIT);
    assert.equal(sql(dbPath, "SELECT accepted_state_authority FROM event_journal WHERE event_type='freshness.checked' LIMIT 1;"), "0");
    assert.equal(sql(dbPath, "SELECT instr(detail_json, 'payload') FROM event_journal WHERE event_type='freshness.checked' LIMIT 1;"), "0");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("AC1 delivery transitions are auditable without message bodies and fail closed", () => {
  const { dir, dbPath } = setupDb();
  try {
    sql(dbPath, `INSERT INTO correspondence_deliveries
      (id,stone_hash,message_id,message_fingerprint,recipient_id,sender_id,thread_id,status,created_at)
      VALUES ('del:1','${STONE}','msg:1','fp','grok:cairnstone-v6','chatgpt:cairnstone-v6','thread:1','delivered','2026-10-05T00:00:00.000Z');`);
    sql(dbPath, `UPDATE correspondence_deliveries SET status='read', read_at='2026-10-05T00:00:01.000Z' WHERE id='del:1';`);
    sql(dbPath, `UPDATE correspondence_deliveries SET read_at='2026-10-05T00:00:02.000Z' WHERE id='del:1';`);

    const transitions = sql(dbPath, "SELECT COALESCE(from_state,'<null>') || '>' || to_state FROM event_journal WHERE event_type='ac1.delivery.transitioned' ORDER BY rowid;").split("\n");
    assert.deepEqual(transitions, ["<null>>delivered", "delivered>read"]);
    assert.equal(sql(dbPath, "SELECT json_extract(detail_json,'$.message_id') FROM event_journal WHERE event_type='ac1.delivery.transitioned' ORDER BY rowid LIMIT 1;"), "msg:1");
    assert.equal(sql(dbPath, "SELECT COUNT(*) FROM event_journal WHERE event_type='ac1.delivery.transitioned' AND detail_json LIKE '%content%';"), "0");

    sql(dbPath, "CREATE TRIGGER force_event_journal_insert_failure BEFORE INSERT ON event_journal BEGIN SELECT RAISE(ABORT, 'forced_event_journal_failure'); END;");
    assert.throws(() => sql(dbPath, "UPDATE correspondence_deliveries SET status='acked' WHERE id='del:1';"), /forced_event_journal_failure/);
    assert.equal(sql(dbPath, "SELECT status FROM correspondence_deliveries WHERE id='del:1';"), "read");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("LOD read audit records identity only and rejects payload detail", async () => {
  const writes = [];
  const db = {
    prepare() {
      return {
        bind(...args) {
          return { async run() { writes.push(args); return { success: true }; } };
        }
      };
    }
  };
  const ok = await recordLodRead(db, { actor_id: "grok:cairnstone-v6", stone_hash: STONE, lod_level: "lod1", chain: "chain:test", path: "docs/a.md" });
  assert.equal(ok.ok, true);
  assert.equal(ok.event.event_type, "stone.lod.read");
  assert.equal(ok.event.lod_level, "lod1");
  assert.equal(ok.event.actor_id, "grok:cairnstone-v6");
  assert.equal(ok.event.detail.payload, undefined);
  assert.equal(JSON.stringify(ok.event.detail).includes(STONE) , false);

  const rejected = await recordLodRead(db, { stone_hash: STONE, lod_level: "lod5", detail: { payload: "secret body" } });
  assert.equal(rejected.ok, false);
  assert.equal(rejected.error, "lod_payload_rejected");
  assert.equal(writes.length, 1);
});


function makeLodAuditDb({ failAudit = false } = {}) {
  const writes = [];
  const stone = {
    border: { chain: "chain:test", path: "docs/a.md" },
    layers: { lod1: "TOP SECRET LOD PAYLOAD" }
  };
  return {
    writes,
    db: {
      prepare(sqlText) {
        return {
          bind(...args) {
            return {
              async first() {
                if (/FROM stones WHERE hash = \?/.test(sqlText)) {
                  return { stone_json: JSON.stringify(stone) };
                }
                throw new Error(`unexpected first SQL: ${sqlText}`);
              },
              async run() {
                if (/INSERT INTO event_journal/.test(sqlText)) {
                  if (failAudit) throw new Error("forced_event_journal_failure");
                  writes.push(args);
                  return { success: true };
                }
                throw new Error(`unexpected run SQL: ${sqlText}`);
              }
            };
          }
        };
      }
    }
  };
}

async function callLod(db, { actorId = null, claimedActorId = null } = {}) {
  const args = { hash: STONE, level: "lod1" };
  if (claimedActorId) args.actor_id = claimedActorId;
  return handleMcpRpc({
    jsonrpc: "2.0",
    id: 101,
    method: "tools/call",
    params: { name: "cairnstone_get_lod", arguments: args }
  }, { CAIRNSTONE_DB: db }, actorId ? { authContext: { principal_id: actorId } } : {});
}

test("MCP LOD read records only trusted auth actor identity", async () => {
  const trusted = makeLodAuditDb();
  const rpc = await callLod(trusted.db, { actorId: "grok:cairnstone-v6" });
  assert.equal(rpc.result.isError, false);
  const payload = JSON.parse(rpc.result.content[0].text);
  assert.equal(payload.value, "TOP SECRET LOD PAYLOAD");
  assert.equal(trusted.writes.length, 1);
  assert.equal(trusted.writes[0][6], "grok:cairnstone-v6");

  const spoofed = makeLodAuditDb();
  const spoofRpc = await callLod(spoofed.db, {
    actorId: "grok:cairnstone-v6",
    claimedActorId: "spoofed:actor"
  });
  assert.equal(spoofRpc.result.isError, true);
  assert.equal(spoofed.writes.length, 0);

  const unauthenticated = makeLodAuditDb();
  const legacyRpc = await callLod(unauthenticated.db, { claimedActorId: "spoofed:actor" });
  assert.equal(legacyRpc.result.isError, false);
  assert.equal(unauthenticated.writes.length, 1);
  assert.equal(unauthenticated.writes[0][6], null);
});

test("MCP LOD read fails closed and returns no payload when audit write fails", async () => {
  const failing = makeLodAuditDb({ failAudit: true });
  const rpc = await callLod(failing.db, { actorId: "grok:cairnstone-v6" });
  assert.equal(rpc.result.isError, true);
  const payload = JSON.parse(rpc.result.content[0].text);
  assert.equal(payload.ok, false);
  assert.equal(payload.error, "lod_read_audit_failed");
  assert.equal(Object.prototype.hasOwnProperty.call(payload, "value"), false);
  assert.equal(JSON.stringify(payload).includes("TOP SECRET LOD PAYLOAD"), false);
});
