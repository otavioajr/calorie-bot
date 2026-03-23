import { z } from 'zod'
import { MealTypeSchema, ConfidenceSchema } from './common'
import { MealItemSchema } from './meal-analysis'

export const ImageAnalysisSchema = z.object({
  image_type: z.enum(['food', 'nutrition_label']),
  meal_type: MealTypeSchema.optional(),
  confidence: ConfidenceSchema,
  items: z.array(MealItemSchema).default([]),
  unknown_items: z.array(z.string()).default([]),
  needs_clarification: z.boolean().default(false),
  clarification_question: z.string().nullable().optional(),
})

export type ImageAnalysis = z.infer<typeof ImageAnalysisSchema>
