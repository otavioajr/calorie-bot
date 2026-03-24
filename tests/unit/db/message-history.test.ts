import { describe, it, expect, vi } from 'vitest'

// Helper to build a mock Supabase query chain
function buildChain(result: { data: unknown; error: unknown }) {
  const chain: Record<string, unknown> = {}
  const terminal = () => Promise.resolve(result)
  chain.select = vi.fn(() => chain)
  chain.eq = vi.fn(() => chain)
  chain.order = vi.fn(() => chain)
  chain.limit = vi.fn(terminal)
  chain.insert = vi.fn(terminal)
  chain.delete = vi.fn(() => chain)
  chain.not = vi.fn(terminal)
  return chain
}

function buildClient(chain: Record<string, unknown>) {
  return {
    from: vi.fn(() => chain),
  }
}

describe('MAX_HISTORY_MESSAGES', () => {
  it('is 10', async () => {
    const { MAX_HISTORY_MESSAGES } = await import('@/lib/db/queries/message-history')
    expect(MAX_HISTORY_MESSAGES).toBe(10)
  })
})

describe('getRecentMessages', () => {
  it('queries with ascending: false, limit 10, and reverses the result', async () => {
    const { getRecentMessages } = await import('@/lib/db/queries/message-history')

    const mockData = [
      { role: 'assistant', content: 'newest' },
      { role: 'user', content: 'middle' },
      { role: 'user', content: 'oldest' },
    ]

    const chain: Record<string, unknown> = {}
    chain.select = vi.fn(() => chain)
    chain.eq = vi.fn(() => chain)
    chain.order = vi.fn(() => chain)
    chain.limit = vi.fn(() => Promise.resolve({ data: mockData, error: null }))

    const supabase = { from: vi.fn(() => chain) }

    const result = await getRecentMessages(supabase as never, 'user-1')

    expect(supabase.from).toHaveBeenCalledWith('message_history')
    expect(chain.select).toHaveBeenCalledWith('role, content')
    expect(chain.eq).toHaveBeenCalledWith('user_id', 'user-1')
    expect(chain.order).toHaveBeenCalledWith('created_at', { ascending: false })
    expect(chain.limit).toHaveBeenCalledWith(10)

    // Should be reversed from what the DB returned
    expect(result).toHaveLength(3)
    expect(result[0].content).toBe('oldest')
    expect(result[1].content).toBe('middle')
    expect(result[2].content).toBe('newest')
  })

  it('returns empty array on DB error', async () => {
    const { getRecentMessages } = await import('@/lib/db/queries/message-history')

    const chain: Record<string, unknown> = {}
    chain.select = vi.fn(() => chain)
    chain.eq = vi.fn(() => chain)
    chain.order = vi.fn(() => chain)
    chain.limit = vi.fn(() => Promise.resolve({ data: null, error: { message: 'DB error' } }))

    const supabase = { from: vi.fn(() => chain) }

    const result = await getRecentMessages(supabase as never, 'user-1')

    expect(result).toEqual([])
  })

  it('returns empty array when data is null without error', async () => {
    const { getRecentMessages } = await import('@/lib/db/queries/message-history')

    const chain: Record<string, unknown> = {}
    chain.select = vi.fn(() => chain)
    chain.eq = vi.fn(() => chain)
    chain.order = vi.fn(() => chain)
    chain.limit = vi.fn(() => Promise.resolve({ data: null, error: null }))

    const supabase = { from: vi.fn(() => chain) }

    const result = await getRecentMessages(supabase as never, 'user-1')

    expect(result).toEqual([])
  })

  it('returns empty array when data is empty', async () => {
    const { getRecentMessages } = await import('@/lib/db/queries/message-history')

    const chain: Record<string, unknown> = {}
    chain.select = vi.fn(() => chain)
    chain.eq = vi.fn(() => chain)
    chain.order = vi.fn(() => chain)
    chain.limit = vi.fn(() => Promise.resolve({ data: [], error: null }))

    const supabase = { from: vi.fn(() => chain) }

    const result = await getRecentMessages(supabase as never, 'user-1')

    expect(result).toEqual([])
  })
})

describe('saveMessage', () => {
  it('inserts with correct fields (user_id, role, content)', async () => {
    const { saveMessage } = await import('@/lib/db/queries/message-history')

    // First from() call: insert
    const insertChain: Record<string, unknown> = {}
    insertChain.insert = vi.fn(() => Promise.resolve({ data: null, error: null }))

    // Second from() call: select for pruning
    const selectChain: Record<string, unknown> = {}
    selectChain.select = vi.fn(() => selectChain)
    selectChain.eq = vi.fn(() => selectChain)
    selectChain.order = vi.fn(() => selectChain)
    // Return fewer than MAX_HISTORY_MESSAGES so pruning is skipped
    selectChain.limit = vi.fn(() => Promise.resolve({ data: [{ id: '1' }], error: null }))

    let callCount = 0
    const supabase = {
      from: vi.fn(() => {
        callCount++
        return callCount === 1 ? insertChain : selectChain
      }),
    }

    await saveMessage(supabase as never, 'user-1', 'user', 'Comi arroz com feijão')

    expect(supabase.from).toHaveBeenCalledWith('message_history')
    expect(insertChain.insert).toHaveBeenCalledWith({
      user_id: 'user-1',
      role: 'user',
      content: 'Comi arroz com feijão',
    })
  })

  it('inserts assistant message with correct role', async () => {
    const { saveMessage } = await import('@/lib/db/queries/message-history')

    const insertChain: Record<string, unknown> = {}
    insertChain.insert = vi.fn(() => Promise.resolve({ data: null, error: null }))

    const selectChain: Record<string, unknown> = {}
    selectChain.select = vi.fn(() => selectChain)
    selectChain.eq = vi.fn(() => selectChain)
    selectChain.order = vi.fn(() => selectChain)
    selectChain.limit = vi.fn(() => Promise.resolve({ data: [{ id: '1' }], error: null }))

    let callCount = 0
    const supabase = {
      from: vi.fn(() => {
        callCount++
        return callCount === 1 ? insertChain : selectChain
      }),
    }

    await saveMessage(supabase as never, 'user-1', 'assistant', 'Registrado! 📊 Hoje: 500 / 2000 kcal')

    expect(insertChain.insert).toHaveBeenCalledWith({
      user_id: 'user-1',
      role: 'assistant',
      content: 'Registrado! 📊 Hoje: 500 / 2000 kcal',
    })
  })

  it('prunes old messages when history is at MAX_HISTORY_MESSAGES limit', async () => {
    const { saveMessage, MAX_HISTORY_MESSAGES } = await import('@/lib/db/queries/message-history')

    const keepRows = Array.from({ length: MAX_HISTORY_MESSAGES }, (_, i) => ({ id: `id-${i}` }))

    const insertChain: Record<string, unknown> = {}
    insertChain.insert = vi.fn(() => Promise.resolve({ data: null, error: null }))

    const selectChain: Record<string, unknown> = {}
    selectChain.select = vi.fn(() => selectChain)
    selectChain.eq = vi.fn(() => selectChain)
    selectChain.order = vi.fn(() => selectChain)
    selectChain.limit = vi.fn(() => Promise.resolve({ data: keepRows, error: null }))

    const deleteChain: Record<string, unknown> = {}
    deleteChain.delete = vi.fn(() => deleteChain)
    deleteChain.eq = vi.fn(() => deleteChain)
    deleteChain.not = vi.fn(() => Promise.resolve({ data: null, error: null }))

    let callCount = 0
    const supabase = {
      from: vi.fn(() => {
        callCount++
        if (callCount === 1) return insertChain
        if (callCount === 2) return selectChain
        return deleteChain
      }),
    }

    await saveMessage(supabase as never, 'user-1', 'user', 'test message')

    expect(deleteChain.delete).toHaveBeenCalled()
    expect(deleteChain.eq).toHaveBeenCalledWith('user_id', 'user-1')
    expect(deleteChain.not).toHaveBeenCalledWith(
      'id',
      'in',
      `(${keepRows.map((r) => r.id).join(',')})`,
    )
  })

  it('does not prune when history is below MAX_HISTORY_MESSAGES limit', async () => {
    const { saveMessage } = await import('@/lib/db/queries/message-history')

    const insertChain: Record<string, unknown> = {}
    insertChain.insert = vi.fn(() => Promise.resolve({ data: null, error: null }))

    // Return fewer than 10 rows
    const selectChain: Record<string, unknown> = {}
    selectChain.select = vi.fn(() => selectChain)
    selectChain.eq = vi.fn(() => selectChain)
    selectChain.order = vi.fn(() => selectChain)
    selectChain.limit = vi.fn(() => Promise.resolve({ data: [{ id: '1' }, { id: '2' }], error: null }))

    const deleteChain: Record<string, unknown> = {}
    deleteChain.delete = vi.fn(() => deleteChain)

    let callCount = 0
    const supabase = {
      from: vi.fn(() => {
        callCount++
        if (callCount === 1) return insertChain
        if (callCount === 2) return selectChain
        return deleteChain
      }),
    }

    await saveMessage(supabase as never, 'user-1', 'user', 'test')

    expect(deleteChain.delete).not.toHaveBeenCalled()
  })
})

describe('clearHistory', () => {
  it('deletes all messages for the user', async () => {
    const { clearHistory } = await import('@/lib/db/queries/message-history')

    const chain: Record<string, unknown> = {}
    chain.delete = vi.fn(() => chain)
    chain.eq = vi.fn(() => Promise.resolve({ data: null, error: null }))

    const supabase = { from: vi.fn(() => chain) }

    await clearHistory(supabase as never, 'user-1')

    expect(supabase.from).toHaveBeenCalledWith('message_history')
    expect(chain.delete).toHaveBeenCalled()
    expect(chain.eq).toHaveBeenCalledWith('user_id', 'user-1')
  })

  it('does not throw on error (fire and forget)', async () => {
    const { clearHistory } = await import('@/lib/db/queries/message-history')

    const chain: Record<string, unknown> = {}
    chain.delete = vi.fn(() => chain)
    chain.eq = vi.fn(() => Promise.resolve({ data: null, error: { message: 'DB error' } }))

    const supabase = { from: vi.fn(() => chain) }

    await expect(clearHistory(supabase as never, 'user-1')).resolves.toBeUndefined()
  })
})
