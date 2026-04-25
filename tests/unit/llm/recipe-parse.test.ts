import { describe, expect, it } from 'vitest'
import { RecipeParseSchema } from '@/lib/llm/schemas/recipe-parse'

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
})
