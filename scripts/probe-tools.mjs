// MCP 工具清单探针：对比 legacy / unified 模式下 SSH/WSL 的工具数量与 description 体积
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const node = process.execPath;

async function probe(name, cmd, extraEnv = {}) {
  const transport = new StdioClientTransport({
    command: cmd[0],
    args: cmd.slice(1),
    env: { ...process.env, ...extraEnv },
  });
  const client = new Client({ name: "probe", version: "1.0.0" });
  try {
    await client.connect(transport);
    const { tools } = await client.listTools();
    const total = tools.reduce((n, t) => n + (t.description?.length ?? 0), 0);
    const rows = tools.map((t) => `    ${t.name}: ${t.description?.length ?? 0} chars`).join("\n");
    console.log(`\n== ${name} ==`);
    console.log(`  工具数: ${tools.length} | description 合计: ${total} chars`);
    console.log(rows);
    return { tools: tools.length, chars: total, names: tools.map((t) => t.name) };
  } catch (err) {
    console.log(`\n== ${name} == 失败: ${err.message}`);
    return { tools: 0, chars: 0, names: [] };
  } finally {
    await client.close();
  }
}

const results = [];
results.push(await probe("SSH legacy", [node, "packages/ssh/dist/index.js"]));
results.push(await probe("SSH unified", [node, "packages/ssh/dist/index.js"], { REMOTE_MCP_FILE_API: "unified" }));
results.push(await probe("WSL legacy", [node, "packages/wsl/dist/index.js"]));
results.push(await probe("WSL unified", [node, "packages/wsl/dist/index.js"], { REMOTE_MCP_FILE_API: "unified" }));

const legacyChars = results[0].chars + results[2].chars;
const unifiedChars = results[1].chars + results[3].chars;
console.log(`\n==== 汇总 ====`);
console.log(`SSH+WSL legacy  description 合计: ${legacyChars} chars (${results[0].tools}+${results[2].tools} 工具)`);
console.log(`SSH+WSL unified description 合计: ${unifiedChars} chars (${results[1].tools}+${results[3].tools} 工具)`);
console.log(`节省: ${legacyChars - unifiedChars} chars (${((legacyChars - unifiedChars) / legacyChars * 100).toFixed(0)}%)`);
