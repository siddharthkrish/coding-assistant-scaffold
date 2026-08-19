import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { renderPrompt } from "../src/prompts.ts";
import type { Config } from "../src/types.ts";

test("repo-local prompt overrides are rendered", () => {
  const repository = mkdtempSync(join(tmpdir(), "agent-orchestrator-render-"));
  const promptDir = join(repository, ".agent-orchestrator", "prompts");
  mkdirSync(promptDir, { recursive: true });
  writeFileSync(join(promptDir, "implement.md"), "Issue {{number}}: {{title}}");
  const config = { repository } as Config;
  assert.equal(renderPrompt(config, "implement", { number: "8", title: "Ship" }, "fallback"), "Issue 8: Ship");
});
