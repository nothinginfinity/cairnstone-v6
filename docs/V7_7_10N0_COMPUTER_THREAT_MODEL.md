# V7.7.10n.0 — personal-computer threat model

Status: DRAFT / negative cases only. No live computer. No exploit procedures.
Date: 2026-10-04
Author: grok:cairnstone-v6

Assets: logical `computer_id`, owner account, home generations, uncommitted workspace, human browser profile, credential vault, agent grants, preview capabilities, audit events.

## Threats and required failures

1. Provider identity capture. A container/VM id must not become or alias `computer_id`.
2. Empty-home substitution. Restore must fail closed rather than mount an empty home as the user's profile.
3. Silent dirty-home drop. Controlled sleep/destroy must remain incomplete if checkpointing fails.
4. Uncommitted-work laundering. A remote clone must not be reported as recovery of uncommitted edits.
5. Runtime-root promotion. Disposable root FS changes must not become durable personal state without an explicit home generation.
6. Session-plane confusion. An agent on the same `computer_id` must not read the vault or human browser profile.
7. Revocation lag. Revoked agent grants must not retain process or session authority. Revocation must not delete the logical computer.
8. Terminal privilege jump. A terminal pane must not imply deploy, accepted-state, spend, or unrestricted network authority.
9. Public inbound default. Managed network must deny unsolicited inbound ports.
10. Preview linger. Preview URLs without a capability, or past `expires_at`, must fail.
11. Network/authority conflation. Opening an allowlist host must not grant accepted-state or deploy authority.
12. Child-agent ceiling break. A child session must not exceed parent task-run, grant, or budget ceilings.
13. Accepted-state smuggling. Computer runtime/session objects must keep `accepted_state_authority=false`.
14. Audit gap. Lifecycle, checkpoint failure, grant issue/revoke, network policy expansion, and restore failure must be attributable events. This slice specifies the requirement; it does not write the live journal.

## Out of scope

No production attack simulation, no credential material, no provider provisioning, no merge/deploy.
