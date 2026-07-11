import { describe, it, expect, vi, afterEach } from 'vitest'

import {
  classifyMealTypeByTime,
  detectExplicitMealDestination,
  detectExplicitMealType,
  getUserLocalTime,
  resolveMealTypeFromContext,
} from '@/lib/utils/meal-time'

describe('classifyMealTypeByTime', () => {
  it.each([
    ['05:00', 'breakfast'],
    ['07:23', 'breakfast'],
    ['10:59', 'breakfast'],
    ['11:00', 'lunch'],
    ['14:59', 'lunch'],
    ['15:00', 'snack'],
    ['17:59', 'snack'],
    ['18:00', 'dinner'],
    ['21:59', 'dinner'],
    ['22:00', 'supper'],
    ['03:30', 'supper'],
    ['04:59', 'supper'],
  ])('maps %s to %s', (time, expected) => {
    expect(classifyMealTypeByTime(time)).toBe(expected)
  })

  it('falls back to snack on malformed input', () => {
    expect(classifyMealTypeByTime('not-a-time')).toBe('snack')
  })
})

describe('detectExplicitMealDestination', () => {
  it.each([
    ['no almoço comi arroz', 'lunch'],
    ['adiciona para o jantar', 'dinner'],
    ['muda pro almoço', 'lunch'],
    ['essa refeição era no almoço', 'lunch'],
    ['jantei frango', 'dinner'],
    ['lanche: iogurte e banana', 'snack'],
    ['café da manhã com pão', 'breakfast'],
  ])('detects an explicit conversational destination in %s', (message, expected) => {
    expect(detectExplicitMealDestination(message)).toBe(expected)
  })

  it.each([
    'adiciona um lanche natural',
    'adiciona um café',
    'gostei do lanche natural',
    'quero um jantar leve',
  ])('does not treat a food or generic mention as a destination: %s', (message) => {
    expect(detectExplicitMealDestination(message)).toBeNull()
  })
})

describe('detectExplicitMealType', () => {
  it.each([
    ['meu café da manhã', 'breakfast'],
    ['no almoço comi arroz', 'lunch'],
    ['jantei pizza', 'dinner'],
    ['minha ceia', 'supper'],
    ['meu lanche da tarde', 'snack'],
    // Standalone unambiguous keywords
    ['lanche 1,5 doses', 'snack'],
    ['janta agora', 'dinner'],
    ['almoço', 'lunch'],
    ['desjejum leve', 'breakfast'],
    // Multi-word wins over partial matches
    ['café da manhã 1 dose', 'breakfast'],
  ])('detects %s', (caption, expected) => {
    expect(detectExplicitMealType(caption)).toBe(expected)
  })

  it('returns null when caption has no meal keyword', () => {
    expect(detectExplicitMealType('1 dose desse pré treino')).toBeNull()
    expect(detectExplicitMealType('')).toBeNull()
    expect(detectExplicitMealType(undefined)).toBeNull()
  })

  it('does not confuse "pré-treino" with a meal keyword', () => {
    expect(detectExplicitMealType('pré-treino')).toBeNull()
    expect(detectExplicitMealType('1 dose de pré treino')).toBeNull()
  })

  it('avoids false positives on words that contain meal keywords as substrings', () => {
    // "cafeína" shares letters with "cafe" but is a single distinct token.
    expect(detectExplicitMealType('bebida com cafeína')).toBeNull()
    // "lanchonete" contains "lanche" as a prefix but is a different token.
    expect(detectExplicitMealType('foto da lanchonete')).toBeNull()
    // "almoçado" is close to "almoço" but not in the keyword list.
    expect(detectExplicitMealType('comida já almoçada ontem')).toBeNull()
  })

  it('does not treat bare "café" as an explicit meal marker — time decides instead', () => {
    // A standalone "café" is ambiguous (morning coffee vs afternoon espresso),
    // so detection intentionally returns null and lets time-based
    // classification take over.
    expect(detectExplicitMealType('tomei um café')).toBeNull()
    expect(detectExplicitMealType('café 1 dose')).toBeNull()
  })
})

describe('resolveMealTypeFromContext', () => {
  it('prefers explicit caption keyword over time', () => {
    expect(
      resolveMealTypeFromContext({ caption: 'meu almoço', currentTime: '07:00' }),
    ).toBe('lunch')
  })

  it('falls back to time-based classification when caption is silent', () => {
    expect(
      resolveMealTypeFromContext({ caption: '1 dose pré-treino', currentTime: '07:23' }),
    ).toBe('breakfast')
    expect(
      resolveMealTypeFromContext({ caption: undefined, currentTime: '19:00' }),
    ).toBe('dinner')
  })
})

describe('getUserLocalTime', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('returns HH:MM formatted in the given timezone', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-04-23T10:23:00Z'))
    expect(getUserLocalTime('America/Sao_Paulo')).toBe('07:23')
  })

  it('defaults to America/Sao_Paulo when timezone missing', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-04-23T18:00:00Z'))
    expect(getUserLocalTime(undefined)).toBe('15:00')
  })
})
