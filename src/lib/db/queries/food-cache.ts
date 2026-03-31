import { SupabaseClient } from '@supabase/supabase-js'

export interface CachedFood {
  id: string
  foodNameNormalized: string
  caloriesPer100g: number
  proteinPer100g: number | null
  carbsPer100g: number | null
  fatPer100g: number | null
  typicalPortionGrams: number | null
  source: string
  hitCount: number
  portionType: string | null
  defaultGrams: number | null
  defaultDisplay: string | null
}

/**
 * Map a DB row (snake_case) to a CachedFood (camelCase).
 * Uses explicit field mapping because the generic fromDB utility
 * cannot handle numeric segments like `_100g` → `100g` correctly.
 */
function rowToCachedFood(row: Record<string, unknown>): CachedFood {
  return {
    id: row.id as string,
    foodNameNormalized: row.food_name_normalized as string,
    caloriesPer100g: row.calories_per_100g as number,
    proteinPer100g: row.protein_per_100g as number | null,
    carbsPer100g: row.carbs_per_100g as number | null,
    fatPer100g: row.fat_per_100g as number | null,
    typicalPortionGrams: row.typical_portion_grams as number | null,
    source: row.source as string,
    hitCount: row.hit_count as number,
    portionType: (row.portion_type as string) ?? null,
    defaultGrams: (row.default_grams as number) ?? null,
    defaultDisplay: (row.default_display as string) ?? null,
  }
}

/**
 * Normalize food name: lowercase, trim, remove accents.
 */
export function normalizeFoodName(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
}

/**
 * Lookup food in cache by normalized name.
 * If found, increments hit_count (fire and forget).
 * Returns the cached entry or null if not found.
 */
export async function lookupFood(
  supabase: SupabaseClient,
  name: string
): Promise<CachedFood | null> {
  const normalized = normalizeFoodName(name)

  const { data, error } = await supabase
    .from('food_cache')
    .select('*')
    .eq('food_name_normalized', normalized)
    .single()

  if (error) {
    if (error.code === 'PGRST116') return null
    throw new Error(error.message)
  }

  // Fire and forget: increment hit_count
  supabase
    .from('food_cache')
    .update({ hit_count: (data as Record<string, unknown>).hit_count as number + 1 })
    .eq('food_name_normalized', normalized)

  return rowToCachedFood(data as Record<string, unknown>)
}

/**
 * Save food to cache (upsert on food_name_normalized conflict).
 * On conflict, increments hit_count.
 */
export async function cacheFood(
  supabase: SupabaseClient,
  data: {
    foodName: string
    caloriesPer100g: number
    proteinPer100g?: number
    carbsPer100g?: number
    fatPer100g?: number
    typicalPortionGrams?: number
    source: string
    portionType?: string
    defaultGrams?: number
    defaultDisplay?: string
  }
): Promise<void> {
  const normalized = normalizeFoodName(data.foodName)

  const row: Record<string, unknown> = {
    food_name_normalized: normalized,
    calories_per_100g: data.caloriesPer100g,
    source: data.source,
  }

  if (data.proteinPer100g !== undefined) row.protein_per_100g = data.proteinPer100g
  if (data.carbsPer100g !== undefined) row.carbs_per_100g = data.carbsPer100g
  if (data.fatPer100g !== undefined) row.fat_per_100g = data.fatPer100g
  if (data.typicalPortionGrams !== undefined) row.typical_portion_grams = data.typicalPortionGrams
  if (data.portionType !== undefined) row.portion_type = data.portionType
  if (data.defaultGrams !== undefined) row.default_grams = data.defaultGrams
  if (data.defaultDisplay !== undefined) row.default_display = data.defaultDisplay

  const { error } = await supabase
    .from('food_cache')
    .upsert(row, { onConflict: 'food_name_normalized' })

  if (error) throw new Error(error.message)
}

export interface CachedDecomposition {
  foodName: string
  ingredients: { food: string; quantity_grams: number }[]
}

/**
 * Lookup cached decomposition for a composite food.
 * Returns null for now — full implementation requires JSONB column.
 */
export async function lookupDecomposition(
  supabase: SupabaseClient,
  foodName: string,
): Promise<CachedDecomposition | null> {
  const normalized = normalizeFoodName(foodName)

  const { data, error } = await supabase
    .from('food_cache')
    .select('*')
    .eq('food_name_normalized', normalized)
    .eq('source', 'decomposition')
    .single()

  if (error || !data) return null

  // Increment hit count fire-and-forget
  supabase
    .from('food_cache')
    .update({ hit_count: ((data as Record<string, unknown>).hit_count as number) + 1 })
    .eq('food_name_normalized', normalized)

  // Full ingredient list storage requires schema change (deferred)
  return null
}

/**
 * Cache a decomposition result marker.
 */
export async function cacheDecomposition(
  supabase: SupabaseClient,
  foodName: string,
): Promise<void> {
  const normalized = normalizeFoodName(foodName)

  await supabase
    .from('food_cache')
    .upsert({
      food_name_normalized: normalized,
      calories_per_100g: 0,
      source: 'decomposition',
    }, { onConflict: 'food_name_normalized' })
}
