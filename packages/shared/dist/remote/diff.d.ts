export interface UnifiedDiffResult {
    diff: string;
    added: number;
    removed: number;
    truncated: boolean;
}
export declare function unifiedDiff(originalText: string, modifiedText: string, path: string, options?: {
    context?: number;
    maxLines?: number;
}): UnifiedDiffResult;
//# sourceMappingURL=diff.d.ts.map