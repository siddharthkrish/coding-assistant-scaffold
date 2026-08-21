import assert from "node:assert/strict";
import test from "node:test";
import { ClaudeStreamReader } from "../src/claude-stream.ts";

test("stream reader reports progress as events arrive, not only at the end", () => {
  const reader = new ClaudeStreamReader();
  const init = reader.push(
    `${JSON.stringify({ type: "system", subtype: "init", session_id: "sess-1", model: "claude-opus-5" })}\n`
  );
  assert.deepEqual(init, ["session sess-1 model=claude-opus-5"]);
  assert.equal(reader.sessionId, "sess-1");

  const work = reader.push(`${JSON.stringify({
    type: "assistant",
    message: { content: [
      { type: "text", text: "Reading the orchestrator" },
      { type: "tool_use", name: "Bash", input: { command: "npm test" } }
    ] }
  })}\n`);
  assert.deepEqual(work, ["Reading the orchestrator | tool Bash(npm test)"]);

  const toolResult = reader.push(`${JSON.stringify({
    type: "user",
    message: { content: [{ type: "tool_result", is_error: true, content: "boom" }] }
  })}\n`);
  assert.deepEqual(toolResult, ["tool result x1 (1 failed)"]);
});

test("stream reader reassembles events split across chunks", () => {
  const reader = new ClaudeStreamReader();
  const event = JSON.stringify({ type: "system", subtype: "init", session_id: "sess-2" });
  assert.deepEqual(reader.push(event.slice(0, 12)), []);
  assert.deepEqual(reader.push(`${event.slice(12)}\n`), ["session sess-2"]);
  assert.equal(reader.sessionId, "sess-2");
});

test("stream reader captures the final result event as an artifact", () => {
  const reader = new ClaudeStreamReader();
  const lines = reader.push(`${JSON.stringify({
    type: "result", subtype: "success", session_id: "sess-3",
    num_turns: 12, duration_ms: 45_000, total_cost_usd: 0.1234, result: "all done"
  })}\n`);
  assert.deepEqual(lines, ["result: success, 12 turns, 45s, $0.1234"]);
  assert.equal(reader.result?.result, "all done");
  assert.equal(reader.sessionId, "sess-3");
});

test("stream reader keeps the prior session id when the stream never reports one", () => {
  const reader = new ClaudeStreamReader("previous-session");
  reader.push(`${JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "hi" }] } })}\n`);
  assert.equal(reader.sessionId, "previous-session");
});

test("stream reader passes through non-JSON output instead of dropping it", () => {
  const reader = new ClaudeStreamReader();
  assert.deepEqual(reader.push("warning: something happened\n"), ["warning: something happened"]);
  assert.deepEqual(reader.push("trailing without newline"), []);
  assert.deepEqual(reader.end(), ["trailing without newline"]);
});

test("stream reader tolerates unknown event shapes", () => {
  const reader = new ClaudeStreamReader();
  assert.deepEqual(reader.push(`${JSON.stringify({ type: "future_event", data: 1 })}\n`), ["future_event event"]);
  assert.deepEqual(reader.push(`${JSON.stringify({ type: "assistant", message: {} })}\n`), []);
});
