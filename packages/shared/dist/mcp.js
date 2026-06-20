export function errorResponse(error) {
    const msg = error instanceof Error ? error.message : String(error);
    return { content: [{ type: "text", text: `Error: ${msg}` }], isError: true };
}
export function asRecord(value) {
    return value && typeof value === "object" ? value : {};
}
export function optionalString(value) {
    return typeof value === "string" ? value : undefined;
}
export function optionalNumber(value) {
    return typeof value === "number" ? value : undefined;
}
export function optionalBoolean(value) {
    return typeof value === "boolean" ? value : undefined;
}
export function optionalStringArray(value) {
    return Array.isArray(value) && value.every((item) => typeof item === "string") ? value : undefined;
}
export function optionalStringRecord(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        return undefined;
    }
    const record = value;
    return Object.values(record).every((item) => typeof item === "string")
        ? record
        : undefined;
}
export function taskTailChars(params) {
    return optionalNumber(params.tail_chars) ?? optionalNumber(params.tailChars);
}
//# sourceMappingURL=mcp.js.map