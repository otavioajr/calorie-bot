import { NextResponse } from 'next/server'
import { sendOTP } from '@/lib/auth/otp'

/**
 * Validates a phone number in E.164 format.
 * Accepts numbers like +5511999999999 (minimum 8 digits after country code).
 */
function isValidPhone(phone: unknown): phone is string {
  if (typeof phone !== 'string') return false
  return /^\+[1-9]\d{7,14}$/.test(phone)
}

export async function POST(request: Request): Promise<NextResponse> {
  let body: Record<string, unknown>
  try {
    body = (await request.json()) as Record<string, unknown>
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  const { phone } = body

  if (!isValidPhone(phone)) {
    return NextResponse.json(
      { error: 'Invalid phone number format. Use E.164 format, e.g. +5511999999999' },
      { status: 400 },
    )
  }

  try {
    await sendOTP(phone)
    return NextResponse.json({ success: true }, { status: 200 })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error'

    if (/rate limit/i.test(message)) {
      return NextResponse.json(
        { error: 'Too many requests. Please wait before requesting a new code.' },
        { status: 429 },
      )
    }

    console.error('[OTP send] unexpected error:', err)
    return NextResponse.json({ error: 'Failed to send OTP' }, { status: 500 })
  }
}
