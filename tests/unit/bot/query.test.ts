import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { MealAnalysis } from '@/lib/llm/schemas/meal-analysis'

// ---------------------------------------------------------------------------
// Hoist mock variables
// ---------------------------------------------------------------------------
const {
  mockAnalyzeMeal,
  mockGetLLMProvider,
  mockSetState,
} = vi.hoisted(() => {
  const mockAnalyzeMeal = vi.fn()
  return {
    mockAnalyzeMeal,
    mockGetLLMProvider: vi.fn(() => ({
      analyzeMeal: mockAnalyzeMeal,
      classifyIntent: vi.fn(),
      chat: vi.fn(),
    })),
    mockSetState: vi.fn().mockResolvedValue(undefined),
  }
})

vi.mock('@/lib/llm/index', () => ({
  getLLMProvider: mockGetLLMProvider,
}))

vi.mock('@/lib/bot/state', () => ({
  setState: mockSetState,
  clearState: vi.fn().mockResolvedValue(undefined),
}))

import { handleQuery } from '@/lib/bot/flows/query'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const USER_ID = 'user-query-123'

const mockSingleItemAnalysis: MealAnalysis = {
  meal_type: 'snack',
  confidence: 'high',
  items: [
    {
      food: 'coxinha',
      quantity_grams: 130,
      quantity_source: 'estimated',
      calories: 290,
      protein: 13,
      carbs: 22,
      fat: 17,
      taco_match: false,
      taco_id: null,
      confidence: 'high',
    },
  ],
  unknown_items: [],
  needs_clarification: false,
  clarification_question: undefined,
}

const mockMultiItemAnalysis: MealAnalysis = {
  meal_type: 'lunch',
  confidence: 'high',
  items: [
    {
      food: 'Arroz',
      quantity_grams: 200,
      quantity_source: 'estimated',
      calories: 260,
      protein: 4,
      carbs: 57,
      fat: 0.4,
      taco_match: false,
      taco_id: null,
      confidence: 'high',
    },
    {
      food: 'Feijão',
      quantity_grams: 150,
      quantity_source: 'estimated',
      calories: 180,
      protein: 9,
      carbs: 30,
      fat: 1,
      taco_match: false,
      taco_id: null,
      confidence: 'medium',
    },
  ],
  unknown_items: [],
  needs_clarification: false,
  clarification_question: undefined,
}

function buildSupabase(): SupabaseClient {
  return {} as unknown as SupabaseClient
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('handleQuery', () => {
  let supabase: SupabaseClient

  beforeEach(() => {
    vi.clearAllMocks()
    supabase = buildSupabase()
    mockAnalyzeMeal.mockResolvedValue(mockSingleItemAnalysis)
    mockGetLLMProvider.mockReturnValue({
      analyzeMeal: mockAnalyzeMeal,
      classifyIntent: vi.fn(),
      chat: vi.fn(),
    })
  })

  // -------------------------------------------------------------------------
  // LLM call
  // -------------------------------------------------------------------------

  describe('LLM integration', () => {
    it('calls LLM analyzeMeal with the message', async () => {
      await handleQuery(supabase, USER_ID, 'quantas calorias tem uma coxinha?')

      expect(mockAnalyzeMeal).toHaveBeenCalledWith(
        'quantas calorias tem uma coxinha?',
        'approximate',
        undefined,
      )
    })

    it('calls getLLMProvider', async () => {
      await handleQuery(supabase, USER_ID, 'quantas calorias tem uma coxinha?')

      expect(mockGetLLMProvider).toHaveBeenCalled()
    })
  })

  // -------------------------------------------------------------------------
  // Response format
  // -------------------------------------------------------------------------

  describe('response format', () => {
    it('returns nutritional information for the queried food', async () => {
      const result = await handleQuery(supabase, USER_ID, 'quantas calorias tem uma coxinha?')

      expect(result).toContain('coxinha')
      expect(result).toContain('290')
    })

    it('includes protein, carbs, and fat in response', async () => {
      const result = await handleQuery(supabase, USER_ID, 'quantas calorias tem uma coxinha?')

      expect(result).toMatch(/13.*proteína|proteína.*13/i)
      expect(result).toMatch(/22.*carbos|carbos.*22/i)
      expect(result).toMatch(/17.*gordura|gordura.*17/i)
    })

    it('ends with offer to register as meal', async () => {
      const result = await handleQuery(supabase, USER_ID, 'quantas calorias tem uma coxinha?')

      expect(result).toMatch(/registrar|sim.*não|sim.*nao/i)
    })

    it('handles multiple items in the analysis', async () => {
      mockAnalyzeMeal.mockResolvedValue(mockMultiItemAnalysis)

      const result = await handleQuery(supabase, USER_ID, 'quantas calorias tem arroz e feijão?')

      expect(result).toContain('Arroz')
      expect(result).toContain('Feijão')
    })
  })

  // -------------------------------------------------------------------------
  // Does NOT save to DB
  // -------------------------------------------------------------------------

  describe('does not save to DB', () => {
    it('does not call any save/create function', async () => {
      // We have no createMeal mock — if it was called, it would throw
      // Just verify logWeight and createMeal are not imported/called
      const result = await handleQuery(supabase, USER_ID, 'quantas calorias tem uma coxinha?')

      // Should return without error and with content
      expect(result).toBeTruthy()
    })
  })

  // -------------------------------------------------------------------------
  // Sets awaiting_confirmation context
  // -------------------------------------------------------------------------

  describe('sets confirmation context', () => {
    it('sets awaiting_confirmation state with analysis', async () => {
      await handleQuery(supabase, USER_ID, 'quantas calorias tem uma coxinha?')

      expect(mockSetState).toHaveBeenCalledWith(
        USER_ID,
        'awaiting_confirmation',
        expect.objectContaining({
          mealAnalysis: expect.objectContaining({
            items: expect.arrayContaining([
              expect.objectContaining({ food: 'coxinha' }),
            ]),
          }),
        }),
      )
    })

    it('stores original message in the state', async () => {
      await handleQuery(supabase, USER_ID, 'quantas calorias tem uma coxinha?')

      expect(mockSetState).toHaveBeenCalledWith(
        USER_ID,
        'awaiting_confirmation',
        expect.objectContaining({
          originalMessage: 'quantas calorias tem uma coxinha?',
        }),
      )
    })
  })
})
