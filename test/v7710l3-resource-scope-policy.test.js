import test from "node:test";
import assert from "node:assert/strict";
import {
  advertisedAuthorizationScopes,
  parseRequestedScopes,
  resolveResourceScopePolicy,
  CANONICAL_CORE_RESOURCE,
  CANONICAL_MESSAGES_RESOURCE
} from "../src/resource-scope-policy.js";
import { mergeScopesForStepUp } from "../src/core-auth.js";

const CORE_RESOURCE = "https://cairnstone.test/mcp/core-auth";
const MESSAGES_RESOURCE = CANONICAL_MESSAGES_RESOURCE;
const url = new URL("https://cairnstone.test/oauth/authorize");
const env = { CORE_AUTH_RESOURCE: CORE_RESOURCE };

test("Core audience + mcp:core succeeds", () => {
  const result = resolveResourceScopePolicy(CORE_RESOURCE, "mcp:core", env, url);
  assert.equal(result.ok, true);
  assert.deepEqual(result.scopes, ["mcp:core"]);
});

test("Core audience + messages.read/write fails", () => {
  const result = resolveResourceScopePolicy(CORE_RESOURCE, "messages.read messages.write", env, url);
  assert.equal(result.ok, false);
  assert.equal(result.error, "invalid_scope");
});

test("Messages audience + messages.read succeeds without mcp:core", () => {
  const result = resolveResourceScopePolicy(MESSAGES_RESOURCE, "messages.read", env, url);
  assert.equal(result.ok, true);
  assert.deepEqual(result.scopes, ["messages.read"]);
  assert.equal(result.scopes.includes("mcp:core"), false);
});

test("Messages audience + messages.read messages.write succeeds without mcp:core", () => {
  const result = resolveResourceScopePolicy(MESSAGES_RESOURCE, "messages.read messages.write", env, url);
  assert.equal(result.ok, true);
  assert.deepEqual(result.scopes, ["messages.read", "messages.write"]);
  assert.equal(result.scopes.includes("mcp:core"), false);
});

test("Messages audience + mcp:core fails", () => {
  const result = resolveResourceScopePolicy(MESSAGES_RESOURCE, "mcp:core", env, url);
  assert.equal(result.ok, false);
  assert.equal(result.error, "invalid_scope");
});

test("unknown resource fails closed", () => {
  const result = resolveResourceScopePolicy("https://unregistered.example/app", "mcp:core", env, url);
  assert.equal(result.ok, false);
  assert.equal(result.error, "invalid_target");
});

test("empty request defaults per resource and does not union mcp:core onto Messages", () => {
  assert.deepEqual(parseRequestedScopes(""), []);
  assert.deepEqual(resolveResourceScopePolicy(CORE_RESOURCE, "", env, url).scopes, ["mcp:core"]);
  const messages = resolveResourceScopePolicy(MESSAGES_RESOURCE, "", env, url);
  assert.deepEqual(messages.scopes, ["messages.read"]);
  assert.equal(messages.scopes.includes("mcp:core"), false);
});

test("refresh cannot widen resource/scopes", () => {
  const refreshPath = mergeScopesForStepUp(["messages.read"], ["messages.read", "messages.write", "mcp:core"], {
    viaAuthorizationServer: false
  });
  assert.equal(refreshPath.widened, false);
  assert.deepEqual(refreshPath.scopes, ["messages.read"]);
});

test("advertised AS scopes list registered families only", () => {
  assert.deepEqual(advertisedAuthorizationScopes(), ["mcp:core", "messages.read", "messages.write"]);
});

test("foreign origin with /mcp/core-auth suffix is invalid_target", () => {
  const evil = resolveResourceScopePolicy("https://evil.example/mcp/core-auth", "mcp:core", env, url);
  assert.equal(evil.error, "invalid_target");
  const lookalike = resolveResourceScopePolicy(
    "https://cairnstone-v6.jaredtechfit.workers.dev.evil.example/mcp/core-auth",
    "mcp:core",
    env,
    url
  );
  assert.equal(lookalike.error, "invalid_target");
});

test("exact configured and exact live Core resources succeed; trailing slash does not broaden origin", () => {
  const configured = resolveResourceScopePolicy(`${CORE_RESOURCE}/`, "mcp:core", env, url);
  assert.equal(configured.ok, true);
  const live = resolveResourceScopePolicy(CANONICAL_CORE_RESOURCE, "mcp:core", env, url);
  assert.equal(live.ok, true);
  const slashOrigin = resolveResourceScopePolicy("https://evil.example//mcp/core-auth", "mcp:core", env, url);
  assert.equal(slashOrigin.error, "invalid_target");
});
