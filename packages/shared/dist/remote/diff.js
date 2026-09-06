const DEFAULT_CONTEXT = 3;
const DEFAULT_MAX_DIFF_LINES = 400;
const LCS_CELL_CAP = 4_000_000;
const LCS_SIDE_CAP = 2000;
function splitLines(text) {
    const normalized = text.replace(/\r\n/g, "\n");
    if (normalized.length === 0) {
        return [];
    }
    const body = normalized.endsWith("\n") ? normalized.slice(0, -1) : normalized;
    return body.length ? body.split("\n") : [];
}
function lcsOps(a, b) {
    const rows = a.length + 1;
    const cols = b.length + 1;
    const table = new Uint32Array(rows * cols);
    for (let i = a.length - 1; i >= 0; i--) {
        for (let j = b.length - 1; j >= 0; j--) {
            table[i * cols + j] = a[i] === b[j]
                ? table[(i + 1) * cols + j + 1] + 1
                : Math.max(table[(i + 1) * cols + j], table[i * cols + j + 1]);
        }
    }
    const ops = [];
    let i = 0;
    let j = 0;
    while (i < a.length && j < b.length) {
        if (a[i] === b[j]) {
            ops.push({ type: "same", text: a[i], oldNo: i + 1, newNo: j + 1 });
            i++;
            j++;
        }
        else if (table[(i + 1) * cols + j] >= table[i * cols + j + 1]) {
            ops.push({ type: "del", text: a[i], oldNo: i + 1 });
            i++;
        }
        else {
            ops.push({ type: "add", text: b[j], newNo: j + 1 });
            j++;
        }
    }
    while (i < a.length) {
        ops.push({ type: "del", text: a[i], oldNo: i + 1 });
        i++;
    }
    while (j < b.length) {
        ops.push({ type: "add", text: b[j], newNo: j + 1 });
        j++;
    }
    return ops;
}
/** Fallback when the changed middle is too large for an LCS table: replace the whole block. */
function blockOps(a, b, oldBase, newBase) {
    const ops = [];
    a.forEach((line, index) => ops.push({ type: "del", text: line, oldNo: oldBase + index + 1 }));
    b.forEach((line, index) => ops.push({ type: "add", text: line, newNo: newBase + index + 1 }));
    return ops;
}
function hunkHeader(ops, from, to) {
    let oldStart = 0;
    let oldCount = 0;
    let newStart = 0;
    let newCount = 0;
    for (let index = from; index < to; index++) {
        const op = ops[index];
        if (op.oldNo !== undefined) {
            if (oldCount === 0) {
                oldStart = op.oldNo;
            }
            oldCount++;
        }
        if (op.newNo !== undefined) {
            if (newCount === 0) {
                newStart = op.newNo;
            }
            newCount++;
        }
    }
    // Pure insertion/deletion: anchor the zero side at the neighbouring line (0 at file start).
    if (oldCount === 0) {
        for (let index = from - 1; index >= 0; index--) {
            if (ops[index].oldNo !== undefined) {
                oldStart = ops[index].oldNo;
                break;
            }
        }
    }
    if (newCount === 0) {
        for (let index = from - 1; index >= 0; index--) {
            if (ops[index].newNo !== undefined) {
                newStart = ops[index].newNo;
                break;
            }
        }
    }
    return `@@ -${oldStart},${oldCount} +${newStart},${newCount} @@`;
}
function formatOp(op) {
    if (op.type === "add") {
        return `+${op.text}`;
    }
    if (op.type === "del") {
        return `-${op.text}`;
    }
    return ` ${op.text}`;
}
/** "a/<path>" prefix for relative paths; absolute paths stay bare so headers never show "a//...". */
function fileHeaders(path) {
    if (path.startsWith("/")) {
        return [`--- ${path}`, `+++ ${path}`];
    }
    return [`--- a/${path}`, `+++ b/${path}`];
}
export function unifiedDiff(originalText, modifiedText, path, options = {}) {
    const context = options.context ?? DEFAULT_CONTEXT;
    const maxLines = options.maxLines ?? DEFAULT_MAX_DIFF_LINES;
    const a = splitLines(originalText);
    const b = splitLines(modifiedText);
    let prefix = 0;
    while (prefix < a.length && prefix < b.length && a[prefix] === b[prefix]) {
        prefix++;
    }
    let suffix = 0;
    while (suffix < a.length - prefix &&
        suffix < b.length - prefix &&
        a[a.length - 1 - suffix] === b[b.length - 1 - suffix]) {
        suffix++;
    }
    const aMid = a.slice(prefix, a.length - suffix);
    const bMid = b.slice(prefix, b.length - suffix);
    if (aMid.length === 0 && bMid.length === 0) {
        return { diff: "", added: 0, removed: 0, truncated: false };
    }
    const useLcs = aMid.length > 0 &&
        bMid.length > 0 &&
        aMid.length <= LCS_SIDE_CAP &&
        bMid.length <= LCS_SIDE_CAP &&
        aMid.length * bMid.length <= LCS_CELL_CAP;
    const midOps = useLcs ? lcsOps(aMid, bMid) : blockOps(aMid, bMid, prefix, prefix);
    const ops = [];
    for (let index = 0; index < prefix; index++) {
        ops.push({ type: "same", text: a[index], oldNo: index + 1, newNo: index + 1 });
    }
    ops.push(...midOps);
    for (let index = 0; index < suffix; index++) {
        ops.push({
            type: "same",
            text: a[a.length - suffix + index],
            oldNo: a.length - suffix + index + 1,
            newNo: b.length - suffix + index + 1,
        });
    }
    const added = ops.filter((op) => op.type === "add").length;
    const removed = ops.filter((op) => op.type === "del").length;
    const changed = [];
    ops.forEach((op, index) => {
        if (op.type !== "same") {
            changed.push(index);
        }
    });
    const lines = fileHeaders(path);
    let truncated = false;
    let clusterStart = 0;
    while (clusterStart < changed.length) {
        let clusterEnd = clusterStart;
        while (clusterEnd + 1 < changed.length && changed[clusterEnd + 1] - changed[clusterEnd] <= 2 * context + 1) {
            clusterEnd++;
        }
        const from = Math.max(0, changed[clusterStart] - context);
        const to = Math.min(ops.length, changed[clusterEnd] + context + 1);
        const bodySize = to - from;
        if (lines.length + bodySize + 1 > maxLines) {
            // Emit a truncated first hunk when nothing fits otherwise, so the model still sees something.
            const budget = maxLines - lines.length - 1;
            truncated = true;
            if (budget >= 3) {
                const take = Math.min(bodySize, budget);
                lines.push(hunkHeader(ops, from, from + take));
                for (let cursor = from; cursor < from + take; cursor++) {
                    lines.push(formatOp(ops[cursor]));
                }
            }
            break;
        }
        lines.push(hunkHeader(ops, from, to));
        for (let cursor = from; cursor < to; cursor++) {
            lines.push(formatOp(ops[cursor]));
        }
        clusterStart = clusterEnd + 1;
    }
    return { diff: lines.join("\n"), added, removed, truncated };
}
//# sourceMappingURL=diff.js.map