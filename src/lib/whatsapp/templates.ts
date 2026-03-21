export function buildDailyReminderMessage(): string {
  return 'Ei! 🍽️ Ainda não vi registro de almoço hoje. Me conta o que comeu?'
}

export function buildDailySummaryMessage(consumed: number, target: number): string {
  const remaining = target - consumed
  if (remaining > 0) {
    return `📊 Resumo do dia: ${consumed} / ${target} kcal (restam ${remaining}). Boa noite! 🌙`
  }
  return `📊 Resumo do dia: ${consumed} / ${target} kcal (excedeu ${Math.abs(remaining)} ⚠️). Boa noite! 🌙`
}

export function buildWeeklySummaryMessage(avgCalories: number, target: number): string {
  return `📈 Resumo da semana: média de ${avgCalories} kcal/dia (meta: ${target}). Continue assim! 💪`
}
