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
  const heightM = heightCm / 100
  return round2(24.9 * heightM * heightM)
}

export function calculateMacros(params: {
  sex: Sex
  maxWeightKg: number
  dailyTarget: number
}): { proteinG: number; fatG: number; carbsG: number } {
  const proteinMultiplier = params.sex === 'male' ? 2 : 1.6
  const proteinG = Math.round(params.maxWeightKg * proteinMultiplier)
  const fatG = Math.round(params.maxWeightKg)

  const proteinKcal = proteinG * 4
  const fatKcal = fatG * 9
  const remainingKcal = params.dailyTarget - proteinKcal - fatKcal
  const carbsG = Math.max(0, Math.round(remainingKcal / 4))

  return { proteinG, fatG, carbsG }
}

export function recalcMacrosFromTarget(
  currentMacros: { proteinG: number; fatG: number; carbsG: number },
  oldTarget: number,
  newTarget: number,
): { proteinG: number; fatG: number; carbsG: number } {
  if (oldTarget === 0) {
    return { proteinG: 0, fatG: 0, carbsG: 0 }
  }
  const ratio = newTarget / oldTarget
  return {
    proteinG: Math.round(currentMacros.proteinG * ratio),
    fatG: Math.round(currentMacros.fatG * ratio),
    carbsG: Math.round(currentMacros.carbsG * ratio),
  }
}

export function calculateAll(params: {
  sex: Sex
  weightKg: number
  heightCm: number
  age: number
  activityLevel: ActivityLevel
  goal: Goal
}): {
  tmb: number; tdee: number; dailyTarget: number
  maxWeightKg: number; proteinG: number; fatG: number; carbsG: number
} {
  const tmb = calculateTMB(params.sex, params.weightKg, params.heightCm, params.age)
  const tdee = calculateTDEE(tmb, params.activityLevel)
  const dailyTarget = calculateDailyTarget(tdee, params.goal)
  const maxWeightKg = calculateMaxWeight(params.heightCm)
  const { proteinG, fatG, carbsG } = calculateMacros({ sex: params.sex, maxWeightKg, dailyTarget })
  return { tmb, tdee, dailyTarget, maxWeightKg, proteinG, fatG, carbsG }
}
