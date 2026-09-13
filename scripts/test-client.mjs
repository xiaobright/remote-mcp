import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

export async function connectServer(backend, extraEnv = {}) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [`packages/${backend}/dist/index.js`],
    env: {
      ...process.env,
      REMOTE_MCP_ENABLE_FILE_TOOLS: "0",
      REMOTE_MCP_ENABLE_ADMIN_TOOLS: "0",
      REMOTE_MCP_FILE_API: "",
      ...extraEnv,
    },
    stderr: "pipe",
  });
  const client = new Client({ name: "remote-mcp-check", version: "1.0.0" });
  try {
    await client.connect(transport);
    return client;
  } catch (error) {
    await client.close();
    throw error;
  }
}

export function textOf(result) {
  return result.content.filter((item) => item.type === "text").map((item) => item.text).join("\n");
}
