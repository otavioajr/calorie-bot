interface LabelNutritionInput {
  servingSizeG: number
  calories: number
  protein: number
  carbs: number
  fat: number
}

interface LabelNutritionPer100g {
  caloriesPer100g: number
  proteinPer100g: number
  carbsPer100g: number
  fatPer100g: number
}

const PRODUCT_SEARCH_STOPWORDS = new Set([
  'a',
  'as',
  'o',
  'os',
  'um',
  'uma',
  'uns',
  'umas',
  'outro',
  'outra',
  'outros',
  'outras',
  'de',
  'da',
  'das',
  'do',
  'dos',
  'e',
  'com',
])

function normalizeText(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim()
    .replace(/\s+/g, ' ')
}

export function normalizeProductName(name: string): string | null {
  const normalized = normalizeText(name)
  return normalized.length > 0 ? normalized : null
}

export function normalizeBrand(brand: string | null | undefined): string | null {
  if (brand == null) return null

  const normalized = normalizeText(brand)
  return normalized.length > 0 ? normalized : null
}

export function tokenizeProductSearchText(value: string | null | undefined): string[] {
  if (!value) return []

  const normalized = normalizeText(value)
    .replace(/[^\p{Letter}\p{Number}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()

  if (!normalized) return []

  return normalized
    .split(' ')
    .filter(token => token.length > 0 && !PRODUCT_SEARCH_STOPWORDS.has(token))
}

export function scoreProductTokenMatch(query: string, candidate: string): number {
  const queryTokens = [...new Set(tokenizeProductSearchText(query))]
  if (queryTokens.length === 0) return 0

  const candidateTokens = new Set(tokenizeProductSearchText(candidate))
  const matchedCount = queryTokens.filter(token => candidateTokens.has(token)).length
  const minimumMatches = Math.min(2, queryTokens.length)
  if (matchedCount < minimumMatches) return 0

  return matchedCount / queryTokens.length
}

export function convertLabelToPer100g(input: LabelNutritionInput): LabelNutritionPer100g {
  if (input.servingSizeG <= 0) {
    throw new Error('servingSizeG must be greater than 0')
  }

  const multiplier = 100 / input.servingSizeG

  return {
    caloriesPer100g: input.calories * multiplier,
    proteinPer100g: input.protein * multiplier,
    carbsPer100g: input.carbs * multiplier,
    fatPer100g: input.fat * multiplier,
  }
}
