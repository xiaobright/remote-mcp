import { type SpawnOptions, type SpawnOptionsWithoutStdio } from "node:child_process";
export interface ProcessRunResult {
    stdout: Buffer;
    stderr: string;
    exitCode: number;
    timedOut: boolean;
}
export declare function windowsSafeEnv(extra?: NodeJS.ProcessEnv): NodeJS.ProcessEnv;
export declare function windowsHiddenSpawnOptions(extra?: SpawnOptions): SpawnOptions;
export declare function runProcessWithInput(command: string, args: string[], input: string, timeoutMs: number, options?: SpawnOptionsWithoutStdio): Promise<ProcessRunResult>;
//# sourceMappingURL=process.d.ts.map