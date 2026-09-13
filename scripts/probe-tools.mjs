// Compare complete tools/list payloads, not just top-level descriptions.
import { connectServer } from "./test-client.mjs";

for (const mode of ["core", "split", "unified"]) {
  let totalChars = 0;
  let count = 0;
  for (const backend of ["ssh", "wsl"]) {
    const client = await connectServer(backend, mode === "core" ? {} : {
      REMOTE_MCP_ENABLE_FILE_TOOLS: "1",
      REMOTE_MCP_ENABLE_ADMIN_TOOLS: "1",
      REMOTE_MCP_FILE_API: mode,
    });
    try {
      const { tools } = await client.listTools();
      const rows = tools.map((t) => ({
        name: t.name,
        descriptionChars: t.description?.length ?? 0,
        schemaChars: JSON.stringify(t.inputSchema).length,
        totalChars: JSON.stringify(t).length,
      }));
      const chars = JSON.stringify(tools).length;
      totalChars += chars;
      count += tools.length;
      console.log(JSON.stringify({ mode, backend, count: tools.length, totalChars: chars, tools: rows }));
    } finally { await client.close(); }
  }
  console.log(JSON.stringify({ combined: mode, count, totalChars, unit: "JSON characters, not model tokens" }));
}
