import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// ---------------------------------------------------------------------------
// Mock Supabase service role client before importing state module
// ---------------------------------------------------------------------------

const mockDelete = vi.fn()
const mockInsert = vi.fn()
const mockSelect = vi.fn()
const mockEq = vi.fn()
const mockGt = vi.fn()
const mockOrder = vi.fn()
const mockLimit = vi.fn()
const mockSingle = vi.fn()

// We build a chainable mock object that supports all the query patterns used
// by getActiveContext, upsertContext and deleteContext.
function makeMockFrom() {
  return {
    delete: vi.fn().mockReturnValue({
      eq: mockEq.mockReturnValue({ error: null }),
    }),
    insert: vi.fn().mockReturnValue({ error: null }),
    select: vi.fn().mockReturnValue({
      eq: vi.fn().mockReturnValue({
        gt: vi.fn().mockReturnValue({
          order: vi.fn().mockReturnValue({
            limit: vi.fn().mockReturnValue({
              single: mockSingle,
            }),
          }),
        }),
      }),
    }),
  }
}

let mockFrom: ReturnType<typeof vi.fn>

vi.mock('@/lib/db/supabase', () => ({
  createServiceRoleClient: () => ({
    get from() {
      return mockFrom
    },
  }),
}))

// Import after mocks are registered
import {
  getState,
  setState,
  clearState,
  CONTEXT_TTLS,
  type ContextType,
} from '@/lib/bot/state'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const NOW = new Date('2026-03-21T12:00:00.000Z')

function makeDbRow(overrides: Partial<{
  id: string
  user_id: string
  context_type: ContextType
  context_data: Record<string, unknown>
  expires_at: string
  created_at: string
}> = {}) {
  return {
    id: 'ctx-uuid-1',
    user_id: 'user-123',
    context_type: 'awaiting_confirmation' as ContextType,
    context_data: { meal_id: 'abc' },
    expires_at: new Date(NOW.getTime() + 5 * 60 * 1000).toISOString(),
    created_at: NOW.toISOString(),
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// CONTEXT_TTLS
// ---------------------------------------------------------------------------

describe('CONTEXT_TTLS', () => {
  it('onboarding TTL is 1440 minutes', () => {
    expect(CONTEXT_TTLS.onboarding).toBe(1440)
  })

  it('awaiting_confirmation TTL is 1440 minutes', () => {
    expect(CONTEXT_TTLS.awaiting_confirmation).toBe(1440)
  })

  it('awaiting_clarification TTL is 60 minutes', () => {
    expect(CONTEXT_TTLS.awaiting_clarification).toBe(60)
  })

  it('awaiting_correction TTL is 60 minutes', () => {
    expect(CONTEXT_TTLS.awaiting_correction).toBe(60)
  })

  it('awaiting_weight TTL is 60 minutes', () => {
    expect(CONTEXT_TTLS.awaiting_weight).toBe(60)
  })

  it('settings_menu TTL is 30 minutes', () => {
    expect(CONTEXT_TTLS.settings_menu).toBe(30)
  })

  it('settings_change TTL is 30 minutes', () => {
    expect(CONTEXT_TTLS.settings_change).toBe(30)
  })
})

// ---------------------------------------------------------------------------
// getState
// ---------------------------------------------------------------------------

describe('getState', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(NOW)

    mockFrom = vi.fn().mockReturnValue({
      select: vi.fn().mockReturnValue({
        eq: vi.fn().mockReturnValue({
          gt: vi.fn().mockReturnValue({
            order: vi.fn().mockReturnValue({
              limit: vi.fn().mockReturnValue({
                single: mockSingle,
              }),
            }),
          }),
        }),
      }),
      delete: vi.fn().mockReturnValue({
        eq: mockEq.mockReturnValue({ error: null }),
      }),
      insert: mockInsert.mockReturnValue({ error: null }),
    })
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.clearAllMocks()
  })

  it('returns a ConversationContext when an active context exists', async () => {
    const row = makeDbRow()
    mockSingle.mockResolvedValue({ data: row, error: null })

    const result = await getState('user-123')

    expect(result).not.toBeNull()
    expect(result?.userId).toBe('user-123')
    expect(result?.contextType).toBe('awaiting_confirmation')
    expect(result?.contextData).toEqual({ meal_id: 'abc' })
    expect(result?.expiresAt).toBe(row.expires_at)
  })

  it('maps DB snake_case columns to camelCase on the result', async () => {
    const row = makeDbRow({ context_type: 'onboarding', context_data: { step: 1 } })
    mockSingle.mockResolvedValue({ data: row, error: null })

    const result = await getState('user-123')

    expect(result?.contextType).toBe('onboarding')
    expect(result?.contextData).toEqual({ step: 1 })
    expect(result?.createdAt).toBe(row.created_at)
  })

  it('returns null when no context exists (PGRST116 error from Supabase)', async () => {
    // Supabase returns PGRST116 when .single() finds no rows
    mockSingle.mockResolvedValue({
      data: null,
      error: { code: 'PGRST116', message: 'The result contains 0 rows' },
    })

    const result = await getState('user-123')

    expect(result).toBeNull()
  })

  it('returns null when query returns null data', async () => {
    mockSingle.mockResolvedValue({ data: null, error: null })

    const result = await getState('user-123')

    expect(result).toBeNull()
  })

  it('returns null when Supabase returns an unexpected error', async () => {
    mockSingle.mockResolvedValue({
      data: null,
      error: { code: '500', message: 'internal error' },
    })

    const result = await getState('user-123')

    expect(result).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// setState
// ---------------------------------------------------------------------------

describe('setState', () => {
  let mockDeleteEq: ReturnType<typeof vi.fn>
  let mockDeleteFn: ReturnType<typeof vi.fn>
  let mockInsertFn: ReturnType<typeof vi.fn>

  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(NOW)

    mockDeleteEq = vi.fn().mockResolvedValue({ error: null })
    mockDeleteFn = vi.fn().mockReturnValue({ eq: mockDeleteEq })
    mockInsertFn = vi.fn().mockResolvedValue({ error: null })

    mockFrom = vi.fn().mockReturnValue({
      delete: mockDeleteFn,
      insert: mockInsertFn,
      select: vi.fn().mockReturnValue({
        eq: vi.fn().mockReturnValue({
          gt: vi.fn().mockReturnValue({
            order: vi.fn().mockReturnValue({
              limit: vi.fn().mockReturnValue({ single: mockSingle }),
            }),
          }),
        }),
      }),
    })
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.clearAllMocks()
  })

  it('calls delete before insert (upsert = delete + insert)', async () => {
    const callOrder: string[] = []
    mockDeleteFn.mockImplementation(() => {
      callOrder.push('delete')
      return { eq: mockDeleteEq }
    })
    mockInsertFn.mockImplementation(() => {
      callOrder.push('insert')
      return Promise.resolve({ error: null })
    })

    await setState('user-123', 'awaiting_confirmation', { meal_id: 'xyz' })

    expect(callOrder).toEqual(['delete', 'insert'])
  })

  it('deletes by user_id before inserting', async () => {
    await setState('user-123', 'awaiting_confirmation', { meal_id: 'xyz' })

    expect(mockDeleteEq).toHaveBeenCalledWith('user_id', 'user-123')
  })

  it('inserts a row with the correct user_id, context_type and context_data', async () => {
    await setState('user-123', 'awaiting_clarification', { original: 'msg' })

    expect(mockInsertFn).toHaveBeenCalledWith(
      expect.objectContaining({
        user_id: 'user-123',
        context_type: 'awaiting_clarification',
        context_data: { original: 'msg' },
      })
    )
  })

  it('calculates expiresAt correctly for awaiting_confirmation (1440 min)', async () => {
    await setState('user-123', 'awaiting_confirmation', {})

    const expectedExpiry = new Date(NOW.getTime() + 1440 * 60 * 1000).toISOString()
    expect(mockInsertFn).toHaveBeenCalledWith(
      expect.objectContaining({ expires_at: expectedExpiry })
    )
  })

  it('calculates expiresAt correctly for onboarding (1440 min = 24h)', async () => {
    await setState('user-456', 'onboarding', { step: 'name' })

    const expectedExpiry = new Date(NOW.getTime() + 1440 * 60 * 1000).toISOString()
    expect(mockInsertFn).toHaveBeenCalledWith(
      expect.objectContaining({ expires_at: expectedExpiry })
    )
  })

  it('calculates expiresAt correctly for awaiting_clarification (60 min)', async () => {
    await setState('user-789', 'awaiting_clarification', {})

    const expectedExpiry = new Date(NOW.getTime() + 60 * 60 * 1000).toISOString()
    expect(mockInsertFn).toHaveBeenCalledWith(
      expect.objectContaining({ expires_at: expectedExpiry })
    )
  })

  it('calculates expiresAt correctly for settings_menu (30 min)', async () => {
    await setState('user-000', 'settings_menu', {})

    const expectedExpiry = new Date(NOW.getTime() + 30 * 60 * 1000).toISOString()
    expect(mockInsertFn).toHaveBeenCalledWith(
      expect.objectContaining({ expires_at: expectedExpiry })
    )
  })

  it('throws when the delete step returns an error', async () => {
    mockDeleteEq.mockResolvedValue({ error: { message: 'delete failed' } })

    await expect(setState('user-err', 'settings_menu', {})).rejects.toThrow()
  })

  it('throws when the insert step returns an error', async () => {
    mockInsertFn.mockResolvedValue({ error: { message: 'insert failed' } })

    await expect(setState('user-err', 'settings_menu', {})).rejects.toThrow()
  })
})

// ---------------------------------------------------------------------------
// clearState
// ---------------------------------------------------------------------------

describe('clearState', () => {
  let mockDeleteEq: ReturnType<typeof vi.fn>
  let mockDeleteFn: ReturnType<typeof vi.fn>

  beforeEach(() => {
    mockDeleteEq = vi.fn().mockResolvedValue({ error: null })
    mockDeleteFn = vi.fn().mockReturnValue({ eq: mockDeleteEq })

    mockFrom = vi.fn().mockReturnValue({
      delete: mockDeleteFn,
      insert: vi.fn().mockResolvedValue({ error: null }),
      select: vi.fn().mockReturnValue({
        eq: vi.fn().mockReturnValue({
          gt: vi.fn().mockReturnValue({
            order: vi.fn().mockReturnValue({
              limit: vi.fn().mockReturnValue({ single: mockSingle }),
            }),
          }),
        }),
      }),
    })

    vi.clearAllMocks()
  })

  it('calls delete with the correct user_id', async () => {
    await clearState('user-123')

    expect(mockDeleteFn).toHaveBeenCalled()
    expect(mockDeleteEq).toHaveBeenCalledWith('user_id', 'user-123')
  })

  it('does not call insert (only delete)', async () => {
    const mockInsertLocal = vi.fn().mockResolvedValue({ error: null })
    mockFrom = vi.fn().mockReturnValue({
      delete: mockDeleteFn,
      insert: mockInsertLocal,
      select: vi.fn(),
    })

    await clearState('user-clear')

    expect(mockInsertLocal).not.toHaveBeenCalled()
  })

  it('throws when delete returns an error', async () => {
    mockDeleteEq.mockResolvedValue({ error: { message: 'delete failed' } })

    await expect(clearState('user-err')).rejects.toThrow()
  })
})
