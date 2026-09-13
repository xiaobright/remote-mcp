# remote-mcp

[English README](README.en.md)

`remote-mcp` 是面向 coding agent 的 SSH / WSL 执行工具：可靠传递命令和多行脚本、管理后台任务、续读有界日志。默认每个服务器只提供 **5 个工具**，不要求安装配套 skill。

它不是远程常驻 agent：MCP 服务器运行在本地，SSH 版本调用本机 `ssh`，WSL 版本调用 `wsl.exe`。每次执行使用新 shell，不保留上次的 `cd` 或环境变量。持久任务另需远端具备 `bash`、`setsid`、`base64` 和基本 shell 工具。

## AI 生成声明

这个仓库的代码和文档由 OpenAI Codex 根据用户需求迭代生成和整理。用户提出了设计目标、测试反馈和取舍方向，但没有手写代码。请把它当成一个 AI 生成的实验性工具来审计和使用，不要默认认为它已经经过了传统人工维护项目的安全审查。

接口使用标准 MCP tools/list 和 tools/call。不同客户端如何显示工具、传递结构化元数据、限制调用时长，仍需分别验证；不承诺所有客户端具有相同交互体验。

## 为什么做这个

重点不是复制一套编辑器，而是减少 Windows 到 Linux 的引号陷阱、长任务重复启动、错误状态判断和日志上下文浪费。

典型场景：

- Windows 上让模型操作 WSL 项目。
- 通过 SSH 操作开发板、服务器等 Linux 设备。
- 执行多行脚本和 here-doc，避免嵌套 Windows shell 转义。
- 等待构建、训练、服务，并在 MCP 重启后重新接入持久任务。
- 文件读取、搜索和修改默认通过 `exec` / `script` 完成。

## 包结构

- `@remote-mcp/ssh`：SSH 命令、脚本、任务和帮助。
- `@remote-mcp/wsl`：WSL 命令、脚本、任务和帮助。
- `@remote-mcp/shared`：共享实现，不作为独立 MCP 加载。

SSH 和 WSL 分开加载。你只需要 SSH 就只启用 SSH MCP，只需要 WSL 就只启用 WSL MCP。

## 工具列表

| WSL | SSH | 用途 |
| --- | --- | --- |
| `wsl_exec` | `ssh_exec` | 命令，默认同步等待 |
| `wsl_script` | `ssh_script` | 多行脚本，通过 stdin 传递 |
| `wsl_task` | `ssh_task` | 管理 exec/script 的 async/watch 任务 |
| `wsl_job` | `ssh_job` | 可跨 MCP 重启的持久任务 |
| `wsl_help` | `ssh_help` | 按需说明 |

`help(topic)` 支持 `overview`（默认）、`execution`、`jobs`、`output`、`connection`、`files`。普通调用无需先读帮助；帮助不会执行命令、改变配置或动态启用工具。

可选能力默认不注册，修改环境变量后需重启 MCP 连接：

- `REMOTE_MCP_ENABLE_ADMIN_TOOLS=1`：启用 `wsl_session` / `ssh_profile`。WSL keepalive 自动启动；SSH 默认目标和原生 `~/.ssh/config` 可直接使用，无需先调用管理工具。
- `REMOTE_MCP_ENABLE_FILE_TOOLS=1`：显式启用旧文件工具。`REMOTE_MCP_FILE_API=unified` 为一个 `*_file`，其他值为五个拆分工具。**仅有旧的 `REMOTE_MCP_FILE_API=unified` 配置不会启用文件工具。**

禁用文件工具只减少接口暴露，不阻止 shell 文件操作，也不是权限沙箱。

## 任务模型

| 类型 | 工具 | 生命周期 | 说明 |
|------|------|----------|------|
| attached task | `*_exec`/`*_script` mode=`async`/`watch` + `*_task` | 随 MCP 进程 | 本地 child（ssh/wsl.exe）存活期间可读输出 |
| persistent job | `*_job` | 跨 MCP 重启 | 远端/WSL 内 setsid；取消以 session leader PID 为准并校验存活 |

`*_task` 的 cancel 会尽量杀掉本地进程树（Windows 上 `taskkill /T`）；远端若已 `nohup`/daemon 化可能仍残留。长任务且需跨重启请用 `*_job`。
cancel 返回取消请求后的状态；需要确认本地 child 已退出时继续 wait，只有进程关闭后才返回 completed。

`sync` 默认超时 120s，超时会停止本地 child；`watch` 超时默认 detach，返回可续接的 taskId。不要把未收到结果当作未执行，然后盲目重跑有副作用的命令。

`task wait` 与 `job wait` 默认等待 60s，完成会提前返回。`wait` 到期表示等待预算用完，不等于任务失败。单次工具等待受超时上限约束；客户端外层超时必须更长。

job 默认最大运行时间为 1h，训练或服务需显式增大 `max_runtime_ms`。job 不保证跨机器重启或 WSL 关闭存活。启动前记录 jobId 和连接信息，启动结果不确定时用同一 ID 检查，而不是重复启动。工作目录不存在时终止，不回退到 HOME。

## 输出与续读

- 同步输出默认每个流最多显示末尾 8192 字符；超长完整输出保存到 MCP **宿主机**的 `work/command-output/<id>/`，返回 `fullOutput` 路径。它是输出展示限额，不是底层进程内存限额。
- task 日志是有界内存尾部，可能淘汰旧内容；job 完整日志在远端 `~/.remote-mcp/jobs/<jobId>/`。
- `delta` 不传 offset 时返回有界尾部，并不是服务端维护的“未读游标”。续读时传回 `nextStdoutOffset` / `nextStderrOffset`。
- `read_mode="full"` 加两个 offset 为 0，从头分页读取；每页仍有上限。显式 offset=0 不会被当成省略。
- task offset 单位是 JavaScript UTF-16 code unit，job offset 是字节；原样复用返回值。`tail_chars` 覆盖 offset，且仍受每页上限约束。
- 日志可能含敏感信息，不自动清理、不默认适合分享。若完整输出保存失败，返回警告，保留命令本身的退出码，不伪装成需要重跑的执行失败。

## 旧文件能力（默认禁用）

保留 read/write/edit/apply_patch/search 实现，供明确启用后使用，不继续作为项目核心。patch 仅支持 Add/Update，不支持 Delete/Move，也不是原生编辑器替代品。

已知限制包括：patch 换行归一化、BOM 不完整保留、重复 hunk 匹配选择首处、符号链接及权限元数据处理有限。临时文件 rename 与 sha256 检查不等于完整并发事务，多文件写入也不保证整体原子性。需要可靠文件修改时，仍应确认匹配范围并检查差异。

## 返回形状

工具返回 MCP 的 `content` 和 `structuredContent`：

- `content` 给人或模型快速扫结果。
- 执行类 `structuredContent` 放退出码、状态、offset、截断标记和日志路径，**不再重复 stdout/stderr**。使用旧版结构化 stdout/stderr 的客户端需调整。
- 旧文件工具仍使用各自返回形状。目录和属性通过 exec 跑 `ls` / `stat`。

## 构建与测试

```powershell
npm install
npm run build
npm test
npm run probe
```

`npm test` 包含纯函数测试、隔离的 MCP 调用链测试与工具注册测试，不连接真实 SSH/WSL 目标。`probe` 统计完整 tools/list JSON 字符数，不将字符数冒充模型 token。

Windows 上显式执行 `npm run test:wsl` 可运行 WSL 实机冒烟：命令/脚本、工作目录、输出分页、MCP 重启续接、job 取消。它使用自己的任务注册表，保留日志和 `work/smoke-wsl/` 下证据，不操作已有任务。真实 SSH 主机需另行验证。

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
- exec/script/job 都能产生真实副作用；默认禁用文件工具不降低 shell 权限。
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
| `REMOTE_MCP_ENABLE_FILE_TOOLS` | 仅 `1` 注册旧文件工具，默认禁用 |
| `REMOTE_MCP_ENABLE_ADMIN_TOOLS` | 仅 `1` 注册 session/profile，默认禁用 |
| `REMOTE_MCP_FILE_API` | 文件工具启用后选择 `unified` 或默认拆分 |
| `REMOTE_MCP_OUTPUT_LIMIT_CHARS` | 同步结果每个流的展示上限，默认 8192 |
| `REMOTE_MCP_OUTPUT_DIR` | 超长同步结果的本地完整日志目录 |
| `REMOTE_MCP_PERSISTENT_JOB_STORE_PATH` | 本地 job 注册表路径，默认 `work/persistent-jobs.json`；跨重启续接需要保留 |
| `*_DEFAULT_TASK_WAIT_MS` | task 默认等待时间，默认 60000 |
| `*_MIN_POLL_INTERVAL_MS` | task status/output 节流间隔，默认 60000 |
| `*_MAX_TOOL_TIMEOUT_MS` | 单次工具超时上限（默认 540s） |
| `*_PERSISTENT_JOB_MAX_RUNTIME_MS` | 持久任务默认最大运行时间（1h） |

## 开源许可

MIT
