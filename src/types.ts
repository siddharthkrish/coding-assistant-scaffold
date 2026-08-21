export type RunStatus =
  | "claimed"
  | "implementing"
  | "reviewing"
  | "fixing"
  | "final_review"
  | "waiting_ci"
  | "merging"
  | "syncing_main"
  | "completed"
  | "human_review"
  | "failed";

export type Issue = {
  number: number;
  title: string;
  body: string;
  url: string;
};

export type Finding = {
  severity: "critical" | "high" | "medium" | "low";
  file: string;
  line: number | null;
  problem: string;
  required_fix: string;
};

export type Review = {
  verdict: "approved" | "changes_requested";
  summary: string;
  findings: Finding[];
};

export type Run = {
  id: string;
  issueNumber: number;
  issueTitle: string;
  issueBody: string;
  issueUrl: string;
  status: RunStatus;
  branch: string;
  worktree: string;
  prNumber: number | null;
  reviewCycle: number;
  reviewedSha: string | null;
  claudeSessionId: string | null;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
};

export type LoggingConfig = {
  maxFileBytes: number;
  maxFilesPerStep: number;
  retainRuns: number;
  heartbeatSeconds: number;
};

/** Live progress for the step a run is currently executing. */
export type Activity = {
  runId: string;
  step: string;
  detail: string | null;
  pid: number | null;
  ownerPid: number | null;
  logPath: string | null;
  startedAt: string;
  lastActivityAt: string;
};

export type Config = {
  repository: string;
  baseBranch: string;
  remote: string;
  readyLabel: string;
  claimedLabel: string;
  completedLabel: string;
  branchPrefix: string;
  worktreeRoot: string;
  stateDatabase: string;
  testCommand: string;
  maxReviewCycles: number;
  pollIntervalSeconds: number;
  commandTimeoutMinutes: number;
  claude: { model: string | null; allowedTools: string };
  codex: { model: string | null; reasoningEffort: string };
  logging: LoggingConfig;
};
