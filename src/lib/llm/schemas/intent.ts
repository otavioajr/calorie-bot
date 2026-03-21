import { z } from 'zod'

export const IntentClassificationSchema = z.object({
  intent: z.enum(['meal_log', 'summary', 'edit', 'query', 'weight', 'help', 'settings', 'out_of_scope']),
})

export type IntentClassification = z.infer<typeof IntentClassificationSchema>
