import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { errorTailBytes, type StepSession } from "./activity.ts";
import { runCommand } from "./process.ts";
import { detectTestCommand } from "./project.ts";
import type { Config, Issue, Run } from "./types.ts";

const quiet = { quiet: true } as const;

export async function nextIssue(config: Config, explicit?: number): Promise<Issue | null> {
  const args = explicit
    ? ["issue", "view", String(explicit), "--json", "number,title,body,url"]
    : ["issue", "list", "--label", config.readyLabel, "--state", "open", "--limit", "1", "--json", "number,title,body,url"];
  const result = await runCommand("gh", args, { cwd: config.repository, ...quiet });
  const parsed = JSON.parse(result.stdout);
  const issue = explicit ? parsed : parsed[0];
  if (!issue) return null;
  return { number: issue.number, title: issue.title, body: issue.body ?? "", url: issue.url };
}

export async function claimIssue(config: Config, issue: Issue): Promise<void> {
  const args = ["issue", "edit", String(issue.number), "--add-label", config.claimedLabel];
  if (config.readyLabel) args.push("--remove-label", config.readyLabel);
  await runCommand("gh", args, { cwd: config.repository });
}

export async function completeIssue(config: Config, issueNumber: number): Promise<void> {
  await runCommand("gh", ["issue", "edit", String(issueNumber), "--remove-label", config.claimedLabel, "--add-label", config.completedLabel], { cwd: config.repository });
}

export async function prepareWorktree(config: Config, run: Run): Promise<void> {
  mkdirSync(dirname(run.worktree), { recursive: true });
  await runCommand("git", ["fetch", config.remote, config.baseBranch], { cwd: config.repository });
  await runCommand("git", ["worktree", "add", "-b", run.branch, run.worktree, `${config.remote}/${config.baseBranch}`], { cwd: config.repository });
}

export async function runTests(config: Config, run: Run, session?: StepSession): Promise<void> {
  const testCommand = config.testCommand === "auto"
    ? detectTestCommand(run.worktree)
    : config.testCommand;
  if (!testCommand) {
    throw new Error(
      "Unable to detect a test command after implementation. Set testCommand in .agent-orchestrator/config.json."
    );
  }
  if (session) session.progress(`running tests: ${testCommand}`);
  else console.log(`Running tests: ${testCommand}`);
  await runCommand("sh", ["-lc", testCommand], {
    cwd: run.worktree,
    timeoutMs: config.commandTimeoutMinutes * 60_000,
    // A verbose suite can emit far more than the failure message needs.
    captureBytes: errorTailBytes,
    ...(session?.commandHooks("tests") ?? {})
  });
}

export async function commitAndPush(config: Config, run: Run, message: string): Promise<string> {
  const status = await runCommand("git", ["status", "--porcelain"], { cwd: run.worktree, ...quiet });
  if (status.stdout.trim()) {
    await runCommand("git", ["add", "-A"], { cwd: run.worktree });
    await runCommand("git", ["commit", "-m", message], { cwd: run.worktree });
  } else {
    const ahead = await runCommand("git", ["rev-list", "--count", `${config.remote}/${config.baseBranch}..HEAD`], { cwd: run.worktree, ...quiet });
    if (Number(ahead.stdout.trim()) < 1) throw new Error("Agent finished without making any changes");
  }
  await runCommand("git", ["push", "-u", config.remote, run.branch], { cwd: run.worktree });
  return headSha(run);
}

export async function openDraftPr(config: Config, run: Run): Promise<number> {
  const existing = await runCommand("gh", ["pr", "view", run.branch, "--json", "number", "--jq", ".number"], {
    cwd: run.worktree, quiet: true, allowNonZero: true
  });
  if (existing.code === 0 && existing.stdout.trim()) return Number(existing.stdout.trim());
  await runCommand("gh", [
    "pr", "create", "--draft", "--base", config.baseBranch, "--head", run.branch,
    "--title", run.issueTitle,
    "--body", `Closes #${run.issueNumber}\n\nImplemented by Claude Code and reviewed by Codex through the pair-programming orchestrator.`
  ], { cwd: run.worktree });
  const result = await runCommand("gh", ["pr", "view", run.branch, "--json", "number", "--jq", ".number"], { cwd: run.worktree, ...quiet });
  return Number(result.stdout.trim());
}

export async function markPrReady(run: Run): Promise<void> {
  const result = await runCommand("gh", ["pr", "view", String(run.prNumber), "--json", "isDraft", "--jq", ".isDraft"], { cwd: run.worktree, ...quiet });
  if (result.stdout.trim() === "true") {
    await runCommand("gh", ["pr", "ready", String(run.prNumber)], { cwd: run.worktree });
  }
}

export async function headSha(run: Run): Promise<string> {
  const result = await runCommand("git", ["rev-parse", "HEAD"], { cwd: run.worktree, ...quiet });
  return result.stdout.trim();
}

export async function prHeadSha(run: Run): Promise<string> {
  const result = await runCommand("gh", ["pr", "view", String(run.prNumber), "--json", "headRefOid", "--jq", ".headRefOid"], { cwd: run.worktree, ...quiet });
  return result.stdout.trim();
}

export type CheckResult = { state: "pending" | "passed" | "failed"; summary: string };

export async function prChecks(run: Run): Promise<CheckResult> {
  const result = await runCommand("gh", ["pr", "checks", String(run.prNumber), "--json", "name,state,bucket,link"], { cwd: run.worktree, quiet: true, allowNonZero: true });
  if (!result.stdout.trim()) {
    if (/no checks reported/i.test(result.stderr)) return { state: "passed", summary: "No required checks reported." };
    throw new Error(`Unable to read PR checks: ${result.stderr.trim() || `exit ${result.code}`}`);
  }
  const checks = JSON.parse(result.stdout) as Array<{ name: string; state: string; bucket: string; link: string }>;
  if (checks.length === 0) return { state: "passed", summary: "No required checks reported." };
  const summary = checks.map((check) => `${check.name}: ${check.bucket || check.state}${check.link ? ` (${check.link})` : ""}`).join("\n");
  if (checks.some((check) => ["fail", "cancel"].includes(check.bucket))) return { state: "failed", summary };
  if (checks.some((check) => check.bucket !== "pass" && check.bucket !== "skipping")) return { state: "pending", summary };
  return { state: "passed", summary };
}

export async function mergePr(config: Config, run: Run): Promise<void> {
  const pr = await runCommand("gh", ["pr", "view", String(run.prNumber), "--json", "state,headRefOid"], { cwd: run.worktree, ...quiet });
  const details = JSON.parse(pr.stdout) as { state: string; headRefOid: string };
  if (details.state === "MERGED") return;
  const local = await headSha(run);
  if (!run.reviewedSha || local !== run.reviewedSha || details.headRefOid !== run.reviewedSha) {
    throw new Error(`PR head changed after final review (reviewed ${run.reviewedSha ?? "none"}, local ${local}, remote ${details.headRefOid})`);
  }
  await runCommand("gh", ["pr", "merge", String(run.prNumber), "--rebase"], { cwd: run.worktree });
}

export async function fastForwardLocalMain(config: Config): Promise<void> {
  const branch = await runCommand("git", ["branch", "--show-current"], { cwd: config.repository, ...quiet });
  if (branch.stdout.trim() !== config.baseBranch) {
    throw new Error(`Target repository must be on ${config.baseBranch} to fast-forward it`);
  }
  const dirty = await runCommand("git", ["status", "--porcelain"], { cwd: config.repository, ...quiet });
  if (dirty.stdout.trim()) throw new Error("Target repository has uncommitted changes; refusing to update main");
  await runCommand("git", ["fetch", config.remote, config.baseBranch], { cwd: config.repository });
  await runCommand("git", ["merge", "--ff-only", `${config.remote}/${config.baseBranch}`], { cwd: config.repository });
}
