import { NextResponse } from 'next/server'
import { cookies } from 'next/headers'
import { z } from 'zod'
import { createServiceRoleClient } from '@/lib/db/supabase'
import { MealTypeSchema } from '@/lib/llm/schemas/common'
import { logMealFromRecipe } from '@/lib/recipes/log-meal'

const NUMERIC_5_2_MAX = 999.99

interface RouteContext {
  params: Promise<{ id: string }>
}

function isValidDate(value: string): boolean {
  const date = new Date(value)
  return !Number.isNaN(date.getTime())
}

const BodySchema = z.object({
  servingsConsumed: z.number().positive().finite().max(NUMERIC_5_2_MAX),
  mealType: MealTypeSchema,
  registeredAt: z.string().datetime().refine(isValidDate),
})

export async function POST(
  request: Request,
  { params }: RouteContext,
): Promise<NextResponse> {
  const cookieStore = await cookies()
  const userId = cookieStore.get('caloriebot-user-id')?.value

  if (!userId) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  let rawBody: unknown
  try {
    rawBody = await request.json()
  } catch {
    return NextResponse.json({ error: 'invalid_json' }, { status: 400 })
  }

  const parsedBody = BodySchema.safeParse(rawBody)
  if (!parsedBody.success) {
    return NextResponse.json({ error: 'invalid_body' }, { status: 400 })
  }

  const { id } = await params
  const { servingsConsumed, mealType, registeredAt } = parsedBody.data

  try {
    const supabase = createServiceRoleClient()
    const mealId = await logMealFromRecipe(supabase, {
      userId,
      recipeId: id,
      portionsConsumed: servingsConsumed,
      mealType,
      registeredAt: new Date(registeredAt),
      sourceMessage: 'log via web',
    })

    return NextResponse.json({ mealId }, { status: 201 })
  } catch {
    return NextResponse.json({ error: 'log_failed' }, { status: 500 })
  }
}
