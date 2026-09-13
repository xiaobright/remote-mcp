// Explicit opt-in integration test. Uses only its own jobs and an isolated local registry.
// Remote job logs and this run's local evidence are retained; no user files are deleted.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { connectServer, textOf } from "./test-client.mjs";

const runDir = resolve("work", "smoke-wsl", randomUUID());
mkdirSync(runDir, { recursive: true });
const env = {
  REMOTE_MCP_PERSISTENT_JOB_STORE_PATH: join(runDir, "jobs.json"),
  REMOTE_MCP_OUTPUT_DIR: join(runDir, "output"),
  REMOTE_MCP_OUTPUT_LIMIT_CHARS: "64",
  WSL_MCP_DEFAULT_TASK_READ_WINDOW_CHARS: "64",
  WSL_MCP_PERSISTENT_JOB_DEFAULT_READ_WINDOW_CHARS: "64",
};
let client = await connectServer("wsl", env);
const jobs = new Set();
let checks = 0;
async function call(name, args) {
  const result = await client.callTool({ name: `wsl_${name}`, arguments: args }, undefined, { timeout: 180000 });
  assert.notEqual(result.isError, true, textOf(result));
  return result;
}
function passed(name) { checks += 1; console.log(`PASS ${name}`); }
async function start(command, extra = {}) {
  const result = await call("job", { action: "start", command, max_runtime_ms: 300000, ...extra });
  jobs.add(result.structuredContent.jobId);
  return result.structuredContent;
}

try {
  const plain = await call("exec", { command: "printf 'core-ok\\n'; printf 'stderr-ok\\n' >&2; exit 7" });
  assert.equal(plain.structuredContent.exitCode, 7);
  assert.match(textOf(plain), /core-ok/);
  assert.match(textOf(plain), /stderr-ok/);
  assert.equal(plain.structuredContent.stdout, undefined);
  passed("exec output and exit code");

  const literal = await call("script", { script: "cat <<'LITERAL'\n$HOME $(literal) \"quotes\" 中文\nLITERAL", shell: "sh", workdir: "/tmp" });
  assert.match(textOf(literal), /\$HOME \$\(literal\) "quotes" 中文/);
  const badDir = await call("exec", { command: "printf 'MUST_NOT_EXECUTE'", workdir: "/__remote_mcp_missing_" + randomUUID() });
  assert.notEqual(badDir.structuredContent.exitCode, 0);
  assert.doesNotMatch(textOf(badDir), /MUST_NOT_EXECUTE/);
  passed("stdin heredoc, sh and fail-closed workdir");

  const large = await call("exec", { command: "printf 'x%.0s' {1..200}; printf END" });
  assert.equal(large.structuredContent.stdoutTruncated, true);
  assert.equal(readFileSync(large.structuredContent.fullOutput.stdout, "utf8"), "x".repeat(200) + "END");
  passed("bounded sync output with recoverable full log");

  const attached = await call("script", { script: "printf before; sleep 1; printf after", mode: "async" });
  const waited = await call("task", { action: "wait", taskId: attached.structuredContent.taskId, wait_ms: 60000, stdoutOffset: 0, stderrOffset: 0 });
  assert.equal(waited.structuredContent.completed, true);
  assert.equal(waited.structuredContent.task.exitCode, 0);
  assert.match(textOf(waited), /beforeafter/);
  const empty = await call("task", {
    action: "output", taskId: attached.structuredContent.taskId,
    stdoutOffset: waited.structuredContent.nextStdoutOffset, stderrOffset: waited.structuredContent.nextStderrOffset,
  });
  assert.doesNotMatch(textOf(empty), /beforeafter/);
  passed("async task wait and non-replaying offsets");

  const persistent = await start("printf before; sleep 2; printf after; exit 7", { workdir: "/tmp" });
  await client.close();
  client = await connectServer("wsl", env);
  const rejoined = await call("job", { action: "wait", jobId: persistent.jobId, wait_ms: 60000, stdoutOffset: 0, stderrOffset: 0 });
  assert.equal(rejoined.structuredContent.completed, true);
  assert.equal(rejoined.structuredContent.job.exitCode, 7);
  assert.match(textOf(rejoined), /beforeafter/);
  passed("persistent job survives MCP restart");

  const paged = await start("printf 'x%.0s' {1..100}; printf '你🙂END'");
  const ended = await call("job", { action: "wait", jobId: paged.jobId, wait_ms: 60000, stdoutOffset: 0, stderrOffset: 0 });
  assert.equal(ended.structuredContent.nextStdoutOffset, 64);
  const second = await call("job", {
    action: "output", jobId: paged.jobId, stdoutOffset: 64, stderrOffset: 0,
  });
  assert.match(textOf(second), /你🙂END/);
  assert.equal(second.structuredContent.nextStdoutOffset, Buffer.byteLength("x".repeat(100) + "你🙂END"));
  passed("job explicit zero offset, capped pages and Unicode");

  const invalid = await start("printf 'MUST_NOT_EXECUTE'", { workdir: "/__remote_mcp_missing_" + randomUUID() });
  const invalidState = await call("job", { action: "wait", jobId: invalid.jobId, wait_ms: 60000 });
  assert.equal(invalidState.structuredContent.job.state, "error");
  assert.doesNotMatch(textOf(invalidState), /MUST_NOT_EXECUTE/);
  passed("job never falls back from an invalid workdir");

  const cancellable = await start("sleep 300 & wait");
  const cancelled = await call("job", { action: "cancel", jobId: cancellable.jobId });
  assert.equal(cancelled.structuredContent.state, "cancelled");
  const again = await call("job", { action: "cancel", jobId: cancellable.jobId });
  assert.equal(again.structuredContent.state, "cancelled");
  passed("job cancellation and repeat cancellation");

  console.log(JSON.stringify({ passed: checks, evidence: runDir, jobIds: [...jobs] }));
} finally {
  // Cancel only jobs created by this smoke run; never enumerate/cancel the user's registry.
  for (const jobId of jobs) {
    try {
      await client.callTool({ name: "wsl_job", arguments: { action: "cancel", jobId } }, undefined, { timeout: 60000 });
    } catch (error) { console.error(`Cleanup for own job ${jobId}: ${error.message}`); }
  }
  await client.close();
}
