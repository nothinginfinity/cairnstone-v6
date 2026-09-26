// V7.7.10l.3 — Messages Auth Bridge (pure introspection helper).
// One identity universe: Core Auth D1 stays the authority.
// Named RPC class lives in src/worker.js (WorkerEntrypoint).
// Messages workers must call this over a service binding and MUST NOT bind Auth D1.

import {
  assertCallerIdentity,
  canonicalCoreAuthResource,
  validateAccessToken
} from "./core-auth.js";
import {
  CANONICAL_MESSAGES_RESOURCE,
  MESSAGES_SCOPES as POLICY_MESSAGES_SCOPES,
  canonicalizeMessagesResource,
  isCanonicalMessagesResource
} from "./resource-scope-policy.js";

export const MESSAGES_AUTH_BRIDGE_SCHEMA = "cairnstone-messages-auth-bridge-v1";
export { CANONICAL_MESSAGES_RESOURCE };
export const MESSAGES_RESOURCE_ALLOWLIST = Object.freeze([
  CANONICAL_MESSAGES_RESOURCE,
  `${CANONICAL_MESSAGES_RESOURCE}/mcp`
]);
export const MESSAGES_SCOPES = POLICY_MESSAGES_SCOPES;

function isAllowlistedMessagesResource(value) {
  return isCanonicalMessagesResource(value);
}

function boundFields(context, expiry) {
  const scopes = Array.isArray(context?.scopes)
    ? context.scopes.filter((scope) => MESSAGES_SCOPES.includes(String(scope)))
    : [];
  return {
    schema: MESSAGES_AUTH_BRIDGE_SCHEMA,
    active: true,
    ok: true,
    account_id: context.account_id,
    tenant_id: context.tenant_id,
    connection_id: context.connection_id,
    principal_id: context.principal_id,
    // Always publish the canonical bare-origin audience after allowlist match.
    resource: CANONICAL_MESSAGES_RESOURCE,
    scopes,
    expiry: expiry || null,
    authz_version: context.authz_version ?? null
  };
}

/**
 * Introspect an opaque csat_* token for the canonical Messages resource only.
 * Caller-supplied resource cannot select Core or any other audience.
 * Accepts either allowlisted form (bare origin or …/mcp); normalizes before
 * validateAccessToken and context.resource checks so legacy `/mcp` tokens work.
 */
export async function introspectAccessToken(env, args = {}) {
  const token = typeof args.token === "string" ? args.token : args.access_token;
  const requestedRaw = args.resource == null || args.resource === ""
    ? CANONICAL_MESSAGES_RESOURCE
    : String(args.resource);

  if (!isAllowlistedMessagesResource(requestedRaw)) {
    return {
      ok: false,
      active: false,
      error: "invalid_resource",
      reason: "resource_not_allowlisted",
      status: 401
    };
  }

  const expectedResource = canonicalizeMessagesResource(requestedRaw);
  const validated = await validateAccessToken(env, token, {
    expectedResource,
    acceptedResources: [...MESSAGES_RESOURCE_ALLOWLIST]
  });
  if (!validated.ok) {
    return {
      ok: false,
      active: false,
      error: validated.error || "invalid_token",
      reason: validated.reason || null,
      status: validated.status || 401
    };
  }

  const context = validated.context;
  if (!context || !canonicalizeMessagesResource(context.resource)) {
    return {
      ok: false,
      active: false,
      error: "invalid_token",
      reason: "audience_mismatch",
      status: 401
    };
  }

  const scopes = Array.isArray(context.scopes) ? context.scopes : [];
  const hasMessagesScope = scopes.some((scope) => MESSAGES_SCOPES.includes(String(scope)));
  if (!hasMessagesScope) {
    return {
      ok: false,
      active: false,
      error: "insufficient_scope",
      reason: "messages_scope_required",
      status: 401
    };
  }

  const identity = assertCallerIdentity(args, context);
  if (!identity.ok) {
    return {
      ok: false,
      active: false,
      error: identity.error,
      field: identity.field || null,
      status: identity.status || 401
    };
  }

  return boundFields(context, validated.expires_at || null);
}

export function coreResourceOf(env, url) {
  return canonicalCoreAuthResource(env, url);
}
