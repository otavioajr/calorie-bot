import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { ConversationContext } from '@/lib/bot/state'
import type { MealAnalysis } from '@/lib/llm/schemas/meal-analysis'

// ---------------------------------------------------------------------------
// Hoist mock variables so they are available at vi.mock() factory call time
// ---------------------------------------------------------------------------
const {
  mockSetState,
  mockClearState,
  mockGetLLMProvider,
  mockAnalyzeMeal,
  mockDecomposeMeal,
  mockCreateMeal,
  mockGetDailyCalories,
  mockGetDailyMacros,
  mockFormatMealBreakdown,
  mockFormatMultiMealBreakdown,
  mockFormatProgress,
  mockFormatDecompositionFeedback,
  mockGetRecentMessages,
  mockFuzzyMatchTacoMultiple,
  mockMatchTacoByBase,
  mockGetLearnedDefault,
  mockRecordTacoUsage,
  mockFormatDefaultNotice,
  mockCalculateMacros,
  mockSendTextMessage,
  mockSearchMealHistory,
} = vi.hoisted(() => {
  const mockAnalyzeMeal = vi.fn()
  const mockDecomposeMeal = vi.fn()
  return {
    mockSetState: vi.fn().mockResolvedValue(undefined),
    mockClearState: vi.fn().mockResolvedValue(undefined),
    mockAnalyzeMeal,
    mockDecomposeMeal,
    mockGetLLMProvider: vi.fn(() => ({
      analyzeMeal: mockAnalyzeMeal,
      decomposeMeal: mockDecomposeMeal,
      classifyIntent: vi.fn(),
      chat: vi.fn(),
    })),
    mockCreateMeal: vi.fn().mockResolvedValue('meal-id-123'),
    mockGetDailyCalories: vi.fn().mockResolvedValue(800),
    mockGetDailyMacros: vi.fn().mockResolvedValue({ calories: 800, proteinG: 40, carbsG: 100, fatG: 20 }),
    mockFormatMealBreakdown: vi.fn().mockReturnValue('Breakdown message\nAlgo errado? Manda "corrigir"'),
    mockFormatMultiMealBreakdown: vi.fn().mockReturnValue('Multi breakdown message\nAlgo errado? Manda "corrigir"'),
    mockFormatProgress: vi.fn().mockReturnValue('📊 Hoje: 800 / 2000 kcal (restam 1200)'),
    mockFormatDecompositionFeedback: vi.fn().mockReturnValue('Decompondo...'),
    mockGetRecentMessages: vi.fn().mockResolvedValue([]),
    mockFuzzyMatchTacoMultiple: vi.fn().mockResolvedValue(new Map([
      ['arroz', { id: 3, foodName: 'Arroz, tipo 1, cozido', category: null, caloriesPer100g: 128, proteinPer100g: 2.5, carbsPer100g: 28.1, fatPer100g: 0.2, fiberPer100g: 1.6, foodBase: 'Arroz', foodVariant: 'tipo 1, cozido', isDefault: true }],
      ['feijão', { id: 5, foodName: 'Feijão, carioca, cozido', category: null, caloriesPer100g: 76, proteinPer100g: 4.8, carbsPer100g: 13.6, fatPer100g: 0.5, fiberPer100g: 8.5, foodBase: 'Feijão', foodVariant: 'carioca, cozido', isDefault: true }],
    ])),
    mockMatchTacoByBase: vi.fn().mockResolvedValue([]),
    mockGetLearnedDefault: vi.fn().mockResolvedValue(null),
    mockRecordTacoUsage: vi.fn().mockResolvedValue(undefined),
    mockFormatDefaultNotice: vi.fn().mockReturnValue(''),
    mockCalculateMacros: vi.fn().mockImplementation((food: { caloriesPer100g: number; proteinPer100g: number; carbsPer100g: number; fatPer100g: number }, grams: number) => ({
      calories: Math.round(food.caloriesPer100g * grams / 100),
      protein: Math.round(food.proteinPer100g * grams / 100 * 10) / 10,
      carbs: Math.round(food.carbsPer100g * grams / 100 * 10) / 10,
      fat: Math.round(food.fatPer100g * grams / 100 * 10) / 10,
    })),
    mockSendTextMessage: vi.fn().mockResolvedValue(undefined),
    mockSearchMealHistory: vi.fn().mockResolvedValue([]),
  }
})

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------
vi.mock('@/lib/bot/state', () => ({
  setState: mockSetState,
  clearState: mockClearState,
}))

vi.mock('@/lib/llm/index', () => ({
  getLLMProvider: mockGetLLMProvider,
}))

vi.mock('@/lib/db/queries/meals', () => ({
  createMeal: mockCreateMeal,
  getDailyCalories: mockGetDailyCalories,
  getDailyMacros: mockGetDailyMacros,
}))

vi.mock('@/lib/utils/formatters', () => ({
  formatMealBreakdown: mockFormatMealBreakdown,
  formatMultiMealBreakdown: mockFormatMultiMealBreakdown,
  formatProgress: mockFormatProgress,
  formatDecompositionFeedback: mockFormatDecompositionFeedback,
  formatDefaultNotice: mockFormatDefaultNotice,
}))

vi.mock('@/lib/db/queries/message-history', () => ({
  getRecentMessages: mockGetRecentMessages,
}))

vi.mock('@/lib/db/queries/taco', () => ({
  fuzzyMatchTacoMultiple: mockFuzzyMatchTacoMultiple,
  calculateMacros: mockCalculateMacros,
  matchTacoByBase: mockMatchTacoByBase,
  getLearnedDefault: mockGetLearnedDefault,
  recordTacoUsage: mockRecordTacoUsage,
}))

vi.mock('@/lib/whatsapp/client', () => ({
  sendTextMessage: mockSendTextMessage,
}))

vi.mock('@/lib/db/queries/meal-history-search', () => ({
  searchMealHistory: mockSearchMealHistory,
}))

// ---------------------------------------------------------------------------
// Import after mocks are registered
// ---------------------------------------------------------------------------
import { handleMealLog } from '@/lib/bot/flows/meal-log'
import type { MealLogResult } from '@/lib/bot/flows/meal-log'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const USER_ID = 'user-meal-log-123'

const mockUser = {
  calorieMode: 'taco',
  dailyCalorieTarget: 2000,
}

const mockMealAnalysis: MealAnalysis = {
  meal_type: 'lunch',
  confidence: 'high',
  references_previous: false,
  reference_query: null,
  items: [
    {
      food: 'Arroz',
      quantity_grams: 200,
      quantity_display: null, quantity_source: 'estimated',
      calories: null,
      protein: null,
      carbs: null,
      fat: null,
      confidence: 'high',
    },
    {
      food: 'Feijão',
      quantity_grams: 150,
      quantity_display: null, quantity_source: 'estimated',
      calories: null,
      protein: null,
      carbs: null,
      fat: null,
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

function buildConfirmationContext(mealAnalysis: MealAnalysis = mockMealAnalysis): ConversationContext {
  // Enriched items as they would be stored in context after TACO enrichment
  const enrichedMeals = [
    mealAnalysis.items.map(item => {
      const tacoMap: Record<string, { caloriesPer100g: number; proteinPer100g: number; carbsPer100g: number; fatPer100g: number; id: number }> = {
        'arroz': { id: 3, caloriesPer100g: 128, proteinPer100g: 2.5, carbsPer100g: 28.1, fatPer100g: 0.2 },
        'feijão': { id: 5, caloriesPer100g: 76, proteinPer100g: 4.8, carbsPer100g: 13.6, fatPer100g: 0.5 },
      }
      const taco = tacoMap[item.food.toLowerCase()]
      if (taco) {
        return {
          food: item.food,
          quantityGrams: item.quantity_grams,
          calories: Math.round(taco.caloriesPer100g * item.quantity_grams / 100),
          protein: Math.round(taco.proteinPer100g * item.quantity_grams / 100 * 10) / 10,
          carbs: Math.round(taco.carbsPer100g * item.quantity_grams / 100 * 10) / 10,
          fat: Math.round(taco.fatPer100g * item.quantity_grams / 100 * 10) / 10,
          source: 'taco',
          tacoId: taco.id,
        }
      }
      return {
        food: item.food,
        quantityGrams: item.quantity_grams,
        calories: 0,
        protein: 0,
        carbs: 0,
        fat: 0,
        source: 'approximate',
      }
    }),
  ]

  return {
    id: 'ctx-1',
    userId: USER_ID,
    contextType: 'awaiting_confirmation',
    contextData: {
      mealAnalyses: [mealAnalysis] as unknown as Record<string, unknown>,
      enrichedMeals: enrichedMeals as unknown as Record<string, unknown>,
      originalMessage: 'almocei arroz e feijão',
    },
    expiresAt: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
    createdAt: new Date().toISOString(),
  }
}

function buildClarificationContext(): ConversationContext {
  return {
    id: 'ctx-2',
    userId: USER_ID,
    contextType: 'awaiting_clarification',
    contextData: {
      originalMessage: 'comi uma tigela de arroz',
    },
    expiresAt: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
    createdAt: new Date().toISOString(),
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('handleMealLog', () => {
  let supabase: SupabaseClient

  beforeEach(() => {
    vi.clearAllMocks()
    supabase = buildSupabase()
    mockAnalyzeMeal.mockResolvedValue([mockMealAnalysis])
    mockDecomposeMeal.mockResolvedValue([])
    mockGetLLMProvider.mockReturnValue({
      analyzeMeal: mockAnalyzeMeal,
      decomposeMeal: mockDecomposeMeal,
      classifyIntent: vi.fn(),
      chat: vi.fn(),
    })
    mockCreateMeal.mockResolvedValue('meal-id-123')
    mockGetDailyCalories.mockResolvedValue(800)
    mockFormatMealBreakdown.mockReturnValue('Breakdown message\nAlgo errado? Manda "corrigir"')
    mockFormatProgress.mockReturnValue('📊 Hoje: 800 / 2000 kcal (restam 1200)')
    // Reset TACO mocks to default
    mockFuzzyMatchTacoMultiple.mockResolvedValue(new Map([
      ['arroz', { id: 3, foodName: 'Arroz, tipo 1, cozido', category: null, caloriesPer100g: 128, proteinPer100g: 2.5, carbsPer100g: 28.1, fatPer100g: 0.2, fiberPer100g: 1.6, foodBase: 'Arroz', foodVariant: 'tipo 1, cozido', isDefault: true }],
      ['feijão', { id: 5, foodName: 'Feijão, carioca, cozido', category: null, caloriesPer100g: 76, proteinPer100g: 4.8, carbsPer100g: 13.6, fatPer100g: 0.5, fiberPer100g: 8.5, foodBase: 'Feijão', foodVariant: 'carioca, cozido', isDefault: true }],
    ]))
    mockMatchTacoByBase.mockResolvedValue([])
    mockGetLearnedDefault.mockResolvedValue(null)
    mockRecordTacoUsage.mockResolvedValue(undefined)
    mockFormatDefaultNotice.mockReturnValue('')
    mockSearchMealHistory.mockResolvedValue([])
  })

  // -------------------------------------------------------------------------
  // New meal — calls LLM, registers immediately
  // -------------------------------------------------------------------------

  describe('new meal (no context)', () => {
    it('analyzes new meal and registers immediately', async () => {
      const result: MealLogResult = await handleMealLog(
        supabase,
        USER_ID,
        'almocei arroz e feijão',
        mockUser,
        null,
      )

      expect(mockAnalyzeMeal).toHaveBeenCalledWith(
        'almocei arroz e feijão',
        [],
      )
      expect(mockCreateMeal).toHaveBeenCalled()
      expect(result.completed).toBe(true)
    })

    it('calls getLLMProvider to get the LLM', async () => {
      await handleMealLog(supabase, USER_ID, 'almocei arroz e feijão', mockUser, null)

      expect(mockGetLLMProvider).toHaveBeenCalled()
    })

    it('does NOT set state to awaiting_confirmation', async () => {
      await handleMealLog(supabase, USER_ID, 'almocei arroz e feijão', mockUser, null)

      expect(mockSetState).not.toHaveBeenCalledWith(
        USER_ID,
        'awaiting_confirmation',
        expect.anything(),
      )
    })

    it('enriches meal items via TACO fuzzy match', async () => {
      await handleMealLog(supabase, USER_ID, 'almocei arroz e feijão', mockUser, null)

      expect(mockFuzzyMatchTacoMultiple).toHaveBeenCalledWith(
        supabase,
        ['Arroz', 'Feijão'],
      )
    })

    it('completed is true after immediate registration', async () => {
      const result = await handleMealLog(supabase, USER_ID, 'almocei', mockUser, null)

      expect(result.completed).toBe(true)
    })
  })


  // -------------------------------------------------------------------------
  // Clarification needed
  // -------------------------------------------------------------------------

  describe('clarification needed', () => {
    it('asks for clarification when LLM needs it', async () => {
      const clarificationAnalysis: MealAnalysis = {
        ...mockMealAnalysis,
        needs_clarification: true,
        clarification_question: 'Qual o tamanho da porção de arroz?',
      }
      mockAnalyzeMeal.mockResolvedValue([clarificationAnalysis])

      const result: MealLogResult = await handleMealLog(
        supabase,
        USER_ID,
        'comi arroz',
        mockUser,
        null,
      )

      expect(result.response).toContain('Qual o tamanho da porção de arroz?')
      expect(result.completed).toBe(false)
    })

    it('sets state to awaiting_clarification when LLM needs clarification', async () => {
      const clarificationAnalysis: MealAnalysis = {
        ...mockMealAnalysis,
        needs_clarification: true,
        clarification_question: 'Qual o tamanho da porção?',
      }
      mockAnalyzeMeal.mockResolvedValue([clarificationAnalysis])

      await handleMealLog(supabase, USER_ID, 'comi arroz', mockUser, null)

      expect(mockSetState).toHaveBeenCalledWith(
        USER_ID,
        'awaiting_clarification',
        expect.objectContaining({
          originalMessage: 'comi arroz',
        }),
      )
    })

    it('does NOT call setState awaiting_confirmation on clarification', async () => {
      const clarificationAnalysis: MealAnalysis = {
        ...mockMealAnalysis,
        needs_clarification: true,
        clarification_question: 'Qual o tamanho?',
      }
      mockAnalyzeMeal.mockResolvedValue([clarificationAnalysis])

      await handleMealLog(supabase, USER_ID, 'comi arroz', mockUser, null)

      expect(mockSetState).not.toHaveBeenCalledWith(
        USER_ID,
        'awaiting_confirmation',
        expect.anything(),
      )
    })
  })

  // -------------------------------------------------------------------------
  // Unknown items
  // -------------------------------------------------------------------------

  describe('unknown items', () => {
    it('asks about unknown items', async () => {
      const unknownItemsAnalysis: MealAnalysis = {
        ...mockMealAnalysis,
        unknown_items: ['brigadeiro artesanal'],
        needs_clarification: false,
      }
      mockAnalyzeMeal.mockResolvedValue([unknownItemsAnalysis])

      const result: MealLogResult = await handleMealLog(
        supabase,
        USER_ID,
        'comi brigadeiro artesanal',
        mockUser,
        null,
      )

      expect(result.response).toContain('brigadeiro artesanal')
      expect(result.completed).toBe(false)
    })

    it('sets state to awaiting_clarification for unknown items', async () => {
      const unknownItemsAnalysis: MealAnalysis = {
        ...mockMealAnalysis,
        unknown_items: ['bolo de fubá caseiro'],
      }
      mockAnalyzeMeal.mockResolvedValue([unknownItemsAnalysis])

      await handleMealLog(supabase, USER_ID, 'comi bolo de fubá caseiro', mockUser, null)

      expect(mockSetState).toHaveBeenCalledWith(
        USER_ID,
        'awaiting_clarification',
        expect.objectContaining({
          originalMessage: 'comi bolo de fubá caseiro',
        }),
      )
    })
  })

  // -------------------------------------------------------------------------
  // Clarification response (awaiting_clarification context)
  // -------------------------------------------------------------------------

  describe('clarification response (awaiting_clarification context)', () => {
    it('re-calls LLM with original message and clarification combined', async () => {
      const context = buildClarificationContext()

      await handleMealLog(
        supabase,
        USER_ID,
        'era uma tigela média de arroz, uns 200g',
        mockUser,
        context,
      )

      expect(mockAnalyzeMeal).toHaveBeenCalled()
    })

    it('registers meal immediately after clarification', async () => {
      const context = buildClarificationContext()

      const result = await handleMealLog(
        supabase,
        USER_ID,
        'era uma tigela média de arroz',
        mockUser,
        context,
      )

      expect(mockCreateMeal).toHaveBeenCalled()
      expect(result.completed).toBe(true)
    })

    it('does not set awaiting_confirmation after clarification', async () => {
      const context = buildClarificationContext()

      await handleMealLog(
        supabase,
        USER_ID,
        'era uma tigela média',
        mockUser,
        context,
      )

      expect(mockSetState).not.toHaveBeenCalledWith(
        USER_ID,
        'awaiting_confirmation',
        expect.anything(),
      )
    })
  })

  // -------------------------------------------------------------------------
  // Base matching fallback
  // -------------------------------------------------------------------------

  describe('base matching fallback', () => {
    it('uses base matching when fuzzy match fails', async () => {
      // Fuzzy returns no match for "banana"
      mockFuzzyMatchTacoMultiple.mockResolvedValueOnce(new Map([
        ['banana', null],
      ]))

      // Base matching returns banana variants
      mockMatchTacoByBase.mockResolvedValueOnce([
        { id: 182, foodName: 'Banana, prata, crua', category: null, caloriesPer100g: 98, proteinPer100g: 1.3, carbsPer100g: 26, fatPer100g: 0.1, fiberPer100g: 2, foodBase: 'Banana', foodVariant: 'prata, crua', isDefault: true },
      ])

      mockAnalyzeMeal.mockResolvedValueOnce([{
        meal_type: 'snack',
        confidence: 'high',
        items: [{ food: 'banana', quantity_grams: 120, calories: null, protein: null, carbs: null, fat: null, quantity_display: null, quantity_source: 'estimated', confidence: 'high' }],
        unknown_items: [],
        needs_clarification: false,
        references_previous: false,
        reference_query: null,
        clarification_question: undefined,
      }])

      const result = await handleMealLog(
        supabase,
        USER_ID,
        'comi uma banana',
        mockUser,
        null,
      )

      expect(result.completed).toBe(true)
      expect(mockMatchTacoByBase).toHaveBeenCalledWith(supabase, 'banana')
    })
  })
})
