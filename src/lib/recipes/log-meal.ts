import type { SupabaseClient } from '@supabase/supabase-js'
import { createMeal } from '@/lib/db/queries/meals'
import { getRecipeWithIngredients } from '@/lib/db/queries/recipes'

export interface LogMealFromRecipeInput {
  userId: string
  recipeId: string
  mealType: string
  portionsConsumed: number
  sourceMessage: string
}

export async function logMealFromRecipe(
  supabase: SupabaseClient,
  input: LogMealFromRecipeInput,
): Promise<string> {
  if (input.portionsConsumed <= 0) {
    throw new Error('portions consumed must be greater than zero')
  }

  const recipe = await getRecipeWithIngredients(supabase, input.recipeId, input.userId)
  const portions = input.portionsConsumed
  const totalCalories = round1(recipe.perServingCalories * portions)
  const totalProtein = round1(recipe.perServingProteinG * portions)
  const totalCarbs = round1(recipe.perServingCarbsG * portions)
  const totalFat = round1(recipe.perServingFatG * portions)
  const totalGrams = round1(recipe.weightPerServingGrams * portions)

  return createMeal(supabase, {
    userId: input.userId,
    mealType: input.mealType,
    totalCalories,
    originalMessage: input.sourceMessage,
    llmResponse: {
      source: 'recipe',
      recipe_id: recipe.id,
      recipe_name: recipe.name,
      portions,
    },
    items: [
      {
        foodName: recipe.name,
        quantityGrams: totalGrams,
        calories: totalCalories,
        proteinG: totalProtein,
        carbsG: totalCarbs,
        fatG: totalFat,
        source: 'recipe',
        confidence: 'high',
      },
    ],
  })
}

function round1(value: number): number {
  return Math.round(value * 10) / 10
}
