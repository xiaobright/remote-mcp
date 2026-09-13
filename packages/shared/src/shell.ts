import { randomBytes } from "node:crypto";

export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export function randomSuffix(): string {
  return randomBytes(8).toString("hex");
}

export function heredoc(tag: string, body: string): string {
  return `<<'${tag}'\n${body}\n${tag}`;
}

export function joinRemotePath(root: string | undefined, path: string): string {
  if (!root || path.startsWith("/")) {
    return path;
  }

  return `${root.replace(/\/+$/, "")}/${path.replace(/^\/+/, "")}`;
}

export function dirnameScript(pathVar: string, outVar: string): string {
  // ${path%/*} yields empty for root-level paths like /foo; treat that as /.
  return [
    `${outVar}=\${${pathVar}%/*}`,
    `if [ "$${outVar}" = "$${pathVar}" ]; then ${outVar}=.`,
    `elif [ -z "$${outVar}" ]; then ${outVar}=/`,
    `fi`,
  ].join("\n");
}

export function validateShell(shell: string): string {
  const trimmed = shell.trim();
  if (!trimmed) {
    throw new Error("shell cannot be empty");
  }
  if (!/^[A-Za-z0-9_./+-]+$/.test(trimmed)) {
    throw new Error(`Unsafe shell value: ${shell}`);
  }
  return trimmed;
}

export function shellStdinArgs(shellInput = "bash", login = true): string[] {
  const shell = validateShell(shellInput);
  const base = shell.split(/[\\/]/).pop();
  return login && (base === "bash" || base === "zsh") ? [shell, "-l", "-s"] : [shell, "-s"];
}

export function validateEnvName(name: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
    throw new Error(`Unsafe environment variable name: ${name}`);
  }
  return name;
}

export function buildEnvPreamble(env?: Record<string, string>): string {
  const lines: string[] = [];
  for (const [name, value] of Object.entries(env ?? {})) {
    lines.push(`export ${validateEnvName(name)}=${shellQuote(String(value))}`);
  }
  return lines.length ? `${lines.join("\n")}\n` : "";
}

export function buildWorkdirPreamble(workdir?: string): string {
  return workdir ? `cd -- ${shellQuote(workdir)} || exit $?\n` : "";
}
