# remote-mcp

Integrated workspace for SSH, WSL, and remote file MCP servers.

Each package still exposes a separate stdio MCP server, so clients can choose
which ones to load:

- `@remote-mcp/ssh`: SSH command/script/task/profile MCP.
- `@remote-mcp/wsl`: WSL command/script/task/session MCP.
- `@remote-mcp/remote-fs`: remote file operations over SSH or WSL.

`remote-fs` keeps patch parsing and safety checks local, then uses small POSIX
shell snippets on the remote side for reads, writes, listings, stats, and search.

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
