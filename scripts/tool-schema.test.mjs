import assert from "node:assert/strict";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

async function listUnifiedTools(serverPath) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [serverPath],
    env: { ...process.env, REMOTE_MCP_FILE_API: "unified" },
  });
  const client = new Client({ name: "tool-schema-test", version: "1.0.0" });
  try {
    await client.connect(transport);
    return (await client.listTools()).tools;
  } finally {
    await client.close();
  }
}

for (const [name, serverPath, toolName] of [
  ["SSH", "packages/ssh/dist/index.js", "ssh_file"],
  ["WSL", "packages/wsl/dist/index.js", "wsl_file"],
]) {
  test(`${name} unified file tool exposes its input schema`, async () => {
    const tools = await listUnifiedTools(serverPath);
    const tool = tools.find((item) => item.name === toolName);
    assert.ok(tool, `${toolName} should be registered`);
    assert.equal(tool.inputSchema?.type, "object");
    assert.ok(tool.inputSchema?.properties?.action, "action must be visible to clients");
    assert.ok(tool.inputSchema?.properties?.path, "path must be visible to clients");
    assert.ok(tool.inputSchema?.properties?.patch, "patch must be visible to clients");
    assert.deepEqual(tool.inputSchema.properties.action.enum, [
      "read",
      "write",
      "edit",
      "apply_patch",
      "search",
    ]);
  });
}

async function listLegacyTools(serverPath) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [serverPath],
  });
  const client = new Client({ name: "tool-schema-test-legacy", version: "1.0.0" });
  try {
    await client.connect(transport);
    return (await client.listTools()).tools;
  } finally {
    await client.close();
  }
}

for (const [name, serverPath, prefix] of [
  ["SSH", "packages/ssh/dist/index.js", "ssh_file_"],
  ["WSL", "packages/wsl/dist/index.js", "wsl_file_"],
]) {
  test(`${name} legacy mode registers exactly the five file tools`, async () => {
    const tools = await listLegacyTools(serverPath);
    const fileTools = tools.map((item) => item.name).filter((item) => item.startsWith(prefix));
    assert.deepEqual(fileTools.sort(), [
      `${prefix}apply_patch`,
      `${prefix}edit`,
      `${prefix}read`,
      `${prefix}search`,
      `${prefix}write`,
    ]);
    for (const tool of tools.filter((item) => item.name.startsWith(prefix))) {
      if (tool.name === `${prefix}read`) {
        assert.ok(tool.description.includes("remote-execution skill"), `${tool.name} description should point at the skill`);
      }
      assert.ok(tool.description.length < 700, `${tool.name} description should stay lean`);
    }
  });
}
