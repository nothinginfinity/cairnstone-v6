// V7.7.10l.3 — fail-closed resource → allowed-scopes policy for Core AS.
// Extensible for future standalone services. Unknown resources do not mint.

export const CORE_SCOPE = "mcp:core";
export const MESSAGES_SCOPES = Object.freeze(["messages.read", "messages.write"]);
export const CANONICAL_MESSAGES_RESOURCE = "https://cairnstone-messages.jaredtechfit.workers.dev";

export const RESOURCE_SCOPE_POLICY = Object.freeze({
  schema: "cairnstone-resource-scope-policy-v1",
  resources: Object.freeze({
    core: Object.freeze({
      defaultScopes: Object.freeze([CORE_SCOPE]),
      allowedScopes: Object.freeze([CORE_SCOPE])
    }),
    messages: Object.freeze({
      defaultScopes: Object.freeze(["messages.read"]),
      allowedScopes: MESSAGES_SCOPES
    })
  })
});

export function parseRequestedScopes(value) {
  if (Array.isArray(value)) {
    return [...new Set(value.map((v) => String(v).trim()).filter(Boolean))].slice(0, 64);
  }
  if (typeof value === "string" && value.trim()) {
    return [...new Set(value.split(/\s+/).map((v) => v.trim()).filter(Boolean))].slice(0, 64);
  }
  return [];
}

export function normalizeRegisteredResource(value) {
  if (typeof value !== "string") return "";
  return value.trim().replace(/\/+$/, "");
}

export function isCanonicalMessagesResource(value) {
  const resource = normalizeRegisteredResource(value);
  return resource === CANONICAL_MESSAGES_RESOURCE
    || resource === `${CANONICAL_MESSAGES_RESOURCE}/mcp`;
}

export function isCanonicalCoreResource(value, env, url) {
  const resource = normalizeRegisteredResource(value);
  if (!resource) return false;
  const configured = typeof env?.CORE_AUTH_RESOURCE === "string"
    ? normalizeRegisteredResource(env.CORE_AUTH_RESOURCE)
    : "";
  if (configured && resource === configured) return true;
  if (resource.endsWith("/mcp/core-auth")) return true;
  try {
    const origin = url?.origin || "";
    if (origin && resource === `${origin}/mcp/core-auth`) return true;
  } catch {
    /* ignore */
  }
  return false;
}

export function resolveResourceClass(resource, env, url) {
  if (isCanonicalCoreResource(resource, env, url)) return "core";
  if (isCanonicalMessagesResource(resource)) return "messages";
  return null;
}

/**
 * Resolve scopes for an authorization request.
 * Fail closed on unknown resource or disallowed scope.
 * Does NOT union mcp:core onto a Messages family.
 */
export function resolveResourceScopePolicy(resource, requestedScopes, env, url) {
  const klass = resolveResourceClass(resource, env, url);
  if (!klass) {
    return {
      ok: false,
      error: "invalid_target",
      status: 400,
      reason: "unregistered_resource"
    };
  }
  const policy = RESOURCE_SCOPE_POLICY.resources[klass];
  const requested = parseRequestedScopes(requestedScopes);
  const allowed = new Set(policy.allowedScopes);
  if (requested.length === 0) {
    return {
      ok: true,
      resource_class: klass,
      scopes: [...policy.defaultScopes],
      defaulted: true
    };
  }
  const disallowed = requested.filter((scope) => !allowed.has(scope));
  if (disallowed.length) {
    return {
      ok: false,
      error: "invalid_scope",
      status: 400,
      reason: "scope_not_allowed_for_resource",
      disallowed,
      resource_class: klass
    };
  }
  return {
    ok: true,
    resource_class: klass,
    scopes: requested,
    defaulted: false
  };
}

export function advertisedAuthorizationScopes() {
  return [CORE_SCOPE, ...MESSAGES_SCOPES];
}
