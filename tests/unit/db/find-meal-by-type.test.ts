import { describe, it, expect, vi } from 'vitest'

function buildChain(result: { data: unknown; error: unknown }) {
  const chain: Record<string, unknown> = {}
  chain.select = vi.fn(() => chain)
  chain.eq = vi.fn(() => chain)
  chain.gte = vi.fn(() => chain)
  chain.lte = vi.fn(() => chain)
  chain.order = vi.fn(() => chain)
  chain.limit = vi.fn(() => chain)
  chain.then = (resolve: (v: unknown) => unknown) => Promise.resolve(result).then(resolve)
  return chain
}
function buildClient(chain: Record<string, unknown>) {
  return { from: vi.fn(() => chain) }
}

describe('findMealByTypeForDay', () => {
  it('returns the existing meal of that type for the day', async () => {
    const { findMealByTypeForDay } = await import('@/lib/db/queries/meals')
    const chain = buildChain({
      data: [{ id: 'meal-1', meal_type: 'breakfast', total_calories: 212, registered_at: '2026-05-29T11:00:00Z' }],
      error: null,
    })
    const supabase = buildClient(chain)

    const result = await findMealByTypeForDay(
      supabase as never, 'user-123', 'breakfast',
      new Date('2026-05-29T14:00:00Z'), 'America/Sao_Paulo',
    )

    expect(supabase.from).toHaveBeenCalledWith('meals')
    expect(chain.eq).toHaveBeenCalledWith('user_id', 'user-123')
    expect(chain.eq).toHaveBeenCalledWith('meal_type', 'breakfast')
    expect(chain.limit).toHaveBeenCalledWith(1)
    expect(result).toEqual({
      id: 'meal-1', mealType: 'breakfast', totalCalories: 212, registeredAt: '2026-05-29T11:00:00Z',
    })
  })

  it('returns the earliest meal when multiple of the same type exist (uses order asc + limit 1)', async () => {
    const { findMealByTypeForDay } = await import('@/lib/db/queries/meals')
    const chain = buildChain({ data: [{ id: 'early', meal_type: 'snack', total_calories: 50, registered_at: '2026-05-29T09:00:00Z' }], error: null })
    const supabase = buildClient(chain)
    const result = await findMealByTypeForDay(supabase as never, 'u', 'snack', new Date('2026-05-29T20:00:00Z'))
    expect(chain.order).toHaveBeenCalledWith('registered_at', { ascending: true })
    expect(chain.limit).toHaveBeenCalledWith(1)
    expect(result?.id).toBe('early')
  })

  it('returns null when no meal of that type exists for the day', async () => {
    const { findMealByTypeForDay } = await import('@/lib/db/queries/meals')
    const chain = buildChain({ data: [], error: null })
    const result = await findMealByTypeForDay(
      buildClient(chain) as never, 'user-123', 'breakfast', new Date('2026-05-29T14:00:00Z'),
    )
    expect(result).toBeNull()
  })

  it('throws on query error', async () => {
    const { findMealByTypeForDay } = await import('@/lib/db/queries/meals')
    const chain = buildChain({ data: null, error: { message: 'boom' } })
    await expect(
      findMealByTypeForDay(buildClient(chain) as never, 'u', 'lunch', new Date()),
    ).rejects.toThrow('Failed to find meal by type: boom')
  })
})
