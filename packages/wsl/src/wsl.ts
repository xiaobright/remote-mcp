import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { boundedDuration as sharedBoundedDuration, readPositiveIntEnv } from "@remote-mcp/shared/env";
import { windowsHiddenSpawnOptions } from "@remote-mcp/shared/process";
import { buildWorkdirPreamble } from "@remote-mcp/shared/shell";
import {
  buildPersistentJobCancelScript,
  buildPersistentJobInspectScript,
  buildPersistentJobRunnerScript,
  getPersistentJob,
  listPersistentJobs as listPersistentJobsFromStore,
  parsePersistentJobInspect,
  resolveDefaultPersistentJobStorePath,
  touchPersistentJob,
  upsertPersistentJob,
  type PersistentJobReadMode,
  type PersistentJobRecord,
} from "@remote-mcp/shared/persistentJobs";
import {
  ProcessTaskManager,
  type TaskReadMode,
  type TaskOutput,
  type TaskSnapshot,
  type TaskState,
  type TaskWaitResult,
} from "@remote-mcp/shared/task-manager";

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

export interface WslRawResult {
  stdout: Buffer;
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
export type WslReadMode = TaskReadMode;

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
  readMode?: WslReadMode;
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

const WSL_EXE = "wsl.exe";

const DEFAULT_DISTRO = process.env.WSL_MCP_DEFAULT_DISTRO?.trim() || "Ubuntu-24.04";
const TASK_OUTPUT_LIMIT = readPositiveIntEnv("WSL_MCP_TASK_OUTPUT_LIMIT", 1048576);
const MAX_FINISHED_TASKS = readPositiveIntEnv("WSL_MCP_MAX_FINISHED_TASKS", 100);
const TASK_MIN_POLL_INTERVAL_MS = readPositiveIntEnv("WSL_MCP_MIN_POLL_INTERVAL_MS", 20000);
const TASK_DEFAULT_READ_WINDOW_CHARS = readPositiveIntEnv("WSL_MCP_DEFAULT_TASK_READ_WINDOW_CHARS", 8192);
const DEFAULT_SYNC_TIMEOUT_MS = readPositiveIntEnv("WSL_MCP_DEFAULT_SYNC_TIMEOUT_MS", 120000);
const DEFAULT_WATCH_TIMEOUT_MS = readPositiveIntEnv("WSL_MCP_DEFAULT_WATCH_TIMEOUT_MS", 120000);
const DEFAULT_TASK_WAIT_MS = readPositiveIntEnv("WSL_MCP_DEFAULT_TASK_WAIT_MS", 30000);
const MAX_TOOL_TIMEOUT_MS = readPositiveIntEnv("WSL_MCP_MAX_TOOL_TIMEOUT_MS", 540000);
const PROTECT_MNT_DELETE = process.env.WSL_MCP_PROTECT_MNT_DELETE !== "0";
const MODULE_DIR = dirname(fileURLToPath(import.meta.url));
const PERSISTENT_JOB_STORE_PATH = resolveDefaultPersistentJobStorePath(MODULE_DIR);
const PERSISTENT_JOB_MAX_RUNTIME_MS = readPositiveIntEnv("WSL_MCP_PERSISTENT_JOB_MAX_RUNTIME_MS", 3600000);
const PERSISTENT_JOB_DEFAULT_READ_WINDOW_CHARS = readPositiveIntEnv("WSL_MCP_PERSISTENT_JOB_DEFAULT_READ_WINDOW_CHARS", 8192);
const PERSISTENT_JOB_OP_TIMEOUT_MS = readPositiveIntEnv("WSL_MCP_PERSISTENT_JOB_OP_TIMEOUT_MS", 30000);
const PERSISTENT_JOB_POLL_INTERVAL_MS = readPositiveIntEnv("WSL_MCP_PERSISTENT_JOB_POLL_INTERVAL_MS", 1000);

let keepalive: ChildProcess | null = null;
let currentDistro: string | null = DEFAULT_DISTRO;
let lastSessionError: string | null = null;
const expectedKeepaliveExits = new WeakSet<ChildProcess>();
let sessionLock: Promise<void> = Promise.resolve();
const taskManager = new ProcessTaskManager<WslTaskMeta>({
  outputLimit: TASK_OUTPUT_LIMIT,
  maxFinishedTasks: MAX_FINISHED_TASKS,
  minPollIntervalMs: TASK_MIN_POLL_INTERVAL_MS,
  pollRecommendation: "Use wsl_task action=\"wait\" for long-running tasks instead of rapid status/output polling.",
  unknownTaskLabel: "WSL",
  defaultReadWindowChars: TASK_DEFAULT_READ_WINDOW_CHARS,
});

async function withSessionLock<T>(fn: () => Promise<T> | T): Promise<T> {
  const previous = sessionLock;
  let release!: () => void;
  sessionLock = new Promise<void>((resolve) => {
    release = resolve;
  });

  await previous;
  try {
    return await fn();
  } finally {
    release();
  }
}

function wslArgsFor(distro: string | null, cmdArgs: string[]): string[] {
  if (distro) {
    return ["-d", distro, "--", ...cmdArgs];
  }
  return ["--", ...cmdArgs];
}

function getActiveKeepalive(): ChildProcess | null {
  if (!keepalive) {
    return null;
  }

  if (keepalive.exitCode !== null || keepalive.signalCode !== null) {
    keepalive = null;
    return null;
  }

  return keepalive;
}

function rememberKeepaliveFailure(code: number | null, signal: NodeJS.Signals | null): void {
  if (signal) {
    lastSessionError = `WSL keepalive exited with signal ${signal}`;
    return;
  }

  if (code !== null && code !== 0) {
    lastSessionError = `WSL keepalive exited with code ${code}`;
  }
}

function bindKeepaliveLifecycle(proc: ChildProcess): void {
  proc.once("error", (error) => {
    const isCurrent = keepalive === proc;
    const expected = expectedKeepaliveExits.has(proc);
    expectedKeepaliveExits.delete(proc);

    if (isCurrent) {
      keepalive = null;
    }
    if (isCurrent && !expected) {
      lastSessionError = error.message;
    }
  });

  proc.once("exit", (code, signal) => {
    const isCurrent = keepalive === proc;
    const expected = expectedKeepaliveExits.has(proc);
    expectedKeepaliveExits.delete(proc);

    if (isCurrent) {
      keepalive = null;
    }

    if (expected) {
      return;
    }

    if (isCurrent) {
      rememberKeepaliveFailure(code, signal);
    }
  });
}

function buildPreamble(workdir?: string): string {
  return buildWorkdirPreamble(workdir);
}

const MNT_DELETE_GUARD = String.raw`
# WSL MCP safety guard: allow normal /mnt access, but block common delete
# operations when their target path, or resolved symlink target, is under /mnt.
__wsl_mcp_realpath() {
  realpath -m -- "$1" 2>/dev/null || printf '%s\n' "$1"
}

__wsl_mcp_is_mnt_path() {
  case "$1" in
    /mnt|/mnt/*) return 0 ;;
    *) return 1 ;;
  esac
}

__wsl_mcp_block_mnt_delete_path() {
  [ "$#" -eq 0 ] && return 0
  case "$1" in
    ""|-) return 0 ;;
  esac

  __wsl_mcp_resolved="$(__wsl_mcp_realpath "$1")"
  if __wsl_mcp_is_mnt_path "$1" || __wsl_mcp_is_mnt_path "$__wsl_mcp_resolved"; then
    printf 'WSL MCP blocked deletion under /mnt: %s (resolved: %s)\n' "$1" "$__wsl_mcp_resolved" >&2
    return 64
  fi
  return 0
}

rm() {
  __wsl_mcp_seen_operand=0
  for __wsl_mcp_arg in "$@"; do
    if [ "$__wsl_mcp_seen_operand" -eq 0 ]; then
      case "$__wsl_mcp_arg" in
        --) __wsl_mcp_seen_operand=1; continue ;;
        -*) continue ;;
      esac
    fi
    __wsl_mcp_seen_operand=1
    __wsl_mcp_block_mnt_delete_path "$__wsl_mcp_arg" || return $?
  done
  command rm "$@"
}

rmdir() {
  __wsl_mcp_seen_operand=0
  for __wsl_mcp_arg in "$@"; do
    if [ "$__wsl_mcp_seen_operand" -eq 0 ]; then
      case "$__wsl_mcp_arg" in
        --) __wsl_mcp_seen_operand=1; continue ;;
        -*) continue ;;
      esac
    fi
    __wsl_mcp_seen_operand=1
    __wsl_mcp_block_mnt_delete_path "$__wsl_mcp_arg" || return $?
  done
  command rmdir "$@"
}

unlink() {
  for __wsl_mcp_arg in "$@"; do
    case "$__wsl_mcp_arg" in
      --|-*) continue ;;
    esac
    __wsl_mcp_block_mnt_delete_path "$__wsl_mcp_arg" || return $?
  done
  command unlink "$@"
}

rsync() {
  __wsl_mcp_delete=0
  __wsl_mcp_remove_source=0
  __wsl_mcp_after_double_dash=0
  __wsl_mcp_operands=

  for __wsl_mcp_arg in "$@"; do
    if [ "$__wsl_mcp_after_double_dash" -eq 0 ]; then
      case "$__wsl_mcp_arg" in
        --) __wsl_mcp_after_double_dash=1; continue ;;
        --delete|--delete-*|--del) __wsl_mcp_delete=1; continue ;;
        --remove-source-files) __wsl_mcp_remove_source=1; continue ;;
        --*) continue ;;
        -*) continue ;;
      esac
    fi
    __wsl_mcp_operands="$__wsl_mcp_operands
$__wsl_mcp_arg"
  done

  if [ "$__wsl_mcp_delete" -eq 1 ]; then
    __wsl_mcp_dest="$(printf '%s\n' "$__wsl_mcp_operands" | sed '/^$/d' | tail -n 1)"
    __wsl_mcp_block_mnt_delete_path "$__wsl_mcp_dest" || return $?
  fi

  if [ "$__wsl_mcp_remove_source" -eq 1 ]; then
    __wsl_mcp_count="$(printf '%s\n' "$__wsl_mcp_operands" | sed '/^$/d' | wc -l)"
    __wsl_mcp_i=0
    printf '%s\n' "$__wsl_mcp_operands" | sed '/^$/d' | while IFS= read -r __wsl_mcp_src; do
      __wsl_mcp_i=$((__wsl_mcp_i + 1))
      [ "$__wsl_mcp_i" -ge "$__wsl_mcp_count" ] && break
      __wsl_mcp_block_mnt_delete_path "$__wsl_mcp_src" || exit $?
    done || return $?
  fi

  command rsync "$@"
}
`;

function buildSafetyPreamble(): string {
  return PROTECT_MNT_DELETE ? `${MNT_DELETE_GUARD}\n` : "";
}

function buildScriptInput(body: string, workdir?: string): string {
  return buildSafetyPreamble() + buildPreamble(workdir) + body;
}

function boundedDuration(
  requestedMs: number | undefined,
  fallbackMs: number,
): { ms: number; requestedMs?: number; clamped: boolean; maxMs: number } {
  return sharedBoundedDuration(requestedMs, fallbackMs, MAX_TOOL_TIMEOUT_MS);
}

async function probeWsl(distro: string | null): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const proc = spawn(WSL_EXE, [...wslArgsFor(distro, ["bash", "-lc", "true"])], windowsHiddenSpawnOptions());
    let stderr = "";
    proc.stderr?.on("data", (data: Buffer) => { stderr += data.toString(); });
    proc.on("close", (code) => {
      if (code === 0) {
        resolve();
        return;
      }

      reject(new Error(stderr.trim() || `wsl.exe exited with code ${code ?? -1}`));
    });
    proc.on("error", reject);
  });
}

function stopSessionUnlocked(): WslSessionState {
  const active = getActiveKeepalive();
  const wasRunning = active !== null;

  if (active) {
    expectedKeepaliveExits.add(active);
    active.kill();
    keepalive = null;
  }

  const state = getSessionState();
  return {
    ...state,
    running: false,
    pid: null,
    lastError: wasRunning ? null : state.lastError,
  };
}

export async function setDistro(distro: string | null): Promise<{ changed: boolean; stoppedSession: boolean }> {
  return withSessionLock(() => {
    if (distro === currentDistro) {
      return { changed: false, stoppedSession: false };
    }

    const stoppedSession = getSessionState().running;
    stopSessionUnlocked();
    currentDistro = distro;
    return { changed: true, stoppedSession };
  });
}

export function getDistro(): string | null {
  return currentDistro;
}

export function getDefaultDistro(): string {
  return DEFAULT_DISTRO;
}

export function getSessionState(): WslSessionState {
  const active = getActiveKeepalive();
  return {
    running: active !== null,
    configuredDistro: currentDistro,
    defaultDistro: DEFAULT_DISTRO,
    pid: active?.pid ?? null,
    lastError: lastSessionError,
  };
}

async function startSessionUnlocked(distro?: string | null): Promise<WslSessionState> {
  if (typeof distro !== "undefined" && distro !== currentDistro) {
    stopSessionUnlocked();
    currentDistro = distro;
  }

  if (getActiveKeepalive()) {
    return getSessionState();
  }

  lastSessionError = null;
  const distroForStart = currentDistro;
  await probeWsl(distroForStart);

  const proc = spawn(WSL_EXE, [...wslArgsFor(distroForStart, ["bash", "-lc", "while true; do sleep 30; done"])], windowsHiddenSpawnOptions({
    stdio: "ignore",
  }));
  keepalive = proc;
  bindKeepaliveLifecycle(proc);
  proc.unref();

  await delay(100);
  const state = getSessionState();
  if (!state.running) {
    throw new Error(state.lastError || "WSL keepalive exited immediately after startup.");
  }

  return state;
}

export async function startSession(distro?: string | null): Promise<WslSessionState> {
  return withSessionLock(() => startSessionUnlocked(distro));
}

export async function ensureSessionStarted(): Promise<WslSessionState> {
  return withSessionLock(() => startSessionUnlocked());
}

export async function stopSession(): Promise<WslSessionState> {
  return withSessionLock(() => stopSessionUnlocked());
}

export function stopSessionSync(): WslSessionState {
  return stopSessionUnlocked();
}

async function spawnWslCommandRaw(cmdArgs: string[], input: string, options: WslSyncOptions = {}): Promise<WslRawResult> {
  return new Promise<WslRawResult>((resolve, reject) => {
    withSessionLock(async () => {
      await startSessionUnlocked();
      const args = wslArgsFor(currentDistro, cmdArgs);
      const proc = spawn(WSL_EXE, args, windowsHiddenSpawnOptions());
      const timeout = boundedDuration(options.timeoutMs, DEFAULT_SYNC_TIMEOUT_MS);
      const stdout: Buffer[] = [];
      let stderr = "";
      let timedOut = false;
      let timer: NodeJS.Timeout | null = null;
      let settled = false;

      timer = setTimeout(() => {
        timedOut = true;
        proc.kill();
      }, timeout.ms);
      timer.unref();

      proc.stdout?.on("data", (data: Buffer) => { stdout.push(data); });
      proc.stderr?.on("data", (data: Buffer) => { stderr += data.toString(); });
      proc.on("close", (code) => {
        if (settled) {
          return;
        }
        settled = true;
        if (timer) {
          clearTimeout(timer);
        }
        resolve({
          stdout: Buffer.concat(stdout),
          stderr,
          exitCode: code ?? -1,
          timedOut,
          timeoutMs: timeout.ms,
          requestedTimeoutMs: timeout.requestedMs,
          timeoutClamped: timeout.clamped,
          maxTimeoutMs: timeout.maxMs,
        });
      });
      proc.on("error", (error) => {
        if (settled) {
          return;
        }
        settled = true;
        if (timer) {
          clearTimeout(timer);
        }
        reject(error);
      });
      proc.stdin?.write(input);
      proc.stdin?.end();
    }).catch(reject);
  });
}

async function spawnWslCommand(cmdArgs: string[], input: string, options: WslSyncOptions = {}): Promise<WslResult> {
  const result = await spawnWslCommandRaw(cmdArgs, input, options);
  return {
    ...result,
    stdout: result.stdout.toString("utf8"),
  };
}

export async function execWsl(command: string, workdir?: string, options: WslSyncOptions = {}): Promise<WslResult> {
  return spawnWslCommand(["bash", "-l", "-s"], buildScriptInput(command + "\n", workdir), options);
}

export async function execWslScript(
  script: string,
  shell = "bash",
  workdir?: string,
  options: WslSyncOptions = {},
): Promise<WslResult> {
  return spawnWslCommand([shell, "-l", "-s"], buildScriptInput(script, workdir), options);
}

export async function runWslRawScript(script: string, options: WslSyncOptions = {}): Promise<WslRawResult> {
  const input = buildScriptInput(script.endsWith("\n") ? script : `${script}\n`);
  return spawnWslCommandRaw(["sh", "-s"], input, options);
}

async function startWslTask(command: string, shell: string, workdir?: string): Promise<WslTaskSnapshot> {
  let createdTask: WslTaskSnapshot | null = null;

  await withSessionLock(async () => {
    await startSessionUnlocked();

    const configuredDistro = currentDistro;
    const proc = spawn(WSL_EXE, wslArgsFor(configuredDistro, [shell, "-l", "-s"]), windowsHiddenSpawnOptions());
    const input = buildScriptInput(command.endsWith("\n") ? command : `${command}\n`, workdir);
    createdTask = taskManager.start(proc, {
      command,
      shell,
      workdir,
      configuredDistro,
    }, { input });
  });

  if (!createdTask) {
    throw new Error("Failed to create WSL task.");
  }

  return createdTask;
}

export async function execWslAsync(command: string, workdir?: string): Promise<WslTaskSnapshot> {
  return startWslTask(command, "bash", workdir);
}

export async function execWslScriptAsync(script: string, shell = "bash", workdir?: string): Promise<WslTaskSnapshot> {
  return startWslTask(script, shell, workdir);
}

export function listTasks(): WslTaskSnapshot[] {
  return taskManager.list();
}

export function getTaskStatus(taskId: string): WslTaskSnapshot {
  return taskManager.status(taskId);
}

export function readTaskOutput(
  taskId: string,
  stdoutOffset?: number,
  stderrOffset?: number,
  tailChars?: number,
  readMode?: WslReadMode,
): WslTaskOutput {
  return taskManager.readOutput(taskId, { stdoutOffset, stderrOffset, tailChars, readMode });
}

export async function observeTaskStatus(taskId: string): Promise<WslTaskSnapshot> {
  return taskManager.observeStatus(taskId);
}

export async function observeTaskOutput(
  taskId: string,
  stdoutOffset?: number,
  stderrOffset?: number,
  tailChars?: number,
  readMode?: WslReadMode,
): Promise<WslTaskOutput> {
  return taskManager.observeOutput(taskId, { stdoutOffset, stderrOffset, tailChars, readMode });
}

export async function waitTask(
  taskId: string,
  waitMs = DEFAULT_TASK_WAIT_MS,
  options: WslTaskOutputOptions = {},
): Promise<WslTaskWaitResult> {
  const wait = boundedDuration(waitMs, DEFAULT_TASK_WAIT_MS);
  const output = await taskManager.wait(taskId, wait.ms, {
    ...options,
    readMode: options.readMode ?? "delta",
  });
  return {
    ...output,
    waitMs: wait.ms,
    requestedWaitMs: wait.requestedMs,
    waitClamped: wait.clamped,
    maxWaitMs: wait.maxMs,
  };
}

export async function watchWslTask(
  command: string,
  shell: string,
  workdir?: string,
  timeoutMs = DEFAULT_WATCH_TIMEOUT_MS,
  timeoutBehavior: WslTimeoutBehavior = "detach",
  outputOptions: WslTaskOutputOptions = {},
): Promise<WslWatchResult> {
  const task = await startWslTask(command, shell, workdir);
  const timeout = boundedDuration(timeoutMs, DEFAULT_WATCH_TIMEOUT_MS);
  const waitResult = await waitTask(task.taskId, timeout.ms, outputOptions);
  let killed = false;

  if (!waitResult.completed && timeoutBehavior === "kill") {
    cancelTask(task.taskId);
    killed = true;
  }

  const finalOutput = killed
    ? readTaskOutput(
      task.taskId,
      outputOptions.stdoutOffset,
      outputOptions.stderrOffset,
      outputOptions.tailChars,
      outputOptions.readMode,
    )
    : waitResult;

  return {
    ...finalOutput,
    completed: waitResult.completed || killed,
    timedOut: !waitResult.completed,
    waitedMs: waitResult.waitedMs,
    waitMs: waitResult.waitMs,
    detached: !waitResult.completed && timeoutBehavior === "detach",
    killed,
    timeoutBehavior,
    requestedTimeoutMs: timeout.requestedMs,
    timeoutClamped: timeout.clamped,
    maxTimeoutMs: timeout.maxMs,
  };
}

export function cancelTask(taskId: string): WslTaskSnapshot {
  return taskManager.cancel(taskId);
}

export function cancelAllTasksSync(): void {
  taskManager.cancelAllSync();
}

export async function listDistros(): Promise<string[]> {
  return new Promise<string[]>((resolve, reject) => {
    const proc = spawn(WSL_EXE, ["-l", "-q"], windowsHiddenSpawnOptions());
    let chunks: Buffer[] = [];
    proc.stdout?.on("data", (data: Buffer) => { chunks.push(data); });
    proc.on("close", (code) => {
      if (code !== 0) return resolve([]);
      // wsl.exe outputs UTF-16LE on Windows; decode and split
      const raw = Buffer.concat(chunks).toString("ucs2");
      resolve(raw.trim().split(/\r?\n/).map((s) => s.trim()).filter(Boolean));
    });
    proc.on("error", reject);
  });
}

// ---------------------------------------------------------------------------
// Persistent jobs: detached tasks that survive MCP/Codex restarts.
//
// Unlike attached tasks (ProcessTaskManager), persistent jobs run fully
// detached inside WSL via setsid. Logs and pid files live in the WSL home
// directory (~/.remote-mcp/jobs/<jobId>/); job metadata lives in the Windows
// side store (work/persistent-jobs.json). Any agent that knows the jobId can
// re-attach, read logs, or cancel — even across MCP restarts.
// ---------------------------------------------------------------------------

function nowIso(): string {
  return new Date().toISOString();
}

function jobDirFor(jobId: string): string {
  return `$HOME/.remote-mcp/jobs/${jobId}`;
}

function parseIntOrNull(value: string | undefined): number | null {
  if (!value) {
    return null;
  }
  const num = Number.parseInt(value, 10);
  return Number.isFinite(num) ? num : null;
}

function parsePidPair(stdout: string): { pgid: number | null; runnerPid: number | null } {
  const [pgidLine, runnerPidLine] = stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => /^\d+$/.test(line));
  return {
    pgid: parseIntOrNull(pgidLine),
    runnerPid: parseIntOrNull(runnerPidLine),
  };
}

function requireWslJob(jobId: string): PersistentJobRecord {
  const record = getPersistentJob(PERSISTENT_JOB_STORE_PATH, jobId);
  if (record.backend !== "wsl") {
    throw new Error(`Persistent job ${jobId} is not a WSL job (backend=${record.backend}).`);
  }
  return record;
}

/**
 * Runs a short WSL command without the session lock or keepalive. Used for all
 * persistent job control/read operations so they never compete with attached
 * task locking and can target a detached job's files independently.
 */
async function spawnWslOnce(cmdArgs: string[], input: string, timeoutMs = PERSISTENT_JOB_OP_TIMEOUT_MS): Promise<WslResult> {
  return new Promise<WslResult>((resolve, reject) => {
    const proc = spawn(WSL_EXE, wslArgsFor(currentDistro, cmdArgs), windowsHiddenSpawnOptions());
    const stdout: Buffer[] = [];
    let stderr = "";
    let timedOut = false;
    let settled = false;
    const timer = setTimeout(() => {
      timedOut = true;
      proc.kill();
    }, timeoutMs);
    timer.unref();
    proc.stdout?.on("data", (data: Buffer) => { stdout.push(data); });
    proc.stderr?.on("data", (data: Buffer) => { stderr += data.toString(); });
    proc.on("close", (code) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolve({
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr,
        exitCode: code ?? -1,
        timedOut,
      });
    });
    proc.on("error", (error) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    proc.stdin?.write(input);
    proc.stdin?.end();
  });
}

async function execWslScriptForDistro(
  script: string,
  distro: string | null | undefined,
  shell = "bash",
  timeoutMs = PERSISTENT_JOB_OP_TIMEOUT_MS,
): Promise<WslResult> {
  const input = buildScriptInput(script.endsWith("\n") ? script : `${script}\n`);
  return spawnWslOnceForDistro(distro, [shell, "-l", "-s"], input, timeoutMs);
}

async function execWslForDistro(
  command: string,
  distro: string | null | undefined,
  timeoutMs = PERSISTENT_JOB_OP_TIMEOUT_MS,
): Promise<WslResult> {
  const input = buildScriptInput(command.endsWith("\n") ? command : `${command}\n`);
  return spawnWslOnceForDistro(distro, ["bash", "-l", "-s"], input, timeoutMs);
}

async function spawnWslOnceForDistro(
  distro: string | null | undefined,
  cmdArgs: string[],
  input: string,
  timeoutMs = PERSISTENT_JOB_OP_TIMEOUT_MS,
): Promise<WslResult> {
  return new Promise<WslResult>((resolve, reject) => {
    const proc = spawn(WSL_EXE, wslArgsFor(typeof distro === "undefined" ? currentDistro : distro, cmdArgs), windowsHiddenSpawnOptions());
    const stdout: Buffer[] = [];
    let stderr = "";
    let timedOut = false;
    let settled = false;
    const timer = setTimeout(() => {
      timedOut = true;
      proc.kill();
    }, timeoutMs);
    timer.unref();
    proc.stdout?.on("data", (data: Buffer) => { stdout.push(data); });
    proc.stderr?.on("data", (data: Buffer) => { stderr += data.toString(); });
    proc.on("close", (code) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolve({
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr,
        exitCode: code ?? -1,
        timedOut,
      });
    });
    proc.on("error", (error) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    proc.stdin?.write(input);
    proc.stdin?.end();
  });
}

export interface WslPersistentJobOutput {
  job: PersistentJobRecord;
  stdout: string;
  stderr: string;
  stdoutOffset: number;
  stderrOffset: number;
  nextStdoutOffset: number;
  nextStderrOffset: number;
  stdoutLength: number;
  stderrLength: number;
  readMode: PersistentJobReadMode;
  [key: string]: unknown;
}

async function readPersistentJobPids(jobId: string, distro: string | null | undefined): Promise<{
  pgid: number | null;
  runnerPid: number | null;
}> {
  const command = `cat "$HOME/.remote-mcp/jobs/${jobId}/pgid" 2>/dev/null; printf '\\n'; cat "$HOME/.remote-mcp/jobs/${jobId}/runner.pid" 2>/dev/null`;
  const deadline = Date.now() + 2000;
  let latest = { pgid: null as number | null, runnerPid: null as number | null };

  while (Date.now() <= deadline) {
    const result = await execWslForDistro(command, distro);
    latest = parsePidPair(result.stdout);
    if (latest.pgid !== null || latest.runnerPid !== null) {
      return latest;
    }
    await delay(100);
  }

  return latest;
}

export async function startPersistentJob(options: {
  command: string;
  workdir?: string;
  maxRuntimeMs?: number;
}): Promise<PersistentJobRecord> {
  const jobId = randomUUID();
  const maxRuntimeMs = options.maxRuntimeMs ?? PERSISTENT_JOB_MAX_RUNTIME_MS;
  const commandB64 = Buffer.from(options.command, "utf8").toString("base64");
  const workdirB64 = options.workdir ? Buffer.from(options.workdir, "utf8").toString("base64") : "";
  const runnerScript = buildPersistentJobRunnerScript({ jobId, commandB64, workdirB64, maxRuntimeMs });
  await ensureSessionStarted();
  const configuredDistro = currentDistro;
  const startResult = await execWslScriptForDistro(runnerScript, configuredDistro);
  if (startResult.exitCode !== 0) {
    throw new Error(`Failed to start persistent job ${jobId}: ${startResult.stderr.trim() || `wsl.exe exited with code ${startResult.exitCode}`}`);
  }

  // Read back the pgid and runner.pid written by the runner script.
  const { pgid, runnerPid } = await readPersistentJobPids(jobId, configuredDistro);
  const startedAt = nowIso();
  const deadlineIso = maxRuntimeMs > 0 ? new Date(Date.now() + maxRuntimeMs).toISOString() : null;
  const jobDir = jobDirFor(jobId);
  const record: PersistentJobRecord = {
    jobId,
    backend: "wsl",
    state: "running",
    shell: "bash",
    workdir: options.workdir,
    configuredDistro,
    jobDir,
    bodyPath: `${jobDir}/cmd.sh`,
    stdoutPath: `${jobDir}/stdout.log`,
    stderrPath: `${jobDir}/stderr.log`,
    statusPath: `${jobDir}/status`,
    runnerPid,
    pgid,
    maxRuntimeMs,
    deadlineIso,
    startedAt,
    endedAt: null,
    exitCode: null,
    error: null,
    createdAt: startedAt,
    updatedAt: startedAt,
  };
  return upsertPersistentJob(PERSISTENT_JOB_STORE_PATH, record);
}

export async function getPersistentJobStatus(jobId: string): Promise<PersistentJobRecord> {
  const record = requireWslJob(jobId);
  if (record.state === "running" && record.deadlineIso && new Date(record.deadlineIso).getTime() <= Date.now()) {
    const refreshed = await refreshPersistentJobRecord(record);
    if (refreshed.state === "running") {
      await cancelPersistentJob(jobId);
      return touchPersistentJob(PERSISTENT_JOB_STORE_PATH, jobId, { state: "expired", endedAt: nowIso() });
    }
    return refreshed;
  }
  if (record.state !== "running" && record.state !== "starting") {
    return record;
  }
  return refreshPersistentJobRecord(record);
}

async function refreshPersistentJobRecord(record: PersistentJobRecord): Promise<PersistentJobRecord> {
  const script = buildPersistentJobInspectScript({
    jobId: record.jobId,
    readMode: "delta",
    maxChars: 0,
    includeContent: false,
  });
  const result = await execWslScriptForDistro(script, record.configuredDistro);
  const inspect = parsePersistentJobInspect(result.stdout);
  const patch: Partial<PersistentJobRecord> = { state: inspect.state };
  if (inspect.state === "exited") {
    patch.endedAt = nowIso();
    patch.exitCode = parseIntOrNull(inspect.statusContent);
  } else if (inspect.state === "error") {
    patch.endedAt = nowIso();
    patch.error = inspect.statusContent || "unknown error";
  } else if (inspect.state === "cancelled" || inspect.state === "expired") {
    patch.endedAt = nowIso();
  }
  return touchPersistentJob(PERSISTENT_JOB_STORE_PATH, record.jobId, patch);
}

export async function readPersistentJobOutput(
  jobId: string,
  options: {
    stdoutOffset?: number;
    stderrOffset?: number;
    tailChars?: number;
    readMode?: PersistentJobReadMode;
  } = {},
): Promise<WslPersistentJobOutput> {
  const record = requireWslJob(jobId);
  const readMode = options.readMode ?? "delta";
  const script = buildPersistentJobInspectScript({
    jobId,
    readMode,
    stdoutOffset: options.stdoutOffset,
    stderrOffset: options.stderrOffset,
    tailChars: options.tailChars,
    maxChars: PERSISTENT_JOB_DEFAULT_READ_WINDOW_CHARS,
    includeContent: true,
  });
  const result = await execWslScriptForDistro(script, record.configuredDistro);
  const inspect = parsePersistentJobInspect(result.stdout);
  const stdout = inspect.stdoutB64 ? Buffer.from(inspect.stdoutB64, "base64").toString("utf8") : "";
  const stderr = inspect.stderrB64 ? Buffer.from(inspect.stderrB64, "base64").toString("utf8") : "";

  // Refresh terminal state into the record if the job just finished.
  let fresh = record;
  if (inspect.state !== "running" && inspect.state !== "starting" && record.state === "running") {
    const patch: Partial<PersistentJobRecord> = { state: inspect.state, endedAt: nowIso() };
    if (inspect.state === "exited") {
      patch.exitCode = parseIntOrNull(inspect.statusContent);
    } else if (inspect.state === "error") {
      patch.error = inspect.statusContent || "unknown error";
    }
    fresh = touchPersistentJob(PERSISTENT_JOB_STORE_PATH, jobId, patch);
  }
  return {
    job: fresh,
    stdout,
    stderr,
    stdoutOffset: inspect.stdoutOffset,
    stderrOffset: inspect.stderrOffset,
    nextStdoutOffset: inspect.stdoutNextOffset,
    nextStderrOffset: inspect.stderrNextOffset,
    stdoutLength: inspect.stdoutLength,
    stderrLength: inspect.stderrLength,
    readMode,
  };
}

export async function waitPersistentJob(
  jobId: string,
  waitMs: number,
  options: {
    stdoutOffset?: number;
    stderrOffset?: number;
    tailChars?: number;
    readMode?: PersistentJobReadMode;
  } = {},
): Promise<WslPersistentJobOutput & { completed: boolean; timedOut: boolean; waitedMs: number }> {
  const started = Date.now();
  while (true) {
    const status = await getPersistentJobStatus(jobId);
    if (status.state !== "running" && status.state !== "starting") {
      const output = await readPersistentJobOutput(jobId, options);
      return { ...output, completed: true, timedOut: false, waitedMs: Date.now() - started };
    }
    const elapsed = Date.now() - started;
    if (elapsed >= waitMs) {
      const output = await readPersistentJobOutput(jobId, options);
      return { ...output, completed: false, timedOut: true, waitedMs: elapsed };
    }
    await delay(Math.min(PERSISTENT_JOB_POLL_INTERVAL_MS, Math.max(0, waitMs - elapsed)));
  }
}

export async function cancelPersistentJob(jobId: string): Promise<PersistentJobRecord> {
  const record = requireWslJob(jobId);
  const script = buildPersistentJobCancelScript(jobId);
  await execWslScriptForDistro(script, record.configuredDistro);
  return touchPersistentJob(PERSISTENT_JOB_STORE_PATH, jobId, {
    state: "cancelled",
    endedAt: nowIso(),
  });
}

export function listPersistentJobs(): PersistentJobRecord[] {
  return listPersistentJobsFromStore(PERSISTENT_JOB_STORE_PATH);
}
