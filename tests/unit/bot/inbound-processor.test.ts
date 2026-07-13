import { describe, it, expect, vi, beforeEach } from 'vitest'

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

vi.mock('@/lib/db/queries/inbound-work', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/db/queries/inbound-work')>()
  return {
    ...actual,
    claimInboundWork: (...args: unknown[]) => mockClaim(...args),
    completeInboundWork: (...args: unknown[]) => mockComplete(...args),
  }
})

import { processInboundWork } from '@/lib/bot/inbound-processor'

describe('processInboundWork', () => {
  const supabase = {} as never
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
  })

  it('skips when claim is not granted', async () => {
    mockClaim.mockResolvedValue({ claimed: false, status: 'committed', attempt: 1 })
    const outcome = await processInboundWork(supabase, { workId: 'work-1', payload }, 'owner-1')
    expect(outcome).toBe('skipped')
    expect(mockHandleIncomingMessage).not.toHaveBeenCalled()
  })

  it('commits after successful handler', async () => {
    const outcome = await processInboundWork(supabase, { workId: 'work-1', payload }, 'owner-1')
    expect(outcome).toBe('committed')
    expect(mockHandleIncomingMessage).toHaveBeenCalled()
    expect(mockComplete).toHaveBeenCalledWith(supabase, 'work-1', 'owner-1', 'committed')
  })

  it('marks failed_retryable when handler throws', async () => {
    mockHandleIncomingMessage.mockRejectedValueOnce(new Error('boom'))
    const outcome = await processInboundWork(supabase, { workId: 'work-1', payload }, 'owner-1')
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
})
