import { closeSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync, } from "node:fs";
import { dirname, resolve } from "node:path";
function nowIso() {
    return new Date().toISOString();
}
function readPositiveIntEnv(name, fallback) {
    const value = Number.parseInt(process.env[name] ?? "", 10);
    return Number.isFinite(value) && value > 0 ? value : fallback;
}
const STORE_LOCK_WAIT_MS = readPositiveIntEnv("REMOTE_MCP_PERSISTENT_JOB_STORE_LOCK_WAIT_MS", 5000);
const STORE_LOCK_STALE_MS = readPositiveIntEnv("REMOTE_MCP_PERSISTENT_JOB_STORE_LOCK_STALE_MS", 30000);
function sleepSync(ms) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}
function withPersistentJobStoreLock(storePath, fn) {
    mkdirSync(dirname(storePath), { recursive: true });
    const lockPath = `${storePath}.lock`;
    const started = Date.now();
    let fd = null;
    while (fd === null) {
        try {
            fd = openSync(lockPath, "wx");
            writeFileSync(fd, `${process.pid}\n${nowIso()}\n`, "utf8");
        }
        catch (error) {
            const code = error.code;
            if (code !== "EEXIST") {
                throw error;
            }
            try {
                const stat = statSync(lockPath);
                if (Date.now() - stat.mtimeMs > STORE_LOCK_STALE_MS) {
                    unlinkSync(lockPath);
                    continue;
                }
            }
            catch (statError) {
                const statCode = statError.code;
                if (statCode !== "ENOENT") {
                    throw statError;
                }
            }
            if (Date.now() - started > STORE_LOCK_WAIT_MS) {
                throw new Error(`Timed out waiting for persistent job store lock: ${lockPath}`);
            }
            sleepSync(50);
        }
    }
    try {
        return fn();
    }
    finally {
        closeSync(fd);
        try {
            unlinkSync(lockPath);
        }
        catch (error) {
            const code = error.code;
            if (code !== "ENOENT") {
                throw error;
            }
        }
    }
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
    return resolve(moduleDir, "..", "..", "..", "work", "persistent-jobs.json");
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
 *   pgid          PID reported by the spawning shell ($!)
 *
 * The spawning shell returns immediately after launching setsid, so the
 * caller (wsl.exe / ssh) does not stay attached.
 */
export function buildPersistentJobRunnerScript(options) {
    const { jobId, commandB64, workdirB64, maxRuntimeMs } = options;
    return [
        `JOB_ID=${shellSingleQuote(jobId)}`,
        `JOB_DIR="$HOME/.remote-mcp/jobs/$JOB_ID"`,
        `mkdir -p "$JOB_DIR"`,
        `: > "$JOB_DIR/stdout.log"`,
        `: > "$JOB_DIR/stderr.log"`,
        `: > "$JOB_DIR/daemon.log"`,
        `printf 'running' > "$JOB_DIR/status"`,
        `printf '%s' ${shellSingleQuote(commandB64)} | base64 -d > "$JOB_DIR/cmd.sh"`,
        `WORKDIR_B64=${shellSingleQuote(workdirB64)}`,
        `MAX_RUNTIME_MS=${Math.max(0, Math.floor(maxRuntimeMs))}`,
        `setsid bash -c '`,
        `job_dir="$1"; workdir_b64="$2"; max_runtime_ms="$3"`,
        `workdir="$(printf "%s" "$workdir_b64" | base64 -d)"`,
        `if [ -n "$workdir" ]; then cd "$workdir" 2>/dev/null || cd "$HOME"; else cd "$HOME"; fi`,
        `printf "%s" "$$" > "$job_dir/runner.pid"`,
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
        `printf "%s" "$!" > "$JOB_DIR/pgid"`,
        `# Wait for setsid child to initialise so it survives parent shell exit`,
        `for _w in 1 2 3 4 5 6 7 8 9 10; do [ -f "$JOB_DIR/runner.pid" ] && break; sleep 0.2; done`,
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
        `OUT="$JOB_DIR/stdout.log"`,
        `ERR="$JOB_DIR/stderr.log"`,
        `READ_MODE=${shellSingleQuote(readMode)}`,
        `SOFF=${soff}`,
        `EOFF=${eoff}`,
        `TAIL=${tail}`,
        `MAX=${max}`,
        `INCLUDE=${include}`,
        `rc_off=0; rc_end=0; rc_b64=""`,
        `read_chunk() {`,
        `  local file="$1" req_off="$2" len="$3" off end b64=""`,
        `  if [ "$TAIL" -gt 0 ] 2>/dev/null; then`,
        `    off=$((len - TAIL)); [ "$off" -lt 0 ] && off=0`,
        `  elif [ "$req_off" -gt 0 ] 2>/dev/null; then`,
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
        `read_chunk "$OUT" "$SOFF" "$out_len"`,
        `out_off=$rc_off; out_end=$rc_end; out_b64=$rc_b64`,
        `read_chunk "$ERR" "$EOFF" "$err_len"`,
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
export function parsePersistentJobInspect(raw) {
    const map = new Map();
    for (const line of raw.split("\n")) {
        const idx = line.indexOf("\t");
        if (idx < 0) {
            continue;
        }
        map.set(line.slice(0, idx), line.slice(idx + 1));
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
 * its process group. Prefers the pgid file, falling back to runner.pid (which
 * equals the PGID for a setsid session leader).
 */
export function buildPersistentJobCancelScript(jobId) {
    return [
        `JOB_ID=${shellSingleQuote(jobId)}`,
        `JOB_DIR="$HOME/.remote-mcp/jobs/$JOB_ID"`,
        `PGID=""`,
        `[ -f "$JOB_DIR/pgid" ] && PGID=$(cat "$JOB_DIR/pgid" 2>/dev/null)`,
        `if [ -z "$PGID" ] && [ -f "$JOB_DIR/runner.pid" ]; then PGID=$(cat "$JOB_DIR/runner.pid" 2>/dev/null); fi`,
        `if [ -n "$PGID" ]; then`,
        `  kill -TERM -"$PGID" 2>/dev/null || kill -TERM "$PGID" 2>/dev/null || true`,
        `  sleep 2`,
        `  kill -KILL -"$PGID" 2>/dev/null || kill -KILL "$PGID" 2>/dev/null || true`,
        `  printf 'cancelled' > "$JOB_DIR/status" 2>/dev/null || true`,
        `  printf 'cancelled\\t%s\\n' "$PGID"`,
        `else`,
        `  printf 'cancelled' > "$JOB_DIR/status" 2>/dev/null || true`,
        `  printf 'cancelled\\tnone\\n'`,
        `fi`,
    ].join("\n") + "\n";
}
//# sourceMappingURL=persistentJobs.js.map