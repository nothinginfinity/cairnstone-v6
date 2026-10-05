import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const BASE_SCHEMA = `
CREATE TABLE stones (
  hash TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  author TEXT NOT NULL,
  created_at TEXT NOT NULL,
  repo TEXT,
  commit_sha TEXT,
  parent_hash TEXT,
  chain_hash TEXT,
  raw_key TEXT NOT NULL,
  stone_json TEXT NOT NULL,
  path TEXT NOT NULL DEFAULT 'content.txt'
);
CREATE TABLE chain_heads (
  chain TEXT PRIMARY KEY,
  head_hash TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE path_heads (
  chain TEXT NOT NULL,
  path TEXT NOT NULL,
  head_hash TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (chain, path)
);
CREATE TABLE stone_edges (
  id TEXT PRIMARY KEY,
  from_hash TEXT NOT NULL,
  to_hash TEXT NOT NULL,
  edge_type TEXT NOT NULL,
  note TEXT,
  created_at TEXT NOT NULL
);
`;

const STONE_1 = "a".repeat(64);
const STONE_2 = "b".repeat(64);
const STONE_3 = "c".repeat(64);
const RAW_1 = `raw/${"1".repeat(64)}.txt`;
const RAW_2 = `raw/${"2".repeat(64)}.txt`;
const RAW_3 = `raw/${"3".repeat(64)}.txt`;

function sql(dbPath, statement) {
  return execFileSync("sqlite3", [dbPath, statement], { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }).trim();
}

function insertStone(dbPath, hash, rawKey, author = "chatgpt:cairnstone-v6") {
  return sql(dbPath, `INSERT INTO stones
    (hash,title,author,created_at,repo,commit_sha,parent_hash,chain_hash,raw_key,stone_json,path)
    VALUES ('${hash}','title','${author}','2026-10-05T00:00:00.000Z','nothinginfinity/cairnstone-v6',NULL,NULL,'chain:test','${rawKey}','{}','docs/example.md');`);
}

function setupDb() {
  const dir = mkdtempSync(join(tmpdir(), "event-journal-hooks-"));
  const dbPath = join(dir, "journal.sqlite");
  const substrate = readFileSync(new URL("../migrations/0025_v7710f1_event_journal.sql", import.meta.url), "utf8");
  const hooks = readFileSync(new URL("../migrations/0026_v7710f1b_event_journal_write_hooks.sql", import.meta.url), "utf8");
  execFileSync("sqlite3", [dbPath], { input: `${BASE_SCHEMA}\n${substrate}\n${hooks}` });
  return { dir, dbPath };
}

test("critical writes emit authority-closed semantic events with exact HEAD transitions", () => {
  const { dir, dbPath } = setupDb();
  try {
    insertStone(dbPath, STONE_1, RAW_1);
    insertStone(dbPath, STONE_2, RAW_2, "grok:cairnstone-v6");

    sql(dbPath, `INSERT INTO chain_heads (chain,head_hash,updated_at) VALUES ('chain:test','${STONE_1}','2026-10-05T00:00:01.000Z');`);
    sql(dbPath, `UPDATE chain_heads SET head_hash='${STONE_2}', updated_at='2026-10-05T00:00:02.000Z' WHERE chain='chain:test';`);
    sql(dbPath, `INSERT INTO path_heads (chain,path,head_hash,updated_at) VALUES ('chain:test','docs/example.md','${STONE_1}','2026-10-05T00:00:03.000Z');`);
    sql(dbPath, `UPDATE path_heads SET head_hash='${STONE_2}', updated_at='2026-10-05T00:00:04.000Z' WHERE chain='chain:test' AND path='docs/example.md';`);
    sql(dbPath, `INSERT INTO stone_edges (id,from_hash,to_hash,edge_type,note,created_at) VALUES ('edge:1','${STONE_2}','${STONE_1}','supersedes',NULL,'2026-10-05T00:00:05.000Z');`);

    assert.equal(sql(dbPath, "SELECT COUNT(*) FROM event_journal WHERE accepted_state_authority <> 0;"), "0");
    assert.equal(sql(dbPath, "SELECT COUNT(*) FROM event_journal WHERE event_type='stone.created';"), "2");
    assert.equal(sql(dbPath, "SELECT actor_id FROM event_journal WHERE event_type='stone.created' AND stone_hash='" + STONE_1 + "';"), "chatgpt:cairnstone-v6");
    assert.equal(sql(dbPath, "SELECT content_sha256 FROM event_journal WHERE event_type='stone.created' AND stone_hash='" + STONE_1 + "';"), "1".repeat(64));

    const chainTransitions = sql(dbPath, `SELECT COALESCE(from_state,'<null>') || '>' || to_state FROM event_journal WHERE event_type='head.chain.changed' ORDER BY rowid;`).split("\n");
    assert.deepEqual(chainTransitions, [`<null>>${STONE_1}`, `${STONE_1}>${STONE_2}`]);

    const pathTransitions = sql(dbPath, `SELECT COALESCE(from_state,'<null>') || '>' || to_state FROM event_journal WHERE event_type='head.path.changed' ORDER BY rowid;`).split("\n");
    assert.deepEqual(pathTransitions, [`<null>>${STONE_1}`, `${STONE_1}>${STONE_2}`]);

    assert.equal(sql(dbPath, "SELECT json_extract(detail_json,'$.edge_type') FROM event_journal WHERE event_type='edge.created' AND object_ref='edge:edge:1';"), "supersedes");
    assert.equal(sql(dbPath, "SELECT related_hash FROM event_journal WHERE event_type='edge.created' AND object_ref='edge:edge:1';"), STONE_1);

    const beforeNoop = sql(dbPath, "SELECT COUNT(*) FROM event_journal WHERE event_type='head.chain.changed';");
    sql(dbPath, `UPDATE chain_heads SET updated_at='2026-10-05T00:00:06.000Z' WHERE chain='chain:test';`);
    assert.equal(sql(dbPath, "SELECT COUNT(*) FROM event_journal WHERE event_type='head.chain.changed';"), beforeNoop);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("journal insert failure aborts Stone, chain HEAD, path HEAD, and edge mutations", () => {
  const { dir, dbPath } = setupDb();
  try {
    insertStone(dbPath, STONE_1, RAW_1);
    insertStone(dbPath, STONE_2, RAW_2);
    sql(dbPath, `INSERT INTO chain_heads (chain,head_hash,updated_at) VALUES ('chain:test','${STONE_1}','2026-10-05T00:00:01.000Z');`);
    sql(dbPath, `INSERT INTO path_heads (chain,path,head_hash,updated_at) VALUES ('chain:test','docs/example.md','${STONE_1}','2026-10-05T00:00:02.000Z');`);

    sql(dbPath, `CREATE TRIGGER force_event_journal_insert_failure BEFORE INSERT ON event_journal BEGIN SELECT RAISE(ABORT, 'forced_event_journal_failure'); END;`);

    assert.throws(() => insertStone(dbPath, STONE_3, RAW_3), /forced_event_journal_failure/);
    assert.equal(sql(dbPath, `SELECT COUNT(*) FROM stones WHERE hash='${STONE_3}';`), "0");

    assert.throws(() => sql(dbPath, `UPDATE chain_heads SET head_hash='${STONE_2}', updated_at='2026-10-05T00:00:03.000Z' WHERE chain='chain:test';`), /forced_event_journal_failure/);
    assert.equal(sql(dbPath, "SELECT head_hash FROM chain_heads WHERE chain='chain:test';"), STONE_1);

    assert.throws(() => sql(dbPath, `UPDATE path_heads SET head_hash='${STONE_2}', updated_at='2026-10-05T00:00:04.000Z' WHERE chain='chain:test' AND path='docs/example.md';`), /forced_event_journal_failure/);
    assert.equal(sql(dbPath, "SELECT head_hash FROM path_heads WHERE chain='chain:test' AND path='docs/example.md';"), STONE_1);

    assert.throws(() => sql(dbPath, `INSERT INTO stone_edges (id,from_hash,to_hash,edge_type,note,created_at) VALUES ('edge:blocked','${STONE_2}','${STONE_1}','references',NULL,'2026-10-05T00:00:05.000Z');`), /forced_event_journal_failure/);
    assert.equal(sql(dbPath, "SELECT COUNT(*) FROM stone_edges WHERE id='edge:blocked';"), "0");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
