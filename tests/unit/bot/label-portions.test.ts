import { describe, expect, it } from 'vitest'

import {
  extractLabelGramsFromCaption,
  extractLabelPortionsFromCaption,
} from '@/lib/bot/label-portions'

describe('extractLabelPortionsFromCaption', () => {
  it('extracts numeric portions from caption keywords', () => {
    expect(extractLabelPortionsFromCaption('café da manhã 1 dose')).toBe(1)
    expect(extractLabelPortionsFromCaption('pós treino 2 scoops')).toBe(2)
  })

  it('supports decimal and textual portion values', () => {
    expect(extractLabelPortionsFromCaption('lanche 1,5 doses')).toBe(1.5)
    expect(extractLabelPortionsFromCaption('ceia meia dose')).toBe(0.5)
    expect(extractLabelPortionsFromCaption('pré treino uma porção')).toBe(1)
  })

  it('extracts portions from natural language consumption', () => {
    expect(extractLabelPortionsFromCaption('Eu tomei um desse actimel no café da manhã')).toBe(1)
    expect(extractLabelPortionsFromCaption('tomei 2 dessas no almoço')).toBe(2)
    expect(extractLabelPortionsFromCaption('comi uma dessa')).toBe(1)
    expect(extractLabelPortionsFromCaption('bebi dois')).toBe(2)
    expect(extractLabelPortionsFromCaption('comi 1,5')).toBe(1.5)
  })

  it('ignores captions without a clear portion quantity', () => {
    expect(extractLabelPortionsFromCaption('café da manhã')).toBeNull()
    expect(extractLabelPortionsFromCaption('pré treino 30g')).toBeNull()
    expect(extractLabelPortionsFromCaption('tabela nutricional actimel')).toBeNull()
  })
})

describe('extractLabelGramsFromCaption', () => {
  it('extracts grams with the unit glued to the number', () => {
    expect(extractLabelGramsFromCaption('Adicionar 55g desse açaí no café da manhã')).toBe(55)
    expect(extractLabelGramsFromCaption('comi 100g')).toBe(100)
  })

  it('extracts grams with a space between number and unit', () => {
    expect(extractLabelGramsFromCaption('comi 55 g de açaí')).toBe(55)
    expect(extractLabelGramsFromCaption('Adicionar 110 gramas')).toBe(110)
  })

  it('supports decimal values (comma or dot)', () => {
    expect(extractLabelGramsFromCaption('30,5g de granola')).toBe(30.5)
    expect(extractLabelGramsFromCaption('0.5g de canela')).toBe(0.5)
  })

  it('returns null for captions without grams', () => {
    expect(extractLabelGramsFromCaption('café da manhã 1 dose')).toBeNull()
    expect(extractLabelGramsFromCaption('uma garrafa')).toBeNull()
    expect(extractLabelGramsFromCaption('')).toBeNull()
    expect(extractLabelGramsFromCaption(null)).toBeNull()
    expect(extractLabelGramsFromCaption(undefined)).toBeNull()
  })

  it('does not match numbers followed by other letters', () => {
    expect(extractLabelGramsFromCaption('100gb de espaço')).toBeNull()
  })
})
