import type { SupabaseClient } from '@supabase/supabase-js'
import { getLLMProvider } from '@/lib/llm/index'
import type { MealAnalysis, MealItem } from '@/lib/llm/schemas/meal-analysis'
import { setState, clearState } from '@/lib/bot/state'
import type { ConversationContext } from '@/lib/bot/state'
import { createMeal, getDailyCalories } from '@/lib/db/queries/meals'
import { formatMealBreakdown, formatMultiMealBreakdown, formatProgress, formatDecompositionFeedback } from '@/lib/utils/formatters'
import { getRecentMessages } from '@/lib/db/queries/message-history'
import { fuzzyMatchTacoMultiple, calculateMacros } from '@/lib/db/queries/taco'
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
// Confirmation keywords
// ---------------------------------------------------------------------------

const CONFIRM_PATTERN = /^(sim|s|ok|confirma)$/i
const REJECT_PATTERN = /^(corrigir|não|nao|n)$/i

// ---------------------------------------------------------------------------
// Types for enriched items
// ---------------------------------------------------------------------------

interface EnrichedItem {
  food: string
  quantityGrams: number
  calories: number
  protein: number
  carbs: number
  fat: number
  source: string
  tacoId?: number
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function totalCaloriesFromEnriched(items: EnrichedItem[]): number {
  return Math.round(items.reduce((sum, item) => sum + item.calories, 0))
}

function getMealsFromContext(contextData: Record<string, unknown>): { meals: MealAnalysis[]; enrichedMeals: EnrichedItem[][] } {
  const meals = (contextData.mealAnalyses ?? (contextData.mealAnalysis ? [contextData.mealAnalysis] : [])) as MealAnalysis[]
  const enrichedMeals = (contextData.enrichedMeals ?? []) as EnrichedItem[][]
  return { meals, enrichedMeals }
}

function buildConfirmationResponse(
  meals: MealAnalysis[],
  enrichedMeals: EnrichedItem[][],
  dailyConsumedSoFar: number,
  dailyTarget: number,
): string {
  if (meals.length === 1 && enrichedMeals.length === 1) {
    const analysis = meals[0]
    const items = enrichedMeals[0]
    const total = totalCaloriesFromEnriched(items)

    return formatMealBreakdown(
      analysis.meal_type,
      items.map(i => ({ food: i.food, quantityGrams: i.quantityGrams, calories: i.calories })),
      total,
      dailyConsumedSoFar,
      dailyTarget,
    )
  }

  const mealSections = meals.map((analysis, idx) => ({
    mealType: analysis.meal_type,
    items: enrichedMeals[idx].map(i => ({ food: i.food, quantityGrams: i.quantityGrams, calories: i.calories })),
    total: totalCaloriesFromEnriched(enrichedMeals[idx]),
  }))

  return formatMultiMealBreakdown(mealSections, dailyConsumedSoFar, dailyTarget)
}

// ---------------------------------------------------------------------------
// TACO enrichment — the core new logic
// ---------------------------------------------------------------------------

async function enrichItemsWithTaco(
  supabase: SupabaseClient,
  items: MealItem[],
  llm: ReturnType<typeof getLLMProvider>,
  userId: string,
  phone?: string,
): Promise<EnrichedItem[]> {
  // Step 1: Batch fuzzy match all items against TACO
  const foodNames = items.map(i => i.food)
  const tacoMatches = await fuzzyMatchTacoMultiple(supabase, foodNames)

  const enriched: EnrichedItem[] = []
  const needsDecomposition: { item: MealItem; index: number }[] = []

  for (let i = 0; i < items.length; i++) {
    const item = items[i]
    const tacoMatch = tacoMatches.get(item.food.toLowerCase())

    if (tacoMatch) {
      // Direct TACO match
      const macros = calculateMacros(tacoMatch, item.quantity_grams)
      enriched.push({
        food: item.food,
        quantityGrams: item.quantity_grams,
        calories: macros.calories,
        protein: macros.protein,
        carbs: macros.carbs,
        fat: macros.fat,
        source: 'taco',
        tacoId: tacoMatch.id,
      })
    } else if (item.calories !== null && item.calories !== undefined && item.calories > 0) {
      // User provided explicit macros
      enriched.push({
        food: item.food,
        quantityGrams: item.quantity_grams,
        calories: item.calories,
        protein: item.protein ?? 0,
        carbs: item.carbs ?? 0,
        fat: item.fat ?? 0,
        source: 'user_provided',
      })
    } else {
      needsDecomposition.push({ item, index: i })
      enriched.push(null as unknown as EnrichedItem) // placeholder
    }
  }

  // Step 2: Decompose items that didn't match TACO
  if (needsDecomposition.length > 0 && phone) {
    const feedbackNames = needsDecomposition.map(d => d.item.food)
    const feedbackMsg = formatDecompositionFeedback(feedbackNames)
    await sendTextMessage(phone, feedbackMsg)
  }

  for (const { item, index } of needsDecomposition) {
    try {
      const ingredients = await llm.decomposeMeal(item.food, item.quantity_grams)

      // Match each ingredient against TACO
      const ingredientNames = ingredients.map(ig => ig.food)
      const ingredientMatches = await fuzzyMatchTacoMultiple(supabase, ingredientNames)

      let totalCal = 0, totalProt = 0, totalCarbs = 0, totalFat = 0

      for (const ig of ingredients) {
        const match = ingredientMatches.get(ig.food.toLowerCase())
        if (match) {
          const macros = calculateMacros(match, ig.quantity_grams)
          totalCal += macros.calories
          totalProt += macros.protein
          totalCarbs += macros.carbs
          totalFat += macros.fat
        } else {
          // Ingredient not in TACO — ask LLM for estimate
          try {
            const fallbackMeals = await llm.analyzeMeal(`${ig.quantity_grams}g de ${ig.food}`)
            const fallbackItem = fallbackMeals[0]?.items[0]
            if (fallbackItem) {
              totalCal += fallbackItem.calories ?? 0
              totalProt += fallbackItem.protein ?? 0
              totalCarbs += fallbackItem.carbs ?? 0
              totalFat += fallbackItem.fat ?? 0
            }
          } catch {
            // Silently skip
          }
        }
      }

      enriched[index] = {
        food: item.food,
        quantityGrams: item.quantity_grams,
        calories: Math.round(totalCal),
        protein: Math.round(totalProt * 10) / 10,
        carbs: Math.round(totalCarbs * 10) / 10,
        fat: Math.round(totalFat * 10) / 10,
        source: totalCal > 0 ? 'taco_decomposed' : 'approximate',
      }
    } catch {
      // Decomposition failed
      enriched[index] = {
        food: item.food,
        quantityGrams: item.quantity_grams,
        calories: 0,
        protein: 0,
        carbs: 0,
        fat: 0,
        source: 'approximate',
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
  user: { calorieMode: string; dailyCalorieTarget: number | null; phone?: string },
  context: ConversationContext | null,
): Promise<MealLogResult> {
  const trimmed = message.trim()

  if (context?.contextType === 'awaiting_confirmation') {
    if (CONFIRM_PATTERN.test(trimmed)) {
      return handleConfirmation(supabase, userId, context, user)
    }
    if (REJECT_PATTERN.test(trimmed)) {
      return handleRejection(userId)
    }
  }

  // Branch: user is selecting from history matches
  if (context?.contextType === 'awaiting_history_selection') {
    return handleHistorySelection(supabase, userId, trimmed, context, user)
  }

  if (context?.contextType === 'awaiting_clarification') {
    const originalMessage = context.contextData.originalMessage as string
    const combined = `${originalMessage}\n${trimmed}`
    return analyzeAndConfirm(supabase, userId, combined, trimmed, user)
  }

  return analyzeAndConfirm(supabase, userId, trimmed, trimmed, user)
}

// ---------------------------------------------------------------------------
// Confirmation handler
// ---------------------------------------------------------------------------

async function handleConfirmation(
  supabase: SupabaseClient,
  userId: string,
  context: ConversationContext,
  user: { calorieMode: string; dailyCalorieTarget: number | null },
): Promise<MealLogResult> {
  const { meals, enrichedMeals } = getMealsFromContext(context.contextData)
  const originalMessage = context.contextData.originalMessage as string

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

  await clearState(userId)

  const dailyConsumed = await getDailyCalories(supabase, userId)
  const target = user.dailyCalorieTarget ?? 2000
  const progressLine = formatProgress(dailyConsumed, target)
  const label = meals.length > 1 ? 'Refeições registradas' : 'Refeição registrada'

  return { response: `${label}! ✅\n\n${progressLine}`, completed: true }
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

  const dailyConsumed = await getDailyCalories(supabase, userId)
  const target = user.dailyCalorieTarget ?? 2000
  const response = buildConfirmationResponse(meals, enrichedMeals, dailyConsumed, target)

  await setState(userId, 'awaiting_confirmation', {
    mealAnalyses: meals as unknown as Record<string, unknown>,
    enrichedMeals: enrichedMeals as unknown as Record<string, unknown>,
    originalMessage,
  })

  return { response, completed: false }
}

// ---------------------------------------------------------------------------
// Rejection handler
// ---------------------------------------------------------------------------

async function handleRejection(userId: string): Promise<MealLogResult> {
  await clearState(userId)
  return {
    response: 'Ok! O que quer corrigir? Pode me mandar a refeição novamente com as correções.',
    completed: false,
  }
}

// ---------------------------------------------------------------------------
// Analyze meal with LLM, enrich with TACO, show confirmation
// ---------------------------------------------------------------------------

async function analyzeAndConfirm(
  supabase: SupabaseClient,
  userId: string,
  messageToAnalyze: string,
  originalMessage: string,
  user: { calorieMode: string; dailyCalorieTarget: number | null; phone?: string },
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
        // Single match — use it directly
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
        const dailyConsumed = await getDailyCalories(supabase, userId)
        const target = user.dailyCalorieTarget ?? 2000
        const response = buildConfirmationResponse(meals, enrichedMeals, dailyConsumed, target)
        await setState(userId, 'awaiting_confirmation', {
          mealAnalyses: meals as unknown as Record<string, unknown>,
          enrichedMeals: enrichedMeals as unknown as Record<string, unknown>,
          originalMessage,
        })
        return { response, completed: false }
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

  // Enrich all meal items with TACO data
  const enrichedMeals: EnrichedItem[][] = []
  for (const meal of meals) {
    const enriched = await enrichItemsWithTaco(supabase, meal.items, llm, userId, user.phone)
    enrichedMeals.push(enriched)
  }

  // Show breakdown and ask for confirmation
  const dailyConsumed = await getDailyCalories(supabase, userId)
  const target = user.dailyCalorieTarget ?? 2000

  const response = buildConfirmationResponse(meals, enrichedMeals, dailyConsumed, target)

  await setState(userId, 'awaiting_confirmation', {
    mealAnalyses: meals as unknown as Record<string, unknown>,
    enrichedMeals: enrichedMeals as unknown as Record<string, unknown>,
    originalMessage,
  })

  return { response, completed: false }
}
