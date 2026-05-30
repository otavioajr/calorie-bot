// ---------------------------------------------------------------------------
// Relative date parsing + labels (shared by meal logging and meal_detail query)
// ---------------------------------------------------------------------------

function normalize(message: string): string {
  return message
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
}

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

/**
 * Parses a relative date reference ("ontem", "anteontem", "hoje", weekday, "dia X")
 * out of a message. Returns an instant offset from `now` and whether the reference
 * was explicit. When nothing is found, returns `now` with wasExplicit=false.
 */
export function parseDateFromMessage(message: string, now?: Date): DateParseResult {
  const normalized = normalize(message)
  const today = now ?? new Date()

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

  for (const [name, dayIndex] of Object.entries(WEEKDAY_MAP)) {
    if (normalized.includes(name)) {
      const currentDay = today.getUTCDay()
      let diff = currentDay - dayIndex
      if (diff < 0) diff += 7
      const d = new Date(today)
      d.setUTCDate(d.getUTCDate() - diff)
      return { date: d, wasExplicit: true }
    }
  }

  const dayMatch = normalized.match(/dia\s+(\d{1,2})/)
  if (dayMatch) {
    const dayNum = parseInt(dayMatch[1], 10)
    const todayDayOfMonth = today.getUTCDate()
    const d = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), dayNum, 12, 0, 0))
    if (d.getUTCDate() !== dayNum || dayNum > todayDayOfMonth) {
      d.setUTCMonth(d.getUTCMonth() - 1)
      d.setUTCDate(dayNum)
    }
    return { date: d, wasExplicit: true }
  }

  return { date: today, wasExplicit: false }
}

/** Returns the local calendar date (YYYY-MM-DD) of an instant in a timezone. */
export function localDateString(date: Date, timezone: string = 'America/Sao_Paulo'): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date)
}

/** Human label for a consumption date: "Hoje" | "Ontem" | "qua 24/05". */
export function formatDateLabel(date: Date, timezone: string = 'America/Sao_Paulo', now?: Date): string {
  const reference = now ?? new Date()
  const target = localDateString(date, timezone)
  if (target === localDateString(reference, timezone)) return 'Hoje'
  const yesterday = new Date(reference.getTime() - 24 * 60 * 60 * 1000)
  if (target === localDateString(yesterday, timezone)) return 'Ontem'

  const formatted = new Intl.DateTimeFormat('pt-BR', {
    timeZone: timezone,
    weekday: 'short',
    day: '2-digit',
    month: '2-digit',
  }).format(date)
  // "qua., 24/05" -> "qua 24/05"
  return formatted.replace(/\.,?/g, '').replace(/\s+/g, ' ').trim()
}
