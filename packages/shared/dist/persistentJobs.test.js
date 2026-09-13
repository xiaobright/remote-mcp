import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildPersistentJobCancelScript, buildPersistentJobInspectScript, buildPersistentJobRunnerScript, decodeJobPage, inferPersistentJobState, parsePersistentJobInspect, requireJobCommandSuccess, } from "./persistentJobs.js";
describe("inferPersistentJobState", () => {
    it("maps status tokens", () => {
        assert.equal(inferPersistentJobState(""), "starting");
        assert.equal(inferPersistentJobState("running"), "running");
        assert.equal(inferPersistentJobState("cancelled"), "cancelled");
        assert.equal(inferPersistentJobState("expired"), "expired");
        assert.equal(inferPersistentJobState("0"), "exited");
        assert.equal(inferPersistentJobState("12"), "exited");
        assert.equal(inferPersistentJobState("boom"), "error");
    });
});
describe("buildPersistentJobRunnerScript", () => {
    it("writes runner.pid and pgid from session leader $$", () => {
        const script = buildPersistentJobRunnerScript({
            jobId: "abc",
            commandB64: Buffer.from("echo hi").toString("base64"),
            workdirB64: "",
            maxRuntimeMs: 1000,
        });
        assert.match(script, /printf "%s" "\$\$" > "\$job_dir\/runner\.pid"/);
        assert.match(script, /printf "%s" "\$\$" > "\$job_dir\/pgid"/);
        assert.doesNotMatch(script, /printf "%s" "\$!" > "\$JOB_DIR\/pgid"/);
    });
    it("fails closed for bad workdirs instead of falling back to HOME", () => {
        const script = buildPersistentJobRunnerScript({ jobId: "test", commandB64: "", workdirB64: "", maxRuntimeMs: 1000 });
        assert.match(script, /error: cannot enter workdir/);
        assert.doesNotMatch(script, /\|\| cd "\$HOME"/);
        assert.match(script, /command -v setsid/);
    });
});
it("job inspect distinguishes explicit zero offsets from default tail reads", () => {
    const explicit = buildPersistentJobInspectScript({
        jobId: "test", readMode: "delta", stdoutOffset: 0, maxChars: 64, includeContent: true,
    });
    assert.match(explicit, /SOFF_SET=1/);
    assert.match(explicit, /EOFF_SET=0/);
    assert.match(explicit, /window=\$MAX/);
});
it("incomplete or failed job inspections do not fabricate starting/running state", () => {
    assert.throws(() => parsePersistentJobInspect(""), /missing STATUS/);
    assert.throws(() => requireJobCommandSuccess("inspect", { exitCode: 255, stderr: "connection failed" }), /connection failed/);
    assert.throws(() => requireJobCommandSuccess("inspect", { exitCode: 0, stderr: "", timedOut: true }), /timed out/);
});
it("UTF-8 job pages retain resumable byte offsets", () => {
    const bytes = Buffer.from("a🙂你b");
    let offset = 0;
    let text = "";
    while (offset < bytes.length) {
        const end = Math.min(bytes.length, offset + 4);
        const page = decodeJobPage(bytes.subarray(offset, end).toString("base64"), offset, end, bytes.length, false);
        assert.ok(page.nextOffset > offset);
        text += page.text;
        offset = page.nextOffset;
    }
    assert.equal(text, "a🙂你b");
});
describe("buildPersistentJobCancelScript", () => {
    it("prefers runner.pid and verifies liveness", () => {
        const script = buildPersistentJobCancelScript("job-1");
        assert.match(script, /runner\.pid/);
        assert.match(script, /cancel_failed/);
        assert.match(script, /already_dead/);
        // runner.pid is preferred before pgid
        const runnerIdx = script.indexOf("runner.pid");
        const pgidIdx = script.indexOf('"$JOB_DIR/pgid"');
        assert.ok(runnerIdx >= 0 && pgidIdx > runnerIdx);
    });
});
describe("parsePersistentJobInspect", () => {
    it("parses tab-delimited inspect output", () => {
        const raw = [
            "STATUS\trunning",
            "STDOUT_LEN\t10",
            "STDERR_LEN\t0",
            "STDOUT_OFFSET\t2",
            "STDOUT_NEXT\t10",
            "STDOUT_B64\taGVsbG8=",
            "STDERR_OFFSET\t0",
            "STDERR_NEXT\t0",
            "STDERR_B64\t",
        ].join("\n");
        const parsed = parsePersistentJobInspect(raw);
        assert.equal(parsed.state, "running");
        assert.equal(parsed.stdoutLength, 10);
        assert.equal(parsed.stdoutOffset, 2);
        assert.equal(parsed.stdoutB64, "aGVsbG8=");
    });
});
//# sourceMappingURL=persistentJobs.test.js.map