import { SupabaseClient } from '@supabase/supabase-js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface MealItemInput {
  foodName: string
  quantityGrams: number
  calories: number
  proteinG: number
  carbsG: number
  fatG: number
  source: string
  tacoId?: number
}

export interface CreateMealInput {
  userId: string
  mealType: string
  totalCalories: number
  originalMessage: string
  llmResponse: unknown
  items: MealItemInput[]
}

export interface RecentMeal {
  id: string
  mealType: string
  totalCalories: number
  registeredAt: string
}

// ---------------------------------------------------------------------------
// createMeal
// ---------------------------------------------------------------------------

/**
 * Insert a meal and all its items into the database.
 * Returns the ID of the created meal.
 */
export async function createMeal(
  supabase: SupabaseClient,
  data: CreateMealInput,
): Promise<string> {
  const { data: mealRow, error: mealError } = await supabase
    .from('meals')
    .insert({
      user_id: data.userId,
      meal_type: data.mealType,
      total_calories: data.totalCalories,
      original_message: data.originalMessage,
      llm_response: data.llmResponse,
    })
    .select('id')
    .single()

  if (mealError || !mealRow) {
    throw new Error(`Failed to create meal: ${mealError?.message ?? 'no data returned'}`)
  }

  const mealId = (mealRow as Record<string, unknown>).id as string

  if (data.items.length > 0) {
    const itemRows = data.items.map((item) => ({
      meal_id: mealId,
      food_name: item.foodName,
      quantity_grams: item.quantityGrams,
      calories: item.calories,
      protein_g: item.proteinG,
      carbs_g: item.carbsG,
      fat_g: item.fatG,
      source: item.source,
      taco_id: item.tacoId ?? null,
    }))

    const { error: itemsError } = await supabase.from('meal_items').insert(itemRows)

    if (itemsError) {
      throw new Error(`Failed to create meal items: ${itemsError.message}`)
    }
  }

  return mealId
}

// ---------------------------------------------------------------------------
// getDailyCalories
// ---------------------------------------------------------------------------

/**
 * Returns the total calories consumed by a user on the given date (defaults to today).
 */
export async function getDailyCalories(
  supabase: SupabaseClient,
  userId: string,
  date?: Date,
): Promise<number> {
  const targetDate = date ?? new Date()

  // Build date range for the full day in UTC
  const startOfDay = new Date(targetDate)
  startOfDay.setUTCHours(0, 0, 0, 0)

  const endOfDay = new Date(targetDate)
  endOfDay.setUTCHours(23, 59, 59, 999)

  const { data, error } = await supabase
    .from('meals')
    .select('total_calories')
    .eq('user_id', userId)
    .gte('registered_at', startOfDay.toISOString())
    .lte('registered_at', endOfDay.toISOString())

  if (error) {
    throw new Error(`Failed to get daily calories: ${error.message}`)
  }

  if (!data || data.length === 0) {
    return 0
  }

  return (data as Array<Record<string, unknown>>).reduce(
    (sum, row) => sum + (row.total_calories as number),
    0,
  )
}

// ---------------------------------------------------------------------------
// deleteMeal
// ---------------------------------------------------------------------------

/**
 * Deletes a meal by ID.
 */
export async function deleteMeal(
  supabase: SupabaseClient,
  mealId: string,
): Promise<void> {
  const { error } = await supabase.from('meals').delete().eq('id', mealId)

  if (error) {
    throw new Error(`Failed to delete meal: ${error.message}`)
  }
}

// ---------------------------------------------------------------------------
// getLastMeal
// ---------------------------------------------------------------------------

export interface LastMeal {
  id: string
  mealType: string
  totalCalories: number
  registeredAt: string
}

/**
 * Returns the most recent meal for a user, or null if none exist.
 */
export async function getLastMeal(
  supabase: SupabaseClient,
  userId: string,
): Promise<LastMeal | null> {
  const { data, error } = await supabase
    .from('meals')
    .select('id, meal_type, total_calories, registered_at')
    .eq('user_id', userId)
    .order('registered_at', { ascending: false })
    .limit(1)
    .single()

  if (error) {
    if (error.code === 'PGRST116') return null
    throw new Error(`Failed to get last meal: ${error.message}`)
  }

  if (!data) return null

  const row = data as Record<string, unknown>
  return {
    id: row.id as string,
    mealType: row.meal_type as string,
    totalCalories: row.total_calories as number,
    registeredAt: row.registered_at as string,
  }
}

// ---------------------------------------------------------------------------
// DailyMeal
// ---------------------------------------------------------------------------

export interface DailyMeal {
  mealType: string
  totalCalories: number
}

// ---------------------------------------------------------------------------
// getDailyMeals
// ---------------------------------------------------------------------------

/**
 * Returns all meals for a user on a specific date (defaults to today).
 * Useful for building daily summaries grouped by meal type.
 */
export async function getDailyMeals(
  supabase: SupabaseClient,
  userId: string,
  date?: Date,
): Promise<DailyMeal[]> {
  const targetDate = date ?? new Date()

  const startOfDay = new Date(targetDate)
  startOfDay.setUTCHours(0, 0, 0, 0)

  const endOfDay = new Date(targetDate)
  endOfDay.setUTCHours(23, 59, 59, 999)

  const { data, error } = await supabase
    .from('meals')
    .select('meal_type, total_calories')
    .eq('user_id', userId)
    .gte('registered_at', startOfDay.toISOString())
    .lte('registered_at', endOfDay.toISOString())

  if (error) {
    throw new Error(`Failed to get daily meals: ${error.message}`)
  }

  if (!data) return []

  return (data as Array<Record<string, unknown>>).map((row) => ({
    mealType: row.meal_type as string,
    totalCalories: row.total_calories as number,
  }))
}

// ---------------------------------------------------------------------------
// getRecentMeals
// ---------------------------------------------------------------------------

/**
 * Returns the most recent meals for a user, up to the given limit.
 */
export async function getRecentMeals(
  supabase: SupabaseClient,
  userId: string,
  limit: number,
): Promise<RecentMeal[]> {
  const { data, error } = await supabase
    .from('meals')
    .select('id, meal_type, total_calories, registered_at')
    .eq('user_id', userId)
    .order('registered_at', { ascending: false })
    .limit(limit)

  if (error) {
    throw new Error(`Failed to get recent meals: ${error.message}`)
  }

  if (!data) return []

  return (data as Array<Record<string, unknown>>).map((row) => ({
    id: row.id as string,
    mealType: row.meal_type as string,
    totalCalories: row.total_calories as number,
    registeredAt: row.registered_at as string,
  }))
}
