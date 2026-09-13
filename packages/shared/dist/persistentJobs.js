import { mkdirSync, readFileSync, renameSync, writeFileSync, } from "node:fs";
import { dirname, resolve } from "node:path";
import { readPositiveIntEnv } from "./env.js";
import { withFileLock } from "./fileLock.js";
function nowIso() {
    return new Date().toISOString();
}
const STORE_LOCK_WAIT_MS = readPositiveIntEnv("REMOTE_MCP_PERSISTENT_JOB_STORE_LOCK_WAIT_MS", 5000);
const STORE_LOCK_STALE_MS = readPositiveIntEnv("REMOTE_MCP_PERSISTENT_JOB_STORE_LOCK_STALE_MS", 30000);
function withPersistentJobStoreLock(storePath, fn) {
    return withFileLock(storePath, fn, {
        waitMs: STORE_LOCK_WAIT_MS,
        staleMs: STORE_LOCK_STALE_MS,
    });
}
export function emptyPersistentJobStore() {
    return { version: 1, jobs: {} };
}
export function readPersistentJobStore(storePath) {
    try {
        const parsed = JSON.parse(readFileSync(storePath, "utf8"));
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
            return emptyPersistentJobStore();
        }
        const raw = parsed;
        if (raw.version !== 1 || !raw.jobs || typeof raw.jobs !== "object" || Array.isArray(raw.jobs)) {
            return emptyPersistentJobStore();
        }
        return {
            version: 1,
            jobs: raw.jobs,
        };
    }
    catch (error) {
        const code = error.code;
        if (code === "ENOENT") {
            return emptyPersistentJobStore();
        }
        throw error;
    }
}
function writePersistentJobStoreUnlocked(storePath, store) {
    mkdirSync(dirname(storePath), { recursive: true });
    const tmpPath = `${storePath}.tmp`;
    writeFileSync(tmpPath, `${JSON.stringify(store, null, 2)}\n`, "utf8");
    renameSync(tmpPath, storePath);
}
export function writePersistentJobStore(storePath, store) {
    withPersistentJobStoreLock(storePath, () => writePersistentJobStoreUnlocked(storePath, store));
}
export function upsertPersistentJob(storePath, record) {
    return withPersistentJobStoreLock(storePath, () => {
        const store = readPersistentJobStore(storePath);
        const next = {
            ...record,
            updatedAt: nowIso(),
        };
        store.jobs[record.jobId] = next;
        writePersistentJobStoreUnlocked(storePath, store);
        return next;
    });
}
export function getPersistentJob(storePath, jobId) {
    const store = readPersistentJobStore(storePath);
    const record = store.jobs[jobId];
    if (!record) {
        throw new Error(`Unknown persistent job: ${jobId}`);
    }
    return record;
}
export function listPersistentJobs(storePath) {
    const store = readPersistentJobStore(storePath);
    return Object.values(store.jobs).sort((a, b) => a.startedAt.localeCompare(b.startedAt));
}
export function touchPersistentJob(storePath, jobId, patch) {
    return withPersistentJobStoreLock(storePath, () => {
        const store = readPersistentJobStore(storePath);
        const current = store.jobs[jobId];
        if (!current) {
            throw new Error(`Unknown persistent job: ${jobId}`);
        }
        const next = {
            ...current,
            ...patch,
            updatedAt: nowIso(),
        };
        store.jobs[jobId] = next;
        writePersistentJobStoreUnlocked(storePath, store);
        return next;
    });
}
export function deletePersistentJob(storePath, jobId) {
    withPersistentJobStoreLock(storePath, () => {
        const store = readPersistentJobStore(storePath);
        if (!store.jobs[jobId]) {
            return;
        }
        delete store.jobs[jobId];
        writePersistentJobStoreUnlocked(storePath, store);
    });
}
export function resolveDefaultPersistentJobStorePath(moduleDir) {
    if (process.env.REMOTE_MCP_PERSISTENT_JOB_STORE_PATH) {
        return resolve(process.env.REMOTE_MCP_PERSISTENT_JOB_STORE_PATH);
    }
    return resolve(moduleDir, "..", "..", "..", "work", "persistent-jobs.json");
}
export function newPersistentJobRecord(options) {
    const startedAt = nowIso();
    const jobDir = `$HOME/.remote-mcp/jobs/${options.jobId}`;
    return {
        ...options, state: "starting", shell: "bash", jobDir,
        bodyPath: `${jobDir}/cmd.sh`, stdoutPath: `${jobDir}/stdout.log`,
        stderrPath: `${jobDir}/stderr.log`, statusPath: `${jobDir}/status`,
        runnerPid: null, pgid: null,
        deadlineIso: options.maxRuntimeMs > 0 ? new Date(Date.now() + options.maxRuntimeMs).toISOString() : null,
        startedAt, endedAt: null, exitCode: null, error: null,
        createdAt: startedAt, updatedAt: startedAt,
    };
}
export function requireJobCommandSuccess(action, result) {
    if (result.timedOut || result.exitCode !== 0) {
        throw new Error(`${action}: ${result.timedOut ? "transport timed out" : `transport exited ${result.exitCode}`}. ${result.stderr.trim()}`);
    }
}
function shellSingleQuote(value) {
    return `'${value.replace(/'/g, "'\\''")}'`;
}
export function inferPersistentJobState(statusContent) {
    const trimmed = statusContent.trim();
    if (!trimmed) {
        return "starting";
    }
    if (trimmed === "running") {
        return "running";
    }
    if (trimmed === "cancelled") {
        return "cancelled";
    }
    if (trimmed === "expired") {
        return "expired";
    }
    if (/^-?\d+$/.test(trimmed)) {
        return "exited";
    }
    return "error";
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
 *   pgid          same session-leader PID as runner.pid
 *
 * The spawning shell returns immediately after launching setsid, so the
 * caller (wsl.exe / ssh) does not stay attached.
 */
export function buildPersistentJobRunnerScript(options) {
    const { jobId, commandB64, workdirB64, maxRuntimeMs } = options;
    // Session leader writes both runner.pid and pgid as $$ (PID == PGID after setsid).
    // Do NOT trust the parent shell's $! — setsid often forks and $! is a short-lived parent.
    return [
        `command -v bash >/dev/null && command -v setsid >/dev/null && command -v base64 >/dev/null || { printf 'job requires bash, setsid and base64\\n' >&2; exit 127; }`,
        `JOB_ID=${shellSingleQuote(jobId)}`,
        `JOB_DIR="$HOME/.remote-mcp/jobs/$JOB_ID"`,
        `mkdir -p "$JOB_DIR" || exit $?`,
        `: > "$JOB_DIR/stdout.log"`,
        `: > "$JOB_DIR/stderr.log"`,
        `: > "$JOB_DIR/daemon.log"`,
        `printf 'starting' > "$JOB_DIR/status"`,
        `decode_b64() {`,
        `  if command -v base64 >/dev/null 2>&1; then`,
        `    printf '%s' "$1" | base64 -d 2>/dev/null && return 0`,
        `    printf '%s' "$1" | base64 --decode 2>/dev/null && return 0`,
        `    printf '%s' "$1" | base64 -D 2>/dev/null && return 0`,
        `  fi`,
        `  return 1`,
        `}`,
        `decode_b64 ${shellSingleQuote(commandB64)} > "$JOB_DIR/cmd.sh" || { printf 'error: base64 decode failed' > "$JOB_DIR/status"; exit 1; }`,
        `WORKDIR_B64=${shellSingleQuote(workdirB64)}`,
        `MAX_RUNTIME_MS=${Math.max(0, Math.floor(maxRuntimeMs))}`,
        `setsid bash -c '`,
        `job_dir="$1"; workdir_b64="$2"; max_runtime_ms="$3"`,
        `decode_b64() {`,
        `  if command -v base64 >/dev/null 2>&1; then`,
        `    printf "%s" "$1" | base64 -d 2>/dev/null && return 0`,
        `    printf "%s" "$1" | base64 --decode 2>/dev/null && return 0`,
        `    printf "%s" "$1" | base64 -D 2>/dev/null && return 0`,
        `  fi`,
        `  return 1`,
        `}`,
        `# $$ is the setsid session leader: PID and PGID are identical.`,
        `printf "%s" "$$" > "$job_dir/runner.pid"`,
        `printf "%s" "$$" > "$job_dir/pgid"`,
        `workdir="$(decode_b64 "$workdir_b64")" || { printf "error: workdir decode failed" > "$job_dir/status"; exit 1; }`,
        `if ! cd "\${workdir:-$HOME}" 2>"$job_dir/stderr.log"; then printf "error: cannot enter workdir" > "$job_dir/status"; exit 1; fi`,
        `printf "running" > "$job_dir/status"`,
        `expired_file="$job_dir/expired"`,
        `on_term() { if [ -f "$expired_file" ]; then printf "expired" > "$job_dir/status"; else printf "cancelled" > "$job_dir/status"; fi; exit 143; }`,
        `trap on_term TERM INT`,
        `watchdog_pid=""`,
        `if [ "$max_runtime_ms" -gt 0 ] 2>/dev/null; then`,
        `  timeout_sec=$(( (max_runtime_ms + 999) / 1000 ))`,
        `  ( trap "" TERM INT; sleep "$timeout_sec"; touch "$expired_file"; kill -TERM -$$ 2>/dev/null; sleep 5; kill -KILL -$$ 2>/dev/null ) &`,
        `  watchdog_pid=$!`,
        `fi`,
        `bash "$job_dir/cmd.sh" > "$job_dir/stdout.log" 2> "$job_dir/stderr.log" &`,
        `cmd_pid=$!`,
        `wait "$cmd_pid"`,
        `exit_code=$?`,
        `if [ -n "$watchdog_pid" ]; then kill -KILL "$watchdog_pid" 2>/dev/null || true; fi`,
        `if [ -f "$expired_file" ]; then printf "expired" > "$job_dir/status"; else printf "%s" "$exit_code" > "$job_dir/status"; fi`,
        `exit "$exit_code"`,
        `' _ "$JOB_DIR" "$WORKDIR_B64" "$MAX_RUNTIME_MS" </dev/null >>"$JOB_DIR/daemon.log" 2>&1 &`,
        `# Wait for session leader to initialise so it survives parent shell exit`,
        `for _w in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15; do [ -f "$JOB_DIR/runner.pid" ] && [ -s "$JOB_DIR/runner.pid" ] && break; sleep 0.2; done`,
    ].join("\n") + "\n";
}
/**
 * Builds a bash script that inspects a persistent job: reads the status file,
 * measures stdout/stderr log lengths, and optionally reads a bounded content
 * chunk from each stream. Output is tab-delimited KEY\tVALUE lines so the Node
 * side can parse it without delimiter collision (base64 output contains no
 * tabs or newlines).
 */
export function buildPersistentJobInspectScript(options) {
    const jobId = options.jobId;
    const readMode = options.readMode;
    const soff = Math.max(0, Math.floor(options.stdoutOffset ?? 0));
    const eoff = Math.max(0, Math.floor(options.stderrOffset ?? 0));
    const tail = Math.max(0, Math.floor(options.tailChars ?? 0));
    const max = Math.max(0, Math.floor(options.maxChars));
    const include = options.includeContent ? 1 : 0;
    return [
        `JOB_ID=${shellSingleQuote(jobId)}`,
        `JOB_DIR="$HOME/.remote-mcp/jobs/$JOB_ID"`,
        `STATUS_FILE="$JOB_DIR/status"`,
        `[ -f "$STATUS_FILE" ] || { printf 'job status is unavailable: %s\\n' "$JOB_ID" >&2; exit 66; }`,
        `OUT="$JOB_DIR/stdout.log"`,
        `ERR="$JOB_DIR/stderr.log"`,
        `READ_MODE=${shellSingleQuote(readMode)}`,
        `SOFF=${soff}`,
        `EOFF=${eoff}`,
        `SOFF_SET=${options.stdoutOffset === undefined ? 0 : 1}`,
        `EOFF_SET=${options.stderrOffset === undefined ? 0 : 1}`,
        `TAIL=${tail}`,
        `MAX=${max}`,
        `INCLUDE=${include}`,
        `rc_off=0; rc_end=0; rc_b64=""`,
        `read_chunk() {`,
        `  local file="$1" req_off="$2" len="$3" offset_set="$4" off end b64="" window`,
        `  if [ "$TAIL" -gt 0 ] 2>/dev/null; then`,
        `    window=$TAIL; [ "$window" -gt "$MAX" ] && window=$MAX`,
        `    off=$((len - window)); [ "$off" -lt 0 ] && off=0`,
        `  elif [ "$offset_set" = "1" ]; then`,
        `    off=$req_off`,
        `  elif [ "$READ_MODE" = "full" ]; then`,
        `    off=0`,
        `  else`,
        `    off=$((len - MAX)); [ "$off" -lt 0 ] && off=0`,
        `  fi`,
        `  [ "$off" -gt "$len" ] 2>/dev/null && off=$len`,
        `  end=$((off + MAX)); [ "$end" -gt "$len" ] 2>/dev/null && end=$len`,
        `  if [ "$INCLUDE" = "1" ] && [ "$end" -gt "$off" ] 2>/dev/null; then`,
        `    b64=$(tail -c +$((off + 1)) "$file" 2>/dev/null | head -c $((end - off)) | base64 | tr -d '\\n')`,
        `  fi`,
        `  rc_off=$off; rc_end=$end; rc_b64=$b64`,
        `}`,
        `status_content=""; [ -f "$STATUS_FILE" ] && status_content=$(cat "$STATUS_FILE" 2>/dev/null)`,
        `out_len=0; [ -f "$OUT" ] && out_len=$(wc -c < "$OUT" 2>/dev/null || printf 0)`,
        `err_len=0; [ -f "$ERR" ] && err_len=$(wc -c < "$ERR" 2>/dev/null || printf 0)`,
        `read_chunk "$OUT" "$SOFF" "$out_len" "$SOFF_SET"`,
        `out_off=$rc_off; out_end=$rc_end; out_b64=$rc_b64`,
        `read_chunk "$ERR" "$EOFF" "$err_len" "$EOFF_SET"`,
        `err_off=$rc_off; err_end=$rc_end; err_b64=$rc_b64`,
        `printf 'STATUS\\t%s\\n' "$status_content"`,
        `printf 'STDOUT_LEN\\t%s\\n' "$out_len"`,
        `printf 'STDERR_LEN\\t%s\\n' "$err_len"`,
        `printf 'STDOUT_OFFSET\\t%s\\n' "$out_off"`,
        `printf 'STDOUT_NEXT\\t%s\\n' "$out_end"`,
        `printf 'STDOUT_B64\\t%s\\n' "$out_b64"`,
        `printf 'STDERR_OFFSET\\t%s\\n' "$err_off"`,
        `printf 'STDERR_NEXT\\t%s\\n' "$err_end"`,
        `printf 'STDERR_B64\\t%s\\n' "$err_b64"`,
    ].join("\n") + "\n";
}
/** Keep UTF-8 characters intact while retaining byte-based, caller-owned cursors. */
export function decodeJobPage(base64, offset, nextOffset, total, mayGrow) {
    const bytes = Buffer.from(base64, "base64");
    let start = 0;
    while (start < bytes.length && (bytes[start] & 0xc0) === 0x80)
        start += 1;
    let end = bytes.length;
    if (end > start && (nextOffset < total || mayGrow)) {
        let lead = end - 1;
        while (lead > start && (bytes[lead] & 0xc0) === 0x80)
            lead -= 1;
        const byte = bytes[lead];
        const width = byte >= 0xf0 && byte <= 0xf4 ? 4 : byte >= 0xe0 && byte <= 0xef ? 3 : byte >= 0xc2 && byte <= 0xdf ? 2 : 1;
        if (end - lead < width)
            end = lead;
    }
    return { text: bytes.subarray(start, end).toString("utf8"), offset: offset + start, nextOffset: offset + end };
}
export function parsePersistentJobInspect(raw) {
    const map = new Map();
    for (const line of raw.split("\n")) {
        const idx = line.indexOf("\t");
        if (idx < 0) {
            continue;
        }
        map.set(line.slice(0, idx), line.slice(idx + 1));
    }
    for (const key of ["STATUS", "STDOUT_LEN", "STDERR_LEN", "STDOUT_OFFSET", "STDOUT_NEXT", "STDOUT_B64", "STDERR_OFFSET", "STDERR_NEXT", "STDERR_B64"]) {
        if (!map.has(key))
            throw new Error(`Invalid job inspection response: missing ${key}. Remote state is unknown; do not restart the job blindly.`);
    }
    const num = (key) => {
        const raw = map.get(key);
        if (!raw) {
            return 0;
        }
        const value = Number.parseInt(raw, 10);
        return Number.isFinite(value) ? value : 0;
    };
    const statusContent = map.get("STATUS") ?? "";
    return {
        statusContent,
        stdoutLength: num("STDOUT_LEN"),
        stderrLength: num("STDERR_LEN"),
        stdoutOffset: num("STDOUT_OFFSET"),
        stdoutNextOffset: num("STDOUT_NEXT"),
        stdoutB64: map.get("STDOUT_B64") ?? "",
        stderrOffset: num("STDERR_OFFSET"),
        stderrNextOffset: num("STDERR_NEXT"),
        stderrB64: map.get("STDERR_B64") ?? "",
        state: inferPersistentJobState(statusContent),
    };
}
/**
 * Builds a bash script that cancels a persistent job by sending SIGTERM to
 * its process group. Prefers runner.pid (session leader written from inside
 * setsid) over the pgid file. Verifies the process is gone before claiming
 * success; does not mark cancelled if the kill target is still alive.
 */
export function buildPersistentJobCancelScript(jobId) {
    return [
        `JOB_ID=${shellSingleQuote(jobId)}`,
        `JOB_DIR="$HOME/.remote-mcp/jobs/$JOB_ID"`,
        `STATUS_FILE="$JOB_DIR/status"`,
        `PGID=""`,
        `# Prefer runner.pid: it is written by the setsid session leader as $$.`,
        `[ -f "$JOB_DIR/runner.pid" ] && PGID=$(tr -d ' \\t\\r\\n' < "$JOB_DIR/runner.pid" 2>/dev/null)`,
        `if [ -z "$PGID" ] && [ -f "$JOB_DIR/pgid" ]; then PGID=$(tr -d ' \\t\\r\\n' < "$JOB_DIR/pgid" 2>/dev/null); fi`,
        `cur=$(cat "$STATUS_FILE" 2>/dev/null || true)`,
        `case "$cur" in`,
        `  cancelled|expired|error:*) printf 'already_dead\\t%s\\n' "$PGID"; exit 0 ;;`,
        `esac`,
        `case "$cur" in`,
        `  ""|*[!0-9-]*) ;;`,
        `  *) printf 'already_dead\\t%s\\n' "$PGID"; exit 0 ;;`,
        `esac`,
        `alive() { kill -0 "$1" 2>/dev/null || kill -0 -"$1" 2>/dev/null; }`,
        `if [ -z "$PGID" ]; then`,
        `  printf 'cancel_unconfirmed: runner PID is unavailable\\n' >&2`,
        `  exit 1`,
        `fi`,
        `case "$PGID" in *[!0-9]*) printf 'cancel_unconfirmed: invalid PID\\n' >&2; exit 1 ;; esac`,
        `[ "$PGID" -gt 1 ] || { printf 'cancel_unconfirmed: unsafe PID\\n' >&2; exit 1; }`,
        `if ! alive "$PGID"; then`,
        `  # Already dead — do not overwrite a real exit code with cancelled.`,
        `  if [ -f "$STATUS_FILE" ]; then`,
        `    cur=$(cat "$STATUS_FILE" 2>/dev/null || true)`,
        `    case "$cur" in`,
        `      running|starting) printf 'cancelled' > "$STATUS_FILE" 2>/dev/null || true ;;`,
        `    esac`,
        `  fi`,
        `  printf 'already_dead\\t%s\\n' "$PGID"`,
        `  exit 0`,
        `fi`,
        `kill -TERM -"$PGID" 2>/dev/null || kill -TERM "$PGID" 2>/dev/null || true`,
        `for _i in 1 2 3 4 5 6 7 8 9 10; do`,
        `  alive "$PGID" || break`,
        `  sleep 0.2`,
        `done`,
        `if alive "$PGID"; then`,
        `  kill -KILL -"$PGID" 2>/dev/null || kill -KILL "$PGID" 2>/dev/null || true`,
        `  sleep 0.5`,
        `fi`,
        `if alive "$PGID"; then`,
        `  printf 'cancel_failed\\t%s\\n' "$PGID"`,
        `  exit 1`,
        `fi`,
        `printf 'cancelled' > "$STATUS_FILE" 2>/dev/null || true`,
        `printf 'cancelled\\t%s\\n' "$PGID"`,
        `exit 0`,
    ].join("\n") + "\n";
}
//# sourceMappingURL=persistentJobs.js.map