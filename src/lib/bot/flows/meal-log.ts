import type { SupabaseClient } from '@supabase/supabase-js'
import { getLLMProvider } from '@/lib/llm/index'
import type { MealAnalysis, MealItem } from '@/lib/llm/schemas/meal-analysis'
import { setState, clearState } from '@/lib/bot/state'
import type { ConversationContext } from '@/lib/bot/state'
import { createMeal, getDailyCalories, getDailyMacros, getLastMeal, recalculateMealTotal, getMealWithItems } from '@/lib/db/queries/meals'
import { formatMealBreakdown, formatMultiMealBreakdown, formatProgress, formatSearchFeedback, formatDefaultNotice } from '@/lib/utils/formatters'
import { getRecentMessages } from '@/lib/db/queries/message-history'
import { fuzzyMatchTacoMultiple, calculateMacros, matchTacoByBase, getLearnedDefault, recordTacoUsage } from '@/lib/db/queries/taco'
import type { TacoFood } from '@/lib/db/queries/taco'
import { sendTextMessage } from '@/lib/whatsapp/client'
import { searchMealHistory, HistoryMatch } from '@/lib/db/queries/meal-history-search'
import { normalizeFoodNameForTaco, applySynonyms, tokenMatchScore } from '@/lib/utils/food-normalize'

// ---------------------------------------------------------------------------
// Public interface
// ---------------------------------------------------------------------------

export interface MealLogResult {
  response: string
  completed: boolean
}

// ---------------------------------------------------------------------------
// Types for enriched items
// ---------------------------------------------------------------------------

interface EnrichedItem {
  food: string
  quantityGrams: number
  quantityDisplay?: string | null
  calories: number
  protein: number
  carbs: number
  fat: number
  source: string
  tacoId?: number
  usedDefault?: boolean
  defaultFoodBase?: string
  defaultFoodVariant?: string
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function totalCaloriesFromEnriched(items: EnrichedItem[]): number {
  return Math.round(items.reduce((sum, item) => sum + item.calories, 0))
}

function safeParseJSON(raw: string): unknown {
  try {
    return JSON.parse(raw.trim())
  } catch {
    // Handle markdown-wrapped JSON (```json ... ```)
    const match = raw.match(/```(?:json)?\s*([\s\S]*?)```/)
    if (match) {
      try { return JSON.parse(match[1].trim()) } catch { /* fall through */ }
    }
    return null
  }
}

async function pickBestVariant(
  supabase: SupabaseClient,
  foodName: string,
  variants: TacoFood[],
): Promise<{ match: TacoFood; usedDefault: boolean }> {
  if (variants.length === 1) {
    return { match: variants[0], usedDefault: false }
  }

  const learned = await getLearnedDefault(supabase, foodName)
  if (learned) {
    const learnedFood = variants.find(v => v.id === learned.tacoId)
    if (learnedFood) {
      return { match: learnedFood, usedDefault: true }
    }
  }

  const manualDefault = variants.find(v => v.isDefault)
  if (manualDefault) {
    return { match: manualDefault, usedDefault: true }
  }

  return { match: variants[0], usedDefault: true }
}

async function resolveByBase(
  supabase: SupabaseClient,
  foodName: string,
): Promise<{ match: TacoFood; usedDefault: boolean } | null> {
  // Try raw name first
  const variants = await matchTacoByBase(supabase, foodName)
  if (variants.length > 0) {
    return pickBestVariant(supabase, foodName, variants)
  }

  // Try with synonyms
  const normalized = normalizeFoodNameForTaco(foodName)
  const withSynonyms = applySynonyms(normalized)
  if (withSynonyms !== normalized) {
    const synonymBase = withSynonyms.split(',')[0].trim()
    const synonymVariants = await matchTacoByBase(supabase, synonymBase)
    if (synonymVariants.length > 0) {
      const normalizedFull = withSynonyms.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
      const exactMatch = synonymVariants.find(v => {
        const vNorm = v.foodName.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
        return vNorm.includes(normalizedFull) || normalizedFull.includes(vNorm)
      })
      if (exactMatch) {
        return { match: exactMatch, usedDefault: false }
      }
      return pickBestVariant(supabase, synonymBase, synonymVariants)
    }
  }

  return null
}

function buildReceiptResponse(
  meals: MealAnalysis[],
  enrichedMeals: EnrichedItem[][],
  dailyConsumedSoFar: number,
  dailyTarget: number,
): string {
  // Collect all items that used a default
  const defaults = enrichedMeals
    .flat()
    .filter(i => i.usedDefault && i.defaultFoodBase && i.defaultFoodVariant)
    .map(i => ({ foodBase: i.defaultFoodBase!, foodVariant: i.defaultFoodVariant! }))

  const defaultNotice = formatDefaultNotice(defaults)

  if (meals.length === 1 && enrichedMeals.length === 1) {
    const analysis = meals[0]
    const items = enrichedMeals[0]
    const total = totalCaloriesFromEnriched(items)

    const breakdown = formatMealBreakdown(
      analysis.meal_type,
      items.map(i => ({ food: i.food, quantityGrams: i.quantityGrams, quantityDisplay: i.quantityDisplay, calories: i.calories })),
      total,
      dailyConsumedSoFar,
      dailyTarget,
    )

    return defaultNotice ? breakdown.replace('Algo errado?', `${defaultNotice}\nAlgo errado?`) : breakdown
  }

  const mealSections = meals.map((analysis, idx) => ({
    mealType: analysis.meal_type,
    items: enrichedMeals[idx].map(i => ({ food: i.food, quantityGrams: i.quantityGrams, calories: i.calories })),
    total: totalCaloriesFromEnriched(enrichedMeals[idx]),
  }))

  const multiBreakdown = formatMultiMealBreakdown(mealSections, dailyConsumedSoFar, dailyTarget)

  return defaultNotice ? multiBreakdown.replace('Algo errado?', `${defaultNotice}\nAlgo errado?`) : multiBreakdown
}

// ---------------------------------------------------------------------------
// TACO enrichment — the core new logic
// ---------------------------------------------------------------------------

export async function enrichItemsWithTaco(
  supabase: SupabaseClient,
  items: MealItem[],
  llm: ReturnType<typeof getLLMProvider>,
  userId: string,
): Promise<EnrichedItem[]> {
  const enriched: EnrichedItem[] = []
  const needsFuzzy: { item: MealItem; index: number }[] = []

  // Step 1: Try base-name matching first (most precise for generic names)
  for (let i = 0; i < items.length; i++) {
    const item = items[i]

    const quantityGrams = item.quantity_grams ?? 0

    if (item.calories !== null && item.calories !== undefined && item.calories > 0) {
      // User provided explicit macros — use as-is
      enriched.push({
        food: item.food,
        quantityGrams,
        quantityDisplay: item.quantity_display,
        calories: item.calories,
        protein: item.protein ?? 0,
        carbs: item.carbs ?? 0,
        fat: item.fat ?? 0,
        source: 'user_provided',
      })
      continue
    }

    const baseResult = await resolveByBase(supabase, item.food)
    if (baseResult) {
      const macros = calculateMacros(baseResult.match, quantityGrams)
      enriched.push({
        food: item.food,
        quantityGrams,
        quantityDisplay: item.quantity_display,
        calories: macros.calories,
        protein: macros.protein,
        carbs: macros.carbs,
        fat: macros.fat,
        source: 'taco',
        tacoId: baseResult.match.id,
        usedDefault: baseResult.usedDefault,
        defaultFoodBase: baseResult.usedDefault ? baseResult.match.foodBase : undefined,
        defaultFoodVariant: baseResult.usedDefault ? baseResult.match.foodVariant : undefined,
      })
    } else {
      needsFuzzy.push({ item, index: i })
      enriched.push(null as unknown as EnrichedItem) // placeholder
    }
  }

  // Step 1.5: Token-based search for items that didn't match base
  const stillNeedsFuzzy: { item: MealItem; index: number }[] = []

  for (const { item, index } of needsFuzzy) {
    // Be defensive: skip token match if quantity is missing/zero
    if (!item.quantity_grams || item.quantity_grams <= 0) {
      stillNeedsFuzzy.push({ item, index })
      continue
    }

    const normalized = normalizeFoodNameForTaco(item.food)
    const withSynonyms = applySynonyms(normalized)
    const inputTokens = withSynonyms.split(/[\s,]+/).filter(t => t.length > 1)

    const baseWord = inputTokens[0]
    if (baseWord) {
      const candidates = await matchTacoByBase(supabase, baseWord)
      if (candidates.length > 0) {
        let bestMatch: TacoFood | null = null
        let bestScore = 0

        for (const candidate of candidates) {
          const candidateNorm = normalizeFoodNameForTaco(candidate.foodName)
          const candidateTokens = candidateNorm.split(/[\s,]+/).filter(t => t.length > 1)
          const score = tokenMatchScore(inputTokens, candidateTokens)
          if (score > bestScore) {
            bestScore = score
            bestMatch = candidate
          }
        }

        if (bestMatch && bestScore >= 0.6) {
          const macros = calculateMacros(bestMatch, item.quantity_grams)
          enriched[index] = {
            food: item.food,
            quantityGrams: item.quantity_grams,
            quantityDisplay: item.quantity_display,
            calories: macros.calories,
            protein: macros.protein,
            carbs: macros.carbs,
            fat: macros.fat,
            source: 'taco',
            tacoId: bestMatch.id,
          }
          continue
        }
      }
    }

    stillNeedsFuzzy.push({ item, index })
  }

  // Step 2: Fuzzy match for items that didn't match any base
  const needsDecomposition: { item: MealItem; index: number }[] = []

  if (stillNeedsFuzzy.length > 0) {
    const fuzzyNames = stillNeedsFuzzy.map(d => d.item.food)
    const tacoMatches = await fuzzyMatchTacoMultiple(supabase, fuzzyNames)

    for (const { item, index } of stillNeedsFuzzy) {
      const itemQty = item.quantity_grams ?? 0
      const tacoMatch = tacoMatches.get(item.food.toLowerCase())
      if (tacoMatch) {
        const macros = calculateMacros(tacoMatch, itemQty)
        enriched[index] = {
          food: item.food,
          quantityGrams: itemQty,
          quantityDisplay: item.quantity_display,
          calories: macros.calories,
          protein: macros.protein,
          carbs: macros.carbs,
          fat: macros.fat,
          source: 'taco',
          tacoId: tacoMatch.id,
        }
      } else {
        needsDecomposition.push({ item, index })
      }
    }
  }

  // Step 3: Decompose composite foods that didn't match TACO
  for (const { item, index } of needsDecomposition) {
    const itemQty = item.quantity_grams ?? 0

    // If quantity is 0 but we have a display description, go straight to LLM estimate
    // (decomposition with 0g is meaningless)
    if (itemQty <= 0) {
      const description = item.quantity_display
        ? `${item.quantity_display} de ${item.food}`
        : item.food
      try {
        const raw = await llm.chat(
          `Estime calorias e macronutrientes para: "${description}". Responda APENAS com JSON: {"calories":number,"protein":number,"carbs":number,"fat":number,"estimated_grams":number}`,
          'Você é um especialista em nutrição. Responda APENAS com JSON válido. Se não souber o peso exato, estime um valor razoável para a porção descrita.',
          true,
        )
        const estimate = safeParseJSON(raw) as Record<string, number> | null
        if (estimate && typeof estimate.calories === 'number' && estimate.calories > 0) {
          enriched[index] = {
            food: item.food,
            quantityGrams: estimate.estimated_grams ?? itemQty,
            quantityDisplay: item.quantity_display,
            calories: Math.round(estimate.calories),
            protein: Math.round((estimate.protein ?? 0) * 10) / 10,
            carbs: Math.round((estimate.carbs ?? 0) * 10) / 10,
            fat: Math.round((estimate.fat ?? 0) * 10) / 10,
            source: 'approximate',
          }
        } else {
          console.error(`[enrichment] LLM estimate for "${description}" returned 0 or unparseable:`, raw?.substring(0, 200))
          enriched[index] = {
            food: item.food,
            quantityGrams: itemQty,
            quantityDisplay: item.quantity_display,
            calories: 0, protein: 0, carbs: 0, fat: 0,
            source: 'approximate',
          }
        }
      } catch (err) {
        console.error(`[enrichment] LLM estimate failed for "${description}":`, err)
        enriched[index] = {
          food: item.food,
          quantityGrams: itemQty,
          quantityDisplay: item.quantity_display,
          calories: 0, protein: 0, carbs: 0, fat: 0,
          source: 'approximate',
        }
      }
      continue
    }

    try {
      const ingredients = await llm.decomposeMeal(item.food, itemQty)

      // Match each ingredient: base first, then fuzzy
      let totalCal = 0, totalProt = 0, totalCarbs = 0, totalFat = 0
      const unmatchedIngredients: typeof ingredients = []

      for (const ig of ingredients) {
        const baseResult = await resolveByBase(supabase, ig.food)
        if (baseResult) {
          const macros = calculateMacros(baseResult.match, ig.quantity_grams)
          totalCal += macros.calories
          totalProt += macros.protein
          totalCarbs += macros.carbs
          totalFat += macros.fat
        } else {
          unmatchedIngredients.push(ig)
        }
      }

      // Fuzzy match remaining ingredients
      if (unmatchedIngredients.length > 0) {
        const ingredientNames = unmatchedIngredients.map(ig => ig.food)
        const ingredientMatches = await fuzzyMatchTacoMultiple(supabase, ingredientNames)

        for (const ig of unmatchedIngredients) {
          const match = ingredientMatches.get(ig.food.toLowerCase())

          if (match) {
            const macros = calculateMacros(match, ig.quantity_grams)
            totalCal += macros.calories
            totalProt += macros.protein
            totalCarbs += macros.carbs
            totalFat += macros.fat
          } else {
            // Step 4: Direct LLM calorie estimate for ingredient not in TACO
            try {
              const raw = await llm.chat(
                `Estime calorias e macronutrientes para ${ig.quantity_grams}g de "${ig.food}". Responda APENAS com JSON: {"calories":number,"protein":number,"carbs":number,"fat":number} (valores para ${ig.quantity_grams}g, não por 100g).`,
                'Você é um especialista em nutrição. Responda APENAS com JSON válido.',
                true,
              )
              const estimate = safeParseJSON(raw) as Record<string, number> | null
              if (estimate && typeof estimate.calories === 'number') {
                totalCal += estimate.calories
                totalProt += estimate.protein ?? 0
                totalCarbs += estimate.carbs ?? 0
                totalFat += estimate.fat ?? 0
              } else {
                console.error(`[enrichment] LLM estimate returned unparseable response for "${ig.food}":`, raw.substring(0, 200))
              }
            } catch (err) {
              console.error(`[enrichment] LLM estimate failed for ingredient "${ig.food}":`, err)
            }
          }
        }
      }

      enriched[index] = {
        food: item.food,
        quantityGrams: itemQty,
        quantityDisplay: item.quantity_display,
        calories: Math.round(totalCal),
        protein: Math.round(totalProt * 10) / 10,
        carbs: Math.round(totalCarbs * 10) / 10,
        fat: Math.round(totalFat * 10) / 10,
        source: totalCal > 0 ? 'taco_decomposed' : 'approximate',
      }
    } catch (decomposeErr) {
      console.error(`[enrichment] Decomposition failed for "${item.food}":`, decomposeErr)
      // Decomposition failed entirely — try a direct LLM estimate
      try {
        const raw = await llm.chat(
          `Estime calorias e macronutrientes para ${itemQty}g de "${item.food}". Responda APENAS com JSON: {"calories":number,"protein":number,"carbs":number,"fat":number} (valores para ${itemQty}g, não por 100g).`,
          'Você é um especialista em nutrição. Responda APENAS com JSON válido.',
          true,
        )
        const estimate = safeParseJSON(raw) as Record<string, number> | null
        if (estimate && typeof estimate.calories === 'number') {
          enriched[index] = {
            food: item.food,
            quantityGrams: itemQty,
            quantityDisplay: item.quantity_display,
            calories: Math.round(estimate.calories),
            protein: Math.round((estimate.protein ?? 0) * 10) / 10,
            carbs: Math.round((estimate.carbs ?? 0) * 10) / 10,
            fat: Math.round((estimate.fat ?? 0) * 10) / 10,
            source: 'approximate',
          }
        } else {
          console.error(`[enrichment] Direct LLM estimate unparseable for "${item.food}":`, raw.substring(0, 200))
          enriched[index] = {
            food: item.food,
            quantityGrams: itemQty,
            quantityDisplay: item.quantity_display,
            calories: 0,
            protein: 0,
            carbs: 0,
            fat: 0,
            source: 'approximate',
          }
        }
      } catch (estimateErr) {
        console.error(`[enrichment] Direct LLM estimate failed for "${item.food}":`, estimateErr)
        enriched[index] = {
          food: item.food,
          quantityGrams: itemQty,
          quantityDisplay: item.quantity_display,
          calories: 0,
          protein: 0,
          carbs: 0,
          fat: 0,
          source: 'approximate',
        }
      }
    }
  }

  return enriched
}

// ---------------------------------------------------------------------------
// Main handler
// ---------------------------------------------------------------------------

export async function handleMealLog(
  supabase: SupabaseClient,
  userId: string,
  message: string,
  user: {
    calorieMode: string
    dailyCalorieTarget: number | null
    dailyProteinG?: number | null
    dailyFatG?: number | null
    dailyCarbsG?: number | null
    phone?: string
    timezone?: string
  },
  context: ConversationContext | null,
): Promise<MealLogResult> {
  const trimmed = message.trim()

  // Branch: user is responding with missing quantities
  if (context?.contextType === 'awaiting_bulk_quantities') {
    return handleBulkQuantitiesResponse(supabase, userId, trimmed, context, user)
  }

  // Branch: user is selecting from history matches
  if (context?.contextType === 'awaiting_history_selection') {
    return handleHistorySelection(supabase, userId, trimmed, context, user)
  }

  if (context?.contextType === 'awaiting_clarification') {
    const originalMessage = context.contextData.originalMessage as string
    const combined = `${originalMessage}\n${trimmed}`
    return analyzeAndRegister(supabase, userId, combined, trimmed, user)
  }

  return analyzeAndRegister(supabase, userId, trimmed, trimmed, user)
}

// ---------------------------------------------------------------------------
// History selection handler
// ---------------------------------------------------------------------------

async function handleHistorySelection(
  supabase: SupabaseClient,
  userId: string,
  message: string,
  context: ConversationContext,
  user: { calorieMode: string; dailyCalorieTarget: number | null; timezone?: string },
): Promise<MealLogResult> {
  const matches = context.contextData.matches as HistoryMatch[]
  const meals = context.contextData.meals as MealAnalysis[]
  const originalMessage = context.contextData.originalMessage as string

  const choice = parseInt(message.trim(), 10)
  if (isNaN(choice) || choice < 1 || choice > matches.length) {
    return { response: `Opção inválida. Digite um número de 1 a ${matches.length}.`, completed: false }
  }

  const match = matches[choice - 1]
  const enrichedMeals: EnrichedItem[][] = [[{
    food: match.foodName,
    quantityGrams: match.quantityGrams,
    calories: match.calories,
    protein: match.protein,
    carbs: match.carbs,
    fat: match.fat,
    source: 'user_history',
    tacoId: match.tacoId ?? undefined,
  }]]

  // Register directly
  await saveMeals(supabase, userId, meals, enrichedMeals, originalMessage)
  await clearState(userId)

  const dailyConsumed = await getDailyCalories(supabase, userId, undefined, user.timezone)
  const target = user.dailyCalorieTarget ?? 2000
  const response = buildReceiptResponse(meals, enrichedMeals, dailyConsumed, target)

  return { response, completed: true }
}

// ---------------------------------------------------------------------------
// Save meals to database
// ---------------------------------------------------------------------------

async function saveMeals(
  supabase: SupabaseClient,
  userId: string,
  meals: MealAnalysis[],
  enrichedMeals: EnrichedItem[][],
  originalMessage: string,
): Promise<void> {
  for (let i = 0; i < meals.length; i++) {
    const analysis = meals[i]
    const items = enrichedMeals[i] ?? []

    await createMeal(supabase, {
      userId,
      mealType: analysis.meal_type,
      totalCalories: totalCaloriesFromEnriched(items),
      originalMessage,
      llmResponse: analysis as unknown as Record<string, unknown>,
      items: items.map((item) => ({
        foodName: item.food,
        quantityGrams: item.quantityGrams,
        calories: item.calories,
        proteinG: item.protein,
        carbsG: item.carbs,
        fatG: item.fat,
        source: item.source,
        tacoId: item.tacoId,
        confidence: item.source === 'approximate' ? 'low' : 'high',
        quantityDisplay: item.quantityDisplay ?? undefined,
      })),
    })
  }

  // Record TACO usage for default learning
  for (const items of enrichedMeals) {
    for (const item of items) {
      if (item.tacoId && item.source === 'taco') {
        const foodBase = item.defaultFoodBase ?? item.food
        await recordTacoUsage(supabase, foodBase, item.tacoId, userId)
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Bulk quantities response handler
// ---------------------------------------------------------------------------

async function handleBulkQuantitiesResponse(
  supabase: SupabaseClient,
  userId: string,
  message: string,
  context: ConversationContext,
  user: {
    calorieMode: string
    dailyCalorieTarget: number | null
    phone?: string
    timezone?: string
  },
): Promise<MealLogResult> {
  const pendingItems = context.contextData.pending_items as Array<{
    food: string
    portion_type: string
  }>
  const resolvedMealId = context.contextData.resolved_meal_id as string | null
  const mealType = context.contextData.meal_type as string
  const originalMessage = context.contextData.original_message as string
  const flow = (context.contextData.flow as string) ?? 'meal_log'

  const llm = getLLMProvider()
  const history = await getRecentMessages(supabase, userId)
  const pendingNames = pendingItems.map(i => i.food).join(', ')

  const quantityPrompt = `O usuário estava informando as quantidades de: ${pendingNames}.\nResposta do usuário: "${message}"\n\nIdentifique as quantidades mencionadas para cada alimento.`

  const meals: MealAnalysis[] = await llm.analyzeMeal(quantityPrompt, history)

  if (!meals.length || !meals[0].items.length) {
    return {
      response: 'Não entendi as quantidades. Pode repetir? (ex: "1 escumadeira de arroz e 200ml de leite")',
      completed: false,
    }
  }

  // Only keep items that match the pending foods — ignore extras the LLM may hallucinate from history
  const pendingFoodSet = new Set(pendingItems.map(p => p.food.toLowerCase()))
  const relevantItems = meals[0].items.filter(i => pendingFoodSet.has(i.food.toLowerCase()))

  // Check if all PENDING items got resolved
  const resolvedFoodSet = new Set(
    relevantItems
      .filter(i => i.quantity_grams !== null && i.quantity_grams !== undefined && i.quantity_grams > 0)
      .map(i => i.food.toLowerCase()),
  )
  const stillMissing = pendingItems.filter(p => !resolvedFoodSet.has(p.food.toLowerCase()))

  if (stillMissing.length > 0) {
    const missingLines = stillMissing.map(p => `• ${p.food}`).join('\n')
    return {
      response: `Ainda faltam quantidades:\n${missingLines}\n\nPode me dizer? (ex: "200ml", "2 colheres")`,
      completed: false,
    }
  }

  const parsedItems = relevantItems.filter(
    i => i.quantity_grams !== null && i.quantity_grams !== undefined && i.quantity_grams > 0,
  )

  const enriched = await enrichItemsWithTaco(supabase, parsedItems, llm, userId)
  await clearState(userId)

  // If this was a query flow, return formatted result without registering
  if (flow === 'query') {
    // Combine previously resolved items with newly enriched items
    const resolvedEnriched = (context.contextData.resolved_enriched as Array<Record<string, unknown>> ?? []).map(i => ({
      food: i.food as string,
      quantityGrams: i.quantityGrams as number,
      quantityDisplay: (i.quantityDisplay as string) ?? null,
      calories: i.calories as number,
      protein: i.protein as number,
      carbs: i.carbs as number,
      fat: i.fat as number,
      source: i.source as string,
      tacoId: i.tacoId as number | undefined,
    }))
    const allEnriched = [...resolvedEnriched, ...enriched]

    const lines: string[] = []
    for (const item of allEnriched) {
      const display = item.quantityDisplay ?? (item.quantityGrams ? `${item.quantityGrams}g` : '')
      const qtyPart = display ? `(${display})` : ''
      const calStr = item.source === 'approximate' ? `~${item.calories}` : `${item.calories}`
      const indicator = item.source === 'approximate' ? ' ⚠️' : ''
      const prot = Math.round(item.protein * 10) / 10
      const carbs = Math.round(item.carbs * 10) / 10
      const fat = Math.round(item.fat * 10) / 10
      lines.push(`🔍 ${item.food}${qtyPart ? ' ' + qtyPart : ''}: ${calStr} kcal, ${prot}g proteína | ${carbs}g carbos | ${fat}g gordura${indicator}`)
    }
    if (allEnriched.length > 1) {
      const totalCal = Math.round(allEnriched.reduce((s, i) => s + i.calories, 0))
      const totalProt = Math.round(allEnriched.reduce((s, i) => s + i.protein, 0) * 10) / 10
      const totalCarbs = Math.round(allEnriched.reduce((s, i) => s + i.carbs, 0) * 10) / 10
      const totalFat = Math.round(allEnriched.reduce((s, i) => s + i.fat, 0) * 10) / 10
      lines.push(`📊 Total: ${totalCal} kcal | ${totalProt}g proteína | ${totalCarbs}g carbos | ${totalFat}g gordura`)
    }
    const hasEstimated = allEnriched.some(i => i.source === 'approximate')
    if (hasEstimated) {
      lines.push('\n⚠️ Valores com este sinal são estimados. Pra corrigir, me manda as calorias certas (ex: "magic toast são 160 kcal")')
    }
    lines.push('', 'Quer registrar como refeição? Manda "registrar"')

    // Save ALL items (resolved + new) for registration
    await setState(userId, 'awaiting_confirmation', {
      flow: 'query',
      mealType,
      originalMessage,
      items: allEnriched.map(i => ({
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

    return { response: lines.filter(Boolean).join('\n'), completed: true }
  }

  const mealAnalysis: MealAnalysis = {
    meal_type: mealType as MealAnalysis['meal_type'],
    confidence: 'high',
    references_previous: false,
    reference_query: null,
    items: parsedItems,
    unknown_items: [],
    needs_clarification: false,
  }

  if (resolvedMealId) {
    const itemRows = enriched.map((item) => ({
      meal_id: resolvedMealId,
      food_name: item.food,
      quantity_grams: item.quantityGrams,
      calories: item.calories,
      protein_g: item.protein,
      carbs_g: item.carbs,
      fat_g: item.fat,
      source: item.source,
      taco_id: item.tacoId ?? null,
      confidence: item.source === 'approximate' ? 'low' : 'high',
      quantity_display: item.quantityDisplay ?? null,
    }))

    const { error } = await supabase.from('meal_items').insert(itemRows)
    if (error) throw new Error(`Failed to add items to meal: ${error.message}`)
    await recalculateMealTotal(supabase, resolvedMealId)
  } else {
    await saveMeals(supabase, userId, [mealAnalysis], [enriched], originalMessage)
  }

  for (const item of enriched) {
    if (item.tacoId && item.source === 'taco') {
      const foodBase = item.defaultFoodBase ?? item.food
      await recordTacoUsage(supabase, foodBase, item.tacoId, userId)
    }
  }

  const dailyConsumed = await getDailyCalories(supabase, userId, undefined, user.timezone)
  const target = user.dailyCalorieTarget ?? 2000

  if (resolvedMealId) {
    const fullMeal = await getMealWithItems(supabase, resolvedMealId)
    if (fullMeal) {
      const receiptItems = fullMeal.items.map(i => ({
        food: i.foodName,
        quantityGrams: i.quantityGrams,
        quantityDisplay: i.quantityDisplay,
        calories: i.calories,
      }))
      return {
        response: formatMealBreakdown(fullMeal.mealType, receiptItems, fullMeal.totalCalories, dailyConsumed, target),
        completed: true,
      }
    }
  }

  const total = totalCaloriesFromEnriched(enriched)
  return {
    response: formatMealBreakdown(
      mealType,
      enriched.map(i => ({ food: i.food, quantityGrams: i.quantityGrams, quantityDisplay: i.quantityDisplay, calories: i.calories })),
      total,
      dailyConsumed,
      target,
    ),
    completed: true,
  }
}

// ---------------------------------------------------------------------------
// Analyze meal with LLM, enrich with TACO, register immediately
// ---------------------------------------------------------------------------

async function analyzeAndRegister(
  supabase: SupabaseClient,
  userId: string,
  messageToAnalyze: string,
  originalMessage: string,
  user: {
    calorieMode: string
    dailyCalorieTarget: number | null
    dailyProteinG?: number | null
    dailyFatG?: number | null
    dailyCarbsG?: number | null
    phone?: string
    timezone?: string
  },
): Promise<MealLogResult> {
  const llm = getLLMProvider()
  const history = await getRecentMessages(supabase, userId)

  const meals: MealAnalysis[] = await llm.analyzeMeal(messageToAnalyze, history)

  // Check clarification/unknown across all meals
  for (const result of meals) {
    if (result.needs_clarification) {
      await setState(userId, 'awaiting_clarification', { originalMessage })
      return {
        response: result.clarification_question ?? 'Pode me dar mais detalhes sobre a refeição?',
        completed: false,
      }
    }
    if (result.unknown_items.length > 0) {
      await setState(userId, 'awaiting_clarification', { originalMessage })
      const itemList = result.unknown_items.join(', ')
      return {
        response: `Não consegui identificar: ${itemList}. Pode me dizer as calorias ou quantas gramas?`,
        completed: false,
      }
    }
  }

  // Check for history references
  for (const meal of meals) {
    if (meal.references_previous && meal.reference_query) {
      const matches = await searchMealHistory(supabase, userId, meal.reference_query)
      if (matches.length === 0) {
        // No history found — fall through to normal TACO pipeline
        continue
      }
      if (matches.length === 1) {
        // Single match — register directly
        const match = matches[0]
        const enrichedMeals: EnrichedItem[][] = [[{
          food: match.foodName,
          quantityGrams: match.quantityGrams,
          calories: match.calories,
          protein: match.protein,
          carbs: match.carbs,
          fat: match.fat,
          source: 'user_history',
          tacoId: match.tacoId ?? undefined,
        }]]
        await saveMeals(supabase, userId, meals, enrichedMeals, originalMessage)
        const dailyConsumed = await getDailyCalories(supabase, userId, undefined, user.timezone)
        const target = user.dailyCalorieTarget ?? 2000
        const response = buildReceiptResponse(meals, enrichedMeals, dailyConsumed, target)
        return { response, completed: true }
      }
      // Multiple matches — present options
      const options = matches.map((m, i) => {
        const date = new Date(m.registeredAt).toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' })
        return `${i + 1}️⃣ ${m.foodName} — ${m.calories}kcal (${date})`
      })
      await setState(userId, 'awaiting_history_selection', {
        matches: matches as unknown as Record<string, unknown>,
        meals: meals as unknown as Record<string, unknown>,
        originalMessage,
      })
      return {
        response: `Encontrei esses registros de ${meal.reference_query}:\n${options.join('\n')}\nQual deles?`,
        completed: false,
      }
    }
  }

  // Send feedback once before enrichment loop
  if (user.phone) {
    await sendTextMessage(user.phone, formatSearchFeedback())
  }

  // TRIAGE: separate resolved items from items needing quantity
  for (let mealIdx = 0; mealIdx < meals.length; mealIdx++) {
    const meal = meals[mealIdx]
    const resolvedItems: MealItem[] = []
    const pendingItems: Array<{ food: string; portion_type: string }> = []

    for (const item of meal.items) {
      const hasQuantity = item.quantity_grams !== null && item.quantity_grams !== undefined && item.quantity_grams > 0
      const isUnit = item.portion_type === 'unit'
      const userProvided = item.has_user_quantity === true

      if (hasQuantity || isUnit || userProvided) {
        resolvedItems.push(item)
      } else {
        pendingItems.push({ food: item.food, portion_type: item.portion_type ?? 'bulk' })
      }
    }

    if (pendingItems.length > 0) {
      let resolvedMealId: string | null = null

      if (resolvedItems.length > 0) {
        const enriched = await enrichItemsWithTaco(supabase, resolvedItems, llm, userId)
        const partialAnalysis: MealAnalysis = { ...meal, items: resolvedItems }
        await saveMeals(supabase, userId, [partialAnalysis], [enriched], originalMessage)
        const lastMeal = await getLastMeal(supabase, userId)
        resolvedMealId = lastMeal?.id ?? null
      }

      const defaultExample = 'ex: quantidade em g, ml, colheres, etc.'
      const pendingLines = pendingItems.map(p => `• ${p.food} — quanto? (${defaultExample})`).join('\n')

      let askMsg: string
      if (resolvedItems.length > 0) {
        const resolvedNames = resolvedItems.map(i => i.food).join(', ')
        askMsg = `✅ ${resolvedNames} registrado! Pra completar:\n${pendingLines}`
      } else {
        askMsg = `Pra registrar, me diz as quantidades:\n${pendingLines}`
      }

      await setState(userId, 'awaiting_bulk_quantities', {
        pending_items: pendingItems,
        resolved_meal_id: resolvedMealId,
        meal_type: meal.meal_type,
        original_message: originalMessage,
      })

      return { response: askMsg, completed: false }
    }
  }

  // Enrich all meal items with TACO data
  const enrichedMeals: EnrichedItem[][] = []
  for (const meal of meals) {
    const enriched = await enrichItemsWithTaco(supabase, meal.items, llm, userId)
    enrichedMeals.push(enriched)
  }

  // Register immediately
  await saveMeals(supabase, userId, meals, enrichedMeals, originalMessage)

  const dailyConsumed = await getDailyCalories(supabase, userId, undefined, user.timezone)
  const target = user.dailyCalorieTarget ?? 2000

  const response = buildReceiptResponse(meals, enrichedMeals, dailyConsumed, target)

  return { response, completed: true }
}
