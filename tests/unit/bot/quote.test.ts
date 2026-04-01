import { describe, it, expect, vi, beforeEach } from 'vitest'

const { mockGetMessageResource } = vi.hoisted(() => ({
  mockGetMessageResource: vi.fn(),
}))

vi.mock('@/lib/db/queries/bot-messages', () => ({
  getMessageResource: mockGetMessageResource,
}))

vi.mock('@/lib/db/supabase', () => ({
  createServiceRoleClient: () => ({} as unknown),
}))

import { resolveQuote } from '@/lib/bot/quote'
import type { QuoteContext } from '@/lib/bot/quote'

describe('resolveQuote', () => {
  beforeEach(() => vi.clearAllMocks())

  it('returns QuoteContext when message_id found in bot_messages', async () => {
    mockGetMessageResource.mockResolvedValue({
      direction: 'outgoing',
      resourceType: 'meal',
      resourceId: 'meal-uuid-1',
      metadata: null,
    })

    const result = await resolveQuote('wamid.quoted123')

    expect(result).not.toBeNull()
    const ctx = result as QuoteContext
    expect(ctx.quotedMessageId).toBe('wamid.quoted123')
    expect(ctx.direction).toBe('outgoing')
    expect(ctx.resourceType).toBe('meal')
    expect(ctx.resourceId).toBe('meal-uuid-1')
    expect(ctx.metadata).toBeUndefined()
  })

  it('returns QuoteContext with metadata when present', async () => {
    const meta = { items: [{ food: 'Arroz', calories: 195 }] }
    mockGetMessageResource.mockResolvedValue({
      direction: 'outgoing',
      resourceType: 'query',
      resourceId: null,
      metadata: meta,
    })

    const result = await resolveQuote('wamid.query456')

    expect(result).not.toBeNull()
    expect(result!.metadata).toEqual(meta)
  })

  it('returns null when message_id not found', async () => {
    mockGetMessageResource.mockResolvedValue(null)

    const result = await resolveQuote('wamid.unknown789')

    expect(result).toBeNull()
  })

  it('returns null when quotedMessageId is undefined', async () => {
    const result = await resolveQuote(undefined)

    expect(result).toBeNull()
    expect(mockGetMessageResource).not.toHaveBeenCalled()
  })
})
