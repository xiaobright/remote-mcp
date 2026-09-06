function parseFilePath(line, prefix) {
    const path = line.slice(prefix.length).trim();
    if (!path) {
        throw new Error(`Missing path in patch line: ${line}`);
    }
    return path;
}
function hasEdits(lines) {
    return lines.some((line) => line.op === "add" || line.op === "remove");
}
function pushHunk(hunks, lines, path, patchLine) {
    if (lines.length === 0) {
        return;
    }
    if (!hasEdits(lines)) {
        throw new Error(`Update File hunk for ${path} starting at patch line ${patchLine ?? "(unknown)"} has no additions or removals. If you meant to add or remove lines, prefix them with '+' or '-'.`);
    }
    hunks.push({ lines, patchLine });
}
export function parsePatch(input) {
    const lines = input.replace(/\r\n/g, "\n").split("\n");
    const operations = [];
    const normalizations = [];
    let index = 0;
    if (lines[index] === "*** Begin Patch") {
        index++;
    }
    while (index < lines.length) {
        const line = lines[index];
        if (!line || line === "*** End Patch") {
            index++;
            continue;
        }
        if (line.startsWith("*** Delete File:")) {
            throw new Error("Delete File patches are intentionally not supported by remote apply_patch tools.");
        }
        if (line.startsWith("*** Add File:")) {
            const path = parseFilePath(line, "*** Add File:");
            index++;
            const addLines = [];
            while (index < lines.length && !lines[index].startsWith("*** ")) {
                const current = lines[index];
                if (!current.startsWith("+")) {
                    throw new Error(`Add File lines must start with '+': ${current}`);
                }
                addLines.push(current.slice(1));
                index++;
            }
            operations.push({ kind: "add", path, lines: addLines });
            continue;
        }
        if (line.startsWith("*** Update File:")) {
            const path = parseFilePath(line, "*** Update File:");
            index++;
            const hunks = [];
            let current = [];
            let currentPatchLine;
            const directive = `Update File: ${path}`;
            while (index < lines.length && !lines[index].startsWith("*** ")) {
                const currentLine = lines[index];
                const patchLine = index + 1;
                if (/^@@ -\d+(,\d+)? \+\d+(,\d+)? @@/.test(currentLine.trim())) {
                    throw new Error(`Unified diff hunk header "${currentLine}" is not supported. Use a bare @@ as the hunk separator; line counts are not needed.`);
                }
                if (/^(--- |\+\+\+ |diff --git )/.test(currentLine)) {
                    throw new Error(`Unified diff file header "${currentLine}" is not supported. This tool uses the Codex patch format: `
                        + `*** Begin Patch / *** Update File: <path> / @@ / lines prefixed with ' ' (context), '+' (added) or '-' (removed) / *** End Patch. `
                        + `Remove the ---/+++/diff headers and mark every hunk line. `
                        + `(If a line you are removing genuinely starts with "--", include more surrounding context lines and use the edit tool instead.)`);
                }
                if (currentLine.startsWith("@@")) {
                    pushHunk(hunks, current, path, currentPatchLine);
                    current = [];
                    currentPatchLine = undefined;
                    index++;
                    continue;
                }
                if (currentLine === "*** End of File") {
                    index++;
                    continue;
                }
                currentPatchLine ??= patchLine;
                const marker = currentLine[0];
                if (marker === " ") {
                    current.push({ op: "context", text: currentLine.slice(1) });
                }
                else if (marker === "+") {
                    current.push({ op: "add", text: currentLine.slice(1) });
                }
                else if (marker === "-") {
                    current.push({ op: "remove", text: currentLine.slice(1) });
                }
                else if (currentLine.length === 0) {
                    normalizations.push({
                        patchLine,
                        path,
                        directive,
                        assumed: "context",
                        reason: "empty-line",
                        text: "",
                    });
                    current.push({ op: "context", text: "" });
                }
                else {
                    normalizations.push({
                        patchLine,
                        path,
                        directive,
                        assumed: "context",
                        reason: "missing-marker",
                        text: currentLine,
                    });
                    current.push({ op: "context", text: currentLine });
                }
                index++;
            }
            pushHunk(hunks, current, path, currentPatchLine);
            if (hunks.length === 0) {
                throw new Error(`Update File patch has no hunks: ${path}`);
            }
            operations.push({ kind: "update", path, hunks });
            continue;
        }
        throw new Error(`Unsupported patch directive: ${line}`);
    }
    if (operations.length === 0) {
        throw new Error("Patch contains no supported file operations.");
    }
    return { operations, normalizations };
}
function splitText(text) {
    const normalized = text.replace(/\r\n/g, "\n");
    if (normalized.length === 0) {
        return { lines: [], trailingNewline: false };
    }
    const trailingNewline = normalized.endsWith("\n");
    const body = trailingNewline ? normalized.slice(0, -1) : normalized;
    return { lines: body.length ? body.split("\n") : [], trailingNewline };
}
function joinText(lines, trailingNewline) {
    const body = lines.join("\n");
    return trailingNewline && (body.length > 0 || lines.length === 0) ? `${body}\n` : body;
}
function findSubsequence(haystack, needle, fromIndex) {
    if (needle.length === 0) {
        return fromIndex;
    }
    for (let index = fromIndex; index <= haystack.length - needle.length; index++) {
        let matched = true;
        for (let inner = 0; inner < needle.length; inner++) {
            if (haystack[index + inner] !== needle[inner]) {
                matched = false;
                break;
            }
        }
        if (matched) {
            return index;
        }
    }
    return -1;
}
function countSubsequenceMatches(haystack, needle, fromIndex, limit = 2) {
    if (needle.length === 0) {
        return Math.min(limit, Math.max(0, haystack.length - fromIndex + 1));
    }
    let matches = 0;
    let index = fromIndex;
    while (index <= haystack.length - needle.length) {
        const foundAt = findSubsequence(haystack, needle, index);
        if (foundAt < 0) {
            break;
        }
        matches += 1;
        if (matches >= limit) {
            return matches;
        }
        index = foundAt + 1;
    }
    return matches;
}
export function applyUpdatePatch(original, hunks, path) {
    const split = splitText(original);
    let lines = split.lines;
    let searchIndex = 0;
    let added = 0;
    let removed = 0;
    const warnings = [];
    for (const [hunkIndex, hunk] of hunks.entries()) {
        const oldLines = hunk.lines
            .filter((line) => line.op === "context" || line.op === "remove")
            .map((line) => line.text);
        const newLines = hunk.lines
            .filter((line) => line.op === "context" || line.op === "add")
            .map((line) => line.text);
        if (oldLines.length === 0) {
            warnings.push({
                kind: "empty-old-block",
                path,
                hunk: hunkIndex + 1,
                patchLine: hunk.patchLine,
                message: `Patch hunk ${hunkIndex + 1} for ${path} has no context or removed lines; insertion uses the current search position.`,
            });
        }
        else if (countSubsequenceMatches(lines, oldLines, searchIndex, 2) > 1) {
            warnings.push({
                kind: "ambiguous-match",
                path,
                hunk: hunkIndex + 1,
                patchLine: hunk.patchLine,
                message: `Patch hunk ${hunkIndex + 1} for ${path} matched more than one location; the first match after the current search position was used.`,
                matches: 2,
                firstOldLine: oldLines[0],
            });
        }
        const foundAt = findSubsequence(lines, oldLines, searchIndex);
        if (foundAt < 0) {
            throw new Error(`Patch hunk did not match ${path}. First old line: ${oldLines[0] ?? "(empty insertion)"}`);
        }
        lines = [
            ...lines.slice(0, foundAt),
            ...newLines,
            ...lines.slice(foundAt + oldLines.length),
        ];
        searchIndex = foundAt + newLines.length;
        added += hunk.lines.filter((line) => line.op === "add").length;
        removed += hunk.lines.filter((line) => line.op === "remove").length;
    }
    return {
        text: joinText(lines, split.trailingNewline),
        added,
        removed,
        warnings,
    };
}
export function textForAddedFile(lines) {
    return lines.length > 0 ? `${lines.join("\n")}\n` : "";
}
//# sourceMappingURL=patch.js.map