/**
 * Incremental reader for Claude Code's `--output-format stream-json` NDJSON.
 *
 * The event schema is treated as advisory: anything unrecognised is surfaced as a
 * short raw line rather than dropped, so a CLI change degrades progress reporting
 * instead of breaking a run.
 */
export class ClaudeStreamReader {
  sessionId: string | null = null;
  result: Record<string, unknown> | null = null;
  #pending = "";

  constructor(initialSessionId: string | null = null) {
    this.sessionId = initialSessionId;
  }

  /** Consumes a chunk and returns human-readable progress lines. */
  push(chunk: string): string[] {
    this.#pending += chunk;
    const lines: string[] = [];
    let index = this.#pending.indexOf("\n");
    while (index >= 0) {
      const line = this.#pending.slice(0, index);
      this.#pending = this.#pending.slice(index + 1);
      const summary = this.#consume(line);
      if (summary) lines.push(summary);
      index = this.#pending.indexOf("\n");
    }
    return lines;
  }

  /** Flushes any trailing partial line at end of stream. */
  end(): string[] {
    const remainder = this.#pending;
    this.#pending = "";
    const summary = remainder ? this.#consume(remainder) : null;
    return summary ? [summary] : [];
  }

  #consume(line: string): string | null {
    const text = line.trim();
    if (!text) return null;
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(text) as Record<string, unknown>;
    } catch {
      return truncate(text, 300);
    }
    const session = event.session_id ?? event.sessionId;
    if (typeof session === "string" && session) this.sessionId = session;
    if (event.type === "result") this.result = event;
    return summarize(event);
  }
}

function summarize(event: Record<string, unknown>): string | null {
  switch (event.type) {
    case "system": {
      if (event.subtype !== "init") return `system: ${String(event.subtype ?? "event")}`;
      const model = typeof event.model === "string" ? ` model=${event.model}` : "";
      return `session ${String(event.session_id ?? event.sessionId ?? "unknown")}${model}`;
    }
    case "assistant":
      return summarizeAssistant(event);
    case "user":
      return summarizeToolResults(event);
    case "result": {
      const status = event.is_error ? "error" : String(event.subtype ?? "success");
      const parts = [`result: ${status}`];
      if (typeof event.num_turns === "number") parts.push(`${event.num_turns} turns`);
      if (typeof event.duration_ms === "number") parts.push(`${Math.round(event.duration_ms / 1000)}s`);
      if (typeof event.total_cost_usd === "number") parts.push(`$${event.total_cost_usd.toFixed(4)}`);
      return parts.join(", ");
    }
    default:
      return event.type ? `${String(event.type)} event` : null;
  }
}

function summarizeAssistant(event: Record<string, unknown>): string | null {
  const parts: string[] = [];
  for (const block of contentBlocks(event)) {
    if (block.type === "text" && typeof block.text === "string" && block.text.trim()) {
      parts.push(truncate(block.text.trim().replace(/\s+/g, " "), 200));
    } else if (block.type === "tool_use") {
      parts.push(`tool ${String(block.name ?? "unknown")}(${describeInput(block.input)})`);
    } else if (block.type === "thinking") {
      parts.push("thinking");
    }
  }
  return parts.length ? parts.join(" | ") : null;
}

function summarizeToolResults(event: Record<string, unknown>): string | null {
  const results = contentBlocks(event).filter((block) => block.type === "tool_result");
  if (!results.length) return null;
  const failed = results.filter((block) => block.is_error === true).length;
  return `tool result x${results.length}${failed ? ` (${failed} failed)` : ""}`;
}

function contentBlocks(event: Record<string, unknown>): Array<Record<string, unknown>> {
  const message = event.message as Record<string, unknown> | undefined;
  const content = message?.content ?? event.content;
  if (typeof content === "string") return [{ type: "text", text: content }];
  if (!Array.isArray(content)) return [];
  return content.filter((block): block is Record<string, unknown> =>
    typeof block === "object" && block !== null);
}

function describeInput(input: unknown): string {
  if (!input || typeof input !== "object") return "";
  const record = input as Record<string, unknown>;
  for (const key of ["command", "file_path", "path", "pattern", "query", "description"]) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return truncate(value.trim().replace(/\s+/g, " "), 120);
  }
  return Object.keys(record).slice(0, 3).join(",");
}

function truncate(value: string, limit: number): string {
  return value.length > limit ? `${value.slice(0, limit - 1)}…` : value;
}
