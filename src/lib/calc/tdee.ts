export type Sex = 'male' | 'female'
export type ActivityLevel = 'sedentary' | 'light' | 'moderate' | 'intense' | 'athlete'
export type Goal = 'lose' | 'maintain' | 'gain'

const ACTIVITY_FACTORS: Record<ActivityLevel, number> = {
  sedentary: 1.4,
  light: 1.5,
  moderate: 1.6,
  intense: 1.7,
  athlete: 1.8,
}

const GOAL_ADJUSTMENTS: Record<Goal, number> = {
  lose: -500,
  maintain: 0,
  gain: 300,
}

function round2(value: number): number {
  return Math.round(value * 100) / 100
}

export function calculateTMB(
  sex: Sex,
  weightKg: number,
  heightCm: number,
  age: number,
): number {
  const base = 10 * weightKg + 6.25 * heightCm - 5 * age
  const sexAdjustment = sex === 'male' ? 5 : -161
  return round2(base + sexAdjustment)
}

export function calculateTDEE(tmb: number, activityLevel: ActivityLevel): number {
  return round2(tmb * ACTIVITY_FACTORS[activityLevel])
}

export function calculateDailyTarget(tdee: number, goal: Goal): number {
  return round2(tdee + GOAL_ADJUSTMENTS[goal])
}

export function calculateMaxWeight(heightCm: number): number {
  return round2(24.9 * Math.pow(heightCm / 100, 2))
}

export function calculateMacros(params: {
  sex: Sex
  maxWeightKg: number
  dailyTarget: number
}): { proteinG: number; fatG: number; carbsG: number } {
  // Protein: 2g per kg of max weight
  const proteinG = Math.round(params.maxWeightKg * 2)
  // Fat: ~25% of daily calories, 9 kcal/g
  const fatG = Math.round((params.dailyTarget * 0.25) / 9)
  // Carbs: remaining calories, 4 kcal/g
  const proteinCals = proteinG * 4
  const fatCals = fatG * 9
  const carbsG = Math.round((params.dailyTarget - proteinCals - fatCals) / 4)
  return { proteinG, fatG, carbsG }
}

export function calculateAll(params: {
  sex: Sex
  weightKg: number
  heightCm: number
  age: number
  activityLevel: ActivityLevel
  goal: Goal
}): { tmb: number; tdee: number; dailyTarget: number; maxWeightKg: number; proteinG: number; fatG: number; carbsG: number } {
  const tmb = calculateTMB(params.sex, params.weightKg, params.heightCm, params.age)
  const tdee = calculateTDEE(tmb, params.activityLevel)
  const dailyTarget = calculateDailyTarget(tdee, params.goal)
  const maxWeightKg = calculateMaxWeight(params.heightCm)
  const { proteinG, fatG, carbsG } = calculateMacros({ sex: params.sex, maxWeightKg, dailyTarget })
  return { tmb, tdee, dailyTarget, maxWeightKg, proteinG, fatG, carbsG }
}
