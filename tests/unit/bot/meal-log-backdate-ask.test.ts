import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { ConversationContext } from '@/lib/bot/state'

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
    startOfDay: new Date('2026-05-28T03:00:00Z'),
    endOfDay: new Date('2026-05-29T02:59:59.999Z'),
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

// NOTE: @/lib/bot/meal-response, @/lib/utils/meal-time and
// @/lib/utils/relative-date are intentionally NOT mocked so the real
// implementations run (date detection + explicit meal-type detection + receipt).

// ---------------------------------------------------------------------------
// Import after mocks are registered
// ---------------------------------------------------------------------------
import { handleMealLog } from '@/lib/bot/flows/meal-log'

const USER_ID = 'user-meal-log-backdate-ask'

function buildSupabase(): SupabaseClient {
  return {} as unknown as SupabaseClient
}

describe('handleMealLog — backdated log asks for meal type', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockGetLLMProvider.mockReturnValue({
      analyzeMeal: mockAnalyzeMeal,
      decomposeMeal: mockDecomposeMeal,
      classifyIntent: vi.fn(),
      chat: vi.fn(),
    })
    mockGetDailyMacros.mockResolvedValue({ calories: 146, proteinG: 12, carbsG: 1, fatG: 10 })
    mockGetDailyCalories.mockResolvedValue(146)
    mockRecordTacoUsage.mockResolvedValue(undefined)
    mockSearchMealHistory.mockResolvedValue([])
    mockTryProductLookup.mockResolvedValue({ kind: 'skip' })
    mockShouldUseProductFlow.mockResolvedValue(false)
    mockGetRecentMessages.mockResolvedValue([])
    mockFindMealByTypeForDay.mockResolvedValue(null)
    mockGetMealWithItems.mockResolvedValue(null)
  })

  it('asks for the meal type when backdated without explicit meal_type', async () => {
    mockAnalyzeMeal.mockResolvedValue([{
      meal_type: 'snack', confidence: 'high', references_previous: false, reference_query: null,
      items: [{ food: 'Ovo', quantity_grams: 100, quantity_display: '2 ovos', quantity_source: 'estimated', portion_type: 'unit', has_user_quantity: true, calories: null, protein: null, carbs: null, fat: null, confidence: 'high' }],
      unknown_items: [], needs_clarification: false,
    }])
    mockMatchTacoByBase.mockResolvedValue([{ id: 1, foodName: 'Ovo', foodBase: 'Ovo', foodVariant: 'cozido', caloriesPer100g: 146, proteinPer100g: 12, carbsPer100g: 1, fatPer100g: 10, isDefault: true }])

    const res = await handleMealLog(buildSupabase(), USER_ID, 'ontem comi 2 ovos', { calorieMode: 'taco', dailyCalorieTarget: 2168 }, null)

    expect(mockSetState).toHaveBeenCalledWith(USER_ID, 'awaiting_meal_type', expect.objectContaining({ originalMessage: 'ontem comi 2 ovos' }))
    expect(mockCreateMeal).not.toHaveBeenCalled()
    expect(res.completed).toBe(false)
    expect(res.response.toLowerCase()).toContain('refeição')
  })

  it('registers on the chosen meal type for the backdated day', async () => {
    mockFindMealByTypeForDay.mockResolvedValue(null)
    mockCreateMeal.mockResolvedValue('m-back')
    mockGetMealWithItems.mockResolvedValue({ id: 'm-back', mealType: 'breakfast', totalCalories: 146, registeredAt: 'x', items: [{ id: '1', foodName: 'Ovo', quantityGrams: 100, quantityDisplay: '2 ovos', calories: 146, proteinG: 12, carbsG: 1, fatG: 10, source: 'taco', confidence: 'high' }] })

    const ctx = {
      id: 'c', userId: USER_ID, contextType: 'awaiting_meal_type',
      contextData: {
        items: [{ foodName: 'Ovo', quantityGrams: 100, quantityDisplay: '2 ovos', calories: 146, proteinG: 12, carbsG: 1, fatG: 10, source: 'taco', confidence: 'high' }],
        targetDateISO: '2026-05-28T12:00:00.000Z',
        originalMessage: 'ontem comi 2 ovos',
      },
      expiresAt: new Date(Date.now() + 600000).toISOString(), createdAt: new Date().toISOString(),
    } as unknown as ConversationContext
    const res = await handleMealLog(buildSupabase(), USER_ID, 'café da manhã', { calorieMode: 'taco', dailyCalorieTarget: 2168 }, ctx)

    expect(res.completed).toBe(true)
    expect(mockCreateMeal).toHaveBeenCalled()
    const createArg = mockCreateMeal.mock.calls[0][1]
    expect(createArg.mealType).toBe('breakfast')
    expect(createArg.registeredAt).toBeInstanceOf(Date) // backdated
  })

  it('re-asks (without clearing state) when the reply is not a recognizable meal', async () => {
    const ctx = {
      id: 'c', userId: USER_ID, contextType: 'awaiting_meal_type',
      contextData: {
        items: [{ foodName: 'Ovo', quantityGrams: 100, quantityDisplay: '2 ovos', calories: 146, proteinG: 12, carbsG: 1, fatG: 10, source: 'taco', confidence: 'high' }],
        targetDateISO: '2026-05-28T12:00:00.000Z',
        originalMessage: 'ontem comi 2 ovos',
      },
      expiresAt: new Date(Date.now() + 600000).toISOString(), createdAt: new Date().toISOString(),
    } as unknown as ConversationContext
    const res = await handleMealLog(buildSupabase(), USER_ID, 'sei lá', { calorieMode: 'taco', dailyCalorieTarget: 2168 }, ctx)
    expect(res.completed).toBe(false)
    expect(res.response.toLowerCase()).toContain('não entendi')
    expect(mockClearState).not.toHaveBeenCalled()
    expect(mockCreateMeal).not.toHaveBeenCalled()
  })

  // #6 — a backdated log that NEEDS a quantity must STILL ask the meal type first
  // (the early ask fires before the bulk-quantity triage). On reply, the text re-run
  // reconstructs an explicit-meal message, so the 2nd analyzeMeal call sees "almoço".
  it('asks meal type for a backdated bulk food then re-runs with an explicit meal phrase', async () => {
    // "arroz" with no quantity → would normally go to the bulk-quantity flow.
    // The real LLM would re-classify the reconstructed "no almoço ..." message as lunch;
    // we simulate that with the mock returning lunch on every analyzeMeal call.
    const bulkArroz = [{
      meal_type: 'lunch', confidence: 'high', references_previous: false, reference_query: null,
      items: [{ food: 'arroz', quantity_grams: null, quantity_display: null, quantity_source: 'estimated', portion_type: 'bulk', has_user_quantity: false, calories: null, protein: null, carbs: null, fat: null, confidence: 'high' }],
      unknown_items: [], needs_clarification: false,
    }]
    mockAnalyzeMeal.mockResolvedValue(bulkArroz)

    // First turn: backdated "ontem comi arroz" → early meal-type ask (no meal created, no bulk flow yet).
    const firstRes = await handleMealLog(buildSupabase(), USER_ID, 'ontem comi arroz', { calorieMode: 'taco', dailyCalorieTarget: 2168 }, null)
    expect(firstRes.completed).toBe(false)
    expect(mockSetState).toHaveBeenCalledWith(USER_ID, 'awaiting_meal_type', expect.objectContaining({ originalMessage: 'ontem comi arroz' }))
    expect(mockCreateMeal).not.toHaveBeenCalled()
    // The early ask must short-circuit BEFORE the bulk-quantity triage.
    expect(mockSetState).not.toHaveBeenCalledWith(USER_ID, 'awaiting_bulk_quantities', expect.anything())

    // Second turn: user replies "almoço". Text mode → re-run with explicit phrase.
    const ctx = {
      id: 'c', userId: USER_ID, contextType: 'awaiting_meal_type',
      contextData: { originalMessage: 'ontem comi arroz' },
      expiresAt: new Date(Date.now() + 600000).toISOString(), createdAt: new Date().toISOString(),
    } as unknown as ConversationContext

    const secondRes = await handleMealLog(buildSupabase(), USER_ID, 'almoço', { calorieMode: 'taco', dailyCalorieTarget: 2168 }, ctx)

    // The reconstructed message handed to the 2nd analyzeMeal must carry an explicit meal phrase.
    const reconstructed = mockAnalyzeMeal.mock.calls[mockAnalyzeMeal.mock.calls.length - 1][0] as string
    expect(reconstructed.toLowerCase()).toContain('almoço')
    expect(reconstructed.toLowerCase()).toContain('arroz')
    // arroz still has no quantity → re-run lands in the bulk-quantity flow, no meal created yet.
    expect(secondRes.completed).toBe(false)
    expect(mockCreateMeal).not.toHaveBeenCalled()
    expect(mockSetState).toHaveBeenCalledWith(USER_ID, 'awaiting_bulk_quantities', expect.objectContaining({ meal_type: 'lunch' }))
  })

  // #2 (text) — after a successful chosen-type text re-run, recent_meal IS seeded.
  it('seeds recent_meal after a text re-run registers under the chosen meal type', async () => {
    // arroz already has a quantity → the re-run registers directly (no bulk flow).
    // Mock returns lunch to simulate the LLM re-classifying the reconstructed "no almoço ..." message.
    mockAnalyzeMeal.mockResolvedValue([{
      meal_type: 'lunch', confidence: 'high', references_previous: false, reference_query: null,
      items: [{ food: 'arroz', quantity_grams: 150, quantity_display: '4 colheres', quantity_source: 'user', portion_type: 'bulk', has_user_quantity: true, calories: null, protein: null, carbs: null, fat: null, confidence: 'high' }],
      unknown_items: [], needs_clarification: false,
    }])
    mockMatchTacoByBase.mockResolvedValue([{ id: 9, foodName: 'Arroz', foodBase: 'Arroz', foodVariant: 'cozido', caloriesPer100g: 130, proteinPer100g: 2.5, carbsPer100g: 28, fatPer100g: 0.2, isDefault: true }])
    mockCreateMeal.mockResolvedValue('m-arroz')
    // recent_meal seeding reads the saved meal back via getMealWithItems.
    mockGetMealWithItems.mockResolvedValue({ id: 'm-arroz', mealType: 'lunch', totalCalories: 195, registeredAt: 'x', items: [{ id: '1', foodName: 'arroz', quantityGrams: 150, quantityDisplay: '4 colheres', calories: 195, proteinG: 3.8, carbsG: 42, fatG: 0.3, source: 'taco', confidence: 'high' }] })

    const ctx = {
      id: 'c', userId: USER_ID, contextType: 'awaiting_meal_type',
      contextData: { originalMessage: 'ontem comi 150g de arroz' },
      expiresAt: new Date(Date.now() + 600000).toISOString(), createdAt: new Date().toISOString(),
    } as unknown as ConversationContext

    const res = await handleMealLog(buildSupabase(), USER_ID, 'almoço', { calorieMode: 'taco', dailyCalorieTarget: 2168 }, ctx)

    expect(res.completed).toBe(true)
    expect(mockCreateMeal).toHaveBeenCalled()
    expect(mockCreateMeal.mock.calls[0][1].mealType).toBe('lunch')
    // The text re-run seeds recent_meal via analyzeAndRegister's saveRecentMealState.
    expect(mockSetState).toHaveBeenCalledWith(USER_ID, 'recent_meal', expect.objectContaining({ mealId: 'm-arroz' }))
  })

  // Bonus guard — "de ontem" in a references_previous message is part of the REFERENCE
  // query (which past meal to copy), NOT a backdate of THIS log. It must register for TODAY.
  it('does NOT backdate a references_previous log even when it says "de ontem" (registers today)', async () => {
    // single meal, references_previous, single history match → history single-match branch registers
    mockAnalyzeMeal.mockResolvedValue([{
      meal_type: 'snack', confidence: 'high', references_previous: true, reference_query: 'açaí',
      items: [{ food: 'Açaí', quantity_grams: 100, quantity_display: null, quantity_source: 'estimated', portion_type: 'unit', has_user_quantity: true, calories: null, protein: null, carbs: null, fat: null, confidence: 'high' }],
      unknown_items: [], needs_clarification: false,
    }])
    // exactly one history match → single-match branch
    mockSearchMealHistory.mockResolvedValue([{ foodName: 'Açaí', quantityGrams: 100, calories: 80, protein: 1, carbs: 18, fat: 0.5, tacoId: null, registeredAt: '2026-05-29T12:00:00Z' }])
    mockFindMealByTypeForDay.mockResolvedValue(null)
    mockCreateMeal.mockResolvedValue('m-ref')
    mockGetMealWithItems.mockResolvedValue({ id: 'm-ref', mealType: 'snack', totalCalories: 80, registeredAt: 'x', items: [{ id: '1', foodName: 'Açaí', quantityGrams: 100, quantityDisplay: null, calories: 80, proteinG: 1, carbsG: 18, fatG: 0.5, source: 'user_history', confidence: 'high' }] })

    const res = await handleMealLog(buildSupabase(), USER_ID, 'igual aquele açaí de ontem', { calorieMode: 'taco', dailyCalorieTarget: 2168 }, null)

    expect(res.completed).toBe(true)
    expect(mockSetState).not.toHaveBeenCalledWith(USER_ID, 'awaiting_meal_type', expect.anything()) // no ask
    expect(mockCreateMeal).toHaveBeenCalled()
    // KEY: registered for TODAY (logFoodToMeal leaves registeredAt undefined when targetDate == today),
    // NOT backdated to yesterday. If the references guard regressed, targetDate would be yesterday → registeredAt a Date.
    const createArg = mockCreateMeal.mock.calls[0][1]
    expect(createArg.registeredAt).toBeUndefined()
  })
})
