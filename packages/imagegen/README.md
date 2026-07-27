# imagegen-mcp-server

独立的 stdio MCP 图片生成服务。它不依赖 Codex imagegen skill，直接使用
OpenAI-compatible Image API；API key、base URL、模型、并发和输出目录都由环境变量控制。

## Tools

- `imagegen_session`: 查看配置和队列状态，不返回 API key。
- `imagegen_generate`: 文字生成图片。
- `imagegen_edit`: 使用本地图片路径编辑、合成或参考生成。
- `imagegen_batch`: 混合提交 `generate` 和 `edit` 任务。
- `imagegen_task`: `status` / `output` / `wait` / `cancel` / `list`。

单图工具支持 `mode=sync|async|watch`，行为与 `wsl_exec` / `ssh_exec` 一致：

- `sync` 等待完成；
- `async` 立即返回 `taskId`；
- `watch` 等待 `timeout_ms`，超时默认保留任务继续运行。

## Environment

MCP 默认自动加载本 package 目录下的 `.env`。也可以在 MCP 配置的 `env` 中设置
`IMAGEGEN_MCP_ENV_FILE` 覆盖加载路径：

```text
OPENAI_API_KEY=...
OPENAI_BASE_URL=https://carrotbot.store/v1
IMAGEGEN_MCP_MODEL=gpt-image-2
IMAGEGEN_MCP_OUTPUT_DIR=C:\Users\y2278\.codex\custom-image-api\output\imagegen
IMAGEGEN_MCP_CONCURRENCY=3
IMAGEGEN_MCP_MAX_ATTEMPTS=3
IMAGEGEN_MCP_REQUEST_TIMEOUT_MS=600000
IMAGEGEN_MCP_DEFAULT_SYNC_TIMEOUT_MS=600000
IMAGEGEN_MCP_DEFAULT_WATCH_TIMEOUT_MS=120000
IMAGEGEN_MCP_MAX_WAIT_MS=1500000
IMAGEGEN_MCP_MIN_POLL_INTERVAL_MS=20000
IMAGEGEN_MCP_MAX_FINISHED_TASKS=100
```

`IMAGEGEN_MCP_MAX_WAIT_MS` 是单次工具调用等待的上限（默认 25 分钟），`timeout_ms` / `wait_ms`
超过它会被钳制并在返回里标记 `timeoutClamped` / `waitClamped`。运行中的任务通过
`imagegen_task action=status|output` 轮询时会按 `IMAGEGEN_MCP_MIN_POLL_INTERVAL_MS` 节流，
与 `wsl` / `ssh` 的 task 轮询行为一致；建议优先用 `action=wait`。

`IMAGEGEN_MCP_MODEL` 不会出现在任何 MCP 工具参数中，模型只能表达生成/编辑意图。

## MCP config

```toml
[mcp_servers.imagegen]
command = 'node'
args = ['C:\Users\y2278\remote-mcp\packages\imagegen\dist\index.js']
startup_timeout_sec = 30

[mcp_servers.imagegen.env]
IMAGEGEN_MCP_ENV_FILE = 'C:\Users\y2278\remote-mcp\packages\imagegen\.env'
IMAGEGEN_MCP_OUTPUT_DIR = 'C:\Users\y2278\.codex\custom-image-api\output\imagegen'
```

图片编辑输入使用 MCP 进程可读取的本地路径。任务输出写入 `IMAGEGEN_MCP_OUTPUT_DIR`，
通过 `imagegen_task action=output` 可以按需把结果作为 MCP image content 返回。

当前异步任务是 MCP 进程内任务，MCP 重启后不会自动恢复；这对应 WSL/SSH 的普通 task，
后续如需跨重启恢复，可以再增加类似 `wsl_job` / `ssh_job` 的持久任务层。
