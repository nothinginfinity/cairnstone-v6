// Shared FakeAuthD1 for cairnstone-v6 OAuth/auth unit tests.
// Covers core-auth tables plus Messages OAuth Issue 2 user-auth tables.

export function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

export class FakeAuthD1 {
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
      auth_oauth_clients: new Map(),
      auth_dcr_rate_buckets: new Map(),
      auth_canary_admissions: new Map(),
      auth_audit_events: new Map(),
      mcp_core_sessions: new Map(),
      // Messages OAuth Issue 2
      auth_passkeys: new Map(),
      auth_webauthn_challenges: new Map(),
      auth_login_invites: new Map(),
      auth_login_invite_rate_buckets: new Map(),
      auth_authorize_sessions: new Map()
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
      case "auth_oauth_clients": return row.client_id;
      case "auth_dcr_rate_buckets": return `${row.realm}|${row.bucket_key}`;
      case "auth_canary_admissions": return `${row.realm}|${row.connection_id}`;
      case "auth_audit_events": return row.event_id;
      case "mcp_core_sessions": return row.session_id;
      case "auth_passkeys": return row.credential_id;
      case "auth_webauthn_challenges": return row.challenge_hash;
      case "auth_login_invites": return row.invite_hash;
      case "auth_login_invite_rate_buckets": return `${row.realm}|${row.bucket_key}`;
      case "auth_authorize_sessions": return row.session_id;
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
              // oauth-user-auth hardcodes method/assurance; core-auth binds them.
              if (/'other_approved'/i.test(normalized) && args.length === 5) {
                const [authenticator_id, schema, realm, account_id, created_at] = args;
                db.tables.auth_authenticators.set(authenticator_id, {
                  authenticator_id, schema, realm, account_id, method: "other_approved", status: "active",
                  assurance_class: "other_approved", wallet_account_id: null, created_at, revoked_at: null,
                  accepted_state_authority: 0
                });
                return { success: true, meta: { changes: 1 } };
              }
              if (/'passkey_webauthn'/i.test(normalized) && args.length === 5) {
                const [authenticator_id, schema, realm, account_id, created_at] = args;
                db.tables.auth_authenticators.set(authenticator_id, {
                  authenticator_id, schema, realm, account_id, method: "passkey_webauthn", status: "active",
                  assurance_class: "webauthn", wallet_account_id: null, created_at, revoked_at: null,
                  accepted_state_authority: 0
                });
                return { success: true, meta: { changes: 1 } };
              }
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
              // Old: 15 bind args. New (Issue 2): step_up_confirmed as last arg (16 total).
              const [
                code_hash, realm, account_id, tenant_id, connection_id, principal_id, authenticator_id,
                client_id, redirect_uri, code_challenge, resource, scopes_json, iss, expires_at, created_at
              ] = args;
              const step_up_confirmed = args.length >= 16 ? (Number(args[15]) === 1 ? 1 : 0) : 0;
              db.tables.auth_authorization_codes.set(code_hash, {
                code_hash, realm, account_id, tenant_id, connection_id, principal_id, authenticator_id,
                client_id, redirect_uri, code_challenge, code_challenge_method: "S256", resource, scopes_json,
                iss, status: "unused", expires_at, created_at, used_at: null, step_up_confirmed
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
            if (/^INSERT INTO auth_oauth_clients/i.test(normalized)) {
              const [
                client_id, realm, client_name, software_id, redirect_uris_json,
                grant_types_json, response_types_json, application_type, created_at
              ] = args;
              db.tables.auth_oauth_clients.set(client_id, {
                client_id,
                realm,
                registration_type: "dcr",
                client_name,
                software_id,
                redirect_uris_json,
                grant_types_json,
                response_types_json,
                token_endpoint_auth_method: "none",
                application_type,
                status: "active",
                created_at,
                revoked_at: null,
                accepted_state_authority: 0
              });
              return { success: true, meta: { changes: 1 } };
            }
            if (/^INSERT INTO auth_dcr_rate_buckets/i.test(normalized)) {
              const [realm, bucket_key, window_start_iso, count] = args;
              const key = `${realm}|${bucket_key}`;
              db.tables.auth_dcr_rate_buckets.set(key, {
                realm,
                bucket_key,
                window_start_iso,
                count
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

            // --- Messages OAuth Issue 2 inserts ---
            if (/^INSERT INTO auth_login_invites/i.test(normalized)) {
              const [
                invite_hash, realm, invite_id, target_account_id, target_tenant_id, issued_by,
                expires_at, created_at
              ] = args;
              db.tables.auth_login_invites.set(invite_hash, {
                invite_hash, realm, invite_id, target_account_id, target_tenant_id, issued_by,
                status: "unused", expires_at, created_at, redeemed_at: null, redeemed_by_session_id: null,
                accepted_state_authority: 0
              });
              return { success: true, meta: { changes: 1 } };
            }
            if (/^INSERT INTO auth_login_invite_rate_buckets/i.test(normalized)) {
              // COUNT may be bind arg or SQL literal `1`.
              const [realm, bucket_key, window_start_iso] = args;
              const count = args.length >= 4 ? args[3] : 1;
              const key = `${realm}|${bucket_key}`;
              db.tables.auth_login_invite_rate_buckets.set(key, {
                realm, bucket_key, window_start_iso, count
              });
              return { success: true, meta: { changes: 1 } };
            }
            if (/^INSERT INTO auth_authorize_sessions/i.test(normalized)) {
              const [
                session_id, realm, session_token_hash, client_id, client_name, redirect_uri, code_challenge,
                resource, scopes_json, state, iss, cimd_content_hash, expires_at, created_at
              ] = args;
              db.tables.auth_authorize_sessions.set(session_id, {
                session_id, realm, session_token_hash, client_id, client_name, redirect_uri, code_challenge,
                code_challenge_method: "S256", resource, scopes_json, state, iss, cimd_content_hash,
                status: "pending_auth", account_id: null, tenant_id: null, authenticator_id: null,
                auth_method: null, step_up_confirmed: 0, offer_passkey_enroll: 0,
                expires_at, created_at, authenticated_at: null, completed_at: null,
                accepted_state_authority: 0
              });
              return { success: true, meta: { changes: 1 } };
            }
            if (/^INSERT INTO auth_webauthn_challenges/i.test(normalized)) {
              const [challenge_hash, realm, purpose, session_id, account_id, expires_at, created_at] = args;
              db.tables.auth_webauthn_challenges.set(challenge_hash, {
                challenge_hash, realm, purpose, session_id, account_id, status: "unused",
                expires_at, created_at, used_at: null, accepted_state_authority: 0
              });
              return { success: true, meta: { changes: 1 } };
            }
            if (/^INSERT INTO auth_passkeys/i.test(normalized)) {
              const [
                credential_id, realm, account_id, authenticator_id, public_key_jwk_json, sign_count,
                user_handle, created_at
              ] = args;
              db.tables.auth_passkeys.set(credential_id, {
                credential_id, realm, account_id, authenticator_id, public_key_jwk_json,
                sign_count: Number(sign_count) || 0, transports_json: "[]", user_handle,
                created_at, last_used_at: null, status: "active", accepted_state_authority: 0
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

            // --- Messages OAuth Issue 2 updates ---
            if (/^UPDATE auth_login_invite_rate_buckets SET count/i.test(normalized)) {
              const [count, realm, bucket_key] = args;
              const key = `${realm}|${bucket_key}`;
              const row = db.tables.auth_login_invite_rate_buckets.get(key);
              if (!row || row.realm !== realm) return { success: true, meta: { changes: 0 } };
              db.tables.auth_login_invite_rate_buckets.set(key, { ...row, count });
              return { success: true, meta: { changes: 1 } };
            }
            if (/^UPDATE auth_authorize_sessions SET status = 'expired'/i.test(normalized)) {
              const [realm, session_id] = args;
              const row = db.tables.auth_authorize_sessions.get(session_id);
              if (!row || row.realm !== realm) return { success: true, meta: { changes: 0 } };
              if (row.status !== "pending_auth" && row.status !== "authenticated") {
                return { success: true, meta: { changes: 0 } };
              }
              db.tables.auth_authorize_sessions.set(session_id, { ...row, status: "expired" });
              return { success: true, meta: { changes: 1 } };
            }
            if (/^UPDATE auth_authorize_sessions\s+SET status = 'authenticated'/i.test(normalized)) {
              const [
                account_id, tenant_id, authenticator_id, auth_method, step_up_confirmed,
                offer_passkey_enroll, authenticated_at, realm, session_id
              ] = args;
              const row = db.tables.auth_authorize_sessions.get(session_id);
              if (!row || row.realm !== realm || row.status !== "pending_auth") {
                return { success: true, meta: { changes: 0 } };
              }
              db.tables.auth_authorize_sessions.set(session_id, {
                ...row,
                status: "authenticated",
                account_id,
                tenant_id,
                authenticator_id,
                auth_method,
                step_up_confirmed: Number(step_up_confirmed) === 1 ? 1 : 0,
                offer_passkey_enroll: Number(offer_passkey_enroll) === 1 ? 1 : 0,
                authenticated_at
              });
              return { success: true, meta: { changes: 1 } };
            }
            if (/^UPDATE auth_authorize_sessions\s+SET authenticator_id/i.test(normalized)) {
              const [authenticator_id, realm, session_id] = args;
              const row = db.tables.auth_authorize_sessions.get(session_id);
              if (!row || row.realm !== realm) return { success: true, meta: { changes: 0 } };
              db.tables.auth_authorize_sessions.set(session_id, {
                ...row,
                authenticator_id,
                auth_method: "passkey_webauthn",
                step_up_confirmed: 1,
                offer_passkey_enroll: 0
              });
              return { success: true, meta: { changes: 1 } };
            }
            if (/^UPDATE auth_authorize_sessions SET status = 'approved'/i.test(normalized)) {
              const [completed_at, realm, session_id] = args;
              const row = db.tables.auth_authorize_sessions.get(session_id);
              if (!row || row.realm !== realm || row.status !== "authenticated") {
                return { success: true, meta: { changes: 0 } };
              }
              db.tables.auth_authorize_sessions.set(session_id, {
                ...row, status: "approved", completed_at
              });
              return { success: true, meta: { changes: 1 } };
            }
            if (/^UPDATE auth_authorize_sessions SET status = 'denied'/i.test(normalized)) {
              const [completed_at, realm, session_id] = args;
              const row = db.tables.auth_authorize_sessions.get(session_id);
              if (!row || row.realm !== realm) return { success: true, meta: { changes: 0 } };
              if (row.status !== "pending_auth" && row.status !== "authenticated") {
                return { success: true, meta: { changes: 0 } };
              }
              db.tables.auth_authorize_sessions.set(session_id, {
                ...row, status: "denied", completed_at
              });
              return { success: true, meta: { changes: 1 } };
            }
            if (/^UPDATE auth_login_invites SET status = 'expired'/i.test(normalized)) {
              const [realm, invite_hash] = args;
              const row = db.tables.auth_login_invites.get(invite_hash);
              if (!row || row.realm !== realm || row.status !== "unused") {
                return { success: true, meta: { changes: 0 } };
              }
              db.tables.auth_login_invites.set(invite_hash, { ...row, status: "expired" });
              return { success: true, meta: { changes: 1 } };
            }
            if (/^UPDATE auth_login_invites\s+SET status = 'redeemed'/i.test(normalized)) {
              const [redeemed_at, redeemed_by_session_id, realm, invite_hash] = args;
              const row = db.tables.auth_login_invites.get(invite_hash);
              if (!row || row.realm !== realm || row.status !== "unused") {
                return { success: true, meta: { changes: 0 } };
              }
              db.tables.auth_login_invites.set(invite_hash, {
                ...row, status: "redeemed", redeemed_at, redeemed_by_session_id
              });
              return { success: true, meta: { changes: 1 } };
            }
            if (/^UPDATE auth_webauthn_challenges SET status = 'expired'/i.test(normalized)) {
              const [realm, challenge_hash] = args;
              const row = db.tables.auth_webauthn_challenges.get(challenge_hash);
              if (!row || row.realm !== realm) return { success: true, meta: { changes: 0 } };
              db.tables.auth_webauthn_challenges.set(challenge_hash, { ...row, status: "expired" });
              return { success: true, meta: { changes: 1 } };
            }
            if (/^UPDATE auth_webauthn_challenges SET status = 'used'/i.test(normalized)) {
              const [used_at, realm, challenge_hash] = args;
              const row = db.tables.auth_webauthn_challenges.get(challenge_hash);
              if (!row || row.realm !== realm || row.status !== "unused") {
                return { success: true, meta: { changes: 0 } };
              }
              db.tables.auth_webauthn_challenges.set(challenge_hash, {
                ...row, status: "used", used_at
              });
              return { success: true, meta: { changes: 1 } };
            }
            if (/^UPDATE auth_passkeys SET sign_count/i.test(normalized)) {
              const [sign_count, last_used_at, realm, credential_id] = args;
              const row = db.tables.auth_passkeys.get(credential_id);
              if (!row || row.realm !== realm) return { success: true, meta: { changes: 0 } };
              db.tables.auth_passkeys.set(credential_id, {
                ...row, sign_count: Number(sign_count) || 0, last_used_at
              });
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
            if (/SELECT account_id FROM auth_accounts WHERE realm = \? AND display_name = \? AND status = 'active'/i.test(normalized)) {
              const [realm, display_name] = args;
              for (const row of db.tables.auth_accounts.values()) {
                if (row.realm === realm && row.display_name === display_name && row.status === "active") {
                  return { account_id: row.account_id };
                }
              }
              return null;
            }
            if (/SELECT \* FROM auth_accounts WHERE realm = \? AND home_workspace_id = \?/i.test(normalized)) {
              const [realm, home_workspace_id] = args;
              for (const row of db.tables.auth_accounts.values()) {
                if (row.realm === realm && row.home_workspace_id === home_workspace_id) {
                  return clone(row);
                }
              }
              return null;
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
            if (/SELECT \* FROM auth_authenticators WHERE realm = \? AND account_id = \? AND method = 'other_approved' AND status = 'active'/i.test(normalized)) {
              const [realm, account_id] = args;
              for (const row of db.tables.auth_authenticators.values()) {
                if (
                  row.realm === realm
                  && row.account_id === account_id
                  && row.method === "other_approved"
                  && row.status === "active"
                ) {
                  return clone(row);
                }
              }
              return null;
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
            if (/SELECT \* FROM auth_oauth_clients WHERE realm = \? AND client_id = \?/i.test(normalized)) {
              const [realm, client_id] = args;
              const row = db.tables.auth_oauth_clients.get(client_id);
              return row && row.realm === realm ? clone(row) : null;
            }
            if (/SELECT bucket_key, window_start_iso, count FROM auth_dcr_rate_buckets WHERE realm = \? AND bucket_key = \?/i.test(normalized)) {
              const [realm, bucket_key] = args;
              const row = db.tables.auth_dcr_rate_buckets.get(`${realm}|${bucket_key}`);
              return row && row.realm === realm
                ? { bucket_key: row.bucket_key, window_start_iso: row.window_start_iso, count: row.count }
                : null;
            }
            if (/SELECT COUNT\(\*\) AS n FROM auth_oauth_clients WHERE realm = \? AND status = 'active'/i.test(normalized)) {
              const [realm] = args;
              let n = 0;
              for (const row of db.tables.auth_oauth_clients.values()) {
                if (row.realm === realm && row.status === "active") n += 1;
              }
              return { n };
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

            // --- Messages OAuth Issue 2 selects ---
            if (/SELECT \* FROM auth_authorize_sessions WHERE realm = \? AND session_token_hash = \?/i.test(normalized)) {
              const [realm, session_token_hash] = args;
              for (const row of db.tables.auth_authorize_sessions.values()) {
                if (row.realm === realm && row.session_token_hash === session_token_hash) {
                  return clone(row);
                }
              }
              return null;
            }
            if (/SELECT \* FROM auth_login_invites WHERE realm = \? AND invite_hash = \?/i.test(normalized)) {
              const [realm, invite_hash] = args;
              const row = db.tables.auth_login_invites.get(invite_hash);
              return row && row.realm === realm ? clone(row) : null;
            }
            if (/SELECT \* FROM auth_passkeys WHERE realm = \? AND credential_id = \? AND status = 'active'/i.test(normalized)) {
              const [realm, credential_id] = args;
              const row = db.tables.auth_passkeys.get(credential_id);
              if (!row || row.realm !== realm || row.status !== "active") return null;
              return clone(row);
            }
            if (/SELECT credential_id FROM auth_passkeys WHERE realm = \? AND credential_id = \?/i.test(normalized)) {
              const [realm, credential_id] = args;
              const row = db.tables.auth_passkeys.get(credential_id);
              return row && row.realm === realm ? { credential_id: row.credential_id } : null;
            }
            if (/SELECT \* FROM auth_passkeys WHERE realm = \? AND credential_id = \?/i.test(normalized)) {
              const [realm, credential_id] = args;
              const row = db.tables.auth_passkeys.get(credential_id);
              return row && row.realm === realm ? clone(row) : null;
            }
            if (/SELECT \* FROM auth_webauthn_challenges WHERE realm = \? AND challenge_hash = \?/i.test(normalized)) {
              const [realm, challenge_hash] = args;
              const row = db.tables.auth_webauthn_challenges.get(challenge_hash);
              return row && row.realm === realm ? clone(row) : null;
            }
            if (/SELECT bucket_key, window_start_iso, count FROM auth_login_invite_rate_buckets WHERE realm = \? AND bucket_key = \?/i.test(normalized)) {
              const [realm, bucket_key] = args;
              const row = db.tables.auth_login_invite_rate_buckets.get(`${realm}|${bucket_key}`);
              return row && row.realm === realm
                ? { bucket_key: row.bucket_key, window_start_iso: row.window_start_iso, count: row.count }
                : null;
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
            if (/SELECT credential_id FROM auth_passkeys WHERE realm = \? AND account_id = \? AND status = 'active'/i.test(normalized)) {
              const [realm, account_id] = args;
              const results = [];
              for (const row of db.tables.auth_passkeys.values()) {
                if (row.realm === realm && row.account_id === account_id && row.status === "active") {
                  results.push({ credential_id: row.credential_id });
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
