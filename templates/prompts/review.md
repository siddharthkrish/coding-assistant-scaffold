Perform a {{reviewPhase}} code review for issue #{{issueNumber}}: {{issueTitle}}.

Review the complete diff between {{baseBranch}} and HEAD. Inspect relevant surrounding code and tests. Run read-only checks if helpful. Focus on concrete correctness, security, regressions, data loss, concurrency, and missing test coverage. Do not edit files. Return only the schema-conforming review. Approve only when there are no actionable findings.

Acceptance context:
{{issueBody}}
