import { describe, it, expect, vi } from 'vitest'

/**
 * Regression suite for the DECIMAL-as-string bug.
 *
 * Postgres DECIMAL/NUMERIC columns are serialized as JSON STRINGS by PostgREST
 * (e.g. "12.50") to preserve precision. A TypeScript `as number` cast does NOT
 * convert at runtime, so summing such values concatenates strings
 * ("0" + "12.50" + "5.50" → "012.505.50" → NaN).
 *
 * The existing query tests feed plain numbers in their mock rows, so they never
 * exercised this coercion. These tests feed DECIMAL columns as STRINGS — the
 * shape production actually returns — to lock the fix as a regression.
 */

// Universal mock chain: works whether the query is awaited directly (thenable)
// or terminated with .single(). Both resolve to `result`.
function chainReturning(result: { data: unknown; error: unknown }) {
  const chain: Record<string, unknown> = {}
  for (const m of ['select', 'eq', 'gte', 'lte', 'order', 'limit', 'ilike', 'update', 'insert', 'upsert']) {
    chain[m] = vi.fn(() => chain)
  }
  chain.single = vi.fn(() => Promise.resolve(result))
  chain.then = (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
    Promise.resolve(result).then(resolve, reject)
  return chain
}

describe('decToNum (DECIMAL → number coercion helper)', () => {
  it('parses a DECIMAL string to a number', async () => {
    const { decToNum } = await import('@/lib/db/utils')
    expect(decToNum('12.50')).toBe(12.5)
    expect(decToNum('18.00')).toBe(18)
  })

  it('passes through an existing number', async () => {
    const { decToNum } = await import('@/lib/db/utils')
    expect(decToNum(12.5)).toBe(12.5)
  })

  it('preserves null/undefined as null (so unknown macro is not coerced to 0)', async () => {
    const { decToNum } = await import('@/lib/db/utils')
    expect(decToNum(null)).toBeNull()
    expect(decToNum(undefined)).toBeNull()
  })

  it('returns null for non-numeric garbage instead of NaN', async () => {
    const { decToNum } = await import('@/lib/db/utils')
    expect(decToNum('abc')).toBeNull()
  })
})

describe('getDailyMacros with DECIMAL columns as strings', () => {
  it('SUMS macros numerically across 2+ items instead of concatenating into NaN', async () => {
    const { getDailyMacros } = await import('@/lib/db/queries/meals')

    // Two meal_items, macros as DECIMAL strings (PostgREST shape).
    const data = [
      { calories: 146, protein_g: '12.50', carbs_g: '1.00', fat_g: '10.00' },
      { calories: 66, protein_g: '5.50', carbs_g: '0.50', fat_g: '5.00' },
    ]
    const supabase = { from: vi.fn(() => chainReturning({ data, error: null })) }

    const result = await getDailyMacros(supabase as never, 'user-1')

    expect(result.calories).toBe(212)
    expect(result.proteinG).toBe(18) // 12.5 + 5.5
    expect(result.carbsG).toBe(2) // round(1.5)
    expect(result.fatG).toBe(15) // 10 + 5
  })
})

describe('getMealWithItems with DECIMAL columns as strings', () => {
  it('returns item macros as numbers, not strings', async () => {
    const { getMealWithItems } = await import('@/lib/db/queries/meals')

    const mealRow = {
      id: 'meal-1',
      meal_type: 'breakfast',
      total_calories: 146,
      registered_at: '2026-05-31T11:12:00Z',
    }
    const itemRows = [
      {
        id: 'item-1',
        food_name: 'Ovo',
        quantity_grams: '100.00',
        quantity_display: null,
        calories: 146,
        protein_g: '12.50',
        carbs_g: '1.00',
        fat_g: '10.00',
        source: 'taco',
        confidence: 'high',
      },
    ]
    const from = vi
      .fn()
      .mockReturnValueOnce(chainReturning({ data: mealRow, error: null }))
      .mockReturnValueOnce(chainReturning({ data: itemRows, error: null }))
    const supabase = { from }

    const result = await getMealWithItems(supabase as never, 'meal-1')

    expect(result).not.toBeNull()
    const item = result!.items[0]
    expect(typeof item.proteinG).toBe('number')
    expect(item.proteinG).toBe(12.5)
    expect(item.carbsG).toBe(1)
    expect(item.fatG).toBe(10)
    expect(item.quantityGrams).toBe(100)
  })
})

describe('getLastWeight with weight_kg as a DECIMAL string', () => {
  it('returns weightKg as a number (so trend comparisons are numeric, not lexicographic)', async () => {
    const { getLastWeight } = await import('@/lib/db/queries/weight')

    const supabase = {
      from: vi.fn(() => chainReturning({ data: { weight_kg: '80.50', logged_at: '2026-05-31T08:00:00Z' }, error: null })),
    }

    const result = await getLastWeight(supabase as never, 'user-1')

    expect(result).not.toBeNull()
    expect(typeof result!.weightKg).toBe('number')
    expect(result!.weightKg).toBe(80.5)
  })
})

describe('lookupFood with per_100g columns as DECIMAL strings', () => {
  it('returns macros as numbers and preserves null macros', async () => {
    const { lookupFood } = await import('@/lib/db/queries/food-cache')

    const row = {
      id: 'food-1',
      food_name_normalized: 'arroz branco',
      calories_per_100g: '130.00',
      protein_per_100g: '2.50',
      carbs_per_100g: '28.10',
      fat_per_100g: null, // genuinely unknown — must stay null, NOT become 0
      typical_portion_grams: '150.00',
      source: 'taco',
      hit_count: 5,
      portion_type: null,
      default_grams: null,
      default_display: null,
    }
    const supabase = { from: vi.fn(() => chainReturning({ data: row, error: null })) }

    const result = await lookupFood(supabase as never, 'Arroz Branco')

    expect(result).not.toBeNull()
    expect(result!.caloriesPer100g).toBe(130)
    expect(result!.proteinPer100g).toBe(2.5)
    expect(result!.carbsPer100g).toBe(28.1)
    expect(result!.typicalPortionGrams).toBe(150)
    expect(result!.fatPer100g).toBeNull()
  })
})

describe('searchMealHistory with DECIMAL columns as strings', () => {
  it('returns item macros as numbers', async () => {
    const { searchMealHistory } = await import('@/lib/db/queries/meal-history-search')

    const itemData = [
      {
        id: 'item-1',
        food_name: 'Arroz',
        quantity_grams: '150.00',
        calories: 195,
        protein_g: '4.00',
        carbs_g: '42.00',
        fat_g: '0.50',
        source: 'taco',
        taco_id: null,
        created_at: '2026-05-30T13:00:00Z',
        meals: {
          id: 'meal-1',
          user_id: 'user-1',
          original_message: 'arroz',
          registered_at: '2026-05-30T13:00:00Z',
        },
      },
    ]
    const supabase = { from: vi.fn(() => chainReturning({ data: itemData, error: null })) }

    const result = await searchMealHistory(supabase as never, 'user-1', 'arroz')

    expect(result).toHaveLength(1)
    expect(typeof result[0].protein).toBe('number')
    expect(result[0].protein).toBe(4)
    expect(result[0].carbs).toBe(42)
    expect(result[0].quantityGrams).toBe(150)
  })
})

describe('getMealDetailByType with quantity_grams as a DECIMAL string', () => {
  it('returns item quantityGrams as a number', async () => {
    const { getMealDetailByType } = await import('@/lib/db/queries/meals')

    const data = [
      {
        id: 'meal-1',
        meal_type: 'lunch',
        total_calories: 500,
        registered_at: '2026-05-31T15:00:00Z',
        meal_items: [
          { food_name: 'Arroz', quantity_grams: '150.00', quantity_display: '1 xícara', calories: 195 },
        ],
      },
    ]
    const supabase = { from: vi.fn(() => chainReturning({ data, error: null })) }

    const result = await getMealDetailByType(supabase as never, 'user-1', 'lunch', new Date('2026-05-31T12:00:00Z'))

    expect(typeof result[0].items[0].quantityGrams).toBe('number')
    expect(result[0].items[0].quantityGrams).toBe(150)
  })
})
