import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ActivityTracker, errorTailBytes } from "../src/activity.ts";
import { runCommand } from "../src/process.ts";
import { StateStore } from "../src/state-store.ts";
import { statusRows } from "../src/status.ts";
import type { Config, Run } from "../src/types.ts";

/** Returns the pid of a process that has definitely exited. */
async function exitedPid(): Promise<number> {
  let pid = 0;
  await runCommand("node", ["-e", ""], { quiet: true, onStart: (value) => { if (value) pid = value; } });
  assert.ok(pid > 0, "expected to observe a child pid");
  return pid;
}

function fixture(): { store: StateStore; run: Run; tracker: ActivityTracker; runtime: string } {
  const runtime = mkdtempSync(join(tmpdir(), "orchestrator-activity-"));
  const store = new StateStore(":memory:");
  const run = store.create(
    { number: 11, title: "Observe me", body: "criteria", url: "https://example.test/11" },
    "agents/issue-11", join(runtime, "worktree")
  );
  const config = {
    pollIntervalSeconds: 30,
    logging: { maxFileBytes: 5_000_000, maxFilesPerStep: 3, retainRuns: 20, heartbeatSeconds: 1 }
  } as Config;
  return { store, run, runtime, tracker: new ActivityTracker(store, config, runtime, true) };
}

test("a step records its sub-step, log path, and owner process", () => {
  const { store, run, tracker } = fixture();
  try {
    const session = tracker.begin(run, "implementing", "starting");
    const activity = store.activity(run.id);
    assert.equal(activity?.step, "implementing");
    assert.equal(activity?.logPath, session.logPath);
    assert.equal(activity?.ownerPid, process.pid);
    assert.equal(activity?.pid, null);
    session.end("done");
  } finally {
    store.close();
  }
});

test("progress lines land in the log and become the visible sub-step", () => {
  const { store, run, tracker } = fixture();
  try {
    const session = tracker.begin(run, "implementing");
    session.progress("claude tool Bash(npm test)");
    session.logger.flush();
    assert.match(readFileSync(session.logPath, "utf8"), /tool Bash\(npm test\)/);
    assert.equal(store.activity(run.id)?.detail, "claude tool Bash(npm test)");
    session.end("done");
  } finally {
    store.close();
  }
});

test("a tracked child process is attached, heartbeats, and is cleared on exit", async () => {
  const { store, run, tracker } = fixture();
  try {
    const session = tracker.begin(run, "implementing");
    const before = store.activity(run.id)!.lastActivityAt;
    let observedPid: number | null = null;
    const hooks = session.commandHooks("child");
    await runCommand("node", ["-e", "console.log('working'); setTimeout(() => console.log('done'), 1200)"], {
      ...hooks,
      onStart: (pid) => {
        hooks.onStart?.(pid);
        if (pid) observedPid = pid;
      }
    });
    assert.ok(observedPid, "expected the child pid to be observed");
    assert.equal(store.activity(run.id)?.pid, null, "pid must be cleared once the child exits");
    assert.ok(store.activity(run.id)!.lastActivityAt >= before, "heartbeat must advance");
    session.logger.flush();
    assert.match(readFileSync(session.logPath, "utf8"), /working/);
    session.end("done");
  } finally {
    store.close();
  }
});

test("credentials in progress text are redacted before every sink", (t) => {
  const { store, run, tracker } = fixture();
  const printed: string[] = [];
  t.mock.method(console, "log", (line: string) => { printed.push(line); });
  const loud = new ActivityTracker(
    store,
    { pollIntervalSeconds: 30, logging: { maxFileBytes: 5_000_000, maxFilesPerStep: 3, retainRuns: 20, heartbeatSeconds: 1 } } as Config,
    join(run.worktree, "..", "loud-runtime"),
    false
  );
  try {
    const session = loud.begin(run, "implementing");
    session.progress("claude tool Bash(curl -H 'Authorization: Bearer abcdef123456789' https://api.example.test)");
    session.logger.flush();

    const stored = store.activity(run.id)!.detail!;
    const logged = readFileSync(session.logPath, "utf8");
    const console_ = printed.join("\n");
    for (const sink of [stored, logged, console_]) {
      assert.doesNotMatch(sink, /abcdef123456789/, "no sink may retain the credential");
    }
    assert.match(stored, /\[redacted\]/);
    assert.match(logged, /curl -H/, "the surrounding command must stay legible");
    session.end("done");
  } finally {
    store.close();
  }
});

test("credentials in a failure message are redacted before every sink", () => {
  const { store, run, tracker } = fixture();
  try {
    const session = tracker.begin(run, "implementing");
    session.fail("sh exited with 1: fatal: could not read password: ghp_abcdefghijklmnopqrstuvwxyz0123");
    assert.doesNotMatch(store.activity(run.id)!.detail!, /ghp_abcdefghijklmnopqrstuvwxyz0123/);
    assert.doesNotMatch(readFileSync(session.logPath, "utf8"), /ghp_abcdefghijklmnopqrstuvwxyz0123/);
  } finally {
    store.close();
  }
});

test("streamed commands retain only an error tail in memory", async () => {
  const { store, run, tracker } = fixture();
  try {
    const session = tracker.begin(run, "implementing");
    const result = await runCommand(
      "node",
      ["-e", "for (let i = 0; i < 20000; i += 1) console.log('noisy output line ' + i)"],
      session.commandHooks("child")
    );
    // The child emits well over 300 KB; only the bounded tail is kept.
    assert.ok(result.stdout.length <= errorTailBytes, `retained ${result.stdout.length} characters`);
    assert.match(result.stdout, /noisy output line 19999/, "the tail must survive for error messages");
    session.logger.flush();
    // Nothing is lost: the full stream still reached the rotating log.
    const logged = readFileSync(session.logPath, "utf8");
    assert.match(logged, /noisy output line 19999/);
    session.end("done");
  } finally {
    store.close();
  }
});

test("track closes the step and rethrows when the body fails", async () => {
  const { store, run, tracker } = fixture();
  try {
    await assert.rejects(
      tracker.track(run, "implementing", async () => { throw new Error("claude exploded"); }),
      /claude exploded/
    );
    const activity = store.activity(run.id)!;
    assert.equal(activity.pid, null);
    assert.match(readFileSync(activity.logPath!, "utf8"), /FAILED: claude exploded/);
  } finally {
    store.close();
  }
});

test("status reports a live run and flags an orphaned one", async () => {
  const { store, run, tracker } = fixture();
  const deadPid = await exitedPid();
  try {
    const session = tracker.begin(run, "implementing", "working");
    store.update(run.id, "implementing");

    const live = statusRows(store, 60)[0];
    assert.equal(live.step, "implementing");
    assert.equal(live.liveness, "waiting");
    assert.equal(live.ownerPid, process.pid);
    assert.equal(live.logPath, session.logPath);
    assert.ok(live.elapsedSeconds !== null && live.idleSeconds !== null);

    // An orchestrator that died leaves an activity row owned by a dead pid.
    store.beginStep(run.id, "implementing", "working", session.logPath, deadPid);
    assert.equal(statusRows(store, 60)[0].liveness, "orphaned");

    // A live owner that has not reported progress recently is stale, not orphaned.
    store.beginStep(run.id, "implementing", "working", session.logPath, process.pid);
    assert.equal(statusRows(store, 60, Date.now() + 600_000)[0].liveness, "stale");

    store.update(run.id, "completed");
    assert.equal(statusRows(store, 60)[0].liveness, "done");
  } finally {
    store.close();
  }
});

test("a dead orchestrator is orphaned even while its child is still running", async () => {
  const { store, run, tracker } = fixture();
  const child = spawn("node", ["-e", "setTimeout(() => {}, 30000)"], { stdio: "ignore" });
  try {
    const session = tracker.begin(run, "implementing");
    store.update(run.id, "implementing");
    const deadOwner = await exitedPid();
    store.beginStep(run.id, "implementing", "working", session.logPath, deadOwner);
    store.attachProcess(run.id, child.pid!);

    const row = statusRows(store, 60)[0];
    // A surviving Claude or Codex child cannot advance the run on its own.
    assert.equal(row.liveness, "orphaned");
    assert.equal(row.childAlive, true, "the live child must still be reported");
    assert.equal(row.ownerAlive, false);
    assert.equal(row.pid, child.pid);
  } finally {
    child.kill("SIGKILL");
    store.close();
  }
});

test("a live orchestrator running a child reports as running", async () => {
  const { store, run, tracker } = fixture();
  const child = spawn("node", ["-e", "setTimeout(() => {}, 30000)"], { stdio: "ignore" });
  try {
    tracker.begin(run, "implementing");
    store.update(run.id, "implementing");
    store.attachProcess(run.id, child.pid!);
    const row = statusRows(store, 60)[0];
    assert.equal(row.liveness, "running");
    assert.equal(row.childAlive, true);
    assert.equal(row.ownerAlive, true);
  } finally {
    child.kill("SIGKILL");
    store.close();
  }
});

test("status redacts credentials recorded in a run error", () => {
  const { store, run } = fixture();
  try {
    store.update(run.id, "implementing", {
      lastError: "gh exited with 1: token=ghp_abcdefghijklmnopqrstuvwxyz0123"
    });
    assert.doesNotMatch(statusRows(store, 60)[0].error!, /ghp_abcdefghijklmnopqrstuvwxyz0123/);
  } finally {
    store.close();
  }
});

test("status falls back to run state before any step is recorded", () => {
  const { store, run } = fixture();
  try {
    const row = statusRows(store, 60)[0];
    assert.equal(row.issue, run.issueNumber);
    assert.equal(row.step, "claimed");
    assert.equal(row.liveness, "waiting");
    assert.equal(row.logPath, null);
  } finally {
    store.close();
  }
});
