import test from "node:test";
import assert from "node:assert/strict";
import {
  resolveResourceScopePolicy,
  CANONICAL_MESSAGES_RESOURCE
} from "../src/resource-scope-policy.js";
import {
  handleOauthAuthorizeRequest,
  mergeScopesForStepUp
} from "../src/core-auth.js";

const CORE_RESOURCE = "https://cairnstone.test/mcp/core-auth";
const MESSAGES_RESOURCE = `${CANONICAL_MESSAGES_RESOURCE}/mcp`;
const url = new URL("https://cairnstone.test/oauth/authorize");
const env = { CORE_AUTH_RESOURCE: CORE_RESOURCE };

test("Messages request of AS union narrows to messages scopes only", () => {
  const result = resolveResourceScopePolicy(
    MESSAGES_RESOURCE,
    "mcp:core messages.read messages.write",
    env,
    url
  );
  assert.equal(result.ok, true);
  assert.deepEqual(result.scopes, ["messages.read", "messages.write"]);
  assert.deepEqual(result.narrowed, ["mcp:core"]);
});

test("Messages request of mcp:core + messages.read narrows to messages.read", () => {
  const result = resolveResourceScopePolicy(MESSAGES_RESOURCE, "mcp:core messages.read", env, url);
  assert.equal(result.ok, true);
  assert.deepEqual(result.scopes, ["messages.read"]);
});

test("Messages request of only mcp:core is invalid_scope", () => {
  const result = resolveResourceScopePolicy(MESSAGES_RESOURCE, "mcp:core", env, url);
  assert.equal(result.ok, false);
  assert.equal(result.error, "invalid_scope");
  assert.equal(result.reason, "scope_not_allowed_for_resource");
});

test("Messages request with unknown scope fails even if messages.read present", () => {
  const result = resolveResourceScopePolicy(MESSAGES_RESOURCE, "messages.read evil.scope", env, url);
  assert.equal(result.ok, false);
  assert.deepEqual(result.disallowed, ["evil.scope"]);
});

test("openid is not registered and fails closed", () => {
  const result = resolveResourceScopePolicy(MESSAGES_RESOURCE, "openid messages.read", env, url);
  assert.equal(result.ok, false);
  assert.deepEqual(result.disallowed, ["openid"]);
});

test("Core request of AS union narrows to mcp:core only", () => {
  const result = resolveResourceScopePolicy(
    CORE_RESOURCE,
    "mcp:core messages.read messages.write",
    env,
    url
  );
  assert.equal(result.ok, true);
  assert.deepEqual(result.scopes, ["mcp:core"]);
  assert.deepEqual(result.narrowed, ["messages.read", "messages.write"]);
});

test("Core request of only messages scopes is invalid_scope", () => {
  const result = resolveResourceScopePolicy(CORE_RESOURCE, "messages.read messages.write", env, url);
  assert.equal(result.ok, false);
  assert.equal(result.error, "invalid_scope");
});

test("authorize reports invalid_scope detail without secrets when zero-after-narrow", async () => {
  const result = await handleOauthAuthorizeRequest({
    response_type: "code",
    resource: MESSAGES_RESOURCE,
    scope: "mcp:core",
    client_id: "https://example.invalid/cimd.json",
    redirect_uri: "https://example.invalid/cb",
    code_challenge: "abc",
    code_challenge_method: "S256"
  }, env, url);
  assert.equal(result.ok, false);
  assert.equal(result.error, "invalid_scope");
  assert.equal(result.reason, "scope_not_allowed_for_resource");
  assert.match(String(result.detail), /scope_not_allowed_for_resource/);
  assert.match(String(result.detail), /mcp:core/);
  assert.equal(result.code, undefined);
  assert.equal(result.access_token, undefined);
  assert.equal(JSON.stringify(result).includes("code_verifier"), false);
});

test("refresh cannot widen messages.read to include mcp:core", () => {
  const refresh = mergeScopesForStepUp(["messages.read"], ["mcp:core", "messages.write"], {
    viaAuthorizationServer: false
  });
  assert.equal(refresh.widened, false);
  assert.deepEqual(refresh.scopes, ["messages.read"]);
});
