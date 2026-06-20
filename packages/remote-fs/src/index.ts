#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { applyUpdatePatch, parsePatch, textForAddedFile } from "./patch.js";
import {
  listDir,
  readTextFile,
  searchText,
  sha256Text,
  statPath,
  writeTextFile,
} from "./remoteOps.js";
import { joinRemotePath } from "./shell.js";
import { type RemoteTarget } from "./transport.js";

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

function errorResponse(error: unknown) {
  const msg = error instanceof Error ? error.message : String(error);
  return { content: [{ type: "text" as const, text: `Error: ${msg}` }], isError: true };
}

function targetFrom(params: {
  transport: "wsl" | "ssh";
  target?: string;
  distro?: string;
  ssh_options?: string[];
  timeout_ms?: number;
}): RemoteTarget {
  return {
    transport: params.transport,
    target: params.target,
    distro: params.distro,
    ssh_options: params.ssh_options,
    timeout_ms: params.timeout_ms,
  };
}

function resolvePath(root: string | undefined, path: string): string {
  const resolved = joinRemotePath(root, path);
  if (!resolved.trim()) {
    throw new Error("path is required");
  }
  return resolved;
}

server.registerTool(
  "remote_file_read",
  {
    title: "Read Remote File",
    description: `Read a UTF-8 text file over SSH or WSL.

This is for observation. It does not require Python or Node on the remote host;
the remote side only needs a basic POSIX shell plus cat/wc.`,
    inputSchema: z.object({
      ...targetFields,
      path: z.string().min(1).describe("Remote file path. Relative paths are joined with root when root is set."),
      max_bytes: z.number().int().positive().default(5 * 1024 * 1024).describe("Maximum file size to read."),
    }).strict(),
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  async (params: {
    transport: "wsl" | "ssh";
    target?: string;
    distro?: string;
    ssh_options?: string[];
    timeout_ms?: number;
    root?: string;
    path: string;
    max_bytes?: number;
  }) => {
    try {
      const path = resolvePath(params.root, params.path);
      const content = await readTextFile(targetFrom(params), path, params.max_bytes);
      const structuredContent = {
        path,
        content,
        bytes: Buffer.byteLength(content, "utf8"),
        sha256: sha256Text(content),
      };
      return {
        content: [{ type: "text" as const, text: content }],
        structuredContent,
      };
    } catch (error) {
      return errorResponse(error);
    }
  },
);

server.registerTool(
  "remote_file_write",
  {
    title: "Write Remote File",
    description: `Atomically write a UTF-8 text file over SSH or WSL.

Content is base64-encoded locally and decoded by the remote shell into a temp
file, then moved into place. Use expected_sha256 when replacing a file that was
previously read.`,
    inputSchema: z.object({
      ...targetFields,
      path: z.string().min(1).describe("Remote file path. Relative paths are joined with root when root is set."),
      content: z.string().describe("UTF-8 text content to write."),
      overwrite: z.boolean().default(true).describe("Whether to overwrite an existing path."),
      create_parents: z.boolean().default(true).describe("Create parent directories before writing."),
      expected_sha256: z.string().optional().describe("Optional sha256 of the current remote file before writing."),
      mode: z.string().optional().describe('Optional chmod mode for the written file, e.g. "644".'),
    }).strict(),
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    },
  },
  async (params: {
    transport: "wsl" | "ssh";
    target?: string;
    distro?: string;
    ssh_options?: string[];
    timeout_ms?: number;
    root?: string;
    path: string;
    content: string;
    overwrite?: boolean;
    create_parents?: boolean;
    expected_sha256?: string;
    mode?: string;
  }) => {
    try {
      const path = resolvePath(params.root, params.path);
      const result = await writeTextFile(targetFrom(params), {
        path,
        content: params.content,
        overwrite: params.overwrite,
        createParents: params.create_parents,
        expectedSha256: params.expected_sha256,
        mode: params.mode,
      });
      return {
        content: [{
          type: "text" as const,
          text: `Wrote ${result.bytes} bytes to ${path}\nsha256: ${result.sha256}`,
        }],
        structuredContent: { path, ...result },
      };
    } catch (error) {
      return errorResponse(error);
    }
  },
);

server.registerTool(
  "remote_file_apply_patch",
  {
    title: "Apply Remote Patch",
    description: `Apply a text patch to remote files over SSH or WSL.

Patch parsing and hunk matching run locally. The remote host only performs
basic reads and atomic writes. Supported directives: *** Add File and
*** Update File. Delete and move patches are intentionally unsupported.`,
    inputSchema: z.object({
      ...targetFields,
      patch: z.string().min(1).describe("Patch text using the Codex-style *** Begin Patch format."),
      dry_run: z.boolean().default(false).describe("Compute the patch without writing remote files."),
      max_bytes: z.number().int().positive().default(5 * 1024 * 1024).describe("Maximum size for each file read."),
    }).strict(),
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    },
  },
  async (params: {
    transport: "wsl" | "ssh";
    target?: string;
    distro?: string;
    ssh_options?: string[];
    timeout_ms?: number;
    root?: string;
    patch: string;
    dry_run?: boolean;
    max_bytes?: number;
  }) => {
    try {
      const target = targetFrom(params);
      const operations = parsePatch(params.patch);
      const summaries = [];

      for (const operation of operations) {
        const path = resolvePath(params.root, operation.path);
        if (operation.kind === "add") {
          const content = textForAddedFile(operation.lines ?? []);
          if (!params.dry_run) {
            await writeTextFile(target, {
              path,
              content,
              overwrite: false,
              createParents: true,
            });
          }
          summaries.push({
            path,
            action: "add",
            added: operation.lines?.length ?? 0,
            removed: 0,
            bytes: Buffer.byteLength(content, "utf8"),
            sha256: sha256Text(content),
            dryRun: params.dry_run ?? false,
          });
          continue;
        }

        const original = await readTextFile(target, path, params.max_bytes);
        const originalSha256 = sha256Text(original);
        const applied = applyUpdatePatch(original, operation.hunks ?? [], path);
        if (!params.dry_run) {
          await writeTextFile(target, {
            path,
            content: applied.text,
            overwrite: true,
            createParents: false,
            expectedSha256: originalSha256,
          });
        }
        summaries.push({
          path,
          action: "update",
          added: applied.added,
          removed: applied.removed,
          bytes: Buffer.byteLength(applied.text, "utf8"),
          oldSha256: originalSha256,
          sha256: sha256Text(applied.text),
          dryRun: params.dry_run ?? false,
        });
      }

      return {
        content: [{
          type: "text" as const,
          text: summaries.map((item) =>
            `${item.dryRun ? "Would apply" : "Applied"} ${item.action} ${item.path} (+${item.added}/-${item.removed})`,
          ).join("\n"),
        }],
        structuredContent: { files: summaries },
      };
    } catch (error) {
      return errorResponse(error);
    }
  },
);

server.registerTool(
  "remote_file_list",
  {
    title: "List Remote Directory",
    description: "List a remote directory over SSH or WSL using basic shell tools.",
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
  },
  async (params: {
    transport: "wsl" | "ssh";
    target?: string;
    distro?: string;
    ssh_options?: string[];
    timeout_ms?: number;
    root?: string;
    path: string;
  }) => {
    try {
      const path = resolvePath(params.root, params.path);
      const entries = await listDir(targetFrom(params), path);
      return {
        content: [{
          type: "text" as const,
          text: entries.map((entry) => `${entry.type}\t${entry.size ?? ""}\t${entry.name}`).join("\n") || "(empty)",
        }],
        structuredContent: { path, entries },
      };
    } catch (error) {
      return errorResponse(error);
    }
  },
);

server.registerTool(
  "remote_file_stat",
  {
    title: "Stat Remote Path",
    description: "Inspect a remote path over SSH or WSL.",
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
  },
  async (params: {
    transport: "wsl" | "ssh";
    target?: string;
    distro?: string;
    ssh_options?: string[];
    timeout_ms?: number;
    root?: string;
    path: string;
  }) => {
    try {
      const path = resolvePath(params.root, params.path);
      const info = await statPath(targetFrom(params), path);
      return {
        content: [{ type: "text" as const, text: JSON.stringify(info, null, 2) }],
        structuredContent: info,
      };
    } catch (error) {
      return errorResponse(error);
    }
  },
);

server.registerTool(
  "remote_file_search",
  {
    title: "Search Remote Text",
    description: "Search remote text files over SSH or WSL using grep.",
    inputSchema: z.object({
      ...targetFields,
      path: z.string().min(1).describe("Remote path to search. Relative paths are joined with root when root is set."),
      pattern: z.string().min(1).describe("Search pattern."),
      fixed: z.boolean().default(true).describe("Use fixed-string search instead of grep regex."),
      max_results: z.number().int().positive().default(100).describe("Maximum matching lines to return."),
    }).strict(),
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  async (params: {
    transport: "wsl" | "ssh";
    target?: string;
    distro?: string;
    ssh_options?: string[];
    timeout_ms?: number;
    root?: string;
    path: string;
    pattern: string;
    fixed?: boolean;
    max_results?: number;
  }) => {
    try {
      const path = resolvePath(params.root, params.path);
      const output = await searchText(targetFrom(params), {
        path,
        pattern: params.pattern,
        fixed: params.fixed,
        maxResults: params.max_results,
      });
      return {
        content: [{ type: "text" as const, text: output || "(no matches)" }],
        structuredContent: { path, output },
      };
    } catch (error) {
      return errorResponse(error);
    }
  },
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("remote-fs-mcp-server running via stdio");
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
