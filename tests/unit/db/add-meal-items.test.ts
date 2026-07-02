import { describe, it, expect, vi } from 'vitest'
import { addMealItems } from '@/lib/db/queries/meals'

describe('addMealItems', () => {
  it('rounds fractional calories before insert (meal_items.calories is INTEGER)', async () => {
    let insertedRows: Record<string, unknown>[] = []
    const chain = {
      insert: vi.fn((rows: Record<string, unknown>[]) => {
        insertedRows = rows
        return chain
      }),
    }
    const supabase = {
      from: vi.fn(() => chain),
    }

    await addMealItems(supabase as never, 'meal-1', [{
      foodName: 'Vinho tinto',
      quantityGrams: 150,
      calories: 127.5,
      proteinG: 0.15,
      carbsG: 3.9,
      fatG: 0,
      source: 'manual',
    }])

    expect(supabase.from).toHaveBeenCalledWith('meal_items')
    expect(insertedRows).toHaveLength(1)
    expect(insertedRows[0].calories).toBe(128)
    expect(insertedRows[0].protein_g).toBe(0.15)
  })
})
