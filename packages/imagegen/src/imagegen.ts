import { randomUUID } from "node:crypto";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync, readFileSync as readFileSyncFs } from "node:fs";
import { basename, dirname, extname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

function loadDotEnv(path: string | undefined): void {
  if (!path || !existsSync(path)) {
    return;
  }

  for (const raw of readFileSyncFs(path, "utf8").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) {
      continue;
    }
    const separator = line.indexOf("=");
    if (separator <= 0) {
      continue;
    }
    const name = line.slice(0, separator).trim();
    const value = line.slice(separator + 1).trim().replace(/^['"]|['"]$/g, "");
    if (name && process.env[name] === undefined) {
      process.env[name] = value;
    }
  }
}

const packageEnvFile = resolve(dirname(fileURLToPath(import.meta.url)), "..", ".env");
loadDotEnv(process.env.IMAGEGEN_MCP_ENV_FILE ?? packageEnvFile);

function positiveInt(name: string, fallback: number, max?: number): number {
  const value = Number.parseInt(process.env[name] ?? "", 10);
  if (!Number.isFinite(value) || value < 1) {
    return fallback;
  }
  return max ? Math.min(value, max) : value;
}

export const imagegenConfig = {
  apiKey: process.env.OPENAI_API_KEY ?? "",
  baseUrl: (process.env.OPENAI_BASE_URL ?? "https://api.openai.com/v1").replace(/\/+$/, ""),
  model: process.env.IMAGEGEN_MCP_MODEL ?? "gpt-image-2",
  outputDir: resolve(process.env.IMAGEGEN_MCP_OUTPUT_DIR ?? resolve(process.cwd(), "output", "imagegen")),
  concurrency: positiveInt("IMAGEGEN_MCP_CONCURRENCY", 3, 25),
  maxAttempts: positiveInt("IMAGEGEN_MCP_MAX_ATTEMPTS", 3, 10),
  requestTimeoutMs: positiveInt("IMAGEGEN_MCP_REQUEST_TIMEOUT_MS", 600_000),
  defaultSyncTimeoutMs: positiveInt("IMAGEGEN_MCP_DEFAULT_SYNC_TIMEOUT_MS", 600_000),
  defaultWatchTimeoutMs: positiveInt("IMAGEGEN_MCP_DEFAULT_WATCH_TIMEOUT_MS", 120_000),
  minPollIntervalMs: positiveInt("IMAGEGEN_MCP_MIN_POLL_INTERVAL_MS", 20_000),
  maxFinishedTasks: positiveInt("IMAGEGEN_MCP_MAX_FINISHED_TASKS", 100),
};

export type ImageOperation = "generate" | "edit";
export type ImageTaskState = "queued" | "running" | "completed" | "failed" | "cancelled";

export interface ImageJobSpec {
  id?: string;
  operation: ImageOperation;
  prompt: string;
  imagePaths?: string[];
  maskPath?: string;
  outputName?: string;
  n?: number;
  size?: string;
  quality?: string;
  background?: string;
  outputFormat?: string;
  outputCompression?: number;
  moderation?: string;
  overwrite?: boolean;
}

export interface ImageArtifact {
  path: string;
  mimeType: string;
  bytes: number;
}

export interface ImageJobResult {
  operation: ImageOperation;
  prompt: string;
  artifacts: ImageArtifact[];
}

export interface BatchItemResult {
  id: string;
  operation: ImageOperation;
  prompt: string;
  state: "completed" | "failed";
  artifacts: ImageArtifact[];
  error?: string;
}

export interface BatchResult {
  items: BatchItemResult[];
  completed: number;
  failed: number;
}

export interface ImageTaskSnapshot {
  taskId: string;
  state: ImageTaskState;
  kind: "image" | "batch";
  operation: ImageOperation | "batch";
  createdAt: string;
  startedAt: string | null;
  endedAt: string | null;
  error: string | null;
  total: number;
  completed: number;
  failed: number;
  outputDir: string;
}

interface ManagedImageTask {
  taskId: string;
  state: ImageTaskState;
  kind: "image" | "batch";
  operation: ImageOperation | "batch";
  createdAt: string;
  startedAt: string | null;
  endedAt: string | null;
  error: string | null;
  total: number;
  completed: number;
  failed: number;
  weight: number;
  spec: ImageJobSpec | ImageJobSpec[];
  controller: AbortController;
  result: ImageJobResult | BatchResult | null;
  finished: Promise<void>;
  resolveFinished: () => void;
}

function nowIso(): string {
  return new Date().toISOString();
}

function mimeTypeFor(path: string): string {
  switch (extname(path).toLowerCase()) {
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".webp":
      return "image/webp";
    default:
      return "image/png";
  }
}

function normalizeFormat(format: string | undefined): string {
  const value = (format ?? "png").toLowerCase().replace(/^\./, "");
  if (!["png", "jpeg", "webp"].includes(value)) {
    throw new Error(`Unsupported output format: ${format}`);
  }
  return value;
}

function extensionFor(format: string): string {
  return format === "jpeg" ? "jpg" : format;
}

function safeOutputName(name: string | undefined, taskId: string, index: number, total: number, format: string): string {
  const extension = extensionFor(format);
  const raw = name?.trim() || `${taskId}-${index}`;
  if (basename(raw) !== raw || raw.includes("..") || raw.includes("/") || raw.includes("\\")) {
    throw new Error("outputName must be a file name inside IMAGEGEN_MCP_OUTPUT_DIR");
  }
  const withoutExtension = raw.replace(/\.(png|jpe?g|webp)$/i, "");
  const suffix = total > 1 ? `-${index}` : "";
  return `${withoutExtension}${suffix}.${extension}`;
}

function requestFields(spec: ImageJobSpec): Record<string, string | number> {
  const fields: Record<string, string | number> = {
    n: spec.n ?? 1,
    size: spec.size ?? "1024x1024",
    quality: spec.quality ?? "medium",
  };
  if (spec.background) fields.background = spec.background;
  if (spec.outputFormat) fields.output_format = normalizeFormat(spec.outputFormat);
  if (typeof spec.outputCompression === "number") fields.output_compression = spec.outputCompression;
  if (spec.moderation) fields.moderation = spec.moderation;
  return fields;
}

function validateSpec(spec: ImageJobSpec): void {
  if (!spec.prompt.trim()) throw new Error("prompt is required");
  const n = spec.n ?? 1;
  if (!Number.isInteger(n) || n < 1 || n > 10) throw new Error("n must be between 1 and 10");
  if (spec.operation === "edit" && (!spec.imagePaths || spec.imagePaths.length === 0)) {
    throw new Error("edit requires at least one image path");
  }
  for (const imagePath of spec.imagePaths ?? []) {
    if (!existsSync(imagePath)) throw new Error(`Image file not found: ${imagePath}`);
  }
  if (spec.maskPath && !existsSync(spec.maskPath)) throw new Error(`Mask file not found: ${spec.maskPath}`);
  normalizeFormat(spec.outputFormat);
}

function buildUrl(path: string): string {
  return `${imagegenConfig.baseUrl}/${path.replace(/^\/+/, "")}`;
}

async function parseApiResponse(response: Response): Promise<{ data?: Array<{ b64_json?: string }> }> {
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`Image API ${response.status}: ${text.slice(0, 1000)}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`Image API returned invalid JSON: ${text.slice(0, 500)}`);
  }
  if (!parsed || typeof parsed !== "object") throw new Error("Image API returned an invalid response");
  return parsed as { data?: Array<{ b64_json?: string }> };
}

async function fetchWithRetry(url: string, init: RequestInit, label: string): Promise<{ data?: Array<{ b64_json?: string }> }> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= imagegenConfig.maxAttempts; attempt += 1) {
    const controller = init.signal as AbortSignal | undefined;
    const timeout = new AbortController();
    const timer = setTimeout(() => timeout.abort(), imagegenConfig.requestTimeoutMs);
    try {
      const response = await fetch(url, {
        ...init,
        signal: controller ? AbortSignal.any([controller, timeout.signal]) : timeout.signal,
      });
      if (response.ok) return await parseApiResponse(response);
      const body = await response.text();
      const retryable = response.status === 408 || response.status === 409 || response.status === 429 || response.status >= 500;
      lastError = new Error(`Image API ${response.status}: ${body.slice(0, 1000)}`);
      if (!retryable || attempt === imagegenConfig.maxAttempts) throw lastError;
      const retryAfter = Number.parseFloat(response.headers.get("retry-after") ?? "");
      const delayMs = Number.isFinite(retryAfter) ? Math.min(retryAfter * 1000, 60_000) : Math.min(60_000, 2 ** attempt * 1000);
      await new Promise((resolveDelay, rejectDelay) => {
        const timerId = setTimeout(resolveDelay, delayMs);
        controller?.addEventListener("abort", () => { clearTimeout(timerId); rejectDelay(new Error("cancelled")); }, { once: true });
      });
    } catch (error) {
      lastError = error;
      if (controller?.aborted || (error instanceof Error && error.message === "cancelled")) throw error;
      if (attempt === imagegenConfig.maxAttempts) throw new Error(`${label}: ${error instanceof Error ? error.message : String(error)}`);
      await new Promise((resolveDelay) => setTimeout(resolveDelay, Math.min(60_000, 2 ** attempt * 1000)));
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastError instanceof Error ? lastError : new Error(`${label}: request failed`);
}

async function callGenerate(spec: ImageJobSpec, signal: AbortSignal): Promise<string[]> {
  const payload: Record<string, unknown> = {
    model: imagegenConfig.model,
    prompt: spec.prompt,
    ...requestFields(spec),
  };
  const response = await fetchWithRetry(buildUrl("images/generations"), {
    method: "POST",
    headers: {
      Authorization: `Bearer ${imagegenConfig.apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
    signal,
  }, "generation");
  return (response.data ?? []).map((item) => item.b64_json ?? "").filter(Boolean);
}

async function callEdit(spec: ImageJobSpec, signal: AbortSignal): Promise<string[]> {
  const form = new FormData();
  form.append("model", imagegenConfig.model);
  form.append("prompt", spec.prompt);
  for (const [key, value] of Object.entries(requestFields(spec))) form.append(key, String(value));
  for (const imagePath of spec.imagePaths ?? []) {
    const bytes = await readFile(imagePath);
    form.append("image", new Blob([bytes], { type: mimeTypeFor(imagePath) }), basename(imagePath));
  }
  if (spec.maskPath) {
    const bytes = await readFile(spec.maskPath);
    form.append("mask", new Blob([bytes], { type: mimeTypeFor(spec.maskPath) }), basename(spec.maskPath));
  }
  const response = await fetchWithRetry(buildUrl("images/edits"), {
    method: "POST",
    headers: { Authorization: `Bearer ${imagegenConfig.apiKey}` },
    body: form,
    signal,
  }, "edit");
  return (response.data ?? []).map((item) => item.b64_json ?? "").filter(Boolean);
}

async function writeArtifacts(spec: ImageJobSpec, taskId: string, images: string[]): Promise<ImageArtifact[]> {
  if (images.length === 0) throw new Error("Image API returned no image data");
  await mkdir(imagegenConfig.outputDir, { recursive: true });
  const format = normalizeFormat(spec.outputFormat);
  const artifacts: ImageArtifact[] = [];
  for (let index = 0; index < images.length; index += 1) {
    const name = safeOutputName(spec.outputName, taskId, index + 1, images.length, format);
    const path = resolve(imagegenConfig.outputDir, name);
    const bytes = Buffer.from(images[index], "base64");
    if (!spec.overwrite && existsSync(path)) throw new Error(`Output already exists: ${path}`);
    await writeFile(path, bytes, { flag: spec.overwrite ? "w" : "wx" });
    artifacts.push({ path, mimeType: `image/${format === "jpg" ? "jpeg" : format}`, bytes: bytes.length });
  }
  return artifacts;
}

async function executeOne(spec: ImageJobSpec, taskId: string, signal: AbortSignal): Promise<ImageJobResult> {
  validateSpec(spec);
  if (!imagegenConfig.apiKey) throw new Error("OPENAI_API_KEY is not set");
  const images = spec.operation === "edit" ? await callEdit(spec, signal) : await callGenerate(spec, signal);
  return { operation: spec.operation, prompt: spec.prompt, artifacts: await writeArtifacts(spec, taskId, images) };
}

async function executeBatch(specs: ImageJobSpec[], taskId: string, signal: AbortSignal): Promise<BatchResult> {
  const results: BatchItemResult[] = new Array(specs.length);
  let nextIndex = 0;
  const worker = async (): Promise<void> => {
    while (true) {
      if (signal.aborted) throw new Error("cancelled");
      const index = nextIndex++;
      if (index >= specs.length) return;
      const spec = specs[index];
      const id = spec.id ?? spec.outputName ?? `item-${index + 1}`;
      try {
        const result = await executeOne(spec, `${taskId}-${index + 1}`, signal);
        results[index] = { id, operation: spec.operation, prompt: spec.prompt, state: "completed", artifacts: result.artifacts };
      } catch (error) {
        if (signal.aborted) throw error;
        results[index] = { id, operation: spec.operation, prompt: spec.prompt, state: "failed", artifacts: [], error: error instanceof Error ? error.message : String(error) };
      }
    }
  };
  const workers = Array.from({ length: Math.min(imagegenConfig.concurrency, specs.length) }, () => worker());
  await Promise.all(workers);
  const completed = results.filter((item) => item?.state === "completed").length;
  return { items: results, completed, failed: specs.length - completed };
}

function makeFinishedLatch(): { finished: Promise<void>; resolveFinished: () => void } {
  let resolveFinished!: () => void;
  const finished = new Promise<void>((resolvePromise) => { resolveFinished = resolvePromise; });
  return { finished, resolveFinished };
}

export class ImageTaskManager {
  private readonly tasks = new Map<string, ManagedImageTask>();
  private readonly queue: string[] = [];
  private activeSlots = 0;

  start(spec: ImageJobSpec | ImageJobSpec[]): ImageTaskSnapshot {
    const batch = Array.isArray(spec);
    const specs = batch ? spec : [spec];
    if (specs.length === 0) throw new Error("At least one image job is required");
    if (specs.length > 500) throw new Error("A batch may contain at most 500 jobs");
    const latch = makeFinishedLatch();
    const taskId = randomUUID();
    const task: ManagedImageTask = {
      taskId,
      state: "queued",
      kind: batch ? "batch" : "image",
      operation: batch ? "batch" : specs[0].operation,
      createdAt: nowIso(),
      startedAt: null,
      endedAt: null,
      error: null,
      total: specs.length,
      completed: 0,
      failed: 0,
      weight: batch ? imagegenConfig.concurrency : 1,
      spec: batch ? specs : specs[0],
      controller: new AbortController(),
      result: null,
      finished: latch.finished,
      resolveFinished: latch.resolveFinished,
    };
    this.tasks.set(taskId, task);
    this.queue.push(taskId);
    this.pump();
    return this.snapshot(task);
  }

  list(): ImageTaskSnapshot[] {
    return [...this.tasks.values()].map((task) => this.snapshot(task)).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  status(taskId: string): ImageTaskSnapshot { return this.snapshot(this.get(taskId)); }

  result(taskId: string): ImageJobResult | BatchResult | null { return this.get(taskId).result; }

  async wait(taskId: string, waitMs: number): Promise<{ snapshot: ImageTaskSnapshot; completed: boolean; waitedMs: number }> {
    const task = this.get(taskId);
    const started = Date.now();
    if (task.state === "queued" || task.state === "running") {
      let timer: NodeJS.Timeout | undefined;
      const timeout = new Promise<void>((resolvePromise) => { timer = setTimeout(resolvePromise, waitMs); timer.unref(); });
      await Promise.race([task.finished, timeout]);
      if (timer) clearTimeout(timer);
    }
    return { snapshot: this.snapshot(task), completed: task.state !== "queued" && task.state !== "running", waitedMs: Date.now() - started };
  }

  cancel(taskId: string): ImageTaskSnapshot {
    const task = this.get(taskId);
    if (task.state === "queued" || task.state === "running") {
      task.state = "cancelled";
      task.error = "cancelled";
      task.endedAt = nowIso();
      task.controller.abort();
      task.resolveFinished();
      this.pump();
    }
    return this.snapshot(task);
  }

  getActiveState(): { activeSlots: number; queued: number; running: number } {
    return {
      activeSlots: this.activeSlots,
      queued: [...this.tasks.values()].filter((task) => task.state === "queued").length,
      running: [...this.tasks.values()].filter((task) => task.state === "running").length,
    };
  }

  private pump(): void {
    while (this.queue.length > 0 && this.activeSlots < imagegenConfig.concurrency) {
      const taskId = this.queue.shift()!;
      const task = this.tasks.get(taskId);
      if (!task || task.state !== "queued") continue;
      if (this.activeSlots + task.weight > imagegenConfig.concurrency) {
        this.queue.unshift(taskId);
        break;
      }
      this.activeSlots += task.weight;
      void this.run(task);
    }
  }

  private async run(task: ManagedImageTask): Promise<void> {
    task.state = "running";
    task.startedAt = nowIso();
    try {
      if (task.kind === "batch") {
        const result = await executeBatch(task.spec as ImageJobSpec[], task.taskId, task.controller.signal);
        task.result = result;
        task.completed = result.completed;
        task.failed = result.failed;
        task.state = result.failed > 0 ? "failed" : "completed";
        if (result.failed > 0) task.error = `${result.failed} batch item(s) failed`;
      } else {
        task.result = await executeOne(task.spec as ImageJobSpec, task.taskId, task.controller.signal);
        task.completed = 1;
        task.state = "completed";
      }
    } catch (error) {
      if (!task.controller.signal.aborted) {
        task.state = "failed";
        task.error = error instanceof Error ? error.message : String(error);
        task.failed = task.total;
      }
    } finally {
      task.endedAt = task.endedAt ?? nowIso();
      this.activeSlots = Math.max(0, this.activeSlots - task.weight);
      task.resolveFinished();
      this.pruneFinished();
      this.pump();
    }
  }

  private pruneFinished(): void {
    const finished = [...this.tasks.values()].filter((task) => ["completed", "failed", "cancelled"].includes(task.state));
    const extra = finished.length - imagegenConfig.maxFinishedTasks;
    if (extra <= 0) return;
    finished.sort((a, b) => a.createdAt.localeCompare(b.createdAt)).slice(0, extra).forEach((task) => this.tasks.delete(task.taskId));
  }

  private get(taskId: string): ManagedImageTask {
    const task = this.tasks.get(taskId);
    if (!task) throw new Error(`Unknown image task: ${taskId}`);
    return task;
  }

  private snapshot(task: ManagedImageTask): ImageTaskSnapshot {
    return {
      taskId: task.taskId,
      state: task.state,
      kind: task.kind,
      operation: task.operation,
      createdAt: task.createdAt,
      startedAt: task.startedAt,
      endedAt: task.endedAt,
      error: task.error,
      total: task.total,
      completed: task.completed,
      failed: task.failed,
      outputDir: imagegenConfig.outputDir,
    };
  }
}

export async function readArtifactBase64(path: string): Promise<string> {
  return (await readFile(path)).toString("base64");
}

export function validateConfiguration(): void {
  if (!imagegenConfig.apiKey) throw new Error("OPENAI_API_KEY is not set");
  if (!imagegenConfig.baseUrl) throw new Error("OPENAI_BASE_URL is empty");
}
