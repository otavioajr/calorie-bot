import { SupabaseClient } from '@supabase/supabase-js'
import { fromDB, toDB } from '@/lib/db/utils'

export interface User {
  id: string
  authId: string | null
  phone: string
  name: string
  sex: 'male' | 'female' | null
  age: number | null
  weightKg: number | null
  heightCm: number | null
  activityLevel: 'sedentary' | 'light' | 'moderate' | 'intense' | 'athlete' | null
  goal: 'lose' | 'maintain' | 'gain' | null
  calorieMode: 'taco' | 'manual'
  dailyCalorieTarget: number | null
  calorieTargetManual: boolean
  tmb: number | null
  tdee: number | null
  maxWeightKg: number | null
  dailyProteinG: number | null
  dailyFatG: number | null
  dailyCarbsG: number | null
  timezone: string
  onboardingComplete: boolean
  onboardingStep: number
  createdAt: string
  updatedAt: string
}

export interface UserSettings {
  id: string
  userId: string
  remindersEnabled: boolean
  dailySummaryTime: string
  reminderTime: string
  detailLevel: 'brief' | 'detailed'
  weightUnit: 'kg' | 'lb'
  lastReminderSentAt: string | null
  lastSummarySentAt: string | null
  createdAt: string
  updatedAt: string
}

/**
 * Find a user by phone number.
 * Returns null when the user does not exist (Supabase PGRST116 = no rows).
 */
export async function findUserByPhone(
  supabase: SupabaseClient,
  phone: string
): Promise<User | null> {
  const { data, error } = await supabase
    .from('users')
    .select('*')
    .eq('phone', phone)
    .single()

  if (error) {
    if (error.code === 'PGRST116') return null
    throw new Error(error.message)
  }

  return fromDB<User>(data as Record<string, unknown>)
}

/**
 * Create a new user in the initial onboarding state.
 * name defaults to '' to satisfy the NOT NULL DB constraint.
 */
export async function createUser(supabase: SupabaseClient, phone: string): Promise<User> {
  const { data, error } = await supabase
    .from('users')
    .insert({ phone, name: '', calorie_mode: 'taco', onboarding_step: 0, onboarding_complete: false })
    .select('*')
    .single()

  if (error) throw new Error(error.message)

  return fromDB<User>(data as Record<string, unknown>)
}

/**
 * Update arbitrary user fields.
 * Accepts camelCase keys and converts them to snake_case for the DB.
 */
export async function updateUser(
  supabase: SupabaseClient,
  userId: string,
  data: Partial<Omit<User, 'id' | 'createdAt' | 'updatedAt'>>
): Promise<User> {
  const snakeData = toDB(data as Record<string, unknown>)

  const { data: updated, error } = await supabase
    .from('users')
    .update(snakeData)
    .eq('id', userId)
    .select('*')
    .single()

  if (error) throw new Error(error.message)

  return fromDB<User>(updated as Record<string, unknown>)
}

/**
 * Get a user together with their settings (if any).
 * Makes two separate queries — users and user_settings.
 */
export async function getUserWithSettings(
  supabase: SupabaseClient,
  userId: string
): Promise<{ user: User; settings: UserSettings | null }> {
  const { data: userData, error: userError } = await supabase
    .from('users')
    .select('*')
    .eq('id', userId)
    .single()

  if (userError) throw new Error(userError.message)

  const { data: settingsData, error: settingsError } = await supabase
    .from('user_settings')
    .select('*')
    .eq('user_id', userId)
    .single()

  let settings: UserSettings | null = null
  if (settingsError) {
    if (settingsError.code !== 'PGRST116') throw new Error(settingsError.message)
  } else {
    settings = fromDB<UserSettings>(settingsData as Record<string, unknown>)
  }

  return {
    user: fromDB<User>(userData as Record<string, unknown>),
    settings,
  }
}

/**
 * Reset all user data and restart onboarding.
 * Calls the `reset_user_data` PostgreSQL function for atomic execution.
 * Deletes: meals, meal_items (cascade), weight_log, user_settings,
 * conversation_context, llm_usage_log.
 * Resets user profile fields and sets onboarding_complete = false.
 */
export async function resetUserData(
  supabase: SupabaseClient,
  userId: string
): Promise<void> {
  const { error } = await supabase.rpc('reset_user_data', { p_user_id: userId })
  if (error) throw new Error(`Failed to reset user data: ${error.message}`)
}
