# Skill: GitHub Actions job logs

Raw Actions logs are keyed by **job ID**, not workflow run ID.

1. Given a run ID, list the run's jobs first.
2. Take the numeric `jobs[].id` for the failing/relevant job.
3. Request `/repos/{owner}/{repo}/actions/jobs/{job_id}/logs` with that job ID.
4. The GitHub logs endpoint normally returns HTTP `302` to a short-lived archive URL. Treat the redirect as success and follow `Location`; do not classify `302` as a failed logs request.
5. Prefer the jobs listing when it already provides enough step-level failure evidence; raw logs are more expensive and often unnecessary.

This skill is the Git-versioned successor to the original mutable R2 `actions-job-logs` AFO GitHub skill.
