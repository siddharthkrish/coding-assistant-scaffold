import assert from "node:assert/strict";
import test from "node:test";
import { ensureGitHubLabels } from "../src/labels.ts";

test("GitHub label provisioning creates only missing lifecycle labels", async () => {
  const calls: string[][] = [];
  const runner = async (_command: string, args: string[]) => {
    calls.push(args);
    if (args[1] === "list") {
      return {
        stdout: JSON.stringify([{ name: "Agent-Ready" }]),
        stderr: "",
        code: 0
      };
    }
    return { stdout: "", stderr: "", code: 0 };
  };

  const created = await ensureGitHubLabels("/repo", {
    readyLabel: "agent-ready",
    claimedLabel: "agent-in-progress",
    completedLabel: "agent-completed"
  }, runner);

  assert.deepEqual(created, ["agent-in-progress", "agent-completed"]);
  assert.equal(calls.length, 3);
  assert.deepEqual(calls[1], [
    "label", "create", "agent-in-progress",
    "--color", "FBCA04",
    "--description", "Agent orchestration in progress"
  ]);
  assert.deepEqual(calls[2], [
    "label", "create", "agent-completed",
    "--color", "1D76DB",
    "--description", "Completed by the agent orchestrator"
  ]);
});

test("GitHub label provisioning de-duplicates configured label names", async () => {
  const calls: string[][] = [];
  const runner = async (_command: string, args: string[]) => {
    calls.push(args);
    return { stdout: "[]", stderr: "", code: 0 };
  };

  const created = await ensureGitHubLabels("/repo", {
    readyLabel: "agent-work",
    claimedLabel: "agent-work",
    completedLabel: "agent-done"
  }, runner);

  assert.deepEqual(created, ["agent-work", "agent-done"]);
  assert.equal(calls.filter((args) => args[1] === "create").length, 2);
});
