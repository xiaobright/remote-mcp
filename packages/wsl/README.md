# wsl-mcp-server

Stdio MCP server for running Linux commands inside WSL while avoiding
PowerShell-to-WSL escaping traps.

This server keeps a small process-local WSL keepalive so the selected distro
does not go cold between calls. Each command or script still runs in a fresh WSL
shell.

## Default Tools

- `wsl_exec`
  - Run a command or multi-line script inside WSL; content goes through stdin.
  - Prefer it for pipes, redirects, here-docs, `$()`, `$VAR`, nested quotes; it is
    one tool for both a single line and a whole script. `shell` defaults to bash.
  - Optional `distro` one-shot override (does not change session default).
- `wsl_task`
  - Manage async/watch tasks started by `wsl_exec`.
- `wsl_job`
  - Detached persistent jobs that survive MCP restarts; optional `distro` on start.
- `wsl_help`
  - Topic help: overview, execution, jobs, output, connection, files. No skill required.

`REMOTE_MCP_ENABLE_ADMIN_TOOLS=1` optionally registers `wsl_session`.
Keepalive starts automatically; a session-start call is not required.
`REMOTE_MCP_ENABLE_FILE_TOOLS=1` optionally registers legacy file tools.
Both optional capabilities are disabled by default; an old unified setting alone
does not enable file tools. See the [root README](../../README.en.md).

Common deletes under `/mnt` are blocked best-effort, not sandboxed. Delete Windows-mounted paths on the host
  (`Remove-Item -LiteralPath ...`), not through WSL.

## Execution Parameters

The WSL and SSH MCPs intentionally use the same execution pattern:

- `wsl_exec` takes `mode: "sync" | "async" | "watch"`.
- `mode="sync"` waits for completion and returns command output.
- `mode="async"` returns a task snapshot immediately.
- `mode="watch"` waits up to `timeout_ms`; on timeout it follows `on_timeout`.
- `on_timeout` is only for `watch`; use `"detach"` to keep running or `"kill"` to cancel.
- `tail_chars` is only for `wsl_exec` watch output.
- Manage background work with `wsl_task`.

Task parameter names intentionally match `ssh_task`:

- `wait_ms` for `wsl_task action="wait"`.
- `stdoutOffset` / `stderrOffset` for offset reads.
- `tail_chars` for task output tailing.

Use `wsl_exec` with `mode="async"` for attached background work.
Use `wsl_job` when work must survive an MCP restart. Output is bounded and
resumable; sync output is not repeated in structuredContent.

## Environment

- `WSL_MCP_DEFAULT_DISTRO`: startup distro. Default: `Ubuntu-24.04`.
- `WSL_MCP_TASK_OUTPUT_LIMIT`: max retained output per task.
- `WSL_MCP_MAX_FINISHED_TASKS`: finished task retention count.
- `WSL_MCP_MIN_POLL_INTERVAL_MS`: task status/output throttle; default `60000`.
- `WSL_MCP_DEFAULT_SYNC_TIMEOUT_MS`: default sync timeout.
- `WSL_MCP_DEFAULT_WATCH_TIMEOUT_MS`: default watch timeout.
- `WSL_MCP_DEFAULT_TASK_WAIT_MS`: default `wsl_task action="wait"` duration, `60000`.
- `WSL_MCP_MAX_TOOL_TIMEOUT_MS`: maximum inner timeout used to keep the MCP call responsive.
- `WSL_MCP_PROTECT_MNT_DELETE`: default enabled; set `0` to disable `/mnt` delete protection.
