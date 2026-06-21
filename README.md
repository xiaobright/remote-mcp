# remote-mcp

Integrated workspace for SSH and WSL remote tool MCP servers.

The main public servers are transport-focused, so clients can load only the
remote world they actually need:

- `@remote-mcp/ssh`: SSH command/script/task/profile plus SSH file tools.
- `@remote-mcp/wsl`: WSL command/script/task/session plus WSL file tools.
- `@remote-mcp/remote-fs`: compatibility server for the older transport-selecting
  remote file tools.
- `@remote-mcp/shared`: internal shared code for process spawning, MCP helpers,
  async task management, shell quoting, patch parsing, and remote file ops.

File tools keep patch parsing and safety checks local, then use small POSIX shell
snippets on the remote side for reads, writes, listings, stats, and search. File
content is transferred as bytes and decoded/encoded locally. Encoding defaults
to `auto`: UTF-8 is preferred when valid, common Chinese legacy encodings such
as GBK/GB18030 are detected when UTF-8 is invalid, and low-confidence cases ask
the caller to pass `encoding` explicitly. Patch updates preserve the detected
source-file encoding. Small writes can fall back to POSIX `printf` when a slim
remote device lacks `base64`.

The shared package is not loaded by clients directly; it keeps behavior
consistent across the separate servers while allowing each server to be enabled
or disabled on its own.

## Tools

WSL:

- `wsl_session`
- `wsl_exec`
- `wsl_script`
- `wsl_task`
- `wsl_file_read`
- `wsl_file_write`
- `wsl_file_apply_patch`
- `wsl_file_list`
- `wsl_file_stat`
- `wsl_file_search`

SSH:

- `ssh_profile`
- `ssh_exec`
- `ssh_script`
- `ssh_task`
- `ssh_file_read`
- `ssh_file_write`
- `ssh_file_apply_patch`
- `ssh_file_list`
- `ssh_file_stat`
- `ssh_file_search`

Compatibility:

- `remote_file_read`
- `remote_file_write`
- `remote_file_apply_patch`
- `remote_file_list`
- `remote_file_stat`
- `remote_file_search`

The compatibility tools still take `transport: "wsl" | "ssh"`. Prefer the
transport-specific `wsl_file_*` and `ssh_file_*` tools for new configurations.

## Return Shape

Tool results use MCP's `content` plus `structuredContent` shape. Human-readable
or directly consumable text is returned in `content`; stable machine-readable
metadata is returned in `structuredContent`. File reads return the file text only
in `content[0].text`, while `structuredContent` carries path, bytes, sha256,
encoding, detectedEncoding, and encodingConfidence.

## Build

```powershell
npm install
npm run build
```

## Run

```powershell
node packages/ssh/dist/index.js
node packages/wsl/dist/index.js
node packages/remote-fs/dist/index.js
```
