import { describe, it, expect } from 'vitest'
import {
  calculateTMB,
  calculateTDEE,
  calculateDailyTarget,
  calculateAll,
} from '@/lib/calc/tdee'

describe('calculateTMB', () => {
  it('returns correct TMB for a male', () => {
    // 10*80 + 6.25*175 - 5*30 + 5 = 800 + 1093.75 - 150 + 5 = 1748.75
    expect(calculateTMB('male', 80, 175, 30)).toBe(1748.75)
  })

  it('returns correct TMB for a female', () => {
    // 10*60 + 6.25*165 - 5*25 - 161 = 600 + 1031.25 - 125 - 161 = 1345.25
    expect(calculateTMB('female', 60, 165, 25)).toBe(1345.25)
  })
})

describe('calculateTDEE', () => {
  const tmb = 1748.75

  it('returns correct TDEE for sedentary', () => {
    // 1748.75 * 1.4 = 2448.25
    expect(calculateTDEE(tmb, 'sedentary')).toBe(2448.25)
  })

  it('returns correct TDEE for light', () => {
    // 1748.75 * 1.5 = 2623.125 → 2623.13
    expect(calculateTDEE(tmb, 'light')).toBe(2623.13)
  })

  it('returns correct TDEE for moderate', () => {
    // 1748.75 * 1.6 = 2798.0
    expect(calculateTDEE(tmb, 'moderate')).toBe(2798)
  })

  it('returns correct TDEE for intense', () => {
    // 1748.75 * 1.7 = 2972.875 → 2972.88
    expect(calculateTDEE(tmb, 'intense')).toBe(2972.88)
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

describe('calculateAll', () => {
  it('returns correct tmb, tdee, and dailyTarget for integration case', () => {
    // Male, 80kg, 175cm, 30yo, moderate, lose
    // tmb: 1748.75, tdee: 1748.75 * 1.6 = 2798, dailyTarget: 2798 - 500 = 2298
    const result = calculateAll({
      sex: 'male',
      weightKg: 80,
      heightCm: 175,
      age: 30,
      activityLevel: 'moderate',
      goal: 'lose',
    })

    expect(result.tmb).toBe(1748.75)
    expect(result.tdee).toBe(2798)
    expect(result.dailyTarget).toBe(2298)
  })
})
