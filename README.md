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

## 文件编辑模型

简单替换优先用 `*_file_edit`：

- `old_string` 必须精确匹配。
- 默认只允许匹配一次；多匹配会报错。
- `replace_all=true` 时替换所有匹配项。
- 兼容 OpenCode 常见参数名：`oldString`、`newString`、`replaceAll`。
- 可传 `expected_sha256` 做乐观锁；冲突时返回当前文件内容和当前 sha256。

复杂修改用 `*_file_apply_patch`：

- 支持 `*** Add File` 和 `*** Update File`。
- 不支持 delete/move，避免模型在大 patch 里顺手删除文件。
- hunk 匹配在本地完成，按 context+removed 行作为连续 subsequence 查找。
- 空行或无 marker 行会被当作 context，但会写入 `structuredContent.normalizations`。
- 重复匹配会写入 `structuredContent.warnings`。

## 返回形状

工具返回 MCP 的 `content` 和 `structuredContent`：

- `content` 给人或模型快速扫结果。
- `structuredContent` 放稳定字段，例如 path、sha256、bytes、encoding、warnings。
- 文件读取的全文在 `structuredContent.text`，`content[0].text` 只放摘要，避免客户端同时展示两份大文本。

## 构建

```powershell
npm install
npm run build
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
- `devices.json`、`.env` 和 `node_modules` 已加入 `.gitignore`。
- 文件工具会修改远程文件，请把它当成真实写操作。
- `*_file_apply_patch` 不支持删除文件。
- WSL 工具默认保护 `/mnt` 下的常见递归删除操作。
- 这个项目由 AI 生成，公开使用前请按自己的威胁模型审计。

## 开源许可

MIT
