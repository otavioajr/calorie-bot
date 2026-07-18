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

-- Fase 2b is deliberately RPC-only even for the API service_role. Keep the
-- broad legacy harness grants for existing tables, then restore the outbox's
-- production least-privilege boundary explicitly.
REVOKE ALL ON TABLE public.outbox_status_events FROM service_role, anon, authenticated;
REVOKE ALL ON TABLE public.outbox_messages FROM service_role, anon, authenticated;
REVOKE ALL ON SCHEMA private FROM service_role, anon, authenticated;
REVOKE ALL ON FUNCTION private.project_outbox_bot_message(UUID, TEXT)
  FROM service_role, anon, authenticated;
`

/** Matches `project_id` in supabase/config.toml (default: calorie-bot). */
const DEFAULT_PROJECT_ID = 'calorie-bot'

function expectedDbContainerName(): string {
  const fromEnv = process.env.SUPABASE_DB_CONTAINER?.trim()
  if (fromEnv) return fromEnv

  const projectId =
    process.env.SUPABASE_PROJECT_ID?.trim() || DEFAULT_PROJECT_ID
  return `supabase_db_${projectId}`
}

/**
 * Resolve the DB container for THIS project only.
 * Never pick the first `supabase_db_*` — that can truncate another local stack.
 */
function resolveDbContainer(): string {
  const expected = expectedDbContainerName()
  const listed = execFileSync('docker', ['ps', '--format', '{{.Names}}'], {
    encoding: 'utf8',
  })
    .split('\n')
    .map((n) => n.trim())
    .filter(Boolean)

  if (!listed.includes(expected)) {
    throw new Error(
      `[integration] Expected Docker container "${expected}" is not running. ` +
        `Running supabase_db_* containers: ${listed.filter((n) => n.startsWith('supabase_db_')).join(', ') || '(none)'}. ` +
        `Start this project's stack with \`supabase start\` (project_id=${DEFAULT_PROJECT_ID}), ` +
        `or set SUPABASE_DB_CONTAINER / SUPABASE_PROJECT_ID.`,
    )
  }
  return expected
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
