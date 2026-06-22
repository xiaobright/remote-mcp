export interface PatchOperation {
    kind: "add" | "update";
    path: string;
    hunks?: PatchHunk[];
    lines?: string[];
}
export interface PatchHunk {
    lines: PatchLine[];
    patchLine?: number;
}
export interface PatchLine {
    op: "context" | "add" | "remove";
    text: string;
}
export interface PatchNormalization {
    patchLine: number;
    path: string;
    directive: string;
    assumed: "context";
    reason: "empty-line" | "missing-marker";
    text: string;
}
export interface PatchApplyWarning {
    kind: "ambiguous-match" | "empty-old-block";
    path: string;
    hunk: number;
    patchLine?: number;
    message: string;
    matches?: number;
    firstOldLine?: string;
}
export interface ParsePatchResult {
    operations: PatchOperation[];
    normalizations: PatchNormalization[];
}
export interface AppliedPatch {
    text: string;
    added: number;
    removed: number;
    warnings: PatchApplyWarning[];
}
export declare function parsePatch(input: string): ParsePatchResult;
export declare function applyUpdatePatch(original: string, hunks: PatchHunk[], path: string): AppliedPatch;
export declare function textForAddedFile(lines: string[]): string;
//# sourceMappingURL=patch.d.ts.map