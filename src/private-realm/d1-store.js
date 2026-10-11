// S0b-2 — D1-backed private Home store adapter (complete methods).
//
// DORMANT. Implements all 12 STORE_METHODS against a private D1 binding.
// Public gateway never holds the binding. Bodies stay in private D1 or private R2.
//
// Isolation via home_id resolved from verified connection + composite FKs.
// Idempotency via unique constraints. Atomic multi-writes via db.batch.
// Auth-shaped failures -> scope_not_authorized; capability-shaped -> capability_denied.
// Audit rows awaited and contain only ids/reason codes.

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

  async function audit(home_id, scope, action, outcome, reason) {
    await db.prepare(
      `INSERT INTO priv_audit (home_id, connection_id, principal_id, action, outcome, reason, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).bind(home_id || null, scope?.connection_id || null, scope?.principal_id || null, action, outcome, reason || null, now()).run();
  }

  async function denyAuth(home_id, scope, action, reason) {
    await audit(home_id, scope, action, "deny", reason);
    throw new PrivateRealmError("scope_not_authorized");
  }

  async function denyCapability(home_id, scope, action, reason) {
    await audit(home_id, scope, action, "deny", reason);
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

  async function activeAdminCount(home_id) {
    const row = await db.prepare(
      `SELECT COUNT(*) AS n FROM priv_home_connections WHERE home_id = ? AND status = 'active' AND role = 'admin'`
    ).bind(home_id).first();
    return row ? row.n : 0;
  }


  async function requireCapability(ctx, inboxId, capability, action) {
    if (typeof inboxId !== "string" || !ID_PATTERNS.ibx.test(inboxId)) {
      return denyCapability(ctx.home_id, ctx.scope, action, "invalid_inbox_id");
    }
    const inbox = await db.prepare(
      `SELECT * FROM priv_inboxes WHERE home_id = ? AND inbox_id = ? AND status = 'active'`
    ).bind(ctx.home_id, inboxId).first();
    if (!inbox) return denyCapability(ctx.home_id, ctx.scope, action, "inbox_unavailable");
    if (inbox.scope === "connection" && inbox.owner_connection_id !== ctx.conn.connection_id) {
      return denyCapability(ctx.home_id, ctx.scope, action, "connection_private_sibling_denied");
    }
    const grant = await db.prepare(
      `SELECT * FROM priv_inbox_grants WHERE home_id = ? AND inbox_id = ? AND connection_id = ? AND revoked_at IS NULL`
    ).bind(ctx.home_id, inboxId, ctx.conn.connection_id).first();
    if (!grant || grant[`can_${capability}`] !== 1) {
      return denyCapability(ctx.home_id, ctx.scope, action, grant ? "capability_not_granted" : "no_grant");
    }
    return inbox;
  }

  const store = {
    async ensureDefaultHome(scopeIn) {
      const scope = assertHomeScope(scopeIn);
      const existing = await db.prepare(
        `SELECT home_id, role FROM priv_home_connections WHERE connection_id = ?`
      ).bind(scope.connection_id).first();
      if (existing) {
        const ctx = await authorize(scopeIn, null, "ensure_home");
        await audit(ctx.home_id, scope, "ensure_home", "allow", "idempotent");
        return deepFreeze({ home_id: ctx.home_id, created: false, connection_attached: false, role: ctx.conn.role });
      }
      let home = await db.prepare(
        `SELECT home_id, tenant_id, status FROM priv_homes WHERE account_id = ? AND is_default = 1`
      ).bind(scope.account_id).first();
      if (home && home.tenant_id !== scope.tenant_id) return denyAuth(home.home_id, scope, "ensure_home", "account_tenant_mismatch");
      const created = !home;
      const home_id = created ? mintId("home", 12) : home.home_id;
      const role = created ? "admin" : "member";
      const stamp = now();
      const stmts = [];
      if (created) {
        stmts.push(db.prepare(
          `INSERT INTO priv_homes (home_id, account_id, tenant_id, is_default, status, created_at)
           VALUES (?, ?, ?, 1, 'active', ?)`
        ).bind(home_id, scope.account_id, scope.tenant_id, stamp));
      }
      stmts.push(db.prepare(
        `INSERT INTO priv_home_connections (home_id, connection_id, principal_id, provider_label, role, status, created_at)
         VALUES (?, ?, ?, ?, ?, 'active', ?)`
      ).bind(home_id, scope.connection_id, scope.principal_id, scope.provider_label, role, stamp));
      try {
        await db.batch(stmts);
      } catch (e) {
        // Unique constraint race: re-read and return idempotent result
        const again = await db.prepare(`SELECT home_id, role FROM priv_home_connections WHERE connection_id = ?`).bind(scope.connection_id).first();
        if (again) {
          await audit(again.home_id, scope, "ensure_home", "allow", "idempotent_race");
          return deepFreeze({ home_id: again.home_id, created: false, connection_attached: false, role: again.role });
        }
        throw e;
      }
      await audit(home_id, scope, "ensure_home", "allow", created ? "created" : "attached");
      return deepFreeze({ home_id, created, connection_attached: true, role });
    },

    async setConnectionRole(scopeIn, targetConnectionId, role, selector) {
      const ctx = await authorize(scopeIn, selector, "set_role");
      if (ctx.conn.role !== "admin") return denyCapability(ctx.home_id, ctx.scope, "set_role", "admin_required");
      if (role !== "admin" && role !== "member") throw new PrivateRealmError("invalid_home_role");
      const target = await db.prepare(
        `SELECT * FROM priv_home_connections WHERE home_id = ? AND connection_id = ? AND status = 'active'`
      ).bind(ctx.home_id, targetConnectionId).first();
      if (!target) return denyCapability(ctx.home_id, ctx.scope, "set_role", "target_not_active_in_home");
      if (target.role === "admin" && role === "member" && await activeAdminCount(ctx.home_id) <= 1) {
        return denyCapability(ctx.home_id, ctx.scope, "set_role", "last_admin_protected");
      }
      await db.prepare(
        `UPDATE priv_home_connections SET role = ? WHERE home_id = ? AND connection_id = ?`
      ).bind(role, ctx.home_id, targetConnectionId).run();
      await audit(ctx.home_id, ctx.scope, "set_role", "allow", `role_${role}`);
      return deepFreeze({ connection_id: targetConnectionId, role });
    },

    async revokeConnection(scopeIn, targetConnectionId, selector) {
      const ctx = await authorize(scopeIn, selector, "revoke_connection");
      const targetId = targetConnectionId === undefined ? ctx.conn.connection_id : targetConnectionId;
      if (typeof targetId !== "string") throw new PrivateRealmError("invalid_connection_id");
      if (targetId !== ctx.conn.connection_id && ctx.conn.role !== "admin") {
        return denyCapability(ctx.home_id, ctx.scope, "revoke_connection", "admin_required");
      }
      const target = await db.prepare(
        `SELECT * FROM priv_home_connections WHERE home_id = ? AND connection_id = ?`
      ).bind(ctx.home_id, targetId).first();
      if (!target) return denyCapability(ctx.home_id, ctx.scope, "revoke_connection", "target_not_in_home");
      if (target.role === "admin" && await activeAdminCount(ctx.home_id) <= 1) {
        return denyCapability(ctx.home_id, ctx.scope, "revoke_connection", "last_admin_protected");
      }
      if (target.status === "revoked") {
        await audit(ctx.home_id, ctx.scope, "revoke_connection", "allow", "already_revoked");
        return deepFreeze({ connection_id: targetId, revoked: true, changed: false });
      }
      const stamp = now();
      await db.batch([
        db.prepare(`UPDATE priv_home_connections SET status = 'revoked', revoked_at = ? WHERE home_id = ? AND connection_id = ?`).bind(stamp, ctx.home_id, targetId),
        db.prepare(`UPDATE priv_inbox_grants SET revoked_at = ? WHERE home_id = ? AND connection_id = ? AND revoked_at IS NULL`).bind(stamp, ctx.home_id, targetId)
      ]);
      await audit(ctx.home_id, ctx.scope, "revoke_connection", "allow", "revoked");
      return deepFreeze({ connection_id: targetId, revoked: true, changed: true });
    },

    async createInbox(scopeIn, opts = {}, selector) {
      const ctx = await authorize(scopeIn, selector, "create_inbox");
      const { scope: inboxScope, plane = "chat", label = "", inboxId } = opts || {};
      if (!INBOX_SCOPES.includes(inboxScope)) throw new PrivateRealmError("invalid_inbox_scope");
      if (!INBOX_PLANES.includes(plane)) throw new PrivateRealmError("invalid_plane");
      if (typeof label !== "string" || label.length > MAX_LABEL_CHARS) throw new PrivateRealmError("invalid_label");
      if (inboxId !== undefined && (typeof inboxId !== "string" || !ID_PATTERNS.ibx.test(inboxId))) {
        throw new PrivateRealmError("invalid_inbox_id");
      }
      if (inboxScope !== "connection" && ctx.conn.role !== "admin") {
        return denyCapability(ctx.home_id, ctx.scope, "create_inbox", "admin_required");
      }
      const inbox_id = inboxId || mintId("ibx", 10);
      const owner = inboxScope === "connection" ? ctx.conn.connection_id : null;
      const existing = await db.prepare(
        `SELECT * FROM priv_inboxes WHERE home_id = ? AND inbox_id = ?`
      ).bind(ctx.home_id, inbox_id).first();
      if (existing) {
        if (existing.scope !== inboxScope || existing.plane !== plane || existing.owner_connection_id !== owner) {
          return denyCapability(ctx.home_id, ctx.scope, "create_inbox", "inbox_conflict");
        }
        await audit(ctx.home_id, ctx.scope, "create_inbox", "allow", "idempotent");
        return deepFreeze({ inbox_id, created: false });
      }
      const stamp = now();
      const stmts = [
        db.prepare(
          `INSERT INTO priv_inboxes (home_id, inbox_id, scope, plane, owner_connection_id, label, status, created_at)
           VALUES (?, ?, ?, ?, ?, ?, 'active', ?)`
        ).bind(ctx.home_id, inbox_id, inboxScope, plane, owner, label, stamp)
      ];
      if (owner) {
        stmts.push(db.prepare(
          `INSERT INTO priv_inbox_grants (home_id, inbox_id, connection_id, can_read, can_send, can_ack, granted_at)
           VALUES (?, ?, ?, 1, 1, 1, ?)`
        ).bind(ctx.home_id, inbox_id, owner, stamp));
      }
      await db.batch(stmts);
      await audit(ctx.home_id, ctx.scope, "create_inbox", "allow", "created");
      return deepFreeze({ inbox_id, created: true });
    },

    async listInboxes(scopeIn, selector) {
      const ctx = await authorize(scopeIn, selector, "list_inboxes");
      const rows = await db.prepare(
        `SELECT i.inbox_id, i.scope, i.plane, i.label,
                CASE WHEN g.revoked_at IS NULL AND g.connection_id IS NOT NULL THEN 1 ELSE 0 END AS granted
         FROM priv_inboxes i
         LEFT JOIN priv_inbox_grants g ON g.home_id = i.home_id AND g.inbox_id = i.inbox_id AND g.connection_id = ?
         WHERE i.home_id = ? AND i.status = 'active'
           AND (i.scope <> 'connection' OR i.owner_connection_id = ?)
           AND (g.connection_id IS NOT NULL AND g.revoked_at IS NULL OR (? = 'admin' AND i.scope <> 'connection'))`
      ).bind(ctx.conn.connection_id, ctx.home_id, ctx.conn.connection_id, ctx.conn.role).all();
      await audit(ctx.home_id, ctx.scope, "list_inboxes", "allow", null);
      return deepFreeze((rows.results || []).map(r => ({ inbox_id: r.inbox_id, scope: r.scope, plane: r.plane, label: r.label, granted: !!r.granted })));
    },

    async grantInbox(scopeIn, opts = {}, selector) {
      const ctx = await authorize(scopeIn, selector, "grant");
      if (ctx.conn.role !== "admin") return denyCapability(ctx.home_id, ctx.scope, "grant", "admin_required");
      const { inboxId, targetConnectionId, caps } = opts || {};
      const inbox = await db.prepare(
        `SELECT * FROM priv_inboxes WHERE home_id = ? AND inbox_id = ? AND status = 'active'`
      ).bind(ctx.home_id, inboxId).first();
      if (!inbox) return denyCapability(ctx.home_id, ctx.scope, "grant", "inbox_unavailable");
      if (inbox.scope === "connection") return denyCapability(ctx.home_id, ctx.scope, "grant", "connection_private_sibling_denied");
      const target = await db.prepare(
        `SELECT * FROM priv_home_connections WHERE home_id = ? AND connection_id = ? AND status = 'active'`
      ).bind(ctx.home_id, targetConnectionId).first();
      if (!target) return denyCapability(ctx.home_id, ctx.scope, "grant", "target_not_active_in_home");
      if (!caps || typeof caps !== "object" || Array.isArray(caps)) throw new PrivateRealmError("invalid_caps");
      const next = { read: 0, send: 0, ack: 0 };
      for (const key of Object.keys(caps)) {
        if (!CAPABILITY_SET.has(key)) throw new PrivateRealmError("invalid_caps");
        next[key] = caps[key] === true || caps[key] === 1 ? 1 : 0;
      }
      if (!next.read && !next.send && !next.ack) throw new PrivateRealmError("invalid_caps");
      const stamp = now();
      await db.prepare(
        `INSERT OR REPLACE INTO priv_inbox_grants (home_id, inbox_id, connection_id, can_read, can_send, can_ack, granted_at, revoked_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, NULL)`
      ).bind(ctx.home_id, inboxId, targetConnectionId, next.read, next.send, next.ack, stamp).run();
      await audit(ctx.home_id, ctx.scope, "grant", "allow", "granted");
      return deepFreeze({ granted: true });
    },

    async revokeGrant(scopeIn, opts = {}, selector) {
      const ctx = await authorize(scopeIn, selector, "revoke_grant");
      if (ctx.conn.role !== "admin") return denyCapability(ctx.home_id, ctx.scope, "revoke_grant", "admin_required");
      const { inboxId, targetConnectionId } = opts || {};
      const inbox = await db.prepare(
        `SELECT * FROM priv_inboxes WHERE home_id = ? AND inbox_id = ?`
      ).bind(ctx.home_id, inboxId).first();
      if (!inbox) return denyCapability(ctx.home_id, ctx.scope, "revoke_grant", "inbox_unavailable");
      if (inbox.scope === "connection") return denyCapability(ctx.home_id, ctx.scope, "revoke_grant", "connection_private_sibling_denied");
      const grant = await db.prepare(
        `SELECT * FROM priv_inbox_grants WHERE home_id = ? AND inbox_id = ? AND connection_id = ?`
      ).bind(ctx.home_id, inboxId, targetConnectionId).first();
      if (!grant || grant.revoked_at) {
        await audit(ctx.home_id, ctx.scope, "revoke_grant", "allow", "already_absent");
        return deepFreeze({ revoked: true, changed: false });
      }
      await db.prepare(
        `UPDATE priv_inbox_grants SET revoked_at = ? WHERE home_id = ? AND inbox_id = ? AND connection_id = ?`
      ).bind(now(), ctx.home_id, inboxId, targetConnectionId).run();
      await audit(ctx.home_id, ctx.scope, "revoke_grant", "allow", "revoked");
      return deepFreeze({ revoked: true, changed: true });
    },

    async can(scopeIn, inboxId, capability, selector) {
      const label = `can_${typeof capability === "string" && CAPABILITY_SET.has(capability) ? capability : "invalid"}`;
      try {
        const ctx = await authorize(scopeIn, selector, label);
        if (typeof capability !== "string" || !CAPABILITY_SET.has(capability)) return false;
        const grant = await db.prepare(
          `SELECT g.* FROM priv_inbox_grants g
           JOIN priv_inboxes i ON i.home_id = g.home_id AND i.inbox_id = g.inbox_id
           WHERE g.home_id = ? AND g.inbox_id = ? AND g.connection_id = ? AND g.revoked_at IS NULL AND i.status = 'active'
             AND (i.scope <> 'connection' OR i.owner_connection_id = ?)`
        ).bind(ctx.home_id, inboxId, ctx.conn.connection_id, ctx.conn.connection_id).first();
        return !!(grant && grant[`can_${capability}`] === 1);
      } catch (error) {
        if (error instanceof PrivateRealmError && (error.code === "scope_not_authorized" || error.code === "capability_denied")) return false;
        throw error;
      }
    },

    async send(scopeIn, opts = {}, selector) {
      const ctx = await authorize(scopeIn, selector, "send");
      const { fromInboxId, toInboxIds = [], messageId, threadId, body } = opts || {};
      await requireCapability(ctx, fromInboxId, "send", "send");
      for (const tid of toInboxIds) await requireCapability(ctx, tid, "send", "send");
      if (typeof body !== "string" || body.length > MAX_BODY_CHARS) throw new PrivateRealmError("invalid_body");
      if (!Array.isArray(toInboxIds) || toInboxIds.length === 0 || toInboxIds.length > MAX_TARGETS) throw new PrivateRealmError("invalid_targets");
      // Capability checks (send on sender + every target) done before write
      const body_sha256 = await sha256Hex(body);
      const stamp = now();
      const mid = messageId || mintId("msg", 12);
      // Idempotent check
      const existing = await db.prepare(`SELECT * FROM priv_messages WHERE home_id = ? AND message_id = ?`).bind(ctx.home_id, mid).first();
      if (existing) {
        const threadOk = existing.thread_id === (threadId || mid);
        const inboxOk = existing.sender_inbox_id === fromInboxId;
        if (existing.body_sha256 !== body_sha256 || existing.sender_connection_id !== ctx.conn.connection_id || !threadOk || !inboxOk) {
          return denyCapability(ctx.home_id, ctx.scope, "send", "idempotency_conflict");
        }
        // Target set check (simplified: count must match; full sorted fingerprint residual)
        const deliv = await db.prepare(`SELECT COUNT(*) AS n FROM priv_deliveries WHERE home_id = ? AND message_id = ?`).bind(ctx.home_id, mid).first();
        if (!deliv || deliv.n !== toInboxIds.length) {
          return denyCapability(ctx.home_id, ctx.scope, "send", "idempotency_conflict");
        }
        await audit(ctx.home_id, ctx.scope, "send", "allow", "idempotent");
        return deepFreeze({ message_id: mid, created: false });
      }
      // For this increment body_text is stored; R2 path can be added when body exceeds limit
      await db.batch([
        db.prepare(
          `INSERT INTO priv_messages (home_id, message_id, thread_id, sender_inbox_id, sender_connection_id, body_sha256, body_text, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
        ).bind(ctx.home_id, mid, threadId || mid, fromInboxId, ctx.conn.connection_id, body_sha256, body, stamp),
        ...toInboxIds.map(tid => db.prepare(
          `INSERT INTO priv_deliveries (home_id, message_id, inbox_id, delivered_at) VALUES (?, ?, ?, ?)`
        ).bind(ctx.home_id, mid, tid, stamp))
      ]);
      await audit(ctx.home_id, ctx.scope, "send", "allow", "sent");
      return deepFreeze({ message_id: mid, created: true });
    },

    async listInbox(scopeIn, opts = {}, selector) {
      const ctx = await authorize(scopeIn, selector, "list_inbox");
      await requireCapability(ctx, opts.inboxId, "read", "list_inbox");
      const { inboxId, limit = 50 } = opts || {};
      const rows = await db.prepare(
        `SELECT m.message_id, m.thread_id, m.sender_inbox_id, m.body_sha256, d.delivered_at, d.read_at, d.acked_at
         FROM priv_deliveries d
         JOIN priv_messages m ON m.home_id = d.home_id AND m.message_id = d.message_id
         WHERE d.home_id = ? AND d.inbox_id = ?
         ORDER BY d.delivered_at DESC LIMIT ?`
      ).bind(ctx.home_id, inboxId, Math.max(1, Math.min(MAX_LIST, limit))).all();
      await audit(ctx.home_id, ctx.scope, "list_inbox", "allow", null);
      return deepFreeze(rows.results || []);
    },

    async readInbox(scopeIn, opts = {}, selector) {
      const ctx = await authorize(scopeIn, selector, "read_inbox");
      await requireCapability(ctx, opts.inboxId, "read", "read_inbox");
      const { inboxId, limit = 50 } = opts || {};
      const stamp = now();
      await db.prepare(
        `UPDATE priv_deliveries SET read_at = ? WHERE home_id = ? AND inbox_id = ? AND read_at IS NULL`
      ).bind(stamp, ctx.home_id, inboxId).run();
      const rows = await db.prepare(
        `SELECT m.message_id, m.thread_id, m.sender_inbox_id, m.body_text AS body, m.body_sha256, m.created_at, d.delivered_at, d.read_at
         FROM priv_deliveries d
         JOIN priv_messages m ON m.home_id = d.home_id AND m.message_id = d.message_id
         WHERE d.home_id = ? AND d.inbox_id = ?
         ORDER BY d.delivered_at DESC LIMIT ?`
      ).bind(ctx.home_id, inboxId, Math.max(1, Math.min(MAX_LIST, limit))).all();
      await audit(ctx.home_id, ctx.scope, "read_inbox", "allow", null);
      return deepFreeze(rows.results || []);
    },

    async ack(scopeIn, opts = {}, selector) {
      const ctx = await authorize(scopeIn, selector, "ack");
      await requireCapability(ctx, opts.inboxId, "ack", "ack");
      const { inboxId, messageId } = opts || {};
      const delivery = await db.prepare(
        `SELECT * FROM priv_deliveries WHERE home_id = ? AND message_id = ? AND inbox_id = ?`
      ).bind(ctx.home_id, messageId, inboxId).first();
      if (!delivery) return denyCapability(ctx.home_id, ctx.scope, "ack", "delivery_not_found");
      if (delivery.acked_at) {
        await audit(ctx.home_id, ctx.scope, "ack", "allow", "already_acked");
        return deepFreeze({ message_id: messageId, acked: true, changed: false });
      }
      const stamp = now();
      await db.prepare(
        `UPDATE priv_deliveries SET read_at = COALESCE(read_at, ?), acked_at = ? WHERE home_id = ? AND message_id = ? AND inbox_id = ?`
      ).bind(stamp, stamp, ctx.home_id, messageId, inboxId).run();
      await audit(ctx.home_id, ctx.scope, "ack", "allow", "acked");
      return deepFreeze({ message_id: messageId, acked: true, changed: true });
    }
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
