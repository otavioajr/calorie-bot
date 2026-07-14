import type { SupabaseClient } from '@supabase/supabase-js'
import { describe, expect, it, vi } from 'vitest'
import {
  createOutboxDeliveryService,
  type OutboxServiceDependencies,
} from '@/lib/outbox/service'
import type { ClaimedOutboxMessage } from '@/lib/outbox/repository'

const OUTBOX_ID = '10000000-0000-4000-8000-000000000001'
const LEASE_TOKEN = '20000000-0000-4000-8000-000000000002'

function row(): ClaimedOutboxMessage {
  return {
    outboxId: OUTBOX_ID,
    recipient: '5511999887766',
    messageKind: 'reminder',
    payload: { version: 1, type: 'text', text: 'durable message' },
    payloadHash: 'a'.repeat(64),
    replyToMessageId: null,
    sequenceNo: 1,
    attempt: 1,
    maxAttempts: 5,
    expiresAt: '2026-07-13T12:15:00.000Z',
    leaseToken: LEASE_TOKEN,
    userId: null,
    workId: null,
    resourceType: null,
    resourceId: null,
    resourceMetadata: null,
  }
}

function dependencies(
  overrides: Partial<OutboxServiceDependencies> = {},
): OutboxServiceDependencies {
  return {
    getSupabase: () => ({} as SupabaseClient),
    enqueue: vi.fn().mockResolvedValue({
      ok: true,
      outboxId: OUTBOX_ID,
      status: 'pending',
      sequenceNo: 1,
      wasInserted: true,
      idempotencyConflict: false,
      providerMessageId: null,
    }),
    claim: vi.fn().mockResolvedValue({ ok: true, rows: [row()] }),
    fenceFallback: vi.fn().mockResolvedValue({
      ok: true,
      safeForDirect: true,
      outboxId: OUTBOX_ID,
      status: 'suspended',
      providerMessageId: null,
      idempotencyConflict: false,
    }),
    beginFallback: vi.fn().mockResolvedValue({
      ok: true,
      started: true,
      leaseToken: LEASE_TOKEN,
      status: 'suspended',
      attempt: 1,
    }),
    recordAttempt: vi.fn().mockResolvedValue({
      ok: true,
      applied: true,
      status: 'api_accepted',
      attempt: 1,
      providerMessageId: 'wamid.fault',
    }),
    sendMeta: vi.fn().mockResolvedValue({
      kind: 'accepted',
      providerMessageId: 'wamid.fault',
      httpStatus: 200,
    }),
    now: () => new Date('2026-07-13T12:00:00.000Z'),
    createOwner: () => 'fault-test-owner',
    readEnv: () => ({
      OUTBOX_MODE: 'active',
      OUTBOX_GENERATION: 'generation-1',
      OUTBOX_CANARY_PERCENT: '100',
      INBOUND_WORK_ENABLED: 'true',
      WHATSAPP_PHONE_NUMBER_ID: 'phone-number-1',
    }),
    reportCritical: vi.fn(),
    ...overrides,
  }
}

function input() {
  return {
    to: '5511999887766',
    text: 'durable message',
    options: {
      source: 'reminder' as const,
      messageKind: 'reminder' as const,
      idempotencyKey: 'reminder:user-1:daily:2026-07-13',
    },
  }
}

describe('outbox fault injection', () => {
  it('recovers with the claimed row after a crash between enqueue and POST', async () => {
    const deps = dependencies({
      claim: vi.fn().mockRejectedValue(new Error('crash after enqueue')),
    })
    const service = createOutboxDeliveryService(deps)

    const inline = await service.sendText(input())

    expect(inline).toMatchObject({
      durablyEnqueued: true,
      providerMessageId: null,
      status: 'pending',
    })
    expect(deps.sendMeta).toHaveBeenCalledTimes(0)

    const recovered = await service.deliverClaimed(
      deps.getSupabase(),
      row(),
    )

    expect(recovered.providerMessageId).toBe('wamid.fault')
    expect(deps.sendMeta).toHaveBeenCalledTimes(1)
  })

  it('never reposts after Meta acceptance when result persistence crashes', async () => {
    const enqueue = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        outboxId: OUTBOX_ID,
        status: 'pending',
        sequenceNo: 1,
        wasInserted: true,
        idempotencyConflict: false,
        providerMessageId: null,
      })
      .mockResolvedValueOnce({
        ok: true,
        outboxId: OUTBOX_ID,
        status: 'sending',
        sequenceNo: 1,
        wasInserted: false,
        idempotencyConflict: false,
        providerMessageId: null,
      })
    const deps = dependencies({
      enqueue,
      recordAttempt: vi.fn().mockRejectedValue(
        new Error('crash before wamid persistence'),
      ),
    })
    const service = createOutboxDeliveryService(deps)

    const accepted = await service.sendText(input())
    const replay = await service.sendText(input())

    expect(accepted.providerMessageId).toBe('wamid.fault')
    expect(replay).toMatchObject({
      providerMessageId: null,
      status: 'sending',
      replayed: true,
    })
    expect(deps.sendMeta).toHaveBeenCalledTimes(1)
    expect(deps.reportCritical).toHaveBeenCalledWith(
      expect.objectContaining({ code: 'outbox_attempt_result_not_persisted' }),
    )
  })

  it('allows only one fenced fallback after an ambiguous outbox insert', async () => {
    const order: string[] = []
    const enqueue = vi.fn()
      .mockImplementationOnce(async () => {
        order.push('ambiguous-enqueue')
        throw new Error('connection dropped after insert')
      })
      .mockImplementationOnce(async () => {
        order.push('tombstone')
        return {
          ok: true,
          outboxId: OUTBOX_ID,
          status: 'suspended',
          sequenceNo: 1,
          wasInserted: false,
          idempotencyConflict: false,
          providerMessageId: null,
        }
      })
      .mockResolvedValueOnce({
        ok: true,
        outboxId: OUTBOX_ID,
        status: 'suspended',
        sequenceNo: 1,
        wasInserted: false,
        idempotencyConflict: false,
        providerMessageId: null,
      })
    const beforeUnsafeFallback = vi.fn().mockImplementation(async () => {
      order.push('inbound-fence')
    })
    const deps = dependencies({
      enqueue,
      fenceFallback: vi.fn().mockImplementation(async () => {
        order.push('fallback-fence')
        return {
          ok: true,
          safeForDirect: true,
          outboxId: OUTBOX_ID,
          status: 'suspended',
          providerMessageId: null,
          idempotencyConflict: false,
        }
      }),
      beginFallback: vi.fn().mockImplementation(async () => {
        order.push('begin')
        return {
          ok: true,
          started: true,
          leaseToken: LEASE_TOKEN,
          status: 'suspended',
          attempt: 1,
        }
      }),
      sendMeta: vi.fn().mockImplementation(async () => {
        order.push('post')
        return {
          kind: 'accepted',
          providerMessageId: 'wamid.fault',
          httpStatus: 200,
        }
      }),
      recordAttempt: vi.fn().mockImplementation(async () => {
        order.push('record')
        return {
          ok: true,
          applied: true,
          status: 'suspended',
          attempt: 1,
          providerMessageId: 'wamid.fault',
        }
      }),
    })
    const service = createOutboxDeliveryService(deps)
    const terminalInput = {
      ...input(),
      options: {
        source: 'bot' as const,
        messageKind: 'terminal' as const,
        idempotencyKey: 'inbound:work-1:0',
        workId: 'work-1',
        emissionIndex: 0,
        beforeUnsafeFallback,
      },
    }

    const first = await service.sendText(terminalInput)
    const replay = await service.sendText(terminalInput)

    expect(first).toMatchObject({
      route: 'enqueue-fallback',
      preventInboundReplay: true,
      providerMessageId: 'wamid.fault',
    })
    expect(replay).toMatchObject({
      route: 'active',
      status: 'suspended',
      providerMessageId: null,
    })
    expect(beforeUnsafeFallback).toHaveBeenCalledOnce()
    expect(order).toEqual([
      'ambiguous-enqueue',
      'fallback-fence',
      'tombstone',
      'inbound-fence',
      'begin',
      'post',
      'record',
    ])
    expect(deps.beginFallback).toHaveBeenCalledOnce()
    expect(deps.sendMeta).toHaveBeenCalledTimes(1)
  })

  it.each([
    {
      source: 'otp' as const,
      messageKind: 'otp' as const,
      idempotencyKey: 'otp:auth-code-1',
    },
    {
      source: 'reminder' as const,
      messageKind: 'reminder' as const,
      idempotencyKey: 'reminder:user-1:daily:2026-07-13',
    },
  ])(
    'uses one confirmed active tombstone fallback for $source without an inbound fence',
    async ({ source, messageKind, idempotencyKey }) => {
      const enqueue = vi.fn()
        .mockRejectedValueOnce(new Error('connection dropped after insert'))
        .mockResolvedValueOnce({
          ok: true,
          outboxId: OUTBOX_ID,
          status: 'suspended',
          sequenceNo: 1,
          wasInserted: false,
          idempotencyConflict: false,
          providerMessageId: null,
        })
        .mockResolvedValueOnce({
          ok: true,
          outboxId: OUTBOX_ID,
          status: 'suspended',
          sequenceNo: 1,
          wasInserted: false,
          idempotencyConflict: false,
          providerMessageId: null,
        })
      const beforeUnsafeFallback = vi.fn()
      const deps = dependencies({ enqueue })
      const service = createOutboxDeliveryService(deps)
      const durableInput = {
        to: '5511999887766',
        text: 'durable message',
        options: {
          source,
          messageKind,
          idempotencyKey,
          beforeUnsafeFallback,
        },
      }

      const first = await service.sendText(durableInput)
      const replay = await service.sendText(durableInput)

      expect(beforeUnsafeFallback).not.toHaveBeenCalled()
      expect(deps.beginFallback).toHaveBeenCalledOnce()
      expect(deps.sendMeta).toHaveBeenCalledTimes(1)
      expect(first).toMatchObject({
        route: 'enqueue-fallback',
        preventInboundReplay: false,
        attemptResultPersisted: true,
      })
      expect(replay).toMatchObject({
        route: 'active',
        status: 'suspended',
        providerMessageId: null,
      })
    },
  )

  it('does not repost after sweeper maintenance projects an expired lease as unknown', async () => {
    // The real sending -> unknown maintenance transition is exercised by the
    // PostgreSQL RPC integration suite. This fault verifies the service-side
    // replay boundary after that durable transition has happened.
    const deps = dependencies({
      enqueue: vi.fn().mockResolvedValue({
        ok: true,
        outboxId: OUTBOX_ID,
        status: 'unknown',
        sequenceNo: 1,
        wasInserted: false,
        idempotencyConflict: false,
        providerMessageId: null,
      }),
    })

    const replay = await createOutboxDeliveryService(deps).sendText(input())

    expect(replay).toMatchObject({
      outboxId: OUTBOX_ID,
      status: 'unknown',
      replayed: true,
      providerMessageId: null,
    })
    expect(deps.claim).toHaveBeenCalledTimes(0)
    expect(deps.sendMeta).toHaveBeenCalledTimes(0)
  })
})
