import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ActivityTracker } from "../src/activity.ts";
import { invokeClaude } from "../src/agents.ts";
import { StateStore } from "../src/state-store.ts";
import type { Config, Run } from "../src/types.ts";

const events = [
  { type: "system", subtype: "init", session_id: "sess-live", model: "claude-opus-5" },
  { type: "assistant", message: { content: [{ type: "tool_use", name: "Bash", input: { command: "npm test" } }] } },
  { type: "result", subtype: "success", session_id: "sess-live", num_turns: 3, result: "implemented" }
];

/** Installs a fake `claude` on PATH that emits NDJSON and records its arguments. */
function fakeClaude(directory: string): { argsPath: string; path: string } {
  const binDir = join(directory, "bin");
  mkdirSync(binDir, { recursive: true });
  const argsPath = join(directory, "args.txt");
  const script = join(binDir, "claude");
  const lines = events.map((event) => JSON.stringify(event));
  writeFileSync(script, [
    "#!/bin/sh",
    `printf '%s\\n' "$@" > ${JSON.stringify(argsPath)}`,
    "cat > /dev/null",
    ...lines.map((line) => `printf '%s\\n' ${JSON.stringify(line)}`),
    ""
  ].join("\n"));
  chmodSync(script, 0o755);
  return { argsPath, path: binDir };
}

function fixture(): { store: StateStore; run: Run; config: Config; tracker: ActivityTracker; runtime: string } {
  const runtime = mkdtempSync(join(tmpdir(), "orchestrator-agents-"));
  const store = new StateStore(":memory:");
  const run = store.create(
    { number: 3, title: "Stream me", body: "criteria", url: "https://example.test/3" },
    "agents/issue-3", runtime
  );
  const config = {
    commandTimeoutMinutes: 1,
    pollIntervalSeconds: 30,
    claude: { model: null, allowedTools: "Read,Write,Edit,Bash" },
    logging: { maxFileBytes: 5_000_000, maxFilesPerStep: 3, retainRuns: 20, heartbeatSeconds: 1 }
  } as Config;
  return { store, run, config, runtime, tracker: new ActivityTracker(store, config, runtime, true) };
}

test("invokeClaude streams progress to the step log and returns the final result", async (t) => {
  const { store, run, config, tracker, runtime } = fixture();
  const fake = fakeClaude(runtime);
  const originalPath = process.env.PATH;
  process.env.PATH = `${fake.path}:${originalPath}`;
  t.after(() => { process.env.PATH = originalPath; store.close(); });

  const session = tracker.begin(run, "implementing");
  const outcome = await invokeClaude(config, run, "do the thing", false, session);
  session.end("done");

  assert.equal(outcome.sessionId, "sess-live");
  assert.equal(outcome.result?.result, "implemented");

  const args = readFileSync(fake.argsPath, "utf8").split("\n");
  assert.ok(args.includes("stream-json"), "claude must run in streaming mode");
  assert.ok(args.includes("--verbose"), "stream-json requires --verbose in print mode");
  assert.ok(!args.includes("--resume"), "a first pass must not resume a session");

  // Every intermediate event is visible in the log, not just the final result.
  const log = readFileSync(session.logPath, "utf8");
  assert.match(log, /claude started \(pid \d+\)/);
  assert.match(log, /session sess-live model=claude-opus-5/);
  assert.match(log, /tool Bash\(npm test\)/);
  assert.match(log, /result: success, 3 turns/);
  assert.equal(store.activity(run.id)?.pid, null);
});

test("invokeClaude resumes the recorded session when fixing", async (t) => {
  const { store, run, config, tracker, runtime } = fixture();
  const fake = fakeClaude(runtime);
  const originalPath = process.env.PATH;
  process.env.PATH = `${fake.path}:${originalPath}`;
  t.after(() => { process.env.PATH = originalPath; store.close(); });

  const resumed = { ...store.update(run.id, "fixing", { claudeSessionId: "earlier-session" }) };
  const session = tracker.begin(resumed, "fixing-1");
  await invokeClaude(config, resumed, "fix it", true, session);
  session.end("done");

  const args = readFileSync(fake.argsPath, "utf8").split("\n");
  assert.ok(args.includes("--resume"));
  assert.ok(args.includes("earlier-session"));
});
