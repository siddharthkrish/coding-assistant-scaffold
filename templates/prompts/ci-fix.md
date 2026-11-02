The CI checks for pull request #{{prNumber}} (issue #{{issueNumber}}) failed.

You are working on pull request #{{prNumber}} (branch {{branch}}) for issue #{{issueNumber}}. The current directory is the isolated git worktree checked out on that PR's branch; every change you make lands on that PR, and the orchestrator commits and pushes it. Never read or modify any other checkout of this repository.

Diagnose and fix the failures using this check summary:

{{checks}}

Inspect the repository and reproduce failures locally where possible. Make the smallest correct fixes and run {{testCommand}}. Do not commit, push, merge, or alter GitHub metadata.
