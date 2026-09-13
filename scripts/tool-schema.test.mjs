import assert from "node:assert/strict";
import test from "node:test";
import { connectServer, textOf } from "./test-client.mjs";

for (const backend of ["ssh", "wsl"]) {
  test(`${backend}: core-only defaults, including with a legacy unified setting`, async () => {
    const client = await connectServer(backend, { REMOTE_MCP_FILE_API: "unified" });
    try {
      const { tools } = await client.listTools();
      assert.deepEqual(tools.map((t) => t.name).sort(), ["exec", "script", "task", "job", "help"].map((n) => `${backend}_${n}`).sort());
      assert.ok(JSON.stringify(tools).length < 8500, "full schema budget, not just description length");
      for (const tool of tools) assert.doesNotMatch(tool.description, /remote-execution skill|prefer.*file_/i);
      const overview = await client.callTool({ name: `${backend}_help`, arguments: {} });
      assert.match(textOf(overview), /files=disabled/);
      for (const topic of ["execution", "jobs", "output", "connection", "files"]) {
        const result = await client.callTool({ name: `${backend}_help`, arguments: { topic } });
        assert.notEqual(result.isError, true);
        assert.ok(textOf(result).length < 2300);
      }
      const disabled = await client.callTool({ name: `${backend}_file`, arguments: { action: "read", path: "/unused" } });
      assert.equal(disabled.isError, true);
      const invalid = await client.callTool({ name: `${backend}_exec`, arguments: { command: "", bogus: 1 } });
      assert.equal(invalid.isError, true);
      const unknown = await client.callTool({ name: `${backend}_task`, arguments: { action: "status", taskId: "does-not-exist" } });
      assert.equal(unknown.isError, true);
    } finally { await client.close(); }
  });

  for (const mode of ["split", "unified"]) {
    test(`${backend}: ${mode} files/admin require explicit enable flags`, async () => {
      const client = await connectServer(backend, {
        REMOTE_MCP_ENABLE_FILE_TOOLS: "1",
        REMOTE_MCP_ENABLE_ADMIN_TOOLS: "1",
        REMOTE_MCP_FILE_API: mode,
      });
      try {
        const { tools } = await client.listTools();
        const names = tools.map((t) => t.name);
        assert.ok(names.includes(backend === "ssh" ? "ssh_profile" : "wsl_session"));
        const files = tools.filter((t) => t.name.startsWith(`${backend}_file`));
        assert.equal(files.length, mode === "split" ? 5 : 1);
        assert.equal(tools.length, mode === "split" ? 11 : 7);
        if (mode === "unified") {
          assert.ok(files[0].inputSchema.properties.action);
          assert.ok(files[0].inputSchema.properties.path);
          assert.ok(!files[0].inputSchema.required.includes("path"));
          const patch = await client.callTool({
            name: `${backend}_file`,
            arguments: { action: "apply_patch", dry_run: true, patch: "*** Begin Patch\n*** Add File: /unused\n+example\n*** End Patch" },
          });
          assert.notEqual(patch.isError, true, textOf(patch));
        }
      } finally { await client.close(); }
    });
  }
}
