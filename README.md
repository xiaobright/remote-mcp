# remote-mcp

Integrated workspace for SSH and WSL remote tool MCP servers.

The main public servers are transport-focused, so clients can load only the
remote world they actually need:

- `@remote-mcp/ssh`: SSH command/script/task/profile plus SSH file tools.
- `@remote-mcp/wsl`: WSL command/script/task/session plus WSL file tools.
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

For focused one-file replacements, use `*_file_edit`: it takes
`old_string`/`new_string`, requires a unique match by default, and supports
`replace_all=true` when every match should be changed. `*_file_apply_patch`
remains the multi-file/multi-hunk/new-file tool. Its Codex-style patch parser is
slightly tolerant of blank or unmarked context lines, but reports each
normalization in `structuredContent.normalizations` and rejects hunks with no
actual additions or removals.

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
- `ssh_file_read`
- `ssh_file_write`
- `ssh_file_edit`
- `ssh_file_apply_patch`
- `ssh_file_list`
- `ssh_file_stat`
- `ssh_file_search`

## Return Shape

Tool results use MCP's `content` plus `structuredContent` shape. Human-readable
or directly consumable text is returned in `content`; stable machine-readable
metadata is returned in `structuredContent`. File reads return a short summary
in `content[0].text`; the full file text is in `structuredContent.text` with
path, bytes, sha256, encoding, detectedEncoding, and encodingConfidence.

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
