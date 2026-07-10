# remote-mcp

[中文 README](README.md)

`remote-mcp` is a set of MCP servers for coding agents that need to work with SSH hosts and WSL distributions. It provides command execution, task management, and agent-friendly remote file tools.

It is not a remote resident agent. The MCP servers run locally: the SSH server uses the local `ssh` command, and the WSL server uses the local WSL installation. The remote side only needs ordinary shell tools. Patch parsing, text decoding, encoding detection, and sha256 checks happen locally.

## AI-Generated Notice

This repository's code and documentation were generated and organized by OpenAI Codex from user requirements and test feedback. The user drove the design and validation direction, but did not hand-write the implementation. Treat this as an AI-generated experimental tool and review it before using it in sensitive environments.

Compatibility work mainly targeted Codex and OpenCode. Examples include `*_file_edit` aliases, Codex-style `apply_patch` guidance, and structured result payloads. Claude Code has not received dedicated compatibility work; it may work through standard MCP calls, but it has not been specifically adapted here.

## Why This Exists

Many MCP servers focus on the local filesystem. Many SSH MCP servers focus on command execution. This project sits between those categories: it focuses on helping models edit files in remote directories with fewer format mistakes.

Typical use cases:

- Let an agent work on WSL projects from Windows.
- Edit configuration or code on SSH-accessible Linux devices, servers, OpenWrt/iStoreOS boxes, or development boards.
- Work with remote machines that do not have Node.js, Python, or a resident agent.
- Use `edit` for simple replacements and `apply_patch` for multi-file, multi-hunk, or add-file changes.
- Preserve common text encodings such as UTF-8, GBK, and GB18030.

## Packages

- `@remote-mcp/ssh`: SSH command/script/task/profile tools plus SSH file tools.
- `@remote-mcp/wsl`: WSL command/script/task/session tools plus WSL file tools.
- `@remote-mcp/shared`: shared implementation, not intended to be loaded as an MCP server.

SSH and WSL are loaded separately, so clients can enable only the transport they need.

## Tools

WSL:

- `wsl_session`
- `wsl_exec`
- `wsl_script`
- `wsl_task`
- `wsl_job` (persistent jobs via setsid; survive MCP restarts)
- `wsl_file_read`
- `wsl_file_write`
- `wsl_file_edit`
- `wsl_file_apply_patch`
- `wsl_file_list`
- `wsl_file_stat`
- `wsl_file_search`

SSH:

- `ssh_profile`
- `ssh_exec`
- `ssh_script`
- `ssh_task`
- `ssh_job` (persistent remote jobs via setsid; logs under `~/.remote-mcp/jobs/`)
- `ssh_file_read`
- `ssh_file_write`
- `ssh_file_edit`
- `ssh_file_apply_patch`
- `ssh_file_list`
- `ssh_file_stat`
- `ssh_file_search`

## File Editing Model

Use `*_file_edit` for simple replacements:

- `old_string` must match exactly.
- The default requires one unique match; multiple matches return an error.
- `replace_all=true` replaces every match.
- OpenCode-style aliases are accepted: `oldString`, `newString`, `replaceAll`.
- `expected_sha256` can be used as an optimistic lock. Conflicts return the current file text and current sha256.

Use `*_file_apply_patch` for more complex changes:

- Supports `*** Add File` and `*** Update File`.
- Does not support delete or move operations.
- Hunk matching is local and line-based: context+removed lines must appear as a contiguous subsequence.
- Blank or unmarked hunk lines are tolerated as context and reported in `structuredContent.normalizations`.
- Ambiguous repeated matches are reported in `structuredContent.warnings`.

## Return Shape

Tools return MCP `content` plus `structuredContent`:

- `content` is a compact human/model-readable summary.
- `structuredContent` contains stable fields such as path, sha256, bytes, encoding, and warnings.
- Full file reads are returned in `structuredContent.text`; `content[0].text` contains only a short summary to avoid duplicating large text in clients that display both fields.

## Build

```powershell
npm install
npm run build
```

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
- File tools perform real writes on remote files.
- `*_file_apply_patch` does not support file deletion.
- The WSL tools protect common recursive delete operations under `/mnt` by default.
- This project is AI-generated. Review it according to your own threat model before use.

## License

MIT
