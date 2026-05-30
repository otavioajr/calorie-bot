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
})
