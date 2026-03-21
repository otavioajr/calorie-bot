import { NextResponse } from 'next/server'
import { cookies } from 'next/headers'
import { createServiceRoleClient } from '@/lib/db/supabase'
import { deleteMeal } from '@/lib/db/queries/meals'

interface RouteContext {
  params: Promise<{ id: string }>
}

export async function DELETE(
  _request: Request,
  { params }: RouteContext,
): Promise<NextResponse> {
  const cookieStore = await cookies()
  const userId = cookieStore.get('caloriebot-user-id')?.value

  if (!userId) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const { id: mealId } = await params

  try {
    const supabase = createServiceRoleClient()

    // Verify the meal belongs to this user before deleting
    const { data, error: fetchError } = await supabase
      .from('meals')
      .select('id')
      .eq('id', mealId)
      .eq('user_id', userId)
      .single()

    if (fetchError || !data) {
      return NextResponse.json({ error: 'Meal not found' }, { status: 404 })
    }

    await deleteMeal(supabase, mealId)
    return NextResponse.json({ success: true })
  } catch (err) {
    console.error('[meal delete] error:', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
