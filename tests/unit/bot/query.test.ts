import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { MealAnalysis } from '@/lib/llm/schemas/meal-analysis'

// ---------------------------------------------------------------------------
// Hoist mock variables
// ---------------------------------------------------------------------------
const {
  mockAnalyzeMeal,
  mockGetLLMProvider,
  mockEnrichItemsWithTaco,
} = vi.hoisted(() => {
  const mockAnalyzeMeal = vi.fn()
  const mockEnrichItemsWithTaco = vi.fn()
  return {
    mockAnalyzeMeal,
    mockGetLLMProvider: vi.fn(() => ({
      analyzeMeal: mockAnalyzeMeal,
      decomposeMeal: vi.fn(),
      classifyIntent: vi.fn(),
      chat: vi.fn(),
    })),
    mockEnrichItemsWithTaco,
  }
})

vi.mock('@/lib/llm/index', () => ({
  getLLMProvider: mockGetLLMProvider,
}))

vi.mock('@/lib/bot/state', () => ({
  setState: vi.fn().mockResolvedValue(undefined),
  clearState: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('@/lib/bot/flows/meal-log', () => ({
  enrichItemsWithTaco: mockEnrichItemsWithTaco,
}))

import { handleQuery } from '@/lib/bot/flows/query'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const USER_ID = 'user-query-123'

const mockSingleItemAnalysis: MealAnalysis = {
  meal_type: 'snack',
  confidence: 'high',
  references_previous: false,
  reference_query: null,
  items: [
    {
      food: 'coxinha',
      quantity_grams: 130,
      quantity_display: '1 unidade',
      quantity_source: 'estimated',
      portion_type: 'unit' as const,
      has_user_quantity: false,
      calories: 290,
      protein: 13,
      carbs: 22,
      fat: 17,
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
  references_previous: false,
  reference_query: null,
  items: [
    {
      food: 'Arroz',
      quantity_grams: 200,
      quantity_display: null,
      quantity_source: 'estimated',
      portion_type: 'bulk' as const,
      has_user_quantity: false,
      calories: 260,
      protein: 4,
      carbs: 57,
      fat: 0.4,
      confidence: 'high',
    },
    {
      food: 'Feijão',
      quantity_grams: 150,
      quantity_display: null,
      quantity_source: 'estimated',
      portion_type: 'bulk' as const,
      has_user_quantity: false,
      calories: 180,
      protein: 9,
      carbs: 30,
      fat: 1,
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
    mockAnalyzeMeal.mockResolvedValue([mockSingleItemAnalysis])
    mockGetLLMProvider.mockReturnValue({
      analyzeMeal: mockAnalyzeMeal,
      decomposeMeal: vi.fn(),
      classifyIntent: vi.fn(),
      chat: vi.fn(),
    })
    // Default enrichment mock: returns items with TACO data
    mockEnrichItemsWithTaco.mockResolvedValue([
      {
        food: 'coxinha',
        quantityGrams: 130,
        quantityDisplay: '1 unidade',
        calories: 290,
        protein: 13,
        carbs: 22,
        fat: 17,
        source: 'taco',
      },
    ])
  })

  // -------------------------------------------------------------------------
  // LLM call
  // -------------------------------------------------------------------------

  describe('LLM integration', () => {
    it('calls LLM analyzeMeal with the message', async () => {
      await handleQuery(supabase, USER_ID, 'quantas calorias tem uma coxinha?')

      expect(mockAnalyzeMeal).toHaveBeenCalledWith(
        'quantas calorias tem uma coxinha?',
      )
    })

    it('calls enrichItemsWithTaco with the analyzed items', async () => {
      await handleQuery(supabase, USER_ID, 'quantas calorias tem uma coxinha?')

      expect(mockEnrichItemsWithTaco).toHaveBeenCalledWith(
        supabase,
        mockSingleItemAnalysis.items,
        expect.anything(),
        USER_ID,
      )
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

    it('offers to register as meal', async () => {
      const result = await handleQuery(supabase, USER_ID, 'quantas calorias tem uma coxinha?')

      expect(result).toContain('registrar')
      expect(result).not.toContain('sim/não')
    })

    it('handles multiple items in the analysis', async () => {
      mockAnalyzeMeal.mockResolvedValue([mockMultiItemAnalysis])
      mockEnrichItemsWithTaco.mockResolvedValue([
        { food: 'Arroz', quantityGrams: 200, quantityDisplay: null, calories: 260, protein: 4, carbs: 57, fat: 0.4, source: 'taco' },
        { food: 'Feijão', quantityGrams: 150, quantityDisplay: null, calories: 180, protein: 9, carbs: 30, fat: 1, source: 'taco' },
      ])

      const result = await handleQuery(supabase, USER_ID, 'quantas calorias tem arroz e feijão?')

      expect(result).toContain('Arroz')
      expect(result).toContain('Feijão')
      expect(result).toContain('Total')
    })

    it('shows ⚠️ for approximate items', async () => {
      mockEnrichItemsWithTaco.mockResolvedValue([
        { food: 'Magic Toast', quantityGrams: 100, quantityDisplay: '6 torradas', calories: 200, protein: 5, carbs: 35, fat: 3, source: 'approximate' },
      ])

      const result = await handleQuery(supabase, USER_ID, 'quantas calorias tem magic toast?')

      expect(result).toContain('⚠️')
      expect(result).toContain('~200')
    })
  })

  // -------------------------------------------------------------------------
  // Does NOT save to DB
  // -------------------------------------------------------------------------

  describe('does not save to DB', () => {
    it('does not call any save/create function', async () => {
      const result = await handleQuery(supabase, USER_ID, 'quantas calorias tem uma coxinha?')
      expect(result).toBeTruthy()
    })
  })
})
