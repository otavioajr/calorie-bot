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
