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
