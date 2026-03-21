import { createServiceRoleClient } from '@/lib/db/supabase'
import { sendTextMessage } from '@/lib/whatsapp/client'
import {
  createAuthCode,
  verifyAuthCode,
  countRecentCodes,
} from '@/lib/db/queries/auth-codes'

const RATE_LIMIT_MAX = 3
const RATE_LIMIT_WINDOW_MINUTES = 15
const OTP_EXPIRY_MINUTES = 5

/**
 * Generate a random 6-digit OTP code as a zero-padded string.
 * e.g. "048291", "999000"
 */
export function generateOTP(): string {
  const code = Math.floor(Math.random() * 1_000_000)
  return code.toString().padStart(6, '0')
}

/**
 * Send an OTP to the given phone number via WhatsApp.
 * Enforces a rate limit of max 3 codes per 15-minute window.
 * The code expires in 5 minutes.
 *
 * @throws {Error} with message matching /rate limit/i when limit exceeded
 */
export async function sendOTP(phone: string): Promise<void> {
  const supabase = createServiceRoleClient()

  const recentCount = await countRecentCodes(supabase, phone, RATE_LIMIT_WINDOW_MINUTES)
  if (recentCount >= RATE_LIMIT_MAX) {
    throw new Error(
      `Rate limit exceeded: max ${RATE_LIMIT_MAX} codes per ${RATE_LIMIT_WINDOW_MINUTES} minutes`,
    )
  }

  const code = generateOTP()
  const expiresAt = new Date(Date.now() + OTP_EXPIRY_MINUTES * 60 * 1000)

  await createAuthCode(supabase, phone, code, expiresAt)

  const message = `Seu código de acesso ao CalorieBot Web: *${code}* (expira em 5 min)`
  await sendTextMessage(phone, message)
}

/**
 * Verify an OTP for the given phone number.
 * Returns true if the code is valid (not expired, not used) and marks it as used.
 * Returns false otherwise.
 */
export async function verifyOTP(phone: string, code: string): Promise<boolean> {
  const supabase = createServiceRoleClient()
  return verifyAuthCode(supabase, phone, code)
}
