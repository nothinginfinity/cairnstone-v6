# V7.7.7d implementation note — repo-scale working tree

Draft/transport plane only. Extends Shared Agent Workspace with
delete/rename/content_ref tips, Git hydrate, GitHub transport bind updates,
tree ls/diff, and GitZip transport receipts. Git/GitZip success is never
accepted-state and never deploy. Never moves chain/path HEADs.
`accepted_state_authority: false` always. Reuses `workspace_capability` +
membership. Code Session gains `set_working_transport` CAS + compile-context
`workspace.tree_stats` / `git_transport`.

Plan stone: `297ffc7a5894f89464f413812646763ed670c53ef6093a39e3f06355d9d1136e`
Docs: `docs/V7_7_7D_REPO_SCALE_WORKING_TREE.md`
Worker version tip for this slice: `0.5.34`
