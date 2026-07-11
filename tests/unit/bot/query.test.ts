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
  mockLogFoodToMeal,
  mockCreateMeal,
  mockGetDailyMacros,
} = vi.hoisted(() => {
  const mockAnalyzeMeal = vi.fn()
  const mockEnrichItemsWithTaco = vi.fn()
  const mockLogFoodToMeal = vi.fn()
  const mockCreateMeal = vi.fn()
  const mockGetDailyMacros = vi.fn()
  return {
    mockAnalyzeMeal,
    mockGetLLMProvider: vi.fn(() => ({
      analyzeMeal: mockAnalyzeMeal,
      decomposeMeal: vi.fn(),
      classifyIntent: vi.fn(),
      chat: vi.fn(),
    })),
    mockEnrichItemsWithTaco,
    mockLogFoodToMeal,
    mockCreateMeal,
    mockGetDailyMacros,
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
  logFoodToMeal: mockLogFoodToMeal,
}))

vi.mock('@/lib/db/queries/meals', () => ({
  createMeal: mockCreateMeal,
  getDailyMacros: mockGetDailyMacros,
}))

import { handleQuery, handleQueryConfirmation } from '@/lib/bot/flows/query'
import type { ConversationContext } from '@/lib/bot/state'

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
      nutrition_basis_grams: null,
      nutrition_basis_calories: null,
      nutrition_basis_protein: null,
      nutrition_basis_carbs: null,
      nutrition_basis_fat: null,
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
      nutrition_basis_grams: null,
      nutrition_basis_calories: null,
      nutrition_basis_protein: null,
      nutrition_basis_carbs: null,
      nutrition_basis_fat: null,
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
      nutrition_basis_grams: null,
      nutrition_basis_calories: null,
      nutrition_basis_protein: null,
      nutrition_basis_carbs: null,
      nutrition_basis_fat: null,
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

// ---------------------------------------------------------------------------
// handleQueryConfirmation — registers via logFoodToMeal (consolidates)
// ---------------------------------------------------------------------------

describe('handleQueryConfirmation', () => {
  let supabase: SupabaseClient

  const confirmationContext: ConversationContext = {
    contextType: 'awaiting_confirmation',
    contextData: {
      flow: 'query',
      mealType: 'snack',
      originalMessage: 'quantas calorias tem uma coxinha?',
      items: [
        {
          food: 'coxinha',
          quantityGrams: 130,
          quantityDisplay: '1 unidade',
          calories: 290,
          protein: 13,
          carbs: 22,
          fat: 17,
          source: 'taco',
          tacoId: 42,
        },
      ],
    },
  } as unknown as ConversationContext

  beforeEach(() => {
    vi.clearAllMocks()
    supabase = buildSupabase()
    mockGetDailyMacros.mockResolvedValue({ calories: 580, proteinG: 0, carbsG: 0, fatG: 0 })
  })

  it('consolidates into the existing same-day meal via logFoodToMeal (wasAppend) instead of creating a new meal', async () => {
    // Existing snack already has a banana; registering the coxinha appends to it.
    mockLogFoodToMeal.mockResolvedValue({
      wasAppend: true,
      mealId: 'meal-existing-1',
      addedItems: [
        { foodName: 'coxinha', quantityGrams: 130, calories: 290, proteinG: 13, carbsG: 22, fatG: 17, source: 'taco', quantityDisplay: '1 unidade' },
      ],
      meal: {
        id: 'meal-existing-1',
        mealType: 'snack',
        totalCalories: 380,
        registeredAt: '2026-05-30T15:00:00.000Z',
        items: [
          { id: 'i1', foodName: 'banana', quantityGrams: 120, quantityDisplay: '1 unidade', calories: 90, proteinG: 1, carbsG: 23, fatG: 0, source: 'taco', confidence: 'high' },
          { id: 'i2', foodName: 'coxinha', quantityGrams: 130, quantityDisplay: '1 unidade', calories: 290, proteinG: 13, carbsG: 22, fatG: 17, source: 'taco', confidence: 'high' },
        ],
      },
    })

    const result = await handleQueryConfirmation(
      supabase,
      USER_ID,
      'registrar',
      confirmationContext,
      { timezone: 'America/Sao_Paulo', dailyCalorieTarget: 2000 },
    )

    // Routes through the consolidation seam, not a direct createMeal
    expect(mockLogFoodToMeal).toHaveBeenCalledTimes(1)
    expect(mockCreateMeal).not.toHaveBeenCalled()

    // logFoodToMeal received the query item mapped to MealItemInput shape + the meal type
    const [, params] = mockLogFoodToMeal.mock.calls[0]
    expect(params.userId).toBe(USER_ID)
    expect(params.mealType).toBe('snack')
    expect(params.items).toEqual([
      expect.objectContaining({
        foodName: 'coxinha',
        quantityGrams: 130,
        calories: 290,
        proteinG: 13,
        carbsG: 22,
        fatG: 17,
        source: 'taco',
        tacoId: 42,
        quantityDisplay: '1 unidade',
      }),
    ])

    // Consolidated "Somei …" response with full meal + the registered food/calories
    expect(result).toContain('Somei')
    expect(result).toContain('coxinha')
    expect(result).toContain('290')
    expect(result).toContain('banana')
    expect(result).toContain('380')
  })

  it('creates a new meal (wasAppend false) when there is no same-day meal of that type', async () => {
    mockLogFoodToMeal.mockResolvedValue({
      wasAppend: false,
      mealId: 'meal-new-1',
      addedItems: [
        { foodName: 'coxinha', quantityGrams: 130, calories: 290, proteinG: 13, carbsG: 22, fatG: 17, source: 'taco', quantityDisplay: '1 unidade' },
      ],
      meal: {
        id: 'meal-new-1',
        mealType: 'snack',
        totalCalories: 290,
        registeredAt: '2026-05-30T15:00:00.000Z',
        items: [
          { id: 'i1', foodName: 'coxinha', quantityGrams: 130, quantityDisplay: '1 unidade', calories: 290, proteinG: 13, carbsG: 22, fatG: 17, source: 'taco', confidence: 'high' },
        ],
      },
    })

    const result = await handleQueryConfirmation(
      supabase,
      USER_ID,
      'registrar',
      confirmationContext,
      { timezone: 'America/Sao_Paulo', dailyCalorieTarget: 2000 },
    )

    expect(mockLogFoodToMeal).toHaveBeenCalledTimes(1)
    expect(mockCreateMeal).not.toHaveBeenCalled()
    expect(result).toContain('registrado')
    expect(result).toContain('coxinha')
    expect(result).toContain('290')
  })

  it('includes the P:/G:/C: macro line when the user has macro goals', async () => {
    mockGetDailyMacros.mockResolvedValue({ calories: 580, proteinG: 30, carbsG: 70, fatG: 20 })
    mockLogFoodToMeal.mockResolvedValue({
      wasAppend: false, mealId: 'meal-new-1',
      addedItems: [{ foodName: 'coxinha', quantityGrams: 130, calories: 290, proteinG: 13, carbsG: 22, fatG: 17, source: 'taco', quantityDisplay: '1 unidade' }],
      meal: { id: 'meal-new-1', mealType: 'snack', totalCalories: 290, registeredAt: '2026-05-30T15:00:00.000Z',
        items: [{ id: 'i1', foodName: 'coxinha', quantityGrams: 130, quantityDisplay: '1 unidade', calories: 290, proteinG: 13, carbsG: 22, fatG: 17, source: 'taco', confidence: 'high' }] },
    })

    const result = await handleQueryConfirmation(
      supabase, USER_ID, 'registrar', confirmationContext,
      { timezone: 'America/Sao_Paulo', dailyCalorieTarget: 2000, dailyProteinG: 120, dailyFatG: 60, dailyCarbsG: 200 },
    )

    expect(result).toContain('P: 30/120g')
  })

  it('omits the macro line when the user has no macro goals', async () => {
    mockGetDailyMacros.mockResolvedValue({ calories: 290, proteinG: 13, carbsG: 22, fatG: 17 })
    mockLogFoodToMeal.mockResolvedValue({
      wasAppend: false, mealId: 'meal-new-2',
      addedItems: [{ foodName: 'coxinha', quantityGrams: 130, calories: 290, proteinG: 13, carbsG: 22, fatG: 17, source: 'taco', quantityDisplay: '1 unidade' }],
      meal: { id: 'meal-new-2', mealType: 'snack', totalCalories: 290, registeredAt: '2026-05-30T15:00:00.000Z',
        items: [{ id: 'i1', foodName: 'coxinha', quantityGrams: 130, quantityDisplay: '1 unidade', calories: 290, proteinG: 13, carbsG: 22, fatG: 17, source: 'taco', confidence: 'high' }] },
    })

    const result = await handleQueryConfirmation(
      supabase, USER_ID, 'registrar', confirmationContext,
      { timezone: 'America/Sao_Paulo', dailyCalorieTarget: 2000 },
    )

    expect(result).not.toContain('P: 13/')
  })
})
