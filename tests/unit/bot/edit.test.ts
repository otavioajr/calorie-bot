import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { ConversationContext } from '@/lib/bot/state'

// ---------------------------------------------------------------------------
// Hoist mock variables
// ---------------------------------------------------------------------------
const {
  mockDeleteMeal,
  mockGetLastMeal,
  mockGetRecentMeals,
  mockSetState,
  mockClearState,
  mockGetMealWithItems,
  mockUpdateMealItem,
  mockRemoveMealItem,
  mockRecalculateMealTotal,
  mockGetDailyCalories,
  mockGetDailyMacros,
  mockUpdateMealType,
  mockLLMChat,
  mockAnalyzeMeal,
  mockAppendItemsToMeal,
  mockEnrichItemsWithTaco,
} = vi.hoisted(() => {
  return {
    mockDeleteMeal: vi.fn().mockResolvedValue(undefined),
    mockGetLastMeal: vi.fn(),
    mockGetRecentMeals: vi.fn().mockResolvedValue([]),
    mockSetState: vi.fn().mockResolvedValue(undefined),
    mockClearState: vi.fn().mockResolvedValue(undefined),
    mockGetMealWithItems: vi.fn(),
    mockUpdateMealItem: vi.fn().mockResolvedValue(undefined),
    mockRemoveMealItem: vi.fn().mockResolvedValue(undefined),
    mockRecalculateMealTotal: vi.fn().mockResolvedValue(500),
    mockGetDailyCalories: vi.fn().mockResolvedValue(1200),
    mockGetDailyMacros: vi.fn().mockResolvedValue({ calories: 1200, proteinG: 0, carbsG: 0, fatG: 0 }),
    mockUpdateMealType: vi.fn().mockResolvedValue(undefined),
    mockLLMChat: vi.fn(),
    mockAnalyzeMeal: vi.fn(),
    mockAppendItemsToMeal: vi.fn(),
    mockEnrichItemsWithTaco: vi.fn(),
  }
})

vi.mock('@/lib/db/queries/meals', () => ({
  deleteMeal: mockDeleteMeal,
  getLastMeal: mockGetLastMeal,
  getRecentMeals: mockGetRecentMeals,
  getMealWithItems: mockGetMealWithItems,
  updateMealItem: mockUpdateMealItem,
  removeMealItem: mockRemoveMealItem,
  recalculateMealTotal: mockRecalculateMealTotal,
  getDailyCalories: mockGetDailyCalories,
  getDailyMacros: mockGetDailyMacros,
  updateMealType: mockUpdateMealType,
}))

vi.mock('@/lib/bot/state', () => ({
  setState: mockSetState,
  clearState: mockClearState,
}))

vi.mock('@/lib/llm/index', () => ({
  getLLMProvider: () => ({ chat: mockLLMChat, analyzeMeal: mockAnalyzeMeal }),
}))

vi.mock('@/lib/utils/formatters', () => ({
  formatProgress: vi.fn((consumed: number, target: number, macros?: unknown) =>
    macros ? `📊 Hoje: ${consumed} / ${target} kcal\nP-LINE` : `📊 Hoje: ${consumed} / ${target} kcal`),
}))

vi.mock('@/lib/bot/flows/meal-log', () => ({
  appendItemsToMeal: mockAppendItemsToMeal,
  enrichItemsWithTaco: mockEnrichItemsWithTaco,
}))

import { handleEdit, handleEditForMeal } from '@/lib/bot/flows/edit'
import { formatProgress } from '@/lib/utils/formatters'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const USER_ID = 'user-edit-123'

const mockLastMeal = {
  id: 'meal-id-1',
  mealType: 'lunch',
  totalCalories: 800,
  registeredAt: '2024-03-21T12:00:00Z',
}

const mockRecentMeals = [
  { id: 'meal-id-1', mealType: 'lunch', totalCalories: 800, registeredAt: '2024-03-21T12:00:00Z' },
  { id: 'meal-id-2', mealType: 'breakfast', totalCalories: 350, registeredAt: '2024-03-21T08:00:00Z' },
  { id: 'meal-id-3', mealType: 'snack', totalCalories: 200, registeredAt: '2024-03-20T15:00:00Z' },
]

function buildSupabase(): SupabaseClient {
  return {} as unknown as SupabaseClient
}

function buildConfirmDeleteContext(mealId: string = 'meal-id-1'): ConversationContext {
  return {
    id: 'ctx-1',
    userId: USER_ID,
    contextType: 'awaiting_correction',
    contextData: {
      action: 'delete_confirm',
      mealId,
      mealType: 'lunch',
      totalCalories: 800,
    },
    expiresAt: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
    createdAt: new Date().toISOString(),
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('handleEdit', () => {
  let supabase: SupabaseClient

  beforeEach(() => {
    vi.clearAllMocks()
    supabase = buildSupabase()
    mockGetLastMeal.mockResolvedValue(mockLastMeal)
    mockGetRecentMeals.mockResolvedValue(mockRecentMeals)
  })

  // -------------------------------------------------------------------------
  // Delete last meal flow
  // -------------------------------------------------------------------------

  describe('delete last meal', () => {
    it('asks for confirmation when "apagar último"', async () => {
      const result = await handleEdit(supabase, USER_ID, 'apagar último', null)

      expect(result).toMatch(/confirma|quer apagar|deletar/i)
      expect(mockDeleteMeal).not.toHaveBeenCalled()
    })

    it('asks for confirmation when "apaga"', async () => {
      const result = await handleEdit(supabase, USER_ID, 'apaga', null)

      expect(result).toMatch(/confirma|quer apagar|deletar/i)
      expect(mockDeleteMeal).not.toHaveBeenCalled()
    })

    it('sets awaiting_correction state with delete_confirm action', async () => {
      await handleEdit(supabase, USER_ID, 'apagar último', null)

      expect(mockSetState).toHaveBeenCalledWith(
        USER_ID,
        'awaiting_correction',
        expect.objectContaining({
          action: 'delete_confirm',
          mealId: mockLastMeal.id,
        }),
      )
    })

    it('shows the meal info in confirmation message', async () => {
      const result = await handleEdit(supabase, USER_ID, 'apagar último', null)

      expect(result).toMatch(/lunch|almoço|800/i)
    })

    it('handles no meals found gracefully', async () => {
      mockGetLastMeal.mockResolvedValue(null)

      const result = await handleEdit(supabase, USER_ID, 'apagar último', null)

      expect(result).toMatch(/nenhuma|não.*encontrei|vazio/i)
      expect(mockDeleteMeal).not.toHaveBeenCalled()
    })
  })

  // -------------------------------------------------------------------------
  // Delete confirmation
  // -------------------------------------------------------------------------

  describe('delete confirmation with awaiting_correction context', () => {
    it('deletes meal on "sim" confirmation', async () => {
      const context = buildConfirmDeleteContext()
      await handleEdit(supabase, USER_ID, 'sim', context)

      expect(mockDeleteMeal).toHaveBeenCalledWith(supabase, 'meal-id-1')
    })

    it('deletes meal on "s" confirmation', async () => {
      const context = buildConfirmDeleteContext()
      await handleEdit(supabase, USER_ID, 's', context)

      expect(mockDeleteMeal).toHaveBeenCalled()
    })

    it('clears state after deletion', async () => {
      const context = buildConfirmDeleteContext()
      await handleEdit(supabase, USER_ID, 'sim', context)

      expect(mockClearState).toHaveBeenCalledWith(USER_ID)
    })

    it('returns success message after deletion', async () => {
      const context = buildConfirmDeleteContext()
      const result = await handleEdit(supabase, USER_ID, 'sim', context)

      expect(result).toMatch(/deletado|removido|apagado|✅/i)
    })

    it('cancels deletion on "não"', async () => {
      const context = buildConfirmDeleteContext()
      const result = await handleEdit(supabase, USER_ID, 'não', context)

      expect(mockDeleteMeal).not.toHaveBeenCalled()
      expect(result).toMatch(/cancelado|ok|mantido/i)
    })
  })

  // -------------------------------------------------------------------------
  // Correction flow (show recent meals)
  // -------------------------------------------------------------------------

  describe('correction flow', () => {
    it('shows recent meals when "corrigir" without context', async () => {
      const result = await handleEdit(supabase, USER_ID, 'corrigir', null)

      expect(result).toMatch(/1.*2.*3|refeições/i)
      expect(mockGetRecentMeals).toHaveBeenCalledWith(supabase, USER_ID, 3)
    })

    it('sets awaiting_correction state with select_meal action', async () => {
      await handleEdit(supabase, USER_ID, 'corrigir', null)

      expect(mockSetState).toHaveBeenCalledWith(
        USER_ID,
        'awaiting_correction',
        expect.objectContaining({
          action: 'select_meal',
        }),
      )
    })

    it('handles no recent meals gracefully', async () => {
      mockGetRecentMeals.mockResolvedValue([])

      const result = await handleEdit(supabase, USER_ID, 'corrigir', null)

      expect(result).toMatch(/nenhuma|não.*encontrei|vazio/i)
    })
  })
})

describe('handleEdit with quoteContext', () => {
  const quoteContext = {
    quotedMessageId: 'wamid.quoted1',
    direction: 'outgoing' as const,
    resourceType: 'meal' as const,
    resourceId: 'meal-quote-1',
  }

  beforeEach(() => {
    vi.clearAllMocks()
    mockGetMealWithItems.mockResolvedValue({
      id: 'meal-quote-1',
      mealType: 'lunch',
      totalCalories: 800,
      registeredAt: '2024-03-21T12:00:00Z',
      items: [
        { id: 'item-1', foodName: 'Arroz branco', quantityGrams: 150, quantityDisplay: '150g', calories: 195, proteinG: 4, carbsG: 42, fatG: 0.5 },
        { id: 'item-2', foodName: 'Feijão preto', quantityGrams: 100, quantityDisplay: '100g', calories: 77, proteinG: 5, carbsG: 14, fatG: 0.5 },
      ],
    })
  })

  it('deletes entire meal when user says "apaga" with quote', async () => {
    const result = await handleEdit(
      buildSupabase(), USER_ID, 'apaga', null,
      { timezone: 'America/Sao_Paulo', dailyCalorieTarget: 2000 },
      quoteContext,
    )
    expect(mockDeleteMeal).toHaveBeenCalledWith(expect.anything(), 'meal-quote-1')
    expect(result).toContain('apagada')
  })

  it('removes specific item when user says "apaga o arroz" with quote', async () => {
    mockRecalculateMealTotal.mockResolvedValue(77)
    const result = await handleEdit(
      buildSupabase(), USER_ID, 'apaga o arroz', null,
      { timezone: 'America/Sao_Paulo', dailyCalorieTarget: 2000 },
      quoteContext,
    )
    expect(mockRemoveMealItem).toHaveBeenCalledWith(expect.anything(), 'item-1')
    expect(result).toContain('removido')
  })

  it('renders the macro line when the user has macro goals', async () => {
    mockRecalculateMealTotal.mockResolvedValue(77)
    mockGetDailyMacros.mockResolvedValue({ calories: 1200, proteinG: 60, carbsG: 100, fatG: 30 })

    const result = await handleEdit(
      buildSupabase(), USER_ID, 'apaga o arroz', null,
      {
        timezone: 'America/Sao_Paulo',
        dailyCalorieTarget: 2000,
        dailyProteinG: 120,
        dailyFatG: 60,
        dailyCarbsG: 200,
      },
      quoteContext,
    )

    expect(mockGetDailyMacros).toHaveBeenCalled()
    expect(formatProgress).toHaveBeenCalledWith(1200, 2000, {
      consumed: { proteinG: 60, fatG: 30, carbsG: 100 },
      target: { proteinG: 120, fatG: 60, carbsG: 200 },
    })
    expect(result).toContain('P-LINE')
  })

  it('returns fallback when quoteContext has no meal resource', async () => {
    const helpQuote = {
      quotedMessageId: 'wamid.help1',
      direction: 'outgoing' as const,
      resourceType: null,
      resourceId: null,
    }
    const result = await handleEdit(
      buildSupabase(), USER_ID, 'apaga', null,
      { timezone: 'America/Sao_Paulo', dailyCalorieTarget: 2000 },
      helpQuote,
    )
    expect(result).toContain('não consigo')
  })

  it('moves the whole quoted meal to another meal type', async () => {
    mockLLMChat.mockResolvedValue(JSON.stringify({
      action: 'change_meal_type',
      target_meal_type: 'breakfast',
      target_food: null,
      new_quantity: null,
      new_food: null,
      new_value: null,
      confidence: 'high',
    }))

    const result = await handleEdit(
      buildSupabase(), USER_ID, 'trocar para o café da manhã', null,
      { timezone: 'America/Sao_Paulo', dailyCalorieTarget: 2000 },
      quoteContext,
    )

    expect(mockUpdateMealType).toHaveBeenCalledWith(expect.anything(), 'meal-quote-1', 'breakfast')
    expect(mockRemoveMealItem).not.toHaveBeenCalled()
    expect(mockUpdateMealItem).not.toHaveBeenCalled()
    expect(result).toContain('Almoço')
    expect(result).toContain('Café da manhã')
  })

  it('returns already-in-type message when quoted meal already has target meal type', async () => {
    mockLLMChat.mockResolvedValue(JSON.stringify({
      action: 'change_meal_type',
      target_meal_type: 'lunch',
      target_food: null,
      new_quantity: null,
      new_food: null,
      new_value: null,
      confidence: 'high',
    }))

    const result = await handleEdit(
      buildSupabase(), USER_ID, 'isso era almoço', null,
      { timezone: 'America/Sao_Paulo', dailyCalorieTarget: 2000 },
      quoteContext,
    )

    expect(mockUpdateMealType).not.toHaveBeenCalled()
    expect(result).toContain('já está')
    expect(result).toContain('Almoço')
  })
})

describe('handleEdit — update_value via natural language', () => {
  let supabase: SupabaseClient

  beforeEach(() => {
    vi.clearAllMocks()
    supabase = buildSupabase()
  })

  it('stops after a low-confidence first parse before selecting a meal', async () => {
    mockLLMChat
      .mockResolvedValueOnce(JSON.stringify({
        action: 'remove_item',
        target_food: 'banana',
        new_quantity: null,
        confidence: 'low',
        target_meal_type: null,
        new_food: null,
        new_value: null,
      }))
      .mockResolvedValueOnce(JSON.stringify({
        action: 'remove_item',
        target_food: 'banana',
        new_quantity: null,
        confidence: 'high',
        target_meal_type: null,
        new_food: null,
        new_value: null,
      }))
    mockGetRecentMeals.mockResolvedValue([
      { id: 'meal-1', mealType: 'breakfast', totalCalories: 105, registeredAt: '2024-03-21T08:00:00Z' },
    ])
    mockGetMealWithItems.mockResolvedValue({
      id: 'meal-1', mealType: 'breakfast', totalCalories: 105, registeredAt: '2024-03-21T08:00:00Z',
      items: [{ id: 'banana-1', foodName: 'Banana', quantityGrams: 120, calories: 105, proteinG: 1, carbsG: 27, fatG: 0 }],
    })

    const result = await handleEdit(
      supabase,
      USER_ID,
      'talvez tira a banana',
      null,
    )

    expect(mockLLMChat).toHaveBeenCalledTimes(1)
    expect(mockGetMealWithItems).not.toHaveBeenCalled()
    expect(mockRemoveMealItem).not.toHaveBeenCalled()
    expect(result).toContain('Qual refeição quer corrigir?')
  })

  it('updates calories directly when LLM returns update_value', async () => {
    mockLLMChat.mockResolvedValue(JSON.stringify({
      action: 'update_value',
      target_food: 'Magic Toast',
      new_value: { field: 'calories', amount: 93 },
      confidence: 'high',
      target_meal_type: null,
      new_quantity: null,
      new_food: null,
    }))

    mockGetRecentMeals.mockResolvedValue([
      { id: 'meal-1', mealType: 'breakfast', totalCalories: 290, registeredAt: '2024-03-21T08:00:00Z' },
    ])

    mockGetMealWithItems.mockResolvedValue({
      id: 'meal-1',
      mealType: 'breakfast',
      totalCalories: 290,
      registeredAt: '2024-03-21T08:00:00Z',
      items: [
        { id: 'item-1', foodName: 'Magic Toast', quantityGrams: 30, calories: 120, proteinG: 3, carbsG: 20, fatG: 3 },
        { id: 'item-2', foodName: 'Queijo cottage', quantityGrams: 25, calories: 9, proteinG: 1.5, carbsG: 0.3, fatG: 0.2 },
      ],
    })

    const result = await handleEdit(
      supabase,
      USER_ID,
      'O magic toast é 93kcal',
      null,
      { timezone: 'America/Sao_Paulo', dailyCalorieTarget: 2000 },
    )

    expect(mockUpdateMealItem).toHaveBeenCalledWith(
      expect.anything(),
      'item-1',
      expect.objectContaining({ calories: 93 }),
    )
    expect(result).toContain('Magic Toast')
    expect(result).toContain('93')
  })
})

describe('handleEdit — add_item via natural language', () => {
  let supabase: SupabaseClient

  beforeEach(() => {
    vi.clearAllMocks()
    supabase = buildSupabase()
  })

  it('appends item to existing meal when LLM returns add_item', async () => {
    mockLLMChat.mockResolvedValue(JSON.stringify({
      action: 'add_item',
      target_food: 'suco de laranja',
      new_quantity: '110ml',
      confidence: 'high',
      target_meal_type: null,
      new_food: null,
      new_value: null,
    }))

    mockGetRecentMeals.mockResolvedValue([
      { id: 'meal-1', mealType: 'breakfast', totalCalories: 304, registeredAt: '2024-03-21T08:00:00Z' },
    ])

    mockGetMealWithItems.mockResolvedValue({
      id: 'meal-1',
      mealType: 'breakfast',
      totalCalories: 304,
      registeredAt: '2024-03-21T08:00:00Z',
      items: [
        { id: 'item-1', foodName: 'Pão de forma', quantityGrams: 50, calories: 172, proteinG: 5, carbsG: 30, fatG: 2 },
        { id: 'item-2', foodName: 'Queijo mussarela', quantityGrams: 30, calories: 132, proteinG: 8, carbsG: 1, fatG: 10 },
      ],
    })

    mockAppendItemsToMeal.mockResolvedValue({
      added: [
        { food: 'Suco de laranja', quantityGrams: 110, quantityDisplay: '110ml', calories: 45, protein: 1, carbs: 10, fat: 0, source: 'taco' },
      ],
      newTotal: 349,
    })

    const result = await handleEdit(
      supabase,
      USER_ID,
      'comi também 110ml de suco de laranja',
      null,
      { timezone: 'America/Sao_Paulo', dailyCalorieTarget: 2000 },
    )

    expect(mockAppendItemsToMeal).toHaveBeenCalledWith(
      expect.anything(),
      USER_ID,
      'meal-1',
      expect.stringContaining('suco de laranja'),
      { timezone: 'America/Sao_Paulo' },
    )
    expect(result).toContain('Adicionado')
    expect(result).toContain('Suco de laranja')
    expect(result).toContain('349')
    expect(mockClearState).toHaveBeenCalledWith(USER_ID)
  })

  it('adds another consumption when the same food already exists in the exact target meal', async () => {
    mockLLMChat.mockResolvedValue(JSON.stringify({
      action: 'add_item',
      target_food: 'banana',
      new_quantity: '1 unidade',
      confidence: 'high',
      target_meal_type: null,
      new_food: null,
      new_value: null,
    }))

    mockGetMealWithItems.mockResolvedValue({
      id: 'meal-from-context',
      mealType: 'breakfast',
      totalCalories: 105,
      registeredAt: '2024-03-21T08:00:00Z',
      items: [
        { id: 'banana-1', foodName: 'Banana', quantityGrams: 120, calories: 105, proteinG: 1, carbsG: 27, fatG: 0 },
      ],
    })

    mockAppendItemsToMeal.mockResolvedValue({
      added: [
        { food: 'Banana', quantityGrams: 120, quantityDisplay: '1 unidade', calories: 105, protein: 1, carbs: 27, fat: 0, source: 'taco' },
      ],
      newTotal: 210,
    })

    const result = await handleEditForMeal(
      supabase,
      USER_ID,
      'coloca mais uma banana',
      'meal-from-context',
      { timezone: 'America/Sao_Paulo', dailyCalorieTarget: 2000 },
    )

    expect(mockGetMealWithItems).toHaveBeenCalledWith(expect.anything(), 'meal-from-context')
    expect(mockGetRecentMeals).not.toHaveBeenCalled()
    expect(mockAppendItemsToMeal).toHaveBeenCalledWith(
      expect.anything(),
      USER_ID,
      'meal-from-context',
      expect.stringContaining('banana'),
      { timezone: 'America/Sao_Paulo' },
    )
    expect(mockUpdateMealItem).not.toHaveBeenCalled()
    expect(mockSetState).not.toHaveBeenCalledWith(
      USER_ID,
      'awaiting_correction_value',
      expect.anything(),
    )
    expect(result.outcome).toBe('applied')
    expect(result.response).toContain('Adicionado')
    expect(result.response).toContain('210')
  })

  it('does not execute a destructive correction when confidence is low', async () => {
    mockLLMChat.mockResolvedValue(JSON.stringify({
      action: 'remove_item',
      target_food: 'banana',
      new_quantity: null,
      confidence: 'low',
      target_meal_type: null,
      new_food: null,
      new_value: null,
    }))
    mockGetMealWithItems.mockResolvedValue({
      id: 'meal-from-context',
      mealType: 'breakfast',
      totalCalories: 105,
      registeredAt: '2024-03-21T08:00:00Z',
      items: [
        { id: 'banana-1', foodName: 'Banana', quantityGrams: 120, calories: 105, proteinG: 1, carbsG: 27, fatG: 0 },
      ],
    })
    mockGetRecentMeals.mockResolvedValue([
      { id: 'meal-from-context', mealType: 'breakfast', totalCalories: 105, registeredAt: '2024-03-21T08:00:00Z' },
    ])

    const result = await handleEditForMeal(
      supabase,
      USER_ID,
      'talvez tira a banana',
      'meal-from-context',
    )

    expect(mockRemoveMealItem).not.toHaveBeenCalled()
    expect(mockUpdateMealType).not.toHaveBeenCalled()
    expect(mockDeleteMeal).not.toHaveBeenCalled()
    expect(mockAppendItemsToMeal).not.toHaveBeenCalled()
    expect(mockSetState).toHaveBeenCalledWith(
      USER_ID,
      'awaiting_correction',
      expect.objectContaining({ action: 'select_meal' }),
    )
    expect(result.outcome).toBe('awaiting_user')
    expect(result.response).toContain('Qual refeição quer corrigir?')
  })

  it('returns helpful error when append fails to resolve item', async () => {
    mockLLMChat.mockResolvedValue(JSON.stringify({
      action: 'add_item',
      target_food: 'suco',
      new_quantity: null,
      confidence: 'high',
      target_meal_type: null,
      new_food: null,
      new_value: null,
    }))

    mockGetRecentMeals.mockResolvedValue([
      { id: 'meal-1', mealType: 'breakfast', totalCalories: 200, registeredAt: '2024-03-21T08:00:00Z' },
    ])

    mockGetMealWithItems.mockResolvedValue({
      id: 'meal-1',
      mealType: 'breakfast',
      totalCalories: 200,
      registeredAt: '2024-03-21T08:00:00Z',
      items: [
        { id: 'item-1', foodName: 'Pão', quantityGrams: 50, calories: 200, proteinG: 5, carbsG: 30, fatG: 2 },
      ],
    })

    mockAppendItemsToMeal.mockResolvedValue(null)

    const result = await handleEdit(
      supabase,
      USER_ID,
      'esqueci do suco',
      null,
      { timezone: 'America/Sao_Paulo', dailyCalorieTarget: 2000 },
    )

    expect(result).toContain('Não consegui adicionar')
    expect(mockClearState).toHaveBeenCalledWith(USER_ID)
  })

  it('does not claim rename was not applied when a post-write refresh fails', async () => {
    mockLLMChat.mockResolvedValue(JSON.stringify({
      action: 'replace_item',
      target_food: 'pão',
      new_food: 'tapioca',
      new_quantity: null,
      confidence: 'high',
      target_meal_type: null,
      new_value: null,
    }))
    mockGetMealWithItems.mockResolvedValue({
      id: 'meal-1',
      mealType: 'breakfast',
      totalCalories: 200,
      registeredAt: '2024-03-21T08:00:00Z',
      items: [
        { id: 'item-1', foodName: 'Pão', quantityGrams: 50, calories: 200, proteinG: 5, carbsG: 30, fatG: 2 },
      ],
    })
    mockAnalyzeMeal.mockResolvedValue([{
      items: [{ food: 'Tapioca', quantity_grams: 50, calories: null }],
    }])
    mockEnrichItemsWithTaco.mockResolvedValue([{
      food: 'Tapioca',
      quantityGrams: 50,
      calories: 116,
      protein: 0,
      carbs: 29,
      fat: 0,
      source: 'taco',
    }])
    mockRecalculateMealTotal.mockRejectedValueOnce(new Error('refresh failed after update'))

    await expect(handleEditForMeal(
      supabase,
      USER_ID,
      'troca o pão por tapioca',
      'meal-1',
    )).rejects.toThrow('refresh failed after update')

    expect(mockUpdateMealItem).toHaveBeenCalledWith(
      expect.anything(),
      'item-1',
      expect.objectContaining({ foodName: 'Tapioca' }),
    )
  })

  it('prices the replacement through the enrichment pipeline instead of trusting the analyzer', async () => {
    mockLLMChat.mockResolvedValue(JSON.stringify({
      action: 'replace_item',
      target_food: 'espaguete ao alho e óleo',
      new_food: 'carbonara',
      new_quantity: null,
      confidence: 'high',
      target_meal_type: null,
      new_value: null,
    }))
    mockGetMealWithItems.mockResolvedValue({
      id: 'meal-1',
      mealType: 'breakfast',
      totalCalories: 237,
      registeredAt: '2024-03-21T08:00:00Z',
      items: [
        { id: 'item-1', foodName: 'Espaguete ao alho e óleo', quantityGrams: 150, calories: 237, proteinG: 8, carbsG: 38, fatG: 6 },
      ],
    })
    // analyzeMeal never returns macros — the prompt tells the LLM to leave them null.
    mockAnalyzeMeal.mockResolvedValue([{
      items: [{ food: 'Espaguete à carbonara', quantity_grams: 150, calories: null, protein: null, carbs: null, fat: null }],
    }])
    mockEnrichItemsWithTaco.mockResolvedValue([{
      food: 'Espaguete à carbonara',
      quantityGrams: 150,
      calories: 570,
      protein: 21,
      carbs: 52,
      fat: 29,
      source: 'taco_decomposed',
    }])
    mockRecalculateMealTotal.mockResolvedValue(732)

    const result = await handleEditForMeal(supabase, USER_ID, 'não é alho e óleo, é carbonara', 'meal-1')

    expect(mockUpdateMealItem).toHaveBeenCalledWith(
      expect.anything(),
      'item-1',
      expect.objectContaining({
        foodName: 'Espaguete à carbonara',
        quantityGrams: 150,
        calories: 570,
        proteinG: 21,
        carbsG: 52,
        fatG: 29,
      }),
    )
    expect(result.outcome).toBe('applied')
    expect(result.response).toContain('237 kcal → 570 kcal')
  })

  it('keeps the original item when the enrichment cannot price the replacement', async () => {
    mockLLMChat.mockResolvedValue(JSON.stringify({
      action: 'replace_item',
      target_food: 'pão',
      new_food: 'bolo da vovó',
      new_quantity: null,
      confidence: 'high',
      target_meal_type: null,
      new_value: null,
    }))
    mockGetMealWithItems.mockResolvedValue({
      id: 'meal-1',
      mealType: 'breakfast',
      totalCalories: 200,
      registeredAt: '2024-03-21T08:00:00Z',
      items: [
        { id: 'item-1', foodName: 'Pão', quantityGrams: 50, calories: 200, proteinG: 5, carbsG: 30, fatG: 2 },
      ],
    })
    mockAnalyzeMeal.mockResolvedValue([{
      items: [{ food: 'Bolo da vovó', quantity_grams: 50, calories: null }],
    }])
    mockEnrichItemsWithTaco.mockResolvedValue([{
      food: 'Bolo da vovó',
      quantityGrams: 50,
      calories: 0,
      protein: 0,
      carbs: 0,
      fat: 0,
      source: 'approximate',
    }])

    const result = await handleEditForMeal(supabase, USER_ID, 'era bolo da vovó', 'meal-1')

    expect(mockUpdateMealItem).not.toHaveBeenCalled()
    expect(mockRecalculateMealTotal).not.toHaveBeenCalled()
    expect(result.outcome).toBe('not_applied')
    expect(result.response).toContain('não mudei nada')
  })
})
