import { NextResponse } from 'next/server'
import { verifyOTP } from '@/lib/auth/otp'
import { createServiceRoleClient } from '@/lib/db/supabase'
import { findUserByPhone } from '@/lib/db/queries/users'

function isValidPhone(phone: unknown): phone is string {
  if (typeof phone !== 'string') return false
  return /^\+[1-9]\d{7,14}$/.test(phone)
}

function isValidCode(code: unknown): code is string {
  if (typeof code !== 'string') return false
  return /^\d{6}$/.test(code)
}

export async function POST(request: Request): Promise<NextResponse> {
  let body: Record<string, unknown>
  try {
    body = (await request.json()) as Record<string, unknown>
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  const { phone, code } = body

  if (!isValidPhone(phone)) {
    return NextResponse.json(
      { error: 'Invalid phone number format. Use E.164 format, e.g. +5511999999999' },
      { status: 400 },
    )
  }

  if (!isValidCode(code)) {
    return NextResponse.json(
      { error: 'Invalid code format. Must be a 6-digit string.' },
      { status: 400 },
    )
  }

  try {
    const isValid = await verifyOTP(phone, code)

    if (!isValid) {
      return NextResponse.json(
        { success: false, error: 'Invalid or expired code' },
        { status: 401 },
      )
    }

    const supabase = createServiceRoleClient()
    const user = await findUserByPhone(supabase, phone)

    if (!user) {
      return NextResponse.json(
        { success: false, error: 'Cadastre-se primeiro pelo WhatsApp' },
        { status: 200 },
      )
    }

    return NextResponse.json({ success: true, userId: user.id }, { status: 200 })
  } catch (err) {
    console.error('[OTP verify] unexpected error:', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
