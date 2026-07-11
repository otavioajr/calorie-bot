import { describe, expect, it } from 'vitest'
import { ContextualCorrectionGatekeeperSchema } from '@/lib/llm/schemas/contextual-correction'

describe('ContextualCorrectionGatekeeperSchema', () => {
  it.each([
    { type: 'confirmation' },
    { type: 'other' },
  ])('accepts a valid $type result', (value) => {
    expect(ContextualCorrectionGatekeeperSchema.parse(value)).toEqual(value)
  })

  it('requires and trims a non-empty corrected_message for corrections', () => {
    expect(ContextualCorrectionGatekeeperSchema.parse({
      type: 'correction',
      corrected_message: '  corrigir arroz para 200g  ',
    })).toEqual({
      type: 'correction',
      corrected_message: 'corrigir arroz para 200g',
    })
  })

  it.each([
    { type: 'unknown' },
    { type: 'correction' },
    { type: 'correction', corrected_message: '' },
    { type: 'correction', corrected_message: '   ' },
    { type: 'correction', corrected_message: 123 },
    { type: 'other', corrected_message: 'não permitido' },
  ])('rejects unknown or malformed gatekeeper output: %j', (value) => {
    expect(ContextualCorrectionGatekeeperSchema.safeParse(value).success).toBe(false)
  })
})
