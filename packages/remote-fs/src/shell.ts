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
  return `${outVar}=\${${pathVar}%/*}\nif [ "$${outVar}" = "$${pathVar}" ]; then ${outVar}=.; fi`;
}

