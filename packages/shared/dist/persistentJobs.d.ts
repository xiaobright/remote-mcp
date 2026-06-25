export type PersistentJobBackend = "wsl" | "ssh";
export type PersistentJobState = "starting" | "running" | "exited" | "error" | "cancelled" | "expired";
export type PersistentJobReadMode = "delta" | "full";
export interface PersistentJobRecord {
    jobId: string;
    backend: PersistentJobBackend;
    state: PersistentJobState;
    shell: string;
    workdir?: string;
    target?: string;
    requestedTarget?: string;
    configuredDistro?: string | null;
    jobDir: string;
    bodyPath: string;
    stdoutPath: string;
    stderrPath: string;
    statusPath: string;
    runnerPid: number | null;
    pgid: number | null;
    maxRuntimeMs: number;
    deadlineIso: string | null;
    startedAt: string;
    endedAt: string | null;
    exitCode: number | null;
    error: string | null;
    createdAt: string;
    updatedAt: string;
    [key: string]: unknown;
}
export interface PersistentJobStore {
    version: 1;
    jobs: Record<string, PersistentJobRecord>;
}
export declare function emptyPersistentJobStore(): PersistentJobStore;
export declare function readPersistentJobStore(storePath: string): PersistentJobStore;
export declare function writePersistentJobStore(storePath: string, store: PersistentJobStore): void;
export declare function upsertPersistentJob(storePath: string, record: PersistentJobRecord): PersistentJobRecord;
export declare function getPersistentJob(storePath: string, jobId: string): PersistentJobRecord;
export declare function listPersistentJobs(storePath: string): PersistentJobRecord[];
export declare function touchPersistentJob(storePath: string, jobId: string, patch: Partial<PersistentJobRecord>): PersistentJobRecord;
export declare function deletePersistentJob(storePath: string, jobId: string): void;
export declare function resolveDefaultPersistentJobStorePath(moduleDir: string): string;
export declare function inferPersistentJobState(statusContent: string): PersistentJobState;
export interface PersistentJobRunnerOptions {
    jobId: string;
    commandB64: string;
    workdirB64: string;
    maxRuntimeMs: number;
}
/**
 * Builds a bash runner script that starts a command fully detached (setsid)
 * inside the execution environment (WSL or remote SSH host). The command and
 * working directory are passed base64-encoded to avoid any quoting pitfalls.
 *
 * Layout written to $HOME/.remote-mcp/jobs/<jobId>/:
 *   cmd.sh        decoded command
 *   stdout.log    command stdout
 *   stderr.log    command stderr
 *   daemon.log    runner supervising shell output
 *   status        "running" while active, exit code string when done
 *   runner.pid    PID of the detached session leader (= PGID)
 *   pgid          PID reported by the spawning shell ($!)
 *
 * The spawning shell returns immediately after launching setsid, so the
 * caller (wsl.exe / ssh) does not stay attached.
 */
export declare function buildPersistentJobRunnerScript(options: PersistentJobRunnerOptions): string;
export interface PersistentJobInspectOptions {
    jobId: string;
    readMode: PersistentJobReadMode;
    stdoutOffset?: number;
    stderrOffset?: number;
    tailChars?: number;
    maxChars: number;
    includeContent: boolean;
}
/**
 * Builds a bash script that inspects a persistent job: reads the status file,
 * measures stdout/stderr log lengths, and optionally reads a bounded content
 * chunk from each stream. Output is tab-delimited KEY\tVALUE lines so the Node
 * side can parse it without delimiter collision (base64 output contains no
 * tabs or newlines).
 */
export declare function buildPersistentJobInspectScript(options: PersistentJobInspectOptions): string;
export interface PersistentJobInspectResult {
    statusContent: string;
    stdoutLength: number;
    stderrLength: number;
    stdoutOffset: number;
    stdoutNextOffset: number;
    stdoutB64: string;
    stderrOffset: number;
    stderrNextOffset: number;
    stderrB64: string;
    state: PersistentJobState;
}
export declare function parsePersistentJobInspect(raw: string): PersistentJobInspectResult;
/**
 * Builds a bash script that cancels a persistent job by sending SIGTERM to
 * its process group. Prefers the pgid file, falling back to runner.pid (which
 * equals the PGID for a setsid session leader).
 */
export declare function buildPersistentJobCancelScript(jobId: string): string;
//# sourceMappingURL=persistentJobs.d.ts.map