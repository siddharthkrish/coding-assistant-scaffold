import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fastForwardLocalMain } from "../src/git-github.ts";
import { StepLogger, artifactPath, stepLogPath, writeArtifact } from "../src/logging.ts";
import type { Config } from "../src/types.ts";

const limits = { maxFileBytes: 5_000_000, maxFilesPerStep: 3 };

/** The `.gitignore` an installation initialized by 0.1.1 would already have. */
const legacyIgnore = [
  ".agent-orchestrator/*.sqlite*",
  ".agent-orchestrator/reviews/",
  ".agent-orchestrator/last-checks.txt",
  ""
].join("\n");

function legacyRepository(): string {
  const dir = mkdtempSync(join(tmpdir(), "orchestrator-legacy-"));
  execFileSync("git", ["init", "-q", "-b", "main", dir]);
  execFileSync("git", ["config", "user.email", "test@example.test"], { cwd: dir });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: dir });
  writeFileSync(join(dir, ".gitignore"), legacyIgnore);
  mkdirSync(join(dir, ".agent-orchestrator"), { recursive: true });
  writeFileSync(join(dir, ".agent-orchestrator", "config.json"), "{}\n");
  execFileSync("git", ["add", "-A"], { cwd: dir });
  execFileSync("git", ["commit", "-qm", "initial"], { cwd: dir });
  return dir;
}

function porcelain(dir: string): string {
  return execFileSync("git", ["status", "--porcelain"], { cwd: dir, encoding: "utf8" }).trim();
}

test("runtime logs and artifacts stay invisible to Git on a legacy installation", () => {
  const repository = legacyRepository();
  const runtime = join(repository, ".agent-orchestrator");
  assert.equal(porcelain(repository), "", "fixture must start clean");

  const logger = new StepLogger(stepLogPath(runtime, 1, "implementing"), limits);
  logger.note("claude tool Bash(npm test)");
  logger.close();
  writeArtifact(artifactPath(runtime, 1, "claude-implement.json"), { subtype: "success" });

  // Without a self-ignoring runtime directory these would be untracked files, and
  // the post-merge fast-forward below would refuse to run.
  assert.equal(porcelain(repository), "", "runtime output must not dirty the checkout");
});

test("a legacy installation can still fast-forward main after a run", async () => {
  const repository = legacyRepository();
  const runtime = join(repository, ".agent-orchestrator");
  const origin = mkdtempSync(join(tmpdir(), "orchestrator-origin-"));
  execFileSync("git", ["clone", "-q", "--bare", repository, origin]);
  execFileSync("git", ["remote", "add", "origin", origin], { cwd: repository });

  const logger = new StepLogger(stepLogPath(runtime, 2, "implementing"), limits);
  logger.write("streamed claude output\n");
  logger.close();
  writeArtifact(artifactPath(runtime, 2, "codex-review.json"), { verdict: "approved" });

  const config = { repository, baseBranch: "main", remote: "origin" } as Config;
  await fastForwardLocalMain(config);
  assert.equal(porcelain(repository), "");
});
