import { readPositiveIntEnv } from "../env.js";
import { runProcessWithInput } from "../process.js";

export type TransportKind = "wsl" | "ssh";

export interface RemoteTarget {
  transport: TransportKind;
  target?: string;
  distro?: string;
  ssh_options?: string[];
  timeout_ms?: number;
}

export interface RemoteRunResult {
  stdout: Buffer;
  stderr: string;
  exitCode: number;
  timedOut: boolean;
}

const DEFAULT_TIMEOUT_MS = readPositiveIntEnv("REMOTE_MCP_DEFAULT_TIMEOUT_MS", 120000);
const SSH_COMMAND = process.env.REMOTE_MCP_SSH_COMMAND?.trim() || process.env.SSH_MCP_COMMAND?.trim() || "ssh";
const WSL_COMMAND = process.env.REMOTE_MCP_WSL_COMMAND?.trim() || "wsl.exe";
const DEFAULT_SSH_TARGET = process.env.REMOTE_MCP_DEFAULT_SSH_TARGET?.trim()
  || process.env.SSH_MCP_DEFAULT_TARGET?.trim();
const DEFAULT_WSL_DISTRO = process.env.REMOTE_MCP_DEFAULT_WSL_DISTRO?.trim();

function wslArgs(target: RemoteTarget): string[] {
  const distro = target.distro ?? DEFAULT_WSL_DISTRO;
  return distro ? ["-d", distro, "--", "sh", "-s"] : ["--", "sh", "-s"];
}

function sshArgs(target: RemoteTarget): string[] {
  const resolvedTarget = target.target ?? DEFAULT_SSH_TARGET;
  if (!resolvedTarget) {
    throw new Error("SSH target is required. Pass target or set REMOTE_MCP_DEFAULT_SSH_TARGET.");
  }

  const defaultOptions = [
    "-o", "BatchMode=yes",
    "-o", "StrictHostKeyChecking=accept-new",
    "-o", `ConnectTimeout=${process.env.REMOTE_MCP_SSH_CONNECT_TIMEOUT_SEC?.trim() || "10"}`,
  ];
  return [...defaultOptions, ...(target.ssh_options ?? []), "--", resolvedTarget, "sh", "-s"];
}

export async function runRemoteScript(target: RemoteTarget, script: string): Promise<RemoteRunResult> {
  const command = target.transport === "wsl" ? WSL_COMMAND : SSH_COMMAND;
  const args = target.transport === "wsl" ? wslArgs(target) : sshArgs(target);
  return runProcessWithInput(command, args, script, target.timeout_ms ?? DEFAULT_TIMEOUT_MS);
}
