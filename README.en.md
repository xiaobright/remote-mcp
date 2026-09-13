# remote-mcp

[中文 README](README.md)

`remote-mcp` provides SSH/WSL command execution, multi-line scripts, background jobs and bounded log reads for coding agents. Each server exposes **five tools by default**, with on-demand help and no required client-specific skill.

It is not a remote resident agent. The MCP servers run locally, using `ssh` or `wsl.exe`. Every execution starts a fresh shell; previous environment/cd changes do not carry over. Persistent jobs require bash, setsid, base64 and basic shell utilities on the execution host.

## AI-Generated Notice

This repository's code and documentation were generated and organized by OpenAI Codex from user requirements and test feedback. The user drove the design and validation direction, but did not hand-write the implementation. Treat this as an AI-generated experimental tool and review it before using it in sensitive environments.

The interface uses standard MCP tools/list and tools/call. Clients differ in tool discovery, structured-output display and outer call timeouts; identical native-editor UX across clients is not guaranteed.

## Why This Exists

The focus is reliable execution rather than duplicating an editor: avoid Windows quoting traps, duplicate job starts, misleading state transitions and excessive model-visible logs.

Typical use cases:

- Let an agent work on WSL projects from Windows.
- Run scripts and heredocs on SSH-accessible Linux devices and servers.
- Manage builds, training and services, reconnecting to persistent jobs after MCP restarts.
- Read, search and modify files through exec/script by default.

## Packages

- `@remote-mcp/ssh`: SSH execution, task management and help.
- `@remote-mcp/wsl`: WSL execution, task management and help.
- `@remote-mcp/shared`: shared implementation, not intended to be loaded as an MCP server.

SSH and WSL are loaded separately, so clients can enable only the transport they need.

## Tools

| WSL | SSH | Purpose |
| --- | --- | --- |
| `wsl_exec` | `ssh_exec` | Commands, synchronous by default |
| `wsl_script` | `ssh_script` | Multi-line scripts through stdin |
| `wsl_task` | `ssh_task` | Attached async/watch task management |
| `wsl_job` | `ssh_job` | Persistent detached jobs |
| `wsl_help` | `ssh_help` | On-demand topic help |

Help topics: `overview` (default), `execution`, `jobs`, `output`, `connection`, `files`. Ordinary calls do not require help first. Help does not execute commands, alter configuration or dynamically load other tools.

Optional capabilities require an explicit environment flag and MCP restart:

- `REMOTE_MCP_ENABLE_ADMIN_TOOLS=1`: enable `wsl_session` / `ssh_profile`. WSL keepalive starts automatically; SSH configuration/default targets work without an admin call.
- `REMOTE_MCP_ENABLE_FILE_TOOLS=1`: enable legacy file tools. `REMOTE_MCP_FILE_API=unified` selects one action-based tool; otherwise five split tools are used. **An old unified setting alone does not enable file tools.**

Disabling file tools reduces exposed schemas, not shell permissions. It is not a sandbox.

## Task Model

| Kind | Tools | Lifetime | Notes |
|------|-------|----------|-------|
| attached task | `*_exec`/`*_script` with mode=`async`/`watch` plus `*_task` | tied to the MCP process | output is readable while the local child (ssh/wsl.exe) is alive |
| persistent job | `*_job` | survives MCP restarts | runs detached via setsid; cancellation targets the session group and checks liveness |

`*_task` cancel tries to kill the local process tree (on Windows via `taskkill /T`); processes that already daemonized on the remote side may survive. For long work that must outlive the MCP process, use `*_job`.
Cancel returns the requested state; use wait to confirm the local child has closed before treating cancellation as complete.

Sync calls default to a 120s timeout and stop the local child on timeout. Watch defaults to detaching and returns a taskId for continuation. Do not blindly rerun side effects after a lost response.

Task/job wait defaults to 60s and returns early on completion. A wait timeout means the waiting budget elapsed, not that execution failed. Waits are capped by the server's tool timeout ceiling; configure a longer outer client timeout.

Jobs default to a 1h maximum runtime; explicitly increase `max_runtime_ms` for longer work/services. They do not survive host reboot or WSL shutdown. The job ID and connection are recorded before launch, so an unconfirmed start can be inspected without duplicate execution. An invalid workdir aborts instead of falling back to HOME.

## Output and Pagination

- Sync responses show at most the last 8192 characters per stream by default. Oversized full output is saved on the **MCP host** under `work/command-output/<id>/`; `fullOutput` returns paths. This is a response budget, not a process-memory limit.
- Tasks retain a bounded in-memory tail; older output can be evicted. Jobs keep remote disk logs under `~/.remote-mcp/jobs/<jobId>/`.
- Delta mode without offsets returns a bounded tail, not a server-maintained unread cursor. Pass back both returned next offsets to continue without replay.
- `read_mode="full"` with both offsets at zero begins capped paging from the start. Explicit zero is not treated as omitted.
- Task offsets are JavaScript UTF-16 code units; job offsets are bytes. Reuse offsets unchanged. `tail_chars` overrides offsets but remains page-capped.
- Logs may contain secrets and are not automatically removed. A spool failure returns a warning without changing the executed command's exit status or encouraging a rerun.

## Legacy File Tools (Disabled by Default)

The read/write/edit/apply_patch/search implementations remain as opt-in legacy capabilities, not the core product. Patch only supports Add/Update, not Delete/Move.

Known limitations include patch newline normalization, incomplete BOM preservation, first-match selection for ambiguous hunks, and limited symlink/permission-metadata handling. A temporary-file rename plus a hash check is not a complete concurrency transaction; multi-file writes are not all-or-nothing.

## Return Shape

Tools return MCP `content` plus `structuredContent`:

- `content` is a compact human/model-readable summary.
- Execution `structuredContent` carries exit codes, state, offsets, truncation flags and log paths, **not duplicate stdout/stderr**. Consumers of the old structured stream fields must adapt.
- Legacy file tools retain their own result shapes. Use exec with `ls` / `stat` for directories and metadata.

## Build

```powershell
npm install
npm run build
npm test
npm run probe
```

Tests cover pure functions, isolated MCP tools/call flows and registration without contacting real SSH/WSL targets. Probe measures complete tools/list JSON characters, not model tokens.

On Windows, explicitly run `npm run test:wsl` for a real WSL smoke test: execution, workdirs, bounded output, restart reattachment and cancellation. It uses its own job registry, retains logs/evidence under `work/smoke-wsl/`, and does not manage existing jobs. Real SSH hosts require separate verification.

## Run

```powershell
node packages/ssh/dist/index.js
node packages/wsl/dist/index.js
```

## MCP Config Examples

SSH:

```toml
[mcp_servers.ssh]
command = 'node'
args = ['C:\path\to\remote-mcp\packages\ssh\dist\index.js']
startup_timeout_sec = 30

[mcp_servers.ssh.env]
SSH_MCP_DEFAULT_TARGET = "alice@devbox.local"
SSH_MCP_BATCH_MODE = "1"
SSH_MCP_STRICT_HOST_KEY_CHECKING = "accept-new"
```

WSL:

```toml
[mcp_servers.wsl]
command = 'node'
args = ['C:\path\to\remote-mcp\packages\wsl\dist\index.js']
startup_timeout_sec = 30

[mcp_servers.wsl.env]
WSL_MCP_DEFAULT_DISTRO = "Ubuntu-24.04"
```

MCP client configuration formats vary. Adjust field names and paths for your client.

## Security Notes

- The SSH MCP does not store SSH passwords. Use SSH keys.
- `devices.json`, `.env`, and `node_modules` are git-ignored.
- Exec/script/job can perform real writes; disabling file tools does not reduce shell permissions.
- `*_file_apply_patch` does not support file deletion.
- WSL blocks common delete operations under `/mnt` best-effort. This is not a sandbox and can be bypassed; delete Windows-mounted paths on the Windows host.
- This project is AI-generated. Review it according to your own threat model before use.

## Environment Variables

| Variable | Purpose |
|------|------|
| `SSH_MCP_DEFAULT_TARGET` | default SSH target or device name |
| `SSH_MCP_DEVICES_PATH` | device profile file path |
| `SSH_MCP_STRICT_HOST_KEY_CHECKING` | defaults to `accept-new` |
| `SSH_MCP_BATCH_MODE` | set to `0` to disable BatchMode |
| `WSL_MCP_DEFAULT_DISTRO` | default WSL distro |
| `WSL_MCP_PROTECT_MNT_DELETE` | set to `0` to disable /mnt delete protection |
| `REMOTE_MCP_ENABLE_FILE_TOOLS` | only `1` registers legacy file tools; disabled by default |
| `REMOTE_MCP_ENABLE_ADMIN_TOOLS` | only `1` registers session/profile; disabled by default |
| `REMOTE_MCP_FILE_API` | unified or split layout, only after file tools are enabled |
| `REMOTE_MCP_OUTPUT_LIMIT_CHARS` | sync response budget per stream; default 8192 |
| `REMOTE_MCP_OUTPUT_DIR` | local directory for oversized full command output |
| `REMOTE_MCP_PERSISTENT_JOB_STORE_PATH` | local job registry, default `work/persistent-jobs.json`; retain it for restart recovery |
| `*_DEFAULT_TASK_WAIT_MS` | default task wait; 60000 |
| `*_MIN_POLL_INTERVAL_MS` | task status/output throttle; 60000 |
| `*_MAX_TOOL_TIMEOUT_MS` | per-call tool timeout ceiling (default 540s) |
| `*_PERSISTENT_JOB_MAX_RUNTIME_MS` | default persistent-job max runtime (1h) |

## License

MIT
