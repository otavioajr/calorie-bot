import { describe, expect, it, vi, beforeEach } from 'vitest'
import { logMealFromRecipe } from '@/lib/recipes/log-meal'
import { createMeal } from '@/lib/db/queries/meals'
import { getRecipeWithIngredients } from '@/lib/db/queries/recipes'

vi.mock('@/lib/db/queries/meals', () => ({
  createMeal: vi.fn(),
}))

vi.mock('@/lib/db/queries/recipes', () => ({
  getRecipeWithIngredients: vi.fn(),
}))

const createMealMock = vi.mocked(createMeal)
const getRecipeWithIngredientsMock = vi.mocked(getRecipeWithIngredients)

describe('logMealFromRecipe', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('creates a meal with one aggregate recipe item scaled by portions consumed', async () => {
    const supabase = {} as never

    getRecipeWithIngredientsMock.mockResolvedValue({
      id: 'recipe-1',
      userId: 'user-1',
      name: 'Arroz com frango',
      totalWeightGrams: 600,
      servings: 4,
      weightPerServingGrams: 150.04,
      totalCalories: 987.6,
      totalProteinG: 120,
      totalCarbsG: 80,
      totalFatG: 20,
      perServingCalories: 246.73,
      perServingProteinG: 30.04,
      perServingCarbsG: 20.06,
      perServingFatG: 5.02,
      notes: null,
      createdAt: '2026-04-25T10:00:00.000Z',
      updatedAt: '2026-04-25T10:00:00.000Z',
      ingredients: [],
    })
    createMealMock.mockResolvedValue('meal-1')

    const result = await logMealFromRecipe(supabase, {
      userId: 'user-1',
      recipeId: 'recipe-1',
      mealType: 'almoco',
      portionsConsumed: 1.5,
      sourceMessage: 'comi 1,5 porcao do arroz com frango',
    })

    expect(result).toBe('meal-1')
    expect(getRecipeWithIngredientsMock).toHaveBeenCalledWith(supabase, 'recipe-1', 'user-1')
    expect(createMealMock).toHaveBeenCalledWith(supabase, {
      userId: 'user-1',
      mealType: 'almoco',
      totalCalories: 370.1,
      originalMessage: 'comi 1,5 porcao do arroz com frango',
      llmResponse: {
        source: 'recipe',
        recipe_id: 'recipe-1',
        recipe_name: 'Arroz com frango',
        portions: 1.5,
      },
      items: [
        {
          foodName: 'Arroz com frango',
          quantityGrams: 225.1,
          calories: 370.1,
          proteinG: 45.1,
          carbsG: 30.1,
          fatG: 7.5,
          source: 'recipe',
          confidence: 'high',
        },
      ],
    })
  })

  it('rejects non-positive portions consumed', async () => {
    await expect(
      logMealFromRecipe({} as never, {
        userId: 'user-1',
        recipeId: 'recipe-1',
        mealType: 'jantar',
        portionsConsumed: 0,
        sourceMessage: 'comi a receita',
      }),
    ).rejects.toThrow(/portions/i)

    expect(getRecipeWithIngredientsMock).not.toHaveBeenCalled()
    expect(createMealMock).not.toHaveBeenCalled()
  })
})
