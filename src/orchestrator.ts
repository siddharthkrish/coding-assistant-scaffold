import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import {
  ciFixPrompt, fixPrompt, implementationPrompt, invokeClaude, invokeCodexReview
} from "./agents.ts";
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

  constructor(
    config: Config,
    store: StateStore,
    runtimeDir: string,
    schemaPath: string
  ) {
    this.config = config;
    this.store = store;
    this.runtimeDir = runtimeDir;
    this.schemaPath = schemaPath;
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
          await claimIssue(this.config, {
            number: run.issueNumber, title: run.issueTitle, body: run.issueBody, url: run.issueUrl
          });
          if (!existsSync(run.worktree)) await prepareWorktree(this.config, run);
          run = this.store.update(run.id, "implementing", { lastError: null });
          break;
        }
        case "implementing": {
          const sessionId = await invokeClaude(this.config, run, implementationPrompt(this.config, run));
          await runTests(this.config, run);
          await commitAndPush(this.config, run, `feat: resolve issue #${run.issueNumber}`);
          const prNumber = run.prNumber ?? await openDraftPr(this.config, run);
          run = this.store.update(run.id, "reviewing", { prNumber, claudeSessionId: sessionId, lastError: null });
          break;
        }
        case "reviewing":
        case "final_review": {
          const finalReview = run.status === "final_review";
          const reviewPath = this.reviewPath(run);
          const review = await invokeCodexReview(this.config, run, this.schemaPath, reviewPath, finalReview);
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
          const review = this.readReview(run);
          const sessionId = await invokeClaude(this.config, run, fixPrompt(this.config, run, review), true);
          await runTests(this.config, run);
          const nextCycle = run.reviewCycle + 1;
          const previousSha = run.reviewedSha;
          const fixedSha = await commitAndPush(this.config, run, `fix: address review for issue #${run.issueNumber} (cycle ${nextCycle})`);
          if (previousSha === fixedSha) throw new Error("Claude did not change the commit after requested fixes");
          run = this.store.update(run.id, "final_review", {
            reviewCycle: nextCycle, reviewedSha: null, claudeSessionId: sessionId, lastError: null
          });
          break;
        }
        case "waiting_ci": {
          const currentSha = await headSha(run);
          const remoteSha = await prHeadSha(run);
          if (currentSha !== run.reviewedSha || remoteSha !== run.reviewedSha) {
            run = this.store.update(run.id, "final_review", { reviewedSha: null }, "Head changed after review");
            break;
          }
          const checks = await this.waitForChecks(run);
          if (checks.state === "failed") {
            if (run.reviewCycle >= this.config.maxReviewCycles) {
              run = this.store.update(run.id, "human_review", {}, "CI failed and iteration limit was reached");
              break;
            }
            const sessionId = await invokeClaude(this.config, run, ciFixPrompt(this.config, run, checks.summary), true);
            await runTests(this.config, run);
            const nextCycle = run.reviewCycle + 1;
            const fixedSha = await commitAndPush(this.config, run, `fix: repair CI for issue #${run.issueNumber} (cycle ${nextCycle})`);
            if (fixedSha === run.reviewedSha) throw new Error("Claude did not change the commit after CI failure");
            run = this.store.update(run.id, "final_review", {
              reviewCycle: nextCycle, reviewedSha: null, claudeSessionId: sessionId
            });
            break;
          }
          await markPrReady(run);
          run = this.store.update(run.id, "merging", {}, checks.summary);
          break;
        }
        case "merging": {
          await mergePr(this.config, run);
          run = this.store.update(run.id, "syncing_main");
          break;
        }
        case "syncing_main": {
          await fastForwardLocalMain(this.config);
          await completeIssue(this.config, run.issueNumber);
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

  private readReview(run: Run): Review {
    const path = this.reviewPath(run);
    if (!existsSync(path)) throw new Error(`Missing persisted review artifact: ${path}`);
    return JSON.parse(readFileSync(path, "utf8")) as Review;
  }

  private async waitForChecks(run: Run): Promise<Awaited<ReturnType<typeof prChecks>>> {
    const deadline = Date.now() + this.config.commandTimeoutMinutes * 60_000;
    while (true) {
      const result = await prChecks(run);
      writeFileSync(resolve(this.runtimeDir, "last-checks.txt"), result.summary);
      if (result.state !== "pending") return result;
      if (Date.now() >= deadline) throw new Error("Timed out waiting for CI checks");
      await new Promise((resolvePromise) => setTimeout(resolvePromise, this.config.pollIntervalSeconds * 1000));
    }
  }
}

function isTerminal(run: Run): boolean {
  return ["completed", "human_review", "failed"].includes(run.status);
}
