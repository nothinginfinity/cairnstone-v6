// Test-only D1-compatible wrapper over a REAL SQLite engine (node:sqlite), loaded from the
// actual private-realm migration file. No Miniflare, no network, no binding, no production data.
//
// What it reproduces from Cloudflare D1 (the parts the private store depends on):
//   - prepare(sql).bind(...).first() / .all() / .run(), with D1 result shapes
//     ({ results }, { meta: { changes } }) and D1's refusal to bind `undefined`.
//   - db.batch(stmts): ONE atomic transaction. Statements see each other's effects; any statement
//     error rolls back the whole batch. There is no await between BEGIN and COMMIT, so nothing can
//     interleave inside a batch (D1 serialises a batch the same way).
//   - FOREIGN KEY enforcement ON, triggers and partial unique indexes from the migration.
//
// What it adds so races are testable deterministically:
//   - Every statement/batch yields to the event loop first, so Promise.all() callers interleave at
//     statement granularity (the same granularity at which real D1 requests interleave).
//   - db.before(match, fn): run `fn` (async) just BEFORE the next statement/batch whose SQL matches.
//     A test uses this to commit a revocation or role change in the exact window between a store
//     method's authorization read and its write.
//   - db.log: every SQL string issued, for asserting statement shape (e.g. LIMIT before UPDATE).

import { readFileSync } from "node:fs";

let DatabaseSync = null;
try {
  ({ DatabaseSync } = await import("node:sqlite"));
} catch {
  /* node:sqlite unavailable on this Node version */
}

export const SQLITE_AVAILABLE = Boolean(DatabaseSync);
export const MIGRATION_URL = new URL("../../migrations/private/0001_s0b2_private_realm.sql", import.meta.url);
export const readMigration = () => readFileSync(MIGRATION_URL, "utf8");

const isReader = sql => /^\s*(select|with|pragma)\b/i.test(sql) || /\breturning\b/i.test(sql);
const isWrite = sql => /^\s*(insert|update|delete|replace)\b/i.test(sql);
const norm = sql => sql.replace(/\s+/g, " ").trim();
const tick = () => new Promise(resolve => setImmediate(resolve));

class D1Error extends Error {
  constructor(cause) {
    super(`D1_ERROR: ${cause && cause.message ? cause.message : cause}: SQLITE_CONSTRAINT`);
    this.name = "D1Error";
    this.cause = cause;
  }
}

export function createSqliteD1({ sql = readMigration() } = {}) {
  if (!DatabaseSync) throw new Error("node:sqlite unavailable");
  const raw = new DatabaseSync(":memory:");
  raw.exec("PRAGMA foreign_keys = ON");
  raw.exec(sql);
  const log = [];
  const hooks = [];
  // Physical commit order of every effective write (statement-level, batch-aware). A rolled-back
  // batch leaves no entries. Tests use `seq` to prove "no write committed AFTER a revocation".
  const writes = [];
  let seq = 0;
  const record = (sqlText, r, into) => {
    if (!isWrite(sqlText)) return;
    const changes = r.reader ? r.rows.length : r.changes;
    into.push({ seq: ++seq, sql: norm(sqlText), changes });
  };

  function bindCheck(args) {
    for (const a of args) {
      if (a === undefined) throw new Error("D1_TYPE_ERROR: Type 'undefined' not supported for value 'undefined'");
      if (typeof a === "boolean") throw new Error("D1_TYPE_ERROR: boolean binds are not portable; bind 0/1");
    }
  }

  async function gate(kind, sqlText) {
    log.push({ kind, sql: norm(sqlText) });
    await tick();
    for (const hook of [...hooks]) {
      if (hook.match(sqlText)) {
        if (hook.once) hooks.splice(hooks.indexOf(hook), 1);
        await hook.fn({ kind, sql: norm(sqlText) });
      }
    }
  }

  function execSync(sqlText, args) {
    const st = raw.prepare(sqlText);
    if (isReader(sqlText)) return { reader: true, rows: st.all(...args) };
    const info = st.run(...args);
    return { reader: false, changes: Number(info.changes) };
  }

  function resultOf(r) {
    return r.reader
      ? { success: true, results: r.rows, meta: { changes: 0 } }
      : { success: true, results: [], meta: { changes: r.changes } };
  }

  function makeStatement(sqlText) {
    return {
      bind(...args) {
        bindCheck(args);
        const bound = {
          sql: sqlText,
          args,
          async first() {
            await gate("first", sqlText);
            const r = execSync(sqlText, args);
            record(sqlText, r, writes);
            return r.reader ? (r.rows[0] ?? null) : null;
          },
          async all() {
            await gate("all", sqlText);
            const r = execSync(sqlText, args);
            record(sqlText, r, writes);
            return resultOf(r);
          },
          async run() {
            await gate("run", sqlText);
            try {
              const r = execSync(sqlText, args);
              record(sqlText, r, writes);
              return resultOf(r);
            } catch (e) {
              throw new D1Error(e);
            }
          }
        };
        return bound;
      }
    };
  }

  const db = {
    prepare: makeStatement,
    async batch(stmts) {
      if (!Array.isArray(stmts) || stmts.length === 0) throw new Error("D1_ERROR: empty batch");
      for (const s of stmts) if (!s || typeof s.sql !== "string" || !Array.isArray(s.args)) throw new Error("D1_ERROR: batch needs bound statements");
      await gate("batch", stmts.map(s => s.sql).join(" ;; "));
      // ---- atomic section: no await below this line until COMMIT/ROLLBACK ----
      raw.exec("BEGIN");
      try {
        const pending = [];
        const out = stmts.map(s => {
          const r = execSync(s.sql, s.args);
          record(s.sql, r, pending);
          return resultOf(r);
        });
        raw.exec("COMMIT");
        writes.push(...pending);
        return out;
      } catch (e) {
        raw.exec("ROLLBACK");
        throw new D1Error(e);
      }
    },

    // ---- test-only helpers (not part of the D1 surface the store may use) ----
    raw,
    log,
    writes,
    get seq() { return seq; },
    before(match, fn, { once = true } = {}) {
      const m = typeof match === "string" ? s => s.includes(match) : match instanceof RegExp ? s => match.test(s) : match;
      hooks.push({ match: m, fn, once });
    },
    clearHooks() { hooks.length = 0; },
    rows(sqlText, ...args) { return raw.prepare(sqlText).all(...args); },
    count(table, where = "1=1", ...args) { return raw.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${where}`).get(...args).n; },
    exec(sqlText) { raw.exec(sqlText); }
  };
  return db;
}

// Deterministic clock and id minting so assertions are exact and runs are reproducible.
export function createClock(start = Date.parse("2026-10-11T00:00:00.000Z")) {
  let n = 0;
  return () => new Date(start + n++).toISOString();
}

export function createMint() {
  let n = 0;
  return (prefix, bytes) => `${prefix}_${String(++n).padStart(Math.max(8, bytes * 2), "0")}`;
}

// Minimal in-memory R2 double: only what the private body adapter may call.
export function createFakeR2() {
  const objects = new Map();
  const calls = [];
  return {
    objects,
    calls,
    async put(key, value) {
      calls.push(["put", key]);
      objects.set(key, typeof value === "string" ? value : String(value));
    },
    async get(key) {
      calls.push(["get", key]);
      if (!objects.has(key)) return null;
      const text = objects.get(key);
      return { text: async () => text };
    }
  };
}
