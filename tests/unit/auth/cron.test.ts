import { describe, it, expect } from 'vitest'
import { isCronAuthorized } from '@/lib/auth/cron'

function makeRequest(authHeader: string | null): Request {
  return new Request('http://localhost/api/cron/reminders', {
    method: 'POST',
    headers: authHeader ? { authorization: authHeader } : {},
  })
}

describe('isCronAuthorized', () => {
  it('returns true when Bearer matches CRON_SECRET', () => {
    process.env.CRON_SECRET = 'my-secret'
    expect(isCronAuthorized(makeRequest('Bearer my-secret'))).toBe(true)
  })

  it('returns false when CRON_SECRET is missing', () => {
    delete process.env.CRON_SECRET
    expect(isCronAuthorized(makeRequest('Bearer undefined'))).toBe(false)
  })

  it('returns false when CRON_SECRET is blank', () => {
    process.env.CRON_SECRET = '   '
    expect(isCronAuthorized(makeRequest('Bearer    '))).toBe(false)
  })

  it('returns false when authorization header is wrong', () => {
    process.env.CRON_SECRET = 'my-secret'
    expect(isCronAuthorized(makeRequest('Bearer wrong'))).toBe(false)
  })

  it('returns false when authorization header is absent', () => {
    process.env.CRON_SECRET = 'my-secret'
    expect(isCronAuthorized(makeRequest(null))).toBe(false)
  })
})
