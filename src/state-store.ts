import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { Activity, Issue, Run, RunStatus } from "./types.ts";

const columns = `id, issue_number, issue_title, issue_body, issue_url, status, branch,
  worktree, pr_number, review_cycle, reviewed_sha, claude_session_id, last_error,
  created_at, updated_at`;

export class StateStore {
  readonly db: DatabaseSync;

  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS runs (
        id TEXT PRIMARY KEY,
        issue_number INTEGER NOT NULL UNIQUE,
        issue_title TEXT NOT NULL,
        issue_body TEXT NOT NULL,
        issue_url TEXT NOT NULL,
        status TEXT NOT NULL,
        branch TEXT NOT NULL,
        worktree TEXT NOT NULL,
        pr_number INTEGER,
        review_cycle INTEGER NOT NULL DEFAULT 0,
        reviewed_sha TEXT,
        claude_session_id TEXT,
        last_error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id TEXT NOT NULL,
        status TEXT NOT NULL,
        detail TEXT,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS activity (
        run_id TEXT PRIMARY KEY,
        step TEXT NOT NULL,
        detail TEXT,
        pid INTEGER,
        owner_pid INTEGER,
        log_path TEXT,
        started_at TEXT NOT NULL,
        last_activity_at TEXT NOT NULL
      );
    `);
  }

  create(issue: Issue, branch: string, worktree: string): Run {
    const now = new Date().toISOString();
    const id = `issue-${issue.number}-${Date.now()}`;
    this.db.prepare(`INSERT INTO runs (${columns}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      id, issue.number, issue.title, issue.body, issue.url, "claimed", branch,
      worktree, null, 0, null, null, null, now, now
    );
    this.event(id, "claimed", "Issue claimed");
    return this.get(id)!;
  }

  get(id: string): Run | null {
    const row = this.db.prepare(`SELECT ${columns} FROM runs WHERE id = ?`).get(id);
    return row ? mapRun(row as Record<string, unknown>) : null;
  }

  getByIssue(issueNumber: number): Run | null {
    const row = this.db.prepare(`SELECT ${columns} FROM runs WHERE issue_number = ?`).get(issueNumber);
    return row ? mapRun(row as Record<string, unknown>) : null;
  }

  active(): Run[] {
    const rows = this.db.prepare(`SELECT ${columns} FROM runs WHERE status NOT IN ('completed', 'failed', 'human_review') ORDER BY created_at`).all();
    return rows.map((row) => mapRun(row as Record<string, unknown>));
  }

  all(): Run[] {
    const rows = this.db.prepare(`SELECT ${columns} FROM runs ORDER BY created_at DESC`).all();
    return rows.map((row) => mapRun(row as Record<string, unknown>));
  }

  update(id: string, status: RunStatus, values: Partial<Pick<Run, "prNumber" | "reviewCycle" | "reviewedSha" | "claudeSessionId" | "lastError">> = {}, detail?: string): Run {
    const current = this.get(id);
    if (!current) throw new Error(`Unknown run ${id}`);
    const next = { ...current, ...values, status, updatedAt: new Date().toISOString() };
    this.db.prepare(`UPDATE runs SET status=?, pr_number=?, review_cycle=?, reviewed_sha=?, claude_session_id=?, last_error=?, updated_at=? WHERE id=?`).run(
      next.status, next.prNumber, next.reviewCycle, next.reviewedSha,
      next.claudeSessionId, next.lastError, next.updatedAt, id
    );
    this.event(id, status, detail ?? null);
    return next;
  }

  /** Records the sub-step a run just entered, replacing any previous activity row. */
  beginStep(runId: string, step: string, detail: string | null, logPath: string | null, ownerPid = process.pid): Activity {
    const now = new Date().toISOString();
    this.db.prepare(
      `INSERT INTO activity (run_id, step, detail, pid, owner_pid, log_path, started_at, last_activity_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(run_id) DO UPDATE SET
         step=excluded.step, detail=excluded.detail, pid=NULL, owner_pid=excluded.owner_pid,
         log_path=excluded.log_path, started_at=excluded.started_at, last_activity_at=excluded.last_activity_at`
    ).run(runId, step, detail, null, ownerPid, logPath, now, now);
    return this.activity(runId)!;
  }

  /** Attaches (or clears) the pid of the child process the step is waiting on. */
  attachProcess(runId: string, pid: number | null): void {
    this.db.prepare("UPDATE activity SET pid=?, last_activity_at=? WHERE run_id=?").run(
      pid ?? null, new Date().toISOString(), runId
    );
  }

  /** Bumps the liveness timestamp, optionally with a new sub-step detail. */
  heartbeat(runId: string, detail?: string | null): void {
    const now = new Date().toISOString();
    if (detail === undefined) {
      this.db.prepare("UPDATE activity SET last_activity_at=? WHERE run_id=?").run(now, runId);
    } else {
      this.db.prepare("UPDATE activity SET last_activity_at=?, detail=? WHERE run_id=?").run(now, detail, runId);
    }
  }

  activity(runId: string): Activity | null {
    const row = this.db.prepare(
      "SELECT run_id, step, detail, pid, owner_pid, log_path, started_at, last_activity_at FROM activity WHERE run_id = ?"
    ).get(runId);
    return row ? mapActivity(row as Record<string, unknown>) : null;
  }

  event(id: string, status: string, detail: string | null): void {
    this.db.prepare("INSERT INTO events (run_id, status, detail, created_at) VALUES (?, ?, ?, ?)").run(
      id, status, detail, new Date().toISOString()
    );
  }

  close(): void { this.db.close(); }
}

function mapActivity(row: Record<string, unknown>): Activity {
  return {
    runId: String(row.run_id),
    step: String(row.step),
    detail: row.detail === null ? null : String(row.detail),
    pid: row.pid === null ? null : Number(row.pid),
    ownerPid: row.owner_pid === null ? null : Number(row.owner_pid),
    logPath: row.log_path === null ? null : String(row.log_path),
    startedAt: String(row.started_at),
    lastActivityAt: String(row.last_activity_at)
  };
}

function mapRun(row: Record<string, unknown>): Run {
  return {
    id: String(row.id), issueNumber: Number(row.issue_number), issueTitle: String(row.issue_title),
    issueBody: String(row.issue_body), issueUrl: String(row.issue_url), status: row.status as RunStatus,
    branch: String(row.branch), worktree: String(row.worktree),
    prNumber: row.pr_number === null ? null : Number(row.pr_number), reviewCycle: Number(row.review_cycle),
    reviewedSha: row.reviewed_sha === null ? null : String(row.reviewed_sha),
    claudeSessionId: row.claude_session_id === null ? null : String(row.claude_session_id),
    lastError: row.last_error === null ? null : String(row.last_error),
    createdAt: String(row.created_at), updatedAt: String(row.updated_at)
  };
}
