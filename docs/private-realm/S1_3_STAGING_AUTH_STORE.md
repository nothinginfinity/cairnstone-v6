# Staging-only durable auth store (issue #94)

Real D1 adapter replacing the former interface-only stub. Source: `src/staging-gateway/staging-auth-store.js`.
Schema: `migrations/staging-auth/0001_staging_auth.sql` (versioned via `staging_auth_schema`). Binding: `STAGING_AUTH_DB`
(`cairnstone-staging-auth`, placeholder id in the tomls). Staging only; never production.

## Behavior
`checkAuth({accountId, connectionId, tokenFamilyId})` resolves with `true` only when ALL hold: the family row exists,
`revoked = 0`, its connection exists with `status = 'active'`, and the family's account, the connection's account and the
token's account agree and the family belongs to the token's connection. Everything else denies: missing/unknown/inactive/revoked
family or connection, malformed ids, null input, missing/invalid DB, query errors, wrong-account association.
The OAuth verifier admits only a strict `true`, and checks the signature and claims before touching the store.

## Schema guarantees (triggers)
Connection and family identity frozen; revoked connection terminal; revocation permanent (no un-revoke); no deletes;
a family can only be created on a connection of the same account.

## Owner prerequisites (not done here; issue #90)
1. Create D1 `cairnstone-staging-auth`, put its real id into the tomls (placeholder is all zeros).
2. Apply `migrations/staging-auth/0001_staging_auth.sql` to staging only.
3. Seed real staging connections/families (the Stage C harness upserts only synthetic `*_stagec_*` fixtures).
No secrets, merges or promotions happen in this PR.
