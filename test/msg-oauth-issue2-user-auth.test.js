// Messages OAuth Issue 2 — authorize user auth + consent tests.
// WebAuthn exercised with in-process ECDSA P-256 (no live Face ID / platform authenticator).

import test from "node:test";
import assert from "node:assert/strict";
import worker from "../src/index.js";
import {
  handleOauthRegisterRequest,
  handleOauthTokenRequest,
  hashSecret,
  pkceChallengeS256,
  redeemAuthorizationCode
} from "../src/core-auth.js";
import {
  approveAuthorizeSession,
  beginOauthAuthorize,
  createAssertionOptions,
  createOwnerAccount,
  createRegistrationOptions,
  denyAuthorizeSession,
  mintLoginInvite,
  redeemLoginInviteForSession,
  verifyAssertionForSession,
  verifyRegistrationForSession
} from "../src/oauth-user-auth.js";
import {
  base64UrlEncode,
  buildCoseEc2Map,
  buildNoneAttestationObject,
  sha256Bytes
} from "../src/webauthn.js";
import { FakeAuthD1 } from "./helpers/fake-auth-d1.js";

const RESOURCE = "https://cairnstone.test/mcp/core-auth";
const ISSUER = "https://cairnstone.test/oauth";
const ORIGIN = "https://cairnstone.test";
const RP_ID = "cairnstone.test";

function envFor(db, extra = {}) {
  return {
    CAIRNSTONE_DB: db,
    CORE_AUTH_RESOURCE: RESOURCE,
    CORE_AUTH_ISSUER: ISSUER,
    CORE_AUTH_ENFORCEMENT: "shadow",
    CORE_AUTH_DCR_ENABLED: "true",
    CORE_AUTH_WEBAUTHN_RP_ID: RP_ID,
    CORE_AUTH_WEBAUTHN_ORIGIN: ORIGIN,
    CAIRNSTONE_OPERATOR_TOKEN: "test-operator-token-not-a-live-secret",
    ...extra
  };
}

function urlFor(path = "/oauth/authorize") {
  return new URL(`${ORIGIN}${path}`);
}

async function registerClient(env, name = "test-client") {
  const registered = await handleOauthRegisterRequest({
    redirect_uris: ["https://client.example/cb"],
    token_endpoint_auth_method: "none",
    client_name: name
  }, env);
  assert.equal(registered.ok, true);
  return registered;
}

async function startAuthorize(env, { clientId, challenge, resource = RESOURCE, scope = "mcp:core", state = null } = {}) {
  const beforeAccounts = dbAccountCountSafe(env);
  const result = await beginOauthAuthorize({
    response_type: "code",
    client_id: clientId,
    redirect_uri: "https://client.example/cb",
    code_challenge: challenge,
    code_challenge_method: "S256",
    resource,
    scope,
    state
  }, env, urlFor());
  assert.equal(result.ok, true, result.error);
  assert.equal(result.code, null);
  assert.equal(result.mode, "consent");
  assert.ok(result.session_token);
  assert.ok(result.html.includes("Authorize"));
  assert.equal(dbAccountCountSafe(env), beforeAccounts);
  return result;
}

function dbAccountCountSafe(env) {
  const db = env.CAIRNSTONE_DB || env.CAIRNSTONE_AUTH_DB;
  return db?.tables?.auth_accounts?.size ?? 0;
}

async function jwkFromCryptoKey(key) {
  return crypto.subtle.exportKey("jwk", key);
}

async function generateEs256KeyPair() {
  return crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
}

function b64uToBytes(v) {
  const padded = v.replace(/-/g, "+").replace(/_/g, "/");
  const pad = padded.length % 4 === 0 ? "" : "=".repeat(4 - (padded.length % 4));
  const binary = atob(padded + pad);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
  return out;
}

async function craftAssertion({ privateKey, challenge, origin, rpId, signCount = 1 }) {
  const clientData = {
    type: "webauthn.get",
    challenge,
    origin,
    crossOrigin: false
  };
  const clientDataJSON = new TextEncoder().encode(JSON.stringify(clientData));
  const rpIdHash = await sha256Bytes(rpId);
  const authData = new Uint8Array(37);
  authData.set(rpIdHash, 0);
  authData[32] = 0x05; // UP | UV
  authData[33] = (signCount >>> 24) & 0xff;
  authData[34] = (signCount >>> 16) & 0xff;
  authData[35] = (signCount >>> 8) & 0xff;
  authData[36] = signCount & 0xff;
  const clientHash = await sha256Bytes(clientDataJSON);
  const signed = new Uint8Array(authData.length + clientHash.length);
  signed.set(authData, 0);
  signed.set(clientHash, authData.length);
  const signature = new Uint8Array(await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    privateKey,
    signed
  ));
  return {
    clientDataJSONB64u: base64UrlEncode(clientDataJSON),
    authenticatorDataB64u: base64UrlEncode(authData),
    signatureB64u: base64UrlEncode(signature)
  };
}

async function craftRegistration({ privateKey, challenge, origin, rpId, credentialIdBytes, signCount = 0 }) {
  const jwk = await jwkFromCryptoKey(privateKey);
  const x = b64uToBytes(jwk.x);
  const y = b64uToBytes(jwk.y);
  const cose = buildCoseEc2Map(x, y);
  const rpIdHash = await sha256Bytes(rpId);
  const attestationObject = buildNoneAttestationObject({
    rpIdHash,
    signCount,
    credentialIdBytes,
    coseKeyMap: cose,
    userVerified: true
  });
  const clientData = {
    type: "webauthn.create",
    challenge,
    origin,
    crossOrigin: false
  };
  const clientDataJSON = new TextEncoder().encode(JSON.stringify(clientData));
  return {
    clientDataJSONB64u: base64UrlEncode(clientDataJSON),
    attestationObjectB64u: base64UrlEncode(attestationObject),
    credentialId: base64UrlEncode(credentialIdBytes),
    publicKeyJwk: { kty: "EC", crv: "P-256", x: jwk.x, y: jwk.y, ext: true }
  };
}

async function seedPasskey(env, accountId, authenticatorId, { credentialId, publicKeyJwk, signCount = 0 } = {}) {
  const db = env.CAIRNSTONE_DB;
  const cred = credentialId || base64UrlEncode(crypto.getRandomValues(new Uint8Array(16)));
  await db.prepare(
    `INSERT INTO auth_passkeys
      (credential_id, realm, account_id, authenticator_id, public_key_jwk_json, sign_count,
       transports_json, user_handle, created_at, last_used_at, status, accepted_state_authority)
     VALUES (?, ?, ?, ?, ?, ?, '[]', ?, ?, NULL, 'active', 0)`
  ).bind(
    cred,
    "core-auth",
    accountId,
    authenticatorId,
    JSON.stringify(publicKeyJwk),
    signCount,
    accountId,
    new Date().toISOString()
  ).run();
  return cred;
}

test("authorize without auth yields no code and creates no anonymous account", async () => {
  const db = new FakeAuthD1();
  const env = envFor(db);
  const client = await registerClient(env);
  const before = db.tables.auth_accounts.size;
  const verifier = "verifier_" + "a".repeat(43);
  const challenge = await pkceChallengeS256(verifier);
  const started = await startAuthorize(env, { clientId: client.client_id, challenge });
  assert.equal(started.code, null);
  assert.equal(db.tables.auth_accounts.size, before);
  assert.equal(db.tables.auth_authorization_codes.size, 0);
  assert.equal(db.tables.auth_authorize_sessions.size, 1);
  assert.match(started.html, /Sign in with passkey/);
});

test("deny path redirects with access_denied", async () => {
  const db = new FakeAuthD1();
  const env = envFor(db);
  const client = await registerClient(env);
  const challenge = await pkceChallengeS256("verifier_" + "b".repeat(43));
  const started = await beginOauthAuthorize({
    response_type: "code",
    client_id: client.client_id,
    redirect_uri: "https://client.example/cb",
    code_challenge: challenge,
    code_challenge_method: "S256",
    resource: RESOURCE,
    state: "state-deny"
  }, env, urlFor());
  const denied = await denyAuthorizeSession(env, { sessionToken: started.session_token });
  assert.equal(denied.ok, true);
  assert.equal(denied.error, "access_denied");
  const loc = new URL(denied.redirect_uri);
  assert.equal(loc.searchParams.get("error"), "access_denied");
  assert.equal(loc.searchParams.get("state"), "state-deny");
  assert.equal(db.tables.auth_authorization_codes.size, 0);
});

test("invite happy path: redeem → approve → code; reuse and expiry rejected", async () => {
  const db = new FakeAuthD1();
  const env = envFor(db);
  const owner = await createOwnerAccount(env, { displayName: "Jared", accountKey: "owner" });
  assert.equal(owner.ok, true);
  assert.match(owner.account.account_id, /^acct_/);
  assert.equal(owner.account.home_workspace_id.startsWith("owner_home_"), true);

  const invite = await mintLoginInvite(env, { accountId: owner.account.account_id, ttlSeconds: 900 });
  assert.equal(invite.ok, true);
  assert.ok(invite.invite_code.startsWith("csinv_"));

  const client = await registerClient(env, "claude-client");
  const verifier = "verifier_" + "c".repeat(43);
  const challenge = await pkceChallengeS256(verifier);
  const started = await beginOauthAuthorize({
    response_type: "code",
    client_id: client.client_id,
    redirect_uri: "https://client.example/cb",
    code_challenge: challenge,
    code_challenge_method: "S256",
    resource: RESOURCE,
    scope: "mcp:core"
  }, env, urlFor());

  const redeemed = await redeemLoginInviteForSession(env, {
    sessionToken: started.session_token,
    inviteCode: invite.invite_code,
    clientIp: "203.0.113.10"
  });
  assert.equal(redeemed.ok, true);
  assert.equal(redeemed.account_id, owner.account.account_id);
  assert.equal(redeemed.step_up_confirmed, false);
  assert.equal(redeemed.offer_passkey_enroll, true);

  // Reuse must be rejected on a fresh authorize session (invite already redeemed).
  const startedReuse = await beginOauthAuthorize({
    response_type: "code",
    client_id: client.client_id,
    redirect_uri: "https://client.example/cb",
    code_challenge: await pkceChallengeS256("verifier_" + "c2".padEnd(43, "c")),
    code_challenge_method: "S256",
    resource: RESOURCE
  }, env, urlFor());
  const reuse = await redeemLoginInviteForSession(env, {
    sessionToken: startedReuse.session_token,
    inviteCode: invite.invite_code,
    clientIp: "203.0.113.10"
  });
  assert.equal(reuse.ok, false);
  assert.equal(reuse.error, "invite_reuse_rejected");

  const approved = await approveAuthorizeSession(env, {
    sessionToken: started.session_token,
    url: urlFor()
  });
  assert.equal(approved.ok, true);
  assert.ok(approved.code);
  assert.equal(approved.account_id, owner.account.account_id);
  assert.equal(approved.step_up_confirmed, false);

  const tokens = await handleOauthTokenRequest({
    grant_type: "authorization_code",
    code: approved.code,
    redirect_uri: "https://client.example/cb",
    client_id: client.client_id,
    code_verifier: verifier,
    resource: RESOURCE
  }, env, urlFor());
  assert.equal(tokens.ok, true);
  assert.equal(tokens.account_id, owner.account.account_id);

  // Expiry: mint a short-TTL invite and advance past it while the session remains valid.
  const invite2 = await mintLoginInvite(env, { accountId: owner.account.account_id, ttlSeconds: 60 });
  const started2 = await beginOauthAuthorize({
    response_type: "code",
    client_id: client.client_id,
    redirect_uri: "https://client.example/cb",
    code_challenge: await pkceChallengeS256("verifier_" + "d".repeat(43)),
    code_challenge_method: "S256",
    resource: RESOURCE
  }, env, urlFor());
  const expired = await redeemLoginInviteForSession(env, {
    sessionToken: started2.session_token,
    inviteCode: invite2.invite_code,
    clientIp: "203.0.113.11",
    nowMs: Date.now() + 90 * 1000
  });
  assert.equal(expired.ok, false);
  assert.equal(expired.error, "invite_expired");
});

test("passkey happy path: assertion → consent → code with step_up_confirmed", async () => {
  const db = new FakeAuthD1();
  const env = envFor(db);
  const owner = await createOwnerAccount(env, { displayName: "Jared", accountKey: "owner-passkey" });
  const keyPair = await generateEs256KeyPair();
  const jwk = await jwkFromCryptoKey(keyPair.privateKey);
  // Store public-only JWK on the authenticator/passkey.
  const publicJwk = { kty: "EC", crv: "P-256", x: jwk.x, y: jwk.y, ext: true };

  // Create passkey authenticator under owner (simulates prior enroll).
  const authenticatorId = "authn_" + "p".repeat(36);
  await db.prepare(
    `INSERT INTO auth_authenticators
      (authenticator_id, schema, realm, account_id, method, status, assurance_class, wallet_account_id, created_at, revoked_at, accepted_state_authority)
     VALUES (?, 'cairnstone-authenticator-v1', ?, ?, 'passkey_webauthn', 'active', 'webauthn', NULL, ?, NULL, 0)`
  ).bind(authenticatorId, "core-auth", owner.account.account_id, new Date().toISOString()).run();
  // Fix INSERT - the fake expects method in args for passkey path. Use oauth-user-auth style insert:
  db.tables.auth_authenticators.set(authenticatorId, {
    authenticator_id: authenticatorId,
    schema: "cairnstone-authenticator-v1",
    realm: "core-auth",
    account_id: owner.account.account_id,
    method: "passkey_webauthn",
    status: "active",
    assurance_class: "webauthn",
    wallet_account_id: null,
    created_at: new Date().toISOString(),
    revoked_at: null,
    accepted_state_authority: 0
  });
  const credentialId = await seedPasskey(env, owner.account.account_id, authenticatorId, {
    publicKeyJwk: publicJwk,
    signCount: 0
  });

  const client = await registerClient(env, "passkey-client");
  const verifier = "verifier_" + "e".repeat(43);
  const challenge = await pkceChallengeS256(verifier);
  const started = await beginOauthAuthorize({
    response_type: "code",
    client_id: client.client_id,
    redirect_uri: "https://client.example/cb",
    code_challenge: challenge,
    code_challenge_method: "S256",
    resource: RESOURCE
  }, env, urlFor());

  const options = await createAssertionOptions(env, {
    sessionToken: started.session_token,
    url: urlFor()
  });
  assert.equal(options.ok, true);
  assert.equal(options.publicKey.userVerification, "required");
  assert.equal(options.publicKey.rpId, RP_ID);

  const assertion = await craftAssertion({
    privateKey: keyPair.privateKey,
    challenge: options.publicKey.challenge,
    origin: ORIGIN,
    rpId: RP_ID,
    signCount: 1
  });

  const verified = await verifyAssertionForSession(env, {
    sessionToken: started.session_token,
    url: urlFor(),
    credential: {
      id: credentialId,
      rawId: credentialId,
      type: "public-key",
      response: {
        clientDataJSON: assertion.clientDataJSONB64u,
        authenticatorData: assertion.authenticatorDataB64u,
        signature: assertion.signatureB64u
      }
    }
  });
  assert.equal(verified.ok, true, verified.error);
  assert.equal(verified.account_id, owner.account.account_id);
  assert.equal(verified.step_up_confirmed, true);
  assert.equal(verified.auth_method, "passkey_webauthn");

  const approved = await approveAuthorizeSession(env, {
    sessionToken: started.session_token,
    url: urlFor()
  });
  assert.equal(approved.ok, true);
  assert.ok(approved.code);
  assert.equal(approved.step_up_confirmed, true);

  const codeHash = await hashSecret(approved.code);
  const codeRow = db.tables.auth_authorization_codes.get(codeHash);
  assert.equal(codeRow.step_up_confirmed, 1);
  assert.equal(codeRow.account_id, owner.account.account_id);
});

test("same account_id across two clients after auth", async () => {
  const db = new FakeAuthD1();
  const env = envFor(db);
  const owner = await createOwnerAccount(env, { displayName: "Jared", accountKey: "owner-multi" });

  async function connectAs(clientName, verifierPad) {
    const invite = await mintLoginInvite(env, { accountId: owner.account.account_id });
    const client = await registerClient(env, clientName);
    const verifier = `verifier_${verifierPad}`;
    const challenge = await pkceChallengeS256(verifier);
    const started = await beginOauthAuthorize({
      response_type: "code",
      client_id: client.client_id,
      redirect_uri: "https://client.example/cb",
      code_challenge: challenge,
      code_challenge_method: "S256",
      resource: RESOURCE
    }, env, urlFor());
    const redeemed = await redeemLoginInviteForSession(env, {
      sessionToken: started.session_token,
      inviteCode: invite.invite_code,
      clientIp: "198.51.100.1"
    });
    assert.equal(redeemed.account_id, owner.account.account_id);
    const approved = await approveAuthorizeSession(env, {
      sessionToken: started.session_token,
      url: urlFor()
    });
    const tokens = await redeemAuthorizationCode(env, {
      code: approved.code,
      codeVerifier: verifier,
      redirectUri: "https://client.example/cb",
      clientId: client.client_id,
      resource: RESOURCE,
      expectedIss: ISSUER
    });
    assert.equal(tokens.ok, true);
    return {
      account_id: tokens.account.account_id,
      connection_id: tokens.connection.connection_id,
      client_id: client.client_id
    };
  }

  const a = await connectAs("Claude", "f".repeat(43));
  const b = await connectAs("ChatGPT", "g".repeat(43));
  assert.equal(a.account_id, b.account_id);
  assert.equal(a.account_id, owner.account.account_id);
  assert.notEqual(a.connection_id, b.connection_id);
  assert.notEqual(a.client_id, b.client_id);
});

test("approve without authentication fails and issues no code", async () => {
  const db = new FakeAuthD1();
  const env = envFor(db);
  const client = await registerClient(env);
  const challenge = await pkceChallengeS256("verifier_" + "h".repeat(43));
  const started = await beginOauthAuthorize({
    response_type: "code",
    client_id: client.client_id,
    redirect_uri: "https://client.example/cb",
    code_challenge: challenge,
    code_challenge_method: "S256",
    resource: RESOURCE
  }, env, urlFor());
  const approved = await approveAuthorizeSession(env, {
    sessionToken: started.session_token,
    url: urlFor()
  });
  assert.equal(approved.ok, false);
  assert.equal(approved.error, "authentication_required");
  assert.equal(db.tables.auth_authorization_codes.size, 0);
});

test("concurrent double Approve issues only one code", async () => {
  const db = new FakeAuthD1();
  const env = envFor(db);
  const owner = await createOwnerAccount(env, { displayName: "Jared", accountKey: "owner-race" });
  const invite = await mintLoginInvite(env, { accountId: owner.account.account_id });
  const client = await registerClient(env, "race-client");
  const started = await beginOauthAuthorize({
    response_type: "code",
    client_id: client.client_id,
    redirect_uri: "https://client.example/cb",
    code_challenge: await pkceChallengeS256("verifier_" + "r".repeat(43)),
    code_challenge_method: "S256",
    resource: RESOURCE
  }, env, urlFor());
  const redeemed = await redeemLoginInviteForSession(env, {
    sessionToken: started.session_token,
    inviteCode: invite.invite_code,
    clientIp: "203.0.113.77"
  });
  assert.equal(redeemed.ok, true);

  // Gate the conditional claim UPDATE until two Approves have both loaded the
  // authenticated session, so we exercise the changes===1 race (not just
  // loadAuthorizeSessionByToken rejecting an already-approved row).
  const origPrepare = db.prepare.bind(db);
  const claimWaiters = [];
  db.prepare = (sql) => {
    const normalized = String(sql).replace(/\s+/g, " ").trim();
    const stmt = origPrepare(sql);
    if (!/^UPDATE auth_authorize_sessions SET status = 'approved'/i.test(normalized)) {
      return stmt;
    }
    return {
      bind(...args) {
        const bound = stmt.bind(...args);
        return {
          async run() {
            await new Promise((resolve) => {
              claimWaiters.push(resolve);
              if (claimWaiters.length >= 2) {
                const ready = claimWaiters.splice(0, claimWaiters.length);
                // Release claims sequentially so FakeAuthD1 status checks serialize.
                ready[0]();
                queueMicrotask(() => ready[1]());
              }
            });
            return bound.run();
          }
        };
      }
    };
  };

  const [first, second] = await Promise.all([
    approveAuthorizeSession(env, { sessionToken: started.session_token, url: urlFor() }),
    approveAuthorizeSession(env, { sessionToken: started.session_token, url: urlFor() })
  ]);

  const outcomes = [first, second];
  const winners = outcomes.filter(r => r.ok === true);
  const losers = outcomes.filter(r => r.ok === false);
  assert.equal(winners.length, 1, JSON.stringify(outcomes));
  assert.equal(losers.length, 1, JSON.stringify(outcomes));
  assert.ok(winners[0].code);
  assert.equal(losers[0].error, "authorize_already_approved");
  assert.equal(losers[0].status, 409);
  assert.equal(db.tables.auth_authorization_codes.size, 1);
  assert.equal(
    [...db.tables.auth_authorize_sessions.values()].filter(s => s.status === "approved").length,
    1
  );
});

test("invite then passkey enroll sets step_up_confirmed on session", async () => {
  const db = new FakeAuthD1();
  const env = envFor(db);
  const owner = await createOwnerAccount(env, { displayName: "Jared", accountKey: "owner-enroll" });
  const invite = await mintLoginInvite(env, { accountId: owner.account.account_id });
  const client = await registerClient(env);
  const started = await beginOauthAuthorize({
    response_type: "code",
    client_id: client.client_id,
    redirect_uri: "https://client.example/cb",
    code_challenge: await pkceChallengeS256("verifier_" + "i".repeat(43)),
    code_challenge_method: "S256",
    resource: RESOURCE
  }, env, urlFor());
  await redeemLoginInviteForSession(env, {
    sessionToken: started.session_token,
    inviteCode: invite.invite_code,
    clientIp: "203.0.113.20"
  });

  const regOpt = await createRegistrationOptions(env, {
    sessionToken: started.session_token,
    url: urlFor()
  });
  assert.equal(regOpt.ok, true);
  const keyPair = await generateEs256KeyPair();
  const credBytes = crypto.getRandomValues(new Uint8Array(16));
  const reg = await craftRegistration({
    privateKey: keyPair.privateKey,
    challenge: regOpt.publicKey.challenge,
    origin: ORIGIN,
    rpId: RP_ID,
    credentialIdBytes: credBytes
  });
  const enrolled = await verifyRegistrationForSession(env, {
    sessionToken: started.session_token,
    url: urlFor(),
    credential: {
      id: reg.credentialId,
      rawId: reg.credentialId,
      type: "public-key",
      response: {
        clientDataJSON: reg.clientDataJSONB64u,
        attestationObject: reg.attestationObjectB64u
      }
    }
  });
  assert.equal(enrolled.ok, true, enrolled.error);
  assert.equal(enrolled.step_up_confirmed, true);
  assert.equal(db.tables.auth_passkeys.size, 1);

  const approved = await approveAuthorizeSession(env, {
    sessionToken: started.session_token,
    url: urlFor()
  });
  assert.equal(approved.ok, true);
  assert.equal(approved.step_up_confirmed, true);
});

test("operator owner-account and login-invites require operator bearer", async () => {
  const db = new FakeAuthD1();
  const env = envFor(db);
  const denied = await worker.fetch(new Request("https://cairnstone.test/oauth/operator/owner-account", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}"
  }), env);
  assert.equal(denied.status, 401);

  const created = await worker.fetch(new Request("https://cairnstone.test/oauth/operator/owner-account", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: "Bearer test-operator-token-not-a-live-secret"
    },
    body: JSON.stringify({ display_name: "Jared", account_key: "owner-http" })
  }), env);
  assert.equal(created.status, 200);
  const body = await created.json();
  assert.equal(body.ok, true);
  assert.ok(body.account_id);

  const inviteRes = await worker.fetch(new Request("https://cairnstone.test/oauth/operator/login-invites", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: "Bearer test-operator-token-not-a-live-secret"
    },
    body: JSON.stringify({ account_id: body.account_id })
  }), env);
  assert.equal(inviteRes.status, 200);
  const inviteBody = await inviteRes.json();
  assert.ok(inviteBody.invite_code);
  assert.ok(inviteBody.invite_id);
});

test("owner account creation does not reuse anonymous acct rows", async () => {
  const db = new FakeAuthD1();
  const env = envFor(db);
  // Seed an anonymous-looking account that must not be selected as owner.
  const anonId = "acct_anonymousorphan00000001";
  const tenId = "ten_anonymousorphan00000001";
  db.tables.auth_tenants.set(tenId, {
    tenant_id: tenId, schema: "cairnstone-tenant-v1", realm: "core-auth",
    status: "active", created_at: new Date().toISOString(), accepted_state_authority: 0
  });
  db.tables.auth_accounts.set(anonId, {
    account_id: anonId, schema: "cairnstone-account-v1", realm: "core-auth",
    home_tenant_id: tenId, status: "active", display_name: null,
    home_workspace_id: "ws_home_anonymous", home_code_session_id: "cs_home_anonymous",
    authz_version: 1, created_at: new Date().toISOString(), closed_at: null, accepted_state_authority: 0
  });

  const owner = await createOwnerAccount(env, { displayName: "Jared", accountKey: "owner-fresh" });
  assert.equal(owner.ok, true);
  assert.notEqual(owner.account.account_id, anonId);
  assert.equal(owner.account.home_workspace_id, "owner_home_owner-fresh");
  assert.equal(db.tables.auth_accounts.has(anonId), true);
});
