import { randomBytes } from "node:crypto";
export function shellQuote(value) {
    return `'${value.replace(/'/g, `'\\''`)}'`;
}
export function randomSuffix() {
    return randomBytes(8).toString("hex");
}
export function heredoc(tag, body) {
    return `<<'${tag}'\n${body}\n${tag}`;
}
export function joinRemotePath(root, path) {
    if (!root || path.startsWith("/")) {
        return path;
    }
    return `${root.replace(/\/+$/, "")}/${path.replace(/^\/+/, "")}`;
}
export function dirnameScript(pathVar, outVar) {
    // ${path%/*} yields empty for root-level paths like /foo; treat that as /.
    return [
        `${outVar}=\${${pathVar}%/*}`,
        `if [ "$${outVar}" = "$${pathVar}" ]; then ${outVar}=.`,
        `elif [ -z "$${outVar}" ]; then ${outVar}=/`,
        `fi`,
    ].join("\n");
}
export function validateShell(shell) {
    const trimmed = shell.trim();
    if (!trimmed) {
        throw new Error("shell cannot be empty");
    }
    if (!/^[A-Za-z0-9_./+-]+$/.test(trimmed)) {
        throw new Error(`Unsafe shell value: ${shell}`);
    }
    return trimmed;
}
export function validateEnvName(name) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
        throw new Error(`Unsafe environment variable name: ${name}`);
    }
    return name;
}
export function buildEnvPreamble(env) {
    const lines = [];
    for (const [name, value] of Object.entries(env ?? {})) {
        lines.push(`export ${validateEnvName(name)}=${shellQuote(String(value))}`);
    }
    return lines.length ? `${lines.join("\n")}\n` : "";
}
export function buildWorkdirPreamble(workdir) {
    return workdir ? `cd -- ${shellQuote(workdir)}\n` : "";
}
//# sourceMappingURL=shell.js.map