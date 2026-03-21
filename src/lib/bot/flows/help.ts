import type { SupabaseClient } from '@supabase/supabase-js'
import { getUserWithSettings } from '@/lib/db/queries/users'
import { formatHelpMenu } from '@/lib/utils/formatters'

// ---------------------------------------------------------------------------
// Goal display mapping
// ---------------------------------------------------------------------------

const GOAL_LABELS: Record<string, string> = {
  lose: 'Perder peso',
  maintain: 'Manter peso',
  gain: 'Ganhar massa',
}

const ACTIVITY_LABELS: Record<string, string> = {
  sedentary: 'Sedentário',
  light: 'Leve',
  moderate: 'Moderado',
  intense: 'Intenso',
}

// ---------------------------------------------------------------------------
// handleHelp
// ---------------------------------------------------------------------------

/**
 * Returns the help menu formatted message.
 */
export async function handleHelp(): Promise<string> {
  return formatHelpMenu()
}

// ---------------------------------------------------------------------------
// handleUserData
// ---------------------------------------------------------------------------

/**
 * Fetches user data and returns a formatted summary.
 */
export async function handleUserData(
  supabase: SupabaseClient,
  userId: string,
): Promise<string> {
  const { user, settings } = await getUserWithSettings(supabase, userId)

  const goalLabel = user.goal ? (GOAL_LABELS[user.goal] ?? user.goal) : 'Não definido'
  const activityLabel = user.activityLevel
    ? (ACTIVITY_LABELS[user.activityLevel] ?? user.activityLevel)
    : 'Não definido'

  const lines: string[] = [
    `👤 Seus dados, ${user.name}:`,
    '',
    `⚖️ Peso: ${user.weightKg ?? '—'} kg`,
    `📏 Altura: ${user.heightCm ?? '—'} cm`,
    `🎂 Idade: ${user.age ?? '—'} anos`,
    `🎯 Objetivo: ${goalLabel}`,
    `🏃 Atividade: ${activityLabel}`,
    `🔥 Meta diária: ${user.dailyCalorieTarget ?? '—'} kcal`,
  ]

  if (user.tmb && user.tdee) {
    lines.push(`📊 TMB: ${user.tmb} kcal | TDEE: ${user.tdee} kcal`)
  }

  if (settings) {
    const reminders = settings.remindersEnabled ? '✅ ligados' : '❌ desligados'
    lines.push(`🔔 Lembretes: ${reminders}`)
  }

  return lines.join('\n')
}
