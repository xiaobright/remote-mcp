export function readPositiveIntEnv(name: string, fallback: number, max?: number): number {
  const raw = process.env[name]?.trim();
  const parsed = raw ? Number.parseInt(raw, 10) : Number.NaN;
  const value = Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
  return typeof max === "number" ? Math.min(value, max) : value;
}

export function readStringArrayJsonEnv(name: string): string[] | null {
  const raw = process.env[name]?.trim();
  if (!raw) {
    return null;
  }

  const parsed = JSON.parse(raw) as unknown;
  if (!Array.isArray(parsed) || !parsed.every((item) => typeof item === "string")) {
    throw new Error(`${name} must be a JSON string array`);
  }

  return parsed;
}

export function isPositiveInt(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

export interface BoundedDuration {
  ms: number;
  requestedMs?: number;
  clamped: boolean;
  maxMs: number;
}

export function boundedDuration(
  requestedMs: number | undefined,
  fallbackMs: number,
  maxMs: number,
): BoundedDuration {
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
