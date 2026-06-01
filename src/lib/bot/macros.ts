// Shared macro-display helper. Builds the calorie target + (optional) macro block
// passed to formatProgress / formatMealBreakdown so the "P:/G:/C:" line renders
// consistently across every flow.

export interface MacrosBlock {
  consumed: { proteinG: number; fatG: number; carbsG: number }
  target: { proteinG: number; fatG: number; carbsG: number }
}

/**
 * Given the user's daily macro goals and the macros consumed so far, returns:
 *  - target: the daily calorie target (2000 fallback)
 *  - macros: the block to feed into the formatters, or undefined when the user
 *    has no macro goals.
 *
 * Gate uses `!= null` (not truthiness) so a legitimate 0g goal (e.g. keto carbs)
 * still renders the macro line. Mirrors summary.ts.
 */
export function buildMacrosBlock(
  user: {
    dailyCalorieTarget: number | null
    dailyProteinG?: number | null
    dailyFatG?: number | null
    dailyCarbsG?: number | null
  },
  dailyMacros: { proteinG: number; fatG: number; carbsG: number },
): { target: number; macros: MacrosBlock | undefined } {
  const target = user.dailyCalorieTarget ?? 2000
  const hasGoals =
    user.dailyProteinG != null && user.dailyFatG != null && user.dailyCarbsG != null
  const macros: MacrosBlock | undefined = hasGoals
    ? {
        consumed: { proteinG: dailyMacros.proteinG, fatG: dailyMacros.fatG, carbsG: dailyMacros.carbsG },
        target: { proteinG: user.dailyProteinG!, fatG: user.dailyFatG!, carbsG: user.dailyCarbsG! },
      }
    : undefined
  return { target, macros }
}
