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
  confidence?: string
  quantityDisplay?: string
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
      confidence: item.confidence ?? 'high',
      quantity_display: item.quantityDisplay ?? null,
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

// ---------------------------------------------------------------------------
// MealWithItems (for correction flow)
// ---------------------------------------------------------------------------

export interface MealItemDetail {
  id: string
  foodName: string
  quantityGrams: number
  quantityDisplay: string | null
  calories: number
  proteinG: number
  carbsG: number
  fatG: number
  source: string
  confidence: string
}

export interface MealWithItems {
  id: string
  mealType: string
  totalCalories: number
  registeredAt: string
  items: MealItemDetail[]
}

export async function getMealWithItems(
  supabase: SupabaseClient,
  mealId: string,
): Promise<MealWithItems | null> {
  const { data: mealRow, error: mealError } = await supabase
    .from('meals')
    .select('id, meal_type, total_calories, registered_at')
    .eq('id', mealId)
    .single()

  if (mealError) {
    if (mealError.code === 'PGRST116') return null
    throw new Error(`Failed to get meal: ${mealError.message}`)
  }

  const meal = mealRow as Record<string, unknown>

  const { data: itemRows, error: itemsError } = await supabase
    .from('meal_items')
    .select('id, food_name, quantity_grams, quantity_display, calories, protein_g, carbs_g, fat_g, source, confidence')
    .eq('meal_id', mealId)

  if (itemsError) {
    throw new Error(`Failed to get meal items: ${itemsError.message}`)
  }

  const items = (itemRows as Array<Record<string, unknown>> || []).map((row) => ({
    id: row.id as string,
    foodName: row.food_name as string,
    quantityGrams: row.quantity_grams as number,
    quantityDisplay: (row.quantity_display as string) ?? null,
    calories: row.calories as number,
    proteinG: row.protein_g as number,
    carbsG: row.carbs_g as number,
    fatG: row.fat_g as number,
    source: row.source as string,
    confidence: (row.confidence as string) ?? 'high',
  }))

  return {
    id: meal.id as string,
    mealType: meal.meal_type as string,
    totalCalories: meal.total_calories as number,
    registeredAt: meal.registered_at as string,
    items,
  }
}

export async function updateMealItem(
  supabase: SupabaseClient,
  itemId: string,
  update: {
    quantityGrams: number
    quantityDisplay?: string
    calories: number
    proteinG: number
    carbsG: number
    fatG: number
  },
): Promise<void> {
  const row: Record<string, unknown> = {
    quantity_grams: update.quantityGrams,
    calories: update.calories,
    protein_g: update.proteinG,
    carbs_g: update.carbsG,
    fat_g: update.fatG,
  }
  if (update.quantityDisplay !== undefined) {
    row.quantity_display = update.quantityDisplay
  }

  const { error } = await supabase
    .from('meal_items')
    .update(row)
    .eq('id', itemId)

  if (error) throw new Error(`Failed to update meal item: ${error.message}`)
}

export async function removeMealItem(
  supabase: SupabaseClient,
  itemId: string,
): Promise<void> {
  const { error } = await supabase
    .from('meal_items')
    .delete()
    .eq('id', itemId)

  if (error) throw new Error(`Failed to remove meal item: ${error.message}`)
}

export async function recalculateMealTotal(
  supabase: SupabaseClient,
  mealId: string,
): Promise<number> {
  const { data, error } = await supabase
    .from('meal_items')
    .select('calories')
    .eq('meal_id', mealId)

  if (error) throw new Error(`Failed to sum meal items: ${error.message}`)

  const total = Math.round(
    (data as Array<Record<string, unknown>> || []).reduce(
      (sum, row) => sum + (row.calories as number || 0),
      0,
    ),
  )

  const { error: updateError } = await supabase
    .from('meals')
    .update({ total_calories: total })
    .eq('id', mealId)

  if (updateError) throw new Error(`Failed to update meal total: ${updateError.message}`)

  return total
}

// ---------------------------------------------------------------------------
// MealDetailItem / MealDetail (for meal_detail query)
// ---------------------------------------------------------------------------

export interface MealDetailItem {
  foodName: string
  quantityGrams: number
  quantityDisplay: string | null
  calories: number
}

export interface MealDetail {
  mealType: string
  registeredAt: string
  items: MealDetailItem[]
  totalCalories: number
}

// ---------------------------------------------------------------------------
// getMealDetailByType
// ---------------------------------------------------------------------------

/**
 * Returns meals with their items for a user on a specific date,
 * optionally filtered by meal type. Used by the meal_detail query flow.
 */
export async function getMealDetailByType(
  supabase: SupabaseClient,
  userId: string,
  mealType: string | null,
  date: Date,
  timezone: string = 'America/Sao_Paulo',
): Promise<MealDetail[]> {
  const { startOfDay, endOfDay } = getDayBoundsForTimezone(date, timezone)

  let query = supabase
    .from('meals')
    .select('id, meal_type, total_calories, registered_at, meal_items(food_name, quantity_grams, quantity_display, calories)')
    .eq('user_id', userId)
    .gte('registered_at', startOfDay.toISOString())
    .lte('registered_at', endOfDay.toISOString())
    .order('registered_at', { ascending: true })

  if (mealType) {
    query = query.eq('meal_type', mealType)
  }

  const { data, error } = await query

  if (error) {
    throw new Error(`Failed to get meal details: ${error.message}`)
  }

  if (!data || data.length === 0) return []

  return (data as Array<Record<string, unknown>>).map((row) => {
    const items = (row.meal_items as Array<Record<string, unknown>> || []).map((item) => ({
      foodName: item.food_name as string,
      quantityGrams: item.quantity_grams as number,
      quantityDisplay: (item.quantity_display as string) ?? null,
      calories: item.calories as number,
    }))

    return {
      mealType: row.meal_type as string,
      registeredAt: row.registered_at as string,
      items,
      totalCalories: row.total_calories as number,
    }
  })
}
