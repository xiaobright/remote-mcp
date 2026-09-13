import { z } from "zod";
import { errorResponse, rejectUnexpectedParams, requireStringParam, } from "../mcp.js";
import { joinRemotePath } from "../shell.js";
import { applyTextEdit } from "./edit.js";
import { unifiedDiff } from "./diff.js";
import { applyUpdatePatch, parsePatch, textForAddedFile, } from "./patch.js";
import { encodeRemoteText, readTextFileDecoded, searchText, sha256Bytes, statPath, writeTextFile, } from "./remoteOps.js";
const DEFAULT_MAX_BYTES = 5 * 1024 * 1024;
const rootField = z.string()
    .optional()
    .describe("Optional remote root joined with relative paths before execution.");
const pathField = z.string()
    .min(1)
    .describe("Remote path. Relative paths are joined with root when root is set.");
const encodingField = z.string()
    .optional()
    .describe('Text encoding, default "auto" (utf-8/gbk/gb18030).');
function resolvePath(root, path) {
    const resolved = joinRemotePath(typeof root === "string" ? root : undefined, path);
    if (!resolved.trim()) {
        throw new Error("path is required");
    }
    return resolved;
}
function maxBytes(params) {
    return typeof params.max_bytes === "number" ? params.max_bytes : DEFAULT_MAX_BYTES;
}
function encoding(params) {
    return typeof params.encoding === "string" ? params.encoding : undefined;
}
function requestedEncoding(params) {
    return encoding(params) ?? "auto";
}
function isAutoEncoding(value) {
    return !value || value.trim().toLowerCase().replace(/_/g, "-") === "auto";
}
async function resolveWriteEncoding(runner, path, params, overwrite) {
    const requested = encoding(params);
    if (!isAutoEncoding(requested)) {
        return requested ?? "utf-8";
    }
    if (!overwrite) {
        return "utf-8";
    }
    const info = await statPath(runner, path);
    if (!info.exists) {
        return "utf-8";
    }
    if (info.type && info.type !== "file") {
        return "utf-8";
    }
    const decoded = await readTextFileDecoded(runner, path, {
        maxBytes: maxBytes(params),
        encoding: "auto",
    });
    return decoded.encoding;
}
function fixedSearch(params) {
    return typeof params.fixed === "boolean" ? params.fixed : true;
}
function maxResults(params) {
    return typeof params.max_results === "number" ? params.max_results : 100;
}
function stringParamWithAlias(params, canonical, alias, toolName, options = {}) {
    const canonicalValue = params[canonical];
    const aliasValue = params[alias];
    if (typeof canonicalValue === "string" && typeof aliasValue === "string" && canonicalValue !== aliasValue) {
        throw new Error(`${toolName}: parameters "${canonical}" and "${alias}" both exist but differ; pass only "${canonical}".`);
    }
    const key = typeof canonicalValue === "string" || typeof aliasValue !== "string" ? canonical : alias;
    return requireStringParam(params, key, toolName, options);
}
function booleanParamWithAlias(params, canonical, alias, defaultValue, toolName) {
    const canonicalValue = params[canonical];
    const aliasValue = params[alias];
    if (typeof canonicalValue === "boolean" && typeof aliasValue === "boolean" && canonicalValue !== aliasValue) {
        throw new Error(`${toolName}: parameters "${canonical}" and "${alias}" both exist but differ; pass only "${canonical}".`);
    }
    if (typeof canonicalValue === "boolean") {
        return canonicalValue;
    }
    if (typeof aliasValue === "boolean") {
        return aliasValue;
    }
    return defaultValue;
}
function shaMismatchResponse(path, expected, current) {
    return {
        content: [{
                type: "text",
                text: [
                    `Error: expected_sha256 mismatch for ${path} — the file changed since you last read it.`,
                    `expected: ${expected}`,
                    `actual:   ${current.sha256}`,
                    `Re-read the file to get fresh content and its sha256, then retry with updated old_string/expected_sha256.`,
                ].join("\n"),
            }],
        isError: true,
        structuredContent: {
            path,
            bytes: current.bytes,
            sha256: current.sha256,
            encoding: current.encoding,
            requestedEncoding: current.requestedEncoding,
            detectedEncoding: current.detectedEncoding,
            encodingConfidence: current.confidence,
            encodingWarning: current.warning,
        },
    };
}
function formatPatchWarnings(normalizations, warnings) {
    const lines = [];
    if (normalizations.length > 0) {
        lines.push(`warning: normalized ${normalizations.length} patch line(s); see structuredContent.normalizations`);
    }
    if (warnings.length > 0) {
        lines.push(`warning: ${warnings.length} patch match warning(s); see structuredContent.warnings`);
    }
    return lines;
}
function formatReadResponse(path, decoded) {
    const lines = [
        `Read ${decoded.bytes} bytes from ${path} (encoding: ${decoded.encoding}, sha256: ${decoded.sha256})`,
    ];
    if (decoded.warning) {
        lines.push(`warning: ${decoded.warning}`);
    }
    // Full text goes in the text content so every MCP client surfaces it,
    // including ones that do not pass structuredContent to the model.
    lines.push(decoded.text);
    return {
        content: [{ type: "text", text: lines.join("\n") }],
        structuredContent: {
            path,
            bytes: decoded.bytes,
            sha256: decoded.sha256,
            encoding: decoded.encoding,
            requestedEncoding: decoded.requestedEncoding,
            detectedEncoding: decoded.detectedEncoding,
            encodingConfidence: decoded.confidence,
            encodingWarning: decoded.warning,
        },
    };
}
function commonFields(options) {
    return {
        ...(options.targetFields ?? {}),
        root: rootField,
    };
}
// ---------------------------------------------------------------------------
// Action handlers (shared by legacy per-tool registration and unified tool)
// ---------------------------------------------------------------------------
async function handleRead(params, options) {
    const toolName = `${options.prefix}_read`;
    rejectUnexpectedParams(params, [...Object.keys(commonFields(options)), "path", "max_bytes", "encoding"], toolName);
    const runner = options.makeRunner(params);
    const path = resolvePath(params.root, requireStringParam(params, "path", toolName));
    const decoded = await readTextFileDecoded(runner, path, {
        maxBytes: maxBytes(params),
        encoding: requestedEncoding(params),
    });
    return formatReadResponse(path, decoded);
}
async function handleWrite(params, options) {
    const toolName = `${options.prefix}_write`;
    rejectUnexpectedParams(params, [...Object.keys(commonFields(options)), "path", "content", "create_parents", "overwrite", "expected_sha256", "mode", "encoding"], toolName);
    const runner = options.makeRunner(params);
    const path = resolvePath(params.root, requireStringParam(params, "path", toolName));
    const overwrite = typeof params.overwrite === "boolean" ? params.overwrite : true;
    const writeEncoding = await resolveWriteEncoding(runner, path, params, overwrite);
    const result = await writeTextFile(runner, {
        path,
        content: requireStringParam(params, "content", toolName, { allowEmpty: true }),
        createParents: typeof params.create_parents === "boolean" ? params.create_parents : true,
        overwrite,
        expectedSha256: typeof params.expected_sha256 === "string" ? params.expected_sha256 : undefined,
        mode: typeof params.mode === "string" ? params.mode : undefined,
        encoding: writeEncoding,
    });
    return {
        content: [{ type: "text", text: `Wrote ${result.bytes} bytes to ${path}\nsha256: ${result.sha256}` }],
        structuredContent: {
            path,
            ...result,
            encoding: writeEncoding,
            requestedEncoding: requestedEncoding(params),
        },
    };
}
const EDIT_DIFF_MAX_LINES = 400;
async function handleEdit(params, options) {
    const toolName = `${options.prefix}_edit`;
    rejectUnexpectedParams(params, [...Object.keys(commonFields(options)), "path", "old_string", "new_string", "replace_all", "oldString", "newString", "replaceAll", "dry_run", "expected_sha256", "max_bytes", "encoding"], toolName);
    const runner = options.makeRunner(params);
    const path = resolvePath(params.root, requireStringParam(params, "path", toolName));
    const textEncoding = requestedEncoding(params);
    const original = await readTextFileDecoded(runner, path, {
        maxBytes: maxBytes(params),
        encoding: textEncoding,
    });
    const expectedSha = typeof params.expected_sha256 === "string" ? params.expected_sha256 : undefined;
    if (expectedSha && expectedSha !== original.sha256) {
        return shaMismatchResponse(path, expectedSha, original);
    }
    const oldString = stringParamWithAlias(params, "old_string", "oldString", toolName);
    const newString = stringParamWithAlias(params, "new_string", "newString", toolName, { allowEmpty: true });
    const replaceAll = booleanParamWithAlias(params, "replace_all", "replaceAll", false, toolName);
    const applied = applyTextEdit(original.text, oldString, newString, {
        replaceAll,
        path,
        hint: `To fix: call ${options.prefix}_read on this file and copy old_string verbatim from its output, then retry.`,
    });
    const bytes = encodeRemoteText(applied.text, original.encoding);
    const diff = unifiedDiff(original.text, applied.text, path, { maxLines: EDIT_DIFF_MAX_LINES });
    if (!params.dry_run) {
        try {
            await writeTextFile(runner, {
                path,
                content: applied.text,
                overwrite: true,
                createParents: false,
                expectedSha256: original.sha256,
                encoding: original.encoding,
            });
        }
        catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            if (message.includes("sha256 mismatch")) {
                const current = await readTextFileDecoded(runner, path, {
                    maxBytes: maxBytes(params),
                    encoding: textEncoding,
                });
                return shaMismatchResponse(path, original.sha256, current);
            }
            throw error;
        }
    }
    const contentLines = [
        `${params.dry_run ? "Would edit" : "Edited"} ${path} (${applied.replacements} replacement${applied.replacements === 1 ? "" : "s"}${applied.lineEndingsNormalized ? ", CRLF line endings preserved" : ""}, sha256: ${sha256Bytes(bytes)})`,
        diff.diff,
    ];
    if (diff.truncated) {
        contentLines.push(`(diff truncated at ${EDIT_DIFF_MAX_LINES} lines)`);
    }
    if (params.dry_run) {
        contentLines.push("(dry run: nothing was written)");
    }
    return {
        content: [{ type: "text", text: contentLines.filter(Boolean).join("\n") }],
        structuredContent: {
            path,
            action: "edit",
            replacements: applied.replacements,
            bytes: bytes.length,
            sha256: sha256Bytes(bytes),
            dryRun: params.dry_run ?? false,
            oldSha256: original.sha256,
            diff: diff.diff,
            diffTruncated: diff.truncated,
            lineEndingsNormalized: applied.lineEndingsNormalized,
            encoding: original.encoding,
            requestedEncoding: textEncoding,
            detectedEncoding: original.detectedEncoding,
            encodingConfidence: original.confidence,
            encodingWarning: original.warning,
        },
    };
}
async function handleApplyPatch(params, options) {
    const toolName = `${options.prefix}_apply_patch`;
    rejectUnexpectedParams(params, [...Object.keys(commonFields(options)), "patch", "dry_run", "max_bytes", "encoding"], toolName, {
        command: `${toolName} expects "patch" containing a Codex-style patch, not "command".`,
        content: `${toolName} expects "patch" containing a Codex-style patch, not "content".`,
        script: `${toolName} expects "patch" containing a Codex-style patch, not "script".`,
    });
    const runner = options.makeRunner(params);
    const textEncoding = requestedEncoding(params);
    const dryRun = Boolean(params.dry_run);
    const parsed = parsePatch(requireStringParam(params, "patch", toolName));
    const operations = parsed.operations;
    const warnings = [];
    const planned = [];
    for (const operation of operations) {
        const path = resolvePath(params.root, operation.path);
        if (operation.kind === "add") {
            const content = textForAddedFile(operation.lines ?? []);
            const writeEncoding = isAutoEncoding(textEncoding) ? "utf-8" : textEncoding;
            if (!dryRun) {
                const info = await statPath(runner, path);
                if (info.exists) {
                    throw new Error(`Add File refused: path already exists: ${path}`);
                }
            }
            const bytes = encodeRemoteText(content, writeEncoding);
            const diff = unifiedDiff("", content, path, { maxLines: EDIT_DIFF_MAX_LINES });
            planned.push({
                kind: "add",
                path,
                content,
                encoding: writeEncoding,
                added: operation.lines?.length ?? 0,
                diff: diff.diff,
                diffTruncated: diff.truncated,
                summary: {
                    path,
                    action: "add",
                    added: operation.lines?.length ?? 0,
                    removed: 0,
                    bytes: bytes.length,
                    sha256: sha256Bytes(bytes),
                    dryRun,
                    diff: diff.diff,
                    diffTruncated: diff.truncated,
                    encoding: writeEncoding,
                    requestedEncoding: textEncoding,
                },
            });
            continue;
        }
        const original = await readTextFileDecoded(runner, path, {
            maxBytes: maxBytes(params),
            encoding: textEncoding,
        });
        const applied = applyUpdatePatch(original.text, operation.hunks ?? [], path);
        warnings.push(...applied.warnings);
        const bytes = encodeRemoteText(applied.text, original.encoding);
        const diff = unifiedDiff(original.text, applied.text, path, { maxLines: EDIT_DIFF_MAX_LINES });
        planned.push({
            kind: "update",
            path,
            content: applied.text,
            encoding: original.encoding,
            expectedSha256: original.sha256,
            added: applied.added,
            removed: applied.removed,
            diff: diff.diff,
            diffTruncated: diff.truncated,
            summary: {
                path,
                action: "update",
                added: applied.added,
                removed: applied.removed,
                bytes: bytes.length,
                sha256: sha256Bytes(bytes),
                dryRun,
                diff: diff.diff,
                diffTruncated: diff.truncated,
                oldSha256: original.sha256,
                encoding: original.encoding,
                requestedEncoding: textEncoding,
                detectedEncoding: original.detectedEncoding,
                encodingConfidence: original.confidence,
                encodingWarning: original.warning,
            },
        });
    }
    if (!dryRun) {
        for (const item of planned) {
            try {
                if (item.kind === "add") {
                    await writeTextFile(runner, {
                        path: item.path,
                        content: item.content,
                        overwrite: false,
                        createParents: true,
                        encoding: item.encoding,
                    });
                }
                else {
                    await writeTextFile(runner, {
                        path: item.path,
                        content: item.content,
                        overwrite: true,
                        createParents: false,
                        expectedSha256: item.expectedSha256,
                        encoding: item.encoding,
                    });
                }
            }
            catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                if (item.kind === "update" && message.includes("sha256 mismatch")) {
                    const current = await readTextFileDecoded(runner, item.path, {
                        maxBytes: maxBytes(params),
                        encoding: textEncoding,
                    });
                    return shaMismatchResponse(item.path, item.expectedSha256, current);
                }
                throw new Error(`${message} (patch write phase failed at ${item.path}; earlier files in this patch may already have been written)`);
            }
        }
    }
    const summaries = planned.map((item) => item.summary);
    const outputLines = summaries.map((item) => {
        const mode = item.dryRun ? "would " : "";
        return `${mode}${item.action} ${item.path} (+${item.added}/-${item.removed}) sha256=${item.sha256}`;
    });
    for (const item of planned) {
        if (item.diff) {
            outputLines.push(item.diff);
            if (item.diffTruncated) {
                outputLines.push(`(diff truncated at ${EDIT_DIFF_MAX_LINES} lines)`);
            }
        }
    }
    outputLines.push(...formatPatchWarnings(parsed.normalizations, warnings));
    return {
        content: [{ type: "text", text: outputLines.join("\n") }],
        structuredContent: {
            operations: summaries,
            normalizations: parsed.normalizations,
            warnings,
        },
    };
}
async function handleSearch(params, options) {
    const toolName = `${options.prefix}_search`;
    rejectUnexpectedParams(params, [...Object.keys(commonFields(options)), "path", "pattern", "fixed", "max_results", "encoding"], toolName);
    const path = resolvePath(params.root, requireStringParam(params, "path", toolName));
    const output = await searchText(options.makeRunner(params), {
        path,
        pattern: requireStringParam(params, "pattern", toolName),
        fixed: fixedSearch(params),
        maxResults: maxResults(params),
        encoding: encoding(params),
    });
    return {
        content: [{ type: "text", text: output }],
        structuredContent: { path, output, requestedEncoding: requestedEncoding(params) },
    };
}
const actionHandlers = {
    read: handleRead,
    write: handleWrite,
    edit: handleEdit,
    apply_patch: handleApplyPatch,
    search: handleSearch,
};
// ---------------------------------------------------------------------------
// Legacy registration: one tool per operation (ssh_file_read, wsl_file_write, ...)
// ---------------------------------------------------------------------------
export function registerRemoteFileTools(options) {
    const common = commonFields(options);
    const handlers = {};
    function register(name, config, callback) {
        handlers[name] = callback;
        options.server.registerTool(name, config, callback);
    }
    register(`${options.prefix}_read`, {
        title: `${options.titlePrefix} Read File`,
        description: `Read a remote text file and return its full text. ${options.targetDescription}
Encoding auto-detected; returned sha256 can guard write/edit. Legacy opt-in capability; see ${options.prefix.split("_")[0]}_help topic="files" for limitations.`,
        inputSchema: z.object({
            ...common,
            path: pathField,
            max_bytes: z.number().int().positive().default(DEFAULT_MAX_BYTES).describe("Maximum file size to read."),
            encoding: encodingField,
        }).strict(),
        annotations: {
            readOnlyHint: true,
            destructiveHint: false,
            idempotentHint: true,
            openWorldHint: true,
        },
    }, async (params) => {
        try {
            return await handleRead(params, options);
        }
        catch (error) {
            return errorResponse(error);
        }
    });
    register(`${options.prefix}_write`, {
        title: `${options.titlePrefix} Write File`,
        description: `Write or create a remote text file. ${options.targetDescription}
Prefer over heredoc/echo: base64 transport (no quoting pitfalls), temp file + atomic rename, parents auto-created. expected_sha256 (from read) guards against overwriting changes. Encoding auto: new files UTF-8, overwrites preserve detected encoding; pass encoding to force.`,
        inputSchema: z.object({
            ...common,
            path: pathField,
            content: z.string().describe("Text content to write."),
            create_parents: z.boolean().default(true).describe("Create parent directories before writing."),
            overwrite: z.boolean().default(true).describe("Allow overwriting an existing path."),
            expected_sha256: z.string().optional().describe("Optional sha256 of the current remote file bytes before writing."),
            mode: z.string().optional().describe('Optional chmod mode for the written file, e.g. "0644".'),
            encoding: encodingField,
        }).strict(),
        annotations: {
            readOnlyHint: false,
            destructiveHint: true,
            idempotentHint: false,
            openWorldHint: true,
        },
    }, async (params) => {
        try {
            return await handleWrite(params, options);
        }
        catch (error) {
            return errorResponse(error);
        }
    });
    register(`${options.prefix}_edit`, {
        title: `${options.titlePrefix} Edit File`,
        description: `Edit a remote text file by exact string replacement. ${options.targetDescription}
Prefer over sed/python: no escaping pitfalls, loud failure instead of silent no-op, atomic + encoding-preserving. Read the file first and copy old_string verbatim; must match exactly once unless replace_all=true. CRLF auto-matched; mismatch errors include the closest region. Returns a unified diff.`,
        inputSchema: z.object({
            ...common,
            path: pathField,
            old_string: z.string().optional().describe("Exact text to replace. Must match once unless replace_all=true."),
            new_string: z.string().optional().describe("Replacement text. May be empty."),
            replace_all: z.boolean().default(false).describe("Replace every occurrence instead of requiring exactly one match."),
            oldString: z.string().optional().describe("Compatibility alias for old_string."),
            newString: z.string().optional().describe("Compatibility alias for new_string."),
            replaceAll: z.boolean().optional().describe("Compatibility alias for replace_all."),
            dry_run: z.boolean().default(false).describe("Compute the edit without writing the remote file."),
            expected_sha256: z.string().optional().describe("Optional sha256 of the current remote file bytes before editing."),
            max_bytes: z.number().int().positive().default(DEFAULT_MAX_BYTES).describe("Maximum file size to read."),
            encoding: encodingField,
        }).strict(),
        annotations: {
            readOnlyHint: false,
            destructiveHint: true,
            idempotentHint: false,
            openWorldHint: true,
        },
    }, async (params) => {
        try {
            return await handleEdit(params, options);
        }
        catch (error) {
            return errorResponse(error);
        }
    });
    register(`${options.prefix}_apply_patch`, {
        title: `${options.titlePrefix} Apply Patch`,
        description: `Apply a Codex-style patch to remote files (Add File / Update File; Delete/Move unsupported). ${options.targetDescription}
Prefer over sed/python for multi-file or multi-hunk changes; single-string replacements can use ${options.prefix}_edit.
Format:
*** Begin Patch
*** Update File: <path>
@@
  context line (leading space)
-removed line
+added line
*** Add File: <path>
+new file content line
*** End Patch
Every hunk line needs a marker: space=context, +=added, -=removed. Returns a unified diff; dry_run=true previews.`,
        inputSchema: z.object({
            ...common,
            patch: z.string().min(1).describe("Patch text using the Codex-style *** Begin Patch format."),
            dry_run: z.boolean().default(false).describe("Compute the patch without writing remote files."),
            max_bytes: z.number().int().positive().default(DEFAULT_MAX_BYTES).describe("Maximum size for each file read."),
            encoding: encodingField,
        }).strict(),
        annotations: {
            readOnlyHint: false,
            destructiveHint: true,
            idempotentHint: false,
            openWorldHint: true,
        },
    }, async (params) => {
        try {
            return await handleApplyPatch(params, options);
        }
        catch (error) {
            return errorResponse(error);
        }
    });
    register(`${options.prefix}_search`, {
        title: `${options.titlePrefix} Search Text`,
        description: `Search remote text files with grep. ${options.targetDescription}
Returns grep -RIn output (path:line:text), capped at max_results. fixed=true (default) is literal grep -F; false for regex. ASCII patterns are most portable across remote locales.`,
        inputSchema: z.object({
            ...common,
            path: pathField,
            pattern: z.string().min(1).describe("Pattern to search for."),
            fixed: z.boolean().default(true).describe("Use fixed-string grep (-F) instead of regex grep."),
            max_results: z.number().int().positive().default(100).describe("Maximum result lines to return."),
            encoding: encodingField,
        }).strict(),
        annotations: {
            readOnlyHint: true,
            destructiveHint: false,
            idempotentHint: true,
            openWorldHint: true,
        },
    }, async (params) => {
        try {
            return await handleSearch(params, options);
        }
        catch (error) {
            return errorResponse(error);
        }
    });
    return handlers;
}
// ---------------------------------------------------------------------------
// Unified registration: one tool per backend ({prefix}, e.g. ssh_file / wsl_file)
// selected by REMOTE_MCP_FILE_API=unified. Reuses the same action handlers.
// ---------------------------------------------------------------------------
const unifiedActionEnum = z.enum(["read", "write", "edit", "apply_patch", "search"]);
function unifiedSchema(options) {
    const common = commonFields(options);
    return z.object({
        action: unifiedActionEnum,
        ...common,
        path: pathField.optional(),
        content: z.string().optional().describe("Text content (write)."),
        create_parents: z.boolean().optional().describe("Create parent directories (write)."),
        overwrite: z.boolean().optional().describe("Allow overwrite (write)."),
        expected_sha256: z.string().optional().describe("sha256 guard before write/edit."),
        mode: z.string().optional().describe('chmod mode (write), e.g. "0644".'),
        old_string: z.string().optional().describe("Exact text to replace (edit); must match once unless replace_all=true."),
        new_string: z.string().optional().describe("Replacement text (edit)."),
        replace_all: z.boolean().optional().describe("Replace every occurrence (edit)."),
        dry_run: z.boolean().optional().describe("Compute without writing."),
        patch: z.string().optional().describe("Codex-style *** Begin Patch text (apply_patch)."),
        pattern: z.string().optional().describe("Search pattern (search)."),
        fixed: z.boolean().optional().describe("grep -F fixed string (search)."),
        max_results: z.number().int().positive().optional().describe("Max result lines (search)."),
        max_bytes: z.number().int().positive().optional().describe("Maximum file size to read."),
        encoding: encodingField,
        // Keep this as a plain ZodObject. The MCP SDK serializes ZodEffects
        // (created by superRefine) as an empty JSON schema, hiding action/path/patch
        // from the model. Action-specific required fields are enforced by the
        // handlers via requireStringParam/rejectUnexpectedParams.
    }).strict();
}
export function registerUnifiedRemoteFileTools(options) {
    const toolName = options.prefix; // e.g. ssh_file / wsl_file
    const handler = async (params) => {
        const action = params.action;
        const impl = actionHandlers[action];
        if (!impl) {
            return errorResponse(new Error(`Unknown ${toolName} action: ${action}`));
        }
        try {
            const { action: _action, ...actionParams } = params;
            return await impl(actionParams, options);
        }
        catch (error) {
            return errorResponse(error);
        }
    };
    options.server.registerTool(toolName, {
        title: `${options.titlePrefix} File Operations (unified)`,
        description: `Remote file operations. ${options.targetDescription}
Legacy opt-in capability. See ${options.prefix.split("_")[0]}_help topic="files" for limitations.
action selects the operation:
  read(path, max_bytes?, encoding?) - read text file; full text in the text content
  write(path, content, create_parents?, overwrite?, expected_sha256?, mode?, encoding?) - write/create text file
  edit(path, old_string, new_string, replace_all?, dry_run?, expected_sha256?, max_bytes?, encoding?) - exact replace once; CRLF auto-matched; returns unified diff
  apply_patch(patch, dry_run?, max_bytes?, encoding?) - Codex-style patch (*** Begin Patch / *** Update File: <path> / @@ / space=context, -=removed, +=added / *** Add File: <path> / *** End Patch); returns unified diff
  search(path, pattern, fixed?, max_results?, encoding?) - grep search (grep -RIn output)
Encoding auto (UTF-8 preferred; GBK fallback; overwrites preserve encoding). read's sha256 doubles as expected_sha256 staleness guard.`,
        inputSchema: unifiedSchema(options),
        annotations: {
            readOnlyHint: false,
            destructiveHint: true,
            idempotentHint: false,
            openWorldHint: true,
        },
    }, handler);
    return { [toolName]: handler };
}
//# sourceMappingURL=fileTools.js.map