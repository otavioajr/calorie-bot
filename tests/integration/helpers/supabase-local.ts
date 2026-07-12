import { createServiceRoleClient } from '@/lib/db/supabase'

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', 'host.docker.internal'])

/**
 * Refuse to run integration tests against non-local Supabase URLs.
 * Fixtures are destructive — never point at the VPS production database.
 */
export function assertLocalSupabaseUrl(url: string | undefined): void {
  if (!url?.trim()) {
    throw new Error(
      '[integration] NEXT_PUBLIC_SUPABASE_URL is missing. ' +
        'Copy .env.test.example → .env.test.local after `supabase start`.',
    )
  }

  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    throw new Error(`[integration] Invalid NEXT_PUBLIC_SUPABASE_URL: ${url}`)
  }

  if (!LOCAL_HOSTS.has(parsed.hostname)) {
    throw new Error(
      `[integration] Refusing to run against non-local Supabase URL host "${parsed.hostname}". ` +
        'Integration tests must use supabase local (127.0.0.1 / localhost). ' +
        'Never point tests at the production VPS.',
    )
  }
}

export function getIntegrationSupabase() {
  assertLocalSupabaseUrl(process.env.NEXT_PUBLIC_SUPABASE_URL)
  if (!process.env.SUPABASE_SERVICE_ROLE_KEY?.trim()) {
    throw new Error('[integration] SUPABASE_SERVICE_ROLE_KEY is missing')
  }
  return createServiceRoleClient()
}
