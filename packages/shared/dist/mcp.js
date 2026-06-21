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
export function rejectUnexpectedParams(params, allowed, toolName, hints = {}) {
    const allowedSet = new Set(allowed);
    const unexpected = Object.keys(params).filter((key) => !allowedSet.has(key));
    if (unexpected.length === 0) {
        return;
    }
    const hintText = unexpected
        .map((key) => hints[key])
        .filter((hint) => Boolean(hint))
        .join(" ");
    const allowedText = [...allowedSet].sort().join(", ");
    throw new Error([
        `${toolName}: unexpected parameter(s): ${unexpected.join(", ")}.`,
        hintText,
        `Allowed parameters: ${allowedText}.`,
    ].filter(Boolean).join(" "));
}
export function requireStringParam(params, key, toolName, options = {}) {
    const value = params[key];
    if (typeof value !== "string") {
        throw new Error(`${toolName}: parameter "${key}" is required and must be a string.`);
    }
    if (!options.allowEmpty && value.trim().length === 0) {
        throw new Error(`${toolName}: parameter "${key}" is required and must not be empty.`);
    }
    return value;
}
//# sourceMappingURL=mcp.js.map