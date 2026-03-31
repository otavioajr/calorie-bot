import type { SupabaseClient } from '@supabase/supabase-js'
import { getLLMProvider } from '@/lib/llm/index'
import type { MealAnalysis } from '@/lib/llm/schemas/meal-analysis'
import { setState } from '@/lib/bot/state'
import { fuzzyMatchTacoMultiple, calculateMacros } from '@/lib/db/queries/taco'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function round(n: number): number {
  return Math.round(n * 10) / 10
}

interface EnrichedQueryItem {
  food: string
  quantityGrams: number | null
  quantityDisplay: string | null
  calories: number
  protein: number
  carbs: number
  fat: number
}

function formatItem(item: EnrichedQueryItem): string {
  const protStr = `${round(item.protein)}g proteína`
  const carbStr = `${round(item.carbs)}g carbos`
  const fatStr = `${round(item.fat)}g gordura`
  const display = item.quantityDisplay || (item.quantityGrams ? `${item.quantityGrams}g` : '')
  const qtyPart = display ? `(${display})` : ''

  return `🔍 ${item.food}${qtyPart ? ' ' + qtyPart : ''}: ${Math.round(item.calories)} kcal, ${protStr} | ${carbStr} | ${fatStr}`
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

  // Enrich with TACO
  const foodNames = allItems.map(i => i.food)
  const tacoMatches = await fuzzyMatchTacoMultiple(supabase, foodNames)

  const enriched: EnrichedQueryItem[] = allItems.map(item => {
    const match = tacoMatches.get(item.food.toLowerCase())
    if (match) {
      const macros = calculateMacros(match, item.quantity_grams ?? 0)
      return { food: item.food, quantityGrams: item.quantity_grams, quantityDisplay: item.quantity_display, ...macros }
    }
    // No TACO match — use LLM values if available, otherwise zeros
    return {
      food: item.food,
      quantityGrams: item.quantity_grams,
      quantityDisplay: item.quantity_display,
      calories: item.calories ?? 0,
      protein: item.protein ?? 0,
      carbs: item.carbs ?? 0,
      fat: item.fat ?? 0,
    }
  })

  const itemLines = enriched.map(formatItem)
  const totalLine = enriched.length > 1 ? [formatTotal(enriched)] : []

  const lines = [...itemLines, ...totalLine, '', 'Quer registrar como uma refeição? (sim/não)']
  const response = lines.join('\n')

  await setState(userId, 'awaiting_confirmation', {
    mealAnalysis: meals[0] as unknown as Record<string, unknown>,
    originalMessage: message,
  })

  return response
}
