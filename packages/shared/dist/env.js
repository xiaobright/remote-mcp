export function readPositiveIntEnv(name, fallback) {
    const raw = process.env[name]?.trim();
    if (!raw) {
        return fallback;
    }
    const value = Number.parseInt(raw, 10);
    return Number.isFinite(value) && value > 0 ? value : fallback;
}
export function readStringArrayJsonEnv(name) {
    const raw = process.env[name]?.trim();
    if (!raw) {
        return null;
    }
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed) || !parsed.every((item) => typeof item === "string")) {
        throw new Error(`${name} must be a JSON string array`);
    }
    return parsed;
}
export function isPositiveInt(value) {
    return typeof value === "number" && Number.isInteger(value) && value > 0;
}
export function boundedDuration(requestedMs, fallbackMs, maxMs) {
    const requested = isPositiveInt(requestedMs) ? requestedMs : undefined;
    const fallback = Math.min(fallbackMs, maxMs);
    const ms = Math.min(requested ?? fallback, maxMs);
    return {
        ms,
        requestedMs: requested,
        clamped: typeof requested === "number" && requested > ms,
        maxMs,
    };
}
//# sourceMappingURL=env.js.map