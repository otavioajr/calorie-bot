import { SupabaseClient } from '@supabase/supabase-js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface WeightLog {
  weightKg: number
  loggedAt: string
}

// ---------------------------------------------------------------------------
// logWeight
// ---------------------------------------------------------------------------

/**
 * Inserts a new weight log entry for a user.
 */
export async function logWeight(
  supabase: SupabaseClient,
  userId: string,
  weightKg: number,
): Promise<void> {
  const { error } = await supabase.from('weight_log').insert({
    user_id: userId,
    weight_kg: weightKg,
  })

  if (error) {
    throw new Error(`Failed to log weight: ${error.message}`)
  }
}

// ---------------------------------------------------------------------------
// getLastWeight
// ---------------------------------------------------------------------------

/**
 * Returns the most recent weight log entry for a user, or null if none exists.
 */
export async function getLastWeight(
  supabase: SupabaseClient,
  userId: string,
): Promise<WeightLog | null> {
  const { data, error } = await supabase
    .from('weight_log')
    .select('weight_kg, logged_at')
    .eq('user_id', userId)
    .order('logged_at', { ascending: false })
    .limit(1)
    .single()

  if (error) {
    if (error.code === 'PGRST116') return null
    throw new Error(`Failed to get last weight: ${error.message}`)
  }

  if (!data) return null

  const row = data as Record<string, unknown>
  return {
    weightKg: row.weight_kg as number,
    loggedAt: row.logged_at as string,
  }
}
