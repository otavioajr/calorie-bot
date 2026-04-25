import { z } from 'zod'

const QuantityGramsSchema = z.preprocess((value) => {
  if (typeof value === 'number') {
    return value
  }

  if (typeof value === 'string') {
    const trimmed = value.trim()
    if (!trimmed) {
      return value
    }

    const parsed = Number(trimmed)
    return Number.isFinite(parsed) ? parsed : value
  }

  return value
}, z.number().positive())

export const RecipeParseIngredientSchema = z
  .object({
    food: z.string().trim().min(1),
    quantity_grams: QuantityGramsSchema,
  })
  .transform((v) => ({
    food: v.food,
    quantityGrams: v.quantity_grams,
  }))

export const RecipeParseSchema = z.object({
  ingredients: z.array(RecipeParseIngredientSchema).min(1),
})

export type RecipeParseIngredient = z.infer<typeof RecipeParseIngredientSchema>
export type RecipeParse = z.infer<typeof RecipeParseSchema>
