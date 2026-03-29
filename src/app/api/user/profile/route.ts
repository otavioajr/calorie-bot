import { NextResponse } from 'next/server'
import { cookies } from 'next/headers'
import { createServiceRoleClient } from '@/lib/db/supabase'
import { updateUser } from '@/lib/db/queries/users'
import { calculateAll } from '@/lib/calc/tdee'
import type { Sex, ActivityLevel, Goal } from '@/lib/calc/tdee'

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

  const {
    name, age, sex, weightKg, heightCm, activityLevel, goal,
    dailyProteinG, dailyFatG, dailyCarbsG,
  } = body

  try {
    const supabase = createServiceRoleClient()

    const updateData: Record<string, unknown> = {}
    if (name !== undefined) updateData.name = name
    if (age !== undefined) updateData.age = age
    if (sex !== undefined) updateData.sex = sex
    if (weightKg !== undefined) updateData.weightKg = weightKg
    if (heightCm !== undefined) updateData.heightCm = heightCm
    if (activityLevel !== undefined) updateData.activityLevel = activityLevel
    if (goal !== undefined) updateData.goal = goal

    // Handle manual macro overrides
    if (dailyProteinG !== undefined) updateData.dailyProteinG = dailyProteinG
    if (dailyFatG !== undefined) updateData.dailyFatG = dailyFatG
    if (dailyCarbsG !== undefined) updateData.dailyCarbsG = dailyCarbsG

    // Recalculate TDEE if enough data
    let calcResult: ReturnType<typeof calculateAll> | null = null
    const effectiveSex = (sex as Sex | null) ?? null
    const effectiveWeight = (weightKg as number | null) ?? null
    const effectiveHeight = (heightCm as number | null) ?? null
    const effectiveAge = (age as number | null) ?? null
    const effectiveActivity = (activityLevel as ActivityLevel | null) ?? null
    const effectiveGoal = (goal as Goal | null) ?? null

    if (
      effectiveSex &&
      effectiveWeight &&
      effectiveHeight &&
      effectiveAge &&
      effectiveActivity &&
      effectiveGoal
    ) {
      calcResult = calculateAll({
        sex: effectiveSex,
        weightKg: effectiveWeight,
        heightCm: effectiveHeight,
        age: effectiveAge,
        activityLevel: effectiveActivity,
        goal: effectiveGoal,
      })
      updateData.tmb = calcResult.tmb
      updateData.tdee = calcResult.tdee
      updateData.dailyCalorieTarget = Math.round(calcResult.dailyTarget)
      updateData.maxWeightKg = calcResult.maxWeightKg

      // Only set calculated macros if not manually overriding
      if (dailyProteinG === undefined && dailyFatG === undefined && dailyCarbsG === undefined) {
        updateData.dailyProteinG = calcResult.proteinG
        updateData.dailyFatG = calcResult.fatG
        updateData.dailyCarbsG = calcResult.carbsG
      }
    }

    await updateUser(supabase, userId, updateData as Parameters<typeof updateUser>[2])

    return NextResponse.json({
      success: true,
      tmb: calcResult?.tmb,
      tdee: calcResult?.tdee,
      dailyTarget: calcResult ? Math.round(calcResult.dailyTarget) : undefined,
      maxWeightKg: calcResult?.maxWeightKg,
      proteinG: (updateData.dailyProteinG as number | undefined) ?? calcResult?.proteinG,
      fatG: (updateData.dailyFatG as number | undefined) ?? calcResult?.fatG,
      carbsG: (updateData.dailyCarbsG as number | undefined) ?? calcResult?.carbsG,
    })
  } catch (err) {
    console.error('[profile update] error:', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
