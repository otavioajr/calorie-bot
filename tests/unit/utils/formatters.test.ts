import { describe, it, expect } from 'vitest'
import {
  formatMealBreakdown,
  formatDailySummary,
  formatWeeklySummary,
  formatWeightUpdate,
  formatProgress,
  formatOnboardingComplete,
  formatHelpMenu,
  formatSettingsMenu,
  formatOutOfScope,
  formatError,
  formatMealDetail,
} from '@/lib/utils/formatters'
import type { MealItem, DailyMealSummary, DailyEntry } from '@/lib/utils/formatters'

// ---------------------------------------------------------------------------
// formatMealBreakdown
// ---------------------------------------------------------------------------
describe('formatMealBreakdown', () => {
  const items: MealItem[] = [
    { food: 'Arroz branco', quantityGrams: 150, calories: 195 },
    { food: 'Feijão carioca', quantityGrams: 100, calories: 77 },
    { food: 'Frango grelhado', quantityGrams: 120, calories: 198 },
  ]

  it('includes the meal type in header', () => {
    const result = formatMealBreakdown('Almoço', items, 470, 1230, 2000)
    expect(result).toContain('Almoço')
  })

  it('includes each food item with grams and calories', () => {
    const result = formatMealBreakdown('Almoço', items, 470, 1230, 2000)
    expect(result).toContain('Arroz branco')
    expect(result).toContain('150g')
    expect(result).toContain('195 kcal')
    expect(result).toContain('Feijão carioca')
    expect(result).toContain('100g')
    expect(result).toContain('77 kcal')
    expect(result).toContain('Frango grelhado')
    expect(result).toContain('120g')
    expect(result).toContain('198 kcal')
  })

  it('includes meal total', () => {
    const result = formatMealBreakdown('Almoço', items, 470, 1230, 2000)
    expect(result).toContain('470 kcal')
  })

  it('includes daily progress with remaining', () => {
    const result = formatMealBreakdown('Almoço', items, 470, 1230, 2000)
    expect(result).toContain('1230')
    expect(result).toContain('2000')
    expect(result).toContain('770')
  })

  it('ends with correction hint', () => {
    const result = formatMealBreakdown('Almoço', items, 470, 1230, 2000)
    expect(result).toContain('Algo errado? Manda "corrigir"')
  })

  it('includes the 🍽️ emoji in header', () => {
    const result = formatMealBreakdown('Almoço', items, 470, 1230, 2000)
    expect(result).toContain('🍽️')
  })

  it('includes 📊 in progress line', () => {
    const result = formatMealBreakdown('Almoço', items, 470, 1230, 2000)
    expect(result).toContain('📊')
  })

  it('works with a single item', () => {
    const singleItem: MealItem[] = [{ food: 'Banana', quantityGrams: 100, calories: 89 }]
    const result = formatMealBreakdown('Lanche', singleItem, 89, 89, 2000)
    expect(result).toContain('Banana')
    expect(result).toContain('100g')
    expect(result).toContain('89 kcal')
  })

  it('uses bullet points for items', () => {
    const result = formatMealBreakdown('Almoço', items, 470, 1230, 2000)
    expect(result).toContain('•')
  })
})

// ---------------------------------------------------------------------------
// formatDailySummary
// ---------------------------------------------------------------------------
describe('formatDailySummary', () => {
  const meals: DailyMealSummary = {
    breakfast: 320,
    lunch: 510,
  }

  it('includes the date in header', () => {
    const result = formatDailySummary('21/03', meals, 830, 2000)
    expect(result).toContain('21/03')
  })

  it('includes 📊 emoji', () => {
    const result = formatDailySummary('21/03', meals, 830, 2000)
    expect(result).toContain('📊')
  })

  it('shows breakfast calories when present', () => {
    const result = formatDailySummary('21/03', meals, 830, 2000)
    expect(result).toContain('320 kcal')
  })

  it('shows lunch calories when present', () => {
    const result = formatDailySummary('21/03', meals, 830, 2000)
    expect(result).toContain('510 kcal')
  })

  it('shows not-registered marker for missing meals', () => {
    const result = formatDailySummary('21/03', meals, 830, 2000)
    // Lunch and dinner not registered should show "não registrado"
    expect(result).toContain('não registrado')
  })

  it('includes total consumed and target', () => {
    const result = formatDailySummary('21/03', meals, 830, 2000)
    expect(result).toContain('830')
    expect(result).toContain('2000')
  })

  it('includes remaining calories', () => {
    const result = formatDailySummary('21/03', meals, 830, 2000)
    expect(result).toContain('1170')
  })

  it('includes meal emojis', () => {
    const result = formatDailySummary('21/03', meals, 830, 2000)
    expect(result).toContain('☕') // breakfast
    expect(result).toContain('🍽️') // lunch
    expect(result).toContain('🍎') // snack
    expect(result).toContain('🌙') // dinner
  })

  it('shows all meals when all present', () => {
    const allMeals: DailyMealSummary = {
      breakfast: 300,
      lunch: 500,
      snack: 150,
      dinner: 400,
    }
    const result = formatDailySummary('21/03', allMeals, 1350, 2000)
    expect(result).toContain('300 kcal')
    expect(result).toContain('500 kcal')
    expect(result).toContain('150 kcal')
    expect(result).toContain('400 kcal')
  })
})

// ---------------------------------------------------------------------------
// formatWeeklySummary
// ---------------------------------------------------------------------------
describe('formatWeeklySummary', () => {
  const days: DailyEntry[] = [
    { date: 'Seg', calories: 1850, target: 2000 },
    { date: 'Ter', calories: 2400, target: 2000 },
    { date: 'Qua', calories: 0, target: 2000 },
    { date: 'Dom', calories: 0, target: 2000 },
  ]

  it('shows days within target with ✅', () => {
    const result = formatWeeklySummary(days, 2000)
    expect(result).toContain('Seg')
    expect(result).toContain('1850 kcal')
    expect(result).toContain('✅')
  })

  it('shows days over target with ❌ and overage', () => {
    const result = formatWeeklySummary(days, 2000)
    expect(result).toContain('Ter')
    expect(result).toContain('2400 kcal')
    expect(result).toContain('❌')
    expect(result).toContain('+400')
  })

  it('shows days with no data with a dash or "hoje"', () => {
    const result = formatWeeklySummary(days, 2000)
    expect(result).toContain('Qua')
    // Should show either "—" or similar placeholder
    expect(result).toMatch(/Qua.*—|—.*Qua/)
  })

  it('shows mean (média) at the end', () => {
    const result = formatWeeklySummary(days, 2000)
    expect(result).toContain('Média')
    expect(result).toContain('kcal/dia')
  })

  it('shows target (meta) at the end', () => {
    const result = formatWeeklySummary(days, 2000)
    expect(result).toContain('Meta')
    expect(result).toContain('2000')
    expect(result).toContain('kcal/dia')
  })

  it('calculates mean only from days with data', () => {
    const simpleDays: DailyEntry[] = [
      { date: 'Seg', calories: 2000, target: 2000 },
      { date: 'Ter', calories: 2000, target: 2000 },
    ]
    const result = formatWeeklySummary(simpleDays, 2000)
    expect(result).toContain('2000')
  })
})

// ---------------------------------------------------------------------------
// formatWeightUpdate
// ---------------------------------------------------------------------------
describe('formatWeightUpdate', () => {
  it('shows current weight', () => {
    const result = formatWeightUpdate(76.3, 77.0, 3)
    expect(result).toContain('76.3 kg')
  })

  it('shows previous weight when provided', () => {
    const result = formatWeightUpdate(76.3, 77.0, 3)
    expect(result).toContain('77.0 kg')
  })

  it('shows days since last weigh-in', () => {
    const result = formatWeightUpdate(76.3, 77.0, 3)
    expect(result).toContain('3')
    expect(result).toContain('dias')
  })

  it('shows weight variation', () => {
    const result = formatWeightUpdate(76.3, 77.0, 3)
    expect(result).toContain('-0.7 kg')
  })

  it('shows 📉 emoji for weight loss', () => {
    const result = formatWeightUpdate(76.3, 77.0, 3)
    expect(result).toContain('📉')
  })

  it('shows 📈 emoji for weight gain', () => {
    const result = formatWeightUpdate(78.0, 76.0, 5)
    expect(result).toContain('📈')
  })

  it('shows first registration message when no previous', () => {
    const result = formatWeightUpdate(76.3, null, null)
    expect(result).toContain('76.3 kg')
    expect(result).toContain('Primeiro registro')
  })

  it('does not show variation when no previous', () => {
    const result = formatWeightUpdate(76.3, null, null)
    expect(result).not.toContain('Variação')
    expect(result).not.toContain('📉')
    expect(result).not.toContain('📈')
  })

  it('includes ⚖️ emoji', () => {
    const result = formatWeightUpdate(76.3, 77.0, 3)
    expect(result).toContain('⚖️')
  })

  it('includes registered message', () => {
    const result = formatWeightUpdate(76.3, 77.0, 3)
    expect(result).toContain('Peso registrado')
  })
})

// ---------------------------------------------------------------------------
// formatProgress
// ---------------------------------------------------------------------------
describe('formatProgress', () => {
  it('shows inline format with remaining when under target', () => {
    const result = formatProgress(1230, 2000)
    expect(result).toBe('📊 Hoje: 1230 / 2000 kcal (restam 770)')
  })

  it('shows excedeu when over target', () => {
    const result = formatProgress(2200, 2000)
    expect(result).toBe('📊 Hoje: 2200 / 2000 kcal (excedeu 200 ⚠️)')
  })

  it('shows restam 0 when exactly at target', () => {
    const result = formatProgress(2000, 2000)
    expect(result).toBe('📊 Hoje: 2000 / 2000 kcal (restam 0)')
  })
})

// ---------------------------------------------------------------------------
// formatOnboardingComplete
// ---------------------------------------------------------------------------
describe('formatOnboardingComplete', () => {
  it('includes completion, name, target, macros, and a meal-logging prompt', () => {
    const result = formatOnboardingComplete('João', 2000, {
      proteinG: 140,
      fatG: 60,
      carbsG: 220,
    })

    expect(result).toContain('Tudo pronto, João')
    expect(result).toContain('2000 kcal')
    expect(result).toContain('Proteína 140g')
    expect(result).toContain('Gordura 60g')
    expect(result).toContain('Carboidratos 220g')
    expect(result).toContain('primeira refeição')
  })

  it('does not leak undefined text when macros are omitted', () => {
    const result = formatOnboardingComplete('João', 2000)
    expect(result).toContain('Tudo pronto, João')
    expect(result).toContain('2000 kcal')
    expect(result).not.toContain('undefined')
  })
})

// ---------------------------------------------------------------------------
// formatHelpMenu
// ---------------------------------------------------------------------------
describe('formatHelpMenu', () => {
  it('includes 📋 emoji in header', () => {
    const result = formatHelpMenu()
    expect(result).toContain('📋')
  })

  it('includes all main menu items', () => {
    const result = formatHelpMenu()
    expect(result).toContain('🍽️')
    expect(result).toContain('📊')
    expect(result).toContain('📈')
    expect(result).toContain('⚖️')
    expect(result).toContain('🔍')
    expect(result).toContain('✏️')
    expect(result).toContain('⚙️')
    expect(result).toContain('❓')
  })

  it('includes commands descriptions in PT-BR', () => {
    const result = formatHelpMenu()
    expect(result).toContain('Registrar refeição')
    expect(result).toContain('Resumo do dia')
    expect(result).toContain('Resumo da semana')
    expect(result).toContain('Registrar peso')
    expect(result).toContain('Consulta')
    expect(result).toContain('Corrigir')
    expect(result).toContain('Configurações')
    expect(result).toContain('Meus dados')
  })

  it('includes closing prompt with 😉', () => {
    const result = formatHelpMenu()
    expect(result).toContain('😉')
  })

  it('matches exact PRD format', () => {
    const result = formatHelpMenu()
    const expected = `📋 O que posso fazer:\n\n🍽️ Registrar refeição — me conta o que comeu\n🔎 O que comi? — 'o que comi no almoço?'\n📊 Resumo do dia — 'como tô hoje?'\n📈 Resumo da semana — 'resumo da semana'\n⚖️ Registrar peso — 'pesei Xkg'\n🔍 Consulta — 'quantas calorias tem...'\n✏️ Corrigir — 'corrigir' ou 'apagar último'\n⚙️ Configurações — 'config'\n❓ Meus dados — 'meus dados'\n\nOu só me manda o que comeu que eu resolvo! 😉`
    expect(result).toBe(expected)
  })
})

// ---------------------------------------------------------------------------
// formatSettingsMenu
// ---------------------------------------------------------------------------
describe('formatSettingsMenu', () => {
  const settings = {
    goal: 'Perder peso',
    calorieMode: 'Tabela TACO',
    dailyTarget: 2000,
    remindersEnabled: true,
    detailLevel: 'Detalhado',
  }

  it('includes ⚙️ emoji', () => {
    const result = formatSettingsMenu(settings)
    expect(result).toContain('⚙️')
  })

  it('shows current goal', () => {
    const result = formatSettingsMenu(settings)
    expect(result).toContain('Perder peso')
  })

  it('shows current calorie mode', () => {
    const result = formatSettingsMenu(settings)
    expect(result).toContain('Tabela TACO')
  })

  it('shows current daily target', () => {
    const result = formatSettingsMenu(settings)
    expect(result).toContain('2000')
    expect(result).toContain('kcal')
  })

  it('shows reminders as enabled when true', () => {
    const result = formatSettingsMenu(settings)
    expect(result).toContain('✅')
  })

  it('shows reminders as disabled when false', () => {
    const disabledSettings = { ...settings, remindersEnabled: false }
    const result = formatSettingsMenu(disabledSettings)
    expect(result).toContain('❌')
  })

  it('shows current detail level', () => {
    const result = formatSettingsMenu(settings)
    expect(result).toContain('Detalhado')
  })

  it('shows numbered options 1-7', () => {
    const result = formatSettingsMenu(settings)
    expect(result).toContain('1')
    expect(result).toContain('2')
    expect(result).toContain('3')
    expect(result).toContain('4')
    expect(result).toContain('5')
    expect(result).toContain('6')
    expect(result).toContain('7')
  })

  it('asks which to change', () => {
    const result = formatSettingsMenu(settings)
    expect(result).toContain('alterar')
  })
})

// ---------------------------------------------------------------------------
// formatOutOfScope
// ---------------------------------------------------------------------------
describe('formatOutOfScope', () => {
  it('returns exact text', () => {
    const result = formatOutOfScope()
    expect(result).toBe(
      'Sou especializado em controle de calorias 🍽️ Não consigo te ajudar com isso, mas posso registrar uma refeição ou te mostrar seu resumo do dia!',
    )
  })
})

// ---------------------------------------------------------------------------
// formatError
// ---------------------------------------------------------------------------
describe('formatError', () => {
  it('returns exact text', () => {
    const result = formatError()
    expect(result).toBe('Ops, tive um probleminha aqui 😅 Tenta de novo em alguns segundos?')
  })
})

// ---------------------------------------------------------------------------
// formatMealDetail
// ---------------------------------------------------------------------------
describe('formatMealDetail', () => {
  it('formats a single meal with items', () => {
    const result = formatMealDetail('breakfast', '28/03', [
      {
        mealType: 'breakfast',
        registeredAt: '2026-03-28T11:00:00Z',
        totalCalories: 452,
        items: [
          { foodName: 'Pão francês', quantityGrams: 100, quantityDisplay: '2 un', calories: 300 },
          { foodName: 'Manteiga', quantityGrams: 10, quantityDisplay: null, calories: 72 },
          { foodName: 'Café com leite', quantityGrams: 200, quantityDisplay: '200ml', calories: 80 },
        ],
      },
    ])
    expect(result).toContain('Café da manhã')
    expect(result).toContain('28/03')
    expect(result).toContain('Pão francês')
    expect(result).toContain('2 un')
    expect(result).toContain('300 kcal')
    expect(result).toContain('Manteiga')
    expect(result).toContain('10g')
    expect(result).toContain('72 kcal')
    expect(result).toContain('Café com leite')
    expect(result).toContain('200ml')
    expect(result).toContain('Total: 452 kcal')
  })

  it('formats multiple meals of the same type', () => {
    const result = formatMealDetail('snack', '28/03', [
      {
        mealType: 'snack',
        registeredAt: '2026-03-28T15:00:00Z',
        totalCalories: 372,
        items: [
          { foodName: 'Pão francês', quantityGrams: 100, quantityDisplay: '2 un', calories: 300 },
          { foodName: 'Manteiga', quantityGrams: 10, quantityDisplay: null, calories: 72 },
        ],
      },
      {
        mealType: 'snack',
        registeredAt: '2026-03-28T17:00:00Z',
        totalCalories: 89,
        items: [
          { foodName: 'Banana', quantityGrams: 100, quantityDisplay: '1 un', calories: 89 },
        ],
      },
    ])
    expect(result).toContain('1a refeição')
    expect(result).toContain('2a refeição')
    expect(result).toContain('Total geral: 461 kcal')
  })

  it('returns not-found message when meals array is empty', () => {
    const result = formatMealDetail('breakfast', '28/03', [])
    expect(result).toContain('Não encontrei')
    expect(result).toContain('café da manhã')
    expect(result).toContain('28/03')
  })

  it('formats all meal types when mealType is null', () => {
    const result = formatMealDetail(null, '28/03', [
      {
        mealType: 'breakfast',
        registeredAt: '2026-03-28T11:00:00Z',
        totalCalories: 300,
        items: [
          { foodName: 'Pão', quantityGrams: 50, quantityDisplay: null, calories: 300 },
        ],
      },
      {
        mealType: 'lunch',
        registeredAt: '2026-03-28T14:00:00Z',
        totalCalories: 500,
        items: [
          { foodName: 'Arroz', quantityGrams: 150, quantityDisplay: null, calories: 500 },
        ],
      },
    ])
    expect(result).toContain('Café da manhã')
    expect(result).toContain('Almoço')
    expect(result).toContain('Total geral: 800 kcal')
  })
})
