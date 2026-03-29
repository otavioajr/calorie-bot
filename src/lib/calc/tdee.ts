export type Sex = 'male' | 'female'
export type ActivityLevel = 'sedentary' | 'light' | 'moderate' | 'intense' | 'athlete'
export type Goal = 'lose' | 'maintain' | 'gain'

const ACTIVITY_FACTORS: Record<ActivityLevel, number> = {
  sedentary: 1.2,
  light: 1.375,
  moderate: 1.55,
  intense: 1.725,
  athlete: 1.9,
}

const GOAL_ADJUSTMENTS: Record<Goal, number> = {
  lose: -500,
  maintain: 0,
  gain: 300,
}

// Approximate max healthy weight (BMI 24.9) in kg for a given height in cm
function calculateMaxWeightKg(heightCm: number): number {
  const heightM = heightCm / 100
  return Math.round(24.9 * heightM * heightM * 10) / 10
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

export function calculateMacros(
  dailyTarget: number,
  weightKg: number,
): { proteinG: number; fatG: number; carbsG: number } {
  // Protein: 1.8g per kg of body weight
  const proteinG = Math.round(weightKg * 1.8)
  // Fat: 25% of daily calories (1g fat = 9 kcal)
  const fatG = Math.round((dailyTarget * 0.25) / 9)
  // Carbs: remaining calories (1g carbs = 4 kcal)
  const carbsG = Math.max(0, Math.round((dailyTarget - proteinG * 4 - fatG * 9) / 4))
  return { proteinG, fatG, carbsG }
}

export function calculateAll(params: {
  sex: Sex
  weightKg: number
  heightCm: number
  age: number
  activityLevel: ActivityLevel
  goal: Goal
}): {
  tmb: number
  tdee: number
  dailyTarget: number
  maxWeightKg: number
  proteinG: number
  fatG: number
  carbsG: number
} {
  const tmb = calculateTMB(params.sex, params.weightKg, params.heightCm, params.age)
  const tdee = calculateTDEE(tmb, params.activityLevel)
  const dailyTarget = calculateDailyTarget(tdee, params.goal)
  const maxWeightKg = calculateMaxWeightKg(params.heightCm)
  const { proteinG, fatG, carbsG } = calculateMacros(dailyTarget, params.weightKg)
  return { tmb, tdee, dailyTarget, maxWeightKg, proteinG, fatG, carbsG }
}
