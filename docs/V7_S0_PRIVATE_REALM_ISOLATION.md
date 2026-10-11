# S0 — Private-realm isolation: threat model, findings, and slice plan

Status: **DESIGN + S0a CANDIDATE (draft PR, not merged, not deployed).**
Roadmap: Stone `3fcdb3598e58246f299102bb71e14b598268e60ef9d3a7d4496d19e740328d5c`
(`project-memory/roadmap/2026-10-10-personal-mcp-home-connection-specific-endpoints.md`), Gate S0.
Tracking issue: nothinginfinity/cairnstone-v6#69.
Verified against `main` at `a0141eb`.

This document grants no merge, deploy, migration, credential, or accepted-state authority.

## 1. Observed incident

An independent second ChatGPT account, with no authenticated CairnStone actor, listed both
`chatgpt:chat` and `chatgpt:cairnstone-v6` inboxes through the legacy full-catalog MCP.

## 2. Verified root causes (from source)

1. **Legacy AC1 trusts caller-supplied actor strings.** `cairnstone_get_inbox`, `list_threads`,
   `get_thread`, `read_message`, `get_notes`, `note_self`, `send_message`, `dispatch_handoff`,
   `forward_with_note` and `run_task_request` take `recipient_id` / `from` / `actor_id` / `to`
   from the request body. With no `authContext`, `callMcpTool` applies no caller check
   (`assertCallerIdentity` only runs when `authContext` exists). This matches inventory class
   `CHECKED_CALLER_ASSERTION` in `V7_7_10I_0_IDENTITY_SURFACE_INVENTORY.md`, which is only
   enforced on `/mcp/core-auth`.
2. **Message content is also an ordinary Stone.** `sendMessage` calls `createStone` with
   `path: correspondence/<id>.txt` and no private marker. It lands in the shared `stones`,
   `refs` and `refs_fts` tables and in R2.
3. **Several read routes have no authentication.** In `src/index.js` the following have no
   `requireOperatorAuthorization` or token check: `GET /v1/stones`, `GET /stones/:hash`,
   `GET /v1/stones/:hash`, `POST /v1/search`, `POST /v2/find`, `POST /v1/expand`,
   `POST /v1/query-expand`, `GET /chains/:chain/manifest`, `GET /v2/chains/:chain/manifest`,
   `GET /v2/chains/:chain/resume`. The equivalent MCP tools are on
   `/mcp` and `/mcp/core`. So message bodies are reachable by search and by hash, not only
   through the mailbox tools.
4. **Core-auth principals cannot currently be AC1 actors.** `actorId()` in `correspondence.js`
   requires `namespace:identifier`, but core-auth principal IDs are `prin_<opaque>` (no colon).
   `injectServerDerivedCaller` fills `recipient_id` / `from` / `actor_id` with that value, so an
   authenticated principal's default mailbox address fails validation. This is the
   "opaque-principal / AC1 address mismatch" in the issue #69 thread. S1 must define the
   address mapping before private mail can flow.
5. **AC1 tables carry no realm or tenant column.** `correspondence_deliveries` is keyed by
   `recipient_id` strings only, so realm separation today can only be by address namespace.
6. **Legacy must not read `auth_*` tables** (`legacyMustNotQueryAuth`), so a registry lookup
   from the legacy path is not an option. Any legacy-side protection has to be a pure function
   of the address.

## 3. What S0a (this PR) does

`src/realm-guard.js`, wired into `callMcpTool` (covers `/mcp`, `/mcp/core`, `/mcp-b`, and
broker/hydration calls, which re-enter `callMcpTool`) and into
`POST /v1/correspondence/forward-with-note`.

- Reserves address namespaces `prin:`, `conn:`, `home:`, `acct:`, `ten:` and the core-auth
  minted id prefixes (`prin_`, `conn_`, `acct_`, `ten_`, `authn_`, `tfam_`, `walacct_`) for the
  private realm.
- For callers with no `authContext`, rejects any AC1 mailbox call that names a reserved address
  as sender, mailbox owner, or recipient, with `private_realm_actor_forbidden` (403).
- Pure and synchronous, no database access, so the legacy no-auth-table invariant holds.
- Mode `AC1_REALM_GUARD`: `off` (default, no behaviour change), `shadow` (allow, log
  `ac1_realm_guard_would_deny` with tool and field names only), `enforce` (deny).
- Historical legacy actors (`chatgpt:chat`, `claude:cairnstone-v6`, `grok:*`, `perplexity*`, ...)
  are untouched, so existing trusted agents are not severed.
- Authenticated core-auth calls are unchanged; they remain bound by `assertCallerIdentity`.

### What S0a does NOT do (so this is not mistaken for closing S0)

- It does **not** stop content exposure through search, `get_stone`, hash read, list, manifest
  or REST (causes 2 and 3). Until S0b lands, **private-realm message bodies must not be
  written to the shared store.** S0a blocks naming private addresses on legacy; it does not
  make already-shared stones private.
- It does **not** contain the historically shared legacy inboxes (`chatgpt:chat` etc.). Anyone
  who can reach `/mcp` can still read those. That needs the owner's containment decision (§6).
- It does not cover other REST/MCP surfaces that take actor fields but are not mailbox tools
  (`access_grant_*`, `task_run_*`, `conversation_session_*`, `workspace_invite_claim`,
  `agent_bootstrap`). They need the same treatment in S0b.
- Routing aliases claimed in `auth_routing_aliases` that look like legacy strings
  (for example `chatgpt:chat`) are not protected by a namespace rule. S1 must issue private-realm
  aliases only inside the reserved namespaces.

## 4. S0b — content isolation (needs an owner decision)

| Option | How | Pros | Cons |
|---|---|---|---|
| A. Marked stones + read guard | Tag private-realm message stones; add a filter to every legacy reader (list, get, search, expand, query-expand, find, find-scope, manifests, chain manifests, REST twins, `ask`, `grounded_response`, `agent_bootstrap`) | No new binding | Dozens of SQL read sites across `src/` (index, ask, grounded-response, agent-bootstrap, repo-stones-runtime, attachment-refs); one missed site is a leak; no physical boundary |
| B. Separate private storage | Private-realm AC1 stones, refs, FTS, R2 prefix and deliveries live in a distinct D1 binding / table set that legacy code never queries; only the core-auth path gets the binding | Legacy SQL cannot reach it by construction; matches the roadmap's "strongly scoped D1/R2" | New binding and migration; needs its own canary |

Recommendation: **B.** A missed filter is the failure mode that already caused this incident.
This is a recommendation for the owner and the independent architecture review, not a decision.

## 5. S1 pointers found while reading

- Define the AC1 address for a principal. Proposal: `prin:<opaque_principal_suffix>`, which is
  inside the namespace S0a already reserves and satisfies the `actorId()` regex.
- Plane mapping: `classifyMailboxPlane` keys on `:chat` / `:cairnstone-v6` suffixes. Private
  inboxes (chat, work, notifications, control) need explicit plane metadata rather than
  suffix matching.
- `injectServerDerivedCaller` should keep deriving the default mailbox from server context;
  `assertCallerIdentity` already rejects a mismatching `from` / `recipient_id` / `actor_id`.

## 6. Decisions (owner directions of 2026-10-10 recorded in `V7_S0B_S1_PRIVATE_REALM_DESIGN.md`)

Owner approved: staged legacy transition behind credentials; reserve `prin conn home acct ten` (and `inbox` pending the audit, `agent:` NOT reserved); Option B private storage as architecture only. Production enforcement, bindings and migrations still need separate approval. Original questions below kept for history.

1. **Legacy inbox containment.** Keep `chatgpt:chat` / `chatgpt:cairnstone-v6` and the other
   shared legacy inboxes open as a compatibility realm, or put them behind a credential. The
   roadmap forbids silently severing trusted agents, so this needs explicit signoff.
2. **Reserved namespaces.** Confirm `prin`, `conn`, `home`, `acct`, `ten` are free to reserve.
   No known legacy actor uses them.
3. **S0b storage option** (A or B above).
4. **Rollout of S0a:** `shadow` first, then `enforce`, each a separate approval. Neither is
   enabled by this PR.

## 7. Acceptance mapping (Roadmap tests A–K)

| Test | S0a | Needs |
|---|---|---|
| D (account #2 cannot list/read/ack/send as #1) | Mailbox tools: covered when `enforce`. Search/Stone/REST: **not covered** | S0b |
| I (URL swap, audience replay, alias race, cross-tenant) | Reserved-namespace spoofing covered | S1, S2 |
| J (negative checks for all storage reads) | Not covered | S0b |
| A, B, C, E, F, G, H, K | Out of scope for S0a | S1–S4 |

Unit and dispatch coverage lives in `test/realm-guard.test.js` (19 tests).

## 8. Operational notes

- Full suite on this branch: 835 tests, 830 pass. The 5 failures are identical on `main`
  (`a0141eb`) and are environmental: they spawn the `sqlite3` CLI, which is absent from this
  sandbox (`spawnSync sqlite3 ENOENT`): event-journal write hooks, state-read hooks, migration
  append-only, AC1 delivery audit.
- No migration, wrangler config change, or deploy is part of this PR. `AC1_REALM_GUARD` is
  unset in `wrangler.toml`, so the default is `off`.
