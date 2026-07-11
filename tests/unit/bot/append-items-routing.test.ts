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
  mockFindOrCreateMeal,
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
    mockFindOrCreateMeal: vi.fn().mockResolvedValue({ mealId: 'meal-id-123', wasAppend: false }),
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
  findOrCreateMeal: mockFindOrCreateMeal,
  getDailyCalories: mockGetDailyCalories,
  getDailyMacros: mockGetDailyMacros,
  getMealWithItems: mockGetMealWithItems,
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

describe('appendItemsToMeal — exact target contract', () => {
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
    mockFindOrCreateMeal.mockResolvedValue({ mealId: 'meal-id-123', wasAppend: false })
    mockRecordTacoUsage.mockResolvedValue(undefined)
  })

  it('rejects an explicit different meal type instead of writing to multiple destinations', async () => {
    mockGetMealWithItems.mockResolvedValue({ id: 'b1', mealType: 'breakfast', totalCalories: 212, registeredAt: 'x', items: [] })
    mockAnalyzeMeal.mockResolvedValue([{
      meal_type: 'lunch', confidence: 'high', references_previous: false, reference_query: null,
      items: [{ food: 'Frango', quantity_grams: 120, quantity_display: null, quantity_source: 'estimated', portion_type: 'unit', has_user_quantity: true, calories: null, protein: null, carbs: null, fat: null, confidence: 'high' }],
      unknown_items: [], needs_clarification: false,
    }])
    mockMatchTacoByBase.mockResolvedValue([{ id: 7, foodName: 'Frango grelhado', foodBase: 'Frango', foodVariant: 'grelhado', caloriesPer100g: 159, proteinPer100g: 32, carbsPer100g: 0, fatPer100g: 3, isDefault: true }])
    const { appendItemsToMeal } = await import('@/lib/bot/flows/meal-log')
    const result = await appendItemsToMeal(buildSupabase(), USER_ID, 'b1', 'comi também frango no almoço', { timezone: 'America/Sao_Paulo' })

    expect(result).toBeNull()
    expect(mockAnalyzeMeal).not.toHaveBeenCalled()
    expect(mockAddMealItems).not.toHaveBeenCalled()
    expect(mockFindOrCreateMeal).not.toHaveBeenCalled()
    expect(mockRecalculateMealTotal).not.toHaveBeenCalled()
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
    expect(mockAddMealItems).toHaveBeenCalledWith(expect.anything(), 'b1', expect.any(Array))
    // same-type items append directly to the target meal — no routing via logFoodToMeal.
    expect(mockFindOrCreateMeal).not.toHaveBeenCalled()
    expect(result!.newTotal).toBe(278)
  })

  it('treats the explicit destination as authoritative for every item in the instruction', async () => {
    mockGetMealWithItems.mockResolvedValue({ id: 'b1', mealType: 'breakfast', totalCalories: 212, registeredAt: 'x', items: [] })
    mockAnalyzeMeal.mockResolvedValue([{
      meal_type: 'breakfast', confidence: 'high', references_previous: false, reference_query: null,
      items: [{ food: 'Pão', quantity_grams: 50, quantity_display: null, quantity_source: 'estimated', portion_type: 'unit', has_user_quantity: true, calories: null, protein: null, carbs: null, fat: null, confidence: 'high' }],
      unknown_items: [], needs_clarification: false,
    }, {
      meal_type: 'lunch', confidence: 'high', references_previous: false, reference_query: null,
      items: [{ food: 'Frango', quantity_grams: 120, quantity_display: null, quantity_source: 'estimated', portion_type: 'unit', has_user_quantity: true, calories: null, protein: null, carbs: null, fat: null, confidence: 'high' }],
      unknown_items: [], needs_clarification: false,
    }])
    mockMatchTacoByBase.mockImplementation(async (_sb: unknown, base: string) => {
      if (String(base).toLowerCase().includes('pao') || String(base).toLowerCase().includes('pão')) return [{ id: 9, foodName: 'Pão francês', foodBase: 'Pão', foodVariant: 'francês', caloriesPer100g: 132, proteinPer100g: 4, carbsPer100g: 26, fatPer100g: 2, isDefault: true }]
      return [{ id: 7, foodName: 'Frango grelhado', foodBase: 'Frango', foodVariant: 'grelhado', caloriesPer100g: 159, proteinPer100g: 32, carbsPer100g: 0, fatPer100g: 3, isDefault: true }]
    })
    mockRecalculateMealTotal.mockResolvedValue(278)

    const { appendItemsToMeal } = await import('@/lib/bot/flows/meal-log')
    const result = await appendItemsToMeal(buildSupabase(), USER_ID, 'b1', 'no café da manhã, adiciona pão e frango', { timezone: 'America/Sao_Paulo' })

    expect(result).not.toBeNull()
    expect(mockAddMealItems).toHaveBeenCalledTimes(1)
    expect(mockAddMealItems).toHaveBeenCalledWith(
      expect.anything(),
      'b1',
      expect.arrayContaining([
        expect.objectContaining({ foodName: 'Pão' }),
        expect.objectContaining({ foodName: 'Frango' }),
      ]),
    )
    expect(mockFindOrCreateMeal).not.toHaveBeenCalled()
    expect(result!.added.map(i => i.food).sort()).toEqual(['Frango', 'Pão'])
    expect(result!.newTotal).toBe(278)
    expect(mockRecordTacoUsage).toHaveBeenCalledTimes(2)
  })

  it('analyzes only the current append instruction without fetching message history', async () => {
    mockGetRecentMessages.mockResolvedValue([
      { role: 'user', content: 'comi 345g de melão no café da manhã' },
    ])
    mockGetMealWithItems.mockResolvedValue({
      id: 'b1', mealType: 'breakfast', totalCalories: 101, registeredAt: 'x', items: [],
    })
    mockAnalyzeMeal.mockResolvedValue([{
      meal_type: 'breakfast', confidence: 'high', references_previous: false, reference_query: null,
      items: [
        { food: 'Pastel de nata', quantity_grams: 30, quantity_display: '30g', quantity_source: 'user_provided', portion_type: 'unit', has_user_quantity: true, calories: null, protein: null, carbs: null, fat: null, confidence: 'high' },
      ],
      unknown_items: [], needs_clarification: false,
    }])
    mockMatchTacoByBase.mockResolvedValue([{ id: 2, foodName: 'Pastel de nata', foodBase: 'Pastel de nata', foodVariant: '', caloriesPer100g: 290, proteinPer100g: 5, carbsPer100g: 30, fatPer100g: 15, isDefault: true }])
    mockRecalculateMealTotal.mockResolvedValue(188)

    const { appendItemsToMeal } = await import('@/lib/bot/flows/meal-log')
    const result = await appendItemsToMeal(buildSupabase(), USER_ID, 'b1', 'adicionar 30g de pastel de nata', { timezone: 'America/Sao_Paulo' })

    expect(result).not.toBeNull()
    expect(mockGetRecentMessages).not.toHaveBeenCalled()
    expect(mockAnalyzeMeal).toHaveBeenCalledWith(
      'adicionar 30g de pastel de nata',
      [],
      expect.any(String),
    )
  })

  it('appends an identical food and quantity as another consumption', async () => {
    const existingBanana = {
      id: 'banana-1', foodName: 'Banana', quantityGrams: 100, quantityDisplay: '1 unidade',
      calories: 89, proteinG: 1, carbsG: 23, fatG: 0, source: 'taco', confidence: 'high',
    }
    mockGetMealWithItems.mockResolvedValue({
      id: 'b1', mealType: 'breakfast', totalCalories: 89, registeredAt: 'x',
      items: [existingBanana],
    })
    mockAnalyzeMeal.mockResolvedValue([{
      meal_type: 'breakfast', confidence: 'high', references_previous: false, reference_query: null,
      items: [
        { food: 'Banana', quantity_grams: 100, quantity_display: '1 unidade', quantity_source: 'estimated', portion_type: 'unit', has_user_quantity: false, calories: null, protein: null, carbs: null, fat: null, confidence: 'high' },
      ],
      unknown_items: [], needs_clarification: false,
    }])
    mockMatchTacoByBase.mockResolvedValue([{ id: 3, foodName: 'Banana', foodBase: 'Banana', foodVariant: '', caloriesPer100g: 89, proteinPer100g: 1, carbsPer100g: 23, fatPer100g: 0, isDefault: true }])
    mockRecalculateMealTotal.mockResolvedValue(178)

    const { appendItemsToMeal } = await import('@/lib/bot/flows/meal-log')
    const result = await appendItemsToMeal(buildSupabase(), USER_ID, 'b1', 'mais uma banana', { timezone: 'America/Sao_Paulo' })

    expect(result).not.toBeNull()
    expect(mockAddMealItems).toHaveBeenCalledWith(
      expect.anything(),
      'b1',
      [expect.objectContaining({ foodName: 'Banana', quantityGrams: 100 })],
    )
    expect(result!.added.map((item) => item.food)).toEqual(['Banana'])
  })

  it('keeps the append on the target meal when the current instruction has no explicit meal type', async () => {
    mockGetMealWithItems.mockResolvedValue({
      id: 'b1', mealType: 'breakfast', totalCalories: 89, registeredAt: 'x', items: [],
    })
    mockAnalyzeMeal.mockResolvedValue([{
      // The LLM may infer lunch from the clock, but the user did not say "almoço".
      meal_type: 'lunch', confidence: 'medium', references_previous: false, reference_query: null,
      items: [
        { food: 'Banana', quantity_grams: 100, quantity_display: '1 unidade', quantity_source: 'estimated', portion_type: 'unit', has_user_quantity: false, calories: null, protein: null, carbs: null, fat: null, confidence: 'high' },
      ],
      unknown_items: [], needs_clarification: false,
    }])
    mockMatchTacoByBase.mockResolvedValue([{ id: 3, foodName: 'Banana', foodBase: 'Banana', foodVariant: '', caloriesPer100g: 89, proteinPer100g: 1, carbsPer100g: 23, fatPer100g: 0, isDefault: true }])
    mockRecalculateMealTotal.mockResolvedValue(178)

    const { appendItemsToMeal } = await import('@/lib/bot/flows/meal-log')
    const result = await appendItemsToMeal(buildSupabase(), USER_ID, 'b1', 'mais uma banana', { timezone: 'America/Sao_Paulo' })

    expect(result).not.toBeNull()
    expect(mockAddMealItems).toHaveBeenCalledWith(
      expect.anything(),
      'b1',
      [expect.objectContaining({ foodName: 'Banana' })],
    )
    expect(mockFindOrCreateMeal).not.toHaveBeenCalled()
    expect(result!.added.map((item) => item.food)).toEqual(['Banana'])
  })
})
