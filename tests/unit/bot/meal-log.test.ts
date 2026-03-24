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
  mockFormatMealBreakdown,
  mockFormatMultiMealBreakdown,
  mockFormatProgress,
  mockFormatDecompositionFeedback,
  mockGetRecentMessages,
  mockFuzzyMatchTacoMultiple,
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
    mockFormatMealBreakdown: vi.fn().mockReturnValue('Breakdown message\nTá certo? (sim / corrigir)'),
    mockFormatMultiMealBreakdown: vi.fn().mockReturnValue('Multi breakdown message\nTá certo? (sim / corrigir)'),
    mockFormatProgress: vi.fn().mockReturnValue('📊 Hoje: 800 / 2000 kcal (restam 1200)'),
    mockFormatDecompositionFeedback: vi.fn().mockReturnValue('Decompondo...'),
    mockGetRecentMessages: vi.fn().mockResolvedValue([]),
    mockFuzzyMatchTacoMultiple: vi.fn().mockResolvedValue(new Map([
      ['arroz', { id: 3, foodName: 'Arroz, tipo 1, cozido', category: 'Cereais', caloriesPer100g: 128, proteinPer100g: 2.5, carbsPer100g: 28.1, fatPer100g: 0.2, fiberPer100g: 1.6 }],
      ['feijão', { id: 5, foodName: 'Feijão, carioca, cozido', category: 'Leguminosas', caloriesPer100g: 76, proteinPer100g: 4.8, carbsPer100g: 13.6, fatPer100g: 0.5, fiberPer100g: 8.5 }],
    ])),
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
}))

vi.mock('@/lib/utils/formatters', () => ({
  formatMealBreakdown: mockFormatMealBreakdown,
  formatMultiMealBreakdown: mockFormatMultiMealBreakdown,
  formatProgress: mockFormatProgress,
  formatDecompositionFeedback: mockFormatDecompositionFeedback,
}))

vi.mock('@/lib/db/queries/message-history', () => ({
  getRecentMessages: mockGetRecentMessages,
}))

vi.mock('@/lib/db/queries/taco', () => ({
  fuzzyMatchTacoMultiple: mockFuzzyMatchTacoMultiple,
  calculateMacros: mockCalculateMacros,
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
      quantity_source: 'estimated',
      calories: null,
      protein: null,
      carbs: null,
      fat: null,
      confidence: 'high',
    },
    {
      food: 'Feijão',
      quantity_grams: 150,
      quantity_source: 'estimated',
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
    mockFormatMealBreakdown.mockReturnValue('Breakdown message\nTá certo? (sim / corrigir)')
    mockFormatProgress.mockReturnValue('📊 Hoje: 800 / 2000 kcal (restam 1200)')
    // Reset TACO mocks to default
    mockFuzzyMatchTacoMultiple.mockResolvedValue(new Map([
      ['arroz', { id: 3, foodName: 'Arroz, tipo 1, cozido', category: 'Cereais', caloriesPer100g: 128, proteinPer100g: 2.5, carbsPer100g: 28.1, fatPer100g: 0.2, fiberPer100g: 1.6 }],
      ['feijão', { id: 5, foodName: 'Feijão, carioca, cozido', category: 'Leguminosas', caloriesPer100g: 76, proteinPer100g: 4.8, carbsPer100g: 13.6, fatPer100g: 0.5, fiberPer100g: 8.5 }],
    ]))
    mockSearchMealHistory.mockResolvedValue([])
  })

  // -------------------------------------------------------------------------
  // New meal — calls LLM, returns breakdown for confirmation
  // -------------------------------------------------------------------------

  describe('new meal (no context)', () => {
    it('analyzes new meal and asks for confirmation', async () => {
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
      expect(result.response).toContain('Tá certo?')
      expect(result.completed).toBe(false)
    })

    it('calls getLLMProvider to get the LLM', async () => {
      await handleMealLog(supabase, USER_ID, 'almocei arroz e feijão', mockUser, null)

      expect(mockGetLLMProvider).toHaveBeenCalled()
    })

    it('sets state to awaiting_confirmation with meal analysis and enriched meals', async () => {
      await handleMealLog(supabase, USER_ID, 'almocei arroz e feijão', mockUser, null)

      expect(mockSetState).toHaveBeenCalledWith(
        USER_ID,
        'awaiting_confirmation',
        expect.objectContaining({
          mealAnalyses: expect.arrayContaining([expect.objectContaining({ meal_type: 'lunch' })]),
          enrichedMeals: expect.any(Array),
          originalMessage: 'almocei arroz e feijão',
        }),
      )
    })

    it('enriches meal items via TACO fuzzy match', async () => {
      await handleMealLog(supabase, USER_ID, 'almocei arroz e feijão', mockUser, null)

      expect(mockFuzzyMatchTacoMultiple).toHaveBeenCalledWith(
        supabase,
        ['Arroz', 'Feijão'],
      )
    })

    it('completed is false when waiting for confirmation', async () => {
      const result = await handleMealLog(supabase, USER_ID, 'almocei', mockUser, null)

      expect(result.completed).toBe(false)
    })
  })

  // -------------------------------------------------------------------------
  // Confirmation — "sim"
  // -------------------------------------------------------------------------

  describe('confirmation (awaiting_confirmation context)', () => {
    it('saves meal on "sim" confirmation', async () => {
      const context = buildConfirmationContext()
      const result: MealLogResult = await handleMealLog(
        supabase,
        USER_ID,
        'sim',
        mockUser,
        context,
      )

      expect(mockCreateMeal).toHaveBeenCalled()
      expect(result.completed).toBe(true)
    })

    it('saves meal on "s" confirmation', async () => {
      const context = buildConfirmationContext()
      await handleMealLog(supabase, USER_ID, 's', mockUser, context)

      expect(mockCreateMeal).toHaveBeenCalled()
    })

    it('saves meal on "ok" confirmation', async () => {
      const context = buildConfirmationContext()
      await handleMealLog(supabase, USER_ID, 'ok', mockUser, context)

      expect(mockCreateMeal).toHaveBeenCalled()
    })

    it('saves meal on "confirma" confirmation', async () => {
      const context = buildConfirmationContext()
      await handleMealLog(supabase, USER_ID, 'confirma', mockUser, context)

      expect(mockCreateMeal).toHaveBeenCalled()
    })

    it('saves meal with case-insensitive "SIM"', async () => {
      const context = buildConfirmationContext()
      await handleMealLog(supabase, USER_ID, 'SIM', mockUser, context)

      expect(mockCreateMeal).toHaveBeenCalled()
    })

    it('calls clearState after saving', async () => {
      const context = buildConfirmationContext()
      await handleMealLog(supabase, USER_ID, 'sim', mockUser, context)

      expect(mockClearState).toHaveBeenCalledWith(USER_ID)
    })

    it('includes daily progress in response after saving', async () => {
      const context = buildConfirmationContext()
      mockGetDailyCalories.mockResolvedValue(1060)
      mockFormatProgress.mockReturnValue('📊 Hoje: 1060 / 2000 kcal (restam 940)')

      const result = await handleMealLog(supabase, USER_ID, 'sim', mockUser, context)

      expect(mockGetDailyCalories).toHaveBeenCalled()
      expect(result.response).toContain('📊')
    })

    it('createMeal receives userId, meal data, and enriched items with source', async () => {
      const context = buildConfirmationContext()
      await handleMealLog(supabase, USER_ID, 'sim', mockUser, context)

      expect(mockCreateMeal).toHaveBeenCalledWith(
        supabase,
        expect.objectContaining({
          userId: USER_ID,
          mealType: 'lunch',
          items: expect.arrayContaining([
            expect.objectContaining({
              source: 'taco',
            }),
          ]),
        }),
      )
    })
  })

  // -------------------------------------------------------------------------
  // Rejection — "corrigir" / "não"
  // -------------------------------------------------------------------------

  describe('correction request (awaiting_confirmation context)', () => {
    it('handles "corrigir" — sets awaiting_clarification and asks what to correct', async () => {
      const context = buildConfirmationContext()
      const result: MealLogResult = await handleMealLog(
        supabase,
        USER_ID,
        'corrigir',
        mockUser,
        context,
      )

      expect(mockSetState).toHaveBeenCalledWith(
        USER_ID,
        'awaiting_clarification',
        expect.objectContaining({ originalMessage: 'almocei arroz e feijão' }),
      )
      expect(result.response).toMatch(/corrigir|corrij|o que/i)
      expect(result.completed).toBe(false)
    })

    it('handles "não" — sets awaiting_clarification', async () => {
      const context = buildConfirmationContext()
      const result = await handleMealLog(supabase, USER_ID, 'não', mockUser, context)

      expect(mockSetState).toHaveBeenCalledWith(
        USER_ID,
        'awaiting_clarification',
        expect.objectContaining({ originalMessage: 'almocei arroz e feijão' }),
      )
      expect(result.completed).toBe(false)
    })

    it('handles "nao" — sets awaiting_clarification', async () => {
      const context = buildConfirmationContext()
      const result = await handleMealLog(supabase, USER_ID, 'nao', mockUser, context)

      expect(mockSetState).toHaveBeenCalledWith(
        USER_ID,
        'awaiting_clarification',
        expect.objectContaining({ originalMessage: 'almocei arroz e feijão' }),
      )
      expect(result.completed).toBe(false)
    })

    it('handles "n" — sets awaiting_clarification', async () => {
      const context = buildConfirmationContext()
      const result = await handleMealLog(supabase, USER_ID, 'n', mockUser, context)

      expect(mockSetState).toHaveBeenCalledWith(
        USER_ID,
        'awaiting_clarification',
        expect.objectContaining({ originalMessage: 'almocei arroz e feijão' }),
      )
      expect(result.completed).toBe(false)
    })

    it('does NOT call createMeal on rejection', async () => {
      const context = buildConfirmationContext()
      await handleMealLog(supabase, USER_ID, 'corrigir', mockUser, context)

      expect(mockCreateMeal).not.toHaveBeenCalled()
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

    it('moves to awaiting_confirmation after clarification', async () => {
      const context = buildClarificationContext()

      await handleMealLog(
        supabase,
        USER_ID,
        'era uma tigela média de arroz',
        mockUser,
        context,
      )

      expect(mockSetState).toHaveBeenCalledWith(
        USER_ID,
        'awaiting_confirmation',
        expect.objectContaining({
          mealAnalyses: expect.anything(),
          enrichedMeals: expect.anything(),
        }),
      )
    })

    it('returns breakdown response after successful clarification', async () => {
      const context = buildClarificationContext()

      const result = await handleMealLog(
        supabase,
        USER_ID,
        'era uma tigela média',
        mockUser,
        context,
      )

      expect(result.response).toContain('Tá certo?')
      expect(result.completed).toBe(false)
    })
  })
})
