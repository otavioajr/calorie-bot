import type { SupabaseClient } from '@supabase/supabase-js'
import { getLLMProvider } from '@/lib/llm/index'
import type { MealAnalysis } from '@/lib/llm/schemas/meal-analysis'
import { enrichItemsWithTaco } from '@/lib/bot/flows/meal-log'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function round(n: number): number {
  return Math.round(n * 10) / 10
}

interface EnrichedQueryItem {
  food: string
  quantityDisplay: string | null
  calories: number
  protein: number
  carbs: number
  fat: number
  source: string
}

function formatItem(item: EnrichedQueryItem): string {
  const protStr = `${round(item.protein)}g proteína`
  const carbStr = `${round(item.carbs)}g carbos`
  const fatStr = `${round(item.fat)}g gordura`
  const qtyPart = item.quantityDisplay ? `(${item.quantityDisplay})` : ''
  const calStr = item.source === 'approximate' ? `~${Math.round(item.calories)}` : `${Math.round(item.calories)}`
  const indicator = item.source === 'approximate' ? ' ⚠️' : ''

  return `🔍 ${item.food}${qtyPart ? ' ' + qtyPart : ''}: ${calStr} kcal, ${protStr} | ${carbStr} | ${fatStr}${indicator}`
}

function formatTotal(items: EnrichedQueryItem[]): string {
  const totalCal = Math.round(items.reduce((sum, i) => sum + i.calories, 0))
  const totalProt = round(items.reduce((sum, i) => sum + i.protein, 0))
  const totalCarbs = round(items.reduce((sum, i) => sum + i.carbs, 0))
  const totalFat = round(items.reduce((sum, i) => sum + i.fat, 0))

  return `📊 Total: ${totalCal} kcal | ${totalProt}g proteína | ${totalCarbs}g carbos | ${totalFat}g gordura`
}

// ---------------------------------------------------------------------------
// handleQuery
// ---------------------------------------------------------------------------

export async function handleQuery(
  supabase: SupabaseClient,
  userId: string,
  message: string,
): Promise<string> {
  const llm = getLLMProvider()
  const meals: MealAnalysis[] = await llm.analyzeMeal(message)

  const allItems = meals.flatMap(m => m.items)

  // Use the full enrichment pipeline (TACO base → synonyms → tokens → fuzzy → decompose → LLM estimate)
  const enrichedItems = await enrichItemsWithTaco(supabase, allItems, llm, userId)

  const queryItems: EnrichedQueryItem[] = enrichedItems.map(item => ({
    food: item.food,
    quantityDisplay: item.quantityDisplay ?? null,
    calories: item.calories,
    protein: item.protein,
    carbs: item.carbs,
    fat: item.fat,
    source: item.source,
  }))

  const itemLines = queryItems.map(formatItem)
  const totalLine = queryItems.length > 1 ? [formatTotal(queryItems)] : []

  const lines = [...itemLines, ...totalLine]
  return lines.join('\n')
}
