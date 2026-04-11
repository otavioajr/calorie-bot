import { describe, expect, it } from 'vitest'

import { extractLabelPortionsFromCaption } from '@/lib/bot/label-portions'

describe('extractLabelPortionsFromCaption', () => {
  it('extracts numeric portions from caption keywords', () => {
    expect(extractLabelPortionsFromCaption('café da manhã 1 dose')).toBe(1)
    expect(extractLabelPortionsFromCaption('pós treino 2 scoops')).toBe(2)
  })

  it('supports decimal and textual portion values', () => {
    expect(extractLabelPortionsFromCaption('lanche 1,5 doses')).toBe(1.5)
    expect(extractLabelPortionsFromCaption('ceia meia dose')).toBe(0.5)
    expect(extractLabelPortionsFromCaption('pré treino uma porção')).toBe(1)
  })

  it('ignores captions without portion keywords', () => {
    expect(extractLabelPortionsFromCaption('café da manhã')).toBeNull()
    expect(extractLabelPortionsFromCaption('pré treino 30g')).toBeNull()
  })
})
