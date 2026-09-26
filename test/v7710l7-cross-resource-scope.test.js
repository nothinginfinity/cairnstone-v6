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

test("authorize zero-after-narrow is invalid_scope before code mint", async () => {
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

test("authorize stores canonical bare-origin Messages resource when client sends /mcp", async () => {
  const captured = [];
  const db = {
    prepare(sql) {
      const normalized = String(sql).replace(/\s+/g, " ").trim();
      return {
        bind(...args) {
          return {
            async first() {
              return null;
            },
            async run() {
              if (/INSERT INTO auth_authorization_codes/.test(normalized)) {
                captured.push({ sql: normalized, args });
              }
              return { success: true, meta: { changes: 1 } };
            }
          };
        }
      };
    }
  };
  const result = await handleOauthAuthorizeRequest({
    response_type: "code",
    resource: MESSAGES_RESOURCE,
    scope: "messages.read",
    client_id: "https://example.invalid/cimd.json",
    redirect_uri: "https://chatgpt.com/connector/oauth/-/callback",
    code_challenge: "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
    code_challenge_method: "S256",
    account_id: "acct_test",
    tenant_id: "ten_test",
    authenticator_id: "authn_test"
  }, { CAIRNSTONE_AUTH_DB: db, CORE_AUTH_RESOURCE: CORE_RESOURCE }, url, {
    fetchImpl: async () => new Response(JSON.stringify({
      client_id: "https://example.invalid/cimd.json",
      redirect_uris: ["https://chatgpt.com/connector/oauth/-/callback"]
    }), { status: 200, headers: { "content-type": "application/json" } })
  });

  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(captured.length, 1);
  // createAuthorizationCode bind order: codeHash, realm, accountId, tenantId,
  // connectionId, principalId, authenticatorId, clientId, redirectUri,
  // codeChallenge, resource, scopes_json, iss, expires, created
  const storedResource = captured[0].args[10];
  assert.equal(storedResource, CANONICAL_MESSAGES_RESOURCE);
  assert.notEqual(storedResource, MESSAGES_RESOURCE);
});
