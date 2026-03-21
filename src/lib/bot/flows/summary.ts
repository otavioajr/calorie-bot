import type { SupabaseClient } from '@supabase/supabase-js'
import { getDailyCalories, getDailyMeals } from '@/lib/db/queries/meals'
import {
  formatDailySummary,
  formatWeeklySummary,
} from '@/lib/utils/formatters'
import type { DailyMealSummary, DailyEntry } from '@/lib/utils/formatters'

// ---------------------------------------------------------------------------
// Type helpers
// ---------------------------------------------------------------------------

type SummaryType = 'daily' | 'weekly'

// ---------------------------------------------------------------------------
// detectSummaryType
// ---------------------------------------------------------------------------

function detectSummaryType(message: string): SummaryType {
  const lower = message.toLowerCase()

  if (lower.includes('semana')) return 'weekly'

  // Default: daily
  return 'daily'
}

// ---------------------------------------------------------------------------
// formatDateBR
// ---------------------------------------------------------------------------

function formatDateBR(date: Date): string {
  return date.toLocaleDateString('pt-BR', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    timeZone: 'UTC',
  })
}

// ---------------------------------------------------------------------------
// buildDailyMealSummary  (helper)
// ---------------------------------------------------------------------------

function buildDailyMealSummary(
  rows: Array<{ mealType: string; totalCalories: number }>,
): { meals: DailyMealSummary; totalCalories: number } {
  const meals: DailyMealSummary = {}
  let totalCalories = 0

  for (const row of rows) {
    const cal = row.totalCalories
    totalCalories += cal

    const type = row.mealType as keyof DailyMealSummary
    if (
      type === 'breakfast' ||
      type === 'lunch' ||
      type === 'snack' ||
      type === 'dinner' ||
      type === 'supper'
    ) {
      const existing = meals[type]
      meals[type] = existing !== undefined ? existing + cal : cal
    }
  }

  return { meals, totalCalories }
}

// ---------------------------------------------------------------------------
// handleSummary
// ---------------------------------------------------------------------------

export async function handleSummary(
  supabase: SupabaseClient,
  userId: string,
  message: string,
  user: { dailyCalorieTarget: number | null },
): Promise<string> {
  const summaryType = detectSummaryType(message)
  const target = user.dailyCalorieTarget ?? 2000

  if (summaryType === 'weekly') {
    return handleWeeklySummary(supabase, userId, target)
  }

  return handleDailySummary(supabase, userId, target)
}

// ---------------------------------------------------------------------------
// handleDailySummary
// ---------------------------------------------------------------------------

async function handleDailySummary(
  supabase: SupabaseClient,
  userId: string,
  target: number,
): Promise<string> {
  const today = new Date()
  const rows = await getDailyMeals(supabase, userId, today)
  const { meals, totalCalories } = buildDailyMealSummary(rows)
  const dateStr = formatDateBR(today)

  return formatDailySummary(dateStr, meals, totalCalories, target)
}

// ---------------------------------------------------------------------------
// handleWeeklySummary
// ---------------------------------------------------------------------------

async function handleWeeklySummary(
  supabase: SupabaseClient,
  userId: string,
  target: number,
): Promise<string> {
  const days: DailyEntry[] = []

  for (let i = 6; i >= 0; i--) {
    const date = new Date()
    date.setUTCDate(date.getUTCDate() - i)
    date.setUTCHours(0, 0, 0, 0)

    const calories = await getDailyCalories(supabase, userId, date)

    days.push({
      date: formatDateBR(date),
      calories,
      target,
    })
  }

  return formatWeeklySummary(days, target)
}
