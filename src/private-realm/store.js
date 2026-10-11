// Private realm Home store (S0b-1).
// Interface + in-memory fake. No production D1/R2 binding.
// Every call is scoped by an authenticated HomeScope derived server-side.
// Private bodies never leave this store into public Stones/search.

const ID = {
  home: /^home_[A-Za-z0-9_-]{8,70}$/,
  acct: /^acct_[A-Za-z0-9_-]{4,60}$/,
  ten: /^ten_[A-Za-z0-9_-]{4,60}$/,
  conn: /^conn_[A-Za-z0-9_-]{4,60}$/,
  prin: /^prin_[A-Za-z0-9_-]{4,60}$/,
  ibx: /^ibx_[A-Za-z0-9_-]{4,70}$/,
};

export function assertHomeScope(scope) {
  if (!scope || typeof scope !== "object") throw new Error("home_scope_required");
  for (const [k, re] of [["account_id", ID.acct], ["tenant_id", ID.ten], ["principal_id", ID.prin], ["connection_id", ID.conn]]) {
    if (!re.test(scope[k] || "")) throw new Error(`invalid_${k}`);
  }
  if (scope.home_id != null && !ID.home.test(scope.home_id)) throw new Error("invalid_home_id");
  return Object.freeze({
    account_id: scope.account_id,
    tenant_id: scope.tenant_id,
    principal_id: scope.principal_id,
    connection_id: scope.connection_id,
    home_id: scope.home_id || null,
    provider_label: scope.provider_label || "unspecified",
  });
}

export function createInMemoryHomeStore() {
  const homes = new Map(); // home_id -> home
  const byAccount = new Map(); // account_id -> home_id (default)
  const connections = new Map(); // connection_id -> connection
  const inboxes = new Map(); // `${home}:${ibx}` -> inbox
  const grants = new Map(); // `${home}:${ibx}:${conn}` -> grant
  const messages = new Map();
  const deliveries = new Map();
  const audit = [];

  function auditPush(home_id, connection_id, principal_id, action, outcome, reason) {
    audit.push({ home_id, connection_id, principal_id, action, outcome, reason: reason || null, created_at: new Date().toISOString() });
  }

  function requireActiveConnection(scope, home) {
    const conn = connections.get(scope.connection_id);
    if (!conn || conn.home_id !== home.home_id || conn.status !== "active" || conn.principal_id !== scope.principal_id) {
      auditPush(home.home_id, scope.connection_id, scope.principal_id, "access", "deny", "connection_inactive_or_mismatch");
      throw new Error("connection_inactive_or_mismatch");
    }
    return conn;
  }

  function getGrant(home_id, inbox_id, connection_id) {
    const g = grants.get(`${home_id}:${inbox_id}:${connection_id}`);
    if (!g || g.revoked_at) return null;
    return g;
  }

  return {
    // Idempotent: returns existing default Home for the account, or creates one.
    async ensureDefaultHome(scopeIn) {
      const scope = assertHomeScope(scopeIn);
      let home_id = byAccount.get(scope.account_id);
      if (home_id) {
        const existing = homes.get(home_id);
        if (existing && existing.account_id === scope.account_id && existing.tenant_id === scope.tenant_id) {
          auditPush(home_id, scope.connection_id, scope.principal_id, "ensure_home", "allow", "idempotent");
          return { home_id, created: false };
        }
      }
      home_id = `home_${cryptoRandom(12)}`;
      const home = {
        home_id,
        account_id: scope.account_id,
        tenant_id: scope.tenant_id,
        is_default: 1,
        status: "active",
        created_at: new Date().toISOString(),
      };
      homes.set(home_id, home);
      byAccount.set(scope.account_id, home_id);
      auditPush(home_id, scope.connection_id, scope.principal_id, "ensure_home", "allow", "created");
      return { home_id, created: true };
    },

    async attachConnection(scopeIn, home_id) {
      const scope = assertHomeScope({ ...scopeIn, home_id });
      const home = homes.get(home_id);
      if (!home || home.account_id !== scope.account_id || home.tenant_id !== scope.tenant_id || home.status !== "active") {
        auditPush(home_id, scope.connection_id, scope.principal_id, "attach", "deny", "home_mismatch");
        throw new Error("home_mismatch");
      }
      if (connections.has(scope.connection_id)) {
        const c = connections.get(scope.connection_id);
        if (c.home_id !== home_id || c.principal_id !== scope.principal_id) throw new Error("connection_conflict");
        return { connection_id: scope.connection_id, attached: false };
      }
      connections.set(scope.connection_id, {
        home_id,
        connection_id: scope.connection_id,
        principal_id: scope.principal_id,
        provider_label: scope.provider_label,
        status: "active",
        created_at: new Date().toISOString(),
        revoked_at: null,
      });
      return { connection_id: scope.connection_id, attached: true };
    },

    async revokeConnection(scopeIn, home_id) {
      const scope = assertHomeScope({ ...scopeIn, home_id });
      const conn = connections.get(scope.connection_id);
      if (!conn || conn.home_id !== home_id) throw new Error("connection_not_found");
      conn.status = "revoked";
      conn.revoked_at = new Date().toISOString();
      auditPush(home_id, scope.connection_id, scope.principal_id, "revoke_connection", "allow", "revoked");
      return { revoked: true };
    },

    async createInbox(scopeIn, home_id, { scope: inboxScope, plane = "chat", label = "" } = {}) {
      const scope = assertHomeScope({ ...scopeIn, home_id });
      const home = homes.get(home_id);
      requireActiveConnection(scope, home);
      if (!ID.ibx.test(arguments[2]?.inbox_id || "") && arguments[2]?.inbox_id) throw new Error("invalid_inbox_id");
      const inbox_id = arguments[2]?.inbox_id || `ibx_${cryptoRandom(10)}`;
      const key = `${home_id}:${inbox_id}`;
      if (inboxes.has(key)) return { inbox_id, created: false };
      const owner = inboxScope === "connection" ? scope.connection_id : null;
      if (inboxScope === "connection" && !owner) throw new Error("connection_scope_requires_owner");
      if (inboxScope !== "connection" && owner) throw new Error("non_connection_scope_must_not_name_owner");
      inboxes.set(key, {
        home_id,
        inbox_id,
        scope: inboxScope,
        plane,
        owner_connection_id: owner,
        label,
        status: "active",
        created_at: new Date().toISOString(),
      });
      // Owner of a connection-private inbox gets implicit full grant; home-owned starts with none.
      if (inboxScope === "connection") {
        grants.set(`${home_id}:${inbox_id}:${scope.connection_id}`, {
          can_read: 1, can_send: 1, can_ack: 1, granted_at: new Date().toISOString(), revoked_at: null,
        });
      }
      return { inbox_id, created: true };
    },

    // Grant. Connection-private inboxes deny sibling grants by default.
    async grant(scopeIn, home_id, inbox_id, target_connection_id, caps) {
      const scope = assertHomeScope({ ...scopeIn, home_id });
      const home = homes.get(home_id);
      requireActiveConnection(scope, home);
      const inbox = inboxes.get(`${home_id}:${inbox_id}`);
      if (!inbox) throw new Error("inbox_not_found");
      if (inbox.scope === "connection" && target_connection_id !== inbox.owner_connection_id) {
        auditPush(home_id, scope.connection_id, scope.principal_id, "grant", "deny", "connection_private_sibling_denied");
        throw new Error("connection_private_sibling_denied");
      }
      const target = connections.get(target_connection_id);
      if (!target || target.home_id !== home_id) throw new Error("target_connection_not_in_home");
      const gkey = `${home_id}:${inbox_id}:${target_connection_id}`;
      grants.set(gkey, {
        can_read: caps.can_read ? 1 : 0,
        can_send: caps.can_send ? 1 : 0,
        can_ack: caps.can_ack ? 1 : 0,
        granted_at: new Date().toISOString(),
        revoked_at: null,
      });
      return { granted: true };
    },

    async can(scopeIn, home_id, inbox_id, capability) {
      const scope = assertHomeScope({ ...scopeIn, home_id });
      const home = homes.get(home_id);
      if (!home || home.status !== "active" || home.account_id !== scope.account_id) {
        auditPush(home_id, scope.connection_id, scope.principal_id, capability, "deny", "home_inactive_or_mismatch");
        return false;
      }
      try { requireActiveConnection(scope, home); } catch { return false; }
      const inbox = inboxes.get(`${home_id}:${inbox_id}`);
      if (!inbox || inbox.status !== "active") return false;
      // Connection-private: only the owner connection may hold a grant.
      if (inbox.scope === "connection" && scope.connection_id !== inbox.owner_connection_id) {
        auditPush(home_id, scope.connection_id, scope.principal_id, capability, "deny", "connection_private_sibling_denied");
        return false;
      }
      const g = getGrant(home_id, inbox_id, scope.connection_id);
      if (!g) {
        auditPush(home_id, scope.connection_id, scope.principal_id, capability, "deny", "no_grant");
        return false;
      }
      const ok = !!g[capability];
      auditPush(home_id, scope.connection_id, scope.principal_id, capability, ok ? "allow" : "deny", ok ? null : "capability_denied");
      return ok;
    },

    // Test helpers only. Not part of the production interface.
    _dump() { return { homes: [...homes.values()], connections: [...connections.values()], inboxes: [...inboxes.values()], grants: [...grants.entries()], audit }; },
  };
}

export function resolveHomeStore(env, scopeIn) {
  // Production path is intentionally closed. No private binding is consulted.
  // Tests inject an in-memory store; live code must not reach private storage yet.
  if (env && env.__PRIVATE_HOME_STORE_TEST__) return env.__PRIVATE_HOME_STORE_TEST__;
  throw new Error("private_home_store_not_bound");
}

function cryptoRandom(n) {
  const bytes = new Uint8Array(n);
  if (typeof crypto !== "undefined" && crypto.getRandomValues) crypto.getRandomValues(bytes);
  else for (let i = 0; i < n; i++) bytes[i] = Math.floor(Math.random() * 256);
  return [...bytes].map(b => b.toString(16).padStart(2, "0")).join("").slice(0, n);
}
