import type { SupabaseClient } from '@supabase/supabase-js'
import { getMealDetailByType } from '@/lib/db/queries/meals'
import { formatMealDetail } from '@/lib/utils/formatters'
import { getLLMProvider } from '@/lib/llm/index'
import { parseDateFromMessage } from '@/lib/utils/relative-date'

// Re-export so existing consumers/tests can keep importing from this module.
export { parseDateFromMessage }
export type { DateParseResult } from '@/lib/utils/relative-date'

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
  { keywords: ['jantar', 'janta', 'jantei'], type: 'dinner' },
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
