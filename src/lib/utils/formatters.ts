// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface MealItem {
  food: string
  quantityGrams: number
  calories: number
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
): string {
  const itemLines = items
    .map((item) => `• ${item.food} (${item.quantityGrams}g) — ${item.calories} kcal`)
    .join('\n')

  const remaining = dailyTarget - dailyConsumed
  const progressLine = formatProgress(dailyConsumed, dailyTarget)

  return [
    `🍽️ ${translateMealType(mealType)} registrado!`,
    '',
    itemLines,
    '',
    `Total: ${total} kcal`,
    '',
    progressLine,
    '',
    'Tá certo? (sim / corrigir)',
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

  return [
    `📊 Resumo de hoje (${date}):`,
    '',
    breakfastLine,
    lunchLine,
    snackLine,
    dinnerLine,
    '',
    `Total: ${consumed} / ${target} kcal`,
    `Restam: ${remaining} kcal`,
  ].join('\n')
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
export function formatProgress(consumed: number, target: number): string {
  const remaining = target - consumed

  if (remaining < 0) {
    const over = Math.abs(remaining)
    return `📊 Hoje: ${consumed} / ${target} kcal (excedeu ${over} ⚠️)`
  }

  return `📊 Hoje: ${consumed} / ${target} kcal (restam ${remaining})`
}

// ---------------------------------------------------------------------------
// formatOnboardingComplete
// ---------------------------------------------------------------------------
export function formatOnboardingComplete(name: string, target: number): string {
  return `Tudo pronto, ${name}! 🎉\nSua meta diária é de ${target} kcal.\n\nAgora é só me mandar o que comeu! Exemplos:\n• 'almocei arroz, feijão e frango'\n• 'comi um pão com ovo no café'\n• 'lanche: 1 banana e granola'\n\nDica: manda 'menu' a qualquer momento pra ver o que posso fazer.`
}

// ---------------------------------------------------------------------------
// formatHelpMenu
// ---------------------------------------------------------------------------
export function formatHelpMenu(): string {
  return `📋 O que posso fazer:\n\n🍽️ Registrar refeição — me conta o que comeu\n📊 Resumo do dia — 'como tô hoje?'\n📈 Resumo da semana — 'resumo da semana'\n⚖️ Registrar peso — 'pesei Xkg'\n🔍 Consulta — 'quantas calorias tem...'\n✏️ Corrigir — 'corrigir' ou 'apagar último'\n⚙️ Configurações — 'config'\n❓ Meus dados — 'meus dados'\n\nOu só me manda o que comeu que eu resolvo! 😉`
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
