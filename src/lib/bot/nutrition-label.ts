type NutritionLabelItem = {
  quantity_grams?: number | null
  nutrition_basis_grams?: number | null
  nutrition_basis_calories?: number | null
  nutrition_basis_protein?: number | null
  nutrition_basis_carbs?: number | null
  nutrition_basis_fat?: number | null
  calories?: number | null
  protein?: number | null
  carbs?: number | null
  fat?: number | null
}

function roundToSingleDecimal(value: number): number {
  return Math.round(value * 10) / 10
}

export function roundLabelCalories(value: number): number {
  const floor = Math.floor(value)
  return value - floor <= 0.5 ? floor : floor + 1
}

export function scaleNutritionLabelItem<T extends NutritionLabelItem>(item: T, portions: number = 1): T {
  const servingGrams = item.quantity_grams ?? 0
  const basisGrams = item.nutrition_basis_grams && item.nutrition_basis_grams > 0
    ? item.nutrition_basis_grams
    : servingGrams
  const baseCalories = item.nutrition_basis_calories ?? item.calories
  const baseProtein = item.nutrition_basis_protein ?? item.protein
  const baseCarbs = item.nutrition_basis_carbs ?? item.carbs
  const baseFat = item.nutrition_basis_fat ?? item.fat

  const ratio = servingGrams > 0 && basisGrams > 0
    ? (servingGrams / basisGrams) * portions
    : portions

  return {
    ...item,
    quantity_grams: roundToSingleDecimal(servingGrams * portions),
    calories: baseCalories == null ? null : roundLabelCalories(baseCalories * ratio),
    protein: baseProtein == null ? null : roundToSingleDecimal(baseProtein * ratio),
    carbs: baseCarbs == null ? null : roundToSingleDecimal(baseCarbs * ratio),
    fat: baseFat == null ? null : roundToSingleDecimal(baseFat * ratio),
  }
}
