import { type RemoteTarget } from "./transport.js";
export interface RemoteScriptRunnerResult {
    stdout: Buffer;
    stderr: string;
    exitCode: number;
    timedOut?: boolean;
    [key: string]: unknown;
}
export type RemoteScriptRunner = (script: string) => Promise<RemoteScriptRunnerResult>;
export type RemoteRunner = RemoteTarget | RemoteScriptRunner;
export interface RemoteTextOptions {
    maxBytes?: number;
    encoding?: string;
}
export interface RemoteTextDecodeResult {
    text: string;
    encoding: string;
    requestedEncoding: string;
    detectedEncoding: string;
    confidence: number;
    warning?: string;
    bytes: number;
    sha256: string;
}
export interface RemoteFileInfo {
    path: string;
    exists: boolean;
    type?: string;
    size?: number;
    mode?: string;
    mtime?: number;
    [key: string]: unknown;
}
export interface RemoteListEntry {
    name: string;
    type: string;
    size?: number;
    mtime?: number;
    [key: string]: unknown;
}
export declare function sha256Text(text: string, encoding?: string): string;
export declare function sha256Bytes(bytes: Buffer): string;
export declare function detectRemoteTextEncoding(bytes: Buffer): Omit<RemoteTextDecodeResult, "bytes" | "sha256">;
export declare function decodeRemoteTextResult(bytes: Buffer, encoding?: string): RemoteTextDecodeResult;
export declare function decodeRemoteText(bytes: Buffer, encoding?: string): string;
export declare function encodeRemoteText(text: string, encoding?: string): Buffer;
export declare function readFileBytes(target: RemoteRunner, path: string, maxBytesOrOptions?: number | RemoteTextOptions): Promise<Buffer>;
export declare function readTextFile(target: RemoteRunner, path: string, maxBytesOrOptions?: number | RemoteTextOptions, encoding?: string): Promise<string>;
export declare function readTextFileDecoded(target: RemoteRunner, path: string, maxBytesOrOptions?: number | RemoteTextOptions, encoding?: string): Promise<RemoteTextDecodeResult>;
export declare function writeTextFile(target: RemoteRunner, options: {
    path: string;
    content: string;
    createParents?: boolean;
    overwrite?: boolean;
    expectedSha256?: string;
    mode?: string;
    encoding?: string;
}): Promise<{
    bytes: number;
    sha256: string;
}>;
export declare function statPath(target: RemoteRunner, path: string): Promise<RemoteFileInfo>;
export declare function listDir(target: RemoteRunner, path: string): Promise<RemoteListEntry[]>;
export declare function searchText(target: RemoteRunner, options: {
    path: string;
    pattern: string;
    fixed?: boolean;
    maxResults?: number;
    encoding?: string;
}): Promise<string>;
//# sourceMappingURL=remoteOps.d.ts.map