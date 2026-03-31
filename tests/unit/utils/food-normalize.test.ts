import { describe, it, expect } from 'vitest'
import { normalizeFoodNameForTaco, applySynonyms, tokenMatchScore } from '@/lib/utils/food-normalize'

describe('normalizeFoodNameForTaco', () => {
  it('lowercases and removes accents', () => {
    expect(normalizeFoodNameForTaco('Café com Leite')).toBe('cafe com leite')
  })

  it('normalizes multiple spaces', () => {
    expect(normalizeFoodNameForTaco('arroz   branco')).toBe('arroz branco')
  })

  it('trims whitespace', () => {
    expect(normalizeFoodNameForTaco('  banana  ')).toBe('banana')
  })
})

describe('applySynonyms', () => {
  it('normalizes "semi desnatado" to "semidesnatado"', () => {
    expect(applySynonyms('leite semi desnatado')).toBe('leite semidesnatado')
  })

  it('normalizes "semi-desnatado" to "semidesnatado"', () => {
    expect(applySynonyms('leite semi-desnatado')).toBe('leite semidesnatado')
  })

  it('normalizes "peito de frango" to TACO format', () => {
    expect(applySynonyms('peito de frango')).toBe('frango, peito')
  })

  it('normalizes "arroz branco" to TACO format', () => {
    expect(applySynonyms('arroz branco')).toBe('arroz, tipo 1, cozido')
  })

  it('returns input unchanged when no synonym matches', () => {
    expect(applySynonyms('abacaxi')).toBe('abacaxi')
  })
})

describe('tokenMatchScore', () => {
  it('returns 1.0 for perfect token overlap', () => {
    expect(tokenMatchScore(
      ['leite', 'semidesnatado'],
      ['leite', 'de', 'vaca', 'semidesnatado'],
    )).toBe(1.0)
  })

  it('returns 0.5 when half the input tokens match', () => {
    expect(tokenMatchScore(
      ['leite', 'chocolate'],
      ['leite', 'de', 'vaca', 'integral'],
    )).toBe(0.5)
  })

  it('returns 0 when no tokens match', () => {
    expect(tokenMatchScore(
      ['pizza'],
      ['arroz', 'tipo', '1', 'cozido'],
    )).toBe(0)
  })
})
