// S1-3 staging-only gateway transport and server-side composition. DORMANT.
// NEVER import from a production/legacy entrypoint; never expose over an HTTP route.
// Cloudflare service binding must configure props = { caller = "cairnstone-stage-gateway" }.
// Auth is verified ONLY through a separately-reviewed, staging-audience verifier.
import { PrivateRealmError } from "./scope.js";
import { STORE_METHODS } from "./store.js";
import { signEnvelope } from "./private-worker-core.js";
import { createIdentityHomeBridge } from "./identity-home-bridge.js";
import { createPrivateInboxTools } from "./private-inbox-tools.js";

export const STAGING_GATEWAY_CALLER = "cairnstone-stage-gateway";
const err = code => new PrivateRealmError(code);
const safeCodes = new Set(["caller_not_authorized", "scope_not_authorized", "invalid_arguments", "private_store_error", "private_worker_unconfigured"]);

// The only transport capable of signing internal staging requests.
// Caller, method and JSON args are bound by HMAC; nonce is fresh for every invocation.
// It never accepts an arbitrary RPC method, caller name, home selector or secret as a tool argument.
export function createStagingPrivateStoreClient({ env } = {}) {
  if (env?.PRIVATE_STAGE_GATEWAY_ENABLED !== "true") throw err("private_tools_disabled");
  const binding = env.CAIRNSTONE_PRIVATE_STAGE;
  const key = env.PRIVATE_GATEWAY_HMAC_KEY;
  if (!binding || typeof binding.call !== "function" ||
      typeof key !== "string" || key.length < 32) throw err("private_worker_unconfigured");

  const methods = Object.create(null);
  for (const name of STORE_METHODS) {
    methods[name] = async (...args) => {
      if (args.length === 0 || args.length > 3) throw err("invalid_arguments");
      // signEnvelope asserts plain JSON and creates a cryptographic random nonce.
      const envelope = await signEnvelope({ key, caller: STAGING_GATEWAY_CALLER, method: name, args });
      try {
        return await binding.call(envelope);
      } catch (error) {
        // Never pass SQL, Worker internals, or raw exception text to the gateway caller.
        throw err(error instanceof PrivateRealmError && safeCodes.has(error.code)
          ? error.code : "private_store_error");
      }
    };
  }
  return Object.freeze(methods);
}

// Source-only server composition: never trust a client-submitted authContext.
// validateStagingToken MUST verify an isolated staging OAuth audience, issuer,
// expiry and account/connection status (with a reviewer-approved implementation).
// Admission defaults to DENY. There is deliberately no fetch(), deploy config,
// public route, or production entrypoint import in this slice.
export function createStagingGatewayCore({
  env, validateStagingToken, expectedResource, inboxDerivationKey,
  admitOnboarding = async () => false,
  admitAdminRecovery = async () => false
} = {}) {
  if (typeof validateStagingToken !== "function" ||
      typeof expectedResource !== "string" || expectedResource !== env?.STAGING_OAUTH_RESOURCE) {
    throw err("trusted_gateway_dependencies_required");
  }
  const store = createStagingPrivateStoreClient({ env });
  const bridge = createIdentityHomeBridge({
    store, expectedResource, validateToken: validateStagingToken,
    inboxDerivationKey, admitOnboarding, admitAdminRecovery
  });
  const tools = createPrivateInboxTools({ bridge, store, enabled: true });
  return Object.freeze({
    call: tools.call, inspect: bridge.inspect, onboard: bridge.onboard,
    definitions: tools.definitions
  });
}
