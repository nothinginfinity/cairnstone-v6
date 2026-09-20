// V7.7.10i.1 — Core-auth canary: negative fixtures + isolation tests.
// Contracts: docs/V7_7_10I_0_NEGATIVE_FIXTURES.md, docs/V7_7_10I_0_CANARY_ROLLBACK.md

import test from "node:test";
import assert from "node:assert/strict";
import worker, { handleMcpRpc } from "../src/index.js";
import {
  ACCOUNT_SCHEMA,
  AUTHENTICATOR_SCHEMA,
  CONNECTION_PRINCIPAL_SCHEMA,
  CORE_AUTH_REALM,
  TOKEN_FAMILY_SCHEMA,
  assertCallerIdentity,
  bootstrapAccountConnection,
  bumpAuthzVersion,
  bindConnectionTenant,
  claimRoutingAlias,
  createAuthorizationCode,
  enforceCoreAuthRequest,
  fetchCimdDocument,
  handleOauthRegisterRequest,
  handleOauthTokenRequest,
  isPrivateOrLinkLocalHostname,
  joinTenant,
  legacyMustNotQueryAuth,
  pkceChallengeS256,
  protectedResourceMetadata,
  redeemAuthorizationCode,
  replaceAuthenticator,
  resolveEnforcementMode,
  revokeAuthenticator,
  revokeConnection,
  revokeTokenFamily,
  rotateRefreshToken,
  sqlTouchesAuthTables,
  validateAccessToken,
  validateAuthenticatorPair,
  validateCimdClientIdUrl
} from "../src/core-auth.js";

const RESOURCE = "https://cairnstone.test/mcp/core-auth";
const ISSUER = "https://cairnstone.test/oauth";

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

class FakeAuthD1 {
  constructor() {
    this.tables = {
      auth_tenants: new Map(),
      auth_accounts: new Map(),
      auth_tenant_memberships: new Map(),
      auth_authenticators: new Map(),
      auth_wallet_accounts: new Map(),
      auth_connection_principals: new Map(),
      auth_token_families: new Map(),
      auth_access_tokens: new Map(),
      auth_refresh_tokens: new Map(),
      auth_authorization_codes: new Map(),
      auth_routing_aliases: new Map(),
      auth_cimd_cache: new Map(),
      auth_canary_admissions: new Map(),
      auth_audit_events: new Map(),
      mcp_core_sessions: new Map()
    };
    this.authQueryCount = 0;
    this.legacyAuthJoinAttempts = 0;
  }

  _pk(table, row) {
    switch (table) {
      case "auth_tenants": return row.tenant_id;
      case "auth_accounts": return row.account_id;
      case "auth_tenant_memberships": return `${row.realm}|${row.account_id}|${row.tenant_id}`;
      case "auth_authenticators": return row.authenticator_id;
      case "auth_wallet_accounts": return row.wallet_account_id;
      case "auth_connection_principals": return row.connection_id;
      case "auth_token_families": return row.token_family_id;
      case "auth_access_tokens": return row.token_hash;
      case "auth_refresh_tokens": return row.token_hash;
      case "auth_authorization_codes": return row.code_hash;
      case "auth_routing_aliases": return `${row.realm}|${row.alias}`;
      case "auth_cimd_cache": return row.client_id;
      case "auth_canary_admissions": return `${row.realm}|${row.connection_id}`;
      case "auth_audit_events": return row.event_id;
      case "mcp_core_sessions": return row.session_id;
      default: return null;
    }
  }

  prepare(sql) {
    const db = this;
    const normalized = String(sql).replace(/\s+/g, " ").trim();
    if (/\bauth_[a-z0-9_]+\b/i.test(normalized)) db.authQueryCount += 1;

    return {
      bind(...args) {
        return {
          async run() {
            if (/^INSERT INTO auth_tenants/i.test(normalized)) {
              const [tenant_id, schema, realm, created_at] = args;
              const row = { tenant_id, schema, realm, status: "active", created_at, accepted_state_authority: 0 };
              db.tables.auth_tenants.set(tenant_id, row);
              return { success: true, meta: { changes: 1 } };
            }
            if (/^INSERT INTO auth_accounts/i.test(normalized)) {
              const [account_id, schema, realm, home_tenant_id, display_name, home_workspace_id, home_code_session_id, created_at] = args;
              db.tables.auth_accounts.set(account_id, {
                account_id, schema, realm, home_tenant_id, status: "active", display_name,
                home_workspace_id, home_code_session_id, authz_version: 1, created_at, closed_at: null,
                accepted_state_authority: 0
              });
              return { success: true, meta: { changes: 1 } };
            }
            if (/^INSERT INTO auth_tenant_memberships/i.test(normalized)) {
              const [realm, account_id, tenant_id, created_at] = args;
              const key = `${realm}|${account_id}|${tenant_id}`;
              const existing = db.tables.auth_tenant_memberships.get(key);
              if (existing && /ON CONFLICT/i.test(normalized)) {
                db.tables.auth_tenant_memberships.set(key, { ...existing, status: "active", revoked_at: null });
              } else {
                db.tables.auth_tenant_memberships.set(key, {
                  realm, account_id, tenant_id, status: "active", authz_version: 1, created_at, revoked_at: null,
                  accepted_state_authority: 0
                });
              }
              return { success: true, meta: { changes: 1 } };
            }
            if (/^INSERT INTO auth_wallet_accounts/i.test(normalized)) {
              const [wallet_account_id, realm, account_id, created_at] = args;
              db.tables.auth_wallet_accounts.set(wallet_account_id, {
                wallet_account_id, schema: "cairnstone-wallet-account-v1", realm, account_id,
                status: "active", balance_units: 0, address: null, created_at, rotated_at: null,
                accepted_state_authority: 0
              });
              return { success: true, meta: { changes: 1 } };
            }
            if (/^INSERT INTO auth_authenticators/i.test(normalized)) {
              const [authenticator_id, schema, realm, account_id, method, assurance_class, wallet_account_id, created_at] = args;
              db.tables.auth_authenticators.set(authenticator_id, {
                authenticator_id, schema, realm, account_id, method, status: "active",
                assurance_class, wallet_account_id, created_at, revoked_at: null, accepted_state_authority: 0
              });
              return { success: true, meta: { changes: 1 } };
            }
            if (/^INSERT INTO auth_connection_principals/i.test(normalized)) {
              const [connection_id, schema, realm, principal_id, account_id, tenant_id, client_family, routing_aliases_json, oauth_sub, created_at] = args;
              db.tables.auth_connection_principals.set(connection_id, {
                connection_id, schema, realm, principal_id, account_id, tenant_id, status: "active",
                client_family, routing_aliases_json, oauth_sub, created_at, revoked_at: null, accepted_state_authority: 0
              });
              return { success: true, meta: { changes: 1 } };
            }
            if (/^INSERT INTO auth_token_families/i.test(normalized)) {
              const [
                token_family_id, schema, realm, connection_id, principal_id, account_id, tenant_id,
                origin_authenticator_id, resource, scopes_json, authz_version, created_at
              ] = args;
              db.tables.auth_token_families.set(token_family_id, {
                token_family_id, schema, realm, connection_id, principal_id, account_id, tenant_id,
                origin_authenticator_id, resource, scopes_json, status: "active", authz_version,
                refresh_generation: 0, created_at, last_rotated_at: null, revoked_at: null,
                superseded_by_token_family_id: null, accepted_state_authority: 0
              });
              return { success: true, meta: { changes: 1 } };
            }
            if (/^INSERT INTO auth_access_tokens/i.test(normalized)) {
              const [
                token_hash, realm, token_family_id, principal_id, account_id, tenant_id, connection_id,
                resource, scopes_json, authz_version, expires_at, created_at
              ] = args;
              db.tables.auth_access_tokens.set(token_hash, {
                token_hash, realm, token_family_id, principal_id, account_id, tenant_id, connection_id,
                resource, scopes_json, authz_version, expires_at, revoked_at: null, created_at
              });
              return { success: true, meta: { changes: 1 } };
            }
            if (/^INSERT INTO auth_refresh_tokens/i.test(normalized)) {
              const [
                token_hash, realm, token_family_id, principal_id, account_id, tenant_id, connection_id,
                refresh_generation, expires_at, created_at
              ] = args;
              db.tables.auth_refresh_tokens.set(token_hash, {
                token_hash, realm, token_family_id, principal_id, account_id, tenant_id, connection_id,
                refresh_generation, status: "active", expires_at, created_at, rotated_at: null, revoked_at: null
              });
              return { success: true, meta: { changes: 1 } };
            }
            if (/^INSERT INTO auth_authorization_codes/i.test(normalized)) {
              const [
                code_hash, realm, account_id, tenant_id, connection_id, principal_id, authenticator_id,
                client_id, redirect_uri, code_challenge, resource, scopes_json, iss, expires_at, created_at
              ] = args;
              db.tables.auth_authorization_codes.set(code_hash, {
                code_hash, realm, account_id, tenant_id, connection_id, principal_id, authenticator_id,
                client_id, redirect_uri, code_challenge, code_challenge_method: "S256", resource, scopes_json,
                iss, status: "unused", expires_at, created_at, used_at: null
              });
              return { success: true, meta: { changes: 1 } };
            }
            if (/^INSERT INTO auth_routing_aliases/i.test(normalized)) {
              const [realm, alias, principal_id, account_id, tenant_id, created_at] = args;
              const key = `${realm}|${alias}`;
              if (db.tables.auth_routing_aliases.has(key)) throw new Error("UNIQUE constraint failed");
              db.tables.auth_routing_aliases.set(key, {
                realm, alias, principal_id, account_id, tenant_id, status: "active", created_at
              });
              return { success: true, meta: { changes: 1 } };
            }
            if (/^INSERT INTO auth_canary_admissions/i.test(normalized)) {
              const [realm, connection_id, client_family, label, created_at] = args;
              const key = `${realm}|${connection_id}`;
              db.tables.auth_canary_admissions.set(key, {
                realm, connection_id, client_family, label, status: "admitted", created_at
              });
              return { success: true, meta: { changes: 1 } };
            }
            if (/^INSERT INTO auth_cimd_cache/i.test(normalized)) {
              const [client_id, realm, content_hash, redirect_uris_json, fetched_at, document_json] = args;
              db.tables.auth_cimd_cache.set(client_id, {
                client_id, realm, content_hash, redirect_uris_json, fetched_at, document_json
              });
              return { success: true, meta: { changes: 1 } };
            }
            if (/^INSERT INTO auth_audit_events/i.test(normalized)) {
              const [event_id, realm, event_type, account_id, tenant_id, principal_id, connection_id, token_family_id, detail_json, created_at] = args;
              db.tables.auth_audit_events.set(event_id, {
                event_id, realm, event_type, account_id, tenant_id, principal_id, connection_id,
                token_family_id, detail_json, created_at, accepted_state_authority: 0
              });
              return { success: true, meta: { changes: 1 } };
            }
            if (/^INSERT INTO mcp_core_sessions/i.test(normalized)) {
              const [session_id, profile, hydrated, created_at, updated_at, expires_at] = args;
              db.tables.mcp_core_sessions.set(session_id, {
                session_id, profile, hydrated_tool_ids_json: hydrated, created_at, updated_at, expires_at
              });
              return { success: true, meta: { changes: 1 } };
            }
            if (/^UPDATE auth_refresh_tokens SET status = 'rotated'/i.test(normalized)) {
              const [rotated_at, realm, token_hash] = args;
              const row = db.tables.auth_refresh_tokens.get(token_hash);
              if (!row || row.realm !== realm || row.status !== "active") return { success: true, meta: { changes: 0 } };
              db.tables.auth_refresh_tokens.set(token_hash, { ...row, status: "rotated", rotated_at });
              return { success: true, meta: { changes: 1 } };
            }
            if (/^UPDATE auth_token_families SET refresh_generation/i.test(normalized)) {
              const [refresh_generation, last_rotated_at, realm, token_family_id] = args;
              const row = db.tables.auth_token_families.get(token_family_id);
              if (!row || row.realm !== realm) return { success: true, meta: { changes: 0 } };
              db.tables.auth_token_families.set(token_family_id, { ...row, refresh_generation, last_rotated_at });
              return { success: true, meta: { changes: 1 } };
            }
            if (/^UPDATE auth_token_families SET status = 'revoked'/i.test(normalized)) {
              const [revoked_at, realm, token_family_id] = args;
              const row = db.tables.auth_token_families.get(token_family_id);
              if (!row || row.realm !== realm) return { success: true, meta: { changes: 0 } };
              db.tables.auth_token_families.set(token_family_id, { ...row, status: "revoked", revoked_at });
              return { success: true, meta: { changes: 1 } };
            }
            if (/^UPDATE auth_refresh_tokens SET status = 'revoked'/i.test(normalized)) {
              const [revoked_at, realm, token_family_id] = args;
              let changes = 0;
              for (const [k, row] of db.tables.auth_refresh_tokens) {
                if (row.realm === realm && row.token_family_id === token_family_id && row.status === "active") {
                  db.tables.auth_refresh_tokens.set(k, { ...row, status: "revoked", revoked_at });
                  changes += 1;
                }
              }
              return { success: true, meta: { changes } };
            }
            if (/^UPDATE auth_access_tokens SET revoked_at/i.test(normalized)) {
              if (args.length === 3 && normalized.includes("token_hash")) {
                const [revoked_at, realm, token_hash] = args;
                const row = db.tables.auth_access_tokens.get(token_hash);
                if (!row || row.realm !== realm) return { success: true, meta: { changes: 0 } };
                db.tables.auth_access_tokens.set(token_hash, { ...row, revoked_at });
                return { success: true, meta: { changes: 1 } };
              }
              const [revoked_at, realm, token_family_id] = args;
              let changes = 0;
              for (const [k, row] of db.tables.auth_access_tokens) {
                if (row.realm === realm && row.token_family_id === token_family_id && !row.revoked_at) {
                  db.tables.auth_access_tokens.set(k, { ...row, revoked_at });
                  changes += 1;
                }
              }
              return { success: true, meta: { changes } };
            }
            if (/^UPDATE auth_connection_principals SET status = 'revoked'/i.test(normalized)) {
              const [revoked_at, realm, connection_id] = args;
              const row = db.tables.auth_connection_principals.get(connection_id);
              if (!row || row.realm !== realm) return { success: true, meta: { changes: 0 } };
              db.tables.auth_connection_principals.set(connection_id, { ...row, status: "revoked", revoked_at });
              return { success: true, meta: { changes: 1 } };
            }
            if (/^UPDATE auth_connection_principals SET tenant_id/i.test(normalized)) {
              const [tenant_id, realm, connection_id] = args;
              const row = db.tables.auth_connection_principals.get(connection_id);
              if (!row || row.realm !== realm) return { success: true, meta: { changes: 0 } };
              db.tables.auth_connection_principals.set(connection_id, { ...row, tenant_id });
              return { success: true, meta: { changes: 1 } };
            }
            if (/^UPDATE auth_authenticators SET status = 'revoked'/i.test(normalized)) {
              const [revoked_at, realm, authenticator_id] = args;
              const row = db.tables.auth_authenticators.get(authenticator_id);
              if (!row || row.realm !== realm) return { success: true, meta: { changes: 0 } };
              db.tables.auth_authenticators.set(authenticator_id, { ...row, status: "revoked", revoked_at });
              return { success: true, meta: { changes: 1 } };
            }
            if (/^UPDATE auth_authenticators SET status = 'replaced'/i.test(normalized)) {
              const [revoked_at, realm, authenticator_id] = args;
              const row = db.tables.auth_authenticators.get(authenticator_id);
              if (!row || row.realm !== realm) return { success: true, meta: { changes: 0 } };
              db.tables.auth_authenticators.set(authenticator_id, { ...row, status: "replaced", revoked_at });
              return { success: true, meta: { changes: 1 } };
            }
            if (/^UPDATE auth_wallet_accounts SET status = 'rotated'/i.test(normalized)) {
              const [rotated_at, address, realm, wallet_account_id] = args;
              const row = db.tables.auth_wallet_accounts.get(wallet_account_id);
              if (!row || row.realm !== realm) return { success: true, meta: { changes: 0 } };
              db.tables.auth_wallet_accounts.set(wallet_account_id, { ...row, status: "rotated", rotated_at, address });
              return { success: true, meta: { changes: 1 } };
            }
            if (/^UPDATE auth_tenant_memberships SET status = 'revoked'/i.test(normalized)) {
              const [authz_version, revoked_at, realm, account_id, tenant_id] = args;
              const key = `${realm}|${account_id}|${tenant_id}`;
              const row = db.tables.auth_tenant_memberships.get(key);
              if (!row) return { success: true, meta: { changes: 0 } };
              db.tables.auth_tenant_memberships.set(key, { ...row, status: "revoked", authz_version, revoked_at });
              return { success: true, meta: { changes: 1 } };
            }
            if (/^UPDATE auth_accounts SET authz_version/i.test(normalized)) {
              const [authz_version, realm, account_id] = args;
              const row = db.tables.auth_accounts.get(account_id);
              if (!row || row.realm !== realm) return { success: true, meta: { changes: 0 } };
              db.tables.auth_accounts.set(account_id, { ...row, authz_version });
              return { success: true, meta: { changes: 1 } };
            }
            if (/^UPDATE auth_accounts SET status/i.test(normalized)) {
              const [status, realm, account_id] = args;
              const row = db.tables.auth_accounts.get(account_id);
              if (!row || row.realm !== realm) return { success: true, meta: { changes: 0 } };
              db.tables.auth_accounts.set(account_id, { ...row, status });
              return { success: true, meta: { changes: 1 } };
            }
            if (/^UPDATE auth_authorization_codes SET status = 'expired'/i.test(normalized)) {
              const [realm, code_hash] = args;
              const row = db.tables.auth_authorization_codes.get(code_hash);
              if (!row || row.realm !== realm) return { success: true, meta: { changes: 0 } };
              db.tables.auth_authorization_codes.set(code_hash, { ...row, status: "expired" });
              return { success: true, meta: { changes: 1 } };
            }
            if (/^UPDATE auth_authorization_codes SET status = 'used'/i.test(normalized)) {
              const [used_at, realm, code_hash] = args;
              const row = db.tables.auth_authorization_codes.get(code_hash);
              if (!row || row.realm !== realm || row.status !== "unused") return { success: true, meta: { changes: 0 } };
              db.tables.auth_authorization_codes.set(code_hash, { ...row, status: "used", used_at });
              return { success: true, meta: { changes: 1 } };
            }
            throw new Error(`Unexpected run SQL: ${normalized}`);
          },
          async first() {
            if (/SELECT \* FROM auth_accounts WHERE realm = \? AND account_id = \?/i.test(normalized)) {
              const [realm, account_id] = args;
              const row = db.tables.auth_accounts.get(account_id);
              return row && row.realm === realm ? clone(row) : null;
            }
            if (/SELECT \* FROM auth_tenant_memberships WHERE realm = \? AND account_id = \? AND tenant_id = \?/i.test(normalized)) {
              const [realm, account_id, tenant_id] = args;
              const row = db.tables.auth_tenant_memberships.get(`${realm}|${account_id}|${tenant_id}`);
              if (!row) return null;
              if (/status = 'active'/i.test(normalized) && row.status !== "active") return null;
              return clone(row);
            }
            if (/SELECT \* FROM auth_tenants WHERE realm = \? AND tenant_id = \?/i.test(normalized)) {
              const [realm, tenant_id] = args;
              const row = db.tables.auth_tenants.get(tenant_id);
              return row && row.realm === realm ? clone(row) : null;
            }
            if (/SELECT \* FROM auth_refresh_tokens WHERE realm = \? AND token_hash = \?/i.test(normalized)) {
              const [realm, token_hash] = args;
              const row = db.tables.auth_refresh_tokens.get(token_hash);
              return row && row.realm === realm ? clone(row) : null;
            }
            if (/SELECT \* FROM auth_access_tokens WHERE realm = \? AND token_hash = \?/i.test(normalized)) {
              const [realm, token_hash] = args;
              const row = db.tables.auth_access_tokens.get(token_hash);
              return row && row.realm === realm ? clone(row) : null;
            }
            if (/SELECT \* FROM auth_token_families WHERE realm = \? AND token_family_id = \?/i.test(normalized)) {
              const [realm, token_family_id] = args;
              const row = db.tables.auth_token_families.get(token_family_id);
              return row && row.realm === realm ? clone(row) : null;
            }
            if (/SELECT \* FROM auth_connection_principals WHERE realm = \? AND connection_id = \?/i.test(normalized)) {
              const [realm, connection_id] = args;
              const row = db.tables.auth_connection_principals.get(connection_id);
              return row && row.realm === realm ? clone(row) : null;
            }
            if (/SELECT \* FROM auth_authenticators WHERE realm = \? AND authenticator_id = \?/i.test(normalized)) {
              const [realm, authenticator_id, account_id] = args;
              const row = db.tables.auth_authenticators.get(authenticator_id);
              if (!row || row.realm !== realm) return null;
              if (account_id && row.account_id !== account_id) return null;
              return clone(row);
            }
            if (/SELECT \* FROM auth_routing_aliases WHERE realm = \? AND alias = \?/i.test(normalized)) {
              const [realm, alias] = args;
              const row = db.tables.auth_routing_aliases.get(`${realm}|${alias}`);
              return row ? clone(row) : null;
            }
            if (/SELECT \* FROM auth_authorization_codes WHERE realm = \? AND code_hash = \?/i.test(normalized)) {
              const [realm, code_hash] = args;
              const row = db.tables.auth_authorization_codes.get(code_hash);
              return row && row.realm === realm ? clone(row) : null;
            }
            if (/SELECT status FROM auth_canary_admissions WHERE realm = \? AND connection_id = \?/i.test(normalized)) {
              const [realm, connection_id] = args;
              const row = db.tables.auth_canary_admissions.get(`${realm}|${connection_id}`);
              return row && row.realm === realm ? { status: row.status } : null;
            }
            if (/SELECT session_id,profile,hydrated_tool_ids_json/i.test(normalized)) {
              const [sessionId] = args;
              return db.tables.mcp_core_sessions.get(sessionId) || null;
            }
            throw new Error(`Unexpected first SQL: ${normalized}`);
          },
          async all() {
            if (/SELECT token_family_id FROM auth_token_families WHERE realm = \? AND connection_id = \? AND status = 'active'/i.test(normalized)) {
              const [realm, connection_id] = args;
              const results = [];
              for (const row of db.tables.auth_token_families.values()) {
                if (row.realm === realm && row.connection_id === connection_id && row.status === "active") {
                  results.push({ token_family_id: row.token_family_id });
                }
              }
              return { results };
            }
            if (/SELECT token_family_id FROM auth_token_families[\s\S]*origin_authenticator_id/i.test(normalized)) {
              const [realm, authenticator_id] = args;
              const results = [];
              for (const row of db.tables.auth_token_families.values()) {
                if (row.realm === realm && row.origin_authenticator_id === authenticator_id && row.status === "active") {
                  results.push({ token_family_id: row.token_family_id });
                }
              }
              return { results };
            }
            throw new Error(`Unexpected all SQL: ${normalized}`);
          }
        };
      }
    };
  }
}

function envFor(db, extra = {}) {
  return {
    CAIRNSTONE_DB: db,
    CORE_AUTH_RESOURCE: RESOURCE,
    CORE_AUTH_ISSUER: ISSUER,
    CORE_AUTH_ENFORCEMENT: "canary",
    ...extra
  };
}

function urlFor(path = "/mcp/core-auth") {
  return new URL(`https://cairnstone.test${path}`);
}

async function bootPair(db, { admitCanary = true, clientFamily = "perplexity", aliases = [] } = {}) {
  const env = envFor(db);
  return bootstrapAccountConnection(env, {
    clientFamily,
    routingAliases: aliases,
    resource: RESOURCE,
    admitCanary,
    canaryLabel: clientFamily === "perplexity" ? "second-perplexity-first" : "canary"
  });
}

test("resolveEnforcementMode coerces required→canary in 10i.1", () => {
  assert.equal(resolveEnforcementMode({ CORE_AUTH_ENFORCEMENT: "off" }), "off");
  assert.equal(resolveEnforcementMode({ CORE_AUTH_ENFORCEMENT: "shadow" }), "shadow");
  assert.equal(resolveEnforcementMode({ CORE_AUTH_ENFORCEMENT: "canary" }), "canary");
  assert.equal(resolveEnforcementMode({ CORE_AUTH_ENFORCEMENT: "required" }), "canary");
});

test("NF-40 authenticator method/assurance mismatch rejected", () => {
  const bad = validateAuthenticatorPair("wallet_proof", "oidc");
  assert.equal(bad.ok, false);
  assert.equal(bad.error, "authenticator_method_assurance_mismatch");
  assert.equal(validateAuthenticatorPair("wallet_proof", "wallet_ownership").ok, true);
});

test("P-01 bootstrap creates account-root graph + token family (no spend)", async () => {
  const db = new FakeAuthD1();
  const boot = await bootPair(db, { aliases: ["perplexity-2:chat"] });
  assert.equal(boot.ok, true);
  assert.equal(boot.account.schema, ACCOUNT_SCHEMA);
  assert.match(boot.account.account_id, /^acct_/);
  assert.match(boot.account.home_tenant_id, /^ten_/);
  assert.equal(boot.authenticator.schema, AUTHENTICATOR_SCHEMA);
  assert.equal(boot.connection.schema, CONNECTION_PRINCIPAL_SCHEMA);
  assert.equal(boot.token_family.schema, TOKEN_FAMILY_SCHEMA);
  assert.equal(boot.spend_authority, false);
  assert.equal(boot.economic_grant, false);
  assert.equal(boot.wallet_account_id.startsWith("walacct_"), true);
  assert.equal(boot.access_token.startsWith("csat_"), true);
  assert.equal(boot.refresh_token.startsWith("csrt_"), true);
});

test("NF-01 unauthenticated protected tools/call → 401 + WWW-Authenticate", async () => {
  const db = new FakeAuthD1();
  const env = envFor(db, { CORE_AUTH_ENFORCEMENT: "canary" });
  const request = new Request("https://cairnstone.test/mcp/core-auth", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "cairnstone_health", arguments: {} }
    })
  });
  const response = await worker.fetch(request, env);
  assert.equal(response.status, 401);
  const www = response.headers.get("WWW-Authenticate") || "";
  assert.match(www, /Bearer/i);
  assert.match(www, /resource_metadata/i);
  assert.match(www, /oauth-protected-resource/);
  const body = await response.json();
  assert.equal(body.ok, false);
  assert.equal(body.residual_risk_stolen_bearer_replay, "documented_not_solved");
});

test("off ladder: discovery OK, protected tools/call fail closed", async () => {
  const db = new FakeAuthD1();
  const env = envFor(db, { CORE_AUTH_ENFORCEMENT: "off" });
  const get = await worker.fetch(new Request("https://cairnstone.test/mcp/core-auth"), env);
  assert.equal(get.status, 200);
  const discovery = await get.json();
  assert.equal(discovery.enforcement, "off");

  const post = await worker.fetch(new Request("https://cairnstone.test/mcp/core-auth", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer csat_deadbeef" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "cairnstone_health", arguments: {} } })
  }), env);
  assert.equal(post.status, 401);
});

test("NF-02 foreign provider token rejected", async () => {
  const db = new FakeAuthD1();
  const env = envFor(db);
  const result = await validateAccessToken(env, "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.foreign.perplexity", {
    expectedResource: RESOURCE,
    url: urlFor()
  });
  assert.equal(result.ok, false);
  assert.equal(result.status, 401);
});

test("NF-03 cross-resource token rejected", async () => {
  const db = new FakeAuthD1();
  const boot = await bootPair(db);
  const result = await validateAccessToken(envFor(db), boot.access_token, {
    expectedResource: "https://cairnstone.test/mcp-b",
    url: urlFor("/mcp-b")
  });
  assert.equal(result.ok, false);
  assert.equal(result.status, 401);
});

test("NF-27 /mcp-b as auth audience rejected; legacy mcp-b still serves", async () => {
  const db = new FakeAuthD1();
  const env = envFor(db);
  const boot = await bootPair(db);
  // Force-resource rewrite simulation: token bound to mcp-b must fail validate
  const bad = await validateAccessToken(env, boot.access_token, {
    expectedResource: "https://cairnstone.test/mcp-b"
  });
  assert.equal(bad.ok, false);

  const legacy = await worker.fetch(new Request("https://cairnstone.test/mcp-b", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} })
  }), env);
  assert.equal(legacy.status, 200);
  const body = await legacy.json();
  assert.equal(body.result.serverInfo.name, "cairnstone-v6");
});

test("NF-05 same-provider collision → distinct connection/principal", async () => {
  const db = new FakeAuthD1();
  const a = await bootPair(db, { clientFamily: "perplexity", aliases: ["perplexity:chat"] });
  const b = await bootPair(db, { clientFamily: "perplexity", aliases: ["perplexity-2:chat"] });
  assert.equal(a.ok, true);
  assert.equal(b.ok, true);
  assert.notEqual(a.connection.connection_id, b.connection.connection_id);
  assert.notEqual(a.connection.principal_id, b.connection.principal_id);
  assert.notEqual(a.account.account_id, b.account.account_id);
});

test("NF-06 alias claim race: second claim 403, no rewrite", async () => {
  const db = new FakeAuthD1();
  const a = await bootPair(db, { aliases: ["perplexity:chat"] });
  assert.equal(a.ok, true);
  const conflict = await claimRoutingAlias(db, {
    alias: "perplexity:chat",
    principalId: "prin_other",
    accountId: "acct_other",
    tenantId: "ten_other"
  });
  assert.equal(conflict.ok, false);
  assert.equal(conflict.status, 403);
});

test("NF-07/NF-08/NF-13 caller assertion + account_id spoof → 403", () => {
  const ctx = {
    account_id: "acct_a",
    tenant_id: "ten_a",
    connection_id: "conn_a",
    principal_id: "prin_a"
  };
  assert.equal(assertCallerIdentity({ from: "prin_b" }, ctx).ok, false);
  assert.equal(assertCallerIdentity({ recipient_id: "prin_b" }, ctx).ok, false);
  assert.equal(assertCallerIdentity({ account_id: "acct_b" }, ctx).error, "caller_identity_mismatch");
  assert.equal(assertCallerIdentity({ from: "prin_a" }, ctx).ok, true);
  // NF-39: target selectors are not caller identity
  assert.equal(assertCallerIdentity({ to: "prin_b", assignee_actor_id: "prin_b" }, ctx).ok, true);
});

test("NF-12 legacyMustNotQueryAuth firewall", () => {
  assert.equal(sqlTouchesAuthTables("SELECT * FROM auth_accounts"), true);
  assert.equal(legacyMustNotQueryAuth("SELECT * FROM auth_token_families").ok, false);
  assert.equal(legacyMustNotQueryAuth("SELECT * FROM stones").ok, true);
});

test("NF-14 refresh reuse revokes family", async () => {
  const db = new FakeAuthD1();
  const boot = await bootPair(db);
  const first = await rotateRefreshToken(envFor(db), boot.refresh_token, { expectedResource: RESOURCE });
  assert.equal(first.ok, true);
  const replay = await rotateRefreshToken(envFor(db), boot.refresh_token, { expectedResource: RESOURCE });
  assert.equal(replay.ok, false);
  assert.equal(replay.family_revoked, true);
  const oldAccess = await validateAccessToken(envFor(db), boot.access_token, { expectedResource: RESOURCE });
  // Original access may still be within TTL until family revoke marks it — revokeTokenFamily sets revoked_at
  assert.equal(oldAccess.ok, false);
});

test("NF-15 revocation isolation: revoke A leaves B live", async () => {
  const db = new FakeAuthD1();
  const a = await bootPair(db, { aliases: ["perplexity:chat"] });
  const b = await bootPair(db, { aliases: ["perplexity-2:chat"] });
  await revokeConnection(envFor(db), a.connection.connection_id);
  const aCheck = await validateAccessToken(envFor(db), a.access_token, { expectedResource: RESOURCE });
  const bCheck = await validateAccessToken(envFor(db), b.access_token, { expectedResource: RESOURCE });
  assert.equal(aCheck.ok, false);
  assert.equal(bCheck.ok, true);
});

test("NF-16 reinstall under same account: new connection, same home pointers", async () => {
  const db = new FakeAuthD1();
  const first = await bootPair(db);
  const second = await bootstrapAccountConnection(envFor(db), {
    clientFamily: "perplexity",
    existingAccountId: first.account.account_id,
    selectTenantId: first.account.home_tenant_id,
    resource: RESOURCE,
    admitCanary: true
  });
  assert.equal(second.ok, true);
  assert.equal(second.account.account_id, first.account.account_id);
  assert.equal(second.account.home_workspace_id, first.account.home_workspace_id);
  assert.equal(second.account.home_code_session_id, first.account.home_code_session_id);
  assert.notEqual(second.connection.connection_id, first.connection.connection_id);
  assert.notEqual(second.connection.principal_id, first.connection.principal_id);
});

test("NF-17 wallet rotation keeps account_id; authenticator replaced", async () => {
  const db = new FakeAuthD1();
  const boot = await bootPair(db);
  const denied = await replaceAuthenticator(envFor(db), {
    accountId: boot.account.account_id,
    previousAuthenticatorId: boot.authenticator.authenticator_id,
    method: "wallet_proof",
    assuranceClass: "wallet_ownership",
    stepUpConfirmed: false
  });
  assert.equal(denied.status, 403);
  const replaced = await replaceAuthenticator(envFor(db), {
    accountId: boot.account.account_id,
    previousAuthenticatorId: boot.authenticator.authenticator_id,
    method: "wallet_proof",
    assuranceClass: "wallet_ownership",
    stepUpConfirmed: true
  });
  assert.equal(replaced.ok, true);
  assert.equal(replaced.account_id_unchanged, true);
  assert.notEqual(replaced.authenticator_id, boot.authenticator.authenticator_id);
});

test("NF-18 zero-balance auth has no spend/economic grant", async () => {
  const db = new FakeAuthD1();
  const boot = await bootPair(db);
  assert.equal(boot.spend_authority, false);
  assert.equal(boot.economic_grant, false);
  const wallet = [...db.tables.auth_wallet_accounts.values()][0];
  assert.equal(wallet.balance_units, 0);
});

test("NF-19/NF-20 CIMD SSRF + redirect denied", async () => {
  assert.equal(isPrivateOrLinkLocalHostname("169.254.169.254"), true);
  assert.equal(validateCimdClientIdUrl("http://example.com/client.json").ok, false);
  assert.equal(validateCimdClientIdUrl("https://169.254.169.254/latest").error, "cimd_ssrf_denied");

  const redirected = await fetchCimdDocument("https://example.com/client.json", {
    fetchImpl: async () => new Response(null, { status: 302, headers: { Location: "http://127.0.0.1/" } })
  });
  assert.equal(redirected.error, "cimd_redirect_denied");
});

test("NF-21 audit events strip secret-like keys", async () => {
  const db = new FakeAuthD1();
  await bootPair(db);
  for (const event of db.tables.auth_audit_events.values()) {
    assert.doesNotMatch(event.detail_json, /csat_|csrt_|code_verifier|"token":/);
  }
});

test("NF-22 hydration identity propagation via CORE_AUTH_CONTEXT", async () => {
  const db = new FakeAuthD1();
  const boot = await bootPair(db);
  const env = envFor(db);
  const validated = await validateAccessToken(env, boot.access_token, { expectedResource: RESOURCE });
  assert.equal(validated.ok, true);
  const rpc = await handleMcpRpc({
    jsonrpc: "2.0",
    id: 7,
    method: "tools/call",
    params: { name: "cairnstone_health", arguments: {} }
  }, env, { core: true, auth: true, authContext: validated.context });
  assert.equal(rpc.result.isError, false);
  // Context remains available on env for brokered invokeTool continuity.
  const envWithCtx = { ...env, CORE_AUTH_CONTEXT: validated.context };
  assert.equal(envWithCtx.CORE_AUTH_CONTEXT.principal_id, boot.connection.principal_id);
});

test("NF-25 stolen same-resource bearer still validates until TTL/revoke (residual risk)", async () => {
  const db = new FakeAuthD1();
  const boot = await bootPair(db);
  const stolen = await validateAccessToken(envFor(db), boot.access_token, { expectedResource: RESOURCE });
  assert.equal(stolen.ok, true);
  assert.equal(stolen.residual_risk_stolen_bearer_replay, true);
  const meta = protectedResourceMetadata(envFor(db), urlFor());
  assert.equal(meta.residual_risk.stolen_same_resource_bearer_replay, "not_solved");
});

test("NF-26 DCR rejected when flag off", async () => {
  const result = await handleOauthRegisterRequest({ client_name: "x" }, envFor(new FakeAuthD1()));
  assert.equal(result.ok, false);
  assert.equal(result.status, 403);
});

test("NF-28 authenticator replacement without step-up → 403", async () => {
  const db = new FakeAuthD1();
  const boot = await bootPair(db);
  const result = await revokeAuthenticator(envFor(db), boot.authenticator.authenticator_id, { stepUpConfirmed: false });
  assert.equal(result.status, 403);
});

test("NF-29/NF-30 auth code replay + PKCE mismatch", async () => {
  const db = new FakeAuthD1();
  const boot = await bootPair(db);
  const verifier = "verifier_" + "a".repeat(43);
  const challenge = await pkceChallengeS256(verifier);
  const code = await createAuthorizationCode(envFor(db), {
    accountId: boot.account.account_id,
    tenantId: boot.account.home_tenant_id,
    authenticatorId: boot.authenticator.authenticator_id,
    clientId: "https://client.example/cimd.json",
    redirectUri: "https://client.example/cb",
    codeChallenge: challenge,
    resource: RESOURCE,
    iss: ISSUER
  });
  assert.equal(code.ok, true);

  const badPkce = await redeemAuthorizationCode(envFor(db), {
    code: code.code,
    codeVerifier: "wrong_verifier_xxxxxxxxxxxxxxxxxxxxxxx",
    redirectUri: "https://client.example/cb",
    clientId: "https://client.example/cimd.json",
    resource: RESOURCE,
    expectedIss: ISSUER
  });
  assert.equal(badPkce.ok, false);
  assert.equal(badPkce.reason, "pkce_mismatch");

  // Recreate unused code for redeem success then replay
  const code2 = await createAuthorizationCode(envFor(db), {
    accountId: boot.account.account_id,
    tenantId: boot.account.home_tenant_id,
    authenticatorId: boot.authenticator.authenticator_id,
    clientId: "https://client.example/cimd.json",
    redirectUri: "https://client.example/cb",
    codeChallenge: challenge,
    resource: RESOURCE,
    iss: ISSUER
  });
  const first = await redeemAuthorizationCode(envFor(db), {
    code: code2.code,
    codeVerifier: verifier,
    redirectUri: "https://client.example/cb",
    clientId: "https://client.example/cimd.json",
    resource: RESOURCE,
    expectedIss: ISSUER
  });
  assert.equal(first.ok, true);
  const second = await redeemAuthorizationCode(envFor(db), {
    code: code2.code,
    codeVerifier: verifier,
    redirectUri: "https://client.example/cb",
    clientId: "https://client.example/cimd.json",
    resource: RESOURCE,
    expectedIss: ISSUER
  });
  assert.equal(second.ok, false);
  assert.equal(second.error, "invalid_grant");
});

test("NF-04 issuer mix-up rejects token issuance", async () => {
  const db = new FakeAuthD1();
  const boot = await bootPair(db);
  const verifier = "verifier_" + "b".repeat(43);
  const challenge = await pkceChallengeS256(verifier);
  const code = await createAuthorizationCode(envFor(db), {
    accountId: boot.account.account_id,
    tenantId: boot.account.home_tenant_id,
    authenticatorId: boot.authenticator.authenticator_id,
    clientId: "client",
    redirectUri: "https://client.example/cb",
    codeChallenge: challenge,
    resource: RESOURCE,
    iss: ISSUER
  });
  const mixup = await handleOauthTokenRequest({
    grant_type: "authorization_code",
    code: code.code,
    code_verifier: verifier,
    redirect_uri: "https://client.example/cb",
    client_id: "client",
    resource: RESOURCE,
    iss: "https://evil.example/oauth"
  }, envFor(db), urlFor());
  assert.equal(mixup.ok, false);
  assert.equal(mixup.reason, "issuer_mixup");
});

test("NF-31 token-family substitution blocked by principal bind", async () => {
  const db = new FakeAuthD1();
  const a = await bootPair(db);
  const b = await bootPair(db);
  // Mutate access token row to point at sibling principal (attack simulation)
  const tokenHash = [...db.tables.auth_access_tokens.keys()][0];
  const row = db.tables.auth_access_tokens.get(tokenHash);
  db.tables.auth_access_tokens.set(tokenHash, {
    ...row,
    principal_id: b.connection.principal_id,
    connection_id: b.connection.connection_id
  });
  const result = await validateAccessToken(envFor(db), a.access_token, { expectedResource: RESOURCE });
  assert.equal(result.ok, false);
});

test("NF-32/NF-38 tenant mismatch + multi-tenant join", async () => {
  const db = new FakeAuthD1();
  const boot = await bootPair(db);
  const t2 = "ten_" + "x".repeat(20);
  const joined = await joinTenant(envFor(db), { accountId: boot.account.account_id, tenantId: t2 });
  assert.equal(joined.ok, true);
  assert.equal(joined.account_id_unchanged, true);

  const denied = await bindConnectionTenant(envFor(db), {
    connectionId: boot.connection.connection_id,
    tenantId: "ten_notamember0001"
  });
  assert.equal(denied.status, 403);

  const bound = await bindConnectionTenant(envFor(db), {
    connectionId: boot.connection.connection_id,
    tenantId: t2
  });
  assert.equal(bound.ok, true);
  assert.equal(bound.account_id, boot.account.account_id);
});

test("NF-33 suspended account → 403", async () => {
  const db = new FakeAuthD1();
  const boot = await bootPair(db);
  const account = db.tables.auth_accounts.get(boot.account.account_id);
  db.tables.auth_accounts.set(boot.account.account_id, { ...account, status: "suspended" });
  const result = await validateAccessToken(envFor(db), boot.access_token, { expectedResource: RESOURCE });
  assert.equal(result.ok, false);
  assert.equal(result.status, 403);
});

test("NF-34 compromised authenticator revokes originated families", async () => {
  const db = new FakeAuthD1();
  const boot = await bootPair(db);
  const revoked = await revokeAuthenticator(envFor(db), boot.authenticator.authenticator_id, { stepUpConfirmed: true });
  assert.equal(revoked.ok, true);
  const check = await validateAccessToken(envFor(db), boot.access_token, { expectedResource: RESOURCE });
  assert.equal(check.ok, false);
});

test("NF-35 stale authz_version fail-closed after membership revoke", async () => {
  const db = new FakeAuthD1();
  const boot = await bootPair(db);
  await bumpAuthzVersion(envFor(db), {
    accountId: boot.account.account_id,
    tenantId: boot.account.home_tenant_id
  });
  const result = await validateAccessToken(envFor(db), boot.access_token, { expectedResource: RESOURCE });
  assert.equal(result.ok, false);
  assert.equal(result.error, "stale_authz_version");
});

test("NF-36 redirect URI mismatch on redeem", async () => {
  const db = new FakeAuthD1();
  const boot = await bootPair(db);
  const verifier = "verifier_" + "c".repeat(43);
  const challenge = await pkceChallengeS256(verifier);
  const code = await createAuthorizationCode(envFor(db), {
    accountId: boot.account.account_id,
    tenantId: boot.account.home_tenant_id,
    authenticatorId: boot.authenticator.authenticator_id,
    clientId: "client",
    redirectUri: "https://client.example/cb",
    codeChallenge: challenge,
    resource: RESOURCE,
    iss: ISSUER
  });
  const bad = await redeemAuthorizationCode(envFor(db), {
    code: code.code,
    codeVerifier: verifier,
    redirectUri: "https://evil.example/cb",
    clientId: "client",
    resource: RESOURCE,
    expectedIss: ISSUER
  });
  assert.equal(bad.ok, false);
});

test("canary admission: non-selected connection denied; selected allowed", async () => {
  const db = new FakeAuthD1();
  const admitted = await bootPair(db, { admitCanary: true });
  const stranger = await bootPair(db, { admitCanary: false, aliases: [] });
  const env = envFor(db, { CORE_AUTH_ENFORCEMENT: "canary" });

  const okGate = await enforceCoreAuthRequest(new Request(RESOURCE, {
    method: "POST",
    headers: { authorization: `Bearer ${admitted.access_token}` },
    body: "{}"
  }), env, urlFor(), { isProtectedToolCall: true });
  assert.equal(okGate.ok, true);

  const denied = await enforceCoreAuthRequest(new Request(RESOURCE, {
    method: "POST",
    headers: { authorization: `Bearer ${stranger.access_token}` },
    body: "{}"
  }), env, urlFor(), { isProtectedToolCall: true });
  assert.equal(denied.ok, false);
  assert.equal(denied.status, 403);
  assert.equal(denied.body.error, "canary_not_admitted");
});

test("shadow mode requires auth but does not require canary admission", async () => {
  const db = new FakeAuthD1();
  const boot = await bootPair(db, { admitCanary: false });
  const env = envFor(db, { CORE_AUTH_ENFORCEMENT: "shadow" });
  const gate = await enforceCoreAuthRequest(new Request(RESOURCE, {
    method: "POST",
    headers: { authorization: `Bearer ${boot.access_token}` },
    body: "{}"
  }), env, urlFor(), { isProtectedToolCall: true });
  assert.equal(gate.ok, true);
  assert.equal(gate.enforcement, "shadow");
});

test("authenticated tools/call succeeds on core-auth canary", async () => {
  const db = new FakeAuthD1();
  const boot = await bootPair(db, { admitCanary: true });
  const env = envFor(db, { CORE_AUTH_ENFORCEMENT: "canary" });
  const response = await worker.fetch(new Request("https://cairnstone.test/mcp/core-auth", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${boot.access_token}`
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "cairnstone_health", arguments: {} }
    })
  }), env);
  assert.equal(response.status, 200);
  const body = await response.json();
  const tool = JSON.parse(body.result.content[0].text);
  assert.equal(tool.ok, true);
  assert.equal(tool.version, "0.5.43");
});

test("legacy /mcp and /mcp/core unchanged and do not touch auth_*", async () => {
  const db = new FakeAuthD1();
  const env = envFor(db);
  const before = db.authQueryCount;
  const legacy = await worker.fetch(new Request("https://cairnstone.test/mcp", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} })
  }), env);
  assert.equal(legacy.status, 200);
  const core = await worker.fetch(new Request("https://cairnstone.test/mcp/core", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} })
  }), env);
  assert.equal(core.status, 200);
  assert.equal(db.authQueryCount, before);
});

test("PRM well-known publishes residual risk + resource", async () => {
  const env = envFor(new FakeAuthD1());
  const response = await worker.fetch(new Request("https://cairnstone.test/.well-known/oauth-protected-resource/mcp/core-auth"), env);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.resource, RESOURCE);
  assert.equal(body.residual_risk.stolen_same_resource_bearer_replay, "not_solved");
});

test("VERSION remains 0.5.43 (no runtime bump)", async () => {
  const env = envFor(new FakeAuthD1());
  const response = await worker.fetch(new Request("https://cairnstone.test/health"), env);
  const body = await response.json();
  assert.equal(body.version, "0.5.43");
  assert.equal(body.mcp_core_auth, "/mcp/core-auth");
});
