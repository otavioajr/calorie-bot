import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

describe('Supabase CI configuration', () => {
  it('uses the current Inbucket section accepted by the CLI', () => {
    const config = readFileSync('supabase/config.toml', 'utf8')

    expect(config).toContain('[inbucket]')
    expect(config).not.toContain('[local_smtp]')
  })
})
