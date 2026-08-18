// ---------------------------------------------------------------------------
// lib/core/config.ts — Type-safe configuration parsing utilities
// ---------------------------------------------------------------------------

/**
 * Parse a value to boolean with a fallback.
 * Treats 'true', '1', 'yes', 'on' (case-insensitive) as true.
 */
export function toBool(value: any, fallback: boolean = false): boolean {
  if (typeof value === 'boolean') return value;
  if (value == null || value === '') return fallback;
  return ['true', '1', 'yes', 'on'].includes(String(value).toLowerCase());
}

/**
 * Parse a value to a finite number with a fallback.
 * Returns the fallback if the value is not a finite number.
 */
export function toNumber(value: any, fallback: number = 0): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

/**
 * Parse a value to a finite positive integer with a fallback.
 */
export function toInt(value: any, fallback: number = 0): number {
  const n = toNumber(value, fallback);
  return Number.isInteger(n) ? n : Math.trunc(n);
}

/**
 * Trim and return a string. Always returns a string (empty if nil).
 */
export function toString(value: any): string {
  return String(value ?? '').trim();
}

/**
 * Trim and return a string, or null if the result is empty.
 * Useful for optional string fields (e.g. API keys, URLs).
 */
export function toOptionalString(value: any): string | null {
  const s = String(value ?? '').trim();
  return s || null;
}

/**
 * Deep-clone a plain object via JSON round-trip.
 * Returns null for nil values, returns primitives as-is.
 */
export function cloneDeep<T>(value: T): T {
  if (value === null || value === undefined) return value;
  if (typeof value !== 'object') return value;
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return { ...value } as T;
  }
}

/**
 * Generate a simple unique ID (timestamp + random suffix).
 * Not cryptographically secure — for session IDs, run IDs, etc.
 */
export function generateId(prefix: string = ''): string {
  const ts = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 8);
  return prefix ? `${prefix}-${ts}-${rand}` : `${ts}-${rand}`;
}

/**
 * Retry an async function with exponential backoff.
 */
export async function retry<T>(
  fn: () => Promise<T>,
  options: { maxAttempts?: number; delayMs?: number; backoffFactor?: number } = {}
): Promise<T> {
  const maxAttempts = options.maxAttempts ?? 3;
  const delayMs = options.delayMs ?? 500;
  const backoffFactor = options.backoffFactor ?? 2;

  let lastError: any;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      if (attempt < maxAttempts) {
        const wait = delayMs * Math.pow(backoffFactor, attempt - 1);
        await new Promise(resolve => setTimeout(resolve, wait));
      }
    }
  }
  throw lastError;
}
