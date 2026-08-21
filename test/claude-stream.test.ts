import assert from "node:assert/strict";
import test from "node:test";
import { ClaudeStreamReader } from "../src/claude-stream.ts";

const summaries = (entries: Array<{ summary: string }>) => entries.map((entry) => entry.summary);

test("stream reader reports progress as events arrive, not only at the end", () => {
  const reader = new ClaudeStreamReader();
  const init = reader.push(
    `${JSON.stringify({ type: "system", subtype: "init", session_id: "sess-1", model: "claude-opus-5" })}\n`
  );
  assert.deepEqual(summaries(init), ["session sess-1 model=claude-opus-5"]);
  assert.equal(reader.sessionId, "sess-1");

  const work = reader.push(`${JSON.stringify({
    type: "assistant",
    message: { content: [
      { type: "text", text: "Reading the orchestrator" },
      { type: "tool_use", name: "Bash", input: { command: "npm test" } }
    ] }
  })}\n`);
  assert.deepEqual(summaries(work), ["Reading the orchestrator | tool Bash(npm test)"]);

  const toolResult = reader.push(`${JSON.stringify({
    type: "user",
    message: { content: [{ type: "tool_result", is_error: true, content: "boom" }] }
  })}\n`);
  assert.deepEqual(summaries(toolResult), ["tool result x1 (1 failed)"]);
});

test("stream reader reassembles events split across chunks", () => {
  const reader = new ClaudeStreamReader();
  const event = JSON.stringify({ type: "system", subtype: "init", session_id: "sess-2" });
  assert.deepEqual(reader.push(event.slice(0, 12)), []);
  assert.deepEqual(summaries(reader.push(`${event.slice(12)}\n`)), ["session sess-2"]);
  assert.equal(reader.sessionId, "sess-2");
});

test("stream reader captures the final result event as an artifact", () => {
  const reader = new ClaudeStreamReader();
  const entries = reader.push(`${JSON.stringify({
    type: "result", subtype: "success", session_id: "sess-3",
    num_turns: 12, duration_ms: 45_000, total_cost_usd: 0.1234, result: "all done"
  })}\n`);
  assert.deepEqual(summaries(entries), ["result: success, 12 turns, 45s, $0.1234"]);
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
  assert.deepEqual(summaries(reader.push("warning: something happened\n")), ["warning: something happened"]);
  assert.deepEqual(reader.push("trailing without newline"), []);
  assert.deepEqual(summaries(reader.end()), ["trailing without newline"]);
});

test("stream reader tolerates unknown event shapes", () => {
  const reader = new ClaudeStreamReader();
  assert.deepEqual(summaries(reader.push(`${JSON.stringify({ type: "future_event", data: 1 })}\n`)), ["future_event event"]);
  assert.deepEqual(reader.push(`${JSON.stringify({ type: "assistant", message: {} })}\n`), []);
});

test("an oversized record is dropped with a diagnostic instead of growing unbounded", () => {
  const reader = new ClaudeStreamReader(null, 4096);
  // A tool result encodes command output inside one JSON line, so a huge record can
  // arrive as many chunks with no newline at all.
  let entries: Array<{ summary: string }> = [];
  entries = entries.concat(reader.push(`{"type":"user","message":{"content":[{"type":"tool_result","content":"`));
  for (let index = 0; index < 200; index += 1) {
    entries = entries.concat(reader.push("A".repeat(1000)));
  }
  assert.deepEqual(entries, [], "no entry is emitted until the record ends");
  const closing = reader.push(`"}]}}\n`);
  assert.equal(closing.length, 1);
  assert.match(closing[0].summary, /dropped oversized event/);
  assert.match(closing[0].summary, /limit 4096/);
});

test("the reader keeps working after dropping an oversized record", () => {
  const reader = new ClaudeStreamReader(null, 1024);
  reader.push(`{"type":"user","content":"${"B".repeat(5000)}`);
  const resumed = reader.push(`"}\n${JSON.stringify({
    type: "system", subtype: "init", session_id: "sess-after"
  })}\n`);
  assert.equal(resumed.length, 2);
  assert.match(resumed[0].summary, /dropped oversized event/);
  assert.equal(resumed[1].summary, "session sess-after");
  assert.equal(reader.sessionId, "sess-after", "later events must still be parsed");
});

test("an oversized record still open at end of stream is reported once", () => {
  const reader = new ClaudeStreamReader(null, 1024);
  reader.push(`{"type":"user","content":"${"C".repeat(4000)}`);
  const ended = reader.end();
  assert.equal(ended.length, 1);
  assert.match(ended[0].summary, /dropped oversized event/);
  assert.deepEqual(reader.end(), [], "the diagnostic is not repeated");
});

test("detail keeps the full assistant message the summary truncates", () => {
  const reader = new ClaudeStreamReader();
  const long = "x".repeat(500);
  const [entry] = reader.push(`${JSON.stringify({
    type: "assistant", message: { content: [{ type: "text", text: long }] }
  })}\n`);
  assert.ok(entry.summary.length < 250, "summary must stay short");
  assert.ok(entry.detail.includes(long), "detail must preserve the whole message");
});

test("detail preserves tool inputs and failing tool result output", () => {
  const reader = new ClaudeStreamReader();
  const [toolUse] = reader.push(`${JSON.stringify({
    type: "assistant",
    message: { content: [{ type: "tool_use", name: "Bash", input: { command: "npm test", timeout: 600 } }] }
  })}\n`);
  assert.match(toolUse.detail, /"command": "npm test"/);
  assert.match(toolUse.detail, /"timeout": 600/);

  const [result] = reader.push(`${JSON.stringify({
    type: "user",
    message: { content: [{ type: "tool_result", is_error: true, content: "AssertionError: expected 1 to equal 2\n  at test.ts:14" }] }
  })}\n`);
  // The failure text is what explains why a run is stuck; it must not be dropped.
  assert.match(result.detail, /tool result \(error\)/);
  assert.match(result.detail, /AssertionError: expected 1 to equal 2/);
  assert.match(result.detail, /at test\.ts:14/);
});

test("detail renders tool results delivered as content blocks", () => {
  const reader = new ClaudeStreamReader();
  const [entry] = reader.push(`${JSON.stringify({
    type: "user",
    message: { content: [{ type: "tool_result", content: [{ type: "text", text: "line one" }, { type: "text", text: "line two" }] }] }
  })}\n`);
  assert.match(entry.detail, /line one/);
  assert.match(entry.detail, /line two/);
});
