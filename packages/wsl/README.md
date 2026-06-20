# wsl-mcp-server

Stdio MCP server for running Linux commands inside WSL while avoiding
PowerShell-to-WSL escaping traps.

This server keeps a small process-local WSL keepalive so the selected distro
does not go cold between calls. Each command or script still runs in a fresh WSL
shell.

## Tools

- `wsl_session`
  - `status`: show current keepalive and configured distro.
  - `start`: start or warm the process-local keepalive.
  - `stop`: stop only this MCP process's keepalive.
  - `set_distro`: set this MCP process's configured distro.
  - `list_distros`: list installed WSL distributions.
- `wsl_exec`
  - Run a short command inside WSL.
- `wsl_script`
  - Run a multi-line WSL shell script through stdin.
  - Prefer this for pipes, redirects, here-docs, `$()`, `$VAR`, nested quotes,
    and anything more complex than one line.
- `wsl_task`
  - Manage async/watch tasks started by `wsl_exec` or `wsl_script`.

## Execution Parameters

The WSL and SSH MCPs intentionally use the same execution pattern:

- `wsl_exec` / `wsl_script` take `mode: "sync" | "async" | "watch"`.
- `mode="sync"` waits for completion and returns command output.
- `mode="async"` returns a task snapshot immediately.
- `mode="watch"` waits up to `timeout_ms`; on timeout it follows `on_timeout`.
- `on_timeout` is only for `watch`; use `"detach"` to keep running or `"kill"` to cancel.
- `tail_chars` is only for `wsl_exec` / `wsl_script` watch output.
- Manage background work with `wsl_task`.

Task parameter names intentionally match `ssh_task`:

- `wait_ms` for `wsl_task action="wait"`.
- `stdoutOffset` / `stderrOffset` for offset reads.
- `tail_chars` for task output tailing.

Older `tailChars` task calls are still accepted for compatibility, but new calls
should use `tail_chars`.

Use only the public consolidated tools listed above. Do not call older example
names such as `wsl_exec_async`, `wsl_script_async`, `wsl_status`, or `wsl_start`;
use `wsl_exec` / `wsl_script` with `mode="async"` and `wsl_session` instead.

## Environment

- `WSL_MCP_DEFAULT_DISTRO`: startup distro. Default: `Ubuntu-24.04`.
- `WSL_MCP_TASK_OUTPUT_LIMIT`: max retained output per task.
- `WSL_MCP_MAX_FINISHED_TASKS`: finished task retention count.
- `WSL_MCP_MIN_POLL_INTERVAL_MS`: throttle interval for rapid task status/output reads.
- `WSL_MCP_DEFAULT_SYNC_TIMEOUT_MS`: default sync timeout.
- `WSL_MCP_DEFAULT_WATCH_TIMEOUT_MS`: default watch timeout.
- `WSL_MCP_DEFAULT_TASK_WAIT_MS`: default `wsl_task action="wait"` duration.
- `WSL_MCP_MAX_TOOL_TIMEOUT_MS`: maximum inner timeout used to keep the MCP call responsive.
- `WSL_MCP_PROTECT_MNT_DELETE`: default enabled; set `0` to disable `/mnt` delete protection.
