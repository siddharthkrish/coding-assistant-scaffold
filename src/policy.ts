import type { Review } from "./types.ts";

export function needsFix(review: Review): boolean {
  return review.verdict === "changes_requested" && review.findings.length > 0;
}

export function mayMerge(review: Review, reviewedSha: string | null, headSha: string): boolean {
  return review.verdict === "approved" && review.findings.length === 0 && reviewedSha === headSha;
}
