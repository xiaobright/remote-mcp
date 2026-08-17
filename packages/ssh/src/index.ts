#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { errorResponse } from "@remote-mcp/shared/mcp";
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

// REMOTE_MCP_FILE_API=unified 时把 7 个 ssh_file_* 合并为 1 个 ssh_file（action 区分）
if (process.env.REMOTE_MCP_FILE_API === "unified") {
  registerUnifiedRemoteFileTools(fileToolOptions);
} else {
  registerRemoteFileTools(fileToolOptions);
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

// Tool invocations go only through registerTool callbacks so MCP SDK Zod
// validation runs. Do not override CallToolRequestSchema on server.server.

server.registerTool(
  "ssh_profile",
  {
    title: "Manage SSH Target",
    description: `Manage SSH target/profile state and a lightweight non-secret device registry.
Each run starts a fresh ssh process (no persistent session; use OpenSSH ControlMaster if you need reuse).
Actions: status, set_default, clear_default, test, list_devices, get_device, upsert_device, remove_device.
Parameter and workflow details: read the remote-execution skill.`,
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
    description: `Manage async/watch SSH tasks started by ssh_exec/ssh_script with mode="async"/"watch" (on_timeout="detach").
Actions: status, output, wait, cancel, list. taskId required for status/output/wait/cancel; wait uses wait_ms; output uses stdoutOffset/stderrOffset/tail_chars/read_mode.
Use action="wait" for builds/tests. status/output are throttled server-side: querying too soon blocks to the minimum poll interval.
task dies when this MCP process exits; use ssh_job for work that must survive MCP restart.`,
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
    description: `Execute a shell command on a remote SSH target. Command is sent via stdin to the remote shell, avoiding Windows quoting issues (pipes, $(), heredocs, nested quotes).
Each call starts a fresh ssh process. Prefer sync for ordinary commands and long builds/tests; mode="async"/"watch" + ssh_task for background work. For complex multi-line commands use ssh_script.`,
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
    description: `Execute a multi-line shell script on a remote SSH target. Script is passed via stdin to the remote shell; prefer this over ssh_exec for pipes, $(), loops, heredocs, and quoting.
No persistent session: one ssh child process per call. Prefer sync for ordinary work; mode="async"/"watch" + ssh_task for background. Parameter names match wsl_script.`,
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
    description: `Manage detached persistent SSH jobs that survive MCP restart: runs detached on the remote host (setsid), logs in ~/.remote-mcp/jobs/<jobId>/ on the remote host.
Actions: start, status, output, wait, cancel, list. read_mode default "delta" (bounded tail); use "full" with offsets to page logs. Workflow details: read the remote-execution skill.`,
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
