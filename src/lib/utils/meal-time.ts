import type { MealAnalysis } from '@/lib/llm/schemas/meal-analysis'

export type MealType = MealAnalysis['meal_type']

export function getUserLocalTime(timezone?: string): string {
  const tz = timezone || 'America/Sao_Paulo'
  return new Date().toLocaleTimeString('pt-BR', {
    timeZone: tz,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  })
}

export function classifyMealTypeByTime(time: string): MealType {
  const [hourStr, minuteStr] = time.split(':')
  const hour = Number.parseInt(hourStr ?? '', 10)
  const minute = Number.parseInt(minuteStr ?? '0', 10)

  if (!Number.isFinite(hour)) return 'snack'

  const totalMinutes = hour * 60 + (Number.isFinite(minute) ? minute : 0)

  if (totalMinutes >= 5 * 60 && totalMinutes < 11 * 60) return 'breakfast'
  if (totalMinutes >= 11 * 60 && totalMinutes < 15 * 60) return 'lunch'
  if (totalMinutes >= 15 * 60 && totalMinutes < 18 * 60) return 'snack'
  if (totalMinutes >= 18 * 60 && totalMinutes < 22 * 60) return 'dinner'
  return 'supper'
}

// Keyword → meal_type map for image captions. Only unambiguous meal mentions
// are listed here — bare "café" is intentionally excluded because it is often
// consumed outside breakfast (e.g. espresso after lunch). When the caption
// lacks an explicit meal name, the caller falls back to the user's local
// time via classifyMealTypeByTime, which correctly maps a morning "café" to
// breakfast and an afternoon one to snack.
const MEAL_KEYWORDS: Array<{ phrases: string[]; mealType: MealType }> = [
  { phrases: ['cafe da manha', 'desjejum'], mealType: 'breakfast' },
  { phrases: ['almoco', 'almocei', 'almocar'], mealType: 'lunch' },
  { phrases: ['lanche da tarde', 'lanche da manha', 'lanche', 'lanchei'], mealType: 'snack' },
  { phrases: ['jantar', 'janta', 'jantei'], mealType: 'dinner' },
  { phrases: ['ceia', 'ceando'], mealType: 'supper' },
]

const DIACRITIC_PATTERN = /[̀-ͯ]/g

function tokenize(caption: string): string[] {
  return caption
    .normalize('NFD')
    .replace(DIACRITIC_PATTERN, '')
    .toLowerCase()
    .split(/[^a-z0-9]+/u)
    .filter(Boolean)
}

function tokensContainPhrase(tokens: string[], phraseTokens: string[]): boolean {
  if (phraseTokens.length === 0) return false
  for (let i = 0; i <= tokens.length - phraseTokens.length; i++) {
    let match = true
    for (let j = 0; j < phraseTokens.length; j++) {
      if (tokens[i + j] !== phraseTokens[j]) {
        match = false
        break
      }
    }
    if (match) return true
  }
  return false
}

export function detectExplicitMealType(caption?: string | null): MealType | null {
  if (!caption) return null
  const tokens = tokenize(caption)
  if (tokens.length === 0) return null

  for (const { phrases, mealType } of MEAL_KEYWORDS) {
    for (const phrase of phrases) {
      const phraseTokens = phrase.split(' ')
      if (tokensContainPhrase(tokens, phraseTokens)) return mealType
    }
  }
  return null
}

/**
 * Detects a meal used as the destination of a conversational command.
 * This is deliberately stricter than detectExplicitMealType(), which also
 * accepts generic labels useful for image captions. For example, "um lanche
 * natural" is food; "no lanche" is a destination.
 */
export function detectExplicitMealDestination(message?: string | null): MealType | null {
  if (!message) return null
  const normalized = tokenize(message).join(' ')
  if (!normalized) return null

  if (/\b(?:almocei|almocar)\b/.test(normalized)) return 'lunch'
  if (/\bjantei\b|\b(?:vou|fui)\s+jantar\b/.test(normalized)) return 'dinner'
  if (/\blanchei\b/.test(normalized)) return 'snack'
  if (/\bceei\b/.test(normalized)) return 'supper'

  const hasDestination = (meal: string): boolean => new RegExp(
    `(?:^${meal}\\b|\\b(?:no|na|num|numa|ao|pro|pra|para o|para a)\\s+${meal}\\b)`,
  ).test(normalized)

  // The full expression is unambiguous; bare "café" remains a beverage.
  if (/\bcafe da manha\b/.test(normalized) || hasDestination('desjejum')) return 'breakfast'
  if (hasDestination('almoco')) return 'lunch'
  if (hasDestination('lanche')) return 'snack'
  if (hasDestination('jantar')) return 'dinner'
  if (hasDestination('ceia')) return 'supper'

  if (/\b(?:comi|tomei|bebi)\b.{0,30}\bde\s+lanche\b/.test(normalized)) return 'snack'

  return null
}

export function resolveMealTypeFromContext(params: {
  caption?: string | null
  currentTime: string
}): MealType {
  return detectExplicitMealType(params.caption) ?? classifyMealTypeByTime(params.currentTime)
}
