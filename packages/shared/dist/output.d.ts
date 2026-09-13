export declare function outputResponse(text: string, result: {
    stdout: string;
    stderr: string;
    [key: string]: unknown;
}): {
    content: {
        type: "text";
        text: string;
    }[];
    structuredContent: {
        [key: string]: unknown;
    };
};
/** Bound model-visible sync output without losing the full command result. */
export declare function commandOutputResponse<T extends {
    stdout: string;
    stderr: string;
    [key: string]: unknown;
}>(result: T, format: (result: T) => string, options?: {
    limit?: number;
    outputDir?: string;
}): {
    content: {
        type: "text";
        text: string;
    }[];
    structuredContent: {
        [key: string]: unknown;
    };
};
//# sourceMappingURL=output.d.ts.map