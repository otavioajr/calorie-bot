import type { TacoFood } from '@/lib/db/queries/taco'
import type { ComputedRecipeMacros, IngredientSource, LabelOverride } from './types'

export interface ComputeIngredient {
  foodName: string
  quantityGrams: number
  source: IngredientSource
  tacoFood?: TacoFood
  labelOverride?: LabelOverride
  displayOrder: number
}

export interface ComputeRecipeInput {
  ingredients: ComputeIngredient[]
  totalWeightGrams: number
  servings: number
}

function macrosPer100g(ing: ComputeIngredient): {
  kcal: number
  protein: number
  carbs: number
  fat: number
} {
  if (ing.source === 'user_label') {
    if (!ing.labelOverride) {
      throw new Error(`label_override required for user_label ingredient: ${ing.foodName}`)
    }
    return {
      kcal: ing.labelOverride.kcalPer100g,
      protein: ing.labelOverride.proteinPer100g,
      carbs: ing.labelOverride.carbsPer100g,
      fat: ing.labelOverride.fatPer100g,
    }
  }

  if (!ing.tacoFood) {
    throw new Error(`tacoFood required for taco ingredient: ${ing.foodName}`)
  }

  return {
    kcal: ing.tacoFood.caloriesPer100g,
    protein: ing.tacoFood.proteinPer100g,
    carbs: ing.tacoFood.carbsPer100g,
    fat: ing.tacoFood.fatPer100g,
  }
}

export function computeRecipeMacros(input: ComputeRecipeInput): ComputedRecipeMacros {
  const ingredientMacros = input.ingredients.map((ing) => {
    const per100 = macrosPer100g(ing)
    const factor = ing.quantityGrams / 100
    return {
      calories: round1(per100.kcal * factor),
      proteinG: round1(per100.protein * factor),
      carbsG: round1(per100.carbs * factor),
      fatG: round1(per100.fat * factor),
    }
  })

  const totalCalories = round1(sum(ingredientMacros.map((m) => m.calories)))
  const totalProteinG = round1(sum(ingredientMacros.map((m) => m.proteinG)))
  const totalCarbsG = round1(sum(ingredientMacros.map((m) => m.carbsG)))
  const totalFatG = round1(sum(ingredientMacros.map((m) => m.fatG)))

  const weightPerServingGrams = round1(input.totalWeightGrams / input.servings)
  const perServingCalories = round1(totalCalories / input.servings)
  const perServingProteinG = round1(totalProteinG / input.servings)
  const perServingCarbsG = round1(totalCarbsG / input.servings)
  const perServingFatG = round1(totalFatG / input.servings)

  return {
    weightPerServingGrams,
    totalCalories,
    totalProteinG,
    totalCarbsG,
    totalFatG,
    perServingCalories,
    perServingProteinG,
    perServingCarbsG,
    perServingFatG,
    ingredientMacros,
  }
}

function round1(n: number): number {
  return Math.round(n * 10) / 10
}

function sum(xs: number[]): number {
  return xs.reduce((a, b) => a + b, 0)
}
