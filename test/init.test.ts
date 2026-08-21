import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ejectPrompts, initializeProject } from "../src/init.ts";

test("init scaffolds repo-local config, ignore rules, and package scripts", async () => {
  const dir = mkdtempSync(join(tmpdir(), "agent-orchestrator-init-"));
  execFileSync("git", ["init", "-b", "main", dir]);
  writeFileSync(join(dir, "package.json"), JSON.stringify({
    name: "fixture-project",
    scripts: { test: "node --test" }
  }));

  const result = await initializeProject({ directory: dir, install: false, labels: false });
  assert.equal(result.project.root, realpathSync(dir));
  assert.equal(result.project.testCommand, "npm test");
  assert.equal(result.installed, false);
  assert.equal(result.labelsCreated, null);
  assert.equal(result.packageJsonCreated, false);

  const config = JSON.parse(readFileSync(join(dir, ".agent-orchestrator", "config.json"), "utf8"));
  assert.equal(config.baseBranch, "main");
  assert.equal(config.testCommand, "npm test");

  const manifest = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
  assert.equal(manifest.scripts.agents, "agent-orchestrator start");
  assert.equal(manifest.scripts["agents:once"], "agent-orchestrator run");
  assert.equal(manifest.scripts["agents:doctor"], "agent-orchestrator doctor");
  assert.equal(manifest.scripts["agents:logs"], "agent-orchestrator logs");
  assert.equal(config.logging.retainRuns, 20);

  const ignored = readFileSync(join(dir, ".gitignore"), "utf8");
  assert.match(ignored, /\.agent-orchestrator\/\*\.sqlite\*/);
  // Streamed logs and agent artifacts must never be committed.
  assert.match(ignored, /\.agent-orchestrator\/logs\//);
  assert.match(ignored, /\.agent-orchestrator\/artifacts\//);
});

test("init can create an opt-in private tooling package", async () => {
  const dir = mkdtempSync(join(tmpdir(), "agent-orchestrator-init-"));
  execFileSync("git", ["init", "-b", "main", dir]);

  const result = await initializeProject({
    directory: dir,
    install: false,
    labels: false,
    createPackageJson: true
  });

  assert.equal(result.packageJsonCreated, true);
  assert.equal(result.project.hasPackageJson, true);
  assert.equal(result.project.testCommand, "auto");
  const manifest = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
  assert.equal(manifest.private, true);
  assert.match(manifest.name, /-tooling$/);
  assert.equal(manifest.scripts.agents, "agent-orchestrator start");
  const config = JSON.parse(readFileSync(join(dir, ".agent-orchestrator", "config.json"), "utf8"));
  assert.equal(config.testCommand, "auto");
});

test("eject-prompts creates editable prompt templates without overwriting", () => {
  const dir = mkdtempSync(join(tmpdir(), "agent-orchestrator-prompts-"));
  const first = ejectPrompts(dir);
  assert.equal(first.length, 4);
  writeFileSync(join(dir, ".agent-orchestrator", "prompts", "implement.md"), "custom");
  const second = ejectPrompts(dir);
  assert.equal(second.length, 0);
  assert.equal(readFileSync(join(dir, ".agent-orchestrator", "prompts", "implement.md"), "utf8"), "custom");
});
