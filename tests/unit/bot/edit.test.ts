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
  mockLLMChat,
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
    mockLLMChat: vi.fn(),
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
}))

vi.mock('@/lib/bot/state', () => ({
  setState: mockSetState,
  clearState: mockClearState,
}))

vi.mock('@/lib/llm/index', () => ({
  getLLMProvider: () => ({ chat: mockLLMChat }),
}))

vi.mock('@/lib/utils/formatters', () => ({
  formatProgress: vi.fn().mockReturnValue('📊 Hoje: 1200 / 2000 kcal'),
}))

import { handleEdit } from '@/lib/bot/flows/edit'

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

function buildCorrectionContext(): ConversationContext {
  return {
    id: 'ctx-2',
    userId: USER_ID,
    contextType: 'awaiting_correction',
    contextData: {
      action: 'select_meal',
      meals: mockRecentMeals,
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

describe('handleEdit — update_value via natural language', () => {
  let supabase: SupabaseClient

  beforeEach(() => {
    vi.clearAllMocks()
    supabase = buildSupabase()
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
