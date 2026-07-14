import { describe, expect, it } from 'vitest'
import {
  OUTBOX_BACKOFF_MS,
  buildInboundKey,
  buildOtpKey,
  buildReminderKey,
  canonicalizePayload,
  classifyCallbackFailure,
  classifySynchronousFailure,
  hashPayload,
  isRecipientSelected,
  nextProjection,
  normalizeRecipientIdentity,
  parseOutboxConfig,
  policyFor,
  retryDelayMs,
} from '@/lib/outbox/policy'

describe('outbox identity and hashing', () => {
  it('builds source-specific idempotency keys', () => {
    expect(buildInboundKey('work-1', 0)).toBe('inbound:work-1:0')
    expect(buildOtpKey('auth-code-1')).toBe('otp:auth-code-1')
    expect(buildReminderKey('user-1', 'daily', '2026-07-13')).toBe(
      'reminder:user-1:daily:2026-07-13',
    )
  })

  it('canonicalizes nested object keys without reordering arrays', () => {
    const left = {
      text: 'hello',
      metadata: { z: 1, a: true },
      values: [{ b: 2, a: 1 }, 3],
    }
    const right = {
      values: [{ a: 1, b: 2 }, 3],
      metadata: { a: true, z: 1 },
      text: 'hello',
    }

    expect(canonicalizePayload(left)).toBe(canonicalizePayload(right))
    expect(hashPayload(left)).toBe(hashPayload(right))
    expect(hashPayload(left)).toMatch(/^[a-f0-9]{64}$/)
  })

  it('distinguishes array order and payload values', () => {
    expect(hashPayload({ values: [1, 2] })).not.toBe(
      hashPayload({ values: [2, 1] }),
    )
    expect(hashPayload({ text: 'a' })).not.toBe(hashPayload({ text: 'b' }))
  })
})

describe('outbox delivery policy', () => {
  it('defines attempts and TTLs by semantic kind', () => {
    expect(policyFor('progress')).toMatchObject({ maxAttempts: 1 })
    expect(policyFor('otp')).toMatchObject({
      maxAttempts: 3,
      ttlMs: 5 * 60_000,
      redactOnAcceptance: true,
    })
    expect(policyFor('prompt').ttlMs).toBe(10 * 60_000)
    expect(policyFor('terminal').ttlMs).toBe(15 * 60_000)
    expect(policyFor('reminder').ttlMs).toBe(15 * 60_000)
  })

  it('uses the approved retry schedule and stops after five attempts', () => {
    expect(OUTBOX_BACKOFF_MS).toEqual([60_000, 120_000, 300_000, 300_000])
    expect([1, 2, 3, 4, 5].map(retryDelayMs)).toEqual([
      60_000,
      120_000,
      300_000,
      300_000,
      null,
    ])
  })

  it('classifies only proven synchronous transient failures as retryable', () => {
    expect(classifySynchronousFailure({ httpStatus: 429 }).retryable).toBe(true)
    expect(classifySynchronousFailure({ httpStatus: 503 }).retryable).toBe(true)
    expect(classifySynchronousFailure({ httpStatus: 501 }).retryable).toBe(false)
    expect(classifySynchronousFailure({ httpStatus: 505 }).retryable).toBe(false)
    expect(classifySynchronousFailure({ httpStatus: 599 }).retryable).toBe(false)
    expect(
      classifySynchronousFailure({ httpStatus: 400, metaCode: 131026 }),
    ).toMatchObject({ projection: 'failed_terminal', retryable: false })
    expect(
      classifySynchronousFailure({ outcomeUnknown: true, message: 'socket closed' }),
    ).toMatchObject({ projection: 'unknown', retryable: false })
  })

  it('never retries a failure received by callback', () => {
    expect(classifyCallbackFailure({ code: 130429 }).retryable).toBe(false)
    expect(classifyCallbackFailure({ code: 130429 }).projection).toBe(
      'failed_terminal',
    )
  })
})

describe('monotonic callback projection', () => {
  it.each([
    ['pending', 'sent', 'delivered', 'read', 'failed_terminal'],
    ['sending', 'sent', 'delivered', 'read', 'failed_terminal'],
    ['retryable', 'sent', 'delivered', 'read', 'failed_terminal'],
    ['unknown', 'sent', 'delivered', 'read', 'failed_terminal'],
    ['api_accepted', 'sent', 'delivered', 'read', 'failed_terminal'],
    ['sent', 'sent', 'delivered', 'read', 'failed_terminal'],
    ['delivered', 'delivered', 'delivered', 'read', 'delivered'],
    ['read', 'read', 'read', 'read', 'read'],
    [
      'failed_terminal',
      'failed_terminal',
      'delivered',
      'read',
      'failed_terminal',
    ],
    ['expired', 'expired', 'delivered', 'read', 'expired'],
    ['superseded', 'superseded', 'delivered', 'read', 'superseded'],
    ['suspended', 'suspended', 'delivered', 'read', 'suspended'],
  ] as const)(
    'projects callbacks monotonically from %s',
    (current, sent, delivered, read, failed) => {
      expect(nextProjection(current, { status: 'sent' })).toBe(sent)
      expect(nextProjection(current, { status: 'delivered' })).toBe(delivered)
      expect(nextProjection(current, { status: 'read' })).toBe(read)
      expect(nextProjection(current, { status: 'failed' })).toBe(failed)
      expect(nextProjection(current, { status: 'unknown' })).toBe(current)
    },
  )

  it('does not regress positive delivery evidence', () => {
    expect(nextProjection('read', { status: 'sent' })).toBe('read')
    expect(nextProjection('delivered', { status: 'failed' })).toBe('delivered')
    expect(nextProjection('read', { status: 'failed' })).toBe('read')
  })

  it('allows late positive evidence to resolve uncertain or failed states', () => {
    expect(nextProjection('unknown', { status: 'delivered' })).toBe('delivered')
    expect(nextProjection('failed_terminal', { status: 'delivered' })).toBe(
      'delivered',
    )
    expect(nextProjection('failed_terminal', { status: 'read' })).toBe('read')
  })

  it('makes a post-acceptance failure terminal without reopening it on sent', () => {
    expect(nextProjection('api_accepted', { status: 'failed' })).toBe(
      'failed_terminal',
    )
    expect(nextProjection('failed_terminal', { status: 'sent' })).toBe(
      'failed_terminal',
    )
  })
})

describe('rollout configuration', () => {
  it('normalizes WhatsApp recipients to a digits-only identity', () => {
    expect(normalizeRecipientIdentity('+351 900-000-001')).toBe('351900000001')
    expect(normalizeRecipientIdentity('351900000001')).toBe('351900000001')
    expect(() => normalizeRecipientIdentity('not-a-phone')).toThrow(/recipient/)
  })

  it('rejects invalid modes, percentages and durable bot mode without inbox', () => {
    expect(() => parseOutboxConfig({ OUTBOX_MODE: 'invalid' })).toThrow(
      /OUTBOX_MODE/,
    )
    expect(() =>
      parseOutboxConfig({
        OUTBOX_MODE: 'active',
        OUTBOX_GENERATION: 'gen-1',
        OUTBOX_CANARY_PERCENT: '101',
        INBOUND_WORK_ENABLED: 'true',
      }),
    ).toThrow(/OUTBOX_CANARY_PERCENT/)
    expect(() =>
      parseOutboxConfig({
        OUTBOX_MODE: 'active',
        OUTBOX_GENERATION: 'gen-1',
        INBOUND_WORK_ENABLED: 'false',
      }),
    ).toThrow(/INBOUND_WORK_ENABLED/)
    expect(() =>
      parseOutboxConfig({
        OUTBOX_MODE: 'shadow',
        OUTBOX_GENERATION: 'gen-shadow',
        INBOUND_WORK_ENABLED: 'false',
      }),
    ).toThrow(/INBOUND_WORK_ENABLED/)
  })

  it('requires a generation for shadow and active modes', () => {
    expect(() => parseOutboxConfig({ OUTBOX_MODE: 'shadow' })).toThrow(
      /OUTBOX_GENERATION/,
    )
    expect(() =>
      parseOutboxConfig({
        OUTBOX_MODE: 'active',
        OUTBOX_GENERATION: '   ',
        INBOUND_WORK_ENABLED: 'true',
      }),
    ).toThrow(/OUTBOX_GENERATION/)
  })

  it('selects allowlisted recipients before deterministic percentage rollout', () => {
    const config = parseOutboxConfig({
      OUTBOX_MODE: 'active',
      OUTBOX_GENERATION: 'gen-1',
      OUTBOX_CANARY_PHONES: '+351900000001,+351900000002',
      OUTBOX_CANARY_PERCENT: '0',
      INBOUND_WORK_ENABLED: 'true',
    })

    expect(isRecipientSelected(config, '351900000001')).toBe(true)
    expect(isRecipientSelected(config, '+351900000099')).toBe(false)
  })

  it.each(['off', 'shadow'] as const)(
    'never selects recipients while mode is %s',
    (mode) => {
      const config = parseOutboxConfig({
        OUTBOX_MODE: mode,
        OUTBOX_GENERATION: mode === 'shadow' ? 'gen-shadow' : undefined,
        OUTBOX_CANARY_PHONES: '+351900000001',
        OUTBOX_CANARY_PERCENT: '100',
        INBOUND_WORK_ENABLED: 'true',
      })

      expect(isRecipientSelected(config, '+351900000001')).toBe(false)
      expect(isRecipientSelected(config, '+351900000099')).toBe(false)
    },
  )

  it('buckets the same recipient deterministically', () => {
    const config = parseOutboxConfig({
      OUTBOX_MODE: 'active',
      OUTBOX_GENERATION: 'gen-1',
      OUTBOX_CANARY_PERCENT: '37.5',
      INBOUND_WORK_ENABLED: 'true',
    })

    const first = isRecipientSelected(config, '+351900000003')
    expect(isRecipientSelected(config, '+351900000003')).toBe(first)
    expect(isRecipientSelected(config, '351900000003')).toBe(first)

    const nextGeneration = parseOutboxConfig({
      OUTBOX_MODE: 'active',
      OUTBOX_GENERATION: 'gen-2',
      OUTBOX_CANARY_PERCENT: '37.5',
      INBOUND_WORK_ENABLED: 'true',
    })
    expect(isRecipientSelected(nextGeneration, '+351900000003')).toBe(first)
  })

  it('allows active OTP configuration without inbound work', () => {
    expect(
      parseOutboxConfig(
        {
          OUTBOX_MODE: 'active',
          OUTBOX_GENERATION: 'gen-otp',
          INBOUND_WORK_ENABLED: 'false',
        },
        { source: 'otp' },
      ).mode,
    ).toBe('active')
  })
})
