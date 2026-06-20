import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
const WSL_EXE = "wsl.exe";
function readPositiveIntEnv(name, fallback) {
    const raw = process.env[name]?.trim();
    if (!raw) {
        return fallback;
    }
    const value = Number.parseInt(raw, 10);
    return Number.isFinite(value) && value > 0 ? value : fallback;
}
const DEFAULT_DISTRO = process.env.WSL_MCP_DEFAULT_DISTRO?.trim() || "Ubuntu-24.04";
const TASK_OUTPUT_LIMIT = readPositiveIntEnv("WSL_MCP_TASK_OUTPUT_LIMIT", 1048576);
const MAX_FINISHED_TASKS = readPositiveIntEnv("WSL_MCP_MAX_FINISHED_TASKS", 100);
const TASK_MIN_POLL_INTERVAL_MS = readPositiveIntEnv("WSL_MCP_MIN_POLL_INTERVAL_MS", 20000);
const DEFAULT_SYNC_TIMEOUT_MS = readPositiveIntEnv("WSL_MCP_DEFAULT_SYNC_TIMEOUT_MS", 120000);
const DEFAULT_WATCH_TIMEOUT_MS = readPositiveIntEnv("WSL_MCP_DEFAULT_WATCH_TIMEOUT_MS", 120000);
const DEFAULT_TASK_WAIT_MS = readPositiveIntEnv("WSL_MCP_DEFAULT_TASK_WAIT_MS", 30000);
const MAX_TOOL_TIMEOUT_MS = readPositiveIntEnv("WSL_MCP_MAX_TOOL_TIMEOUT_MS", 540000);
const PROTECT_MNT_DELETE = process.env.WSL_MCP_PROTECT_MNT_DELETE !== "0";
let keepalive = null;
let currentDistro = DEFAULT_DISTRO;
let lastSessionError = null;
const expectedKeepaliveExits = new WeakSet();
let sessionLock = Promise.resolve();
const tasks = new Map();
async function withSessionLock(fn) {
    const previous = sessionLock;
    let release;
    sessionLock = new Promise((resolve) => {
        release = resolve;
    });
    await previous;
    try {
        return await fn();
    }
    finally {
        release();
    }
}
function wslArgsFor(distro, cmdArgs) {
    if (distro) {
        return ["-d", distro, "--", ...cmdArgs];
    }
    return ["--", ...cmdArgs];
}
function getActiveKeepalive() {
    if (!keepalive) {
        return null;
    }
    if (keepalive.exitCode !== null || keepalive.signalCode !== null) {
        keepalive = null;
        return null;
    }
    return keepalive;
}
function rememberKeepaliveFailure(code, signal) {
    if (signal) {
        lastSessionError = `WSL keepalive exited with signal ${signal}`;
        return;
    }
    if (code !== null && code !== 0) {
        lastSessionError = `WSL keepalive exited with code ${code}`;
    }
}
function bindKeepaliveLifecycle(proc) {
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
function shellQuote(value) {
    return `'${value.replace(/'/g, `'\\''`)}'`;
}
function buildPreamble(workdir) {
    return workdir ? `cd -- ${shellQuote(workdir)}\n` : "";
}
const MNT_DELETE_GUARD = String.raw `
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
function buildSafetyPreamble() {
    return PROTECT_MNT_DELETE ? `${MNT_DELETE_GUARD}\n` : "";
}
function buildScriptInput(body, workdir) {
    return buildSafetyPreamble() + buildPreamble(workdir) + body;
}
function nowIso() {
    return new Date().toISOString();
}
function isPositiveInt(value) {
    return typeof value === "number" && Number.isInteger(value) && value > 0;
}
function boundedDuration(requestedMs, fallbackMs) {
    const requested = isPositiveInt(requestedMs) ? requestedMs : undefined;
    const fallback = Math.min(fallbackMs, MAX_TOOL_TIMEOUT_MS);
    const ms = Math.min(requested ?? fallback, MAX_TOOL_TIMEOUT_MS);
    return {
        ms,
        requestedMs: requested,
        clamped: typeof requested === "number" && requested > ms,
        maxMs: MAX_TOOL_TIMEOUT_MS,
    };
}
function appendTaskOutput(task, stream, data) {
    const text = data.toString();
    const bufferKey = stream;
    const baseKey = stream === "stdout" ? "stdoutBaseOffset" : "stderrBaseOffset";
    task[bufferKey] += text;
    const overflow = task[bufferKey].length - TASK_OUTPUT_LIMIT;
    if (overflow > 0) {
        task[bufferKey] = task[bufferKey].slice(overflow);
        task[baseKey] += overflow;
    }
}
function taskSnapshot(task) {
    return {
        taskId: task.taskId,
        state: task.state,
        command: task.command,
        shell: task.shell,
        workdir: task.workdir,
        configuredDistro: task.configuredDistro,
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
function makeFinishedLatch() {
    let resolveFinished;
    const finished = new Promise((resolve) => {
        resolveFinished = resolve;
    });
    return { finished, resolveFinished };
}
function getTask(taskId) {
    const task = tasks.get(taskId);
    if (!task) {
        throw new Error(`Unknown WSL task: ${taskId}`);
    }
    return task;
}
function readTaskOutputUnlocked(task, stdoutOffset, stderrOffset, tailChars) {
    const stdout = sliceTaskStream(task.stdout, task.stdoutBaseOffset, stdoutOffset, tailChars);
    const stderr = sliceTaskStream(task.stderr, task.stderrBaseOffset, stderrOffset, tailChars);
    return {
        task: taskSnapshot(task),
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
async function withTaskObservationThrottle(task, fn) {
    const previous = task.observationLock;
    let release;
    task.observationLock = new Promise((resolve) => {
        release = resolve;
    });
    await previous;
    try {
        const now = Date.now();
        const elapsed = task.lastObservationAt === null ? TASK_MIN_POLL_INTERVAL_MS : now - task.lastObservationAt;
        const waitMs = task.state === "running" ? Math.max(0, TASK_MIN_POLL_INTERVAL_MS - elapsed) : 0;
        if (waitMs > 0) {
            await delay(waitMs);
        }
        task.lastObservationAt = Date.now();
        const poll = {
            throttled: waitMs > 0,
            waitedMs: waitMs,
            minPollIntervalMs: TASK_MIN_POLL_INTERVAL_MS,
            recommendedAction: "Use wsl_task action=\"wait\" for long-running tasks instead of rapid status/output polling.",
        };
        return await fn(poll);
    }
    finally {
        release();
    }
}
async function waitForTaskEnd(task, waitMs) {
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
function pruneFinishedTasks() {
    if (MAX_FINISHED_TASKS <= 0) {
        return;
    }
    const finished = [...tasks.values()].filter((task) => task.state !== "running");
    const extra = finished.length - MAX_FINISHED_TASKS;
    if (extra <= 0) {
        return;
    }
    finished
        .sort((a, b) => a.startedAt.localeCompare(b.startedAt))
        .slice(0, extra)
        .forEach((task) => tasks.delete(task.taskId));
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
async function probeWsl(distro) {
    return new Promise((resolve, reject) => {
        const proc = spawn(WSL_EXE, [...wslArgsFor(distro, ["bash", "-lc", "true"])], { windowsHide: true });
        let stderr = "";
        proc.stderr?.on("data", (data) => { stderr += data.toString(); });
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
function stopSessionUnlocked() {
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
export async function setDistro(distro) {
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
export function getDistro() {
    return currentDistro;
}
export function getDefaultDistro() {
    return DEFAULT_DISTRO;
}
export function getSessionState() {
    const active = getActiveKeepalive();
    return {
        running: active !== null,
        configuredDistro: currentDistro,
        defaultDistro: DEFAULT_DISTRO,
        pid: active?.pid ?? null,
        lastError: lastSessionError,
    };
}
async function startSessionUnlocked(distro) {
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
    const proc = spawn(WSL_EXE, [...wslArgsFor(distroForStart, ["bash", "-lc", "while true; do sleep 30; done"])], {
        stdio: "ignore",
        windowsHide: true,
    });
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
export async function startSession(distro) {
    return withSessionLock(() => startSessionUnlocked(distro));
}
export async function ensureSessionStarted() {
    return withSessionLock(() => startSessionUnlocked());
}
export async function stopSession() {
    return withSessionLock(() => stopSessionUnlocked());
}
export function stopSessionSync() {
    return stopSessionUnlocked();
}
async function spawnWslCommand(cmdArgs, input, options = {}) {
    return new Promise((resolve, reject) => {
        withSessionLock(async () => {
            await startSessionUnlocked();
            const args = wslArgsFor(currentDistro, cmdArgs);
            const proc = spawn(WSL_EXE, args, { windowsHide: true });
            const timeout = boundedDuration(options.timeoutMs, DEFAULT_SYNC_TIMEOUT_MS);
            let stdout = "";
            let stderr = "";
            let timedOut = false;
            let timer = null;
            let settled = false;
            timer = setTimeout(() => {
                timedOut = true;
                proc.kill();
            }, timeout.ms);
            timer.unref();
            proc.stdout?.on("data", (data) => { stdout += data.toString(); });
            proc.stderr?.on("data", (data) => { stderr += data.toString(); });
            proc.on("close", (code) => {
                if (settled) {
                    return;
                }
                settled = true;
                if (timer) {
                    clearTimeout(timer);
                }
                resolve({
                    stdout,
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
export async function execWsl(command, workdir, options = {}) {
    return spawnWslCommand(["bash", "-l", "-s"], buildScriptInput(command + "\n", workdir), options);
}
export async function execWslScript(script, shell = "bash", workdir, options = {}) {
    return spawnWslCommand([shell, "-l", "-s"], buildScriptInput(script, workdir), options);
}
async function startWslTask(command, shell, workdir) {
    let createdTask = null;
    await withSessionLock(async () => {
        await startSessionUnlocked();
        const taskId = randomUUID();
        const configuredDistro = currentDistro;
        const proc = spawn(WSL_EXE, wslArgsFor(configuredDistro, [shell, "-l", "-s"]), { windowsHide: true });
        const latch = makeFinishedLatch();
        const task = {
            taskId,
            state: "running",
            command,
            shell,
            workdir,
            configuredDistro,
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
        };
        tasks.set(taskId, task);
        createdTask = task;
        proc.stdout?.on("data", (data) => appendTaskOutput(task, "stdout", data));
        proc.stderr?.on("data", (data) => appendTaskOutput(task, "stderr", data));
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
            pruneFinishedTasks();
        });
        proc.on("error", (error) => {
            task.state = "error";
            task.error = error.message;
            task.endedAt ??= nowIso();
            task.proc = null;
            task.pid = null;
            task.resolveFinished();
            pruneFinishedTasks();
        });
        proc.stdin?.write(buildScriptInput(command, workdir));
        if (!command.endsWith("\n")) {
            proc.stdin?.write("\n");
        }
        proc.stdin?.end();
    });
    if (!createdTask) {
        throw new Error("Failed to create WSL task.");
    }
    return taskSnapshot(createdTask);
}
export async function execWslAsync(command, workdir) {
    return startWslTask(command, "bash", workdir);
}
export async function execWslScriptAsync(script, shell = "bash", workdir) {
    return startWslTask(script, shell, workdir);
}
export function listTasks() {
    return [...tasks.values()].map(taskSnapshot);
}
export function getTaskStatus(taskId) {
    return taskSnapshot(getTask(taskId));
}
export function readTaskOutput(taskId, stdoutOffset, stderrOffset, tailChars) {
    return readTaskOutputUnlocked(getTask(taskId), stdoutOffset, stderrOffset, tailChars);
}
export async function observeTaskStatus(taskId) {
    const task = getTask(taskId);
    return withTaskObservationThrottle(task, (poll) => ({
        ...taskSnapshot(task),
        poll,
    }));
}
export async function observeTaskOutput(taskId, stdoutOffset, stderrOffset, tailChars) {
    const task = getTask(taskId);
    return withTaskObservationThrottle(task, (poll) => ({
        ...readTaskOutputUnlocked(task, stdoutOffset, stderrOffset, tailChars),
        poll,
    }));
}
export async function waitTask(taskId, waitMs = DEFAULT_TASK_WAIT_MS, options = {}) {
    const task = getTask(taskId);
    const wait = boundedDuration(waitMs, DEFAULT_TASK_WAIT_MS);
    const started = Date.now();
    const completed = await waitForTaskEnd(task, wait.ms);
    const waitedMs = Date.now() - started;
    return {
        ...readTaskOutputUnlocked(task, options.stdoutOffset, options.stderrOffset, options.tailChars),
        completed,
        timedOut: !completed,
        waitedMs,
        waitMs: wait.ms,
        requestedWaitMs: wait.requestedMs,
        waitClamped: wait.clamped,
        maxWaitMs: wait.maxMs,
    };
}
export async function watchWslTask(command, shell, workdir, timeoutMs = DEFAULT_WATCH_TIMEOUT_MS, timeoutBehavior = "detach", outputOptions = {}) {
    const task = await startWslTask(command, shell, workdir);
    const timeout = boundedDuration(timeoutMs, DEFAULT_WATCH_TIMEOUT_MS);
    const waitResult = await waitTask(task.taskId, timeout.ms, outputOptions);
    let killed = false;
    if (!waitResult.completed && timeoutBehavior === "kill") {
        cancelTask(task.taskId);
        killed = true;
    }
    const finalOutput = killed
        ? readTaskOutput(task.taskId, outputOptions.stdoutOffset, outputOptions.stderrOffset, outputOptions.tailChars)
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
export function cancelTask(taskId) {
    const task = getTask(taskId);
    if (task.state === "running" && task.proc) {
        task.state = "cancelled";
        task.endedAt = nowIso();
        task.proc.kill();
        task.resolveFinished();
    }
    return taskSnapshot(task);
}
export function cancelAllTasksSync() {
    for (const task of tasks.values()) {
        if (task.state === "running" && task.proc) {
            task.state = "cancelled";
            task.endedAt = nowIso();
            task.proc.kill();
        }
    }
}
export async function listDistros() {
    return new Promise((resolve, reject) => {
        const proc = spawn(WSL_EXE, ["-l", "-q"], { windowsHide: true });
        let chunks = [];
        proc.stdout?.on("data", (data) => { chunks.push(data); });
        proc.on("close", (code) => {
            if (code !== 0)
                return resolve([]);
            // wsl.exe outputs UTF-16LE on Windows; decode and split
            const raw = Buffer.concat(chunks).toString("ucs2");
            resolve(raw.trim().split(/\r?\n/).map((s) => s.trim()).filter(Boolean));
        });
        proc.on("error", reject);
    });
}
//# sourceMappingURL=wsl.js.map