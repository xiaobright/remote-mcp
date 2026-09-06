import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { unifiedDiff } from "./diff.js";

describe("unifiedDiff", () => {
  it("returns empty diff for identical text", () => {
    const result = unifiedDiff("a\nb\nc", "a\nb\nc", "f.txt");
    assert.equal(result.diff, "");
    assert.equal(result.added, 0);
    assert.equal(result.removed, 0);
    assert.equal(result.truncated, false);
  });

  it("produces a correct hunk for a single-line replacement", () => {
    const result = unifiedDiff("one\ntwo\nthree", "one\nTWO\nthree", "f.txt");
    assert.equal(result.added, 1);
    assert.equal(result.removed, 1);
    assert.equal(
      result.diff,
      ["--- a/f.txt", "+++ b/f.txt", "@@ -1,3 +1,3 @@", " one", "-two", "+TWO", " three"].join("\n"),
    );
  });

  it("handles insertion at file start", () => {
    const result = unifiedDiff("b", "a\nb", "f.txt");
    assert.equal(result.added, 1);
    assert.equal(result.removed, 0);
    assert.ok(result.diff.includes("@@ -1,1 +1,2 @@"), result.diff);
    assert.ok(result.diff.includes("+a"), result.diff);
    assert.ok(result.diff.includes(" b"), result.diff);
  });

  it("handles full-file creation", () => {
    const result = unifiedDiff("", "x\ny", "f.txt");
    assert.equal(result.added, 2);
    assert.ok(result.diff.includes("@@ -0,0 +1,2 @@"), result.diff);
    assert.ok(result.diff.startsWith("--- a/f.txt\n+++ b/f.txt"), result.diff);
  });

  it("handles full-file deletion", () => {
    const result = unifiedDiff("x\ny", "", "f.txt");
    assert.equal(result.removed, 2);
    assert.ok(result.diff.includes("@@ -1,2 +0,0 @@"), result.diff);
  });

  it("emits separate hunks for scattered changes", () => {
    const original = Array.from({ length: 20 }, (_, i) => `line${i}`).join("\n");
    const modified = original
      .replace("line2", "line2-changed")
      .replace("line15", "line15-changed");
    const result = unifiedDiff(original, modified, "f.txt");
    assert.equal(result.added, 2);
    assert.equal(result.removed, 2);
    assert.equal((result.diff.match(/^@@ /gm) || []).length, 2, "expected two hunks");
    assert.ok(result.diff.includes("-line2"), result.diff);
    assert.ok(result.diff.includes("+line15-changed"), result.diff);
    assert.ok(!result.diff.includes("line8"), "context should stay within 3 lines of changes");
  });

  it("normalizes CRLF input before diffing", () => {
    const result = unifiedDiff("a\r\nb\r\nc", "a\r\nB\r\nc", "f.txt");
    assert.ok(result.diff.includes("-b") && result.diff.includes("+B"), result.diff);
  });

  it("falls back to a block hunk for very large inputs without crashing", () => {
    const a = Array.from({ length: 3000 }, (_, i) => `old${i}`).join("\n");
    const b = Array.from({ length: 3000 }, (_, i) => `new${i}`).join("\n");
    const result = unifiedDiff(a, b, "f.txt");
    assert.equal(result.removed, 3000);
    assert.equal(result.added, 3000);
  });

  it("truncates output at maxLines", () => {
    const a = Array.from({ length: 500 }, (_, i) => `line${i}`).join("\n");
    const b = Array.from({ length: 500 }, (_, i) => `CHANGED${i}`).join("\n");
    const result = unifiedDiff(a, b, "f.txt", { maxLines: 50 });
    assert.equal(result.truncated, true);
    assert.equal(result.diff.split("\n").length, 50);
  });
});
