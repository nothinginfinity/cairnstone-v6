# Skill: GitHub workflow dispatch safety

Manual workflow dispatch is a mutation. Verify the workflow and its contract before triggering it.

1. Identify the exact workflow file/id and target repository.
2. Read the workflow source or workflow metadata and confirm it actually declares `workflow_dispatch`. Many deployment workflows are push-only.
3. Determine the intended ref and any declared inputs. Do not invent input names or values.
4. Separate "the workflow supports dispatch" from "the user authorized this dispatch". Require mutation authority before calling the trigger tool.
5. Trigger once with the explicit ref/inputs, then capture the resulting run by workflow/ref/commit evidence instead of assuming a 204 means the job succeeded.
6. Verify the run and jobs after dispatch. Deployment acceptance still requires live-state verification when relevant.

Never substitute an unrelated Pages deployment endpoint for GitHub Actions workflow dispatch or run evidence.
