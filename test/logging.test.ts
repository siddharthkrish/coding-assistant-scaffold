import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  StepLogger, artifactPath, listLogFiles, pruneRunHistory, redact, runLogDirectory,
  stepLogPath, tailFile, writeArtifact
} from "../src/logging.ts";

const limits = { maxFileBytes: 5_000_000, maxFilesPerStep: 3 };

function workspace(): string {
  return mkdtempSync(join(tmpdir(), "orchestrator-logs-"));
}

test("redaction removes credential-shaped values", () => {
  const text = [
    "Authorization: Bearer abcdef123456789",
    "using ghp_abcdefghijklmnopqrstuvwxyz0123",
    "ANTHROPIC_API_KEY=sk-ant-api03-supersecretvalue",
    "aws id AKIAIOSFODNN7EXAMPLE",
    "api_key: 'hunter2hunter2'"
  ].join("\n");
  const output = redact(text);
  assert.doesNotMatch(output, /ghp_abcdefghijklmnopqrstuvwxyz0123/);
  assert.doesNotMatch(output, /sk-ant-api03-supersecretvalue/);
  assert.doesNotMatch(output, /AKIAIOSFODNN7EXAMPLE/);
  assert.doesNotMatch(output, /hunter2hunter2/);
  assert.doesNotMatch(output, /abcdef123456789/);
});

test("redaction leaves ordinary agent output intact", () => {
  const text = "Running tests: npm test\n  tool Bash(npm test)\n  result: success, 4 turns";
  assert.equal(redact(text), text);
});

test("redaction scrubs quoted JSON credential fields without breaking the JSON", () => {
  const record = { password: "hunter2hunter2", token: "abcdef123456", note: "keep me", retries: 3 };
  const output = redact(JSON.stringify(record));
  assert.doesNotMatch(output, /hunter2hunter2/);
  assert.doesNotMatch(output, /abcdef123456/);
  const parsed = JSON.parse(output);
  assert.equal(parsed.password, "[redacted]");
  assert.equal(parsed.token, "[redacted]");
  assert.equal(parsed.note, "keep me");
  assert.equal(parsed.retries, 3);
});

test("redaction survives pretty-printed JSON and leaves placeholder values alone", () => {
  const output = redact(JSON.stringify({ api_key: "supersecretvalue", secret: null }, null, 2));
  const parsed = JSON.parse(output);
  assert.equal(parsed.api_key, "[redacted]");
  assert.equal(parsed.secret, null);
});

test("redaction is idempotent", () => {
  const once = redact(JSON.stringify({ password: "hunter2hunter2" }));
  assert.equal(redact(once), once);
});

test("step logger suppresses a private key spanning many lines", () => {
  const dir = workspace();
  const path = join(dir, "implementing.log");
  const logger = new StepLogger(path, limits);
  logger.write([
    "before the key",
    "-----BEGIN RSA PRIVATE KEY-----",
    "MIIEowIBAAKCAQEAsecretkeymaterialline1",
    "MIIEowIBAAKCAQEAsecretkeymaterialline2",
    "-----END RSA PRIVATE KEY-----",
    "after the key",
    ""
  ].join("\n"));
  logger.close();
  const content = readFileSync(path, "utf8");
  assert.doesNotMatch(content, /secretkeymaterial/);
  assert.doesNotMatch(content, /BEGIN RSA PRIVATE KEY/);
  assert.match(content, /\[redacted private key\]/);
  // Surrounding output must still be readable.
  assert.match(content, /before the key/);
  assert.match(content, /after the key/);
});

test("artifacts redact generic credential fields and stay parseable", () => {
  const runtime = workspace();
  const path = writeArtifact(artifactPath(runtime, 9, "claude-implement.json"), {
    subtype: "success",
    password: "hunter2hunter2",
    result: "ran `curl -H 'Authorization: Bearer abcdef123456789'`"
  });
  const parsed = JSON.parse(readFileSync(path, "utf8"));
  assert.equal(parsed.password, "[redacted]");
  assert.doesNotMatch(parsed.result, /abcdef123456789/);
  assert.equal(parsed.subtype, "success");
});

test("step logger writes whole lines and redacts secrets crossing chunk boundaries", () => {
  const dir = workspace();
  const path = join(dir, "implementing.log");
  const logger = new StepLogger(path, limits);
  logger.write("export TOKEN=ghp_abcdefgh");
  logger.write("ijklmnopqrstuvwxyz0123\nplain line\n");
  logger.close();
  const content = readFileSync(path, "utf8");
  assert.doesNotMatch(content, /ghp_abcdefghijklmnopqrstuvwxyz0123/);
  assert.match(content, /plain line/);
});

test("step logger rotates and bounds total files", () => {
  const dir = workspace();
  const path = join(dir, "review.log");
  const logger = new StepLogger(path, { maxFileBytes: 1024, maxFilesPerStep: 2 });
  for (let index = 0; index < 200; index += 1) logger.write(`${"x".repeat(80)}\n`);
  logger.close();
  assert.ok(existsSync(`${path}.1`), "expected a rotated file");
  assert.ok(existsSync(`${path}.2`), "expected a second rotated file");
  assert.ok(!existsSync(`${path}.3`), "rotation must stop at maxFilesPerStep");
  assert.ok(readFileSync(path, "utf8").length <= 1024 + 128);
});

test("step logger appends to an existing file without truncating it", () => {
  const dir = workspace();
  const path = join(dir, "tests.log");
  writeFileSync(path, "earlier run\n");
  const logger = new StepLogger(path, limits);
  logger.note("second run");
  logger.close();
  const content = readFileSync(path, "utf8");
  assert.match(content, /earlier run/);
  assert.match(content, /second run/);
});

test("pruning keeps only the newest run log and artifact directories", () => {
  const runtime = workspace();
  for (const issue of [1, 2, 3]) {
    const logger = new StepLogger(stepLogPath(runtime, issue, "implementing"), limits);
    logger.note(`issue ${issue}`);
    logger.close();
    writeArtifact(artifactPath(runtime, issue, "claude-implement.json"), { issue });
  }
  const removed = pruneRunHistory(runtime, 1);
  assert.equal(removed.length, 4, "expected two log and two artifact directories to be dropped");
  assert.ok(existsSync(runLogDirectory(runtime, 3)));
  assert.ok(!existsSync(runLogDirectory(runtime, 1)));
  assert.ok(existsSync(artifactPath(runtime, 3, "claude-implement.json")));
  assert.ok(!existsSync(artifactPath(runtime, 1, "claude-implement.json")));
});

test("pruning is a no-op before any history exists", () => {
  assert.deepEqual(pruneRunHistory(workspace(), 20), []);
});

test("artifacts are persisted redacted and are readable", () => {
  const runtime = workspace();
  const path = writeArtifact(artifactPath(runtime, 7, "claude-implement.json"), {
    subtype: "success",
    result: "done, token ghp_abcdefghijklmnopqrstuvwxyz0123"
  });
  const parsed = JSON.parse(readFileSync(path, "utf8"));
  assert.equal(parsed.subtype, "success");
  assert.doesNotMatch(parsed.result, /ghp_/);
});

test("log listing and tailing surface recorded output", () => {
  const runtime = workspace();
  const logger = new StepLogger(stepLogPath(runtime, 5, "implementing"), limits);
  for (let index = 0; index < 10; index += 1) logger.write(`line ${index}\n`);
  logger.close();
  const files = listLogFiles(runtime, 5);
  assert.equal(files.length, 1);
  const tail = tailFile(files[0], 3);
  assert.equal(tail?.split("\n").length, 3);
  assert.match(tail!, /line 9/);
  assert.equal(tailFile(join(runtime, "missing.log"), 3), null);
});
