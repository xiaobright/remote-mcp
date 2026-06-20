import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
function readPositiveIntEnv(name, fallback) {
    const raw = process.env[name]?.trim();
    if (!raw) {
        return fallback;
    }
    const value = Number.parseInt(raw, 10);
    return Number.isFinite(value) && value > 0 ? value : fallback;
}
function readStringArrayJsonEnv(name) {
    const raw = process.env[name]?.trim();
    if (!raw) {
        return null;
    }
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed) || !parsed.every((item) => typeof item === "string")) {
        throw new Error(`${name} must be a JSON string array`);
    }
    return parsed;
}
function sshSpawnOptions() {
    const home = homedir();
    return {
        env: {
            ...process.env,
            HOME: process.env.HOME || home,
            USERPROFILE: process.env.USERPROFILE || home,
            ProgramData: process.env.ProgramData || "C:\\ProgramData",
            SystemRoot: process.env.SystemRoot || process.env.SYSTEMROOT || "C:\\Windows",
            WINDIR: process.env.WINDIR || process.env.SystemRoot || process.env.SYSTEMROOT || "C:\\Windows",
        },
        windowsHide: true,
    };
}
const SSH_COMMAND = process.env.SSH_MCP_COMMAND?.trim() || "ssh";
const INITIAL_DEFAULT_TARGET = process.env.SSH_MCP_DEFAULT_TARGET?.trim() || null;
const DEFAULT_SHELL = process.env.SSH_MCP_DEFAULT_SHELL?.trim() || "bash";
const MODULE_DIR = dirname(fileURLToPath(import.meta.url));
const DEFAULT_DEVICE_STORE_PATH = resolve(MODULE_DIR, "..", "devices.json");
const DEVICE_STORE_PATH = resolve(process.env.SSH_MCP_DEVICES_PATH?.trim() || DEFAULT_DEVICE_STORE_PATH);
const TASK_OUTPUT_LIMIT = readPositiveIntEnv("SSH_MCP_TASK_OUTPUT_LIMIT", 1048576);
const MAX_FINISHED_TASKS = readPositiveIntEnv("SSH_MCP_MAX_FINISHED_TASKS", 100);
const TASK_MIN_POLL_INTERVAL_MS = readPositiveIntEnv("SSH_MCP_MIN_POLL_INTERVAL_MS", 20000);
const DEFAULT_SYNC_TIMEOUT_MS = readPositiveIntEnv("SSH_MCP_DEFAULT_SYNC_TIMEOUT_MS", 120000);
const DEFAULT_WATCH_TIMEOUT_MS = readPositiveIntEnv("SSH_MCP_DEFAULT_WATCH_TIMEOUT_MS", 120000);
const DEFAULT_TASK_WAIT_MS = readPositiveIntEnv("SSH_MCP_DEFAULT_TASK_WAIT_MS", 30000);
const MAX_TOOL_TIMEOUT_MS = readPositiveIntEnv("SSH_MCP_MAX_TOOL_TIMEOUT_MS", 540000);
const TARGET_PROBE_TIMEOUT_MS = readPositiveIntEnv("SSH_MCP_TARGET_PROBE_TIMEOUT_MS", 15000);
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
const tasks = new Map();
let deviceStoreCache = null;
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
function shellQuote(value) {
    return `'${value.replace(/'/g, `'\\''`)}'`;
}
function validateShell(shell) {
    const trimmed = shell.trim();
    if (!trimmed) {
        throw new Error("shell cannot be empty");
    }
    if (!/^[A-Za-z0-9_./+-]+$/.test(trimmed)) {
        throw new Error(`Unsafe shell value: ${shell}`);
    }
    return trimmed;
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
function writeDeviceStore(store) {
    writeFileSync(DEVICE_STORE_PATH, `${JSON.stringify(store, null, 2)}\n`, "utf8");
    deviceStoreCache = store;
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
    const store = readDeviceStore();
    const current = store.devices[profile.name];
    if (!current) {
        return;
    }
    store.devices[profile.name] = {
        ...current,
        lastResolvedTarget: validateTargetLiteral(target),
        lastSeen: nowIso(),
    };
    writeDeviceStore(store);
}
function remoteShellArgs(shellInput, login = true) {
    const shell = validateShell(shellInput || DEFAULT_SHELL);
    const base = shell.split(/[\\/]/).pop() || shell;
    if (login && (base === "bash" || base === "zsh")) {
        return [shell, "-l", "-s"];
    }
    return [shell, "-s"];
}
function validateEnvName(name) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
        throw new Error(`Unsafe environment variable name: ${name}`);
    }
    return name;
}
function buildPreamble(workdir, env) {
    const lines = [];
    for (const [name, value] of Object.entries(env ?? {})) {
        lines.push(`export ${validateEnvName(name)}=${shellQuote(String(value))}`);
    }
    if (workdir) {
        lines.push(`cd -- ${shellQuote(workdir)}`);
    }
    return lines.length ? `${lines.join("\n")}\n` : "";
}
function buildScriptInput(script, workdir, env) {
    return buildPreamble(workdir, env) + script + (script.endsWith("\n") ? "" : "\n");
}
function resolveTarget(target) {
    const requested = target?.trim() || currentDefaultTarget;
    if (!requested) {
        throw new Error("target is required. Pass target like radxa@192.168.31.34 or set SSH_MCP_DEFAULT_TARGET.");
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
        const proc = spawn(SSH_COMMAND, args, sshSpawnOptions());
        let stderr = "";
        let settled = false;
        const timer = setTimeout(() => {
            proc.kill();
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
    const taskList = [...tasks.values()];
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
    const store = readDeviceStore();
    const existing = store.devices[sanitized.name];
    store.devices[sanitized.name] = {
        ...(existing ?? {}),
        ...sanitized,
        name: sanitized.name,
    };
    writeDeviceStore(store);
    return store.devices[sanitized.name];
}
export function removeDevice(name) {
    const deviceName = validateDeviceName(name);
    const store = readDeviceStore();
    if (!store.devices[deviceName]) {
        throw new Error(`Unknown SSH device: ${deviceName}`);
    }
    delete store.devices[deviceName];
    if (currentDefaultTarget === deviceName) {
        currentDefaultTarget = null;
    }
    writeDeviceStore(store);
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
export async function runSshScript(options) {
    const { resolved, args, attemptedTargets } = await buildSshArgsForRun(options);
    const effectiveWorkdir = options.workdir ?? resolved.profile?.defaultWorkdir;
    const input = buildScriptInput(options.script, effectiveWorkdir, options.env);
    const timeout = boundedDuration(options.timeoutMs, DEFAULT_SYNC_TIMEOUT_MS);
    return new Promise((resolve, reject) => {
        const proc = spawn(SSH_COMMAND, args, sshSpawnOptions());
        let stdout = "";
        let stderr = "";
        let timedOut = false;
        let settled = false;
        let timer = null;
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
                target: resolved.target,
                requestedTarget: resolved.requestedTarget,
                deviceName: resolved.deviceName,
                stdout,
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
        proc.stdin?.write(input);
        proc.stdin?.end();
    });
}
function appendTaskOutput(task, stream, data) {
    const text = data.toString();
    const baseKey = stream === "stdout" ? "stdoutBaseOffset" : "stderrBaseOffset";
    task[stream] += text;
    const overflow = task[stream].length - TASK_OUTPUT_LIMIT;
    if (overflow > 0) {
        task[stream] = task[stream].slice(overflow);
        task[baseKey] += overflow;
    }
}
function makeFinishedLatch() {
    let resolveFinished;
    const finished = new Promise((resolve) => {
        resolveFinished = resolve;
    });
    return { finished, resolveFinished };
}
function taskSnapshot(task) {
    return {
        taskId: task.taskId,
        state: task.state,
        target: task.target,
        requestedTarget: task.requestedTarget,
        deviceName: task.deviceName,
        command: task.command,
        shell: task.shell,
        workdir: task.workdir,
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
function getTask(taskId) {
    const task = tasks.get(taskId);
    if (!task) {
        throw new Error(`Unknown SSH task: ${taskId}`);
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
            recommendedAction: "Use ssh_task action=\"wait\" for long-running tasks instead of rapid status/output polling.",
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
export async function startSshTask(options) {
    const { resolved, args } = await buildSshArgsForRun(options);
    const effectiveWorkdir = options.workdir ?? resolved.profile?.defaultWorkdir;
    const input = buildScriptInput(options.script, effectiveWorkdir, options.env);
    const proc = spawn(SSH_COMMAND, args, sshSpawnOptions());
    const latch = makeFinishedLatch();
    const taskId = randomUUID();
    const shell = validateShell(options.shell || DEFAULT_SHELL);
    const task = {
        taskId,
        state: "running",
        target: resolved.target,
        requestedTarget: resolved.requestedTarget,
        deviceName: resolved.deviceName,
        command: options.script,
        shell,
        workdir: effectiveWorkdir,
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
        if ((code ?? -1) === 0 && resolved.profile) {
            rememberResolvedDevice(resolved.profile, resolved.target);
        }
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
    proc.stdin?.write(input);
    proc.stdin?.end();
    return taskSnapshot(task);
}
export function listTasks() {
    return [...tasks.values()].map(taskSnapshot);
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
export function readTaskOutput(taskId, stdoutOffset, stderrOffset, tailChars) {
    return readTaskOutputUnlocked(getTask(taskId), stdoutOffset, stderrOffset, tailChars);
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
            task.resolveFinished();
        }
    }
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
//# sourceMappingURL=ssh.js.map