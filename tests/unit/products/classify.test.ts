import { describe, expect, it, vi } from 'vitest'
import { GENERIC_FOOD_TOKENS, shouldUseProductFlow } from '@/lib/products/classify'
import type { MealItem } from '@/lib/llm/schemas/meal-analysis'

function item(overrides: Partial<MealItem>): MealItem {
  return {
    food: 'x',
    portion_type: 'unit',
    has_user_quantity: false,
    quantity_grams: null,
    quantity_display: null,
    quantity_source: 'estimated',
    nutrition_basis_grams: null,
    nutrition_basis_calories: null,
    nutrition_basis_protein: null,
    nutrition_basis_carbs: null,
    nutrition_basis_fat: null,
    calories: null,
    protein: null,
    carbs: null,
    fat: null,
    confidence: 'medium',
    ...overrides,
  }
}

function supabaseWithSimilarity(similarity: number) {
  return {
    rpc: vi.fn().mockResolvedValue({ data: similarity, error: null }),
  } as unknown as Parameters<typeof shouldUseProductFlow>[1]
}

describe('shouldUseProductFlow', () => {
  it('returns false when portion_type is not packaged', async () => {
    const supabase = supabaseWithSimilarity(0)

    await expect(
      shouldUseProductFlow(item({ food: 'magic toast', portion_type: 'unit' }), supabase),
    ).resolves.toBe(false)
    await expect(
      shouldUseProductFlow(item({ food: 'arroz', portion_type: 'bulk' }), supabase),
    ).resolves.toBe(false)
    expect(supabase.rpc).not.toHaveBeenCalled()
  })

  it('returns false for generic foods even when packaged', async () => {
    const supabase = supabaseWithSimilarity(0)

    for (const food of ['arroz integral', 'feijão carioca', 'frango desfiado', 'leite integral', 'ovo cozido']) {
      await expect(
        shouldUseProductFlow(item({ food, portion_type: 'packaged' }), supabase),
      ).resolves.toBe(false)
    }
    expect(supabase.rpc).not.toHaveBeenCalled()
  })

  it('returns false when TACO has a high-similarity match', async () => {
    const supabase = supabaseWithSimilarity(0.72)

    await expect(
      shouldUseProductFlow(item({ food: 'arrroz branco', portion_type: 'packaged' }), supabase),
    ).resolves.toBe(false)
    expect(supabase.rpc).toHaveBeenCalledWith('taco_max_similarity', { input: 'arrroz branco' })
  })

  it('returns true for branded products without a TACO neighbor', async () => {
    const supabase = supabaseWithSimilarity(0.21)

    await expect(
      shouldUseProductFlow(item({ food: 'Magic Toast Marilan', portion_type: 'packaged' }), supabase),
    ).resolves.toBe(true)
    await expect(
      shouldUseProductFlow(item({ food: 'YoPRO chocolate', portion_type: 'packaged' }), supabase),
    ).resolves.toBe(true)
  })
})

describe('GENERIC_FOOD_TOKENS', () => {
  it('contains common defensive PT-BR generic foods', () => {
    expect(GENERIC_FOOD_TOKENS).toEqual(
      expect.arrayContaining(['arroz', 'feijão', 'feijao', 'frango', 'leite', 'ovo']),
    )
  })
})
