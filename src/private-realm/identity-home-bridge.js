// S1-1 — dormant, server-side, authenticated Identity-to-Home bridge.
// No production entrypoint imports this file, and no private storage binding is created here.
// AuthContext is accepted ONLY as the result of an injected *trusted* token verifier.
import { validateAccessToken } from "../core-auth.js";
import { PrivateRealmError, assertHomeScope, ID_PATTERNS } from "./scope.js";

const PLANES = Object.freeze(["chat", "work"]);
const FULL = Object.freeze({ read: true, send: true, ack: true });
const hex = bytes => [...bytes].map(b => b.toString(16).padStart(2, "0")).join("");
const denied = () => new PrivateRealmError("scope_not_authorized");

function assertContext(context, resource) {
  if (!context || typeof context !== "object" || Array.isArray(context) ||
      context.schema !== "cairnstone-core-auth-context-v1" || context.realm !== "core-auth" ||
      context.resource !== resource || context.account_status !== "active" ||
      context.connection_status !== "active" || context.token_family_status !== "active" ||
      !Array.isArray(context.scopes) || !context.scopes.includes("mcp:core") ||
      typeof context.token_family_id !== "string" || !/^tfam_[A-Za-z0-9_-]+$/.test(context.token_family_id)) throw denied();
  // The real Core-auth client_family is a transport/client label, not identity or authority.
  // An unrecognised family becomes "unspecified" without affecting Home derivation.
  const family = context.client_family;
  const provider_label = typeof family === "string" && /^[a-z0-9_.-]{1,40}$/.test(family)
    ? family : "unspecified";
  try {
    return assertHomeScope({
      account_id: context.account_id, tenant_id: context.tenant_id,
      principal_id: context.principal_id, connection_id: context.connection_id,
      provider_label, home_role: "member"
    });
  } catch {
    throw denied();
  }
}

function assertResource(resource) {
  if (typeof resource !== "string" || !/^https:\/\/[^/?#]+\/mcp\/core-auth$/.test(resource)) {
    throw new PrivateRealmError("core_auth_resource_required");
  }
  return resource;
}

async function keyFor(raw) {
  if (typeof raw !== "string" || raw.length < 32) throw new PrivateRealmError("inbox_derivation_key_required");
  return crypto.subtle.importKey("raw", new TextEncoder().encode(raw), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
}

function rejectForeignKeys(request) {
  // This is a server-only module; these are never accepted as authority from external callers.
  if (request !== undefined) throw new PrivateRealmError("caller_selectors_forbidden");
}

export function createIdentityHomeBridge({
  validateToken, store, expectedResource, admitOnboarding = async () => false,
  admitAdminRecovery = async () => false, inboxDerivationKey
} = {}) {
  assertResource(expectedResource);
  if (typeof validateToken !== "function" || typeof admitOnboarding !== "function" ||
      typeof admitAdminRecovery !== "function") {
    throw new PrivateRealmError("trusted_gateway_dependencies_required");
  }
  for (const method of ["ensureDefaultHome", "listInboxes", "createInbox", "grantInbox", "can"]) {
    if (typeof store?.[method] !== "function") throw new PrivateRealmError("private_home_store_required");
  }
  if (typeof inboxDerivationKey !== "string" || inboxDerivationKey.length < 32) throw new PrivateRealmError("inbox_derivation_key_required");
  const keyPromise = keyFor(inboxDerivationKey);
  const deriveId = async (kind, homeId, connectionId, plane) => {
    if (!ID_PATTERNS.home.test(homeId) || (connectionId && !ID_PATTERNS.conn.test(connectionId)) ||
        !PLANES.includes(plane) || !["home", "connection"].includes(kind)) throw denied();
    const key = await keyPromise;
    const input = JSON.stringify(["cairnstone-s1-1-inbox-v1", kind, homeId, connectionId || null, plane]);
    const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(input));
    return "ibx_" + hex(new Uint8Array(sig)).slice(0, 32);
  };

  async function verifiedScope(accessToken) {
    if (typeof accessToken !== "string" || !accessToken.startsWith("csat_")) throw denied();
    // The validator must be wired to validateAccessToken(env, token, {expectedResource});
    // never use token parsing, unverified headers, request actor fields, or a client identity hint.
    const result = await validateToken(accessToken, expectedResource);
    if (result?.ok !== true || !result.context) throw denied();
    return Object.freeze({ scope: assertContext(result.context, expectedResource), context: result.context });
  }

  async function addresses(scope, homeId) {
    const result = {};
    for (const plane of PLANES) {
      const homeInbox = await deriveId("home", homeId, null, plane);
      const privateInbox = await deriveId("connection", homeId, scope.connection_id, plane);
      result[plane] = Object.freeze({
        home: Object.freeze({ inbox_id: homeInbox, address: "inbox:" + homeInbox, scope: "home" }),
        connection: Object.freeze({ inbox_id: privateInbox, address: "inbox:" + privateInbox, scope: "connection" })
      });
    }
    return Object.freeze(result);
  }

  async function visible(scope, homeId, map) {
    // Do not infer capabilities from Home ownership or from the caller's admin role.
    const listings = await store.listInboxes(scope, { homeId });
    const granted = new Set(listings.filter(i => i.granted).map(i => i.inbox_id));
    const result = {};
    for (const plane of PLANES) {
      result[plane] = {};
      for (const kind of ["home", "connection"]) {
        const inbox = map[plane][kind];
        const accessible = granted.has(inbox.inbox_id);
        const capabilities = {};
        for (const cap of ["read", "send", "ack"]) {
          capabilities[cap] = accessible && await store.can(scope, inbox.inbox_id, cap, { homeId });
        }
        result[plane][kind] = Object.freeze({ ...inbox, capabilities: Object.freeze(capabilities) });
      }
      Object.freeze(result[plane]);
    }
    return Object.freeze(result);
  }

  // Explicit, server-admitted bootstrap/attach. No network/public endpoint or automatic first-use.
  // The callback is an owner's server-side policy: never derive admission from token scope alone.
  async function onboard(accessToken, request) {
    rejectForeignKeys(request);
    const { scope, context } = await verifiedScope(accessToken);
    if (await admitOnboarding(context) !== true) throw new PrivateRealmError("onboarding_not_admitted");
    // Admin recovery needs separate, server-held owner consent. A new connection never
    // becomes an admin by presenting an actor string, a token scope, or a request role.
    const recoverAdmin = await admitAdminRecovery(context) === true;
    // Re-verify immediately before the first store write; the S0b store also rechecks its own
    // connection/tenant/admin/grant state at write boundaries. Cross-DB atomicity is not claimed.
    const fresh = await verifiedScope(accessToken);
    if (fresh.scope.account_id !== scope.account_id || fresh.scope.tenant_id !== scope.tenant_id ||
        fresh.scope.principal_id !== scope.principal_id || fresh.scope.connection_id !== scope.connection_id) throw denied();
    const attachScope = recoverAdmin
      ? assertHomeScope({ ...fresh.scope, home_role: "admin" }) : fresh.scope;
    const home = await store.ensureDefaultHome(attachScope);
    const map = await addresses(attachScope, home.home_id);
    // If the first operation failed halfway through, a retry may create missing inbox rows.
    // Crucially, an existing inbox NEVER gets grants silently reissued after revocation.
    for (const plane of PLANES) {
      if (home.role === "admin") {
        const target = map[plane].home.inbox_id;
        const created = await store.createInbox(attachScope, { scope: "home", plane, inboxId: target, label: plane }, { homeId: home.home_id });
        if (created.created) {
          await store.grantInbox(attachScope, { inboxId: target, targetConnectionId: attachScope.connection_id, caps: FULL }, { homeId: home.home_id });
        }
      }
      await store.createInbox(attachScope, {
        scope: "connection", plane, inboxId: map[plane].connection.inbox_id, label: plane
      }, { homeId: home.home_id });
    }
    return Object.freeze({
      home_id: home.home_id, created: home.created, connection_attached: home.connection_attached,
      role: home.role, inboxes: await visible(attachScope, home.home_id, map)
    });
  }

  // Ordinary reads cannot create or reattach a connection and revalidate each access token.
  async function inspect(accessToken, request) {
    rejectForeignKeys(request);
    const { scope } = await verifiedScope(accessToken);
    const listings = await store.listInboxes(scope);
    // A missing Home/connection fails in the store; no auto-provisioning or legacy fallback.
    const ids = listings.map(i => i.inbox_id);
    const map = {};
    for (const row of listings) map[row.inbox_id] = row;
    // Derive candidate stable addresses from the Home ID only once it is resolved by the
    // store itself. We expose no selectors to avoid treating a caller's guessed Home as identity.
    const homeId = typeof store.resolveHomeId === "function" ? await store.resolveHomeId(scope) : null;
    return Object.freeze({ inbox_ids: Object.freeze(ids), inboxes: Object.freeze(map), home_id: homeId });
  }

  return Object.freeze({ onboard, inspect });
}

// Production wiring seam (DORMANT). The caller supplies the private-store client and
// explicit admission policy; the only source of verified identity is Core-auth D1.
export function createCoreAuthIdentityHomeBridge({ env, store, resource, admitOnboarding, admitAdminRecovery, inboxDerivationKey }) {
  assertResource(resource);
  return createIdentityHomeBridge({
    store, expectedResource: resource, admitOnboarding, admitAdminRecovery, inboxDerivationKey,
    validateToken: (token, expectedResource) => validateAccessToken(env, token, { expectedResource })
  });
}
