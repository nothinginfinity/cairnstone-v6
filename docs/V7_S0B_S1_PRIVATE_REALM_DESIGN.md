# S0b / S1 — Private realm storage and identity-to-mailbox bridge: design

Status: **DESIGN ONLY (draft PR, stacked on #70).** No merge, deploy, migration, binding, enforcement or accepted-HEAD authority.
Roadmap Stone `3fcdb3598e58246f299102bb71e14b598268e60ef9d3a7d4496d19e740328d5c`; Portability Stone `cadfc8d6a6a7a3cb186604d2f1bcde3f09e194829eb2442752d6295f3252e182`.
Builds on S0a (`src/realm-guard.js`, PR #70) and `docs/V7_S0_PRIVATE_REALM_ISOLATION.md`.

## 1. Owner directions recorded (2026-10-10)

1. Legacy inboxes end up behind credentials via a **staged** transition; history and delivery state preserved; no new private users or messages into legacy storage; audit legacy Stone/search/REST body access; production enforcement needs separate approval.
2. Reserve `prin:`, `conn:`, `home:`, `acct:`, `ten:`. **Do not reserve `agent:`.** `inbox:` reserved only if the audit is clean (it is, see §3). No ownership claim from an actor string.
3. Storage is Option B: separate private-realm storage (dedicated private D1 plus separately protected R2), server-enforced account/tenant/Home/principal authorization. Many Homes may share isolated infrastructure at first; a per-Home resolver keeps later migration to dedicated Workers/D1/R2/domains possible. Architecture only: no binding creation or migration yet.
4. Order: account creation, then organizations, then managed subaccounts. Design continues in parallel with ChatGPT's review of #70.
5. Portability: **the Home belongs to the user, not the LLM provider.**

## 2. Threat model

| # | Threat | Control in this design |
|---|---|---|
| T1 | Unauthenticated caller names a private address on legacy mailbox tools | S0a guard (namespace reservation, now incl. `inbox:`, `home_`, `ibx_`) |
| T2 | Private message bodies read via shared stones, search, FTS, hash, manifests, REST | Bodies never written to shared tables or the shared R2 prefix; private D1 binding is not available to legacy code paths |
| T3 | Account B reads or writes Account A's Home | Every row has `home_id`; composite FKs; Home resolved from verified `authContext`, never from a request field |
| T4 | Connection X reads connection Y's private inbox | `scope='connection'` inboxes have one owner; access through `priv_inbox_grants` only |
| T5 | URL swap / audience replay / alias race | Connection ID taken from the token-bound context; a path or body `home_id`/`inbox_id` is a *selector* that must match the grant, else deny + audit |
| T6 | Actor-string claim of ownership (`chatgpt:chat`) | Ownership only by authenticated claim flow (§5); strings confer nothing |
| T7 | Provider lock-in / token transplant | Home keyed by account; provider is a label on a connection; each connection has its own credential; no token reuse across providers |
| T8 | Silent mutation of history | `priv_messages` immutable, deliveries forward-only, audit append-only (triggers, tested) |
| T9 | Legacy compatibility becomes a permanent backdoor | Phases L0–L3 with an explicit sunset; each switch needs approval |
| T10 | Hostile legacy writes into private realm (spoofed sender) | Private-realm sends only through authenticated path; sender inbox/connection derived server-side |
| T11 | Audit/log leakage | Audit stores IDs and reasons only, never bodies or secrets; guard logs field names only |

## 3. Namespace collision audit

- **Repository**: no source, fixture or doc uses `prin:`, `conn:`, `acct:`, `ten:`, `inbox:` as an actor namespace. `home:` appears once as a computer-contract profile ref (not an AC1 actor field; naming overlap noted). `agent:claude:jared` and similar exist in fixtures, so `agent:` stays unreserved (guard tests assert it is allowed).
- **Live (partial)**: unauthenticated probes for `agent:claude:jared`, `agent:chatgpt:jared`, `inbox:default`, `home:default` returned nothing. A complete census is **not** possible without database access. Operator-run read-only SQL:

```sql
SELECT DISTINCT sender_id AS actor FROM correspondence_deliveries
UNION SELECT DISTINCT recipient_id FROM correspondence_deliveries;
SELECT substr(path,1,instr(path,'/')) AS prefix, COUNT(*) FROM refs
 WHERE path LIKE 'correspondence/%' OR path LIKE 'notes/%' GROUP BY 1;
```

  Reserve `inbox:` in enforce mode only after this census shows no historical `inbox:*` actor. The guard is default-off, so merging code does not itself reserve anything in production.

## 4. Minimal implementation proposal (ordered PR slices)

| Slice | Content | Touches |
|---|---|---|
| S0a (PR #70) | Guard, default off | code only |
| S0b-0 (this PR) | Design, draft schema, schema tests, guard reserves `inbox`/`home_`/`ibx_` | docs, tests, guard (still off) |
| S0b-1 | `src/private-realm/` store module behind an interface and **per-Home resolver** (`resolveHomeStore(env, homeId)`); in-memory/SQLite fake for tests; no binding | code, tests |
| S0b-2 | Migration file for private D1 (from the draft), `wrangler.toml` binding **commented/absent** until approved | migration file, not applied |
| S1-1 | Identity-to-mailbox bridge: account → default Home (idempotent), connection → principal → grants; ID minting; address mapping `prin_x` ↔ `inbox:`/`ibx_` | code, tests |
| S1-2 | Authenticated private tools on `/mcp/core-auth` only (inbox get/send/read/ack/list) using the store; legacy tools untouched | code, tests |
| S1-3 | Claim flow for legacy actors (§5) | code, tests |
| S2+ | Per-connection MCP URLs, Hop Card onboarding, dedicated node (separate designs) | later |

Each slice is independently revertible and ships dormant (flag/binding absent).

### Addressing
- `home_<opaque>` Home; `ibx_<opaque>` inbox; `conn_`, `prin_` unchanged from core-auth. Inbox scopes: `home` (portable, Home-owned, shared by grant), `connection` (private to one provider connection), `agent_identity` (optional provider-neutral identity).
- Plane (`chat`/`work`/`notifications`/`control`) is explicit column data, not inferred from address suffix.

### Portability mapping to Acceptance A–H
Home-owned inboxes and memory survive connection revoke/replace; a new provider connection is granted into the existing Home rather than creating a new one; revoking one connection never deletes Home data (tested via FK/immutability invariants; behavioural tests land in S1-1/S1-2).

## 5. Legacy transition (L0–L3)

| Phase | State | Production effect | Approval |
|---|---|---|---|
| L0 | S0a merged, guard `off` | none | review of #70 |
| L1 | Guard `shadow`; census SQL run; legacy body-read audit report | log lines only | approval to set env var |
| L2 | Guard `enforce` for private namespaces; **no new private data in legacy** | blocks private names on legacy | explicit approval |
| L3 | Legacy actors (`chatgpt:chat` …) require an authenticated **claim**: an authenticated principal proves control via an owner-approved flow, gets a grant to a migrated copy/view of the historical inbox; unauthenticated legacy mailbox/read paths close after a notice window | closes legacy backdoor | explicit approval + sunset date |

History and delivery states are preserved (copied or referenced, never rewritten). No automatic claim by actor string.

## 6. Migration boundaries

| Item | Changed by this PR | Needs separate approval before |
|---|---|---|
| Production D1/R2 binding creation | no | creating `CAIRNSTONE_PRIVATE_DB` / private R2 |
| Applying any migration | no (draft lives in `docs/`) | moving draft to `migrations/` and applying |
| `AC1_REALM_GUARD` value | no (unset = off) | shadow, then enforce |
| Legacy data moves or deletes | no | any copy, tombstone or sunset |
| `wrangler.toml` / deploy | no | any deploy |
| Accepted HEADs / chain state | no | advancing any |
| Merging #70 or this PR | no | independent review |

## 7. Required owner approvals (not yet given)

1. Review and merge of PR #70, then this PR (independent review).
2. Creation of the private D1 binding and protected R2 bucket; naming and region; whether early Homes share one DB.
3. Applying the private-realm migration.
4. Guard rollout: `shadow` then `enforce`; run the census SQL first (§3) and confirm no historical `inbox:*` actors.
5. Legacy claim-flow design sign-off and the L3 sunset date.
6. Confirmation that `agent:` stays unreserved, and whether to later give agent identities a separate reserved form.
7. Account→default-Home creation policy (automatic on first authenticated connect vs explicit), and the ordering for organizations then managed subaccounts.

## 8. Out of scope here
Organizations, managed subaccounts, per-connection URLs, Hop Card, dedicated node, Home export format, and the non-mailbox actor surfaces (`access_grant_*`, `task_run_*`, `conversation_session_*`, `workspace_invite_claim`, `agent_bootstrap`) are noted in S0 and designed in later slices.
