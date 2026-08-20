# Pair-programming orchestrator

A repo-local workflow controller for Claude Code implementation and Codex review. It claims a labeled GitHub issue, creates an isolated worktree, asks Claude Code to implement it, asks Codex for a schema-constrained review, loops fixes through Claude, verifies CI against the reviewed commit, merges the PR, and fast-forwards the local main branch.

Merge authority remains in deterministic code rather than either agent.

## Quick start

Run the initializer inside the repository the agents should work on:

```sh
npx pair-programming-orchestrator@0.1.1 init
```

For Node projects, `init` installs an exact development dependency and adds these scripts:

```sh
npm run agents:once    # Process one issue
npm run agents         # Continuously watch the issue queue
npm run agents:doctor  # Validate tools and authentication
npm run agents:status  # Inspect durable workflow state
```

Before the first run, validate the local tools and authentication:

```sh
npm run agents:doctor
```

Label an issue `agent-ready`, then run one issue or select it explicitly:

```sh
npm run agents:once
npm run agents:once -- --issue 123
```

Use `--no-install` with `init` to scaffold without adding a package dependency. Non-Node repositories can keep using the version-pinned `npx pair-programming-orchestrator@0.1.1 <command>` form. Avoid `npm exec -- agent-orchestrator`: without the local development dependency, npm resolves that as the unrelated `agent-orchestrator` package from the registry.

## What `init` creates

```text
your-project/
├── .agent-orchestrator/
│   └── config.json
├── .gitignore
└── package.json          # scripts and exact dev dependency for Node projects
```

The configuration is intended to be committed. SQLite state, reviews, and CI snapshots are added to `.gitignore`. Issue worktrees live outside the repository by default:

```text
../.agent-orchestrator-worktrees/<repository>/issue-123/
```

The CLI discovers `.agent-orchestrator/config.json` by walking upward from the current directory, so commands also work from nested project folders.

## Commands

```text
agent-orchestrator init [--dir path] [--no-install] [--force]
agent-orchestrator doctor [--config path]
agent-orchestrator run [--issue N] [--config path]
agent-orchestrator start [--config path]
agent-orchestrator resume [--issue N] [--config path]
agent-orchestrator status [--config path]
agent-orchestrator eject-prompts [--force] [--config path]
```

- `run` processes one queued or explicitly selected issue.
- `start` keeps polling the labeled GitHub issue queue until interrupted.
- `resume` continues persisted work after an operational failure.
- `eject-prompts` creates editable implementation, review, fix, and CI-fix prompts under `.agent-orchestrator/prompts/`.

## Requirements

- Node.js 24 or newer
- `git`, `gh`, `claude`, and `codex` on `PATH`
- Authenticated GitHub, Claude Code, and Codex CLIs
- A GitHub repository with a clean local checkout on its base branch
- Rebase merging enabled in the GitHub repository

No API keys or CLI credentials are written to project configuration.

## Configuration

The initializer detects the Git root, current or remote default branch, package manager, and likely test command. Review `.agent-orchestrator/config.json` before the first autonomous run, especially:

- `testCommand`
- issue queue labels
- `maxReviewCycles`
- Claude allowed tools
- Codex reasoning effort

All options can be overridden per repository. The default worktree location can be changed with `worktreeRoot`.

## Workflow and safety gates

1. Claim one issue by moving it from `readyLabel` to `claimedLabel`.
2. Create a branch and external Git worktree from `remote/baseBranch`.
3. Run Claude Code in edit mode; the orchestrator owns commits and GitHub operations.
4. Run project tests, commit, push, and open a draft PR.
5. Run Codex in a read-only sandbox with a packaged JSON response schema.
6. If Codex requests changes, resume the Claude session and repeat, up to `maxReviewCycles`.
7. Wait for CI. A failed check goes back to Claude and must pass another fresh Codex review.
8. Verify both local and remote PR heads exactly equal the SHA approved by Codex.
9. Mark the PR ready, merge with GitHub's rebase strategy, and update local main using `git merge --ff-only`.

The orchestrator stops in `human_review` when it reaches the iteration limit. Operational errors preserve the current phase and record `lastError` so the run can be resumed after the underlying problem is fixed.

## Development

```sh
npm test
npm run pack:check
```

The package has no runtime npm dependencies. TypeScript source is compiled to distributable JavaScript, and runtime state uses Node's built-in SQLite module.

Node 24 and 25 may print an `ExperimentalWarning` when SQLite-backed commands first start; this comes from Node's current `node:sqlite` stability designation.

This first version is intentionally a single-runner local orchestrator. Before running multiple orchestrator processes against the same repository, add an atomic external lease such as a GitHub check-run or shared database lock.
