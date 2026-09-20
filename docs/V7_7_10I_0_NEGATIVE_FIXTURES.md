# V7.7.10i.0 — Negative fixtures (fail closed)

Status: **CONTRACT FREEZE.** Fixtures are required before 10i.1 runtime. Each row is a named test that MUST return the listed class, never a silent success.

| ID | Threat | Setup | Expected |
|---|---|---|---|
| NF-01 | URL possession | Unauthenticated GET/POST to protected Core-auth tool | `401` + RFC 9728 `WWW-Authenticate` |
| NF-02 | Foreign provider token | ChatGPT/Claude/Perplexity access token as Bearer | `401` |
| NF-03 | Cross-resource token | Token audience ≠ canonical Core-auth resource | `401` |
| NF-04 | Issuer mix-up | Authorization response `iss` ≠ AS | reject token issuance |
| NF-05 | Same-provider collision | Two Perplexity accounts, identical client family | distinct `connection_id`/`principal_id` |
| NF-06 | Alias claim race | A and B claim `perplexity:chat` | one winner; loser `403`; no body rewrite |
| NF-07 | Send-as | Authenticated A sets `from`=B | `403` |
| NF-08 | Read-as | A `recipient_id`=B inbox | `403` |
| NF-09 | Invite confused deputy | A claims B invite without grant | `403` |
| NF-10 | Workspace IDOR | A reads B `workspace_id` | `403` / empty, never leak |
| NF-11 | Code Session IDOR | A compiles B session | `403` |
| NF-12 | Legacy enumerates canary | `/mcp` or `/mcp/core` query auth_* / new principal rows | no rows; no error oracle of IDs |
| NF-13 | Canary reads only via context | core-auth tool with caller `account_id` of B | `403`; server context wins |
| NF-14 | Refresh reuse | Replay rotated refresh | family revoked; `401` |
| NF-15 | Revocation isolation | Revoke connection A | A dead immediately; sibling B live |
| NF-16 | Reinstall duplicate bootstrap | Fresh auth under same account | new connection/principal; **no** duplicate home workspace/session |
| NF-17 | Wallet rotation | Replace wallet address | `account_id` unchanged; authenticator replaced |
| NF-18 | Zero-balance spend | Authenticate with unfunded wallet, attempt paid quote capture | auth OK; spend/economic grant absent |
| NF-19 | CIMD SSRF | `client_id` URL to link-local/metadata | fetch denied; no token |
| NF-20 | CIMD redirect | metadata 302 to internal IP | fail closed |
| NF-21 | Secret leakage | Auth success path | no token/code/proof in Stones, AC1, GitHub, logs, receipts, tool JSON |
| NF-22 | Hydration identity loss | tool_execute / load_tools / hydrated tool | principal identical to gateway context |
| NF-23 | Step-up widening | extra scope request | scopes may increase only with AS; memberships/mutation not silently added |
| NF-24 | Concurrent alias bind | two commits same alias | one commit; other fail-closed |
| NF-25 | Stolen same-resource bearer | replay unexpired access token | residual risk: succeeds until TTL/revoke; document, do not claim solved |
| NF-26 | DCR unexpected | DCR flag off | registration rejected |
| NF-27 | `/mcp-b` as auth | treat mcp-b as token audience | `401`; mcp-b unchanged |
| NF-28 | Authenticator replacement without step-up | replace passkey/wallet without confirmation | `403` |
| NF-29 | Authorization-code replay | Redeem one authorization code twice | first may succeed; second `invalid_grant`; no second token |
| NF-30 | PKCE verifier mismatch | Redeem code with wrong verifier | `invalid_grant`; no token |
| NF-31 | Token-family substitution | Present sibling connection/family material as another principal | `401`; no family/principal crossover |
| NF-32 | Tenant mismatch | T1-bound principal targets T2 without validated membership | `403`; no T2 data |
| NF-33 | Suspended/closed account | Otherwise-valid bearer for suspended or closed account | `403`; no private tool/data access |
| NF-34 | Compromised authenticator revocation | Revoke authenticator that originated active token families | matching active families revoked; call/refresh `401` |
| NF-35 | Stale authz version | Revoke membership/grant after token issuance | stale `authz_version` cannot retain revoked rights; fail closed |
| NF-36 | Redirect URI mismatch | Authorization/token flow uses redirect URI not exactly allowlisted | reject; no code/token |
| NF-37 | CIMD metadata mutation | Previously fetched client metadata changes redirect/client properties | URL+content-hash policy revalidates or fails closed; stale metadata cannot authorize |
| NF-38 | Multi-tenant account | Same account joins T2 then selects T2 | `account_id` unchanged; tenant binding only after membership; cross-tenant access still denied |
| NF-39 | Target/caller confusion | A sends/assigns/grants to B using a legitimate target field | caller remains A; B is only a policy-authorized target; no principal substitution |
| NF-40 | Authenticator method/assurance mismatch | e.g. `wallet_proof` + `oidc` assurance | record/authentication rejected |

## Positive canary (not 10i.1 deploy, fixture specs only)

- P-01: first auth creates account, tenant, authenticator, connection, principal, token family, home workspace pointer, Code Session pointer, bootstrap receipt.
- P-02: valid refresh resumes same connection/principal.
- P-03: second Perplexity account is principal B, isolated mailboxes.
- P-04: one account joins a second tenant without changing `account_id`; tenant-bound access requires validated membership.
- P-05: A may target B for an authorized send/assign/grant while A remains the immutable caller in audit/context.
