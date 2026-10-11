// S0b-1 — HomeScope: the only authority input to the private-realm store.
//
// A HomeScope is built SERVER-SIDE from a verified authContext (account, tenant,
// principal, connection). It never carries a caller-supplied Home or inbox id: those
// are *selectors* that must match what the scope resolves to, never authority.
//
// Dormant: pure validation, no bindings, no I/O.

export const ID_PATTERNS = Object.freeze({
  acct: /^acct_[A-Za-z0-9_-]{4,60}$/,
  ten: /^ten_[A-Za-z0-9_-]{4,60}$/,
  prin: /^prin_[A-Za-z0-9_-]{4,60}$/,
  conn: /^conn_[A-Za-z0-9_-]{4,60}$/,
  home: /^home_[A-Za-z0-9_-]{8,70}$/,
  ibx: /^ibx_[A-Za-z0-9_-]{4,70}$/,
  message: /^[A-Za-z0-9:._-]{8,120}$/,
  thread: /^[A-Za-z0-9:._-]{1,120}$/
});

export const HOME_ROLES = Object.freeze(["admin", "member"]);
export const INBOX_SCOPES = Object.freeze(["home", "connection", "agent_identity"]);
export const INBOX_PLANES = Object.freeze(["chat", "work", "notifications", "control"]);
// Whitelist. Capability names are never used as property lookups on caller input.
export const CAPABILITIES = Object.freeze(["read", "send", "ack"]);

export class PrivateRealmError extends Error {
  constructor(code, detail) {
    super(code);
    this.name = "PrivateRealmError";
    this.code = code;
    if (detail !== undefined) this.detail = detail;
  }
}

/**
 * Validate and freeze a HomeScope. Throws PrivateRealmError(`invalid_<field>`) on any
 * malformed field. Legacy actor strings (chatgpt:chat, claude:cairnstone-v6, ...) can never
 * satisfy these patterns, so they cannot become ownership.
 *
 * `home_role` is server-derived from the owner-approved consent that minted the connection
 * (not from a request). It is a *request*: the store only honours `admin` for the first
 * connection of a Home or when no active admin remains.
 */
export function assertHomeScope(scope) {
  if (!scope || typeof scope !== "object" || Array.isArray(scope)) throw new PrivateRealmError("home_scope_required");
  const fields = [
    ["account_id", ID_PATTERNS.acct],
    ["tenant_id", ID_PATTERNS.ten],
    ["principal_id", ID_PATTERNS.prin],
    ["connection_id", ID_PATTERNS.conn]
  ];
  for (const [key, pattern] of fields) {
    if (typeof scope[key] !== "string" || !pattern.test(scope[key])) throw new PrivateRealmError(`invalid_${key}`);
  }
  const role = scope.home_role === undefined ? "member" : scope.home_role;
  if (!HOME_ROLES.includes(role)) throw new PrivateRealmError("invalid_home_role");
  const label = scope.provider_label === undefined ? "unspecified" : scope.provider_label;
  if (typeof label !== "string" || !/^[a-z0-9_.-]{1,40}$/.test(label)) throw new PrivateRealmError("invalid_provider_label");
  // A home_id inside the scope would make a request field look like authority. Reject it.
  if ("home_id" in scope || "inbox_id" in scope) throw new PrivateRealmError("scope_must_not_carry_selectors");
  return Object.freeze({
    account_id: scope.account_id,
    tenant_id: scope.tenant_id,
    principal_id: scope.principal_id,
    connection_id: scope.connection_id,
    home_role: role,
    provider_label: label
  });
}

/** Selectors are optional hints that must equal the resolved value; they never grant anything. */
export function assertSelector(selector) {
  if (selector === undefined || selector === null) return Object.freeze({ homeId: null });
  if (typeof selector !== "object" || Array.isArray(selector)) throw new PrivateRealmError("invalid_selector");
  const homeId = selector.homeId === undefined ? null : selector.homeId;
  if (homeId !== null && (typeof homeId !== "string" || !ID_PATTERNS.home.test(homeId))) {
    throw new PrivateRealmError("invalid_selector");
  }
  return Object.freeze({ homeId });
}
