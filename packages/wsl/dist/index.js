#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { errorResponse } from "@remote-mcp/shared/mcp";
import { commandOutputResponse, outputResponse } from "@remote-mcp/shared/output";
import { registerHelpTool, toolFeatures } from "@remote-mcp/shared/tool-surface";
import { registerRemoteFileTools, registerUnifiedRemoteFileTools } from "@remote-mcp/shared/remote";
import { execWsl, execWslAsync, execWslScript, execWslScriptAsync, runWslRawScript, watchWslTask, startSession, stopSession, stopSessionSync, cancelAllTasksSync, cancelTask, setDistro, getDistro, getDefaultDistro, getSessionState, observeTaskOutput, observeTaskStatus, listDistros, listTasks, waitTask, startPersistentJob, getPersistentJobStatus, readPersistentJobOutput, waitPersistentJob, cancelPersistentJob, listPersistentJobs, } from "./wsl.js";
const server = new McpServer({
    name: "wsl-mcp-server",
    version: "1.0.0",
});
const features = toolFeatures();
registerHelpTool(server, "wsl", features);
function formatDistro(distro) {
    return distro ?? "(system default)";
}
const runModeSchema = z.enum(["sync", "async", "watch"]);
const timeoutBehaviorSchema = z.enum(["kill", "detach"]);
const distroField = z.string()
    .optional()
    .describe('One-call distro override; "default" selects the system default.');
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
if (features.files) {
    if (features.fileApi === "unified")
        registerUnifiedRemoteFileTools(fileToolOptions);
    else
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
        `\nTask ${output.task.taskId}: ${output.task.state}${output.task.exitCode !== null ? ` (exit ${output.task.exitCode})` : ""}`,
        `\nNext offsets: stdout=${output.nextStdoutOffset}, stderr=${output.nextStderrOffset}`,
        poll?.throttled ? `\nPolling was throttled inside the MCP server; waited ${poll.waitedMs} ms before returning.` : "",
    ].filter(Boolean).join("");
}
function formatPersistentJobStarted(job) {
    return `Job ${job.jobId}: ${job.state}. Logs: ${job.jobDir}. Continue: wsl_job action="wait", jobId="${job.jobId}", wait_ms=60000.`;
}
function formatPersistentJobStatus(job) {
    return `Job ${job.jobId}: ${job.state}${job.exitCode !== null ? ` (exit ${job.exitCode})` : ""}. Started ${job.startedAt}.${job.endedAt ? ` Ended ${job.endedAt}.` : ""}`;
}
function formatPersistentJobOutput(output) {
    return [
        output.stdout,
        output.stderr ? `\nSTDERR:\n${output.stderr}` : "",
        `\nJob ${output.job.jobId}: ${output.job.state}${output.job.exitCode !== null ? ` (exit ${output.job.exitCode})` : ""}`,
        `\nNext offsets: stdout=${output.nextStdoutOffset}/${output.stdoutLength}, stderr=${output.nextStderrOffset}/${output.stderrLength}`,
        output.completed !== undefined ? `\nCompleted: ${output.completed}${output.timedOut ? " (timed out)" : ""}${output.waitedMs !== undefined ? ` after ${output.waitedMs} ms` : ""}` : "",
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
        return outputResponse(formatTaskOutput(output), output);
    }
    const result = await execWsl(params.command, params.workdir, { timeoutMs: params.timeout_ms, distro });
    return commandOutputResponse(result, formatCommandResult);
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
        return outputResponse(formatTaskOutput(output), output);
    }
    const result = await execWslScript(params.script, shell, params.workdir, { timeoutMs: params.timeout_ms, distro });
    return commandOutputResponse(result, formatCommandResult);
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
if (features.admin)
    server.registerTool("wsl_session", {
        title: "Manage WSL Session",
        description: `Manage process-local distro/keepalive state. Execution auto-starts it; stop does not shut down the distro. Details: wsl_help topic="connection".`,
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
    description: `Wait/read/cancel attached exec/script tasks. Lost on MCP restart; persistent work uses wsl_job. Prefer wait (default 60s); reuse offsets for capped output. Details: wsl_help topic="output".`,
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
    description: `Run a command in a fresh WSL shell. sync waits; async/watch return taskId for wsl_task. Sync timeout stops the local child; use wsl_job for persistence. Multi-line: wsl_script. Delete Windows-mounted paths on the host.`,
    inputSchema: z.object({
        command: z.string()
            .min(1, "command is required")
            .describe("Shell command."),
        workdir: z.string()
            .optional()
            .describe("Working directory; failed cd aborts execution."),
        mode: runModeSchema
            .default("sync"),
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
    description: `Run a multi-line script/heredoc via stdin in a fresh WSL shell. sync waits; async/watch use wsl_task. Sync timeout stops the local child; durable work uses wsl_job. Delete Windows-mounted paths on the host.`,
    inputSchema: z.object({
        script: z.string()
            .min(1, "script is required")
            .describe("Multi-line shell script."),
        shell: z.string()
            .default("bash")
            .describe("Shell executable."),
        workdir: z.string()
            .optional()
            .describe("Working directory; failed cd aborts execution."),
        mode: runModeSchema
            .default("sync"),
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
    description: `Run/manage detached bash jobs with disk logs. Survives MCP restart, not WSL shutdown. Prefer wait over polling. Default runtime limit: 1h. Details: wsl_help topic="jobs".`,
    inputSchema: z.object({
        action: z.enum(["start", "status", "output", "wait", "cancel", "list"]),
        command: z.string()
            .optional()
            .describe("start: shell command or multi-line bash script."),
        jobId: z.string()
            .optional()
            .describe("Job UUID for status/output/wait/cancel."),
        workdir: z.string()
            .optional()
            .describe("Working directory; failed cd aborts execution. for action=start."),
        distro: distroField,
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