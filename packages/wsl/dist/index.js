#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { execWsl, execWslAsync, execWslScript, execWslScriptAsync, watchWslTask, startSession, stopSession, stopSessionSync, cancelAllTasksSync, cancelTask, setDistro, getDistro, getDefaultDistro, getSessionState, observeTaskOutput, observeTaskStatus, listDistros, listTasks, waitTask, } from "./wsl.js";
const server = new McpServer({
    name: "wsl-mcp-server",
    version: "1.0.0",
});
function formatDistro(distro) {
    return distro ?? "(system default)";
}
const runModeSchema = z.enum(["sync", "async", "watch"]);
const timeoutBehaviorSchema = z.enum(["kill", "detach"]);
function errorResponse(error) {
    const msg = error instanceof Error ? error.message : String(error);
    return { content: [{ type: "text", text: `Error: ${msg}` }] };
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
        `\nTask ${output.task.taskId}: ${output.task.state}`,
        `\nNext offsets: stdout=${output.nextStdoutOffset}, stderr=${output.nextStderrOffset}`,
        poll?.throttled ? `\nPolling was throttled inside the MCP server; waited ${poll.waitedMs} ms before returning.` : "",
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
            const output = await observeTaskOutput(params.taskId, params.stdoutOffset, params.stderrOffset, params.tailChars);
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
async function runCommandTool(params) {
    const mode = params.mode ?? "sync";
    if (mode === "async") {
        const task = await execWslAsync(params.command, params.workdir);
        return { content: [{ type: "text", text: formatTaskStarted(task) }], structuredContent: task };
    }
    if (mode === "watch") {
        const output = await watchWslTask(params.command, "bash", params.workdir, params.timeout_ms, params.on_timeout ?? "detach", {
            tailChars: params.tail_chars,
        });
        return { content: [{ type: "text", text: formatTaskOutput(output) }], structuredContent: output };
    }
    const result = await execWsl(params.command, params.workdir, { timeoutMs: params.timeout_ms });
    return { content: [{ type: "text", text: formatCommandResult(result) }], structuredContent: result };
}
async function runScriptTool(params) {
    const shell = params.shell ?? "bash";
    const mode = params.mode ?? "sync";
    if (mode === "async") {
        const task = await execWslScriptAsync(params.script, shell, params.workdir);
        return { content: [{ type: "text", text: formatTaskStarted(task) }], structuredContent: task };
    }
    if (mode === "watch") {
        const output = await watchWslTask(params.script, shell, params.workdir, params.timeout_ms, params.on_timeout ?? "detach", {
            tailChars: params.tail_chars,
        });
        return { content: [{ type: "text", text: formatTaskOutput(output) }], structuredContent: output };
    }
    const result = await execWslScript(params.script, shell, params.workdir, { timeoutMs: params.timeout_ms });
    return { content: [{ type: "text", text: formatCommandResult(result) }], structuredContent: result };
}
function asRecord(value) {
    return value && typeof value === "object" ? value : {};
}
function optionalString(value) {
    return typeof value === "string" ? value : undefined;
}
function optionalNumber(value) {
    return typeof value === "number" ? value : undefined;
}
function optionalRunMode(value) {
    return value === "sync" || value === "async" || value === "watch" ? value : undefined;
}
function optionalTimeoutBehavior(value) {
    return value === "kill" || value === "detach" ? value : undefined;
}
function optionalTaskTailChars(args) {
    return optionalNumber(args.tail_chars) ?? optionalNumber(args.tailChars);
}
async function dispatchToolCall(name, argsInput) {
    const args = asRecord(argsInput);
    switch (name) {
        case "wsl_session":
            return handleSessionAction({
                action: String(args.action ?? ""),
                distro: optionalString(args.distro),
            });
        case "wsl_task":
            return handleTaskAction({
                action: String(args.action ?? ""),
                taskId: optionalString(args.taskId),
                waitMs: optionalNumber(args.wait_ms),
                stdoutOffset: optionalNumber(args.stdoutOffset),
                stderrOffset: optionalNumber(args.stderrOffset),
                tailChars: optionalTaskTailChars(args),
            });
        case "wsl_exec":
            return runCommandTool({
                command: String(args.command ?? ""),
                workdir: optionalString(args.workdir),
                mode: optionalRunMode(args.mode),
                timeout_ms: optionalNumber(args.timeout_ms),
                on_timeout: optionalTimeoutBehavior(args.on_timeout),
                tail_chars: optionalNumber(args.tail_chars),
            });
        case "wsl_script":
            return runScriptTool({
                script: String(args.script ?? ""),
                shell: optionalString(args.shell),
                workdir: optionalString(args.workdir),
                mode: optionalRunMode(args.mode),
                timeout_ms: optionalNumber(args.timeout_ms),
                on_timeout: optionalTimeoutBehavior(args.on_timeout),
                tail_chars: optionalNumber(args.tail_chars),
            });
        // Hidden compatibility aliases. They are intentionally not registered, so
        // tools/list only exposes the consolidated tool surface.
        case "wsl_start":
            return handleSessionAction({ action: "start", distro: optionalString(args.distro) });
        case "wsl_stop":
            return handleSessionAction({ action: "stop" });
        case "wsl_status":
            return handleSessionAction({ action: "status" });
        case "wsl_set_distro":
            return handleSessionAction({ action: "set_distro", distro: optionalString(args.distro) });
        case "wsl_list_distros":
            return handleSessionAction({ action: "list_distros" });
        case "wsl_get_distro": {
            const current = getDistro();
            return {
                content: [{
                        type: "text",
                        text: current
                            ? `Configured distro: ${current} (startup default: ${getDefaultDistro()})`
                            : `Using the system default WSL distro (startup default: ${getDefaultDistro()})`,
                    }],
                structuredContent: { distro: current, defaultDistro: getDefaultDistro() },
            };
        }
        case "wsl_exec_async":
            return runCommandTool({
                command: String(args.command ?? ""),
                workdir: optionalString(args.workdir),
                mode: "async",
            });
        case "wsl_script_async":
            return runScriptTool({
                script: String(args.script ?? ""),
                shell: optionalString(args.shell),
                workdir: optionalString(args.workdir),
                mode: "async",
            });
        case "wsl_task_status":
            return handleTaskAction({ action: "status", taskId: optionalString(args.taskId) });
        case "wsl_task_output":
            return handleTaskAction({
                action: "output",
                taskId: optionalString(args.taskId),
                stdoutOffset: optionalNumber(args.stdoutOffset),
                stderrOffset: optionalNumber(args.stderrOffset),
                tailChars: optionalTaskTailChars(args),
            });
        case "wsl_task_cancel":
            return handleTaskAction({ action: "cancel", taskId: optionalString(args.taskId) });
        case "wsl_task_list":
            return handleTaskAction({ action: "list" });
        default:
            return {
                content: [{ type: "text", text: `Error: Tool ${name} not found` }],
                isError: true,
            };
    }
}
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
by this MCP process; do not invent separate wsl_status/wsl_start/wsl_stop tool
calls from older examples.`,
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
            tailChars: params.tail_chars ?? params.tailChars,
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

Parameter names intentionally match ssh_exec/ssh_script. Start background work by
passing mode="async" here; do not invent separate wsl_exec_async tool calls.

Returns:
  sync: { stdout, stderr, exitCode, timedOut?, timeoutMs? }
  async: task snapshot
  watch: task output snapshot plus detached/killed/timedOut fields

Examples:
  - "ls -la /home"                                   -> list home directory
  - "cd /tmp && curl -s ifconfig.me"                  -> chain commands
  - "node -e 'console.log(2+2)'"                      -> inline script
  - workdir="/home/user/project" + "npm test"         -> run in project dir
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

Parameter names intentionally match ssh_exec/ssh_script. Start background work by
passing mode="async" here; do not invent separate wsl_script_async tool calls.

Returns:
  Same as wsl_exec: sync command result, async task snapshot, or watch output.

Examples:
  - script="git status\\ngit log --oneline -3"        -> run multiple commands
  - script="for f in *.txt; do echo \$f; done"        -> shell loop
  - shell="zsh" + script="echo \$ZSH_VERSION"         -> use specific shell
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
}, async (params) => {
    try {
        return await runScriptTool(params);
    }
    catch (error) {
        return errorResponse(error);
    }
});
server.server.setRequestHandler(CallToolRequestSchema, async (request) => {
    try {
        return await dispatchToolCall(request.params.name, request.params.arguments);
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