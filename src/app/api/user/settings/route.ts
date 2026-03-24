import { NextResponse } from 'next/server'
import { cookies } from 'next/headers'
import { createServiceRoleClient } from '@/lib/db/supabase'
import { updateUser } from '@/lib/db/queries/users'
import { updateSettings } from '@/lib/db/queries/settings'

export async function PUT(request: Request): Promise<NextResponse> {
  const cookieStore = await cookies()
  const userId = cookieStore.get('caloriebot-user-id')?.value

  if (!userId) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  let body: Record<string, unknown>
  try {
    body = (await request.json()) as Record<string, unknown>
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  const { calorieMode, detailLevel, weightUnit, remindersEnabled, reminderTime, dailySummaryTime } = body

  try {
    const supabase = createServiceRoleClient()

    // Update calorie mode on the user record
    if (calorieMode !== undefined) {
      await updateUser(supabase, userId, { calorieMode: calorieMode as 'taco' | 'manual' })
    }

    // Update user_settings
    const settingsUpdate: Record<string, unknown> = {}
    if (detailLevel !== undefined) settingsUpdate.detailLevel = detailLevel
    if (weightUnit !== undefined) settingsUpdate.weightUnit = weightUnit
    if (remindersEnabled !== undefined) settingsUpdate.remindersEnabled = remindersEnabled
    if (reminderTime !== undefined) settingsUpdate.reminderTime = reminderTime
    if (dailySummaryTime !== undefined) settingsUpdate.dailySummaryTime = dailySummaryTime

    if (Object.keys(settingsUpdate).length > 0) {
      await updateSettings(supabase, userId, settingsUpdate as Parameters<typeof updateSettings>[2])
    }

    return NextResponse.json({ success: true })
  } catch (err) {
    console.error('[settings update] error:', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
