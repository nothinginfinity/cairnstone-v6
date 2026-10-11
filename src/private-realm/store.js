// S0b-1 — Private-realm Home store: interface + in-memory fake.
//
// DORMANT. No D1/R2 binding, no migration, no route, no import from legacy code.
// Authority comes ONLY from a server-verified HomeScope (see scope.js). Home, inbox and
// message ids passed by callers are selectors that must match; they never grant access.
//
// Isolation is structural: every inbox, grant, message and delivery lives inside its own
// Home's state object, mirroring the composite (home_id, id) keys of
// docs/private-realm/schema.sql.draft. Cross-Home references cannot be expressed.
//
// Error policy: authentication-shaped failures (unknown/mismatched/revoked connection,
// selector mismatch) all throw `scope_not_authorized`; capability failures all throw
// `capability_denied`. Precise reasons go to the audit log only, so a caller cannot probe
// which Homes, inboxes or connections exist. The gateway must collapse both to one 403.
//
// Private message bodies exist only inside this store. Audit rows carry ids and reason
// codes, never bodies or secrets.

import {
  CAPABILITIES,
  ID_PATTERNS,
  INBOX_PLANES,
  INBOX_SCOPES,
  PrivateRealmError,
  assertHomeScope,
  assertSelector
} from "./scope.js";

const MAX_BODY_CHARS = 65536;
const MAX_LABEL_CHARS = 120;
const MAX_TARGETS = 20;
const MAX_LIST = 200;
const CAPABILITY_SET = new Set(CAPABILITIES);

export const STORE_METHODS = Object.freeze([
  "ensureDefaultHome",
  "resolveHome",
  "setConnectionRole",
  "revokeConnection",
  "createInbox",
  "listInboxes",
  "grantInbox",
  "revokeGrant",
  "can",
  "send",
  "listInbox",
  "readInbox",
  "ack"
]);

function defaultMint(prefix, bytes) {
  const c = globalThis.crypto;
  if (!c || typeof c.getRandomValues !== "function") throw new PrivateRealmError("secure_random_unavailable");
  const buf = new Uint8Array(bytes);
  c.getRandomValues(buf);
  return `${prefix}_${[...buf].map(b => b.toString(16).padStart(2, "0")).join("")}`;
}

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

export function createInMemoryHomeStore({ now = () => new Date().toISOString(), mintId = defaultMint, testHooks = false } = {}) {
  const homes = new Map(); // home_id -> HomeState
  const accountIndex = new Map(); // account_id -> default home_id
  const connectionIndex = new Map(); // connection_id -> home_id (UNIQUE across all Homes)
  const auditLog = [];

  function audit(home_id, scope, action, outcome, reason) {
    auditLog.push(Object.freeze({
      home_id: home_id || null,
      connection_id: scope ? scope.connection_id : null,
      principal_id: scope ? scope.principal_id : null,
      action,
      outcome,
      reason: reason || null,
      created_at: now()
    }));
  }

  function denyAuth(home_id, scope, action, reason) {
    audit(home_id, scope, action, "deny", reason);
    throw new PrivateRealmError("scope_not_authorized");
  }

  function denyCapability(home_id, scope, action, reason) {
    audit(home_id, scope, action, "deny", reason);
    throw new PrivateRealmError("capability_denied");
  }

  // Resolve Home + active connection from the verified scope. Never from a caller home id.
  function authorize(scopeIn, selectorIn, action) {
    const scope = assertHomeScope(scopeIn);
    const selector = assertSelector(selectorIn);
    const home_id = connectionIndex.get(scope.connection_id);
    if (!home_id) return denyAuth(null, scope, action, "connection_unknown");
    const home = homes.get(home_id);
    const conn = home.connections.get(scope.connection_id);
    if (home.account_id !== scope.account_id || home.tenant_id !== scope.tenant_id) {
      return denyAuth(home_id, scope, action, "account_or_tenant_mismatch");
    }
    if (conn.principal_id !== scope.principal_id) return denyAuth(home_id, scope, action, "principal_mismatch");
    if (home.status !== "active") return denyAuth(home_id, scope, action, "home_inactive");
    if (conn.status !== "active") return denyAuth(home_id, scope, action, "connection_revoked");
    if (selector.homeId !== null && selector.homeId !== home_id) return denyAuth(home_id, scope, action, "selector_mismatch");
    return { scope, home, conn };
  }

  function requireAdmin(ctx, action) {
    if (ctx.conn.role !== "admin") return denyCapability(ctx.home.home_id, ctx.scope, action, "admin_required");
  }

  function activeAdminCount(home) {
    let n = 0;
    for (const c of home.connections.values()) if (c.status === "active" && c.role === "admin") n += 1;
    return n;
  }

  // Effective permission: active connection (checked by authorize) + live, non-revoked grant.
  // Private-by-connection inboxes are never reachable by any connection but their owner.
  function checkCapability(ctx, inbox_id, capability, action) {
    const { home, scope, conn } = ctx;
    if (typeof capability !== "string" || !CAPABILITY_SET.has(capability)) {
      return denyCapability(home.home_id, scope, action, "unknown_capability");
    }
    if (typeof inbox_id !== "string" || !ID_PATTERNS.ibx.test(inbox_id)) {
      return denyCapability(home.home_id, scope, action, "invalid_inbox_id");
    }
    const inbox = home.inboxes.get(inbox_id);
    if (!inbox || inbox.status !== "active") return denyCapability(home.home_id, scope, action, "inbox_unavailable");
    if (inbox.scope === "connection" && inbox.owner_connection_id !== conn.connection_id) {
      return denyCapability(home.home_id, scope, action, "connection_private_sibling_denied");
    }
    const grant = home.grants.get(`${inbox_id}|${conn.connection_id}`);
    if (!grant || grant.revoked_at || grant[capability] !== 1) {
      return denyCapability(home.home_id, scope, action, grant && !grant.revoked_at ? "capability_not_granted" : "no_grant");
    }
    return inbox;
  }

  function newHome(scope) {
    const home_id = mintId("home", 12);
    const home = {
      home_id,
      account_id: scope.account_id,
      tenant_id: scope.tenant_id,
      is_default: 1,
      status: "active",
      created_at: now(),
      connections: new Map(),
      inboxes: new Map(),
      grants: new Map(), // `${inbox_id}|${connection_id}` -> grant
      messages: new Map(), // message_id -> immutable message
      deliveries: new Map() // `${message_id}|${inbox_id}` -> delivery
    };
    homes.set(home_id, home);
    accountIndex.set(scope.account_id, home_id);
    return home;
  }

  const store = {
    // Idempotent connect-time bridge: account -> its one default Home, and this connection
    // -> that Home. A new provider connection joins the EXISTING Home (portability); it never
    // gets a new Home and never inherits another connection's private inboxes or grants.
    async ensureDefaultHome(scopeIn) {
      const scope = assertHomeScope(scopeIn);
      const known = connectionIndex.get(scope.connection_id);
      if (known) {
        const home = homes.get(known);
        const conn = home.connections.get(scope.connection_id);
        if (home.account_id !== scope.account_id || home.tenant_id !== scope.tenant_id || conn.principal_id !== scope.principal_id) {
          return denyAuth(known, scope, "ensure_home", "connection_conflict");
        }
        if (conn.status !== "active") return denyAuth(known, scope, "ensure_home", "connection_revoked");
        audit(known, scope, "ensure_home", "allow", "idempotent");
        return deepFreeze({ home_id: known, created: false, connection_attached: false, role: conn.role });
      }
      let home = null;
      const existingId = accountIndex.get(scope.account_id);
      if (existingId) {
        home = homes.get(existingId);
        if (home.tenant_id !== scope.tenant_id) return denyAuth(existingId, scope, "ensure_home", "account_tenant_mismatch");
        if (home.status !== "active") return denyAuth(existingId, scope, "ensure_home", "home_inactive");
        for (const c of home.connections.values()) {
          if (c.principal_id === scope.principal_id) return denyAuth(existingId, scope, "ensure_home", "principal_conflict");
        }
      }
      const created = !home;
      if (created) home = newHome(scope);
      // Admin is honoured only for the Home's first connection, or when no active admin remains
      // (owner-approved recovery consent). Otherwise the connection joins as a plain member.
      const wantsAdmin = scope.home_role === "admin";
      const role = created || (wantsAdmin && activeAdminCount(home) === 0) ? "admin" : "member";
      const reason = wantsAdmin && role !== "admin" ? "role_downgraded_to_member" : created ? "created" : "attached";
      home.connections.set(scope.connection_id, {
        connection_id: scope.connection_id,
        principal_id: scope.principal_id,
        provider_label: scope.provider_label,
        role,
        status: "active",
        created_at: now(),
        revoked_at: null
      });
      connectionIndex.set(scope.connection_id, home.home_id);
      audit(home.home_id, scope, "ensure_home", "allow", reason);
      return deepFreeze({ home_id: home.home_id, created, connection_attached: true, role });
    },

    async setConnectionRole(scopeIn, targetConnectionId, role, selector) {
      const ctx = authorize(scopeIn, selector, "set_role");
      requireAdmin(ctx, "set_role");
      if (role !== "admin" && role !== "member") throw new PrivateRealmError("invalid_home_role");
      const target = ctx.home.connections.get(targetConnectionId);
      if (typeof targetConnectionId !== "string" || !target || target.status !== "active") {
        return denyCapability(ctx.home.home_id, ctx.scope, "set_role", "target_not_active_in_home");
      }
      if (target.role === "admin" && role === "member" && activeAdminCount(ctx.home) <= 1) {
        return denyCapability(ctx.home.home_id, ctx.scope, "set_role", "last_admin_protected");
      }
      target.role = role;
      audit(ctx.home.home_id, ctx.scope, "set_role", "allow", `role_${role}`);
      return deepFreeze({ connection_id: targetConnectionId, role });
    },

    // A connection may revoke itself; an admin may revoke any connection of the same Home.
    // Revocation retains rows (history) but removes effective permission everywhere and
    // cannot be undone by re-attaching the same connection id.
    async revokeConnection(scopeIn, targetConnectionId, selector) {
      const ctx = authorize(scopeIn, selector, "revoke_connection");
      const targetId = targetConnectionId === undefined ? ctx.conn.connection_id : targetConnectionId;
      if (typeof targetId !== "string") throw new PrivateRealmError("invalid_connection_id");
      if (targetId !== ctx.conn.connection_id) requireAdmin(ctx, "revoke_connection");
      const target = ctx.home.connections.get(targetId);
      if (!target) return denyCapability(ctx.home.home_id, ctx.scope, "revoke_connection", "target_not_in_home");
      if (target.status === "revoked") {
        audit(ctx.home.home_id, ctx.scope, "revoke_connection", "allow", "already_revoked");
        return deepFreeze({ connection_id: targetId, revoked: true, changed: false });
      }
      const stamp = now();
      target.status = "revoked";
      target.revoked_at = stamp;
      for (const [key, grant] of ctx.home.grants) {
        if (key.endsWith(`|${targetId}`) && !grant.revoked_at) grant.revoked_at = stamp;
      }
      audit(ctx.home.home_id, ctx.scope, "revoke_connection", "allow", "revoked");
      return deepFreeze({ connection_id: targetId, revoked: true, changed: true });
    },

    // `scope: "connection"` inboxes belong to the calling connection alone and can never be
    // granted to a sibling. Home-owned (`home`, `agent_identity`) inboxes are admin-created and
    // shared only by explicit grant. Creating an inbox grants the admin nothing by itself.
    async createInbox(scopeIn, opts = {}, selector) {
      const ctx = authorize(scopeIn, selector, "create_inbox");
      const { scope: inboxScope, plane = "chat", label = "", inboxId, grantToCreator = false } = opts || {};
      if (!INBOX_SCOPES.includes(inboxScope)) throw new PrivateRealmError("invalid_inbox_scope");
      if (typeof grantToCreator !== "boolean" || (grantToCreator && inboxScope === "connection")) throw new PrivateRealmError("invalid_options");
      if (!INBOX_PLANES.includes(plane)) throw new PrivateRealmError("invalid_plane");
      if (typeof label !== "string" || label.length > MAX_LABEL_CHARS) throw new PrivateRealmError("invalid_label");
      if (inboxId !== undefined && (typeof inboxId !== "string" || !ID_PATTERNS.ibx.test(inboxId))) {
        throw new PrivateRealmError("invalid_inbox_id");
      }
      if (inboxScope !== "connection") requireAdmin(ctx, "create_inbox");
      const inbox_id = inboxId || mintId("ibx", 10);
      const owner = inboxScope === "connection" ? ctx.conn.connection_id : null;
      const existing = ctx.home.inboxes.get(inbox_id);
      if (existing) {
        if (existing.scope !== inboxScope || existing.plane !== plane || existing.owner_connection_id !== owner) {
          return denyCapability(ctx.home.home_id, ctx.scope, "create_inbox", "inbox_conflict");
        }
        audit(ctx.home.home_id, ctx.scope, "create_inbox", "allow", "idempotent");
        return deepFreeze({ inbox_id, created: false });
      }
      ctx.home.inboxes.set(inbox_id, {
        inbox_id,
        scope: inboxScope,
        plane,
        owner_connection_id: owner,
        label,
        status: "active",
        created_at: now()
      });
      if (owner || grantToCreator) {
        ctx.home.grants.set(`${inbox_id}|${owner || ctx.conn.connection_id}`, { read: 1, send: 1, ack: 1, granted_at: now(), revoked_at: null });
      }
      audit(ctx.home.home_id, ctx.scope, "create_inbox", "allow", "created");
      return deepFreeze({ inbox_id, created: true });
    },

    // Authorized, audited, non-provisioning Home lookup.
    async resolveHome(scopeIn, selector) {
      const ctx = authorize(scopeIn, selector, "resolve_home");
      audit(ctx.home.home_id, ctx.scope, "resolve_home", "allow", null);
      return deepFreeze({ home_id: ctx.home.home_id, role: ctx.conn.role });
    },

    // Discovery is least-privilege: a connection sees only inboxes it holds a live grant on
    // (including its own private ones). Admins additionally see home-owned inbox metadata.
    // Nobody ever sees a sibling's connection-private inbox.
    async listInboxes(scopeIn, selector) {
      const ctx = authorize(scopeIn, selector, "list_inboxes");
      const out = [];
      for (const inbox of ctx.home.inboxes.values()) {
        if (inbox.status !== "active") continue;
        if (inbox.scope === "connection" && inbox.owner_connection_id !== ctx.conn.connection_id) continue;
        const grant = ctx.home.grants.get(`${inbox.inbox_id}|${ctx.conn.connection_id}`);
        const granted = !!grant && !grant.revoked_at;
        if (!granted && !(ctx.conn.role === "admin" && inbox.scope !== "connection")) continue;
        out.push({ inbox_id: inbox.inbox_id, scope: inbox.scope, plane: inbox.plane, label: inbox.label, granted });
      }
      audit(ctx.home.home_id, ctx.scope, "list_inboxes", "allow", null);
      return deepFreeze(out);
    },

    async grantInbox(scopeIn, opts = {}, selector) {
      const ctx = authorize(scopeIn, selector, "grant");
      requireAdmin(ctx, "grant");
      const { inboxId, targetConnectionId, caps } = opts || {};
      const inbox = typeof inboxId === "string" ? ctx.home.inboxes.get(inboxId) : null;
      if (!inbox || inbox.status !== "active") return denyCapability(ctx.home.home_id, ctx.scope, "grant", "inbox_unavailable");
      if (inbox.scope === "connection") {
        return denyCapability(ctx.home.home_id, ctx.scope, "grant", "connection_private_sibling_denied");
      }
      const target = typeof targetConnectionId === "string" ? ctx.home.connections.get(targetConnectionId) : null;
      if (!target || target.status !== "active") {
        return denyCapability(ctx.home.home_id, ctx.scope, "grant", "target_not_active_in_home");
      }
      if (!caps || typeof caps !== "object" || Array.isArray(caps)) throw new PrivateRealmError("invalid_caps");
      const next = { read: 0, send: 0, ack: 0, granted_at: now(), revoked_at: null };
      for (const key of Object.keys(caps)) {
        if (!CAPABILITY_SET.has(key)) throw new PrivateRealmError("invalid_caps");
        next[key] = caps[key] === true || caps[key] === 1 ? 1 : 0;
      }
      if (!next.read && !next.send && !next.ack) throw new PrivateRealmError("invalid_caps");
      ctx.home.grants.set(`${inboxId}|${targetConnectionId}`, next);
      audit(ctx.home.home_id, ctx.scope, "grant", "allow", "granted");
      return deepFreeze({ granted: true });
    },

    async revokeGrant(scopeIn, opts = {}, selector) {
      const ctx = authorize(scopeIn, selector, "revoke_grant");
      requireAdmin(ctx, "revoke_grant");
      const { inboxId, targetConnectionId } = opts || {};
      const inbox = typeof inboxId === "string" ? ctx.home.inboxes.get(inboxId) : null;
      if (!inbox) return denyCapability(ctx.home.home_id, ctx.scope, "revoke_grant", "inbox_unavailable");
      // The owner's implicit grant on a connection-private inbox is not an admin-revocable grant.
      if (inbox.scope === "connection") return denyCapability(ctx.home.home_id, ctx.scope, "revoke_grant", "connection_private_sibling_denied");
      const grant = ctx.home.grants.get(`${inboxId}|${targetConnectionId}`);
      if (!grant || grant.revoked_at) {
        audit(ctx.home.home_id, ctx.scope, "revoke_grant", "allow", "already_absent");
        return deepFreeze({ revoked: true, changed: false });
      }
      grant.revoked_at = now();
      audit(ctx.home.home_id, ctx.scope, "revoke_grant", "allow", "revoked");
      return deepFreeze({ revoked: true, changed: true });
    },

    // Boolean probe. Authentication-shaped failures and unknown capabilities are `false`,
    // identical to a plain "no grant", and never throw for authorization reasons.
    async can(scopeIn, inboxId, capability, selector) {
      const label = `can_${typeof capability === "string" && CAPABILITY_SET.has(capability) ? capability : "invalid"}`;
      try {
        const ctx = authorize(scopeIn, selector, label);
        checkCapability(ctx, inboxId, capability, label);
        return true;
      } catch (error) {
        if (error instanceof PrivateRealmError && (error.code === "scope_not_authorized" || error.code === "capability_denied")) return false;
        throw error;
      }
    },

    // Deliver one immutable message to one or more inboxes in the caller's Home. The caller needs
    // `send` on its sender inbox AND on every target inbox. Idempotent per message_id.
    //
    // Atomicity: the digests are the only asynchronous work, and they are pure (they read and write
    // no store state). Every authoritative decision (authorization, capabilities, the idempotency
    // lookup) and every write (message, deliveries, audit) happens in ONE synchronous section after
    // the digests, so no concurrent send, grant change or revocation can interleave with it. A
    // revocation or grant change that lands while the digests are pending is therefore honoured, and
    // two same-id sends can never both pass the idempotency lookup. The early check below only
    // avoids hashing for callers who are already unauthorized; it is never the authority.
    async send(scopeIn, opts = {}, selectorIn) {
      // Freeze identity and request once, so a caller mutating its objects mid-flight cannot change
      // what is committed relative to what was authorized.
      const scope = assertHomeScope(scopeIn);
      const selector = assertSelector(selectorIn);
      const { fromInboxId, toInboxIds, messageId, threadId, body } = opts || {};
      const early = authorize(scope, selector, "send");
      if (typeof messageId !== "string" || !ID_PATTERNS.message.test(messageId)) throw new PrivateRealmError("invalid_message_id");
      const thread = threadId === undefined ? messageId : threadId;
      if (typeof thread !== "string" || !ID_PATTERNS.thread.test(thread)) throw new PrivateRealmError("invalid_thread_id");
      if (typeof body !== "string" || body.length === 0 || body.length > MAX_BODY_CHARS) throw new PrivateRealmError("invalid_body");
      if (!Array.isArray(toInboxIds) || toInboxIds.length === 0 || toInboxIds.length > MAX_TARGETS) {
        throw new PrivateRealmError("invalid_recipients");
      }
      const targets = [...new Set(toInboxIds)].sort();
      checkCapability(early, fromInboxId, "send", "send");
      for (const target of targets) checkCapability(early, target, "send", "send");

      // Pure work only: nothing below reads or writes store state.
      const fingerprint = await sha256Hex(JSON.stringify([fromInboxId, targets, thread, body]));
      const body_sha256 = await sha256Hex(body);

      // COMMIT-SECTION-BEGIN
      const ctx = authorize(scope, selector, "send");
      checkCapability(ctx, fromInboxId, "send", "send");
      for (const target of targets) checkCapability(ctx, target, "send", "send");
      const existing = ctx.home.messages.get(messageId);
      if (existing) {
        if (existing.sender_connection_id === ctx.conn.connection_id && existing.fingerprint === fingerprint) {
          audit(ctx.home.home_id, ctx.scope, "send", "allow", "idempotent_replay");
          return deepFreeze({ message_id: messageId, created: false });
        }
        return denyCapability(ctx.home.home_id, ctx.scope, "send", "idempotency_conflict");
      }
      const created_at = now();
      ctx.home.messages.set(messageId, Object.freeze({
        message_id: messageId,
        thread_id: thread,
        sender_inbox_id: fromInboxId,
        sender_connection_id: ctx.conn.connection_id,
        body_sha256,
        body_text: body,
        fingerprint,
        created_at
      }));
      for (const target of targets) {
        ctx.home.deliveries.set(`${messageId}|${target}`, { message_id: messageId, inbox_id: target, delivered_at: created_at, read_at: null, acked_at: null });
      }
      audit(ctx.home.home_id, ctx.scope, "send", "allow", "delivered");
      return deepFreeze({ message_id: messageId, created: true, delivered_to: targets.length });
      // COMMIT-SECTION-END
    },

    // Metadata only. Requires `read`; never returns bodies and never changes delivery state.
    async listInbox(scopeIn, opts = {}, selector) {
      const ctx = authorize(scopeIn, selector, "list_inbox");
      const { inboxId, limit = 50 } = opts || {};
      checkCapability(ctx, inboxId, "read", "list_inbox");
      const cap = Math.max(1, Math.min(MAX_LIST, Number.isInteger(limit) ? limit : 50));
      const out = [];
      for (const delivery of ctx.home.deliveries.values()) {
        if (delivery.inbox_id !== inboxId) continue;
        const message = ctx.home.messages.get(delivery.message_id);
        out.push({
          message_id: message.message_id,
          thread_id: message.thread_id,
          sender_inbox_id: message.sender_inbox_id,
          body_sha256: message.body_sha256,
          delivered_at: delivery.delivered_at,
          read_at: delivery.read_at,
          acked_at: delivery.acked_at
        });
        if (out.length >= cap) break;
      }
      audit(ctx.home.home_id, ctx.scope, "list_inbox", "allow", null);
      return deepFreeze(out);
    },

    // Returns bodies. Requires `read`. First read stamps read_at; state only moves forward.
    async readInbox(scopeIn, opts = {}, selector) {
      const ctx = authorize(scopeIn, selector, "read_inbox");
      const { inboxId, limit = 50 } = opts || {};
      checkCapability(ctx, inboxId, "read", "read_inbox");
      const cap = Math.max(1, Math.min(MAX_LIST, Number.isInteger(limit) ? limit : 50));
      const out = [];
      for (const delivery of ctx.home.deliveries.values()) {
        if (delivery.inbox_id !== inboxId) continue;
        if (!delivery.read_at) delivery.read_at = now();
        const message = ctx.home.messages.get(delivery.message_id);
        out.push({
          message_id: message.message_id,
          thread_id: message.thread_id,
          sender_inbox_id: message.sender_inbox_id,
          body: message.body_text,
          body_sha256: message.body_sha256,
          created_at: message.created_at,
          delivered_at: delivery.delivered_at,
          read_at: delivery.read_at
        });
        if (out.length >= cap) break;
      }
      audit(ctx.home.home_id, ctx.scope, "read_inbox", "allow", null);
      return deepFreeze(out);
    },

    async ack(scopeIn, opts = {}, selector) {
      const ctx = authorize(scopeIn, selector, "ack");
      const { inboxId, messageId } = opts || {};
      checkCapability(ctx, inboxId, "ack", "ack");
      const delivery = typeof messageId === "string" ? ctx.home.deliveries.get(`${messageId}|${inboxId}`) : null;
      if (!delivery) return denyCapability(ctx.home.home_id, ctx.scope, "ack", "delivery_not_found");
      if (delivery.acked_at) {
        audit(ctx.home.home_id, ctx.scope, "ack", "allow", "already_acked");
        return deepFreeze({ message_id: messageId, acked: true, changed: false });
      }
      const stamp = now();
      if (!delivery.read_at) delivery.read_at = stamp;
      delivery.acked_at = stamp;
      audit(ctx.home.home_id, ctx.scope, "ack", "allow", "acked");
      return deepFreeze({ message_id: messageId, acked: true, changed: true });
    }
  };

  if (testHooks === true) {
    // Test-only introspection. Absent unless the fake is built with { testHooks: true }.
    Object.defineProperty(store, "__inspect", {
      enumerable: false,
      value() {
        return {
          audit: auditLog.slice(),
          homes: [...homes.values()].map(h => ({
            home_id: h.home_id,
            account_id: h.account_id,
            connections: [...h.connections.values()].map(c => ({ ...c })),
            inboxes: [...h.inboxes.values()].map(i => ({ ...i })),
            grants: [...h.grants.entries()].map(([k, g]) => [k, { ...g }]),
            messages: [...h.messages.values()].map(m => ({ ...m })),
            deliveries: [...h.deliveries.values()].map(d => ({ ...d }))
          }))
        };
      }
    });
  }

  return Object.freeze(store);
}

// The production path is intentionally closed in S0b-1. It never consults env.DB,
// env.CAIRNSTONE_DB, env.CAIRNSTONE_AUTH_DB or any private binding. A later, separately
// approved slice replaces this with a service-binding client to the private-storage Worker.
export function resolveHomeStore(env) {
  const injected = env && env.__PRIVATE_HOME_STORE_TEST__;
  if (injected && typeof injected === "object") return injected;
  throw new PrivateRealmError("private_home_store_not_bound");
}
