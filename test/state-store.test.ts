import assert from "node:assert/strict";
import test from "node:test";
import { StateStore } from "../src/state-store.ts";

test("state survives transitions and tracks active work", () => {
  const store = new StateStore(":memory:");
  try {
    const run = store.create(
      { number: 42, title: "Fix it", body: "Acceptance criteria", url: "https://example.test/42" },
      "agents/issue-42", "/tmp/issue-42"
    );
    assert.equal(run.status, "claimed");
    assert.equal(store.active().length, 1);

    const reviewed = store.update(run.id, "waiting_ci", { prNumber: 9, reviewedSha: "abc" });
    assert.equal(reviewed.prNumber, 9);
    assert.equal(store.get(run.id)?.reviewedSha, "abc");

    store.update(run.id, "completed");
    assert.equal(store.active().length, 0);
    assert.equal(store.all()[0].status, "completed");
  } finally {
    store.close();
  }
});
