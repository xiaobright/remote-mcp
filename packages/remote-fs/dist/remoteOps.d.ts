import { type RemoteTarget } from "./transport.js";
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
export declare function sha256Text(text: string): string;
export declare function readTextFile(target: RemoteTarget, path: string, maxBytes?: number): Promise<string>;
export declare function writeTextFile(target: RemoteTarget, options: {
    path: string;
    content: string;
    createParents?: boolean;
    overwrite?: boolean;
    expectedSha256?: string;
    mode?: string;
}): Promise<{
    bytes: number;
    sha256: string;
}>;
export declare function statPath(target: RemoteTarget, path: string): Promise<RemoteFileInfo>;
export declare function listDir(target: RemoteTarget, path: string): Promise<RemoteListEntry[]>;
export declare function searchText(target: RemoteTarget, options: {
    path: string;
    pattern: string;
    fixed?: boolean;
    maxResults?: number;
}): Promise<string>;
//# sourceMappingURL=remoteOps.d.ts.map