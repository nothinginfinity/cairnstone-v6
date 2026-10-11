// Test-only equivalent of the sqlite3 CLI calls used by the Event Journal suites.
// Executes the real migrations and SQL with Node's built-in SQLite engine.
// No system-installed sqlite3 binary, subprocess, production binding, or network required.
import { DatabaseSync } from "node:sqlite";

/**
 * Execute a sqlite3-style invocation against a disposable file database.
 * The second array element is a single SQL command. Without it, run options.input
 * as a multi-statement migration/script. Query output follows the sqlite3 defaults:
 * no headers, pipe-separated columns, one row per line, NULL as an empty cell.
 */
export function execSqlite([dbPath, sql], options = {}) {
  if (typeof dbPath !== "string" || !dbPath) throw new TypeError("sqlite_database_path_required");
  const statement = sql === undefined ? options.input : sql;
  if (typeof statement !== "string") throw new TypeError("sqlite_sql_required");

  const db = new DatabaseSync(dbPath);
  try {
    let output = "";
    if (sql !== undefined && /^\s*(?:SELECT|WITH|PRAGMA|EXPLAIN)\b/i.test(statement)) {
      const rows = db.prepare(statement).all();
      if (rows.length > 0) {
        output = rows.map(row => Object.values(row).map(value =>
          value === null ? "" : String(value)
        ).join("|")).join("\n") + "\n";
      }
    } else {
      db.exec(statement);
    }
    return options.encoding === "utf8" ? output : Buffer.from(output, "utf8");
  } finally {
    db.close();
  }
}
