import { z } from 'zod'
import { MealTypeSchema, ConfidenceSchema } from './common'

export const MealItemSchema = z.object({
  food: z.string(),
  quantity_grams: z.coerce.number().positive(),
  quantity_source: z.enum(['estimated', 'user_provided', 'taco']).default('estimated'),
  calories: z.coerce.number().nonnegative(),
  protein: z.coerce.number().nonnegative().default(0),
  carbs: z.coerce.number().nonnegative().default(0),
  fat: z.coerce.number().nonnegative().default(0),
  taco_match: z.boolean().optional().default(false),
  taco_id: z.coerce.number().nullable().optional().default(null),
  confidence: ConfidenceSchema.optional().default('medium'),
})

export const MealAnalysisSchema = z.object({
  meal_type: MealTypeSchema,
  confidence: ConfidenceSchema,
  items: z.array(MealItemSchema).min(1),
  unknown_items: z.array(z.string()).default([]),
  needs_clarification: z.boolean().default(false),
  clarification_question: z.string().nullable().optional(),
})

export type MealItem = z.infer<typeof MealItemSchema>
export type MealAnalysis = z.infer<typeof MealAnalysisSchema>
