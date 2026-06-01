import { describe, it, expect } from 'vitest'
import { buildMacrosBlock } from '@/lib/bot/macros'

const DAILY = { proteinG: 50, fatG: 20, carbsG: 100 }

describe('buildMacrosBlock', () => {
  it('returns the calorie target and a macros block when all 3 macro goals are set', () => {
    const { target, macros } = buildMacrosBlock(
      { dailyCalorieTarget: 1800, dailyProteinG: 120, dailyFatG: 60, dailyCarbsG: 200 },
      DAILY,
    )
    expect(target).toBe(1800)
    expect(macros).toEqual({
      consumed: { proteinG: 50, fatG: 20, carbsG: 100 },
      target: { proteinG: 120, fatG: 60, carbsG: 200 },
    })
  })

  it('falls back to 2000 kcal when dailyCalorieTarget is null', () => {
    const { target } = buildMacrosBlock(
      { dailyCalorieTarget: null, dailyProteinG: 120, dailyFatG: 60, dailyCarbsG: 200 },
      DAILY,
    )
    expect(target).toBe(2000)
  })

  it('returns macros=undefined when any macro goal is missing (null)', () => {
    const { macros } = buildMacrosBlock(
      { dailyCalorieTarget: 1800, dailyProteinG: 120, dailyFatG: null, dailyCarbsG: 200 },
      DAILY,
    )
    expect(macros).toBeUndefined()
  })

  it('returns macros=undefined when goals are undefined (user without macros)', () => {
    const { macros } = buildMacrosBlock({ dailyCalorieTarget: 1800 }, DAILY)
    expect(macros).toBeUndefined()
  })

  it('keeps the macros block when a goal is a legitimate 0 (gate uses != null, not truthiness)', () => {
    const { macros } = buildMacrosBlock(
      { dailyCalorieTarget: 1800, dailyProteinG: 150, dailyFatG: 130, dailyCarbsG: 0 },
      DAILY,
    )
    expect(macros).toEqual({
      consumed: { proteinG: 50, fatG: 20, carbsG: 100 },
      target: { proteinG: 150, fatG: 130, carbsG: 0 },
    })
  })
})
