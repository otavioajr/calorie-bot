import { z } from 'zod'
import { MealTypeSchema, ConfidenceSchema } from './common'

// More lenient item schema for image analysis — allows quantity_grams = 0
// (e.g. supplement labels where the LLM can't determine weight in grams)
const ImageMealItemSchema = z.object({
  food: z.string(),
  quantity_grams: z.coerce.number().nonnegative(),
  quantity_display: z.string().nullable().optional().default(null),
  quantity_source: z.enum(['estimated', 'user_provided']).default('estimated'),
  calories: z.coerce.number().nonnegative().nullable().optional().default(null),
  protein: z.coerce.number().nonnegative().nullable().optional().default(null),
  carbs: z.coerce.number().nonnegative().nullable().optional().default(null),
  fat: z.coerce.number().nonnegative().nullable().optional().default(null),
  confidence: ConfidenceSchema.optional().default('medium'),
})

export const ImageAnalysisSchema = z.object({
  image_type: z.enum(['food', 'nutrition_label']).catch('food'),
  meal_type: MealTypeSchema.optional(),
  confidence: ConfidenceSchema.catch('medium'),
  items: z.array(ImageMealItemSchema).default([]),
  unknown_items: z.array(z.string()).default([]),
  needs_clarification: z.boolean().default(false),
  clarification_question: z.string().nullable().optional(),
})

export type ImageAnalysis = z.infer<typeof ImageAnalysisSchema>
