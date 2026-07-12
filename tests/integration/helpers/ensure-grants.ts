import { execFileSync } from 'child_process'

/**
 * Local Supabase migrations create tables without full table grants for
 * `service_role` (only Dxtm). Production VPS has broader grants applied
 * operationally. For integration tests we grant once per process via psql —
 * not a production migration.
 */
const GRANT_SQL = `
GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
GRANT ALL ON ALL TABLES IN SCHEMA public TO service_role;
GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO service_role;
GRANT ALL ON ALL ROUTINES IN SCHEMA public TO service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON ROUTINES TO service_role;
`

function resolveDbContainer(): string {
  const fromEnv = process.env.SUPABASE_DB_CONTAINER?.trim()
  if (fromEnv) return fromEnv

  const listed = execFileSync('docker', ['ps', '--format', '{{.Names}}'], {
    encoding: 'utf8',
  })
  const match = listed
    .split('\n')
    .map((n) => n.trim())
    .find((n) => n.startsWith('supabase_db_'))
  if (!match) {
    throw new Error(
      '[integration] Could not find supabase_db_* container. Is `supabase start` running?',
    )
  }
  return match
}

let granted = false

export function ensureServiceRoleGrants(): void {
  if (granted) return
  const container = resolveDbContainer()
  execFileSync(
    'docker',
    ['exec', '-i', container, 'psql', '-U', 'postgres', '-d', 'postgres', '-v', 'ON_ERROR_STOP=1', '-c', GRANT_SQL],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  )
  granted = true
}

export function getDbContainerName(): string {
  return resolveDbContainer()
}
