Perform a {{reviewPhase}} code review of pull request #{{prNumber}} for issue #{{issueNumber}}: {{issueTitle}}.

The current worktree is checked out on that PR's branch ({{branch}}) and HEAD is its head commit. Review only this worktree, never any other checkout. Review the complete diff between {{baseBranch}} and HEAD. Inspect relevant surrounding code and tests. Run read-only checks if helpful. Focus on concrete correctness, security, regressions, data loss, concurrency, and missing test coverage. Do not edit files. Return only the schema-conforming review. Approve only when there are no actionable findings.

Acceptance context:
{{issueBody}}
