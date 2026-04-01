import { describe, it, expect, vi } from 'vitest'

// Helper to build a mock Supabase query chain for getMealDetailByType.
// The chain is also a thenable so `await query` resolves with `result`.
function buildChain(result: { data: unknown; error: unknown }) {
  const chain: Record<string, unknown> = {}
  chain.select = vi.fn(() => chain)
  chain.eq = vi.fn(() => chain)
  chain.gte = vi.fn(() => chain)
  chain.lte = vi.fn(() => chain)
  chain.order = vi.fn(() => chain)
  // Make the chain itself a thenable so `await chain` works
  chain.then = (resolve: (v: unknown) => unknown) => Promise.resolve(result).then(resolve)
  return chain
}

function buildClient(chain: Record<string, unknown>) {
  return {
    from: vi.fn(() => chain),
  }
}

describe('getMealDetailByType', () => {
  it('returns meal details with items for a specific meal type and date', async () => {
    const { getMealDetailByType } = await import('@/lib/db/queries/meals')

    const mockData = [
      {
        id: 'meal-1',
        meal_type: 'lunch',
        total_calories: 500,
        registered_at: '2026-03-31T15:00:00Z',
        meal_items: [
          {
            food_name: 'Arroz branco',
            quantity_grams: 150,
            quantity_display: '1 xícara',
            calories: 195,
          },
          {
            food_name: 'Feijão carioca',
            quantity_grams: 86,
            quantity_display: null,
            calories: 76,
          },
        ],
      },
    ]

    const chain = buildChain({ data: mockData, error: null })
    const supabase = buildClient(chain)

    const result = await getMealDetailByType(
      supabase as never,
      'user-123',
      'lunch',
      new Date('2026-03-31T12:00:00Z'),
      'America/Sao_Paulo',
    )

    expect(supabase.from).toHaveBeenCalledWith('meals')
    expect(chain.eq).toHaveBeenCalledWith('user_id', 'user-123')
    expect(chain.eq).toHaveBeenCalledWith('meal_type', 'lunch')

    expect(result).toHaveLength(1)
    expect(result[0].mealType).toBe('lunch')
    expect(result[0].totalCalories).toBe(500)
    expect(result[0].registeredAt).toBe('2026-03-31T15:00:00Z')
    expect(result[0].items).toHaveLength(2)
    expect(result[0].items[0]).toEqual({
      foodName: 'Arroz branco',
      quantityGrams: 150,
      quantityDisplay: '1 xícara',
      calories: 195,
    })
    expect(result[0].items[1]).toEqual({
      foodName: 'Feijão carioca',
      quantityGrams: 86,
      quantityDisplay: null,
      calories: 76,
    })
  })

  it('returns all meal types when mealType is null', async () => {
    const { getMealDetailByType } = await import('@/lib/db/queries/meals')

    const mockData = [
      {
        id: 'meal-1',
        meal_type: 'breakfast',
        total_calories: 300,
        registered_at: '2026-03-31T09:00:00Z',
        meal_items: [
          {
            food_name: 'Pão de queijo',
            quantity_grams: 50,
            quantity_display: '2 unidades',
            calories: 130,
          },
        ],
      },
      {
        id: 'meal-2',
        meal_type: 'lunch',
        total_calories: 600,
        registered_at: '2026-03-31T13:00:00Z',
        meal_items: [],
      },
    ]

    const chain = buildChain({ data: mockData, error: null })
    const supabase = buildClient(chain)

    const result = await getMealDetailByType(
      supabase as never,
      'user-123',
      null,
      new Date('2026-03-31T12:00:00Z'),
      'America/Sao_Paulo',
    )

    // Should NOT filter by meal_type when null
    const eqCalls = (chain.eq as ReturnType<typeof vi.fn>).mock.calls
    const mealTypeCall = eqCalls.find((call: unknown[]) => call[0] === 'meal_type')
    expect(mealTypeCall).toBeUndefined()

    expect(result).toHaveLength(2)
    expect(result[0].mealType).toBe('breakfast')
    expect(result[1].mealType).toBe('lunch')
  })

  it('returns empty array when no meals found', async () => {
    const { getMealDetailByType } = await import('@/lib/db/queries/meals')

    const chain = buildChain({ data: [], error: null })
    const supabase = buildClient(chain)

    const result = await getMealDetailByType(
      supabase as never,
      'user-123',
      'dinner',
      new Date('2026-03-31T12:00:00Z'),
    )

    expect(result).toEqual([])
  })

  it('returns empty array when data is null', async () => {
    const { getMealDetailByType } = await import('@/lib/db/queries/meals')

    const chain = buildChain({ data: null, error: null })
    const supabase = buildClient(chain)

    const result = await getMealDetailByType(
      supabase as never,
      'user-123',
      null,
      new Date('2026-03-31T12:00:00Z'),
    )

    expect(result).toEqual([])
  })

  it('throws when query returns an error', async () => {
    const { getMealDetailByType } = await import('@/lib/db/queries/meals')

    const chain = buildChain({ data: null, error: { message: 'DB connection failed' } })
    const supabase = buildClient(chain)

    await expect(
      getMealDetailByType(
        supabase as never,
        'user-123',
        'lunch',
        new Date('2026-03-31T12:00:00Z'),
      )
    ).rejects.toThrow('Failed to get meal details: DB connection failed')
  })

  it('handles meal items with missing quantity_display as null', async () => {
    const { getMealDetailByType } = await import('@/lib/db/queries/meals')

    const mockData = [
      {
        id: 'meal-1',
        meal_type: 'snack',
        total_calories: 100,
        registered_at: '2026-03-31T16:00:00Z',
        meal_items: [
          {
            food_name: 'Banana',
            quantity_grams: 100,
            quantity_display: undefined,
            calories: 89,
          },
        ],
      },
    ]

    const chain = buildChain({ data: mockData, error: null })
    const supabase = buildClient(chain)

    const result = await getMealDetailByType(
      supabase as never,
      'user-123',
      'snack',
      new Date('2026-03-31T12:00:00Z'),
    )

    expect(result[0].items[0].quantityDisplay).toBeNull()
  })
})
