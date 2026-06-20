# remote-mcp

Integrated workspace for SSH, WSL, and remote file MCP servers.

Each package still exposes a separate stdio MCP server, so clients can choose
which ones to load:

- `@remote-mcp/ssh`: SSH command/script/task/profile MCP.
- `@remote-mcp/wsl`: WSL command/script/task/session MCP.
- `@remote-mcp/remote-fs`: remote file operations over SSH or WSL.
- `@remote-mcp/shared`: internal shared code for process spawning, MCP helpers,
  async task management, shell quoting, patch parsing, and remote file ops.

`remote-fs` keeps patch parsing and safety checks local, then uses small POSIX
shell snippets on the remote side for reads, writes, listings, stats, and search.

The public MCP servers remain independent entrypoints. The shared package is not
loaded by clients directly; it keeps behavior consistent across the separate
servers while allowing each server to be enabled or disabled on its own.

## Tools

- `remote_file_read`
- `remote_file_write`
- `remote_file_apply_patch`
- `remote_file_list`
- `remote_file_stat`
- `remote_file_search`

Each tool takes `transport: "wsl" | "ssh"`.

For WSL, pass `distro` or omit it for the system default. For SSH, pass `target`
such as `radxa@192.168.31.34`.

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
