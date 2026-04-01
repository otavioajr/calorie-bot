import type { SupabaseClient } from '@supabase/supabase-js'
import { getMealDetailByType } from '@/lib/db/queries/meals'
import { formatMealDetail } from '@/lib/utils/formatters'
import { getLLMProvider } from '@/lib/llm/index'

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
  { keywords: ['cafe da manha', 'cafe'], type: 'breakfast' },
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

export interface DateParseResult {
  date: Date
  wasExplicit: boolean
}

export function parseDateFromMessage(message: string, now?: Date): DateParseResult {
  const normalized = normalize(message)
  const today = now ?? new Date()

  // "anteontem" must be checked before "ontem"
  if (normalized.includes('anteontem')) {
    const d = new Date(today)
    d.setUTCDate(d.getUTCDate() - 2)
    return { date: d, wasExplicit: true }
  }

  if (normalized.includes('ontem')) {
    const d = new Date(today)
    d.setUTCDate(d.getUTCDate() - 1)
    return { date: d, wasExplicit: true }
  }

  if (normalized.includes('hoje')) {
    return { date: today, wasExplicit: true }
  }

  // Day of week
  for (const [name, dayIndex] of Object.entries(WEEKDAY_MAP)) {
    if (normalized.includes(name)) {
      const currentDay = today.getUTCDay()
      let diff = currentDay - dayIndex
      if (diff < 0) diff += 7
      // If diff is 0, it means today (same weekday)
      const d = new Date(today)
      d.setUTCDate(d.getUTCDate() - diff)
      return { date: d, wasExplicit: true }
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
    return { date: d, wasExplicit: true }
  }

  // Default: today (not explicit)
  return { date: today, wasExplicit: false }
}

// ---------------------------------------------------------------------------
// hasTemporalHints
// ---------------------------------------------------------------------------

const TEMPORAL_HINTS: readonly string[] = [
  'passada',
  'passado',
  'anterior',
  'janeiro',
  'fevereiro',
  'marco',
  'abril',
  'maio',
  'junho',
  'julho',
  'agosto',
  'setembro',
  'outubro',
  'novembro',
  'dezembro',
  'semana passada',
  'mes passado',
]

function hasTemporalHints(message: string): boolean {
  const normalized = normalize(message)
  return TEMPORAL_HINTS.some((hint) => normalized.includes(hint))
}

// ---------------------------------------------------------------------------
// parseMealDetailFromLLM (fallback)
// ---------------------------------------------------------------------------

async function parseMealDetailFromLLM(
  message: string,
  todayStr: string,
): Promise<{ mealType: string | null; date: Date | null }> {
  const llm = getLLMProvider()
  const systemPrompt = `Extraia o tipo de refeição e a data da mensagem do usuário.
Hoje é ${todayStr}.
Responda APENAS com JSON: {"meal_type": "breakfast|lunch|snack|dinner|supper|null", "date": "YYYY-MM-DD"}
Se não conseguir identificar o tipo, use null para meal_type.
Se não conseguir identificar a data, use a data de hoje.
Tipos válidos: breakfast, lunch, snack, dinner, supper.`

  try {
    const raw = await llm.chat(message, systemPrompt, true)
    const parsed = JSON.parse(raw.trim()) as { meal_type: string | null; date: string | null }
    return {
      mealType: parsed.meal_type ?? null,
      date: parsed.date ? new Date(parsed.date + 'T12:00:00Z') : null,
    }
  } catch {
    return { mealType: null, date: null }
  }
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
// formatDateISO
// ---------------------------------------------------------------------------

function formatDateISO(date: Date, timezone: string): string {
  return date.toLocaleDateString('sv-SE', { timeZone: timezone }) // sv-SE gives YYYY-MM-DD
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

  // 1. Rules-based parsing
  let mealType = parseMealType(message)
  const { date, wasExplicit } = parseDateFromMessage(message)
  let targetDate = date

  // 2. LLM fallback if date wasn't explicit and message has temporal hints
  if (!wasExplicit && hasTemporalHints(message)) {
    const todayStr = formatDateISO(date, timezone)
    const llmResult = await parseMealDetailFromLLM(message, todayStr)
    if (llmResult.date) targetDate = llmResult.date
    if (llmResult.mealType && !mealType) mealType = llmResult.mealType
  }

  // 3. Query the database
  const meals = await getMealDetailByType(supabase, userId, mealType, targetDate, timezone)

  // 4. Format the response
  const dateStr = formatDateBR(targetDate, timezone)

  return formatMealDetail(mealType, dateStr, meals)
}
