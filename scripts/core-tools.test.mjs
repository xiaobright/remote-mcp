import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { connectServer, textOf } from "./test-client.mjs";
import { newPersistentJobRecord } from "../packages/shared/dist/persistentJobs.js";

async function fixture(t, extraEnv = {}) {
  const dir = mkdtempSync(join(tmpdir(), "remote-mcp-core-test-"));
  const env = {
    SSH_MCP_COMMAND: process.execPath,
    SSH_MCP_OPTIONS_JSON: JSON.stringify([resolve("scripts/fixtures/fake-ssh.mjs")]),
    SSH_MCP_DEFAULT_TARGET: "fixture-host",
    SSH_MCP_DEVICES_PATH: join(dir, "devices.json"),
    REMOTE_MCP_PERSISTENT_JOB_STORE_PATH: join(dir, "jobs.json"),
    REMOTE_MCP_OUTPUT_DIR: join(dir, "output"),
    REMOTE_MCP_OUTPUT_LIMIT_CHARS: "64",
    SSH_MCP_DEFAULT_TASK_READ_WINDOW_CHARS: "64",
    ...extraEnv,
  };
  const client = await connectServer("ssh", env);
  t.after(async () => {
    await client.close();
    assert.equal(resolve(dirname(dir)), resolve(tmpdir()));
    assert.ok(dir.includes("remote-mcp-core-test-"));
    rmSync(dir, { recursive: true, force: true });
  });
  return { client, dir, env };
}

test("actual tools/call preserves stdin, quoting, workdir and environment", async (t) => {
  const { client } = await fixture(t, { REMOTE_MCP_OUTPUT_LIMIT_CHARS: "8192" });
  const script = "printf '%s\\n' '$VAR $(literal) \"quotes\" 中文'";
  const result = await client.callTool({
    name: "ssh_script", arguments: { script, workdir: "/tmp/a'b", env: { EXAMPLE: "a'b" }, shell: "sh" },
  });
  assert.equal(result.structuredContent.exitCode, 0);
  assert.equal(result.structuredContent.stdout, undefined);
  const line = textOf(result).split("\n").find((line) => line.startsWith("{"));
  const captured = JSON.parse(line);
  assert.ok(captured.input.includes(script));
  assert.match(captured.input, /cd -- .* \|\| exit \$\?/);
  assert.match(captured.input, /export EXAMPLE=/);
  assert.deepEqual(captured.argv.slice(-2), ["sh", "-s"]);
});

test("sync results retain exit codes and spool oversized output once", async (t) => {
  const { client } = await fixture(t);
  const failure = await client.callTool({ name: "ssh_exec", arguments: { command: "FIXTURE_EXIT" } });
  assert.equal(failure.structuredContent.exitCode, 7);
  assert.match(textOf(failure), /command failed/);
  const large = await client.callTool({ name: "ssh_exec", arguments: { command: "FIXTURE_LARGE" } });
  assert.equal(large.structuredContent.stdoutTruncated, true);
  assert.equal(large.structuredContent.stdout, undefined);
  assert.ok(textOf(large).length < 1000);
  assert.equal(readFileSync(large.structuredContent.fullOutput.stdout, "utf8").length, 2010);
});

test("watch detaches to a usable task handle; wait does not relaunch", async (t) => {
  const { client } = await fixture(t);
  const start = await client.callTool({
    name: "ssh_exec", arguments: { command: "FIXTURE_SLEEP", mode: "watch", timeout_ms: 20 },
  });
  assert.equal(start.structuredContent.detached, true);
  const id = start.structuredContent.task.taskId;
  const completed = await client.callTool({
    name: "ssh_task", arguments: { action: "wait", taskId: id, wait_ms: 60000, stdoutOffset: 0, stderrOffset: 0 },
  }, undefined, { timeout: 120000 });
  assert.equal(completed.structuredContent.completed, true);
  assert.equal(completed.structuredContent.task.exitCode, 0);
  assert.match(textOf(completed), /started[\s\S]*finished/);
  const noReplay = await client.callTool({
    name: "ssh_task", arguments: {
      action: "output", taskId: id,
      stdoutOffset: completed.structuredContent.nextStdoutOffset,
      stderrOffset: completed.structuredContent.nextStderrOffset,
    },
  });
  assert.doesNotMatch(textOf(noReplay), /started|finished/);
});

test("sync timeout and attached cancellation settle their local children", async (t) => {
  const { client } = await fixture(t);
  const timed = await client.callTool({ name: "ssh_exec", arguments: { command: "FIXTURE_HANG", timeout_ms: 20 } });
  assert.equal(timed.structuredContent.timedOut, true);
  const started = await client.callTool({ name: "ssh_exec", arguments: { command: "FIXTURE_HANG", mode: "async" } });
  const taskId = started.structuredContent.taskId;
  const cancel = await client.callTool({ name: "ssh_task", arguments: { action: "cancel", taskId } });
  assert.equal(cancel.structuredContent.state, "cancelled");
  const waited = await client.callTool({
    name: "ssh_task", arguments: { action: "wait", taskId, wait_ms: 60000 },
  }, undefined, { timeout: 120000 });
  assert.equal(waited.structuredContent.completed, true);
  assert.equal(waited.structuredContent.task.pid, null);
  assert.equal(waited.structuredContent.task.state, "cancelled");
});

test("failed job transport preserves the recoverable ID and does not fabricate state", async (t) => {
  const { client, env } = await fixture(t, { FAKE_SSH_FAIL: "1" });
  const result = await client.callTool({ name: "ssh_job", arguments: { action: "start", command: "echo harmless" } });
  assert.equal(result.isError, true);
  assert.match(textOf(result), /outcome is unconfirmed/);
  const stored = JSON.parse(readFileSync(env.REMOTE_MCP_PERSISTENT_JOB_STORE_PATH, "utf8"));
  const [job] = Object.values(stored.jobs);
  assert.equal(job.state, "starting");
  assert.ok(textOf(result).includes(job.jobId));
  const status = await client.callTool({ name: "ssh_job", arguments: { action: "status", jobId: job.jobId } });
  assert.equal(status.isError, true);
  assert.match(textOf(status), /transport exited 255/);
  const unchanged = JSON.parse(readFileSync(env.REMOTE_MCP_PERSISTENT_JOB_STORE_PATH, "utf8")).jobs[job.jobId];
  assert.equal(unchanged.state, "starting");
});

test("job lists are backend-isolated and terminal jobs reconnect after restart", async (t) => {
  const { client, env } = await fixture(t);
  const ssh = { ...newPersistentJobRecord({ jobId: "ssh-old", backend: "ssh", maxRuntimeMs: 1000 }), state: "exited", exitCode: 7 };
  const wsl = newPersistentJobRecord({ jobId: "wsl-other", backend: "wsl", maxRuntimeMs: 1000 });
  writeFileSync(env.REMOTE_MCP_PERSISTENT_JOB_STORE_PATH, JSON.stringify({ version: 1, jobs: { "ssh-old": ssh, "wsl-other": wsl } }));
  const list = await client.callTool({ name: "ssh_job", arguments: { action: "list" } });
  assert.deepEqual(list.structuredContent.jobs.map((j) => j.jobId), ["ssh-old"]);
  const second = await connectServer("ssh", env);
  try {
    const status = await second.callTool({ name: "ssh_job", arguments: { action: "status", jobId: ssh.jobId } });
    assert.equal(status.structuredContent.exitCode, 7);
    assert.equal(status.structuredContent.state, "exited");
  } finally { await second.close(); }
});
