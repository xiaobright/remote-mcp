export interface TextEditResult {
    text: string;
    replacements: number;
}
export declare function applyTextEdit(original: string, oldString: string, newString: string, options?: {
    replaceAll?: boolean;
    path?: string;
}): TextEditResult;
//# sourceMappingURL=edit.d.ts.map