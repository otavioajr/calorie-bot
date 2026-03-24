import type { SupabaseClient } from '@supabase/supabase-js'
import { getLLMProvider } from '@/lib/llm/index'
import type { MealAnalysis, MealItem } from '@/lib/llm/schemas/meal-analysis'
import { setState } from '@/lib/bot/state'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function round(n: number): number {
  return Math.round(n * 10) / 10
}

/**
 * Formats a single meal item's nutritional info.
 */
function formatItem(item: MealItem): string {
  const protStr = `${round(item.protein)}g proteína`
  const carbStr = `${round(item.carbs)}g carbos`
  const fatStr = `${round(item.fat)}g gordura`
  const qty = item.quantity_grams ? `~${item.quantity_grams}g` : ''
  const qtyPart = qty ? `(${qty})` : ''

  return `🔍 ${item.food}${qtyPart ? ' ' + qtyPart : ''}: ${Math.round(item.calories)} kcal, ${protStr} | ${carbStr} | ${fatStr}`
}

/**
 * Formats the total nutritional info when multiple items are present.
 */
function formatTotal(analysis: MealAnalysis): string {
  const totalCal = Math.round(
    analysis.items.reduce((sum, item) => sum + item.calories, 0),
  )
  const totalProt = round(analysis.items.reduce((sum, item) => sum + item.protein, 0))
  const totalCarbs = round(analysis.items.reduce((sum, item) => sum + item.carbs, 0))
  const totalFat = round(analysis.items.reduce((sum, item) => sum + item.fat, 0))

  return `📊 Total: ${totalCal} kcal | ${totalProt}g proteína | ${totalCarbs}g carbos | ${totalFat}g gordura`
}

// ---------------------------------------------------------------------------
// handleQuery
// ---------------------------------------------------------------------------

/**
 * Handles a nutritional query — looks up calories/macros for a food
 * via LLM and returns the info WITHOUT saving to DB.
 * Sets awaiting_confirmation state so "sim" can save it.
 */
export async function handleQuery(
  supabase: SupabaseClient,
  userId: string,
  message: string,
): Promise<string> {
  const llm = getLLMProvider()
  const meals: MealAnalysis[] = await llm.analyzeMeal(message, 'approximate', undefined)

  // Flatten all meals' items into one analysis for display
  const allItems = meals.flatMap(m => m.items)
  const analysis: MealAnalysis = { ...meals[0], items: allItems }

  // Format each item
  const itemLines = analysis.items.map(formatItem)

  // If multiple items, also show total
  const totalLine = analysis.items.length > 1 ? [formatTotal(analysis)] : []

  const lines = [
    ...itemLines,
    ...totalLine,
    '',
    'Quer registrar como uma refeição? (sim/não)',
  ]

  const response = lines.join('\n')

  // Set state so that "sim" can save this analysis as a meal
  await setState(userId, 'awaiting_confirmation', {
    mealAnalysis: analysis as unknown as Record<string, unknown>,
    originalMessage: message,
  })

  return response
}
