import { StepLogger, pruneRunHistory, redact, stepLogPath } from "./logging.ts";
import type { CommandOptions } from "./process.ts";
import type { StateStore } from "./state-store.ts";
import type { Config, Run } from "./types.ts";

/** Retained tail of a streamed child's output, used only for failure messages. */
export const errorTailBytes = 64_000;

/**
 * One observable sub-step of a run. Owns the step's log file, publishes progress to
 * the console, and keeps the persisted activity row fresh so `status` can tell live
 * work apart from an orphaned run.
 */
export class StepSession {
  readonly step: string;
  readonly logger: StepLogger;
  readonly heartbeatMs: number;
  readonly #store: StateStore;
  readonly #runId: string;
  readonly #quiet: boolean;

  constructor(
    store: StateStore,
    run: Run,
    step: string,
    logger: StepLogger,
    heartbeatMs: number,
    quiet: boolean
  ) {
    this.#store = store;
    this.#runId = run.id;
    this.step = step;
    this.logger = logger;
    this.heartbeatMs = heartbeatMs;
    this.#quiet = quiet;
  }

  get logPath(): string {
    return this.logger.path;
  }

  /** Records a progress line: console (unless quiet), log file, and heartbeat detail. */
  progress(text: string): void {
    // Agent messages and tool commands can quote credentials, so redact once here
    // and use the result for every sink: log file, activity row, and console.
    const safe = redact(text).trim();
    if (!safe) return;
    this.logger.note(safe);
    this.#store.heartbeat(this.#runId, safe.slice(0, 200));
    if (!this.#quiet) console.log(`  ${this.step}: ${safe}`);
  }

  /** Writes fuller diagnostics to the bounded log without touching other sinks. */
  detail(text: string): void {
    if (!text.trim()) return;
    this.logger.write(text.endsWith("\n") ? text : `${text}\n`);
  }

  /** Raw output from a child process; logged, echoed, and treated as liveness. */
  output(chunk: string): void {
    this.logger.write(chunk);
    this.#store.heartbeat(this.#runId);
    if (!this.#quiet) process.stdout.write(redact(chunk));
  }

  beat(): void {
    this.#store.heartbeat(this.#runId);
  }

  /** Process-observation options to merge into a `runCommand` call. */
  commandHooks(
    label: string,
    onData?: (stream: "stdout" | "stderr", chunk: string) => void
  ): Partial<CommandOptions> {
    return {
      onStart: (pid) => {
        this.#store.attachProcess(this.#runId, pid ?? null);
        if (pid) this.progress(`${label} started (pid ${pid})`);
      },
      onData: (stream, chunk) => {
        if (onData) onData(stream, chunk);
        else this.output(chunk);
      },
      onHeartbeat: () => this.beat(),
      heartbeatMs: this.heartbeatMs,
      // Streamed output already reaches the rotating log, so retain only enough to
      // build a useful error message if the child exits non-zero.
      captureBytes: errorTailBytes
    };
  }

  end(detail: string): void {
    this.progress(detail);
    this.#store.attachProcess(this.#runId, null);
    this.logger.close();
  }

  fail(message: string): void {
    // Command failures embed child stderr, which is a common place for secrets.
    const safe = redact(message);
    this.logger.note(`FAILED: ${safe}`);
    this.#store.heartbeat(this.#runId, `failed: ${safe}`.slice(0, 200));
    this.#store.attachProcess(this.#runId, null);
    this.logger.close();
  }
}

/** Creates observable step sessions for one run. */
export class ActivityTracker {
  readonly #store: StateStore;
  readonly #config: Config;
  readonly #runtimeDir: string;
  readonly #quiet: boolean;

  constructor(store: StateStore, config: Config, runtimeDir: string, quiet = false) {
    this.#store = store;
    this.#config = config;
    this.#runtimeDir = runtimeDir;
    this.#quiet = quiet;
  }

  begin(run: Run, step: string, detail?: string): StepSession {
    // Pruning happens per step, not once per process, so a long-lived `start`
    // queue keeps its history bounded rather than only trimming at launch.
    pruneRunHistory(this.#runtimeDir, this.#config.logging.retainRuns);
    const path = stepLogPath(this.#runtimeDir, run.issueNumber, step);
    const logger = new StepLogger(path, this.#config.logging);
    logger.note(`=== ${step} (issue #${run.issueNumber}, cycle ${run.reviewCycle}) ===`);
    this.#store.beginStep(run.id, step, detail ?? null, path);
    const session = new StepSession(
      this.#store, run, step, logger, this.#config.logging.heartbeatSeconds * 1000, this.#quiet
    );
    if (!this.#quiet) console.log(`> ${step} (issue #${run.issueNumber}) → ${path}`);
    return session;
  }

  /** Runs `body` inside a step session, closing it on both success and failure. */
  async track<T>(run: Run, step: string, body: (session: StepSession) => Promise<T>, detail?: string): Promise<T> {
    const session = this.begin(run, step, detail);
    try {
      const result = await body(session);
      session.end(`${step} finished`);
      return result;
    } catch (error) {
      session.fail(error instanceof Error ? error.message : String(error));
      throw error;
    }
  }
}
