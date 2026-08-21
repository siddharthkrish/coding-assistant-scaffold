import { spawn } from "node:child_process";

export type CommandResult = { stdout: string; stderr: string; code: number };

export type CommandOptions = {
  cwd?: string;
  stdin?: string;
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
  quiet?: boolean;
  allowNonZero?: boolean;
  /**
   * Called with the child pid when it spawns, and again with `undefined` once it
   * exits, so callers can record exactly what is running right now.
   */
  onStart?: (pid: number | undefined) => void;
  /** Receives every chunk as it arrives; when set it replaces console echoing. */
  onData?: (stream: "stdout" | "stderr", chunk: string) => void;
  /** Fired on an interval while the child is alive so liveness can be recorded. */
  onHeartbeat?: () => void;
  heartbeatMs?: number;
};

export async function runCommand(
  command: string,
  args: string[],
  options: CommandOptions = {}
): Promise<CommandResult> {
  const controller = new AbortController();
  const timeout = options.timeoutMs
    ? setTimeout(() => controller.abort(), options.timeoutMs)
    : undefined;
  const child = spawn(command, args, {
    cwd: options.cwd,
    env: options.env ?? process.env,
    signal: controller.signal,
    stdio: ["pipe", "pipe", "pipe"]
  });
  options.onStart?.(child.pid);
  const heartbeat = options.onHeartbeat && options.heartbeatMs
    ? setInterval(options.onHeartbeat, options.heartbeatMs)
    : undefined;
  heartbeat?.unref?.();
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
    if (options.onData) options.onData("stdout", chunk);
    else if (!options.quiet) process.stdout.write(chunk);
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
    if (options.onData) options.onData("stderr", chunk);
    else if (!options.quiet) process.stderr.write(chunk);
  });
  if (options.stdin !== undefined) child.stdin.end(options.stdin);
  else child.stdin.end();
  try {
    const code = await new Promise<number>((resolvePromise, reject) => {
      child.once("error", reject);
      child.once("close", (value) => resolvePromise(value ?? 1));
    });
    if (code !== 0 && !options.allowNonZero) {
      const detail = stderr.trim() || stdout.trim() || "no output";
      throw new Error(`${command} exited with ${code}: ${detail}`);
    }
    return { stdout, stderr, code };
  } catch (error) {
    if (controller.signal.aborted) {
      throw new Error(`${command} timed out after ${options.timeoutMs}ms`, { cause: error });
    }
    throw error;
  } finally {
    if (timeout) clearTimeout(timeout);
    if (heartbeat) clearInterval(heartbeat);
    options.onStart?.(undefined);
  }
}

export async function commandExists(command: string): Promise<boolean> {
  try {
    await runCommand(command, ["--version"], { quiet: true, timeoutMs: 10_000 });
    return true;
  } catch {
    return false;
  }
}

/** True when a process with `pid` is still running and reachable. */
export function isProcessAlive(pid: number | null | undefined): boolean {
  if (!pid || pid < 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}
