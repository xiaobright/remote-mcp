import { type ChildProcess } from "node:child_process";
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
export declare class ProcessTaskManager<TMeta extends object> {
    private readonly options;
    private readonly tasks;
    constructor(options: ProcessTaskManagerOptions);
    start(proc: ChildProcess, metadata: TMeta, options?: StartTaskOptions): TaskSnapshot<TMeta>;
    list(): TaskSnapshot<TMeta>[];
    status(taskId: string): TaskSnapshot<TMeta>;
    readOutput(taskId: string, options?: TaskOutputOptions): TaskOutput<TMeta>;
    observeStatus(taskId: string): Promise<TaskSnapshot<TMeta>>;
    observeOutput(taskId: string, options?: TaskOutputOptions): Promise<TaskOutput<TMeta>>;
    wait(taskId: string, waitMs: number, options?: TaskOutputOptions): Promise<TaskWaitResult<TMeta>>;
    cancel(taskId: string): TaskSnapshot<TMeta>;
    cancelAllSync(): void;
    private appendTaskOutput;
    private appendTaskText;
    private snapshot;
    private pruneFinishedTasks;
    private getTask;
    private readTaskOutputUnlocked;
    private withTaskObservationThrottle;
    private waitForTaskEnd;
}
//# sourceMappingURL=taskManager.d.ts.map