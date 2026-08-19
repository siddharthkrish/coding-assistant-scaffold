import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import test from "node:test";
import { findConfig, loadConfig } from "../src/config.ts";

test("config applies safe defaults and resolves repository paths", () => {
  const dir = mkdtempSync(join(tmpdir(), "pair-orchestrator-"));
  const path = join(dir, "orchestrator.config.json");
  writeFileSync(path, JSON.stringify({ repository: "./repo" }));
  const config = loadConfig(path);
  assert.equal(config.repository, join(dir, "repo"));
  assert.equal(config.maxReviewCycles, 3);
  assert.equal(config.codex.reasoningEffort, "high");
});

test("config rejects an invalid review limit", () => {
  const dir = mkdtempSync(join(tmpdir(), "pair-orchestrator-"));
  const path = join(dir, "orchestrator.config.json");
  writeFileSync(path, JSON.stringify({ repository: "./repo", maxReviewCycles: 0 }));
  assert.throws(() => loadConfig(path), /positive integer/);
});

test("repo-local config is discovered from nested directories", () => {
  const dir = mkdtempSync(join(tmpdir(), "pair-orchestrator-"));
  const nested = join(dir, "src", "nested");
  const configDir = join(dir, ".agent-orchestrator");
  mkdirSync(nested, { recursive: true });
  mkdirSync(configDir, { recursive: true });
  const path = join(configDir, "config.json");
  writeFileSync(path, JSON.stringify({ testCommand: "npm test" }));
  assert.equal(findConfig(nested), path);
  const config = loadConfig(path);
  assert.equal(config.repository, dir);
  assert.equal(config.worktreeRoot, join(dirname(dir), ".agent-orchestrator-worktrees", basename(dir)));
});
