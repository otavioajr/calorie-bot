import { z } from 'zod'

export const CalorieModeSchema = z.enum(['approximate', 'taco', 'manual'])
export type CalorieMode = z.infer<typeof CalorieModeSchema>

export const MealTypeSchema = z.enum(['breakfast', 'lunch', 'snack', 'dinner', 'supper'])
export type MealType = z.infer<typeof MealTypeSchema>

export const ConfidenceSchema = z.enum(['high', 'medium', 'low'])
export type Confidence = z.infer<typeof ConfidenceSchema>
