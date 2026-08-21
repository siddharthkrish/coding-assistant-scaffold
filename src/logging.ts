import {
  appendFileSync, closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync,
  readSync, renameSync, rmSync, statSync, writeFileSync
} from "node:fs";
import { resolve } from "node:path";
import type { LoggingConfig } from "./types.ts";

export const logsDirectory = "logs";
export const artifactsDirectory = "artifacts";

/**
 * Creates a runtime directory that Git ignores entirely, including the marker
 * itself. Repositories initialized by an earlier version have a `.gitignore`
 * without rules for these paths; relying on the project `.gitignore` alone would
 * leave streamed logs untracked in the checkout, which both exposes agent output
 * and makes `fastForwardLocalMain` refuse to sync a dirty repository after a merge.
 */
export function ensureIgnoredDirectory(path: string): string {
  mkdirSync(path, { recursive: true });
  const marker = resolve(path, ".gitignore");
  if (!existsSync(marker)) writeFileSync(marker, "*\n");
  return path;
}

const secretPatterns: Array<[RegExp, string]> = [
  [/-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----[\s\S]*?-----END (?:[A-Z ]+ )?PRIVATE KEY-----/g, "[redacted private key]"],
  [/gh[pousr]_[A-Za-z0-9]{16,}/g, "[redacted github token]"],
  [/sk-ant-[A-Za-z0-9_-]{8,}/g, "[redacted anthropic key]"],
  [/sk-[A-Za-z0-9]{20,}/g, "[redacted api key]"],
  [/xox[baprs]-[A-Za-z0-9-]{10,}/g, "[redacted slack token]"],
  [/AKIA[0-9A-Z]{16}/g, "[redacted aws key id]"],
  [/eyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, "[redacted jwt]"]
];

const credentialKeys =
  "authorization|api[-_]?keys?|access[-_]?tokens?|auth[-_]?tokens?|tokens?|secrets?|passwords?|passwd|passphrase|credentials?";

/** Authorization schemes whose scheme name must be kept while the value is dropped. */
const authSchemes = "Bearer|Basic|Digest|Token|ApiKey|JWT|OAuth";

/**
 * Matches `key = value`, `key: value`, and the quoted `"key": "value"` form used by
 * JSON. The closing quote is left outside the match so replacing only the value
 * keeps structured records parseable.
 *
 * A credential term is recognised anywhere inside an identifier rather than only at
 * a `\b` boundary: `_` is a word character, so `\b` never matches inside names like
 * `GITHUB_TOKEN` or `AWS_SECRET_ACCESS_KEY`. The leading separator is captured so it
 * can be preserved in the replacement.
 */
const assignmentPattern = new RegExp(
  `((?:^|[^A-Za-z0-9])[A-Za-z0-9_-]{0,64}?(?:${credentialKeys})[A-Za-z0-9_-]{0,64}` +
  `["']?\\s*(?:[:=]|=>)\\s*["']?(?:(?:${authSchemes})\\s+)?)([^\\s"',;}\\])]{6,})`,
  "gim"
);

/**
 * Values that must be left alone. Booleans, null, and numbers are unquoted in JSON,
 * so replacing them with a bare `[redacted]` would produce unparseable output — and
 * a six-digit token *count* is not a secret. An already-redacted value arrives here
 * as `[redacted` because the value group stops before `]`; matching on that prefix
 * keeps redact() idempotent instead of appending a bracket on every pass.
 */
const placeholders = /^(?:null|true|false|undefined|none|-?\d+(?:\.\d+)?|\[redacted.*)$/i;

export const privateKeyStart = /-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----/;
export const privateKeyEnd = /-----END (?:[A-Z ]+ )?PRIVATE KEY-----/;

/** A base64 body line: no spaces and long, which ordinary log lines are not. */
const privateKeyBody = /^[A-Za-z0-9+/=]{16,}$/;

/** Upper bound on suppressed lines; a 4096-bit key body is well under this. */
const maxPrivateKeyLines = 128;

/**
 * Strips credential-shaped substrings so persisted output never carries secrets.
 * Safe on structured records: only the value side of an assignment is replaced, so
 * redacted JSON stays valid JSON.
 */
export function redact(text: string): string {
  let output = text;
  for (const [pattern, replacement] of secretPatterns) {
    output = output.replace(pattern, replacement);
  }
  return output.replace(assignmentPattern, (match, prefix: string, value: string) =>
    placeholders.test(value) ? match : `${prefix}[redacted]`);
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
  #inPrivateKey = false;
  #privateKeyLines = 0;

  constructor(path: string, limits: Pick<LoggingConfig, "maxFileBytes" | "maxFilesPerStep">) {
    this.path = path;
    this.maxBytes = Math.max(1024, limits.maxFileBytes);
    this.maxFiles = Math.max(1, limits.maxFilesPerStep);
    ensureIgnoredDirectory(resolve(path, ".."));
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

  /**
   * Redacts and appends one line. A PEM block spans many lines, so the single-line
   * redaction pass can never see it whole; the block is suppressed with a state
   * machine instead and replaced by one placeholder.
   *
   * Suppression always terminates. Truncated output can carry a header with no
   * footer, and staying in suppression mode for the rest of the step would silently
   * swallow all later progress — the log would look stuck while the agent worked on.
   * It therefore ends at the footer, at the first line that is not key material, or
   * at a line budget, whichever comes first, and never emits the body itself.
   */
  #emit(line: string): void {
    if (this.#inPrivateKey) {
      if (privateKeyEnd.test(line)) {
        this.#inPrivateKey = false;
        return;
      }
      this.#privateKeyLines += 1;
      if (privateKeyBody.test(line) && this.#privateKeyLines <= maxPrivateKeyLines) return;
      this.#inPrivateKey = false;
      this.#append("[unterminated private key block; resuming output]");
      // Fall through so this line, which is not key material, is still recorded.
    }
    if (privateKeyStart.test(line) && !privateKeyEnd.test(line)) {
      this.#inPrivateKey = true;
      this.#privateKeyLines = 0;
      this.#append("[redacted private key]");
      return;
    }
    this.#append(redact(line));
  }

  #append(line: string): void {
    const text = `${line}\n`;
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
  ensureIgnoredDirectory(resolve(path, ".."));
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

type FileIdentity = { dev: number; ino: number; size: number };

function identify(path: string): FileIdentity | null {
  try {
    const stats = statSync(path);
    return { dev: stats.dev, ino: stats.ino, size: stats.size };
  } catch {
    return null;
  }
}

function sameFile(left: FileIdentity, right: FileIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

/** Reads a byte range without loading the whole file. */
function readRange(path: string, start: number, end: number): string {
  if (end <= start) return "";
  const buffer = Buffer.alloc(end - start);
  const handle = openSync(path, "r");
  try {
    const read = readSync(handle, buffer, 0, buffer.length, start);
    return buffer.subarray(0, read).toString("utf8");
  } finally {
    closeSync(handle);
  }
}

/**
 * Incremental reader for a rotating log.
 *
 * Rotation is detected by file identity rather than by size. Comparing sizes alone
 * misses a rotation whose replacement file has already grown past the previous
 * offset, which would silently skip the beginning of the new file.
 */
export class LogFollower {
  readonly path: string;
  #identity: FileIdentity | null;
  #offset: number;

  constructor(path: string, options: { fromStart?: boolean } = {}) {
    this.path = path;
    this.#identity = identify(path);
    this.#offset = options.fromStart || !this.#identity ? 0 : this.#identity.size;
  }

  /** Returns everything appended since the last call, across rotations. */
  poll(): string {
    const current = identify(this.path);
    if (!current) return "";
    let output = "";
    if (this.#identity && !sameFile(current, this.#identity)) {
      output += this.#drainRotated();
      this.#offset = 0;
    }
    this.#identity = current;
    // A file truncated in place rather than renamed also restarts from zero.
    if (current.size < this.#offset) this.#offset = 0;
    if (current.size > this.#offset) {
      output += readRange(this.path, this.#offset, current.size);
      this.#offset = current.size;
    }
    return output;
  }

  /** Recovers the tail written to the previous file before it was rotated away. */
  #drainRotated(): string {
    const previous = this.#identity;
    if (!previous) return "";
    const rotated = `${this.path}.1`;
    const identity = identify(rotated);
    if (!identity || !sameFile(identity, previous)) return "";
    return readRange(rotated, this.#offset, identity.size);
  }
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
