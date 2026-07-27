export declare const imagegenConfig: {
    apiKey: string;
    baseUrl: string;
    model: string;
    outputDir: string;
    concurrency: number;
    maxAttempts: number;
    requestTimeoutMs: number;
    defaultSyncTimeoutMs: number;
    defaultWatchTimeoutMs: number;
    minPollIntervalMs: number;
    maxFinishedTasks: number;
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
export declare class ImageTaskManager {
    private readonly tasks;
    private readonly queue;
    private activeSlots;
    start(spec: ImageJobSpec | ImageJobSpec[]): ImageTaskSnapshot;
    list(): ImageTaskSnapshot[];
    status(taskId: string): ImageTaskSnapshot;
    result(taskId: string): ImageJobResult | BatchResult | null;
    wait(taskId: string, waitMs: number): Promise<{
        snapshot: ImageTaskSnapshot;
        completed: boolean;
        waitedMs: number;
    }>;
    cancel(taskId: string): ImageTaskSnapshot;
    getActiveState(): {
        activeSlots: number;
        queued: number;
        running: number;
    };
    private pump;
    private run;
    private pruneFinished;
    private get;
    private snapshot;
}
export declare function readArtifactBase64(path: string): Promise<string>;
export declare function validateConfiguration(): void;
//# sourceMappingURL=imagegen.d.ts.map