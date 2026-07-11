import { describe, it, expect } from 'vitest'
import { isBlankText, isTextTooLong } from '@/lib/bot/input-validation'
import { MAX_INCOMING_TEXT_CHARS } from '@/lib/whatsapp/limits'

describe('isBlankText', () => {
  it('returns true for empty string', () => {
    expect(isBlankText('')).toBe(true)
  })

  it('returns true for whitespace only', () => {
    expect(isBlankText('   \n\t  ')).toBe(true)
  })

  it('returns true for zero-width characters only', () => {
    expect(isBlankText('\u200B\uFEFF')).toBe(true)
  })

  it('returns false when there is visible text', () => {
    expect(isBlankText('arroz')).toBe(false)
  })
})

describe('isTextTooLong', () => {
  it('returns false within limit', () => {
    expect(isTextTooLong('a'.repeat(MAX_INCOMING_TEXT_CHARS))).toBe(false)
  })

  it('returns true above limit', () => {
    expect(isTextTooLong('a'.repeat(MAX_INCOMING_TEXT_CHARS + 1))).toBe(true)
  })
})
