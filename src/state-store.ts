import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { Issue, Run, RunStatus } from "./types.ts";

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

  event(id: string, status: string, detail: string | null): void {
    this.db.prepare("INSERT INTO events (run_id, status, detail, created_at) VALUES (?, ?, ?, ?)").run(
      id, status, detail, new Date().toISOString()
    );
  }

  close(): void { this.db.close(); }
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
