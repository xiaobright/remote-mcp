import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import { ProcessTaskManager } from "./taskManager.js";
function fixture(window = 4, retained = 100) {
    const proc = Object.assign(new EventEmitter(), {
        stdout: new PassThrough(), stderr: new PassThrough(), stdin: new PassThrough(), pid: undefined,
    });
    const manager = new ProcessTaskManager({
        outputLimit: retained, maxFinishedTasks: 10, minPollIntervalMs: 60000,
        pollRecommendation: "wait", unknownTaskLabel: "test", defaultReadWindowChars: window,
    });
    const task = manager.start(proc, {});
    return { proc, manager, id: task.taskId };
}
test("task full reads are capped pages with resumable independent offsets", () => {
    const { proc, manager, id } = fixture();
    proc.stdout.write("abcdefghij");
    const first = manager.readOutput(id, { readMode: "full", stdoutOffset: 0 });
    assert.equal(first.stdout, "abcd");
    assert.equal(first.nextStdoutOffset, 4);
    assert.equal(first.stdoutHasMore, true);
    assert.deepEqual(manager.readOutput(id, { readMode: "full", stdoutOffset: 0 }), first);
    const second = manager.readOutput(id, { stdoutOffset: first.nextStdoutOffset });
    assert.equal(second.stdout, "efgh");
    assert.equal(second.nextStdoutOffset, 8);
    const last = manager.readOutput(id, { stdoutOffset: second.nextStdoutOffset });
    assert.equal(last.stdout, "ij");
    assert.equal(last.stdoutHasMore, false);
});
test("task tail is capped and out-of-range offsets clamp to the end", () => {
    const { proc, manager, id } = fixture();
    proc.stdout.write("abcdefghij");
    assert.equal(manager.readOutput(id, { tailChars: 1000 }).stdout, "ghij");
    const empty = manager.readOutput(id, { stdoutOffset: 1000 });
    assert.equal(empty.stdout, "");
    assert.equal(empty.stdoutOffset, 10);
    assert.equal(empty.nextStdoutOffset, 10);
});
test("task eviction reports the actual retained offset", () => {
    const { proc, manager, id } = fixture(4, 6);
    proc.stdout.write("abcdefghij");
    const out = manager.readOutput(id, { stdoutOffset: 0 });
    assert.equal(out.stdout, "efgh");
    assert.equal(out.stdoutOffset, 4);
    assert.equal(out.task.stdoutLength, 10);
    assert.equal(out.stdoutTruncated, true);
});
test("UTF-8 chunks and UTF-16 page boundaries preserve Unicode", () => {
    const { proc, manager, id } = fixture(3);
    const bytes = Buffer.from("你🙂好");
    proc.stdout.write(bytes.subarray(0, 2));
    proc.stdout.write(bytes.subarray(2, 5));
    proc.stdout.write(bytes.subarray(5));
    proc.emit("close", 0, null);
    const first = manager.readOutput(id, { stdoutOffset: 0 });
    assert.equal(first.stdout, "你🙂");
    assert.equal(manager.readOutput(id, { stdoutOffset: first.nextStdoutOffset }).stdout, "好");
});
test("spawn errors are not overwritten by a later close event", () => {
    const { proc, manager, id } = fixture();
    proc.emit("error", new Error("spawn failed"));
    proc.emit("close", -2, null);
    assert.equal(manager.status(id).state, "error");
    assert.equal(manager.status(id).error, "spawn failed");
});
test("a cancellation request does not make wait complete before process close", async () => {
    const { proc, manager, id } = fixture();
    manager.cancel(id);
    let resolved = false;
    const pending = manager.wait(id, 60000).then((result) => { resolved = true; return result; });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(resolved, false);
    proc.emit("close", null, "SIGTERM");
    assert.equal((await pending).completed, true);
    assert.equal(manager.status(id).state, "cancelled");
});
test("completion releases a throttled observation without waiting a minute", async () => {
    const { proc, manager, id } = fixture();
    await manager.observeStatus(id);
    const pending = manager.observeStatus(id);
    queueMicrotask(() => proc.emit("close", 0, null));
    const completed = await pending;
    assert.equal(completed.state, "exited");
    assert.equal(completed.poll.minPollIntervalMs, 60000);
});
//# sourceMappingURL=taskManager.test.js.map