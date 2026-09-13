#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { errorResponse } from "@remote-mcp/shared/mcp";
import { commandOutputResponse, outputResponse } from "@remote-mcp/shared/output";
import { registerHelpTool, toolFeatures } from "@remote-mcp/shared/tool-surface";
import {
  registerRemoteFileTools,
  registerUnifiedRemoteFileTools,
  type RegisterRemoteFileToolsOptions,
} from "@remote-mcp/shared/remote";
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
const features = toolFeatures();
registerHelpTool(server, "ssh", features);

const runModeSchema = z.enum(["sync", "async", "watch"]);
const timeoutBehaviorSchema = z.enum(["kill", "detach"]);

const fileToolOptions: RegisterRemoteFileToolsOptions = {
  server,
  prefix: "ssh_file",
  titlePrefix: "SSH",
  targetDescription: "Uses ssh_profile target resolution, device profiles, and SSH options.",
  targetFields: {
    target: z.string()
      .optional()
      .describe("SSH target/device; defaults to the configured target."),
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
    target: typeof params.target === "string" ? params.target : undefined,
    script,
    shell: "sh",
    login: false,
    sshOptions: Array.isArray(params.ssh_options) && params.ssh_options.every((item) => typeof item === "string")
      ? params.ssh_options as string[]
      : undefined,
    timeoutMs: typeof params.timeout_ms === "number" ? params.timeout_ms : undefined,
  }),
};

if (features.files) {
  if (features.fileApi === "unified") registerUnifiedRemoteFileTools(fileToolOptions);
  else registerRemoteFileTools(fileToolOptions);
}

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
    `\nTask ${output.task.taskId}: ${output.task.state}${output.task.exitCode !== null ? ` (exit ${output.task.exitCode})` : ""}`,
    `\nNext offsets: stdout=${output.nextStdoutOffset}, stderr=${output.nextStderrOffset}`,
    poll?.throttled ? `\nPolling was throttled inside the MCP server; waited ${poll.waitedMs} ms before returning.` : "",
  ].filter(Boolean).join("");
}

function formatPersistentJobStarted(job: { jobId: string; backend: string; state: string; jobDir: string; target?: string }): string {
  return `Job ${job.jobId}: ${job.state} on ${job.target ?? "N/A"}. Logs: ${job.jobDir}. Continue: ssh_job action="wait", jobId="${job.jobId}", wait_ms=60000.`;
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
    `\nJob ${output.job.jobId}: ${output.job.state}${output.job.exitCode !== null ? ` (exit ${output.job.exitCode})` : ""} on ${output.job.target ?? "N/A"}`,
    `\nNext offsets: stdout=${output.nextStdoutOffset}/${output.stdoutLength}, stderr=${output.nextStderrOffset}/${output.stderrLength}`,
    output.completed !== undefined ? `\nCompleted: ${output.completed}${output.timedOut ? " (timed out)" : ""}${output.waitedMs !== undefined ? ` after ${output.waitedMs} ms` : ""}` : "",
  ].filter(Boolean).join("");
}

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
      return commandOutputResponse(result, formatCommandResult);
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
      return outputResponse(formatTaskOutput(output), output);
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
      return outputResponse(formatTaskOutput(output), output);
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
      return outputResponse(formatPersistentJobOutput(output), output);
    }
    case "wait": {
      if (!params.jobId) {
        throw new Error("jobId is required for wait");
      }
      const output = await waitPersistentJob(params.jobId, params.waitMs ?? 60000, {
        stdoutOffset: params.stdoutOffset,
        stderrOffset: params.stderrOffset,
        tailChars: params.tailChars,
        readMode: params.readMode,
      });
      return outputResponse(formatPersistentJobOutput(output), output);
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
    return outputResponse(formatTaskOutput(output), output);
  }

  const result = await runSshScript(options);
  return commandOutputResponse(result, formatCommandResult);
}

// Tool invocations go only through registerTool callbacks so MCP SDK Zod
// validation runs. Do not override CallToolRequestSchema on server.server.

if (features.admin) server.registerTool(
  "ssh_profile",
  {
    title: "Manage SSH Target",
    description: `Manage default SSH target and non-secret device profiles. Ordinary execution needs no profile call. Details: ssh_help topic="connection".`,
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
    description: `Wait/read/cancel attached exec/script tasks. Lost on MCP restart; persistent work uses ssh_job. Prefer wait (default 60s); reuse offsets for capped output. Details: ssh_help topic="output".`,
    inputSchema: z.object({
      action: z.enum(["status", "output", "wait", "cancel", "list"]),
      taskId: z.string()
        .optional()
        .describe("Required for status/output/wait/cancel."),
      wait_ms: z.number()
        .int()
        .positive()
        .optional()
        .describe("Wait budget in ms; default 60000, returns early on completion."),
      stdoutOffset: z.number()
        .int()
        .nonnegative()
        .optional()
        .describe("stdout character offset from the previous result."),
      stderrOffset: z.number()
        .int()
        .nonnegative()
        .optional()
        .describe("stderr character offset from the previous result."),
      read_mode: z.enum(["delta", "full"])
        .optional()
        .describe('No offset: tail (delta) or first page (full).'),
      tail_chars: z.number()
        .int()
        .positive()
        .optional()
        .describe("Capped tail window; overrides offsets."),
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
    description: `Run a command via stdin in a fresh SSH shell. sync waits; async/watch return taskId for ssh_task. Sync timeout stops the local child, not necessarily remote descendants. Multi-line: ssh_script; persistent work: ssh_job.`,
    inputSchema: z.object({
      command: z.string()
        .min(1, "command is required")
        .describe("Shell command."),
      target: z.string()
        .optional()
        .describe("SSH target/device; defaults to the configured target."),
      shell: z.string()
        .default("bash")
        .describe("Remote shell."),
      login: z.boolean()
        .default(true)
        .describe("Use login shell mode for bash/zsh."),
      workdir: z.string()
        .optional()
        .describe("Working directory; failed cd aborts execution."),
      env: z.record(z.string())
        .optional()
        .describe("Environment for this call."),
      ssh_options: z.array(z.string())
        .optional()
        .describe('Extra ssh argv items, e.g. ["-p","2222","-i","C:/path/key"].'),
      mode: runModeSchema
        .default("sync"),
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
        .describe('No offset: tail (delta) or first page (full).'),
      tail_chars: z.number()
        .int()
        .positive()
        .optional()
        .describe("watch only: capped tail window."),
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
    description: `Run a multi-line script/heredoc via stdin in a fresh SSH shell. sync waits; async/watch use ssh_task. Sync timeout stops the local child, not necessarily remote descendants. Durable work: ssh_job.`,
    inputSchema: z.object({
      script: z.string()
        .min(1, "script is required")
        .describe("Multi-line shell script."),
      target: z.string()
        .optional()
        .describe("SSH target/device; defaults to the configured target."),
      shell: z.string()
        .default("bash")
        .describe("Remote shell."),
      login: z.boolean()
        .default(true)
        .describe("Use login shell mode for bash/zsh."),
      workdir: z.string()
        .optional()
        .describe("Working directory; failed cd aborts execution."),
      env: z.record(z.string())
        .optional()
        .describe("Environment for this call."),
      ssh_options: z.array(z.string())
        .optional()
        .describe('Extra ssh argv items, e.g. ["-p","2222","-i","C:/path/key"].'),
      mode: runModeSchema
        .default("sync"),
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
        .describe('No offset: tail (delta) or first page (full).'),
      tail_chars: z.number()
        .int()
        .positive()
        .optional()
        .describe("watch only: capped tail window."),
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
    description: `Run/manage detached bash jobs with disk logs. Survives MCP restart, not host reboot. Prefer wait over polling. Default runtime limit: 1h. Details: ssh_help topic="jobs".`,
    inputSchema: z.object({
      action: z.enum(["start", "status", "output", "wait", "cancel", "list"]),
      command: z.string()
        .optional()
        .describe("start: shell command or multi-line bash script."),
      jobId: z.string()
        .optional()
        .describe("Job UUID for status/output/wait/cancel."),
      target: z.string()
        .optional()
        .describe("start: SSH target/device; defaults to configured target."),
      workdir: z.string()
        .optional()
        .describe("start: working directory."),
      max_runtime_ms: z.number()
        .int()
        .positive()
        .optional()
        .describe("start: runtime limit in ms; default 3600000 (1h)."),
      wait_ms: z.number()
        .int()
        .positive()
        .optional()
        .describe("Wait budget in ms; default 60000, returns early on completion."),
      stdoutOffset: z.number()
        .int()
        .nonnegative()
        .optional()
        .describe("stdout byte offset from the previous result."),
      stderrOffset: z.number()
        .int()
        .nonnegative()
        .optional()
        .describe("stderr byte offset from the previous result."),
      read_mode: z.enum(["delta", "full"])
        .optional()
        .describe('No offset: tail (delta) or first page (full).'),
      tail_chars: z.number()
        .int()
        .positive()
        .optional()
        .describe("Capped tail window; overrides offsets."),
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
