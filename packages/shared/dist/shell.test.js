import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildWorkdirPreamble, dirnameScript, joinRemotePath, shellQuote, shellStdinArgs, validateEnvName, validateShell } from "./shell.js";
describe("shellQuote", () => {
    it("wraps simple values", () => {
        assert.equal(shellQuote("hello"), "'hello'");
    });
    it("escapes single quotes", () => {
        assert.equal(shellQuote("a'b"), `'a'\\''b'`);
    });
});
it("workdir failures abort before the user's command", () => {
    assert.equal(buildWorkdirPreamble("/missing dir"), "cd -- '/missing dir' || exit $?\n");
});
it("login flags are only passed to shells supporting that contract", () => {
    assert.deepEqual(shellStdinArgs("bash"), ["bash", "-l", "-s"]);
    assert.deepEqual(shellStdinArgs("/bin/zsh"), ["/bin/zsh", "-l", "-s"]);
    assert.deepEqual(shellStdinArgs("sh"), ["sh", "-s"]);
    assert.deepEqual(shellStdinArgs("dash"), ["dash", "-s"]);
    assert.deepEqual(shellStdinArgs("bash", false), ["bash", "-s"]);
});
describe("dirnameScript", () => {
    it("handles root-level paths by setting dir to /", () => {
        const script = dirnameScript("path", "dir");
        assert.match(script, /elif \[ -z "\$dir" \]; then dir=\//);
    });
    it("uses . for paths without a slash", () => {
        const script = dirnameScript("path", "dir");
        assert.match(script, /then dir=\./);
    });
});
describe("joinRemotePath", () => {
    it("joins relative paths under root", () => {
        assert.equal(joinRemotePath("/home/a", "proj/x"), "/home/a/proj/x");
    });
    it("keeps absolute paths", () => {
        assert.equal(joinRemotePath("/home/a", "/etc/hosts"), "/etc/hosts");
    });
});
describe("validateShell / validateEnvName", () => {
    it("accepts safe shell paths", () => {
        assert.equal(validateShell("/bin/bash"), "/bin/bash");
    });
    it("rejects unsafe shell values", () => {
        assert.throws(() => validateShell("bash; rm -rf /"), /Unsafe shell/);
    });
    it("accepts valid env names", () => {
        assert.equal(validateEnvName("FOO_BAR"), "FOO_BAR");
    });
    it("rejects invalid env names", () => {
        assert.throws(() => validateEnvName("1FOO"), /Unsafe environment/);
    });
});
//# sourceMappingURL=shell.test.js.map