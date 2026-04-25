import { describe, expect, it, vi } from 'vitest'

const recipeRow = {
  id: 'recipe-1',
  user_id: 'user-1',
  name: 'Bolo de banana',
  total_weight_grams: '600',
  servings: 6,
  weight_per_serving_grams: '100',
  total_calories: '840',
  total_protein_g: '18',
  total_carbs_g: '150',
  total_fat_g: '24',
  per_serving_calories: '140',
  per_serving_protein_g: '3',
  per_serving_carbs_g: '25',
  per_serving_fat_g: '4',
  notes: 'sem açúcar',
  created_at: '2026-04-25T12:00:00Z',
  updated_at: '2026-04-25T12:05:00Z',
}

const ingredientRow = {
  id: 'ingredient-1',
  recipe_id: 'recipe-1',
  food_name: 'Banana',
  quantity_grams: '200',
  calories: '196',
  protein_g: '2.6',
  carbs_g: '52',
  fat_g: '0.2',
  source: 'user_label',
  taco_id: null,
  taco_food_base: null,
  taco_food_variant: null,
  label_override: {
    kcal_per_100g: 98,
    protein_per_100g: 1.3,
    carbs_per_100g: 26,
    fat_per_100g: 0.1,
    fiber_per_100g: null,
    sodium_per_100g: null,
  },
  display_order: 0,
}

const createInput = {
  userId: 'user-1',
  name: 'Bolo de banana',
  totalWeightGrams: 600,
  servings: 6,
  notes: 'sem açúcar',
  ingredients: [
    {
      foodName: 'Banana',
      quantityGrams: 200,
      source: 'user_label' as const,
      labelOverride: {
        kcalPer100g: 98,
        proteinPer100g: 1.3,
        carbsPer100g: 26,
        fatPer100g: 0.1,
      },
      displayOrder: 0,
    },
    {
      foodName: 'Aveia',
      quantityGrams: 100,
      source: 'taco' as const,
      tacoId: 123,
      tacoFoodBase: 'Aveia',
      tacoFoodVariant: 'flocos',
      displayOrder: 1,
    },
  ],
  precomputedMacros: {
    weightPerServingGrams: 100,
    totalCalories: 585,
    totalProteinG: 19.5,
    totalCarbsG: 118,
    totalFatG: 7.2,
    perServingCalories: 97.5,
    perServingProteinG: 3.3,
    perServingCarbsG: 19.7,
    perServingFatG: 1.2,
    ingredientMacros: [
      { calories: 196, proteinG: 2.6, carbsG: 52, fatG: 0.2 },
      { calories: 389, proteinG: 16.9, carbsG: 66, fatG: 7 },
    ],
  },
}

describe('recipes query helpers', () => {
  it('createRecipe inserts user_recipes then recipe_ingredients with computed macros', async () => {
    const { createRecipe } = await import('@/lib/db/queries/recipes')

    const recipeChain: Record<string, unknown> = {}
    recipeChain.insert = vi.fn(() => recipeChain)
    recipeChain.select = vi.fn(() => recipeChain)
    recipeChain.single = vi.fn(() => Promise.resolve({ data: { id: 'recipe-1' }, error: null }))

    const ingredientsChain = {
      insert: vi.fn(() => Promise.resolve({ data: null, error: null })),
    }

    const supabase = {
      from: vi.fn((table: string) => {
        if (table === 'user_recipes') return recipeChain
        if (table === 'recipe_ingredients') return ingredientsChain
        throw new Error(`unexpected table: ${table}`)
      }),
    }

    const result = await createRecipe(supabase as never, createInput)

    expect(result).toBe('recipe-1')
    expect(supabase.from).toHaveBeenNthCalledWith(1, 'user_recipes')
    expect(recipeChain.insert).toHaveBeenCalledWith({
      user_id: 'user-1',
      name: 'Bolo de banana',
      total_weight_grams: 600,
      servings: 6,
      weight_per_serving_grams: 100,
      total_calories: 585,
      total_protein_g: 19.5,
      total_carbs_g: 118,
      total_fat_g: 7.2,
      per_serving_calories: 97.5,
      per_serving_protein_g: 3.3,
      per_serving_carbs_g: 19.7,
      per_serving_fat_g: 1.2,
      notes: 'sem açúcar',
    })
    expect(recipeChain.select).toHaveBeenCalledWith('id')
    expect(recipeChain.single).toHaveBeenCalled()
    expect(supabase.from).toHaveBeenNthCalledWith(2, 'recipe_ingredients')
    expect(ingredientsChain.insert).toHaveBeenCalledWith([
      {
        recipe_id: 'recipe-1',
        food_name: 'Banana',
        quantity_grams: 200,
        calories: 196,
        protein_g: 2.6,
        carbs_g: 52,
        fat_g: 0.2,
        source: 'user_label',
        taco_id: null,
        taco_food_base: null,
        taco_food_variant: null,
        label_override: {
          kcal_per_100g: 98,
          protein_per_100g: 1.3,
          carbs_per_100g: 26,
          fat_per_100g: 0.1,
          fiber_per_100g: null,
          sodium_per_100g: null,
        },
        display_order: 0,
      },
      {
        recipe_id: 'recipe-1',
        food_name: 'Aveia',
        quantity_grams: 100,
        calories: 389,
        protein_g: 16.9,
        carbs_g: 66,
        fat_g: 7,
        source: 'taco',
        taco_id: 123,
        taco_food_base: 'Aveia',
        taco_food_variant: 'flocos',
        label_override: null,
        display_order: 1,
      },
    ])
  })

  it('createRecipe throws when recipe insert fails', async () => {
    const { createRecipe } = await import('@/lib/db/queries/recipes')

    const recipeChain: Record<string, unknown> = {}
    recipeChain.insert = vi.fn(() => recipeChain)
    recipeChain.select = vi.fn(() => recipeChain)
    recipeChain.single = vi.fn(() =>
      Promise.resolve({ data: null, error: { message: 'duplicate name' } })
    )

    const supabase = {
      from: vi.fn(() => recipeChain),
    }

    await expect(createRecipe(supabase as never, createInput)).rejects.toThrow(
      'Failed to create recipe: duplicate name'
    )
  })

  it('getRecipesByUser maps snake_case DB rows to camelCase recipes and orders by created_at descending', async () => {
    const { getRecipesByUser } = await import('@/lib/db/queries/recipes')

    const chain: Record<string, unknown> = {}
    chain.select = vi.fn(() => chain)
    chain.eq = vi.fn(() => chain)
    chain.order = vi.fn(() => Promise.resolve({ data: [recipeRow], error: null }))
    const supabase = { from: vi.fn(() => chain) }

    const result = await getRecipesByUser(supabase as never, 'user-1')

    expect(supabase.from).toHaveBeenCalledWith('user_recipes')
    expect(chain.select).toHaveBeenCalledWith('*')
    expect(chain.eq).toHaveBeenCalledWith('user_id', 'user-1')
    expect(chain.order).toHaveBeenCalledWith('created_at', { ascending: false })
    expect(result).toEqual([
      {
        id: 'recipe-1',
        userId: 'user-1',
        name: 'Bolo de banana',
        totalWeightGrams: 600,
        servings: 6,
        weightPerServingGrams: 100,
        totalCalories: 840,
        totalProteinG: 18,
        totalCarbsG: 150,
        totalFatG: 24,
        perServingCalories: 140,
        perServingProteinG: 3,
        perServingCarbsG: 25,
        perServingFatG: 4,
        notes: 'sem açúcar',
        createdAt: '2026-04-25T12:00:00Z',
        updatedAt: '2026-04-25T12:05:00Z',
      },
    ])
  })

  it('deleteRecipe deletes by id and user_id', async () => {
    const { deleteRecipe } = await import('@/lib/db/queries/recipes')

    const chain: Record<string, unknown> = {}
    chain.delete = vi.fn(() => chain)
    chain.eq = vi
      .fn()
      .mockReturnValueOnce(chain)
      .mockResolvedValueOnce({ data: null, error: null })
    const supabase = { from: vi.fn(() => chain) }

    await deleteRecipe(supabase as never, 'recipe-1', 'user-1')

    expect(supabase.from).toHaveBeenCalledWith('user_recipes')
    expect(chain.delete).toHaveBeenCalled()
    expect(chain.eq).toHaveBeenNthCalledWith(1, 'id', 'recipe-1')
    expect(chain.eq).toHaveBeenNthCalledWith(2, 'user_id', 'user-1')
  })

  it('updateRecipe throws and does not clear ingredients when no owner recipe is updated', async () => {
    const { updateRecipe } = await import('@/lib/db/queries/recipes')

    const updateChain: Record<string, unknown> = {}
    updateChain.update = vi.fn(() => updateChain)
    updateChain.eq = vi.fn(() => updateChain)
    updateChain.select = vi.fn(() => updateChain)
    updateChain.single = vi.fn(() =>
      Promise.resolve({ data: null, error: { message: 'No rows returned' } })
    )

    const deleteChain: Record<string, unknown> = {}
    deleteChain.delete = vi.fn(() => deleteChain)
    deleteChain.eq = vi.fn(() => Promise.resolve({ data: null, error: null }))

    const insertChain = {
      insert: vi.fn(() => Promise.resolve({ data: null, error: null })),
    }

    let ingredientTableCalls = 0
    const supabase = {
      from: vi.fn((table: string) => {
        if (table === 'user_recipes') return updateChain
        if (table === 'recipe_ingredients') {
          ingredientTableCalls++
          return ingredientTableCalls === 1 ? deleteChain : insertChain
        }
        throw new Error(`unexpected table: ${table}`)
      }),
    }

    await expect(updateRecipe(supabase as never, 'recipe-1', 'other-user', createInput))
      .rejects.toThrow('Failed to update recipe: No rows returned')

    expect(updateChain.select).toHaveBeenCalledWith('id')
    expect(updateChain.single).toHaveBeenCalled()
    expect(deleteChain.delete).not.toHaveBeenCalled()
    expect(insertChain.insert).not.toHaveBeenCalled()
  })

  it('getRecipeWithIngredients returns recipe joined with ingredients', async () => {
    const { getRecipeWithIngredients } = await import('@/lib/db/queries/recipes')

    const recipeChain: Record<string, unknown> = {}
    recipeChain.select = vi.fn(() => recipeChain)
    recipeChain.eq = vi.fn(() => recipeChain)
    recipeChain.single = vi.fn(() => Promise.resolve({ data: recipeRow, error: null }))

    const ingredientsChain: Record<string, unknown> = {}
    ingredientsChain.select = vi.fn(() => ingredientsChain)
    ingredientsChain.eq = vi.fn(() => ingredientsChain)
    ingredientsChain.order = vi.fn(() =>
      Promise.resolve({
        data: [
          ingredientRow,
          {
            ...ingredientRow,
            id: 'ingredient-2',
            source: 'taco',
            taco_id: 123,
            taco_food_base: 'Aveia',
            taco_food_variant: 'flocos',
            label_override: {
              kcalPer100g: 389,
              proteinPer100g: 16.9,
              carbsPer100g: 66,
              fatPer100g: 7,
              fiberPer100g: 10.6,
            },
            display_order: 1,
          },
        ],
        error: null,
      })
    )

    const supabase = {
      from: vi.fn((table: string) => {
        if (table === 'user_recipes') return recipeChain
        if (table === 'recipe_ingredients') return ingredientsChain
        throw new Error(`unexpected table: ${table}`)
      }),
    }

    const result = await getRecipeWithIngredients(supabase as never, 'recipe-1', 'user-1')

    expect(recipeChain.eq).toHaveBeenNthCalledWith(1, 'id', 'recipe-1')
    expect(recipeChain.eq).toHaveBeenNthCalledWith(2, 'user_id', 'user-1')
    expect(ingredientsChain.eq).toHaveBeenCalledWith('recipe_id', 'recipe-1')
    expect(ingredientsChain.order).toHaveBeenCalledWith('display_order', { ascending: true })
    expect(result.ingredients).toEqual([
      {
        id: 'ingredient-1',
        recipeId: 'recipe-1',
        foodName: 'Banana',
        quantityGrams: 200,
        calories: 196,
        proteinG: 2.6,
        carbsG: 52,
        fatG: 0.2,
        source: 'user_label',
        tacoId: undefined,
        tacoFoodBase: undefined,
        tacoFoodVariant: undefined,
        labelOverride: {
          kcalPer100g: 98,
          proteinPer100g: 1.3,
          carbsPer100g: 26,
          fatPer100g: 0.1,
          fiberPer100g: undefined,
          sodiumPer100g: undefined,
        },
        displayOrder: 0,
      },
      {
        id: 'ingredient-2',
        recipeId: 'recipe-1',
        foodName: 'Banana',
        quantityGrams: 200,
        calories: 196,
        proteinG: 2.6,
        carbsG: 52,
        fatG: 0.2,
        source: 'taco',
        tacoId: 123,
        tacoFoodBase: 'Aveia',
        tacoFoodVariant: 'flocos',
        labelOverride: {
          kcalPer100g: 389,
          proteinPer100g: 16.9,
          carbsPer100g: 66,
          fatPer100g: 7,
          fiberPer100g: 10.6,
          sodiumPer100g: undefined,
        },
        displayOrder: 1,
      },
    ])
    expect(result.name).toBe('Bolo de banana')
    expect(result.createdAt).toBe('2026-04-25T12:00:00Z')
  })
})
