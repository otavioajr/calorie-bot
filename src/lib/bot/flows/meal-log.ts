import type { SupabaseClient } from '@supabase/supabase-js'
import { getLLMProvider } from '@/lib/llm/index'
import type { MealAnalysis, MealItem } from '@/lib/llm/schemas/meal-analysis'
import { setState, clearState } from '@/lib/bot/state'
import type { ConversationContext } from '@/lib/bot/state'
import { addMealItems, createMeal, getDailyCalories, getDailyMacros, recalculateMealTotal, getMealWithItems, findMealByTypeForDay, getDayBoundsForTimezone } from '@/lib/db/queries/meals'
import type { MealItemInput, MealWithItems } from '@/lib/db/queries/meals'
import { formatMealBreakdown, formatMultiMealBreakdown, formatProgress, formatSearchFeedback, formatDefaultNotice } from '@/lib/utils/formatters'
import { getRecentMessages } from '@/lib/db/queries/message-history'
import { fuzzyMatchTacoMultiple, calculateMacros, matchTacoByBase, getLearnedDefault, recordTacoUsage } from '@/lib/db/queries/taco'
import type { TacoFood } from '@/lib/db/queries/taco'
import { sendTextMessage } from '@/lib/whatsapp/client'
import { searchMealHistory, HistoryMatch } from '@/lib/db/queries/meal-history-search'
import { normalizeFoodNameForTaco, applySynonyms, tokenMatchScore } from '@/lib/utils/food-normalize'
import { getUserLocalTime, detectExplicitMealType } from '@/lib/utils/meal-time'
import { buildProductQuantityPrompt, handleStartLabelInput, handleStartOffChoice } from '@/lib/bot/flows/product-confirm'
import { tryProductLookup } from '@/lib/products/lookup'
import { shouldUseProductFlow } from '@/lib/products/classify'
import type { Product, ProductLookupOutcome } from '@/lib/products/types'
import { localDateString, parseDateFromMessage, formatDateLabel } from '@/lib/utils/relative-date'
import { buildConsolidatedMealResponse } from '@/lib/bot/meal-response'
import { parseMealType } from '@/lib/bot/flows/meal-detail'

// ---------------------------------------------------------------------------
// Public interface
// ---------------------------------------------------------------------------

export interface MealLogResult {
  response: string
  completed: boolean
  mealId?: string
}

// ---------------------------------------------------------------------------
// Types for enriched items
// ---------------------------------------------------------------------------

export interface EnrichedItem {
  food: string
  quantityGrams: number
  quantityDisplay?: string | null
  calories: number
  protein: number
  carbs: number
  fat: number
  source: string
  tacoId?: number
  productId?: string
  usedDefault?: boolean
  defaultFoodBase?: string
  defaultFoodVariant?: string
}

// ---------------------------------------------------------------------------
// Map an EnrichedItem to the DB input shape (single source of truth)
// ---------------------------------------------------------------------------

export function enrichedToMealItemInput(item: EnrichedItem): MealItemInput {
  return {
    foodName: item.food,
    quantityGrams: item.quantityGrams,
    calories: item.calories,
    proteinG: item.protein,
    carbsG: item.carbs,
    fatG: item.fat,
    source: item.source,
    tacoId: item.tacoId,
    productId: item.productId,
    confidence: item.source === 'approximate' ? 'low' : 'high',
    quantityDisplay: item.quantityDisplay ?? undefined,
  }
}

// ---------------------------------------------------------------------------
// logFoodToMeal — single consolidation seam (find-or-create by day+meal_type)
// ---------------------------------------------------------------------------

export interface LogFoodResult {
  wasAppend: boolean
  mealId: string
  addedItems: MealItemInput[]
  meal: MealWithItems
}

export interface LogFoodParams {
  userId: string
  mealType: string
  items: MealItemInput[]
  originalMessage: string
  llmResponse?: unknown
  targetDate?: Date
  timezone?: string
  now?: Date
}

export async function logFoodToMeal(
  supabase: SupabaseClient,
  params: LogFoodParams,
): Promise<LogFoodResult> {
  const timezone = params.timezone ?? 'America/Sao_Paulo'
  const now = params.now ?? new Date()
  const targetDate = params.targetDate ?? now

  const existing = await findMealByTypeForDay(supabase, params.userId, params.mealType, targetDate, timezone)

  if (existing) {
    await addMealItems(supabase, existing.id, params.items)
    await recalculateMealTotal(supabase, existing.id)
    const meal = await getMealWithItems(supabase, existing.id)
    if (!meal) throw new Error(`Meal ${existing.id} not found after append`)
    return {
      wasAppend: true,
      mealId: existing.id,
      addedItems: params.items,
      meal,
    }
  }

  // New meal. Backdate registered_at to local noon when target day != today.
  // Backdate registered_at to ~local noon of the target day (12h after local midnight).
  // The 12h offset can drift ±1h on DST-transition days, but never out of the correct local day.
  // (Default America/Sao_Paulo has no DST.)
  let registeredAt: Date | undefined
  if (localDateString(targetDate, timezone) !== localDateString(now, timezone)) {
    const { startOfDay } = getDayBoundsForTimezone(targetDate, timezone)
    registeredAt = new Date(startOfDay.getTime() + 12 * 60 * 60 * 1000)
  }

  const totalCalories = Math.round(params.items.reduce((sum, i) => sum + i.calories, 0))
  const mealId = await createMeal(supabase, {
    userId: params.userId,
    mealType: params.mealType,
    totalCalories,
    originalMessage: params.originalMessage,
    llmResponse: params.llmResponse ?? {},
    items: params.items,
    registeredAt,
  })
  const meal = await getMealWithItems(supabase, mealId)
  if (!meal) throw new Error(`Meal ${mealId} not found after create`)
  return {
    wasAppend: false,
    mealId,
    addedItems: params.items,
    meal,
  }
}

type PendingProductOutcome = Extract<ProductLookupOutcome, { kind: 'needs_off_choice' | 'needs_label' | 'needs_quantity' }>

interface PendingProductInteraction {
  item: MealItem
  index: number
  outcome: PendingProductOutcome
}

class ProductInteractionRequired extends Error {
  constructor(
    readonly pendingInteractions: PendingProductInteraction[],
    readonly enrichedItems: Array<EnrichedItem | null>,
  ) {
    super('Product interaction required')
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function totalCaloriesFromEnriched(items: EnrichedItem[]): number {
  return Math.round(items.reduce((sum, item) => sum + item.calories, 0))
}

function buildMacrosBlock(
  user: { dailyCalorieTarget: number | null; dailyProteinG?: number | null; dailyFatG?: number | null; dailyCarbsG?: number | null },
  dailyMacros: { proteinG: number; fatG: number; carbsG: number },
): {
  target: number
  macros: { consumed: { proteinG: number; fatG: number; carbsG: number }; target: { proteinG: number; fatG: number; carbsG: number } } | undefined
} {
  const target = user.dailyCalorieTarget ?? 2000
  const macros = (user.dailyProteinG && user.dailyFatG && user.dailyCarbsG)
    ? {
        consumed: { proteinG: dailyMacros.proteinG, fatG: dailyMacros.fatG, carbsG: dailyMacros.carbsG },
        target: { proteinG: user.dailyProteinG, fatG: user.dailyFatG, carbsG: user.dailyCarbsG },
      }
    : undefined
  return { target, macros }
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

function calculateMacrosFromProduct(product: Product, quantityGrams: number) {
  const factor = quantityGrams / 100
  return {
    calories: Math.round(product.caloriesPer100g * factor),
    protein: Math.round(product.proteinPer100g * factor * 10) / 10,
    carbs: Math.round(product.carbsPer100g * factor * 10) / 10,
    fat: Math.round(product.fatPer100g * factor * 10) / 10,
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

  // Check if the user's food name already specifies a variant
  const norm = (s: string) => s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
  const nameNorm = norm(foodName)
  const variantMatch = variants.find(v => {
    // Extract the type keyword from the variant (first comma-separated token)
    const variantType = norm(v.foodVariant.split(',')[0].trim())
    // Only match if the type keyword is specific enough (>=4 chars) and present in the food name
    if (variantType.length >= 4 && nameNorm.includes(variantType)) {
      return true
    }
    // Also check if the full food_name matches
    const vNameNorm = norm(v.foodName)
    return vNameNorm.includes(nameNorm) || nameNorm.includes(vNameNorm)
  })
  if (variantMatch) {
    return { match: variantMatch, usedDefault: false }
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
  macros?: {
    consumed: { proteinG: number; fatG: number; carbsG: number }
    target: { proteinG: number; fatG: number; carbsG: number }
  },
  dateLabel: string = 'Hoje',
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
      macros,
      dateLabel,
    )

    return defaultNotice ? breakdown.replace('Algo errado?', `${defaultNotice}\nAlgo errado?`) : breakdown
  }

  const mealSections = meals.map((analysis, idx) => ({
    mealType: analysis.meal_type,
    items: enrichedMeals[idx].map(i => ({ food: i.food, quantityGrams: i.quantityGrams, calories: i.calories })),
    total: totalCaloriesFromEnriched(enrichedMeals[idx]),
  }))

  const multiBreakdown = formatMultiMealBreakdown(mealSections, dailyConsumedSoFar, dailyTarget, macros)

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

  // Step 1.7: Try industrialized product base before LLM decomposition.
  const stillNeedsAfterProducts: { item: MealItem; index: number }[] = []
  const pendingInteractions: PendingProductInteraction[] = []

  for (const { item, index } of stillNeedsFuzzy) {
    const outcome = await tryProductLookup(supabase, item, userId)

    if (outcome.kind === 'matched') {
      const resolvedQuantity = outcome.quantityGrams ?? outcome.product.servingSizeG
      if (resolvedQuantity == null || resolvedQuantity <= 0) {
        pendingInteractions.push({
          item,
          index,
          outcome: { kind: 'needs_quantity', product: outcome.product },
        })
        continue
      }
      const quantityDisplay = item.quantity_display ?? outcome.product.servingDisplay ?? null
      const macros = calculateMacrosFromProduct(outcome.product, resolvedQuantity)
      enriched[index] = {
        food: outcome.product.name,
        quantityGrams: resolvedQuantity,
        quantityDisplay,
        calories: macros.calories,
        protein: macros.protein,
        carbs: macros.carbs,
        fat: macros.fat,
        source: 'product',
        productId: outcome.product.id,
      }
      continue
    }

    if (outcome.kind === 'needs_off_choice' || outcome.kind === 'needs_label' || outcome.kind === 'needs_quantity') {
      pendingInteractions.push({ item, index, outcome })
      continue
    }

    stillNeedsAfterProducts.push({ item, index })
  }

  // If we have pending interactions, throw after collecting all of them
  if (pendingInteractions.length > 0) {
    throw new ProductInteractionRequired(pendingInteractions, enriched)
  }

  // Step 2: Fuzzy match for items that didn't match any base
  const needsDecomposition: { item: MealItem; index: number }[] = []

  if (stillNeedsAfterProducts.length > 0) {
    const fuzzyNames = stillNeedsAfterProducts.map(d => d.item.food)
    const tacoMatches = await fuzzyMatchTacoMultiple(supabase, fuzzyNames)

    for (const { item, index } of stillNeedsAfterProducts) {
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

  // Branch: backdated log without an explicit meal type — user is answering "which meal?"
  if (context?.contextType === 'awaiting_meal_type') {
    return handleAwaitingMealType(supabase, userId, trimmed, context, user)
  }

  if (context?.contextType === 'awaiting_clarification') {
    const originalMessage = context.contextData.originalMessage as string
    const combined = `${originalMessage}\n${trimmed}`
    return analyzeAndRegister(supabase, userId, combined, trimmed, user)
  }

  return analyzeAndRegister(supabase, userId, trimmed, trimmed, user)
}

// ---------------------------------------------------------------------------
// appendItemsToMeal — adds new items to an existing meal (for add_item correction)
// ---------------------------------------------------------------------------

export interface AppendItemsResult {
  added: EnrichedItem[]
  newTotal: number
}

export async function appendItemsToMeal(
  supabase: SupabaseClient,
  userId: string,
  mealId: string,
  message: string,
  user?: { timezone?: string },
): Promise<AppendItemsResult | null> {
  const llm = getLLMProvider()
  const history = await getRecentMessages(supabase, userId)
  const currentTime = getUserLocalTime(user?.timezone)

  const meals: MealAnalysis[] = await llm.analyzeMeal(message, history, currentTime)
  const items: MealItem[] = meals.flatMap((m) => m.items)
  if (items.length === 0) return null

  // Skip items that need clarification or are unknown — keep this path simple.
  for (const result of meals) {
    if (result.needs_clarification || result.unknown_items.length > 0) {
      return null
    }
  }

  const targetMeal = await getMealWithItems(supabase, mealId)
  if (!targetMeal) return null

  const resolvedItems = items.filter((item) => {
    const hasQuantity = item.quantity_grams !== null && item.quantity_grams !== undefined && item.quantity_grams > 0
    const isUnit = item.portion_type === 'unit'
    const userProvided = item.has_user_quantity === true
    return hasQuantity || isUnit || userProvided
  })
  if (resolvedItems.length === 0) return null

  let enriched: EnrichedItem[]
  try {
    enriched = await enrichItemsWithTaco(supabase, resolvedItems, llm, userId)
  } catch (err) {
    if (err instanceof ProductInteractionRequired) return null
    throw err
  }

  const validEnriched = enriched.filter((e): e is EnrichedItem => e !== null && e !== undefined)
  if (validEnriched.length === 0) return null

  // Map each enriched item to the meal_type its source message implies. Items whose
  // analyzed meal_type matches the target go to the target meal; the rest are routed
  // (find-or-create) to a meal of their own type for today — nothing is silently dropped.
  const targetType = targetMeal.mealType
  const itemTypeByFood = new Map<string, string>()
  for (const m of meals) {
    for (const it of m.items) itemTypeByFood.set(it.food.toLowerCase(), m.meal_type)
  }

  const sameTypeInputs: MealItemInput[] = []
  const otherByType = new Map<string, MealItemInput[]>()
  for (const item of validEnriched) {
    const input = enrichedToMealItemInput(item)
    const itemType = itemTypeByFood.get(item.food.toLowerCase()) ?? targetType
    if (itemType === targetType) {
      sameTypeInputs.push(input)
    } else {
      const bucket = otherByType.get(itemType) ?? []
      bucket.push(input)
      otherByType.set(itemType, bucket)
    }
  }

  // Same-type items → append directly to the target meal
  if (sameTypeInputs.length > 0) {
    await addMealItems(supabase, mealId, sameTypeInputs)
  }
  // Other-type items → their own meal (today), via the consolidation seam
  for (const [type, inputs] of otherByType) {
    await logFoodToMeal(supabase, {
      userId, mealType: type, items: inputs, originalMessage: message, timezone: user?.timezone,
    })
  }

  for (const item of validEnriched) {
    if (item.tacoId && item.source === 'taco') {
      const foodBase = item.defaultFoodBase ?? item.food
      await recordTacoUsage(supabase, foodBase, item.tacoId, userId)
    }
  }

  const newTotal = await recalculateMealTotal(supabase, mealId)
  return { added: validEnriched, newTotal }
}

async function startProductInteraction(
  userId: string,
  meal: MealAnalysis,
  originalMessage: string,
  pendingInteractions: PendingProductInteraction[],
): Promise<MealLogResult> {
  const first = pendingInteractions[0]
  const item = first.item
  const outcome = first.outcome
  const productItemIndex = first.index

  const pendingMeal = {
    mealType: meal.meal_type,
    originalMessage,
    food: item.food,
    quantityDisplay: item.quantity_display,
    mealItems: meal.items,
    productItemIndex,
  }

  if (outcome.kind === 'needs_quantity') {
    await setState(userId, 'awaiting_product_quantity', {
      product: outcome.product,
      pendingMeal,
    })
    const response = buildProductQuantityPrompt(
      outcome.product.name,
      outcome.product.servingDisplay,
      outcome.product.servingSizeG,
    )
    return { response, completed: false }
  }

  if (outcome.kind === 'needs_off_choice') {
    const result = await handleStartOffChoice(userId, {
      query: outcome.query,
      candidates: outcome.candidates,
      quantityGrams: outcome.quantityGrams,
      pendingMeal,
    })
    return { response: result.response, completed: false }
  }

  const result = await handleStartLabelInput(userId, {
    food: outcome.food,
    quantityGrams: outcome.quantityGrams,
    pendingMeal,
  })
  return { response: result.response, completed: false }
}

// ---------------------------------------------------------------------------
// History selection handler
// ---------------------------------------------------------------------------

async function handleHistorySelection(
  supabase: SupabaseClient,
  userId: string,
  message: string,
  context: ConversationContext,
  user: { calorieMode: string; dailyCalorieTarget: number | null; dailyProteinG?: number | null; dailyFatG?: number | null; dailyCarbsG?: number | null; timezone?: string },
): Promise<MealLogResult> {
  const matches = context.contextData.matches as HistoryMatch[]
  const meals = context.contextData.meals as MealAnalysis[]
  const originalMessage = context.contextData.originalMessage as string
  const { date: targetDate } = parseDateFromMessage(originalMessage)

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
  const results = await saveMeals(supabase, userId, meals, enrichedMeals, originalMessage, targetDate, user.timezone)
  const lastId = results[results.length - 1].mealId
  await saveRecentMealState(supabase, userId, lastId)

  const dailyMacros = await getDailyMacros(supabase, userId, targetDate, user.timezone)
  const { target, macros } = buildMacrosBlock(user, dailyMacros)
  const response = buildReceiptResponse(meals, enrichedMeals, dailyMacros.calories, target, macros, formatDateLabel(targetDate, user.timezone))

  return { response, completed: true, mealId: lastId }
}

// ---------------------------------------------------------------------------
// Awaiting meal type handler — registers a backdated log on the chosen meal type
// ---------------------------------------------------------------------------

async function handleAwaitingMealType(
  supabase: SupabaseClient,
  userId: string,
  message: string,
  context: ConversationContext,
  user: { dailyCalorieTarget: number | null; dailyProteinG?: number | null; dailyFatG?: number | null; dailyCarbsG?: number | null; timezone?: string },
): Promise<MealLogResult> {
  // Use the lenient parser for the REPLY: bare "café" should resolve to breakfast here,
  // unlike the strict ask-decision guard which intentionally treats bare "café" as no type.
  const mealType = parseMealType(message)
  if (!mealType) {
    return {
      response: 'Não entendi a refeição. Responde com: café da manhã, almoço, lanche, jantar ou ceia.',
      completed: false,
    }
  }

  const items = (context.contextData.items as MealItemInput[]) ?? []
  const targetDate = new Date(context.contextData.targetDateISO as string)
  const originalMessage = (context.contextData.originalMessage as string) ?? ''

  const result = await logFoodToMeal(supabase, {
    userId, mealType, items, originalMessage, targetDate, timezone: user.timezone,
  })
  await clearState(userId)

  const dailyMacros = await getDailyMacros(supabase, userId, targetDate, user.timezone)
  const { target, macros } = buildMacrosBlock(user, dailyMacros)
  const dateLabel = formatDateLabel(targetDate, user.timezone)

  return {
    response: buildConsolidatedMealResponse(result, dailyMacros.calories, target, dateLabel, macros),
    completed: true,
    mealId: result.mealId,
  }
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
  targetDate?: Date,
  timezone?: string,
): Promise<LogFoodResult[]> {
  const results: LogFoodResult[] = []
  for (let i = 0; i < meals.length; i++) {
    const analysis = meals[i]
    const items = (enrichedMeals[i] ?? []).map(enrichedToMealItemInput)
    const result = await logFoodToMeal(supabase, {
      userId,
      mealType: analysis.meal_type,
      items,
      originalMessage,
      llmResponse: analysis as unknown as Record<string, unknown>,
      targetDate,
      timezone,
    })
    results.push(result)
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

  return results
}

// ---------------------------------------------------------------------------
// Save recent_meal context state after registration
// ---------------------------------------------------------------------------

async function saveRecentMealState(
  supabase: SupabaseClient,
  userId: string,
  mealId: string,
): Promise<void> {
  const mealWithItems = await getMealWithItems(supabase, mealId)
  if (!mealWithItems || mealWithItems.items.length === 0) return

  await setState(userId, 'recent_meal', {
    mealId,
    mealType: mealWithItems.mealType,
    items: mealWithItems.items.map(i => ({
      id: i.id,
      foodName: i.foodName,
      quantityGrams: i.quantityGrams,
      quantityDisplay: i.quantityDisplay,
      calories: i.calories,
      proteinG: i.proteinG,
      carbsG: i.carbsG,
      fatG: i.fatG,
    })),
  })
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
  const { date: targetDate } = parseDateFromMessage(originalMessage)

  const llm = getLLMProvider()
  const history = await getRecentMessages(supabase, userId)
  const currentTime = getUserLocalTime(user.timezone)
  const pendingNames = pendingItems.map(i => i.food).join(', ')

  const quantityPrompt = `O usuário estava informando as quantidades de: ${pendingNames}.\nResposta do usuário: "${message}"\n\nIdentifique as quantidades mencionadas para cada alimento.`

  let meals: MealAnalysis[]
  try {
    meals = await llm.analyzeMeal(quantityPrompt, history, currentTime)
  } catch (err) {
    console.error('[meal-log] LLM failed in bulk quantities response:', err)
    return {
      response: 'Não entendi as quantidades. Pode repetir? (ex: "1 escumadeira de arroz e 200ml de leite")',
      completed: false,
    }
  }

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

  let savedMealId: string | null = resolvedMealId

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
      product_id: item.productId ?? null,
      confidence: item.source === 'approximate' ? 'low' : 'high',
      quantity_display: item.quantityDisplay ?? null,
    }))

    const { error } = await supabase.from('meal_items').insert(itemRows)
    if (error) throw new Error(`Failed to add items to meal: ${error.message}`)
    await recalculateMealTotal(supabase, resolvedMealId)
  } else {
    const newResults = await saveMeals(supabase, userId, [mealAnalysis], [enriched], originalMessage, targetDate, user.timezone)
    savedMealId = newResults[newResults.length - 1]?.mealId ?? null
    await saveRecentMealState(supabase, userId, savedMealId ?? '')
  }

  for (const item of enriched) {
    if (item.tacoId && item.source === 'taco') {
      const foodBase = item.defaultFoodBase ?? item.food
      await recordTacoUsage(supabase, foodBase, item.tacoId, userId)
    }
  }

  const dailyConsumed = await getDailyCalories(supabase, userId, targetDate, user.timezone)
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
        mealId: resolvedMealId,
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
    mealId: savedMealId ?? undefined,
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
  const currentTime = getUserLocalTime(user.timezone)
  const { date: targetDate } = parseDateFromMessage(originalMessage)
  const dateLabel = formatDateLabel(targetDate, user.timezone)

  const meals: MealAnalysis[] = await llm.analyzeMeal(messageToAnalyze, history, currentTime)

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
        const results = await saveMeals(supabase, userId, meals, enrichedMeals, originalMessage, targetDate, user.timezone)
        const lastId = results[results.length - 1].mealId
        await saveRecentMealState(supabase, userId, lastId)
        const dailyMacros = await getDailyMacros(supabase, userId, targetDate, user.timezone)
        const { target, macros } = buildMacrosBlock(user, dailyMacros)
        const response = buildReceiptResponse(meals, enrichedMeals, dailyMacros.calories, target, macros, dateLabel)
        return { response, completed: true, mealId: lastId }
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
      } else if (await shouldUseProductFlow(item, supabase)) {
        resolvedItems.push(item)
      } else {
        pendingItems.push({ food: item.food, portion_type: item.portion_type ?? 'bulk' })
      }
    }

    if (pendingItems.length > 0) {
      let resolvedMealId: string | null = null

      if (resolvedItems.length > 0) {
        let enriched: EnrichedItem[]
        try {
          enriched = await enrichItemsWithTaco(supabase, resolvedItems, llm, userId)
        } catch (error) {
          if (error instanceof ProductInteractionRequired) {
            return startProductInteraction(userId, meal, originalMessage, error.pendingInteractions)
          }
          throw error
        }
        const partialAnalysis: MealAnalysis = { ...meal, items: resolvedItems }
        const savedResults = await saveMeals(supabase, userId, [partialAnalysis], [enriched], originalMessage, targetDate, user.timezone)
        resolvedMealId = savedResults[savedResults.length - 1]?.mealId ?? null
        if (resolvedMealId) await saveRecentMealState(supabase, userId, resolvedMealId)
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
    let enriched: EnrichedItem[]
    try {
      enriched = await enrichItemsWithTaco(supabase, meal.items, llm, userId)
    } catch (error) {
      if (error instanceof ProductInteractionRequired) {
        return startProductInteraction(userId, meal, originalMessage, error.pendingInteractions)
      }
      throw error
    }
    enrichedMeals.push(enriched)
  }

  // Backdated log without an explicit meal type → ask which meal. We can't fall back to
  // time-of-day classification here because that reflects NOW, not the backdated day
  // (e.g. yesterday's eggs logged at 3pm would be misfiled as "snack"). Single-meal case only.
  const dateWasBackdated = localDateString(targetDate, user.timezone) !== localDateString(new Date(), user.timezone)
  const explicitMealType = detectExplicitMealType(originalMessage)
  if (dateWasBackdated && !explicitMealType && enrichedMeals.length === 1) {
    await setState(userId, 'awaiting_meal_type', {
      items: enrichedMeals[0].map(enrichedToMealItemInput) as unknown as Record<string, unknown>,
      targetDateISO: targetDate.toISOString(),
      originalMessage,
    })
    return {
      response: 'Esse registro é de outro dia. Em qual refeição? (café da manhã, almoço, lanche, jantar ou ceia)',
      completed: false,
    }
  }

  // Register immediately
  const results = await saveMeals(supabase, userId, meals, enrichedMeals, originalMessage, targetDate, user.timezone)
  const lastResult = results[results.length - 1]
  await saveRecentMealState(supabase, userId, lastResult.mealId)

  const dailyMacros = await getDailyMacros(supabase, userId, targetDate, user.timezone)
  const { target, macros } = buildMacrosBlock(user, dailyMacros)

  // Single meal that was appended → "Somei …" delta + full consolidated meal
  if (results.length === 1 && lastResult.wasAppend) {
    const response = buildConsolidatedMealResponse(lastResult, dailyMacros.calories, target, dateLabel, macros)
    return { response, completed: true, mealId: lastResult.mealId }
  }

  const response = buildReceiptResponse(meals, enrichedMeals, dailyMacros.calories, target, macros, dateLabel)

  return { response, completed: true, mealId: lastResult.mealId }
}
