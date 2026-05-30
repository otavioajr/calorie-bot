import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'

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
  mockFormatMealAddition,
  mockFormatMultiMealBreakdown,
  mockFormatProgress,
  mockFormatDecompositionFeedback,
  mockFormatSearchFeedback,
  mockGetRecentMessages,
  mockFuzzyMatchTacoMultiple,
  mockMatchTacoByBase,
  mockGetLearnedDefault,
  mockRecordTacoUsage,
  mockFormatDefaultNotice,
  mockCalculateMacros,
  mockSendTextMessage,
  mockSearchMealHistory,
  mockTryProductLookup,
  mockShouldUseProductFlow,
  mockHandleStartOffChoice,
  mockHandleStartLabelInput,
  mockFindMealByTypeForDay,
  mockGetMealWithItems,
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
    mockFormatMealAddition: vi.fn().mockReturnValue('🍽️ Somei ... ao café da manhã'),
    mockFormatMultiMealBreakdown: vi.fn().mockReturnValue('Multi breakdown message\nAlgo errado? Manda "corrigir"'),
    mockFormatProgress: vi.fn().mockReturnValue('📊 Hoje: 800 / 2000 kcal (restam 1200)'),
    mockFormatDecompositionFeedback: vi.fn().mockReturnValue('Decompondo...'),
    mockFormatSearchFeedback: vi.fn().mockReturnValue('Encontrando os alimentos... 🔍'),
    mockGetRecentMessages: vi.fn().mockResolvedValue([]),
    mockFuzzyMatchTacoMultiple: vi.fn().mockResolvedValue(new Map()),
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
    mockTryProductLookup: vi.fn().mockResolvedValue({ kind: 'skip' }),
    mockShouldUseProductFlow: vi.fn().mockResolvedValue(false),
    mockHandleStartOffChoice: vi.fn().mockResolvedValue({ response: 'Escolha um produto', completed: false }),
    mockHandleStartLabelInput: vi.fn().mockResolvedValue({ response: 'Envie o rótulo', completed: false }),
    mockFindMealByTypeForDay: vi.fn().mockResolvedValue(null),
    mockGetMealWithItems: vi.fn().mockResolvedValue(null),
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
  getMealWithItems: mockGetMealWithItems,
  findMealByTypeForDay: mockFindMealByTypeForDay,
  addMealItems: vi.fn().mockResolvedValue(undefined),
  recalculateMealTotal: vi.fn().mockResolvedValue(278),
  getDayBoundsForTimezone: vi.fn(() => ({
    startOfDay: new Date('2026-05-29T03:00:00Z'),
    endOfDay: new Date('2026-05-30T02:59:59.999Z'),
  })),
}))

vi.mock('@/lib/utils/formatters', () => ({
  formatMealBreakdown: mockFormatMealBreakdown,
  formatMealAddition: mockFormatMealAddition,
  formatMultiMealBreakdown: mockFormatMultiMealBreakdown,
  formatProgress: mockFormatProgress,
  formatDecompositionFeedback: mockFormatDecompositionFeedback,
  formatSearchFeedback: mockFormatSearchFeedback,
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

vi.mock('@/lib/products/lookup', () => ({
  tryProductLookup: mockTryProductLookup,
}))

vi.mock('@/lib/products/classify', () => ({
  shouldUseProductFlow: mockShouldUseProductFlow,
}))

vi.mock('@/lib/bot/flows/product-confirm', () => ({
  handleStartOffChoice: mockHandleStartOffChoice,
  handleStartLabelInput: mockHandleStartLabelInput,
}))

// NOTE: @/lib/bot/meal-response is intentionally NOT mocked so the real
// buildConsolidatedMealResponse runs and calls the mocked formatters.

// ---------------------------------------------------------------------------
// Import after mocks are registered
// ---------------------------------------------------------------------------
import { handleMealLog } from '@/lib/bot/flows/meal-log'

const USER_ID = 'user-meal-log-consolidation'

function buildSupabase(): SupabaseClient {
  return {} as unknown as SupabaseClient
}

describe('handleMealLog — text consolidation', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockGetLLMProvider.mockReturnValue({
      analyzeMeal: mockAnalyzeMeal,
      decomposeMeal: mockDecomposeMeal,
      classifyIntent: vi.fn(),
      chat: vi.fn(),
    })
    mockGetDailyMacros.mockResolvedValue({ calories: 800, proteinG: 40, carbsG: 100, fatG: 20 })
    mockGetDailyCalories.mockResolvedValue(800)
    mockRecordTacoUsage.mockResolvedValue(undefined)
    mockSearchMealHistory.mockResolvedValue([])
    mockTryProductLookup.mockResolvedValue({ kind: 'skip' })
    mockShouldUseProductFlow.mockResolvedValue(false)
    mockGetRecentMessages.mockResolvedValue([])
  })

  it('consolidates a text log into the existing same-day breakfast and says "Somei"', async () => {
    mockFindMealByTypeForDay.mockResolvedValue({ id: 'b1', mealType: 'breakfast', totalCalories: 212, registeredAt: 'x' })
    mockGetMealWithItems.mockResolvedValue({
      id: 'b1', mealType: 'breakfast', totalCalories: 278, registeredAt: 'x',
      items: [
        { id: '1', foodName: 'Ovo', quantityGrams: 100, quantityDisplay: '2 ovos', calories: 146, proteinG: 12, carbsG: 1, fatG: 10, source: 'taco', confidence: 'high' },
        { id: '2', foodName: 'Queijo mussarela', quantityGrams: 20, quantityDisplay: '1 fatia', calories: 66, proteinG: 5, carbsG: 0, fatG: 5, source: 'taco', confidence: 'high' },
        { id: '3', foodName: 'Pão', quantityGrams: 50, quantityDisplay: null, calories: 66, proteinG: 2, carbsG: 13, fatG: 1, source: 'taco', confidence: 'high' },
      ],
    })
    mockAnalyzeMeal.mockResolvedValue([{
      meal_type: 'breakfast', confidence: 'high', references_previous: false, reference_query: null,
      items: [{ food: 'Pão', quantity_grams: 50, quantity_display: null, quantity_source: 'estimated', portion_type: 'unit', has_user_quantity: true, calories: null, protein: null, carbs: null, fat: null, confidence: 'high' }],
      unknown_items: [], needs_clarification: false,
    }])
    mockMatchTacoByBase.mockResolvedValue([{ id: 9, foodName: 'Pão francês', foodBase: 'Pão', foodVariant: 'francês', caloriesPer100g: 132, proteinPer100g: 4, carbsPer100g: 26, fatPer100g: 2, isDefault: true }])

    const result = await handleMealLog(buildSupabase(), USER_ID, 'comi também 1 pão no café da manhã', { calorieMode: 'taco', dailyCalorieTarget: 2168 }, null)

    expect(mockCreateMeal).not.toHaveBeenCalled()
    expect(result.response).toContain('Somei')
  })

  // Regression: when a history-reference single match builds a SHORTER enrichedMeals
  // (length 1) than the analyzed `meals` (length 2), saveMeals must NOT persist a
  // zero-calorie placeholder meal for the missing index.
  it('does not create a zero-item placeholder meal when enrichedMeals is shorter than meals', async () => {
    // No same-day meal exists yet → each logged meal would hit createMeal.
    mockFindMealByTypeForDay.mockResolvedValue(null)
    // After create, return a valid meal so saveRecentMealState succeeds.
    mockGetMealWithItems.mockResolvedValue({
      id: 'meal-id-123', mealType: 'lunch', totalCalories: 200, registeredAt: 'x',
      items: [
        { id: 'h1', foodName: 'Marmita de ontem', quantityGrams: 400, quantityDisplay: null, calories: 600, proteinG: 30, carbsG: 60, fatG: 20, source: 'user_history', confidence: 'high' },
      ],
    })

    // Two analyzed meals: the FIRST references previous history (single match →
    // enrichedMeals = [[match]], length 1), the SECOND is a normal meal.
    mockAnalyzeMeal.mockResolvedValue([
      {
        meal_type: 'lunch', confidence: 'high', references_previous: true, reference_query: 'marmita de ontem',
        items: [{ food: 'marmita', quantity_grams: 400, quantity_display: null, quantity_source: 'estimated', portion_type: 'bulk', has_user_quantity: false, calories: null, protein: null, carbs: null, fat: null, confidence: 'high' }],
        unknown_items: [], needs_clarification: false,
      },
      {
        meal_type: 'snack', confidence: 'high', references_previous: false, reference_query: null,
        items: [{ food: 'Banana', quantity_grams: 100, quantity_display: null, quantity_source: 'estimated', portion_type: 'unit', has_user_quantity: true, calories: null, protein: null, carbs: null, fat: null, confidence: 'high' }],
        unknown_items: [], needs_clarification: false,
      },
    ])

    // Single history match for the first meal's reference_query.
    mockSearchMealHistory.mockResolvedValue([
      { mealId: 'old-meal-1', foodName: 'Marmita de ontem', quantityGrams: 400, calories: 600, protein: 30, carbs: 60, fat: 20, source: 'user_history', tacoId: null, registeredAt: '2026-05-29T15:00:00Z', originalMessage: 'marmita' },
    ])

    // buildReceiptResponse (out of scope for this fix) also indexes the shorter
    // enrichedMeals and can throw downstream; the guard under test lives in
    // saveMeals, which runs first, so we assert on createMeal regardless.
    await handleMealLog(buildSupabase(), USER_ID, 'mesma marmita de ontem e uma banana', { calorieMode: 'taco', dailyCalorieTarget: 2168 }, null).catch(() => undefined)

    // Only the single history-match meal should be persisted — NOT a second,
    // empty (0 kcal, 0 item) placeholder for the missing enrichedMeals[1].
    expect(mockCreateMeal).toHaveBeenCalledTimes(1)
  })

  // Regression: buildReceiptResponse used to index enrichedMeals[idx] for EVERY
  // analyzed meal. When enrichedMeals (length 1, history single-match) is shorter
  // than meals (length 2), enrichedMeals[1] is undefined → `.map` throws.
  it('builds the receipt without throwing when enrichedMeals is shorter than meals', async () => {
    mockFindMealByTypeForDay.mockResolvedValue(null)
    mockGetMealWithItems.mockResolvedValue({
      id: 'meal-id-123', mealType: 'lunch', totalCalories: 600, registeredAt: 'x',
      items: [
        { id: 'h1', foodName: 'Marmita de ontem', quantityGrams: 400, quantityDisplay: null, calories: 600, proteinG: 30, carbsG: 60, fatG: 20, source: 'user_history', confidence: 'high' },
      ],
    })

    mockAnalyzeMeal.mockResolvedValue([
      {
        meal_type: 'lunch', confidence: 'high', references_previous: true, reference_query: 'marmita de ontem',
        items: [{ food: 'marmita', quantity_grams: 400, quantity_display: null, quantity_source: 'estimated', portion_type: 'bulk', has_user_quantity: false, calories: null, protein: null, carbs: null, fat: null, confidence: 'high' }],
        unknown_items: [], needs_clarification: false,
      },
      {
        meal_type: 'snack', confidence: 'high', references_previous: false, reference_query: null,
        items: [{ food: 'Banana', quantity_grams: 100, quantity_display: null, quantity_source: 'estimated', portion_type: 'unit', has_user_quantity: true, calories: null, protein: null, carbs: null, fat: null, confidence: 'high' }],
        unknown_items: [], needs_clarification: false,
      },
    ])

    mockSearchMealHistory.mockResolvedValue([
      { mealId: 'old-meal-1', foodName: 'Marmita de ontem', quantityGrams: 400, calories: 600, protein: 30, carbs: 60, fat: 20, source: 'user_history', tacoId: null, registeredAt: '2026-05-29T15:00:00Z', originalMessage: 'marmita' },
    ])

    const result = await handleMealLog(buildSupabase(), USER_ID, 'mesma marmita de ontem e uma banana', { calorieMode: 'taco', dailyCalorieTarget: 2168 }, null)

    expect(typeof result.response).toBe('string')
    expect(result.response.length).toBeGreaterThan(0)
  })
})
