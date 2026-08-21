import {
  appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync,
  rmSync, statSync, writeFileSync
} from "node:fs";
import { resolve } from "node:path";
import type { LoggingConfig } from "./types.ts";

export const logsDirectory = "logs";
export const artifactsDirectory = "artifacts";

const secretPatterns: Array<[RegExp, string]> = [
  [/-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----[\s\S]*?-----END (?:[A-Z ]+ )?PRIVATE KEY-----/g, "[redacted private key]"],
  [/gh[pousr]_[A-Za-z0-9]{16,}/g, "[redacted github token]"],
  [/sk-ant-[A-Za-z0-9_-]{8,}/g, "[redacted anthropic key]"],
  [/sk-[A-Za-z0-9]{20,}/g, "[redacted api key]"],
  [/xox[baprs]-[A-Za-z0-9-]{10,}/g, "[redacted slack token]"],
  [/AKIA[0-9A-Z]{16}/g, "[redacted aws key id]"],
  [/eyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, "[redacted jwt]"]
];

const assignmentPattern =
  /\b(authorization|api[-_]?keys?|access[-_]?tokens?|tokens?|secrets?|passwords?|passwd|credentials?)\b(\s*(?:[:=]|=>)\s*|\s+)(?:Bearer\s+)?["']?([^\s"',;]{6,})/gi;

/** Strips credential-shaped substrings so persisted logs never carry secrets. */
export function redact(text: string): string {
  let output = text;
  for (const [pattern, replacement] of secretPatterns) {
    output = output.replace(pattern, replacement);
  }
  return output.replace(assignmentPattern, (match, key, separator) => {
    if (/^(?:null|true|false|undefined|none)$/i.test(match.split(separator).pop() ?? "")) return match;
    return `${key}${separator}[redacted]`;
  });
}

/**
 * Append-only log file for one orchestrator step. Writes whole lines so a secret
 * can never be split across two redaction passes, and rotates so continuous queue
 * mode cannot grow storage without bound.
 */
export class StepLogger {
  readonly path: string;
  readonly maxBytes: number;
  readonly maxFiles: number;
  #pending = "";
  #bytes = 0;
  #closed = false;

  constructor(path: string, limits: Pick<LoggingConfig, "maxFileBytes" | "maxFilesPerStep">) {
    this.path = path;
    this.maxBytes = Math.max(1024, limits.maxFileBytes);
    this.maxFiles = Math.max(1, limits.maxFilesPerStep);
    mkdirSync(resolve(path, ".."), { recursive: true });
    if (!existsSync(path)) writeFileSync(path, "");
    this.#bytes = statSync(path).size;
  }

  /** Buffers `chunk` and flushes every complete line. */
  write(chunk: string): void {
    if (this.#closed) return;
    this.#pending += chunk;
    let index = this.#pending.indexOf("\n");
    while (index >= 0) {
      this.#emit(this.#pending.slice(0, index));
      this.#pending = this.#pending.slice(index + 1);
      index = this.#pending.indexOf("\n");
    }
    if (this.#pending.length > this.maxBytes) {
      this.#emit(this.#pending);
      this.#pending = "";
    }
  }

  /** Writes a timestamped one-line note. */
  note(text: string): void {
    this.flush();
    this.#emit(`[${new Date().toISOString()}] ${text}`);
  }

  flush(): void {
    if (this.#closed || !this.#pending) return;
    this.#emit(this.#pending);
    this.#pending = "";
  }

  close(): void {
    this.flush();
    this.#closed = true;
  }

  #emit(line: string): void {
    const text = `${redact(line)}\n`;
    const size = Buffer.byteLength(text);
    if (this.#bytes + size > this.maxBytes) this.#rotate();
    appendFileSync(this.path, text);
    this.#bytes += size;
  }

  #rotate(): void {
    const oldest = `${this.path}.${this.maxFiles}`;
    if (existsSync(oldest)) rmSync(oldest, { force: true });
    for (let index = this.maxFiles - 1; index >= 1; index -= 1) {
      const source = `${this.path}.${index}`;
      if (existsSync(source)) renameSync(source, `${this.path}.${index + 1}`);
    }
    if (this.maxFiles >= 1) renameSync(this.path, `${this.path}.1`);
    writeFileSync(this.path, "");
    this.#bytes = 0;
  }
}

export function runLogDirectory(runtimeDir: string, issueNumber: number): string {
  return resolve(runtimeDir, logsDirectory, `issue-${issueNumber}`);
}

export function stepLogPath(runtimeDir: string, issueNumber: number, step: string): string {
  return resolve(runLogDirectory(runtimeDir, issueNumber), `${slug(step)}.log`);
}

export function artifactPath(runtimeDir: string, issueNumber: number, name: string): string {
  return resolve(runtimeDir, artifactsDirectory, `issue-${issueNumber}`, slug(name));
}

/** Persists a structured artifact (Claude result, Codex review) for later inspection. */
export function writeArtifact(path: string, value: unknown): string {
  mkdirSync(resolve(path, ".."), { recursive: true });
  const text = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  writeFileSync(path, redact(text));
  return path;
}

/**
 * Drops the oldest per-issue log and artifact directories beyond the retention
 * limit, so continuous queue mode cannot accumulate history without bound.
 */
export function pruneRunHistory(runtimeDir: string, retainRuns: number): string[] {
  return [logsDirectory, artifactsDirectory].flatMap(
    (directory) => pruneDirectory(resolve(runtimeDir, directory), retainRuns)
  );
}

function pruneDirectory(root: string, retainRuns: number): string[] {
  if (!existsSync(root) || retainRuns < 1) return [];
  const entries = readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => {
      const path = resolve(root, entry.name);
      return { path, modified: statSync(path).mtimeMs };
    })
    .sort((left, right) => right.modified - left.modified);
  const removed = entries.slice(retainRuns);
  for (const entry of removed) rmSync(entry.path, { recursive: true, force: true });
  return removed.map((entry) => entry.path);
}

/** Returns the trailing `lines` lines of a log file, or null when it does not exist. */
export function tailFile(path: string, lines: number): string | null {
  if (!existsSync(path)) return null;
  const content = readFileSync(path, "utf8");
  if (lines <= 0) return content;
  const all = content.split("\n");
  if (all.at(-1) === "") all.pop();
  return all.slice(-lines).join("\n");
}

/** Lists the readable log files for an issue, newest activity first. */
export function listLogFiles(runtimeDir: string, issueNumber: number): string[] {
  const directory = runLogDirectory(runtimeDir, issueNumber);
  if (!existsSync(directory)) return [];
  return readdirSync(directory)
    .filter((name) => name.includes(".log"))
    .map((name) => resolve(directory, name))
    .sort((left, right) => statSync(right).mtimeMs - statSync(left).mtimeMs);
}

function slug(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "step";
}
