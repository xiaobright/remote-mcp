#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { applyUpdatePatch, encodeRemoteText, joinRemotePath, listDir, parsePatch, readTextFileDecoded, searchText, sha256Text, statPath, textForAddedFile, writeTextFile, } from "@remote-mcp/shared/remote";
import { errorResponse } from "@remote-mcp/shared/mcp";
const server = new McpServer({
    name: "remote-fs-mcp-server",
    version: "0.1.0",
});
const transportSchema = z.enum(["wsl", "ssh"]);
const targetFields = {
    transport: transportSchema.describe('Remote transport: "wsl" or "ssh".'),
    target: z.string()
        .optional()
        .describe("SSH target, e.g. radxa@192.168.31.34. Omit to use REMOTE_MCP_DEFAULT_SSH_TARGET."),
    distro: z.string()
        .optional()
        .describe("WSL distro. Omit to use the system default or REMOTE_MCP_DEFAULT_WSL_DISTRO."),
    ssh_options: z.array(z.string())
        .optional()
        .describe('Extra ssh argv items, e.g. ["-p","2222"].'),
    timeout_ms: z.number()
        .int()
        .positive()
        .optional()
        .describe("Timeout for the underlying remote shell operation."),
    root: z.string()
        .optional()
        .describe("Optional remote root joined with relative paths before execution."),
};
const encodingField = z.string()
    .optional()
    .describe('Text encoding for file content. Defaults to "auto"; explicit values include "utf-8", "gbk", and "gb18030".');
function targetFrom(params) {
    return {
        transport: params.transport,
        target: params.target,
        distro: params.distro,
        ssh_options: params.ssh_options,
        timeout_ms: params.timeout_ms,
    };
}
function resolvePath(root, path) {
    const resolved = joinRemotePath(root, path);
    if (!resolved.trim()) {
        throw new Error("path is required");
    }
    return resolved;
}
function requestedEncoding(params) {
    return params.encoding ?? "auto";
}
function isAutoEncoding(value) {
    return !value || value.trim().toLowerCase().replace(/_/g, "-") === "auto";
}
async function resolveWriteEncoding(target, path, params, overwrite) {
    if (!isAutoEncoding(params.encoding)) {
        return params.encoding ?? "utf-8";
    }
    if (!overwrite) {
        return "utf-8";
    }
    const info = await statPath(target, path);
    if (!info.exists || (info.type && info.type !== "file")) {
        return "utf-8";
    }
    const decoded = await readTextFileDecoded(target, path, {
        maxBytes: params.max_bytes,
        encoding: "auto",
    });
    return decoded.encoding;
}
server.registerTool("remote_file_read", {
    title: "Read Remote File",
    description: `Read a remote text file over SSH or WSL.

This is for observation. It does not require Python or Node on the remote host;
the remote side only needs a basic POSIX shell plus cat/wc. Encoding defaults to
auto; structuredContent returns metadata such as bytes, sha256, detected
encoding, and confidence while the file text is returned in content[0].text.`,
    inputSchema: z.object({
        ...targetFields,
        path: z.string().min(1).describe("Remote file path. Relative paths are joined with root when root is set."),
        max_bytes: z.number().int().positive().default(5 * 1024 * 1024).describe("Maximum file size to read."),
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
        const path = resolvePath(params.root, params.path);
        const decoded = await readTextFileDecoded(targetFrom(params), path, {
            maxBytes: params.max_bytes,
            encoding: requestedEncoding(params),
        });
        const structuredContent = {
            path,
            bytes: decoded.bytes,
            sha256: decoded.sha256,
            encoding: decoded.encoding,
            requestedEncoding: decoded.requestedEncoding,
            detectedEncoding: decoded.detectedEncoding,
            encodingConfidence: decoded.confidence,
            encodingWarning: decoded.warning,
        };
        return {
            content: [{ type: "text", text: decoded.text }],
            structuredContent,
        };
    }
    catch (error) {
        return errorResponse(error);
    }
});
server.registerTool("remote_file_write", {
    title: "Write Remote File",
    description: `Atomically write a remote text file over SSH or WSL.

Content is base64-encoded locally and decoded by the remote shell into a temp
file, then moved into place. Use expected_sha256 when replacing a file that was
previously read. Encoding defaults to auto: new files use UTF-8 and overwrites
try to preserve the existing file's detected encoding. Small writes can fall
back to POSIX printf when base64 is unavailable.`,
    inputSchema: z.object({
        ...targetFields,
        path: z.string().min(1).describe("Remote file path. Relative paths are joined with root when root is set."),
        content: z.string().describe("UTF-8 text content to write."),
        overwrite: z.boolean().default(true).describe("Whether to overwrite an existing path."),
        create_parents: z.boolean().default(true).describe("Create parent directories before writing."),
        expected_sha256: z.string().optional().describe("Optional sha256 of the current remote file before writing."),
        mode: z.string().optional().describe('Optional chmod mode for the written file, e.g. "644".'),
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
        const path = resolvePath(params.root, params.path);
        const target = targetFrom(params);
        const overwrite = params.overwrite ?? true;
        const writeEncoding = await resolveWriteEncoding(target, path, params, overwrite);
        const result = await writeTextFile(target, {
            path,
            content: params.content,
            overwrite,
            createParents: params.create_parents,
            expectedSha256: params.expected_sha256,
            mode: params.mode,
            encoding: writeEncoding,
        });
        return {
            content: [{
                    type: "text",
                    text: `Wrote ${result.bytes} bytes to ${path}\nsha256: ${result.sha256}`,
                }],
            structuredContent: { path, ...result, encoding: writeEncoding, requestedEncoding: requestedEncoding(params) },
        };
    }
    catch (error) {
        return errorResponse(error);
    }
});
server.registerTool("remote_file_apply_patch", {
    title: "Apply Remote Patch",
    description: `Apply a text patch to remote files over SSH or WSL.

Patch parsing and hunk matching run locally. The remote host only performs
basic reads and atomic writes. Supported directives: *** Add File and
*** Update File. Delete and move patches are intentionally unsupported.
Encoding defaults to auto: updates preserve detected source-file encoding and
added files use UTF-8 unless encoding is passed explicitly.`,
    inputSchema: z.object({
        ...targetFields,
        patch: z.string().min(1).describe("Patch text using the Codex-style *** Begin Patch format."),
        dry_run: z.boolean().default(false).describe("Compute the patch without writing remote files."),
        max_bytes: z.number().int().positive().default(5 * 1024 * 1024).describe("Maximum size for each file read."),
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
        const target = targetFrom(params);
        const textEncoding = requestedEncoding(params);
        const operations = parsePatch(params.patch);
        const summaries = [];
        for (const operation of operations) {
            const path = resolvePath(params.root, operation.path);
            if (operation.kind === "add") {
                const content = textForAddedFile(operation.lines ?? []);
                const writeEncoding = isAutoEncoding(textEncoding) ? "utf-8" : textEncoding;
                if (!params.dry_run) {
                    await writeTextFile(target, {
                        path,
                        content,
                        overwrite: false,
                        createParents: true,
                        encoding: writeEncoding,
                    });
                }
                summaries.push({
                    path,
                    action: "add",
                    added: operation.lines?.length ?? 0,
                    removed: 0,
                    bytes: encodeRemoteText(content, writeEncoding).length,
                    sha256: sha256Text(content, writeEncoding),
                    dryRun: params.dry_run ?? false,
                    encoding: writeEncoding,
                    requestedEncoding: textEncoding,
                });
                continue;
            }
            const original = await readTextFileDecoded(target, path, {
                maxBytes: params.max_bytes,
                encoding: textEncoding,
            });
            const applied = applyUpdatePatch(original.text, operation.hunks ?? [], path);
            if (!params.dry_run) {
                await writeTextFile(target, {
                    path,
                    content: applied.text,
                    overwrite: true,
                    createParents: false,
                    expectedSha256: original.sha256,
                    encoding: original.encoding,
                });
            }
            summaries.push({
                path,
                action: "update",
                added: applied.added,
                removed: applied.removed,
                bytes: encodeRemoteText(applied.text, original.encoding).length,
                oldSha256: original.sha256,
                sha256: sha256Text(applied.text, original.encoding),
                dryRun: params.dry_run ?? false,
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
                    text: summaries.map((item) => `${item.dryRun ? "Would apply" : "Applied"} ${item.action} ${item.path} (+${item.added}/-${item.removed})`).join("\n"),
                }],
            structuredContent: { files: summaries },
        };
    }
    catch (error) {
        return errorResponse(error);
    }
});
server.registerTool("remote_file_list", {
    title: "List Remote Directory",
    description: "List a remote directory over SSH or WSL using basic shell tools. Returns compact text plus structured entries.",
    inputSchema: z.object({
        ...targetFields,
        path: z.string().min(1).describe("Remote directory path. Relative paths are joined with root when root is set."),
    }).strict(),
    annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
    },
}, async (params) => {
    try {
        const path = resolvePath(params.root, params.path);
        const entries = await listDir(targetFrom(params), path);
        return {
            content: [{
                    type: "text",
                    text: entries.map((entry) => `${entry.type}\t${entry.size ?? ""}\t${entry.name}`).join("\n") || "(empty)",
                }],
            structuredContent: { path, entries },
        };
    }
    catch (error) {
        return errorResponse(error);
    }
});
server.registerTool("remote_file_stat", {
    title: "Stat Remote Path",
    description: "Inspect a remote path over SSH or WSL. Returns existence, type, size, mode, and mtime when available.",
    inputSchema: z.object({
        ...targetFields,
        path: z.string().min(1).describe("Remote path. Relative paths are joined with root when root is set."),
    }).strict(),
    annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
    },
}, async (params) => {
    try {
        const path = resolvePath(params.root, params.path);
        const info = await statPath(targetFrom(params), path);
        return {
            content: [{ type: "text", text: JSON.stringify(info, null, 2) }],
            structuredContent: info,
        };
    }
    catch (error) {
        return errorResponse(error);
    }
});
server.registerTool("remote_file_search", {
    title: "Search Remote Text",
    description: "Search remote text files over SSH or WSL using grep. Output is decoded locally with auto/explicit encoding rules; non-ASCII pattern matching depends on the remote grep and locale.",
    inputSchema: z.object({
        ...targetFields,
        path: z.string().min(1).describe("Remote path to search. Relative paths are joined with root when root is set."),
        pattern: z.string().min(1).describe("Search pattern."),
        fixed: z.boolean().default(true).describe("Use fixed-string search instead of grep regex."),
        max_results: z.number().int().positive().default(100).describe("Maximum matching lines to return."),
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
        const path = resolvePath(params.root, params.path);
        const output = await searchText(targetFrom(params), {
            path,
            pattern: params.pattern,
            fixed: params.fixed,
            maxResults: params.max_results,
            encoding: params.encoding,
        });
        return {
            content: [{ type: "text", text: output || "(no matches)" }],
            structuredContent: { path, output, requestedEncoding: requestedEncoding(params) },
        };
    }
    catch (error) {
        return errorResponse(error);
    }
});
async function main() {
    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.error("remote-fs-mcp-server running via stdio");
}
main().catch((error) => {
    console.error("Fatal error:", error);
    process.exit(1);
});
//# sourceMappingURL=index.js.map