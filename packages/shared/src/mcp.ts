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

export function rejectUnexpectedParams(
  params: Record<string, unknown>,
  allowed: readonly string[],
  toolName: string,
  hints: Record<string, string> = {},
): void {
  const allowedSet = new Set(allowed);
  const unexpected = Object.keys(params).filter((key) => !allowedSet.has(key));
  if (unexpected.length === 0) {
    return;
  }

  const hintText = unexpected
    .map((key) => hints[key])
    .filter((hint): hint is string => Boolean(hint))
    .join(" ");
  const allowedText = [...allowedSet].sort().join(", ");
  throw new Error([
    `${toolName}: unexpected parameter(s): ${unexpected.join(", ")}.`,
    hintText,
    `Allowed parameters: ${allowedText}.`,
  ].filter(Boolean).join(" "));
}

export function requireStringParam(
  params: Record<string, unknown>,
  key: string,
  toolName: string,
  options: { allowEmpty?: boolean } = {},
): string {
  const value = params[key];
  if (typeof value !== "string") {
    throw new Error(`${toolName}: parameter "${key}" is required and must be a string.`);
  }
  if (!options.allowEmpty && value.trim().length === 0) {
    throw new Error(`${toolName}: parameter "${key}" is required and must not be empty.`);
  }
  return value;
}
