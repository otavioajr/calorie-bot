import type { SupabaseClient } from '@supabase/supabase-js'
import { getLLMProvider } from '@/lib/llm/index'
import type { MealAnalysis, MealItem } from '@/lib/llm/schemas/meal-analysis'
import { setState, clearState } from '@/lib/bot/state'
import type { ConversationContext } from '@/lib/bot/state'
import { createMeal, getDailyCalories, getDailyMacros } from '@/lib/db/queries/meals'
import { formatMealBreakdown, formatMultiMealBreakdown, formatProgress, formatSearchFeedback, formatDefaultNotice } from '@/lib/utils/formatters'
import { getRecentMessages } from '@/lib/db/queries/message-history'
import { fuzzyMatchTacoMultiple, calculateMacros, matchTacoByBase, getLearnedDefault, recordTacoUsage } from '@/lib/db/queries/taco'
import type { TacoFood } from '@/lib/db/queries/taco'
import { sendTextMessage } from '@/lib/whatsapp/client'
import { searchMealHistory, HistoryMatch } from '@/lib/db/queries/meal-history-search'

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

async function resolveByBase(
  supabase: SupabaseClient,
  foodName: string,
): Promise<{ match: TacoFood; usedDefault: boolean } | null> {
  // Try matching the food name as a base (e.g., "banana" → all banana variants)
  const variants = await matchTacoByBase(supabase, foodName)
  if (variants.length === 0) return null

  // Single variant — no ambiguity
  if (variants.length === 1) {
    return { match: variants[0], usedDefault: false }
  }

  // Check for learned default first (community preference)
  const learned = await getLearnedDefault(supabase, foodName)
  if (learned) {
    const learnedFood = variants.find(v => v.id === learned.tacoId)
    if (learnedFood) {
      return { match: learnedFood, usedDefault: true }
    }
  }

  // Fall back to manual default (is_default = true)
  const manualDefault = variants.find(v => v.isDefault)
  if (manualDefault) {
    return { match: manualDefault, usedDefault: true }
  }

  // No default set — use first result
  return { match: variants[0], usedDefault: true }
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

async function enrichItemsWithTaco(
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

    if (item.calories !== null && item.calories !== undefined && item.calories > 0) {
      // User provided explicit macros — use as-is
      enriched.push({
        food: item.food,
        quantityGrams: item.quantity_grams,
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
      const macros = calculateMacros(baseResult.match, item.quantity_grams)
      enriched.push({
        food: item.food,
        quantityGrams: item.quantity_grams,
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

  // Step 2: Fuzzy match for items that didn't match any base
  const needsDecomposition: { item: MealItem; index: number }[] = []

  if (needsFuzzy.length > 0) {
    const fuzzyNames = needsFuzzy.map(d => d.item.food)
    const tacoMatches = await fuzzyMatchTacoMultiple(supabase, fuzzyNames)

    for (const { item, index } of needsFuzzy) {
      const tacoMatch = tacoMatches.get(item.food.toLowerCase())
      if (tacoMatch) {
        const macros = calculateMacros(tacoMatch, item.quantity_grams)
        enriched[index] = {
          food: item.food,
          quantityGrams: item.quantity_grams,
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
    try {
      const ingredients = await llm.decomposeMeal(item.food, item.quantity_grams)

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
              )
              const estimate = JSON.parse(raw.trim())
              totalCal += estimate.calories ?? 0
              totalProt += estimate.protein ?? 0
              totalCarbs += estimate.carbs ?? 0
              totalFat += estimate.fat ?? 0
            } catch {
              // Silently skip
            }
          }
        }
      }

      enriched[index] = {
        food: item.food,
        quantityGrams: item.quantity_grams,
        quantityDisplay: item.quantity_display,
        calories: Math.round(totalCal),
        protein: Math.round(totalProt * 10) / 10,
        carbs: Math.round(totalCarbs * 10) / 10,
        fat: Math.round(totalFat * 10) / 10,
        source: totalCal > 0 ? 'taco_decomposed' : 'approximate',
      }
    } catch {
      // Decomposition failed entirely — try a direct LLM estimate
      try {
        const raw = await llm.chat(
          `Estime calorias e macronutrientes para ${item.quantity_grams}g de "${item.food}". Responda APENAS com JSON: {"calories":number,"protein":number,"carbs":number,"fat":number} (valores para ${item.quantity_grams}g, não por 100g).`,
          'Você é um especialista em nutrição. Responda APENAS com JSON válido.',
        )
        const estimate = JSON.parse(raw.trim())
        enriched[index] = {
          food: item.food,
          quantityGrams: item.quantity_grams,
          quantityDisplay: item.quantity_display,
          calories: Math.round(estimate.calories ?? 0),
          protein: Math.round((estimate.protein ?? 0) * 10) / 10,
          carbs: Math.round((estimate.carbs ?? 0) * 10) / 10,
          fat: Math.round((estimate.fat ?? 0) * 10) / 10,
          source: 'approximate',
        }
      } catch {
        enriched[index] = {
          food: item.food,
          quantityGrams: item.quantity_grams,
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
  },
  context: ConversationContext | null,
): Promise<MealLogResult> {
  const trimmed = message.trim()

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
  user: { calorieMode: string; dailyCalorieTarget: number | null },
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

  const dailyConsumed = await getDailyCalories(supabase, userId)
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
        const dailyConsumed = await getDailyCalories(supabase, userId)
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

  // Enrich all meal items with TACO data
  const enrichedMeals: EnrichedItem[][] = []
  for (const meal of meals) {
    const enriched = await enrichItemsWithTaco(supabase, meal.items, llm, userId)
    enrichedMeals.push(enriched)
  }

  // Register immediately
  await saveMeals(supabase, userId, meals, enrichedMeals, originalMessage)

  const dailyConsumed = await getDailyCalories(supabase, userId)
  const target = user.dailyCalorieTarget ?? 2000

  const response = buildReceiptResponse(meals, enrichedMeals, dailyConsumed, target)

  return { response, completed: true }
}
