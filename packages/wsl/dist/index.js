#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { errorResponse } from "@remote-mcp/shared/mcp";
import { registerRemoteFileTools } from "@remote-mcp/shared/remote";
import { execWsl, execWslAsync, execWslScript, execWslScriptAsync, runWslRawScript, watchWslTask, startSession, stopSession, stopSessionSync, cancelAllTasksSync, cancelTask, setDistro, getDistro, getDefaultDistro, getSessionState, observeTaskOutput, observeTaskStatus, listDistros, listTasks, waitTask, startPersistentJob, getPersistentJobStatus, readPersistentJobOutput, waitPersistentJob, cancelPersistentJob, listPersistentJobs, } from "./wsl.js";
const server = new McpServer({
    name: "wsl-mcp-server",
    version: "1.0.0",
});
function formatDistro(distro) {
    return distro ?? "(system default)";
}
const runModeSchema = z.enum(["sync", "async", "watch"]);
const timeoutBehaviorSchema = z.enum(["kill", "detach"]);
const distroField = z.string()
    .optional()
    .describe('Optional one-shot distro override (e.g. "Ubuntu-22.04"). Does not change the process session default. Pass "default" for system default.');
registerRemoteFileTools({
    server,
    prefix: "wsl_file",
    titlePrefix: "WSL",
    targetDescription: "Uses this MCP process's configured WSL distro and keepalive session. Optional distro overrides one call only.",
    targetFields: {
        timeout_ms: z.number()
            .int()
            .positive()
            .optional()
            .describe("Timeout for each underlying WSL shell operation."),
        distro: distroField,
    },
    makeRunner: (params) => async (script) => {
        const distro = await resolveRequestedDistro(typeof params.distro === "string" ? params.distro : undefined);
        return runWslRawScript(script, {
            timeoutMs: typeof params.timeout_ms === "number" ? params.timeout_ms : undefined,
            distro,
        });
    },
});
function formatCommandResult(result) {
    return [
        result.stdout,
        result.stderr ? `\nSTDERR:\n${result.stderr}` : "",
        result.timeoutClamped ? `\nRequested timeout ${result.requestedTimeoutMs} ms was capped at ${result.timeoutMs} ms so the MCP client has time to receive the result before its outer tool-call timeout.` : "",
        result.timedOut ? `\nTimed out after ${result.timeoutMs} ms and killed the WSL child process.` : "",
        `\nExit code: ${result.exitCode}`,
    ].filter(Boolean).join("");
}
function formatTaskStarted(task) {
    return `Started WSL task ${task.taskId} on ${formatDistro(task.configuredDistro)}${task.pid ? ` (pid ${task.pid})` : ""}.`;
}
function formatTaskOutput(output) {
    const poll = output.poll;
    const requestedTimeoutMs = typeof output.requestedTimeoutMs === "number" ? output.requestedTimeoutMs : undefined;
    const requestedWaitMs = typeof output.requestedWaitMs === "number" ? output.requestedWaitMs : undefined;
    const effectiveMs = typeof output.waitMs === "number" ? output.waitMs : undefined;
    return [
        output.stdout,
        output.stderr ? `\nSTDERR:\n${output.stderr}` : "",
        output.timeoutClamped && requestedTimeoutMs && effectiveMs ? `\nRequested timeout ${requestedTimeoutMs} ms was capped at ${effectiveMs} ms so the MCP client has time to receive the result before its outer tool-call timeout.` : "",
        output.waitClamped && requestedWaitMs && effectiveMs ? `\nRequested wait ${requestedWaitMs} ms was capped at ${effectiveMs} ms so the MCP client has time to receive the result before its outer tool-call timeout.` : "",
        output.readMode === "full" ? "" : "\nRead mode: delta (bounded window). Use read_mode=\"full\" with offsets to page through retained output, or continue with the returned offsets.",
        `\nTask ${output.task.taskId}: ${output.task.state}`,
        `\nNext offsets: stdout=${output.nextStdoutOffset}, stderr=${output.nextStderrOffset}`,
        poll?.throttled ? `\nPolling was throttled inside the MCP server; waited ${poll.waitedMs} ms before returning.` : "",
    ].filter(Boolean).join("");
}
function formatPersistentJobStarted(job) {
    return `Started persistent job ${job.jobId} (backend=${job.backend}, state=${job.state}). Logs at ${job.jobDir}. Use wsl_job action="status" to check progress.`;
}
function formatPersistentJobStatus(job) {
    return `Job ${job.jobId}: ${job.state}${job.exitCode !== null ? ` (exit ${job.exitCode})` : ""}. Started ${job.startedAt}.${job.endedAt ? ` Ended ${job.endedAt}.` : ""}`;
}
function formatPersistentJobOutput(output) {
    return [
        output.stdout,
        output.stderr ? `\nSTDERR:\n${output.stderr}` : "",
        output.readMode === "full" ? "" : "\nRead mode: delta (bounded window). Use read_mode=\"full\" with offsets to page through the disk log, or continue with the returned offsets.",
        `\nJob ${output.job.jobId}: ${output.job.state}${output.job.exitCode !== null ? ` (exit ${output.job.exitCode})` : ""}`,
        `\nNext offsets: stdout=${output.nextStdoutOffset}/${output.stdoutLength}, stderr=${output.nextStderrOffset}/${output.stderrLength}`,
        output.completed !== undefined ? `\nCompleted: ${output.completed}${output.timedOut ? " (timed out)" : ""}${output.waitedMs !== undefined ? ` after ${output.waitedMs} ms` : ""}` : "",
        "\nPersistent job: detached, logs on disk, survives MCP restart.",
    ].filter(Boolean).join("");
}
async function handleSessionAction(params) {
    switch (params.action) {
        case "status": {
            const state = getSessionState();
            const lines = [
                `Session: ${state.running ? "running" : "stopped"}`,
                `Configured distro: ${formatDistro(state.configuredDistro)}`,
                `Default startup distro: ${state.defaultDistro}`,
                state.pid ? `Keepalive PID: ${state.pid}` : null,
                state.lastError ? `Last error: ${state.lastError}` : null,
            ].filter(Boolean);
            return { content: [{ type: "text", text: lines.join("\n") }], structuredContent: state };
        }
        case "start": {
            const requested = await resolveRequestedDistro(params.distro);
            const configured = requested === undefined ? getDistro() : requested;
            if (configured) {
                await ensureInstalledDistro(configured);
            }
            const state = await startSession(requested);
            return {
                content: [{ type: "text", text: `WSL session started for ${formatDistro(state.configuredDistro)}.` }],
                structuredContent: state,
            };
        }
        case "stop": {
            const state = await stopSession();
            return {
                content: [{ type: "text", text: `WSL session stopped. Configured distro remains ${formatDistro(state.configuredDistro)}.` }],
                structuredContent: state,
            };
        }
        case "set_distro": {
            if (!params.distro) {
                throw new Error("distro is required for set_distro");
            }
            const distro = await resolveRequestedDistro(params.distro);
            const change = await setDistro(distro ?? null);
            const current = getDistro();
            return {
                content: [{
                        type: "text",
                        text: change.changed
                            ? `Configured distro set to ${formatDistro(current)}.${change.stoppedSession ? " This process's keepalive was stopped and will auto-start on demand." : ""}`
                            : `Configured distro is already ${formatDistro(current)}.`,
                    }],
                structuredContent: { distro: current, running: getSessionState().running },
            };
        }
        case "list_distros": {
            const distros = await listDistros();
            const current = getDistro();
            return {
                content: [{
                        type: "text",
                        text: [
                            `Configured distro: ${formatDistro(current)}`,
                            `Default startup distro: ${getDefaultDistro()}`,
                            "",
                            "Installed distributions:",
                            ...distros.map((d) => `  - ${d}`),
                        ].join("\n"),
                    }],
                structuredContent: { distros, current, defaultDistro: getDefaultDistro() },
            };
        }
        default:
            throw new Error(`Unknown wsl_session action: ${params.action}`);
    }
}
async function handleTaskAction(params) {
    switch (params.action) {
        case "list": {
            const tasks = listTasks();
            return {
                content: [{
                        type: "text",
                        text: tasks.length
                            ? tasks.map((task) => `${task.taskId}  ${task.state}  ${formatDistro(task.configuredDistro)}  ${task.command}`).join("\n")
                            : "No async WSL tasks.",
                    }],
                structuredContent: { tasks },
            };
        }
        case "status": {
            if (!params.taskId) {
                throw new Error("taskId is required for status");
            }
            const task = await observeTaskStatus(params.taskId);
            const poll = task.poll;
            return {
                content: [{
                        type: "text",
                        text: `Task ${task.taskId}: ${task.state}${task.exitCode !== null ? ` (exit ${task.exitCode})` : ""}.${poll?.throttled ? ` Polling was throttled inside MCP; waited ${poll.waitedMs} ms.` : ""}`,
                    }],
                structuredContent: task,
            };
        }
        case "output": {
            if (!params.taskId) {
                throw new Error("taskId is required for output");
            }
            const output = await observeTaskOutput(params.taskId, params.stdoutOffset, params.stderrOffset, params.tailChars, params.readMode);
            return {
                content: [{ type: "text", text: formatTaskOutput(output) }],
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
                content: [{ type: "text", text: formatTaskOutput(output) }],
                structuredContent: output,
            };
        }
        case "cancel": {
            if (!params.taskId) {
                throw new Error("taskId is required for cancel");
            }
            const task = cancelTask(params.taskId);
            return {
                content: [{ type: "text", text: `Task ${task.taskId}: ${task.state}.` }],
                structuredContent: task,
            };
        }
        default:
            throw new Error(`Unknown wsl_task action: ${params.action}`);
    }
}
async function handleJobAction(params) {
    switch (params.action) {
        case "start": {
            if (!params.command) {
                throw new Error("command is required for start");
            }
            const distro = await resolveRequestedDistro(params.distro);
            const job = await startPersistentJob({
                command: params.command,
                workdir: params.workdir,
                maxRuntimeMs: params.maxRuntimeMs,
                distro,
            });
            return {
                content: [{ type: "text", text: formatPersistentJobStarted(job) }],
                structuredContent: job,
            };
        }
        case "status": {
            if (!params.jobId) {
                throw new Error("jobId is required for status");
            }
            const job = await getPersistentJobStatus(params.jobId);
            return {
                content: [{ type: "text", text: formatPersistentJobStatus(job) }],
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
                content: [{ type: "text", text: formatPersistentJobOutput(output) }],
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
                content: [{ type: "text", text: formatPersistentJobOutput(output) }],
                structuredContent: output,
            };
        }
        case "cancel": {
            if (!params.jobId) {
                throw new Error("jobId is required for cancel");
            }
            const job = await cancelPersistentJob(params.jobId);
            return {
                content: [{ type: "text", text: `Job ${job.jobId}: ${job.state}.` }],
                structuredContent: job,
            };
        }
        case "list": {
            const jobs = listPersistentJobs();
            return {
                content: [{
                        type: "text",
                        text: jobs.length
                            ? jobs.map((job) => `${job.jobId}  ${job.state}  ${job.backend}  ${job.startedAt}`).join("\n")
                            : "No persistent jobs.",
                    }],
                structuredContent: { jobs },
            };
        }
        default:
            throw new Error(`Unknown wsl_job action: ${params.action}`);
    }
}
async function runCommandTool(params) {
    const mode = params.mode ?? "sync";
    const distro = await resolveRequestedDistro(params.distro);
    if (mode === "async") {
        const task = await execWslAsync(params.command, params.workdir, { distro });
        return { content: [{ type: "text", text: formatTaskStarted(task) }], structuredContent: task };
    }
    if (mode === "watch") {
        const output = await watchWslTask(params.command, "bash", params.workdir, params.timeout_ms, params.on_timeout ?? "detach", {
            tailChars: params.tail_chars,
            readMode: params.read_mode,
        }, distro);
        return { content: [{ type: "text", text: formatTaskOutput(output) }], structuredContent: output };
    }
    const result = await execWsl(params.command, params.workdir, { timeoutMs: params.timeout_ms, distro });
    return { content: [{ type: "text", text: formatCommandResult(result) }], structuredContent: result };
}
async function runScriptTool(params) {
    const shell = params.shell ?? "bash";
    const mode = params.mode ?? "sync";
    const distro = await resolveRequestedDistro(params.distro);
    if (mode === "async") {
        const task = await execWslScriptAsync(params.script, shell, params.workdir, { distro });
        return { content: [{ type: "text", text: formatTaskStarted(task) }], structuredContent: task };
    }
    if (mode === "watch") {
        const output = await watchWslTask(params.script, shell, params.workdir, params.timeout_ms, params.on_timeout ?? "detach", {
            tailChars: params.tail_chars,
            readMode: params.read_mode,
        }, distro);
        return { content: [{ type: "text", text: formatTaskOutput(output) }], structuredContent: output };
    }
    const result = await execWslScript(params.script, shell, params.workdir, { timeoutMs: params.timeout_ms, distro });
    return { content: [{ type: "text", text: formatCommandResult(result) }], structuredContent: result };
}
// Tool invocations go only through registerTool callbacks so MCP SDK Zod
// validation runs. Do not override CallToolRequestSchema on server.server.
async function ensureInstalledDistro(distro) {
    const distros = await listDistros();
    if (distros.includes(distro)) {
        return;
    }
    const installed = distros.length > 0 ? distros.join(", ") : "(none)";
    throw new Error(`WSL distribution "${distro}" is not installed. Installed distros: ${installed}`);
}
async function resolveRequestedDistro(input) {
    if (typeof input === "undefined") {
        return undefined;
    }
    const trimmed = input.trim();
    if (!trimmed) {
        throw new Error("distro name is required");
    }
    if (trimmed.toLowerCase() === "default") {
        return null;
    }
    await ensureInstalledDistro(trimmed);
    return trimmed;
}
server.registerTool("wsl_session", {
    title: "Manage WSL Session",
    description: `Unified process-local WSL session manager.

Actions:
  - status: read this MCP process's keepalive/configured distro state.
  - start: start or warm the process-local keepalive.
  - stop: stop only this MCP process's keepalive; does not terminate the WSL distro globally.
  - set_distro: set this MCP process's configured distro; stops this process's keepalive if needed.
  - list_distros: list installed WSL distributions.

Use only this public session tool for WSL session state. Session state is owned
by this MCP process.`,
    inputSchema: z.object({
        action: z.enum(["status", "start", "stop", "set_distro", "list_distros"]),
        distro: z.string()
            .optional()
            .describe('Distro for start or set_distro, e.g. "Ubuntu-22.04"; pass "default" for system default.'),
    }).strict(),
    annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
    },
}, async (params) => {
    try {
        return await handleSessionAction(params);
    }
    catch (error) {
        return errorResponse(error);
    }
});
server.registerTool("wsl_task", {
    title: "Manage WSL Async Task",
    description: `Unified async/watch WSL task manager for tasks started by wsl_exec/wsl_script
with mode="async" or mode="watch" and on_timeout="detach".

Actions:
  - status: get state and output lengths.
  - output: read stdout/stderr with offsets or tail_chars.
  - wait: block inside this MCP server for wait_ms, returning early if the task exits.
  - cancel: kill the owned wsl.exe child process.
  - list: list process-local tasks.

Parameter names intentionally match ssh_task:
  - taskId is required for status/output/wait/cancel.
  - wait uses wait_ms.
  - output offsets use stdoutOffset/stderrOffset.
  - task output tailing uses tail_chars.

Use action="wait" for builds/tests. status/output are throttled by the MCP
server: if queried too soon for a running task, the tool blocks until the minimum
poll interval is reached, then returns a warning plus the real result.`,
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
        openWorldHint: false,
    },
}, async (params) => {
    try {
        return await handleTaskAction({
            ...params,
            waitMs: params.wait_ms,
            readMode: params.read_mode,
            tailChars: params.tail_chars,
        });
    }
    catch (error) {
        return errorResponse(error);
    }
});
server.registerTool("wsl_exec", {
    title: "Run WSL Command",
    description: `Execute a shell command inside this MCP process's WSL session.

This tool is intended to avoid the quoting and escaping traps that happen when
running Linux commands through wsl.exe from PowerShell, especially for pipes,
redirection, here-docs, $() and $VAR expansion, and nested quotes. Prefer it over
hand-written wsl.exe invocations when a WSL MCP tool is available.
By default it also blocks common delete operations whose target or resolved path
is under /mnt, while still allowing normal reads and writes there.

Each call still uses a fresh shell, but the keepalive process keeps the chosen
WSL distro warm. If the session is not running, it is auto-started on demand.
Concurrent command calls spawn separate WSL shells.

Args:
  - command (string, required): The shell command to execute.
    Example: "ls -la /home"
  - workdir (string, optional): Working directory inside WSL.
    Example: "/home/user/project"
  - mode: "sync" (default), "async", or "watch".
    sync waits for completion and kills the WSL child if timeout_ms is reached.
    async returns a taskId immediately.
    watch waits up to timeout_ms, then either detaches or kills depending on on_timeout.
  - timeout_ms: sync/watch timeout in milliseconds. Long requested timeouts may be capped
    internally so the MCP client can still receive a timeout result.
  - on_timeout: for watch only, "detach" (default) or "kill".
  - tail_chars: for watch output, return only the tail of each stream.
  - distro: optional one-shot distro override; does not change session default.

Parameter names intentionally match ssh_exec/ssh_script. Start background work by
passing mode="async" here.

Deletes under /mnt are blocked on purpose: delete Windows paths on the host
(PowerShell Remove-Item), not through WSL.

Returns:
  sync: { stdout, stderr, exitCode, timedOut?, timeoutMs? }
  async: task snapshot
  watch: task output snapshot plus detached/killed/timedOut fields

Examples:
  - "ls -la /home"                                   -> list home directory
  - "cd /tmp && curl -s ifconfig.me"                  -> chain commands
  - "node -e 'console.log(2+2)'"                      -> inline script
  - workdir="/home/user/project" + "npm test"         -> run in project dir
  - distro="Ubuntu-22.04" + "uname -a"                -> one-shot other distro
  - mode="watch", timeout_ms=120000 for builds that may take a while

Error Handling:
  - Returns stdout/stderr and non-zero exitCode on failure
  - Returns "Error: ENOENT" if wsl.exe is not found on PATH
  - Returns startup/probe errors if the configured distro cannot be launched`,
    inputSchema: z.object({
        command: z.string()
            .min(1, "command is required")
            .describe("Shell command to execute inside WSL"),
        workdir: z.string()
            .optional()
            .describe("Working directory inside WSL (e.g., /home/user)"),
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
        distro: distroField,
    }).strict(),
    annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
    },
}, async (params) => {
    try {
        return await runCommandTool(params);
    }
    catch (error) {
        return errorResponse(error);
    }
});
server.registerTool("wsl_script", {
    title: "Run WSL Script",
    description: `Execute a multi-line shell script inside this MCP process's WSL session.

Unlike wsl_exec, this tool passes the script via stdin (\`bash -l -s\`), so
quoting and special characters inside the script are never interpreted by Windows.
It is intended to avoid PowerShell-to-wsl.exe escaping traps for complex Linux
scripts with pipes, redirection, here-docs, $()/$VAR expansion, and nested quotes.
Prefer it over hand-written wsl.exe bash -lc strings when a WSL MCP tool is available.
By default it also blocks common delete operations whose target or resolved path
is under /mnt, while still allowing normal reads and writes there.
If the session is not running, it is auto-started on demand. Concurrent script
calls spawn separate WSL shells.

Args:
  - script (string, required): Script content to execute. Can be multiple lines.
    Example: "echo hello\\necho world"
  - shell (string, optional): Shell to use (default: "bash").
    Options: "bash", "sh", "zsh", "dash", etc.
  - workdir (string, optional): Working directory inside WSL.
  - mode: "sync" (default), "async", or "watch".
  - timeout_ms: sync/watch timeout in milliseconds. Long requested timeouts may be capped
    internally so the MCP client can still receive a timeout result.
  - on_timeout: for watch only, "detach" (default) or "kill".
  - tail_chars: for watch output, return only the tail of each stream.
  - distro: optional one-shot distro override; does not change session default.

Parameter names intentionally match ssh_exec/ssh_script. Start background work by
passing mode="async" here.

Deletes under /mnt are blocked on purpose: delete Windows paths on the host.

Returns:
  Same as wsl_exec: sync command result, async task snapshot, or watch output.

Examples:
  - script="git status\\ngit log --oneline -3"        -> run multiple commands
  - script="for f in *.txt; do echo \$f; done"        -> shell loop
  - shell="zsh" + script="echo \$ZSH_VERSION"         -> use specific shell
  - distro="Ubuntu-22.04" + script="df -h /"          -> one-shot other distro
  - mode="watch", timeout_ms=120000 for builds that may take a while

Error Handling:
  - Same as wsl_exec`,
    inputSchema: z.object({
        script: z.string()
            .min(1, "script is required")
            .describe("Multi-line script content to execute"),
        shell: z.string()
            .default("bash")
            .describe("Shell to use (bash, sh, zsh, dash, etc.)"),
        workdir: z.string()
            .optional()
            .describe("Working directory inside WSL"),
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
        distro: distroField,
    }).strict(),
    annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
    },
}, async (params) => {
    try {
        return await runScriptTool(params);
    }
    catch (error) {
        return errorResponse(error);
    }
});
server.registerTool("wsl_job", {
    title: "Manage WSL Persistent Job",
    description: `Detached persistent job manager for WSL. Unlike wsl_task (attached, dies with MCP),
persistent jobs run fully detached inside WSL via setsid. Logs and pid files
live in ~/.remote-mcp/jobs/<jobId>/; metadata is stored on the Windows side.
Any agent with the jobId can re-attach, read logs, or cancel — even after MCP
or Codex restarts.

Actions:
  - start: launch a detached command. Returns jobId immediately.
  - status: check job state (running/exited/cancelled/expired).
  - output: read stdout/stderr logs with offsets or tail_chars.
  - wait: poll until the job exits or wait_ms elapses, then return output.
  - cancel: send SIGTERM to the job's process group.
  - list: list all known persistent jobs.

Use wsl_job for long-running tasks like firmware builds that may outlive the
MCP process. Default read_mode is "delta" (bounded tail window) to prevent
context explosion; use read_mode="full" with stdoutOffset/stderrOffset to page
through complete logs without a single huge response.

Parameters:
  - action (required): start | status | output | wait | cancel | list
  - command (required for start): shell command to execute detached.
  - jobId (required for status/output/wait/cancel): UUID returned by start.
  - workdir (optional, for start): working directory inside WSL.
  - distro (optional, for start): one-shot distro override for the job.
  - max_runtime_ms (optional, for start): auto-expire deadline. Default 1h.
  - wait_ms (optional, for wait): max poll duration. Default 30000.
  - stdoutOffset/stderrOffset: byte offsets for incremental reads.
  - tail_chars: read only the last N characters from each stream.
  - read_mode: "delta" (default) or "full".`,
    inputSchema: z.object({
        action: z.enum(["start", "status", "output", "wait", "cancel", "list"]),
        command: z.string()
            .optional()
            .describe("Shell command for action=start. Runs detached via setsid."),
        jobId: z.string()
            .optional()
            .describe("Job UUID for status/output/wait/cancel."),
        workdir: z.string()
            .optional()
            .describe("Working directory inside WSL for action=start."),
        distro: distroField,
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
}, async (params) => {
    try {
        return await handleJobAction({
            ...params,
            maxRuntimeMs: params.max_runtime_ms,
            waitMs: params.wait_ms,
            readMode: params.read_mode,
            tailChars: params.tail_chars,
        });
    }
    catch (error) {
        return errorResponse(error);
    }
});
function cleanup() {
    cancelAllTasksSync();
    stopSessionSync();
}
// process.on('exit') fires on all normal exit paths (process.exit(), uncaught
// exception, empty event loop, stdin EOF). On Windows SIGTERM is not a real
// signal (TerminateProcess), so 'exit' is the only reliable cleanup hook.
process.on("exit", cleanup);
process.on("SIGINT", () => { cleanup(); process.exit(0); });
process.on("SIGHUP", () => { cleanup(); process.exit(0); });
async function main() {
    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.error(`wsl-mcp-server running via stdio (auto-start, default distro: ${getDefaultDistro()})`);
}
main().catch((error) => {
    console.error("Fatal error:", error);
    process.exit(1);
});
//# sourceMappingURL=index.js.map