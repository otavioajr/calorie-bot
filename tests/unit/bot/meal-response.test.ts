import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock the state module so we can assert setState/clearState calls.
// The formatters module is intentionally NOT mocked — these tests exercise the
// real formatMealAddition / formatMealBreakdown output.
// Hoisted so the mocks are available at vi.mock() factory call time.
const { mockSetState, mockClearState } = vi.hoisted(() => ({
  mockSetState: vi.fn().mockResolvedValue(undefined),
  mockClearState: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('@/lib/bot/state', () => ({
  setState: mockSetState,
  clearState: mockClearState,
}))

import { setRecentMealState, buildConsolidatedMealResponse } from '@/lib/bot/meal-response'
import type { LogFoodResult } from '@/lib/bot/flows/meal-log'
import type { MealItemDetail } from '@/lib/db/queries/meals'

const USER_ID = 'user-1'

function item(overrides: Partial<MealItemDetail>): MealItemDetail {
  return {
    id: 'i1',
    foodName: 'Ovo',
    quantityGrams: 100,
    quantityDisplay: null,
    calories: 143,
    proteinG: 13,
    carbsG: 1,
    fatG: 10,
    source: 'taco',
    confidence: 'high',
    ...overrides,
  }
}

describe('buildConsolidatedMealResponse', () => {
  it('renders the "Somei" delta + full meal when items were appended', () => {
    const logResult: LogFoodResult = {
      wasAppend: true,
      mealId: 'm1',
      addedItems: [
        { foodName: 'Açaí', quantityGrams: 67, calories: 80, proteinG: 1, carbsG: 18, fatG: 0.4, source: 'manual' },
      ],
      meal: {
        id: 'm1',
        mealType: 'breakfast',
        totalCalories: 292,
        registeredAt: '2026-04-23T18:00:00Z',
        items: [
          item({ id: 'i1', foodName: 'Ovo', quantityGrams: 100, calories: 143 }),
          item({ id: 'i2', foodName: 'Queijo', quantityGrams: 30, calories: 69, proteinG: 6, fatG: 5 }),
          item({ id: 'i3', foodName: 'Açaí', quantityGrams: 67, calories: 80, proteinG: 1, carbsG: 18, fatG: 0.4, source: 'manual' }),
        ],
      },
    }

    const response = buildConsolidatedMealResponse(logResult, 500, 2000, 'Hoje')

    expect(response).toContain('Somei')
    expect(response).toContain('Café da manhã agora:')
    expect(response).toContain('Total: 292 kcal')
  })

  it('renders the "registrado!" breakdown for a brand-new meal', () => {
    const logResult: LogFoodResult = {
      wasAppend: false,
      mealId: 'm2',
      addedItems: [
        { foodName: 'Arroz', quantityGrams: 150, calories: 195, proteinG: 4, carbsG: 42, fatG: 0, source: 'taco' },
      ],
      meal: {
        id: 'm2',
        mealType: 'lunch',
        totalCalories: 195,
        registeredAt: '2026-04-23T18:00:00Z',
        items: [item({ id: 'i1', foodName: 'Arroz', quantityGrams: 150, calories: 195, source: 'taco' })],
      },
    }

    const response = buildConsolidatedMealResponse(logResult, 500, 2000, 'Hoje')

    expect(response).toContain('registrado!')
    expect(response).toContain('Total: 195 kcal')
    expect(response).not.toContain('Somei')
  })
})

describe('setRecentMealState', () => {
  beforeEach(() => {
    mockSetState.mockClear()
    mockClearState.mockClear()
  })

  it('sets recent_meal context with mapped items when the meal has items', async () => {
    const meal: LogFoodResult['meal'] = {
      id: 'm1',
      mealType: 'breakfast',
      totalCalories: 212,
      registeredAt: '2026-04-23T18:00:00Z',
      items: [
        item({ id: 'i1', foodName: 'Ovo', quantityGrams: 100, calories: 143 }),
        item({ id: 'i2', foodName: 'Queijo', quantityGrams: 30, calories: 69, proteinG: 6, fatG: 5 }),
      ],
    }

    await setRecentMealState(USER_ID, meal)

    expect(mockClearState).not.toHaveBeenCalled()
    expect(mockSetState).toHaveBeenCalledWith(USER_ID, 'recent_meal', {
      mealId: 'm1',
      mealType: 'breakfast',
      items: [
        { id: 'i1', foodName: 'Ovo', quantityGrams: 100, quantityDisplay: null, calories: 143, proteinG: 13, carbsG: 1, fatG: 10 },
        { id: 'i2', foodName: 'Queijo', quantityGrams: 30, quantityDisplay: null, calories: 69, proteinG: 6, carbsG: 1, fatG: 5 },
      ],
    })
  })

  it('clears the context when the meal has no items', async () => {
    const meal: LogFoodResult['meal'] = {
      id: 'm3',
      mealType: 'dinner',
      totalCalories: 0,
      registeredAt: '2026-04-23T18:00:00Z',
      items: [],
    }

    await setRecentMealState(USER_ID, meal)

    expect(mockClearState).toHaveBeenCalledWith(USER_ID)
    expect(mockSetState).not.toHaveBeenCalled()
  })
})
