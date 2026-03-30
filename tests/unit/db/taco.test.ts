import { describe, it, expect, vi } from 'vitest'
import {
  fuzzyMatchTaco,
  fuzzyMatchTacoMultiple,
  calculateMacros,
  matchTacoByBase,
  getLearnedDefault,
  recordTacoUsage,
} from '@/lib/db/queries/taco'

function createMockSupabase(returnData: unknown[] | null, error: unknown = null) {
  const rpc = vi.fn().mockResolvedValue({ data: returnData, error })
  return { rpc } as unknown as import('@supabase/supabase-js').SupabaseClient
}

describe('fuzzyMatchTaco', () => {
  it('returns best match when similarity >= threshold', async () => {
    const supabase = createMockSupabase([
      { id: 3, food_name: 'Arroz, tipo 1, cozido', category: null, calories_per_100g: 128, protein_per_100g: 2.5, carbs_per_100g: 28.1, fat_per_100g: 0.2, fiber_per_100g: 1.6, food_base: 'Arroz', food_variant: 'tipo 1, cozido', is_default: true, similarity: 0.8 }
    ])

    const result = await fuzzyMatchTaco(supabase, 'arroz branco cozido')
    expect(result).not.toBeNull()
    expect(result!.foodName).toBe('Arroz, tipo 1, cozido')
    expect(result!.foodBase).toBe('Arroz')
    expect(result!.isDefault).toBe(true)
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
  it('returns map of matched foods with base/variant', async () => {
    const supabase = createMockSupabase([
      { id: 3, food_name: 'Arroz, tipo 1, cozido', category: null, calories_per_100g: 128, protein_per_100g: 2.5, carbs_per_100g: 28.1, fat_per_100g: 0.2, fiber_per_100g: 1.6, food_base: 'Arroz', food_variant: 'tipo 1, cozido', is_default: true, similarity: 0.8, query_name: 'arroz' },
      { id: 100, food_name: 'Feijão, carioca, cozido', category: null, calories_per_100g: 76, protein_per_100g: 4.8, carbs_per_100g: 13.6, fat_per_100g: 0.5, fiber_per_100g: 8.5, food_base: 'Feijão', food_variant: 'carioca, cozido', is_default: true, similarity: 0.7, query_name: 'feijão' },
    ])

    const result = await fuzzyMatchTacoMultiple(supabase, ['arroz', 'feijão'])
    expect(result.get('arroz')!.foodBase).toBe('Arroz')
    expect(result.get('feijão')!.foodBase).toBe('Feijão')
  })

  it('returns empty map for empty input', async () => {
    const supabase = createMockSupabase([])
    const result = await fuzzyMatchTacoMultiple(supabase, [])
    expect(result.size).toBe(0)
  })
})

describe('matchTacoByBase', () => {
  it('returns all variants for a base, default first', async () => {
    const supabase = createMockSupabase([
      { id: 182, food_name: 'Banana, prata, crua', food_base: 'Banana', food_variant: 'prata, crua', is_default: true, calories_per_100g: 98, protein_per_100g: 1.3, carbs_per_100g: 26, fat_per_100g: 0.1, fiber_per_100g: 2 },
      { id: 175, food_name: 'Banana, da terra, crua', food_base: 'Banana', food_variant: 'da terra, crua', is_default: false, calories_per_100g: 128, protein_per_100g: 1.4, carbs_per_100g: 33.7, fat_per_100g: 0.1, fiber_per_100g: 1.5 },
    ])

    const result = await matchTacoByBase(supabase, 'Banana')
    expect(result).toHaveLength(2)
    expect(result[0].isDefault).toBe(true)
    expect(result[0].foodVariant).toBe('prata, crua')
  })

  it('returns empty array when no match', async () => {
    const supabase = createMockSupabase([])
    const result = await matchTacoByBase(supabase, 'BigMac')
    expect(result).toEqual([])
  })
})

describe('getLearnedDefault', () => {
  it('returns taco_id with most distinct users', async () => {
    const supabase = createMockSupabase([
      { taco_id: 179, user_count: 6 },
    ])
    const result = await getLearnedDefault(supabase, 'Banana')
    expect(result).toEqual({ tacoId: 179, userCount: 6 })
  })

  it('returns null when no usage data', async () => {
    const supabase = createMockSupabase([])
    const result = await getLearnedDefault(supabase, 'Banana')
    expect(result).toBeNull()
  })
})

describe('recordTacoUsage', () => {
  it('calls the RPC with correct params', async () => {
    const supabase = createMockSupabase(null)
    await recordTacoUsage(supabase, 'Banana', 182, 'user-123')
    expect(supabase.rpc).toHaveBeenCalledWith('record_taco_usage', {
      p_food_base: 'Banana',
      p_taco_id: 182,
      p_user_id: 'user-123',
    })
  })
})

describe('calculateMacros', () => {
  it('calculates proportional macros based on grams', () => {
    const tacoFood = {
      id: 3, foodName: 'Arroz, tipo 1, cozido', category: null as string | null,
      caloriesPer100g: 128, proteinPer100g: 2.5, carbsPer100g: 28.1, fatPer100g: 0.2, fiberPer100g: 1.6,
      foodBase: 'Arroz', foodVariant: 'tipo 1, cozido', isDefault: true,
    }
    const result = calculateMacros(tacoFood, 200)
    expect(result.calories).toBe(256)
    expect(result.protein).toBeCloseTo(5.0)
    expect(result.carbs).toBeCloseTo(56.2)
    expect(result.fat).toBeCloseTo(0.4)
  })
})
