import { mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { runCommand } from "./process.ts";
import { renderPrompt } from "./prompts.ts";
import type { Config, Review, Run } from "./types.ts";

function timeout(config: Config): number {
  return config.commandTimeoutMinutes * 60_000;
}

export async function invokeClaude(
  config: Config,
  run: Run,
  prompt: string,
  resume = false
): Promise<string | null> {
  const args = [
    "--print",
    "--output-format", "json",
    "--permission-mode", "acceptEdits",
    "--allowedTools", config.claude.allowedTools
  ];
  if (config.claude.model) args.push("--model", config.claude.model);
  if (resume && run.claudeSessionId) args.push("--resume", run.claudeSessionId);
  const result = await runCommand("claude", args, {
    cwd: run.worktree,
    stdin: prompt,
    timeoutMs: timeout(config),
    quiet: false
  });
  try {
    const parsed = JSON.parse(result.stdout);
    return parsed.session_id ?? parsed.sessionId ?? run.claudeSessionId;
  } catch {
    return run.claudeSessionId;
  }
}

export async function invokeCodexReview(
  config: Config,
  run: Run,
  schemaPath: string,
  outputPath: string,
  finalReview: boolean
): Promise<Review> {
  mkdirSync(dirname(outputPath), { recursive: true });
  const args = [
    "exec", "--ephemeral", "--sandbox", "read-only",
    "--output-schema", schemaPath,
    "--output-last-message", outputPath
  ];
  if (config.codex.model) args.push("--model", config.codex.model);
  if (config.codex.reasoningEffort) {
    args.push("-c", `model_reasoning_effort=\"${config.codex.reasoningEffort}\"`);
  }
  args.push("-");
  const phase = finalReview ? "final, fresh" : "initial";
  const prompt = renderPrompt(config, "review", {
    reviewPhase: phase,
    issueNumber: String(run.issueNumber),
    prNumber: String(run.prNumber),
    branch: run.branch,
    issueTitle: run.issueTitle,
    issueBody: run.issueBody,
    baseBranch: config.baseBranch
  }, `Perform an {{reviewPhase}} code review of pull request #{{prNumber}} for issue #{{issueNumber}}: {{issueTitle}}.

The current worktree is checked out on that PR's branch ({{branch}}) and HEAD is its head commit. Review only this worktree, never any other checkout. Review the complete diff between {{baseBranch}} and HEAD. Inspect relevant surrounding code and tests. Run read-only checks if helpful. Focus on concrete correctness, security, regressions, data loss, concurrency, and missing test coverage. Do not edit files. Return only the schema-conforming review. Approve only when there are no actionable findings.

Acceptance context:
{{issueBody}}`);
  await runCommand("codex", args, {
    cwd: run.worktree,
    stdin: prompt,
    timeoutMs: timeout(config),
    quiet: false
  });
  const review = JSON.parse(readFileSync(outputPath, "utf8")) as Review;
  validateReview(review);
  return review;
}

function validateReview(review: Review): void {
  if (!review || !["approved", "changes_requested"].includes(review.verdict)) {
    throw new Error("Codex returned an invalid review verdict");
  }
  if (!Array.isArray(review.findings)) throw new Error("Codex review has no findings array");
  if (review.verdict === "approved" && review.findings.length > 0) {
    throw new Error("Codex approved the change but also returned findings");
  }
  if (review.verdict === "changes_requested" && review.findings.length === 0) {
    throw new Error("Codex requested changes without a finding");
  }
}

export function implementationPrompt(config: Config, run: Run): string {
  return renderPrompt(config, "implement", {
    issueNumber: String(run.issueNumber), prNumber: String(run.prNumber), branch: run.branch, issueTitle: run.issueTitle,
    issueBody: run.issueBody, testCommand: promptTestCommand(config)
  }, `Implement GitHub issue #{{issueNumber}}: {{issueTitle}}

You are working on pull request #{{prNumber}} (branch {{branch}}) for issue #{{issueNumber}}. The current directory is the isolated git worktree checked out on that PR's branch; every change you make lands on that PR, and the orchestrator commits and pushes it. Never read or modify any other checkout of this repository.

{{issueBody}}

Work only in the current worktree. Inspect the codebase before editing. Implement the complete acceptance criteria, add or update tests, and run {{testCommand}}. Do not commit, push, open a pull request, merge, or modify issue labels; the orchestrator owns Git and GitHub state. Finish with a concise summary and the checks you ran.`);
}

export function fixPrompt(config: Config, run: Run, review: Review): string {
  return renderPrompt(config, "fix", {
    issueNumber: String(run.issueNumber), prNumber: String(run.prNumber), branch: run.branch, review: JSON.stringify(review, null, 2),
    testCommand: promptTestCommand(config)
  }, `Address every actionable Codex review finding below for issue #{{issueNumber}}.

You are working on pull request #{{prNumber}} (branch {{branch}}) for issue #{{issueNumber}}. The current directory is the isolated git worktree checked out on that PR's branch; every change you make lands on that PR, and the orchestrator commits and pushes it. Never read or modify any other checkout of this repository.

{{review}}

Inspect the current files rather than trusting line numbers blindly. Make the smallest complete fixes, add regression tests where appropriate, and run {{testCommand}}. Do not commit, push, merge, or alter GitHub metadata. Finish with a concise summary and checks run.`);
}

export function ciFixPrompt(config: Config, run: Run, checks: string): string {
  return renderPrompt(config, "ci-fix", {
    issueNumber: String(run.issueNumber), prNumber: String(run.prNumber), branch: run.branch, checks, testCommand: promptTestCommand(config)
  }, `The CI checks for pull request #{{prNumber}} (issue #{{issueNumber}}) failed.

You are working on pull request #{{prNumber}} (branch {{branch}}) for issue #{{issueNumber}}. The current directory is the isolated git worktree checked out on that PR's branch; every change you make lands on that PR, and the orchestrator commits and pushes it. Never read or modify any other checkout of this repository.

Diagnose and fix the failures using this check summary:

{{checks}}

Inspect the repository and reproduce failures locally where possible. Make the smallest correct fixes and run {{testCommand}}. Do not commit, push, merge, or alter GitHub metadata.`);
}

function promptTestCommand(config: Config): string {
  return config.testCommand === "auto"
    ? "the appropriate test suite for the project"
    : config.testCommand;
}
