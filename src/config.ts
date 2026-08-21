import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, isAbsolute, resolve } from "node:path";
import type { Config } from "./types.ts";

export const configDirectory = ".agent-orchestrator";
export const configFileName = "config.json";

const defaults = {
  baseBranch: "main",
  remote: "origin",
  readyLabel: "agent-ready",
  claimedLabel: "agent-in-progress",
  completedLabel: "agent-completed",
  branchPrefix: "agents/issue-",
  stateDatabase: ".agent-orchestrator/state.sqlite",
  testCommand: "npm test",
  maxReviewCycles: 3,
  pollIntervalSeconds: 30,
  commandTimeoutMinutes: 45,
  claude: { model: null, allowedTools: "Read,Write,Edit,Bash" },
  codex: { model: null, reasoningEffort: "high" },
  logging: {
    maxFileBytes: 5_000_000,
    maxFilesPerStep: 3,
    retainRuns: 20,
    heartbeatSeconds: 15
  }
} as const;

export function findConfig(start = process.cwd()): string | null {
  let cursor = resolve(start);
  while (true) {
    const modern = resolve(cursor, configDirectory, configFileName);
    if (existsSync(modern)) return modern;
    const legacy = resolve(cursor, "orchestrator.config.json");
    if (existsSync(legacy)) return legacy;
    const parent = dirname(cursor);
    if (parent === cursor) return null;
    cursor = parent;
  }
}

export function loadConfig(path?: string): Config {
  const resolvedPath = path ? resolve(path) : findConfig();
  if (!resolvedPath) {
    throw new Error("No .agent-orchestrator/config.json found. Run `agent-orchestrator init` first.");
  }
  const raw = JSON.parse(readFileSync(resolvedPath, "utf8"));
  const configDir = dirname(resolvedPath);
  const inferredRepository = basename(configDir) === configDirectory ? dirname(configDir) : configDir;
  const repository = raw.repository
    ? (isAbsolute(raw.repository) ? raw.repository : resolve(configDir, raw.repository))
    : inferredRepository;
  const worktreeRoot = raw.worktreeRoot
    ? (isAbsolute(raw.worktreeRoot) ? raw.worktreeRoot : resolve(repository, raw.worktreeRoot))
    : resolve(dirname(repository), ".agent-orchestrator-worktrees", basename(repository));
  const config: Config = {
    ...defaults,
    ...raw,
    repository,
    worktreeRoot,
    claude: { ...defaults.claude, ...raw.claude },
    codex: { ...defaults.codex, ...raw.codex },
    logging: { ...defaults.logging, ...raw.logging }
  };
  if (!Number.isInteger(config.maxReviewCycles) || config.maxReviewCycles < 1) {
    throw new Error("maxReviewCycles must be a positive integer");
  }
  for (const key of ["maxFileBytes", "maxFilesPerStep", "retainRuns", "heartbeatSeconds"] as const) {
    const value = config.logging[key];
    if (!Number.isInteger(value) || value < 1) {
      throw new Error(`logging.${key} must be a positive integer`);
    }
  }
  if (!config.branchPrefix.match(/^[A-Za-z0-9._/-]+$/)) {
    throw new Error("branchPrefix contains unsupported characters");
  }
  return config;
}

export function projectPath(config: Config, value: string): string {
  return isAbsolute(value) ? value : resolve(config.repository, value);
}

export function runtimeDirectory(config: Config): string {
  return resolve(config.repository, configDirectory);
}
