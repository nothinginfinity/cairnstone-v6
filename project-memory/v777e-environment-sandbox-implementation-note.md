# V7.7.7e implementation note — environment sandbox

Operational/reconstructability plane only. Adds provider-neutral environment
manifests, disposable sandbox attachments, and immutable sandbox-local
execution receipts. Sandbox-local execution is never deploy/merge/accepted-state.
Never moves chain/path HEADs. `accepted_state_authority: false` and
`secrets_absent: true` always. Reuses `workspace_capability` + membership.
Code Session gains CAS attach-environment, `latest_sandbox_attachment_id`,
and compile-context `environment_sandbox`.

Plan stone: `297ffc7a5894f89464f413812646763ed670c53ef6093a39e3f06355d9d1136e`
Docs: `docs/V7_7_7E_ENVIRONMENT_SANDBOX.md`
Worker version tip for this slice: `0.5.35`
