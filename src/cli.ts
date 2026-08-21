#!/usr/bin/env node
import { createReadStream, existsSync, readFileSync, statSync } from "node:fs";
import { basename, resolve } from "node:path";
import { loadConfig, projectPath, runtimeDirectory } from "./config.ts";
import { doctor } from "./doctor.ts";
import { ejectPrompts, initializeProject } from "./init.ts";
import { listLogFiles, tailFile } from "./logging.ts";
import { Orchestrator } from "./orchestrator.ts";
import type { StateStore } from "./state-store.ts";
import { formatDuration, statusRows } from "./status.ts";
import type { Config } from "./types.ts";

const args = process.argv.slice(2);
const command = args[0]?.startsWith("-") ? "help" : (args[0] ?? "help");
const configFlag = valueOf("--config");
const packageManifest = JSON.parse(readFileSync(resolve(import.meta.dirname, "../package.json"), "utf8"));

try {
  if (command === "version" || hasFlag("--version") || hasFlag("-V")) {
    console.log(packageManifest.version);
  } else if (command === "help" || hasFlag("--help") || hasFlag("-h")) {
    usage();
  } else if (command === "init") {
    const result = await initializeProject({
      directory: valueOf("--dir"),
      force: hasFlag("--force"),
      install: !hasFlag("--no-install"),
      labels: !hasFlag("--no-labels"),
      createPackageJson: hasFlag("--create-package-json")
    });
    console.log(`Initialized agent orchestration in ${result.project.root}`);
    console.log(`Configuration: ${result.configPath}`);
    if (result.labelsCreated) {
      console.log(result.labelsCreated.length
        ? `Created GitHub labels: ${result.labelsCreated.join(", ")}.`
        : "GitHub lifecycle labels already exist.");
    } else {
      console.log("GitHub label provisioning was skipped.");
    }
    if (result.packageJsonCreated) console.log("Created a private tooling package.json.");
    if (result.project.hasPackageJson) {
      console.log(result.installed
        ? `Installed ${packageManifest.name}@${packageManifest.version} and added package scripts.`
        : "Added repository scripts; package installation was skipped.");
      console.log("Run the `agents:doctor` script, then use `agents:once` for one issue or `agents` for the queue.");
    } else {
      console.log(`Run \`npx ${packageManifest.name}@${packageManifest.version} doctor\`, then use \`run\` or \`start\`.`);
    }
    console.log(`Use \`npx ${packageManifest.name}@${packageManifest.version} eject-prompts\` to customize agent instructions.`);
  } else {
    const config = loadConfig(configFlag);
    if (command === "doctor") {
      process.exitCode = (await doctor(config)) ? 0 : 1;
    } else if (command === "eject-prompts") {
      const written = ejectPrompts(config.repository, hasFlag("--force"));
      if (!written.length) console.log("Prompts already exist; use --force to replace them.");
      else console.log(`Wrote ${written.length} editable prompts to .agent-orchestrator/prompts/.`);
    } else {
      const { StateStore } = await import("./state-store.ts");
      const store = new StateStore(projectPath(config, config.stateDatabase));
      try {
        if (command === "status") {
          printStatus(store, config, hasFlag("--json"));
        } else if (command === "logs") {
          await printLogs(store, config);
        } else if (["run", "resume", "start"].includes(command)) {
          const issue = issueArgument();
          const orchestrator = new Orchestrator(
            config,
            store,
            runtimeDirectory(config),
            resolve(import.meta.dirname, "../schemas/review.schema.json")
          );
          if (command === "start") await startQueue(orchestrator, config.pollIntervalSeconds);
          else {
            const result = await orchestrator.run(issue);
            if (!result) console.log(`No open issue with label ${config.readyLabel}.`);
            else console.log(`Issue #${result.issueNumber}: ${result.status}`);
          }
        } else {
          usage();
          process.exitCode = 2;
        }
      } finally {
        store.close();
      }
    }
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}

async function startQueue(orchestrator: Orchestrator, intervalSeconds: number): Promise<void> {
  let stopping = false;
  let wake = () => {};
  const stop = () => { stopping = true; wake(); };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  console.log("Watching the issue queue. Press Ctrl+C to stop after the current operation.");
  while (!stopping) {
    const result = await orchestrator.run();
    if (result) console.log(`Issue #${result.issueNumber}: ${result.status}`);
    if (!stopping) {
      await new Promise<void>((resolvePromise) => {
        const timer = setTimeout(resolvePromise, intervalSeconds * 1000);
        wake = () => { clearTimeout(timer); resolvePromise(); };
      });
      wake = () => {};
    }
  }
}

function printStatus(store: StateStore, config: Config, asJson: boolean): void {
  const rows = statusRows(store, staleAfterSeconds(config));
  if (asJson) {
    console.log(JSON.stringify(rows, null, 2));
    return;
  }
  if (!rows.length) {
    console.log("No orchestrator runs yet.");
    return;
  }
  console.table(rows.map((row) => ({
    issue: row.issue,
    status: row.status,
    step: row.step,
    live: row.liveness,
    cycle: row.cycle,
    pr: row.pr ?? "-",
    pid: row.pid ?? "-",
    elapsed: formatDuration(row.elapsedSeconds),
    idle: formatDuration(row.idleSeconds),
    error: row.error ?? ""
  })));
  for (const row of rows) {
    if (row.liveness === "done" && !row.error) continue;
    console.log(`\nIssue #${row.issue} (${row.status} / ${row.step}, ${row.liveness})`);
    if (row.detail) console.log(`  doing:    ${row.detail}`);
    if (row.session) console.log(`  session:  ${row.session}`);
    if (row.ownerPid) console.log(`  owner:    pid ${row.ownerPid}`);
    if (row.lastActivityAt) console.log(`  activity: ${row.lastActivityAt}`);
    if (row.logPath) console.log(`  log:      ${row.logPath}`);
    if (row.liveness === "orphaned") {
      console.log("  The orchestrator process for this run is gone. Re-run `resume --issue N` to continue it.");
    }
    if (row.liveness === "stale") {
      console.log("  No progress recorded recently; inspect the log above to see where it is waiting.");
    }
  }
  console.log(`\nFollow live output with \`agent-orchestrator logs --issue N --follow\`.`);
}

async function printLogs(store: StateStore, config: Config): Promise<void> {
  const runtimeDir = runtimeDirectory(config);
  const issue = issueArgument() ?? store.active()[0]?.issueNumber ?? store.all()[0]?.issueNumber;
  if (issue === undefined) throw new Error("No orchestrator runs yet.");
  const step = valueOf("--step");
  const files = listLogFiles(runtimeDir, issue);
  if (!files.length) throw new Error(`No logs recorded yet for issue #${issue}.`);
  const target = step
    ? files.find((path) => basename(path).startsWith(step))
    : preferredLog(store, runtimeDir, issue) ?? files[0];
  if (!target) throw new Error(`No log for step ${step} on issue #${issue}. Available: ${files.map((path) => basename(path)).join(", ")}`);
  const lines = Number(valueOf("--lines") ?? 200);
  console.log(`# ${target}`);
  const tail = tailFile(target, Number.isFinite(lines) ? lines : 200);
  if (tail) console.log(tail);
  if (!hasFlag("--follow")) return;
  await followFile(target);
}

/** Streams appended lines until interrupted. */
async function followFile(path: string): Promise<void> {
  let offset = statSync(path).size;
  await new Promise<void>((resolvePromise) => {
    const stop = () => { clearInterval(timer); resolvePromise(); };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
    const timer = setInterval(() => {
      let size: number;
      try {
        size = statSync(path).size;
      } catch {
        return;
      }
      if (size < offset) offset = 0;
      if (size === offset) return;
      const stream = createReadStream(path, { start: offset, end: size - 1, encoding: "utf8" });
      offset = size;
      stream.on("data", (chunk) => process.stdout.write(chunk));
    }, 500);
  });
}

function preferredLog(store: StateStore, runtimeDir: string, issue: number): string | null {
  const run = store.getByIssue(issue);
  const path = run ? store.activity(run.id)?.logPath ?? null : null;
  return path && existsSync(path) ? path : null;
}

function staleAfterSeconds(config: Config): number {
  return Math.max(config.logging.heartbeatSeconds * 4, config.pollIntervalSeconds * 2);
}

function issueArgument(): number | undefined {
  const raw = valueOf("--issue");
  if (!raw) return undefined;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) throw new Error("--issue must be a positive integer");
  return value;
}

function valueOf(flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
}

function hasFlag(flag: string): boolean {
  return args.includes(flag);
}

function usage(): void {
  console.log(`agent-orchestrator ${packageManifest.version}

Usage:
  agent-orchestrator init [--dir path] [--create-package-json] [--no-install] [--no-labels] [--force]
  agent-orchestrator doctor [--config path]
  agent-orchestrator run [--issue N] [--config path]
  agent-orchestrator start [--config path]
  agent-orchestrator resume [--issue N] [--config path]
  agent-orchestrator status [--json] [--config path]
  agent-orchestrator logs [--issue N] [--step name] [--lines N] [--follow] [--config path]
  agent-orchestrator eject-prompts [--force] [--config path]

Run \`init\` inside a Git repository to create repo-local configuration.`);
}
