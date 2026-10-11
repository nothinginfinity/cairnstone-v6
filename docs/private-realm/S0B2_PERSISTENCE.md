# S0b-2 — private persistence (DRAFT, dormant)

Status: **candidate only.** Nothing here is deployed, bound, routed, migrated or enforced. No production binding is
provisioned, no migration is applied, guard enforcement is untouched, no accepted chain/path HEAD moves.

## Pieces

| File | Role |
| --- | --- |
| `migrations/private/0001_s0b2_private_realm.sql` | Schema candidate for a *dedicated* private D1. Lives outside any wrangler `migrations_dir`. Adds BEFORE INSERT authorization triggers on `priv_messages` / `priv_deliveries`. |
| `src/private-realm/d1-store.js` | D1 adapter for the 12 `STORE_METHODS`. |
| `src/private-realm/r2-body.js`, `hash.js` | Private R2 body path: `private/{home_id}/{message_id}/{body_sha256}`, verified on read. |
| `src/private-realm/private-worker-core.js` | Caller identity (signed envelope) + dispatch. Pure, unit-tested in Node. |
| `src/private-realm/private-worker.js` | `WorkerEntrypoint` glue: one RPC method, no `fetch`. Syntax-checked only. |

## Concurrency model

Authorization is **read first** (for precise, audited denials) and then **re-evaluated inside every write**:

* guarded `INSERT`/`UPDATE` statements embed `EXISTS (...)` predicates for the active connection (principal, account,
  tenant, Home status), admin role, and live grant;
* `send` inserts the message and every delivery in one `db.batch()`; the migration triggers abort the batch if the sender
  or any target grant is no longer effective, so there is **no partial delivery**;
* the last-admin guard is part of the `UPDATE` itself; admin recovery on attach is computed in the `INSERT ... SELECT`;
* when a write affects nothing or a batch fails, state is **re-read and re-authorized**, then classified as replay
  (idempotent), conflict (`capability_denied`), lost authority (`scope_not_authorized` / `capability_denied`), or
  `concurrent_state_change`. A raw SQL/D1 error never stands in for an expected race.
* `ensureDefaultHome` is a bounded retry loop that re-authorizes (account, tenant, principal, revocation) on every pass.

## Private worker caller identity

The worker trusts only a signed envelope verified against secrets in **its own** environment
(`PRIVATE_GATEWAY_HMAC_KEY`, optional `PRIVATE_GATEWAY_HMAC_KEY_PREVIOUS`, `PRIVATE_ALLOWED_CALLERS`). The RPC surface takes
no `env`. The envelope covers `{v, caller, method, args, iat, nonce}`; the HomeScope inside `args` is therefore
integrity-protected end to end, and only the gateway (key holder) can mint one. If the platform attaches caller identity to
the binding (`ctx.props.caller`) it must match. All envelope failures collapse to `caller_not_authorized`.

## Residuals (disclosed, not hidden)

1. **Not Miniflare / not D1.** The suite runs the real migration on `node:sqlite` (a real SQLite engine) through a
   D1-shaped wrapper. D1's exact `changes()` reporting, trigger execution inside `batch()`, `RETURNING` and upsert behaviour are
   *assumed* to match SQLite and must be re-proven on a real private D1 before any provisioning.
2. **`ctx.props` is a platform assumption** (unverified here). The HMAC does not depend on it.
3. **Replay window.** Envelopes are valid for ±60 s and a per-isolate nonce cache rejects replays *within one isolate only*.
   Cross-isolate replay inside the window is possible; mutating methods are idempotent or guard-checked, but this is not
   cryptographic replay protection.
4. **Audit is not atomic with the mutation** (separate awaited insert). A crash between them loses the audit row, never safety.
5. **Orphan R2 objects** can remain when a send loses a race after its object was written. They are content-addressed
   and Home-scoped, so they cannot overwrite or be read as another message; no reaper exists yet.
6. **No pagination / unread filter** for `listInbox` / `readInbox` (limit ≤ 200, newest first).
7. D1 is stricter than the S0b-1 in-memory fake in places (e.g. revoking the last admin is refused atomically in SQL).
8. Trailing `undefined` positional arguments cannot cross the signed JSON envelope; callers omit them.
9. Inline/R2 threshold (`inlineBodyMax`, default 16384 chars) is a tunable default, not a measured limit.
10. The public gateway client that builds and signs envelopes does not exist yet (`signEnvelope` is the reference).

## Draft review addendum (2026-10-11)

The legacy Event Journal tests now use a committed, test-only `node:sqlite` helper instead of
relying on a locally installed `sqlite3` CLI shim. GitHub Actions on the PR branch runs
`npm run check` under Node 22, without deployments or production credentials.

A follow-up read-side race review added final read-grant/connection revalidation after
`listInbox` query execution and `readInbox` body hydration, including the no-stamp
(already-read) path. The extra boundary checks reduce the window for data being returned
after revocation; they do not establish a transactional response boundary or a global
cross-isolate revocation guarantee. D1 live acceptance is still required before activation.
