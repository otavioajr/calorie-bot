import { describe, it, expect } from 'vitest'
import {
  INBOUND_REPLY_TTL_SECONDS,
  evaluateInboundTtl,
} from '@/lib/bot/inbound-freshness'

describe('evaluateInboundTtl', () => {
  const now = new Date('2026-07-13T12:00:00.000Z')

  it('exposes 90s TTL constant', () => {
    expect(INBOUND_REPLY_TTL_SECONDS).toBe(90)
  })

  it('allows message within TTL', () => {
    const receivedAt = new Date('2026-07-13T11:59:30.000Z')
    expect(evaluateInboundTtl(receivedAt, now)).toEqual({ ok: true })
  })

  it('rejects message older than TTL', () => {
    const receivedAt = new Date('2026-07-13T11:58:00.000Z')
    expect(evaluateInboundTtl(receivedAt, now)).toEqual({
      ok: false,
      errorCode: 'stale_expired',
    })
  })

  it('rejects at exactly TTL+1ms boundary as expired', () => {
    const receivedAt = new Date(now.getTime() - (90_000 + 1))
    expect(evaluateInboundTtl(receivedAt, now).ok).toBe(false)
  })

  it('allows at exactly TTL boundary', () => {
    const receivedAt = new Date(now.getTime() - 90_000)
    expect(evaluateInboundTtl(receivedAt, now)).toEqual({ ok: true })
  })
})
