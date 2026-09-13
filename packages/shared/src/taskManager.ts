import { type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { StringDecoder } from "node:string_decoder";
import { killProcessTree } from "./process.js";

export type TaskState = "running" | "exited" | "error" | "cancelled";
export type TaskReadMode = "delta" | "full";

export interface TaskSnapshotBase {
  taskId: string;
  state: TaskState;
  pid: number | null;
  startedAt: string;
  endedAt: string | null;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  error: string | null;
  stdoutLength: number;
  stderrLength: number;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
  [key: string]: unknown;
}

export type TaskSnapshot<TMeta extends object> = TaskSnapshotBase & TMeta;

export interface TaskOutput<TMeta extends object> {
  task: TaskSnapshot<TMeta>;
  stdout: string;
  stderr: string;
  stdoutOffset: number;
  stderrOffset: number;
  nextStdoutOffset: number;
  nextStderrOffset: number;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
  stdoutHasMore: boolean;
  stderrHasMore: boolean;
  readMode: TaskReadMode;
  [key: string]: unknown;
}

export interface TaskOutputOptions {
  stdoutOffset?: number;
  stderrOffset?: number;
  tailChars?: number;
  readMode?: TaskReadMode;
}

export interface TaskWaitResult<TMeta extends object> extends TaskOutput<TMeta> {
  completed: boolean;
  timedOut: boolean;
  waitedMs: number;
  [key: string]: unknown;
}

export interface TaskPollInfo {
  throttled: boolean;
  waitedMs: number;
  minPollIntervalMs: number;
  recommendedAction: string;
  [key: string]: unknown;
}

interface ManagedTask<TMeta extends object> {
  taskId: string;
  state: TaskState;
  metadata: TMeta;
  proc: ChildProcess | null;
  pid: number | null;
  startedAt: string;
  endedAt: string | null;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  error: string | null;
  stdout: string;
  stderr: string;
  stdoutDecoder: StringDecoder;
  stderrDecoder: StringDecoder;
  stdoutBaseOffset: number;
  stderrBaseOffset: number;
  finished: Promise<void>;
  resolveFinished: () => void;
  lastObservationAt: number | null;
  observationLock: Promise<void>;
  onSuccessfulExit?: () => void;
}

export interface StartTaskOptions {
  input?: string;
  onSuccessfulExit?: () => void;
}

export interface ProcessTaskManagerOptions {
  outputLimit: number;
  maxFinishedTasks: number;
  minPollIntervalMs: number;
  pollRecommendation: string;
  unknownTaskLabel: string;
  defaultReadWindowChars: number;
}

function nowIso(): string {
  return new Date().toISOString();
}

function makeFinishedLatch(): { finished: Promise<void>; resolveFinished: () => void } {
  let resolveFinished!: () => void;
  const finished = new Promise<void>((resolve) => {
    resolveFinished = resolve;
  });
  return { finished, resolveFinished };
}

function sliceTaskStream(
  content: string,
  baseOffset: number,
  requestedOffset?: number,
  tailChars?: number,
  readMode: TaskReadMode = "delta",
  defaultReadWindowChars = 8192,
): { text: string; offset: number; nextOffset: number; truncated: boolean; hasMore: boolean } {
  const totalLength = baseOffset + content.length;
  const limit = Math.max(2, defaultReadWindowChars);
  let offset = baseOffset;
  if (typeof tailChars === "number") {
    offset = Math.max(baseOffset, totalLength - Math.min(tailChars, limit));
  } else if (typeof requestedOffset === "number") {
    offset = Math.max(baseOffset, requestedOffset);
  } else if (readMode === "full") {
    offset = baseOffset;
  } else {
    offset = Math.max(baseOffset, totalLength - limit);
  }
  offset = Math.min(offset, totalLength);
  let start = offset - baseOffset;
  if (start > 0 && /[\uDC00-\uDFFF]/.test(content[start])) start += 1;
  offset = baseOffset + start;
  let end = Math.min(content.length, start + limit);
  if (end < content.length && /[\uD800-\uDBFF]/.test(content[end - 1])) end -= 1;
  const nextOffset = baseOffset + end;

  return {
    text: content.slice(start, end),
    offset,
    nextOffset,
    truncated: baseOffset > 0 || offset > baseOffset || nextOffset < totalLength,
    hasMore: nextOffset < totalLength,
  };
}

export class ProcessTaskManager<TMeta extends object> {
  private readonly tasks = new Map<string, ManagedTask<TMeta>>();

  constructor(private readonly options: ProcessTaskManagerOptions) {}

  start(proc: ChildProcess, metadata: TMeta, options: StartTaskOptions = {}): TaskSnapshot<TMeta> {
    const latch = makeFinishedLatch();
    const taskId = randomUUID();
    const task: ManagedTask<TMeta> = {
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

    proc.stdout?.on("data", (data: Buffer) => this.appendTaskOutput(task, "stdout", data));
    proc.stderr?.on("data", (data: Buffer) => this.appendTaskOutput(task, "stderr", data));
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
      proc.stdin?.on("error", () => {});
      proc.stdin?.write(options.input);
      proc.stdin?.end();
    }

    return this.snapshot(task);
  }

  list(): TaskSnapshot<TMeta>[] {
    return [...this.tasks.values()].map((task) => this.snapshot(task));
  }

  status(taskId: string): TaskSnapshot<TMeta> {
    return this.snapshot(this.getTask(taskId));
  }

  readOutput(taskId: string, options: TaskOutputOptions = {}): TaskOutput<TMeta> {
    return this.readTaskOutputUnlocked(this.getTask(taskId), options);
  }

  async observeStatus(taskId: string): Promise<TaskSnapshot<TMeta>> {
    const task = this.getTask(taskId);
    return this.withTaskObservationThrottle(task, (poll) => ({
      ...this.snapshot(task),
      poll,
    }));
  }

  async observeOutput(taskId: string, options: TaskOutputOptions = {}): Promise<TaskOutput<TMeta>> {
    const task = this.getTask(taskId);
    return this.withTaskObservationThrottle(task, (poll) => ({
      ...this.readTaskOutputUnlocked(task, options),
      poll,
    }));
  }

  async wait(taskId: string, waitMs: number, options: TaskOutputOptions = {}): Promise<TaskWaitResult<TMeta>> {
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

  cancel(taskId: string): TaskSnapshot<TMeta> {
    const task = this.getTask(taskId);
    if (task.state === "running" && task.proc) {
      task.state = "cancelled";
      task.endedAt ??= nowIso();
      // Kill the tree; let the close handler settle finished/exitCode.
      killProcessTree(task.proc);
    }

    return this.snapshot(task);
  }

  cancelAllSync(): void {
    for (const task of this.tasks.values()) {
      if (task.state === "running" && task.proc) {
        task.state = "cancelled";
        task.endedAt ??= nowIso();
        killProcessTree(task.proc);
      }
    }
  }

  private appendTaskOutput(task: ManagedTask<TMeta>, stream: "stdout" | "stderr", data: Buffer): void {
    const decoder = stream === "stdout" ? task.stdoutDecoder : task.stderrDecoder;
    this.appendTaskText(task, stream, decoder.write(data));
  }

  private appendTaskText(task: ManagedTask<TMeta>, stream: "stdout" | "stderr", text: string): void {
    const baseKey = stream === "stdout" ? "stdoutBaseOffset" : "stderrBaseOffset";
    task[stream] += text;
    let overflow = task[stream].length - this.options.outputLimit;
    if (overflow > 0) {
      if (/[\uDC00-\uDFFF]/.test(task[stream][overflow])) overflow += 1;
      task[stream] = task[stream].slice(overflow);
      task[baseKey] += overflow;
    }
  }

  private snapshot(task: ManagedTask<TMeta>): TaskSnapshot<TMeta> {
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

  private pruneFinishedTasks(): void {
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

  private getTask(taskId: string): ManagedTask<TMeta> {
    const task = this.tasks.get(taskId);
    if (!task) {
      throw new Error(`Unknown ${this.options.unknownTaskLabel} task: ${taskId}`);
    }
    return task;
  }

  private readTaskOutputUnlocked(task: ManagedTask<TMeta>, options: TaskOutputOptions = {}): TaskOutput<TMeta> {
    const stdoutSlice = sliceTaskStream(
      task.stdout,
      task.stdoutBaseOffset,
      options.stdoutOffset,
      options.tailChars,
      options.readMode,
      this.options.defaultReadWindowChars,
    );
    const stderrSlice = sliceTaskStream(
      task.stderr,
      task.stderrBaseOffset,
      options.stderrOffset,
      options.tailChars,
      options.readMode,
      this.options.defaultReadWindowChars,
    );

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

  private async withTaskObservationThrottle<T>(
    task: ManagedTask<TMeta>,
    fn: (poll: TaskPollInfo) => T | Promise<T>,
  ): Promise<T> {
    const previous = task.observationLock;
    let release!: () => void;
    task.observationLock = new Promise<void>((resolve) => {
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
      const poll: TaskPollInfo = {
        throttled: waitMs > 0,
        waitedMs: waitMs,
        minPollIntervalMs: this.options.minPollIntervalMs,
        recommendedAction: this.options.pollRecommendation,
      };
      return await fn(poll);
    } finally {
      release();
    }
  }

  private async waitForTaskEnd(task: ManagedTask<TMeta>, waitMs: number): Promise<boolean> {
    // cancel() requests termination; only close/error settles the local process.
    if (task.proc === null) {
      return true;
    }

    let timer: NodeJS.Timeout | null = null;
    const timeout = new Promise<"timeout">((resolve) => {
      timer = setTimeout(() => resolve("timeout"), waitMs);
      timer.unref();
    });

    const result = await Promise.race([
      task.finished.then(() => "finished" as const),
      timeout,
    ]);

    if (timer) {
      clearTimeout(timer);
    }

    return result === "finished" || task.proc === null;
  }
}
