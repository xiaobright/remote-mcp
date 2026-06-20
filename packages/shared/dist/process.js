import { spawn } from "node:child_process";
import { homedir } from "node:os";
export function windowsSafeEnv(extra) {
    const home = homedir();
    return {
        ...process.env,
        ...extra,
        HOME: process.env.HOME || extra?.HOME || home,
        USERPROFILE: process.env.USERPROFILE || extra?.USERPROFILE || home,
        ProgramData: process.env.ProgramData || extra?.ProgramData || "C:\\ProgramData",
        SystemRoot: process.env.SystemRoot || process.env.SYSTEMROOT || extra?.SystemRoot || extra?.SYSTEMROOT || "C:\\Windows",
        WINDIR: process.env.WINDIR || process.env.SystemRoot || process.env.SYSTEMROOT || extra?.WINDIR || "C:\\Windows",
    };
}
export function windowsHiddenSpawnOptions(extra) {
    return {
        ...extra,
        env: windowsSafeEnv(extra?.env),
        windowsHide: true,
    };
}
export async function runProcessWithInput(command, args, input, timeoutMs, options) {
    return new Promise((resolve, reject) => {
        const child = spawn(command, args, windowsHiddenSpawnOptions(options));
        const stdout = [];
        let stderr = "";
        let settled = false;
        let timedOut = false;
        const timer = setTimeout(() => {
            timedOut = true;
            child.kill();
        }, timeoutMs);
        timer.unref();
        child.stdout?.on("data", (chunk) => stdout.push(chunk));
        child.stderr?.on("data", (chunk) => { stderr += chunk.toString(); });
        child.on("error", (error) => {
            if (settled) {
                return;
            }
            settled = true;
            clearTimeout(timer);
            reject(error);
        });
        child.on("close", (code) => {
            if (settled) {
                return;
            }
            settled = true;
            clearTimeout(timer);
            resolve({
                stdout: Buffer.concat(stdout),
                stderr,
                exitCode: timedOut ? -1 : code ?? -1,
                timedOut,
            });
        });
        child.stdin?.end(input);
    });
}
//# sourceMappingURL=process.js.map