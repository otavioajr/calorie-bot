import { SupabaseClient } from '@supabase/supabase-js'

export interface HistoryMatch {
  mealId: string
  foodName: string
  quantityGrams: number
  calories: number
  protein: number
  carbs: number
  fat: number
  source: string
  tacoId: number | null
  registeredAt: string
  originalMessage: string
}

/**
 * Search a user's previous meal_items by food name (ILIKE).
 * Falls back to searching meals.original_message if no item match.
 * Returns up to 3 most recent matches.
 */
export async function searchMealHistory(
  supabase: SupabaseClient,
  userId: string,
  query: string,
): Promise<HistoryMatch[]> {
  // First: search by meal_items.food_name
  const { data: itemData } = await supabase
    .from('meal_items')
    .select(`
      id, food_name, quantity_grams, calories, protein_g, carbs_g, fat_g, source, taco_id, created_at,
      meals!inner(id, user_id, original_message, registered_at)
    `)
    .eq('meals.user_id', userId)
    .ilike('food_name', `%${query}%`)
    .order('created_at', { ascending: false })
    .limit(3)

  if (itemData && itemData.length > 0) {
    return itemData.map((row: Record<string, unknown>) => {
      const meal = row.meals as Record<string, unknown>
      return {
        mealId: meal.id as string,
        foodName: row.food_name as string,
        quantityGrams: row.quantity_grams as number,
        calories: row.calories as number,
        protein: row.protein_g as number,
        carbs: row.carbs_g as number,
        fat: row.fat_g as number,
        source: row.source as string,
        tacoId: row.taco_id as number | null,
        registeredAt: meal.registered_at as string,
        originalMessage: meal.original_message as string,
      }
    })
  }

  // Fallback: search by meals.original_message
  const { data: mealData } = await supabase
    .from('meals')
    .select(`
      id, original_message, registered_at,
      meal_items(food_name, quantity_grams, calories, protein_g, carbs_g, fat_g, source, taco_id)
    `)
    .eq('user_id', userId)
    .ilike('original_message', `%${query}%`)
    .order('registered_at', { ascending: false })
    .limit(3)

  if (!mealData || mealData.length === 0) return []

  return mealData.map((meal: Record<string, unknown>) => {
    const items = meal.meal_items as Record<string, unknown>[]
    const firstItem = items?.[0] ?? {}
    return {
      mealId: meal.id as string,
      foodName: (firstItem.food_name as string) ?? 'Refeição',
      quantityGrams: (firstItem.quantity_grams as number) ?? 0,
      calories: (firstItem.calories as number) ?? 0,
      protein: (firstItem.protein_g as number) ?? 0,
      carbs: (firstItem.carbs_g as number) ?? 0,
      fat: (firstItem.fat_g as number) ?? 0,
      source: (firstItem.source as string) ?? 'approximate',
      tacoId: (firstItem.taco_id as number | null) ?? null,
      registeredAt: meal.registered_at as string,
      originalMessage: meal.original_message as string,
    }
  })
}
