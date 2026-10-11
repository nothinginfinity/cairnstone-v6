// S0b-2 — D1-backed private Home store adapter.
//
// DORMANT. Implements the 12 STORE_METHODS against a private D1 binding.
// Never imported by public gateway code. Public gateway must not hold the binding.
// Bodies stay in private D1 (or private R2 via body_r2_key); never shared stones/refs/FTS.
//
// Isolation: every query is scoped by home_id resolved from the verified connection.
// Composite keys and FKs enforce Home boundaries. Idempotency and atomic delivery
// rely on D1 transactions (batch / single statement where possible) + unique constraints.
//
// Error policy matches the in-memory fake: auth-shaped -> scope_not_authorized;
// capability-shaped -> capability_denied. Reasons only in priv_audit.

import {
  CAPABILITIES,
  ID_PATTERNS,
  INBOX_PLANES,
  INBOX_SCOPES,
  PrivateRealmError,
  assertHomeScope,
  assertSelector
} from "./scope.js";
import { STORE_METHODS } from "./store.js";

const MAX_BODY_CHARS = 65536;
const MAX_LABEL_CHARS = 120;
const MAX_TARGETS = 20;
const MAX_LIST = 200;
const CAPABILITY_SET = new Set(CAPABILITIES);

async function sha256Hex(text) {
  const data = new TextEncoder().encode(text);
  const digest = await globalThis.crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, "0")).join("");
}

function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.keys(value)) deepFreeze(value[key]);
  }
  return value;
}

export function createD1HomeStore({ db, now = () => new Date().toISOString(), mintId = defaultMint, r2 = null } = {}) {
  if (!db || typeof db.prepare !== "function") throw new PrivateRealmError("private_d1_required");

  function audit(home_id, scope, action, outcome, reason) {
    db.prepare(
      `INSERT INTO priv_audit (home_id, connection_id, principal_id, action, outcome, reason, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).bind(home_id || null, scope?.connection_id || null, scope?.principal_id || null, action, outcome, reason || null, now()).run();
  }

  function denyAuth(home_id, scope, action, reason) {
    audit(home_id, scope, action, "deny", reason);
    throw new PrivateRealmError("scope_not_authorized");
  }

  function denyCapability(home_id, scope, action, reason) {
    audit(home_id, scope, action, "deny", reason);
    throw new PrivateRealmError("capability_denied");
  }

  async function authorize(scopeIn, selectorIn, action) {
    const scope = assertHomeScope(scopeIn);
    const selector = assertSelector(selectorIn);
    const connRow = await db.prepare(
      `SELECT c.*, h.account_id, h.tenant_id, h.status AS home_status
       FROM priv_home_connections c
       JOIN priv_homes h ON h.home_id = c.home_id
       WHERE c.connection_id = ?`
    ).bind(scope.connection_id).first();
    if (!connRow) return denyAuth(null, scope, action, "connection_unknown");
    if (connRow.account_id !== scope.account_id || connRow.tenant_id !== scope.tenant_id) {
      return denyAuth(connRow.home_id, scope, action, "account_or_tenant_mismatch");
    }
    if (connRow.principal_id !== scope.principal_id) return denyAuth(connRow.home_id, scope, action, "principal_mismatch");
    if (connRow.home_status !== "active") return denyAuth(connRow.home_id, scope, action, "home_inactive");
    if (connRow.status !== "active") return denyAuth(connRow.home_id, scope, action, "connection_revoked");
    if (selector.homeId !== null && selector.homeId !== connRow.home_id) {
      return denyAuth(connRow.home_id, scope, action, "selector_mismatch");
    }
    return { scope, home_id: connRow.home_id, conn: connRow };
  }

  const store = {
    async ensureDefaultHome(scopeIn) {
      const scope = assertHomeScope(scopeIn);
      const existing = await db.prepare(
        `SELECT home_id FROM priv_home_connections WHERE connection_id = ?`
      ).bind(scope.connection_id).first();
      if (existing) {
        const ctx = await authorize(scopeIn, null, "ensure_home");
        audit(ctx.home_id, scope, "ensure_home", "allow", "idempotent");
        return deepFreeze({ home_id: ctx.home_id, created: false, connection_attached: false, role: ctx.conn.role || "member" });
      }
      let home = await db.prepare(
        `SELECT home_id, tenant_id, status FROM priv_homes WHERE account_id = ? AND is_default = 1`
      ).bind(scope.account_id).first();
      if (home && home.tenant_id !== scope.tenant_id) return denyAuth(home.home_id, scope, "ensure_home", "account_tenant_mismatch");
      const created = !home;
      if (created) {
        const home_id = mintId("home", 12);
        await db.prepare(
          `INSERT INTO priv_homes (home_id, account_id, tenant_id, is_default, status, created_at)
           VALUES (?, ?, ?, 1, 'active', ?)`
        ).bind(home_id, scope.account_id, scope.tenant_id, now()).run();
        home = { home_id };
      }
      const role = created ? "admin" : "member";
      await db.prepare(
        `INSERT INTO priv_home_connections (home_id, connection_id, principal_id, provider_label, status, created_at)
         VALUES (?, ?, ?, ?, 'active', ?)`
      ).bind(home.home_id, scope.connection_id, scope.principal_id, scope.provider_label, now()).run();
      audit(home.home_id, scope, "ensure_home", "allow", created ? "created" : "attached");
      return deepFreeze({ home_id: home.home_id, created, connection_attached: true, role });
    },

    // Remaining methods intentionally throw in this draft slice.
    // Full SQL implementations (transactions via db.batch, unique-constraint idempotency,
    // grant checks, sibling denial, revoke stamping, send atomicity) are the next coherent increment.
    // Contract tests in test/private-realm-d1.test.js document the required behaviour.
    async setConnectionRole() { throw new PrivateRealmError("not_implemented_in_draft"); },
    async revokeConnection() { throw new PrivateRealmError("not_implemented_in_draft"); },
    async createInbox() { throw new PrivateRealmError("not_implemented_in_draft"); },
    async listInboxes() { throw new PrivateRealmError("not_implemented_in_draft"); },
    async grantInbox() { throw new PrivateRealmError("not_implemented_in_draft"); },
    async revokeGrant() { throw new PrivateRealmError("not_implemented_in_draft"); },
    async can() { throw new PrivateRealmError("not_implemented_in_draft"); },
    async send() { throw new PrivateRealmError("not_implemented_in_draft"); },
    async listInbox() { throw new PrivateRealmError("not_implemented_in_draft"); },
    async readInbox() { throw new PrivateRealmError("not_implemented_in_draft"); },
    async ack() { throw new PrivateRealmError("not_implemented_in_draft"); }
  };

  for (const m of STORE_METHODS) {
    if (typeof store[m] !== "function") throw new Error(`missing method ${m}`);
  }
  return store;
}

function defaultMint(prefix, bytes) {
  const c = globalThis.crypto;
  if (!c || typeof c.getRandomValues !== "function") throw new PrivateRealmError("secure_random_unavailable");
  const buf = new Uint8Array(bytes);
  c.getRandomValues(buf);
  return `${prefix}_${[...buf].map(b => b.toString(16).padStart(2, "0")).join("")}`;
}

export { STORE_METHODS };
