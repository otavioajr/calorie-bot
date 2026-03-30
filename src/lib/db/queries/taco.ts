import { SupabaseClient } from '@supabase/supabase-js'

export const SIMILARITY_THRESHOLD = 0.4

export interface TacoFood {
  id: number
  foodName: string
  category: string | null
  caloriesPer100g: number
  proteinPer100g: number
  carbsPer100g: number
  fatPer100g: number
  fiberPer100g: number
  foodBase: string
  foodVariant: string
  isDefault: boolean
}

export interface CalculatedMacros {
  calories: number
  protein: number
  carbs: number
  fat: number
}

interface TacoRow {
  id: number
  food_name: string
  category?: string | null
  calories_per_100g: number
  protein_per_100g: number
  carbs_per_100g: number
  fat_per_100g: number
  fiber_per_100g: number
  food_base: string
  food_variant: string
  is_default: boolean
  similarity?: number
  query_name?: string
}

function rowToTacoFood(row: TacoRow): TacoFood {
  return {
    id: row.id,
    foodName: row.food_name,
    category: row.category ?? null,
    caloriesPer100g: row.calories_per_100g,
    proteinPer100g: row.protein_per_100g,
    carbsPer100g: row.carbs_per_100g,
    fatPer100g: row.fat_per_100g,
    fiberPer100g: row.fiber_per_100g,
    foodBase: row.food_base,
    foodVariant: row.food_variant,
    isDefault: row.is_default,
  }
}

// ---------------------------------------------------------------------------
// Fuzzy matching (existing — now returns base/variant/isDefault too)
// ---------------------------------------------------------------------------

export async function fuzzyMatchTaco(
  supabase: SupabaseClient,
  foodName: string,
): Promise<TacoFood | null> {
  const { data, error } = await supabase.rpc('match_taco_food', {
    query_name: foodName.toLowerCase(),
    threshold: SIMILARITY_THRESHOLD,
  })

  if (error || !data || data.length === 0) {
    return null
  }

  return rowToTacoFood(data[0] as TacoRow)
}

export async function fuzzyMatchTacoMultiple(
  supabase: SupabaseClient,
  foodNames: string[],
): Promise<Map<string, TacoFood | null>> {
  const result = new Map<string, TacoFood | null>()

  if (foodNames.length === 0) return result

  const { data, error } = await supabase.rpc('match_taco_foods_batch', {
    query_names: foodNames.map(n => n.toLowerCase()),
    threshold: SIMILARITY_THRESHOLD,
  })

  for (const name of foodNames) {
    result.set(name.toLowerCase(), null)
  }

  if (error || !data) return result

  for (const row of data as (TacoRow & { query_name: string })[]) {
    result.set(row.query_name, rowToTacoFood(row))
  }

  return result
}

// ---------------------------------------------------------------------------
// Base matching (new)
// ---------------------------------------------------------------------------

export async function matchTacoByBase(
  supabase: SupabaseClient,
  foodBase: string,
): Promise<TacoFood[]> {
  const { data, error } = await supabase.rpc('match_taco_by_base', {
    query_base: foodBase,
  })

  if (error || !data || data.length === 0) {
    return []
  }

  return (data as TacoRow[]).map(rowToTacoFood)
}

// ---------------------------------------------------------------------------
// Learned defaults (new)
// ---------------------------------------------------------------------------

export async function getLearnedDefault(
  supabase: SupabaseClient,
  foodBase: string,
): Promise<{ tacoId: number; userCount: number } | null> {
  const { data, error } = await supabase.rpc('get_learned_default', {
    query_base: foodBase,
  })

  if (error || !data || data.length === 0) {
    return null
  }

  const row = data[0] as { taco_id: number; user_count: number }
  return { tacoId: row.taco_id, userCount: row.user_count }
}

// ---------------------------------------------------------------------------
// Usage tracking (new)
// ---------------------------------------------------------------------------

export async function recordTacoUsage(
  supabase: SupabaseClient,
  foodBase: string,
  tacoId: number,
  userId: string,
): Promise<void> {
  await supabase.rpc('record_taco_usage', {
    p_food_base: foodBase,
    p_taco_id: tacoId,
    p_user_id: userId,
  })
}

// ---------------------------------------------------------------------------
// Macro calculation (unchanged)
// ---------------------------------------------------------------------------

export function calculateMacros(tacoFood: TacoFood, grams: number): CalculatedMacros {
  const factor = grams / 100
  return {
    calories: Math.round(tacoFood.caloriesPer100g * factor),
    protein: Math.round(tacoFood.proteinPer100g * factor * 10) / 10,
    carbs: Math.round(tacoFood.carbsPer100g * factor * 10) / 10,
    fat: Math.round(tacoFood.fatPer100g * factor * 10) / 10,
  }
}
