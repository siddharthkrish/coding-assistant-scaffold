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

  const result = await initializeProject({ directory: dir, install: false });
  assert.equal(result.project.root, realpathSync(dir));
  assert.equal(result.project.testCommand, "npm test");
  assert.equal(result.installed, false);

  const config = JSON.parse(readFileSync(join(dir, ".agent-orchestrator", "config.json"), "utf8"));
  assert.equal(config.baseBranch, "main");
  assert.equal(config.testCommand, "npm test");

  const manifest = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
  assert.equal(manifest.scripts.agents, "agent-orchestrator start");
  assert.equal(manifest.scripts["agents:once"], "agent-orchestrator run");
  assert.equal(manifest.scripts["agents:doctor"], "agent-orchestrator doctor");
  assert.match(readFileSync(join(dir, ".gitignore"), "utf8"), /\.agent-orchestrator\/\*\.sqlite\*/);
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
