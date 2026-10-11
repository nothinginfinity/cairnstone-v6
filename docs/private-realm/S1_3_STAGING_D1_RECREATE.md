# S1-3 staging D1 recreate runbook (owner-approved path for B1)

Status: approved by owner 2026-10-11 as the B1 path. NOT yet executed. Staging only; synthetic data only.
Run by someone holding a staging-scoped Cloudflare token (Claude's session has read-only Cloudflare tools and cannot do this).

1. Record old DB id `26d4e786-2da7-47a4-a159-1ba206712b13`; confirm it is the staging DB and is bound to no production Worker.
2. `wrangler d1 create cairnstone-private-staging-2` (new name avoids clashing with the old DB until verified).
3. Apply `migrations/private-staging/0001_*.sql` then `0002_*.sql` in order (`wrangler d1 migrations apply` against the new DB; it will create a ledger).
4. Read-only preflight: confirm `priv_home_connections.role`, triggers `priv_messages_sender_authorized` and `priv_deliveries_target_authorized`, and `priv_service_nonces` exist.
5. In a follow-up commit, update `database_id` (and `database_name`) in `wrangler.private-staging.toml` to the new DB. Review that change before deploy.
6. Deploy `cairnstone-private-staging` at the reviewed commit; gateway service binding must set `props = { caller = "cairnstone-stage-gateway" }`.
7. Read back bindings; run live E2E (include a revoked-grant send rejected by the trigger, and a missing-`ctx.props` call denied).
8. Delete the old staging DB only after E2E passes and the owner confirms.
