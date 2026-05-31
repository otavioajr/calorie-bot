import { describe, it, expect } from 'vitest'
import { logFoodToMeal } from '@/lib/bot/flows/meal-log'
import { createInMemorySupabase } from '../../helpers/in-memory-supabase'

describe('integration: consolidação café da manhã (texto + foto)', () => {
  it('soma o açaí no café da manhã existente → 1 refeição, 3 itens, 292 kcal', async () => {
    const supabase = createInMemorySupabase()
    const userId = 'user-1'
    const today = new Date()

    // 1) texto: ovos + queijo (cria o café da manhã)
    const r1 = await logFoodToMeal(supabase as never, {
      userId,
      mealType: 'breakfast',
      items: [
        { foodName: 'Ovo', quantityGrams: 100, calories: 146, proteinG: 12, carbsG: 1, fatG: 10, source: 'taco' },
        { foodName: 'Queijo mussarela', quantityGrams: 20, calories: 66, proteinG: 5, carbsG: 0, fatG: 5, source: 'taco' },
      ],
      originalMessage: 'comi 2 ovos e queijo',
      targetDate: today,
    })
    expect(r1.wasAppend).toBe(false)

    // 2) foto-rótulo: açaí (deve SOMAR no mesmo café da manhã)
    const r2 = await logFoodToMeal(supabase as never, {
      userId,
      mealType: 'breakfast',
      items: [{ foodName: 'Açaí', quantityGrams: 67, calories: 80, proteinG: 1, carbsG: 18, fatG: 0.5, source: 'manual' }],
      originalMessage: 'comi também 67g de açaí',
      targetDate: today,
    })

    expect(r2.wasAppend).toBe(true)
    expect(r2.mealId).toBe(r1.mealId)
    expect(r2.meal.items).toHaveLength(3)
    expect(r2.meal.totalCalories).toBe(292)
  })
})
