import { describe, it, expect } from 'vitest'
import { computeRecipeMacros } from '@/lib/recipes/compute'
import type { TacoFood } from '@/lib/db/queries/taco'

const RICE: TacoFood = {
  id: 1,
  foodName: 'arroz cozido',
  category: null,
  caloriesPer100g: 124,
  proteinPer100g: 2.5,
  carbsPer100g: 26,
  fatPer100g: 0.2,
  fiberPer100g: 1.6,
  foodBase: 'arroz',
  foodVariant: 'cozido',
  isDefault: true,
}

const BEANS: TacoFood = {
  id: 2,
  foodName: 'feijao cozido',
  category: null,
  caloriesPer100g: 76,
  proteinPer100g: 4.8,
  carbsPer100g: 13.6,
  fatPer100g: 0.5,
  fiberPer100g: 8.5,
  foodBase: 'feijao',
  foodVariant: 'cozido',
  isDefault: true,
}

describe('computeRecipeMacros', () => {
  it('aggregates TACO-sourced ingredients and divides by servings', () => {
    const result = computeRecipeMacros({
      ingredients: [
        { foodName: 'arroz', quantityGrams: 200, source: 'taco', tacoFood: RICE, displayOrder: 1 },
        { foodName: 'feijao', quantityGrams: 100, source: 'taco', tacoFood: BEANS, displayOrder: 2 },
      ],
      totalWeightGrams: 300,
      servings: 2,
    })

    // 200g arroz: 248 kcal, 5g P, 52g C, 0.4g F
    // 100g feijao: 76 kcal, 4.8g P, 13.6g C, 0.5g F
    expect(result.totalCalories).toBeCloseTo(324, 1)
    expect(result.totalProteinG).toBeCloseTo(9.8, 1)
    expect(result.totalCarbsG).toBeCloseTo(65.6, 1)
    expect(result.totalFatG).toBeCloseTo(0.9, 1)

    expect(result.perServingCalories).toBeCloseTo(162, 1)
    expect(result.perServingProteinG).toBeCloseTo(4.9, 1)
    expect(result.weightPerServingGrams).toBeCloseTo(150, 1)
  })

  it('uses label_override when source is user_label', () => {
    const result = computeRecipeMacros({
      ingredients: [
        {
          foodName: 'creme de leite',
          quantityGrams: 200,
          source: 'user_label',
          labelOverride: {
            kcalPer100g: 195,
            proteinPer100g: 2.5,
            carbsPer100g: 4,
            fatPer100g: 19,
          },
          displayOrder: 1,
        },
      ],
      totalWeightGrams: 200,
      servings: 1,
    })

    expect(result.totalCalories).toBeCloseTo(390, 1)
    expect(result.totalFatG).toBeCloseTo(38, 1)
  })

  it('mixes TACO and label_override ingredients', () => {
    const result = computeRecipeMacros({
      ingredients: [
        { foodName: 'arroz', quantityGrams: 100, source: 'taco', tacoFood: RICE, displayOrder: 1 },
        {
          foodName: 'creme de leite',
          quantityGrams: 100,
          source: 'user_label',
          labelOverride: { kcalPer100g: 195, proteinPer100g: 2.5, carbsPer100g: 4, fatPer100g: 19 },
          displayOrder: 2,
        },
      ],
      totalWeightGrams: 200,
      servings: 2,
    })

    expect(result.totalCalories).toBeCloseTo(124 + 195, 1)
    expect(result.weightPerServingGrams).toBeCloseTo(100, 1)
  })

  it('handles fractional servings (decimal)', () => {
    const result = computeRecipeMacros({
      ingredients: [
        { foodName: 'arroz', quantityGrams: 100, source: 'taco', tacoFood: RICE, displayOrder: 1 },
      ],
      totalWeightGrams: 100,
      servings: 2.5,
    })
    expect(result.perServingCalories).toBeCloseTo(124 / 2.5, 1)
    expect(result.weightPerServingGrams).toBeCloseTo(40, 1)
  })
})
