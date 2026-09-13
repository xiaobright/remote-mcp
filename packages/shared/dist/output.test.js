import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { commandOutputResponse, outputResponse } from "./output.js";
function scratch(t) {
    const dir = mkdtempSync(join(tmpdir(), "remote-mcp-output-test-"));
    t.after(() => {
        assert.equal(resolve(dirname(dir)), resolve(tmpdir()));
        assert.ok(dir.includes("remote-mcp-output-test-"));
        rmSync(dir, { recursive: true, force: true });
    });
    return dir;
}
test("stream text is not duplicated in structuredContent", () => {
    const response = outputResponse("hello", { stdout: "hello", stderr: "", exitCode: 0 });
    assert.deepEqual(response.structuredContent, { exitCode: 0 });
    assert.equal(response.content[0].text, "hello");
});
test("oversized sync output is bounded while full logs stay available", (t) => {
    const dir = scratch(t);
    const result = { stdout: "abcdefghij", stderr: "problem", exitCode: 9 };
    const response = commandOutputResponse(result, (r) => `${r.stdout}\n${r.stderr}`, { limit: 4, outputDir: dir });
    assert.match(response.content[0].text, /^ghij\nblem/);
    assert.equal(response.structuredContent.exitCode, 9);
    assert.equal(response.structuredContent.stdoutLength, 10);
    assert.equal(response.structuredContent.stdoutTruncated, true);
    const full = response.structuredContent.fullOutput;
    assert.equal(readFileSync(full.stdout, "utf8"), result.stdout);
    assert.equal(readFileSync(full.stderr, "utf8"), result.stderr);
    assert.equal("stdout" in response.structuredContent, false);
});
test("log-save failure preserves the executed command's exit status", (t) => {
    const dir = scratch(t);
    const blockedPath = join(dir, "not-a-directory");
    writeFileSync(blockedPath, "occupied");
    const response = commandOutputResponse({ stdout: "abcdefghij", stderr: "", exitCode: 0 }, (r) => r.stdout, {
        limit: 4, outputDir: blockedPath,
    });
    assert.equal(response.structuredContent.exitCode, 0);
    assert.match(response.content[0].text, /save failed/);
    assert.match(response.content[0].text, /Do not rerun/);
});
//# sourceMappingURL=output.test.js.map