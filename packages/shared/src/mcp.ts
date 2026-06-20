export function errorResponse(error: unknown) {
  const msg = error instanceof Error ? error.message : String(error);
  return { content: [{ type: "text" as const, text: `Error: ${msg}` }], isError: true };
}

export function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? value as Record<string, unknown> : {};
}

export function optionalString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

export function optionalNumber(value: unknown): number | undefined {
  return typeof value === "number" ? value : undefined;
}

export function optionalBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

export function optionalStringArray(value: unknown): string[] | undefined {
  return Array.isArray(value) && value.every((item) => typeof item === "string") ? value : undefined;
}

export function optionalStringRecord(value: unknown): Record<string, string> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }

  const record = value as Record<string, unknown>;
  return Object.values(record).every((item) => typeof item === "string")
    ? record as Record<string, string>
    : undefined;
}

export function taskTailChars(params: { tail_chars?: unknown; tailChars?: unknown }): number | undefined {
  return optionalNumber(params.tail_chars) ?? optionalNumber(params.tailChars);
}
