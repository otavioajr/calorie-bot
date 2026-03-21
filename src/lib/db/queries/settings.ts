import { SupabaseClient } from '@supabase/supabase-js'
import { fromDB, toDB } from '@/lib/db/utils'
import type { UserSettings } from '@/lib/db/queries/users'

export type { UserSettings }

/**
 * Create default settings for a user.
 * Defaults: reminders_enabled=true, daily_summary_time='21:00', reminder_time='14:00',
 *           detail_level='brief', weight_unit='kg'
 */
export async function createDefaultSettings(
  supabase: SupabaseClient,
  userId: string
): Promise<UserSettings> {
  const { data, error } = await supabase
    .from('user_settings')
    .insert({
      user_id: userId,
      reminders_enabled: true,
      daily_summary_time: '21:00',
      reminder_time: '14:00',
      detail_level: 'brief',
      weight_unit: 'kg',
    })
    .select('*')
    .single()

  if (error) throw new Error(error.message)

  return fromDB<UserSettings>(data as Record<string, unknown>)
}

/**
 * Update settings for a user.
 * Accepts camelCase keys and converts them to snake_case for the DB.
 * Matches on user_id (not settings.id).
 */
export async function updateSettings(
  supabase: SupabaseClient,
  userId: string,
  data: Partial<Omit<UserSettings, 'id' | 'userId' | 'createdAt' | 'updatedAt'>>
): Promise<UserSettings> {
  const snakeData = toDB(data as Record<string, unknown>)

  const { data: updated, error } = await supabase
    .from('user_settings')
    .update(snakeData)
    .eq('user_id', userId)
    .select('*')
    .single()

  if (error) throw new Error(error.message)

  return fromDB<UserSettings>(updated as Record<string, unknown>)
}
