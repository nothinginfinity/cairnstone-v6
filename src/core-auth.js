// V7.7.10i.1 — Additive authenticated Core canary (`/mcp/core-auth`).
//
// Authority: project-memory/v7710i1-additive-core-auth-implementation-authorized.md
// Contracts: docs/V7_7_10I_0_*.md
//
// Rules:
// - Authentication is mandatory once a protected tool request reaches core-auth.
// - Ladder off→shadow→canary controls admission/publication, never "optional auth".
// - Legacy /mcp, /mcp/core, /mcp-b MUST NOT join auth_* tables.
// - Secrets never enter Stones, AC1, GitHub, model context, receipts, or ordinary logs.
// - Stolen same-resource bearer replay is residual risk (NF-25), not claimed solved.

import { sha256Text, stableJson } from "./agent-bootstrap.js";
import {
  advertisedAuthorizationScopes,
  canonicalizeMessagesResource,
  messagesResourcesEquivalent,
  resolveResourceScopePolicy
} from "./resource-scope-policy.js";

export const CORE_AUTH_REALM = "core-auth";
export const CORE_AUTH_RESOURCE_PATH = "/mcp/core-auth";
export const ACCOUNT_SCHEMA = "cairnstone-account-v1";
export const AUTHENTICATOR_SCHEMA = "cairnstone-authenticator-v1";
export const CONNECTION_PRINCIPAL_SCHEMA = "cairnstone-connection-principal-v1";
export const TOKEN_FAMILY_SCHEMA = "cairnstone-token-family-v1";
export const TENANT_SCHEMA = "cairnstone-tenant-v1";

export const ENFORCEMENT_MODES = Object.freeze(["off", "shadow", "canary", "required"]);

export const AUTHENTICATOR_METHOD_ASSURANCE = Object.freeze({
  wallet_proof: "wallet_ownership",
  passkey_webauthn: "webauthn",
  custodial_idp: "oidc",
  other_approved: "other_approved"
});

export const CHECKED_CALLER_ASSERTION_FIELDS = Object.freeze([
  "from",
  "recipient_id",
  "actor_id"
]);

export const STRICT_CALLER_IDENTITY_FIELDS = Object.freeze([
  "account_id",
  "tenant_id",
  "principal_id",
  "connection_id"
]);

export const AUTHORIZED_TARGET_SELECTOR_FIELDS = Object.freeze([
  "to",
  "assignee_actor_id",
  "principal_actor_id",
  "selected_actors",
  "worker_actor_id"
]);

const ID_PATTERNS = Object.freeze({
  account_id: /^acct_[A-Za-z0-9_-]+$/,
  tenant_id: /^ten_[A-Za-z0-9_-]+$/,
  authenticator_id: /^authn_[A-Za-z0-9_-]+$/,
  connection_id: /^conn_[A-Za-z0-9_-]+$/,
  principal_id: /^prin_[A-Za-z0-9_-]+$/,
  token_family_id: /^tfam_[A-Za-z0-9_-]+$/,
  wallet_account_id: /^walacct_[A-Za-z0-9_-]+$/
});

const ACCESS_TOKEN_TTL_SECONDS = 900;
const REFRESH_TOKEN_TTL_SECONDS = 30 * 24 * 60 * 60;
const AUTH_CODE_TTL_SECONDS = 120;
const CIMD_TIMEOUT_MS = 3000;
const CIMD_MAX_BYTES = 64 * 1024;
const DEFAULT_SCOPES = Object.freeze(["mcp:core"]);
const DCR_MAX_REDIRECT_URIS = 8;
const DCR_MAX_REDIRECT_URI_CHARS = 2048;
const DCR_MAX_CLIENT_NAME_CHARS = 256;
const DCR_MAX_SOFTWARE_ID_CHARS = 256;
const DCR_RATE_LIMIT_MAX_DEFAULT = 5;
const DCR_RATE_LIMIT_MAX_UNKNOWN_DEFAULT = 2;
const DCR_RATE_LIMIT_WINDOW_SECONDS_DEFAULT = 3600;
const DCR_MAX_ACTIVE_CLIENTS_DEFAULT = 1000;

function nowIso(nowMs = Date.now()) {
  return new Date(nowMs).toISOString();
}

function plusSecondsIso(seconds, nowMs = Date.now()) {
  return new Date(nowMs + seconds * 1000).toISOString();
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function randomToken(prefix, bytes = 24) {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  const body = Array.from(buf, b => b.toString(16).padStart(2, "0")).join("");
  return `${prefix}_${body}`;
}

function mintId(kind) {
  const prefixes = {
    account_id: "acct",
    tenant_id: "ten",
    authenticator_id: "authn",
    connection_id: "conn",
    principal_id: "prin",
    token_family_id: "tfam",
    wallet_account_id: "walacct",
    event_id: "aevt"
  };
  const prefix = prefixes[kind];
  if (!prefix) throw new Error(`unknown_id_kind:${kind}`);
  return randomToken(prefix, 18);
}

function matchId(kind, value) {
  const pattern = ID_PATTERNS[kind];
  return typeof value === "string" && pattern && pattern.test(value);
}

export function validateAuthenticatorPair(method, assuranceClass) {
  const expected = AUTHENTICATOR_METHOD_ASSURANCE[method];
  if (!expected) return { ok: false, error: "authenticator_method_invalid" };
  if (assuranceClass !== expected) {
    return { ok: false, error: "authenticator_method_assurance_mismatch" };
  }
  return { ok: true };
}

export function authDb(env) {
  if (env?.CAIRNSTONE_AUTH_DB) return { ok: true, db: env.CAIRNSTONE_AUTH_DB, binding: "CAIRNSTONE_AUTH_DB" };
  if (env?.CAIRNSTONE_DB) return { ok: true, db: env.CAIRNSTONE_DB, binding: "CAIRNSTONE_DB" };
  return { ok: false, error: "missing_auth_d1_binding" };
}

export function resolveEnforcementMode(env) {
  const raw = typeof env?.CORE_AUTH_ENFORCEMENT === "string"
    ? env.CORE_AUTH_ENFORCEMENT.trim().toLowerCase()
    : "off";
  if (raw === "required") {
    // 10i.1 must not activate required; treat as canary for safety.
    return "canary";
  }
  return ENFORCEMENT_MODES.includes(raw) ? raw : "off";
}

export function canonicalCoreAuthResource(env, url) {
  if (typeof env?.CORE_AUTH_RESOURCE === "string" && env.CORE_AUTH_RESOURCE.trim()) {
    return env.CORE_AUTH_RESOURCE.trim().replace(/\/$/, "");
  }
  if (url && typeof url.origin === "string") {
    return `${url.origin}${CORE_AUTH_RESOURCE_PATH}`;
  }
  return CORE_AUTH_RESOURCE_PATH;
}

/**
 * Canonicalize a resource for storage on codes/tokens.
 * Messages …/mcp collapses to bare origin; other audiences are unchanged.
 */
export function canonicalizeOauthResource(resource) {
  if (typeof resource !== "string" || !resource.trim()) return resource;
  const messages = canonicalizeMessagesResource(resource);
  return messages || resource.trim();
}

/**
 * Compare OAuth resource parameters across authorize ↔ token ↔ refresh.
 * Messages bare origin and …/mcp are equivalent; Core remains exact.
 */
export function oauthResourcesMatch(stored, requested) {
  if (stored === requested) return true;
  if (messagesResourcesEquivalent(stored, requested)) return true;
  return false;
}

export function authorizationServerIssuer(env, url) {
  if (typeof env?.CORE_AUTH_ISSUER === "string" && env.CORE_AUTH_ISSUER.trim()) {
    return env.CORE_AUTH_ISSUER.trim().replace(/\/$/, "");
  }
  if (url && typeof url.origin === "string") {
    return `${url.origin}/oauth`;
  }
  return "/oauth";
}

export function protectedResourceMetadata(env, url) {
  const resource = canonicalCoreAuthResource(env, url);
  const issuer = authorizationServerIssuer(env, url);
  return {
    resource,
    authorization_servers: [issuer],
    bearer_methods_supported: ["header"],
    scopes_supported: [...DEFAULT_SCOPES],
    resource_documentation: "https://github.com/nothinginfinity/cairnstone-v6/blob/main/docs/V7_7_10I_CONNECTOR_BOUND_IDENTITY.md",
    residual_risk: {
      stolen_same_resource_bearer_replay: "not_solved",
      note: "Until sender-constrained tokens (DPoP/similar) are host-supported, stolen same-audience bearer replay remains residual risk (NF-25)."
    }
  };
}

export function isDcrEnabled(env) {
  return env?.CORE_AUTH_DCR_ENABLED === "true" || env?.CORE_AUTH_DCR_ENABLED === true;
}

export function isCimdClientId(clientId) {
  return typeof clientId === "string" && clientId.startsWith("https://");
}

/**
 * Strict OAuth POST body parser for /oauth/token and /oauth/revoke.
 * Prefer application/x-www-form-urlencoded; retain application/json for tests.
 */
export async function parseOauthPostBody(request) {
  const raw = request?.headers?.get?.("content-type") || "";
  const mediaType = String(raw).split(";")[0].trim().toLowerCase();

  if (mediaType === "application/x-www-form-urlencoded") {
    const text = await request.text();
    const params = new URLSearchParams(text);
    const body = Object.create(null);
    for (const [key, value] of params.entries()) {
      body[key] = value;
    }
    return { ok: true, body, content_type: mediaType };
  }

  if (mediaType === "application/json") {
    let parsed;
    try {
      parsed = await request.json();
    } catch {
      return { ok: false, error: "invalid_request", status: 400, detail: "invalid_json" };
    }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { ok: false, error: "invalid_request", status: 400, detail: "json_object_required" };
    }
    return { ok: true, body: parsed, content_type: mediaType };
  }

  return {
    ok: false,
    error: "invalid_request",
    status: 415,
    detail: "unsupported_content_type",
    content_type: mediaType || null
  };
}

export function authorizationServerMetadata(env, url) {
  const issuer = authorizationServerIssuer(env, url);
  const origin = url?.origin || "";
  const dcrEnabled = isDcrEnabled(env);
  const meta = {
    issuer,
    authorization_endpoint: `${origin}/oauth/authorize`,
    token_endpoint: `${origin}/oauth/token`,
    revocation_endpoint: `${origin}/oauth/revoke`,
    code_challenge_methods_supported: ["S256"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    response_types_supported: ["code"],
    token_endpoint_auth_methods_supported: ["none"],
    scopes_supported: advertisedAuthorizationScopes(),
    // CIMD preferred; kernel already validates HTTPS client metadata documents.
    client_id_metadata_document_supported: true,
    dcr_enabled: dcrEnabled,
    // Authorize is implemented (GET+POST /oauth/authorize). Do not advertise
    // endpoints that do not exist.
    authorization_response_iss_parameter_supported: true
  };
  // Advertise registration_endpoint ONLY when DCR is actually enabled.
  if (dcrEnabled) {
    meta.registration_endpoint = `${origin}/oauth/register`;
  }
  return meta;
}

export function wwwAuthenticateChallenge(env, url, { error = "invalid_token", errorDescription } = {}) {
  const metadata = protectedResourceMetadata(env, url);
  const parts = [
    `Bearer resource_metadata="${url.origin}/.well-known/oauth-protected-resource${CORE_AUTH_RESOURCE_PATH}"`,
    `resource="${metadata.resource}"`,
    `scope="${DEFAULT_SCOPES.join(" ")}"`,
    `error="${error}"`
  ];
  if (errorDescription) parts.push(`error_description="${String(errorDescription).replace(/"/g, "")}"`);
  return parts.join(", ");
}

export async function hashSecret(value) {
  return sha256Text(String(value || ""));
}

async function pkceChallengeS256(verifier) {
  const digest = await sha256Text(verifier);
  // sha256Text returns hex; convert hex → base64url without padding
  const bytes = new Uint8Array(digest.match(/.{1,2}/g).map(h => parseInt(h, 16)));
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  const b64 = btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
  return b64;
}

function parseScopes(value) {
  if (Array.isArray(value)) {
    return [...new Set(value.map(v => String(v).trim()).filter(Boolean))].slice(0, 64);
  }
  if (typeof value === "string" && value.trim()) {
    return [...new Set(value.split(/\s+/).map(v => v.trim()).filter(Boolean))].slice(0, 64);
  }
  return [...DEFAULT_SCOPES];
}

function authorityClosed() {
  return {
    accepted_state_authority: false,
    chain_heads_mutated: false,
    path_heads_mutated: false,
    spend_authority: false,
    economic_grant: false
  };
}

async function audit(db, eventType, fields = {}) {
  const eventId = mintId("event_id");
  const detail = { ...fields };
  // Defense in depth: strip likely secret keys from audit payloads.
  for (const key of Object.keys(detail)) {
    if (/token|code|proof|secret|password|verifier|private_key|refresh/i.test(key)) {
      delete detail[key];
    }
  }
  await db.prepare(
    `INSERT INTO auth_audit_events
      (event_id, realm, event_type, account_id, tenant_id, principal_id, connection_id, token_family_id, detail_json, created_at, accepted_state_authority)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`
  ).bind(
    eventId,
    CORE_AUTH_REALM,
    eventType,
    fields.account_id || null,
    fields.tenant_id || null,
    fields.principal_id || null,
    fields.connection_id || null,
    fields.token_family_id || null,
    stableJson(detail),
    nowIso()
  ).run();
  return eventId;
}

function rowToAccount(row) {
  if (!row) return null;
  return {
    schema: ACCOUNT_SCHEMA,
    account_id: row.account_id,
    home_tenant_id: row.home_tenant_id,
    status: row.status,
    display_name: row.display_name || undefined,
    home_workspace_id: row.home_workspace_id ?? null,
    home_code_session_id: row.home_code_session_id ?? null,
    created_at: row.created_at,
    closed_at: row.closed_at ?? null,
    authz_version: row.authz_version
  };
}

function rowToAuthenticator(row) {
  if (!row) return null;
  return {
    schema: AUTHENTICATOR_SCHEMA,
    authenticator_id: row.authenticator_id,
    account_id: row.account_id,
    method: row.method,
    status: row.status,
    assurance_class: row.assurance_class,
    wallet_account_id: row.wallet_account_id ?? null,
    created_at: row.created_at,
    revoked_at: row.revoked_at ?? null
  };
}

function rowToConnectionPrincipal(row) {
  if (!row) return null;
  let aliases = [];
  try {
    aliases = JSON.parse(row.routing_aliases_json || "[]");
  } catch {
    aliases = [];
  }
  return {
    schema: CONNECTION_PRINCIPAL_SCHEMA,
    connection_id: row.connection_id,
    principal_id: row.principal_id,
    account_id: row.account_id,
    tenant_id: row.tenant_id,
    status: row.status,
    client_family: row.client_family,
    routing_aliases: aliases,
    oauth_sub: row.oauth_sub,
    created_at: row.created_at,
    revoked_at: row.revoked_at ?? null
  };
}

function rowToTokenFamily(row) {
  if (!row) return null;
  let scopes = [];
  try {
    scopes = JSON.parse(row.scopes_json || "[]");
  } catch {
    scopes = [];
  }
  return {
    schema: TOKEN_FAMILY_SCHEMA,
    token_family_id: row.token_family_id,
    connection_id: row.connection_id,
    principal_id: row.principal_id,
    account_id: row.account_id,
    tenant_id: row.tenant_id,
    origin_authenticator_id: row.origin_authenticator_id,
    resource: row.resource,
    scopes,
    status: row.status,
    authz_version: row.authz_version,
    refresh_generation: row.refresh_generation,
    created_at: row.created_at,
    last_rotated_at: row.last_rotated_at ?? null,
    revoked_at: row.revoked_at ?? null,
    superseded_by_token_family_id: row.superseded_by_token_family_id ?? null
  };
}

export function buildAuthContext({
  account,
  connection,
  tokenFamily,
  authenticator,
  scopes,
  resource
}) {
  return {
    schema: "cairnstone-core-auth-context-v1",
    realm: CORE_AUTH_REALM,
    account_id: account.account_id,
    tenant_id: connection.tenant_id,
    connection_id: connection.connection_id,
    principal_id: connection.principal_id,
    authenticator_assurance: authenticator?.assurance_class || null,
    client_family: connection.client_family,
    resource,
    scopes: Array.isArray(scopes) ? scopes : tokenFamily.scopes,
    token_family_id: tokenFamily.token_family_id,
    authz_version: tokenFamily.authz_version,
    account_status: account.status,
    connection_status: connection.status,
    token_family_status: tokenFamily.status,
    home_workspace_id: account.home_workspace_id ?? null,
    home_code_session_id: account.home_code_session_id ?? null,
    visible_workspace_ids: [account.home_workspace_id].filter(Boolean),
    visible_code_session_ids: [account.home_code_session_id].filter(Boolean),
    ...authorityClosed()
  };
}

/**
 * Fail-closed caller-identity assertion (migration rule).
 * Target selectors are not treated as caller identity.
 */
export function assertCallerIdentity(args, authContext, { authorizedAliases = [] } = {}) {
  if (!authContext || !isObject(args)) return { ok: true };

  for (const field of STRICT_CALLER_IDENTITY_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(args, field) || args[field] == null || args[field] === "") {
      continue;
    }
    const presented = String(args[field]);
    const expected = authContext[field];
    if (presented !== expected) {
      return {
        ok: false,
        status: 403,
        error: "caller_identity_mismatch",
        field,
        hint: "Caller-supplied identity must equal server-derived context; never rewritten."
      };
    }
  }

  const allowedActors = new Set([
    authContext.principal_id,
    ...authorizedAliases
  ]);

  for (const field of CHECKED_CALLER_ASSERTION_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(args, field) || args[field] == null || args[field] === "") {
      continue;
    }
    const presented = String(args[field]);
    if (!allowedActors.has(presented)) {
      return {
        ok: false,
        status: 403,
        error: "caller_assertion_forbidden",
        field,
        hint: "from/recipient_id/actor_id must resolve to the authenticated principal or an authorized delegated alias."
      };
    }
  }

  return { ok: true };
}

/**
 * Fail-closed resource selectors (NF-09/10/11). Full AC1/workspace binding is
 * 10i.3; on core-auth the gateway still denies foreign workspace / Code Session
 * / invite claim without an explicit grant proof.
 */
export function assertResourceSelectors(args, authContext, { toolName = null } = {}) {
  if (!authContext || !isObject(args)) return { ok: true };

  if (typeof args.workspace_id === "string" && args.workspace_id.trim()) {
    const allowed = new Set([
      authContext.home_workspace_id,
      ...(Array.isArray(authContext.visible_workspace_ids) ? authContext.visible_workspace_ids : [])
    ].filter(Boolean));
    if (!allowed.has(args.workspace_id.trim())) {
      return {
        ok: false,
        status: 403,
        error: "workspace_idor_denied",
        field: "workspace_id",
        hint: "workspace_id is a RESOURCE_SELECTOR constrained by server-derived membership; never leaks foreign rows."
      };
    }
  }

  const sessionKey = typeof args.code_session_id === "string" && args.code_session_id.trim()
    ? args.code_session_id.trim()
    : (typeof args.session_id === "string" && args.session_id.trim() ? args.session_id.trim() : null);
  if (sessionKey) {
    const allowed = new Set([
      authContext.home_code_session_id,
      ...(Array.isArray(authContext.visible_code_session_ids) ? authContext.visible_code_session_ids : [])
    ].filter(Boolean));
    if (!allowed.has(sessionKey)) {
      return {
        ok: false,
        status: 403,
        error: "code_session_idor_denied",
        field: "code_session_id",
        hint: "Code Session selectors are constrained by server-derived membership."
      };
    }
  }

  const inviteTool = toolName === "cairnstone_workspace_invite_claim"
    || (typeof args.invite_id === "string" && args.invite_id.trim());
  if (inviteTool) {
    const hasGrant = Boolean(
      args.mailbox_capability
      || args.invite_capability
      || args.workspace_capability
      || args.grant_id
    );
    if (!hasGrant) {
      return {
        ok: false,
        status: 403,
        error: "invite_confused_deputy",
        field: "invite_id",
        hint: "Invite claim requires an explicit grant/capability; authenticated caller alone is not enough."
      };
    }
  }

  return { ok: true };
}

/**
 * NF-23: scopes may increase only via AS authorization; refresh/mint helpers
 * must not silently add memberships or mutation authority.
 */
export function mergeScopesForStepUp(existingScopes, requestedScopes, { viaAuthorizationServer = false } = {}) {
  const current = parseScopes(existingScopes);
  const requested = parseScopes(requestedScopes);
  if (!viaAuthorizationServer) {
    // Non-AS paths (refresh, local mint) cannot widen beyond the family.
    const allowed = new Set(current);
    const filtered = requested.filter(scope => allowed.has(scope));
    return {
      ok: true,
      scopes: filtered.length ? filtered : current,
      widened: false,
      memberships_added: false,
      mutation_added: false
    };
  }
  const merged = [...new Set([...current, ...requested])].slice(0, 64);
  return {
    ok: true,
    scopes: merged,
    widened: merged.length > current.length,
    memberships_added: false,
    mutation_added: false
  };
}

export function injectServerDerivedCaller(args, authContext) {
  if (!authContext) return args;
  const next = isObject(args) ? { ...args } : {};
  // Server context wins for omitted caller fields; never replace targets.
  if (!next.from) next.from = authContext.principal_id;
  if (!next.actor_id) next.actor_id = authContext.principal_id;
  if (!next.recipient_id) next.recipient_id = authContext.principal_id;
  return next;
}

// --- CIMD SSRF policy (unit-testable) ---

export function isPrivateOrLinkLocalHostname(hostname) {
  const host = String(hostname || "").toLowerCase();
  if (!host) return true;
  if (host === "localhost" || host.endsWith(".localhost") || host === "metadata.google.internal") return true;
  if (host === "0.0.0.0" || host === "::1" || host === "[::1]") return true;
  // IPv4 literal checks
  const m = host.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (m) {
    const a = Number(m[1]);
    const b = Number(m[2]);
    if (a === 10) return true;
    if (a === 127) return true;
    if (a === 0) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
  }
  return false;
}

export function validateCimdClientIdUrl(clientId) {
  let parsed;
  try {
    parsed = new URL(clientId);
  } catch {
    return { ok: false, error: "cimd_client_id_not_url" };
  }
  if (parsed.protocol !== "https:") {
    return { ok: false, error: "cimd_https_required" };
  }
  if (["file:", "gopher:", "data:", "http:"].includes(parsed.protocol)) {
    return { ok: false, error: "cimd_scheme_forbidden" };
  }
  if (isPrivateOrLinkLocalHostname(parsed.hostname)) {
    return { ok: false, error: "cimd_ssrf_denied" };
  }
  if (parsed.username || parsed.password) {
    return { ok: false, error: "cimd_userinfo_forbidden" };
  }
  return { ok: true, url: parsed };
}

/**
 * Fetch CIMD with SSRF controls. `fetchImpl` injectable for tests.
 * Redirects are denied (fail closed) — fetch with redirect: "manual".
 */
export async function fetchCimdDocument(clientId, { fetchImpl = fetch, cacheDb = null } = {}) {
  const validated = validateCimdClientIdUrl(clientId);
  if (!validated.ok) return validated;

  const controller = typeof AbortController !== "undefined" ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), CIMD_TIMEOUT_MS) : null;
  try {
    const response = await fetchImpl(validated.url.toString(), {
      method: "GET",
      redirect: "manual",
      signal: controller?.signal,
      headers: { Accept: "application/json" }
    });

    if (response.status >= 300 && response.status < 400) {
      return { ok: false, error: "cimd_redirect_denied" };
    }
    if (!response.ok) {
      return { ok: false, error: "cimd_fetch_failed", status: response.status };
    }

    const text = await response.text();
    if (text.length > CIMD_MAX_BYTES) {
      return { ok: false, error: "cimd_body_too_large" };
    }

    let document;
    try {
      document = JSON.parse(text);
    } catch {
      return { ok: false, error: "cimd_json_invalid" };
    }

    const documentUrl = typeof document.client_id === "string" ? document.client_id : null;
    if (documentUrl !== clientId) {
      return { ok: false, error: "cimd_document_url_mismatch" };
    }

    const contentHash = await hashSecret(text);
    const redirectUris = Array.isArray(document.redirect_uris) ? document.redirect_uris : [];

    if (cacheDb) {
      await cacheDb.prepare(
        `INSERT INTO auth_cimd_cache (client_id, realm, content_hash, redirect_uris_json, fetched_at, document_json)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(client_id) DO UPDATE SET
           content_hash = excluded.content_hash,
           redirect_uris_json = excluded.redirect_uris_json,
           fetched_at = excluded.fetched_at,
           document_json = excluded.document_json`
      ).bind(clientId, CORE_AUTH_REALM, contentHash, JSON.stringify(redirectUris), nowIso(), text).run();
    }

    return {
      ok: true,
      client_id: clientId,
      content_hash: contentHash,
      redirect_uris: redirectUris,
      document
    };
  } catch (error) {
    const message = String(error && error.message ? error.message : error);
    if (/abort/i.test(message)) return { ok: false, error: "cimd_timeout" };
    return { ok: false, error: "cimd_fetch_error", detail: message };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function requireAllowlistedRedirectUri(clientId, redirectUri, { fetchImpl, cacheDb, cached } = {}) {
  let meta = cached;
  if (!meta) {
    meta = await fetchCimdDocument(clientId, { fetchImpl, cacheDb });
  }
  if (!meta.ok) return meta;
  if (!meta.redirect_uris.includes(redirectUri)) {
    return { ok: false, error: "redirect_uri_mismatch" };
  }
  return { ok: true, cimd: meta };
}

export async function revalidateCimdOrFail(clientId, expectedContentHash, { fetchImpl, cacheDb } = {}) {
  const meta = await fetchCimdDocument(clientId, { fetchImpl, cacheDb });
  if (!meta.ok) return meta;
  if (expectedContentHash && meta.content_hash !== expectedContentHash) {
    return { ok: false, error: "cimd_metadata_mutated" };
  }
  return meta;
}

/**
 * Bounded redirect_uri rules for public DCR clients (RFC 8252 + HTTPS).
 * Allows https:// and loopback http://127.0.0.1|localhost|[::1] only.
 */
export function validateDcrRedirectUri(redirectUri) {
  if (typeof redirectUri !== "string" || !redirectUri.trim()) {
    return { ok: false, error: "invalid_redirect_uri" };
  }
  if (redirectUri.length > DCR_MAX_REDIRECT_URI_CHARS) {
    return { ok: false, error: "redirect_uri_too_long" };
  }
  let parsed;
  try {
    parsed = new URL(redirectUri);
  } catch {
    return { ok: false, error: "invalid_redirect_uri" };
  }
  if (parsed.username || parsed.password) {
    return { ok: false, error: "redirect_uri_userinfo_forbidden" };
  }
  if (parsed.hash) {
    return { ok: false, error: "redirect_uri_fragment_forbidden" };
  }
  const host = parsed.hostname.toLowerCase();
  const isLoopback =
    host === "127.0.0.1" ||
    host === "localhost" ||
    host === "[::1]" ||
    host === "::1";
  if (parsed.protocol === "https:") {
    return { ok: true, uri: parsed.toString() };
  }
  if (parsed.protocol === "http:" && isLoopback) {
    return { ok: true, uri: parsed.toString() };
  }
  return { ok: false, error: "redirect_uri_scheme_forbidden" };
}

export function normalizeDcrRedirectUris(redirectUris) {
  if (!Array.isArray(redirectUris) || redirectUris.length === 0) {
    return { ok: false, error: "redirect_uris_required" };
  }
  if (redirectUris.length > DCR_MAX_REDIRECT_URIS) {
    return { ok: false, error: "too_many_redirect_uris" };
  }
  const normalized = [];
  const seen = new Set();
  for (const raw of redirectUris) {
    const checked = validateDcrRedirectUri(raw);
    if (!checked.ok) return checked;
    if (seen.has(checked.uri)) continue;
    seen.add(checked.uri);
    normalized.push(checked.uri);
  }
  if (normalized.length === 0) {
    return { ok: false, error: "redirect_uris_required" };
  }
  return { ok: true, redirect_uris: normalized };
}

export async function lookupActiveOauthClient(env, clientId) {
  const dbRes = authDb(env);
  if (!dbRes.ok) return dbRes;
  const row = await dbRes.db.prepare(
    "SELECT * FROM auth_oauth_clients WHERE realm = ? AND client_id = ?"
  ).bind(CORE_AUTH_REALM, clientId).first();
  if (!row || row.status !== "active") {
    return { ok: false, error: "unknown_client" };
  }
  return { ok: true, client: row };
}

export async function requireRegisteredOpaqueClientRedirect(env, clientId, redirectUri) {
  const found = await lookupActiveOauthClient(env, clientId);
  if (!found.ok) {
    return { ok: false, error: "invalid_client", detail: found.error || "unknown_client" };
  }
  let uris;
  try {
    uris = JSON.parse(found.client.redirect_uris_json || "[]");
  } catch {
    return { ok: false, error: "invalid_client", detail: "corrupt_client_record" };
  }
  if (!Array.isArray(uris) || !uris.includes(redirectUri)) {
    return { ok: false, error: "invalid_request", detail: "redirect_uri_mismatch" };
  }
  return { ok: true, client: found.client, redirect_uris: uris };
}

// --- Bootstrap / registry ---

export async function bootstrapAccountConnection(env, {
  clientFamily = "perplexity",
  method = "wallet_proof",
  assuranceClass = "wallet_ownership",
  displayName = null,
  routingAliases = [],
  resource,
  scopes = DEFAULT_SCOPES,
  existingAccountId = null,
  selectTenantId = null,
  admitCanary = false,
  canaryLabel = null,
  stepUpConfirmed = true,
  mintConnection = true
} = {}) {
  const pair = validateAuthenticatorPair(method, assuranceClass);
  if (!pair.ok) return pair;

  const dbRes = authDb(env);
  if (!dbRes.ok) return dbRes;
  const db = dbRes.db;
  const createdAt = nowIso();
  const resourceUrl = resource || canonicalCoreAuthResource(env);

  let accountId = existingAccountId;
  let tenantId = selectTenantId;
  let accountRow = null;

  if (accountId) {
    accountRow = await db.prepare(
      "SELECT * FROM auth_accounts WHERE realm = ? AND account_id = ?"
    ).bind(CORE_AUTH_REALM, accountId).first();
    if (!accountRow) return { ok: false, error: "account_not_found" };
    if (accountRow.status === "suspended" || accountRow.status === "closed") {
      return { ok: false, error: "account_not_active", status: accountRow.status };
    }
    if (!tenantId) tenantId = accountRow.home_tenant_id;
    const membership = await db.prepare(
      "SELECT * FROM auth_tenant_memberships WHERE realm = ? AND account_id = ? AND tenant_id = ? AND status = 'active'"
    ).bind(CORE_AUTH_REALM, accountId, tenantId).first();
    if (!membership) return { ok: false, error: "tenant_membership_required", status: 403 };
  } else {
    tenantId = mintId("tenant_id");
    accountId = mintId("account_id");
    await db.prepare(
      `INSERT INTO auth_tenants (tenant_id, schema, realm, status, created_at, accepted_state_authority)
       VALUES (?, ?, ?, 'active', ?, 0)`
    ).bind(tenantId, TENANT_SCHEMA, CORE_AUTH_REALM, createdAt).run();
    await db.prepare(
      `INSERT INTO auth_accounts
        (account_id, schema, realm, home_tenant_id, status, display_name, home_workspace_id, home_code_session_id, authz_version, created_at, closed_at, accepted_state_authority)
       VALUES (?, ?, ?, ?, 'active', ?, ?, ?, 1, ?, NULL, 0)`
    ).bind(
      accountId,
      ACCOUNT_SCHEMA,
      CORE_AUTH_REALM,
      tenantId,
      displayName,
      `ws_home_${accountId.slice(5, 21)}`,
      `cs_home_${accountId.slice(5, 21)}`,
      createdAt
    ).run();
    await db.prepare(
      `INSERT INTO auth_tenant_memberships
        (realm, account_id, tenant_id, status, authz_version, created_at, revoked_at, accepted_state_authority)
       VALUES (?, ?, ?, 'active', 1, ?, NULL, 0)`
    ).bind(CORE_AUTH_REALM, accountId, tenantId, createdAt).run();
    accountRow = await db.prepare(
      "SELECT * FROM auth_accounts WHERE realm = ? AND account_id = ?"
    ).bind(CORE_AUTH_REALM, accountId).first();
  }

  let walletAccountId = null;
  if (method === "wallet_proof") {
    walletAccountId = mintId("wallet_account_id");
    await db.prepare(
      `INSERT INTO auth_wallet_accounts
        (wallet_account_id, schema, realm, account_id, status, balance_units, address, created_at, rotated_at, accepted_state_authority)
       VALUES (?, 'cairnstone-wallet-account-v1', ?, ?, 'active', 0, NULL, ?, NULL, 0)`
    ).bind(walletAccountId, CORE_AUTH_REALM, accountId, createdAt).run();
  }

  const authenticatorId = mintId("authenticator_id");
  await db.prepare(
    `INSERT INTO auth_authenticators
      (authenticator_id, schema, realm, account_id, method, status, assurance_class, wallet_account_id, created_at, revoked_at, accepted_state_authority)
     VALUES (?, ?, ?, ?, ?, 'active', ?, ?, ?, NULL, 0)`
  ).bind(
    authenticatorId,
    AUTHENTICATOR_SCHEMA,
    CORE_AUTH_REALM,
    accountId,
    method,
    assuranceClass,
    walletAccountId,
    createdAt
  ).run();

  if (mintConnection === false) {
    await audit(db, "bootstrap_account_only", {
      account_id: accountId,
      tenant_id: tenantId,
      step_up_confirmed: stepUpConfirmed === true
    });
    return {
      ok: true,
      account: rowToAccount(accountRow),
      authenticator: rowToAuthenticator({
        authenticator_id: authenticatorId,
        account_id: accountId,
        method,
        status: "active",
        assurance_class: assuranceClass,
        wallet_account_id: walletAccountId,
        created_at: createdAt,
        revoked_at: null
      }),
      wallet_account_id: walletAccountId,
      connection: null,
      token_family: null,
      spend_authority: false,
      economic_grant: false,
      ...authorityClosed()
    };
  }

  const connectionId = mintId("connection_id");
  const principalId = mintId("principal_id");
  const aliases = Array.isArray(routingAliases) ? routingAliases.slice(0, 16) : [];
  await db.prepare(
    `INSERT INTO auth_connection_principals
      (connection_id, schema, realm, principal_id, account_id, tenant_id, status, client_family, routing_aliases_json, oauth_sub, created_at, revoked_at, accepted_state_authority)
     VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, NULL, 0)`
  ).bind(
    connectionId,
    CONNECTION_PRINCIPAL_SCHEMA,
    CORE_AUTH_REALM,
    principalId,
    accountId,
    tenantId,
    clientFamily,
    JSON.stringify(aliases),
    principalId,
    createdAt
  ).run();

  for (const alias of aliases) {
    const claimed = await claimRoutingAlias(db, {
      alias,
      principalId,
      accountId,
      tenantId,
      createdAt
    });
    if (!claimed.ok) return claimed;
  }

  // Selective canary: call sites must not hardcode true on OAuth redeem.
  // Explicit admitCanary=true (operator/test/allowlist-gated caller) writes the row.
  if (admitCanary) {
    await db.prepare(
      `INSERT INTO auth_canary_admissions (realm, connection_id, client_family, label, status, created_at)
       VALUES (?, ?, ?, ?, 'admitted', ?)
       ON CONFLICT(realm, connection_id) DO UPDATE SET status = 'admitted', label = excluded.label`
    ).bind(CORE_AUTH_REALM, connectionId, clientFamily, canaryLabel || "canary", createdAt).run();
  }

  const minted = await mintTokenFamily(env, {
    connectionId,
    principalId,
    accountId,
    tenantId,
    authenticatorId,
    resource: resourceUrl,
    scopes: parseScopes(scopes),
    authzVersion: accountRow.authz_version || 1
  });
  if (!minted.ok) return minted;

  await audit(db, "bootstrap_complete", {
    account_id: accountId,
    tenant_id: tenantId,
    principal_id: principalId,
    connection_id: connectionId,
    token_family_id: minted.token_family.token_family_id,
    step_up_confirmed: stepUpConfirmed === true
  });

  return {
    ok: true,
    account: rowToAccount(accountRow),
    authenticator: rowToAuthenticator({
      authenticator_id: authenticatorId,
      account_id: accountId,
      method,
      status: "active",
      assurance_class: assuranceClass,
      wallet_account_id: walletAccountId,
      created_at: createdAt,
      revoked_at: null
    }),
    connection: rowToConnectionPrincipal({
      connection_id: connectionId,
      principal_id: principalId,
      account_id: accountId,
      tenant_id: tenantId,
      status: "active",
      client_family: clientFamily,
      routing_aliases_json: JSON.stringify(aliases),
      oauth_sub: principalId,
      created_at: createdAt,
      revoked_at: null
    }),
    wallet_account_id: walletAccountId,
    spend_authority: false,
    economic_grant: false,
    ...minted,
    ...authorityClosed()
  };
}

export async function claimRoutingAlias(db, { alias, principalId, accountId, tenantId, createdAt }) {
  const existing = await db.prepare(
    "SELECT * FROM auth_routing_aliases WHERE realm = ? AND alias = ?"
  ).bind(CORE_AUTH_REALM, alias).first();
  if (existing) {
    if (existing.status === "active" && existing.principal_id === principalId) {
      return { ok: true, alias, winner: true, existing: true };
    }
    return {
      ok: false,
      status: 403,
      error: "alias_claim_conflict",
      alias,
      hint: "Conflicting alias claims fail closed; historical bodies are never rewritten."
    };
  }
  try {
    await db.prepare(
      `INSERT INTO auth_routing_aliases (realm, alias, principal_id, account_id, tenant_id, status, created_at)
       VALUES (?, ?, ?, ?, ?, 'active', ?)`
    ).bind(CORE_AUTH_REALM, alias, principalId, accountId, tenantId, createdAt || nowIso()).run();
    return { ok: true, alias, winner: true };
  } catch {
    return { ok: false, status: 403, error: "alias_claim_race", alias };
  }
}

export async function mintTokenFamily(env, {
  connectionId,
  principalId,
  accountId,
  tenantId,
  authenticatorId,
  resource,
  scopes = DEFAULT_SCOPES,
  authzVersion = 1,
  nowMs = Date.now()
}) {
  const dbRes = authDb(env);
  if (!dbRes.ok) return dbRes;
  const db = dbRes.db;
  const createdAt = nowIso(nowMs);
  const tokenFamilyId = mintId("token_family_id");
  const scopeList = parseScopes(scopes);

  await db.prepare(
    `INSERT INTO auth_token_families
      (token_family_id, schema, realm, connection_id, principal_id, account_id, tenant_id,
       origin_authenticator_id, resource, scopes_json, status, authz_version, refresh_generation,
       created_at, last_rotated_at, revoked_at, superseded_by_token_family_id, accepted_state_authority)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, 0, ?, NULL, NULL, NULL, 0)`
  ).bind(
    tokenFamilyId,
    TOKEN_FAMILY_SCHEMA,
    CORE_AUTH_REALM,
    connectionId,
    principalId,
    accountId,
    tenantId,
    authenticatorId,
    resource,
    JSON.stringify(scopeList),
    authzVersion,
    createdAt
  ).run();

  const tokens = await issueTokenPair(db, {
    tokenFamilyId,
    connectionId,
    principalId,
    accountId,
    tenantId,
    resource,
    scopes: scopeList,
    authzVersion,
    refreshGeneration: 0,
    nowMs
  });

  return {
    ok: true,
    token_family: rowToTokenFamily({
      token_family_id: tokenFamilyId,
      connection_id: connectionId,
      principal_id: principalId,
      account_id: accountId,
      tenant_id: tenantId,
      origin_authenticator_id: authenticatorId,
      resource,
      scopes_json: JSON.stringify(scopeList),
      status: "active",
      authz_version: authzVersion,
      refresh_generation: 0,
      created_at: createdAt,
      last_rotated_at: null,
      revoked_at: null,
      superseded_by_token_family_id: null
    }),
    ...tokens
  };
}

async function issueTokenPair(db, {
  tokenFamilyId,
  connectionId,
  principalId,
  accountId,
  tenantId,
  resource,
  scopes,
  authzVersion,
  refreshGeneration,
  nowMs = Date.now()
}) {
  const accessToken = randomToken("csat", 32);
  const refreshToken = randomToken("csrt", 32);
  const accessHash = await hashSecret(accessToken);
  const refreshHash = await hashSecret(refreshToken);
  const createdAt = nowIso(nowMs);

  await db.prepare(
    `INSERT INTO auth_access_tokens
      (token_hash, realm, token_family_id, principal_id, account_id, tenant_id, connection_id, resource, scopes_json, authz_version, expires_at, revoked_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)`
  ).bind(
    accessHash,
    CORE_AUTH_REALM,
    tokenFamilyId,
    principalId,
    accountId,
    tenantId,
    connectionId,
    resource,
    JSON.stringify(scopes),
    authzVersion,
    plusSecondsIso(ACCESS_TOKEN_TTL_SECONDS, nowMs),
    createdAt
  ).run();

  await db.prepare(
    `INSERT INTO auth_refresh_tokens
      (token_hash, realm, token_family_id, principal_id, account_id, tenant_id, connection_id, refresh_generation, status, expires_at, created_at, rotated_at, revoked_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, NULL, NULL)`
  ).bind(
    refreshHash,
    CORE_AUTH_REALM,
    tokenFamilyId,
    principalId,
    accountId,
    tenantId,
    connectionId,
    refreshGeneration,
    plusSecondsIso(REFRESH_TOKEN_TTL_SECONDS, nowMs),
    createdAt
  ).run();

  return {
    access_token: accessToken,
    refresh_token: refreshToken,
    token_type: "Bearer",
    expires_in: ACCESS_TOKEN_TTL_SECONDS,
    scope: scopes.join(" "),
    // Never echo secrets into audit/receipt fields — callers of mint get tokens once.
    resource
  };
}

export async function rotateRefreshToken(env, refreshToken, {
  expectedResource = null,
  nowMs = Date.now()
} = {}) {
  const dbRes = authDb(env);
  if (!dbRes.ok) return dbRes;
  const db = dbRes.db;
  const refreshHash = await hashSecret(refreshToken);
  const row = await db.prepare(
    "SELECT * FROM auth_refresh_tokens WHERE realm = ? AND token_hash = ?"
  ).bind(CORE_AUTH_REALM, refreshHash).first();

  if (!row) return { ok: false, error: "invalid_grant", status: 401 };

  if (row.status !== "active") {
    // Refresh reuse detection: revoke the whole family.
    await revokeTokenFamily(env, row.token_family_id, { reason: "refresh_reuse_detected" });
    return { ok: false, error: "invalid_grant", status: 401, family_revoked: true };
  }

  if (row.expires_at && row.expires_at < nowIso(nowMs)) {
    return { ok: false, error: "invalid_grant", status: 401 };
  }

  const family = await db.prepare(
    "SELECT * FROM auth_token_families WHERE realm = ? AND token_family_id = ?"
  ).bind(CORE_AUTH_REALM, row.token_family_id).first();
  if (!family || family.status !== "active") {
    return { ok: false, error: "invalid_grant", status: 401 };
  }
  if (expectedResource && !oauthResourcesMatch(family.resource, expectedResource)) {
    return { ok: false, error: "invalid_grant", status: 401 };
  }

  const freshness = await enforceAuthzFreshness(db, family);
  if (!freshness.ok) return freshness;

  // Mark previous refresh rotated (single-use).
  await db.prepare(
    `UPDATE auth_refresh_tokens SET status = 'rotated', rotated_at = ?
     WHERE realm = ? AND token_hash = ? AND status = 'active'`
  ).bind(nowIso(nowMs), CORE_AUTH_REALM, refreshHash).run();

  const nextGen = Number(family.refresh_generation || 0) + 1;
  await db.prepare(
    `UPDATE auth_token_families SET refresh_generation = ?, last_rotated_at = ?
     WHERE realm = ? AND token_family_id = ?`
  ).bind(nextGen, nowIso(nowMs), CORE_AUTH_REALM, family.token_family_id).run();

  let scopes = [];
  try {
    scopes = JSON.parse(family.scopes_json || "[]");
  } catch {
    scopes = [...DEFAULT_SCOPES];
  }

  const tokens = await issueTokenPair(db, {
    tokenFamilyId: family.token_family_id,
    connectionId: family.connection_id,
    principalId: family.principal_id,
    accountId: family.account_id,
    tenantId: family.tenant_id,
    resource: family.resource,
    scopes,
    authzVersion: family.authz_version,
    refreshGeneration: nextGen,
    nowMs
  });

  await audit(db, "refresh_rotated", {
    account_id: family.account_id,
    tenant_id: family.tenant_id,
    principal_id: family.principal_id,
    connection_id: family.connection_id,
    token_family_id: family.token_family_id,
    refresh_generation: nextGen
  });

  return {
    ok: true,
    token_family_id: family.token_family_id,
    refresh_generation: nextGen,
    ...tokens
  };
}

async function enforceAuthzFreshness(db, familyRow) {
  const account = await db.prepare(
    "SELECT * FROM auth_accounts WHERE realm = ? AND account_id = ?"
  ).bind(CORE_AUTH_REALM, familyRow.account_id).first();
  if (!account) return { ok: false, error: "account_not_found", status: 401 };
  if (account.status === "suspended" || account.status === "closed") {
    return { ok: false, error: "account_not_active", status: 403 };
  }

  const membership = await db.prepare(
    "SELECT * FROM auth_tenant_memberships WHERE realm = ? AND account_id = ? AND tenant_id = ?"
  ).bind(CORE_AUTH_REALM, familyRow.account_id, familyRow.tenant_id).first();
  if (!membership || membership.status !== "active") {
    return { ok: false, error: "stale_authz_version", status: 403 };
  }

  const currentVersion = Math.max(
    Number(account.authz_version || 1),
    Number(membership.authz_version || 1)
  );
  if (Number(familyRow.authz_version) < currentVersion) {
    return { ok: false, error: "stale_authz_version", status: 403 };
  }

  const connection = await db.prepare(
    "SELECT * FROM auth_connection_principals WHERE realm = ? AND connection_id = ?"
  ).bind(CORE_AUTH_REALM, familyRow.connection_id).first();
  if (!connection || connection.status !== "active") {
    return { ok: false, error: "connection_revoked", status: 401 };
  }

  return { ok: true, account, membership, connection, currentVersion };
}

export async function revokeTokenFamily(env, tokenFamilyId, { reason = "revoked" } = {}) {
  const dbRes = authDb(env);
  if (!dbRes.ok) return dbRes;
  const db = dbRes.db;
  const now = nowIso();
  const family = await db.prepare(
    "SELECT * FROM auth_token_families WHERE realm = ? AND token_family_id = ?"
  ).bind(CORE_AUTH_REALM, tokenFamilyId).first();
  if (!family) return { ok: false, error: "token_family_not_found" };

  await db.prepare(
    `UPDATE auth_token_families SET status = 'revoked', revoked_at = ?
     WHERE realm = ? AND token_family_id = ?`
  ).bind(now, CORE_AUTH_REALM, tokenFamilyId).run();
  await db.prepare(
    `UPDATE auth_refresh_tokens SET status = 'revoked', revoked_at = ?
     WHERE realm = ? AND token_family_id = ? AND status = 'active'`
  ).bind(now, CORE_AUTH_REALM, tokenFamilyId).run();
  await db.prepare(
    `UPDATE auth_access_tokens SET revoked_at = ?
     WHERE realm = ? AND token_family_id = ? AND revoked_at IS NULL`
  ).bind(now, CORE_AUTH_REALM, tokenFamilyId).run();

  await audit(db, "token_family_revoked", {
    account_id: family.account_id,
    tenant_id: family.tenant_id,
    principal_id: family.principal_id,
    connection_id: family.connection_id,
    token_family_id: tokenFamilyId,
    reason
  });

  return { ok: true, token_family_id: tokenFamilyId, reason };
}

export async function revokeConnection(env, connectionId) {
  const dbRes = authDb(env);
  if (!dbRes.ok) return dbRes;
  const db = dbRes.db;
  const now = nowIso();
  const connection = await db.prepare(
    "SELECT * FROM auth_connection_principals WHERE realm = ? AND connection_id = ?"
  ).bind(CORE_AUTH_REALM, connectionId).first();
  if (!connection) return { ok: false, error: "connection_not_found" };

  await db.prepare(
    `UPDATE auth_connection_principals SET status = 'revoked', revoked_at = ?
     WHERE realm = ? AND connection_id = ?`
  ).bind(now, CORE_AUTH_REALM, connectionId).run();

  const families = await db.prepare(
    "SELECT token_family_id FROM auth_token_families WHERE realm = ? AND connection_id = ? AND status = 'active'"
  ).bind(CORE_AUTH_REALM, connectionId).all();
  const rows = families?.results || families?.rows || [];
  for (const row of rows) {
    await revokeTokenFamily(env, row.token_family_id, { reason: "connection_revoked" });
  }

  await audit(db, "connection_revoked", {
    account_id: connection.account_id,
    tenant_id: connection.tenant_id,
    principal_id: connection.principal_id,
    connection_id: connectionId
  });

  return { ok: true, connection_id: connectionId };
}

export async function revokeAuthenticator(env, authenticatorId, { stepUpConfirmed = false } = {}) {
  if (!stepUpConfirmed) {
    return { ok: false, error: "step_up_required", status: 403 };
  }
  const dbRes = authDb(env);
  if (!dbRes.ok) return dbRes;
  const db = dbRes.db;
  const now = nowIso();
  const authenticator = await db.prepare(
    "SELECT * FROM auth_authenticators WHERE realm = ? AND authenticator_id = ?"
  ).bind(CORE_AUTH_REALM, authenticatorId).first();
  if (!authenticator) return { ok: false, error: "authenticator_not_found" };

  await db.prepare(
    `UPDATE auth_authenticators SET status = 'revoked', revoked_at = ?
     WHERE realm = ? AND authenticator_id = ?`
  ).bind(now, CORE_AUTH_REALM, authenticatorId).run();

  const families = await db.prepare(
    `SELECT token_family_id FROM auth_token_families
     WHERE realm = ? AND origin_authenticator_id = ? AND status = 'active'`
  ).bind(CORE_AUTH_REALM, authenticatorId).all();
  const rows = families?.results || families?.rows || [];
  for (const row of rows) {
    await revokeTokenFamily(env, row.token_family_id, { reason: "authenticator_revoked" });
  }

  await audit(db, "authenticator_revoked", {
    account_id: authenticator.account_id,
    token_family_id: null,
    authenticator_id_present: true
  });

  return { ok: true, authenticator_id: authenticatorId, families_revoked: rows.length };
}

export async function replaceAuthenticator(env, {
  accountId,
  previousAuthenticatorId,
  method,
  assuranceClass,
  stepUpConfirmed = false
}) {
  if (!stepUpConfirmed) {
    return { ok: false, error: "step_up_required", status: 403 };
  }
  const pair = validateAuthenticatorPair(method, assuranceClass);
  if (!pair.ok) return pair;

  const dbRes = authDb(env);
  if (!dbRes.ok) return dbRes;
  const db = dbRes.db;
  const now = nowIso();

  const account = await db.prepare(
    "SELECT * FROM auth_accounts WHERE realm = ? AND account_id = ?"
  ).bind(CORE_AUTH_REALM, accountId).first();
  if (!account) return { ok: false, error: "account_not_found" };

  const previous = await db.prepare(
    "SELECT * FROM auth_authenticators WHERE realm = ? AND authenticator_id = ? AND account_id = ?"
  ).bind(CORE_AUTH_REALM, previousAuthenticatorId, accountId).first();
  if (!previous) return { ok: false, error: "authenticator_not_found" };

  await db.prepare(
    `UPDATE auth_authenticators SET status = 'replaced', revoked_at = ?
     WHERE realm = ? AND authenticator_id = ?`
  ).bind(now, CORE_AUTH_REALM, previousAuthenticatorId).run();

  let walletAccountId = previous.wallet_account_id;
  if (method === "wallet_proof") {
    // Rotate instrument under same wallet account relationship when present;
    // otherwise provision a new zero-balance wallet account.
    if (walletAccountId) {
      await db.prepare(
        `UPDATE auth_wallet_accounts SET status = 'rotated', rotated_at = ?, address = ?
         WHERE realm = ? AND wallet_account_id = ?`
      ).bind(now, `addr_${randomToken("w", 8)}`, CORE_AUTH_REALM, walletAccountId).run();
    } else {
      walletAccountId = mintId("wallet_account_id");
      await db.prepare(
        `INSERT INTO auth_wallet_accounts
          (wallet_account_id, schema, realm, account_id, status, balance_units, address, created_at, rotated_at, accepted_state_authority)
         VALUES (?, 'cairnstone-wallet-account-v1', ?, ?, 'active', 0, NULL, ?, NULL, 0)`
      ).bind(walletAccountId, CORE_AUTH_REALM, accountId, now).run();
    }
  }

  const authenticatorId = mintId("authenticator_id");
  await db.prepare(
    `INSERT INTO auth_authenticators
      (authenticator_id, schema, realm, account_id, method, status, assurance_class, wallet_account_id, created_at, revoked_at, accepted_state_authority)
     VALUES (?, ?, ?, ?, ?, 'active', ?, ?, ?, NULL, 0)`
  ).bind(
    authenticatorId,
    AUTHENTICATOR_SCHEMA,
    CORE_AUTH_REALM,
    accountId,
    method,
    assuranceClass,
    walletAccountId,
    now
  ).run();

  return {
    ok: true,
    account_id: accountId,
    previous_authenticator_id: previousAuthenticatorId,
    authenticator_id: authenticatorId,
    wallet_account_id: walletAccountId,
    account_id_unchanged: true
  };
}

export async function bumpAuthzVersion(env, { accountId, tenantId = null }) {
  const dbRes = authDb(env);
  if (!dbRes.ok) return dbRes;
  const db = dbRes.db;

  if (tenantId) {
    const membership = await db.prepare(
      "SELECT * FROM auth_tenant_memberships WHERE realm = ? AND account_id = ? AND tenant_id = ?"
    ).bind(CORE_AUTH_REALM, accountId, tenantId).first();
    if (!membership) return { ok: false, error: "membership_not_found" };
    const next = Number(membership.authz_version || 1) + 1;
    await db.prepare(
      `UPDATE auth_tenant_memberships SET status = 'revoked', authz_version = ?, revoked_at = ?
       WHERE realm = ? AND account_id = ? AND tenant_id = ?`
    ).bind(next, nowIso(), CORE_AUTH_REALM, accountId, tenantId).run();
    return { ok: true, authz_version: next, scope: "membership" };
  }

  const account = await db.prepare(
    "SELECT * FROM auth_accounts WHERE realm = ? AND account_id = ?"
  ).bind(CORE_AUTH_REALM, accountId).first();
  if (!account) return { ok: false, error: "account_not_found" };
  const next = Number(account.authz_version || 1) + 1;
  await db.prepare(
    "UPDATE auth_accounts SET authz_version = ? WHERE realm = ? AND account_id = ?"
  ).bind(next, CORE_AUTH_REALM, accountId).run();
  return { ok: true, authz_version: next, scope: "account" };
}

export async function joinTenant(env, { accountId, tenantId }) {
  const dbRes = authDb(env);
  if (!dbRes.ok) return dbRes;
  const db = dbRes.db;
  const account = await db.prepare(
    "SELECT * FROM auth_accounts WHERE realm = ? AND account_id = ?"
  ).bind(CORE_AUTH_REALM, accountId).first();
  if (!account) return { ok: false, error: "account_not_found" };
  const tenant = await db.prepare(
    "SELECT * FROM auth_tenants WHERE realm = ? AND tenant_id = ?"
  ).bind(CORE_AUTH_REALM, tenantId).first();
  if (!tenant) {
    await db.prepare(
      `INSERT INTO auth_tenants (tenant_id, schema, realm, status, created_at, accepted_state_authority)
       VALUES (?, ?, ?, 'active', ?, 0)`
    ).bind(tenantId, TENANT_SCHEMA, CORE_AUTH_REALM, nowIso()).run();
  }
  await db.prepare(
    `INSERT INTO auth_tenant_memberships
      (realm, account_id, tenant_id, status, authz_version, created_at, revoked_at, accepted_state_authority)
     VALUES (?, ?, ?, 'active', 1, ?, NULL, 0)
     ON CONFLICT(realm, account_id, tenant_id) DO UPDATE SET status = 'active', revoked_at = NULL`
  ).bind(CORE_AUTH_REALM, accountId, tenantId, nowIso()).run();
  return {
    ok: true,
    account_id: accountId,
    tenant_id: tenantId,
    account_id_unchanged: true
  };
}

export async function bindConnectionTenant(env, { connectionId, tenantId }) {
  const dbRes = authDb(env);
  if (!dbRes.ok) return dbRes;
  const db = dbRes.db;
  const connection = await db.prepare(
    "SELECT * FROM auth_connection_principals WHERE realm = ? AND connection_id = ?"
  ).bind(CORE_AUTH_REALM, connectionId).first();
  if (!connection) return { ok: false, error: "connection_not_found" };
  const membership = await db.prepare(
    "SELECT * FROM auth_tenant_memberships WHERE realm = ? AND account_id = ? AND tenant_id = ? AND status = 'active'"
  ).bind(CORE_AUTH_REALM, connection.account_id, tenantId).first();
  if (!membership) {
    return { ok: false, error: "tenant_membership_required", status: 403 };
  }
  await db.prepare(
    "UPDATE auth_connection_principals SET tenant_id = ? WHERE realm = ? AND connection_id = ?"
  ).bind(tenantId, CORE_AUTH_REALM, connectionId).run();
  return {
    ok: true,
    connection_id: connectionId,
    tenant_id: tenantId,
    account_id: connection.account_id,
    account_id_unchanged: true
  };
}

/**
 * Validate Bearer access token for core-auth resource. Fail closed.
 */
export async function validateAccessToken(env, accessToken, {
  expectedResource = null,
  acceptedResources = null,
  url = null,
  nowMs = Date.now()
} = {}) {
  if (typeof accessToken !== "string" || !accessToken.trim()) {
    return { ok: false, error: "invalid_token", status: 401 };
  }

  // Foreign provider tokens (JWT-ish without our prefix) fail closed.
  if (!accessToken.startsWith("csat_")) {
    return { ok: false, error: "foreign_or_malformed_token", status: 401 };
  }

  const dbRes = authDb(env);
  if (!dbRes.ok) return { ok: false, error: "auth_store_unavailable", status: 503 };
  const db = dbRes.db;
  const tokenHash = await hashSecret(accessToken.trim());
  const row = await db.prepare(
    "SELECT * FROM auth_access_tokens WHERE realm = ? AND token_hash = ?"
  ).bind(CORE_AUTH_REALM, tokenHash).first();
  if (!row) return { ok: false, error: "invalid_token", status: 401 };
  if (row.revoked_at) return { ok: false, error: "invalid_token", status: 401 };
  if (row.expires_at < nowIso(nowMs)) return { ok: false, error: "invalid_token", status: 401 };

  const resource = expectedResource || canonicalCoreAuthResource(env, url);
  const allowedAudiences = Array.isArray(acceptedResources) && acceptedResources.length
    ? acceptedResources
    : [resource];
  // Default remains exact match. Messages bridge may pass both allowlisted forms
  // via acceptedResources; Core callers leave that unset and stay exact.
  if (!allowedAudiences.includes(row.resource)) {
    return { ok: false, error: "invalid_token", status: 401, reason: "audience_mismatch" };
  }

  // mcp-b must never be accepted as audience (NF-27)
  if (/\/mcp-b\/?$/.test(row.resource) || row.resource === "/mcp-b") {
    return { ok: false, error: "invalid_token", status: 401, reason: "mcp_b_not_auth" };
  }

  const family = await db.prepare(
    "SELECT * FROM auth_token_families WHERE realm = ? AND token_family_id = ?"
  ).bind(CORE_AUTH_REALM, row.token_family_id).first();
  if (!family || family.status !== "active") {
    return { ok: false, error: "invalid_token", status: 401 };
  }

  // Token-family substitution: principal/connection must match family.
  if (row.principal_id !== family.principal_id || row.connection_id !== family.connection_id) {
    return { ok: false, error: "invalid_token", status: 401, reason: "family_principal_mismatch" };
  }

  const freshness = await enforceAuthzFreshness(db, family);
  if (!freshness.ok) return freshness;

  const authenticator = await db.prepare(
    "SELECT * FROM auth_authenticators WHERE realm = ? AND authenticator_id = ?"
  ).bind(CORE_AUTH_REALM, family.origin_authenticator_id).first();

  let scopes = [];
  try {
    scopes = JSON.parse(row.scopes_json || "[]");
  } catch {
    scopes = [...DEFAULT_SCOPES];
  }

  const context = buildAuthContext({
    account: rowToAccount(freshness.account),
    connection: rowToConnectionPrincipal(freshness.connection),
    tokenFamily: rowToTokenFamily(family),
    authenticator: rowToAuthenticator(authenticator),
    scopes,
    resource: row.resource
  });

  return {
    ok: true,
    context,
    expires_at: row.expires_at || null,
    // NF-25 residual risk acknowledgment for same-resource stolen bearer:
    residual_risk_stolen_bearer_replay: true
  };
}

export async function isCanaryAdmitted(env, connectionId, { clientFamily = null, label = null } = {}) {
  const dbRes = authDb(env);
  if (dbRes.ok) {
    const row = await dbRes.db.prepare(
      "SELECT status FROM auth_canary_admissions WHERE realm = ? AND connection_id = ?"
    ).bind(CORE_AUTH_REALM, connectionId).first();
    if (row?.status === "admitted") return true;
  }

  return shouldAdmitCanaryOnMint(env, { connectionId, clientFamily, label });
}

/**
 * Selective canary admission. Default deny.
 * Allow only via:
 * - CORE_AUTH_CANARY_AUTO_ADMIT=true (operator flag; off by default)
 * - CORE_AUTH_CANARY_CONNECTIONS allowlist entries:
 *   connection_id | family:<clientFamily> | label:<label>
 */
export function shouldAdmitCanaryOnMint(env, { connectionId = null, clientFamily = null, label = null } = {}) {
  if (env?.CORE_AUTH_CANARY_AUTO_ADMIT === "true" || env?.CORE_AUTH_CANARY_AUTO_ADMIT === true) {
    return true;
  }
  const raw = typeof env?.CORE_AUTH_CANARY_CONNECTIONS === "string"
    ? env.CORE_AUTH_CANARY_CONNECTIONS
    : "";
  if (!raw.trim()) return false;
  const allowed = new Set(raw.split(",").map(s => s.trim()).filter(Boolean));
  if (connectionId && allowed.has(connectionId)) return true;
  if (clientFamily && allowed.has(`family:${clientFamily}`)) return true;
  if (label && allowed.has(`label:${label}`)) return true;
  return false;
}

/**
 * Gate a protected core-auth MCP request.
 * Returns { ok:true, context } or { ok:false, status, headers, body }.
 */
export async function enforceCoreAuthRequest(request, env, url, {
  isProtectedToolCall = false
} = {}) {
  const mode = resolveEnforcementMode(env);
  const challenge = wwwAuthenticateChallenge(env, url);
  const unauthorized = (error = "invalid_token", description) => ({
    ok: false,
    status: 401,
    headers: {
      "WWW-Authenticate": wwwAuthenticateChallenge(env, url, { error, errorDescription: description })
    },
    body: {
      ok: false,
      error,
      error_description: description || "Authentication required for /mcp/core-auth protected tools.",
      enforcement: mode,
      residual_risk_stolen_bearer_replay: "documented_not_solved"
    }
  });

  // Discovery / probe paths may proceed without auth when not a protected tool call,
  // except there is NEVER an unauthenticated protected-tool execution mode.
  if (!isProtectedToolCall) {
    return { ok: true, context: null, enforcement: mode, discovery: true };
  }

  if (mode === "off") {
    return unauthorized("invalid_token", "core-auth enforcement is off; protected tools are not usable.");
  }

  const header = request.headers.get("authorization") || "";
  const match = header.match(/^Bearer\s+(.+)$/i);
  const token = match ? match[1].trim() : "";
  if (!token) {
    return unauthorized("invalid_token", "Bearer access token required.");
  }

  const validated = await validateAccessToken(env, token, {
    expectedResource: canonicalCoreAuthResource(env, url),
    url
  });
  if (!validated.ok) {
    const status = validated.status || 401;
    if (status === 403) {
      return {
        ok: false,
        status: 403,
        headers: {},
        body: {
          ok: false,
          error: validated.error,
          enforcement: mode
        }
      };
    }
    return unauthorized(validated.error || "invalid_token");
  }

  if (mode === "canary") {
    const admitted = await isCanaryAdmitted(env, validated.context.connection_id, {
      clientFamily: validated.context.client_family
    });
    if (!admitted) {
      return {
        ok: false,
        status: 403,
        headers: {},
        body: {
          ok: false,
          error: "canary_not_admitted",
          hint: "Non-selected connections stay on legacy /mcp or /mcp/core URLs.",
          enforcement: mode
        }
      };
    }
  }

  // shadow + canary (+ coerced required→canary): auth mandatory; realm isolation always enforced.
  return {
    ok: true,
    context: validated.context,
    enforcement: mode,
    residual_risk_stolen_bearer_replay: true
  };
}

export function isProtectedMcpRpc(rpc) {
  if (!rpc || typeof rpc !== "object") return false;
  if (Array.isArray(rpc)) return rpc.some(isProtectedMcpRpc);
  const method = rpc.method;
  if (method === "tools/call") return true;
  return false;
}

export async function createAuthorizationCode(env, {
  accountId,
  tenantId,
  authenticatorId,
  clientId,
  redirectUri,
  codeChallenge,
  codeChallengeMethod = "S256",
  resource,
  scopes = DEFAULT_SCOPES,
  iss,
  connectionId = null,
  principalId = null,
  stepUpConfirmed = false,
  nowMs = Date.now()
}) {
  if (codeChallengeMethod !== "S256") {
    return { ok: false, error: "invalid_request", detail: "S256 required" };
  }
  const dbRes = authDb(env);
  if (!dbRes.ok) return dbRes;
  const code = randomToken("csac", 24);
  const codeHash = await hashSecret(code);
  await dbRes.db.prepare(
    `INSERT INTO auth_authorization_codes
      (code_hash, realm, account_id, tenant_id, connection_id, principal_id, authenticator_id,
       client_id, redirect_uri, code_challenge, code_challenge_method, resource, scopes_json, iss,
       status, expires_at, created_at, used_at, step_up_confirmed)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'S256', ?, ?, ?, 'unused', ?, ?, NULL, ?)`
  ).bind(
    codeHash,
    CORE_AUTH_REALM,
    accountId,
    tenantId,
    connectionId,
    principalId,
    authenticatorId,
    clientId,
    redirectUri,
    codeChallenge,
    resource,
    JSON.stringify(parseScopes(scopes)),
    iss,
    plusSecondsIso(AUTH_CODE_TTL_SECONDS, nowMs),
    nowIso(nowMs),
    stepUpConfirmed === true ? 1 : 0
  ).run();
  return { ok: true, code, expires_in: AUTH_CODE_TTL_SECONDS, step_up_confirmed: stepUpConfirmed === true };
}

/**
 * Mint a new connection + token family under an EXISTING account/authenticator.
 * Used by OAuth redeem after real user auth — does not create accounts or wallet authenticators.
 */
export async function mintConnectionUnderAccount(env, {
  accountId,
  tenantId,
  authenticatorId,
  clientFamily = "cimd",
  routingAliases = [],
  resource,
  scopes = DEFAULT_SCOPES,
  admitCanary = false,
  canaryLabel = null,
  stepUpConfirmed = false
} = {}) {
  const dbRes = authDb(env);
  if (!dbRes.ok) return dbRes;
  const db = dbRes.db;
  const createdAt = nowIso();
  const resourceUrl = resource || canonicalCoreAuthResource(env);

  const accountRow = await db.prepare(
    "SELECT * FROM auth_accounts WHERE realm = ? AND account_id = ?"
  ).bind(CORE_AUTH_REALM, accountId).first();
  if (!accountRow) return { ok: false, error: "account_not_found" };
  if (accountRow.status === "suspended" || accountRow.status === "closed") {
    return { ok: false, error: "account_not_active", status: accountRow.status };
  }
  const resolvedTenantId = tenantId || accountRow.home_tenant_id;
  const membership = await db.prepare(
    "SELECT * FROM auth_tenant_memberships WHERE realm = ? AND account_id = ? AND tenant_id = ? AND status = 'active'"
  ).bind(CORE_AUTH_REALM, accountId, resolvedTenantId).first();
  if (!membership) return { ok: false, error: "tenant_membership_required", status: 403 };

  const authenticator = await db.prepare(
    "SELECT * FROM auth_authenticators WHERE realm = ? AND authenticator_id = ? AND account_id = ?"
  ).bind(CORE_AUTH_REALM, authenticatorId, accountId).first();
  if (!authenticator || authenticator.status !== "active") {
    return { ok: false, error: "authenticator_not_found" };
  }

  const connectionId = mintId("connection_id");
  const principalId = mintId("principal_id");
  const aliases = Array.isArray(routingAliases) ? routingAliases.slice(0, 16) : [];
  await db.prepare(
    `INSERT INTO auth_connection_principals
      (connection_id, schema, realm, principal_id, account_id, tenant_id, status, client_family, routing_aliases_json, oauth_sub, created_at, revoked_at, accepted_state_authority)
     VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, NULL, 0)`
  ).bind(
    connectionId,
    CONNECTION_PRINCIPAL_SCHEMA,
    CORE_AUTH_REALM,
    principalId,
    accountId,
    resolvedTenantId,
    clientFamily,
    JSON.stringify(aliases),
    principalId,
    createdAt
  ).run();

  for (const alias of aliases) {
    const claimed = await claimRoutingAlias(db, {
      alias,
      principalId,
      accountId,
      tenantId: resolvedTenantId,
      createdAt
    });
    if (!claimed.ok) return claimed;
  }

  if (admitCanary) {
    await db.prepare(
      `INSERT INTO auth_canary_admissions (realm, connection_id, client_family, label, status, created_at)
       VALUES (?, ?, ?, ?, 'admitted', ?)
       ON CONFLICT(realm, connection_id) DO UPDATE SET status = 'admitted', label = excluded.label`
    ).bind(CORE_AUTH_REALM, connectionId, clientFamily, canaryLabel || "canary", createdAt).run();
  }

  const minted = await mintTokenFamily(env, {
    connectionId,
    principalId,
    accountId,
    tenantId: resolvedTenantId,
    authenticatorId,
    resource: resourceUrl,
    scopes: parseScopes(scopes),
    authzVersion: accountRow.authz_version || 1
  });
  if (!minted.ok) return minted;

  await audit(db, "connection_minted_under_account", {
    account_id: accountId,
    tenant_id: resolvedTenantId,
    principal_id: principalId,
    connection_id: connectionId,
    token_family_id: minted.token_family.token_family_id,
    step_up_confirmed: stepUpConfirmed === true
  });

  return {
    ok: true,
    account: rowToAccount(accountRow),
    authenticator: rowToAuthenticator(authenticator),
    connection: rowToConnectionPrincipal({
      connection_id: connectionId,
      principal_id: principalId,
      account_id: accountId,
      tenant_id: resolvedTenantId,
      status: "active",
      client_family: clientFamily,
      routing_aliases_json: JSON.stringify(aliases),
      oauth_sub: principalId,
      created_at: createdAt,
      revoked_at: null
    }),
    spend_authority: false,
    economic_grant: false,
    step_up_confirmed: stepUpConfirmed === true,
    ...minted,
    ...authorityClosed()
  };
}

export async function redeemAuthorizationCode(env, {
  code,
  codeVerifier,
  redirectUri,
  clientId,
  resource,
  expectedIss,
  nowMs = Date.now()
}) {
  const dbRes = authDb(env);
  if (!dbRes.ok) return dbRes;
  const db = dbRes.db;
  const codeHash = await hashSecret(code);
  const row = await db.prepare(
    "SELECT * FROM auth_authorization_codes WHERE realm = ? AND code_hash = ?"
  ).bind(CORE_AUTH_REALM, codeHash).first();
  if (!row) return { ok: false, error: "invalid_grant" };
  if (row.status !== "unused") return { ok: false, error: "invalid_grant" };
  if (row.expires_at < nowIso(nowMs)) {
    await db.prepare(
      "UPDATE auth_authorization_codes SET status = 'expired' WHERE realm = ? AND code_hash = ?"
    ).bind(CORE_AUTH_REALM, codeHash).run();
    return { ok: false, error: "invalid_grant" };
  }
  if (row.client_id !== clientId) return { ok: false, error: "invalid_grant" };
  if (row.redirect_uri !== redirectUri) return { ok: false, error: "invalid_grant" };
  if (expectedIss && row.iss !== expectedIss) {
    return { ok: false, error: "invalid_grant", reason: "issuer_mismatch" };
  }
  if (resource && !oauthResourcesMatch(row.resource, resource)) {
    return { ok: false, error: "invalid_grant", reason: "resource_mismatch" };
  }

  const challenge = await pkceChallengeS256(codeVerifier);
  if (challenge !== row.code_challenge) {
    return { ok: false, error: "invalid_grant", reason: "pkce_mismatch" };
  }

  // Mark used BEFORE minting to prevent double-redeem races.
  const used = await db.prepare(
    `UPDATE auth_authorization_codes SET status = 'used', used_at = ?
     WHERE realm = ? AND code_hash = ? AND status = 'unused'`
  ).bind(nowIso(nowMs), CORE_AUTH_REALM, codeHash).run();
  const changes = Number(used?.meta?.changes ?? used?.changes ?? 0);
  if (changes !== 1) return { ok: false, error: "invalid_grant" };

  // Fresh connection under the EXISTING authenticated account.
  // Do not create anonymous accounts or new wallet_proof authenticators here.
  // Selective canary: NEVER hardcode admitCanary true — gate on explicit allowlist /
  // CORE_AUTH_CANARY_AUTO_ADMIT / CORE_AUTH_CANARY_CONNECTIONS (family:/label:).
  // DCR/CIMD registration must NEVER auto-admit canary connections.
  const clientFamily = isCimdClientId(clientId) ? "cimd" : String(clientId).slice(0, 64);
  const canaryLabel = "oauth_redeem";
  const stepUpConfirmed = Number(row.step_up_confirmed) === 1;
  const boot = await mintConnectionUnderAccount(env, {
    accountId: row.account_id,
    tenantId: row.tenant_id,
    authenticatorId: row.authenticator_id,
    clientFamily,
    resource: row.resource,
    scopes: JSON.parse(row.scopes_json || "[]"),
    admitCanary: shouldAdmitCanaryOnMint(env, { clientFamily, label: canaryLabel }),
    canaryLabel,
    stepUpConfirmed
  });
  if (!boot.ok) return boot;

  return {
    ok: true,
    ...boot,
    // Strip nested secret-bearing audit risk: tokens only in OAuth response.
  };
}

/**
 * Authorization endpoint entry (GET/POST). Advertised in AS metadata.
 *
 * Messages OAuth Issue 2: after client/redirect/PKCE/resource checks, this starts
 * a consent session and returns HTML — it does NOT bootstrap anonymous accounts
 * and does NOT issue a code until authentication + Approve.
 */
export async function handleOauthAuthorizeRequest(params, env, url, { fetchImpl } = {}) {
  // Dynamic import avoids a static cycle with oauth-user-auth.js.
  const { beginOauthAuthorize } = await import("./oauth-user-auth.js");
  return beginOauthAuthorize(params, env, url, { fetchImpl });
}

export async function handleOauthTokenRequest(body, env, url) {
  const grantType = String(body?.grant_type || "");
  const resourceRaw = typeof body?.resource === "string" ? body.resource : canonicalCoreAuthResource(env, url);
  const resource = canonicalizeOauthResource(resourceRaw);
  const issuer = authorizationServerIssuer(env, url);

  if (grantType === "authorization_code") {
    if (body?.iss && body.iss !== issuer) {
      return { ok: false, error: "invalid_grant", status: 400, reason: "issuer_mixup" };
    }
    const redeemed = await redeemAuthorizationCode(env, {
      code: body.code,
      codeVerifier: body.code_verifier,
      redirectUri: body.redirect_uri,
      clientId: body.client_id,
      resource,
      expectedIss: issuer
    });
    if (!redeemed.ok) return { ...redeemed, status: 400 };
    return {
      ok: true,
      access_token: redeemed.access_token,
      refresh_token: redeemed.refresh_token,
      token_type: "Bearer",
      expires_in: redeemed.expires_in,
      scope: redeemed.scope,
      // identity hints (non-secret)
      account_id: redeemed.account?.account_id,
      principal_id: redeemed.connection?.principal_id,
      connection_id: redeemed.connection?.connection_id,
      token_family_id: redeemed.token_family?.token_family_id
    };
  }

  if (grantType === "refresh_token") {
    const rotated = await rotateRefreshToken(env, body.refresh_token, { expectedResource: resource });
    if (!rotated.ok) return { ...rotated, status: 400 };
    return {
      ok: true,
      access_token: rotated.access_token,
      refresh_token: rotated.refresh_token,
      token_type: "Bearer",
      expires_in: rotated.expires_in,
      scope: rotated.scope
    };
  }

  return { ok: false, error: "unsupported_grant_type", status: 400 };
}

export async function handleOauthRevokeRequest(body, env) {
  const token = body?.token;
  if (typeof token !== "string" || !token) {
    return { ok: false, error: "invalid_request", status: 400 };
  }
  const dbRes = authDb(env);
  if (!dbRes.ok) return dbRes;
  const db = dbRes.db;

  if (token.startsWith("csrt_")) {
    const hash = await hashSecret(token);
    const row = await db.prepare(
      "SELECT * FROM auth_refresh_tokens WHERE realm = ? AND token_hash = ?"
    ).bind(CORE_AUTH_REALM, hash).first();
    if (row) {
      await revokeTokenFamily(env, row.token_family_id, { reason: "oauth_revoke" });
    }
    return { ok: true };
  }

  if (token.startsWith("csat_")) {
    const hash = await hashSecret(token);
    const row = await db.prepare(
      "SELECT * FROM auth_access_tokens WHERE realm = ? AND token_hash = ?"
    ).bind(CORE_AUTH_REALM, hash).first();
    if (row) {
      await db.prepare(
        "UPDATE auth_access_tokens SET revoked_at = ? WHERE realm = ? AND token_hash = ?"
      ).bind(nowIso(), CORE_AUTH_REALM, hash).run();
    }
    return { ok: true };
  }

  // Unknown token type: RFC 7009 says still return 200
  return { ok: true };
}

function envPositiveInt(env, key, fallback) {
  const raw = env?.[key];
  if (raw === undefined || raw === null || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 1) return fallback;
  return Math.floor(n);
}

function dcrRateLimitMax(env, clientIp) {
  if (clientIp === "unknown") {
    return envPositiveInt(env, "CORE_AUTH_DCR_RATE_LIMIT_MAX_UNKNOWN", DCR_RATE_LIMIT_MAX_UNKNOWN_DEFAULT);
  }
  return envPositiveInt(env, "CORE_AUTH_DCR_RATE_LIMIT_MAX", DCR_RATE_LIMIT_MAX_DEFAULT);
}

function dcrRateLimitWindowSeconds(env) {
  return envPositiveInt(env, "CORE_AUTH_DCR_RATE_LIMIT_WINDOW_SECONDS", DCR_RATE_LIMIT_WINDOW_SECONDS_DEFAULT);
}

function dcrMaxActiveClients(env) {
  return envPositiveInt(env, "CORE_AUTH_DCR_MAX_ACTIVE_CLIENTS", DCR_MAX_ACTIVE_CLIENTS_DEFAULT);
}

function dcrInitialAccessTokenConfigured(env) {
  const raw = env?.CORE_AUTH_DCR_INITIAL_ACCESS_TOKEN;
  return typeof raw === "string" && raw.trim().length > 0;
}

/**
 * Prefer CF-Connecting-IP, else first X-Forwarded-For hop, else explicit clientIp, else unknown.
 */
export function resolveDcrClientIp(ctx = {}) {
  const headers = ctx.request?.headers || ctx.headers || null;
  if (headers && typeof headers.get === "function") {
    const cf = headers.get("CF-Connecting-IP") || headers.get("cf-connecting-ip");
    if (typeof cf === "string" && cf.trim()) return cf.trim();
    const xff = headers.get("X-Forwarded-For") || headers.get("x-forwarded-for");
    if (typeof xff === "string" && xff.trim()) {
      const first = xff.split(",")[0].trim();
      if (first) return first;
    }
  }
  if (typeof ctx.clientIp === "string" && ctx.clientIp.trim()) return ctx.clientIp.trim();
  return "unknown";
}

function resolveDcrAuthorizationHeader(ctx = {}) {
  if (typeof ctx.authorization === "string") return ctx.authorization;
  const headers = ctx.request?.headers || ctx.headers || null;
  if (headers && typeof headers.get === "function") {
    return headers.get("authorization") || headers.get("Authorization") || "";
  }
  return "";
}

async function timingSafeSecretEqual(provided, expected) {
  if (typeof provided !== "string" || typeof expected !== "string" || !provided || !expected) {
    return false;
  }
  const [left, right] = await Promise.all([hashSecret(provided), hashSecret(expected)]);
  if (left.length !== right.length) return false;
  let diff = 0;
  for (let i = 0; i < left.length; i += 1) {
    diff |= left.charCodeAt(i) ^ right.charCodeAt(i);
  }
  return diff === 0;
}

async function enforceDcrInitialAccessToken(env, ctx = {}) {
  if (!dcrInitialAccessTokenConfigured(env)) return { ok: true };
  const expected = String(env.CORE_AUTH_DCR_INITIAL_ACCESS_TOKEN).trim();
  const header = resolveDcrAuthorizationHeader(ctx);
  const match = String(header || "").match(/^Bearer\s+(.+)$/i);
  const provided = match ? match[1].trim() : "";
  if (!provided || !(await timingSafeSecretEqual(provided, expected))) {
    return { ok: false, error: "invalid_token", status: 401, detail: "initial_access_token_required" };
  }
  return { ok: true };
}

async function consumeDcrRateLimit(db, env, clientIp, nowMs = Date.now()) {
  const max = dcrRateLimitMax(env, clientIp);
  const windowSeconds = dcrRateLimitWindowSeconds(env);
  const bucketKey = `ip:${clientIp}`;
  const now = nowMs;
  const row = await db.prepare(
    "SELECT bucket_key, window_start_iso, count FROM auth_dcr_rate_buckets WHERE realm = ? AND bucket_key = ?"
  ).bind(CORE_AUTH_REALM, bucketKey).first();

  let windowStartMs;
  let count = 0;
  if (row?.window_start_iso) {
    const parsed = Date.parse(row.window_start_iso);
    if (Number.isFinite(parsed) && (now - parsed) < windowSeconds * 1000) {
      windowStartMs = parsed;
      count = Number(row.count) || 0;
    }
  }
  if (windowStartMs == null) {
    windowStartMs = now;
    count = 0;
  }

  if (count >= max) {
    const retryAfter = Math.max(1, Math.ceil((windowStartMs + windowSeconds * 1000 - now) / 1000));
    return {
      ok: false,
      error: "slow_down",
      status: 429,
      retry_after: retryAfter,
      detail: "dcr_rate_limit_exceeded"
    };
  }

  const nextCount = count + 1;
  const windowStartIso = nowIso(windowStartMs);
  await db.prepare(
    `INSERT INTO auth_dcr_rate_buckets (realm, bucket_key, window_start_iso, count)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(realm, bucket_key) DO UPDATE SET
       window_start_iso = excluded.window_start_iso,
       count = excluded.count`
  ).bind(CORE_AUTH_REALM, bucketKey, windowStartIso, nextCount).run();

  return {
    ok: true,
    bucket_key: bucketKey,
    count: nextCount,
    max,
    window_start_iso: windowStartIso,
    window_seconds: windowSeconds
  };
}

async function enforceDcrActiveClientCap(db, env) {
  const max = dcrMaxActiveClients(env);
  const row = await db.prepare(
    "SELECT COUNT(*) AS n FROM auth_oauth_clients WHERE realm = ? AND status = 'active'"
  ).bind(CORE_AUTH_REALM).first();
  const active = Number(row?.n) || 0;
  if (active >= max) {
    return {
      ok: false,
      error: "dcr_capacity_exceeded",
      status: 403,
      detail: "active_oauth_clients_cap",
      active,
      max
    };
  }
  return { ok: true, active, max };
}

/**
 * Bounded public-client DCR (RFC 7591). Optional third arg carries request/headers
 * (or clientIp + authorization) so IP rate limits and initial-access Bearer can be enforced.
 */
export async function handleOauthRegisterRequest(body, env, ctx = {}) {
  if (!isDcrEnabled(env)) {
    return { ok: false, error: "dcr_disabled", status: 403 };
  }

  const dbRes = authDb(env);
  if (!dbRes.ok) return { ...dbRes, status: 500 };

  const iat = await enforceDcrInitialAccessToken(env, ctx);
  if (!iat.ok) return iat;

  const clientIp = resolveDcrClientIp(ctx);
  const rate = await consumeDcrRateLimit(dbRes.db, env, clientIp);
  if (!rate.ok) return rate;

  const cap = await enforceDcrActiveClientCap(dbRes.db, env);
  if (!cap.ok) return cap;

  const redirectNorm = normalizeDcrRedirectUris(body?.redirect_uris);
  if (!redirectNorm.ok) {
    return { ok: false, error: "invalid_client_metadata", status: 400, detail: redirectNorm.error };
  }

  const grantTypesRaw = Array.isArray(body?.grant_types) ? body.grant_types : ["authorization_code"];
  const grantTypes = [...new Set(grantTypesRaw.map((g) => String(g)))];
  if (grantTypes.length !== 1 || grantTypes[0] !== "authorization_code") {
    return { ok: false, error: "invalid_client_metadata", status: 400, detail: "grant_types_must_be_authorization_code" };
  }

  const responseTypesRaw = Array.isArray(body?.response_types) ? body.response_types : ["code"];
  const responseTypes = [...new Set(responseTypesRaw.map((g) => String(g)))];
  if (responseTypes.length !== 1 || responseTypes[0] !== "code") {
    return { ok: false, error: "invalid_client_metadata", status: 400, detail: "response_types_must_be_code" };
  }

  const authMethod = typeof body?.token_endpoint_auth_method === "string"
    ? body.token_endpoint_auth_method
    : "none";
  if (authMethod !== "none") {
    return { ok: false, error: "invalid_client_metadata", status: 400, detail: "token_endpoint_auth_method_must_be_none" };
  }

  // Reject any attempt to register a confidential client secret.
  if (body?.client_secret != null || body?.client_secret_expires_at != null) {
    return { ok: false, error: "invalid_client_metadata", status: 400, detail: "client_secret_not_supported" };
  }

  let clientName = null;
  if (typeof body?.client_name === "string" && body.client_name.trim()) {
    clientName = body.client_name.trim().slice(0, DCR_MAX_CLIENT_NAME_CHARS);
  }
  let softwareId = null;
  if (typeof body?.software_id === "string" && body.software_id.trim()) {
    softwareId = body.software_id.trim().slice(0, DCR_MAX_SOFTWARE_ID_CHARS);
  }
  let applicationType = null;
  if (typeof body?.application_type === "string" && body.application_type.trim()) {
    const at = body.application_type.trim().toLowerCase();
    if (at !== "web" && at !== "native") {
      return { ok: false, error: "invalid_client_metadata", status: 400, detail: "application_type_invalid" };
    }
    applicationType = at;
  }

  // Opaque DCR client_id only — never accept a caller-supplied URL client_id here.
  if (typeof body?.client_id === "string" && body.client_id.trim()) {
    return { ok: false, error: "invalid_client_metadata", status: 400, detail: "client_id_server_minted_only" };
  }

  const clientId = randomToken("dcr", 16);
  const issuedAt = Math.floor(Date.now() / 1000);
  const createdAt = nowIso();

  await dbRes.db.prepare(
    `INSERT INTO auth_oauth_clients
      (client_id, realm, registration_type, client_name, software_id, redirect_uris_json,
       grant_types_json, response_types_json, token_endpoint_auth_method, application_type,
       status, created_at, revoked_at, accepted_state_authority)
     VALUES (?, ?, 'dcr', ?, ?, ?, ?, ?, 'none', ?, 'active', ?, NULL, 0)`
  ).bind(
    clientId,
    CORE_AUTH_REALM,
    clientName,
    softwareId,
    JSON.stringify(redirectNorm.redirect_uris),
    JSON.stringify(grantTypes),
    JSON.stringify(responseTypes),
    applicationType,
    createdAt
  ).run();

  await audit(dbRes.db, "oauth_dcr_register", {
    client_id: clientId,
    redirect_uri_count: redirectNorm.redirect_uris.length,
    application_type: applicationType,
    client_ip: clientIp === "unknown" ? "unknown" : "redacted"
    // Never auto-admit canary from DCR.
  });

  // RFC 7591 public-client registration response. No client_secret ever.
  return {
    ok: true,
    client_id: clientId,
    client_id_issued_at: issuedAt,
    redirect_uris: redirectNorm.redirect_uris,
    grant_types: grantTypes,
    response_types: responseTypes,
    token_endpoint_auth_method: "none",
    client_name: clientName || undefined,
    software_id: softwareId || undefined,
    application_type: applicationType || undefined
  };
}

/**
 * Storage firewall helper: legacy code paths must never call this.
 * Returns whether a SQL string touches auth_* tables.
 */
export function sqlTouchesAuthTables(sql) {
  return /\bauth_[a-z0-9_]+\b/i.test(String(sql || ""));
}

export function legacyMustNotQueryAuth(sql) {
  if (sqlTouchesAuthTables(sql)) {
    return {
      ok: false,
      error: "legacy_auth_table_forbidden",
      hint: "Legacy /mcp|/mcp/core|/mcp-b must not join auth_* tables."
    };
  }
  return { ok: true };
}

export {
  matchId,
  mintId,
  parseScopes,
  DEFAULT_SCOPES,
  ACCESS_TOKEN_TTL_SECONDS,
  authorityClosed,
  rowToAccount,
  rowToAuthenticator,
  rowToConnectionPrincipal,
  rowToTokenFamily,
  pkceChallengeS256,
  DCR_MAX_REDIRECT_URIS,
  DCR_MAX_REDIRECT_URI_CHARS
};
