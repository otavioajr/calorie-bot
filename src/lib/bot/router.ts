export type IntentType =
  | 'meal_log'
  | 'summary'
  | 'edit'
  | 'query'
  | 'weight'
  | 'help'
  | 'settings'
  | 'user_data'
  | 'out_of_scope'

/**
 * Normalizes a message: trim + lowercase + remove accents (NFD decomposition).
 */
function normalize(message: string): string {
  return message
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
}

const HELP_EXACT: ReadonlySet<string> = new Set([
  'menu',
  'ajuda',
  'help',
  'o que voce faz',
  'o que voce faz', // already without accent after normalize
])

const SETTINGS_KEYWORDS: readonly string[] = [
  'config',
  'configurac', // matches "configuracao", "configuracoes", etc.
  'mudar objetivo',
  'mudar modo',
  'mudar meta',
  'trocar modo',
  'trocar objetivo',
]

const SUMMARY_KEYWORDS: readonly string[] = [
  'resum',
  'como to',   // matches "como to", "como tô" (after accent removal)
  'como estou',
  'quanto comi',
  'quanto ja comi', // "já" normalized to "ja"
]

const EDIT_KEYWORDS: readonly string[] = [
  'apaga',
  'apagar',
  'corrig',
  'corrigir',
  'tira o',
  'tira a',
  'remove',
]

const WEIGHT_KEYWORDS: readonly string[] = [
  'peso',
  'pesei',
  'pesagem',
]

const QUERY_KEYWORDS: readonly string[] = [
  'quantas calorias tem',
  'quantas calorias',
  'quanto tem um',
  'quanto tem uma',
]

const USER_DATA_KEYWORDS: readonly string[] = [
  'meus dados',
  'meu perfil',
  'minhas info',
]

/**
 * Pure, synchronous rules-based intent classifier.
 * Returns null when no rule matches (LLM fallback will classify).
 *
 * Priority order:
 * 1. help    — exact match
 * 2. settings
 * 3. summary
 * 4. edit
 * 5. weight
 * 6. query
 * 7. user_data
 * 8. null    — no rule matched
 */
export function classifyByRules(message: string): IntentType | null {
  const normalized = normalize(message)

  // 1. help — exact match only
  if (HELP_EXACT.has(normalized)) {
    return 'help'
  }

  // 2. settings
  for (const kw of SETTINGS_KEYWORDS) {
    if (normalized.includes(kw)) return 'settings'
  }

  // 3. summary
  for (const kw of SUMMARY_KEYWORDS) {
    if (normalized.includes(kw)) return 'summary'
  }

  // 4. edit
  for (const kw of EDIT_KEYWORDS) {
    if (normalized.includes(kw)) return 'edit'
  }

  // 5. weight
  for (const kw of WEIGHT_KEYWORDS) {
    if (normalized.includes(kw)) return 'weight'
  }

  // 6. query
  for (const kw of QUERY_KEYWORDS) {
    if (normalized.includes(kw)) return 'query'
  }

  // 7. user_data
  for (const kw of USER_DATA_KEYWORDS) {
    if (normalized.includes(kw)) return 'user_data'
  }

  // 8. no rule matched — LLM fallback
  return null
}
