import { existsSync, readFileSync } from 'fs'
import path from 'path'

/**
 * Load `.env.test.local` (or `.env.test`) into process.env for integration tests.
 * Does not override keys already set (CI injects env directly).
 */
function loadEnvFile(filename: string): void {
  const filePath = path.resolve(process.cwd(), filename)
  if (!existsSync(filePath)) return

  for (const line of readFileSync(filePath, 'utf8').split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const eq = trimmed.indexOf('=')
    if (eq <= 0) continue
    const key = trimmed.slice(0, eq).trim()
    let value = trimmed.slice(eq + 1).trim()
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1)
    }
    if (process.env[key] === undefined) {
      process.env[key] = value
    }
  }
}

loadEnvFile('.env.test.local')
loadEnvFile('.env.test')

import { assertLocalSupabaseUrl } from './helpers/supabase-local'
import { ensureServiceRoleGrants } from './helpers/ensure-grants'

assertLocalSupabaseUrl(process.env.NEXT_PUBLIC_SUPABASE_URL)
ensureServiceRoleGrants()
