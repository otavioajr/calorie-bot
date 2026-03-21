import type { SupabaseClient } from '@supabase/supabase-js'
import { getLLMProvider } from '@/lib/llm/index'
import type { MealAnalysis } from '@/lib/llm/schemas/meal-analysis'
import { setState, clearState } from '@/lib/bot/state'
import type { ConversationContext } from '@/lib/bot/state'
import { createMeal, getDailyCalories } from '@/lib/db/queries/meals'
import { formatMealBreakdown, formatProgress } from '@/lib/utils/formatters'

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
// Helpers
// ---------------------------------------------------------------------------

function totalCalories(analysis: MealAnalysis): number {
  return Math.round(analysis.items.reduce((sum, item) => sum + item.calories, 0))
}

/**
 * Format a confirmation message showing the meal breakdown and asking the user
 * to confirm or correct.
 */
function buildConfirmationResponse(
  analysis: MealAnalysis,
  dailyConsumedSoFar: number,
  dailyTarget: number,
): string {
  const items = analysis.items.map((item) => ({
    food: item.food,
    quantityGrams: item.quantity_grams,
    calories: item.calories,
  }))

  const total = totalCalories(analysis)

  return formatMealBreakdown(
    analysis.meal_type,
    items,
    total,
    dailyConsumedSoFar,
    dailyTarget,
  )
}

// ---------------------------------------------------------------------------
// Main handler
// ---------------------------------------------------------------------------

export async function handleMealLog(
  supabase: SupabaseClient,
  userId: string,
  message: string,
  user: { calorieMode: string; dailyCalorieTarget: number | null },
  context: ConversationContext | null,
): Promise<MealLogResult> {
  const trimmed = message.trim()

  // -------------------------------------------------------------------------
  // Branch: user is responding to a confirmation prompt
  // -------------------------------------------------------------------------
  if (context?.contextType === 'awaiting_confirmation') {
    if (CONFIRM_PATTERN.test(trimmed)) {
      return handleConfirmation(supabase, userId, context, user)
    }

    if (REJECT_PATTERN.test(trimmed)) {
      return handleRejection(userId)
    }

    // Unknown response — treat as a new meal message (fall through below)
  }

  // -------------------------------------------------------------------------
  // Branch: user is providing a clarification
  // -------------------------------------------------------------------------
  if (context?.contextType === 'awaiting_clarification') {
    const originalMessage = context.contextData.originalMessage as string
    const combined = `${originalMessage}\n${trimmed}`
    return analyzeAndConfirm(supabase, userId, combined, trimmed, user)
  }

  // -------------------------------------------------------------------------
  // Default branch: new meal message — analyze with LLM
  // -------------------------------------------------------------------------
  return analyzeAndConfirm(supabase, userId, trimmed, trimmed, user)
}

// ---------------------------------------------------------------------------
// Confirmation handler
// ---------------------------------------------------------------------------

async function handleConfirmation(
  supabase: SupabaseClient,
  userId: string,
  context: ConversationContext,
  user: { dailyCalorieTarget: number | null },
): Promise<MealLogResult> {
  const analysis = context.contextData.mealAnalysis as MealAnalysis
  const originalMessage = context.contextData.originalMessage as string

  // Save to DB
  await createMeal(supabase, {
    userId,
    mealType: analysis.meal_type,
    totalCalories: totalCalories(analysis),
    originalMessage,
    llmResponse: analysis as unknown as Record<string, unknown>,
    items: analysis.items.map((item) => ({
      foodName: item.food,
      quantityGrams: item.quantity_grams,
      calories: item.calories,
      proteinG: item.protein,
      carbsG: item.carbs,
      fatG: item.fat,
      source: item.quantity_source,
      tacoId: item.taco_id ?? undefined,
    })),
  })

  await clearState(userId)

  // Get daily progress
  const dailyConsumed = await getDailyCalories(supabase, userId)
  const target = user.dailyCalorieTarget ?? 2000

  const progressLine = formatProgress(dailyConsumed, target)

  return {
    response: `Refeição registrada! ✅\n\n${progressLine}`,
    completed: true,
  }
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
// Analyze meal with LLM and show confirmation
// ---------------------------------------------------------------------------

async function analyzeAndConfirm(
  supabase: SupabaseClient,
  userId: string,
  messageToAnalyze: string,
  originalMessage: string,
  user: { calorieMode: string; dailyCalorieTarget: number | null },
): Promise<MealLogResult> {
  const llm = getLLMProvider()

  // Pass mode as CalorieMode — the LLM provider accepts string-typed CalorieMode
  const calorieMode = user.calorieMode as Parameters<typeof llm.analyzeMeal>[1]

  const result: MealAnalysis = await llm.analyzeMeal(messageToAnalyze, calorieMode, undefined)

  // Clarification required
  if (result.needs_clarification) {
    await setState(userId, 'awaiting_clarification', {
      originalMessage,
    })

    return {
      response: result.clarification_question ?? 'Pode me dar mais detalhes sobre a refeição?',
      completed: false,
    }
  }

  // Unknown items
  if (result.unknown_items.length > 0) {
    await setState(userId, 'awaiting_clarification', {
      originalMessage,
    })

    const itemList = result.unknown_items.join(', ')
    return {
      response: `Não consegui identificar: ${itemList}. Pode me dizer as calorias ou quantas gramas?`,
      completed: false,
    }
  }

  // Happy path — show breakdown and ask for confirmation
  const dailyConsumed = await getDailyCalories(supabase, userId)
  const target = user.dailyCalorieTarget ?? 2000

  const response = buildConfirmationResponse(result, dailyConsumed, target)

  await setState(userId, 'awaiting_confirmation', {
    mealAnalysis: result as unknown as Record<string, unknown>,
    originalMessage,
  })

  return { response, completed: false }
}
