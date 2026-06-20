import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
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
function sliceTaskStream(content, baseOffset, requestedOffset, tailChars) {
    const totalLength = baseOffset + content.length;
    const offset = typeof tailChars === "number"
        ? Math.max(baseOffset, totalLength - tailChars)
        : Math.max(baseOffset, requestedOffset ?? baseOffset);
    const start = offset - baseOffset;
    return {
        text: content.slice(start),
        offset,
        nextOffset: totalLength,
        truncated: (requestedOffset ?? offset) < baseOffset,
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
            if (task.state !== "cancelled") {
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
            task.endedAt = nowIso();
            task.proc.kill();
            task.resolveFinished();
        }
        return this.snapshot(task);
    }
    cancelAllSync() {
        for (const task of this.tasks.values()) {
            if (task.state === "running" && task.proc) {
                task.state = "cancelled";
                task.endedAt = nowIso();
                task.proc.kill();
                task.resolveFinished();
            }
        }
    }
    appendTaskOutput(task, stream, data) {
        const text = data.toString();
        const baseKey = stream === "stdout" ? "stdoutBaseOffset" : "stderrBaseOffset";
        task[stream] += text;
        const overflow = task[stream].length - this.options.outputLimit;
        if (overflow > 0) {
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
        const stdout = sliceTaskStream(task.stdout, task.stdoutBaseOffset, options.stdoutOffset, options.tailChars);
        const stderr = sliceTaskStream(task.stderr, task.stderrBaseOffset, options.stderrOffset, options.tailChars);
        return {
            task: this.snapshot(task),
            stdout: stdout.text,
            stderr: stderr.text,
            stdoutOffset: stdout.offset,
            stderrOffset: stderr.offset,
            nextStdoutOffset: stdout.nextOffset,
            nextStderrOffset: stderr.nextOffset,
            stdoutTruncated: stdout.truncated,
            stderrTruncated: stderr.truncated,
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
                await delay(waitMs);
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
        if (task.state !== "running") {
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
        return result === "finished" || task.state !== "running";
    }
}
//# sourceMappingURL=taskManager.js.map