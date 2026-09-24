// Wrangler module entry. Keeps src/index.js as the default fetch Worker
// and publishes the MessagesAuthBridge named entrypoint for service bindings.
export { default } from "./index.js";
export { MessagesAuthBridge } from "./messages-auth-bridge.js";
