import type { SupabaseClient } from '@supabase/supabase-js'
import { getLLMProvider } from '@/lib/llm/index'
import type { MealAnalysis, MealItem } from '@/lib/llm/schemas/meal-analysis'
import { setState } from '@/lib/bot/state'
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

  // Triage: separate items with quantity from items that need it
  const resolvedItems: MealItem[] = []
  const pendingItems: Array<{ food: string; portion_type: string }> = []

  for (const item of allItems) {
    const hasQuantity = item.quantity_grams !== null && item.quantity_grams !== undefined && item.quantity_grams > 0
    const isUnit = item.portion_type === 'unit'
    const userProvided = item.has_user_quantity === true

    if (hasQuantity || isUnit || userProvided) {
      resolvedItems.push(item)
    } else {
      pendingItems.push({ food: item.food, portion_type: item.portion_type ?? 'bulk' })
    }
  }

  // If there are pending items, ask for quantities first
  if (pendingItems.length > 0) {
    // Calculate what we can for resolved items
    let resolvedResponse = ''
    if (resolvedItems.length > 0) {
      const enrichedResolved = await enrichItemsWithTaco(supabase, resolvedItems, llm, userId)
      const resolvedQueryItems = enrichedResolved.map(item => ({
        food: item.food,
        quantityDisplay: item.quantityDisplay ?? null,
        calories: item.calories,
        protein: item.protein,
        carbs: item.carbs,
        fat: item.fat,
        source: item.source,
      }))
      resolvedResponse = resolvedQueryItems.map(formatItem).join('\n') + '\n\n'
    }

    const defaultExample = 'ex: quantidade em g, ml, colheres, etc.'
    const pendingLines = pendingItems.map(p => `• ${p.food} — quanto? (${defaultExample})`).join('\n')

    // Save state so we can complete the query when user responds
    await setState(userId, 'awaiting_bulk_quantities', {
      pending_items: pendingItems,
      resolved_items: resolvedItems.length > 0 ? resolvedItems as unknown as Record<string, unknown>[] : [],
      meal_type: meals[0]?.meal_type ?? 'snack',
      original_message: message,
      flow: 'query',
    })

    if (resolvedItems.length > 0) {
      return `${resolvedResponse}Pra calcular o resto, me diz as quantidades:\n${pendingLines}`
    }
    return `Pra calcular, me diz as quantidades:\n${pendingLines}`
  }

  // All items have quantities — enrich and show
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

  const hasEstimated = queryItems.some(i => i.source === 'approximate')
  const estimatedNotice = hasEstimated
    ? '\n⚠️ Valores com este sinal são estimados. Pra corrigir, me manda as calorias certas (ex: "magic toast são 160 kcal")'
    : ''

  const lines = [...itemLines, ...totalLine, estimatedNotice]
  return lines.filter(Boolean).join('\n')
}
