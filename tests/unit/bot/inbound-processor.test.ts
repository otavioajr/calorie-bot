import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const { mockHandleIncomingMessage } = vi.hoisted(() => ({
  mockHandleIncomingMessage: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('@/lib/bot/handler', () => ({
  handleIncomingMessage: mockHandleIncomingMessage,
  handleIncomingAudio: vi.fn(),
  handleIncomingImage: vi.fn(),
  handleUnsupportedMessage: vi.fn(),
}))

const mockClaim = vi.fn()
const mockComplete = vi.fn()
const mockHasNewer = vi.fn()

vi.mock('@/lib/db/queries/inbound-work', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/db/queries/inbound-work')>()
  return {
    ...actual,
    claimInboundWork: (...args: unknown[]) => mockClaim(...args),
    completeInboundWork: (...args: unknown[]) => mockComplete(...args),
    hasNewerInboundWork: (...args: unknown[]) => mockHasNewer(...args),
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
    mockClaim.mockResolvedValue({ claimed: true, status: 'processing', attempt: 1 })
    mockComplete.mockResolvedValue({ completed: true, status: 'committed' })
    mockHasNewer.mockResolvedValue(false)
  })

  afterEach(() => {
    vi.useRealTimers()
  })

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
    mockHasNewer.mockResolvedValue(false)
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
    mockHasNewer.mockResolvedValue(true)
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
})
