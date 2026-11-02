import assert from "node:assert/strict";
import test from "node:test";
import { formatReviewComment } from "../src/review-comment.ts";
import type { Review } from "../src/types.ts";

test("approved review comment names the verdict and commit", () => {
  const review: Review = { verdict: "approved", summary: "Looks good", findings: [] };
  const body = formatReviewComment(review, "abc123", false);
  assert.match(body, /Codex review: Approved/);
  assert.match(body, /`abc123`/);
  assert.doesNotMatch(body, /Findings/);
});

test("requested changes list each finding with location and fix", () => {
  const review: Review = {
    verdict: "changes_requested",
    summary: "Race condition",
    findings: [
      { severity: "high", file: "src/x.ts", line: 7, problem: "race", required_fix: "serialize" },
      { severity: "low", file: "src/y.ts", line: null, problem: "naming", required_fix: "rename" }
    ]
  };
  const body = formatReviewComment(review, "def456", true);
  assert.match(body, /Codex final review: Changes requested/);
  assert.match(body, /\*\*high\*\* — `src\/x\.ts:7`/);
  assert.match(body, /`src\/y\.ts`/);
  assert.match(body, /Required fix: serialize/);
});
