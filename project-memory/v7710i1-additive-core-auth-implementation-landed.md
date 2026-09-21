# V7.7.10i.1 additive Core-auth canary — implementation landed (deploy held)

Status: **IMPLEMENTATION COMPLETE IN BRANCH / DEPLOY NOT AUTHORIZED.**

Authority stone: `48c87468211ceefa496637fc1d05efacd3f912ca44afb7507518169647f5439e`
Propose: `b20678a488194962748f6a3bce7eadaa265b4476898e04bd09d8e89f366342b5`
10i.0 freeze START HERE: `cdd79ae23c69f6013b573a72cf9126e3f9cea73eda185be81dc3032dbb3f3e09`

## Summary

Additive `/mcp/core-auth` with account-root identity, `cairnstone-token-family-v1` lifecycle, enforcement ladder `off→shadow→canary`, storage firewall (`auth_*` + `realm='core-auth'`), and fail-closed negative fixtures. Legacy `/mcp`, `/mcp/core`, `/mcp-b` unchanged. Runtime version remains `0.5.43`.

See `docs/V7_7_10I_1_ADDITIVE_CORE_AUTH.md` for ladder flip instructions and residual-risk statement (stolen same-resource bearer replay not claimed solved).

## 10i.1a follow-on (Auth D1)

Dedicated Auth D1 wiring + retirement of shared-path `migrations/0024_v7710i1_core_auth.sql` (superseded before production application): see `project-memory/v7710i1a-dedicated-auth-d1-0024-retired.md`.
