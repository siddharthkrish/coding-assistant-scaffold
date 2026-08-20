#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { loadConfig, projectPath, runtimeDirectory } from "./config.ts";
import { doctor } from "./doctor.ts";
import { ejectPrompts, initializeProject } from "./init.ts";
import { Orchestrator } from "./orchestrator.ts";
import type { StateStore } from "./state-store.ts";

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
      labels: !hasFlag("--no-labels")
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
          printStatus(store);
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

function printStatus(store: StateStore): void {
  const runs = store.all();
  if (!runs.length) console.log("No orchestrator runs yet.");
  else console.table(runs.map((run) => ({
    issue: run.issueNumber,
    status: run.status,
    cycle: run.reviewCycle,
    pr: run.prNumber ?? "-",
    updated: run.updatedAt,
    error: run.lastError ?? ""
  })));
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
  agent-orchestrator init [--dir path] [--no-install] [--no-labels] [--force]
  agent-orchestrator doctor [--config path]
  agent-orchestrator run [--issue N] [--config path]
  agent-orchestrator start [--config path]
  agent-orchestrator resume [--issue N] [--config path]
  agent-orchestrator status [--config path]
  agent-orchestrator eject-prompts [--force] [--config path]

Run \`init\` inside a Git repository to create repo-local configuration.`);
}
