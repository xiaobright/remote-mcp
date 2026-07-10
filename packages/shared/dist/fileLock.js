import { closeSync, mkdirSync, openSync, statSync, unlinkSync, writeFileSync, } from "node:fs";
import { dirname } from "node:path";
function nowIso() {
    return new Date().toISOString();
}
function readPositiveIntEnv(name, fallback) {
    const value = Number.parseInt(process.env[name] ?? "", 10);
    return Number.isFinite(value) && value > 0 ? value : fallback;
}
const DEFAULT_LOCK_WAIT_MS = readPositiveIntEnv("REMOTE_MCP_FILE_LOCK_WAIT_MS", 5000);
const DEFAULT_LOCK_STALE_MS = readPositiveIntEnv("REMOTE_MCP_FILE_LOCK_STALE_MS", 30000);
function sleepSync(ms) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}
/**
 * Exclusive file lock via O_EXCL lockfile. Used for local JSON stores that may
 * be touched by multiple MCP processes.
 */
export function withFileLock(targetPath, fn, options = {}) {
    mkdirSync(dirname(targetPath), { recursive: true });
    const lockPath = `${targetPath}.lock`;
    const waitMs = options.waitMs ?? DEFAULT_LOCK_WAIT_MS;
    const staleMs = options.staleMs ?? DEFAULT_LOCK_STALE_MS;
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
                if (Date.now() - stat.mtimeMs > staleMs) {
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
            if (Date.now() - started > waitMs) {
                throw new Error(`Timed out waiting for file lock: ${lockPath}`);
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
//# sourceMappingURL=fileLock.js.map