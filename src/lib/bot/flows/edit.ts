import type { SupabaseClient } from '@supabase/supabase-js'
import type { ConversationContext } from '@/lib/bot/state'
import { setState, clearState } from '@/lib/bot/state'
import { deleteMeal, getLastMeal, getRecentMeals } from '@/lib/db/queries/meals'
import type { LastMeal, RecentMeal } from '@/lib/db/queries/meals'

// ---------------------------------------------------------------------------
// Patterns
// ---------------------------------------------------------------------------

const DELETE_PATTERN = /apaga(r)?\s*(último|ultimo|last)?/i
const CORRECTION_PATTERN = /^corrigir$/i
const CONFIRM_PATTERN = /^(sim|s|ok|confirma)$/i
const REJECT_PATTERN = /^(não|nao|n|cancelar|cancela)$/i

// ---------------------------------------------------------------------------
// Meal type display labels
// ---------------------------------------------------------------------------

const MEAL_TYPE_LABELS: Record<string, string> = {
  breakfast: 'Café da manhã',
  lunch: 'Almoço',
  snack: 'Lanche',
  dinner: 'Jantar',
  supper: 'Ceia',
}

function mealLabel(mealType: string): string {
  return MEAL_TYPE_LABELS[mealType] ?? mealType
}

// ---------------------------------------------------------------------------
// handleEdit
// ---------------------------------------------------------------------------

export async function handleEdit(
  supabase: SupabaseClient,
  userId: string,
  message: string,
  context: ConversationContext | null,
): Promise<string> {
  const trimmed = message.trim()

  // -------------------------------------------------------------------------
  // Branch: confirmation/rejection of a pending delete
  // -------------------------------------------------------------------------
  if (context?.contextType === 'awaiting_correction') {
    const action = context.contextData.action as string

    if (action === 'delete_confirm') {
      if (CONFIRM_PATTERN.test(trimmed)) {
        return confirmDeleteMeal(supabase, userId, context)
      }

      if (REJECT_PATTERN.test(trimmed)) {
        await clearState(userId)
        return 'Ok, mantive a refeição. Pode me mandar o que quer corrigir!'
      }
    }
  }

  // -------------------------------------------------------------------------
  // Branch: delete last meal
  // -------------------------------------------------------------------------
  if (DELETE_PATTERN.test(trimmed)) {
    return initiateDeleteLastMeal(supabase, userId)
  }

  // -------------------------------------------------------------------------
  // Branch: correction (show recent meals)
  // -------------------------------------------------------------------------
  if (CORRECTION_PATTERN.test(trimmed)) {
    return showRecentMealsForCorrection(supabase, userId)
  }

  // -------------------------------------------------------------------------
  // Default: correction flow
  // -------------------------------------------------------------------------
  return showRecentMealsForCorrection(supabase, userId)
}

// ---------------------------------------------------------------------------
// initiateDeleteLastMeal
// ---------------------------------------------------------------------------

async function initiateDeleteLastMeal(
  supabase: SupabaseClient,
  userId: string,
): Promise<string> {
  const lastMeal: LastMeal | null = await getLastMeal(supabase, userId)

  if (!lastMeal) {
    return 'Não encontrei nenhuma refeição para apagar.'
  }

  const label = mealLabel(lastMeal.mealType)

  await setState(userId, 'awaiting_correction', {
    action: 'delete_confirm',
    mealId: lastMeal.id,
    mealType: lastMeal.mealType,
    totalCalories: lastMeal.totalCalories,
  })

  return `Quer apagar: ${label} (${lastMeal.totalCalories} kcal)? (sim/não)`
}

// ---------------------------------------------------------------------------
// confirmDeleteMeal
// ---------------------------------------------------------------------------

async function confirmDeleteMeal(
  supabase: SupabaseClient,
  userId: string,
  context: ConversationContext,
): Promise<string> {
  const mealId = context.contextData.mealId as string

  await deleteMeal(supabase, mealId)
  await clearState(userId)

  return 'Refeição apagada! ✅'
}

// ---------------------------------------------------------------------------
// showRecentMealsForCorrection
// ---------------------------------------------------------------------------

async function showRecentMealsForCorrection(
  supabase: SupabaseClient,
  userId: string,
): Promise<string> {
  const meals: RecentMeal[] = await getRecentMeals(supabase, userId, 3)

  if (meals.length === 0) {
    return 'Não encontrei nenhuma refeição recente para corrigir.'
  }

  await setState(userId, 'awaiting_correction', {
    action: 'select_meal',
    meals: meals as unknown as Record<string, unknown>[],
  })

  const mealLines = meals.map((meal, idx) => {
    const label = mealLabel(meal.mealType)
    const dateStr = new Date(meal.registeredAt).toLocaleDateString('pt-BR')
    return `${idx + 1}. ${label} — ${meal.totalCalories} kcal (${dateStr})`
  })

  return `Qual refeição quer corrigir?\n\n${mealLines.join('\n')}\n\nDigite o número:`
}
