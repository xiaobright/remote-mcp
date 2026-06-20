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
    return `${outVar}=\${${pathVar}%/*}\nif [ "$${outVar}" = "$${pathVar}" ]; then ${outVar}=.; fi`;
}
//# sourceMappingURL=shell.js.map