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
  .describe('Text encoding, default "auto" (utf-8/gbk/gb18030).');

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

// ---------------------------------------------------------------------------
// Action handlers (shared by legacy per-tool registration and unified tool)
// ---------------------------------------------------------------------------

async function handleRead(params: Record<string, unknown>, options: RegisterRemoteFileToolsOptions) {
  const toolName = `${options.prefix}_read`;
  rejectUnexpectedParams(params, [...Object.keys(commonFields(options)), "path", "max_bytes", "encoding"], toolName, );
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
}

async function handleWrite(params: Record<string, unknown>, options: RegisterRemoteFileToolsOptions) {
  const toolName = `${options.prefix}_write`;
  rejectUnexpectedParams(params, [...Object.keys(commonFields(options)), "path", "content", "create_parents", "overwrite", "expected_sha256", "mode", "encoding"], toolName, );
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
}

async function handleEdit(params: Record<string, unknown>, options: RegisterRemoteFileToolsOptions) {
  const toolName = `${options.prefix}_edit`;
  rejectUnexpectedParams(params, [...Object.keys(commonFields(options)), "path", "old_string", "new_string", "replace_all", "oldString", "newString", "replaceAll", "dry_run", "expected_sha256", "max_bytes", "encoding"], toolName, );
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
}

async function handleApplyPatch(params: Record<string, unknown>, options: RegisterRemoteFileToolsOptions) {
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
  const warnings: PatchApplyWarning[] = [];

  type PlannedOp =
    | {
      kind: "add";
      path: string;
      content: string;
      encoding: string;
      added: number;
      summary: Record<string, unknown>;
    }
    | {
      kind: "update";
      path: string;
      content: string;
      encoding: string;
      expectedSha256: string;
      added: number;
      removed: number;
      summary: Record<string, unknown>;
    };

  const planned: PlannedOp[] = [];

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
      planned.push({
        kind: "add",
        path,
        content,
        encoding: writeEncoding,
        added: operation.lines?.length ?? 0,
        summary: {
          path,
          action: "add",
          added: operation.lines?.length ?? 0,
          removed: 0,
          bytes: bytes.length,
          sha256: sha256Bytes(bytes),
          dryRun,
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
    planned.push({
      kind: "update",
      path,
      content: applied.text,
      encoding: original.encoding,
      expectedSha256: original.sha256,
      added: applied.added,
      removed: applied.removed,
      summary: {
        path,
        action: "update",
        added: applied.added,
        removed: applied.removed,
        bytes: bytes.length,
        sha256: sha256Bytes(bytes),
        dryRun,
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
        } else {
          await writeTextFile(runner, {
            path: item.path,
            content: item.content,
            overwrite: true,
            createParents: false,
            expectedSha256: item.expectedSha256,
            encoding: item.encoding,
          });
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (item.kind === "update" && message.includes("sha256 mismatch")) {
          const current = await readTextFileDecoded(runner, item.path, {
            maxBytes: maxBytes(params),
            encoding: textEncoding,
          });
          return shaMismatchResponse(item.path, item.expectedSha256, current);
        }
        throw new Error(
          `${message} (patch write phase failed at ${item.path}; earlier files in this patch may already have been written)`,
        );
      }
    }
  }

  const summaries = planned.map((item) => item.summary);

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
}

async function handleList(params: Record<string, unknown>, options: RegisterRemoteFileToolsOptions) {
  const toolName = `${options.prefix}_list`;
  rejectUnexpectedParams(params, [...Object.keys(commonFields(options)), "path"], toolName, );
  const path = resolvePath(params.root, requireStringParam(params, "path", toolName));
  const entries = await listDir(options.makeRunner(params), path);
  return {
    content: [{ type: "text" as const, text: JSON.stringify(entries, null, 2) }],
    structuredContent: { path, entries },
  };
}

async function handleStat(params: Record<string, unknown>, options: RegisterRemoteFileToolsOptions) {
  const toolName = `${options.prefix}_stat`;
  rejectUnexpectedParams(params, [...Object.keys(commonFields(options)), "path"], toolName, );
  const path = resolvePath(params.root, requireStringParam(params, "path", toolName));
  const info = await statPath(options.makeRunner(params), path);
  return {
    content: [{ type: "text" as const, text: JSON.stringify(info, null, 2) }],
    structuredContent: info,
  };
}

async function handleSearch(params: Record<string, unknown>, options: RegisterRemoteFileToolsOptions) {
  const toolName = `${options.prefix}_search`;
  rejectUnexpectedParams(params, [...Object.keys(commonFields(options)), "path", "pattern", "fixed", "max_results", "encoding"], toolName, );
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
}

const actionHandlers: Record<string, (params: Record<string, unknown>, options: RegisterRemoteFileToolsOptions) => Promise<any>> = {
  read: handleRead,
  write: handleWrite,
  edit: handleEdit,
  apply_patch: handleApplyPatch,
  list: handleList,
  stat: handleStat,
  search: handleSearch,
};

// ---------------------------------------------------------------------------
// Legacy registration: one tool per operation (ssh_file_read, wsl_file_write, ...)
// ---------------------------------------------------------------------------

export function registerRemoteFileTools(options: RegisterRemoteFileToolsOptions): Record<string, RemoteFileToolHandler> {
  const common = commonFields(options);
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
Encoding defaults to auto: UTF-8 preferred, legacy encodings (GBK/GB18030) tried when UTF-8 invalid. Full text in structuredContent.text.`,
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
        return await handleRead(params, options);
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
Encoding auto: new files UTF-8; overwriting an existing text file preserves its detected encoding. Pass encoding to force.`,
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
        return await handleWrite(params, options);
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
old_string must match exactly once unless replace_all=true (errors instead of guessing). Encoding auto, preserves source encoding.`,
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
        return await handleEdit(params, options);
      } catch (error) {
        return errorResponse(error);
      }
    },
  );

  register(
    `${options.prefix}_apply_patch`,
    {
      title: `${options.titlePrefix} Apply Patch`,
      description: `Apply a Codex-style patch to remote files (Add File / Update File; Delete/Move unsupported). ${options.targetDescription}
Multi-file edits; focused single-file replacements should use ${options.prefix}_edit.
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
Update hunk lines need a marker each: space=context, +=added, -=removed.`,
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
        return await handleApplyPatch(params, options);
      } catch (error) {
        return errorResponse(error);
      }
    },
  );

  register(
    `${options.prefix}_list`,
    {
      title: `${options.titlePrefix} List Directory`,
      description: `List a remote directory (name, type, size, mtime when available). ${options.targetDescription}`,
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
        return await handleList(params, options);
      } catch (error) {
        return errorResponse(error);
      }
    },
  );

  register(
    `${options.prefix}_stat`,
    {
      title: `${options.titlePrefix} Stat Path`,
      description: `Inspect a remote path: existence, type, size, mode, mtime. ${options.targetDescription}`,
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
        return await handleStat(params, options);
      } catch (error) {
        return errorResponse(error);
      }
    },
  );

  register(
    `${options.prefix}_search`,
    {
      title: `${options.titlePrefix} Search Text`,
      description: `Search remote text files with grep. ${options.targetDescription}
fixed=true uses grep -F; ASCII patterns are the most portable across remote locales.`,
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
        return await handleSearch(params, options);
      } catch (error) {
        return errorResponse(error);
      }
    },
  );

  return handlers;
}

// ---------------------------------------------------------------------------
// Unified registration: one tool per backend ({prefix}, e.g. ssh_file / wsl_file)
// selected by REMOTE_MCP_FILE_API=unified. Reuses the same action handlers.
// ---------------------------------------------------------------------------

const unifiedActionEnum = z.enum(["read", "write", "edit", "apply_patch", "list", "stat", "search"]);

function unifiedSchema(options: RegisterRemoteFileToolsOptions) {
  const common = commonFields(options);
  return z.object({
    action: unifiedActionEnum,
    ...common,
    path: pathField,
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
  }).strict().superRefine((val, ctx) => {
    const required: Record<string, string[]> = {
      read: ["path"],
      write: ["path", "content"],
      edit: ["path", "old_string", "new_string"],
      apply_patch: ["patch"],
      list: ["path"],
      stat: ["path"],
      search: ["path", "pattern"],
    };
    const record = val as unknown as Record<string, unknown>;
    for (const field of required[record.action as string] ?? []) {
      if (record[field] === undefined) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: `action=${record.action} requires "${field}"`, path: [field] });
      }
    }
  });
}

export function registerUnifiedRemoteFileTools(options: RegisterRemoteFileToolsOptions): Record<string, RemoteFileToolHandler> {
  const toolName = options.prefix; // e.g. ssh_file / wsl_file
  const handler: RemoteFileToolHandler = async (params) => {
    const action = params.action as string;
    const impl = actionHandlers[action];
    if (!impl) {
      return errorResponse(new Error(`Unknown ${toolName} action: ${action}`));
    }
    try {
      // In unified mode the tool name reported to handlers should be the
      // action tool name so existing messages stay consistent.
      return await impl(params, { ...options, prefix: `${options.prefix}_${action}` });
    } catch (error) {
      return errorResponse(error);
    }
  };
  options.server.registerTool(
    toolName,
    {
      title: `${options.titlePrefix} File Operations (unified)`,
      description: `Remote file operations. ${options.targetDescription}
action selects the operation:
  read(path, max_bytes?, encoding?) - read text file (text in structuredContent.text)
  write(path, content, create_parents?, overwrite?, expected_sha256?, mode?, encoding?) - write text file
  edit(path, old_string, new_string, replace_all?, dry_run?, expected_sha256?, max_bytes?, encoding?) - replace exact text once
  apply_patch(patch, dry_run?, max_bytes?, encoding?) - Codex-style patch (Add/Update File; format: *** Begin Patch / *** Update File: <path> / @@ / space=context, -=removed, +=added / *** Add File: <path> / *** End Patch)
  list(path) - list directory
  stat(path) - inspect path
  search(path, pattern, fixed?, max_results?, encoding?) - grep search
Encoding defaults to auto (UTF-8 preferred; GBK/GB18030 fallback; overwrites preserve existing encoding).`,
      inputSchema: unifiedSchema(options),
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    handler,
  );
  return { [toolName]: handler };
}
