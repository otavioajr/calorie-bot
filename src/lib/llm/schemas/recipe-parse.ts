import { z } from 'zod'

export const RecipeParseIngredientSchema = z
  .object({
    food: z.string().min(1),
    quantity_grams: z.coerce.number().positive(),
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
