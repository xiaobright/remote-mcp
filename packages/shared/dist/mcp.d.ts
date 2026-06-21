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
export declare function rejectUnexpectedParams(params: Record<string, unknown>, allowed: readonly string[], toolName: string, hints?: Record<string, string>): void;
export declare function requireStringParam(params: Record<string, unknown>, key: string, toolName: string, options?: {
    allowEmpty?: boolean;
}): string;
//# sourceMappingURL=mcp.d.ts.map