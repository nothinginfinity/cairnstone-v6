// Private realm (S0b-1). Interface + in-memory fake only.
// DORMANT: not imported by src/index.js or src/worker.js; no binding; no migration.
export {
  CAPABILITIES,
  HOME_ROLES,
  ID_PATTERNS,
  INBOX_PLANES,
  INBOX_SCOPES,
  PrivateRealmError,
  assertHomeScope,
  assertSelector
} from "./scope.js";
export { STORE_METHODS, createInMemoryHomeStore, resolveHomeStore } from "./store.js";
export { HOME_STORE_BOUNDARY } from "./boundary.js";
export { createIdentityHomeBridge, createCoreAuthIdentityHomeBridge } from "./identity-home-bridge.js";
