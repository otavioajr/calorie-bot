import { SupabaseClient } from '@supabase/supabase-js'
import type {
  ComputedRecipeMacros,
  CreateRecipeInput,
  LabelOverride,
  Recipe,
  RecipeIngredient,
  RecipeIngredientInput,
  RecipeWithIngredients,
} from '@/lib/recipes/types'
import { isRecipeNotFoundOrNotOwnedError } from '@/lib/recipes/errors'

type JsonLabelOverride = {
  kcal_per_100g?: number | string | null
  kcalPer100g?: number | string | null
  protein_per_100g?: number | string | null
  proteinPer100g?: number | string | null
  carbs_per_100g?: number | string | null
  carbsPer100g?: number | string | null
  fat_per_100g?: number | string | null
  fatPer100g?: number | string | null
  fiber_per_100g?: number | string | null
  fiberPer100g?: number | string | null
  sodium_per_100g?: number | string | null
  sodiumPer100g?: number | string | null
}

interface DbRecipeRow {
  id: string
  user_id: string
  name: string
  total_weight_grams: number | string
  servings: number | string
  weight_per_serving_grams: number | string
  total_calories: number | string
  total_protein_g: number | string
  total_carbs_g: number | string
  total_fat_g: number | string
  per_serving_calories: number | string
  per_serving_protein_g: number | string
  per_serving_carbs_g: number | string
  per_serving_fat_g: number | string
  notes: string | null
  created_at: string
  updated_at: string
}

interface DbIngredientRow {
  id: string
  recipe_id: string
  food_name: string
  quantity_grams: number | string
  calories: number | string
  protein_g: number | string
  carbs_g: number | string
  fat_g: number | string
  source: 'taco' | 'user_label'
  taco_id: number | null
  taco_food_base: string | null
  taco_food_variant: string | null
  label_override: JsonLabelOverride | null
  display_order: number
}

export interface CreateRecipeWithMacrosInput extends CreateRecipeInput {
  precomputedMacros: ComputedRecipeMacros
}

export type UpdateRecipeWithMacrosInput = Omit<CreateRecipeWithMacrosInput, 'userId'>

function rowToRecipe(row: DbRecipeRow): Recipe {
  return {
    id: row.id,
    userId: row.user_id,
    name: row.name,
    totalWeightGrams: Number(row.total_weight_grams),
    servings: Number(row.servings),
    weightPerServingGrams: Number(row.weight_per_serving_grams),
    totalCalories: Number(row.total_calories),
    totalProteinG: Number(row.total_protein_g),
    totalCarbsG: Number(row.total_carbs_g),
    totalFatG: Number(row.total_fat_g),
    perServingCalories: Number(row.per_serving_calories),
    perServingProteinG: Number(row.per_serving_protein_g),
    perServingCarbsG: Number(row.per_serving_carbs_g),
    perServingFatG: Number(row.per_serving_fat_g),
    notes: row.notes,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function numberOrUndefined(value: number | string | null | undefined): number | undefined {
  return value == null ? undefined : Number(value)
}

function readLabelNumber(
  label: JsonLabelOverride,
  snakeKey: keyof JsonLabelOverride,
  camelKey: keyof JsonLabelOverride,
): number {
  return Number(label[snakeKey] ?? label[camelKey])
}

function rowToIngredient(row: DbIngredientRow): RecipeIngredient {
  const labelOverride = row.label_override

  return {
    id: row.id,
    recipeId: row.recipe_id,
    foodName: row.food_name,
    quantityGrams: Number(row.quantity_grams),
    calories: Number(row.calories),
    proteinG: Number(row.protein_g),
    carbsG: Number(row.carbs_g),
    fatG: Number(row.fat_g),
    source: row.source,
    tacoId: row.taco_id ?? undefined,
    tacoFoodBase: row.taco_food_base ?? undefined,
    tacoFoodVariant: row.taco_food_variant ?? undefined,
    labelOverride: labelOverride
      ? {
          kcalPer100g: readLabelNumber(labelOverride, 'kcal_per_100g', 'kcalPer100g'),
          proteinPer100g: readLabelNumber(labelOverride, 'protein_per_100g', 'proteinPer100g'),
          carbsPer100g: readLabelNumber(labelOverride, 'carbs_per_100g', 'carbsPer100g'),
          fatPer100g: readLabelNumber(labelOverride, 'fat_per_100g', 'fatPer100g'),
          fiberPer100g: numberOrUndefined(
            labelOverride.fiber_per_100g ?? labelOverride.fiberPer100g,
          ),
          sodiumPer100g: numberOrUndefined(
            labelOverride.sodium_per_100g ?? labelOverride.sodiumPer100g,
          ),
        }
      : undefined,
    displayOrder: row.display_order,
  }
}

function serializeLabelOverride(labelOverride: LabelOverride | undefined): JsonLabelOverride | null {
  if (!labelOverride) return null

  return {
    kcal_per_100g: labelOverride.kcalPer100g,
    protein_per_100g: labelOverride.proteinPer100g,
    carbs_per_100g: labelOverride.carbsPer100g,
    fat_per_100g: labelOverride.fatPer100g,
    fiber_per_100g: labelOverride.fiberPer100g ?? null,
    sodium_per_100g: labelOverride.sodiumPer100g ?? null,
  }
}

function buildRecipeRow(input: UpdateRecipeWithMacrosInput) {
  return {
    name: input.name,
    total_weight_grams: input.totalWeightGrams,
    servings: input.servings,
    weight_per_serving_grams: input.precomputedMacros.weightPerServingGrams,
    total_calories: input.precomputedMacros.totalCalories,
    total_protein_g: input.precomputedMacros.totalProteinG,
    total_carbs_g: input.precomputedMacros.totalCarbsG,
    total_fat_g: input.precomputedMacros.totalFatG,
    per_serving_calories: input.precomputedMacros.perServingCalories,
    per_serving_protein_g: input.precomputedMacros.perServingProteinG,
    per_serving_carbs_g: input.precomputedMacros.perServingCarbsG,
    per_serving_fat_g: input.precomputedMacros.perServingFatG,
    notes: input.notes ?? null,
  }
}

function buildRecipeUpdateRow(input: UpdateRecipeWithMacrosInput) {
  return buildRecipeRow(input)
}

function buildIngredientRowsWithoutRecipeId(
  ingredients: RecipeIngredientInput[],
  macros: ComputedRecipeMacros,
) {
  return ingredients.map((ingredient, index) => {
    const ingredientMacros = macros.ingredientMacros[index]
    return {
      food_name: ingredient.foodName,
      quantity_grams: ingredient.quantityGrams,
      calories: ingredientMacros.calories,
      protein_g: ingredientMacros.proteinG,
      carbs_g: ingredientMacros.carbsG,
      fat_g: ingredientMacros.fatG,
      source: ingredient.source,
      taco_id: ingredient.tacoId ?? null,
      taco_food_base: ingredient.tacoFoodBase ?? null,
      taco_food_variant: ingredient.tacoFoodVariant ?? null,
      label_override: serializeLabelOverride(ingredient.labelOverride),
      display_order: ingredient.displayOrder,
    }
  })
}

export async function createRecipe(
  supabase: SupabaseClient,
  input: CreateRecipeWithMacrosInput,
): Promise<string> {
  const { data, error } = await supabase.rpc('create_user_recipe_with_ingredients', {
    p_user_id: input.userId,
    p_recipe: buildRecipeRow(input),
    p_ingredients: buildIngredientRowsWithoutRecipeId(
      input.ingredients,
      input.precomputedMacros,
    ),
  })

  if (error || !data) {
    throw new Error(`Failed to create recipe: ${error?.message ?? 'no row returned'}`)
  }

  return data as string
}

export async function getRecipesByUser(
  supabase: SupabaseClient,
  userId: string,
): Promise<Recipe[]> {
  const { data, error } = await supabase
    .from('user_recipes')
    .select('*')
    .eq('user_id', userId)
    .order('created_at', { ascending: false })

  if (error) {
    throw new Error(`Failed to load recipes: ${error.message}`)
  }

  return ((data ?? []) as DbRecipeRow[]).map(rowToRecipe)
}

export async function getRecipeWithIngredients(
  supabase: SupabaseClient,
  recipeId: string,
  userId: string,
): Promise<RecipeWithIngredients> {
  const { data: recipeRow, error: recipeError } = await supabase
    .from('user_recipes')
    .select('*')
    .eq('id', recipeId)
    .eq('user_id', userId)
    .single()

  if (recipeError || !recipeRow) {
    throw new Error(`Recipe not found: ${recipeError?.message ?? 'no row returned'}`)
  }

  const { data: ingredientRows, error: ingredientsError } = await supabase
    .from('recipe_ingredients')
    .select('*')
    .eq('recipe_id', recipeId)
    .order('display_order', { ascending: true })

  if (ingredientsError) {
    throw new Error(`Failed to load ingredients: ${ingredientsError.message}`)
  }

  return {
    ...rowToRecipe(recipeRow as DbRecipeRow),
    ingredients: ((ingredientRows ?? []) as DbIngredientRow[]).map(rowToIngredient),
  }
}

export async function updateRecipe(
  supabase: SupabaseClient,
  recipeId: string,
  userId: string,
  input: UpdateRecipeWithMacrosInput,
): Promise<void> {
  const { error } = await supabase.rpc('update_user_recipe_with_ingredients', {
    p_recipe_id: recipeId,
    p_user_id: userId,
    p_recipe: buildRecipeUpdateRow(input),
    p_ingredients: buildIngredientRowsWithoutRecipeId(
      input.ingredients,
      input.precomputedMacros,
    ),
  })

  if (error) {
    throw new Error(`Failed to update recipe: ${error.message}`)
  }
}

export async function deleteRecipe(
  supabase: SupabaseClient,
  recipeId: string,
  userId: string,
): Promise<void> {
  const { error } = await supabase
    .from('user_recipes')
    .delete()
    .eq('id', recipeId)
    .eq('user_id', userId)
    .select('id')
    .single()

  if (error?.code === 'PGRST116') {
    throw new Error('Recipe not found or not owned by user')
  }

  if (error) {
    if (isRecipeNotFoundOrNotOwnedError(error)) {
      throw new Error('Recipe not found or not owned by user')
    }
    throw new Error(`Failed to delete recipe: ${error.message}`)
  }
}
