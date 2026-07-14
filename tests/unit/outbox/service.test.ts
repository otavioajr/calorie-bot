import type { SupabaseClient } from '@supabase/supabase-js'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createOutboxDeliveryService,
  type OutboxServiceDependencies,
  type OutboxTextInput,
} from '@/lib/outbox/service'
import { hashPayload } from '@/lib/outbox/policy'
import type {
  ClaimedOutboxMessage,
  EnqueueOutboxResult,
} from '@/lib/outbox/repository'

const NOW = new Date('2026-07-13T12:00:00.000Z')
const OUTBOX_ID = '10000000-0000-4000-8000-000000000001'
const LEASE_TOKEN = '20000000-0000-4000-8000-000000000002'

function activeEnv(overrides: Record<string, string | undefined> = {}) {
  return {
    OUTBOX_MODE: 'active',
    OUTBOX_GENERATION: 'generation-1',
    OUTBOX_CANARY_PERCENT: '100',
    INBOUND_WORK_ENABLED: 'true',
    WHATSAPP_PHONE_NUMBER_ID: '123456789',
    ...overrides,
  }
}

function durableInput(
  overrides: Partial<OutboxTextInput> = {},
): OutboxTextInput {
  return {
    to: '5511999887766',
    text: 'Hello!',
    options: {
      source: 'bot',
      messageKind: 'terminal',
      idempotencyKey: 'inbound:work-1:0',
      workId: 'work-1',
      emissionIndex: 0,
      userId: 'user-1',
    },
    ...overrides,
  }
}

function enqueueResult(
  overrides: Partial<Extract<EnqueueOutboxResult, { ok: true }>> = {},
): Extract<EnqueueOutboxResult, { ok: true }> {
  return {
    ok: true,
    outboxId: OUTBOX_ID,
    status: 'pending',
    sequenceNo: 1,
    wasInserted: true,
    idempotencyConflict: false,
    providerMessageId: null,
    ...overrides,
  }
}

function claimedRow(
  overrides: Partial<ClaimedOutboxMessage> = {},
): ClaimedOutboxMessage {
  return {
    outboxId: OUTBOX_ID,
    recipient: '5511999887766',
    messageKind: 'terminal',
    payload: { version: 1, type: 'text', text: 'Hello!' },
    payloadHash: 'a'.repeat(64),
    replyToMessageId: null,
    sequenceNo: 1,
    attempt: 1,
    maxAttempts: 5,
    expiresAt: '2026-07-13T12:15:00.000Z',
    leaseToken: LEASE_TOKEN,
    userId: 'user-1',
    workId: 'work-1',
    resourceType: null,
    resourceId: null,
    resourceMetadata: null,
    ...overrides,
  }
}

function createDependencies(
  overrides: Partial<OutboxServiceDependencies> = {},
): OutboxServiceDependencies {
  return {
    getSupabase: () => ({} as SupabaseClient),
    enqueue: vi.fn().mockResolvedValue(enqueueResult()),
    claim: vi.fn().mockResolvedValue({ ok: true, rows: [claimedRow()] }),
    fenceFallback: vi.fn().mockResolvedValue({
      ok: true,
      safeForDirect: true,
      outboxId: null,
      status: null,
      providerMessageId: null,
      idempotencyConflict: false,
    }),
    beginFallback: vi.fn().mockResolvedValue({
      ok: true,
      started: true,
      leaseToken: LEASE_TOKEN,
      status: 'sending',
      attempt: 1,
    }),
    recordAttempt: vi.fn().mockResolvedValue({
      ok: true,
      applied: true,
      status: 'api_accepted',
      attempt: 1,
      providerMessageId: 'wamid.accepted',
    }),
    sendMeta: vi.fn().mockResolvedValue({
      kind: 'accepted',
      providerMessageId: 'wamid.accepted',
      httpStatus: 200,
      response: { messages: [{ id: 'wamid.accepted' }] },
    }),
    now: () => NOW,
    createOwner: () => 'inline:test-owner',
    readEnv: () => activeEnv(),
    reportCritical: vi.fn(),
    ...overrides,
  }
}

describe('outbox delivery service', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it('uses direct Meta delivery in off mode without touching the outbox', async () => {
    const dependencies = createDependencies({
      readEnv: () => activeEnv({ OUTBOX_MODE: 'off' }),
    })
    const service = createOutboxDeliveryService(dependencies)

    const result = await service.sendText({ to: '5511999887766', text: 'Hi' })

    expect(result).toMatchObject({
      providerMessageId: 'wamid.accepted',
      route: 'direct-off',
      durablyEnqueued: false,
    })
    expect(dependencies.enqueue).not.toHaveBeenCalled()
    expect(dependencies.sendMeta).toHaveBeenCalledOnce()
  })

  it('preserves rejection for direct off-mode delivery', async () => {
    const dependencies = createDependencies({
      readEnv: () => activeEnv({ OUTBOX_MODE: 'off' }),
      sendMeta: vi.fn().mockResolvedValue({
        kind: 'rejected',
        httpStatus: 400,
        metaCode: 190,
        message: 'Invalid token',
      }),
    })

    await expect(createOutboxDeliveryService(dependencies).sendText({
      to: '5511999887766',
      text: 'Hi',
    })).rejects.toThrow(/WhatsApp API error.*Invalid token/)
    expect(dependencies.sendMeta).toHaveBeenCalledOnce()
  })

  it('uses direct delivery for recipients outside an active canary', async () => {
    const dependencies = createDependencies({
      readEnv: () => activeEnv({ OUTBOX_CANARY_PERCENT: '0' }),
    })

    const result = await createOutboxDeliveryService(dependencies)
      .sendText(durableInput())

    expect(result.route).toBe('direct-ineligible')
    expect(dependencies.enqueue).not.toHaveBeenCalled()
    expect(dependencies.sendMeta).toHaveBeenCalledOnce()
  })

  it('persists before POST, claims only the target, and records acceptance', async () => {
    const order: string[] = []
    const dependencies = createDependencies({
      enqueue: vi.fn().mockImplementation(async () => {
        order.push('enqueue')
        return enqueueResult()
      }),
      claim: vi.fn().mockImplementation(async () => {
        order.push('claim')
        return { ok: true, rows: [claimedRow()] }
      }),
      sendMeta: vi.fn().mockImplementation(async () => {
        order.push('post')
        return {
          kind: 'accepted',
          providerMessageId: 'wamid.accepted',
          httpStatus: 200,
        }
      }),
      recordAttempt: vi.fn().mockImplementation(async () => {
        order.push('record')
        return {
          ok: true,
          applied: true,
          status: 'api_accepted',
          attempt: 1,
          providerMessageId: 'wamid.accepted',
        }
      }),
    })

    const result = await createOutboxDeliveryService(dependencies)
      .sendText(durableInput())

    expect(order).toEqual(['enqueue', 'claim', 'post', 'record'])
    expect(dependencies.claim).toHaveBeenCalledWith(
      expect.anything(),
      'inline:test-owner',
      'generation-1',
      {
        limit: 1,
        leaseSeconds: 90,
        outboxId: OUTBOX_ID,
        allowUnfinalized: true,
      },
    )
    expect(dependencies.sendMeta).toHaveBeenCalledWith({
      to: '5511999887766',
      text: 'Hello!',
      bizOpaqueCallbackData: OUTBOX_ID,
    })
    expect(dependencies.recordAttempt).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        outboxId: OUTBOX_ID,
        leaseToken: LEASE_TOKEN,
        outcome: 'api_accepted',
        providerMessageId: 'wamid.accepted',
      }),
    )
    expect(result).toMatchObject({
      providerMessageId: 'wamid.accepted',
      outboxId: OUTBOX_ID,
      route: 'active',
      durablyEnqueued: true,
      replayed: false,
      attemptResultPersisted: true,
    })
  })

  it('hashes the full immutable semantic envelope and applies terminal TTL', async () => {
    const dependencies = createDependencies()
    const input = durableInput({
      replyToMessageId: 'wamid.original',
      options: {
        source: 'bot',
        messageKind: 'terminal',
        idempotencyKey: 'inbound:work-1:0',
        workId: 'work-1',
        emissionIndex: 0,
        userId: 'user-1',
        resourceType: 'meal',
        resourceId: 'meal-1',
        resourceMetadata: { source: 'photo' },
      },
    })

    await createOutboxDeliveryService(dependencies).sendText(input)

    const envelope = {
      version: 1,
      messageKind: 'terminal',
      payload: { version: 1, type: 'text', text: 'Hello!' },
      replyToMessageId: 'wamid.original',
      userId: 'user-1',
      resourceType: 'meal',
      resourceId: 'meal-1',
      resourceMetadata: { source: 'photo' },
    }
    expect(dependencies.enqueue).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        payload: envelope.payload,
        payloadHash: hashPayload(envelope),
        maxAttempts: 5,
        expiresAt: '2026-07-13T12:15:00.000Z',
      }),
    )
  })

  it('returns an accepted replay without claiming or posting again', async () => {
    const dependencies = createDependencies({
      enqueue: vi.fn().mockResolvedValue(enqueueResult({
        wasInserted: false,
        status: 'delivered',
        providerMessageId: 'wamid.replayed',
      })),
    })

    const result = await createOutboxDeliveryService(dependencies)
      .sendText(durableInput())

    expect(result).toMatchObject({
      providerMessageId: 'wamid.replayed',
      replayed: true,
      status: 'delivered',
    })
    expect(dependencies.claim).not.toHaveBeenCalled()
    expect(dependencies.sendMeta).not.toHaveBeenCalled()
  })

  it.each(['sending', 'unknown', 'failed_terminal', 'suspended'] as const)(
    'does not post a replay already in %s',
    async (status) => {
      const dependencies = createDependencies({
        enqueue: vi.fn().mockResolvedValue(enqueueResult({
          wasInserted: false,
          status,
        })),
      })

      const result = await createOutboxDeliveryService(dependencies)
        .sendText(durableInput())

      expect(result.providerMessageId).toBeNull()
      expect(result.replayed).toBe(true)
      expect(dependencies.claim).not.toHaveBeenCalled()
      expect(dependencies.sendMeta).not.toHaveBeenCalled()
    },
  )

  it('blocks a key/hash conflict and alerts without POST', async () => {
    const dependencies = createDependencies({
      enqueue: vi.fn().mockResolvedValue(enqueueResult({
        wasInserted: false,
        idempotencyConflict: true,
      })),
    })

    await expect(createOutboxDeliveryService(dependencies)
      .sendText(durableInput())).rejects.toThrow(/idempotency conflict/i)

    expect(dependencies.reportCritical).toHaveBeenCalledWith(
      expect.objectContaining({ code: 'outbox_idempotency_conflict' }),
    )
    expect(dependencies.sendMeta).not.toHaveBeenCalled()
  })

  it('does not post a newly inserted suspended shadow row', async () => {
    const dependencies = createDependencies({
      readEnv: () => activeEnv({ OUTBOX_MODE: 'shadow' }),
      enqueue: vi.fn().mockResolvedValue(enqueueResult({
        wasInserted: true,
        status: 'suspended',
      })),
    })

    const result = await createOutboxDeliveryService(dependencies)
      .sendText(durableInput())

    expect(dependencies.beginFallback).not.toHaveBeenCalled()
    expect(dependencies.sendMeta).not.toHaveBeenCalled()
    expect(result).toMatchObject({
      route: 'shadow',
      status: 'suspended',
      durablyEnqueued: true,
      replayed: false,
    })
  })

  it('starts shadow through begin before posting', async () => {
    const order: string[] = []
    const dependencies = createDependencies({
      readEnv: () => activeEnv({ OUTBOX_MODE: 'shadow' }),
      beginFallback: vi.fn().mockImplementation(async () => {
        order.push('begin')
        return {
          ok: true,
          started: true,
          leaseToken: LEASE_TOKEN,
          status: 'sending',
          attempt: 1,
        }
      }),
      sendMeta: vi.fn().mockImplementation(async () => {
        order.push('post')
        return {
          kind: 'accepted',
          providerMessageId: 'wamid.shadow',
          httpStatus: 200,
        }
      }),
      recordAttempt: vi.fn().mockImplementation(async () => {
        order.push('record')
        return {
          ok: true,
          applied: true,
          status: 'api_accepted',
          attempt: 1,
          providerMessageId: 'wamid.shadow',
        }
      }),
    })

    const result = await createOutboxDeliveryService(dependencies)
      .sendText(durableInput())

    expect(order).toEqual(['begin', 'post', 'record'])
    expect(dependencies.claim).not.toHaveBeenCalled()
    expect(dependencies.sendMeta).toHaveBeenCalledWith(expect.objectContaining({
      bizOpaqueCallbackData: OUTBOX_ID,
    }))
    expect(dependencies.recordAttempt).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        leaseToken: LEASE_TOKEN,
        outcome: 'api_accepted',
        providerMessageId: 'wamid.shadow',
      }),
    )
    expect(result.route).toBe('shadow')
  })

  it('records a shadow unknown with the same lease and no retry', async () => {
    const dependencies = createDependencies({
      readEnv: () => activeEnv({ OUTBOX_MODE: 'shadow' }),
      sendMeta: vi.fn().mockResolvedValue({
        kind: 'outcome_unknown',
        outcomeUnknown: true,
        message: 'socket closed after POST',
      }),
      recordAttempt: vi.fn().mockResolvedValue({
        ok: true,
        applied: true,
        status: 'unknown',
        attempt: 1,
        providerMessageId: null,
      }),
    })

    await expect(createOutboxDeliveryService(dependencies)
      .sendText(durableInput())).rejects.toThrow(/outcome unknown/i)

    expect(dependencies.beginFallback).toHaveBeenCalledOnce()
    expect(dependencies.sendMeta).toHaveBeenCalledOnce()
    expect(dependencies.recordAttempt).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        leaseToken: LEASE_TOKEN,
        outcome: 'unknown',
        nextAttemptAt: null,
      }),
    )
  })

  it('records then rejects a shadow direct failure', async () => {
    const dependencies = createDependencies({
      readEnv: () => activeEnv({ OUTBOX_MODE: 'shadow' }),
      sendMeta: vi.fn().mockResolvedValue({
        kind: 'rejected',
        httpStatus: 400,
        message: 'Bad request',
      }),
      recordAttempt: vi.fn().mockResolvedValue({
        ok: true,
        applied: true,
        status: 'failed_terminal',
        attempt: 1,
        providerMessageId: null,
      }),
    })

    await expect(createOutboxDeliveryService(dependencies)
      .sendText(durableInput())).rejects.toThrow(/WhatsApp API error.*Bad request/)
    expect(dependencies.recordAttempt).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ outcome: 'failed_terminal' }),
    )
  })

  it('fences and starts shadow fallback before posting after ambiguous enqueue', async () => {
    const order: string[] = []
    const beforeUnsafeFallback = vi.fn().mockImplementation(async () => {
      order.push('inbound-fence')
    })
    const dependencies = createDependencies({
      readEnv: () => activeEnv({ OUTBOX_MODE: 'shadow' }),
      enqueue: vi.fn()
        .mockRejectedValueOnce(new Error('enqueue RPC unavailable'))
        .mockResolvedValueOnce(enqueueResult({
          wasInserted: false,
          status: 'suspended',
        })),
      beginFallback: vi.fn().mockImplementation(async () => {
        order.push('begin')
        return {
          ok: true,
          started: true,
          leaseToken: LEASE_TOKEN,
          status: 'sending',
          attempt: 1,
        }
      }),
      sendMeta: vi.fn().mockImplementation(async () => {
        order.push('post')
        return {
          kind: 'accepted',
          providerMessageId: 'wamid.shadow-fallback',
        }
      }),
      recordAttempt: vi.fn().mockImplementation(async () => {
        order.push('record')
        return {
          ok: true,
          applied: true,
          status: 'api_accepted',
          attempt: 1,
          providerMessageId: 'wamid.shadow-fallback',
        }
      }),
    })

    const result = await createOutboxDeliveryService(dependencies).sendText(
      durableInput({
        options: {
          source: 'bot',
          messageKind: 'terminal',
          idempotencyKey: 'inbound:work-1:0',
          workId: 'work-1',
          emissionIndex: 0,
          beforeUnsafeFallback,
        },
      }),
    )

    expect(order).toEqual(['inbound-fence', 'begin', 'post', 'record'])
    expect(dependencies.enqueue).toHaveBeenCalledTimes(2)
    expect(dependencies.fenceFallback).toHaveBeenCalledOnce()
    expect(dependencies.beginFallback).toHaveBeenCalledOnce()
    expect(dependencies.sendMeta).toHaveBeenCalledOnce()
    expect(dependencies.recordAttempt).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ leaseToken: LEASE_TOKEN }),
    )
    expect(result).toMatchObject({
      providerMessageId: 'wamid.shadow-fallback',
      route: 'enqueue-fallback',
      outboxId: OUTBOX_ID,
      durablyEnqueued: true,
      preventInboundReplay: true,
      attemptResultPersisted: true,
    })
  })

  it('records a fenced shadow fallback POST failure as terminal', async () => {
    const dependencies = createDependencies({
      readEnv: () => activeEnv({ OUTBOX_MODE: 'shadow' }),
      enqueue: vi.fn()
        .mockRejectedValueOnce(new Error('enqueue RPC unavailable'))
        .mockResolvedValueOnce(enqueueResult({
          wasInserted: false,
          status: 'suspended',
        })),
      sendMeta: vi.fn().mockResolvedValue({
        kind: 'rejected',
        httpStatus: 400,
        message: 'Bad shadow fallback request',
      }),
      recordAttempt: vi.fn().mockResolvedValue({
        ok: true,
        applied: true,
        status: 'failed_terminal',
        attempt: 1,
        providerMessageId: null,
      }),
    })

    const result = await createOutboxDeliveryService(dependencies).sendText(
      durableInput({
        options: {
          source: 'reminder',
          messageKind: 'reminder',
          idempotencyKey: 'reminder:user-1:daily:2026-07-13',
        },
      }),
    )

    expect(dependencies.enqueue).toHaveBeenCalledTimes(2)
    expect(dependencies.fenceFallback).toHaveBeenCalledOnce()
    expect(dependencies.beginFallback).toHaveBeenCalledOnce()
    expect(dependencies.recordAttempt).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        leaseToken: LEASE_TOKEN,
        outcome: 'failed_terminal',
        nextAttemptAt: null,
      }),
    )
    expect(dependencies.sendMeta).toHaveBeenCalledOnce()
    expect(result).toMatchObject({
      route: 'enqueue-fallback',
      status: 'failed_terminal',
      durablyEnqueued: true,
    })
  })

  it('fails closed instead of direct-fallback for shadow bot progress', async () => {
    const dependencies = createDependencies({
      readEnv: () => activeEnv({ OUTBOX_MODE: 'shadow' }),
      enqueue: vi.fn()
        .mockRejectedValueOnce(new Error('enqueue RPC unavailable'))
        .mockResolvedValueOnce(enqueueResult({
          wasInserted: false,
          status: 'suspended',
        })),
    })

    await expect(createOutboxDeliveryService(dependencies).sendText(
      durableInput({
        options: {
          source: 'bot',
          messageKind: 'progress',
          idempotencyKey: 'inbound:work-1:0',
          workId: 'work-1',
          emissionIndex: 0,
        },
      }),
    )).rejects.toThrow(/progress/i)

    expect(dependencies.sendMeta).not.toHaveBeenCalled()
  })

  it.each(['shadow', 'active'] as const)(
    'treats an omitted source as bot when fencing %s terminal fallback',
    async (mode) => {
      const beforeUnsafeFallback = vi.fn()
      const dependencies = createDependencies({
        readEnv: () => activeEnv({ OUTBOX_MODE: mode }),
        enqueue: vi.fn()
          .mockRejectedValueOnce(new Error('enqueue RPC unavailable'))
          .mockResolvedValueOnce(enqueueResult({
            wasInserted: false,
            status: 'suspended',
          })),
      })

      const result = await createOutboxDeliveryService(dependencies).sendText(
        durableInput({
          options: {
            messageKind: 'terminal',
            idempotencyKey: 'inbound:work-1:0',
            workId: 'work-1',
            emissionIndex: 0,
            beforeUnsafeFallback,
          },
        }),
      )

      expect(beforeUnsafeFallback).toHaveBeenCalledOnce()
      expect(dependencies.sendMeta).toHaveBeenCalledOnce()
      expect(result.preventInboundReplay).toBe(true)
    },
  )

  it.each(['shadow', 'active'] as const)(
    'treats an omitted source as bot and fails closed for %s progress',
    async (mode) => {
      const dependencies = createDependencies({
        readEnv: () => activeEnv({ OUTBOX_MODE: mode }),
        enqueue: vi.fn()
          .mockRejectedValueOnce(new Error('enqueue RPC unavailable'))
          .mockResolvedValueOnce(enqueueResult({
            wasInserted: false,
            status: 'suspended',
          })),
      })

      await expect(createOutboxDeliveryService(dependencies).sendText(
        durableInput({
          options: {
            messageKind: 'progress',
            idempotencyKey: 'inbound:work-1:0',
            workId: 'work-1',
            emissionIndex: 0,
          },
        }),
      )).rejects.toThrow(/progress/i)

      expect(dependencies.sendMeta).not.toHaveBeenCalled()
    },
  )

  it('never repeats a shadow POST for an existing unresolved key', async () => {
    const dependencies = createDependencies({
      readEnv: () => activeEnv({ OUTBOX_MODE: 'shadow' }),
      enqueue: vi.fn().mockResolvedValue(enqueueResult({
        wasInserted: false,
        status: 'pending',
      })),
    })

    await expect(createOutboxDeliveryService(dependencies)
      .sendText(durableInput())).rejects.toThrow(/refusing replay/i)
    expect(dependencies.sendMeta).not.toHaveBeenCalled()
  })

  it('schedules an explicitly transient first rejection after one minute', async () => {
    const dependencies = createDependencies({
      sendMeta: vi.fn().mockResolvedValue({
        kind: 'rejected',
        httpStatus: 429,
        metaCode: 130429,
        message: 'Rate limited',
      }),
      recordAttempt: vi.fn().mockResolvedValue({
        ok: true,
        applied: true,
        status: 'retryable',
        attempt: 1,
        providerMessageId: null,
      }),
    })

    const result = await createOutboxDeliveryService(dependencies)
      .sendText(durableInput())

    expect(result.providerMessageId).toBeNull()
    expect(dependencies.recordAttempt).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        outcome: 'retryable',
        nextAttemptAt: '2026-07-13T12:01:00.000Z',
        errorCode: 'meta:130429',
      }),
    )
  })

  it('never retries progress even for an explicitly transient rejection', async () => {
    const dependencies = createDependencies({
      claim: vi.fn().mockResolvedValue({
        ok: true,
        rows: [claimedRow({
          messageKind: 'progress',
          maxAttempts: 1,
          expiresAt: '2026-07-13T12:05:00.000Z',
        })],
      }),
      sendMeta: vi.fn().mockResolvedValue({
        kind: 'rejected',
        httpStatus: 429,
        message: 'Rate limited',
      }),
    })

    await createOutboxDeliveryService(dependencies).sendText(durableInput({
      options: {
        source: 'bot',
        messageKind: 'progress',
        idempotencyKey: 'inbound:work-1:0',
        workId: 'work-1',
        emissionIndex: 0,
      },
    }))

    expect(dependencies.enqueue).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ maxAttempts: 1 }),
    )
    expect(dependencies.recordAttempt).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        outcome: 'failed_terminal',
        nextAttemptAt: null,
      }),
    )
  })

  it('caps OTP at three attempts and five minutes', async () => {
    const dependencies = createDependencies()

    await createOutboxDeliveryService(dependencies).sendText(durableInput({
      options: {
        source: 'otp',
        messageKind: 'otp',
        idempotencyKey: 'otp:auth-code-1',
        userId: 'user-1',
      },
    }))

    expect(dependencies.enqueue).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        maxAttempts: 3,
        expiresAt: '2026-07-13T12:05:00.000Z',
      }),
    )
  })

  it('records permanent rejection without scheduling a retry', async () => {
    const dependencies = createDependencies({
      sendMeta: vi.fn().mockResolvedValue({
        kind: 'rejected',
        httpStatus: 400,
        metaCode: 190,
        message: 'Invalid token',
      }),
    })

    const result = await createOutboxDeliveryService(dependencies)
      .sendText(durableInput())

    expect(result.providerMessageId).toBeNull()
    expect(dependencies.recordAttempt).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        outcome: 'failed_terminal',
        nextAttemptAt: null,
      }),
    )
  })

  it('records unknown without retry metadata or a second POST', async () => {
    const dependencies = createDependencies({
      sendMeta: vi.fn().mockResolvedValue({
        kind: 'outcome_unknown',
        outcomeUnknown: true,
        message: 'socket closed',
      }),
    })

    const result = await createOutboxDeliveryService(dependencies)
      .sendText(durableInput())

    expect(result.providerMessageId).toBeNull()
    expect(dependencies.sendMeta).toHaveBeenCalledOnce()
    expect(dependencies.recordAttempt).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        outcome: 'unknown',
        nextAttemptAt: null,
        errorCode: 'outcome_unknown',
      }),
    )
  })

  it('marks an existing active row claimed inline as replayed', async () => {
    const dependencies = createDependencies({
      enqueue: vi.fn().mockResolvedValue(enqueueResult({
        wasInserted: false,
        status: 'pending',
      })),
    })

    const result = await createOutboxDeliveryService(dependencies)
      .sendText(durableInput())

    expect(result).toMatchObject({
      route: 'active',
      replayed: true,
      status: 'api_accepted',
    })
    expect(dependencies.sendMeta).toHaveBeenCalledOnce()
  })

  it('reports an accepted result persistence failure without reposting', async () => {
    const dependencies = createDependencies({
      recordAttempt: vi.fn().mockRejectedValue(
        new Error('database unavailable'),
      ),
    })

    const result = await createOutboxDeliveryService(dependencies)
      .sendText(durableInput())

    expect(result.providerMessageId).toBe('wamid.accepted')
    expect(result.attemptResultPersisted).toBe(false)
    expect(dependencies.sendMeta).toHaveBeenCalledOnce()
    expect(dependencies.reportCritical).toHaveBeenCalledWith(
      expect.objectContaining({ code: 'outbox_attempt_result_not_persisted' }),
    )
  })

  it('alerts when the attempt RPC declines an accepted claimed result', async () => {
    const dependencies = createDependencies({
      recordAttempt: vi.fn().mockResolvedValue({
        ok: true,
        applied: false,
        status: 'sending',
        attempt: 1,
        providerMessageId: null,
      }),
    })

    const result = await createOutboxDeliveryService(dependencies)
      .sendText(durableInput())

    expect(result.providerMessageId).toBe('wamid.accepted')
    expect(result.attemptResultPersisted).toBe(false)
    expect(dependencies.sendMeta).toHaveBeenCalledOnce()
    expect(dependencies.reportCritical).toHaveBeenCalledWith(
      expect.objectContaining({
        code: 'outbox_attempt_result_not_persisted',
        message: expect.stringContaining('did not apply'),
      }),
    )
  })

  it('runs the active bot completion fence before the fallback POST', async () => {
    const order: string[] = []
    const beforeUnsafeFallback = vi.fn().mockImplementation(async () => {
      order.push('inbound-fence')
    })
    const dependencies = createDependencies({
      enqueue: vi.fn()
        .mockImplementationOnce(async () => {
          throw new Error('connection dropped')
        })
        .mockImplementationOnce(async () => {
          return enqueueResult({
            wasInserted: false,
            status: 'suspended',
          })
        }),
      fenceFallback: vi.fn().mockImplementation(async () => {
        return {
          ok: true,
          safeForDirect: true,
          outboxId: OUTBOX_ID,
          status: 'suspended',
          providerMessageId: null,
          idempotencyConflict: false,
        }
      }),
      reportCritical: vi.fn(),
      beginFallback: vi.fn().mockImplementation(async () => {
        order.push('begin-fallback')
        return {
          ok: true,
          started: true,
          leaseToken: LEASE_TOKEN,
          status: 'sending',
          attempt: 1,
        }
      }),
      sendMeta: vi.fn().mockImplementation(async () => {
        order.push('post')
        return {
          kind: 'accepted',
          providerMessageId: 'wamid.fallback',
        }
      }),
      recordAttempt: vi.fn().mockImplementation(async () => {
        order.push('record')
        return {
          ok: true,
          applied: true,
          status: 'api_accepted',
          attempt: 1,
          providerMessageId: 'wamid.fallback',
        }
      }),
    })

    const result = await createOutboxDeliveryService(dependencies).sendText(
      durableInput({
        options: {
          source: 'bot',
          messageKind: 'terminal',
          idempotencyKey: 'inbound:work-1:0',
          workId: 'work-1',
          emissionIndex: 0,
          beforeUnsafeFallback,
        },
      }),
    )

    expect(order).toEqual(['inbound-fence', 'begin-fallback', 'post', 'record'])
    expect(beforeUnsafeFallback).toHaveBeenCalledOnce()
    expect(dependencies.sendMeta).toHaveBeenCalledOnce()
    expect(result).toMatchObject({
      providerMessageId: 'wamid.fallback',
      outboxId: OUTBOX_ID,
      status: 'api_accepted',
      route: 'enqueue-fallback',
      durablyEnqueued: true,
      preventInboundReplay: true,
      attemptResultPersisted: true,
    })
    expect(dependencies.sendMeta).toHaveBeenCalledWith(expect.objectContaining({
      bizOpaqueCallbackData: OUTBOX_ID,
    }))
    expect(dependencies.recordAttempt).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ leaseToken: LEASE_TOKEN }),
    )
  })

  it('rejects a bot terminal fallback without a fence callback before begin', async () => {
    const dependencies = createDependencies({
      enqueue: vi.fn()
        .mockRejectedValueOnce(new Error('connection dropped'))
        .mockResolvedValueOnce(enqueueResult({
          wasInserted: false,
          status: 'suspended',
        })),
    })

    await expect(createOutboxDeliveryService(dependencies).sendText(
      durableInput({
        options: {
          source: 'bot',
          messageKind: 'terminal',
          idempotencyKey: 'inbound:work-1:0',
          workId: 'work-1',
          emissionIndex: 0,
        },
      }),
    )).rejects.toThrow(/no durable replay fence/i)

    expect(dependencies.beginFallback).not.toHaveBeenCalled()
    expect(dependencies.sendMeta).not.toHaveBeenCalled()
    expect(dependencies.recordAttempt).not.toHaveBeenCalled()
  })

  it('returns a FIFO-blocked active fallback as durably queued', async () => {
    const beforeUnsafeFallback = vi.fn()
    const dependencies = createDependencies({
      enqueue: vi.fn()
        .mockRejectedValueOnce(new Error('connection dropped'))
        .mockResolvedValueOnce(enqueueResult({
          wasInserted: false,
          status: 'suspended',
        })),
      beginFallback: vi.fn().mockResolvedValue({
        ok: true,
        started: false,
        leaseToken: null,
        status: 'pending',
        attempt: 0,
      }),
    })

    const result = await createOutboxDeliveryService(dependencies)
      .sendText(durableInput({
        options: {
          source: 'bot',
          messageKind: 'terminal',
          idempotencyKey: 'inbound:work-1:0',
          workId: 'work-1',
          emissionIndex: 0,
          beforeUnsafeFallback,
        },
      }))

    expect(beforeUnsafeFallback).toHaveBeenCalledOnce()
    expect(dependencies.sendMeta).not.toHaveBeenCalled()
    expect(result).toMatchObject({
      route: 'active',
      status: 'pending',
      durablyEnqueued: true,
      replayed: true,
    })
  })

  it('does not direct-fallback a progress emission without an inbound replay fence', async () => {
    const dependencies = createDependencies({
      enqueue: vi.fn()
        .mockRejectedValueOnce(new Error('connection dropped'))
        .mockResolvedValueOnce(enqueueResult({
          wasInserted: false,
          status: 'suspended',
        })),
    })

    await expect(createOutboxDeliveryService(dependencies).sendText(
      durableInput({
        options: {
          source: 'bot',
          messageKind: 'progress',
          idempotencyKey: 'inbound:work-1:0',
          workId: 'work-1',
          emissionIndex: 0,
        },
      }),
    )).rejects.toThrow(/no durable replay fence/i)

    expect(dependencies.beginFallback).not.toHaveBeenCalled()
    expect(dependencies.sendMeta).not.toHaveBeenCalled()
  })

  it('blocks an unsafe fallback if the durable replay fence fails', async () => {
    const dependencies = createDependencies({
      enqueue: vi.fn()
        .mockResolvedValueOnce({
          ok: false,
          error: { message: 'connection dropped' },
        })
        .mockResolvedValueOnce(enqueueResult({
          wasInserted: false,
          status: 'suspended',
        })),
    })

    await expect(createOutboxDeliveryService(dependencies).sendText(
      durableInput({
        options: {
          source: 'bot',
          messageKind: 'terminal',
          idempotencyKey: 'inbound:work-1:0',
          workId: 'work-1',
          emissionIndex: 0,
          beforeUnsafeFallback: async () => {
            throw new Error('could not persist fence')
          },
        },
      }),
    )).rejects.toThrow('could not persist fence')
    expect(dependencies.sendMeta).not.toHaveBeenCalled()
  })

  it('never posts if the outbox fallback fence itself cannot be confirmed', async () => {
    const beforeUnsafeFallback = vi.fn()
    const dependencies = createDependencies({
      enqueue: vi.fn().mockRejectedValue(new Error('connection dropped')),
      fenceFallback: vi.fn().mockResolvedValue({
        ok: false,
        error: { message: 'database still unavailable' },
      }),
    })

    await expect(createOutboxDeliveryService(dependencies).sendText(
      durableInput({
        options: {
          source: 'bot',
          messageKind: 'terminal',
          idempotencyKey: 'inbound:work-1:0',
          workId: 'work-1',
          emissionIndex: 0,
          beforeUnsafeFallback,
        },
      }),
    )).rejects.toThrow(/fallback fence could not be confirmed/i)
    expect(beforeUnsafeFallback).not.toHaveBeenCalled()
    expect(dependencies.sendMeta).not.toHaveBeenCalled()
    expect(dependencies.reportCritical).toHaveBeenCalledWith(
      expect.objectContaining({ code: 'outbox_fallback_fence_failed' }),
    )
  })

  it('never posts if the one-time fallback permission was already consumed', async () => {
    const dependencies = createDependencies({
      enqueue: vi.fn()
        .mockRejectedValueOnce(new Error('connection dropped'))
        .mockResolvedValueOnce(enqueueResult({
          wasInserted: false,
          status: 'suspended',
        })),
      beginFallback: vi.fn().mockResolvedValue({
        ok: true,
        started: false,
        leaseToken: null,
        status: 'suspended',
        attempt: 1,
      }),
    })

    await expect(createOutboxDeliveryService(dependencies).sendText(
      durableInput({
        options: {
          source: 'bot',
          messageKind: 'terminal',
          idempotencyKey: 'inbound:work-1:0',
          workId: 'work-1',
          emissionIndex: 0,
          beforeUnsafeFallback: async () => undefined,
        },
      }),
    )).rejects.toThrow(/permission was already consumed/i)
    expect(dependencies.sendMeta).not.toHaveBeenCalled()
  })

  it('does not fall back directly when a committed row may already be sending', async () => {
    const dependencies = createDependencies({
      enqueue: vi.fn().mockRejectedValue(new Error('connection dropped')),
      fenceFallback: vi.fn().mockResolvedValue({
        ok: true,
        safeForDirect: false,
        outboxId: OUTBOX_ID,
        status: 'sending',
        providerMessageId: null,
        idempotencyConflict: false,
      }),
    })

    const result = await createOutboxDeliveryService(dependencies)
      .sendText(durableInput())

    expect(result).toMatchObject({
      providerMessageId: null,
      outboxId: OUTBOX_ID,
      status: 'sending',
      route: 'active',
      durablyEnqueued: true,
    })
    expect(dependencies.enqueue).toHaveBeenCalledOnce()
    expect(dependencies.sendMeta).not.toHaveBeenCalled()
  })
})
