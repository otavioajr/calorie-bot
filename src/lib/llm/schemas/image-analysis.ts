import { z } from 'zod'
import { MealTypeSchema, ConfidenceSchema } from './common'

// Very lenient item schema for image analysis — uses .catch() to never fail validation
// LLM vision responses are unpredictable, especially for supplement labels
const ImageMealItemSchema = z.object({
  food: z.string().catch('Alimento não identificado'),
  quantity_grams: z.coerce.number().nonnegative().catch(0),
  quantity_display: z.string().nullable().optional().default(null),
  quantity_source: z.enum(['estimated', 'user_provided']).catch('estimated'),
  calories: z.coerce.number().nonnegative().nullable().catch(null),
  protein: z.coerce.number().nonnegative().nullable().catch(null),
  carbs: z.coerce.number().nonnegative().nullable().catch(null),
  fat: z.coerce.number().nonnegative().nullable().catch(null),
  confidence: ConfidenceSchema.optional().catch('medium'),
})

export const ImageAnalysisSchema = z.object({
  image_type: z.enum(['food', 'nutrition_label']).catch('food'),
  meal_type: MealTypeSchema.optional(),
  confidence: ConfidenceSchema.catch('medium'),
  items: z.array(ImageMealItemSchema).nullable().catch([]).transform(v => v ?? []),
  unknown_items: z.array(z.string()).nullable().catch([]).transform(v => v ?? []),
  needs_clarification: z.boolean().catch(false),
  clarification_question: z.string().nullable().optional().catch(null),
})

export type ImageAnalysis = z.infer<typeof ImageAnalysisSchema>
