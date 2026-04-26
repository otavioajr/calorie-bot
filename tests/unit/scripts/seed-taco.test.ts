import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

describe('seed-taco defaults', () => {
  it('uses macaroni with eggs as the default Macarrão variant', () => {
    const seedScript = readFileSync(join(process.cwd(), 'scripts/seed-taco.ts'), 'utf8')

    expect(seedScript).toContain("'Macarrão': 'trigo, cru, com ovos'")
  })
})
