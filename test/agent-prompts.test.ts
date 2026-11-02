import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ciFixPrompt, fixPrompt, implementationPrompt } from "../src/agents.ts";
import type { Config, Review, Run } from "../src/types.ts";

const config = { repository: mkdtempSync(join(tmpdir(), "agent-prompts-")), testCommand: "npm test" } as Config;
const run = {
  issueNumber: 7, issueTitle: "Add thing", issueBody: "body", prNumber: 42, branch: "agents/issue-7"
} as Run;
const review: Review = { verdict: "changes_requested", summary: "s", findings: [] };

test("every Claude prompt names the PR and its branch", () => {
  for (const prompt of [
    implementationPrompt(config, run),
    fixPrompt(config, run, review),
    ciFixPrompt(config, run, "lint: fail")
  ]) {
    assert.match(prompt, /pull request #42/);
    assert.match(prompt, /agents\/issue-7/);
    assert.doesNotMatch(prompt, /\{\{/);
  }
});
