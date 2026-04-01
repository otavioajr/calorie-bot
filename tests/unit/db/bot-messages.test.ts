import { describe, it, expect, vi } from 'vitest'

describe('saveBotMessage', () => {
  it('calls insert with correct snake_case column names', async () => {
    const { saveBotMessage } = await import('@/lib/db/queries/bot-messages')

    const insertChain: Record<string, unknown> = {}
    insertChain.insert = vi.fn(() => Promise.resolve({ data: null, error: null }))

    const supabase = { from: vi.fn(() => insertChain) }

    await saveBotMessage(supabase as never, {
      userId: 'user-1',
      messageId: 'msg-abc',
      direction: 'incoming',
      resourceType: 'meal',
      resourceId: 'meal-123',
      metadata: { foo: 'bar' },
    })

    expect(supabase.from).toHaveBeenCalledWith('bot_messages')
    expect(insertChain.insert).toHaveBeenCalledWith({
      user_id: 'user-1',
      message_id: 'msg-abc',
      direction: 'incoming',
      resource_type: 'meal',
      resource_id: 'meal-123',
      metadata: { foo: 'bar' },
    })
  })

  it('coerces undefined resourceType and resourceId to null', async () => {
    const { saveBotMessage } = await import('@/lib/db/queries/bot-messages')

    const insertChain: Record<string, unknown> = {}
    insertChain.insert = vi.fn(() => Promise.resolve({ data: null, error: null }))

    const supabase = { from: vi.fn(() => insertChain) }

    await saveBotMessage(supabase as never, {
      userId: 'user-2',
      messageId: 'msg-xyz',
      direction: 'outgoing',
    })

    expect(insertChain.insert).toHaveBeenCalledWith({
      user_id: 'user-2',
      message_id: 'msg-xyz',
      direction: 'outgoing',
      resource_type: null,
      resource_id: null,
      metadata: null,
    })
  })

  it('does not throw on DB error (fire and forget)', async () => {
    const { saveBotMessage } = await import('@/lib/db/queries/bot-messages')

    const insertChain: Record<string, unknown> = {}
    insertChain.insert = vi.fn(() =>
      Promise.resolve({ data: null, error: { message: 'insert failed' } }),
    )

    const supabase = { from: vi.fn(() => insertChain) }

    await expect(
      saveBotMessage(supabase as never, {
        userId: 'user-3',
        messageId: 'msg-err',
        direction: 'incoming',
      }),
    ).resolves.toBeUndefined()
  })
})

describe('getMessageResource', () => {
  it('returns mapped data with camelCase keys', async () => {
    const { getMessageResource } = await import('@/lib/db/queries/bot-messages')

    const chain: Record<string, unknown> = {}
    chain.select = vi.fn(() => chain)
    chain.eq = vi.fn(() => chain)
    chain.limit = vi.fn(() => chain)
    chain.single = vi.fn(() =>
      Promise.resolve({
        data: {
          direction: 'outgoing',
          resource_type: 'summary',
          resource_id: 'sum-456',
          metadata: { key: 'value' },
        },
        error: null,
      }),
    )

    const supabase = { from: vi.fn(() => chain) }

    const result = await getMessageResource(supabase as never, 'msg-123')

    expect(supabase.from).toHaveBeenCalledWith('bot_messages')
    expect(chain.select).toHaveBeenCalledWith('direction, resource_type, resource_id, metadata')
    expect(chain.eq).toHaveBeenCalledWith('message_id', 'msg-123')
    expect(chain.limit).toHaveBeenCalledWith(1)
    expect(result).toEqual({
      direction: 'outgoing',
      resourceType: 'summary',
      resourceId: 'sum-456',
      metadata: { key: 'value' },
    })
  })

  it('returns null when record is not found (error)', async () => {
    const { getMessageResource } = await import('@/lib/db/queries/bot-messages')

    const chain: Record<string, unknown> = {}
    chain.select = vi.fn(() => chain)
    chain.eq = vi.fn(() => chain)
    chain.limit = vi.fn(() => chain)
    chain.single = vi.fn(() =>
      Promise.resolve({ data: null, error: { message: 'not found' } }),
    )

    const supabase = { from: vi.fn(() => chain) }

    const result = await getMessageResource(supabase as never, 'missing-msg')

    expect(result).toBeNull()
  })

  it('returns null when data is null without error', async () => {
    const { getMessageResource } = await import('@/lib/db/queries/bot-messages')

    const chain: Record<string, unknown> = {}
    chain.select = vi.fn(() => chain)
    chain.eq = vi.fn(() => chain)
    chain.limit = vi.fn(() => chain)
    chain.single = vi.fn(() => Promise.resolve({ data: null, error: null }))

    const supabase = { from: vi.fn(() => chain) }

    const result = await getMessageResource(supabase as never, 'missing-msg')

    expect(result).toBeNull()
  })
})

describe('cleanupOldMessages', () => {
  it('calls delete with a cutoff date 30 days ago by default', async () => {
    const { cleanupOldMessages } = await import('@/lib/db/queries/bot-messages')

    const chain: Record<string, unknown> = {}
    chain.delete = vi.fn(() => chain)
    chain.lt = vi.fn(() => Promise.resolve({ data: null, error: null, count: 5 }))

    const supabase = { from: vi.fn(() => chain) }

    const before = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)
    const result = await cleanupOldMessages(supabase as never)
    const after = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)

    expect(supabase.from).toHaveBeenCalledWith('bot_messages')
    expect(chain.delete).toHaveBeenCalled()

    const cutoffArg = (chain.lt as ReturnType<typeof vi.fn>).mock.calls[0]
    expect(cutoffArg[0]).toBe('created_at')

    const cutoffDate = new Date(cutoffArg[1] as string)
    expect(cutoffDate.getTime()).toBeGreaterThanOrEqual(before.getTime())
    expect(cutoffDate.getTime()).toBeLessThanOrEqual(after.getTime())

    expect(result).toBe(5)
  })

  it('uses custom retentionDays when provided', async () => {
    const { cleanupOldMessages } = await import('@/lib/db/queries/bot-messages')

    const chain: Record<string, unknown> = {}
    chain.delete = vi.fn(() => chain)
    chain.lt = vi.fn(() => Promise.resolve({ data: null, error: null, count: 2 }))

    const supabase = { from: vi.fn(() => chain) }

    const before = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000)
    const result = await cleanupOldMessages(supabase as never, 7)
    const after = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000)

    const cutoffArg = (chain.lt as ReturnType<typeof vi.fn>).mock.calls[0]
    const cutoffDate = new Date(cutoffArg[1] as string)
    expect(cutoffDate.getTime()).toBeGreaterThanOrEqual(before.getTime())
    expect(cutoffDate.getTime()).toBeLessThanOrEqual(after.getTime())

    expect(result).toBe(2)
  })

  it('returns 0 and does not throw on DB error', async () => {
    const { cleanupOldMessages } = await import('@/lib/db/queries/bot-messages')

    const chain: Record<string, unknown> = {}
    chain.delete = vi.fn(() => chain)
    chain.lt = vi.fn(() =>
      Promise.resolve({ data: null, error: { message: 'delete failed' }, count: null }),
    )

    const supabase = { from: vi.fn(() => chain) }

    const result = await cleanupOldMessages(supabase as never)

    expect(result).toBe(0)
  })
})
