import { describe, it, expect } from 'vitest'
import { parseDateFromMessage, localDateString, formatDateLabel } from '@/lib/utils/relative-date'

const NOW = new Date('2026-05-29T17:00:00Z') // sexta-feira, ~14h em America/Sao_Paulo

describe('parseDateFromMessage', () => {
  it('detects "ontem" (explicit, previous day)', () => {
    const { date, wasExplicit } = parseDateFromMessage('ontem no jantar comi arroz', NOW)
    expect(wasExplicit).toBe(true)
    expect(localDateString(date, 'America/Sao_Paulo')).toBe('2026-05-28')
  })

  it('detects "anteontem" before "ontem"', () => {
    const { date } = parseDateFromMessage('anteontem comi pizza', NOW)
    expect(localDateString(date, 'America/Sao_Paulo')).toBe('2026-05-27')
  })

  it('defaults to today, not explicit, when no date hint', () => {
    const { date, wasExplicit } = parseDateFromMessage('comi 2 ovos', NOW)
    expect(wasExplicit).toBe(false)
    expect(localDateString(date, 'America/Sao_Paulo')).toBe('2026-05-29')
  })
})

describe('formatDateLabel', () => {
  it('labels today as "Hoje"', () => {
    expect(formatDateLabel(new Date('2026-05-29T18:00:00Z'), 'America/Sao_Paulo', NOW)).toBe('Hoje')
  })
  it('labels yesterday as "Ontem"', () => {
    expect(formatDateLabel(new Date('2026-05-28T18:00:00Z'), 'America/Sao_Paulo', NOW)).toBe('Ontem')
  })
  it('labels older dates with day/month', () => {
    const label = formatDateLabel(new Date('2026-05-24T15:00:00Z'), 'America/Sao_Paulo', NOW)
    expect(label).toMatch(/24\/05/)
    expect(label).not.toMatch(/[.,]/)
  })
})
