import { describe, it, expect, vi, beforeEach } from 'vitest'

const {
  mockFindOrCreateMeal, mockAddMealItems,
  mockRecalculateMealTotal, mockGetMealWithItems,
} = vi.hoisted(() => ({
  mockFindOrCreateMeal: vi.fn(),
  mockAddMealItems: vi.fn().mockResolvedValue(undefined),
  mockRecalculateMealTotal: vi.fn(),
  mockGetMealWithItems: vi.fn(),
}))

vi.mock('@/lib/db/queries/meals', () => ({
  findOrCreateMeal: mockFindOrCreateMeal,
  addMealItems: mockAddMealItems,
  recalculateMealTotal: mockRecalculateMealTotal,
  getMealWithItems: mockGetMealWithItems,
  getDayBoundsForTimezone: vi.fn(() => ({
    startOfDay: new Date('2026-05-28T03:00:00Z'),
    endOfDay: new Date('2026-05-29T02:59:59.999Z'),
  })),
}))

import { logFoodToMeal } from '@/lib/bot/flows/meal-log'

const ITEM = {
  foodName: 'Açaí', quantityGrams: 67, calories: 80, proteinG: 1, carbsG: 18, fatG: 0.5, source: 'manual',
}
const supabase = {} as never

beforeEach(() => {
  vi.clearAllMocks()
})

describe('logFoodToMeal', () => {
  it('appends to an existing meal of the same type/day and returns the consolidated meal', async () => {
    // find-or-create resolved to an EXISTING meal → wasAppend true (consolidation).
    mockFindOrCreateMeal.mockResolvedValue({ mealId: 'meal-1', wasAppend: true })
    mockRecalculateMealTotal.mockResolvedValue(292)
    mockGetMealWithItems.mockResolvedValue({
      id: 'meal-1', mealType: 'breakfast', totalCalories: 292, registeredAt: 'x',
      items: [
        { id: 'a', foodName: 'Ovo', quantityGrams: 100, quantityDisplay: '2 ovos', calories: 146, proteinG: 12, carbsG: 1, fatG: 10, source: 'taco', confidence: 'high' },
        { id: 'b', foodName: 'Queijo mussarela', quantityGrams: 20, quantityDisplay: '1 fatia', calories: 66, proteinG: 5, carbsG: 0, fatG: 5, source: 'taco', confidence: 'high' },
        { id: 'c', foodName: 'Açaí', quantityGrams: 67, quantityDisplay: null, calories: 80, proteinG: 1, carbsG: 18, fatG: 0.5, source: 'manual', confidence: 'high' },
      ],
    })

    const result = await logFoodToMeal(supabase, {
      userId: 'u', mealType: 'breakfast', items: [ITEM],
      originalMessage: 'comi também 67g de açaí', targetDate: new Date('2026-05-29T12:00:00Z'),
    })

    // The append/create branch is now fully inside find_or_create_meal; logFoodToMeal
    // always adds items + recalcs on whatever mealId it returns.
    expect(mockFindOrCreateMeal).toHaveBeenCalledTimes(1)
    expect(mockAddMealItems).toHaveBeenCalledWith(supabase, 'meal-1', [ITEM])
    expect(mockRecalculateMealTotal).toHaveBeenCalledWith(supabase, 'meal-1')
    expect(result.wasAppend).toBe(true)
    expect(result.mealId).toBe('meal-1')
    expect(result.addedItems).toEqual([ITEM])
    expect(result.meal.items).toHaveLength(3)
    expect(result.meal.totalCalories).toBe(292)
  })

  it('persists an identical food and quantity as a new consumption', async () => {
    mockFindOrCreateMeal.mockResolvedValue({ mealId: 'meal-1', wasAppend: true })
    mockRecalculateMealTotal.mockResolvedValue(202)
    const existingMelon = {
      id: 'm1', foodName: 'Melão', quantityGrams: 345, quantityDisplay: '345g',
      calories: 101, proteinG: 2, carbsG: 26, fatG: 0, source: 'taco', confidence: 'high' as const,
    }
    mockGetMealWithItems.mockResolvedValue({
      id: 'meal-1', mealType: 'breakfast', totalCalories: 202, registeredAt: 'x',
      items: [existingMelon, { ...existingMelon, id: 'm2' }],
    })

    const repeatedMelon = {
      foodName: 'Melão', quantityGrams: 345, calories: 101, proteinG: 2, carbsG: 26, fatG: 0, source: 'taco',
    }
    const result = await logFoodToMeal(supabase, {
      userId: 'u', mealType: 'breakfast', items: [repeatedMelon],
      originalMessage: 'mais 345g de melão', targetDate: new Date(),
    })

    expect(mockAddMealItems).toHaveBeenCalledWith(supabase, 'meal-1', [repeatedMelon])
    expect(mockRecalculateMealTotal).toHaveBeenCalledWith(supabase, 'meal-1')
    expect(result.addedItems).toEqual([repeatedMelon])
  })

  it('creates a new meal when none exists for the day/type', async () => {
    // find-or-create returned a freshly-created meal → wasAppend false.
    mockFindOrCreateMeal.mockResolvedValue({ mealId: 'new-meal', wasAppend: false })
    mockRecalculateMealTotal.mockResolvedValue(80)
    mockGetMealWithItems.mockResolvedValue({
      id: 'new-meal', mealType: 'breakfast', totalCalories: 80, registeredAt: 'x',
      items: [{ id: 'c', foodName: 'Açaí', quantityGrams: 67, quantityDisplay: null, calories: 80, proteinG: 1, carbsG: 18, fatG: 0.5, source: 'manual', confidence: 'high' }],
    })

    const result = await logFoodToMeal(supabase, {
      userId: 'u', mealType: 'breakfast', items: [ITEM], originalMessage: 'comi açaí',
      targetDate: new Date(),
    })

    expect(mockFindOrCreateMeal).toHaveBeenCalledTimes(1)
    // Today's log → no backdate, registeredAt left undefined for the RPC.
    const input = mockFindOrCreateMeal.mock.calls[0][1]
    expect(input.registeredAt).toBeUndefined()
    expect(mockAddMealItems).toHaveBeenCalledWith(supabase, 'new-meal', [ITEM])
    expect(result.wasAppend).toBe(false)
    expect(result.mealId).toBe('new-meal')
  })

  it('backdates registered_at to local noon when the target day is not today', async () => {
    mockFindOrCreateMeal.mockResolvedValue({ mealId: 'back-meal', wasAppend: false })
    mockRecalculateMealTotal.mockResolvedValue(80)
    mockGetMealWithItems.mockResolvedValue({ id: 'back-meal', mealType: 'dinner', totalCalories: 80, registeredAt: 'x', items: [] })

    await logFoodToMeal(supabase, {
      userId: 'u', mealType: 'dinner', items: [ITEM], originalMessage: 'ontem jantei açaí',
      targetDate: new Date('2026-05-28T12:00:00Z'),
    })

    // Backdate is now computed in logFoodToMeal and passed to find_or_create_meal as registeredAt.
    const input = mockFindOrCreateMeal.mock.calls[0][1]
    expect(input.registeredAt).toBeInstanceOf(Date)
    expect((input.registeredAt as Date).toISOString()).toBe('2026-05-28T15:00:00.000Z')
  })
})
