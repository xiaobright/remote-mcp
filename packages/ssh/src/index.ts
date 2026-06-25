#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import {
  asRecord,
  errorResponse,
  optionalBoolean,
  optionalNumber,
  optionalString,
  optionalStringArray,
  optionalStringRecord,
  rejectUnexpectedParams,
  requireStringParam,
} from "@remote-mcp/shared/mcp";
import { registerRemoteFileTools } from "@remote-mcp/shared/remote";
import {
  cancelAllTasksSync,
  cancelTask,
  candidateTargetsFor,
  getDevice,
  getSshState,
  listDevices,
  listTasks,
  observeTaskOutput,
  observeTaskStatus,
  removeDevice,
  runSshRawScript,
  runSshScript,
  setDefaultTarget,
  startSshTask,
  testSshTarget,
  upsertDevice,
  waitTask,
  watchSshTask,
  startPersistentJob,
  getPersistentJobStatus,
  readPersistentJobOutput,
  waitPersistentJob,
  cancelPersistentJob,
  listPersistentJobs,
  type SshDeviceProfile,
  type SshReadMode,
  type SshRunMode,
  type SshTimeoutBehavior,
} from "./ssh.js";

const server = new McpServer({
  name: "ssh-mcp-server",
  version: "1.0.0",
});

const runModeSchema = z.enum(["sync", "async", "watch"]);
const timeoutBehaviorSchema = z.enum(["kill", "detach"]);

const sshFileToolHandlers = registerRemoteFileTools({
  server,
  prefix: "ssh_file",
  titlePrefix: "SSH",
  targetDescription: "Uses ssh_profile target resolution, device profiles, and SSH options.",
  targetFields: {
    target: z.string()
      .optional()
      .describe("SSH target or saved device name. Omit to use SSH_MCP_DEFAULT_TARGET or ssh_profile set_default."),
    ssh_options: z.array(z.string())
      .optional()
      .describe('Extra ssh argv items, e.g. ["-p","2222","-i","C:/path/key"].'),
    timeout_ms: z.number()
      .int()
      .positive()
      .optional()
      .describe("Timeout for each underlying SSH shell operation."),
  },
  makeRunner: (params) => (script) => runSshRawScript({
    target: optionalString(params.target),
    script,
    shell: "sh",
    login: false,
    sshOptions: optionalStringArray(params.ssh_options),
    timeoutMs: optionalNumber(params.timeout_ms),
  }),
});

function formatCommandResult(result: {
  target?: string;
  stdout: string;
  stderr: string;
  exitCode: number;
  timedOut?: boolean;
  timeoutMs?: number;
  requestedTimeoutMs?: number;
  timeoutClamped?: boolean;
}): string {
  return [
    result.target ? `Target: ${result.target}\n` : "",
    result.stdout,
    result.stderr ? `\nSTDERR:\n${result.stderr}` : "",
    result.timeoutClamped ? `\nRequested timeout ${result.requestedTimeoutMs} ms was capped at ${result.timeoutMs} ms so the MCP client can receive the result before its outer tool-call timeout.` : "",
    result.timedOut ? `\nTimed out after ${result.timeoutMs} ms and killed the local ssh process.` : "",
    `\nExit code: ${result.exitCode}`,
  ].filter(Boolean).join("");
}

function formatTaskStarted(task: { taskId: string; target: string; pid: number | null }): string {
  return `Started SSH task ${task.taskId} on ${task.target}${task.pid ? ` (local ssh pid ${task.pid})` : ""}.`;
}

function formatTaskOutput(output: {
  task: { taskId: string; state: string; target: string; exitCode: number | null };
  stdout: string;
  stderr: string;
  nextStdoutOffset: number;
  nextStderrOffset: number;
  readMode?: string;
  [key: string]: unknown;
}): string {
  const poll = output.poll as { throttled?: boolean; waitedMs?: number } | undefined;
  const requestedTimeoutMs = typeof output.requestedTimeoutMs === "number" ? output.requestedTimeoutMs : undefined;
  const requestedWaitMs = typeof output.requestedWaitMs === "number" ? output.requestedWaitMs : undefined;
  const effectiveMs = typeof output.waitMs === "number" ? output.waitMs : undefined;
  return [
    `Target: ${output.task.target}\n`,
    output.stdout,
    output.stderr ? `\nSTDERR:\n${output.stderr}` : "",
    output.timeoutClamped && requestedTimeoutMs && effectiveMs ? `\nRequested timeout ${requestedTimeoutMs} ms was capped at ${effectiveMs} ms so the MCP client can receive the result before its outer tool-call timeout.` : "",
    output.waitClamped && requestedWaitMs && effectiveMs ? `\nRequested wait ${requestedWaitMs} ms was capped at ${effectiveMs} ms so the MCP client can receive the result before its outer tool-call timeout.` : "",
    output.readMode === "full" ? "" : "\nRead mode: delta (bounded window). Use read_mode=\"full\" with offsets to page through retained output, or continue with the returned offsets.",
    `\nTask ${output.task.taskId}: ${output.task.state}${output.task.exitCode !== null ? ` (exit ${output.task.exitCode})` : ""}`,
    `\nNext offsets: stdout=${output.nextStdoutOffset}, stderr=${output.nextStderrOffset}`,
    poll?.throttled ? `\nPolling was throttled inside the MCP server; waited ${poll.waitedMs} ms before returning.` : "",
  ].filter(Boolean).join("");
}

function formatPersistentJobStarted(job: { jobId: string; backend: string; state: string; jobDir: string; target?: string }): string {
  return `Started persistent job ${job.jobId} (backend=${job.backend}, state=${job.state}, target=${job.target ?? "N/A"}). Logs at ${job.jobDir}. Use ssh_job action="status" to check progress.`;
}

function formatPersistentJobStatus(job: { jobId: string; state: string; exitCode: number | null; startedAt: string; endedAt: string | null; target?: string }): string {
  return `Job ${job.jobId}: ${job.state}${job.exitCode !== null ? ` (exit ${job.exitCode})` : ""} on ${job.target ?? "N/A"}. Started ${job.startedAt}.${job.endedAt ? ` Ended ${job.endedAt}.` : ""}`;
}

function formatPersistentJobOutput(output: {
  job: { jobId: string; state: string; exitCode: number | null; target?: string };
  stdout: string;
  stderr: string;
  nextStdoutOffset: number;
  nextStderrOffset: number;
  stdoutLength: number;
  stderrLength: number;
  readMode: string;
  completed?: boolean;
  timedOut?: boolean;
  waitedMs?: number;
}): string {
  return [
    output.stdout,
    output.stderr ? `\nSTDERR:\n${output.stderr}` : "",
    output.readMode === "full" ? "" : "\nRead mode: delta (bounded window). Use read_mode=\"full\" with offsets to page through the disk log, or continue with the returned offsets.",
    `\nJob ${output.job.jobId}: ${output.job.state}${output.job.exitCode !== null ? ` (exit ${output.job.exitCode})` : ""} on ${output.job.target ?? "N/A"}`,
    `\nNext offsets: stdout=${output.nextStdoutOffset}/${output.stdoutLength}, stderr=${output.nextStderrOffset}/${output.stderrLength}`,
    output.completed !== undefined ? `\nCompleted: ${output.completed}${output.timedOut ? " (timed out)" : ""}${output.waitedMs !== undefined ? ` after ${output.waitedMs} ms` : ""}` : "",
    "\nPersistent job: detached, logs on disk, survives MCP restart.",
  ].filter(Boolean).join("");
}

function optionalRunMode(value: unknown): SshRunMode | undefined {
  return value === "sync" || value === "async" || value === "watch" ? value : undefined;
}

function optionalTimeoutBehavior(value: unknown): SshTimeoutBehavior | undefined {
  return value === "kill" || value === "detach" ? value : undefined;
}

function optionalReadMode(value: unknown): SshReadMode | undefined {
  return value === "delta" || value === "full" ? value : undefined;
}

const sshExecParams = [
  "command",
  "env",
  "login",
  "mode",
  "on_timeout",
  "read_mode",
  "shell",
  "ssh_options",
  "tail_chars",
  "target",
  "timeout_ms",
  "workdir",
];

const sshScriptParams = [
  "env",
  "login",
  "mode",
  "on_timeout",
  "read_mode",
  "script",
  "shell",
  "ssh_options",
  "tail_chars",
  "target",
  "timeout_ms",
  "workdir",
];

const sshProfileParams = [
  "action",
  "defaultWorkdir",
  "host",
  "hosts",
  "identityFile",
  "name",
  "notes",
  "port",
  "ssh_options",
  "tags",
  "target",
  "timeout_ms",
  "user",
];

const sshTaskParams = [
  "action",
  "stderrOffset",
  "stdoutOffset",
  "read_mode",
  "tail_chars",
  "taskId",
  "wait_ms",
];

const sshJobParams = [
  "action",
  "command",
  "jobId",
  "max_runtime_ms",
  "read_mode",
  "stderrOffset",
  "stdoutOffset",
  "tail_chars",
  "target",
  "wait_ms",
  "workdir",
];

async function handleProfileAction(params: {
  action: string;
  target?: string;
  name?: string;
  user?: string;
  host?: string;
  hosts?: string[];
  port?: number;
  identityFile?: string;
  defaultWorkdir?: string;
  ssh_options?: string[];
  tags?: string[];
  notes?: string;
  timeout_ms?: number;
}) {
  switch (params.action) {
    case "status": {
      const state = getSshState();
      const lines = [
        `SSH command: ${state.sshCommand}`,
        `Default target: ${state.defaultTarget ?? "(not set)"}`,
        `Default shell: ${state.defaultShell}`,
        `Default options: ${state.defaultSshOptions.join(" ") || "(none)"}`,
        `Device store: ${state.deviceStorePath}`,
        `Devices: ${state.devices.join(", ") || "(none)"}`,
        `Tasks: ${state.runningTasks} running / ${state.taskCount} total`,
      ];
      return { content: [{ type: "text" as const, text: lines.join("\n") }], structuredContent: state };
    }
    case "set_default": {
      if (!params.target?.trim()) {
        throw new Error("target is required for set_default");
      }
      const state = setDefaultTarget(params.target);
      return {
        content: [{ type: "text" as const, text: `Default SSH target set to ${state.defaultTarget}.` }],
        structuredContent: state,
      };
    }
    case "clear_default": {
      const state = setDefaultTarget(null);
      return {
        content: [{ type: "text" as const, text: "Default SSH target cleared. Future calls must pass target explicitly." }],
        structuredContent: state,
      };
    }
    case "test": {
      const result = await testSshTarget(params.target, params.timeout_ms);
      return {
        content: [{ type: "text" as const, text: formatCommandResult(result) }],
        structuredContent: result,
      };
    }
    case "list_devices": {
      const devices = listDevices();
      return {
        content: [{
          type: "text" as const,
          text: devices.length
            ? devices.map((device) => {
              const candidates = candidateTargetsFor(device.name).map((item) => item.target).join(", ");
              return `${device.name}: ${candidates}${device.defaultWorkdir ? `  workdir=${device.defaultWorkdir}` : ""}`;
            }).join("\n")
            : "No SSH device profiles.",
        }],
        structuredContent: { devices },
      };
    }
    case "get_device": {
      const name = params.name ?? params.target;
      if (!name?.trim()) {
        throw new Error("name or target is required for get_device");
      }
      const device = getDevice(name);
      return {
        content: [{ type: "text" as const, text: JSON.stringify(device, null, 2) }],
        structuredContent: { device },
      };
    }
    case "upsert_device": {
      if (!params.name?.trim()) {
        throw new Error("name is required for upsert_device");
      }
      const profile: SshDeviceProfile = {
        name: params.name,
        target: params.target,
        user: params.user,
        host: params.host,
        hosts: params.hosts,
        port: params.port,
        identityFile: params.identityFile,
        defaultWorkdir: params.defaultWorkdir,
        sshOptions: params.ssh_options,
        tags: params.tags,
        notes: params.notes,
      };
      const device = upsertDevice(profile);
      return {
        content: [{ type: "text" as const, text: `SSH device ${device.name} saved.` }],
        structuredContent: { device },
      };
    }
    case "remove_device": {
      const name = params.name ?? params.target;
      if (!name?.trim()) {
        throw new Error("name or target is required for remove_device");
      }
      const state = removeDevice(name);
      return {
        content: [{ type: "text" as const, text: `SSH device ${name} removed.` }],
        structuredContent: state,
      };
    }
    default:
      throw new Error(`Unknown ssh_profile action: ${params.action}`);
  }
}

async function handleTaskAction(params: {
  action: string;
  taskId?: string;
  waitMs?: number;
  stdoutOffset?: number;
  stderrOffset?: number;
  tailChars?: number;
  readMode?: SshReadMode;
}) {
  switch (params.action) {
    case "list": {
      const tasks = listTasks();
      return {
        content: [{
          type: "text" as const,
          text: tasks.length
            ? tasks.map((task) => `${task.taskId}  ${task.state}  ${task.target}  ${task.command.split(/\r?\n/, 1)[0]}`).join("\n")
            : "No async SSH tasks.",
        }],
        structuredContent: { tasks },
      };
    }
    case "status": {
      if (!params.taskId) {
        throw new Error("taskId is required for status");
      }
      const task = await observeTaskStatus(params.taskId);
      const poll = task.poll as { throttled?: boolean; waitedMs?: number } | undefined;
      return {
        content: [{
          type: "text" as const,
          text: `Task ${task.taskId}: ${task.state} on ${task.target}${task.exitCode !== null ? ` (exit ${task.exitCode})` : ""}.${poll?.throttled ? ` Polling was throttled inside MCP; waited ${poll.waitedMs} ms.` : ""}`,
        }],
        structuredContent: task,
      };
    }
    case "output": {
      if (!params.taskId) {
        throw new Error("taskId is required for output");
      }
      const output = await observeTaskOutput(
        params.taskId,
        params.stdoutOffset,
        params.stderrOffset,
        params.tailChars,
        params.readMode,
      );
      return {
        content: [{ type: "text" as const, text: formatTaskOutput(output) }],
        structuredContent: output,
      };
    }
    case "wait": {
      if (!params.taskId) {
        throw new Error("taskId is required for wait");
      }
      const output = await waitTask(params.taskId, params.waitMs, {
        stdoutOffset: params.stdoutOffset,
        stderrOffset: params.stderrOffset,
        tailChars: params.tailChars,
        readMode: params.readMode,
      });
      return {
        content: [{ type: "text" as const, text: formatTaskOutput(output) }],
        structuredContent: output,
      };
    }
    case "cancel": {
      if (!params.taskId) {
        throw new Error("taskId is required for cancel");
      }
      const task = cancelTask(params.taskId);
      return {
        content: [{ type: "text" as const, text: `Task ${task.taskId}: ${task.state}.` }],
        structuredContent: task,
      };
    }
    default:
      throw new Error(`Unknown ssh_task action: ${params.action}`);
  }
}

async function handleJobAction(params: {
  action: string;
  command?: string;
  jobId?: string;
  target?: string;
  workdir?: string;
  maxRuntimeMs?: number;
  waitMs?: number;
  stdoutOffset?: number;
  stderrOffset?: number;
  tailChars?: number;
  readMode?: SshReadMode;
}) {
  switch (params.action) {
    case "start": {
      if (!params.command) {
        throw new Error("command is required for start");
      }
      const job = await startPersistentJob({
        command: params.command,
        target: params.target,
        workdir: params.workdir,
        maxRuntimeMs: params.maxRuntimeMs,
      });
      return {
        content: [{ type: "text" as const, text: formatPersistentJobStarted(job) }],
        structuredContent: job,
      };
    }
    case "status": {
      if (!params.jobId) {
        throw new Error("jobId is required for status");
      }
      const job = await getPersistentJobStatus(params.jobId);
      return {
        content: [{ type: "text" as const, text: formatPersistentJobStatus(job) }],
        structuredContent: job,
      };
    }
    case "output": {
      if (!params.jobId) {
        throw new Error("jobId is required for output");
      }
      const output = await readPersistentJobOutput(params.jobId, {
        stdoutOffset: params.stdoutOffset,
        stderrOffset: params.stderrOffset,
        tailChars: params.tailChars,
        readMode: params.readMode,
      });
      return {
        content: [{ type: "text" as const, text: formatPersistentJobOutput(output) }],
        structuredContent: output,
      };
    }
    case "wait": {
      if (!params.jobId) {
        throw new Error("jobId is required for wait");
      }
      const output = await waitPersistentJob(params.jobId, params.waitMs ?? 30000, {
        stdoutOffset: params.stdoutOffset,
        stderrOffset: params.stderrOffset,
        tailChars: params.tailChars,
        readMode: params.readMode,
      });
      return {
        content: [{ type: "text" as const, text: formatPersistentJobOutput(output) }],
        structuredContent: output,
      };
    }
    case "cancel": {
      if (!params.jobId) {
        throw new Error("jobId is required for cancel");
      }
      const job = await cancelPersistentJob(params.jobId);
      return {
        content: [{ type: "text" as const, text: `Job ${job.jobId}: ${job.state}.` }],
        structuredContent: job,
      };
    }
    case "list": {
      const jobs = listPersistentJobs();
      return {
        content: [{
          type: "text" as const,
          text: jobs.length
            ? jobs.map((job) => `${job.jobId}  ${job.state}  ${job.backend}  ${job.target ?? "N/A"}  ${job.startedAt}`).join("\n")
            : "No persistent jobs.",
        }],
        structuredContent: { jobs },
      };
    }
    default:
      throw new Error(`Unknown ssh_job action: ${params.action}`);
  }
}

async function runScriptTool(params: {
  target?: string;
  script: string;
  shell?: string;
  login?: boolean;
  workdir?: string;
  env?: Record<string, string>;
  ssh_options?: string[];
  mode?: SshRunMode;
  timeout_ms?: number;
  on_timeout?: SshTimeoutBehavior;
  tail_chars?: number;
  read_mode?: SshReadMode;
}) {
  const mode = params.mode ?? "sync";
  const options = {
    target: params.target,
    script: params.script,
    shell: params.shell,
    login: params.login,
    workdir: params.workdir,
    env: params.env,
    sshOptions: params.ssh_options,
    timeoutMs: params.timeout_ms,
  };

  if (mode === "async") {
    const task = await startSshTask(options);
    return { content: [{ type: "text" as const, text: formatTaskStarted(task) }], structuredContent: task };
  }
  if (mode === "watch") {
    const output = await watchSshTask(options, params.timeout_ms, params.on_timeout ?? "detach", {
      tailChars: params.tail_chars,
      readMode: params.read_mode,
    });
    return { content: [{ type: "text" as const, text: formatTaskOutput(output) }], structuredContent: output };
  }

  const result = await runSshScript(options);
  return { content: [{ type: "text" as const, text: formatCommandResult(result) }], structuredContent: result };
}

async function dispatchToolCall(name: string, argsInput: unknown) {
  const args = asRecord(argsInput);
  const fileHandler = sshFileToolHandlers[name];
  if (fileHandler) {
    return fileHandler(args);
  }

  switch (name) {
    case "ssh_profile":
      rejectUnexpectedParams(args, sshProfileParams, "ssh_profile");
      return handleProfileAction({
        action: requireStringParam(args, "action", "ssh_profile"),
        target: optionalString(args.target),
        name: optionalString(args.name),
        user: optionalString(args.user),
        host: optionalString(args.host),
        hosts: optionalStringArray(args.hosts),
        port: optionalNumber(args.port),
        identityFile: optionalString(args.identityFile),
        defaultWorkdir: optionalString(args.defaultWorkdir),
        ssh_options: optionalStringArray(args.ssh_options),
        tags: optionalStringArray(args.tags),
        notes: optionalString(args.notes),
        timeout_ms: optionalNumber(args.timeout_ms),
      });
    case "ssh_task":
      rejectUnexpectedParams(args, sshTaskParams, "ssh_task", {
        tailChars: 'ssh_task expects "tail_chars"; camelCase "tailChars" is not supported.',
      });
      return handleTaskAction({
        action: requireStringParam(args, "action", "ssh_task"),
        taskId: optionalString(args.taskId),
        waitMs: optionalNumber(args.wait_ms),
        stdoutOffset: optionalNumber(args.stdoutOffset),
        stderrOffset: optionalNumber(args.stderrOffset),
        readMode: optionalReadMode(args.read_mode),
        tailChars: optionalNumber(args.tail_chars),
      });
    case "ssh_exec":
      rejectUnexpectedParams(args, sshExecParams, "ssh_exec", {
        script: 'ssh_exec expects "command"; use ssh_script when you want the parameter to be named "script".',
      });
      return runScriptTool({
        target: optionalString(args.target),
        script: requireStringParam(args, "command", "ssh_exec"),
        shell: optionalString(args.shell),
        login: optionalBoolean(args.login),
        workdir: optionalString(args.workdir),
        env: optionalStringRecord(args.env),
        ssh_options: optionalStringArray(args.ssh_options),
        mode: optionalRunMode(args.mode),
        timeout_ms: optionalNumber(args.timeout_ms),
        on_timeout: optionalTimeoutBehavior(args.on_timeout),
        read_mode: optionalReadMode(args.read_mode),
        tail_chars: optionalNumber(args.tail_chars),
      });
    case "ssh_script":
      rejectUnexpectedParams(args, sshScriptParams, "ssh_script", {
        command: 'ssh_script expects "script"; use ssh_exec when you want the parameter to be named "command".',
      });
      return runScriptTool({
        target: optionalString(args.target),
        script: requireStringParam(args, "script", "ssh_script"),
        shell: optionalString(args.shell),
        login: optionalBoolean(args.login),
        workdir: optionalString(args.workdir),
        env: optionalStringRecord(args.env),
        ssh_options: optionalStringArray(args.ssh_options),
        mode: optionalRunMode(args.mode),
        timeout_ms: optionalNumber(args.timeout_ms),
        on_timeout: optionalTimeoutBehavior(args.on_timeout),
        read_mode: optionalReadMode(args.read_mode),
        tail_chars: optionalNumber(args.tail_chars),
      });
    case "ssh_job":
      rejectUnexpectedParams(args, sshJobParams, "ssh_job");
      return handleJobAction({
        action: requireStringParam(args, "action", "ssh_job"),
        command: optionalString(args.command),
        jobId: optionalString(args.jobId),
        target: optionalString(args.target),
        workdir: optionalString(args.workdir),
        maxRuntimeMs: optionalNumber(args.max_runtime_ms),
        waitMs: optionalNumber(args.wait_ms),
        stdoutOffset: optionalNumber(args.stdoutOffset),
        stderrOffset: optionalNumber(args.stderrOffset),
        readMode: optionalReadMode(args.read_mode),
        tailChars: optionalNumber(args.tail_chars),
      });
    default:
      return {
        content: [{ type: "text" as const, text: `Error: Tool ${name} not found` }],
        isError: true,
      };
  }
}

server.registerTool(
  "ssh_profile",
  {
    title: "Manage SSH Target",
    description: `Unified process-local SSH target/profile helper and lightweight device registry.

This SSH MCP intentionally does not keep a long-lived remote shell. Each run
starts a fresh local ssh process. That keeps remote state clean and avoids
hanging sessions. Use OpenSSH ControlMaster in ssh_options or ~/.ssh/config if
you later need connection reuse.

Device profiles are non-secret connection records. They can store a friendly
name, user, one or more candidate hosts/IPs, port, identityFile, ssh_options,
tags, and defaultWorkdir. They must not store passwords. When a target matches a
device name, ssh_exec/ssh_script try the remembered last target first, then the
saved target/host/hosts until one connects. Successful connections update
lastResolvedTarget and lastSeen.

Actions:
  - status: show default target, ssh command, default options, task count.
  - list_devices: list saved device profiles and candidate targets.
  - get_device: show one saved profile by name.
  - upsert_device: create/update a profile.
  - remove_device: delete a saved profile.
  - set_default: set this MCP process's default target, e.g. devbox or user@example.com.
  - clear_default: clear default target.
  - test: run a small read-only probe on the target/device, trying saved hosts in order.

This is the SSH counterpart to wsl_session. Use ssh_profile only for target
state; use ssh_exec/ssh_script for execution and ssh_task for async/watch tasks.`,
    inputSchema: z.object({
      action: z.enum(["status", "set_default", "clear_default", "test", "list_devices", "get_device", "upsert_device", "remove_device"]),
      name: z.string()
        .optional()
        .describe("Device profile name for get_device/upsert_device/remove_device, e.g. rock5a."),
      target: z.string()
        .optional()
        .describe("SSH target or device name, for example devbox, user@example.com, or a Host alias from ~/.ssh/config."),
      user: z.string()
        .optional()
        .describe("Device username for upsert_device, e.g. alice."),
      host: z.string()
        .optional()
        .describe("Primary host/IP for upsert_device."),
      hosts: z.array(z.string())
        .optional()
        .describe("Candidate hosts/IPs for upsert_device; tried in order after lastResolvedTarget/target/host."),
      port: z.number()
        .int()
        .positive()
        .optional()
        .describe("SSH port for upsert_device."),
      identityFile: z.string()
        .optional()
        .describe("Identity file path for upsert_device; stored as non-secret metadata."),
      defaultWorkdir: z.string()
        .optional()
        .describe("Default remote workdir used by ssh_exec/ssh_script when workdir is omitted."),
      ssh_options: z.array(z.string())
        .optional()
        .describe('Per-device extra ssh argv items, e.g. ["-o","ServerAliveInterval=30"].'),
      tags: z.array(z.string())
        .optional()
        .describe("Optional device tags, e.g. rk3588/devboard."),
      notes: z.string()
        .optional()
        .describe("Short non-secret notes."),
      timeout_ms: z.number()
        .int()
        .positive()
        .optional()
        .describe("Timeout for action=test in milliseconds."),
    }).strict(),
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
  },
  async (params: {
    action: string;
    name?: string;
    target?: string;
    user?: string;
    host?: string;
    hosts?: string[];
    port?: number;
    identityFile?: string;
    defaultWorkdir?: string;
    ssh_options?: string[];
    tags?: string[];
    notes?: string;
    timeout_ms?: number;
  }) => {
    try {
      return await handleProfileAction(params);
    } catch (error) {
      return errorResponse(error);
    }
  },
);

server.registerTool(
  "ssh_task",
  {
    title: "Manage SSH Async Task",
    description: `Unified async/watch SSH task manager for tasks started by ssh_exec/ssh_script
with mode="async" or mode="watch" and on_timeout="detach".

Actions:
  - status: get state and output lengths.
  - output: read stdout/stderr with offsets or tail_chars.
  - wait: block inside this MCP server for wait_ms, returning early if the task exits.
  - cancel: kill the owned local ssh child process.
  - list: list process-local tasks.

Parameter names intentionally match wsl_task:
  - taskId is required for status/output/wait/cancel.
  - wait uses wait_ms.
  - output offsets use stdoutOffset/stderrOffset.
  - read_mode defaults to a bounded delta window; use "full" with offsets to page retained output.
  - task output tailing uses tail_chars.

Prefer synchronous ssh_exec/ssh_script for normal commands and long builds/tests
when there is no other foreground work to do. Use mode="async" only when real
background concurrency is needed. Use action="wait" for builds/tests. status/output
are throttled by the MCP server: if queried too soon for a running task, the tool
blocks until the minimum poll interval is reached, then returns a warning plus the
real result.`,
    inputSchema: z.object({
      action: z.enum(["status", "output", "wait", "cancel", "list"]),
      taskId: z.string()
        .optional()
        .describe("Required for status/output/wait/cancel."),
      wait_ms: z.number()
        .int()
        .positive()
        .optional()
        .describe("For action=wait, maximum time to block before returning current output."),
      stdoutOffset: z.number()
        .int()
        .nonnegative()
        .optional()
        .describe("Read stdout starting at this character offset."),
      stderrOffset: z.number()
        .int()
        .nonnegative()
        .optional()
        .describe("Read stderr starting at this character offset."),
      read_mode: z.enum(["delta", "full"])
        .optional()
        .describe('Read mode: "delta" returns a bounded recent window by default; "full" pages from the requested offset.'),
      tail_chars: z.number()
        .int()
        .positive()
        .optional()
        .describe("If set, ignore offsets and read only the last N characters from each stream."),
    }).strict(),
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
  },
  async (params: {
    action: string;
    taskId?: string;
    wait_ms?: number;
    stdoutOffset?: number;
    stderrOffset?: number;
    read_mode?: SshReadMode;
    tail_chars?: number;
  }) => {
    try {
      return await handleTaskAction({
        ...params,
        waitMs: params.wait_ms,
        readMode: params.read_mode,
        tailChars: params.tail_chars,
      });
    } catch (error) {
      return errorResponse(error);
    }
  },
);

server.registerTool(
  "ssh_exec",
  {
    title: "Run SSH Command",
    description: `Execute a shell command on a remote SSH target.

The command is sent to the remote shell through stdin, not embedded into a
PowerShell/cmd ssh command line. This avoids local Windows escaping problems
with pipes, redirection, here-docs, $(), $VAR, and nested quotes.

Each call starts a fresh local ssh process. For complex commands, prefer
ssh_script so the model can write a clear multi-line script.

Args:
  - command (string, required): The shell command to execute.
    Example: "ls -la /home"
  - target (string, optional): SSH target or saved device name. Omit to use
    SSH_MCP_DEFAULT_TARGET or ssh_profile set_default.
  - shell (string, optional): Remote shell to run. Default: "bash".
  - login (boolean, optional): Use login shell mode for bash/zsh. Default: true.
  - workdir (string, optional): Remote working directory.
  - env (object, optional): Environment variables exported before running.
  - ssh_options (string[], optional): Extra ssh argv items.
  - mode: "sync" (default), "async", or "watch".
    sync waits for completion and kills the local ssh process if timeout_ms is reached.
    async returns a taskId immediately.
    watch waits up to timeout_ms, then either detaches or kills depending on on_timeout.
  - timeout_ms: sync/watch timeout in milliseconds. Long requested timeouts may be capped
    internally so the MCP client can still receive a timeout result.
  - on_timeout: for watch only, "detach" (default) or "kill".
  - read_mode: for watch output, "delta" (default) keeps a bounded window; "full" pages from the requested offset.
  - tail_chars: for watch output, return only the tail of each stream.

Parameter names intentionally match wsl_exec/wsl_script. Prefer sync mode for
ordinary commands and long builds/tests when there is no other work to do. Start
background work by passing mode="async" here only when necessary. For complex
commands, use ssh_script instead of local PowerShell/cmd ssh command-line
composition.

Returns:
  sync: { target, stdout, stderr, exitCode, timedOut?, timeoutMs? }
  async: task snapshot
  watch: task output snapshot plus detached/killed/timedOut fields

Examples:
  - command="ls -la /home"                            -> list remote home directory
  - command="uname -a"                                -> short remote command
  - target="devbox" + command="uptime"                -> saved device profile
  - target="user@example.com" + command="uptime"      -> explicit target
  - workdir="/home/alice/project" + command="npm test"
  - mode="watch", timeout_ms=120000 for builds that may take a while

Error Handling:
  - Returns stdout/stderr and non-zero exitCode on failure
  - Returns SSH connection/auth/host-key errors in stderr or as Error text`,
    inputSchema: z.object({
      command: z.string()
        .min(1, "command is required")
        .describe("Shell command to execute on the remote target."),
      target: z.string()
        .optional()
        .describe("SSH target or saved device name. Omit to use SSH_MCP_DEFAULT_TARGET or ssh_profile set_default."),
      shell: z.string()
        .default("bash")
        .describe("Remote shell to run. Default: bash."),
      login: z.boolean()
        .default(true)
        .describe("Use login shell mode for bash/zsh."),
      workdir: z.string()
        .optional()
        .describe("Remote working directory."),
      env: z.record(z.string())
        .optional()
        .describe("Environment variables exported before running the command."),
      ssh_options: z.array(z.string())
        .optional()
        .describe('Extra ssh argv items, e.g. ["-p","2222","-i","C:/path/key"].'),
      mode: runModeSchema
        .default("sync")
        .describe('Execution mode: "sync", "async", or "watch".'),
      timeout_ms: z.number()
        .int()
        .positive()
        .optional()
        .describe("sync/watch timeout in milliseconds."),
      on_timeout: timeoutBehaviorSchema
        .default("detach")
        .describe('watch timeout behavior: "detach" keeps the task running; "kill" cancels it.'),
      read_mode: z.enum(["delta", "full"])
        .optional()
        .describe('Read mode: "delta" returns a bounded recent window by default; "full" pages from the requested offset.'),
      tail_chars: z.number()
        .int()
        .positive()
        .optional()
        .describe("For watch mode, return only the last N characters from each stream."),
    }).strict(),
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    },
  },
  async (params: {
    command: string;
    target?: string;
    shell?: string;
    login?: boolean;
    workdir?: string;
    env?: Record<string, string>;
    ssh_options?: string[];
    mode?: SshRunMode;
    timeout_ms?: number;
    on_timeout?: SshTimeoutBehavior;
    read_mode?: SshReadMode;
    tail_chars?: number;
  }) => {
    try {
      return await runScriptTool({
        ...params,
        script: params.command,
      });
    } catch (error) {
      return errorResponse(error);
    }
  },
);

server.registerTool(
  "ssh_script",
  {
    title: "Run SSH Script",
    description: `Execute a multi-line shell script on a remote SSH target.

The script is passed via ssh stdin to the remote shell. This is the main tool
for avoiding local quoting and escaping traps when running remote Linux
commands from Windows.

This tool does not create or reuse a persistent SSH session. It starts one local
ssh child process per call, which is usually fast enough on LAN and keeps remote
state predictable.

Args:
  - script (string, required): Script content to execute. Can be multiple lines.
    Example: "echo hello\\necho world"
  - target (string, optional): SSH target or saved device name. Omit to use
    SSH_MCP_DEFAULT_TARGET or ssh_profile set_default.
  - shell (string, optional): Remote shell to run. Default: "bash".
  - login (boolean, optional): Use login shell mode for bash/zsh. Default: true.
  - workdir (string, optional): Remote working directory.
  - env (object, optional): Environment variables exported before running.
  - ssh_options (string[], optional): Extra ssh argv items.
  - mode: "sync" (default), "async", or "watch".
  - timeout_ms: sync/watch timeout in milliseconds. Long requested timeouts may be capped
    internally so the MCP client can still receive a timeout result.
  - on_timeout: for watch only, "detach" (default) or "kill".
  - read_mode: for watch output, "delta" (default) keeps a bounded window; "full" pages from the requested offset.
  - tail_chars: for watch output, return only the tail of each stream.

Parameter names intentionally match wsl_exec/wsl_script. Prefer sync mode for
ordinary commands and long builds/tests when there is no other work to do. Start
background work by passing mode="async" here only when necessary.

Returns:
  Same as ssh_exec: sync command result, async task snapshot, or watch output.

Examples:
  - script="git status\\ngit log --oneline -3"        -> run multiple commands
  - script="for f in *.txt; do echo $f; done"         -> shell loop
  - shell="zsh" + script="echo $ZSH_VERSION"          -> use specific shell
  - mode="watch", timeout_ms=120000 for builds that may take a while

Error Handling:
  - Same as ssh_exec`,
    inputSchema: z.object({
      script: z.string()
        .min(1, "script is required")
        .describe("Multi-line script content to execute on the remote target."),
      target: z.string()
        .optional()
        .describe("SSH target or saved device name. Omit to use SSH_MCP_DEFAULT_TARGET or ssh_profile set_default."),
      shell: z.string()
        .default("bash")
        .describe("Remote shell to run. Default: bash."),
      login: z.boolean()
        .default(true)
        .describe("Use login shell mode for bash/zsh."),
      workdir: z.string()
        .optional()
        .describe("Remote working directory."),
      env: z.record(z.string())
        .optional()
        .describe("Environment variables exported before running the script."),
      ssh_options: z.array(z.string())
        .optional()
        .describe('Extra ssh argv items, e.g. ["-p","2222","-i","C:/path/key"].'),
      mode: runModeSchema
        .default("sync")
        .describe('Execution mode: "sync", "async", or "watch".'),
      timeout_ms: z.number()
        .int()
        .positive()
        .optional()
        .describe("sync/watch timeout in milliseconds."),
      on_timeout: timeoutBehaviorSchema
        .default("detach")
        .describe('watch timeout behavior: "detach" keeps the task running; "kill" cancels it.'),
      read_mode: z.enum(["delta", "full"])
        .optional()
        .describe('Read mode: "delta" returns a bounded recent window by default; "full" pages from the requested offset.'),
      tail_chars: z.number()
        .int()
        .positive()
        .optional()
        .describe("For watch mode, return only the last N characters from each stream."),
    }).strict(),
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    },
  },
  async (params: {
    script: string;
    target?: string;
    shell?: string;
    login?: boolean;
    workdir?: string;
    env?: Record<string, string>;
    ssh_options?: string[];
    mode?: SshRunMode;
    timeout_ms?: number;
    on_timeout?: SshTimeoutBehavior;
    read_mode?: SshReadMode;
    tail_chars?: number;
  }) => {
    try {
      return await runScriptTool(params);
    } catch (error) {
      return errorResponse(error);
    }
  },
);

server.registerTool(
  "ssh_job",
  {
    title: "Manage SSH Persistent Job",
    description: `Detached persistent job manager for SSH. Unlike ssh_task (attached, dies with MCP),
persistent jobs run fully detached inside the remote SSH host via setsid. Logs
and pid files live in ~/.remote-mcp/jobs/<jobId>/ on the remote host; metadata
is stored on the Windows side. Any agent with the jobId can re-attach, read
logs, or cancel — even after MCP or Codex restarts.

Actions:
  - start: launch a detached command on the remote host. Returns jobId immediately.
  - status: check job state (running/exited/cancelled/expired).
  - output: read stdout/stderr logs with offsets or tail_chars.
  - wait: poll until the job exits or wait_ms elapses, then return output.
  - cancel: send SIGTERM to the job's process group on the remote host.
  - list: list all known persistent jobs.

Use ssh_job for long-running tasks like remote firmware builds that may outlive
the MCP process. Default read_mode is "delta" (bounded tail window) to prevent
context explosion; use read_mode="full" with stdoutOffset/stderrOffset to page
through complete logs without a single huge response.

Parameters:
  - action (required): start | status | output | wait | cancel | list
  - command (required for start): shell command to execute detached on the remote host.
  - jobId (required for status/output/wait/cancel): UUID returned by start.
  - target (optional, for start): SSH target or device name. Omit to use default.
  - workdir (optional, for start): remote working directory.
  - max_runtime_ms (optional, for start): auto-expire deadline. Default 1h.
  - wait_ms (optional, for wait): max poll duration. Default 30000.
  - stdoutOffset/stderrOffset: byte offsets for incremental reads.
  - tail_chars: read only the last N characters from each stream.
  - read_mode: "delta" (default) or "full".`,
    inputSchema: z.object({
      action: z.enum(["start", "status", "output", "wait", "cancel", "list"]),
      command: z.string()
        .optional()
        .describe("Shell command for action=start. Runs detached via setsid on the remote host."),
      jobId: z.string()
        .optional()
        .describe("Job UUID for status/output/wait/cancel."),
      target: z.string()
        .optional()
        .describe("SSH target or saved device name for action=start. Omit to use SSH_MCP_DEFAULT_TARGET."),
      workdir: z.string()
        .optional()
        .describe("Remote working directory for action=start."),
      max_runtime_ms: z.number()
        .int()
        .positive()
        .optional()
        .describe("Auto-expire deadline for action=start. Default 3600000 (1h)."),
      wait_ms: z.number()
        .int()
        .positive()
        .optional()
        .describe("Max poll duration for action=wait. Default 30000."),
      stdoutOffset: z.number()
        .int()
        .nonnegative()
        .optional()
        .describe("Read stdout starting at this byte offset."),
      stderrOffset: z.number()
        .int()
        .nonnegative()
        .optional()
        .describe("Read stderr starting at this byte offset."),
      read_mode: z.enum(["delta", "full"])
        .optional()
        .describe('"delta" (default) returns a bounded tail window; "full" reads one capped page from the requested offset.'),
      tail_chars: z.number()
        .int()
        .positive()
        .optional()
        .describe("If set, ignore offsets and read only the last N characters from each stream."),
    }).strict(),
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
  },
  async (params: {
    action: string;
    command?: string;
    jobId?: string;
    target?: string;
    workdir?: string;
    max_runtime_ms?: number;
    wait_ms?: number;
    stdoutOffset?: number;
    stderrOffset?: number;
    read_mode?: SshReadMode;
    tail_chars?: number;
  }) => {
    try {
      return await handleJobAction({
        ...params,
        maxRuntimeMs: params.max_runtime_ms,
        waitMs: params.wait_ms,
        readMode: params.read_mode,
        tailChars: params.tail_chars,
      });
    } catch (error) {
      return errorResponse(error);
    }
  },
);

function cleanup() {
  cancelAllTasksSync();
}

process.on("exit", cleanup);
process.on("SIGINT", () => { cleanup(); process.exit(0); });
process.on("SIGHUP", () => { cleanup(); process.exit(0); });

server.server.setRequestHandler(CallToolRequestSchema, async (request) => {
  try {
    return await dispatchToolCall(request.params.name, request.params.arguments);
  } catch (error) {
    return errorResponse(error);
  }
});

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  const state = getSshState();
  console.error(`ssh-mcp-server running via stdio (default target: ${state.defaultTarget ?? "not set"})`);
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
