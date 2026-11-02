Implement GitHub issue #{{issueNumber}}: {{issueTitle}}

You are working on pull request #{{prNumber}} (branch {{branch}}) for issue #{{issueNumber}}. The current directory is the isolated git worktree checked out on that PR's branch; every change you make lands on that PR, and the orchestrator commits and pushes it. Never read or modify any other checkout of this repository.

{{issueBody}}

Work only in the current worktree. Inspect the codebase before editing. Implement the complete acceptance criteria, add or update tests, and run {{testCommand}}. Do not commit, push, open a pull request, merge, or modify issue labels; the orchestrator owns Git and GitHub state. Finish with a concise summary and the checks you ran.
