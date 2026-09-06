export interface TextEditResult {
    text: string;
    replacements: number;
    lineEndingsNormalized: boolean;
}
export interface TextEditOptions {
    replaceAll?: boolean;
    path?: string;
    /** Appended to mismatch errors, e.g. "call ssh_file_read and copy old_string verbatim". */
    hint?: string;
}
export declare function applyTextEdit(original: string, oldString: string, newString: string, options?: TextEditOptions): TextEditResult;
//# sourceMappingURL=edit.d.ts.map