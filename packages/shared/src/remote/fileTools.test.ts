import assert from "node:assert/strict";
import { test } from "node:test";
import { registerUnifiedRemoteFileTools, type RemoteFileToolHandler } from "./fileTools.js";

function fixture() {
  let schema: { parse: (params: unknown) => Record<string, unknown> };
  let handler: RemoteFileToolHandler;
  const calls: string[] = [];
  registerUnifiedRemoteFileTools({
    server: { registerTool: (_name, config, callback) => { schema = config.inputSchema; handler = callback; } },
    prefix: "test_file", titlePrefix: "Test", targetDescription: "In-memory transport.",
    makeRunner: () => async (script) => {
      calls.push(script);
      return { stdout: Buffer.from("alpha\n"), stderr: "", exitCode: 0 };
    },
  });
  return { calls, call: (params: unknown) => handler(schema.parse(params)) };
}

test("unified read reaches the real handler without leaking action", async () => {
  const f = fixture();
  const result = await f.call({ action: "read", path: "/example" });
  assert.equal(result.isError, undefined);
  assert.match(result.content[0].text, /alpha/);
  assert.equal(f.calls.length, 1);
});

test("unified edit reads, replaces and writes through the dispatcher", async () => {
  const f = fixture();
  const result = await f.call({ action: "edit", path: "/example", old_string: "alpha", new_string: "beta" });
  assert.equal(result.isError, undefined);
  assert.equal(result.structuredContent.replacements, 1);
  assert.match(result.content[0].text, /\+beta/);
  assert.equal(f.calls.length, 2);
});

test("unified patch dry run needs no unrelated path parameter", async () => {
  const f = fixture();
  const result = await f.call({
    action: "apply_patch", dry_run: true,
    patch: "*** Begin Patch\n*** Add File: /example\n+alpha\n*** End Patch",
  });
  assert.equal(result.isError, undefined);
  assert.match(result.content[0].text, /example/);
  assert.equal(f.calls.length, 0);
});

test("unified read still requires path at the action boundary", async () => {
  const f = fixture();
  const result = await f.call({ action: "read" });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /parameter "path" is required/);
  assert.doesNotMatch(result.content[0].text, /read_read|unexpected parameter.*action/);
  assert.equal(f.calls.length, 0);
});
