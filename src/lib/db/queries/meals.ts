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
// getDayBoundsForTimezone (helper)
// ---------------------------------------------------------------------------

/**
 * Returns UTC start/end of the "local day" for the given date in the user's timezone.
 * E.g. for America/Sao_Paulo (UTC-3) on March 31:
 *   start = March 31 03:00 UTC, end = April 1 02:59:59.999 UTC
 */
function getDayBoundsForTimezone(
  date: Date,
  timezone: string,
): { startOfDay: Date; endOfDay: Date } {
  // Format the date in the user's timezone to get the local YYYY-MM-DD
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  })
  const localDateStr = formatter.format(date) // "2026-03-31"

  // Get the offset for the start of that day in the target timezone
  const utcMidnight = new Date(`${localDateStr}T00:00:00Z`)
  const offsetMs = getTimezoneOffsetMs(utcMidnight, timezone)

  const startOfDay = new Date(utcMidnight.getTime() - offsetMs)
  const endOfDay = new Date(startOfDay.getTime() + 24 * 60 * 60 * 1000 - 1)

  return { startOfDay, endOfDay }
}

/**
 * Get the UTC offset in milliseconds for a given timezone at a specific moment.
 */
function getTimezoneOffsetMs(date: Date, timezone: string): number {
  // Format the date in both UTC and the target timezone
  const utcParts = getDateParts(date, 'UTC')
  const tzParts = getDateParts(date, timezone)

  const utcDate = Date.UTC(utcParts.year, utcParts.month - 1, utcParts.day, utcParts.hour, utcParts.minute)
  const tzDate = Date.UTC(tzParts.year, tzParts.month - 1, tzParts.day, tzParts.hour, tzParts.minute)

  return tzDate - utcDate
}

function getDateParts(date: Date, timezone: string): { year: number; month: number; day: number; hour: number; minute: number } {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: 'numeric',
    hour12: false,
  })
  const parts = formatter.formatToParts(date)
  return {
    year: parseInt(parts.find(p => p.type === 'year')!.value),
    month: parseInt(parts.find(p => p.type === 'month')!.value),
    day: parseInt(parts.find(p => p.type === 'day')!.value),
    hour: parseInt(parts.find(p => p.type === 'hour')!.value),
    minute: parseInt(parts.find(p => p.type === 'minute')!.value),
  }
}

// ---------------------------------------------------------------------------
// getDailyCalories
// ---------------------------------------------------------------------------

/**
 * Returns the total calories consumed by a user on the given date (defaults to today).
 * Uses the user's timezone to determine day boundaries.
 */
export async function getDailyCalories(
  supabase: SupabaseClient,
  userId: string,
  date?: Date,
  timezone: string = 'America/Sao_Paulo',
): Promise<number> {
  const targetDate = date ?? new Date()

  const { startOfDay, endOfDay } = getDayBoundsForTimezone(targetDate, timezone)

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
// getDailyMacros
// ---------------------------------------------------------------------------

export interface DailyMacros {
  calories: number
  proteinG: number
  carbsG: number
  fatG: number
}

/**
 * Returns the total calories and macros consumed by a user on the given date.
 * Sums from meal_items via a join on meals.
 */
export async function getDailyMacros(
  supabase: SupabaseClient,
  userId: string,
  date?: Date,
  timezone: string = 'America/Sao_Paulo',
): Promise<DailyMacros> {
  const targetDate = date ?? new Date()

  const { startOfDay, endOfDay } = getDayBoundsForTimezone(targetDate, timezone)

  const { data, error } = await supabase
    .from('meal_items')
    .select('calories, protein_g, carbs_g, fat_g, meal:meals!inner(user_id, registered_at)')
    .eq('meal.user_id', userId)
    .gte('meal.registered_at', startOfDay.toISOString())
    .lte('meal.registered_at', endOfDay.toISOString())

  if (error) {
    throw new Error(`Failed to get daily macros: ${error.message}`)
  }

  if (!data || data.length === 0) {
    return { calories: 0, proteinG: 0, carbsG: 0, fatG: 0 }
  }

  const rows = data as Array<Record<string, unknown>>
  return {
    calories: Math.round(rows.reduce((sum, r) => sum + (r.calories as number || 0), 0)),
    proteinG: Math.round(rows.reduce((sum, r) => sum + (r.protein_g as number || 0), 0)),
    carbsG: Math.round(rows.reduce((sum, r) => sum + (r.carbs_g as number || 0), 0)),
    fatG: Math.round(rows.reduce((sum, r) => sum + (r.fat_g as number || 0), 0)),
  }
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
  timezone: string = 'America/Sao_Paulo',
): Promise<DailyMeal[]> {
  const targetDate = date ?? new Date()

  const { startOfDay, endOfDay } = getDayBoundsForTimezone(targetDate, timezone)

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
