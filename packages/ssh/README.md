# ssh-mcp-server

Lightweight stdio MCP server for SSH.

This server intentionally does **not** keep a persistent remote SSH shell. Each
tool call starts one local `ssh` process and sends the remote command/script to
the remote shell through stdin. That is enough to avoid Windows/PowerShell
escaping traps while keeping remote state predictable.

## Tools

- `ssh_profile`
  - `status`: show current default target and options.
  - `list_devices`: list saved device profiles.
  - `get_device`: inspect one device profile.
  - `upsert_device`: create or update a device profile.
  - `remove_device`: remove a device profile.
  - `set_default`: set a process-local default target.
  - `clear_default`: clear the default target.
  - `test`: run a small read-only probe.
- `ssh_exec`
  - Run a short command. Internally it is still sent through stdin.
- `ssh_script`
  - Run a multi-line remote shell script through stdin.
  - Prefer this for pipes, redirects, here-docs, `$()`, `$VAR`, nested quotes,
    and anything more complex than one line.
- `ssh_task`
  - Manage async/watch tasks started by `ssh_exec` or `ssh_script`.
- `ssh_file_edit`
  - Replace exact text in one remote file.
  - Defaults to one unique match; pass `replace_all=true` to replace every match.
  - Also accepts `oldString`/`newString`/`replaceAll` aliases for clients whose
    native edit tool uses camelCase.
- `ssh_file_apply_patch`
  - Apply Codex-style multi-file patches and add files.
  - Blank or unmarked hunk lines are treated as context and reported in
    `structuredContent.normalizations`.
  - Hunks with no additions or removals are rejected to catch missing markers.

## Execution Parameters

The SSH and WSL MCPs intentionally use the same execution pattern:

- `ssh_exec` / `ssh_script` take `mode: "sync" | "async" | "watch"`.
- `mode="sync"` waits for completion and returns command output.
- `mode="async"` returns a task snapshot immediately.
- `mode="watch"` waits up to `timeout_ms`; on timeout it follows `on_timeout`.
- `on_timeout` is only for `watch`; use `"detach"` to keep running or `"kill"` to cancel.
- `tail_chars` is only for `ssh_exec` / `ssh_script` watch output.
- Manage background work with `ssh_task`.

Task parameter names intentionally match `wsl_task`:

- `wait_ms` for `ssh_task action="wait"`.
- `stdoutOffset` / `stderrOffset` for offset reads.
- `tail_chars` for task output tailing.

Use `ssh_exec` / `ssh_script` with `mode="async"` for background work.

Prefer `mode="sync"` for normal commands and long builds/tests when there is no
other foreground work to do. Use `mode="async"` only when true background
concurrency is useful. `ssh_task status/output` calls are throttled by default:
if a running task is observed less than 20 seconds after the previous
observation, the MCP server waits until the minimum interval and returns a
warning.

## Device Profiles

Device profiles live in `devices.json` next to this server by default. They are
local, git-ignored, non-secret connection records. They may store:

- friendly name
- user
- one or more candidate hosts/IPs
- port
- identity file path
- per-device SSH options
- default remote working directory
- tags and notes

They must not store passwords.

Example profile:

```json
{
  "version": 1,
  "devices": {
    "rock5a": {
      "name": "rock5a",
      "user": "radxa",
      "hosts": [
        "192.168.31.34",
        "192.168.137.42",
        "10.42.0.23"
      ],
      "identityFile": "C:/Users/y2278/.ssh/id_ed25519",
      "defaultWorkdir": "/home/radxa/Desktop/project",
      "tags": ["rk3588", "devboard"]
    }
  }
}
```

Then tool calls can use `target="rock5a"` instead of `radxa@192.168...`. When a
device has multiple hosts, `ssh_profile test`, `ssh_exec`, and `ssh_script` try
the remembered last successful target first, then saved target/host/hosts. A
successful connection updates `lastResolvedTarget` and `lastSeen`.

Example `ssh_profile upsert_device` arguments:

```json
{
  "action": "upsert_device",
  "name": "rock5a",
  "user": "radxa",
  "hosts": ["192.168.31.34", "192.168.137.42"],
  "defaultWorkdir": "/home/radxa/Desktop/project"
}
```

## Public Key Setup

This MCP intentionally does not accept or store SSH passwords. For first-time
setup, run the password step in a real terminal, then let the MCP verify.

PowerShell equivalent of `ssh-copy-id`:

```powershell
Get-Content $env:USERPROFILE\.ssh\id_ed25519.pub | ssh radxa@192.168.31.34 "umask 077; mkdir -p ~/.ssh; cat >> ~/.ssh/authorized_keys"
```

After that, use:

```text
ssh_profile action="test" target="rock5a"
```

## Codex Config Example

```toml
[mcp_servers.ssh]
command = 'C:\Users\y2278\AppData\Local\OpenAI\Codex\bin\5b9024f90663758b\node.exe'
args = ['C:\Users\y2278\.config\opencode\ssh-mcp-server\dist\index.js']
startup_timeout_sec = 30

[mcp_servers.ssh.env]
SSH_MCP_DEFAULT_TARGET = "radxa@192.168.31.34"
SSH_MCP_BATCH_MODE = "1"
SSH_MCP_STRICT_HOST_KEY_CHECKING = "accept-new"
```

## Environment

- `SSH_MCP_DEFAULT_TARGET`: default SSH target, e.g. `radxa@192.168.31.34`.
- `SSH_MCP_COMMAND`: override the ssh executable path. Default: `ssh`.
- `SSH_MCP_DEFAULT_SHELL`: remote shell. Default: `bash`.
- `SSH_MCP_OPTIONS_JSON`: full default ssh argv override as JSON string array.
- `SSH_MCP_EXTRA_OPTIONS_JSON`: extra default ssh argv as JSON string array.
- `SSH_MCP_BATCH_MODE`: default `1`; set `0` to allow interactive auth.
- `SSH_MCP_CONNECT_TIMEOUT_SEC`: default `10`.
- `SSH_MCP_STRICT_HOST_KEY_CHECKING`: default `accept-new`.
- `SSH_MCP_DEVICES_PATH`: override device profile store path. Default: `devices.json`.
- `SSH_MCP_MIN_POLL_INTERVAL_MS`: default `20000`.
- `SSH_MCP_DEFAULT_SYNC_TIMEOUT_MS`: default `120000`.
- `SSH_MCP_DEFAULT_WATCH_TIMEOUT_MS`: default `120000`.
- `SSH_MCP_MAX_TOOL_TIMEOUT_MS`: default `540000`.

## Good Next Features

- `ssh_sync`: explicit rsync/scp wrapper with dry-run and exclude lists.
- `ssh_key`: explicit public-key install helper, never automatic.
- `ssh_tunnel`: managed local port forwards with task-style lifecycle.
- `ssh_disk`: read-only disk usage snapshot and low-space warnings.
