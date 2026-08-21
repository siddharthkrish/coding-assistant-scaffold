import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import { ActivityTracker, type StepSession } from "./activity.ts";
import {
  ciFixPrompt, fixPrompt, implementationPrompt, invokeClaude, invokeCodexReview
} from "./agents.ts";
import { artifactPath, writeArtifact } from "./logging.ts";
import {
  claimIssue, commitAndPush, completeIssue, fastForwardLocalMain, headSha,
  markPrReady, mergePr, nextIssue, openDraftPr, prChecks, prepareWorktree, prHeadSha, runTests
} from "./git-github.ts";
import { needsFix } from "./policy.ts";
import type { StateStore } from "./state-store.ts";
import type { Config, Review, Run } from "./types.ts";

export class Orchestrator {
  readonly config: Config;
  readonly store: StateStore;
  readonly runtimeDir: string;
  readonly schemaPath: string;
  readonly tracker: ActivityTracker;

  constructor(
    config: Config,
    store: StateStore,
    runtimeDir: string,
    schemaPath: string,
    tracker?: ActivityTracker
  ) {
    this.config = config;
    this.store = store;
    this.runtimeDir = runtimeDir;
    this.schemaPath = schemaPath;
    this.tracker = tracker ?? new ActivityTracker(store, config, runtimeDir);
  }

  async run(explicitIssue?: number): Promise<Run | null> {
    let run = explicitIssue ? this.store.getByIssue(explicitIssue) : this.store.active()[0] ?? null;
    if (!run) {
      const issue = await nextIssue(this.config, explicitIssue);
      if (!issue) return null;
      const branch = `${this.config.branchPrefix}${issue.number}`;
      const worktree = resolve(this.config.worktreeRoot, `issue-${issue.number}`);
      run = this.store.create(issue, branch, worktree);
    }

    try {
      return await this.advance(run);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const latest = this.store.get(run.id) ?? run;
      this.store.update(latest.id, latest.status, { lastError: message }, `Paused after error: ${message}`);
      throw error;
    }
  }

  private async advance(initial: Run): Promise<Run> {
    let run = this.store.get(initial.id) ?? initial;
    while (!isTerminal(run)) {
      switch (run.status) {
        case "claimed": {
          const current = run;
          await this.tracker.track(run, "claiming", async (session) => {
            await claimIssue(this.config, {
              number: current.issueNumber, title: current.issueTitle,
              body: current.issueBody, url: current.issueUrl
            });
            if (!existsSync(current.worktree)) {
              session.progress(`preparing worktree ${current.worktree}`);
              await prepareWorktree(this.config, current);
            }
          });
          run = this.store.update(run.id, "implementing", { lastError: null });
          break;
        }
        case "implementing": {
          const current = run;
          const outcome = await this.tracker.track(current, "implementing", async (session) => {
            const claude = await invokeClaude(
              this.config, current, implementationPrompt(this.config, current), false, session
            );
            this.saveClaudeResult(current, "implement", claude.result, session);
            await runTests(this.config, current, session);
            await commitAndPush(this.config, current, `feat: resolve issue #${current.issueNumber}`);
            const prNumber = current.prNumber ?? await openDraftPr(this.config, current);
            return { prNumber, sessionId: claude.sessionId };
          });
          run = this.store.update(run.id, "reviewing", {
            prNumber: outcome.prNumber, claudeSessionId: outcome.sessionId, lastError: null
          });
          break;
        }
        case "reviewing":
        case "final_review": {
          const current = run;
          const finalReview = current.status === "final_review";
          const reviewPath = this.reviewPath(current);
          const step = finalReview ? `final-review-${current.reviewCycle}` : "review";
          const review = await this.tracker.track(current, step, async (session) => {
            const result = await invokeCodexReview(
              this.config, current, this.schemaPath, reviewPath, finalReview, session
            );
            writeArtifact(artifactPath(this.runtimeDir, current.issueNumber, `codex-${step}.json`), result);
            session.progress(`codex verdict: ${result.verdict} (${result.findings.length} findings)`);
            return result;
          });
          const sha = await headSha(run);
          if (needsFix(review)) {
            if (run.reviewCycle >= this.config.maxReviewCycles) {
              run = this.store.update(run.id, "human_review", { reviewedSha: sha }, "Review iteration limit reached");
              break;
            }
            run = this.store.update(run.id, "fixing", { reviewedSha: sha, lastError: null }, review.summary);
          } else {
            run = this.store.update(run.id, "waiting_ci", { reviewedSha: sha, lastError: null }, review.summary);
          }
          break;
        }
        case "fixing": {
          const current = run;
          const nextCycle = current.reviewCycle + 1;
          const sessionId = await this.tracker.track(current, `fixing-${nextCycle}`, async (session) => {
            const review = this.readReview(current);
            const claude = await invokeClaude(
              this.config, current, fixPrompt(this.config, current, review), true, session
            );
            this.saveClaudeResult(current, `fix-${nextCycle}`, claude.result, session);
            await runTests(this.config, current, session);
            const previousSha = current.reviewedSha;
            const fixedSha = await commitAndPush(
              this.config, current, `fix: address review for issue #${current.issueNumber} (cycle ${nextCycle})`
            );
            if (previousSha === fixedSha) throw new Error("Claude did not change the commit after requested fixes");
            return claude.sessionId;
          });
          run = this.store.update(run.id, "final_review", {
            reviewCycle: nextCycle, reviewedSha: null, claudeSessionId: sessionId, lastError: null
          });
          break;
        }
        case "waiting_ci": {
          const current = run;
          const outcome = await this.tracker.track(current, "waiting-ci", async (session) => {
            const currentSha = await headSha(current);
            const remoteSha = await prHeadSha(current);
            if (currentSha !== current.reviewedSha || remoteSha !== current.reviewedSha) {
              return { kind: "head_changed" as const };
            }
            const checks = await this.waitForChecks(current, session);
            if (checks.state !== "failed") {
              await markPrReady(current);
              return { kind: "passed" as const, summary: checks.summary };
            }
            if (current.reviewCycle >= this.config.maxReviewCycles) return { kind: "exhausted" as const };
            const claude = await invokeClaude(
              this.config, current, ciFixPrompt(this.config, current, checks.summary), true, session
            );
            const nextCycle = current.reviewCycle + 1;
            this.saveClaudeResult(current, `ci-fix-${nextCycle}`, claude.result, session);
            await runTests(this.config, current, session);
            const fixedSha = await commitAndPush(
              this.config, current, `fix: repair CI for issue #${current.issueNumber} (cycle ${nextCycle})`
            );
            if (fixedSha === current.reviewedSha) throw new Error("Claude did not change the commit after CI failure");
            return { kind: "ci_fixed" as const, nextCycle, sessionId: claude.sessionId };
          });
          if (outcome.kind === "head_changed") {
            run = this.store.update(run.id, "final_review", { reviewedSha: null }, "Head changed after review");
          } else if (outcome.kind === "exhausted") {
            run = this.store.update(run.id, "human_review", {}, "CI failed and iteration limit was reached");
          } else if (outcome.kind === "ci_fixed") {
            run = this.store.update(run.id, "final_review", {
              reviewCycle: outcome.nextCycle, reviewedSha: null, claudeSessionId: outcome.sessionId
            });
          } else {
            run = this.store.update(run.id, "merging", {}, outcome.summary);
          }
          break;
        }
        case "merging": {
          const current = run;
          await this.tracker.track(current, "merging", () => mergePr(this.config, current));
          run = this.store.update(run.id, "syncing_main");
          break;
        }
        case "syncing_main": {
          const current = run;
          await this.tracker.track(current, "syncing-main", async () => {
            await fastForwardLocalMain(this.config);
            await completeIssue(this.config, current.issueNumber);
          });
          run = this.store.update(run.id, "completed", { lastError: null });
          break;
        }
        default:
          throw new Error(`Cannot advance run ${run.id} from ${run.status}`);
      }
    }
    return run;
  }

  private reviewPath(run: Run): string {
    return resolve(this.runtimeDir, "reviews", `${basename(run.id)}.json`);
  }

  /** Keeps the final structured Claude result inspectable after the process exits. */
  private saveClaudeResult(
    run: Run,
    label: string,
    result: Record<string, unknown> | null,
    session: StepSession
  ): void {
    if (!result) {
      session.progress("claude produced no structured result event");
      return;
    }
    const path = writeArtifact(artifactPath(this.runtimeDir, run.issueNumber, `claude-${label}.json`), result);
    session.progress(`claude result saved to ${path}`);
  }

  private readReview(run: Run): Review {
    const path = this.reviewPath(run);
    if (!existsSync(path)) throw new Error(`Missing persisted review artifact: ${path}`);
    return JSON.parse(readFileSync(path, "utf8")) as Review;
  }

  private async waitForChecks(run: Run, session?: StepSession): Promise<Awaited<ReturnType<typeof prChecks>>> {
    const deadline = Date.now() + this.config.commandTimeoutMinutes * 60_000;
    while (true) {
      const result = await prChecks(run);
      writeFileSync(resolve(this.runtimeDir, "last-checks.txt"), result.summary);
      session?.progress(`checks ${result.state}`);
      if (result.state !== "pending") return result;
      if (Date.now() >= deadline) throw new Error("Timed out waiting for CI checks");
      await new Promise((resolvePromise) => setTimeout(resolvePromise, this.config.pollIntervalSeconds * 1000));
    }
  }
}

function isTerminal(run: Run): boolean {
  return ["completed", "human_review", "failed"].includes(run.status);
}
