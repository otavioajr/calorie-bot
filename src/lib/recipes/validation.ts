import { z } from 'zod'
import type { ComputedRecipeMacros } from '@/lib/recipes/types'

export const NUMERIC_8_2_MAX = 999999.99
export const NUMERIC_5_2_MAX = 999.99
export const SMALLINT_MAX = 32767

export function hasAtMostTwoDecimalPlaces(value: number): boolean {
  if (!Number.isFinite(value)) return false

  const cents = value * 100
  return Math.abs(Math.round(cents) - cents) < 1e-9
}

export const Decimal2Schema = z
  .number()
  .refine(hasAtMostTwoDecimalPlaces)

export const LabelOverrideSchema = z.object({
  kcalPer100g: z.number().nonnegative().max(900),
  proteinPer100g: z.number().nonnegative().max(100),
  carbsPer100g: z.number().nonnegative().max(100),
  fatPer100g: z.number().nonnegative().max(100),
  fiberPer100g: z.number().nonnegative().max(100).optional(),
  sodiumPer100g: z.number().nonnegative().max(100000).optional(),
})

export const TacoIngredientSchema = z.object({
  foodName: z.string().trim().min(1),
  quantityGrams: Decimal2Schema.min(0.01).max(NUMERIC_8_2_MAX),
  source: z.literal('taco'),
  tacoId: z.number().int().positive(),
  displayOrder: z.number().int().nonnegative().max(SMALLINT_MAX),
})

export const UserLabelIngredientSchema = z.object({
  foodName: z.string().trim().min(1),
  quantityGrams: Decimal2Schema.min(0.01).max(NUMERIC_8_2_MAX),
  source: z.literal('user_label'),
  labelOverride: LabelOverrideSchema,
  displayOrder: z.number().int().nonnegative().max(SMALLINT_MAX),
})

export const RecipeBodySchema = z.object({
  name: z.string().trim().min(1).max(120),
  totalWeightGrams: Decimal2Schema.min(0.01).max(NUMERIC_8_2_MAX),
  servings: Decimal2Schema.min(0.01).max(NUMERIC_5_2_MAX),
  notes: z.string().trim().max(1000).optional(),
  ingredients: z
    .array(z.discriminatedUnion('source', [TacoIngredientSchema, UserLabelIngredientSchema]))
    .min(1)
    .max(50),
})

function isPersistedNumericInRange(value: number): boolean {
  return Number.isFinite(value) && value >= 0 && value <= NUMERIC_8_2_MAX
}

export function areComputedMacrosPersistable(macros: ComputedRecipeMacros): boolean {
  const recipeMacroValues = [
    macros.totalProteinG,
    macros.totalCarbsG,
    macros.totalFatG,
    macros.totalCalories,
    macros.perServingCalories,
    macros.perServingProteinG,
    macros.perServingCarbsG,
    macros.perServingFatG,
  ]

  const ingredientValues = macros.ingredientMacros.flatMap((ingredient) => [
    ingredient.calories,
    ingredient.proteinG,
    ingredient.carbsG,
    ingredient.fatG,
  ])

  return (
    Number.isFinite(macros.weightPerServingGrams) &&
    macros.weightPerServingGrams > 0 &&
    macros.weightPerServingGrams <= NUMERIC_8_2_MAX &&
    [...recipeMacroValues, ...ingredientValues].every(isPersistedNumericInRange)
  )
}
