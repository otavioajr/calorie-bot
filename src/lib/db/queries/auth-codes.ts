import { SupabaseClient } from '@supabase/supabase-js'
import { fromDB } from '@/lib/db/utils'

interface AuthCodeRow {
  id: string
  phone: string
  code: string
  expires_at: string
  used: boolean
  created_at: string
}

interface AuthCode {
  id: string
  phone: string
  code: string
  expiresAt: string
  used: boolean
  createdAt: string
}

/**
 * Insert a new auth code record into the auth_codes table.
 */
export async function createAuthCode(
  supabase: SupabaseClient,
  phone: string,
  code: string,
  expiresAt: Date,
): Promise<void> {
  const { error } = await supabase.from('auth_codes').insert({
    phone,
    code,
    expires_at: expiresAt.toISOString(),
    used: false,
  })

  if (error) throw new Error(error.message)
}

/**
 * Verify that a code is valid for the given phone:
 *  - phone matches
 *  - code matches
 *  - not expired
 *  - not already used
 * If valid, marks the record as used and returns true. Returns false otherwise.
 */
export async function verifyAuthCode(
  supabase: SupabaseClient,
  phone: string,
  code: string,
): Promise<boolean> {
  const now = new Date().toISOString()

  const { data, error } = await supabase
    .from('auth_codes')
    .select('*')
    .eq('phone', phone)
    .eq('code', code)
    .eq('used', false)
    .gt('expires_at', now)
    .order('created_at', { ascending: false })
    .limit(1)
    .single()

  if (error) {
    // PGRST116 = no rows found — not an error we want to throw
    if (error.code === 'PGRST116') return false
    throw new Error(error.message)
  }

  if (!data) return false

  const authCode = fromDB<AuthCode>(data as unknown as Record<string, unknown>)

  // Mark as used
  const { error: updateError } = await supabase
    .from('auth_codes')
    .update({ used: true })
    .eq('id', (data as AuthCodeRow).id)

  if (updateError) throw new Error(updateError.message)

  return authCode !== null
}

/**
 * Count how many codes were created for this phone within the last windowMinutes.
 */
export async function countRecentCodes(
  supabase: SupabaseClient,
  phone: string,
  windowMinutes: number,
): Promise<number> {
  const windowStart = new Date(Date.now() - windowMinutes * 60 * 1000).toISOString()

  const { count, error } = await supabase
    .from('auth_codes')
    .select('*', { count: 'exact', head: true })
    .eq('phone', phone)
    .gt('created_at', windowStart)

  if (error) throw new Error(error.message)

  return count ?? 0
}
