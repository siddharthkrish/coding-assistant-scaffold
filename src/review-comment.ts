import type { Review } from "./types.ts";

export function formatReviewComment(review: Review, sha: string, finalReview: boolean): string {
  const phase = finalReview ? "Final review" : "Review";
  const verdict = review.verdict === "approved" ? "Approved" : "Changes requested";
  const lines = [
    `### Codex ${phase.toLowerCase()}: ${verdict}`,
    "",
    `Reviewed commit: \`${sha}\``,
    "",
    review.summary
  ];
  if (review.findings.length > 0) {
    lines.push("", "**Findings**", "");
    review.findings.forEach((finding, index) => {
      const location = finding.line === null ? finding.file : `${finding.file}:${finding.line}`;
      lines.push(
        `${index + 1}. **${finding.severity}** — \`${location}\``,
        `   - Problem: ${finding.problem}`,
        `   - Required fix: ${finding.required_fix}`
      );
    });
  }
  lines.push("", "_Posted by the pair-programming orchestrator._");
  return lines.join("\n");
}
