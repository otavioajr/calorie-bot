import { beforeEach, describe, expect, it, vi } from 'vitest'
import { parseRecipeIngredients } from '@/lib/llm/parsers/recipe-ingredients'
import { RecipeParseSchema } from '@/lib/llm/schemas/recipe-parse'

const { mockChat } = vi.hoisted(() => ({
  mockChat: vi.fn(),
}))

vi.mock('@/lib/llm/index', () => ({
  getLLMProvider: () => ({
    chat: mockChat,
  }),
}))

beforeEach(() => {
  mockChat.mockReset()
})

describe('RecipeParseSchema', () => {
  it('accepts valid ingredient list', () => {
    const result = RecipeParseSchema.parse({
      ingredients: [
        { food: 'arroz branco', quantity_grams: 150 },
        { food: 'feijao carioca', quantity_grams: 100 },
      ],
    })

    expect(result.ingredients).toEqual([
      { food: 'arroz branco', quantityGrams: 150 },
      { food: 'feijao carioca', quantityGrams: 100 },
    ])
  })

  it('coerces string quantity_grams to number and exposes quantityGrams', () => {
    const result = RecipeParseSchema.parse({
      ingredients: [{ food: 'cebola', quantity_grams: '110' }],
    })

    expect(result.ingredients[0]).toEqual({
      food: 'cebola',
      quantityGrams: 110,
    })
  })

  it('rejects empty ingredient list', () => {
    expect(() => RecipeParseSchema.parse({ ingredients: [] })).toThrow()
  })

  it('trims food names in valid output', () => {
    const result = RecipeParseSchema.parse({
      ingredients: [{ food: '  cebola media  ', quantity_grams: 110 }],
    })

    expect(result.ingredients[0].food).toBe('cebola media')
  })

  it('rejects whitespace-only food', () => {
    expect(() =>
      RecipeParseSchema.parse({
        ingredients: [{ food: '   ', quantity_grams: 110 }],
      }),
    ).toThrow()
  })

  it.each([
    ['zero', 0],
    ['negative', -5],
    ['non-numeric string', 'abc'],
    ['boolean', true],
  ])('rejects %s quantity_grams', (_label, quantityGrams) => {
    expect(() =>
      RecipeParseSchema.parse({
        ingredients: [{ food: 'cebola', quantity_grams: quantityGrams }],
      }),
    ).toThrow()
  })
})

describe('parseRecipeIngredients', () => {
  it('throws debuggable error for invalid JSON response', async () => {
    mockChat.mockResolvedValue('isto nao eh json')

    await expect(parseRecipeIngredients('1 cebola')).rejects.toThrow(
      'Failed to parse recipe ingredients JSON: isto nao eh json',
    )
  })

  it('throws debuggable error for schema-invalid JSON response', async () => {
    mockChat.mockResolvedValue('{"ingredients":[]}')

    await expect(parseRecipeIngredients('1 cebola')).rejects.toThrow(
      'Invalid recipe ingredients response: {"ingredients":[]}',
    )
  })
})
