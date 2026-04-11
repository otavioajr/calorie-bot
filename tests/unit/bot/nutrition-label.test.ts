import { describe, expect, it } from 'vitest'

import { roundLabelCalories, scaleNutritionLabelItem } from '@/lib/bot/nutrition-label'

describe('roundLabelCalories', () => {
  it('rounds .5 down and .6 up', () => {
    expect(roundLabelCalories(19.5)).toBe(19)
    expect(roundLabelCalories(19.6)).toBe(20)
  })
})

describe('scaleNutritionLabelItem', () => {
  it('rescales calories and macros from the nutrition basis grams to the serving grams', () => {
    const scaled = scaleNutritionLabelItem({
      quantity_grams: 7.5,
      nutrition_basis_grams: 5,
      calories: 13,
      protein: 0,
      carbs: 0.9,
      fat: 0,
    })

    expect(scaled.quantity_grams).toBe(7.5)
    expect(scaled.calories).toBe(19)
    expect(scaled.carbs).toBe(1.4)
  })

  it('preserves exact totals across multiple portions before rounding the final calories', () => {
    const scaled = scaleNutritionLabelItem({
      quantity_grams: 7.5,
      nutrition_basis_grams: 5,
      calories: 13,
      protein: 0,
      carbs: 0.9,
      fat: 0,
    }, 2)

    expect(scaled.quantity_grams).toBe(15)
    expect(scaled.calories).toBe(39)
    expect(scaled.carbs).toBe(2.7)
  })
})
