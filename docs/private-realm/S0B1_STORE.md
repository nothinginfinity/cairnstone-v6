# S0b-1 — Private Home store interface + fake adapter

Status: **implementation candidate, dormant.** Draft PR stacked on PR #71 (`claude/s0b-s1-design`).
Task source: ChatGPT `msg:pr71-build-next-20261010-chatgpt`, handed off via Grok `msg:s0b1-claude-handoff-20261010-grok`.

**Not done, not authorized:** merge, deploy, applying a migration, creating a production binding, enabling guard enforcement, moving an accepted HEAD, provisioning private users. Task coordination only; this is not deployment approval.

## What this adds

| File | Purpose |
|---|---|
| `src/private-realm/scope.js` | `assertHomeScope` / `assertSelector`, id patterns, closed capability list, `PrivateRealmError` |
| `src/private-realm/store.js` | `STORE_METHODS` interface, `createInMemoryHomeStore` fake, closed `resolveHomeStore` seam |
| `src/private-realm/boundary.js` | Frozen two-service-role storage plan; its method list is tested against the interface |
| `src/private-realm/index.js` | Barrel export. Not imported by `src/index.js` or `src/worker.js` |
| `test/private-realm-store.test.js` | 44 tests: isolation, escalation, revoke, portability, privacy, send() atomicity, dormancy |

## Model

- **Authority is a server-verified `HomeScope`** (`account_id`, `tenant_id`, `principal_id`, `connection_id`, optional `home_role`, `provider_label`). The Home is resolved from the connection recorded in the store, never from a request field. A scope carrying `home_id` or `inbox_id` is rejected. Home and inbox ids passed by callers are *selectors* that must equal the resolved value, or the call is denied and audited.
- **The Home belongs to the account, not the provider.** `ensureDefaultHome` is idempotent per connection and per account. A new provider connection joins the existing Home with its own principal, starts as a `member` with zero grants, and never inherits another connection's private inboxes. `provider_label` is a label only.
- **Inbox scopes:** `home` and `agent_identity` are admin-created and shared only by explicit grant; creating one grants nobody anything. `connection` inboxes belong to the creating connection alone.
- **Connection-private inboxes are unreachable by siblings** for read, send, ack, discovery, grant and revoke, including by an admin sibling. Sharing something across providers means putting it in a `home`-scope inbox. An explicit owner-consented share of a private inbox is deliberately *not* built here; it needs its own design.
- **Revocation is effective, not cosmetic.** A revoked connection fails auth on every method, its grants are stamped revoked, rows are retained as history, and the same connection id cannot be re-attached. Revoking one connection leaves the Home, other connections and home-owned data untouched. An admin may revoke any connection; a member may revoke only itself.
- **Roles:** the first connection is `admin`. A later connection is a `member` even if its scope requests admin, unless no active admin remains (owner-approved recovery). The last admin cannot be demoted. Admin gates grants, role changes, home-inbox creation and revoking others.
- **Capabilities** are the closed list `read | send | ack`; any other name denies (no property-name tricks such as `granted_at` or `constructor`).
- **Messages** are immutable and idempotent per `message_id`; a conflicting replay or another sender reusing the id is denied. Delivery state only moves forward. `listInbox` returns metadata with no body; `readInbox` returns bodies and needs `read`. `send()` is atomic: only the pure digests are asynchronous; authorization, capability checks, the idempotency lookup and every write happen in one synchronous commit section (marked `COMMIT-SECTION-BEGIN/END`, statically tested to contain no `await`), so a revocation or grant change during a send is honoured and two same-id sends can never both commit.
- **Errors do not leak existence.** All authentication-shaped failures throw `scope_not_authorized`; all capability failures throw `capability_denied`. Precise reasons live only in the audit log (ids and reason codes, never bodies). The gateway must collapse both to one external 403.

## Review points addressed (ChatGPT PR #71 review)

| # | Review point | Where |
|---|---|---|
| 1 | Same-Worker bindings are not route-inaccessible | `boundary.js`: public gateway holds no private binding; internal private-storage Worker via service binding |
| 2 | Connection-scoped grants let siblings in | Sibling denial incl. admin; grant and revoke on private inboxes refused |
| 3 | Revoked connection/grant must fail despite retained rows | `authorize()` checks status on every call; grants stamped revoked |
| 4 | Namespace census pending | Unchanged: still the operator-run SQL in the design doc §3. This slice does not claim it clean |
| 5 | L3 legacy Stone/search raw-body exposure | Unchanged and out of scope. The store never writes bodies to shared tables; a static test enforces it |
| 6 | Resolver should use verified scope, not caller `homeId` | Scope-only authority; `home_id` is a validated selector |
| — | At-most-one default Home | One account→Home index; concurrency test (25 parallel calls → 1 Home). The SQL partial unique index in the draft schema remains the real enforcement |
| — | Temporal invariants, audit reason codes | `delivered_at <= read_at <= acked_at` tested; fixed reason-code vocabulary |

## Portability acceptance (owner invariant)

Tested: switching ChatGPT to Grok keeps one Home; Grok gets a separate principal and no inherited access; revoking ChatGPT does not remove the Home or Grok's access; ChatGPT's connection-private data stays private after revocation; a second ChatGPT connection is a new principal that does not inherit the first one's private inbox; revoked connections cannot be resurrected. Not covered here: versioned context snapshots and export format (later slice).

## Dormancy guarantees (enforced by tests)

- `src/private-realm/*` imports only its own siblings, touches no `env.*` binding, does no I/O, no `Math.random`.
- No reference to legacy `correspondence_*` or `auth_*` tables, and no SQL against shared stone tables.
- `src/index.js` and `src/worker.js` do not import the module; `wrangler.toml` declares no private binding; `migrations/` contains no private-realm migration.
- `resolveHomeStore(env)` throws `private_home_store_not_bound` even when `env` has real-looking bindings; only a test store can be injected.
- Minted `home_` / `ibx_` ids and the `acct_` / `ten_` / `prin_` / `conn_` ids are all recognized by the S0a realm guard as private-realm names, and legacy actors (`chatgpt:chat`, `claude:cairnstone-v6`, …) cannot satisfy any scope pattern. The guard mode is untouched (default off).

## Known limits and follow-ups

- Fake only. D1 concurrency, the composite foreign keys and the immutability triggers are exercised in the schema draft tests, not against a real private D1.
- `__inspect` test hook exists only when the fake is built with `{ testHooks: true }`.
- Mutation check: seven of eight security rules were individually broken and each broke a test. The surviving case is the redundant sibling check inside `checkCapability`, which is defense in depth because the API can never create a sibling grant on a private inbox.
- Audit log is unbounded in the fake; the real store needs retention and a size policy.
- S0b-2 (migration file, binding commented/absent), S1-1 (account→Home bridge in core-auth), S1-2 (authenticated tools) and L1–L3 legacy phases remain separate approvals.
