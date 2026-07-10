import { type ChildProcess, type SpawnOptions, type SpawnOptionsWithoutStdio } from "node:child_process";
export interface ProcessRunResult {
    stdout: Buffer;
    stderr: string;
    exitCode: number;
    timedOut: boolean;
}
export declare function windowsSafeEnv(extra?: NodeJS.ProcessEnv): NodeJS.ProcessEnv;
export declare function windowsHiddenSpawnOptions(extra?: SpawnOptions): SpawnOptions;
/**
 * Best-effort kill of a spawned child and its descendants.
 * On Windows uses taskkill /T; on POSIX tries the process group then the pid.
 */
export declare function killProcessTree(proc: ChildProcess, signal?: NodeJS.Signals): void;
export declare function runProcessWithInput(command: string, args: string[], input: string, timeoutMs: number, options?: SpawnOptionsWithoutStdio): Promise<ProcessRunResult>;
//# sourceMappingURL=process.d.ts.map