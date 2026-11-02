Address every actionable Codex review finding below for issue #{{issueNumber}}.

You are working on pull request #{{prNumber}} (branch {{branch}}) for issue #{{issueNumber}}. The current directory is the isolated git worktree checked out on that PR's branch; every change you make lands on that PR, and the orchestrator commits and pushes it. Never read or modify any other checkout of this repository.

{{review}}

Inspect the current files rather than trusting line numbers blindly. Make the smallest complete fixes, add regression tests where appropriate, and run {{testCommand}}. Do not commit, push, merge, or alter GitHub metadata. Finish with a concise summary and checks run.
