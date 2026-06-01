/**
 * Converts a snake_case string to camelCase.
 * e.g. "auth_id" → "authId", "onboarding_complete" → "onboardingComplete"
 */
function snakeToCamel(key: string): string {
  return key.replace(/_([a-z])/g, (_, letter: string) => letter.toUpperCase())
}

/**
 * Converts a camelCase string to snake_case.
 * e.g. "authId" → "auth_id", "onboardingComplete" → "onboarding_complete"
 */
function camelToSnake(key: string): string {
  return key.replace(/([A-Z])/g, (letter: string) => `_${letter.toLowerCase()}`)
}

/**
 * Coerce a Postgres DECIMAL/NUMERIC column value to a number.
 *
 * PostgREST serializes DECIMAL/NUMERIC as a STRING (e.g. "12.50") to preserve
 * precision. A TypeScript `as number` cast does NOT convert at runtime, so
 * arithmetic on these values silently breaks: `0 + "12.50" + "5.50"` concatenates
 * to "012.505.50", and Math.round of that is NaN. Route every DECIMAL/NUMERIC
 * read through this helper.
 *
 * Returns null for null/undefined/non-numeric input, so a genuinely unknown value
 * stays null instead of becoming 0. Use `?? 0` at call sites that need a numeric
 * fallback (e.g. when summing).
 */
export function decToNum(value: unknown): number | null {
  if (value == null) return null
  const n = Number(value)
  return Number.isNaN(n) ? null : n
}

/**
 * Convert a DB row (snake_case keys) to a TypeScript object (camelCase keys).
 */
export function fromDB<T>(row: Record<string, unknown>): T {
  const result: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(row)) {
    result[snakeToCamel(key)] = value
  }
  return result as T
}

/**
 * Convert a TypeScript object (camelCase keys) to DB columns (snake_case keys).
 */
export function toDB(data: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(data)) {
    result[camelToSnake(key)] = value
  }
  return result
}
