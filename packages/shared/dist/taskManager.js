import { randomUUID } from "node:crypto";
import { StringDecoder } from "node:string_decoder";
import { killProcessTree } from "./process.js";
function nowIso() {
    return new Date().toISOString();
}
function makeFinishedLatch() {
    let resolveFinished;
    const finished = new Promise((resolve) => {
        resolveFinished = resolve;
    });
    return { finished, resolveFinished };
}
function sliceTaskStream(content, baseOffset, requestedOffset, tailChars, readMode = "delta", defaultReadWindowChars = 8192) {
    const totalLength = baseOffset + content.length;
    const limit = Math.max(2, defaultReadWindowChars);
    let offset = baseOffset;
    if (typeof tailChars === "number") {
        offset = Math.max(baseOffset, totalLength - Math.min(tailChars, limit));
    }
    else if (typeof requestedOffset === "number") {
        offset = Math.max(baseOffset, requestedOffset);
    }
    else if (readMode === "full") {
        offset = baseOffset;
    }
    else {
        offset = Math.max(baseOffset, totalLength - limit);
    }
    offset = Math.min(offset, totalLength);
    let start = offset - baseOffset;
    if (start > 0 && /[\uDC00-\uDFFF]/.test(content[start]))
        start += 1;
    offset = baseOffset + start;
    let end = Math.min(content.length, start + limit);
    if (end < content.length && /[\uD800-\uDBFF]/.test(content[end - 1]))
        end -= 1;
    const nextOffset = baseOffset + end;
    return {
        text: content.slice(start, end),
        offset,
        nextOffset,
        truncated: baseOffset > 0 || offset > baseOffset || nextOffset < totalLength,
        hasMore: nextOffset < totalLength,
    };
}
export class ProcessTaskManager {
    options;
    tasks = new Map();
    constructor(options) {
        this.options = options;
    }
    start(proc, metadata, options = {}) {
        const latch = makeFinishedLatch();
        const taskId = randomUUID();
        const task = {
            taskId,
            state: "running",
            metadata,
            proc,
            pid: proc.pid ?? null,
            startedAt: nowIso(),
            endedAt: null,
            exitCode: null,
            signal: null,
            error: null,
            stdout: "",
            stderr: "",
            stdoutDecoder: new StringDecoder("utf8"),
            stderrDecoder: new StringDecoder("utf8"),
            stdoutBaseOffset: 0,
            stderrBaseOffset: 0,
            finished: latch.finished,
            resolveFinished: latch.resolveFinished,
            lastObservationAt: null,
            observationLock: Promise.resolve(),
            onSuccessfulExit: options.onSuccessfulExit,
        };
        this.tasks.set(taskId, task);
        proc.stdout?.on("data", (data) => this.appendTaskOutput(task, "stdout", data));
        proc.stderr?.on("data", (data) => this.appendTaskOutput(task, "stderr", data));
        proc.on("close", (code, signal) => {
            this.appendTaskText(task, "stdout", task.stdoutDecoder.end());
            this.appendTaskText(task, "stderr", task.stderrDecoder.end());
            if (task.state === "running") {
                task.state = "exited";
            }
            task.exitCode = code ?? -1;
            task.signal = signal;
            task.endedAt ??= nowIso();
            task.proc = null;
            task.pid = null;
            task.resolveFinished();
            if ((code ?? -1) === 0) {
                task.onSuccessfulExit?.();
            }
            this.pruneFinishedTasks();
        });
        proc.on("error", (error) => {
            task.state = "error";
            task.error = error.message;
            task.endedAt ??= nowIso();
            task.proc = null;
            task.pid = null;
            task.resolveFinished();
            this.pruneFinishedTasks();
        });
        if (typeof options.input === "string") {
            // A command may exit before it has consumed stdin; do not crash the MCP on EPIPE.
            proc.stdin?.on("error", () => { });
            proc.stdin?.write(options.input);
            proc.stdin?.end();
        }
        return this.snapshot(task);
    }
    list() {
        return [...this.tasks.values()].map((task) => this.snapshot(task));
    }
    status(taskId) {
        return this.snapshot(this.getTask(taskId));
    }
    readOutput(taskId, options = {}) {
        return this.readTaskOutputUnlocked(this.getTask(taskId), options);
    }
    async observeStatus(taskId) {
        const task = this.getTask(taskId);
        return this.withTaskObservationThrottle(task, (poll) => ({
            ...this.snapshot(task),
            poll,
        }));
    }
    async observeOutput(taskId, options = {}) {
        const task = this.getTask(taskId);
        return this.withTaskObservationThrottle(task, (poll) => ({
            ...this.readTaskOutputUnlocked(task, options),
            poll,
        }));
    }
    async wait(taskId, waitMs, options = {}) {
        const task = this.getTask(taskId);
        const started = Date.now();
        const completed = await this.waitForTaskEnd(task, waitMs);
        const waitedMs = Date.now() - started;
        return {
            ...this.readTaskOutputUnlocked(task, options),
            completed,
            timedOut: !completed,
            waitedMs,
        };
    }
    cancel(taskId) {
        const task = this.getTask(taskId);
        if (task.state === "running" && task.proc) {
            task.state = "cancelled";
            task.endedAt ??= nowIso();
            // Kill the tree; let the close handler settle finished/exitCode.
            killProcessTree(task.proc);
        }
        return this.snapshot(task);
    }
    cancelAllSync() {
        for (const task of this.tasks.values()) {
            if (task.state === "running" && task.proc) {
                task.state = "cancelled";
                task.endedAt ??= nowIso();
                killProcessTree(task.proc);
            }
        }
    }
    appendTaskOutput(task, stream, data) {
        const decoder = stream === "stdout" ? task.stdoutDecoder : task.stderrDecoder;
        this.appendTaskText(task, stream, decoder.write(data));
    }
    appendTaskText(task, stream, text) {
        const baseKey = stream === "stdout" ? "stdoutBaseOffset" : "stderrBaseOffset";
        task[stream] += text;
        let overflow = task[stream].length - this.options.outputLimit;
        if (overflow > 0) {
            if (/[\uDC00-\uDFFF]/.test(task[stream][overflow]))
                overflow += 1;
            task[stream] = task[stream].slice(overflow);
            task[baseKey] += overflow;
        }
    }
    snapshot(task) {
        return {
            taskId: task.taskId,
            state: task.state,
            ...task.metadata,
            pid: task.pid,
            startedAt: task.startedAt,
            endedAt: task.endedAt,
            exitCode: task.exitCode,
            signal: task.signal,
            error: task.error,
            stdoutLength: task.stdoutBaseOffset + task.stdout.length,
            stderrLength: task.stderrBaseOffset + task.stderr.length,
            stdoutTruncated: task.stdoutBaseOffset > 0,
            stderrTruncated: task.stderrBaseOffset > 0,
        };
    }
    pruneFinishedTasks() {
        if (this.options.maxFinishedTasks <= 0) {
            return;
        }
        const finished = [...this.tasks.values()].filter((task) => task.state !== "running");
        const extra = finished.length - this.options.maxFinishedTasks;
        if (extra <= 0) {
            return;
        }
        finished
            .sort((a, b) => a.startedAt.localeCompare(b.startedAt))
            .slice(0, extra)
            .forEach((task) => this.tasks.delete(task.taskId));
    }
    getTask(taskId) {
        const task = this.tasks.get(taskId);
        if (!task) {
            throw new Error(`Unknown ${this.options.unknownTaskLabel} task: ${taskId}`);
        }
        return task;
    }
    readTaskOutputUnlocked(task, options = {}) {
        const stdoutSlice = sliceTaskStream(task.stdout, task.stdoutBaseOffset, options.stdoutOffset, options.tailChars, options.readMode, this.options.defaultReadWindowChars);
        const stderrSlice = sliceTaskStream(task.stderr, task.stderrBaseOffset, options.stderrOffset, options.tailChars, options.readMode, this.options.defaultReadWindowChars);
        return {
            task: this.snapshot(task),
            stdout: stdoutSlice.text,
            stderr: stderrSlice.text,
            stdoutOffset: stdoutSlice.offset,
            stderrOffset: stderrSlice.offset,
            nextStdoutOffset: stdoutSlice.nextOffset,
            nextStderrOffset: stderrSlice.nextOffset,
            stdoutTruncated: stdoutSlice.truncated,
            stderrTruncated: stderrSlice.truncated,
            stdoutHasMore: stdoutSlice.hasMore,
            stderrHasMore: stderrSlice.hasMore,
            readMode: options.readMode ?? "delta",
        };
    }
    async withTaskObservationThrottle(task, fn) {
        const previous = task.observationLock;
        let release;
        task.observationLock = new Promise((resolve) => {
            release = resolve;
        });
        await previous;
        try {
            const now = Date.now();
            const elapsed = task.lastObservationAt === null ? this.options.minPollIntervalMs : now - task.lastObservationAt;
            const waitMs = task.state === "running" ? Math.max(0, this.options.minPollIntervalMs - elapsed) : 0;
            if (waitMs > 0) {
                await this.waitForTaskEnd(task, waitMs);
            }
            task.lastObservationAt = Date.now();
            const poll = {
                throttled: waitMs > 0,
                waitedMs: waitMs,
                minPollIntervalMs: this.options.minPollIntervalMs,
                recommendedAction: this.options.pollRecommendation,
            };
            return await fn(poll);
        }
        finally {
            release();
        }
    }
    async waitForTaskEnd(task, waitMs) {
        // cancel() requests termination; only close/error settles the local process.
        if (task.proc === null) {
            return true;
        }
        let timer = null;
        const timeout = new Promise((resolve) => {
            timer = setTimeout(() => resolve("timeout"), waitMs);
            timer.unref();
        });
        const result = await Promise.race([
            task.finished.then(() => "finished"),
            timeout,
        ]);
        if (timer) {
            clearTimeout(timer);
        }
        return result === "finished" || task.proc === null;
    }
}
//# sourceMappingURL=taskManager.js.map