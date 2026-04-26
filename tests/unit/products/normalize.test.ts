import { describe, expect, it } from 'vitest'

import {
  convertLabelToPer100g,
  normalizeBrand,
  normalizeProductName,
} from '@/lib/products/normalize'

describe('normalizeProductName', () => {
  it('lowercases, removes accents, trims, and collapses spaces without TACO synonyms', () => {
    expect(normalizeProductName('  Arroz   Branco Café  ')).toBe('arroz branco cafe')
    expect(normalizeProductName('arroz branco')).toBe('arroz branco')
  })
})

describe('normalizeBrand', () => {
  it('normalizes brand text with the same rules as product names', () => {
    expect(normalizeBrand('  MÃE   TERRA  ')).toBe('mae terra')
  })

  it('returns null for empty values', () => {
    expect(normalizeBrand(null)).toBeNull()
    expect(normalizeBrand(undefined)).toBeNull()
    expect(normalizeBrand('   ')).toBeNull()
  })
})

describe('convertLabelToPer100g', () => {
  it('converts nutrition values from a 30g serving to 100g', () => {
    expect(
      convertLabelToPer100g({
        servingSizeG: 30,
        calories: 120,
        protein: 3,
        carbs: 18,
        fat: 4.5,
      }),
    ).toEqual({
      caloriesPer100g: 400,
      proteinPer100g: 10,
      carbsPer100g: 60,
      fatPer100g: 15,
    })
  })
})
