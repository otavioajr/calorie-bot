import { SupabaseClient } from '@supabase/supabase-js'
import { fromDB } from '@/lib/db/utils'
import { TacoNotFoundError } from '@/lib/recipes/errors'
import { applySynonyms, normalizeFoodNameForTaco, tokenMatchScore } from '@/lib/utils/food-normalize'

export const SIMILARITY_THRESHOLD = 0.4
export const TACO_SELECT =
  'id, food_name, category, calories_per_100g, protein_per_100g, carbs_per_100g, fat_per_100g, fiber_per_100g, food_base, food_variant, is_default'

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

export interface TacoRow {
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
  const food = fromDB<TacoFood>(row as unknown as Record<string, unknown>)

  return {
    ...food,
    category: food.category ?? null,
    caloriesPer100g: Number(food.caloriesPer100g ?? row.calories_per_100g),
    proteinPer100g: Number(food.proteinPer100g ?? row.protein_per_100g),
    carbsPer100g: Number(food.carbsPer100g ?? row.carbs_per_100g),
    fatPer100g: Number(food.fatPer100g ?? row.fat_per_100g),
    fiberPer100g: Number(food.fiberPer100g ?? row.fiber_per_100g),
    isDefault: Boolean(food.isDefault),
  }
}

export async function lookupTacoById(
  supabase: SupabaseClient,
  tacoId: number,
): Promise<TacoFood> {
  const { data, error } = await supabase
    .from('taco_foods')
    .select(TACO_SELECT)
    .eq('id', tacoId)
    .single()

  if (error?.code === 'PGRST116' || (!error && !data)) {
    throw new TacoNotFoundError(tacoId)
  }

  if (error) {
    throw new Error('taco_lookup_failed')
  }

  return rowToTacoFood(data as TacoRow)
}

// ---------------------------------------------------------------------------
// Fuzzy matching (existing — now returns base/variant/isDefault too)
// ---------------------------------------------------------------------------

export async function fuzzyMatchTaco(
  supabase: SupabaseClient,
  foodName: string,
  options: { throwOnError?: boolean } = {},
): Promise<TacoFood | null> {
  const { data, error } = await supabase.rpc('match_taco_food', {
    query_name: foodName.toLowerCase(),
    threshold: SIMILARITY_THRESHOLD,
  })

  if (error) {
    if (options.throwOnError) throw new Error(error.message)
    return null
  }

  if (!data || data.length === 0) {
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

function pickBestResolvedVariant(foodName: string, variants: TacoFood[]): TacoFood {
  const normalizedName = normalizeFoodNameForTaco(applySynonyms(normalizeFoodNameForTaco(foodName)))
  const inputTokens = normalizedName.split(/[\s,]+/).filter(t => t.length > 1)

  const directVariantMatch = variants.find((variant) => {
    const variantName = normalizeFoodNameForTaco(variant.foodName)
    const variantType = normalizeFoodNameForTaco(variant.foodVariant.split(',')[0] ?? '')

    return (
      (variantType.length >= 4 && normalizedName.includes(variantType)) ||
      variantName.includes(normalizedName) ||
      normalizedName.includes(variantName)
    )
  })

  if (directVariantMatch) {
    return directVariantMatch
  }

  let bestMatch: TacoFood | null = null
  let bestScore = 0

  for (const variant of variants) {
    const candidateTokens = normalizeFoodNameForTaco(variant.foodName)
      .split(/[\s,]+/)
      .filter(t => t.length > 1)
    const score = tokenMatchScore(inputTokens, candidateTokens)

    if (score > bestScore) {
      bestScore = score
      bestMatch = variant
    }
  }

  if (bestMatch && bestScore >= 0.6) {
    return bestMatch
  }

  return variants.find(variant => variant.isDefault) ?? variants[0]
}

export async function resolveTacoFood(
  supabase: SupabaseClient,
  foodName: string,
  options: { throwOnError?: boolean } = {},
): Promise<TacoFood | null> {
  const normalized = normalizeFoodNameForTaco(foodName)
  const synonymName = applySynonyms(normalized)
  const baseCandidates = [
    foodName.trim(),
    foodName.trim().split(/\s+/)[0],
    synonymName.split(',')[0]?.trim(),
    synonymName.split(/[\s,]+/)[0],
  ].filter((candidate): candidate is string => Boolean(candidate))

  for (const base of [...new Set(baseCandidates)]) {
    const variants = await matchTacoByBase(supabase, base)
    if (variants.length > 0) {
      return pickBestResolvedVariant(foodName, variants)
    }
  }

  return fuzzyMatchTaco(supabase, foodName, options)
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
