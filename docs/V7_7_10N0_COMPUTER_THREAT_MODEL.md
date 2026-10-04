# V7.7.10n.0 — personal-computer threat model

Status: DRAFT / negative cases only. No live computer. No exploit procedures.
Date: 2026-10-04
Author: grok:cairnstone-v6
Canonical lock stone: `e37be2c29ca0cb4b6e0660d635f7625be42bf34d6163bbc104d40a016b4c99b7`

Assets: logical `computer_id`, owner account, home generations, uncommitted workspace, human browser profile, credential vault, agent grants, preview capabilities, provider/runtime handles, storage/home adapter refs, audit events.

## Threats and required failures

1. Provider identity capture. A container/VM id must not become or alias `computer_id`.
2. Empty-home substitution. Restore must fail closed rather than mount an empty home as the user's profile.
3. Silent dirty-home drop. Controlled sleep/destroy must remain incomplete if checkpointing fails.
4. Uncommitted-work laundering. A remote clone must not be reported as recovery of uncommitted edits.
5. Runtime-root promotion. Disposable root FS changes must not become durable personal state without an explicit home generation.
6. Session-plane confusion. An agent on the same `computer_id` must not read the vault or human browser profile.
7. Revocation lag. Revoked agent grants must not retain process or session authority. Revocation must not delete the logical computer.
8. Terminal privilege jump. A terminal pane must not imply deploy, accepted-state, spend, credential, or unrestricted network authority.
9. Public inbound default. Managed network must deny unsolicited inbound ports.
10. Preview linger. Preview URLs without a capability, past `expires_at`, or with malformed timestamps must fail.
11. Network/authority conflation. Opening an allowlist host must not grant accepted-state or deploy authority.
12. Child-agent ceiling break. A child session must not exceed parent task-run, grant, or budget ceilings.
13. Accepted-state smuggling. Computer runtime/session objects must keep `accepted_state_authority=false`; other forbidden authorities must not appear.
14. Audit gap. Lifecycle, checkpoint failure, grant issue/revoke, network policy expansion, unexpected runtime loss, and restore failure must be attributable events. This slice specifies the requirement; it does not write the live journal.
15. Malformed network request. Missing/non-object policy or request must fail closed.
16. Invalid home state. Unknown status or inconsistent generation pairs must fail closed before controlled transitions.
17. Owner spoofing. `computer_id` owner segment must match `owner_account_id`.
18. Adapter identity confusion. Provider and storage adapters must not treat runtime handles as logical computer identity, and must not mark runtime root as promotable durable state.

## Out of scope

No production attack simulation, no credential material, no provider provisioning, no merge/deploy.
