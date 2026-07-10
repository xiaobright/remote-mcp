/**
 * Exclusive file lock via O_EXCL lockfile. Used for local JSON stores that may
 * be touched by multiple MCP processes.
 */
export declare function withFileLock<T>(targetPath: string, fn: () => T, options?: {
    waitMs?: number;
    staleMs?: number;
}): T;
//# sourceMappingURL=fileLock.d.ts.map