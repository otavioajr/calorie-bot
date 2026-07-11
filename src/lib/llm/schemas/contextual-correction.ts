import { z } from 'zod'

export const ContextualCorrectionGatekeeperSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('correction'),
    corrected_message: z.string().trim().min(1),
  }).strict(),
  z.object({
    type: z.literal('confirmation'),
  }).strict(),
  z.object({
    type: z.literal('other'),
  }).strict(),
])

export type ContextualCorrectionGatekeeper = z.infer<typeof ContextualCorrectionGatekeeperSchema>
