import { z } from "zod";
import { errorResponse } from "../mcp.js";
import { joinRemotePath } from "../shell.js";
import { applyUpdatePatch, parsePatch, textForAddedFile, } from "./patch.js";
import { encodeRemoteText, listDir, readTextFileDecoded, searchText, sha256Bytes, statPath, writeTextFile, } from "./remoteOps.js";
const DEFAULT_MAX_BYTES = 5 * 1024 * 1024;
const rootField = z.string()
    .optional()
    .describe("Optional remote root joined with relative paths before execution.");
const pathField = z.string()
    .min(1)
    .describe("Remote path. Relative paths are joined with root when root is set.");
const encodingField = z.string()
    .optional()
    .describe('Text encoding for file content. Defaults to "auto"; explicit values include "utf-8", "gbk", and "gb18030".');
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
function formatReadSummary(path, decoded) {
    const lines = [
        `Read ${decoded.bytes} bytes from ${path}`,
        `sha256: ${decoded.sha256}`,
        `encoding: ${decoded.encoding} (requested: ${decoded.requestedEncoding}, detected: ${decoded.detectedEncoding}, confidence: ${decoded.confidence})`,
        "text: structuredContent.text",
    ];
    if (decoded.warning) {
        lines.push(`warning: ${decoded.warning}`);
    }
    return lines.join("\n");
}
function commonFields(options) {
    return {
        ...(options.targetFields ?? {}),
        root: rootField,
    };
}
export function registerRemoteFileTools(options) {
    const common = commonFields(options);
    const handlers = {};
    function register(name, config, callback) {
        handlers[name] = callback;
        options.server.registerTool(name, config, callback);
    }
    register(`${options.prefix}_read`, {
        title: `${options.titlePrefix} Read File`,
        description: `Read a remote text file. ${options.targetDescription}

The remote side only needs a basic POSIX shell plus cat/wc. File bytes are read
raw and decoded locally. Encoding defaults to auto: UTF-8 is preferred when
valid, and common legacy encodings such as GBK/GB18030 are tried when UTF-8 is
invalid. The returned text content is in structuredContent.text. The text
content entry is a short summary to avoid duplicating large file contents for
clients that surface both content and structuredContent.`,
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
            const runner = options.makeRunner(params);
            const path = resolvePath(params.root, String(params.path ?? ""));
            const decoded = await readTextFileDecoded(runner, path, {
                maxBytes: maxBytes(params),
                encoding: requestedEncoding(params),
            });
            return {
                content: [{ type: "text", text: formatReadSummary(path, decoded) }],
                structuredContent: {
                    path,
                    text: decoded.text,
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
        catch (error) {
            return errorResponse(error);
        }
    });
    register(`${options.prefix}_write`, {
        title: `${options.titlePrefix} Write File`,
        description: `Write a remote text file. ${options.targetDescription}

Content is encoded locally, sent as base64 through stdin, decoded by the remote
shell into a temporary file, then moved into place. Encoding defaults to auto:
new files are written as UTF-8, while overwriting an existing text file first
detects and preserves that file's encoding. Pass encoding explicitly to force a
specific encoding. Small writes can fall back to POSIX printf when base64 is not
available on a slim remote device.`,
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
            const runner = options.makeRunner(params);
            const path = resolvePath(params.root, String(params.path ?? ""));
            const overwrite = typeof params.overwrite === "boolean" ? params.overwrite : true;
            const writeEncoding = await resolveWriteEncoding(runner, path, params, overwrite);
            const result = await writeTextFile(runner, {
                path,
                content: String(params.content ?? ""),
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
        catch (error) {
            return errorResponse(error);
        }
    });
    register(`${options.prefix}_apply_patch`, {
        title: `${options.titlePrefix} Apply Patch`,
        description: `Apply a text patch to remote files. ${options.targetDescription}

Patch parsing and hunk matching run locally. The remote host only performs
basic reads and atomic writes. Supported directives: *** Add File and
*** Update File. Delete and move patches are intentionally unsupported.
Encoding defaults to auto: updates preserve the detected source-file encoding,
while added files are written as UTF-8 unless encoding is passed explicitly.`,
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
            const runner = options.makeRunner(params);
            const textEncoding = requestedEncoding(params);
            const operations = parsePatch(String(params.patch ?? ""));
            const summaries = [];
            for (const operation of operations) {
                const path = resolvePath(params.root, operation.path);
                if (operation.kind === "add") {
                    const content = textForAddedFile(operation.lines ?? []);
                    const writeEncoding = isAutoEncoding(textEncoding) ? "utf-8" : textEncoding;
                    if (!params.dry_run) {
                        await writeTextFile(runner, {
                            path,
                            content,
                            overwrite: false,
                            createParents: true,
                            encoding: writeEncoding,
                        });
                    }
                    const bytes = encodeRemoteText(content, writeEncoding);
                    summaries.push({
                        path,
                        action: "add",
                        added: operation.lines?.length ?? 0,
                        removed: 0,
                        bytes: bytes.length,
                        sha256: sha256Bytes(bytes),
                        dryRun: params.dry_run ?? false,
                        encoding: writeEncoding,
                        requestedEncoding: textEncoding,
                    });
                    continue;
                }
                const original = await readTextFileDecoded(runner, path, {
                    maxBytes: maxBytes(params),
                    encoding: textEncoding,
                });
                const applied = applyUpdatePatch(original.text, operation.hunks ?? [], path);
                if (!params.dry_run) {
                    await writeTextFile(runner, {
                        path,
                        content: applied.text,
                        overwrite: true,
                        createParents: false,
                        expectedSha256: original.sha256,
                        encoding: original.encoding,
                    });
                }
                const bytes = encodeRemoteText(applied.text, original.encoding);
                summaries.push({
                    path,
                    action: "update",
                    added: applied.added,
                    removed: applied.removed,
                    bytes: bytes.length,
                    sha256: sha256Bytes(bytes),
                    dryRun: params.dry_run ?? false,
                    oldSha256: original.sha256,
                    encoding: original.encoding,
                    requestedEncoding: textEncoding,
                    detectedEncoding: original.detectedEncoding,
                    encodingConfidence: original.confidence,
                    encodingWarning: original.warning,
                });
            }
            return {
                content: [{
                        type: "text",
                        text: summaries.map((item) => {
                            const mode = item.dryRun ? "would " : "";
                            return `${mode}${item.action} ${item.path} (+${item.added}/-${item.removed}) sha256=${item.sha256}`;
                        }).join("\n"),
                    }],
                structuredContent: { operations: summaries },
            };
        }
        catch (error) {
            return errorResponse(error);
        }
    });
    register(`${options.prefix}_list`, {
        title: `${options.titlePrefix} List Directory`,
        description: `List a remote directory using basic shell tools. ${options.targetDescription}

This is for quick inspection; it returns a compact text rendering plus
structured entries with name, type, size, and mtime when available.`,
        inputSchema: z.object({
            ...common,
            path: pathField,
        }).strict(),
        annotations: {
            readOnlyHint: true,
            destructiveHint: false,
            idempotentHint: true,
            openWorldHint: true,
        },
    }, async (params) => {
        try {
            const path = resolvePath(params.root, String(params.path ?? ""));
            const entries = await listDir(options.makeRunner(params), path);
            return {
                content: [{ type: "text", text: JSON.stringify(entries, null, 2) }],
                structuredContent: { path, entries },
            };
        }
        catch (error) {
            return errorResponse(error);
        }
    });
    register(`${options.prefix}_stat`, {
        title: `${options.titlePrefix} Stat Path`,
        description: `Inspect a remote path. ${options.targetDescription}

This returns existence, path type, size, mode, and mtime when the remote shell
can obtain them.`,
        inputSchema: z.object({
            ...common,
            path: pathField,
        }).strict(),
        annotations: {
            readOnlyHint: true,
            destructiveHint: false,
            idempotentHint: true,
            openWorldHint: true,
        },
    }, async (params) => {
        try {
            const path = resolvePath(params.root, String(params.path ?? ""));
            const info = await statPath(options.makeRunner(params), path);
            return {
                content: [{ type: "text", text: JSON.stringify(info, null, 2) }],
                structuredContent: info,
            };
        }
        catch (error) {
            return errorResponse(error);
        }
    });
    register(`${options.prefix}_search`, {
        title: `${options.titlePrefix} Search Text`,
        description: `Search remote text files using grep. ${options.targetDescription}

The remote host runs grep and the output bytes are decoded locally with the same
auto/explicit encoding rules as reads. ASCII patterns are the most portable;
non-ASCII pattern matching still depends on the remote grep and locale.`,
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
            const path = resolvePath(params.root, String(params.path ?? ""));
            const output = await searchText(options.makeRunner(params), {
                path,
                pattern: String(params.pattern ?? ""),
                fixed: fixedSearch(params),
                maxResults: maxResults(params),
                encoding: encoding(params),
            });
            return {
                content: [{ type: "text", text: output }],
                structuredContent: { path, output, requestedEncoding: requestedEncoding(params) },
            };
        }
        catch (error) {
            return errorResponse(error);
        }
    });
    return handlers;
}
//# sourceMappingURL=fileTools.js.map