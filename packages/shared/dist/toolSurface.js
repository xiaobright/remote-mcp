import { z } from "zod";
import { readPositiveIntEnv } from "./env.js";
export function toolFeatures(env = process.env) {
    return {
        files: env.REMOTE_MCP_ENABLE_FILE_TOOLS === "1",
        admin: env.REMOTE_MCP_ENABLE_ADMIN_TOOLS === "1",
        fileApi: env.REMOTE_MCP_FILE_API === "unified" ? "unified" : "split",
    };
}
export function registerHelpTool(server, backend, features) {
    const prefix = backend.toUpperCase();
    const waitMs = readPositiveIntEnv(`${prefix}_MCP_DEFAULT_TASK_WAIT_MS`, 60000);
    const topics = {
        overview: [
            `${backend}_exec: commands; ${backend}_script: multi-line scripts. Both use a fresh shell.`,
            `${backend}_task: attached async/watch work; lost on MCP restart.`,
            `${backend}_job: detached work with disk logs; survives MCP restart, not host/WSL shutdown.`,
            `Help topics: execution, jobs, output, connection, files. Ordinary calls do not require help first.`,
            `Optional tools: files=${features.files ? features.fileApi : "disabled"}, admin=${features.admin ? "enabled" : "disabled"}.`,
        ],
        execution: [
            `Use ${backend}_exec for commands, ${backend}_script for multi-line scripts/heredocs. Content is sent through stdin, not nested Windows shell quoting.`,
            `Each call starts a fresh non-interactive shell. Set workdir explicitly; environment/cd changes do not carry to later calls. A failed cd aborts the call.`,
            `mode="sync" waits for completion (default timeout 120000 ms). timeout_ms is capped by ${prefix}_MCP_MAX_TOOL_TIMEOUT_MS (default 540000).`,
            `mode="async" returns taskId immediately. mode="watch" waits, then on_timeout="detach" keeps the task running; "kill" requests cancellation.`,
            `Continue attached work with ${backend}_task action="wait", taskId, wait_ms. Default wait: ${waitMs} ms; completion returns early.`,
            `Sync timeout/cancel kills the local child tree best-effort; it does not prove every remote descendant stopped. Do not blindly rerun timed-out side effects.`,
            backend === "wsl"
                ? `Windows-mounted deletes belong on the Windows host. The /mnt delete check is best-effort, not a sandbox. bash is default; sh/dash do not use login-shell flags.`
                : `target overrides the configured target for one call. shell defaults to bash; login controls bash/zsh login-shell mode. env applies to this call only.`,
        ],
        jobs: [
            `${backend}_job action="start", command, workdir?, max_runtime_ms? starts detached bash work via setsid. command may contain multiple lines.`,
            `Use jobs for training/builds/services that must survive MCP restart. They do not survive host reboot or WSL shutdown.`,
            `The remote host needs bash, setsid, base64 and basic shell utilities. Logs: ~/.remote-mcp/jobs/<jobId>/. Keep the local job registry to reconnect.`,
            `Default maximum runtime is 3600000 ms (1 hour); set max_runtime_ms explicitly for longer work/services.`,
            `Use action="wait", jobId, wait_ms=60000 (or longer) instead of frequent status/output calls. A wait timeout means "still running", not execution failure.`,
            `Use action="output" with returned offsets to continue logs; action="status" for state, "list" to recover IDs, "cancel" to stop the process group.`,
            `Cancellation is checked remotely; connection failure is not proof of cancellation. A lost start response can mean the job started: inspect the returned jobId before retrying.`,
        ],
        output: [
            `stdout/stderr appear once in text content; structuredContent carries state, exitCode, offsets and truncation metadata, not duplicate streams.`,
            `Sync responses show a bounded tail. Oversized full output is saved on the MCP host at the returned fullOutput paths; read it there rather than rerunning the command.`,
            `For task/job logs, default delta without offsets shows a bounded tail, not a server-maintained unread cursor.`,
            `Pass both returned nextStdoutOffset/nextStderrOffset as stdoutOffset/stderrOffset on the next call. Each caller owns its offsets; reads do not consume another caller's logs.`,
            `read_mode="full", stdoutOffset=0, stderrOffset=0 starts bounded paging from the beginning. Continue until offsets reach reported lengths.`,
            `Task offsets count JavaScript UTF-16 code units; job offsets count bytes. Reuse returned offsets unchanged. tail_chars overrides offsets and remains page-capped.`,
            `Tasks retain a bounded in-memory tail, so old output may be evicted. Job logs remain on disk. Keep sensitive logs private; cleanup is explicit, not automatic.`,
        ],
        connection: backend === "wsl" ? [
            `WSL_MCP_DEFAULT_DISTRO sets the startup distro (default Ubuntu-24.04). distro on an execution tool overrides one call; "default" selects the Windows system default.`,
            `The process-local keepalive starts automatically. There is no need to call session start before executing commands.`,
            `REMOTE_MCP_ENABLE_ADMIN_TOOLS=1 enables wsl_session: status, start, stop, set_distro, list_distros. stop only stops this MCP process's keepalive, not the whole distro.`,
            `Restart the MCP server/client connection after changing environment settings. Stopping MCP also stops attached tasks; use jobs when persistence is required.`,
        ] : [
            `Set SSH_MCP_DEFAULT_TARGET or pass target on a call. Native ~/.ssh/config Host aliases and existing saved device names work without an admin tool call.`,
            `Use SSH keys. Default BatchMode=yes and StrictHostKeyChecking=accept-new; configure SSH_MCP_STRICT_HOST_KEY_CHECKING=yes when host keys must already be trusted.`,
            `REMOTE_MCP_ENABLE_ADMIN_TOOLS=1 enables ssh_profile for status/test, default-target changes and the non-secret device registry.`,
            `Restart the MCP server/client connection after changing environment settings. Each execution uses a fresh local ssh process; there is no persistent remote shell.`,
        ],
        files: [
            `Dedicated file tools are ${features.files ? `enabled (${features.fileApi})` : "disabled"}. This does not prohibit file operations through exec/script and is not a security sandbox.`,
            `Use exec with rg/grep, ls/stat or bounded text reads; use script for heredocs or guarded edits. Check old text and match count before replacing; verify the result.`,
            `Legacy file tools are retained only as an opt-in: REMOTE_MCP_ENABLE_FILE_TOOLS=1, with REMOTE_MCP_FILE_API=unified or split. Restart to change registration.`,
            `The legacy patch implementation is a subset (Add/Update only), not a native-editor replacement; encoding/BOM, symlink, concurrency and multi-file atomicity guarantees are limited.`,
        ],
    };
    server.registerTool(`${backend}_help`, {
        title: `${prefix} Help`,
        description: `Read concise ${prefix} usage by topic. Optional; ordinary calls are self-contained.`,
        inputSchema: z.object({
            topic: z.enum(["overview", "execution", "jobs", "output", "connection", "files"]).default("overview"),
        }).strict(),
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    }, async ({ topic }) => ({
        content: [{ type: "text", text: topics[topic].join("\n") }],
    }));
}
//# sourceMappingURL=toolSurface.js.map