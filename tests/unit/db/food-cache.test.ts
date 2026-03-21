import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { CachedFood } from '@/lib/db/queries/food-cache'

// Helper to build a mock Supabase query chain
function buildChain(result: { data: unknown; error: unknown }) {
  const chain: Record<string, unknown> = {}
  const terminal = () => Promise.resolve(result)
  chain.select = vi.fn(() => chain)
  chain.eq = vi.fn(() => chain)
  chain.single = vi.fn(terminal)
  chain.insert = vi.fn(() => chain)
  chain.update = vi.fn(() => chain)
  chain.upsert = vi.fn(terminal)
  return chain
}

function buildClient(chain: Record<string, unknown>) {
  return {
    from: vi.fn(() => chain),
  }
}

const mockCachedFoodRow: Record<string, unknown> = {
  id: 'food-1',
  food_name_normalized: 'arroz branco',
  calories_per_100g: 130,
  protein_per_100g: 2.5,
  carbs_per_100g: 28.1,
  fat_per_100g: 0.3,
  typical_portion_grams: 150,
  source: 'taco',
  hit_count: 5,
}

describe('normalizeFoodName', () => {
  it('lowercases and trims', async () => {
    const { normalizeFoodName } = await import('@/lib/db/queries/food-cache')
    expect(normalizeFoodName('Arroz Branco ')).toBe('arroz branco')
  })

  it('trims leading spaces and lowercases', async () => {
    const { normalizeFoodName } = await import('@/lib/db/queries/food-cache')
    expect(normalizeFoodName('  FEIJÃO Carioca')).toBe('feijao carioca')
  })

  it('removes accents from characters', async () => {
    const { normalizeFoodName } = await import('@/lib/db/queries/food-cache')
    expect(normalizeFoodName('Pão de queijo')).toBe('pao de queijo')
  })

  it('handles multiple accented characters', async () => {
    const { normalizeFoodName } = await import('@/lib/db/queries/food-cache')
    expect(normalizeFoodName('Maçã')).toBe('maca')
  })
})

describe('lookupFood', () => {
  it('returns CachedFood and increments hit_count when found', async () => {
    const { lookupFood } = await import('@/lib/db/queries/food-cache')

    // First call: select query returns the food
    const selectChain: Record<string, unknown> = {}
    selectChain.select = vi.fn(() => selectChain)
    selectChain.eq = vi.fn(() => selectChain)
    selectChain.single = vi.fn(() =>
      Promise.resolve({ data: mockCachedFoodRow, error: null })
    )

    // Second call (fire and forget): update hit_count
    const updateChain: Record<string, unknown> = {}
    updateChain.update = vi.fn(() => updateChain)
    updateChain.eq = vi.fn(() => Promise.resolve({ data: null, error: null }))

    let callCount = 0
    const supabase = {
      from: vi.fn(() => {
        callCount++
        return callCount === 1 ? selectChain : updateChain
      }),
    }

    const result = await lookupFood(supabase as never, 'Arroz Branco ')

    expect(supabase.from).toHaveBeenCalledWith('food_cache')
    expect(selectChain.eq).toHaveBeenCalledWith('food_name_normalized', 'arroz branco')
    expect(result).not.toBeNull()
    expect(result!.id).toBe('food-1')
    expect(result!.foodNameNormalized).toBe('arroz branco')
    expect(result!.caloriesPer100g).toBe(130)
    expect(result!.proteinPer100g).toBe(2.5)
    expect(result!.carbsPer100g).toBe(28.1)
    expect(result!.fatPer100g).toBe(0.3)
    expect(result!.typicalPortionGrams).toBe(150)
    expect(result!.source).toBe('taco')
    expect(result!.hitCount).toBe(5)
  })

  it('returns null when food is not found (PGRST116)', async () => {
    const { lookupFood } = await import('@/lib/db/queries/food-cache')
    const chain = buildChain({ data: null, error: { code: 'PGRST116', message: 'No rows' } })
    const supabase = buildClient(chain)

    const result = await lookupFood(supabase as never, 'comida inexistente')

    expect(result).toBeNull()
  })

  it('throws on unexpected DB errors', async () => {
    const { lookupFood } = await import('@/lib/db/queries/food-cache')
    const chain = buildChain({ data: null, error: { code: '500', message: 'DB error' } })
    const supabase = buildClient(chain)

    await expect(lookupFood(supabase as never, 'arroz')).rejects.toThrow('DB error')
  })

  it('normalizes the name before querying', async () => {
    const { lookupFood } = await import('@/lib/db/queries/food-cache')

    const selectChain: Record<string, unknown> = {}
    selectChain.select = vi.fn(() => selectChain)
    selectChain.eq = vi.fn(() => selectChain)
    selectChain.single = vi.fn(() =>
      Promise.resolve({ data: null, error: { code: 'PGRST116', message: 'No rows' } })
    )

    const supabase = { from: vi.fn(() => selectChain) }

    await lookupFood(supabase as never, '  FEIJÃO Carioca')

    expect(selectChain.eq).toHaveBeenCalledWith('food_name_normalized', 'feijao carioca')
  })
})

describe('cacheFood', () => {
  it('upserts with normalized food name', async () => {
    const { cacheFood } = await import('@/lib/db/queries/food-cache')
    const chain = buildChain({ data: null, error: null })
    const supabase = buildClient(chain)

    await cacheFood(supabase as never, {
      foodName: 'Arroz Branco',
      caloriesPer100g: 130,
      source: 'taco',
    })

    expect(supabase.from).toHaveBeenCalledWith('food_cache')
    expect(chain.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        food_name_normalized: 'arroz branco',
        calories_per_100g: 130,
        source: 'taco',
      }),
      expect.objectContaining({ onConflict: 'food_name_normalized' })
    )
  })

  it('includes optional nutritional fields when provided', async () => {
    const { cacheFood } = await import('@/lib/db/queries/food-cache')
    const chain = buildChain({ data: null, error: null })
    const supabase = buildClient(chain)

    await cacheFood(supabase as never, {
      foodName: 'Feijão Carioca',
      caloriesPer100g: 76,
      proteinPer100g: 4.8,
      carbsPer100g: 13.6,
      fatPer100g: 0.5,
      typicalPortionGrams: 86,
      source: 'taco',
    })

    expect(chain.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        food_name_normalized: 'feijao carioca',
        calories_per_100g: 76,
        protein_per_100g: 4.8,
        carbs_per_100g: 13.6,
        fat_per_100g: 0.5,
        typical_portion_grams: 86,
        source: 'taco',
      }),
      expect.objectContaining({ onConflict: 'food_name_normalized' })
    )
  })

  it('throws when upsert fails', async () => {
    const { cacheFood } = await import('@/lib/db/queries/food-cache')
    const chain = buildChain({ data: null, error: { code: '500', message: 'insert failed' } })
    const supabase = buildClient(chain)

    await expect(
      cacheFood(supabase as never, {
        foodName: 'Arroz',
        caloriesPer100g: 130,
        source: 'taco',
      })
    ).rejects.toThrow('insert failed')
  })

  it('normalizes accented food name before upsert', async () => {
    const { cacheFood } = await import('@/lib/db/queries/food-cache')
    const chain = buildChain({ data: null, error: null })
    const supabase = buildClient(chain)

    await cacheFood(supabase as never, {
      foodName: 'Pão de queijo',
      caloriesPer100g: 260,
      source: 'approximate',
    })

    expect(chain.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ food_name_normalized: 'pao de queijo' }),
      expect.anything()
    )
  })
})
