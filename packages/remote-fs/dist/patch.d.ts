export interface PatchOperation {
    kind: "add" | "update";
    path: string;
    hunks?: PatchHunk[];
    lines?: string[];
}
export interface PatchHunk {
    lines: PatchLine[];
}
export interface PatchLine {
    op: "context" | "add" | "remove";
    text: string;
}
export interface AppliedPatch {
    text: string;
    added: number;
    removed: number;
}
export declare function parsePatch(input: string): PatchOperation[];
export declare function applyUpdatePatch(original: string, hunks: PatchHunk[], path: string): AppliedPatch;
export declare function textForAddedFile(lines: string[]): string;
//# sourceMappingURL=patch.d.ts.map