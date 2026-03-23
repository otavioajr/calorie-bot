import { NextResponse } from 'next/server'
import { cookies } from 'next/headers'
import { createServiceRoleClient } from '@/lib/db/supabase'
import { resetUserData } from '@/lib/db/queries/users'

export async function POST(): Promise<NextResponse> {
  const cookieStore = await cookies()
  const userId = cookieStore.get('caloriebot-user-id')?.value

  if (!userId) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  try {
    const supabase = createServiceRoleClient()
    await resetUserData(supabase, userId)

    cookieStore.delete('caloriebot-user-id')

    return NextResponse.json({ success: true })
  } catch (err) {
    console.error('[reset-data] error:', err)
    return NextResponse.json({ error: 'Failed to reset data' }, { status: 500 })
  }
}
