export declare function readPositiveIntEnv(name: string, fallback: number): number;
export declare function readStringArrayJsonEnv(name: string): string[] | null;
export declare function isPositiveInt(value: unknown): value is number;
export interface BoundedDuration {
    ms: number;
    requestedMs?: number;
    clamped: boolean;
    maxMs: number;
}
export declare function boundedDuration(requestedMs: number | undefined, fallbackMs: number, maxMs: number): BoundedDuration;
//# sourceMappingURL=env.d.ts.map