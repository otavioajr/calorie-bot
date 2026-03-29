import { describe, it, expect } from 'vitest'
import {
  calculateTMB,
  calculateTDEE,
  calculateDailyTarget,
  calculateAll,
  calculateMaxWeight,
  calculateMacros,
  recalcMacrosFromTarget,
} from '@/lib/calc/tdee'

describe('calculateTMB', () => {
  it('returns correct TMB for a male', () => {
    expect(calculateTMB('male', 80, 175, 30)).toBe(1748.75)
  })

  it('returns correct TMB for a female', () => {
    expect(calculateTMB('female', 60, 165, 25)).toBe(1345.25)
  })
})

describe('calculateTDEE', () => {
  const tmb = 1748.75

  it('returns correct TDEE for sedentary', () => {
    expect(calculateTDEE(tmb, 'sedentary')).toBe(2448.25)
  })

  it('returns correct TDEE for light', () => {
    expect(calculateTDEE(tmb, 'light')).toBe(2623.13)
  })

  it('returns correct TDEE for moderate', () => {
    expect(calculateTDEE(tmb, 'moderate')).toBe(2798)
  })

  it('returns correct TDEE for intense', () => {
    expect(calculateTDEE(tmb, 'intense')).toBe(2972.88)
  })

  it('returns correct TDEE for athlete', () => {
    expect(calculateTDEE(tmb, 'athlete')).toBe(3147.75)
  })
})

describe('calculateDailyTarget', () => {
  const tdee = 2098.5

  it('returns TDEE - 500 for lose goal', () => {
    expect(calculateDailyTarget(tdee, 'lose')).toBe(1598.5)
  })

  it('returns TDEE for maintain goal', () => {
    expect(calculateDailyTarget(tdee, 'maintain')).toBe(2098.5)
  })

  it('returns TDEE + 300 for gain goal', () => {
    expect(calculateDailyTarget(tdee, 'gain')).toBe(2398.5)
  })
})

describe('calculateMaxWeight', () => {
  it('returns correct max weight for 175cm', () => {
    expect(calculateMaxWeight(175)).toBe(76.26)
  })

  it('returns correct max weight for 160cm', () => {
    expect(calculateMaxWeight(160)).toBe(63.74)
  })

  it('returns correct max weight for 190cm', () => {
    expect(calculateMaxWeight(190)).toBe(89.89)
  })
})

describe('calculateMacros', () => {
  it('returns correct macros for male with 76kg max weight and 2298 target', () => {
    const result = calculateMacros({ sex: 'male', maxWeightKg: 76, dailyTarget: 2298 })
    expect(result.proteinG).toBe(152)
    expect(result.fatG).toBe(76)
    expect(result.carbsG).toBe(252)
  })

  it('returns correct macros for female with 64kg max weight and 1800 target', () => {
    const result = calculateMacros({ sex: 'female', maxWeightKg: 64, dailyTarget: 1800 })
    expect(result.proteinG).toBe(102)
    expect(result.fatG).toBe(64)
    expect(result.carbsG).toBe(204)
  })

  it('returns 0 carbs when protein + fat exceed target', () => {
    const result = calculateMacros({ sex: 'male', maxWeightKg: 100, dailyTarget: 1000 })
    expect(result.proteinG).toBe(200)
    expect(result.fatG).toBe(100)
    expect(result.carbsG).toBe(0)
  })
})

describe('recalcMacrosFromTarget', () => {
  it('scales all macros proportionally when target increases', () => {
    const result = recalcMacrosFromTarget({ proteinG: 150, fatG: 80, carbsG: 200 }, 2000, 2200)
    expect(result.proteinG).toBe(165)
    expect(result.fatG).toBe(88)
    expect(result.carbsG).toBe(220)
  })

  it('scales all macros proportionally when target decreases', () => {
    const result = recalcMacrosFromTarget({ proteinG: 150, fatG: 80, carbsG: 200 }, 2000, 1800)
    expect(result.proteinG).toBe(135)
    expect(result.fatG).toBe(72)
    expect(result.carbsG).toBe(180)
  })

  it('returns zeros when old target is 0', () => {
    const result = recalcMacrosFromTarget({ proteinG: 150, fatG: 80, carbsG: 200 }, 0, 2000)
    expect(result.proteinG).toBe(0)
    expect(result.fatG).toBe(0)
    expect(result.carbsG).toBe(0)
  })
})

describe('calculateAll', () => {
  it('returns tmb, tdee, dailyTarget, maxWeightKg, and macros', () => {
    const result = calculateAll({
      sex: 'male', weightKg: 80, heightCm: 175, age: 30,
      activityLevel: 'moderate', goal: 'lose',
    })
    expect(result.tmb).toBe(1748.75)
    expect(result.tdee).toBe(2798)
    expect(result.dailyTarget).toBe(2298)
    expect(result.maxWeightKg).toBe(76.26)
    expect(result.proteinG).toBe(153)
    expect(result.fatG).toBe(76)
    expect(result.carbsG).toBe(251)
  })
})
