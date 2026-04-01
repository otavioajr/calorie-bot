import type { SupabaseClient } from '@supabase/supabase-js'
import { getMealDetailByType } from '@/lib/db/queries/meals'
import { formatMealDetail } from '@/lib/utils/formatters'

// ---------------------------------------------------------------------------
// normalize (same as router.ts)
// ---------------------------------------------------------------------------

function normalize(message: string): string {
  return message
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
}

// ---------------------------------------------------------------------------
// parseMealType
// ---------------------------------------------------------------------------

const MEAL_TYPE_MAP: Array<{ keywords: string[]; type: string }> = [
  { keywords: ['cafe da manha', 'cafe', 'manha'], type: 'breakfast' },
  { keywords: ['almoco'], type: 'lunch' },
  { keywords: ['lanche'], type: 'snack' },
  { keywords: ['jantar', 'janta'], type: 'dinner' },
  { keywords: ['ceia'], type: 'supper' },
]

export function parseMealType(message: string): string | null {
  const normalized = normalize(message)

  // Check longer keywords first (cafe da manha before cafe)
  for (const entry of MEAL_TYPE_MAP) {
    for (const kw of entry.keywords) {
      if (normalized.includes(kw)) return entry.type
    }
  }

  return null
}

// ---------------------------------------------------------------------------
// parseDateFromMessage
// ---------------------------------------------------------------------------

const WEEKDAY_MAP: Record<string, number> = {
  domingo: 0,
  segunda: 1,
  terca: 2,
  quarta: 3,
  quinta: 4,
  sexta: 5,
  sabado: 6,
}

export function parseDateFromMessage(message: string, now?: Date): Date {
  const normalized = normalize(message)
  const today = now ?? new Date()

  // "anteontem" must be checked before "ontem"
  if (normalized.includes('anteontem')) {
    const d = new Date(today)
    d.setDate(d.getDate() - 2)
    return d
  }

  if (normalized.includes('ontem')) {
    const d = new Date(today)
    d.setDate(d.getDate() - 1)
    return d
  }

  if (normalized.includes('hoje')) {
    return today
  }

  // Day of week
  for (const [name, dayIndex] of Object.entries(WEEKDAY_MAP)) {
    if (normalized.includes(name)) {
      const currentDay = today.getDay()
      let diff = currentDay - dayIndex
      if (diff < 0) diff += 7
      // If diff is 0, it means today (same weekday)
      const d = new Date(today)
      d.setDate(d.getDate() - diff)
      return d
    }
  }

  // "dia X" or "dia XX"
  const dayMatch = normalized.match(/dia\s+(\d{1,2})/)
  if (dayMatch) {
    const dayNum = parseInt(dayMatch[1], 10)
    const todayDayOfMonth = today.getUTCDate()
    const d = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), dayNum, 12, 0, 0))
    // If the day hasn't arrived yet this month, go to previous month
    if (d.getUTCDate() !== dayNum || dayNum > todayDayOfMonth) {
      d.setUTCMonth(d.getUTCMonth() - 1)
      d.setUTCDate(dayNum)
    }
    return d
  }

  // Default: today
  return today
}

// ---------------------------------------------------------------------------
// formatDateBR
// ---------------------------------------------------------------------------

function formatDateBR(date: Date, timezone: string): string {
  return date.toLocaleDateString('pt-BR', {
    day: '2-digit',
    month: '2-digit',
    timeZone: timezone,
  })
}

// ---------------------------------------------------------------------------
// handleMealDetail
// ---------------------------------------------------------------------------

export async function handleMealDetail(
  supabase: SupabaseClient,
  userId: string,
  message: string,
  user: { timezone?: string },
): Promise<string> {
  const timezone = user.timezone ?? 'America/Sao_Paulo'

  // 1. Try rules-based parsing
  const mealType = parseMealType(message)
  const date = parseDateFromMessage(message)

  // 2. Query the database
  const meals = await getMealDetailByType(supabase, userId, mealType, date, timezone)

  // 3. Format the response
  const dateStr = formatDateBR(date, timezone)

  return formatMealDetail(mealType, dateStr, meals)
}
