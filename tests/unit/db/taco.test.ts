import { describe, it, expect, vi } from 'vitest'
import { fuzzyMatchTaco, fuzzyMatchTacoMultiple, calculateMacros } from '@/lib/db/queries/taco'

function createMockSupabase(returnData: unknown[] | null, error: unknown = null) {
  const rpc = vi.fn().mockResolvedValue({ data: returnData, error })
  return { rpc } as unknown as import('@supabase/supabase-js').SupabaseClient
}

describe('fuzzyMatchTaco', () => {
  it('returns best match when similarity >= threshold', async () => {
    const supabase = createMockSupabase([
      { id: 3, food_name: 'Arroz, tipo 1, cozido', category: 'Cereais e derivados', calories_per_100g: 128, protein_per_100g: 2.5, carbs_per_100g: 28.1, fat_per_100g: 0.2, fiber_per_100g: 1.6, similarity: 0.8 }
    ])

    const result = await fuzzyMatchTaco(supabase, 'arroz branco cozido')
    expect(result).not.toBeNull()
    expect(result!.foodName).toBe('Arroz, tipo 1, cozido')
    expect(result!.caloriesPer100g).toBe(128)
  })

  it('returns null when no match above threshold', async () => {
    const supabase = createMockSupabase([])
    const result = await fuzzyMatchTaco(supabase, 'big mac')
    expect(result).toBeNull()
  })

  it('returns null on database error', async () => {
    const supabase = createMockSupabase(null, { message: 'connection error' })
    const result = await fuzzyMatchTaco(supabase, 'arroz')
    expect(result).toBeNull()
  })
})

describe('fuzzyMatchTacoMultiple', () => {
  it('returns map of matched foods', async () => {
    const supabase = createMockSupabase([
      { id: 3, food_name: 'Arroz, tipo 1, cozido', category: 'Cereais e derivados', calories_per_100g: 128, protein_per_100g: 2.5, carbs_per_100g: 28.1, fat_per_100g: 0.2, fiber_per_100g: 1.6, similarity: 0.8, query_name: 'arroz' },
      { id: 100, food_name: 'Feijão, carioca, cozido', category: 'Leguminosas e derivados', calories_per_100g: 76, protein_per_100g: 4.8, carbs_per_100g: 13.6, fat_per_100g: 0.5, fiber_per_100g: 8.5, similarity: 0.7, query_name: 'feijão' },
    ])

    const result = await fuzzyMatchTacoMultiple(supabase, ['arroz', 'feijão'])
    expect(result.get('arroz')).not.toBeNull()
    expect(result.get('feijão')).not.toBeNull()
  })

  it('returns empty map for empty input', async () => {
    const supabase = createMockSupabase([])
    const result = await fuzzyMatchTacoMultiple(supabase, [])
    expect(result.size).toBe(0)
  })
})

describe('calculateMacros', () => {
  it('calculates proportional macros based on grams', () => {
    const tacoFood = {
      id: 3, foodName: 'Arroz, tipo 1, cozido', category: 'Cereais e derivados',
      caloriesPer100g: 128, proteinPer100g: 2.5, carbsPer100g: 28.1, fatPer100g: 0.2, fiberPer100g: 1.6,
    }
    const result = calculateMacros(tacoFood, 200)
    expect(result.calories).toBe(256)
    expect(result.protein).toBeCloseTo(5.0)
    expect(result.carbs).toBeCloseTo(56.2)
    expect(result.fat).toBeCloseTo(0.4)
  })
})
