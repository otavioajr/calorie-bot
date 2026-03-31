import { z } from 'zod'
import { MealTypeSchema, ConfidenceSchema } from './common'

export const PortionTypeSchema = z.enum(['unit', 'bulk', 'packaged']).default('unit')
export type PortionType = z.infer<typeof PortionTypeSchema>

export const MealItemSchema = z.object({
  food: z.string(),
  quantity_grams: z.coerce.number().positive().nullable().optional().default(null),
  quantity_display: z.string().nullable().optional().default(null),
  quantity_source: z.enum(['estimated', 'user_provided']).default('estimated'),
  portion_type: PortionTypeSchema.optional().default('unit'),
  has_user_quantity: z.boolean().optional().default(false),
  calories: z.coerce.number().nonnegative().nullable().optional().default(null),
  protein: z.coerce.number().nonnegative().nullable().optional().default(null),
  carbs: z.coerce.number().nonnegative().nullable().optional().default(null),
  fat: z.coerce.number().nonnegative().nullable().optional().default(null),
  confidence: ConfidenceSchema.optional().default('medium'),
})

export const MealAnalysisSchema = z.object({
  meal_type: MealTypeSchema,
  confidence: ConfidenceSchema,
  references_previous: z.boolean().optional().default(false),
  reference_query: z.string().nullable().optional().default(null),
  items: z.array(MealItemSchema).min(1),
  unknown_items: z.array(z.string()).default([]),
  needs_clarification: z.boolean().default(false),
  clarification_question: z.string().nullable().optional(),
})

export const MultiMealAnalysisSchema = z.object({
  meals: z.array(MealAnalysisSchema).min(1),
})

export type MealItem = z.infer<typeof MealItemSchema>
export type MealAnalysis = z.infer<typeof MealAnalysisSchema>
