export declare function errorResponse(error: unknown): {
    content: {
        type: "text";
        text: string;
    }[];
    isError: boolean;
};
export declare function asRecord(value: unknown): Record<string, unknown>;
export declare function optionalString(value: unknown): string | undefined;
export declare function optionalNumber(value: unknown): number | undefined;
export declare function optionalBoolean(value: unknown): boolean | undefined;
export declare function optionalStringArray(value: unknown): string[] | undefined;
export declare function optionalStringRecord(value: unknown): Record<string, string> | undefined;
export declare function taskTailChars(params: {
    tail_chars?: unknown;
    tailChars?: unknown;
}): number | undefined;
//# sourceMappingURL=mcp.d.ts.map