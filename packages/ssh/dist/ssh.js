import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { boundedDuration as sharedBoundedDuration, readPositiveIntEnv, readStringArrayJsonEnv } from "@remote-mcp/shared/env";
import { withFileLock } from "@remote-mcp/shared/fileLock";
import { killProcessTree, windowsHiddenSpawnOptions } from "@remote-mcp/shared/process";
import { buildEnvPreamble, buildWorkdirPreamble, shellStdinArgs, validateShell, } from "@remote-mcp/shared/shell";
import { ProcessTaskManager, } from "@remote-mcp/shared/task-manager";
import { buildPersistentJobCancelScript, buildPersistentJobInspectScript, buildPersistentJobRunnerScript, decodeJobPage, getPersistentJob, newPersistentJobRecord, requireJobCommandSuccess, listPersistentJobs as listPersistentJobsFromStore, parsePersistentJobInspect, resolveDefaultPersistentJobStorePath, touchPersistentJob, upsertPersistentJob, } from "@remote-mcp/shared/persistentJobs";
const SSH_COMMAND = process.env.SSH_MCP_COMMAND?.trim() || "ssh";
const INITIAL_DEFAULT_TARGET = process.env.SSH_MCP_DEFAULT_TARGET?.trim() || null;
const DEFAULT_SHELL = process.env.SSH_MCP_DEFAULT_SHELL?.trim() || "bash";
const MODULE_DIR = dirname(fileURLToPath(import.meta.url));
const DEFAULT_DEVICE_STORE_PATH = resolve(MODULE_DIR, "..", "devices.json");
const DEVICE_STORE_PATH = resolve(process.env.SSH_MCP_DEVICES_PATH?.trim() || DEFAULT_DEVICE_STORE_PATH);
const TASK_OUTPUT_LIMIT = readPositiveIntEnv("SSH_MCP_TASK_OUTPUT_LIMIT", 1048576);
const MAX_FINISHED_TASKS = readPositiveIntEnv("SSH_MCP_MAX_FINISHED_TASKS", 100);
const TASK_MIN_POLL_INTERVAL_MS = readPositiveIntEnv("SSH_MCP_MIN_POLL_INTERVAL_MS", 60000);
const TASK_DEFAULT_READ_WINDOW_CHARS = readPositiveIntEnv("SSH_MCP_DEFAULT_TASK_READ_WINDOW_CHARS", 8192);
const DEFAULT_SYNC_TIMEOUT_MS = readPositiveIntEnv("SSH_MCP_DEFAULT_SYNC_TIMEOUT_MS", 120000);
const DEFAULT_WATCH_TIMEOUT_MS = readPositiveIntEnv("SSH_MCP_DEFAULT_WATCH_TIMEOUT_MS", 120000);
const DEFAULT_TASK_WAIT_MS = readPositiveIntEnv("SSH_MCP_DEFAULT_TASK_WAIT_MS", 60000);
const MAX_TOOL_TIMEOUT_MS = readPositiveIntEnv("SSH_MCP_MAX_TOOL_TIMEOUT_MS", 540000);
const TARGET_PROBE_TIMEOUT_MS = readPositiveIntEnv("SSH_MCP_TARGET_PROBE_TIMEOUT_MS", 15000);
const PERSISTENT_JOB_STORE_PATH = resolveDefaultPersistentJobStorePath(MODULE_DIR);
const PERSISTENT_JOB_MAX_RUNTIME_MS = readPositiveIntEnv("SSH_MCP_PERSISTENT_JOB_MAX_RUNTIME_MS", 3600000);
const PERSISTENT_JOB_DEFAULT_READ_WINDOW_CHARS = Math.max(4, readPositiveIntEnv("SSH_MCP_PERSISTENT_JOB_DEFAULT_READ_WINDOW_CHARS", 8192));
const PERSISTENT_JOB_OP_TIMEOUT_MS = readPositiveIntEnv("SSH_MCP_PERSISTENT_JOB_OP_TIMEOUT_MS", 30000);
const PERSISTENT_JOB_POLL_INTERVAL_MS = readPositiveIntEnv("SSH_MCP_PERSISTENT_JOB_POLL_INTERVAL_MS", 1000);
function buildDefaultSshOptions() {
    const override = readStringArrayJsonEnv("SSH_MCP_OPTIONS_JSON");
    if (override) {
        return override;
    }
    const options = [];
    const connectTimeoutSec = readPositiveIntEnv("SSH_MCP_CONNECT_TIMEOUT_SEC", 10);
    const strictHostKeyChecking = process.env.SSH_MCP_STRICT_HOST_KEY_CHECKING?.trim() || "accept-new";
    if (process.env.SSH_MCP_BATCH_MODE !== "0") {
        options.push("-o", "BatchMode=yes");
    }
    if (connectTimeoutSec > 0) {
        options.push("-o", `ConnectTimeout=${connectTimeoutSec}`);
    }
    if (strictHostKeyChecking) {
        options.push("-o", `StrictHostKeyChecking=${strictHostKeyChecking}`);
    }
    const extra = readStringArrayJsonEnv("SSH_MCP_EXTRA_OPTIONS_JSON");
    if (extra) {
        options.push(...extra);
    }
    return options;
}
const DEFAULT_SSH_OPTIONS = buildDefaultSshOptions();
let currentDefaultTarget = INITIAL_DEFAULT_TARGET;
const taskManager = new ProcessTaskManager({
    outputLimit: TASK_OUTPUT_LIMIT,
    maxFinishedTasks: MAX_FINISHED_TASKS,
    minPollIntervalMs: TASK_MIN_POLL_INTERVAL_MS,
    pollRecommendation: "Use ssh_task action=\"wait\" for long-running tasks instead of rapid status/output polling.",
    unknownTaskLabel: "SSH",
    defaultReadWindowChars: TASK_DEFAULT_READ_WINDOW_CHARS,
});
let deviceStoreCache = null;
function nowIso() {
    return new Date().toISOString();
}
function boundedDuration(requestedMs, fallbackMs) {
    return sharedBoundedDuration(requestedMs, fallbackMs, MAX_TOOL_TIMEOUT_MS);
}
function validateDeviceName(name) {
    const trimmed = name.trim();
    if (!trimmed) {
        throw new Error("device name cannot be empty");
    }
    if (!isDeviceNameLiteral(trimmed)) {
        throw new Error(`Unsafe device name: ${name}`);
    }
    return trimmed;
}
function isDeviceNameLiteral(name) {
    return /^[A-Za-z0-9_.-]+$/.test(name.trim());
}
function validateTargetLiteral(target) {
    const trimmed = target.trim();
    if (!trimmed) {
        throw new Error("SSH target cannot be empty");
    }
    if (trimmed.startsWith("-")) {
        throw new Error(`Unsafe SSH target: ${trimmed}`);
    }
    return trimmed;
}
function sanitizeHosts(hosts) {
    if (hosts === undefined) {
        return [];
    }
    if (!Array.isArray(hosts) || !hosts.every((item) => typeof item === "string")) {
        throw new Error("hosts must be a string array");
    }
    return [...new Set(hosts.map((host) => host.trim()).filter(Boolean))];
}
function sanitizeStringArray(value, fieldName) {
    if (value === undefined) {
        return undefined;
    }
    if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
        throw new Error(`${fieldName} must be a string array`);
    }
    return value;
}
function sanitizeDeviceProfile(input) {
    const name = validateDeviceName(input.name);
    const target = typeof input.target === "string" && input.target.trim()
        ? validateTargetLiteral(input.target)
        : undefined;
    const user = typeof input.user === "string" && input.user.trim() ? input.user.trim() : undefined;
    const host = typeof input.host === "string" && input.host.trim() ? input.host.trim() : undefined;
    const hosts = sanitizeHosts(input.hosts);
    const port = typeof input.port === "number" && Number.isInteger(input.port) && input.port > 0 ? input.port : undefined;
    const identityFile = typeof input.identityFile === "string" && input.identityFile.trim()
        ? input.identityFile.trim()
        : undefined;
    const defaultWorkdir = typeof input.defaultWorkdir === "string" && input.defaultWorkdir.trim()
        ? input.defaultWorkdir.trim()
        : undefined;
    const sshOptions = sanitizeStringArray(input.sshOptions, "sshOptions");
    const tags = sanitizeStringArray(input.tags, "tags");
    const notes = typeof input.notes === "string" && input.notes.trim() ? input.notes.trim() : undefined;
    if (!target && !host && hosts.length === 0) {
        throw new Error("device profile needs target, host, or hosts");
    }
    if ((host || hosts.length > 0) && !user && !target) {
        throw new Error("device profile with host/hosts needs user unless target is provided");
    }
    return {
        name,
        ...(target ? { target } : {}),
        ...(user ? { user } : {}),
        ...(host ? { host } : {}),
        ...(hosts.length ? { hosts } : {}),
        ...(port ? { port } : {}),
        ...(identityFile ? { identityFile } : {}),
        ...(defaultWorkdir ? { defaultWorkdir } : {}),
        ...(sshOptions ? { sshOptions } : {}),
        ...(tags ? { tags } : {}),
        ...(notes ? { notes } : {}),
        ...(typeof input.lastResolvedTarget === "string" && input.lastResolvedTarget.trim()
            ? { lastResolvedTarget: validateTargetLiteral(input.lastResolvedTarget) }
            : {}),
        ...(typeof input.lastSeen === "string" && input.lastSeen.trim() ? { lastSeen: input.lastSeen.trim() } : {}),
    };
}
function readDeviceStore() {
    if (deviceStoreCache) {
        return deviceStoreCache;
    }
    if (!existsSync(DEVICE_STORE_PATH)) {
        deviceStoreCache = { version: 1, devices: {} };
        return deviceStoreCache;
    }
    const parsed = JSON.parse(readFileSync(DEVICE_STORE_PATH, "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error(`Invalid device store: ${DEVICE_STORE_PATH}`);
    }
    const raw = parsed;
    if (!raw.devices || typeof raw.devices !== "object" || Array.isArray(raw.devices)) {
        throw new Error(`Invalid device store devices object: ${DEVICE_STORE_PATH}`);
    }
    const devices = {};
    for (const [name, profile] of Object.entries(raw.devices)) {
        if (!profile || typeof profile !== "object" || Array.isArray(profile)) {
            throw new Error(`Invalid device profile for ${name}`);
        }
        devices[validateDeviceName(name)] = sanitizeDeviceProfile({
            ...profile,
            name,
        });
    }
    deviceStoreCache = { version: 1, devices };
    return deviceStoreCache;
}
function mutateDeviceStore(mutator) {
    return withFileLock(DEVICE_STORE_PATH, () => {
        // Bypass cache so concurrent MCP processes see the latest file.
        deviceStoreCache = null;
        const store = readDeviceStore();
        mutator(store);
        writeFileSync(DEVICE_STORE_PATH, `${JSON.stringify(store, null, 2)}\n`, "utf8");
        deviceStoreCache = store;
        return store;
    });
}
function deviceProfile(name) {
    const trimmed = name.trim();
    if (!isDeviceNameLiteral(trimmed)) {
        return undefined;
    }
    return readDeviceStore().devices[trimmed];
}
function buildTargetFromHost(profile, host) {
    const user = profile.user?.trim();
    if (!user) {
        throw new Error(`device ${profile.name} needs user to build target for host ${host}`);
    }
    return `${user}@${host.trim()}`;
}
function deviceCandidateTargets(profile) {
    const candidates = [];
    if (profile.lastResolvedTarget) {
        candidates.push(profile.lastResolvedTarget);
    }
    if (profile.target) {
        candidates.push(profile.target);
    }
    if (profile.host) {
        candidates.push(buildTargetFromHost(profile, profile.host));
    }
    for (const host of profile.hosts ?? []) {
        candidates.push(buildTargetFromHost(profile, host));
    }
    return [...new Set(candidates.map(validateTargetLiteral))];
}
function deviceSshOptions(profile) {
    if (!profile) {
        return [];
    }
    const options = [];
    if (profile.port) {
        options.push("-p", String(profile.port));
    }
    if (profile.identityFile) {
        options.push("-i", profile.identityFile);
    }
    if (profile.sshOptions) {
        options.push(...profile.sshOptions);
    }
    return options;
}
function rememberResolvedDevice(profile, target) {
    mutateDeviceStore((store) => {
        const current = store.devices[profile.name];
        if (!current) {
            return;
        }
        store.devices[profile.name] = {
            ...current,
            lastResolvedTarget: validateTargetLiteral(target),
            lastSeen: nowIso(),
        };
    });
}
function remoteShellArgs(shellInput, login = true) {
    return shellStdinArgs(shellInput || DEFAULT_SHELL, login);
}
function buildPreamble(workdir, env) {
    return buildEnvPreamble(env) + buildWorkdirPreamble(workdir);
}
function buildScriptInput(script, workdir, env) {
    return buildPreamble(workdir, env) + script + (script.endsWith("\n") ? "" : "\n");
}
function resolveTarget(target) {
    const requested = target?.trim() || currentDefaultTarget;
    if (!requested) {
        throw new Error("target is required. Pass target like user@example.com or set SSH_MCP_DEFAULT_TARGET.");
    }
    const profile = deviceProfile(requested);
    if (!profile) {
        const literal = validateTargetLiteral(requested);
        return { requestedTarget: requested, target: literal };
    }
    const candidates = deviceCandidateTargets(profile);
    if (candidates.length === 0) {
        throw new Error(`device profile ${profile.name} has no target candidates`);
    }
    return {
        requestedTarget: requested,
        target: candidates[0],
        deviceName: profile.name,
        profile,
    };
}
function buildSshArgsForTarget(options, resolved) {
    const sshOptions = options.sshOptions ?? [];
    if (!sshOptions.every((item) => typeof item === "string")) {
        throw new Error("sshOptions must be a string array");
    }
    return [
        ...DEFAULT_SSH_OPTIONS,
        ...deviceSshOptions(resolved.profile),
        ...sshOptions,
        "--",
        resolved.target,
        ...remoteShellArgs(options.shell, options.login ?? true),
    ];
}
function buildSshArgs(options) {
    const resolved = resolveTarget(options.target);
    return {
        resolved,
        args: buildSshArgsForTarget(options, resolved),
    };
}
async function probeCandidateTarget(options, resolved) {
    const args = buildSshArgsForTarget(options, resolved);
    return new Promise((resolveProbe) => {
        const proc = spawn(SSH_COMMAND, args, windowsHiddenSpawnOptions());
        let stderr = "";
        let settled = false;
        const timer = setTimeout(() => {
            killProcessTree(proc);
        }, TARGET_PROBE_TIMEOUT_MS);
        timer.unref();
        proc.stderr?.on("data", (data) => { stderr += data.toString(); });
        proc.on("close", (code) => {
            if (settled) {
                return;
            }
            settled = true;
            clearTimeout(timer);
            const exitCode = code ?? -1;
            resolveProbe({ ok: exitCode === 0, exitCode, stderr });
        });
        proc.on("error", (error) => {
            if (settled) {
                return;
            }
            settled = true;
            clearTimeout(timer);
            resolveProbe({ ok: false, exitCode: -1, stderr: error.message });
        });
        proc.stdin?.write("true\n");
        proc.stdin?.end();
    });
}
async function buildSshArgsForRun(options) {
    const candidates = candidateTargetsFor(options.target);
    if (candidates.length <= 1 || !candidates[0]?.profile) {
        const resolved = candidates[0] ?? resolveTarget(options.target);
        return {
            resolved,
            args: buildSshArgsForTarget(options, resolved),
        };
    }
    const failures = [];
    for (const candidate of candidates) {
        const probe = await probeCandidateTarget(options, candidate);
        if (probe.ok) {
            if (candidate.profile) {
                rememberResolvedDevice(candidate.profile, candidate.target);
            }
            return {
                resolved: candidate,
                args: buildSshArgsForTarget(options, candidate),
                attemptedTargets: candidates.map((item) => item.target),
            };
        }
        failures.push({ target: candidate.target, exitCode: probe.exitCode, stderr: probe.stderr });
    }
    const details = failures
        .map((failure) => `${failure.target}: exit=${failure.exitCode}${failure.stderr ? ` stderr=${failure.stderr.trim()}` : ""}`)
        .join("; ");
    throw new Error(`Could not connect to any SSH target candidate for ${candidates[0].requestedTarget}. ${details}`);
}
export function getSshState() {
    const taskList = taskManager.list();
    const store = readDeviceStore();
    return {
        sshCommand: SSH_COMMAND,
        defaultTarget: currentDefaultTarget,
        initialDefaultTarget: INITIAL_DEFAULT_TARGET,
        defaultShell: DEFAULT_SHELL,
        defaultSshOptions: DEFAULT_SSH_OPTIONS,
        deviceStorePath: DEVICE_STORE_PATH,
        deviceCount: Object.keys(store.devices).length,
        devices: Object.keys(store.devices).sort(),
        runningTasks: taskList.filter((task) => task.state === "running").length,
        taskCount: taskList.length,
    };
}
export function setDefaultTarget(target) {
    const trimmed = target?.trim() || null;
    if (trimmed) {
        if (deviceProfile(trimmed)) {
            currentDefaultTarget = trimmed;
        }
        else {
            currentDefaultTarget = validateTargetLiteral(trimmed);
        }
    }
    else {
        currentDefaultTarget = null;
    }
    return getSshState();
}
export function listDevices() {
    return Object.values(readDeviceStore().devices).sort((a, b) => a.name.localeCompare(b.name));
}
export function getDevice(name) {
    const profile = deviceProfile(name);
    if (!profile) {
        throw new Error(`Unknown SSH device: ${name}`);
    }
    return profile;
}
export function upsertDevice(profile) {
    const sanitized = sanitizeDeviceProfile(profile);
    const store = mutateDeviceStore((s) => {
        const existing = s.devices[sanitized.name];
        s.devices[sanitized.name] = {
            ...(existing ?? {}),
            ...sanitized,
            name: sanitized.name,
        };
    });
    return store.devices[sanitized.name];
}
export function removeDevice(name) {
    const deviceName = validateDeviceName(name);
    mutateDeviceStore((store) => {
        if (!store.devices[deviceName]) {
            throw new Error(`Unknown SSH device: ${deviceName}`);
        }
        delete store.devices[deviceName];
    });
    if (currentDefaultTarget === deviceName) {
        currentDefaultTarget = null;
    }
    return getSshState();
}
export function candidateTargetsFor(target) {
    const requested = target?.trim() || currentDefaultTarget;
    if (!requested) {
        throw new Error("target is required. Pass a device name, user@host, or set a default target.");
    }
    const profile = deviceProfile(requested);
    if (!profile) {
        return [{ requestedTarget: requested, target: validateTargetLiteral(requested) }];
    }
    return deviceCandidateTargets(profile).map((candidate) => ({
        requestedTarget: requested,
        target: candidate,
        deviceName: profile.name,
        profile,
    }));
}
export async function runSshRawScript(options) {
    const { resolved, args, attemptedTargets } = await buildSshArgsForRun(options);
    const effectiveWorkdir = options.workdir ?? resolved.profile?.defaultWorkdir;
    const input = buildScriptInput(options.script, effectiveWorkdir, options.env);
    const timeout = boundedDuration(options.timeoutMs, DEFAULT_SYNC_TIMEOUT_MS);
    return new Promise((resolve, reject) => {
        const proc = spawn(SSH_COMMAND, args, windowsHiddenSpawnOptions());
        const stdout = [];
        let stderr = "";
        let timedOut = false;
        let settled = false;
        let timer = null;
        timer = setTimeout(() => {
            timedOut = true;
            killProcessTree(proc);
        }, timeout.ms);
        timer.unref();
        proc.stdout?.on("data", (data) => { stdout.push(data); });
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
                target: resolved.target,
                requestedTarget: resolved.requestedTarget,
                deviceName: resolved.deviceName,
                stdout: Buffer.concat(stdout),
                stderr,
                exitCode: code ?? -1,
                timedOut,
                timeoutMs: timeout.ms,
                requestedTimeoutMs: timeout.requestedMs,
                timeoutClamped: timeout.clamped,
                maxTimeoutMs: timeout.maxMs,
                attemptedTargets,
            });
            if ((code ?? -1) === 0 && resolved.profile) {
                rememberResolvedDevice(resolved.profile, resolved.target);
            }
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
        proc.stdin?.on("error", () => { });
        proc.stdin?.write(input);
        proc.stdin?.end();
    });
}
export async function runSshScript(options) {
    const result = await runSshRawScript(options);
    return {
        ...result,
        stdout: result.stdout.toString("utf8"),
    };
}
export async function startSshTask(options) {
    const { resolved, args } = await buildSshArgsForRun(options);
    const effectiveWorkdir = options.workdir ?? resolved.profile?.defaultWorkdir;
    const input = buildScriptInput(options.script, effectiveWorkdir, options.env);
    const proc = spawn(SSH_COMMAND, args, windowsHiddenSpawnOptions());
    const shell = validateShell(options.shell || DEFAULT_SHELL);
    return taskManager.start(proc, {
        target: resolved.target,
        requestedTarget: resolved.requestedTarget,
        deviceName: resolved.deviceName,
        command: options.script,
        shell,
        workdir: effectiveWorkdir,
    }, {
        input,
        onSuccessfulExit: () => {
            if (resolved.profile) {
                rememberResolvedDevice(resolved.profile, resolved.target);
            }
        },
    });
}
export function listTasks() {
    return taskManager.list();
}
export async function observeTaskStatus(taskId) {
    return taskManager.observeStatus(taskId);
}
export async function observeTaskOutput(taskId, stdoutOffset, stderrOffset, tailChars, readMode) {
    return taskManager.observeOutput(taskId, { stdoutOffset, stderrOffset, tailChars, readMode });
}
export function readTaskOutput(taskId, stdoutOffset, stderrOffset, tailChars, readMode) {
    return taskManager.readOutput(taskId, { stdoutOffset, stderrOffset, tailChars, readMode });
}
export async function waitTask(taskId, waitMs = DEFAULT_TASK_WAIT_MS, options = {}) {
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
export async function watchSshTask(options, timeoutMs = DEFAULT_WATCH_TIMEOUT_MS, timeoutBehavior = "detach", outputOptions = {}) {
    const task = await startSshTask(options);
    const timeout = boundedDuration(timeoutMs, DEFAULT_WATCH_TIMEOUT_MS);
    const waitResult = await waitTask(task.taskId, timeout.ms, outputOptions);
    let killed = false;
    if (!waitResult.completed && timeoutBehavior === "kill") {
        cancelTask(task.taskId);
        killed = true;
    }
    const finalOutput = killed
        ? readTaskOutput(task.taskId, outputOptions.stdoutOffset, outputOptions.stderrOffset, outputOptions.tailChars, outputOptions.readMode)
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
    return taskManager.cancel(taskId);
}
export function cancelAllTasksSync() {
    taskManager.cancelAllSync();
}
export async function testSshTarget(target, timeoutMs = 15000) {
    const candidates = candidateTargetsFor(target);
    let lastResult = null;
    const failures = [];
    for (const candidate of candidates) {
        const result = await runSshScript({
            target: candidate.target,
            timeoutMs,
            sshOptions: deviceSshOptions(candidate.profile),
            script: [
                "printf 'ssh-mcp-ok\\n'",
                "printf 'user='; whoami",
                "printf 'host='; hostname",
                "printf 'pwd='; pwd",
                "uname -a 2>/dev/null || true",
            ].join("\n"),
        });
        result.requestedTarget = candidate.requestedTarget;
        result.deviceName = candidate.deviceName;
        lastResult = result;
        if (result.exitCode === 0) {
            if (candidate.profile) {
                rememberResolvedDevice(candidate.profile, candidate.target);
            }
            return {
                ...result,
                attemptedTargets: candidates.map((item) => item.target),
            };
        }
        failures.push({ target: candidate.target, exitCode: result.exitCode, stderr: result.stderr });
    }
    if (!lastResult) {
        throw new Error("no SSH target candidates");
    }
    return {
        ...lastResult,
        attemptedTargets: candidates.map((item) => item.target),
        failures,
    };
}
// ---------------------------------------------------------------------------
// Persistent jobs: detached tasks that survive MCP/Codex restarts.
//
// Unlike attached tasks (ProcessTaskManager), persistent jobs run fully
// detached inside the remote SSH host via setsid. Logs and pid files live
// in the remote home directory (~/.remote-mcp/jobs/<jobId>/); job metadata
// lives in the Windows-side store (work/persistent-jobs.json). Any agent
// that knows the jobId can re-attach, read logs, or cancel — even across
// MCP restarts.
// ---------------------------------------------------------------------------
function parseIntOrNull(value) {
    if (!value) {
        return null;
    }
    const num = Number.parseInt(value, 10);
    return Number.isFinite(num) ? num : null;
}
function parsePidPair(stdout) {
    const [pgidLine, runnerPidLine] = stdout
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => /^\d+$/.test(line));
    return {
        pgid: parseIntOrNull(pgidLine),
        runnerPid: parseIntOrNull(runnerPidLine),
    };
}
function requireSshJob(jobId) {
    const record = getPersistentJob(PERSISTENT_JOB_STORE_PATH, jobId);
    if (record.backend !== "ssh") {
        throw new Error(`Persistent job ${jobId} is not an SSH job (backend=${record.backend}).`);
    }
    return record;
}
async function readPersistentJobPids(jobId, target, sshOptions) {
    const metaScript = [
        `cat "$HOME/.remote-mcp/jobs/${jobId}/pgid" 2>/dev/null; printf '\\n'`,
        `cat "$HOME/.remote-mcp/jobs/${jobId}/runner.pid" 2>/dev/null`,
    ].join("\n");
    const deadline = Date.now() + 2000;
    let latest = { pgid: null, runnerPid: null };
    while (Date.now() <= deadline) {
        const metaResult = await runSshScript({
            target,
            sshOptions,
            script: metaScript,
            timeoutMs: PERSISTENT_JOB_OP_TIMEOUT_MS,
        });
        latest = parsePidPair(metaResult.stdout);
        if (latest.pgid !== null || latest.runnerPid !== null) {
            return latest;
        }
        await delay(100);
    }
    return latest;
}
export async function startPersistentJob(options) {
    const jobId = randomUUID();
    const maxRuntimeMs = options.maxRuntimeMs ?? PERSISTENT_JOB_MAX_RUNTIME_MS;
    const { resolved } = await buildSshArgsForRun({ target: options.target, script: "" });
    const workdir = options.workdir ?? resolved.profile?.defaultWorkdir;
    const sshOptions = deviceSshOptions(resolved.profile);
    const commandB64 = Buffer.from(options.command, "utf8").toString("base64");
    const workdirB64 = workdir ? Buffer.from(workdir, "utf8").toString("base64") : "";
    const runnerScript = buildPersistentJobRunnerScript({ jobId, commandB64, workdirB64, maxRuntimeMs });
    // Persist the ID and exact connection before launching any side effects.
    const record = newPersistentJobRecord({
        jobId, backend: "ssh", workdir, target: resolved.target,
        requestedTarget: resolved.requestedTarget, sshOptions, maxRuntimeMs,
    });
    upsertPersistentJob(PERSISTENT_JOB_STORE_PATH, record);
    try {
        const startResult = await runSshScript({
            target: record.target, sshOptions, script: runnerScript,
            timeoutMs: PERSISTENT_JOB_OP_TIMEOUT_MS,
        });
        requireJobCommandSuccess("start job", startResult);
        const pids = await readPersistentJobPids(jobId, resolved.target, sshOptions);
        const tracked = touchPersistentJob(PERSISTENT_JOB_STORE_PATH, jobId, pids);
        return await refreshPersistentJobRecord(tracked);
    }
    catch (error) {
        const message = `Job ${jobId} start outcome is unconfirmed: ${error instanceof Error ? error.message : String(error)}. Inspect ssh_job status/output for this jobId before retrying; remote logs: ${record.jobDir}.`;
        touchPersistentJob(PERSISTENT_JOB_STORE_PATH, jobId, { error: message });
        throw new Error(message);
    }
}
export async function getPersistentJobStatus(jobId) {
    const record = requireSshJob(jobId);
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
async function refreshPersistentJobRecord(record) {
    const script = buildPersistentJobInspectScript({
        jobId: record.jobId,
        readMode: "delta",
        maxChars: 0,
        includeContent: false,
    });
    const result = await runSshScript({
        target: record.target,
        sshOptions: record.sshOptions,
        script,
        timeoutMs: PERSISTENT_JOB_OP_TIMEOUT_MS,
    });
    requireJobCommandSuccess("inspect job", result);
    const inspect = parsePersistentJobInspect(result.stdout);
    const patch = { state: inspect.state, error: null };
    if (inspect.state === "exited") {
        patch.endedAt = nowIso();
        patch.exitCode = parseIntOrNull(inspect.statusContent);
    }
    else if (inspect.state === "error") {
        patch.endedAt = nowIso();
        patch.error = inspect.statusContent || "unknown error";
    }
    else if (inspect.state === "cancelled" || inspect.state === "expired") {
        patch.endedAt = nowIso();
    }
    return touchPersistentJob(PERSISTENT_JOB_STORE_PATH, record.jobId, patch);
}
export async function readPersistentJobOutput(jobId, options = {}) {
    const record = requireSshJob(jobId);
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
    const result = await runSshScript({
        target: record.target,
        sshOptions: record.sshOptions,
        script,
        timeoutMs: PERSISTENT_JOB_OP_TIMEOUT_MS,
    });
    requireJobCommandSuccess("read job output", result);
    const inspect = parsePersistentJobInspect(result.stdout);
    const mayGrow = inspect.state === "running" || inspect.state === "starting";
    const stdout = decodeJobPage(inspect.stdoutB64, inspect.stdoutOffset, inspect.stdoutNextOffset, inspect.stdoutLength, mayGrow);
    const stderr = decodeJobPage(inspect.stderrB64, inspect.stderrOffset, inspect.stderrNextOffset, inspect.stderrLength, mayGrow);
    // Refresh terminal state into the record if the job just finished.
    let fresh = record;
    if (inspect.state !== record.state && (record.state === "running" || record.state === "starting")) {
        const terminal = inspect.state !== "running" && inspect.state !== "starting";
        const patch = { state: inspect.state, error: null, ...(terminal ? { endedAt: nowIso() } : {}) };
        if (inspect.state === "exited") {
            patch.exitCode = parseIntOrNull(inspect.statusContent);
        }
        else if (inspect.state === "error") {
            patch.error = inspect.statusContent || "unknown error";
        }
        fresh = touchPersistentJob(PERSISTENT_JOB_STORE_PATH, jobId, patch);
    }
    return {
        job: fresh,
        stdout: stdout.text,
        stderr: stderr.text,
        stdoutOffset: stdout.offset,
        stderrOffset: stderr.offset,
        nextStdoutOffset: stdout.nextOffset,
        nextStderrOffset: stderr.nextOffset,
        stdoutLength: inspect.stdoutLength,
        stderrLength: inspect.stderrLength,
        readMode,
    };
}
export async function waitPersistentJob(jobId, waitMs, options = {}) {
    const budget = boundedDuration(waitMs, 60000);
    waitMs = budget.ms;
    const started = Date.now();
    while (true) {
        const status = await getPersistentJobStatus(jobId);
        if (status.state !== "running" && status.state !== "starting") {
            const output = await readPersistentJobOutput(jobId, options);
            return { ...output, completed: true, timedOut: false, waitedMs: Date.now() - started, waitClamped: budget.clamped, waitMs };
        }
        const elapsed = Date.now() - started;
        if (elapsed >= waitMs) {
            const output = await readPersistentJobOutput(jobId, options);
            return { ...output, completed: false, timedOut: true, waitedMs: Date.now() - started, waitClamped: budget.clamped, waitMs };
        }
        await delay(Math.min(PERSISTENT_JOB_POLL_INTERVAL_MS, Math.max(0, waitMs - elapsed)));
    }
}
export async function cancelPersistentJob(jobId) {
    const record = requireSshJob(jobId);
    if (record.state !== "running" && record.state !== "starting") {
        return record;
    }
    const script = buildPersistentJobCancelScript(jobId);
    const result = await runSshScript({
        target: record.target,
        sshOptions: record.sshOptions,
        script,
        timeoutMs: PERSISTENT_JOB_OP_TIMEOUT_MS,
    });
    if (result.exitCode !== 0) {
        // Re-inspect so we do not claim cancelled when the remote process still lives.
        const refreshed = await refreshPersistentJobRecord(record);
        if (refreshed.state === "running" || refreshed.state === "starting") {
            throw new Error(`Failed to cancel persistent job ${jobId}: ${result.stderr.trim() || result.stdout.trim() || `ssh exit ${result.exitCode}`}`);
        }
        return refreshed;
    }
    const line = result.stdout.trim().split(/\r?\n/).find((entry) => entry.includes("\t")) ?? "";
    const outcome = line.split("\t")[0] || "cancelled";
    if (outcome === "already_dead") {
        return refreshPersistentJobRecord(record);
    }
    return touchPersistentJob(PERSISTENT_JOB_STORE_PATH, jobId, {
        state: "cancelled",
        endedAt: nowIso(),
    });
}
export function listPersistentJobs() {
    return listPersistentJobsFromStore(PERSISTENT_JOB_STORE_PATH).filter((job) => job.backend === "ssh");
}
//# sourceMappingURL=ssh.js.map