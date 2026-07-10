import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { boundedDuration as sharedBoundedDuration, readPositiveIntEnv, readStringArrayJsonEnv } from "@remote-mcp/shared/env";
import { withFileLock } from "@remote-mcp/shared/fileLock";
import { killProcessTree, windowsHiddenSpawnOptions } from "@remote-mcp/shared/process";
import {
  buildEnvPreamble,
  buildWorkdirPreamble,
  validateShell,
} from "@remote-mcp/shared/shell";
import {
  ProcessTaskManager,
  type TaskReadMode,
  type TaskOutput,
  type TaskSnapshot,
  type TaskState,
  type TaskWaitResult,
} from "@remote-mcp/shared/task-manager";
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

export type SshRunMode = "sync" | "async" | "watch";
export type SshTimeoutBehavior = "kill" | "detach";
export type SshTaskState = TaskState;
export type SshReadMode = TaskReadMode;

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

export interface SshRawRunResult {
  target: string;
  requestedTarget?: string;
  deviceName?: string;
  stdout: Buffer;
  stderr: string;
  exitCode: number;
  timedOut?: boolean;
  timeoutMs?: number;
  requestedTimeoutMs?: number;
  timeoutClamped?: boolean;
  maxTimeoutMs?: number;
  attemptedTargets?: string[];
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
  readMode?: SshReadMode;
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

const SSH_COMMAND = process.env.SSH_MCP_COMMAND?.trim() || "ssh";
const INITIAL_DEFAULT_TARGET = process.env.SSH_MCP_DEFAULT_TARGET?.trim() || null;
const DEFAULT_SHELL = process.env.SSH_MCP_DEFAULT_SHELL?.trim() || "bash";
const MODULE_DIR = dirname(fileURLToPath(import.meta.url));
const DEFAULT_DEVICE_STORE_PATH = resolve(MODULE_DIR, "..", "devices.json");
const DEVICE_STORE_PATH = resolve(process.env.SSH_MCP_DEVICES_PATH?.trim() || DEFAULT_DEVICE_STORE_PATH);
const TASK_OUTPUT_LIMIT = readPositiveIntEnv("SSH_MCP_TASK_OUTPUT_LIMIT", 1048576);
const MAX_FINISHED_TASKS = readPositiveIntEnv("SSH_MCP_MAX_FINISHED_TASKS", 100);
const TASK_MIN_POLL_INTERVAL_MS = readPositiveIntEnv("SSH_MCP_MIN_POLL_INTERVAL_MS", 20000);
const TASK_DEFAULT_READ_WINDOW_CHARS = readPositiveIntEnv("SSH_MCP_DEFAULT_TASK_READ_WINDOW_CHARS", 8192);
const DEFAULT_SYNC_TIMEOUT_MS = readPositiveIntEnv("SSH_MCP_DEFAULT_SYNC_TIMEOUT_MS", 120000);
const DEFAULT_WATCH_TIMEOUT_MS = readPositiveIntEnv("SSH_MCP_DEFAULT_WATCH_TIMEOUT_MS", 120000);
const DEFAULT_TASK_WAIT_MS = readPositiveIntEnv("SSH_MCP_DEFAULT_TASK_WAIT_MS", 30000);
const MAX_TOOL_TIMEOUT_MS = readPositiveIntEnv("SSH_MCP_MAX_TOOL_TIMEOUT_MS", 540000);
const TARGET_PROBE_TIMEOUT_MS = readPositiveIntEnv("SSH_MCP_TARGET_PROBE_TIMEOUT_MS", 15000);
const PERSISTENT_JOB_STORE_PATH = resolveDefaultPersistentJobStorePath(MODULE_DIR);
const PERSISTENT_JOB_MAX_RUNTIME_MS = readPositiveIntEnv("SSH_MCP_PERSISTENT_JOB_MAX_RUNTIME_MS", 3600000);
const PERSISTENT_JOB_DEFAULT_READ_WINDOW_CHARS = readPositiveIntEnv("SSH_MCP_PERSISTENT_JOB_DEFAULT_READ_WINDOW_CHARS", 8192);
const PERSISTENT_JOB_OP_TIMEOUT_MS = readPositiveIntEnv("SSH_MCP_PERSISTENT_JOB_OP_TIMEOUT_MS", 30000);
const PERSISTENT_JOB_POLL_INTERVAL_MS = readPositiveIntEnv("SSH_MCP_PERSISTENT_JOB_POLL_INTERVAL_MS", 1000);

function buildDefaultSshOptions(): string[] {
  const override = readStringArrayJsonEnv("SSH_MCP_OPTIONS_JSON");
  if (override) {
    return override;
  }

  const options: string[] = [];
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
let currentDefaultTarget: string | null = INITIAL_DEFAULT_TARGET;
const taskManager = new ProcessTaskManager<SshTaskMeta>({
  outputLimit: TASK_OUTPUT_LIMIT,
  maxFinishedTasks: MAX_FINISHED_TASKS,
  minPollIntervalMs: TASK_MIN_POLL_INTERVAL_MS,
  pollRecommendation: "Use ssh_task action=\"wait\" for long-running tasks instead of rapid status/output polling.",
  unknownTaskLabel: "SSH",
  defaultReadWindowChars: TASK_DEFAULT_READ_WINDOW_CHARS,
});
let deviceStoreCache: SshDeviceStore | null = null;

function nowIso(): string {
  return new Date().toISOString();
}

function boundedDuration(
  requestedMs: number | undefined,
  fallbackMs: number,
): { ms: number; requestedMs?: number; clamped: boolean; maxMs: number } {
  return sharedBoundedDuration(requestedMs, fallbackMs, MAX_TOOL_TIMEOUT_MS);
}

function validateDeviceName(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) {
    throw new Error("device name cannot be empty");
  }
  if (!isDeviceNameLiteral(trimmed)) {
    throw new Error(`Unsafe device name: ${name}`);
  }
  return trimmed;
}

function isDeviceNameLiteral(name: string): boolean {
  return /^[A-Za-z0-9_.-]+$/.test(name.trim());
}

function validateTargetLiteral(target: string): string {
  const trimmed = target.trim();
  if (!trimmed) {
    throw new Error("SSH target cannot be empty");
  }
  if (trimmed.startsWith("-")) {
    throw new Error(`Unsafe SSH target: ${trimmed}`);
  }
  return trimmed;
}

function sanitizeHosts(hosts: unknown): string[] {
  if (hosts === undefined) {
    return [];
  }
  if (!Array.isArray(hosts) || !hosts.every((item) => typeof item === "string")) {
    throw new Error("hosts must be a string array");
  }
  return [...new Set(hosts.map((host) => host.trim()).filter(Boolean))];
}

function sanitizeStringArray(value: unknown, fieldName: string): string[] | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
    throw new Error(`${fieldName} must be a string array`);
  }
  return value;
}

function sanitizeDeviceProfile(input: SshDeviceProfile): SshDeviceProfile {
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

function readDeviceStore(): SshDeviceStore {
  if (deviceStoreCache) {
    return deviceStoreCache;
  }
  if (!existsSync(DEVICE_STORE_PATH)) {
    deviceStoreCache = { version: 1, devices: {} };
    return deviceStoreCache;
  }

  const parsed = JSON.parse(readFileSync(DEVICE_STORE_PATH, "utf8")) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`Invalid device store: ${DEVICE_STORE_PATH}`);
  }
  const raw = parsed as { version?: unknown; devices?: unknown };
  if (!raw.devices || typeof raw.devices !== "object" || Array.isArray(raw.devices)) {
    throw new Error(`Invalid device store devices object: ${DEVICE_STORE_PATH}`);
  }

  const devices: Record<string, SshDeviceProfile> = {};
  for (const [name, profile] of Object.entries(raw.devices as Record<string, unknown>)) {
    if (!profile || typeof profile !== "object" || Array.isArray(profile)) {
      throw new Error(`Invalid device profile for ${name}`);
    }
    devices[validateDeviceName(name)] = sanitizeDeviceProfile({
      ...(profile as SshDeviceProfile),
      name,
    });
  }
  deviceStoreCache = { version: 1, devices };
  return deviceStoreCache;
}

function mutateDeviceStore(mutator: (store: SshDeviceStore) => void): SshDeviceStore {
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

function deviceProfile(name: string): SshDeviceProfile | undefined {
  const trimmed = name.trim();
  if (!isDeviceNameLiteral(trimmed)) {
    return undefined;
  }
  return readDeviceStore().devices[trimmed];
}

function buildTargetFromHost(profile: SshDeviceProfile, host: string): string {
  const user = profile.user?.trim();
  if (!user) {
    throw new Error(`device ${profile.name} needs user to build target for host ${host}`);
  }
  return `${user}@${host.trim()}`;
}

function deviceCandidateTargets(profile: SshDeviceProfile): string[] {
  const candidates: string[] = [];
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

function deviceSshOptions(profile?: SshDeviceProfile): string[] {
  if (!profile) {
    return [];
  }
  const options: string[] = [];
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

function rememberResolvedDevice(profile: SshDeviceProfile, target: string): void {
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

function remoteShellArgs(shellInput?: string, login = true): string[] {
  const shell = validateShell(shellInput || DEFAULT_SHELL);
  const base = shell.split(/[\\/]/).pop() || shell;
  if (login && (base === "bash" || base === "zsh")) {
    return [shell, "-l", "-s"];
  }
  return [shell, "-s"];
}

function buildPreamble(workdir?: string, env?: Record<string, string>): string {
  return buildEnvPreamble(env) + buildWorkdirPreamble(workdir);
}

function buildScriptInput(script: string, workdir?: string, env?: Record<string, string>): string {
  return buildPreamble(workdir, env) + script + (script.endsWith("\n") ? "" : "\n");
}

function resolveTarget(target?: string): ResolvedSshTarget {
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

function buildSshArgsForTarget(options: SshRunOptions, resolved: ResolvedSshTarget): string[] {
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

function buildSshArgs(options: SshRunOptions): { resolved: ResolvedSshTarget; args: string[] } {
  const resolved = resolveTarget(options.target);
  return {
    resolved,
    args: buildSshArgsForTarget(options, resolved),
  };
}

async function probeCandidateTarget(options: SshRunOptions, resolved: ResolvedSshTarget): Promise<{ ok: boolean; exitCode: number; stderr: string }> {
  const args = buildSshArgsForTarget(options, resolved);
  return new Promise((resolveProbe) => {
    const proc = spawn(SSH_COMMAND, args, windowsHiddenSpawnOptions());
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => {
      killProcessTree(proc);
    }, TARGET_PROBE_TIMEOUT_MS);
    timer.unref();

    proc.stderr?.on("data", (data: Buffer) => { stderr += data.toString(); });
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

async function buildSshArgsForRun(options: SshRunOptions): Promise<{
  resolved: ResolvedSshTarget;
  args: string[];
  attemptedTargets?: string[];
}> {
  const candidates = candidateTargetsFor(options.target);
  if (candidates.length <= 1 || !candidates[0]?.profile) {
    const resolved = candidates[0] ?? resolveTarget(options.target);
    return {
      resolved,
      args: buildSshArgsForTarget(options, resolved),
    };
  }

  const failures: Array<{ target: string; exitCode: number; stderr: string }> = [];
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

export function getSshState(): SshState {
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

export function setDefaultTarget(target: string | null): SshState {
  const trimmed = target?.trim() || null;
  if (trimmed) {
    if (deviceProfile(trimmed)) {
      currentDefaultTarget = trimmed;
    } else {
      currentDefaultTarget = validateTargetLiteral(trimmed);
    }
  } else {
    currentDefaultTarget = null;
  }
  return getSshState();
}

export function listDevices(): SshDeviceProfile[] {
  return Object.values(readDeviceStore().devices).sort((a, b) => a.name.localeCompare(b.name));
}

export function getDevice(name: string): SshDeviceProfile {
  const profile = deviceProfile(name);
  if (!profile) {
    throw new Error(`Unknown SSH device: ${name}`);
  }
  return profile;
}

export function upsertDevice(profile: SshDeviceProfile): SshDeviceProfile {
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

export function removeDevice(name: string): SshState {
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

export function candidateTargetsFor(target?: string): ResolvedSshTarget[] {
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

export async function runSshRawScript(options: SshRunOptions): Promise<SshRawRunResult> {
  const { resolved, args, attemptedTargets } = await buildSshArgsForRun(options);
  const effectiveWorkdir = options.workdir ?? resolved.profile?.defaultWorkdir;
  const input = buildScriptInput(options.script, effectiveWorkdir, options.env);
  const timeout = boundedDuration(options.timeoutMs, DEFAULT_SYNC_TIMEOUT_MS);

  return new Promise<SshRawRunResult>((resolve, reject) => {
    const proc = spawn(SSH_COMMAND, args, windowsHiddenSpawnOptions());
    const stdout: Buffer[] = [];
    let stderr = "";
    let timedOut = false;
    let settled = false;
    let timer: NodeJS.Timeout | null = null;

    timer = setTimeout(() => {
      timedOut = true;
      killProcessTree(proc);
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
    proc.stdin?.write(input);
    proc.stdin?.end();
  });
}

export async function runSshScript(options: SshRunOptions): Promise<SshRunResult> {
  const result = await runSshRawScript(options);
  return {
    ...result,
    stdout: result.stdout.toString("utf8"),
  };
}

export async function startSshTask(options: SshRunOptions): Promise<SshTaskSnapshot> {
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

export function listTasks(): SshTaskSnapshot[] {
  return taskManager.list();
}

export async function observeTaskStatus(taskId: string): Promise<SshTaskSnapshot> {
  return taskManager.observeStatus(taskId);
}

export async function observeTaskOutput(
  taskId: string,
  stdoutOffset?: number,
  stderrOffset?: number,
  tailChars?: number,
  readMode?: SshReadMode,
): Promise<SshTaskOutput> {
  return taskManager.observeOutput(taskId, { stdoutOffset, stderrOffset, tailChars, readMode });
}

export function readTaskOutput(
  taskId: string,
  stdoutOffset?: number,
  stderrOffset?: number,
  tailChars?: number,
  readMode?: SshReadMode,
): SshTaskOutput {
  return taskManager.readOutput(taskId, { stdoutOffset, stderrOffset, tailChars, readMode });
}

export async function waitTask(
  taskId: string,
  waitMs = DEFAULT_TASK_WAIT_MS,
  options: SshTaskOutputOptions = {},
): Promise<SshTaskWaitResult> {
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

export async function watchSshTask(
  options: SshRunOptions,
  timeoutMs = DEFAULT_WATCH_TIMEOUT_MS,
  timeoutBehavior: SshTimeoutBehavior = "detach",
  outputOptions: SshTaskOutputOptions = {},
): Promise<SshWatchResult> {
  const task = await startSshTask(options);
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

export function cancelTask(taskId: string): SshTaskSnapshot {
  return taskManager.cancel(taskId);
}

export function cancelAllTasksSync(): void {
  taskManager.cancelAllSync();
}

export async function testSshTarget(target?: string, timeoutMs = 15000): Promise<SshRunResult> {
  const candidates = candidateTargetsFor(target);
  let lastResult: SshRunResult | null = null;
  const failures: Array<{ target: string; exitCode: number; stderr: string }> = [];
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

function requireSshJob(jobId: string): PersistentJobRecord {
  const record = getPersistentJob(PERSISTENT_JOB_STORE_PATH, jobId);
  if (record.backend !== "ssh") {
    throw new Error(`Persistent job ${jobId} is not an SSH job (backend=${record.backend}).`);
  }
  return record;
}

export interface SshPersistentJobOutput {
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

async function readPersistentJobPids(jobId: string, target: string): Promise<{
  pgid: number | null;
  runnerPid: number | null;
}> {
  const metaScript = [
    `cat "$HOME/.remote-mcp/jobs/${jobId}/pgid" 2>/dev/null; printf '\\n'`,
    `cat "$HOME/.remote-mcp/jobs/${jobId}/runner.pid" 2>/dev/null`,
  ].join("\n");
  const deadline = Date.now() + 2000;
  let latest = { pgid: null as number | null, runnerPid: null as number | null };

  while (Date.now() <= deadline) {
    const metaResult = await runSshScript({
      target,
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

export async function startPersistentJob(options: {
  command: string;
  target?: string;
  workdir?: string;
  maxRuntimeMs?: number;
}): Promise<PersistentJobRecord> {
  const jobId = randomUUID();
  const maxRuntimeMs = options.maxRuntimeMs ?? PERSISTENT_JOB_MAX_RUNTIME_MS;
  const commandB64 = Buffer.from(options.command, "utf8").toString("base64");
  const workdirB64 = options.workdir ? Buffer.from(options.workdir, "utf8").toString("base64") : "";
  const runnerScript = buildPersistentJobRunnerScript({ jobId, commandB64, workdirB64, maxRuntimeMs });

  // runSshScript resolves the target (with probing if a device name is given)
  // and returns the resolved target/deviceName in the result.
  const startResult = await runSshScript({
    target: options.target,
    script: runnerScript,
    timeoutMs: PERSISTENT_JOB_OP_TIMEOUT_MS,
  });
  if (startResult.exitCode !== 0) {
    throw new Error(
      `Failed to start persistent job ${jobId}: ${startResult.stderr.trim() || `ssh exited with code ${startResult.exitCode}`}`,
    );
  }

  // Read back the pgid and runner.pid written by the runner script.
  const { pgid, runnerPid } = await readPersistentJobPids(jobId, startResult.target);
  const startedAt = nowIso();
  const deadlineIso = maxRuntimeMs > 0 ? new Date(Date.now() + maxRuntimeMs).toISOString() : null;
  const jobDir = jobDirFor(jobId);
  const record: PersistentJobRecord = {
    jobId,
    backend: "ssh",
    state: "running",
    shell: "bash",
    workdir: options.workdir,
    target: startResult.target,
    requestedTarget: startResult.requestedTarget,
    configuredDistro: undefined,
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

async function refreshPersistentJobRecord(record: PersistentJobRecord): Promise<PersistentJobRecord> {
  const script = buildPersistentJobInspectScript({
    jobId: record.jobId,
    readMode: "delta",
    maxChars: 0,
    includeContent: false,
  });
  const result = await runSshScript({
    target: record.target,
    script,
    timeoutMs: PERSISTENT_JOB_OP_TIMEOUT_MS,
  });
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
): Promise<SshPersistentJobOutput> {
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
    script,
    timeoutMs: PERSISTENT_JOB_OP_TIMEOUT_MS,
  });
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
): Promise<SshPersistentJobOutput & { completed: boolean; timedOut: boolean; waitedMs: number }> {
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
  const record = requireSshJob(jobId);
  if (record.state !== "running" && record.state !== "starting") {
    return record;
  }
  const script = buildPersistentJobCancelScript(jobId);
  const result = await runSshScript({
    target: record.target,
    script,
    timeoutMs: PERSISTENT_JOB_OP_TIMEOUT_MS,
  });
  if (result.exitCode !== 0) {
    // Re-inspect so we do not claim cancelled when the remote process still lives.
    const refreshed = await refreshPersistentJobRecord(record);
    if (refreshed.state === "running" || refreshed.state === "starting") {
      throw new Error(
        `Failed to cancel persistent job ${jobId}: ${result.stderr.trim() || result.stdout.trim() || `ssh exit ${result.exitCode}`}`,
      );
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

export function listPersistentJobs(): PersistentJobRecord[] {
  return listPersistentJobsFromStore(PERSISTENT_JOB_STORE_PATH);
}
