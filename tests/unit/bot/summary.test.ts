import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'

// ---------------------------------------------------------------------------
// Hoist mock variables
// ---------------------------------------------------------------------------
const {
  mockGetDailyCalories,
  mockGetDailyMeals,
  mockFormatDailySummary,
  mockFormatWeeklySummary,
} = vi.hoisted(() => {
  return {
    mockGetDailyCalories: vi.fn().mockResolvedValue(1200),
    mockGetDailyMeals: vi.fn().mockResolvedValue([]),
    mockFormatDailySummary: vi.fn().mockReturnValue('📊 Resumo de hoje...'),
    mockFormatWeeklySummary: vi.fn().mockReturnValue('Resumo da semana...'),
  }
})

vi.mock('@/lib/db/queries/meals', () => ({
  getDailyCalories: mockGetDailyCalories,
  getDailyMeals: mockGetDailyMeals,
}))

vi.mock('@/lib/utils/formatters', () => ({
  formatDailySummary: mockFormatDailySummary,
  formatWeeklySummary: mockFormatWeeklySummary,
}))

import { handleSummary } from '@/lib/bot/flows/summary'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const USER_ID = 'user-summary-123'

const mockUser = {
  dailyCalorieTarget: 2000,
}

function buildSupabase(): SupabaseClient {
  return {} as unknown as SupabaseClient
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('handleSummary', () => {
  let supabase: SupabaseClient

  beforeEach(() => {
    vi.clearAllMocks()
    supabase = buildSupabase()
    mockGetDailyCalories.mockResolvedValue(1200)
    mockFormatDailySummary.mockReturnValue('📊 Resumo de hoje (21/03): Total: 1200 / 2000 kcal')
    mockFormatWeeklySummary.mockReturnValue('Resumo da semana...\nMédia: 1500 kcal/dia')
  })

  // -------------------------------------------------------------------------
  // Daily summary
  // -------------------------------------------------------------------------

  describe('daily summary', () => {
    it('returns daily summary for "hoje"', async () => {
      const result = await handleSummary(supabase, USER_ID, 'hoje', mockUser)

      expect(mockFormatDailySummary).toHaveBeenCalled()
      expect(result).toContain('Resumo de hoje')
    })

    it('returns daily summary for "como to"', async () => {
      const result = await handleSummary(supabase, USER_ID, 'como to', mockUser)

      expect(mockFormatDailySummary).toHaveBeenCalled()
      expect(result).toContain('Resumo de hoje')
    })

    it('returns daily summary for "como tô"', async () => {
      const result = await handleSummary(supabase, USER_ID, 'como tô', mockUser)

      expect(mockFormatDailySummary).toHaveBeenCalled()
      expect(result).toContain('Resumo de hoje')
    })

    it('returns daily summary by default when type is unclear', async () => {
      const result = await handleSummary(supabase, USER_ID, 'resumo', mockUser)

      expect(mockFormatDailySummary).toHaveBeenCalled()
      expect(result).toContain('Resumo de hoje')
    })

    it('passes the target calories to formatter', async () => {
      await handleSummary(supabase, USER_ID, 'hoje', mockUser)

      expect(mockFormatDailySummary).toHaveBeenCalledWith(
        expect.any(String),
        expect.any(Object),
        expect.any(Number),
        2000,
      )
    })

    it('handles case with no meals today', async () => {
      mockGetDailyCalories.mockResolvedValue(0)
      mockFormatDailySummary.mockReturnValue('📊 Resumo de hoje: Total: 0 / 2000 kcal')

      const result = await handleSummary(supabase, USER_ID, 'hoje', mockUser)

      expect(result).toBeTruthy()
      expect(mockFormatDailySummary).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({}),
        0,
        2000,
      )
    })

    it('uses default target of 2000 when dailyCalorieTarget is null', async () => {
      await handleSummary(supabase, USER_ID, 'hoje', { dailyCalorieTarget: null })

      expect(mockFormatDailySummary).toHaveBeenCalledWith(
        expect.any(String),
        expect.any(Object),
        expect.any(Number),
        2000,
      )
    })
  })

  // -------------------------------------------------------------------------
  // Weekly summary
  // -------------------------------------------------------------------------

  describe('weekly summary', () => {
    it('returns weekly summary for "semana"', async () => {
      const result = await handleSummary(supabase, USER_ID, 'semana', mockUser)

      expect(mockFormatWeeklySummary).toHaveBeenCalled()
      expect(result).toContain('semana')
    })

    it('returns weekly summary for "resumo da semana"', async () => {
      const result = await handleSummary(supabase, USER_ID, 'resumo da semana', mockUser)

      expect(mockFormatWeeklySummary).toHaveBeenCalled()
      expect(result).toContain('semana')
    })

    it('passes target to weekly formatter', async () => {
      mockGetDailyCalories.mockResolvedValue(1500)

      await handleSummary(supabase, USER_ID, 'semana', mockUser)

      expect(mockFormatWeeklySummary).toHaveBeenCalledWith(
        expect.arrayContaining([
          expect.objectContaining({ calories: expect.any(Number), target: 2000 }),
        ]),
        2000,
      )
    })

    it('queries 7 days of data for weekly summary', async () => {
      await handleSummary(supabase, USER_ID, 'semana', mockUser)

      // getDailyCalories should be called 7 times (once per day)
      expect(mockGetDailyCalories).toHaveBeenCalledTimes(7)
    })
  })
})
