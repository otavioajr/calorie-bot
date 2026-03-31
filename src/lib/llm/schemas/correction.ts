import { z } from 'zod'

export const CorrectionActionSchema = z.enum([
  'update_quantity',
  'remove_item',
  'add_item',
  'replace_item',
  'delete_meal',
])

export const CorrectionSchema = z.object({
  action: CorrectionActionSchema,
  target_meal_type: z.string().nullable().default(null),
  target_food: z.string().nullable().default(null),
  new_quantity: z.string().nullable().default(null),
  new_food: z.string().nullable().default(null),
  confidence: z.enum(['high', 'medium', 'low']).default('medium'),
})

export type Correction = z.infer<typeof CorrectionSchema>
export type CorrectionAction = z.infer<typeof CorrectionActionSchema>
