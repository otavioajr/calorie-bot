import type { SupabaseClient } from '@supabase/supabase-js'
import { getLLMProvider } from '@/lib/llm/index'
import type { MealAnalysis, MealItem } from '@/lib/llm/schemas/meal-analysis'
import { setState, clearState } from '@/lib/bot/state'
import type { ConversationContext } from '@/lib/bot/state'
import { enrichItemsWithTaco } from '@/lib/bot/flows/meal-log'
import { createMeal, getDailyCalories } from '@/lib/db/queries/meals'
import { formatProgress } from '@/lib/utils/formatters'

export async function registerFromQuotedQuery(
  supabase: SupabaseClient,
  userId: string,
  quoteContext: { metadata?: Record<string, unknown> },
  user?: { timezone?: string; dailyCalorieTarget?: number | null },
): Promise<string> {
  const metadata = quoteContext.metadata
  if (!metadata?.items || !Array.isArray(metadata.items)) {
    return 'Não encontrei os dados dessa consulta. Manda de novo o que quer registrar?'
  }

  const items = metadata.items as Array<{
    food: string
    quantityGrams: number
    quantityDisplay?: string | null
    calories: number
    protein: number
    carbs: number
    fat: number
    source: string
    tacoId?: number
  }>

  const mealType = (metadata.mealType as string) || 'snack'
  const originalMessage = (metadata.originalMessage as string) || '[query registrada]'
  const totalCalories = Math.round(items.reduce((sum, i) => sum + i.calories, 0))

  await createMeal(supabase, {
    userId,
    mealType,
    totalCalories,
    originalMessage,
    llmResponse: {},
    items: items.map(i => ({
      foodName: i.food,
      quantityGrams: i.quantityGrams,
      calories: i.calories,
      proteinG: i.protein,
      carbsG: i.carbs,
      fatG: i.fat,
      source: i.source,
      tacoId: i.tacoId,
      confidence: i.source === 'approximate' ? 'low' : 'high',
      quantityDisplay: i.quantityDisplay ?? undefined,
    })),
  })

  await clearState(userId)
  const dailyConsumed = await getDailyCalories(supabase, userId, undefined, user?.timezone)
  const target = user?.dailyCalorieTarget ?? 2000

  return `✅ Refeição registrada! (${totalCalories} kcal)\n${formatProgress(dailyConsumed, target)}`
}

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
    // Enrich what we can for resolved items
    let resolvedResponse = ''
    let enrichedResolvedData: Array<Record<string, unknown>> = []
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
      // Save enriched data for later combination
      enrichedResolvedData = enrichedResolved.map(i => ({
        food: i.food,
        quantityGrams: i.quantityGrams,
        quantityDisplay: i.quantityDisplay,
        calories: i.calories,
        protein: i.protein,
        carbs: i.carbs,
        fat: i.fat,
        source: i.source,
        tacoId: i.tacoId,
      }))
    }

    const defaultExample = 'ex: quantidade em g, ml, colheres, etc.'
    const pendingLines = pendingItems.map(p => `• ${p.food} — quanto? (${defaultExample})`).join('\n')

    // Save state with enriched resolved items so we can combine later
    await setState(userId, 'awaiting_bulk_quantities', {
      pending_items: pendingItems,
      resolved_enriched: enrichedResolvedData,
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

  const lines = [...itemLines, ...totalLine, estimatedNotice, '', 'Quer registrar como refeição? Manda "registrar"']

  // Save enriched data so we can register if user confirms
  await setState(userId, 'awaiting_confirmation', {
    flow: 'query',
    mealType: meals[0]?.meal_type ?? 'snack',
    originalMessage: message,
    items: enrichedItems.map(i => ({
      food: i.food,
      quantityGrams: i.quantityGrams,
      quantityDisplay: i.quantityDisplay,
      calories: i.calories,
      protein: i.protein,
      carbs: i.carbs,
      fat: i.fat,
      source: i.source,
      tacoId: i.tacoId,
    })),
  })

  return lines.filter(Boolean).join('\n')
}

// ---------------------------------------------------------------------------
// handleQueryConfirmation — register query result as meal
// ---------------------------------------------------------------------------

const REGISTER_PATTERN = /^(registrar|registra|sim|s)$/i

/**
 * Matches corrections like "magic toast são 80 kcal", "queijo cottage é 50 calorias",
 * "magic toast sao 80kcal". Returns { foodName, calories } or null.
 */
const CORRECTION_PATTERN = /^(.+?)\s+(?:são|sao|é|eh|tem|e)\s+(\d+)\s*(?:kcal|calorias?)$/i

function parseCorrection(message: string): { foodName: string; calories: number } | null {
  const match = message.trim().match(CORRECTION_PATTERN)
  if (!match) return null
  return { foodName: match[1].trim(), calories: parseInt(match[2], 10) }
}

function findItemByName(
  items: Array<{ food: string; [key: string]: unknown }>,
  foodName: string,
): number {
  const normalize = (s: string) =>
    s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim()
  const target = normalize(foodName)

  // Exact match first
  const exactIdx = items.findIndex(i => normalize(i.food) === target)
  if (exactIdx !== -1) return exactIdx

  // Partial match (target contained in item name or vice-versa)
  const partialIdx = items.findIndex(i => {
    const n = normalize(i.food)
    return n.includes(target) || target.includes(n)
  })
  return partialIdx
}

export async function handleQueryConfirmation(
  supabase: SupabaseClient,
  userId: string,
  message: string,
  context: ConversationContext,
  user?: { timezone?: string; dailyCalorieTarget?: number | null },
): Promise<string> {
  const trimmed = message.trim()

  // Check for correction before dismissing (e.g. "magic toast são 80 kcal")
  if (!REGISTER_PATTERN.test(trimmed)) {
    const correction = parseCorrection(trimmed)

    if (!correction) {
      await clearState(userId)
      return 'Ok, não registrei. Pode me mandar o que comeu quando quiser!'
    }

    const items = context.contextData.items as Array<{
      food: string
      quantityGrams: number
      quantityDisplay: string | null
      calories: number
      protein: number
      carbs: number
      fat: number
      source: string
      tacoId?: number
    }>

    const idx = findItemByName(items, correction.foodName)
    if (idx === -1) {
      return `Não encontrei "${correction.foodName}" na lista. Tenta com o nome exato do item ou manda "registrar" pra salvar.`
    }

    // Scale macros proportionally based on calorie correction
    const item = items[idx]
    const oldCal = item.calories
    const ratio = oldCal > 0 ? correction.calories / oldCal : 1

    items[idx] = {
      ...item,
      calories: correction.calories,
      protein: Math.round(item.protein * ratio * 10) / 10,
      carbs: Math.round(item.carbs * ratio * 10) / 10,
      fat: Math.round(item.fat * ratio * 10) / 10,
      source: 'manual',
    }

    // Update state with corrected items, keep awaiting_confirmation
    await setState(userId, 'awaiting_confirmation', {
      ...context.contextData,
      items,
    })

    // Rebuild the display
    const lines: string[] = []
    for (const i of items) {
      const qtyPart = i.quantityDisplay ? `(${i.quantityDisplay})` : ''
      const calStr = i.source === 'approximate' ? `~${Math.round(i.calories)}` : `${Math.round(i.calories)}`
      const indicator = i.source === 'approximate' ? ' ⚠️' : ''
      const prot = Math.round(i.protein * 10) / 10
      const carbs = Math.round(i.carbs * 10) / 10
      const fat = Math.round(i.fat * 10) / 10
      lines.push(`🔍 ${i.food}${qtyPart ? ' ' + qtyPart : ''}: ${calStr} kcal, ${prot}g proteína | ${carbs}g carbos | ${fat}g gordura${indicator}`)
    }
    if (items.length > 1) {
      const totalCal = Math.round(items.reduce((s, i) => s + i.calories, 0))
      const totalProt = Math.round(items.reduce((s, i) => s + i.protein, 0) * 10) / 10
      const totalCarbs = Math.round(items.reduce((s, i) => s + i.carbs, 0) * 10) / 10
      const totalFat = Math.round(items.reduce((s, i) => s + i.fat, 0) * 10) / 10
      lines.push(`📊 Total: ${totalCal} kcal | ${totalProt}g proteína | ${totalCarbs}g carbos | ${totalFat}g gordura`)
    }
    const hasEstimated = items.some(i => i.source === 'approximate')
    if (hasEstimated) {
      lines.push('\n⚠️ Valores com este sinal são estimados. Pra corrigir, me manda as calorias certas (ex: "magic toast são 160 kcal")')
    }
    lines.push(`\n✅ ${items[idx].food} corrigido pra ${correction.calories} kcal!`)
    lines.push('Quer registrar como refeição? Manda "registrar"')

    return lines.filter(Boolean).join('\n')
  }

  const items = context.contextData.items as Array<{
    food: string
    quantityGrams: number
    quantityDisplay: string | null
    calories: number
    protein: number
    carbs: number
    fat: number
    source: string
    tacoId?: number
  }>
  const mealType = context.contextData.mealType as string
  const originalMessage = context.contextData.originalMessage as string

  const totalCalories = Math.round(items.reduce((sum, i) => sum + i.calories, 0))

  await createMeal(supabase, {
    userId,
    mealType,
    totalCalories,
    originalMessage,
    llmResponse: {},
    items: items.map(i => ({
      foodName: i.food,
      quantityGrams: i.quantityGrams,
      calories: i.calories,
      proteinG: i.protein,
      carbsG: i.carbs,
      fatG: i.fat,
      source: i.source,
      tacoId: i.tacoId,
      confidence: i.source === 'approximate' ? 'low' : 'high',
      quantityDisplay: i.quantityDisplay ?? undefined,
    })),
  })

  await clearState(userId)

  const dailyConsumed = await getDailyCalories(supabase, userId, undefined, user?.timezone)
  const target = user?.dailyCalorieTarget ?? 2000

  return `✅ Refeição registrada! (${totalCalories} kcal)\n${formatProgress(dailyConsumed, target)}`
}
