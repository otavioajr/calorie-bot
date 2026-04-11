type NutritionLabelItem = {
  quantity_grams?: number | null
  nutrition_basis_grams?: number | null
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

  const ratio = servingGrams > 0 && basisGrams > 0
    ? (servingGrams / basisGrams) * portions
    : portions

  return {
    ...item,
    quantity_grams: roundToSingleDecimal(servingGrams * portions),
    calories: item.calories == null ? null : roundLabelCalories(item.calories * ratio),
    protein: item.protein == null ? null : roundToSingleDecimal(item.protein * ratio),
    carbs: item.carbs == null ? null : roundToSingleDecimal(item.carbs * ratio),
    fat: item.fat == null ? null : roundToSingleDecimal(item.fat * ratio),
  }
}
