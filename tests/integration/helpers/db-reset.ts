import { execFileSync } from 'child_process'
import { assertLocalSupabaseUrl, getIntegrationSupabase } from './supabase-local'
import { getDbContainerName } from './ensure-grants'

/**
 * Domain tables truncated between tests. Seed/reference tables (taco_foods) are kept.
 * Uses docker exec → psql on the local supabase_db container (no production path).
 */
const TRUNCATE_SQL = `
TRUNCATE TABLE
  meal_items,
  meals,
  inbound_work,
  processed_messages,
  conversation_context,
  weight_log,
  message_history,
  bot_messages,
  llm_usage_log,
  auth_codes,
  user_settings,
  product_usage,
  recipe_ingredients,
  user_recipes,
  products,
  taco_food_usage,
  food_cache,
  users
RESTART IDENTITY CASCADE;
`

export function resetIntegrationDb(): void {
  assertLocalSupabaseUrl(process.env.NEXT_PUBLIC_SUPABASE_URL)
  const container = getDbContainerName()
  execFileSync(
    'docker',
    ['exec', '-i', container, 'psql', '-U', 'postgres', '-d', 'postgres', '-v', 'ON_ERROR_STOP=1', '-c', TRUNCATE_SQL],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  )
}

/** Soft verification that key tables are empty after reset. */
export async function assertDomainTablesEmpty(): Promise<void> {
  const supabase = getIntegrationSupabase()
  const { count: mealCount, error: mealErr } = await supabase
    .from('meals')
    .select('*', { count: 'exact', head: true })
  if (mealErr) throw new Error(`meals count failed: ${mealErr.message}`)

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { count: msgCount, error: msgErr } = await (supabase as any)
    .from('processed_messages')
    .select('*', { count: 'exact', head: true })
  if (msgErr) throw new Error(`processed_messages count failed: ${msgErr.message}`)

  if ((mealCount ?? 0) !== 0 || (msgCount ?? 0) !== 0) {
    throw new Error(
      `[integration] Expected empty domain tables after reset; meals=${mealCount} processed_messages=${msgCount}`,
    )
  }
}
