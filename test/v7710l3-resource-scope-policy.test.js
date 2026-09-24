import test from "node:test";
import assert from "node:assert/strict";
import {
  advertisedAuthorizationScopes,
  resolveResourceScopePolicy,
  parseRequestedScopes,
  CANONICAL_MESSAGES_RESOURCE
} from "../src/resource-scope-policy.js";
import {
  handleOauthAuthorizeRequest,
  handleOauthRegisterRequest,
  handleOauthTokenRequest,
  mergeScopesForStepUp,
  pkceChallengeS256,
  rotateRefreshToken,
  validateAccessToken
} from "../src/core-auth.js";
import { FakeAuthD1, envFor as coreEnvFor } from "./v7710l3-auth-test-harness.js";

const CORE_RESOURCE = "https://cairnstone.test/mcp/core-auth";
const MESSAGES_RESOURCE = CANONICAL_MESSAGES_RESOURCE;

function urlFor() {
  return new URL("https://cairnstone.test/oauth/authorize");
}

function envFor(db) {
  return coreEnvFor(db, { CORE_AUTH_RESOURCE: CORE_RESOURCE, CORE_AUTH_DCR_ENABLED: "true" });
}

test("policy: Core mcp:core allowed; Messages scopes denied on Core", () => {
  const env = { CORE_AUTH_RESOURCE: CORE_RESOURCE };
  const ok = resolveResourceScopePolicy(CORE_RESOURCE, "mcp:core", env, urlFor());
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.scopes, ["mcp:core"]);
  const bad = resolveResourceScopePolicy(CORE_RESOURCE, "messages.read messages.write", env, urlFor());
  assert.equal(bad.ok, false);
  assert.equal(bad.error, "invalid_scope");
});

test("policy: Messages read/write succeed without mcp:core", () => {
  const env = { CORE_AUTH_RESOURCE: CORE_RESOURCE };
  const read = resolveResourceScopePolicy(MESSAGES_RESOURCE, "messages.read", env, urlFor());
  assert.equal(read.ok, true);
  assert.deepEqual(read.scopes, ["messages.read"]);
  assert.equal(read.scopes.includes("mcp:core"), false);
  const both = resolveResourceScopePolicy(MESSAGES_RESOURCE, "messages.read messages.write", env, urlFor());
  assert.equal(both.ok, true);
  assert.deepEqual(both.scopes, ["messages.read", "messages.write"]);
  assert.equal(both.scopes.includes("mcp:core"), false);
});

test("policy: Messages + mcp:core fails; unknown resource fails", () => {
  const env = { CORE_AUTH_RESOURCE: CORE_RESOURCE };
  const mixed = resolveResourceScopePolicy(MESSAGES_RESOURCE, "mcp:core", env, urlFor());
  assert.equal(mixed.error, "invalid_scope");
  const unknown = resolveResourceScopePolicy("https://evil.example/mcp", "mcp:core", env, urlFor());
  assert.equal(unknown.error, "invalid_target");
});

test("empty requested scopes default per resource and never leak mcp:core onto Messages", () => {
  const env = { CORE_AUTH_RESOURCE: CORE_RESOURCE };
  assert.deepEqual(parseRequestedScopes(""), []);
  const core = resolveResourceScopePolicy(CORE_RESOURCE, "", env, urlFor());
  assert.deepEqual(core.scopes, ["mcp:core"]);
  const messages = resolveResourceScopePolicy(MESSAGES_RESOURCE, "", env, urlFor());
  assert.deepEqual(messages.scopes, ["messages.read"]);
  assert.equal(messages.scopes.includes("mcp:core"), false);
});

test("advertised AS scopes include Core and Messages without implying union on mint", () => {
  assert.deepEqual(advertisedAuthorizationScopes(), ["mcp:core", "messages.read", "messages.write"]);
});

async function registerClient(env) {
  return handleOauthRegisterRequest({
    redirect_uris: ["https://client.example/cb"],
    token_endpoint_auth_method: "none"
  }, env);
}

async function pkce() {
  const verifier = "verifier_" + "k".repeat(43);
  return { verifier, challenge: await pkceChallengeS256(verifier) };
}

test("authorize: Core audience + mcp:core succeeds", async () => {
  const db = new FakeAuthD1();
  const env = envFor(db);
  const registered = await registerClient(env);
  const { challenge } = await pkce();
  const authz = await handleOauthAuthorizeRequest({
    response_type: "code",
    client_id: registered.client_id,
    redirect_uri: "https://client.example/cb",
    code_challenge: challenge,
    code_challenge_method: "S256",
    resource: CORE_RESOURCE,
    scope: "mcp:core"
  }, env, urlFor());
  assert.equal(authz.ok, true);
  assert.ok(authz.redirect_url || authz.code || authz.redirect);
});

test("authorize: Core audience + messages.read fails", async () => {
  const db = new FakeAuthD1();
  const env = envFor(db);
  const registered = await registerClient(env);
  const { challenge } = await pkce();
  const authz = await handleOauthAuthorizeRequest({
    response_type: "code",
    client_id: registered.client_id,
    redirect_uri: "https://client.example/cb",
    code_challenge: challenge,
    code_challenge_method: "S256",
    resource: CORE_RESOURCE,
    scope: "messages.read"
  }, env, urlFor());
  assert.equal(authz.ok, false);
  assert.equal(authz.error, "invalid_scope");
});

test("authorize: Messages audience + messages.read has no mcp:core; token resource must match", async () => {
  const db = new FakeAuthD1();
  const env = envFor(db);
  const registered = await registerClient(env);
  const { verifier, challenge } = await pkce();
  const authz = await handleOauthAuthorizeRequest({
    response_type: "code",
    client_id: registered.client_id,
    redirect_uri: "https://client.example/cb",
    code_challenge: challenge,
    code_challenge_method: "S256",
    resource: MESSAGES_RESOURCE,
    scope: "messages.read messages.write"
  }, env, urlFor());
  assert.equal(authz.ok, true);
  const code = authz.code || new URL(authz.redirect || authz.redirect_url).searchParams.get("code");
  const wrong = await handleOauthTokenRequest({
    grant_type: "authorization_code",
    code,
    redirect_uri: "https://client.example/cb",
    client_id: registered.client_id,
    code_verifier: verifier,
    resource: CORE_RESOURCE
  }, env, urlFor());
  assert.equal(wrong.ok, false);
  assert.equal(wrong.error, "invalid_grant");
  const ok = await handleOauthTokenRequest({
    grant_type: "authorization_code",
    code,
    redirect_uri: "https://client.example/cb",
    client_id: registered.client_id,
    code_verifier: verifier,
    resource: MESSAGES_RESOURCE
  }, env, urlFor());
  assert.equal(ok.ok, true);
  const validated = await validateAccessToken(env, ok.access_token, { expectedResource: MESSAGES_RESOURCE });
  assert.equal(validated.ok, true);
  assert.equal(validated.context.resource, MESSAGES_RESOURCE);
  assert.deepEqual(validated.context.scopes, ["messages.read", "messages.write"]);
  assert.equal(validated.context.scopes.includes("mcp:core"), false);
});

test("authorize: Messages audience + mcp:core fails", async () => {
  const db = new FakeAuthD1();
  const env = envFor(db);
  const registered = await registerClient(env);
  const { challenge } = await pkce();
  const authz = await handleOauthAuthorizeRequest({
    response_type: "code",
    client_id: registered.client_id,
    redirect_uri: "https://client.example/cb",
    code_challenge: challenge,
    code_challenge_method: "S256",
    resource: MESSAGES_RESOURCE,
    scope: "mcp:core"
  }, env, urlFor());
  assert.equal(authz.ok, false);
  assert.equal(authz.error, "invalid_scope");
});

test("authorize: unknown resource fails closed", async () => {
  const db = new FakeAuthD1();
  const env = envFor(db);
  const registered = await registerClient(env);
  const { challenge } = await pkce();
  const authz = await handleOauthAuthorizeRequest({
    response_type: "code",
    client_id: registered.client_id,
    redirect_uri: "https://client.example/cb",
    code_challenge: challenge,
    code_challenge_method: "S256",
    resource: "https://unregistered.example/app",
    scope: "mcp:core"
  }, env, urlFor());
  assert.equal(authz.ok, false);
  assert.equal(authz.error, "invalid_target");
});

test("refresh cannot widen resource or scopes", async () => {
  const refreshPath = mergeScopesForStepUp(["messages.read"], ["messages.read", "messages.write", "mcp:core"], {
    viaAuthorizationServer: false
  });
  assert.equal(refreshPath.widened, false);
  assert.deepEqual(refreshPath.scopes, ["messages.read"]);
});
