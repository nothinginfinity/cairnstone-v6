import test from "node:test";
import assert from "node:assert/strict";
import { hashSecret, validateAccessToken, assertCallerIdentity } from "../src/core-auth.js";
import {
  CANONICAL_MESSAGES_RESOURCE,
  MessagesAuthBridge,
  introspectAccessToken
} from "../src/messages-auth-bridge.js";

const CORE_RESOURCE = "https://cairnstone-v6.jaredtechfit.workers.dev/mcp/core-auth";
const REALM = "core-auth";

class MiniAuthDb {
  constructor() {
    this.access = new Map();
    this.families = new Map();
    this.accounts = new Map();
    this.memberships = new Map();
    this.connections = new Map();
    this.authenticators = new Map();
  }

  prepare(sql) {
    const normalized = String(sql).replace(/\s+/g, " ").trim();
    const db = this;
    return {
      bind(...args) {
        return {
          async first() {
            if (/FROM auth_access_tokens WHERE realm = \? AND token_hash = \?/.test(normalized)) {
              const row = db.access.get(args[1]);
              return row && row.realm === args[0] ? row : null;
            }
            if (/FROM auth_token_families WHERE realm = \? AND token_family_id = \?/.test(normalized)) {
              const row = db.families.get(args[1]);
              return row && row.realm === args[0] ? row : null;
            }
            if (/FROM auth_accounts WHERE realm = \? AND account_id = \?/.test(normalized)) {
              const row = db.accounts.get(args[1]);
              return row && row.realm === args[0] ? row : null;
            }
            if (/FROM auth_tenant_memberships WHERE realm = \? AND account_id = \? AND tenant_id = \?/.test(normalized)) {
              const row = db.memberships.get(`${args[1]}|${args[2]}`);
              return row && row.realm === args[0] ? row : null;
            }
            if (/FROM auth_connection_principals WHERE realm = \? AND connection_id = \?/.test(normalized)) {
              const row = db.connections.get(args[1]);
              return row && row.realm === args[0] ? row : null;
            }
            if (/FROM auth_authenticators WHERE realm = \? AND authenticator_id = \?/.test(normalized)) {
              const row = db.authenticators.get(args[1]);
              return row && row.realm === args[0] ? row : null;
            }
            return null;
          },
          async run() {
            return { success: true, meta: { changes: 0 } };
          }
        };
      }
    };
  }
}

async function seedToken(db, {
  token,
  resource,
  scopes,
  expiresAt = "2099-01-01T00:00:00.000Z",
  revokedAt = null,
  familyStatus = "active",
  accountId = "acct_alice",
  tenantId = "ten_alice",
  connectionId = "conn_alice",
  principalId = "prin_alice",
  familyId = "tfam_alice",
  authenticatorId = "authn_alice"
}) {
  const tokenHash = await hashSecret(token);
  db.access.set(tokenHash, {
    token_hash: tokenHash,
    realm: REALM,
    token_family_id: familyId,
    principal_id: principalId,
    account_id: accountId,
    tenant_id: tenantId,
    connection_id: connectionId,
    resource,
    scopes_json: JSON.stringify(scopes),
    authz_version: 1,
    expires_at: expiresAt,
    revoked_at: revokedAt,
    created_at: "2026-09-01T00:00:00.000Z"
  });
  db.families.set(familyId, {
    token_family_id: familyId,
    realm: REALM,
    connection_id: connectionId,
    principal_id: principalId,
    account_id: accountId,
    tenant_id: tenantId,
    origin_authenticator_id: authenticatorId,
    resource,
    scopes_json: JSON.stringify(scopes),
    status: familyStatus,
    authz_version: 1
  });
  db.accounts.set(accountId, {
    account_id: accountId,
    realm: REALM,
    home_tenant_id: tenantId,
    status: "active",
    display_name: "Alice",
    home_workspace_id: null,
    home_code_session_id: null,
    authz_version: 1,
    created_at: "2026-09-01T00:00:00.000Z",
    closed_at: null
  });
  db.memberships.set(`${accountId}|${tenantId}`, {
    realm: REALM,
    account_id: accountId,
    tenant_id: tenantId,
    status: "active",
    authz_version: 1
  });
  db.connections.set(connectionId, {
    connection_id: connectionId,
    principal_id: principalId,
    account_id: accountId,
    tenant_id: tenantId,
    realm: REALM,
    status: "active",
    client_family: "messages",
    routing_aliases_json: "[]",
    oauth_sub: accountId,
    created_at: "2026-09-01T00:00:00.000Z"
  });
  db.authenticators.set(authenticatorId, {
    authenticator_id: authenticatorId,
    realm: REALM,
    account_id: accountId,
    method: "wallet_proof",
    status: "active",
    assurance_class: "wallet_ownership",
    wallet_account_id: "walacct_alice",
    created_at: "2026-09-01T00:00:00.000Z"
  });
  return { tokenHash };
}

function envFor(db) {
  return { CAIRNSTONE_AUTH_DB: db, CORE_AUTH_RESOURCE: CORE_RESOURCE };
}

test("Messages token introspects to bounded principal", async () => {
  const db = new MiniAuthDb();
  await seedToken(db, {
    token: "csat_messages_ok",
    resource: CANONICAL_MESSAGES_RESOURCE,
    scopes: ["messages.read", "messages.write"]
  });
  const bridge = new MessagesAuthBridge(null, envFor(db));
  const result = await bridge.introspectAccessToken({ token: "csat_messages_ok" });
  assert.equal(result.ok, true);
  assert.equal(result.active, true);
  assert.equal(result.account_id, "acct_alice");
  assert.equal(result.tenant_id, "ten_alice");
  assert.equal(result.connection_id, "conn_alice");
  assert.equal(result.principal_id, "prin_alice");
  assert.equal(result.resource, CANONICAL_MESSAGES_RESOURCE);
  assert.deepEqual(result.scopes, ["messages.read", "messages.write"]);
  assert.equal(result.authz_version, 1);
  assert.equal("token_family_id" in result, false);
});

test("Core-resource token is rejected by Messages bridge", async () => {
  const db = new MiniAuthDb();
  await seedToken(db, {
    token: "csat_core",
    resource: CORE_RESOURCE,
    scopes: ["mcp:core"]
  });
  const result = await introspectAccessToken(envFor(db), { token: "csat_core" });
  assert.equal(result.ok, false);
  assert.equal(result.active, false);
  assert.equal(result.status, 401);
});

test("Messages-resource token is rejected at Core validateAccessToken", async () => {
  const db = new MiniAuthDb();
  await seedToken(db, {
    token: "csat_messages_ok",
    resource: CANONICAL_MESSAGES_RESOURCE,
    scopes: ["messages.read", "messages.write"]
  });
  const result = await validateAccessToken(envFor(db), "csat_messages_ok", {
    expectedResource: CORE_RESOURCE
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "audience_mismatch");
});

test("caller cannot point introspection at an arbitrary resource", async () => {
  const db = new MiniAuthDb();
  await seedToken(db, {
    token: "csat_messages_ok",
    resource: CANONICAL_MESSAGES_RESOURCE,
    scopes: ["messages.read"]
  });
  const result = await introspectAccessToken(envFor(db), {
    token: "csat_messages_ok",
    resource: CORE_RESOURCE
  });
  assert.equal(result.reason, "resource_not_allowlisted");
});

test("expired and revoked tokens fail closed", async () => {
  const db = new MiniAuthDb();
  await seedToken(db, {
    token: "csat_expired",
    resource: CANONICAL_MESSAGES_RESOURCE,
    scopes: ["messages.read"],
    expiresAt: "2020-01-01T00:00:00.000Z"
  });
  await seedToken(db, {
    token: "csat_revoked",
    resource: CANONICAL_MESSAGES_RESOURCE,
    scopes: ["messages.read"],
    revokedAt: "2026-09-01T00:00:00.000Z",
    familyId: "tfam_revoked",
    connectionId: "conn_revoked",
    principalId: "prin_revoked"
  });
  assert.equal((await introspectAccessToken(envFor(db), { token: "csat_expired" })).ok, false);
  assert.equal((await introspectAccessToken(envFor(db), { token: "csat_revoked" })).ok, false);
});

test("mcp:core scopes are insufficient for Messages", async () => {
  const db = new MiniAuthDb();
  await seedToken(db, {
    token: "csat_wrong_scope",
    resource: CANONICAL_MESSAGES_RESOURCE,
    scopes: ["mcp:core"]
  });
  const result = await introspectAccessToken(envFor(db), { token: "csat_wrong_scope" });
  assert.equal(result.error, "insufficient_scope");
});

test("caller identity override is rejected", async () => {
  const db = new MiniAuthDb();
  await seedToken(db, {
    token: "csat_messages_ok",
    resource: CANONICAL_MESSAGES_RESOURCE,
    scopes: ["messages.read"]
  });
  const result = await introspectAccessToken(envFor(db), {
    token: "csat_messages_ok",
    account_id: "acct_eve"
  });
  assert.equal(result.error, "caller_identity_mismatch");
  const direct = assertCallerIdentity(
    { account_id: "acct_eve" },
    { account_id: "acct_alice", tenant_id: "ten_alice", connection_id: "conn_alice", principal_id: "prin_alice" }
  );
  assert.equal(direct.ok, false);
});

test("foreign JWT never becomes a Messages principal", async () => {
  const db = new MiniAuthDb();
  const result = await introspectAccessToken(envFor(db), {
    token: "eyJhbGciOiJub25lIn0.eyJzdWIiOiJhY2N0X2ZvcmdlIn0.x"
  });
  assert.equal(result.ok, false);
  assert.equal(result.active, false);
});
