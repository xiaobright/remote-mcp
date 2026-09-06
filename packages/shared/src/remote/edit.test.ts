import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { applyTextEdit } from "./edit.js";

describe("applyTextEdit", () => {
  it("replaces a single match", () => {
    const result = applyTextEdit("hello world", "world", "there");
    assert.equal(result.text, "hello there");
    assert.equal(result.replacements, 1);
    assert.equal(result.lineEndingsNormalized, false);
  });

  it("errors on multiple matches without replace_all, reporting line numbers", () => {
    let message = "";
    try {
      applyTextEdit("first aa here\nsecond aa there", "aa", "b");
    } catch (error) {
      message = (error as Error).message;
    }
    assert.match(message, /multiple locations/);
    assert.match(message, /line 1, line 2/);
    assert.match(message, /replace_all=true/);
  });

  it("replace_all replaces every occurrence", () => {
    const result = applyTextEdit("aa aa", "aa", "b", { replaceAll: true });
    assert.equal(result.text, "b b");
    assert.equal(result.replacements, 2);
  });

  it("rejects empty old_string", () => {
    assert.throws(() => applyTextEdit("x", "", "y"), /must not be empty/);
  });

  it("rejects no-op edits", () => {
    assert.throws(() => applyTextEdit("x", "x", "x"), /identical/);
  });

  describe("CRLF handling", () => {
    it("matches LF old_string against a CRLF file and preserves CRLF", () => {
      const original = "function a() {\r\n  return 1;\r\n}\r\n";
      const result = applyTextEdit(original, "function a() {\n  return 1;\n}", "function a() {\n  return 2;\n}");
      assert.equal(result.text, "function a() {\r\n  return 2;\r\n}\r\n");
      assert.equal(result.replacements, 1);
      assert.equal(result.lineEndingsNormalized, true);
    });

    it("matches CRLF old_string directly without normalization", () => {
      const original = "a\r\nb\r\n";
      const result = applyTextEdit(original, "a\r\nb", "a\r\nc");
      assert.equal(result.text, "a\r\nc\r\n");
      assert.equal(result.lineEndingsNormalized, false);
    });

    it("keeps a CRLF file consistent when new_string uses LF", () => {
      const original = "keep\r\nold\r\nmore\r\n";
      const result = applyTextEdit(original, "old", "x\ny");
      assert.equal(result.text, "keep\r\nx\r\ny\r\nmore\r\n");
      assert.equal(result.lineEndingsNormalized, true);
    });

    it("reports line numbers of multiple CRLF matches", () => {
      let message = "";
      try {
        applyTextEdit("a\r\nbb\r\nbb\r\n", "bb", "c");
      } catch (error) {
        message = (error as Error).message;
      }
      assert.match(message, /line 2, line 3/);
    });
  });

  describe("mismatch diagnostics", () => {
    it("reports a whitespace-insensitive match with exact escaped text", () => {
      const original = "function a() {   \n    return 1;\n}";
      let message = "";
      try {
        applyTextEdit(original, "function a() {\n    return 1;\n}", "x");
      } catch (error) {
        message = (error as Error).message;
      }
      assert.match(message, /leading\/trailing whitespace/);
      assert.match(message, /lines 1-3/);
      assert.match(message, /"function a\(\) \{   "/);
    });

    it("reports the closest region with line numbers and escaped old_string", () => {
      const original = "alpha one\nalpha two\nalpha three\n";
      let message = "";
      try {
        applyTextEdit(original, "alpha too\nalpha tree", "x");
      } catch (error) {
        message = (error as Error).message;
      }
      assert.match(message, /old_string not found/);
      assert.match(message, /Closest region in file \(lines \d+-\d+/);
      assert.match(message, /old_string \(escaped\)/);
    });

    it("suggests removing a trailing newline when that is the only difference", () => {
      const original = "just one line";
      let message = "";
      try {
        applyTextEdit(original, "just one line\n", "x");
      } catch (error) {
        message = (error as Error).message;
      }
      assert.match(message, /trailing newline/);
    });

    it("includes the tool-specific fix hint when provided", () => {
      let message = "";
      try {
        applyTextEdit("abc", "zzz", "x", { hint: "To fix: call ssh_file_read." });
      } catch (error) {
        message = (error as Error).message;
      }
      assert.match(message, /call ssh_file_read/);
    });
  });
});
