// S0b-2 — D1-backed private Home store adapter (all 12 STORE_METHODS).
//
// DORMANT. Talks to a private D1 binding handed in by the private storage Worker. The public gateway
// never holds that binding. Bodies stay in private D1 or private R2.
//
// Concurrency model (D1: requests interleave between awaits; db.batch() is one atomic transaction):
//   1. AUTHORIZE first, with precise audited denials (authorize / requireCapability).
//   2. WRITE with the authority re-evaluated INSIDE the write statement (guarded INSERT/UPDATE: the
//      actor must still be an active connection / admin / grant holder at the moment of the write).
//      The authorization read in step 1 is therefore only an early exit, never the authority.
//   3. message/delivery inserts are additionally protected by BEFORE INSERT triggers in the migration;
//      a trigger abort rolls back the whole batch (no partial delivery).
//   4. If a write affected nothing or the batch failed, the state is RE-READ and re-authorized, then
//      classified: replay (idempotent success), conflict (typed denial), lost authority (typed
//      denial), or concurrent_state_change. A raw SQL/D1 error never escapes for an expected race.
// Auth-shaped failures -> scope_not_authorized; capability-shaped -> capability_denied. Precise reasons
// go to priv_audit only. Audit rows are awaited and contain only ids and reason codes.
//
// Known limit (disclosed): the audit insert is a separate awaited statement, not atomic with the
// mutation it describes; a crash between the two loses the audit row but never the mutation's safety.

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
import { sha256Hex } from "./hash.js";
import { getPrivateBody, privateBodyKey, putPrivateBody } from "./r2-body.js";

const MAX_BODY_CHARS = 65536;
const DEFAULT_INLINE_BODY_CHARS = 16384;
const MAX_LABEL_CHARS = 120;
const MAX_TARGETS = 20;
const MAX_LIST = 200;
const MAX_PASSES = 5;
const CAPABILITY_SET = new Set(CAPABILITIES);

function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.keys(value)) deepFreeze(value[key]);
  }
  return value;
}

const changesOf = result => Number(result?.meta?.changes ?? result?.changes ?? 0);
const isInboxId = value => typeof value === "string" && ID_PATTERNS.ibx.test(value);
const isConnectionId = value => typeof value === "string" && ID_PATTERNS.conn.test(value);

export function createD1HomeStore({
  db,
  now = () => new Date().toISOString(),
  mintId = defaultMint,
  r2 = null,
  inlineBodyMax = DEFAULT_INLINE_BODY_CHARS
} = {}) {
  if (!db || typeof db.prepare !== "function") throw new PrivateRealmError("private_d1_required");

  // ---- SQL guards: authority re-evaluated inside the write ------------------------------------
  // The calling connection is still active, in an active Home, with the account/tenant/principal the
  // verified scope carried (and optionally still an admin).
  function connGuard(ctx, { admin = false } = {}) {
    return {
      sql: `EXISTS (SELECT 1 FROM priv_home_connections gc JOIN priv_homes gh ON gh.home_id = gc.home_id
              WHERE gc.home_id = ? AND gc.connection_id = ? AND gc.principal_id = ? AND gc.status = 'active'
                AND gh.status = 'active' AND gh.account_id = ? AND gh.tenant_id = ?${admin ? " AND gc.role = 'admin'" : ""})`,
      args: [ctx.home_id, ctx.scope.connection_id, ctx.scope.principal_id, ctx.scope.account_id, ctx.scope.tenant_id]
    };
  }

  // The calling connection still holds a live grant with `capability` on an active inbox it may reach.
  function grantGuard(ctx, inboxId, capability) {
    if (!CAPABILITY_SET.has(capability)) throw new PrivateRealmError("invalid_capability");
    return {
      sql: `EXISTS (SELECT 1 FROM priv_inbox_grants gg JOIN priv_inboxes gi ON gi.home_id = gg.home_id AND gi.inbox_id = gg.inbox_id
              WHERE gg.home_id = ? AND gg.inbox_id = ? AND gg.connection_id = ? AND gg.revoked_at IS NULL AND gg.can_${capability} = 1
                AND gi.status = 'active' AND (gi.scope <> 'connection' OR gi.owner_connection_id = gg.connection_id))`,
      args: [ctx.home_id, inboxId, ctx.scope.connection_id]
    };
  }

  const both = (...guards) => ({ sql: guards.map(g => g.sql).join(" AND "), args: guards.flatMap(g => g.args) });

  // ---- audit and typed denials ----------------------------------------------------------------
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

  async function requireCapability(ctx, inboxId, capability, action) {
    if (!isInboxId(inboxId)) return denyCapability(ctx.home_id, ctx.scope, action, "invalid_inbox_id");
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

  // A guarded write affected nothing: find out WHY and raise the typed denial. Re-authorizes first, so a
  // connection revoked mid-call surfaces as scope_not_authorized (audited).
  async function failedGuard(scopeIn, selector, action, { admin = false } = {}) {
    const ctx = await authorize(scopeIn, selector, action);
    if (admin && ctx.conn.role !== "admin") return denyCapability(ctx.home_id, ctx.scope, action, "admin_required");
    return ctx;
  }

  const concurrentChange = () => new PrivateRealmError("concurrent_state_change");

  const store = {
    async ensureDefaultHome(scopeIn) {
      const scope = assertHomeScope(scopeIn);
      let lastError = null;
      for (let pass = 0; pass < MAX_PASSES; pass += 1) {
        const existing = await db.prepare(`SELECT home_id FROM priv_home_connections WHERE connection_id = ?`).bind(scope.connection_id).first();
        if (existing) {
          // Re-authorize EVERY time: account, tenant, principal, revocation. Never trust the row's existence.
          const ctx = await authorize(scopeIn, null, "ensure_home");
          await audit(ctx.home_id, scope, "ensure_home", "allow", pass === 0 ? "idempotent" : "idempotent_race");
          return deepFreeze({ home_id: ctx.home_id, created: false, connection_attached: false, role: ctx.conn.role });
        }
        const home = await db.prepare(
          `SELECT home_id, tenant_id, status FROM priv_homes WHERE account_id = ? AND is_default = 1`
        ).bind(scope.account_id).first();
        const stamp = now();

        if (!home) {
          const home_id = mintId("home", 12);
          try {
            await db.batch([
              db.prepare(
                `INSERT INTO priv_homes (home_id, account_id, tenant_id, is_default, status, created_at) VALUES (?, ?, ?, 1, 'active', ?)`
              ).bind(home_id, scope.account_id, scope.tenant_id, stamp),
              db.prepare(
                `INSERT INTO priv_home_connections (home_id, connection_id, principal_id, provider_label, role, status, created_at)
                 VALUES (?, ?, ?, ?, 'admin', 'active', ?)`
              ).bind(home_id, scope.connection_id, scope.principal_id, scope.provider_label, stamp)
            ]);
          } catch (error) {
            lastError = error; // lost the default-Home race or the connection id was claimed: re-read and re-authorize
            continue;
          }
          await audit(home_id, scope, "ensure_home", "allow", "created");
          return deepFreeze({ home_id, created: true, connection_attached: true, role: "admin" });
        }

        if (home.tenant_id !== scope.tenant_id) return denyAuth(home.home_id, scope, "ensure_home", "account_tenant_mismatch");
        if (home.status !== "active") return denyAuth(home.home_id, scope, "ensure_home", "home_inactive");
        const clash = await db.prepare(
          `SELECT 1 AS x FROM priv_home_connections WHERE home_id = ? AND principal_id = ?`
        ).bind(home.home_id, scope.principal_id).first();
        if (clash) return denyAuth(home.home_id, scope, "ensure_home", "principal_conflict");

        // Role is computed INSIDE the insert: a requested admin is honoured only if the Home has no active
        // admin at that instant, so concurrent recovery attaches can mint at most one admin.
        let attached = null;
        try {
          attached = await db.prepare(
            `INSERT INTO priv_home_connections (home_id, connection_id, principal_id, provider_label, role, status, created_at)
             SELECT h.home_id, ?, ?, ?,
                    CASE WHEN ? = 'admin' AND NOT EXISTS (
                           SELECT 1 FROM priv_home_connections a WHERE a.home_id = h.home_id AND a.status = 'active' AND a.role = 'admin'
                         ) THEN 'admin' ELSE 'member' END,
                    'active', ?
             FROM priv_homes h
             WHERE h.home_id = ? AND h.account_id = ? AND h.tenant_id = ? AND h.status = 'active'
             RETURNING role`
          ).bind(scope.connection_id, scope.principal_id, scope.provider_label, scope.home_role, stamp, home.home_id, scope.account_id, scope.tenant_id).first();
        } catch (error) {
          lastError = error; // unique(connection_id) / unique(home, principal) lost a race: re-read and re-authorize
          continue;
        }
        if (!attached) continue; // the Home changed under us: re-read
        const reason = attached.role === "admin" ? "attached_admin_recovery" : scope.home_role === "admin" ? "role_downgraded_to_member" : "attached";
        await audit(home.home_id, scope, "ensure_home", "allow", reason);
        return deepFreeze({ home_id: home.home_id, created: false, connection_attached: true, role: attached.role });
      }
      throw lastError || concurrentChange();
    },

    async setConnectionRole(scopeIn, targetConnectionId, role, selector) {
      const ctx = await authorize(scopeIn, selector, "set_role");
      if (ctx.conn.role !== "admin") return denyCapability(ctx.home_id, ctx.scope, "set_role", "admin_required");
      if (role !== "admin" && role !== "member") throw new PrivateRealmError("invalid_home_role");
      if (!isConnectionId(targetConnectionId)) return denyCapability(ctx.home_id, ctx.scope, "set_role", "target_not_active_in_home");
      const target = await db.prepare(
        `SELECT * FROM priv_home_connections WHERE home_id = ? AND connection_id = ? AND status = 'active'`
      ).bind(ctx.home_id, targetConnectionId).first();
      if (!target) return denyCapability(ctx.home_id, ctx.scope, "set_role", "target_not_active_in_home");
      // One statement: actor still an active admin AND (not a demotion OR target not an admin OR another admin remains).
      const actor = connGuard(ctx, { admin: true });
      const result = await db.prepare(
        `UPDATE priv_home_connections SET role = ?
         WHERE home_id = ? AND connection_id = ? AND status = 'active'
           AND ${actor.sql}
           AND (? <> 'member' OR role <> 'admin' OR (
             SELECT COUNT(*) FROM priv_home_connections WHERE home_id = ? AND status = 'active' AND role = 'admin'
           ) > 1)`
      ).bind(role, ctx.home_id, targetConnectionId, ...actor.args, role, ctx.home_id).run();
      if (changesOf(result) === 0) {
        const fresh = await failedGuard(scopeIn, selector, "set_role", { admin: true });
        const still = await db.prepare(
          `SELECT role FROM priv_home_connections WHERE home_id = ? AND connection_id = ? AND status = 'active'`
        ).bind(fresh.home_id, targetConnectionId).first();
        if (!still) return denyCapability(fresh.home_id, fresh.scope, "set_role", "target_not_active_in_home");
        if (still.role === "admin" && role === "member") return denyCapability(fresh.home_id, fresh.scope, "set_role", "last_admin_protected");
        throw concurrentChange();
      }
      await audit(ctx.home_id, ctx.scope, "set_role", "allow", `role_${role}`);
      return deepFreeze({ connection_id: targetConnectionId, role });
    },

    async revokeConnection(scopeIn, targetConnectionId, selector) {
      const ctx = await authorize(scopeIn, selector, "revoke_connection");
      const targetId = targetConnectionId === undefined ? ctx.conn.connection_id : targetConnectionId;
      if (!isConnectionId(targetId)) throw new PrivateRealmError("invalid_connection_id");
      if (targetId !== ctx.conn.connection_id && ctx.conn.role !== "admin") {
        return denyCapability(ctx.home_id, ctx.scope, "revoke_connection", "admin_required");
      }
      const target = await db.prepare(
        `SELECT * FROM priv_home_connections WHERE home_id = ? AND connection_id = ?`
      ).bind(ctx.home_id, targetId).first();
      if (!target) return denyCapability(ctx.home_id, ctx.scope, "revoke_connection", "target_not_in_home");
      if (target.status === "revoked") {
        await audit(ctx.home_id, ctx.scope, "revoke_connection", "allow", "already_revoked");
        return deepFreeze({ connection_id: targetId, revoked: true, changed: false });
      }
      const stamp = now();
      const self = targetId === ctx.conn.connection_id;
      const actor = connGuard(ctx, { admin: !self });
      // One atomic batch: revoke the connection (actor still entitled; not the last admin) and, only if that
      // took effect, revoke every live grant it held. Either both land or neither.
      const [revoked] = await db.batch([
        db.prepare(
          `UPDATE priv_home_connections SET status = 'revoked', revoked_at = ?
           WHERE home_id = ? AND connection_id = ? AND status = 'active'
             AND ${actor.sql}
             AND (role <> 'admin' OR (
               SELECT COUNT(*) FROM priv_home_connections WHERE home_id = ? AND status = 'active' AND role = 'admin'
             ) > 1)`
        ).bind(stamp, ctx.home_id, targetId, ...actor.args, ctx.home_id),
        db.prepare(
          `UPDATE priv_inbox_grants SET revoked_at = ?
           WHERE home_id = ? AND connection_id = ? AND revoked_at IS NULL
             AND EXISTS (SELECT 1 FROM priv_home_connections rc WHERE rc.home_id = ? AND rc.connection_id = ? AND rc.status = 'revoked' AND rc.revoked_at = ?)`
        ).bind(stamp, ctx.home_id, targetId, ctx.home_id, targetId, stamp)
      ]);
      if (changesOf(revoked) === 0) {
        const fresh = await failedGuard(scopeIn, selector, "revoke_connection", { admin: !self });
        const still = await db.prepare(
          `SELECT role, status FROM priv_home_connections WHERE home_id = ? AND connection_id = ?`
        ).bind(fresh.home_id, targetId).first();
        if (!still) return denyCapability(fresh.home_id, fresh.scope, "revoke_connection", "target_not_in_home");
        if (still.status === "revoked") {
          await audit(fresh.home_id, fresh.scope, "revoke_connection", "allow", "already_revoked");
          return deepFreeze({ connection_id: targetId, revoked: true, changed: false });
        }
        if (still.role === "admin") return denyCapability(fresh.home_id, fresh.scope, "revoke_connection", "last_admin_protected");
        throw concurrentChange();
      }
      await audit(ctx.home_id, ctx.scope, "revoke_connection", "allow", "revoked");
      return deepFreeze({ connection_id: targetId, revoked: true, changed: true });
    },

    async createInbox(scopeIn, opts = {}, selector) {
      const ctx = await authorize(scopeIn, selector, "create_inbox");
      const { scope: inboxScope, plane = "chat", label = "", inboxId } = opts || {};
      if (!INBOX_SCOPES.includes(inboxScope)) throw new PrivateRealmError("invalid_inbox_scope");
      if (!INBOX_PLANES.includes(plane)) throw new PrivateRealmError("invalid_plane");
      if (typeof label !== "string" || label.length > MAX_LABEL_CHARS) throw new PrivateRealmError("invalid_label");
      if (inboxId !== undefined && !isInboxId(inboxId)) throw new PrivateRealmError("invalid_inbox_id");
      const needsAdmin = inboxScope !== "connection";
      if (needsAdmin && ctx.conn.role !== "admin") return denyCapability(ctx.home_id, ctx.scope, "create_inbox", "admin_required");
      const inbox_id = inboxId || mintId("ibx", 10);
      const owner = inboxScope === "connection" ? ctx.conn.connection_id : null;

      const classify = async () => {
        const existing = await db.prepare(`SELECT * FROM priv_inboxes WHERE home_id = ? AND inbox_id = ?`).bind(ctx.home_id, inbox_id).first();
        if (!existing) return null;
        if (existing.scope !== inboxScope || existing.plane !== plane || existing.owner_connection_id !== owner) {
          return denyCapability(ctx.home_id, ctx.scope, "create_inbox", "inbox_conflict");
        }
        await audit(ctx.home_id, ctx.scope, "create_inbox", "allow", "idempotent");
        return deepFreeze({ inbox_id, created: false });
      };

      const early = await classify();
      if (early) return early;

      const stamp = now();
      const actor = connGuard(ctx, { admin: needsAdmin });
      const stmts = [
        db.prepare(
          `INSERT INTO priv_inboxes (home_id, inbox_id, scope, plane, owner_connection_id, label, status, created_at)
           SELECT ?, ?, ?, ?, ?, ?, 'active', ? WHERE ${actor.sql}`
        ).bind(ctx.home_id, inbox_id, inboxScope, plane, owner, label, stamp, ...actor.args)
      ];
      if (owner) {
        stmts.push(db.prepare(
          `INSERT INTO priv_inbox_grants (home_id, inbox_id, connection_id, can_read, can_send, can_ack, granted_at)
           SELECT ?, ?, ?, 1, 1, 1, ?
           WHERE ${actor.sql}
             AND EXISTS (SELECT 1 FROM priv_inboxes oi WHERE oi.home_id = ? AND oi.inbox_id = ? AND oi.owner_connection_id = ?)`
        ).bind(ctx.home_id, inbox_id, owner, stamp, ...actor.args, ctx.home_id, inbox_id, owner));
      }
      let results;
      try {
        results = await db.batch(stmts);
      } catch (error) {
        // Duplicate id (lost a create race) or a failure inside the batch: nothing was written. Re-read.
        await failedGuard(scopeIn, selector, "create_inbox", { admin: needsAdmin });
        const raced = await classify();
        if (raced) return raced;
        throw error;
      }
      if (changesOf(results[0]) === 0) {
        await failedGuard(scopeIn, selector, "create_inbox", { admin: needsAdmin });
        const raced = await classify();
        if (raced) return raced;
        throw concurrentChange();
      }
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
           AND (g.connection_id IS NOT NULL AND g.revoked_at IS NULL OR (? = 'admin' AND i.scope <> 'connection'))
         ORDER BY i.inbox_id`
      ).bind(ctx.conn.connection_id, ctx.home_id, ctx.conn.connection_id, ctx.conn.role).all();
      await audit(ctx.home_id, ctx.scope, "list_inboxes", "allow", null);
      return deepFreeze((rows.results || []).map(r => ({ inbox_id: r.inbox_id, scope: r.scope, plane: r.plane, label: r.label, granted: !!r.granted })));
    },

    async grantInbox(scopeIn, opts = {}, selector) {
      const ctx = await authorize(scopeIn, selector, "grant");
      if (ctx.conn.role !== "admin") return denyCapability(ctx.home_id, ctx.scope, "grant", "admin_required");
      const { inboxId, targetConnectionId, caps } = opts || {};
      if (!isInboxId(inboxId)) return denyCapability(ctx.home_id, ctx.scope, "grant", "inbox_unavailable");
      const inbox = await db.prepare(
        `SELECT * FROM priv_inboxes WHERE home_id = ? AND inbox_id = ? AND status = 'active'`
      ).bind(ctx.home_id, inboxId).first();
      if (!inbox) return denyCapability(ctx.home_id, ctx.scope, "grant", "inbox_unavailable");
      if (inbox.scope === "connection") return denyCapability(ctx.home_id, ctx.scope, "grant", "connection_private_sibling_denied");
      if (!isConnectionId(targetConnectionId)) return denyCapability(ctx.home_id, ctx.scope, "grant", "target_not_active_in_home");
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
      const actor = connGuard(ctx, { admin: true });
      // Upsert (never INSERT OR REPLACE): the grant row is updated in place, and only while the actor is
      // still an admin and both the inbox and the target are still valid in this Home.
      const result = await db.prepare(
        `INSERT INTO priv_inbox_grants (home_id, inbox_id, connection_id, can_read, can_send, can_ack, granted_at, revoked_at)
         SELECT ?, ?, ?, ?, ?, ?, ?, NULL
         WHERE ${actor.sql}
           AND EXISTS (SELECT 1 FROM priv_inboxes xi WHERE xi.home_id = ? AND xi.inbox_id = ? AND xi.status = 'active' AND xi.scope <> 'connection')
           AND EXISTS (SELECT 1 FROM priv_home_connections xc WHERE xc.home_id = ? AND xc.connection_id = ? AND xc.status = 'active')
         ON CONFLICT (home_id, inbox_id, connection_id) DO UPDATE SET
           can_read = excluded.can_read, can_send = excluded.can_send, can_ack = excluded.can_ack,
           granted_at = excluded.granted_at, revoked_at = NULL`
      ).bind(ctx.home_id, inboxId, targetConnectionId, next.read, next.send, next.ack, stamp, ...actor.args,
        ctx.home_id, inboxId, ctx.home_id, targetConnectionId).run();
      if (changesOf(result) === 0) {
        const fresh = await failedGuard(scopeIn, selector, "grant", { admin: true });
        return denyCapability(fresh.home_id, fresh.scope, "grant", "target_or_inbox_changed");
      }
      await audit(ctx.home_id, ctx.scope, "grant", "allow", "granted");
      return deepFreeze({ granted: true });
    },

    async revokeGrant(scopeIn, opts = {}, selector) {
      const ctx = await authorize(scopeIn, selector, "revoke_grant");
      if (ctx.conn.role !== "admin") return denyCapability(ctx.home_id, ctx.scope, "revoke_grant", "admin_required");
      const { inboxId, targetConnectionId } = opts || {};
      if (!isInboxId(inboxId)) return denyCapability(ctx.home_id, ctx.scope, "revoke_grant", "inbox_unavailable");
      const inbox = await db.prepare(
        `SELECT * FROM priv_inboxes WHERE home_id = ? AND inbox_id = ?`
      ).bind(ctx.home_id, inboxId).first();
      if (!inbox) return denyCapability(ctx.home_id, ctx.scope, "revoke_grant", "inbox_unavailable");
      if (inbox.scope === "connection") return denyCapability(ctx.home_id, ctx.scope, "revoke_grant", "connection_private_sibling_denied");
      if (!isConnectionId(targetConnectionId)) {
        await audit(ctx.home_id, ctx.scope, "revoke_grant", "allow", "already_absent");
        return deepFreeze({ revoked: true, changed: false });
      }
      const actor = connGuard(ctx, { admin: true });
      const result = await db.prepare(
        `UPDATE priv_inbox_grants SET revoked_at = ?
         WHERE home_id = ? AND inbox_id = ? AND connection_id = ? AND revoked_at IS NULL AND ${actor.sql}`
      ).bind(now(), ctx.home_id, inboxId, targetConnectionId, ...actor.args).run();
      if (changesOf(result) === 0) {
        const fresh = await failedGuard(scopeIn, selector, "revoke_grant", { admin: true });
        const grant = await db.prepare(
          `SELECT revoked_at FROM priv_inbox_grants WHERE home_id = ? AND inbox_id = ? AND connection_id = ?`
        ).bind(fresh.home_id, inboxId, targetConnectionId).first();
        if (!grant || grant.revoked_at) {
          await audit(fresh.home_id, fresh.scope, "revoke_grant", "allow", "already_absent");
          return deepFreeze({ revoked: true, changed: false });
        }
        throw concurrentChange();
      }
      await audit(ctx.home_id, ctx.scope, "revoke_grant", "allow", "revoked");
      return deepFreeze({ revoked: true, changed: true });
    },

    async can(scopeIn, inboxId, capability, selector) {
      const label = `can_${typeof capability === "string" && CAPABILITY_SET.has(capability) ? capability : "invalid"}`;
      try {
        const ctx = await authorize(scopeIn, selector, label);
        if (typeof capability !== "string" || !CAPABILITY_SET.has(capability)) return false;
        if (!isInboxId(inboxId)) return false;
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
      const { fromInboxId, toInboxIds, messageId, threadId, body } = opts || {};
      // Pure input validation first: nothing here touches storage.
      if (typeof messageId !== "string" || !ID_PATTERNS.message.test(messageId)) throw new PrivateRealmError("invalid_message_id");
      if (threadId !== undefined && (typeof threadId !== "string" || !ID_PATTERNS.thread.test(threadId))) throw new PrivateRealmError("invalid_thread_id");
      if (typeof body !== "string" || body.length === 0 || body.length > MAX_BODY_CHARS) throw new PrivateRealmError("invalid_body");
      if (!Array.isArray(toInboxIds) || toInboxIds.length === 0 || toInboxIds.length > MAX_TARGETS) throw new PrivateRealmError("invalid_recipients");
      if (!toInboxIds.every(t => typeof t === "string")) throw new PrivateRealmError("invalid_recipients");
      const targets = [...new Set(toInboxIds)].sort(); // exact recipient set: deduplicated, stable order
      const thread = threadId || messageId;
      const mid = messageId;

      const ctx = await authorize(scopeIn, selector, "send");
      const checkAuthority = async c => {
        await requireCapability(c, fromInboxId, "send", "send");
        for (const tid of targets) await requireCapability(c, tid, "send", "send");
      };
      await checkAuthority(ctx);

      const body_sha256 = await sha256Hex(body);
      const useR2 = body.length > inlineBodyMax;
      if (useR2 && !r2) throw new PrivateRealmError("private_r2_required");

      // The request is a replay only if EVERYTHING matches: sender connection, sender inbox, thread, body hash
      // and the exact recipient set. Anything else under the same id is a conflict. Never overwritten.
      const classify = async () => {
        const existing = await db.prepare(`SELECT * FROM priv_messages WHERE home_id = ? AND message_id = ?`).bind(ctx.home_id, mid).first();
        if (!existing) return null;
        const delivered = await db.prepare(
          `SELECT inbox_id FROM priv_deliveries WHERE home_id = ? AND message_id = ? ORDER BY inbox_id`
        ).bind(ctx.home_id, mid).all();
        const have = (delivered.results || []).map(r => r.inbox_id);
        const same = existing.body_sha256 === body_sha256 && existing.sender_connection_id === ctx.conn.connection_id &&
          existing.thread_id === thread && existing.sender_inbox_id === fromInboxId &&
          have.length === targets.length && have.every((id, i) => id === targets[i]);
        if (!same) return denyCapability(ctx.home_id, ctx.scope, "send", "idempotency_conflict");
        await audit(ctx.home_id, ctx.scope, "send", "allow", "idempotent");
        return deepFreeze({ message_id: mid, created: false, delivered_to: targets.length });
      };

      const early = await classify();
      if (early) return early;

      let r2Key = null;
      if (useR2) r2Key = await putPrivateBody(r2, { home_id: ctx.home_id, message_id: mid, body_sha256, body });
      const stamp = now();
      try {
        // Atomic. The migration's BEFORE INSERT triggers re-check the sender's connection, Home, grant and the
        // target grants INSIDE the write; any failure aborts the whole batch (no message, no partial delivery).
        await db.batch([
          db.prepare(
            `INSERT INTO priv_messages (home_id, message_id, thread_id, sender_inbox_id, sender_connection_id, body_sha256, body_text, body_r2_key, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
          ).bind(ctx.home_id, mid, thread, fromInboxId, ctx.conn.connection_id, body_sha256, useR2 ? null : body, r2Key, stamp),
          ...targets.map(tid => db.prepare(
            `INSERT INTO priv_deliveries (home_id, message_id, inbox_id, delivered_at) VALUES (?, ?, ?, ?)`
          ).bind(ctx.home_id, mid, tid, stamp))
        ]);
      } catch (error) {
        // Nothing was written. Re-authorize FIRST (a revocation must never turn into an idempotent success),
        // then decide whether we lost a replay/conflict race.
        const fresh = await authorize(scopeIn, selector, "send");
        await checkAuthority(fresh);
        const raced = await classify();
        if (raced) return raced;
        throw concurrentChange();
      }
      await audit(ctx.home_id, ctx.scope, "send", "allow", "sent");
      return deepFreeze({ message_id: mid, created: true, delivered_to: targets.length });
    },

    async listInbox(scopeIn, opts = {}, selector) {
      const { inboxId, limit = 50 } = opts || {};
      const lim = clampLimit(limit);
      const ctx = await authorize(scopeIn, selector, "list_inbox");
      await requireCapability(ctx, inboxId, "read", "list_inbox");
      const rows = await db.prepare(
        `SELECT m.message_id, m.thread_id, m.sender_inbox_id, m.body_sha256, m.created_at, d.delivered_at, d.read_at, d.acked_at
         FROM priv_deliveries d
         JOIN priv_messages m ON m.home_id = d.home_id AND m.message_id = d.message_id
         WHERE d.home_id = ? AND d.inbox_id = ?
         ORDER BY d.delivered_at DESC, d.message_id DESC LIMIT ?`
      ).bind(ctx.home_id, inboxId, lim).all();
      await audit(ctx.home_id, ctx.scope, "list_inbox", "allow", null);
      return deepFreeze((rows.results || []).map(r => ({ ...r })));
    },

    async readInbox(scopeIn, opts = {}, selector) {
      const { inboxId, limit = 50 } = opts || {};
      const lim = clampLimit(limit);
      const ctx = await authorize(scopeIn, selector, "read_inbox");
      await requireCapability(ctx, inboxId, "read", "read_inbox");
      const rows = await db.prepare(
        `SELECT m.message_id, m.thread_id, m.sender_inbox_id, m.body_text, m.body_r2_key, m.body_sha256, m.created_at,
                d.delivered_at, d.read_at
         FROM priv_deliveries d
         JOIN priv_messages m ON m.home_id = d.home_id AND m.message_id = d.message_id
         WHERE d.home_id = ? AND d.inbox_id = ?
         ORDER BY d.delivered_at DESC, d.message_id DESC LIMIT ?`
      ).bind(ctx.home_id, inboxId, lim).all();

      // Resolve bodies. An unavailable or corrupt R2 object is reported per row and is NEVER stamped as read.
      const returned = [];
      for (const r of rows.results || []) {
        let bodyText = r.body_text;
        let status = "ok";
        if (bodyText === null || bodyText === undefined) {
          const got = await getPrivateBody(r2, { home_id: ctx.home_id, message_id: r.message_id, body_sha256: r.body_sha256, storedKey: r.body_r2_key });
          status = got.status;
          bodyText = got.status === "ok" ? got.body : null;
        }
        returned.push({
          message_id: r.message_id, thread_id: r.thread_id, sender_inbox_id: r.sender_inbox_id,
          body: bodyText, body_status: status, body_sha256: r.body_sha256, created_at: r.created_at,
          delivered_at: r.delivered_at, read_at: r.read_at
        });
      }

      // Stamp ONLY the rows being returned with a body, ONLY if still unread, and ONLY while the reader still
      // holds an active connection and a live read grant (checked inside the UPDATE).
      const toMark = returned.filter(r => !r.read_at && r.body_status === "ok").map(r => r.message_id);
      if (toMark.length) {
        const stamp = now();
        const guard = both(connGuard(ctx), grantGuard(ctx, inboxId, "read"));
        const placeholders = toMark.map(() => "?").join(",");
        const result = await db.prepare(
          `UPDATE priv_deliveries SET read_at = ?
           WHERE home_id = ? AND inbox_id = ? AND message_id IN (${placeholders}) AND read_at IS NULL AND ${guard.sql}`
        ).bind(stamp, ctx.home_id, inboxId, ...toMark, ...guard.args).run();
        if (changesOf(result) < toMark.length) {
          // Either another reader stamped some rows first (fine) or this reader lost authority (must fail
          // closed before any body leaves). Re-authorize, then report the stamps that actually stand.
          const fresh = await authorize(scopeIn, selector, "read_inbox");
          await requireCapability(fresh, inboxId, "read", "read_inbox");
          const standing = await db.prepare(
            `SELECT message_id, read_at FROM priv_deliveries WHERE home_id = ? AND inbox_id = ? AND message_id IN (${placeholders})`
          ).bind(ctx.home_id, inboxId, ...toMark).all();
          const byId = new Map((standing.results || []).map(s => [s.message_id, s.read_at]));
          for (const r of returned) if (byId.has(r.message_id) && byId.get(r.message_id)) r.read_at = byId.get(r.message_id);
        } else {
          for (const r of returned) if (toMark.includes(r.message_id)) r.read_at = stamp;
        }
      }
      await audit(ctx.home_id, ctx.scope, "read_inbox", "allow", null);
      return deepFreeze(returned);
    },

    async ack(scopeIn, opts = {}, selector) {
      const { inboxId, messageId } = opts || {};
      const ctx = await authorize(scopeIn, selector, "ack");
      await requireCapability(ctx, inboxId, "ack", "ack");
      if (typeof messageId !== "string" || !ID_PATTERNS.message.test(messageId)) {
        return denyCapability(ctx.home_id, ctx.scope, "ack", "delivery_not_found");
      }
      const stamp = now();
      const guard = both(connGuard(ctx), grantGuard(ctx, inboxId, "ack"));
      // read_at <= acked_at is preserved even if a concurrent reader stamped read_at with a later clock reading.
      const result = await db.prepare(
        `UPDATE priv_deliveries SET read_at = COALESCE(read_at, ?), acked_at = max(COALESCE(read_at, ?), ?)
         WHERE home_id = ? AND message_id = ? AND inbox_id = ? AND acked_at IS NULL AND ${guard.sql}`
      ).bind(stamp, stamp, stamp, ctx.home_id, messageId, inboxId, ...guard.args).run();
      if (changesOf(result) === 0) {
        const fresh = await authorize(scopeIn, selector, "ack");
        await requireCapability(fresh, inboxId, "ack", "ack");
        const delivery = await db.prepare(
          `SELECT acked_at FROM priv_deliveries WHERE home_id = ? AND message_id = ? AND inbox_id = ?`
        ).bind(fresh.home_id, messageId, inboxId).first();
        if (!delivery) return denyCapability(fresh.home_id, fresh.scope, "ack", "delivery_not_found");
        if (delivery.acked_at) {
          await audit(fresh.home_id, fresh.scope, "ack", "allow", "already_acked");
          return deepFreeze({ message_id: messageId, acked: true, changed: false });
        }
        throw concurrentChange();
      }
      await audit(ctx.home_id, ctx.scope, "ack", "allow", "acked");
      return deepFreeze({ message_id: messageId, acked: true, changed: true });
    }
  };

  for (const m of STORE_METHODS) {
    if (typeof store[m] !== "function") throw new Error(`missing method ${m}`);
  }
  return store;
}

function clampLimit(limit) {
  if (!Number.isInteger(limit) || limit < 1) throw new PrivateRealmError("invalid_limit");
  return Math.min(MAX_LIST, limit);
}

function defaultMint(prefix, bytes) {
  const c = globalThis.crypto;
  if (!c || typeof c.getRandomValues !== "function") throw new PrivateRealmError("secure_random_unavailable");
  const buf = new Uint8Array(bytes);
  c.getRandomValues(buf);
  return `${prefix}_${[...buf].map(b => b.toString(16).padStart(2, "0")).join("")}`;
}

export { STORE_METHODS, privateBodyKey };
