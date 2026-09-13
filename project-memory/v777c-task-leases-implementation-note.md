# V7.7.7c implementation note — task/path leases

Operational coordination plane only. Adds `code_session_leases` + MCP/REST
acquire/renew/release/list. Leases are coordination hints (not locks); hard
path correctness remains workspace CAS. Never moves chain/path HEADs.
`accepted_state_authority: false` always. Reuses `workspace_capability` +
membership. Compile-context / get surface live leases; `conflict_rebase`
checkpoints hydrate lease awareness into 7.7.7b stubs.

Plan stone: `297ffc7a5894f89464f413812646763ed670c53ef6093a39e3f06355d9d1136e`
Docs: `docs/V7_7_7C_TASK_LEASES.md`
Worker version tip for this slice: `0.5.33`
