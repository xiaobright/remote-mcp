# remote-mcp

[English README](README.en.md)

`remote-mcp` 是一组面向 coding agent 的 MCP 服务器，用来在 SSH 主机和 WSL 发行版里运行命令、管理任务，并以更适合模型使用的方式读写远程文件。

它不是远程常驻 agent：MCP 服务器运行在本地，SSH 版本通过本机 `ssh` 命令连接远程主机，WSL 版本通过本机 WSL 调用发行版。远程侧只需要常见的 shell 工具；文件编辑、patch 解析、编码检测、sha256 校验都在本地完成。

## AI 生成声明

这个仓库的代码和文档由 OpenAI Codex 根据用户需求迭代生成和整理。用户提出了设计目标、测试反馈和取舍方向，但没有手写代码。请把它当成一个 AI 生成的实验性工具来审计和使用，不要默认认为它已经经过了传统人工维护项目的安全审查。

兼容性主要围绕 Codex 和 OpenCode 做过专门调整，例如 `*_file_edit` 的参数别名、Codex-style `apply_patch` 格式说明、结构化返回信息等。Claude Code 没有专门适配；理论上只要客户端按标准 MCP 调用工具就可以使用，但这里没有做专门验证。

## 为什么做这个

很多 MCP 服务器只解决本地文件系统，很多 SSH MCP 只解决远程命令执行。这个项目夹在中间：它更关心模型如何低成本、少出错地修改远程目录里的文件。

典型场景：

- Windows 上让模型操作 WSL 项目。
- 通过 SSH 修改开发板、服务器、OpenWrt/iStoreOS 等纯 Linux 设备上的配置或代码。
- 远程机器没有 Node.js、Python 或常驻 agent，但有基础 POSIX shell。
- 希望模型用 `edit` 做简单替换，用 `apply_patch` 做多文件、多 hunk、新增文件。
- 希望读写时自动处理 UTF-8、GBK、GB18030 等常见文本编码。

## 包结构

- `@remote-mcp/ssh`：SSH 命令、脚本、任务、设备 profile 和 SSH 文件工具。
- `@remote-mcp/wsl`：WSL 命令、脚本、任务、会话和 WSL 文件工具。
- `@remote-mcp/shared`：共享实现，不作为独立 MCP 加载。

SSH 和 WSL 分开加载。你只需要 SSH 就只启用 SSH MCP，只需要 WSL 就只启用 WSL MCP。

## 工具列表

WSL:

- `wsl_session`
- `wsl_exec`
- `wsl_script`
- `wsl_task`
- `wsl_job`（持久任务：setsid 脱离 MCP 生命周期）
- `wsl_file_read`
- `wsl_file_write`
- `wsl_file_edit`
- `wsl_file_apply_patch`
- `wsl_file_search`

SSH:

- `ssh_profile`
- `ssh_exec`
- `ssh_script`
- `ssh_task`
- `ssh_job`（持久任务：远程 setsid，日志在远端 `~/.remote-mcp/jobs/`）
- `ssh_file_read`
- `ssh_file_write`
- `ssh_file_edit`
- `ssh_file_apply_patch`
- `ssh_file_search`

设了 `REMOTE_MCP_FILE_API=unified` 时，每个 server 的 5 个 `*_file_*` 工具合并为 1 个 `*_file`，用 `action` 区分 `read`/`write`/`edit`/`apply_patch`/`search`。

## 任务模型

| 类型 | 工具 | 生命周期 | 说明 |
|------|------|----------|------|
| attached task | `*_exec`/`*_script` mode=`async`/`watch` + `*_task` | 随 MCP 进程 | 本地 child（ssh/wsl.exe）存活期间可读输出 |
| persistent job | `*_job` | 跨 MCP 重启 | 远端/WSL 内 setsid；取消以 session leader PID 为准并校验存活 |

`*_task` 的 cancel 会尽量杀掉本地进程树（Windows 上 `taskkill /T`）；远端若已 `nohup`/daemon 化可能仍残留。长任务且需跨重启请用 `*_job`。

## 文件编辑模型

简单替换优先用 `*_file_edit`：

- `old_string` 必须精确匹配；CRLF 文件即使用 LF 的 old_string 也能匹配，并保留 CRLF。
- 默认只允许匹配一次；多匹配报错并列出各匹配行号。
- 0 次匹配时报错含最接近区域（行号 + JSON 转义文本）、空白差异提示和修复指引，而不是一句干巴巴的 "did not match"。
- `replace_all=true` 时替换所有匹配项。
- 拆分模式下兼容参数名别名 `oldString`、`newString`、`replaceAll`；unified 模式只接受规范名 `old_string`/`new_string`/`replace_all`。
- 可传 `expected_sha256`（来自 read 返回）做乐观锁；冲突时报错并给出当前 sha256，重读重试即可。
- 成功返回 unified diff 和新 sha256，同回合即可核对；`dry_run=true` 只预览不落盘。

复杂修改用 `*_file_apply_patch`：

- 支持 `*** Add File` 和 `*** Update File`。
- 不支持 delete/move，避免模型在大 patch 里顺手删除文件。
- unified diff 头（`--- a/x`、`+++ b/x`、`diff --git`）与 `@@ -a,b +c,d @@` 计数头会被显式拒绝并提示格式，混用格式不会静默写坏文件。
- hunk 匹配在本地完成，按 context+removed 行作为连续 subsequence 查找。
- **两阶段应用**：先对所有文件完成读入与 hunk 匹配，再统一写入；规划阶段失败时不会写任何文件。写入阶段若中途失败，错误会注明可能已部分写入。
- 空行或无 marker 行会被当作 context，但会写入 `structuredContent.normalizations`。
- 重复匹配会写入 `structuredContent.warnings`。
- 成功返回每个文件的 unified diff；`dry_run=true` 只预览。

## 返回形状

工具返回 MCP 的 `content` 和 `structuredContent`：

- `content` 给人或模型快速扫结果。
- `structuredContent` 放稳定字段，例如 path、sha256、bytes、encoding、diff、warnings。
- 文件读取的全文放在 `content`（所有客户端都会透传给模型，包括不渲染 `structuredContent` 的）；`structuredContent` 只放元数据，避免大文本双份。
- 列目录、查路径属性没有专门工具：用 `wsl_exec`/`ssh_exec` 跑 `ls`/`stat`。

## 构建与测试

```powershell
npm install
npm run build
npm test
```

## 运行

```powershell
node packages/ssh/dist/index.js
node packages/wsl/dist/index.js
```

## MCP 配置示例

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

不同客户端的 MCP 配置格式略有差异，请按客户端文档调整字段名和路径。

## 安全边界

- SSH MCP 不保存密码。建议使用 SSH key。
- 默认 `StrictHostKeyChecking=accept-new` 便于首次连接；生产环境可设 `SSH_MCP_STRICT_HOST_KEY_CHECKING=yes`。
- `devices.json`、`.env` 和 `node_modules` 已加入 `.gitignore`。device 与 persistent job 元数据写入有本地文件锁。
- 文件工具会修改远程文件，请把它当成真实写操作。
- `*_file_apply_patch` 不支持删除文件。
- WSL 工具默认拦截常见删除命令（`rm`/`rmdir`/`unlink`/带 delete 的 `rsync`）目标落在 `/mnt` 的情况。这是**最佳努力**，不是沙箱：`command rm`、`find -delete`、Python/`os.remove` 等仍可绕过。
- 这个项目由 AI 生成，公开使用前请按自己的威胁模型审计。

## 主要环境变量

| 变量 | 作用 |
|------|------|
| `SSH_MCP_DEFAULT_TARGET` | 默认 SSH target 或 device 名 |
| `SSH_MCP_DEVICES_PATH` | device 配置文件路径 |
| `SSH_MCP_STRICT_HOST_KEY_CHECKING` | 默认 `accept-new` |
| `SSH_MCP_BATCH_MODE` | 设为 `0` 可关闭 BatchMode |
| `WSL_MCP_DEFAULT_DISTRO` | 默认 WSL 发行版 |
| `WSL_MCP_PROTECT_MNT_DELETE` | 设为 `0` 关闭 /mnt 删除防护 |
| `REMOTE_MCP_FILE_API` | 设为 `unified` 时把 5 个 `*_file_*` 合并为 1 个 `*_file`（`action` 区分）；不设则保持拆分工具 |
| `*_MAX_TOOL_TIMEOUT_MS` | 单次工具超时上限（默认 540s） |
| `*_PERSISTENT_JOB_MAX_RUNTIME_MS` | 持久任务默认最大运行时间（1h） |

## 开源许可

MIT
