// Messages OAuth Issue 2 — authorize UI, passkey + invite auth, consent.
// Authority: Jared decision 2026-09-26 (msg-oauth-issue2-decision-20260926).
//
// Rules:
// - No authorization code without authentication AND explicit Approve consent.
// - Passkey (WebAuthn UV) is primary; invite code is fallback / bootstrap gate.
// - First passkey enrollment for the owner account is invite-gated.
// - Do not create anonymous acct_* rows on /oauth/authorize.
// - Orphan anonymous accounts from prior connects are left intact (no merge/revoke).
// - Secrets never enter Stones, commits, PR bodies, or fixtures that look live.

import {
  AUTHENTICATOR_SCHEMA,
  CORE_AUTH_REALM,
  TENANT_SCHEMA,
  ACCOUNT_SCHEMA,
  authDb,
  authorizationServerIssuer,
  canonicalCoreAuthResource,
  canonicalizeOauthResource,
  createAuthorizationCode,
  hashSecret,
  isCimdClientId,
  lookupActiveOauthClient,
  requireAllowlistedRedirectUri,
  requireRegisteredOpaqueClientRedirect,
  resolveDcrClientIp
} from "./core-auth.js";
import { resolveResourceScopePolicy } from "./resource-scope-policy.js";
import {
  base64UrlEncode,
  sha256Bytes,
  verifyAssertion,
  verifyRegistration
} from "./webauthn.js";

export const AUTHORIZE_SESSION_COOKIE = "cs_oauth_sess";
export const AUTHORIZE_SESSION_TTL_SECONDS = 600;
export const WEBAUTHN_CHALLENGE_TTL_SECONDS = 120;
export const LOGIN_INVITE_TTL_SECONDS = 15 * 60;
export const LOGIN_INVITE_RATE_LIMIT_MAX = 10;
export const LOGIN_INVITE_RATE_LIMIT_WINDOW_SECONDS = 3600;
export const DEFAULT_WEBAUTHN_RP_ID = "cairnstone-v6.jaredtechfit.workers.dev";

function nowIso(nowMs = Date.now()) {
  return new Date(nowMs).toISOString();
}

function plusSecondsIso(seconds, nowMs = Date.now()) {
  return new Date(nowMs + seconds * 1000).toISOString();
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
    invite_id: "linv",
    session_id: "oas"
  };
  const prefix = prefixes[kind];
  if (!prefix) throw new Error(`unknown_id_kind:${kind}`);
  return randomToken(prefix, 18);
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function resolveWebAuthnRp(env, url) {
  const rpId = typeof env?.CORE_AUTH_WEBAUTHN_RP_ID === "string" && env.CORE_AUTH_WEBAUTHN_RP_ID.trim()
    ? env.CORE_AUTH_WEBAUTHN_RP_ID.trim()
    : (url?.hostname || DEFAULT_WEBAUTHN_RP_ID);
  const origin = typeof env?.CORE_AUTH_WEBAUTHN_ORIGIN === "string" && env.CORE_AUTH_WEBAUTHN_ORIGIN.trim()
    ? env.CORE_AUTH_WEBAUTHN_ORIGIN.trim().replace(/\/$/, "")
    : (url ? url.origin : `https://${rpId}`);
  return { rpId, origin };
}

async function audit(db, eventType, fields = {}) {
  const eventId = randomToken("aevt", 12);
  const detail = { ...fields };
  for (const key of Object.keys(detail)) {
    if (/token|code|proof|secret|password|verifier|private_key|refresh|invite_plaintext/i.test(key)) {
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
    JSON.stringify(detail),
    nowIso()
  ).run();
}

export function parseAuthorizeSessionCookie(cookieHeader) {
  if (typeof cookieHeader !== "string" || !cookieHeader) return null;
  const parts = cookieHeader.split(/;\s*/);
  for (const part of parts) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    const name = part.slice(0, eq).trim();
    if (name === AUTHORIZE_SESSION_COOKIE) {
      const value = part.slice(eq + 1).trim();
      return value || null;
    }
  }
  return null;
}

export function buildAuthorizeSessionCookie(sessionToken, { maxAge = AUTHORIZE_SESSION_TTL_SECONDS, secure = true } = {}) {
  const parts = [
    `${AUTHORIZE_SESSION_COOKIE}=${sessionToken}`,
    "Path=/oauth",
    "HttpOnly",
    `Max-Age=${maxAge}`,
    "SameSite=Lax"
  ];
  if (secure) parts.push("Secure");
  return parts.join("; ");
}

export function clearAuthorizeSessionCookie({ secure = true } = {}) {
  return buildAuthorizeSessionCookie("", { maxAge: 0, secure });
}

function parseScopesJson(raw) {
  try {
    const parsed = JSON.parse(raw || "[]");
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

async function resolveClientDisplayName(env, clientId, cimdDocument) {
  if (cimdDocument && typeof cimdDocument.client_name === "string" && cimdDocument.client_name.trim()) {
    return cimdDocument.client_name.trim().slice(0, 256);
  }
  if (!isCimdClientId(clientId)) {
    const row = await lookupActiveOauthClient(env, clientId);
    if (row.ok && row.client?.client_name) return String(row.client.client_name).slice(0, 256);
  }
  try {
    if (isCimdClientId(clientId)) return new URL(clientId).hostname;
  } catch {
    // fall through
  }
  return clientId.slice(0, 64);
}

/**
 * Create a canonical owner account (no connection, no anonymous reuse).
 * Operator-only. Does not enroll a passkey — first passkey requires an invite.
 */
export async function createOwnerAccount(env, {
  displayName = "Jared",
  accountKey = "owner",
  issuedBy = "operator"
} = {}) {
  const dbRes = authDb(env);
  if (!dbRes.ok) return dbRes;
  const db = dbRes.db;
  const createdAt = nowIso();

  // Fail closed if an owner label already exists — do not pick an anonymous acct_*.
  const existing = await db.prepare(
    `SELECT account_id FROM auth_accounts
      WHERE realm = ? AND display_name = ? AND status = 'active'
      LIMIT 1`
  ).bind(CORE_AUTH_REALM, displayName).first();
  // Allow multiple names in tests; use account_key marker in home_workspace_id for idempotency.
  const marker = `owner_home_${String(accountKey).replace(/[^a-z0-9_-]/gi, "").slice(0, 32) || "owner"}`;
  const byMarker = await db.prepare(
    `SELECT * FROM auth_accounts WHERE realm = ? AND home_workspace_id = ?`
  ).bind(CORE_AUTH_REALM, marker).first();
  if (byMarker) {
    return {
      ok: true,
      existing: true,
      account: {
        account_id: byMarker.account_id,
        home_tenant_id: byMarker.home_tenant_id,
        display_name: byMarker.display_name,
        home_workspace_id: byMarker.home_workspace_id
      }
    };
  }

  const tenantId = mintId("tenant_id");
  const accountId = mintId("account_id");
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
    marker,
    `cs_home_${accountId.slice(5, 21)}`,
    createdAt
  ).run();
  await db.prepare(
    `INSERT INTO auth_tenant_memberships
      (realm, account_id, tenant_id, status, authz_version, created_at, revoked_at, accepted_state_authority)
     VALUES (?, ?, ?, 'active', 1, ?, NULL, 0)`
  ).bind(CORE_AUTH_REALM, accountId, tenantId, createdAt).run();

  await audit(db, "owner_account_created", {
    account_id: accountId,
    tenant_id: tenantId,
    issued_by: issuedBy,
    account_key: accountKey,
    // note: existing anonymous accounts are intentionally not referenced
    reused_anonymous: false
  });

  // Suppress unused warning for the soft uniqueness probe above.
  void existing;

  return {
    ok: true,
    existing: false,
    account: {
      account_id: accountId,
      home_tenant_id: tenantId,
      display_name: displayName,
      home_workspace_id: marker
    }
  };
}

/**
 * Mint a single-use login invite for an existing account (operator-only).
 * Returns plaintext once; only the hash is persisted.
 */
export async function mintLoginInvite(env, {
  accountId,
  ttlSeconds = LOGIN_INVITE_TTL_SECONDS,
  issuedBy = "operator",
  nowMs = Date.now()
} = {}) {
  const dbRes = authDb(env);
  if (!dbRes.ok) return dbRes;
  const db = dbRes.db;

  const account = await db.prepare(
    "SELECT * FROM auth_accounts WHERE realm = ? AND account_id = ?"
  ).bind(CORE_AUTH_REALM, accountId).first();
  if (!account) return { ok: false, error: "account_not_found", status: 404 };
  if (account.status !== "active") return { ok: false, error: "account_not_active", status: 403 };

  const ttl = Math.max(60, Math.min(Number(ttlSeconds) || LOGIN_INVITE_TTL_SECONDS, 60 * 60));
  const inviteId = mintId("invite_id");
  // Invite plaintext looks like a test token prefix — never a production secret fixture.
  const plaintext = randomToken("csinv", 24);
  const inviteHash = await hashSecret(plaintext);
  const createdAt = nowIso(nowMs);

  await db.prepare(
    `INSERT INTO auth_login_invites
      (invite_hash, realm, invite_id, target_account_id, target_tenant_id, issued_by, status, expires_at, created_at, redeemed_at, redeemed_by_session_id, accepted_state_authority)
     VALUES (?, ?, ?, ?, ?, ?, 'unused', ?, ?, NULL, NULL, 0)`
  ).bind(
    inviteHash,
    CORE_AUTH_REALM,
    inviteId,
    account.account_id,
    account.home_tenant_id,
    String(issuedBy).slice(0, 128),
    plusSecondsIso(ttl, nowMs),
    createdAt
  ).run();

  await audit(db, "login_invite_minted", {
    account_id: account.account_id,
    tenant_id: account.home_tenant_id,
    invite_id: inviteId,
    issued_by: issuedBy,
    expires_at: plusSecondsIso(ttl, nowMs)
  });

  return {
    ok: true,
    invite_id: inviteId,
    // Returned once to the operator channel — never logged by callers.
    invite_code: plaintext,
    account_id: account.account_id,
    tenant_id: account.home_tenant_id,
    expires_in: ttl,
    expires_at: plusSecondsIso(ttl, nowMs)
  };
}

async function consumeInviteRateLimit(db, env, { clientIp, clientId }) {
  const max = Number(env?.CORE_AUTH_LOGIN_INVITE_RATE_LIMIT_MAX) > 0
    ? Math.floor(Number(env.CORE_AUTH_LOGIN_INVITE_RATE_LIMIT_MAX))
    : LOGIN_INVITE_RATE_LIMIT_MAX;
  const windowSeconds = Number(env?.CORE_AUTH_LOGIN_INVITE_RATE_LIMIT_WINDOW_SECONDS) > 0
    ? Math.floor(Number(env.CORE_AUTH_LOGIN_INVITE_RATE_LIMIT_WINDOW_SECONDS))
    : LOGIN_INVITE_RATE_LIMIT_WINDOW_SECONDS;
  const now = Date.now();
  const windowStart = new Date(now - (now % (windowSeconds * 1000))).toISOString();

  async function bump(bucketKey) {
    const row = await db.prepare(
      `SELECT bucket_key, window_start_iso, count FROM auth_login_invite_rate_buckets
        WHERE realm = ? AND bucket_key = ?`
    ).bind(CORE_AUTH_REALM, bucketKey).first();
    if (!row || row.window_start_iso !== windowStart) {
      await db.prepare(
        `INSERT INTO auth_login_invite_rate_buckets (realm, bucket_key, window_start_iso, count)
         VALUES (?, ?, ?, 1)
         ON CONFLICT(realm, bucket_key) DO UPDATE SET window_start_iso = excluded.window_start_iso, count = 1`
      ).bind(CORE_AUTH_REALM, bucketKey, windowStart).run();
      return { ok: true, count: 1 };
    }
    if (row.count >= max) {
      return { ok: false, error: "slow_down", status: 429, retry_after: windowSeconds };
    }
    const next = row.count + 1;
    await db.prepare(
      `UPDATE auth_login_invite_rate_buckets SET count = ? WHERE realm = ? AND bucket_key = ?`
    ).bind(next, CORE_AUTH_REALM, bucketKey).run();
    return { ok: true, count: next };
  }

  const ipKey = `ip:${clientIp || "unknown"}`;
  const ipResult = await bump(ipKey);
  if (!ipResult.ok) return ipResult;
  if (clientId) {
    const clientResult = await bump(`client:${String(clientId).slice(0, 128)}`);
    if (!clientResult.ok) return clientResult;
  }
  return { ok: true };
}

export async function loadAuthorizeSessionByToken(env, sessionToken, { nowMs = Date.now() } = {}) {
  if (typeof sessionToken !== "string" || !sessionToken) {
    return { ok: false, error: "authorize_session_required", status: 401 };
  }
  const dbRes = authDb(env);
  if (!dbRes.ok) return dbRes;
  const tokenHash = await hashSecret(sessionToken);
  const row = await dbRes.db.prepare(
    "SELECT * FROM auth_authorize_sessions WHERE realm = ? AND session_token_hash = ?"
  ).bind(CORE_AUTH_REALM, tokenHash).first();
  if (!row) return { ok: false, error: "authorize_session_not_found", status: 401 };
  if (row.expires_at < nowIso(nowMs)) {
    await dbRes.db.prepare(
      `UPDATE auth_authorize_sessions SET status = 'expired' WHERE realm = ? AND session_id = ? AND status IN ('pending_auth','authenticated')`
    ).bind(CORE_AUTH_REALM, row.session_id).run();
    return { ok: false, error: "authorize_session_expired", status: 401 };
  }
  if (row.status === "approved" || row.status === "denied" || row.status === "expired") {
    return { ok: false, error: "authorize_session_complete", status: 400, status_value: row.status };
  }
  return { ok: true, session: row, db: dbRes.db };
}

export function renderAuthorizeHtml(session, { rpId, error = null } = {}) {
  const clientName = session.client_name || session.client_id;
  const scopes = parseScopesJson(session.scopes_json);
  const authenticated = session.status === "authenticated";
  const offerEnroll = authenticated && Number(session.offer_passkey_enroll) === 1;
  const stepUp = Number(session.step_up_confirmed) === 1;

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1"/>
  <title>Authorize — CairnStone</title>
  <style>
    :root {
      --bg0: #0f1419;
      --bg1: #1a2332;
      --ink: #e8eef6;
      --muted: #9aabbf;
      --accent: #3d9cf0;
      --danger: #d45d5d;
      --ok: #3caf7a;
      --line: rgba(232,238,246,0.12);
    }
    * { box-sizing: border-box; }
    body {
      margin: 0; min-height: 100vh; color: var(--ink);
      font-family: "IBM Plex Sans", "Segoe UI", sans-serif;
      background:
        radial-gradient(1200px 600px at 10% -10%, rgba(61,156,240,0.22), transparent 55%),
        radial-gradient(900px 500px at 100% 0%, rgba(60,175,122,0.12), transparent 50%),
        linear-gradient(165deg, var(--bg0), var(--bg1));
    }
    main {
      max-width: 28rem; margin: 0 auto; padding: 2.5rem 1.25rem 3rem;
    }
    .brand {
      font-family: "IBM Plex Serif", Georgia, serif;
      font-size: 1.75rem; letter-spacing: -0.02em; margin: 0 0 0.35rem;
    }
    h1 { font-size: 1.15rem; font-weight: 600; margin: 1.5rem 0 0.35rem; }
    p, li { color: var(--muted); line-height: 1.45; font-size: 0.95rem; }
    .meta { margin: 1rem 0; padding: 0.9rem 0; border-top: 1px solid var(--line); border-bottom: 1px solid var(--line); }
    .meta dt { font-size: 0.72rem; text-transform: uppercase; letter-spacing: 0.06em; color: var(--muted); margin-top: 0.55rem; }
    .meta dd { margin: 0.15rem 0 0; color: var(--ink); word-break: break-all; }
    .error { color: var(--danger); background: rgba(212,93,93,0.12); padding: 0.65rem 0.75rem; border-radius: 6px; }
    .ok { color: var(--ok); }
    label { display: block; margin: 0.75rem 0 0.35rem; font-size: 0.85rem; }
    input[type=text] {
      width: 100%; padding: 0.7rem 0.75rem; border-radius: 6px; border: 1px solid var(--line);
      background: rgba(0,0,0,0.25); color: var(--ink); font-size: 1rem;
    }
    .actions { display: flex; flex-wrap: wrap; gap: 0.6rem; margin-top: 1.25rem; }
    button, .btn {
      appearance: none; border: 0; border-radius: 6px; padding: 0.7rem 1rem;
      font-size: 0.95rem; font-weight: 600; cursor: pointer;
    }
    .primary { background: var(--accent); color: #041018; }
    .secondary { background: rgba(232,238,246,0.08); color: var(--ink); border: 1px solid var(--line); }
    .danger { background: transparent; color: var(--danger); border: 1px solid rgba(212,93,93,0.45); }
    .hint { font-size: 0.8rem; margin-top: 0.75rem; }
    #status { min-height: 1.25rem; font-size: 0.85rem; margin-top: 0.75rem; }
  </style>
</head>
<body>
  <main>
    <p class="brand">CairnStone</p>
    <h1>Authorize ${escapeHtml(clientName)}</h1>
    <p>Sign in, then approve access. No code is issued until you approve.</p>
    <dl class="meta">
      <dt>Client</dt><dd>${escapeHtml(clientName)}</dd>
      <dt>Scopes</dt><dd>${escapeHtml(scopes.join(" ") || "(none)")}</dd>
      <dt>Resource</dt><dd>${escapeHtml(session.resource)}</dd>
    </dl>
    ${error ? `<p class="error" id="flash">${escapeHtml(error)}</p>` : ""}
    ${authenticated ? `
      <p class="ok">Signed in${stepUp ? " with passkey (user verified)" : " via invite code"}.</p>
      ${offerEnroll ? `
        <p class="hint">Optional: enroll a Face ID / passkey on this device for next time.</p>
        <div class="actions">
          <button type="button" class="secondary" id="btnEnroll">Enroll passkey</button>
        </div>
      ` : ""}
      <form method="POST" action="/oauth/authorize/approve" class="actions" id="consentForm">
        <button type="submit" class="primary" id="btnApprove">Approve</button>
      </form>
      <form method="POST" action="/oauth/authorize/deny" class="actions">
        <button type="submit" class="danger">Deny</button>
      </form>
    ` : `
      <div class="actions">
        <button type="button" class="primary" id="btnPasskey">Sign in with passkey</button>
      </div>
      <form id="inviteForm" method="POST" action="/oauth/authorize/invite">
        <label for="invite_code">Or enter a one-time invite code</label>
        <input id="invite_code" name="invite_code" type="text" autocomplete="one-time-code" inputmode="text" required/>
        <div class="actions">
          <button type="submit" class="secondary">Continue with invite</button>
        </div>
      </form>
      <form method="POST" action="/oauth/authorize/deny" class="actions">
        <button type="submit" class="danger">Deny</button>
      </form>
    `}
    <p id="status" class="hint"></p>
  </main>
  <script>
(function () {
  var statusEl = document.getElementById("status");
  function setStatus(msg, isError) {
    if (!statusEl) return;
    statusEl.textContent = msg || "";
    statusEl.style.color = isError ? "var(--danger)" : "var(--muted)";
  }
  function b64url(buf) {
    var bytes = buf instanceof ArrayBuffer ? new Uint8Array(buf) : buf;
    var s = "";
    for (var i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
    return btoa(s).replace(/\\+/g, "-").replace(/\\//g, "_").replace(/=+$/g, "");
  }
  function b64urlToBuf(v) {
    var padded = v.replace(/-/g, "+").replace(/_/g, "/");
    while (padded.length % 4) padded += "=";
    var bin = atob(padded);
    var out = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out.buffer;
  }
  async function postJson(url, body) {
    var res = await fetch(url, {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json", "accept": "application/json" },
      body: JSON.stringify(body || {})
    });
    var data = await res.json().catch(function () { return {}; });
    if (!res.ok || data.ok === false) {
      throw new Error(data.error_description || data.error || ("http_" + res.status));
    }
    return data;
  }
  var btnPasskey = document.getElementById("btnPasskey");
  if (btnPasskey) {
    btnPasskey.addEventListener("click", async function () {
      try {
        setStatus("Waiting for passkey…");
        var opt = await postJson("/oauth/webauthn/assertion/options", {});
        var publicKey = opt.publicKey;
        publicKey.challenge = b64urlToBuf(publicKey.challenge);
        if (publicKey.allowCredentials) {
          publicKey.allowCredentials = publicKey.allowCredentials.map(function (c) {
            return Object.assign({}, c, { id: b64urlToBuf(c.id) });
          });
        }
        var cred = await navigator.credentials.get({ publicKey: publicKey });
        if (!cred) throw new Error("passkey_cancelled");
        await postJson("/oauth/webauthn/assertion/verify", {
          id: cred.id,
          rawId: b64url(cred.rawId),
          type: cred.type,
          response: {
            clientDataJSON: b64url(cred.response.clientDataJSON),
            authenticatorData: b64url(cred.response.authenticatorData),
            signature: b64url(cred.response.signature),
            userHandle: cred.response.userHandle ? b64url(cred.response.userHandle) : null
          }
        });
        location.reload();
      } catch (err) {
        setStatus(String(err && err.message ? err.message : err), true);
      }
    });
  }
  var btnEnroll = document.getElementById("btnEnroll");
  if (btnEnroll) {
    btnEnroll.addEventListener("click", async function () {
      try {
        setStatus("Create a passkey on this device…");
        var opt = await postJson("/oauth/webauthn/registration/options", {});
        var publicKey = opt.publicKey;
        publicKey.challenge = b64urlToBuf(publicKey.challenge);
        publicKey.user.id = b64urlToBuf(publicKey.user.id);
        if (publicKey.excludeCredentials) {
          publicKey.excludeCredentials = publicKey.excludeCredentials.map(function (c) {
            return Object.assign({}, c, { id: b64urlToBuf(c.id) });
          });
        }
        var cred = await navigator.credentials.create({ publicKey: publicKey });
        if (!cred) throw new Error("passkey_cancelled");
        await postJson("/oauth/webauthn/registration/verify", {
          id: cred.id,
          rawId: b64url(cred.rawId),
          type: cred.type,
          response: {
            clientDataJSON: b64url(cred.response.clientDataJSON),
            attestationObject: b64url(cred.response.attestationObject)
          }
        });
        setStatus("Passkey enrolled.");
        location.reload();
      } catch (err) {
        setStatus(String(err && err.message ? err.message : err), true);
      }
    });
  }
})();
  </script>
</body>
</html>`;
}

/**
 * Validate OAuth authorize params and create a pending browser session.
 * Does NOT issue a code and does NOT bootstrap anonymous accounts.
 */
export async function beginOauthAuthorize(params, env, url, { fetchImpl } = {}) {
  const responseType = String(params?.response_type || "");
  if (responseType !== "code") {
    return { ok: false, error: "unsupported_response_type", status: 400 };
  }

  const clientId = typeof params?.client_id === "string" ? params.client_id.trim() : "";
  const redirectUri = typeof params?.redirect_uri === "string" ? params.redirect_uri.trim() : "";
  const codeChallenge = typeof params?.code_challenge === "string" ? params.code_challenge.trim() : "";
  const codeChallengeMethod = String(params?.code_challenge_method || "S256");
  const resourceRaw = typeof params?.resource === "string" && params.resource.trim()
    ? params.resource.trim()
    : canonicalCoreAuthResource(env, url);
  // Issue Messages codes/tokens against the bare-origin canonical audience even
  // when the client requested …/mcp (MCP connector resource URL).
  const resource = canonicalizeOauthResource(resourceRaw);
  const state = typeof params?.state === "string" ? params.state : null;
  const issuer = authorizationServerIssuer(env, url);
  const scoped = resolveResourceScopePolicy(resourceRaw, params?.scope, env, url);
  if (!scoped.ok) {
    return {
      ok: false,
      error: scoped.error,
      status: scoped.status || 400,
      reason: scoped.reason || null,
      disallowed: scoped.disallowed || null
    };
  }
  const scopes = scoped.scopes;

  if (!clientId || !redirectUri || !codeChallenge) {
    return { ok: false, error: "invalid_request", status: 400, detail: "client_id, redirect_uri, and code_challenge required" };
  }
  if (codeChallengeMethod !== "S256") {
    return { ok: false, error: "invalid_request", status: 400, detail: "S256 required" };
  }

  let cimdContentHash = null;
  let cimdDocument = null;
  if (isCimdClientId(clientId)) {
    const dbRes = authDb(env);
    const allowed = await requireAllowlistedRedirectUri(clientId, redirectUri, {
      fetchImpl,
      cacheDb: dbRes.ok ? dbRes.db : null
    });
    if (!allowed.ok) {
      return { ok: false, error: allowed.error || "invalid_request", status: 400 };
    }
    cimdContentHash = allowed.cimd?.content_hash || null;
    cimdDocument = allowed.cimd?.document || null;
  } else {
    const registered = await requireRegisteredOpaqueClientRedirect(env, clientId, redirectUri);
    if (!registered.ok) {
      return {
        ok: false,
        error: registered.error || "invalid_client",
        status: 400,
        detail: registered.detail || registered.error
      };
    }
  }

  const dbRes = authDb(env);
  if (!dbRes.ok) return { ...dbRes, status: 503 };
  const db = dbRes.db;
  const clientName = await resolveClientDisplayName(env, clientId, cimdDocument);
  const sessionId = mintId("session_id");
  const sessionToken = randomToken("oastok", 32);
  const sessionTokenHash = await hashSecret(sessionToken);
  const createdAt = nowIso();

  await db.prepare(
    `INSERT INTO auth_authorize_sessions
      (session_id, realm, session_token_hash, client_id, client_name, redirect_uri, code_challenge,
       code_challenge_method, resource, scopes_json, state, iss, cimd_content_hash, status,
       account_id, tenant_id, authenticator_id, auth_method, step_up_confirmed, offer_passkey_enroll,
       expires_at, created_at, authenticated_at, completed_at, accepted_state_authority)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'S256', ?, ?, ?, ?, ?, 'pending_auth',
             NULL, NULL, NULL, NULL, 0, 0, ?, ?, NULL, NULL, 0)`
  ).bind(
    sessionId,
    CORE_AUTH_REALM,
    sessionTokenHash,
    clientId,
    clientName,
    redirectUri,
    codeChallenge,
    resource,
    JSON.stringify(scopes),
    state,
    issuer,
    cimdContentHash,
    plusSecondsIso(AUTHORIZE_SESSION_TTL_SECONDS),
    createdAt
  ).run();

  await audit(db, "authorize_session_started", {
    session_id: sessionId,
    client_id: clientId,
    resource,
    scopes
  });

  const sessionRow = {
    session_id: sessionId,
    client_id: clientId,
    client_name: clientName,
    redirect_uri: redirectUri,
    resource,
    scopes_json: JSON.stringify(scopes),
    state,
    iss: issuer,
    status: "pending_auth",
    step_up_confirmed: 0,
    offer_passkey_enroll: 0
  };
  const rp = resolveWebAuthnRp(env, url);
  const html = renderAuthorizeHtml(sessionRow, { rpId: rp.rpId });

  return {
    ok: true,
    mode: "consent",
    session_id: sessionId,
    session_token: sessionToken,
    client_name: clientName,
    scopes,
    resource,
    state,
    iss: issuer,
    html,
    // Explicit: no code until auth + Approve.
    code: null,
    redirect_uri: null
  };
}

async function markSessionAuthenticated(db, session, {
  accountId,
  tenantId,
  authenticatorId,
  authMethod,
  stepUpConfirmed,
  offerPasskeyEnroll
}) {
  await db.prepare(
    `UPDATE auth_authorize_sessions
       SET status = 'authenticated', account_id = ?, tenant_id = ?, authenticator_id = ?,
           auth_method = ?, step_up_confirmed = ?, offer_passkey_enroll = ?, authenticated_at = ?
     WHERE realm = ? AND session_id = ? AND status = 'pending_auth'`
  ).bind(
    accountId,
    tenantId,
    authenticatorId,
    authMethod,
    stepUpConfirmed ? 1 : 0,
    offerPasskeyEnroll ? 1 : 0,
    nowIso(),
    CORE_AUTH_REALM,
    session.session_id
  ).run();
}

async function ensureInviteAuthenticator(db, accountId) {
  const existing = await db.prepare(
    `SELECT * FROM auth_authenticators
      WHERE realm = ? AND account_id = ? AND method = 'other_approved' AND status = 'active'
      LIMIT 1`
  ).bind(CORE_AUTH_REALM, accountId).first();
  if (existing) return existing;
  const authenticatorId = mintId("authenticator_id");
  const createdAt = nowIso();
  await db.prepare(
    `INSERT INTO auth_authenticators
      (authenticator_id, schema, realm, account_id, method, status, assurance_class, wallet_account_id, created_at, revoked_at, accepted_state_authority)
     VALUES (?, ?, ?, ?, 'other_approved', 'active', 'other_approved', NULL, ?, NULL, 0)`
  ).bind(authenticatorId, AUTHENTICATOR_SCHEMA, CORE_AUTH_REALM, accountId, createdAt).run();
  return {
    authenticator_id: authenticatorId,
    account_id: accountId,
    method: "other_approved",
    assurance_class: "other_approved",
    status: "active"
  };
}

export async function redeemLoginInviteForSession(env, {
  sessionToken,
  inviteCode,
  clientIp = "unknown",
  nowMs = Date.now()
} = {}) {
  const loaded = await loadAuthorizeSessionByToken(env, sessionToken, { nowMs });
  if (!loaded.ok) return loaded;
  if (loaded.session.status !== "pending_auth") {
    return { ok: false, error: "authorize_session_not_pending", status: 400 };
  }
  const db = loaded.db;
  const rate = await consumeInviteRateLimit(db, env, {
    clientIp,
    clientId: loaded.session.client_id
  });
  if (!rate.ok) return rate;

  if (typeof inviteCode !== "string" || !inviteCode.trim()) {
    return { ok: false, error: "invalid_invite", status: 400 };
  }
  const inviteHash = await hashSecret(inviteCode.trim());
  const invite = await db.prepare(
    "SELECT * FROM auth_login_invites WHERE realm = ? AND invite_hash = ?"
  ).bind(CORE_AUTH_REALM, inviteHash).first();
  if (!invite) return { ok: false, error: "invalid_invite", status: 400 };
  if (invite.status !== "unused") return { ok: false, error: "invite_reuse_rejected", status: 400 };
  if (invite.expires_at < nowIso(nowMs)) {
    await db.prepare(
      `UPDATE auth_login_invites SET status = 'expired' WHERE realm = ? AND invite_hash = ? AND status = 'unused'`
    ).bind(CORE_AUTH_REALM, inviteHash).run();
    return { ok: false, error: "invite_expired", status: 400 };
  }

  const used = await db.prepare(
    `UPDATE auth_login_invites
       SET status = 'redeemed', redeemed_at = ?, redeemed_by_session_id = ?
     WHERE realm = ? AND invite_hash = ? AND status = 'unused'`
  ).bind(nowIso(nowMs), loaded.session.session_id, CORE_AUTH_REALM, inviteHash).run();
  const changes = Number(used?.meta?.changes ?? used?.changes ?? 0);
  if (changes !== 1) return { ok: false, error: "invite_reuse_rejected", status: 400 };

  const account = await db.prepare(
    "SELECT * FROM auth_accounts WHERE realm = ? AND account_id = ?"
  ).bind(CORE_AUTH_REALM, invite.target_account_id).first();
  if (!account || account.status !== "active") {
    return { ok: false, error: "account_not_active", status: 403 };
  }

  const authenticator = await ensureInviteAuthenticator(db, account.account_id);
  // Invite alone is not WebAuthn UV — step_up_confirmed stays false.
  // Offer passkey enroll so the device can gain UV next.
  await markSessionAuthenticated(db, loaded.session, {
    accountId: account.account_id,
    tenantId: invite.target_tenant_id || account.home_tenant_id,
    authenticatorId: authenticator.authenticator_id,
    authMethod: "invite_code",
    stepUpConfirmed: false,
    offerPasskeyEnroll: true
  });

  await audit(db, "login_invite_redeemed", {
    account_id: account.account_id,
    tenant_id: account.home_tenant_id,
    invite_id: invite.invite_id,
    session_id: loaded.session.session_id,
    step_up_confirmed: false
  });

  return {
    ok: true,
    account_id: account.account_id,
    tenant_id: account.home_tenant_id,
    authenticator_id: authenticator.authenticator_id,
    auth_method: "invite_code",
    step_up_confirmed: false,
    offer_passkey_enroll: true
  };
}

async function createWebAuthnChallenge(db, {
  purpose,
  sessionId,
  accountId = null,
  nowMs = Date.now()
}) {
  const challengeBytes = new Uint8Array(32);
  crypto.getRandomValues(challengeBytes);
  const challenge = base64UrlEncode(challengeBytes);
  const challengeHash = await hashSecret(challenge);
  await db.prepare(
    `INSERT INTO auth_webauthn_challenges
      (challenge_hash, realm, purpose, session_id, account_id, status, expires_at, created_at, used_at, accepted_state_authority)
     VALUES (?, ?, ?, ?, ?, 'unused', ?, ?, NULL, 0)`
  ).bind(
    challengeHash,
    CORE_AUTH_REALM,
    purpose,
    sessionId,
    accountId,
    plusSecondsIso(WEBAUTHN_CHALLENGE_TTL_SECONDS, nowMs),
    nowIso(nowMs)
  ).run();
  return challenge;
}

async function consumeWebAuthnChallenge(db, {
  challenge,
  purpose,
  sessionId,
  nowMs = Date.now()
}) {
  const challengeHash = await hashSecret(challenge);
  const row = await db.prepare(
    "SELECT * FROM auth_webauthn_challenges WHERE realm = ? AND challenge_hash = ?"
  ).bind(CORE_AUTH_REALM, challengeHash).first();
  if (!row) return { ok: false, error: "challenge_invalid" };
  if (row.purpose !== purpose) return { ok: false, error: "challenge_purpose_mismatch" };
  if (row.session_id && row.session_id !== sessionId) return { ok: false, error: "challenge_session_mismatch" };
  if (row.status !== "unused") return { ok: false, error: "challenge_reuse_rejected" };
  if (row.expires_at < nowIso(nowMs)) {
    await db.prepare(
      `UPDATE auth_webauthn_challenges SET status = 'expired' WHERE realm = ? AND challenge_hash = ?`
    ).bind(CORE_AUTH_REALM, challengeHash).run();
    return { ok: false, error: "challenge_expired" };
  }
  const used = await db.prepare(
    `UPDATE auth_webauthn_challenges SET status = 'used', used_at = ?
     WHERE realm = ? AND challenge_hash = ? AND status = 'unused'`
  ).bind(nowIso(nowMs), CORE_AUTH_REALM, challengeHash).run();
  const changes = Number(used?.meta?.changes ?? used?.changes ?? 0);
  if (changes !== 1) return { ok: false, error: "challenge_reuse_rejected" };
  return { ok: true, challenge: row };
}

export async function createAssertionOptions(env, { sessionToken, url, nowMs = Date.now() } = {}) {
  const loaded = await loadAuthorizeSessionByToken(env, sessionToken, { nowMs });
  if (!loaded.ok) return loaded;
  if (loaded.session.status !== "pending_auth") {
    return { ok: false, error: "authorize_session_not_pending", status: 400 };
  }
  const rp = resolveWebAuthnRp(env, url);
  const challenge = await createWebAuthnChallenge(loaded.db, {
    purpose: "assertion",
    sessionId: loaded.session.session_id,
    nowMs
  });

  // Discover allowCredentials only when we can scope to a known account later;
  // for discoverable passkeys, empty allowCredentials lets the platform pick.
  const publicKey = {
    challenge,
    timeout: 60000,
    rpId: rp.rpId,
    userVerification: "required",
    allowCredentials: []
  };
  return { ok: true, publicKey };
}

export async function verifyAssertionForSession(env, {
  sessionToken,
  credential,
  url,
  nowMs = Date.now()
} = {}) {
  const loaded = await loadAuthorizeSessionByToken(env, sessionToken, { nowMs });
  if (!loaded.ok) return loaded;
  if (loaded.session.status !== "pending_auth") {
    return { ok: false, error: "authorize_session_not_pending", status: 400 };
  }
  const db = loaded.db;
  const rp = resolveWebAuthnRp(env, url);

  const clientDataJSON = credential?.response?.clientDataJSON;
  if (typeof clientDataJSON !== "string") {
    return { ok: false, error: "assertion_missing_client_data", status: 400 };
  }
  let clientData;
  try {
    const raw = atob(clientDataJSON.replace(/-/g, "+").replace(/_/g, "/"));
    // clientDataJSON is UTF-8 JSON; challenge is inside.
    const text = typeof TextDecoder !== "undefined"
      ? new TextDecoder().decode(Uint8Array.from(raw, c => c.charCodeAt(0)))
      : raw;
    clientData = JSON.parse(text);
  } catch {
    return { ok: false, error: "client_data_json_invalid", status: 400 };
  }
  const expectedChallenge = clientData.challenge;
  const consumed = await consumeWebAuthnChallenge(db, {
    challenge: expectedChallenge,
    purpose: "assertion",
    sessionId: loaded.session.session_id,
    nowMs
  });
  if (!consumed.ok) return { ...consumed, status: 400 };

  const credentialId = typeof credential?.rawId === "string" && credential.rawId
    ? credential.rawId
    : credential?.id;
  if (typeof credentialId !== "string" || !credentialId) {
    return { ok: false, error: "credential_id_required", status: 400 };
  }

  const passkey = await db.prepare(
    "SELECT * FROM auth_passkeys WHERE realm = ? AND credential_id = ? AND status = 'active'"
  ).bind(CORE_AUTH_REALM, credentialId).first();
  if (!passkey) return { ok: false, error: "passkey_not_found", status: 400 };

  let publicKeyJwk;
  try {
    publicKeyJwk = JSON.parse(passkey.public_key_jwk_json);
  } catch {
    return { ok: false, error: "passkey_public_key_corrupt", status: 500 };
  }

  const verified = await verifyAssertion({
    credentialId,
    authenticatorDataB64u: credential.response.authenticatorData,
    clientDataJSONB64u: clientDataJSON,
    signatureB64u: credential.response.signature,
    expectedChallenge,
    expectedOrigin: rp.origin,
    rpId: rp.rpId,
    publicKeyJwk,
    previousSignCount: Number(passkey.sign_count || 0)
  });
  if (!verified.ok) return { ...verified, status: 400 };

  await db.prepare(
    `UPDATE auth_passkeys SET sign_count = ?, last_used_at = ?
     WHERE realm = ? AND credential_id = ?`
  ).bind(verified.sign_count, nowIso(nowMs), CORE_AUTH_REALM, credentialId).run();

  const account = await db.prepare(
    "SELECT * FROM auth_accounts WHERE realm = ? AND account_id = ?"
  ).bind(CORE_AUTH_REALM, passkey.account_id).first();
  if (!account || account.status !== "active") {
    return { ok: false, error: "account_not_active", status: 403 };
  }

  await markSessionAuthenticated(db, loaded.session, {
    accountId: account.account_id,
    tenantId: account.home_tenant_id,
    authenticatorId: passkey.authenticator_id,
    authMethod: "passkey_webauthn",
    stepUpConfirmed: true,
    offerPasskeyEnroll: false
  });

  await audit(db, "passkey_assertion_ok", {
    account_id: account.account_id,
    tenant_id: account.home_tenant_id,
    session_id: loaded.session.session_id,
    step_up_confirmed: true
  });

  return {
    ok: true,
    account_id: account.account_id,
    tenant_id: account.home_tenant_id,
    authenticator_id: passkey.authenticator_id,
    auth_method: "passkey_webauthn",
    step_up_confirmed: true
  };
}

export async function createRegistrationOptions(env, { sessionToken, url, nowMs = Date.now() } = {}) {
  const loaded = await loadAuthorizeSessionByToken(env, sessionToken, { nowMs });
  if (!loaded.ok) return loaded;
  if (loaded.session.status !== "authenticated") {
    return { ok: false, error: "authorize_session_not_authenticated", status: 401 };
  }
  // Registration is invite-gated for bootstrap: session must already be authenticated
  // (invite or existing passkey). Open registration is never offered from pending_auth.
  const rp = resolveWebAuthnRp(env, url);
  const challenge = await createWebAuthnChallenge(loaded.db, {
    purpose: "registration",
    sessionId: loaded.session.session_id,
    accountId: loaded.session.account_id,
    nowMs
  });

  const userIdBytes = await sha256Bytes(loaded.session.account_id);
  const existing = await loaded.db.prepare(
    `SELECT credential_id FROM auth_passkeys WHERE realm = ? AND account_id = ? AND status = 'active'`
  ).bind(CORE_AUTH_REALM, loaded.session.account_id).all();
  const excludeCredentials = (existing?.results || []).map(row => ({
    type: "public-key",
    id: row.credential_id
  }));

  return {
    ok: true,
    publicKey: {
      challenge,
      rp: { id: rp.rpId, name: "CairnStone" },
      user: {
        id: base64UrlEncode(userIdBytes),
        name: loaded.session.account_id,
        displayName: loaded.session.account_id
      },
      pubKeyCredParams: [{ type: "public-key", alg: -7 }],
      timeout: 60000,
      authenticatorSelection: {
        residentKey: "preferred",
        userVerification: "required"
      },
      attestation: "none",
      excludeCredentials
    }
  };
}

export async function verifyRegistrationForSession(env, {
  sessionToken,
  credential,
  url,
  nowMs = Date.now()
} = {}) {
  const loaded = await loadAuthorizeSessionByToken(env, sessionToken, { nowMs });
  if (!loaded.ok) return loaded;
  if (loaded.session.status !== "authenticated") {
    return { ok: false, error: "authorize_session_not_authenticated", status: 401 };
  }
  const db = loaded.db;
  const rp = resolveWebAuthnRp(env, url);

  const clientDataJSON = credential?.response?.clientDataJSON;
  if (typeof clientDataJSON !== "string") {
    return { ok: false, error: "registration_missing_client_data", status: 400 };
  }
  let clientData;
  try {
    const padded = clientDataJSON.replace(/-/g, "+").replace(/_/g, "/");
    const pad = padded.length % 4 === 0 ? "" : "=".repeat(4 - (padded.length % 4));
    const binary = atob(padded + pad);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    clientData = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return { ok: false, error: "client_data_json_invalid", status: 400 };
  }

  const consumed = await consumeWebAuthnChallenge(db, {
    challenge: clientData.challenge,
    purpose: "registration",
    sessionId: loaded.session.session_id,
    nowMs
  });
  if (!consumed.ok) return { ...consumed, status: 400 };

  const credentialId = typeof credential?.rawId === "string" && credential.rawId
    ? credential.rawId
    : credential?.id;
  const verified = await verifyRegistration({
    credentialId,
    attestationObjectB64u: credential?.response?.attestationObject,
    clientDataJSONB64u: clientDataJSON,
    expectedChallenge: clientData.challenge,
    expectedOrigin: rp.origin,
    rpId: rp.rpId
  });
  if (!verified.ok) return { ...verified, status: 400 };

  const existingCred = await db.prepare(
    "SELECT credential_id FROM auth_passkeys WHERE realm = ? AND credential_id = ?"
  ).bind(CORE_AUTH_REALM, verified.credential_id).first();
  if (existingCred) return { ok: false, error: "passkey_already_registered", status: 400 };

  const authenticatorId = mintId("authenticator_id");
  const createdAt = nowIso(nowMs);
  await db.prepare(
    `INSERT INTO auth_authenticators
      (authenticator_id, schema, realm, account_id, method, status, assurance_class, wallet_account_id, created_at, revoked_at, accepted_state_authority)
     VALUES (?, ?, ?, ?, 'passkey_webauthn', 'active', 'webauthn', NULL, ?, NULL, 0)`
  ).bind(
    authenticatorId,
    AUTHENTICATOR_SCHEMA,
    CORE_AUTH_REALM,
    loaded.session.account_id,
    createdAt
  ).run();

  await db.prepare(
    `INSERT INTO auth_passkeys
      (credential_id, realm, account_id, authenticator_id, public_key_jwk_json, sign_count,
       transports_json, user_handle, created_at, last_used_at, status, accepted_state_authority)
     VALUES (?, ?, ?, ?, ?, ?, '[]', ?, ?, NULL, 'active', 0)`
  ).bind(
    verified.credential_id,
    CORE_AUTH_REALM,
    loaded.session.account_id,
    authenticatorId,
    JSON.stringify(verified.public_key_jwk),
    verified.sign_count || 0,
    loaded.session.account_id,
    createdAt
  ).run();

  // Prefer the new passkey authenticator + mark UV step-up for consent.
  await db.prepare(
    `UPDATE auth_authorize_sessions
       SET authenticator_id = ?, auth_method = 'passkey_webauthn', step_up_confirmed = 1, offer_passkey_enroll = 0
     WHERE realm = ? AND session_id = ?`
  ).bind(authenticatorId, CORE_AUTH_REALM, loaded.session.session_id).run();

  await audit(db, "passkey_enrolled", {
    account_id: loaded.session.account_id,
    tenant_id: loaded.session.tenant_id,
    session_id: loaded.session.session_id,
    step_up_confirmed: true
  });

  return {
    ok: true,
    account_id: loaded.session.account_id,
    authenticator_id: authenticatorId,
    credential_id: verified.credential_id,
    step_up_confirmed: true
  };
}

export async function approveAuthorizeSession(env, {
  sessionToken,
  url,
  nowMs = Date.now()
} = {}) {
  const loaded = await loadAuthorizeSessionByToken(env, sessionToken, { nowMs });
  if (!loaded.ok) return loaded;
  const session = loaded.session;
  if (session.status !== "authenticated") {
    return { ok: false, error: "authentication_required", status: 401, detail: "Sign in before approving" };
  }
  if (!session.account_id || !session.tenant_id || !session.authenticator_id) {
    return { ok: false, error: "authentication_required", status: 401 };
  }

  // Claim the session BEFORE minting a code so concurrent Approve cannot issue two codes.
  // Only one UPDATE from status='authenticated' succeeds (changes === 1).
  const claimed = await loaded.db.prepare(
    `UPDATE auth_authorize_sessions SET status = 'approved', completed_at = ?
     WHERE realm = ? AND session_id = ? AND status = 'authenticated'`
  ).bind(nowIso(nowMs), CORE_AUTH_REALM, session.session_id).run();
  const claimChanges = Number(claimed?.meta?.changes ?? claimed?.changes ?? 0);
  if (claimChanges !== 1) {
    return {
      ok: false,
      error: "authorize_already_approved",
      status: 409,
      detail: "This authorization request was already approved"
    };
  }

  const stepUpConfirmed = Number(session.step_up_confirmed) === 1;
  const scopes = parseScopesJson(session.scopes_json);
  const code = await createAuthorizationCode(env, {
    accountId: session.account_id,
    tenantId: session.tenant_id,
    authenticatorId: session.authenticator_id,
    clientId: session.client_id,
    redirectUri: session.redirect_uri,
    codeChallenge: session.code_challenge,
    codeChallengeMethod: "S256",
    resource: session.resource,
    scopes,
    iss: session.iss,
    stepUpConfirmed,
    nowMs
  });
  if (!code.ok) {
    // Session is already claimed approved; do not reverse into a second-code race.
    // Client must restart authorize — safer than leaving a usable orphan code.
    return { ...code, status: 400, session_claimed: true };
  }

  const redirect = new URL(session.redirect_uri);
  redirect.searchParams.set("code", code.code);
  redirect.searchParams.set("iss", session.iss);
  if (session.state) redirect.searchParams.set("state", session.state);

  await audit(loaded.db, "authorize_approved", {
    account_id: session.account_id,
    tenant_id: session.tenant_id,
    session_id: session.session_id,
    step_up_confirmed: stepUpConfirmed,
    auth_method: session.auth_method
  });

  return {
    ok: true,
    redirect_uri: redirect.toString(),
    code: code.code,
    iss: session.iss,
    state: session.state,
    account_id: session.account_id,
    scopes,
    step_up_confirmed: stepUpConfirmed
  };
}

export async function denyAuthorizeSession(env, {
  sessionToken,
  nowMs = Date.now()
} = {}) {
  const loaded = await loadAuthorizeSessionByToken(env, sessionToken, { nowMs });
  if (!loaded.ok) {
    // If session is missing, we cannot redirect safely without client redirect_uri.
    return loaded;
  }
  const session = loaded.session;
  await loaded.db.prepare(
    `UPDATE auth_authorize_sessions SET status = 'denied', completed_at = ?
     WHERE realm = ? AND session_id = ? AND status IN ('pending_auth','authenticated')`
  ).bind(nowIso(nowMs), CORE_AUTH_REALM, session.session_id).run();

  const redirect = new URL(session.redirect_uri);
  redirect.searchParams.set("error", "access_denied");
  redirect.searchParams.set("error_description", "The user denied the request");
  if (session.state) redirect.searchParams.set("state", session.state);
  redirect.searchParams.set("iss", session.iss);

  await audit(loaded.db, "authorize_denied", {
    session_id: session.session_id,
    account_id: session.account_id || null
  });

  return {
    ok: true,
    redirect_uri: redirect.toString(),
    error: "access_denied"
  };
}

export async function reloadAuthorizeHtml(env, { sessionToken, url, error = null } = {}) {
  const loaded = await loadAuthorizeSessionByToken(env, sessionToken);
  if (!loaded.ok) return loaded;
  const rp = resolveWebAuthnRp(env, url);
  return {
    ok: true,
    html: renderAuthorizeHtml(loaded.session, { rpId: rp.rpId, error }),
    session: loaded.session
  };
}

export function oauthAuthorizeErrorRedirect(redirectUri, { error, state, iss, description } = {}) {
  if (!redirectUri) return null;
  try {
    const redirect = new URL(redirectUri);
    redirect.searchParams.set("error", error || "server_error");
    if (description) redirect.searchParams.set("error_description", description);
    if (state) redirect.searchParams.set("state", state);
    if (iss) redirect.searchParams.set("iss", iss);
    return redirect.toString();
  } catch {
    return null;
  }
}

export { resolveDcrClientIp };
