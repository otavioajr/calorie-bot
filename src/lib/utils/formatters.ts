// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface MealItem {
  food: string
  quantityGrams: number
  quantityDisplay?: string | null
  calories: number
  confidence?: string
}

export interface DailyMealSummary {
  breakfast?: number
  lunch?: number
  snack?: number
  dinner?: number
  supper?: number
}

export interface DailyEntry {
  date: string
  calories: number
  target: number
}

// ---------------------------------------------------------------------------
// Meal type translation
// ---------------------------------------------------------------------------
const MEAL_TYPE_PT: Record<string, string> = {
  breakfast: 'Café da manhã',
  lunch: 'Almoço',
  snack: 'Lanche',
  dinner: 'Jantar',
  supper: 'Ceia',
}

function translateMealType(mealType: string): string {
  return MEAL_TYPE_PT[mealType] ?? mealType
}

// ---------------------------------------------------------------------------
// formatMealBreakdown
// ---------------------------------------------------------------------------
export function formatMealBreakdown(
  mealType: string,
  items: MealItem[],
  total: number,
  dailyConsumed: number,
  dailyTarget: number,
  macros?: {
    consumed: { proteinG: number; fatG: number; carbsG: number }
    target: { proteinG: number; fatG: number; carbsG: number }
  },
): string {
  const itemLines = items
    .map((item) => {
      const display = item.quantityDisplay || `${item.quantityGrams}g`
      const calStr = item.confidence === 'low' ? `~${item.calories}` : `${item.calories}`
      const indicator = item.confidence === 'low' ? ' ⚠️' : ''
      return `• ${item.food} (${display}) — ${calStr} kcal${indicator}`
    })
    .join('\n')

  const progressLine = formatProgress(dailyConsumed, dailyTarget, macros)

  const lowConfItems = items.filter(i => i.confidence === 'low')
  const lowConfNotice = lowConfItems.length > 0
    ? `\n⚠️ Valores com este sinal são estimados. Pra corrigir, me manda as calorias certas (ex: "magic toast são 160 kcal")`
    : ''

  return [
    `🍽️ ${translateMealType(mealType)} registrado!`,
    '',
    itemLines,
    '',
    `Total: ${total} kcal`,
    '',
    progressLine,
    lowConfNotice,
    '',
    'Algo errado? Manda "corrigir"',
  ].filter(Boolean).join('\n')
}

// ---------------------------------------------------------------------------
// formatMultiMealBreakdown
// ---------------------------------------------------------------------------
export function formatMultiMealBreakdown(
  meals: Array<{
    mealType: string
    items: MealItem[]
    total: number
  }>,
  dailyConsumed: number,
  dailyTarget: number,
  macros?: {
    consumed: { proteinG: number; fatG: number; carbsG: number }
    target: { proteinG: number; fatG: number; carbsG: number }
  },
): string {
  const sections = meals.map((meal) => {
    const itemLines = meal.items
      .map((item) => {
        const display = item.quantityDisplay || `${item.quantityGrams}g`
        const calStr = item.confidence === 'low' ? `~${item.calories}` : `${item.calories}`
        const indicator = item.confidence === 'low' ? ' ⚠️' : ''
        return `• ${item.food} (${display}) — ${calStr} kcal${indicator}`
      })
      .join('\n')

    return `🍽️ ${translateMealType(meal.mealType)}:\n${itemLines}\nSubtotal: ${meal.total} kcal`
  })

  const grandTotal = meals.reduce((sum, meal) => sum + meal.total, 0)
  const progressLine = formatProgress(dailyConsumed, dailyTarget, macros)

  return [
    ...sections,
    '',
    `Total geral: ${grandTotal} kcal`,
    '',
    progressLine,
    '',
    'Algo errado? Manda "corrigir"',
  ].join('\n')
}

// ---------------------------------------------------------------------------
// formatDailySummary
// ---------------------------------------------------------------------------
export function formatDailySummary(
  date: string,
  meals: DailyMealSummary,
  consumed: number,
  target: number,
  macros?: {
    consumed: { proteinG: number; fatG: number; carbsG: number }
    target: { proteinG: number; fatG: number; carbsG: number }
  },
): string {
  const notRegistered = '— (não registrado)'

  const breakfastLine =
    meals.breakfast !== undefined
      ? `☕ Café: ${meals.breakfast} kcal`
      : `☕ Café: ${notRegistered}`

  const lunchLine =
    meals.lunch !== undefined ? `🍽️ Almoço: ${meals.lunch} kcal` : `🍽️ Almoço: ${notRegistered}`

  const snackLine =
    meals.snack !== undefined ? `🍎 Lanche: ${meals.snack} kcal` : `🍎 Lanche: ${notRegistered}`

  const dinnerLine =
    meals.dinner !== undefined ? `🌙 Jantar: ${meals.dinner} kcal` : `🌙 Jantar: ${notRegistered}`

  const remaining = target - consumed

  const lines = [
    `📊 Resumo de hoje (${date}):`,
    '',
    breakfastLine,
    lunchLine,
    snackLine,
    dinnerLine,
    '',
    `Total: ${consumed} / ${target} kcal`,
    `Restam: ${remaining} kcal`,
  ]

  if (macros) {
    lines.push(
      `P: ${macros.consumed.proteinG}/${macros.target.proteinG}g | G: ${macros.consumed.fatG}/${macros.target.fatG}g | C: ${macros.consumed.carbsG}/${macros.target.carbsG}g`,
    )
  }

  return lines.join('\n')
}

// ---------------------------------------------------------------------------
// formatWeeklySummary
// ---------------------------------------------------------------------------
export function formatWeeklySummary(days: DailyEntry[], target: number): string {
  const dayLines = days.map((day) => {
    if (day.calories === 0) {
      return `${day.date}: — (hoje)`
    }

    if (day.calories <= day.target) {
      return `${day.date}: ${day.calories} kcal ✅`
    }

    const over = day.calories - day.target
    return `${day.date}: ${day.calories} kcal ❌ (+${over})`
  })

  const daysWithData = days.filter((d) => d.calories > 0)
  const mean =
    daysWithData.length > 0
      ? Math.round(daysWithData.reduce((sum, d) => sum + d.calories, 0) / daysWithData.length)
      : 0

  return [...dayLines, '', `Média: ${mean} kcal/dia`, `Meta: ${target} kcal/dia`].join('\n')
}

// ---------------------------------------------------------------------------
// formatWeightUpdate
// ---------------------------------------------------------------------------
export function formatWeightUpdate(
  current: number,
  previous: number | null,
  daysSince: number | null,
): string {
  const lines: string[] = [`Peso registrado! ⚖️`, `Hoje: ${current} kg`]

  if (previous !== null && daysSince !== null) {
    lines.push(`Última pesagem: ${previous.toFixed(1)} kg (há ${daysSince} dias)`)

    const variation = current - previous
    const variationStr = variation < 0 ? `${variation.toFixed(1)} kg` : `+${variation.toFixed(1)} kg`
    const trendEmoji = variation < 0 ? '📉' : '📈'
    lines.push(`Variação: ${variationStr} ${trendEmoji}`)
  } else {
    lines.push('Primeiro registro!')
  }

  return lines.join('\n')
}

// ---------------------------------------------------------------------------
// formatProgress
// ---------------------------------------------------------------------------
export function formatProgress(
  consumed: number,
  target: number,
  macros?: {
    consumed: { proteinG: number; fatG: number; carbsG: number }
    target: { proteinG: number; fatG: number; carbsG: number }
  },
): string {
  const remaining = target - consumed

  let calorieLine: string
  if (remaining < 0) {
    const over = Math.abs(remaining)
    calorieLine = `📊 Hoje: ${consumed} / ${target} kcal (excedeu ${over} ⚠️)`
  } else {
    calorieLine = `📊 Hoje: ${consumed} / ${target} kcal (restam ${remaining})`
  }

  if (!macros) {
    return calorieLine
  }

  const macroLine = `P: ${macros.consumed.proteinG}/${macros.target.proteinG}g | G: ${macros.consumed.fatG}/${macros.target.fatG}g | C: ${macros.consumed.carbsG}/${macros.target.carbsG}g`
  return `${calorieLine}\n${macroLine}`
}

// ---------------------------------------------------------------------------
// formatOnboardingComplete
// ---------------------------------------------------------------------------
export function formatOnboardingComplete(
  name: string,
  target: number,
  macros?: { proteinG: number; fatG: number; carbsG: number },
): string {
  const lines = [`Tudo pronto, ${name}. ✨`, `Sua meta diária ficou em ${target} kcal.`]

  if (macros) {
    lines.push(
      `Macros de referência: Proteína ${macros.proteinG}g | Gordura ${macros.fatG}g | Carboidratos ${macros.carbsG}g.`,
    )
  }

  lines.push('', 'Quando quiser, me envie sua primeira refeição e eu registro para você.')

  return lines.join('\n')
}

// ---------------------------------------------------------------------------
// formatHelpMenu
// ---------------------------------------------------------------------------
export function formatHelpMenu(): string {
  return `📋 O que posso fazer:\n\n🍽️ Registrar refeição — me conta o que comeu\n🔎 O que comi? — 'o que comi no almoço?'\n📊 Resumo do dia — 'como tô hoje?'\n📈 Resumo da semana — 'resumo da semana'\n⚖️ Registrar peso — 'pesei Xkg'\n🔍 Consulta — 'quantas calorias tem...'\n✏️ Corrigir — 'corrigir' ou 'apagar último'\n⚙️ Configurações — 'config'\n❓ Meus dados — 'meus dados'\n\nOu só me manda o que comeu que eu resolvo! 😉`
}

// ---------------------------------------------------------------------------
// formatSettingsMenu
// ---------------------------------------------------------------------------
export function formatSettingsMenu(settings: {
  goal: string
  calorieMode: string
  dailyTarget: number
  remindersEnabled: boolean
  detailLevel: string
}): string {
  const remindersStatus = settings.remindersEnabled ? '✅ ligados' : '❌ desligados'

  return [
    '⚙️ Configurações:',
    '',
    `1️⃣ Objetivo (atual: ${settings.goal})`,
    `2️⃣ Modo de cálculo (atual: ${settings.calorieMode})`,
    `3️⃣ Meta calórica (atual: ${settings.dailyTarget} kcal)`,
    `4️⃣ Lembretes (atual: ${remindersStatus})`,
    `5️⃣ Nível de detalhe (atual: ${settings.detailLevel})`,
    `6️⃣ Atualizar peso`,
    `7️⃣ Abrir painel completo na web`,
    `8️⃣ Limpar dados e recomeçar`,
    '',
    'Qual quer alterar?',
  ].join('\n')
}

// ---------------------------------------------------------------------------
// formatOutOfScope
// ---------------------------------------------------------------------------
export function formatOutOfScope(): string {
  return 'Sou especializado em controle de calorias 🍽️ Não consigo te ajudar com isso, mas posso registrar uma refeição ou te mostrar seu resumo do dia!'
}

// ---------------------------------------------------------------------------
// formatError
// ---------------------------------------------------------------------------
export function formatError(): string {
  return 'Ops, tive um probleminha aqui 😅 Tenta de novo em alguns segundos?'
}

// ---------------------------------------------------------------------------
// formatDecompositionFeedback
// ---------------------------------------------------------------------------
export function formatDecompositionFeedback(foodNames: string[]): string {
  if (foodNames.length === 1) {
    return `Não encontrei "${foodNames[0]}" na Tabela TACO. Vou decompor nos ingredientes, um momento... 🔍`
  }
  const list = foodNames.join(', ')
  return `Não encontrei ${list} na Tabela TACO. Vou decompor nos ingredientes, um momento... 🔍`
}

// ---------------------------------------------------------------------------
// formatSearchFeedback
// ---------------------------------------------------------------------------
export function formatSearchFeedback(): string {
  return 'Encontrando os alimentos... 🔍'
}

// ---------------------------------------------------------------------------
// formatDefaultNotice
// ---------------------------------------------------------------------------
export function formatDefaultNotice(defaults: Array<{ foodBase: string; foodVariant: string }>): string {
  if (defaults.length === 0) return ''
  if (defaults.length === 1) {
    const d = defaults[0]
    return `\nℹ️ Usei ${d.foodBase.toLowerCase()} ${d.foodVariant.split(',')[0]} como padrão. Se for outro tipo, me diz qual!`
  }
  const list = defaults.map(d => `${d.foodBase.toLowerCase()} ${d.foodVariant.split(',')[0]}`).join(', ')
  return `\nℹ️ Usei como padrão: ${list}. Se algum for diferente, me diz qual!`
}

// ---------------------------------------------------------------------------
// formatMealDetail
// ---------------------------------------------------------------------------

const MEAL_TYPE_EMOJI: Record<string, string> = {
  breakfast: '☕',
  lunch: '🍽️',
  snack: '🍎',
  dinner: '🌙',
  supper: '🌙',
}

interface MealDetailForFormat {
  mealType: string
  registeredAt: string
  totalCalories: number
  items: Array<{
    foodName: string
    quantityGrams: number
    quantityDisplay: string | null
    calories: number
  }>
}

export function formatMealDetail(
  mealType: string | null,
  dateStr: string,
  meals: MealDetailForFormat[],
): string {
  if (meals.length === 0) {
    if (mealType) {
      const typeName = translateMealType(mealType).toLowerCase()
      return `Não encontrei nenhum registro de ${typeName} em ${dateStr} ${MEAL_TYPE_EMOJI[mealType] ?? '🍽️'}`
    }
    return `Não encontrei nenhum registro de refeição em ${dateStr} 🍽️`
  }

  const emoji = mealType
    ? (MEAL_TYPE_EMOJI[mealType] ?? '🍽️')
    : '📋'
  const title = mealType
    ? translateMealType(mealType)
    : 'Refeições'

  // Single meal — simple format
  if (meals.length === 1) {
    const meal = meals[0]
    const itemLines = meal.items
      .map((item) => {
        const display = item.quantityDisplay || `${item.quantityGrams}g`
        return `• ${item.foodName} (${display}) — ${item.calories} kcal`
      })
      .join('\n')

    return [
      `${emoji} ${title} (${dateStr}):`,
      '',
      itemLines,
      '',
      `Total: ${meal.totalCalories} kcal`,
    ].join('\n')
  }

  // Multiple meals — numbered format
  const sections = meals.map((meal, index) => {
    const itemLines = meal.items
      .map((item) => {
        const display = item.quantityDisplay || `${item.quantityGrams}g`
        return `• ${item.foodName} (${display}) — ${item.calories} kcal`
      })
      .join('\n')

    const sectionTitle = mealType
      ? `${index + 1}a refeição:`
      : `${MEAL_TYPE_EMOJI[meal.mealType] ?? '🍽️'} ${translateMealType(meal.mealType)}:`

    return `${sectionTitle}\n${itemLines}\nTotal: ${meal.totalCalories} kcal`
  })

  const grandTotal = meals.reduce((sum, meal) => sum + meal.totalCalories, 0)

  return [
    `${emoji} ${title} (${dateStr}):`,
    '',
    ...sections,
    '',
    `Total geral: ${grandTotal} kcal`,
  ].join('\n')
}
