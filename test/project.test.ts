import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { detectTestCommand } from "../src/project.ts";

test("test command detection can resolve a project created after init", () => {
  const dir = mkdtempSync(join(tmpdir(), "agent-orchestrator-project-"));
  assert.equal(detectTestCommand(dir), null);

  writeFileSync(join(dir, "package.json"), JSON.stringify({
    scripts: { test: "node --test" }
  }));
  assert.equal(detectTestCommand(dir), "npm test");
});

test("test command detection ignores npm's placeholder test script", () => {
  const dir = mkdtempSync(join(tmpdir(), "agent-orchestrator-project-"));
  writeFileSync(join(dir, "package.json"), JSON.stringify({
    scripts: { test: "echo \"Error: no test specified\" && exit 1" }
  }));
  assert.equal(detectTestCommand(dir), null);
});
