import assert from "node:assert/strict";
import test from "node:test";
import { mayMerge, needsFix } from "../src/policy.ts";
import type { Review } from "../src/types.ts";

const approved: Review = { verdict: "approved", summary: "ok", findings: [] };
const rejected: Review = {
  verdict: "changes_requested",
  summary: "bug",
  findings: [{
    severity: "high", file: "src/x.ts", line: 7,
    problem: "race", required_fix: "serialize updates"
  }]
};

test("a concrete finding requires a fix", () => {
  assert.equal(needsFix(rejected), true);
  assert.equal(needsFix(approved), false);
});

test("merge policy binds approval to the reviewed SHA", () => {
  assert.equal(mayMerge(approved, "abc", "abc"), true);
  assert.equal(mayMerge(approved, "abc", "def"), false);
  assert.equal(mayMerge(rejected, "abc", "abc"), false);
});
