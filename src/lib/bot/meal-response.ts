import { setState, clearState } from '@/lib/bot/state'
import { formatMealAddition, formatMealBreakdown } from '@/lib/utils/formatters'
import type { LogFoodResult } from '@/lib/bot/flows/meal-log'

/** Sync the recent_meal context to a just-logged meal (or clear it if empty). */
export async function setRecentMealState(userId: string, meal: LogFoodResult['meal']): Promise<void> {
  if (meal.items.length === 0) {
    await clearState(userId)
    return
  }
  await setState(userId, 'recent_meal', {
    mealId: meal.id,
    mealType: meal.mealType,
    items: meal.items.map(i => ({
      id: i.id, foodName: i.foodName, quantityGrams: i.quantityGrams, quantityDisplay: i.quantityDisplay,
      calories: i.calories, proteinG: i.proteinG, carbsG: i.carbsG, fatG: i.fatG,
    })),
  })
}

/** Build the confirmation string from a logFoodToMeal result (delta+meal when appended, else registered). */
export function buildConsolidatedMealResponse(
  logResult: LogFoodResult,
  dailyConsumed: number,
  target: number,
  dateLabel: string,
  macros?: {
    consumed: { proteinG: number; fatG: number; carbsG: number }
    target: { proteinG: number; fatG: number; carbsG: number }
  },
): string {
  const fullItems = logResult.meal.items.map(i => ({
    food: i.foodName, quantityGrams: i.quantityGrams, quantityDisplay: i.quantityDisplay, calories: i.calories,
  }))
  const addedForMsg = logResult.addedItems.map(i => ({
    food: i.foodName, quantityGrams: i.quantityGrams, quantityDisplay: i.quantityDisplay ?? null, calories: i.calories,
  }))
  return logResult.wasAppend
    ? formatMealAddition(logResult.meal.mealType, addedForMsg, fullItems, logResult.meal.totalCalories, dailyConsumed, target, dateLabel, macros)
    : formatMealBreakdown(logResult.meal.mealType, fullItems, logResult.meal.totalCalories, dailyConsumed, target, macros, dateLabel)
}
