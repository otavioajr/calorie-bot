import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync } from 'fs'
import path from 'path'

const CASES_DIR = path.resolve(__dirname, 'cases')
const REQUIRED_TOP = [
  'id',
  'description',
  'clock',
  'timezone',
  'initial_state',
  'inbound',
  'expected',
] as const

describe('golden corpus cases', () => {
  const files = readdirSync(CASES_DIR).filter((f) => f.endsWith('.json'))

  it('has at least 2 versioned cases', () => {
    expect(files.length).toBeGreaterThanOrEqual(2)
  })

  for (const file of files) {
    it(`${file} has required fields and parses`, () => {
      const raw = readFileSync(path.join(CASES_DIR, file), 'utf8')
      const data = JSON.parse(raw) as Record<string, unknown>
      for (const key of REQUIRED_TOP) {
        expect(data[key], `${file} missing ${key}`).toBeDefined()
      }
      const expected = data.expected as Record<string, unknown>
      expect(expected.structural).toBeDefined()
      expect(typeof expected.max_llm_calls).toBe('number')
      const inbound = data.inbound as Record<string, unknown>
      expect(['text', 'audio', 'image']).toContain(inbound.type)
    })
  }
})
