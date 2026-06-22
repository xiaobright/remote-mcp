import { z, type ZodRawShape } from "zod";
import {
  errorResponse,
  rejectUnexpectedParams,
  requireStringParam,
} from "../mcp.js";
import { joinRemotePath } from "../shell.js";
import { applyTextEdit } from "./edit.js";
import {
  applyUpdatePatch,
  parsePatch,
  type PatchApplyWarning,
  type PatchNormalization,
  textForAddedFile,
} from "./patch.js";
import {
  encodeRemoteText,
  listDir,
  readTextFileDecoded,
  searchText,
  sha256Bytes,
  statPath,
  writeTextFile,
  type RemoteScriptRunner,
} from "./remoteOps.js";

interface RemoteFileToolServer {
  registerTool: (...args: any[]) => void;
}

export type RemoteFileToolHandler = (params: Record<string, unknown>) => Promise<any>;

export interface RegisterRemoteFileToolsOptions {
  server: RemoteFileToolServer;
  prefix: string;
  titlePrefix: string;
  targetDescription: string;
  targetFields?: ZodRawShape;
  makeRunner: (params: Record<string, unknown>) => RemoteScriptRunner;
}

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

function resolvePath(root: unknown, path: string): string {
  const resolved = joinRemotePath(typeof root === "string" ? root : undefined, path);
  if (!resolved.trim()) {
    throw new Error("path is required");
  }
  return resolved;
}

function maxBytes(params: Record<string, unknown>): number {
  return typeof params.max_bytes === "number" ? params.max_bytes : DEFAULT_MAX_BYTES;
}

function encoding(params: Record<string, unknown>): string | undefined {
  return typeof params.encoding === "string" ? params.encoding : undefined;
}

function requestedEncoding(params: Record<string, unknown>): string {
  return encoding(params) ?? "auto";
}

function isAutoEncoding(value: string | undefined): boolean {
  return !value || value.trim().toLowerCase().replace(/_/g, "-") === "auto";
}

async function resolveWriteEncoding(
  runner: RemoteScriptRunner,
  path: string,
  params: Record<string, unknown>,
  overwrite: boolean,
): Promise<string> {
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

function fixedSearch(params: Record<string, unknown>): boolean {
  return typeof params.fixed === "boolean" ? params.fixed : true;
}

function maxResults(params: Record<string, unknown>): number {
  return typeof params.max_results === "number" ? params.max_results : 100;
}

function stringParamWithAlias(
  params: Record<string, unknown>,
  canonical: string,
  alias: string,
  toolName: string,
  options: { allowEmpty?: boolean } = {},
): string {
  const canonicalValue = params[canonical];
  const aliasValue = params[alias];
  if (typeof canonicalValue === "string" && typeof aliasValue === "string" && canonicalValue !== aliasValue) {
    throw new Error(`${toolName}: parameters "${canonical}" and "${alias}" both exist but differ; pass only "${canonical}".`);
  }
  const key = typeof canonicalValue === "string" || typeof aliasValue !== "string" ? canonical : alias;
  return requireStringParam(params, key, toolName, options);
}

function booleanParamWithAlias(
  params: Record<string, unknown>,
  canonical: string,
  alias: string,
  defaultValue: boolean,
  toolName: string,
): boolean {
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

function shaMismatchResponse(path: string, expected: string, current: {
  text: string;
  bytes: number;
  sha256: string;
  encoding: string;
  requestedEncoding: string;
  detectedEncoding: string;
  confidence: number;
  warning?: string;
}) {
  return {
    content: [{
      type: "text" as const,
      text: [
        `Error: expected_sha256 mismatch for ${path}`,
        `expected: ${expected}`,
        `actual:   ${current.sha256}`,
        "current text: structuredContent.text",
      ].join("\n"),
    }],
    isError: true,
    structuredContent: {
      path,
      text: current.text,
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

function formatPatchWarnings(
  normalizations: PatchNormalization[],
  warnings: PatchApplyWarning[],
): string[] {
  const lines: string[] = [];
  if (normalizations.length > 0) {
    lines.push(`warning: normalized ${normalizations.length} patch line(s); see structuredContent.normalizations`);
  }
  if (warnings.length > 0) {
    lines.push(`warning: ${warnings.length} patch match warning(s); see structuredContent.warnings`);
  }
  return lines;
}

function formatReadSummary(path: string, decoded: {
  bytes: number;
  sha256: string;
  encoding: string;
  requestedEncoding: string;
  detectedEncoding: string;
  confidence: number;
  warning?: string;
}): string {
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

function commonFields(options: RegisterRemoteFileToolsOptions): ZodRawShape {
  return {
    ...(options.targetFields ?? {}),
    root: rootField,
  };
}

export function registerRemoteFileTools(options: RegisterRemoteFileToolsOptions): Record<string, RemoteFileToolHandler> {
  const common = commonFields(options);
  const commonKeys = Object.keys(common);
  const readParams = [...commonKeys, "path", "max_bytes", "encoding"];
  const writeParams = [...commonKeys, "path", "content", "create_parents", "overwrite", "expected_sha256", "mode", "encoding"];
  const editParams = [
    ...commonKeys,
    "path",
    "old_string",
    "new_string",
    "replace_all",
    "oldString",
    "newString",
    "replaceAll",
    "dry_run",
    "expected_sha256",
    "max_bytes",
    "encoding",
  ];
  const patchParams = [...commonKeys, "patch", "dry_run", "max_bytes", "encoding"];
  const pathParams = [...commonKeys, "path"];
  const searchParams = [...commonKeys, "path", "pattern", "fixed", "max_results", "encoding"];
  const handlers: Record<string, RemoteFileToolHandler> = {};

  function register(
    name: string,
    config: Record<string, unknown>,
    callback: RemoteFileToolHandler,
  ): void {
    handlers[name] = callback;
    options.server.registerTool(name, config, callback);
  }

  register(
    `${options.prefix}_read`,
    {
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
    },
    async (params) => {
      try {
        const toolName = `${options.prefix}_read`;
        rejectUnexpectedParams(params, readParams, toolName);
        const runner = options.makeRunner(params);
        const path = resolvePath(params.root, requireStringParam(params, "path", toolName));
        const decoded = await readTextFileDecoded(runner, path, {
          maxBytes: maxBytes(params),
          encoding: requestedEncoding(params),
        });
        return {
          content: [{ type: "text" as const, text: formatReadSummary(path, decoded) }],
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
      } catch (error) {
        return errorResponse(error);
      }
    },
  );

  register(
    `${options.prefix}_write`,
    {
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
    },
    async (params) => {
      try {
        const toolName = `${options.prefix}_write`;
        rejectUnexpectedParams(params, writeParams, toolName);
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
          content: [{ type: "text" as const, text: `Wrote ${result.bytes} bytes to ${path}\nsha256: ${result.sha256}` }],
          structuredContent: {
            path,
            ...result,
            encoding: writeEncoding,
            requestedEncoding: requestedEncoding(params),
          },
        };
      } catch (error) {
        return errorResponse(error);
      }
    },
  );

  register(
    `${options.prefix}_edit`,
    {
      title: `${options.titlePrefix} Edit File`,
      description: `Edit a remote text file by replacing an exact string. ${options.targetDescription}

Use this for focused one-file replacements. The default behavior matches common
editor tools: old_string must match exactly once; if it matches multiple places,
the tool errors instead of picking one. Pass replace_all=true to replace every
occurrence. OpenCode-style aliases oldString, newString, and replaceAll are
accepted for compatibility. The remote file is read and decoded locally, then
written back atomically with a sha256 guard. Encoding defaults to auto and
preserves the detected source-file encoding.`,
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
    },
    async (params) => {
      try {
        const toolName = `${options.prefix}_edit`;
        rejectUnexpectedParams(params, editParams, toolName);
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
        });

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
          } catch (error) {
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

        const bytes = encodeRemoteText(applied.text, original.encoding);
        return {
          content: [{
            type: "text" as const,
            text: `${params.dry_run ? "would edit" : "edited"} ${path} (${applied.replacements} replacement${applied.replacements === 1 ? "" : "s"}) sha256=${sha256Bytes(bytes)}`,
          }],
          structuredContent: {
            path,
            action: "edit",
            replacements: applied.replacements,
            bytes: bytes.length,
            sha256: sha256Bytes(bytes),
            dryRun: params.dry_run ?? false,
            oldSha256: original.sha256,
            encoding: original.encoding,
            requestedEncoding: textEncoding,
            detectedEncoding: original.detectedEncoding,
            encodingConfidence: original.confidence,
            encodingWarning: original.warning,
          },
        };
      } catch (error) {
        return errorResponse(error);
      }
    },
  );

  register(
    `${options.prefix}_apply_patch`,
    {
      title: `${options.titlePrefix} Apply Patch`,
      description: `Apply a text patch to remote files. ${options.targetDescription}

Patch parsing and hunk matching run locally. The remote host only performs
basic reads and atomic writes. Supported directives: *** Add File and
*** Update File. Delete and move patches are intentionally unsupported.
Encoding defaults to auto: updates preserve the detected source-file encoding,
while added files are written as UTF-8 unless encoding is passed explicitly.

Use ${options.prefix}_edit for focused single-file string replacements. Use this
tool when you need multi-file edits, multiple hunks, or *** Add File.

Format (Codex-style):
  *** Begin Patch
  *** Update File: <path>
  @@
   context line (leading space)
  -removed line
  +added line
  *** Add File: <path>
  +new file content line
  *** End Patch

Rules:
  - In update hunks, each normal line should start with a marker: space=context,
    +=add, -=remove. The @@ line is an optional hunk separator.
  - The marker is a patch prefix, not part of the file content. Put the marker
    before the real line text; for an indented line like "  key: value", the
    context patch line is "   key: value" (one marker space plus two content
    spaces).
  - Blank or unmarked hunk lines are tolerated as context, but every one is
    reported in structuredContent.normalizations with patch line number and text.
  - Every hunk must contain at least one + or - line; context-only hunks are
    rejected because they usually mean a marker was forgotten.
  - Hunk matching is line-based: context+removed lines must appear as a
    contiguous subsequence in the current file, searched from the previous
    hunk's position. If the same old block appears multiple times, the first
    match is used and a warning is returned in structuredContent.warnings.
  - Add File content lines must start with +. Delete File and Move are not
    supported by this tool.`,
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
    },
    async (params) => {
      try {
        const toolName = `${options.prefix}_apply_patch`;
        rejectUnexpectedParams(params, patchParams, toolName, {
          command: `${toolName} expects "patch" containing a Codex-style patch, not "command".`,
          content: `${toolName} expects "patch" containing a Codex-style patch, not "content".`,
          script: `${toolName} expects "patch" containing a Codex-style patch, not "script".`,
        });
        const runner = options.makeRunner(params);
        const textEncoding = requestedEncoding(params);
        const parsed = parsePatch(requireStringParam(params, "patch", toolName));
        const operations = parsed.operations;
        const summaries = [];
        const warnings: PatchApplyWarning[] = [];

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
          warnings.push(...applied.warnings);
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
            } catch (error) {
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
            type: "text" as const,
            text: [
              ...summaries.map((item) => {
              const mode = item.dryRun ? "would " : "";
              return `${mode}${item.action} ${item.path} (+${item.added}/-${item.removed}) sha256=${item.sha256}`;
              }),
              ...formatPatchWarnings(parsed.normalizations, warnings),
            ].join("\n"),
          }],
          structuredContent: {
            operations: summaries,
            normalizations: parsed.normalizations,
            warnings,
          },
        };
      } catch (error) {
        return errorResponse(error);
      }
    },
  );

  register(
    `${options.prefix}_list`,
    {
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
    },
    async (params) => {
      try {
        const toolName = `${options.prefix}_list`;
        rejectUnexpectedParams(params, pathParams, toolName);
        const path = resolvePath(params.root, requireStringParam(params, "path", toolName));
        const entries = await listDir(options.makeRunner(params), path);
        return {
          content: [{ type: "text" as const, text: JSON.stringify(entries, null, 2) }],
          structuredContent: { path, entries },
        };
      } catch (error) {
        return errorResponse(error);
      }
    },
  );

  register(
    `${options.prefix}_stat`,
    {
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
    },
    async (params) => {
      try {
        const toolName = `${options.prefix}_stat`;
        rejectUnexpectedParams(params, pathParams, toolName);
        const path = resolvePath(params.root, requireStringParam(params, "path", toolName));
        const info = await statPath(options.makeRunner(params), path);
        return {
          content: [{ type: "text" as const, text: JSON.stringify(info, null, 2) }],
          structuredContent: info,
        };
      } catch (error) {
        return errorResponse(error);
      }
    },
  );

  register(
    `${options.prefix}_search`,
    {
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
    },
    async (params) => {
      try {
        const toolName = `${options.prefix}_search`;
        rejectUnexpectedParams(params, searchParams, toolName);
        const path = resolvePath(params.root, requireStringParam(params, "path", toolName));
        const output = await searchText(options.makeRunner(params), {
          path,
          pattern: requireStringParam(params, "pattern", toolName),
          fixed: fixedSearch(params),
          maxResults: maxResults(params),
          encoding: encoding(params),
        });
        return {
          content: [{ type: "text" as const, text: output }],
          structuredContent: { path, output, requestedEncoding: requestedEncoding(params) },
        };
      } catch (error) {
        return errorResponse(error);
      }
    },
  );

  return handlers;
}
