import { spawn, type SpawnOptions, type SpawnOptionsWithoutStdio } from "node:child_process";
import { homedir } from "node:os";

export interface ProcessRunResult {
  stdout: Buffer;
  stderr: string;
  exitCode: number;
  timedOut: boolean;
}

export function windowsSafeEnv(extra?: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
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

export function windowsHiddenSpawnOptions(extra?: SpawnOptions): SpawnOptions {
  return {
    ...extra,
    env: windowsSafeEnv(extra?.env),
    windowsHide: true,
  };
}

export async function runProcessWithInput(
  command: string,
  args: string[],
  input: string,
  timeoutMs: number,
  options?: SpawnOptionsWithoutStdio,
): Promise<ProcessRunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, windowsHiddenSpawnOptions(options));
    const stdout: Buffer[] = [];
    let stderr = "";
    let settled = false;
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs);
    timer.unref();

    child.stdout?.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr?.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
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
