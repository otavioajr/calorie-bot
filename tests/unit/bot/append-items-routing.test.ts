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
  mockAddMealItems,
  mockRecalculateMealTotal,
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
    mockAddMealItems: vi.fn().mockResolvedValue(undefined),
    mockRecalculateMealTotal: vi.fn().mockResolvedValue(278),
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
  addMealItems: mockAddMealItems,
  recalculateMealTotal: mockRecalculateMealTotal,
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

const USER_ID = 'user-append-routing'

function buildSupabase(): SupabaseClient {
  return {} as unknown as SupabaseClient
}

describe('appendItemsToMeal — routing of mismatched meal types', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockGetLLMProvider.mockReturnValue({
      analyzeMeal: mockAnalyzeMeal,
      decomposeMeal: mockDecomposeMeal,
      classifyIntent: vi.fn(),
      chat: vi.fn(),
    })
    mockGetRecentMessages.mockResolvedValue([])
    mockTryProductLookup.mockResolvedValue({ kind: 'skip' })
    mockShouldUseProductFlow.mockResolvedValue(false)
    mockFindMealByTypeForDay.mockResolvedValue(null)
    mockRecordTacoUsage.mockResolvedValue(undefined)
  })

  it('routes mismatched meal_type items to the correct meal instead of dropping them', async () => {
    mockGetMealWithItems.mockResolvedValue({ id: 'b1', mealType: 'breakfast', totalCalories: 212, registeredAt: 'x', items: [] })
    mockAnalyzeMeal.mockResolvedValue([{
      meal_type: 'lunch', confidence: 'high', references_previous: false, reference_query: null,
      items: [{ food: 'Frango', quantity_grams: 120, quantity_display: null, quantity_source: 'estimated', portion_type: 'unit', has_user_quantity: true, calories: null, protein: null, carbs: null, fat: null, confidence: 'high' }],
      unknown_items: [], needs_clarification: false,
    }])
    mockMatchTacoByBase.mockResolvedValue([{ id: 7, foodName: 'Frango grelhado', foodBase: 'Frango', foodVariant: 'grelhado', caloriesPer100g: 159, proteinPer100g: 32, carbsPer100g: 0, fatPer100g: 3, isDefault: true }])
    mockFindMealByTypeForDay.mockResolvedValue(null) // no lunch yet today
    mockCreateMeal.mockResolvedValue('lunch-1')
    mockRecalculateMealTotal.mockResolvedValue(212)

    const { appendItemsToMeal } = await import('@/lib/bot/flows/meal-log')
    const result = await appendItemsToMeal(buildSupabase(), USER_ID, 'b1', 'comi também frango no almoço', { timezone: 'America/Sao_Paulo' })

    expect(result).not.toBeNull()
    expect(mockCreateMeal).toHaveBeenCalled() // the lunch meal was created (items not dropped)
  })

  it('appends same-type items directly to the target meal', async () => {
    mockGetMealWithItems.mockResolvedValue({ id: 'b1', mealType: 'breakfast', totalCalories: 212, registeredAt: 'x', items: [] })
    mockAnalyzeMeal.mockResolvedValue([{
      meal_type: 'breakfast', confidence: 'high', references_previous: false, reference_query: null,
      items: [{ food: 'Pão', quantity_grams: 50, quantity_display: null, quantity_source: 'estimated', portion_type: 'unit', has_user_quantity: true, calories: null, protein: null, carbs: null, fat: null, confidence: 'high' }],
      unknown_items: [], needs_clarification: false,
    }])
    mockMatchTacoByBase.mockResolvedValue([{ id: 9, foodName: 'Pão francês', foodBase: 'Pão', foodVariant: 'francês', caloriesPer100g: 132, proteinPer100g: 4, carbsPer100g: 26, fatPer100g: 2, isDefault: true }])
    mockRecalculateMealTotal.mockResolvedValue(278)

    const { appendItemsToMeal } = await import('@/lib/bot/flows/meal-log')
    const result = await appendItemsToMeal(buildSupabase(), USER_ID, 'b1', 'comi também 1 pão', { timezone: 'America/Sao_Paulo' })

    expect(result).not.toBeNull()
    expect(mockAddMealItems).toHaveBeenCalledWith(buildSupabase(), 'b1', expect.any(Array))
    expect(mockCreateMeal).not.toHaveBeenCalled()
    expect(result!.newTotal).toBe(278)
  })
})
