import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'

// ---------------------------------------------------------------------------
// Hoist mocks
// ---------------------------------------------------------------------------
const {
  mockGetMealDetailByType,
  mockFormatMealDetail,
  mockGetLLMProvider,
} = vi.hoisted(() => ({
  mockGetMealDetailByType: vi.fn().mockResolvedValue([]),
  mockFormatMealDetail: vi.fn().mockReturnValue('formatted result'),
  mockGetLLMProvider: vi.fn().mockReturnValue({
    chat: vi.fn().mockResolvedValue('{"meal_type": "breakfast", "date": "2026-03-28"}'),
  }),
}))

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
})

// ---------------------------------------------------------------------------
// parseDateFromMessage
// ---------------------------------------------------------------------------
describe('parseDateFromMessage', () => {
  // Fix the current date for deterministic tests
  const baseDate = new Date('2026-04-01T12:00:00Z') // a Wednesday

  it('returns today when no date indicator found', () => {
    const result = parseDateFromMessage('o que comi no café?', baseDate)
    expect(result.toISOString().substring(0, 10)).toBe('2026-04-01')
  })

  it('parses "hoje"', () => {
    const result = parseDateFromMessage('o que comi no café hoje?', baseDate)
    expect(result.toISOString().substring(0, 10)).toBe('2026-04-01')
  })

  it('parses "ontem"', () => {
    const result = parseDateFromMessage('o que comi no almoço ontem?', baseDate)
    expect(result.toISOString().substring(0, 10)).toBe('2026-03-31')
  })

  it('parses "anteontem"', () => {
    const result = parseDateFromMessage('o que comi no jantar anteontem?', baseDate)
    expect(result.toISOString().substring(0, 10)).toBe('2026-03-30')
  })

  it('parses "segunda" (last Monday from Wednesday)', () => {
    const result = parseDateFromMessage('o que comi no almoço segunda?', baseDate)
    expect(result.toISOString().substring(0, 10)).toBe('2026-03-30')
  })

  it('parses "domingo" (last Sunday from Wednesday)', () => {
    const result = parseDateFromMessage('o que comi no almoço domingo?', baseDate)
    expect(result.toISOString().substring(0, 10)).toBe('2026-03-29')
  })

  it('parses "quarta" on a Wednesday returns today', () => {
    const result = parseDateFromMessage('o que comi no almoço quarta?', baseDate)
    expect(result.toISOString().substring(0, 10)).toBe('2026-04-01')
  })

  it('parses "dia 25" as March 25', () => {
    const result = parseDateFromMessage('o que comi no almoço dia 25?', baseDate)
    expect(result.toISOString().substring(0, 10)).toBe('2026-03-25')
  })

  it('parses "dia 5" as March 5 (future day this month goes to prev month)', () => {
    const result = parseDateFromMessage('o que comi dia 5?', baseDate)
    expect(result.toISOString().substring(0, 10)).toBe('2026-03-05')
  })

  it('parses "dia 1" as today (April 1)', () => {
    const result = parseDateFromMessage('o que comi dia 1?', baseDate)
    expect(result.toISOString().substring(0, 10)).toBe('2026-04-01')
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
})
