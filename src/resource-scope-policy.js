// V7.7.10l.7 — fail-closed resource → allowed-scopes policy for Core AS.
// Cross-resource registered scopes are narrowed, never granted.
// Unknown resources do not mint. Unknown scopes fail closed.

export const CORE_SCOPE = "mcp:core";
export const MESSAGES_SCOPES = Object.freeze(["messages.read", "messages.write"]);
export const CANONICAL_MESSAGES_RESOURCE = "https://cairnstone-messages.jaredtechfit.workers.dev";
export const CANONICAL_CORE_ORIGIN = "https://cairnstone-v6.jaredtechfit.workers.dev";
export const CANONICAL_CORE_RESOURCE = `${CANONICAL_CORE_ORIGIN}/mcp/core-auth`;

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

/**
 * Map either allowlisted Messages form (bare origin or …/mcp) to the
 * canonical bare-origin audience stored on codes/tokens.
 * Returns null when the value is not an allowlisted Messages resource.
 */
export function canonicalizeMessagesResource(value) {
  if (!isCanonicalMessagesResource(value)) return null;
  return CANONICAL_MESSAGES_RESOURCE;
}

/**
 * True when both values are allowlisted Messages resources (either form).
 * Does not equate Messages with Core or any other audience.
 */
export function messagesResourcesEquivalent(a, b) {
  const left = canonicalizeMessagesResource(a);
  const right = canonicalizeMessagesResource(b);
  return left !== null && left === right;
}

export function isCanonicalCoreResource(value, env, url) {
  const resource = normalizeRegisteredResource(value);
  if (!resource) return false;
  const allowed = new Set();
  const configured = typeof env?.CORE_AUTH_RESOURCE === "string"
    ? normalizeRegisteredResource(env.CORE_AUTH_RESOURCE)
    : "";
  if (configured) allowed.add(configured);
  allowed.add(CANONICAL_CORE_RESOURCE);
  const origin = url?.origin ? normalizeRegisteredResource(url.origin) : "";
  if (origin) allowed.add(`${origin}/mcp/core-auth`);
  return allowed.has(resource);
}

export function resolveResourceClass(resource, env, url) {
  if (isCanonicalCoreResource(resource, env, url)) return "core";
  if (isCanonicalMessagesResource(resource)) return "messages";
  return null;
}

export function registeredScopeOwner(scope) {
  if (scope === CORE_SCOPE) return "core";
  if (MESSAGES_SCOPES.includes(scope)) return "messages";
  return null;
}

export function allRegisteredScopes() {
  return [CORE_SCOPE, ...MESSAGES_SCOPES];
}

/**
 * Resolve scopes for an authorization request.
 * Unknown resource => invalid_target.
 * Known registered scopes owned by a different family are ignored (narrowed).
 * Unknown/unregistered scopes => invalid_scope.
 * After narrowing, zero remaining scopes => invalid_scope (no silent default).
 * Empty request retains per-resource defaults. Never unions mcp:core onto Messages.
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
      defaulted: true,
      narrowed: []
    };
  }
  const eligible = [];
  const foreign = [];
  const unknown = [];
  for (const scope of requested) {
    const owner = registeredScopeOwner(scope);
    if (!owner) unknown.push(scope);
    else if (!allowed.has(scope) || owner !== klass) foreign.push(scope);
    else if (!eligible.includes(scope)) eligible.push(scope);
  }
  if (unknown.length) {
    return {
      ok: false,
      error: "invalid_scope",
      status: 400,
      reason: "scope_not_allowed_for_resource",
      disallowed: unknown,
      resource_class: klass
    };
  }
  if (!eligible.length) {
    return {
      ok: false,
      error: "invalid_scope",
      status: 400,
      reason: "scope_not_allowed_for_resource",
      disallowed: foreign,
      resource_class: klass
    };
  }
  return {
    ok: true,
    resource_class: klass,
    scopes: eligible,
    defaulted: false,
    narrowed: foreign
  };
}

export function advertisedAuthorizationScopes() {
  return allRegisteredScopes();
}
