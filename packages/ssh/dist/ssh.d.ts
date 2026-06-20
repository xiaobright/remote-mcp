import { type TaskOutput, type TaskSnapshot, type TaskState, type TaskWaitResult } from "@remote-mcp/shared/task-manager";
export type SshRunMode = "sync" | "async" | "watch";
export type SshTimeoutBehavior = "kill" | "detach";
export type SshTaskState = TaskState;
export interface SshRunResult {
    target: string;
    requestedTarget?: string;
    deviceName?: string;
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
export interface SshState {
    sshCommand: string;
    defaultTarget: string | null;
    initialDefaultTarget: string | null;
    defaultShell: string;
    defaultSshOptions: string[];
    deviceStorePath: string;
    deviceCount: number;
    devices: string[];
    runningTasks: number;
    taskCount: number;
    [key: string]: unknown;
}
export interface SshTaskMeta {
    target: string;
    requestedTarget?: string;
    deviceName?: string;
    command: string;
    shell: string;
    workdir?: string;
}
export type SshTaskSnapshot = TaskSnapshot<SshTaskMeta>;
export type SshTaskOutput = TaskOutput<SshTaskMeta>;
export interface SshTaskOutputOptions {
    stdoutOffset?: number;
    stderrOffset?: number;
    tailChars?: number;
}
export interface SshTaskWaitResult extends TaskWaitResult<SshTaskMeta> {
    waitMs: number;
    requestedWaitMs?: number;
    waitClamped?: boolean;
    maxWaitMs?: number;
    [key: string]: unknown;
}
export interface SshWatchResult extends SshTaskWaitResult {
    detached: boolean;
    killed: boolean;
    timeoutBehavior: SshTimeoutBehavior;
    requestedTimeoutMs?: number;
    timeoutClamped?: boolean;
    maxTimeoutMs?: number;
    [key: string]: unknown;
}
export interface SshRunOptions {
    target?: string;
    script: string;
    shell?: string;
    login?: boolean;
    workdir?: string;
    env?: Record<string, string>;
    sshOptions?: string[];
    timeoutMs?: number;
}
export interface SshDeviceProfile {
    name: string;
    target?: string;
    user?: string;
    host?: string;
    hosts?: string[];
    port?: number;
    identityFile?: string;
    defaultWorkdir?: string;
    sshOptions?: string[];
    tags?: string[];
    notes?: string;
    lastResolvedTarget?: string;
    lastSeen?: string;
    [key: string]: unknown;
}
export interface ResolvedSshTarget {
    requestedTarget: string;
    target: string;
    deviceName?: string;
    profile?: SshDeviceProfile;
}
export interface SshDeviceStore {
    version: 1;
    devices: Record<string, SshDeviceProfile>;
}
export interface SshTaskPollInfo {
    throttled: boolean;
    waitedMs: number;
    minPollIntervalMs: number;
    recommendedAction: string;
    [key: string]: unknown;
}
export declare function getSshState(): SshState;
export declare function setDefaultTarget(target: string | null): SshState;
export declare function listDevices(): SshDeviceProfile[];
export declare function getDevice(name: string): SshDeviceProfile;
export declare function upsertDevice(profile: SshDeviceProfile): SshDeviceProfile;
export declare function removeDevice(name: string): SshState;
export declare function candidateTargetsFor(target?: string): ResolvedSshTarget[];
export declare function runSshScript(options: SshRunOptions): Promise<SshRunResult>;
export declare function startSshTask(options: SshRunOptions): Promise<SshTaskSnapshot>;
export declare function listTasks(): SshTaskSnapshot[];
export declare function observeTaskStatus(taskId: string): Promise<SshTaskSnapshot>;
export declare function observeTaskOutput(taskId: string, stdoutOffset?: number, stderrOffset?: number, tailChars?: number): Promise<SshTaskOutput>;
export declare function readTaskOutput(taskId: string, stdoutOffset?: number, stderrOffset?: number, tailChars?: number): SshTaskOutput;
export declare function waitTask(taskId: string, waitMs?: number, options?: SshTaskOutputOptions): Promise<SshTaskWaitResult>;
export declare function watchSshTask(options: SshRunOptions, timeoutMs?: number, timeoutBehavior?: SshTimeoutBehavior, outputOptions?: SshTaskOutputOptions): Promise<SshWatchResult>;
export declare function cancelTask(taskId: string): SshTaskSnapshot;
export declare function cancelAllTasksSync(): void;
export declare function testSshTarget(target?: string, timeoutMs?: number): Promise<SshRunResult>;
//# sourceMappingURL=ssh.d.ts.map