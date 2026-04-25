export type IngredientSource = 'taco' | 'user_label'

export interface LabelOverride {
  kcalPer100g: number
  proteinPer100g: number
  carbsPer100g: number
  fatPer100g: number
  fiberPer100g?: number
  sodiumPer100g?: number
}

export interface RecipeIngredientInput {
  foodName: string
  quantityGrams: number
  source: IngredientSource
  tacoId?: number
  tacoFoodBase?: string
  tacoFoodVariant?: string
  labelOverride?: LabelOverride
  displayOrder: number
}

export interface RecipeIngredient extends RecipeIngredientInput {
  id: string
  recipeId: string
  calories: number
  proteinG: number
  carbsG: number
  fatG: number
}

export interface CreateRecipeInput {
  userId: string
  name: string
  totalWeightGrams: number
  servings: number
  notes?: string
  ingredients: RecipeIngredientInput[]
}

export interface Recipe {
  id: string
  userId: string
  name: string
  totalWeightGrams: number
  servings: number
  weightPerServingGrams: number
  totalCalories: number
  totalProteinG: number
  totalCarbsG: number
  totalFatG: number
  perServingCalories: number
  perServingProteinG: number
  perServingCarbsG: number
  perServingFatG: number
  notes: string | null
  createdAt: string
  updatedAt: string
}

export interface RecipeWithIngredients extends Recipe {
  ingredients: RecipeIngredient[]
}

export interface ComputedIngredientMacros {
  calories: number
  proteinG: number
  carbsG: number
  fatG: number
}

export interface ComputedRecipeMacros {
  weightPerServingGrams: number
  totalCalories: number
  totalProteinG: number
  totalCarbsG: number
  totalFatG: number
  perServingCalories: number
  perServingProteinG: number
  perServingCarbsG: number
  perServingFatG: number
  ingredientMacros: ComputedIngredientMacros[]
}
