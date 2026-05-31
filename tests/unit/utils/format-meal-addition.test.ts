import { describe, it, expect } from 'vitest'
import { formatMealAddition, formatProgress, formatMealBreakdown, formatMultiMealBreakdown } from '@/lib/utils/formatters'

const ADDED = [{ food: 'Açaí', quantityGrams: 67, quantityDisplay: null, calories: 80 }]
const FULL = [
  { food: 'Ovo', quantityGrams: 100, quantityDisplay: '2 ovos', calories: 146 },
  { food: 'Queijo mussarela', quantityGrams: 20, quantityDisplay: '1 fatia', calories: 66 },
  { food: 'Açaí', quantityGrams: 67, quantityDisplay: null, calories: 80 },
]

describe('formatMealAddition', () => {
  it('frames as "Somei … ao …" and lists the full meal', () => {
    const msg = formatMealAddition('breakfast', ADDED, FULL, 292, 292, 2168, 'Hoje')
    expect(msg).toContain('Somei')
    expect(msg).toContain('Açaí')
    expect(msg).toContain('Café da manhã agora:')
    expect(msg).toContain('Ovo')
    expect(msg).toContain('Queijo mussarela')
    expect(msg).toContain('Total: 292 kcal')
    expect(msg).toContain('📊 Hoje: 292 / 2168 kcal')
  })

  it('uses the date label for backdated additions', () => {
    const msg = formatMealAddition('dinner', ADDED, FULL, 292, 292, 2168, 'Ontem')
    expect(msg).toContain('📊 Ontem: 292 / 2168 kcal')
  })
})

describe('formatProgress label', () => {
  it('defaults to "Hoje"', () => {
    expect(formatProgress(100, 2000)).toContain('📊 Hoje: 100 / 2000 kcal')
  })
  it('accepts a custom label', () => {
    expect(formatProgress(100, 2000, undefined, 'Ontem')).toContain('📊 Ontem: 100 / 2000 kcal')
  })
})

describe('formatMealBreakdown dateLabel', () => {
  it('passes a custom date label through to the progress line', () => {
    const msg = formatMealBreakdown('breakfast', ADDED, 80, 80, 2000, undefined, 'Ontem')
    expect(msg).toContain('📊 Ontem: 80 / 2000 kcal')
  })
})

describe('formatMultiMealBreakdown dateLabel', () => {
  const MEALS = [
    { mealType: 'breakfast', items: ADDED, total: 80 },
    { mealType: 'lunch', items: FULL, total: 292 },
  ]

  it('defaults to "Hoje" when no date label is given', () => {
    const msg = formatMultiMealBreakdown(MEALS, 372, 2000)
    expect(msg).toContain('📊 Hoje: 372 / 2000 kcal')
  })

  it('passes a custom date label through to the progress line', () => {
    const msg = formatMultiMealBreakdown(MEALS, 372, 2000, undefined, 'Ontem')
    expect(msg).toContain('📊 Ontem:')
    expect(msg).toContain('📊 Ontem: 372 / 2000 kcal')
  })
})
