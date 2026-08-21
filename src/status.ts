import { isProcessAlive } from "./process.ts";
import type { StateStore } from "./state-store.ts";
import type { Run } from "./types.ts";

export type Liveness = "running" | "waiting" | "stale" | "orphaned" | "done";

export type StatusRow = {
  issue: number;
  status: string;
  step: string;
  liveness: Liveness;
  cycle: number;
  pr: number | null;
  pid: number | null;
  ownerPid: number | null;
  session: string | null;
  detail: string | null;
  lastActivityAt: string | null;
  idleSeconds: number | null;
  elapsedSeconds: number | null;
  logPath: string | null;
  updatedAt: string;
  error: string | null;
};

const terminalStatuses = ["completed", "failed", "human_review"];

/**
 * Joins run state with the persisted activity row so callers can see the current
 * sub-step and tell live work apart from a run whose orchestrator died.
 */
export function statusRows(store: StateStore, staleAfterSeconds: number, now = Date.now()): StatusRow[] {
  return store.all().map((run) => buildRow(run, store, staleAfterSeconds, now));
}

function buildRow(run: Run, store: StateStore, staleAfterSeconds: number, now: number): StatusRow {
  const activity = store.activity(run.id);
  const terminal = terminalStatuses.includes(run.status);
  const lastActivity = activity ? Date.parse(activity.lastActivityAt) : Number.NaN;
  const idleSeconds = Number.isNaN(lastActivity) ? null : Math.max(0, Math.round((now - lastActivity) / 1000));
  const started = activity ? Date.parse(activity.startedAt) : Number.NaN;
  const elapsedSeconds = Number.isNaN(started) ? null : Math.max(0, Math.round((now - started) / 1000));
  return {
    issue: run.issueNumber,
    status: run.status,
    step: activity?.step ?? run.status,
    liveness: liveness(terminal, activity, idleSeconds, staleAfterSeconds),
    cycle: run.reviewCycle,
    pr: run.prNumber,
    pid: activity?.pid ?? null,
    ownerPid: activity?.ownerPid ?? null,
    session: run.claudeSessionId,
    detail: activity?.detail ?? null,
    lastActivityAt: activity?.lastActivityAt ?? null,
    idleSeconds,
    elapsedSeconds,
    logPath: activity?.logPath ?? null,
    updatedAt: run.updatedAt,
    error: run.lastError
  };
}

function liveness(
  terminal: boolean,
  activity: { pid: number | null; ownerPid: number | null } | null,
  idleSeconds: number | null,
  staleAfterSeconds: number
): Liveness {
  if (terminal) return "done";
  if (!activity) return "waiting";
  if (isProcessAlive(activity.pid)) return "running";
  // No child process: the run is only alive if the orchestrator that owns it is.
  if (!isProcessAlive(activity.ownerPid)) return "orphaned";
  if (idleSeconds !== null && idleSeconds > staleAfterSeconds) return "stale";
  return "waiting";
}

export function formatDuration(seconds: number | null): string {
  if (seconds === null) return "-";
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}
