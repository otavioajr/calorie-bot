import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'

// ---------------------------------------------------------------------------
// Hoist mocks
// ---------------------------------------------------------------------------
const {
  mockGetMealDetailByType,
  mockFormatMealDetail,
  mockChat,
  mockGetLLMProvider,
} = vi.hoisted(() => {
  const mockChat = vi.fn().mockResolvedValue('{"meal_type": "breakfast", "date": "2026-03-28"}')
  return {
    mockGetMealDetailByType: vi.fn().mockResolvedValue([]),
    mockFormatMealDetail: vi.fn().mockReturnValue('formatted result'),
    mockChat,
    mockGetLLMProvider: vi.fn().mockReturnValue({ chat: mockChat }),
  }
})

vi.mock('@/lib/db/queries/meals', () => ({
  getMealDetailByType: mockGetMealDetailByType,
}))

vi.mock('@/lib/utils/formatters', () => ({
  formatMealDetail: mockFormatMealDetail,
}))

vi.mock('@/lib/llm/index', () => ({
  getLLMProvider: mockGetLLMProvider,
}))

import { handleMealDetail, parseMealType, parseDateFromMessage } from '@/lib/bot/flows/meal-detail'

// ---------------------------------------------------------------------------
// parseMealType
// ---------------------------------------------------------------------------
describe('parseMealType', () => {
  it('parses "café da manhã" as breakfast', () => {
    expect(parseMealType('o que comi no café da manhã?')).toBe('breakfast')
  })

  it('parses "cafe" as breakfast', () => {
    expect(parseMealType('o que comi no cafe?')).toBe('breakfast')
  })

  it('parses "almoço" as lunch', () => {
    expect(parseMealType('o que comi no almoço?')).toBe('lunch')
  })

  it('parses "lanche" as snack', () => {
    expect(parseMealType('comi no lanche')).toBe('snack')
  })

  it('parses "jantar" as dinner', () => {
    expect(parseMealType('o que comi no jantar?')).toBe('dinner')
  })

  it('parses "janta" as dinner', () => {
    expect(parseMealType('o que comi na janta?')).toBe('dinner')
  })

  it('parses "ceia" as supper', () => {
    expect(parseMealType('o que comi na ceia?')).toBe('supper')
  })

  it('returns null when no meal type found', () => {
    expect(parseMealType('o que comi hoje?')).toBeNull()
  })

  it('handles accented input', () => {
    expect(parseMealType('o que comi no almoço?')).toBe('lunch')
  })

  it('is case insensitive', () => {
    expect(parseMealType('O QUE COMI NO ALMOÇO?')).toBe('lunch')
  })

  it('does not parse standalone "manha" as breakfast', () => {
    expect(parseMealType('de manha comi muito')).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// parseDateFromMessage
// ---------------------------------------------------------------------------
describe('parseDateFromMessage', () => {
  // Fix the current date for deterministic tests
  const baseDate = new Date('2026-04-01T12:00:00Z') // a Wednesday

  it('returns today when no date indicator found, wasExplicit=false', () => {
    const result = parseDateFromMessage('o que comi no café?', baseDate)
    expect(result.date.toISOString().substring(0, 10)).toBe('2026-04-01')
    expect(result.wasExplicit).toBe(false)
  })

  it('parses "hoje", wasExplicit=true', () => {
    const result = parseDateFromMessage('o que comi no café hoje?', baseDate)
    expect(result.date.toISOString().substring(0, 10)).toBe('2026-04-01')
    expect(result.wasExplicit).toBe(true)
  })

  it('parses "ontem", wasExplicit=true', () => {
    const result = parseDateFromMessage('o que comi no almoço ontem?', baseDate)
    expect(result.date.toISOString().substring(0, 10)).toBe('2026-03-31')
    expect(result.wasExplicit).toBe(true)
  })

  it('parses "anteontem", wasExplicit=true', () => {
    const result = parseDateFromMessage('o que comi no jantar anteontem?', baseDate)
    expect(result.date.toISOString().substring(0, 10)).toBe('2026-03-30')
    expect(result.wasExplicit).toBe(true)
  })

  it('parses "segunda" (last Monday from Wednesday), wasExplicit=true', () => {
    const result = parseDateFromMessage('o que comi no almoço segunda?', baseDate)
    expect(result.date.toISOString().substring(0, 10)).toBe('2026-03-30')
    expect(result.wasExplicit).toBe(true)
  })

  it('parses "domingo" (last Sunday from Wednesday), wasExplicit=true', () => {
    const result = parseDateFromMessage('o que comi no almoço domingo?', baseDate)
    expect(result.date.toISOString().substring(0, 10)).toBe('2026-03-29')
    expect(result.wasExplicit).toBe(true)
  })

  it('parses "quarta" on a Wednesday returns today, wasExplicit=true', () => {
    const result = parseDateFromMessage('o que comi no almoço quarta?', baseDate)
    expect(result.date.toISOString().substring(0, 10)).toBe('2026-04-01')
    expect(result.wasExplicit).toBe(true)
  })

  it('parses "dia 25" as March 25, wasExplicit=true', () => {
    const result = parseDateFromMessage('o que comi no almoço dia 25?', baseDate)
    expect(result.date.toISOString().substring(0, 10)).toBe('2026-03-25')
    expect(result.wasExplicit).toBe(true)
  })

  it('parses "dia 5" as March 5 (future day this month goes to prev month), wasExplicit=true', () => {
    const result = parseDateFromMessage('o que comi dia 5?', baseDate)
    expect(result.date.toISOString().substring(0, 10)).toBe('2026-03-05')
    expect(result.wasExplicit).toBe(true)
  })

  it('parses "dia 1" as today (April 1), wasExplicit=true', () => {
    const result = parseDateFromMessage('o que comi dia 1?', baseDate)
    expect(result.date.toISOString().substring(0, 10)).toBe('2026-04-01')
    expect(result.wasExplicit).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// handleMealDetail
// ---------------------------------------------------------------------------
describe('handleMealDetail', () => {
  const mockSupabase = {} as unknown as SupabaseClient

  beforeEach(() => {
    vi.clearAllMocks()
    mockFormatMealDetail.mockReturnValue('formatted result')
    mockChat.mockResolvedValue('{"meal_type": "breakfast", "date": "2026-03-28"}')
    mockGetLLMProvider.mockReturnValue({ chat: mockChat })
  })

  it('calls getMealDetailByType and formatMealDetail', async () => {
    mockGetMealDetailByType.mockResolvedValue([
      { mealType: 'breakfast', registeredAt: '2026-04-01T11:00:00Z', totalCalories: 300, items: [] },
    ])

    const result = await handleMealDetail(mockSupabase, 'user-123', 'o que comi no café?', {
      timezone: 'America/Sao_Paulo',
    })

    expect(mockGetMealDetailByType).toHaveBeenCalledWith(
      mockSupabase,
      'user-123',
      'breakfast',
      expect.any(Date),
      'America/Sao_Paulo',
    )
    expect(mockFormatMealDetail).toHaveBeenCalled()
    expect(result).toBe('formatted result')
  })

  it('passes null mealType when no type detected', async () => {
    mockGetMealDetailByType.mockResolvedValue([])

    await handleMealDetail(mockSupabase, 'user-123', 'o que comi hoje?', {
      timezone: 'America/Sao_Paulo',
    })

    expect(mockGetMealDetailByType).toHaveBeenCalledWith(
      mockSupabase,
      'user-123',
      null,
      expect.any(Date),
      'America/Sao_Paulo',
    )
  })

  it('calls LLM when date is not explicit and message has temporal hints', async () => {
    mockGetMealDetailByType.mockResolvedValue([])
    mockChat.mockResolvedValue('{"meal_type": "lunch", "date": "2026-03-15"}')
    mockGetLLMProvider.mockReturnValue({ chat: mockChat })

    await handleMealDetail(
      mockSupabase,
      'user-123',
      'o que comi na semana passada no almoço?',
      { timezone: 'America/Sao_Paulo' },
    )

    expect(mockGetLLMProvider).toHaveBeenCalled()
    expect(mockChat).toHaveBeenCalled()
    // LLM returned lunch, so mealType should be lunch
    expect(mockGetMealDetailByType).toHaveBeenCalledWith(
      mockSupabase,
      'user-123',
      'lunch',
      expect.any(Date),
      'America/Sao_Paulo',
    )
    // The date passed should be 2026-03-15 (from LLM)
    const callArgs = mockGetMealDetailByType.mock.calls[0]
    const dateArg = callArgs[3] as Date
    expect(dateArg.toISOString().substring(0, 10)).toBe('2026-03-15')
  })

  it('does not call LLM when date is explicit', async () => {
    mockGetMealDetailByType.mockResolvedValue([])

    await handleMealDetail(mockSupabase, 'user-123', 'o que comi ontem no almoço?', {
      timezone: 'America/Sao_Paulo',
    })

    expect(mockChat).not.toHaveBeenCalled()
  })

  it('does not call LLM when no temporal hints present', async () => {
    mockGetMealDetailByType.mockResolvedValue([])

    await handleMealDetail(mockSupabase, 'user-123', 'o que comi no almoço?', {
      timezone: 'America/Sao_Paulo',
    })

    expect(mockChat).not.toHaveBeenCalled()
  })

  it('falls back to today gracefully when LLM throws', async () => {
    mockGetMealDetailByType.mockResolvedValue([])
    mockChat.mockRejectedValue(new Error('LLM error'))
    mockGetLLMProvider.mockReturnValue({ chat: mockChat })

    // Should not throw; falls back to today's date
    await expect(
      handleMealDetail(
        mockSupabase,
        'user-123',
        'o que comi em março passado?',
        { timezone: 'America/Sao_Paulo' },
      ),
    ).resolves.toBe('formatted result')

    // getMealDetailByType still called (with today as fallback)
    expect(mockGetMealDetailByType).toHaveBeenCalled()
  })

  it('falls back to today gracefully when LLM returns invalid JSON', async () => {
    mockGetMealDetailByType.mockResolvedValue([])
    mockChat.mockResolvedValue('not valid json')
    mockGetLLMProvider.mockReturnValue({ chat: mockChat })

    await expect(
      handleMealDetail(
        mockSupabase,
        'user-123',
        'o que comi em fevereiro passado?',
        { timezone: 'America/Sao_Paulo' },
      ),
    ).resolves.toBe('formatted result')

    expect(mockGetMealDetailByType).toHaveBeenCalled()
  })
})
