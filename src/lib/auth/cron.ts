import { timingSafeEqual } from 'crypto'

/**
 * Validates cron job Authorization header.
 * Returns false when CRON_SECRET is missing/blank (fail-closed).
 */
export function isCronAuthorized(request: Request): boolean {
  const secret = process.env.CRON_SECRET?.trim()
  if (!secret) return false

  const authHeader = request.headers.get('authorization')
  if (!authHeader) return false

  const expected = `Bearer ${secret}`
  if (authHeader.length !== expected.length) return false

  try {
    return timingSafeEqual(Buffer.from(authHeader), Buffer.from(expected))
  } catch {
    return false
  }
}
