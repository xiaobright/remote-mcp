import { type TaskOutput, type TaskSnapshot, type TaskState, type TaskWaitResult } from "@remote-mcp/shared/task-manager";
export interface WslResult {
    stdout: string;
    stderr: string;
    exitCode: number;
    timedOut?: boolean;
    timeoutMs?: number;
    requestedTimeoutMs?: number;
    timeoutClamped?: boolean;
    maxTimeoutMs?: number;
    [key: string]: unknown;
}
export interface WslSessionState {
    running: boolean;
    configuredDistro: string | null;
    defaultDistro: string;
    pid: number | null;
    lastError: string | null;
    [key: string]: unknown;
}
export type WslTaskState = TaskState;
export interface WslTaskMeta {
    command: string;
    shell: string;
    workdir?: string;
    configuredDistro: string | null;
}
export type WslTaskSnapshot = TaskSnapshot<WslTaskMeta>;
export type WslTaskOutput = TaskOutput<WslTaskMeta>;
export type WslRunMode = "sync" | "async" | "watch";
export type WslTimeoutBehavior = "kill" | "detach";
export interface WslSyncOptions {
    timeoutMs?: number;
}
export interface WslTaskPollInfo {
    throttled: boolean;
    waitedMs: number;
    minPollIntervalMs: number;
    recommendedAction: string;
    [key: string]: unknown;
}
export interface WslTaskOutputOptions {
    stdoutOffset?: number;
    stderrOffset?: number;
    tailChars?: number;
}
export interface WslTaskWaitResult extends TaskWaitResult<WslTaskMeta> {
    waitMs: number;
    requestedWaitMs?: number;
    waitClamped?: boolean;
    maxWaitMs?: number;
    [key: string]: unknown;
}
export interface WslWatchResult extends WslTaskWaitResult {
    detached: boolean;
    killed: boolean;
    timeoutBehavior: WslTimeoutBehavior;
    requestedTimeoutMs?: number;
    timeoutClamped?: boolean;
    maxTimeoutMs?: number;
    [key: string]: unknown;
}
export declare function setDistro(distro: string | null): Promise<{
    changed: boolean;
    stoppedSession: boolean;
}>;
export declare function getDistro(): string | null;
export declare function getDefaultDistro(): string;
export declare function getSessionState(): WslSessionState;
export declare function startSession(distro?: string | null): Promise<WslSessionState>;
export declare function ensureSessionStarted(): Promise<WslSessionState>;
export declare function stopSession(): Promise<WslSessionState>;
export declare function stopSessionSync(): WslSessionState;
export declare function execWsl(command: string, workdir?: string, options?: WslSyncOptions): Promise<WslResult>;
export declare function execWslScript(script: string, shell?: string, workdir?: string, options?: WslSyncOptions): Promise<WslResult>;
export declare function execWslAsync(command: string, workdir?: string): Promise<WslTaskSnapshot>;
export declare function execWslScriptAsync(script: string, shell?: string, workdir?: string): Promise<WslTaskSnapshot>;
export declare function listTasks(): WslTaskSnapshot[];
export declare function getTaskStatus(taskId: string): WslTaskSnapshot;
export declare function readTaskOutput(taskId: string, stdoutOffset?: number, stderrOffset?: number, tailChars?: number): WslTaskOutput;
export declare function observeTaskStatus(taskId: string): Promise<WslTaskSnapshot>;
export declare function observeTaskOutput(taskId: string, stdoutOffset?: number, stderrOffset?: number, tailChars?: number): Promise<WslTaskOutput>;
export declare function waitTask(taskId: string, waitMs?: number, options?: WslTaskOutputOptions): Promise<WslTaskWaitResult>;
export declare function watchWslTask(command: string, shell: string, workdir?: string, timeoutMs?: number, timeoutBehavior?: WslTimeoutBehavior, outputOptions?: WslTaskOutputOptions): Promise<WslWatchResult>;
export declare function cancelTask(taskId: string): WslTaskSnapshot;
export declare function cancelAllTasksSync(): void;
export declare function listDistros(): Promise<string[]>;
//# sourceMappingURL=wsl.d.ts.map