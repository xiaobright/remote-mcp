#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { errorResponse } from "@remote-mcp/shared/mcp";
import { imagegenConfig, ImageTaskManager, readArtifactBase64, validateConfiguration, } from "./imagegen.js";
const server = new McpServer({ name: "imagegen-mcp-server", version: "0.1.0" });
const manager = new ImageTaskManager();
const modeSchema = z.enum(["sync", "async", "watch"]).default("sync");
const timeoutBehaviorSchema = z.enum(["detach", "kill"]).default("detach");
const commonFields = {
    prompt: z.string().min(1),
    output_name: z.string().min(1).optional(),
    n: z.number().int().min(1).max(10).optional(),
    size: z.string().optional(),
    quality: z.enum(["low", "medium", "high", "auto"]).optional(),
    background: z.enum(["transparent", "opaque", "auto"]).optional(),
    output_format: z.enum(["png", "jpeg", "webp"]).optional(),
    output_compression: z.number().int().min(0).max(100).optional(),
    moderation: z.enum(["auto", "low"]).optional(),
    overwrite: z.boolean().optional(),
    mode: modeSchema,
    timeout_ms: z.number().int().positive().optional(),
    on_timeout: timeoutBehaviorSchema,
};
function snapshotText(snapshot) {
    return `Image task ${snapshot.taskId}: ${snapshot.state} (${snapshot.completed}/${snapshot.total} completed, ${snapshot.failed} failed)`;
}
function responseForSnapshot(snapshot, extra = {}) {
    return {
        content: [{ type: "text", text: snapshotText(snapshot) }],
        structuredContent: { ...snapshot, ...extra },
    };
}
async function responseForResult(taskId, includeImages, maxImages) {
    const snapshot = manager.status(taskId);
    const result = manager.result(taskId);
    const content = [
        { type: "text", text: snapshotText(snapshot) },
    ];
    if (!result)
        return { content, structuredContent: { ...snapshot } };
    const artifacts = "artifacts" in result ? result.artifacts : result.items.flatMap((item) => item.artifacts);
    const limitedArtifacts = artifacts.slice(0, Math.max(0, Math.min(maxImages, 20)));
    if (includeImages) {
        for (const artifact of limitedArtifacts) {
            content.push({ type: "image", data: await readArtifactBase64(artifact.path), mimeType: artifact.mimeType });
        }
    }
    return { content, structuredContent: { ...snapshot, result } };
}
async function runMode(spec, mode, timeoutMs, onTimeout, includeImages = true) {
    const snapshot = manager.start(spec);
    if (mode === "async")
        return responseForSnapshot(snapshot, { nextAction: "Use imagegen_task with action=status, wait, or output." });
    const waitMs = timeoutMs ?? (mode === "sync" ? imagegenConfig.defaultSyncTimeoutMs : imagegenConfig.defaultWatchTimeoutMs);
    const waited = await manager.wait(snapshot.taskId, waitMs);
    if (!waited.completed && (mode === "sync" || onTimeout === "kill")) {
        const cancelled = manager.cancel(snapshot.taskId);
        return responseForSnapshot(cancelled, { timedOut: true, waitedMs: waited.waitedMs });
    }
    if (!waited.completed)
        return responseForSnapshot(waited.snapshot, { timedOut: true, waitedMs: waited.waitedMs, nextAction: "Use imagegen_task with action=wait or output." });
    return responseForResult(snapshot.taskId, includeImages, 10);
}
server.registerTool("imagegen_session", {
    title: "Inspect Image Generation Session",
    description: "Read the image MCP process configuration and current queue state. API keys are never returned.",
    inputSchema: z.object({ action: z.enum(["status", "validate"]) }).strict(),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
}, async (params) => {
    try {
        if (params.action === "validate")
            validateConfiguration();
        return {
            content: [{ type: "text", text: params.action === "validate" ? "Image API configuration is valid." : "Image generation session configuration." }],
            structuredContent: {
                baseUrl: imagegenConfig.baseUrl,
                model: imagegenConfig.model,
                outputDir: imagegenConfig.outputDir,
                concurrency: imagegenConfig.concurrency,
                maxAttempts: imagegenConfig.maxAttempts,
                ...manager.getActiveState(),
            },
        };
    }
    catch (error) {
        return errorResponse(error);
    }
});
server.registerTool("imagegen_generate", {
    title: "Generate Image",
    description: "Generate one or more variants from a text prompt. API credentials and model selection are controlled by the MCP environment. Use mode=async for long-running requests.",
    inputSchema: z.object(commonFields).strict(),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
}, async (params) => {
    try {
        const { mode, timeout_ms, on_timeout, ...rest } = params;
        const spec = { operation: "generate", prompt: rest.prompt, outputName: rest.output_name, n: rest.n, size: rest.size, quality: rest.quality, background: rest.background, outputFormat: rest.output_format, outputCompression: rest.output_compression, moderation: rest.moderation, overwrite: rest.overwrite };
        return await runMode(spec, mode, timeout_ms, on_timeout);
    }
    catch (error) {
        return errorResponse(error);
    }
});
server.registerTool("imagegen_edit", {
    title: "Edit Image",
    description: "Edit or combine one or more local image files. Use image_paths for source/reference images and mask_path for an optional mask. Use mode=async for long-running requests.",
    inputSchema: z.object({ ...commonFields, image_paths: z.array(z.string().min(1)).min(1).max(16), mask_path: z.string().min(1).optional() }).strict(),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
}, async (params) => {
    try {
        const { mode, timeout_ms, on_timeout, ...rest } = params;
        const spec = { operation: "edit", prompt: rest.prompt, imagePaths: rest.image_paths, maskPath: rest.mask_path, outputName: rest.output_name, n: rest.n, size: rest.size, quality: rest.quality, background: rest.background, outputFormat: rest.output_format, outputCompression: rest.output_compression, moderation: rest.moderation, overwrite: rest.overwrite };
        return await runMode(spec, mode, timeout_ms, on_timeout);
    }
    catch (error) {
        return errorResponse(error);
    }
});
const batchItem = z.object({
    id: z.string().min(1).optional(),
    operation: z.enum(["generate", "edit"]),
    prompt: z.string().min(1),
    image_paths: z.array(z.string().min(1)).min(1).max(16).optional(),
    mask_path: z.string().min(1).optional(),
    output_name: z.string().min(1).optional(),
    n: z.number().int().min(1).max(10).optional(),
    size: z.string().optional(),
    quality: z.enum(["low", "medium", "high", "auto"]).optional(),
    background: z.enum(["transparent", "opaque", "auto"]).optional(),
    output_format: z.enum(["png", "jpeg", "webp"]).optional(),
    output_compression: z.number().int().min(0).max(100).optional(),
    moderation: z.enum(["auto", "low"]).optional(),
    overwrite: z.boolean().optional(),
}).strict();
server.registerTool("imagegen_batch", {
    title: "Batch Generate or Edit Images",
    description: "Submit a mixed batch of generation and edit jobs. Each item explicitly chooses operation=generate or operation=edit. The server controls API access, model, retries, and concurrency from environment variables.",
    inputSchema: z.object({ jobs: z.array(batchItem).min(1).max(500), mode: modeSchema, timeout_ms: z.number().int().positive().optional(), on_timeout: timeoutBehaviorSchema }).strict(),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
}, async (params) => {
    try {
        const specs = params.jobs.map((job) => ({ id: job.id, operation: job.operation, prompt: job.prompt, imagePaths: job.image_paths, maskPath: job.mask_path, outputName: job.output_name, n: job.n, size: job.size, quality: job.quality, background: job.background, outputFormat: job.output_format, outputCompression: job.output_compression, moderation: job.moderation, overwrite: job.overwrite }));
        return await runMode(specs, params.mode, params.timeout_ms, params.on_timeout, false);
    }
    catch (error) {
        return errorResponse(error);
    }
});
server.registerTool("imagegen_task", {
    title: "Manage Image Generation Task",
    description: "Manage image tasks using actions status, output, wait, cancel, and list. Use output with include_images=true only when the generated images should be returned into model context.",
    inputSchema: z.object({
        action: z.enum(["status", "output", "wait", "cancel", "list"]),
        taskId: z.string().min(1).optional(),
        wait_ms: z.number().int().positive().optional(),
        include_images: z.boolean().optional(),
        max_images: z.number().int().positive().max(20).optional(),
    }).strict(),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
}, async (params) => {
    try {
        if (params.action === "list")
            return { content: [{ type: "text", text: manager.list().map(snapshotText).join("\n") || "No image tasks." }], structuredContent: { tasks: manager.list() } };
        if (!params.taskId)
            throw new Error(`taskId is required for action=${params.action}`);
        if (params.action === "status")
            return responseForSnapshot(manager.status(params.taskId));
        if (params.action === "cancel")
            return responseForSnapshot(manager.cancel(params.taskId));
        if (params.action === "output")
            return await responseForResult(params.taskId, params.include_images ?? true, params.max_images ?? 10);
        const waited = await manager.wait(params.taskId, params.wait_ms ?? imagegenConfig.defaultWatchTimeoutMs);
        if (!waited.completed)
            return responseForSnapshot(waited.snapshot, { timedOut: true, waitedMs: waited.waitedMs });
        return await responseForResult(params.taskId, params.include_images ?? true, params.max_images ?? 10);
    }
    catch (error) {
        return errorResponse(error);
    }
});
async function main() {
    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.error(`imagegen-mcp-server running via stdio (model=${imagegenConfig.model}, concurrency=${imagegenConfig.concurrency})`);
}
main().catch((error) => { console.error("Fatal error:", error); process.exit(1); });
//# sourceMappingURL=index.js.map