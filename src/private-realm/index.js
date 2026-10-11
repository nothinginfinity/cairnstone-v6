// Private realm store (S0b-1).
// Interface only. No production binding. Fake adapter for tests.
// Home resolution is always from an authenticated HomeScope, never a raw homeId.

export { createInMemoryHomeStore, resolveHomeStore, assertHomeScope } from "./store.js";
export { HOME_STORE_BOUNDARY } from "./boundary.js";
