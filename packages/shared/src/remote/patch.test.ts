import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { applyUpdatePatch, parsePatch, textForAddedFile } from "./patch.js";

describe("parsePatch", () => {
  it("parses add and update operations", () => {
    const patch = [
      "*** Begin Patch",
      "*** Add File: a.txt",
      "+hello",
      "*** Update File: b.txt",
      "@@",
      " line1",
      "-old",
      "+new",
      "*** End Patch",
    ].join("\n");
    const parsed = parsePatch(patch);
    assert.equal(parsed.operations.length, 2);
    assert.equal(parsed.operations[0].kind, "add");
    assert.equal(parsed.operations[1].kind, "update");
  });

  it("rejects delete file directives", () => {
    assert.throws(
      () => parsePatch("*** Delete File: x\n"),
      /not supported/,
    );
  });

  it("records empty-line normalizations", () => {
    const patch = [
      "*** Update File: b.txt",
      "@@",
      " keep",
      "",
      "-old",
      "+new",
    ].join("\n");
    const parsed = parsePatch(patch);
    assert.ok(parsed.normalizations.some((n) => n.reason === "empty-line"));
  });
});

describe("applyUpdatePatch", () => {
  it("applies a simple hunk", () => {
    const original = "a\nold\nb\n";
    const { operations } = parsePatch([
      "*** Update File: f",
      "@@",
      " a",
      "-old",
      "+new",
      " b",
    ].join("\n"));
    const op = operations[0];
    assert.equal(op.kind, "update");
    const applied = applyUpdatePatch(original, op.hunks ?? [], "f");
    assert.equal(applied.text, "a\nnew\nb\n");
    assert.equal(applied.added, 1);
    assert.equal(applied.removed, 1);
  });

  it("throws when hunk does not match", () => {
    const { operations } = parsePatch([
      "*** Update File: f",
      "@@",
      "-missing",
      "+x",
    ].join("\n"));
    assert.throws(
      () => applyUpdatePatch("only\n", operations[0].hunks ?? [], "f"),
      /did not match/,
    );
  });
});

describe("textForAddedFile", () => {
  it("joins with trailing newline", () => {
    assert.equal(textForAddedFile(["a", "b"]), "a\nb\n");
  });

  it("returns empty string for no lines", () => {
    assert.equal(textForAddedFile([]), "");
  });
});
