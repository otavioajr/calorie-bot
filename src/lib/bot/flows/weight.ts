import type { SupabaseClient } from '@supabase/supabase-js'
import type { User } from '@/lib/db/queries/users'
import { updateUser } from '@/lib/db/queries/users'
import { logWeight, getLastWeight } from '@/lib/db/queries/weight'
import { setState, clearState } from '@/lib/bot/state'
import { calculateAll } from '@/lib/calc/tdee'
import type { ActivityLevel, Goal, Sex } from '@/lib/calc/tdee'
import { formatWeightUpdate } from '@/lib/utils/formatters'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const WEIGHT_MIN = 30
const WEIGHT_MAX = 300

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Extracts a numeric weight value from a message string.
 * Handles both "." and "," as decimal separators.
 * Returns null if no valid number is found.
 */
function extractWeight(message: string): number | null {
  // Replace comma decimal separator with period
  const normalized = message.replace(',', '.')

  // Match a number (integer or decimal)
  const match = normalized.match(/\b(\d{2,3}(?:\.\d+)?)\b/)

  if (!match) return null

  return parseFloat(match[1])
}

/**
 * Calculates how many days have passed since a given ISO date string.
 */
function daysSince(isoDate: string): number {
  const then = new Date(isoDate).getTime()
  const now = Date.now()
  return Math.floor((now - then) / (1000 * 60 * 60 * 24))
}

// ---------------------------------------------------------------------------
// handleWeight
// ---------------------------------------------------------------------------

export async function handleWeight(
  supabase: SupabaseClient,
  userId: string,
  message: string,
  user: User,
): Promise<string> {
  const weight = extractWeight(message)

  // No number found — prompt the user
  if (weight === null) {
    await setState(userId, 'awaiting_weight', {})
    return 'Qual seu peso hoje? (em kg)'
  }

  // Validate range
  if (weight < WEIGHT_MIN || weight > WEIGHT_MAX) {
    return `Peso inválido. Por favor, informe um valor entre ${WEIGHT_MIN} e ${WEIGHT_MAX} kg.`
  }

  // Get previous weight before logging the new one
  const previous = await getLastWeight(supabase, userId)

  // Log the new weight
  await logWeight(supabase, userId, weight)

  // Build update payload
  const updatePayload: Partial<Omit<User, 'id' | 'createdAt' | 'updatedAt'>> = {
    weightKg: weight,
  }

  // Recalculate TDEE if not manually overridden and user has all required data
  if (
    !user.calorieTargetManual &&
    user.sex &&
    user.heightCm &&
    user.age &&
    user.activityLevel &&
    user.goal
  ) {
    const { tmb, tdee, dailyTarget } = calculateAll({
      sex: user.sex as Sex,
      weightKg: weight,
      heightCm: user.heightCm,
      age: user.age,
      activityLevel: user.activityLevel as ActivityLevel,
      goal: user.goal as Goal,
    })

    updatePayload.tmb = tmb
    updatePayload.tdee = tdee
    updatePayload.dailyCalorieTarget = dailyTarget
  }

  await updateUser(supabase, userId, updatePayload)

  // Clear the awaiting_weight state so subsequent messages are routed normally
  await clearState(userId)

  // Format the response
  const previousWeight = previous ? previous.weightKg : null
  const days = previous ? daysSince(previous.loggedAt) : null

  return formatWeightUpdate(weight, previousWeight, days)
}
