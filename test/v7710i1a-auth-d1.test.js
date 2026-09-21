// V7.7.10i.1a — Dedicated Auth D1 wiring + migration stream isolation.
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import {
  authDb,
  resolveEnforcementMode,
  shouldAdmitCanaryOnMint
} from "../src/core-auth.js";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

function readToml() {
  return readFileSync(join(ROOT, "wrangler.toml"), "utf8");
}

function parseD1Bindings(toml) {
  const blocks = toml.split(/\[\[d1_databases\]\]/).slice(1);
  return blocks.map((block) => {
    const get = (key) => {
      const m = block.match(new RegExp(`^${key}\\s*=\\s*"([^"]+)"`, "m"));
      return m ? m[1] : null;
    };
    return {
      binding: get("binding"),
      database_name: get("database_name"),
      database_id: get("database_id"),
      migrations_dir: get("migrations_dir")
    };
  });
}

function wranglerLocal(args, { cwd = ROOT, persistTo } = {}) {
  const full = ["wrangler", ...args, "--config", "wrangler.toml"];
  if (persistTo) full.push("--persist-to", persistTo);
  return execFileSync("npx", full, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, CI: "1", WRANGLER_SEND_METRICS: "false" },
    stdio: ["ignore", "pipe", "pipe"]
  });
}

test("authDb prefers CAIRNSTONE_AUTH_DB over shared CAIRNSTONE_DB", () => {
  const auth = { tag: "auth" };
  const shared = { tag: "shared" };
  const preferred = authDb({ CAIRNSTONE_AUTH_DB: auth, CAIRNSTONE_DB: shared });
  assert.equal(preferred.ok, true);
  assert.equal(preferred.binding, "CAIRNSTONE_AUTH_DB");
  assert.equal(preferred.db, auth);

  const fallback = authDb({ CAIRNSTONE_DB: shared });
  assert.equal(fallback.ok, true);
  assert.equal(fallback.binding, "CAIRNSTONE_DB");
  assert.equal(fallback.db, shared);

  const missing = authDb({});
  assert.equal(missing.ok, false);
  assert.equal(missing.error, "missing_auth_d1_binding");
});

test("production-style wrangler.toml binds CAIRNSTONE_AUTH_DB with auth migrations_dir", () => {
  const bindings = parseD1Bindings(readToml());
  const shared = bindings.find((b) => b.binding === "CAIRNSTONE_DB");
  const auth = bindings.find((b) => b.binding === "CAIRNSTONE_AUTH_DB");
  assert.ok(shared, "CAIRNSTONE_DB binding required");
  assert.ok(auth, "CAIRNSTONE_AUTH_DB binding required");
  assert.equal(shared.database_name, "cairnstone-v6");
  assert.equal(shared.migrations_dir, "migrations");
  assert.equal(auth.database_name, "cairnstone-v6-auth");
  assert.equal(auth.migrations_dir, "migrations/auth");
  assert.notEqual(auth.database_id, shared.database_id);
  // Pre-provision: PLACEHOLDER_*; post-provision: a real D1 UUID. Never the shared id (asserted above).
  assert.match(auth.database_id, /^(PLACEHOLDER_[A-Za-z0-9_-]+|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/);
});

test("shared migration stream retired 0024; auth schema lives under migrations/auth only", () => {
  assert.equal(existsSync(join(ROOT, "migrations/0024_v7710i1_core_auth.sql")), false);
  const sharedSql = readdirSync(join(ROOT, "migrations")).filter((n) => n.endsWith(".sql"));
  assert.ok(
    !sharedSql.some((n) => /^0024_/.test(n) || /v7710i1_core_auth/i.test(n)),
    `shared stream still has auth file: ${sharedSql.join(",")}`
  );
  for (const name of sharedSql) {
    const body = readFileSync(join(ROOT, "migrations", name), "utf8");
    assert.equal(/\bCREATE TABLE IF NOT EXISTS auth_/i.test(body), false, `${name} must not create auth_*`);
  }
  const authMig = join(ROOT, "migrations/auth/0001_v7710i1_core_auth.sql");
  assert.equal(existsSync(authMig), true);
  const authBody = readFileSync(authMig, "utf8");
  assert.match(authBody, /CREATE TABLE IF NOT EXISTS auth_accounts/);
  assert.match(authBody, /CREATE TABLE IF NOT EXISTS auth_canary_admissions/);
});

test("shared wrangler migration list cannot see auth migration; auth list cannot see shared", () => {
  const sharedOut = wranglerLocal(["d1", "migrations", "list", "CAIRNSTONE_DB", "--local"]);
  const authOut = wranglerLocal(["d1", "migrations", "list", "CAIRNSTONE_AUTH_DB", "--local"]);
  assert.equal(/0001_v7710i1_core_auth\.sql/.test(sharedOut), false);
  assert.equal(/0024_v7710i1_core_auth\.sql/.test(sharedOut), false);
  assert.match(authOut, /0001_v7710i1_core_auth\.sql/);
  assert.equal(/0012_v7_7_5a_shared_agent_workspace\.sql/.test(authOut), false);
  assert.equal(/0001_init\.sql/.test(authOut), false);
});

test("auth migration applies idempotently on dedicated local Auth D1", () => {
  const persistTo = mkdtempSync(join(tmpdir(), "cs-auth-d1-"));
  try {
    const first = wranglerLocal(
      ["d1", "migrations", "apply", "CAIRNSTONE_AUTH_DB", "--local"],
      { persistTo }
    );
    assert.match(first, /0001_v7710i1_core_auth\.sql/);
    const second = wranglerLocal(
      ["d1", "migrations", "apply", "CAIRNSTONE_AUTH_DB", "--local"],
      { persistTo }
    );
    assert.match(second, /No migrations to apply/i);

    const authProbe = wranglerLocal(
      [
        "d1",
        "execute",
        "CAIRNSTONE_AUTH_DB",
        "--local",
        "--command",
        "SELECT name FROM sqlite_master WHERE type='table' AND name='auth_accounts'"
      ],
      { persistTo }
    );
    assert.match(authProbe, /auth_accounts/);

    // Shared DB with only shared migrations applied must not grow auth_* tables.
    // Prove via migration list isolation + schema file scan (above); additionally
    // confirm applying auth migration is impossible against CAIRNSTONE_DB stream.
    const sharedList = wranglerLocal(["d1", "migrations", "list", "CAIRNSTONE_DB", "--local"]);
    assert.equal(/auth_accounts|0001_v7710i1_core_auth/.test(sharedList), false);
  } finally {
    rmSync(persistTo, { recursive: true, force: true });
  }
});

test("CORE_AUTH_ENFORCEMENT defaults off; canary auto-admit defaults off", () => {
  assert.equal(resolveEnforcementMode({}), "off");
  assert.equal(resolveEnforcementMode({ CORE_AUTH_ENFORCEMENT: "" }), "off");
  assert.equal(resolveEnforcementMode({ CORE_AUTH_ENFORCEMENT: "off" }), "off");
  assert.equal(
    shouldAdmitCanaryOnMint({}, { connectionId: "conn_x", clientFamily: "perplexity", label: "x" }),
    false
  );
  assert.equal(
    shouldAdmitCanaryOnMint(
      { CORE_AUTH_CANARY_AUTO_ADMIT: "false" },
      { connectionId: "conn_x", clientFamily: "perplexity", label: "x" }
    ),
    false
  );
});

test("production wrangler activates shadow only; canary admission remains opt-in", () => {
  const toml = readToml();
  assert.match(toml, /^CORE_AUTH_ENFORCEMENT\s*=\s*"shadow"$/m);
  assert.equal(/^CORE_AUTH_CANARY_AUTO_ADMIT\s*=/m.test(toml), false);
  assert.equal(/^CORE_AUTH_CANARY_CONNECTIONS\s*=/m.test(toml), false);
});

test("deploy workflow wires apply_auth_migrations default false and fail-closed gate", () => {
  const yml = readFileSync(join(ROOT, ".github/workflows/deploy-cloudflare.yml"), "utf8");
  assert.match(yml, /apply_auth_migrations:/);
  assert.match(yml, /apply_auth_migrations == 'true'/);
  assert.match(yml, /CAIRNSTONE_AUTH_DB/);
  assert.match(yml, /PLACEHOLDER_/);
  // Defaults remain false for both migration gates.
  const applyShared = yml.match(/apply_migrations:[\s\S]*?default:\s*"false"/);
  const applyAuth = yml.match(/apply_auth_migrations:[\s\S]*?default:\s*"false"/);
  assert.ok(applyShared, "apply_migrations must default false");
  assert.ok(applyAuth, "apply_auth_migrations must default false");
});
