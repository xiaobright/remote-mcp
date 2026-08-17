#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { errorResponse } from "@remote-mcp/shared/mcp";
import { registerRemoteFileTools, registerUnifiedRemoteFileTools } from "@remote-mcp/shared/remote";
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
const fileToolOptions = {
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
};
// REMOTE_MCP_FILE_API=unified 时把 7 个 wsl_file_* 合并为 1 个 wsl_file（action 区分）
if (process.env.REMOTE_MCP_FILE_API === "unified") {
    registerUnifiedRemoteFileTools(fileToolOptions);
}
else {
    registerRemoteFileTools(fileToolOptions);
}
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
    description: `Manage this MCP process's WSL session state (keepalive + configured distro).
Actions: status, start, stop, set_distro, list_distros. Session state is owned by this MCP process.
Workflow details: read the remote-execution skill.`,
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
    description: `Manage async/watch WSL tasks started by wsl_exec/wsl_script with mode="async"/"watch" (on_timeout="detach").
Actions: status, output, wait, cancel, list. taskId required for status/output/wait/cancel; wait uses wait_ms; output uses stdoutOffset/stderrOffset/tail_chars/read_mode.
Use action="wait" for builds/tests. status/output are throttled server-side: querying too soon blocks to the minimum poll interval.
task dies when this MCP process exits; use wsl_job for work that must survive MCP restart.`,
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
    description: `Execute a shell command inside this MCP process's WSL session. Avoids wsl.exe quoting traps for pipes, redirection, $(), and nested quotes.
Each call uses a fresh shell; keepalive keeps the distro warm (auto-start on demand). Deletes under /mnt are blocked on purpose: delete Windows paths on the host, not through WSL.
Prefer sync for ordinary work; mode="async"/"watch" + wsl_task for background. Complex multi-line commands: use wsl_script.`,
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
    description: `Execute a multi-line shell script inside this MCP process's WSL session. Script passes via stdin (bash -l -s), so quoting/heredocs are never interpreted by Windows.
Deletes under /mnt are blocked on purpose: delete Windows paths on the host, not through WSL.
Prefer sync for ordinary work; mode="async"/"watch" + wsl_task for background. Parameter names match wsl_exec.`,
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
    description: `Manage detached persistent WSL jobs that survive MCP restart: runs fully detached inside WSL (setsid), logs in ~/.remote-mcp/jobs/<jobId>/.
Actions: start, status, output, wait, cancel, list. read_mode default "delta" (bounded tail); use "full" with offsets to page logs. Workflow details: read the remote-execution skill.`,
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