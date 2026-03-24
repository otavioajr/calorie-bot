import { z } from 'zod'

export const DecomposedItemSchema = z.object({
  food: z.string(),
  quantity_grams: z.coerce.number().positive(),
})

export const DecompositionResultSchema = z.object({
  ingredients: z.array(DecomposedItemSchema).min(1),
})

export type DecomposedItem = z.infer<typeof DecomposedItemSchema>
export type DecompositionResult = z.infer<typeof DecompositionResultSchema>
