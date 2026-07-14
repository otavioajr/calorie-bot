import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const {
  mockHandleIncomingMessage,
  mockHandleIncomingAudio,
  mockHandleIncomingImage,
  mockHandleUnsupportedMessage,
} = vi.hoisted(() => ({
  mockHandleIncomingMessage: vi.fn().mockResolvedValue(undefined),
  mockHandleIncomingAudio: vi.fn().mockResolvedValue(undefined),
  mockHandleIncomingImage: vi.fn().mockResolvedValue(undefined),
  mockHandleUnsupportedMessage: vi.fn().mockResolvedValue(undefined),
}))

const {
  mockRunWithOutboxScope,
  mockGetActiveContext,
  mockFinalizeOutboxScope,
  scopeState,
} = vi.hoisted(() => {
  const state = {
    summary: {
      userId: 'user-existing' as string | null,
      hasProgress: false,
      hasDurableTerminal: true,
      lastNonProgressOutboxId: 'outbox-1' as string | null,
      lastNonProgressStatus: 'pending' as string | null,
      unsafeFallbackFenced: false,
      idempotencyConflict: false,
      conflictError: null as string | null,
    },
  }

  return {
    scopeState: state,
    mockRunWithOutboxScope: vi.fn(
      async (
        input: { userId?: string | null },
        operation: () => Promise<unknown>,
      ) => ({
        value: await operation(),
        summary: {
          ...state.summary,
          userId: input.userId ?? null,
        },
      }),
    ),
    mockGetActiveContext: vi.fn().mockResolvedValue(null),
    mockFinalizeOutboxScope: vi.fn().mockResolvedValue({
      ok: true,
      finalized: true,
      responseCount: 1,
      status: 'pending',
    }),
  }
})

vi.mock('@/lib/bot/handler', () => ({
  handleIncomingMessage: mockHandleIncomingMessage,
  handleIncomingAudio: mockHandleIncomingAudio,
  handleIncomingImage: mockHandleIncomingImage,
  handleUnsupportedMessage: mockHandleUnsupportedMessage,
}))

vi.mock('@/lib/outbox/scope', () => ({
  runWithOutboxScope: mockRunWithOutboxScope,
}))

vi.mock('@/lib/db/queries/context', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/db/queries/context')>()
  return {
    ...actual,
    getActiveContextResult: (...args: unknown[]) => mockGetActiveContext(...args),
  }
})

vi.mock('@/lib/outbox/repository', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/outbox/repository')>()
  return {
    ...actual,
    finalizeOutboxScope: (...args: unknown[]) => mockFinalizeOutboxScope(...args),
  }
})

const mockClaim = vi.fn()
const mockComplete = vi.fn()
const mockHasNewer = vi.fn()
const mockFindUserByPhone = vi.fn()

vi.mock('@/lib/db/queries/inbound-work', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/db/queries/inbound-work')>()
  return {
    ...actual,
    claimInboundWork: (...args: unknown[]) => mockClaim(...args),
    completeInboundWork: (...args: unknown[]) => mockComplete(...args),
    hasNewerInboundWork: (...args: unknown[]) => mockHasNewer(...args),
  }
})

vi.mock('@/lib/db/queries/users', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/db/queries/users')>()
  return {
    ...actual,
    findUserByPhone: (...args: unknown[]) => mockFindUserByPhone(...args),
  }
})

import { processInboundWork } from '@/lib/bot/inbound-processor'

function supabaseWithMeta(meta: {
  received_at: string
  created_at: string
  user_phone: string
}) {
  const single = vi.fn().mockResolvedValue({ data: meta, error: null })
  const eq = vi.fn(() => ({ single }))
  const select = vi.fn(() => ({ eq }))
  const from = vi.fn(() => ({ select }))
  return { supabase: { from } as never, from, select, eq, single }
}

function supabaseWithMetaError(errorMessage = 'db_error') {
  const single = vi.fn().mockResolvedValue({ data: null, error: { message: errorMessage } })
  const eq = vi.fn(() => ({ single }))
  const select = vi.fn(() => ({ eq }))
  const from = vi.fn(() => ({ select }))
  return { supabase: { from } as never, from, select, eq, single }
}

describe('processInboundWork', () => {
  const payload = {
    type: 'text' as const,
    from: '5511999999999',
    messageId: 'wamid.1',
    text: 'oi',
  }

  beforeEach(() => {
    vi.clearAllMocks()
    vi.stubEnv('OUTBOX_MODE', 'off')
    mockClaim.mockResolvedValue({ claimed: true, status: 'processing', attempt: 1 })
    mockComplete.mockResolvedValue({ completed: true, status: 'committed' })
    mockHasNewer.mockResolvedValue({ status: 'none' })
    mockFindUserByPhone.mockResolvedValue({ id: 'user-existing' })
    mockGetActiveContext.mockResolvedValue({ ok: true, context: null })
    mockFinalizeOutboxScope.mockResolvedValue({
      ok: true,
      finalized: true,
      responseCount: 1,
      status: 'pending',
    })
    scopeState.summary = {
      userId: 'user-existing',
      hasProgress: false,
      hasDurableTerminal: true,
      lastNonProgressOutboxId: 'outbox-1',
      lastNonProgressStatus: 'pending',
      unsafeFallbackFenced: false,
      idempotencyConflict: false,
      conflictError: null,
    }
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllEnvs()
  })

  function enableActiveOutbox() {
    vi.stubEnv('OUTBOX_MODE', 'active')
    vi.stubEnv('OUTBOX_GENERATION', 'generation-1')
    vi.stubEnv('OUTBOX_CANARY_PERCENT', '100')
    vi.stubEnv('INBOUND_WORK_ENABLED', 'true')
  }

  function scopeExecutionError(
    overrides: Partial<typeof scopeState.summary> = {},
  ) {
    return Object.assign(new Error('handler failed after fallback'), {
      summary: {
        workId: 'work-1',
        recipient: payload.from,
        emissions: [],
        ...scopeState.summary,
        ...overrides,
      },
    })
  }

  it('skips when claim is not granted', async () => {
    mockClaim.mockResolvedValue({ claimed: false, status: 'committed', attempt: 1 })
    const outcome = await processInboundWork(
      {} as never,
      { workId: 'work-1', payload },
      'owner-1',
      { freshnessGate: false },
    )
    expect(outcome).toBe('skipped')
    expect(mockHandleIncomingMessage).not.toHaveBeenCalled()
  })

  it('commits after successful handler', async () => {
    const supabase = {} as never
    const outcome = await processInboundWork(
      supabase,
      { workId: 'work-1', payload },
      'owner-1',
      { freshnessGate: false },
    )
    expect(outcome).toBe('committed')
    expect(mockHandleIncomingMessage).toHaveBeenCalled()
    expect(mockComplete).toHaveBeenCalledWith(supabase, 'work-1', 'owner-1', 'committed')
  })

  it.each([
    {
      caseName: 'blank text',
      earlyPayload: {
        type: 'text' as const,
        from: payload.from,
        messageId: 'wamid.blank',
        text: '   ',
      },
    },
    {
      caseName: 'text over the channel limit',
      earlyPayload: {
        type: 'text' as const,
        from: payload.from,
        messageId: 'wamid.long',
        text: 'x'.repeat(4_097),
      },
    },
    {
      caseName: 'unsupported message',
      earlyPayload: {
        type: 'unsupported' as const,
        from: payload.from,
        messageId: 'wamid.unsupported',
        rawType: 'sticker',
      },
    },
    {
      caseName: 'audio without media id',
      earlyPayload: {
        type: 'audio' as const,
        from: payload.from,
        messageId: 'wamid.audio-missing',
      },
    },
    {
      caseName: 'image without media id',
      earlyPayload: {
        type: 'image' as const,
        from: payload.from,
        messageId: 'wamid.image-missing',
      },
    },
  ])('preloads the existing user into the outbox scope for $caseName', async ({
    earlyPayload,
  }) => {
    const supabase = {} as never

    await processInboundWork(
      supabase,
      { workId: 'work-1', payload: earlyPayload },
      'owner-1',
      { freshnessGate: false },
    )

    expect(mockFindUserByPhone).toHaveBeenCalledWith(supabase, earlyPayload.from)
    expect(mockRunWithOutboxScope).toHaveBeenCalledWith(
      expect.objectContaining({
        workId: 'work-1',
        recipient: earlyPayload.from,
        userId: 'user-existing',
      }),
      expect.any(Function),
    )
    expect(mockFindUserByPhone.mock.invocationCallOrder[0]).toBeLessThan(
      mockRunWithOutboxScope.mock.invocationCallOrder[0],
    )
  })

  it('marks lookup failures retryable without dispatching the payload', async () => {
    mockFindUserByPhone.mockRejectedValueOnce(new Error('user lookup failed'))
    const supabase = {} as never

    const outcome = await processInboundWork(
      supabase,
      { workId: 'work-1', payload },
      'owner-1',
      { freshnessGate: false },
    )

    expect(outcome).toBe('failed_retryable')
    expect(mockComplete).toHaveBeenCalledWith(
      supabase,
      'work-1',
      'owner-1',
      'failed_retryable',
      'handler_error',
      'user lookup failed',
    )
    expect(mockRunWithOutboxScope).not.toHaveBeenCalled()
    expect(mockHandleIncomingMessage).not.toHaveBeenCalled()
    expect(mockHandleIncomingAudio).not.toHaveBeenCalled()
    expect(mockHandleIncomingImage).not.toHaveBeenCalled()
    expect(mockHandleUnsupportedMessage).not.toHaveBeenCalled()
  })

  it('marks failed_retryable when handler throws', async () => {
    mockHandleIncomingMessage.mockRejectedValueOnce(new Error('boom'))
    const supabase = {} as never
    const outcome = await processInboundWork(
      supabase,
      { workId: 'work-1', payload },
      'owner-1',
      { freshnessGate: false },
    )
    expect(outcome).toBe('failed_retryable')
    expect(mockComplete).toHaveBeenCalledWith(
      supabase,
      'work-1',
      'owner-1',
      'failed_retryable',
      'handler_error',
      'boom',
    )
  })

  it('with freshnessGate marks stale_expired without calling handler', async () => {
    mockHasNewer.mockResolvedValue({ status: 'none' })
    const { supabase } = supabaseWithMeta({
      received_at: '2026-07-13T11:00:00.000Z',
      created_at: '2026-07-13T11:00:00.000Z',
      user_phone: '5511999999999',
    })
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-07-13T12:00:00.000Z'))

    const outcome = await processInboundWork(
      supabase,
      { workId: 'work-1', payload },
      'owner-1',
      { freshnessGate: true },
    )

    expect(outcome).toBe('failed_terminal')
    expect(mockHandleIncomingMessage).not.toHaveBeenCalled()
    expect(mockHasNewer).not.toHaveBeenCalled()
    expect(mockComplete).toHaveBeenCalledWith(
      supabase,
      'work-1',
      'owner-1',
      'failed_terminal',
      'stale_expired',
      expect.any(String),
    )
  })

  it('with freshnessGate marks freshness_meta_error when meta load fails', async () => {
    const { supabase } = supabaseWithMetaError('connection lost')

    const outcome = await processInboundWork(
      supabase,
      { workId: 'work-1', payload },
      'owner-1',
      { freshnessGate: true },
    )

    expect(outcome).toBe('failed_retryable')
    expect(mockHandleIncomingMessage).not.toHaveBeenCalled()
    expect(mockHasNewer).not.toHaveBeenCalled()
    expect(mockComplete).toHaveBeenCalledWith(
      supabase,
      'work-1',
      'owner-1',
      'failed_retryable',
      'freshness_meta_error',
      'connection lost',
    )
  })

  it('with freshnessGate marks superseded when newer work exists', async () => {
    mockHasNewer.mockResolvedValue({ status: 'newer' })
    const { supabase } = supabaseWithMeta({
      received_at: '2026-07-13T11:59:00.000Z',
      created_at: '2026-07-13T11:59:00.000Z',
      user_phone: '5511999999999',
    })
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-07-13T12:00:00.000Z'))

    const outcome = await processInboundWork(
      supabase,
      { workId: 'work-1', payload },
      'owner-1',
      { freshnessGate: true },
    )

    expect(outcome).toBe('failed_terminal')
    expect(mockHandleIncomingMessage).not.toHaveBeenCalled()
    expect(mockComplete).toHaveBeenCalledWith(
      supabase,
      'work-1',
      'owner-1',
      'failed_terminal',
      'superseded',
      expect.any(String),
    )
    expect(mockHasNewer).toHaveBeenCalledWith(supabase, {
      workId: 'work-1',
      userPhone: '5511999999999',
      receivedAt: '2026-07-13T11:59:00.000Z',
      createdAt: '2026-07-13T11:59:00.000Z',
    })
  })

  it('with freshnessGate marks has_newer_lookup_error when newer lookup fails', async () => {
    mockHasNewer.mockResolvedValue({ status: 'error', message: 'down' })
    const { supabase } = supabaseWithMeta({
      received_at: '2026-07-13T11:59:00.000Z',
      created_at: '2026-07-13T11:59:00.000Z',
      user_phone: '5511999999999',
    })
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-07-13T12:00:00.000Z'))

    const outcome = await processInboundWork(
      supabase,
      { workId: 'work-1', payload },
      'owner-1',
      { freshnessGate: true },
    )

    expect(outcome).toBe('failed_retryable')
    expect(mockHandleIncomingMessage).not.toHaveBeenCalled()
    expect(mockComplete).toHaveBeenCalledWith(
      supabase,
      'work-1',
      'owner-1',
      'failed_retryable',
      'has_newer_lookup_error',
      'down',
    )
  })

  it('with freshnessGate false skips meta load and runs handler', async () => {
    const from = vi.fn()
    const supabase = { from } as never

    const outcome = await processInboundWork(
      supabase,
      { workId: 'work-1', payload },
      'owner-1',
      { freshnessGate: false },
    )

    expect(outcome).toBe('committed')
    expect(from).not.toHaveBeenCalled()
    expect(mockHasNewer).not.toHaveBeenCalled()
    expect(mockHandleIncomingMessage).toHaveBeenCalled()
  })

  it.each(['pending', 'retryable', 'unknown'])(
    'commits active inbound after durable terminal enqueue while Meta status is %s',
    async (deliveryStatus) => {
      enableActiveOutbox()
      scopeState.summary.lastNonProgressStatus = deliveryStatus
      const supabase = {} as never

      const outcome = await processInboundWork(
        supabase,
        { workId: 'work-1', payload },
        'owner-1',
        { freshnessGate: false },
      )

      expect(outcome).toBe('committed')
      expect(mockFinalizeOutboxScope).toHaveBeenCalledWith(supabase, {
        workId: 'work-1',
        lastOutboxId: 'outbox-1',
        messageKind: 'terminal',
        expiresAt: expect.any(String),
      })
      expect(mockComplete).toHaveBeenCalledWith(
        supabase,
        'work-1',
        'owner-1',
        'committed',
      )
    },
  )

  it('marks progress-only active inbound as missing_terminal_outbox', async () => {
    enableActiveOutbox()
    scopeState.summary = {
      userId: 'user-existing',
      hasProgress: true,
      hasDurableTerminal: false,
      lastNonProgressOutboxId: null,
      lastNonProgressStatus: null,
      unsafeFallbackFenced: false,
      idempotencyConflict: false,
      conflictError: null,
    }
    const supabase = {} as never

    const outcome = await processInboundWork(
      supabase,
      { workId: 'work-1', payload },
      'owner-1',
      { freshnessGate: false },
    )

    expect(outcome).toBe('failed_terminal')
    expect(mockFinalizeOutboxScope).not.toHaveBeenCalled()
    expect(mockComplete).toHaveBeenCalledWith(
      supabase,
      'work-1',
      'owner-1',
      'failed_terminal',
      'missing_terminal_outbox',
      expect.any(String),
    )
  })

  it('does not complete inbound a second time after unsafe fallback fenced it', async () => {
    enableActiveOutbox()
    scopeState.summary = {
      userId: 'user-existing',
      hasProgress: false,
      hasDurableTerminal: false,
      lastNonProgressOutboxId: null,
      lastNonProgressStatus: null,
      unsafeFallbackFenced: true,
      idempotencyConflict: false,
      conflictError: null,
    }

    const outcome = await processInboundWork(
      {} as never,
      { workId: 'work-1', payload },
      'owner-1',
      { freshnessGate: false },
    )

    expect(outcome).toBe('committed')
    expect(mockComplete).not.toHaveBeenCalled()
  })

  it('finalizes a durable pending fallback before returning the fenced outcome', async () => {
    enableActiveOutbox()
    scopeState.summary = {
      userId: 'user-existing',
      hasProgress: false,
      hasDurableTerminal: true,
      lastNonProgressOutboxId: 'outbox-fallback',
      lastNonProgressStatus: 'pending',
      unsafeFallbackFenced: true,
      idempotencyConflict: false,
      conflictError: null,
    }
    const supabase = {} as never

    const outcome = await processInboundWork(
      supabase,
      { workId: 'work-1', payload },
      'owner-1',
      { freshnessGate: false },
    )

    expect(outcome).toBe('committed')
    expect(mockFinalizeOutboxScope).toHaveBeenCalledWith(supabase, {
      workId: 'work-1',
      lastOutboxId: 'outbox-fallback',
      messageKind: 'terminal',
      expiresAt: expect.any(String),
    })
    expect(mockComplete).not.toHaveBeenCalled()
  })

  it.each(['context lookup', 'scope finalization'] as const)(
    'preserves the fenced committed outcome when %s fails after a durable fallback',
    async (failurePoint) => {
      enableActiveOutbox()
      scopeState.summary = {
        userId: 'user-existing',
        hasProgress: false,
        hasDurableTerminal: true,
        lastNonProgressOutboxId: 'outbox-fallback',
        lastNonProgressStatus: 'pending',
        unsafeFallbackFenced: true,
        idempotencyConflict: false,
        conflictError: null,
      }
      mockComplete.mockResolvedValue({ completed: false, status: 'committed' })
      if (failurePoint === 'context lookup') {
        mockGetActiveContext.mockResolvedValue({
          ok: false,
          error: { message: 'context unavailable', code: '08006' },
        })
      } else {
        mockFinalizeOutboxScope.mockResolvedValue({
          ok: false,
          error: { message: 'finalize unavailable', code: '08006' },
        })
      }
      const supabase = {} as never

      const outcome = await processInboundWork(
        supabase,
        { workId: 'work-1', payload },
        'owner-1',
        { freshnessGate: false },
      )

      expect(outcome).toBe('committed')
      expect(mockFinalizeOutboxScope).toHaveBeenCalledWith(
        supabase,
        expect.objectContaining({
          workId: 'work-1',
          lastOutboxId: 'outbox-fallback',
        }),
      )
      expect(mockComplete).not.toHaveBeenCalled()
    },
  )

  it('finalizes a durable fallback from a failed scope before preserving committed', async () => {
    enableActiveOutbox()
    mockRunWithOutboxScope.mockRejectedValueOnce(
      scopeExecutionError({
        hasDurableTerminal: true,
        lastNonProgressOutboxId: 'outbox-fallback',
        unsafeFallbackFenced: true,
      }),
    )
    const supabase = {} as never

    const outcome = await processInboundWork(
      supabase,
      { workId: 'work-1', payload },
      'owner-1',
      { freshnessGate: false },
    )

    expect(outcome).toBe('committed')
    expect(mockFinalizeOutboxScope).toHaveBeenCalledWith(supabase, {
      workId: 'work-1',
      lastOutboxId: 'outbox-fallback',
      messageKind: 'terminal',
      expiresAt: expect.any(String),
    })
    expect(mockComplete).not.toHaveBeenCalled()
  })

  it('returns a failed fenced scope directly when it has no durable terminal', async () => {
    enableActiveOutbox()
    mockRunWithOutboxScope.mockRejectedValueOnce(
      scopeExecutionError({
        hasDurableTerminal: false,
        lastNonProgressOutboxId: null,
        unsafeFallbackFenced: true,
      }),
    )

    const outcome = await processInboundWork(
      {} as never,
      { workId: 'work-1', payload },
      'owner-1',
      { freshnessGate: false },
    )

    expect(outcome).toBe('committed')
    expect(mockFinalizeOutboxScope).not.toHaveBeenCalled()
    expect(mockComplete).not.toHaveBeenCalled()
  })

  it('does not mask an idempotency conflict from a fenced failed scope', async () => {
    enableActiveOutbox()
    mockRunWithOutboxScope.mockRejectedValueOnce(
      scopeExecutionError({
        hasDurableTerminal: true,
        lastNonProgressOutboxId: 'outbox-fallback',
        unsafeFallbackFenced: true,
        idempotencyConflict: true,
        conflictError: 'payload hash differs after fallback',
      }),
    )

    const outcome = await processInboundWork(
      {} as never,
      { workId: 'work-1', payload },
      'owner-1',
      { freshnessGate: false },
    )

    expect(outcome).toBe('failed_terminal')
    expect(mockComplete).toHaveBeenCalledWith(
      expect.anything(),
      'work-1',
      'owner-1',
      'failed_terminal',
      'outbox_idempotency_conflict',
      'payload hash differs after fallback',
    )
    expect(mockFinalizeOutboxScope).not.toHaveBeenCalled()
  })

  it('fails terminal and blocks replay after an outbox idempotency conflict', async () => {
    enableActiveOutbox()
    scopeState.summary.idempotencyConflict = true
    scopeState.summary.conflictError = 'payload hash differs'
    scopeState.summary.lastNonProgressOutboxId = null

    const outcome = await processInboundWork(
      {} as never,
      { workId: 'work-1', payload },
      'owner-1',
      { freshnessGate: false },
    )

    expect(outcome).toBe('failed_terminal')
    expect(mockComplete).toHaveBeenCalledWith(
      expect.anything(),
      'work-1',
      'owner-1',
      'failed_terminal',
      'outbox_idempotency_conflict',
      'payload hash differs',
    )
    expect(mockFinalizeOutboxScope).not.toHaveBeenCalled()
  })

  it('finalizes shadow rows before committing the legacy delivery', async () => {
    vi.stubEnv('OUTBOX_MODE', 'shadow')
    vi.stubEnv('OUTBOX_GENERATION', 'generation-shadow')
    vi.stubEnv('INBOUND_WORK_ENABLED', 'true')

    const outcome = await processInboundWork(
      {} as never,
      { workId: 'work-1', payload },
      'owner-1',
      { freshnessGate: false },
    )

    expect(outcome).toBe('committed')
    expect(mockFinalizeOutboxScope).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        workId: 'work-1',
        lastOutboxId: 'outbox-1',
        messageKind: 'terminal',
      }),
    )
    expect(mockComplete).toHaveBeenCalledWith(
      expect.anything(),
      'work-1',
      'owner-1',
      'committed',
    )
  })

  it('finalizes the last response as prompt with the exact active context expiry', async () => {
    enableActiveOutbox()
    const supabase = {} as never
    mockGetActiveContext.mockResolvedValue({
      ok: true,
      context: {
        id: 'context-1',
        userId: 'user-existing',
        contextType: 'awaiting_confirmation',
        contextData: {},
        expiresAt: '2026-07-13T12:07:43.123Z',
        createdAt: '2026-07-13T12:00:00.000Z',
      },
    })

    const outcome = await processInboundWork(
      supabase,
      { workId: 'work-1', payload },
      'owner-1',
      { freshnessGate: false },
    )

    expect(outcome).toBe('committed')
    expect(mockRunWithOutboxScope).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'user-existing' }),
      expect.any(Function),
    )
    expect(mockGetActiveContext).toHaveBeenCalledWith(supabase, 'user-existing')
    expect(mockFinalizeOutboxScope).toHaveBeenCalledWith(supabase, {
      workId: 'work-1',
      lastOutboxId: 'outbox-1',
      messageKind: 'prompt',
      expiresAt: '2026-07-13T12:07:43.123Z',
    })
  })

  it('treats isolated recent_meal context as terminal with a fifteen-minute TTL', async () => {
    enableActiveOutbox()
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-07-13T12:00:00.000Z'))
    const supabase = {} as never
    mockGetActiveContext.mockResolvedValue({
      ok: true,
      context: {
        id: 'context-1',
        userId: 'user-1',
        contextType: 'recent_meal',
        contextData: {},
        expiresAt: '2026-07-13T12:05:00.000Z',
        createdAt: '2026-07-13T12:00:00.000Z',
      },
    })

    const outcome = await processInboundWork(
      supabase,
      { workId: 'work-1', payload },
      'owner-1',
      { freshnessGate: false },
    )

    expect(outcome).toBe('committed')
    expect(mockFinalizeOutboxScope).toHaveBeenCalledWith(supabase, {
      workId: 'work-1',
      lastOutboxId: 'outbox-1',
      messageKind: 'terminal',
      expiresAt: '2026-07-13T12:15:00.000Z',
    })
  })

  it('expires the row and fails terminal when active context lookup fails', async () => {
    enableActiveOutbox()
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-07-13T12:00:00.000Z'))
    mockGetActiveContext.mockResolvedValue({
      ok: false,
      error: { message: 'database unavailable', code: '08006' },
    })

    const outcome = await processInboundWork(
      {} as never,
      { workId: 'work-1', payload },
      'owner-1',
      { freshnessGate: false },
    )

    expect(outcome).toBe('failed_terminal')
    expect(mockFinalizeOutboxScope).toHaveBeenCalledWith(
      expect.anything(),
      {
        workId: 'work-1',
        lastOutboxId: 'outbox-1',
        messageKind: 'terminal',
        expiresAt: '2026-07-13T12:00:00.000Z',
      },
    )
    expect(mockComplete).toHaveBeenCalledWith(
      expect.anything(),
      'work-1',
      'owner-1',
      'failed_terminal',
      'outbox_context_lookup_failed',
      expect.stringContaining('database unavailable'),
    )
  })

  it('fails terminal while the DB gate quarantines a row whose expiry RPC failed', async () => {
    enableActiveOutbox()
    mockGetActiveContext.mockResolvedValue({
      ok: false,
      error: { message: 'context read failed', code: '08006' },
    })
    mockFinalizeOutboxScope.mockResolvedValue({
      ok: false,
      error: { message: 'finalize unavailable', code: '08006' },
    })

    const outcome = await processInboundWork(
      {} as never,
      { workId: 'work-1', payload },
      'owner-1',
      { freshnessGate: false },
    )

    expect(outcome).toBe('failed_terminal')
    expect(mockComplete).toHaveBeenCalledWith(
      expect.anything(),
      'work-1',
      'owner-1',
      'failed_terminal',
      'outbox_context_lookup_failed',
      expect.stringContaining('remains quarantined'),
    )
  })

  it('fails before claiming work when active bot outbox lacks inbound work', async () => {
    vi.stubEnv('OUTBOX_MODE', 'active')
    vi.stubEnv('OUTBOX_GENERATION', 'generation-1')
    vi.stubEnv('OUTBOX_CANARY_PERCENT', '100')
    vi.stubEnv('INBOUND_WORK_ENABLED', 'false')

    await expect(
      processInboundWork(
        {} as never,
        { workId: 'work-1', payload },
        'owner-1',
        { freshnessGate: false },
      ),
    ).rejects.toThrow(/INBOUND_WORK_ENABLED/)

    expect(mockClaim).not.toHaveBeenCalled()
    expect(mockHandleIncomingMessage).not.toHaveBeenCalled()
  })
})
