import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { applyTextEdit } from "./edit.js";
describe("applyTextEdit", () => {
    it("replaces a single match", () => {
        const result = applyTextEdit("hello world", "world", "there");
        assert.equal(result.text, "hello there");
        assert.equal(result.replacements, 1);
    });
    it("errors on multiple matches without replace_all", () => {
        assert.throws(() => applyTextEdit("aa aa", "aa", "b"), /multiple locations/);
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
});
//# sourceMappingURL=edit.test.js.map