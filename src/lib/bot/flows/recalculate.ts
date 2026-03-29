import type { SupabaseClient } from '@supabase/supabase-js'
import { getUserWithSettings, updateUser } from '@/lib/db/queries/users'
import { calculateAll } from '@/lib/calc/tdee'
import type { Sex, ActivityLevel, Goal } from '@/lib/calc/tdee'

export async function handleRecalculate(
  supabase: SupabaseClient,
  userId: string,
): Promise<string> {
  const { user } = await getUserWithSettings(supabase, userId)

  if (!user.onboardingComplete) {
    return 'Você precisa completar o cadastro primeiro! Me manda "oi" pra começar.'
  }

  if (!user.sex || !user.weightKg || !user.heightCm || !user.age || !user.activityLevel || !user.goal) {
    return 'Seus dados de perfil estão incompletos. Atualize pelo site ou entre em contato.'
  }

  const result = calculateAll({
    sex: user.sex as Sex,
    weightKg: user.weightKg,
    heightCm: user.heightCm,
    age: user.age,
    activityLevel: user.activityLevel as ActivityLevel,
    goal: user.goal as Goal,
  })

  await updateUser(supabase, userId, {
    tmb: result.tmb,
    tdee: result.tdee,
    dailyCalorieTarget: Math.round(result.dailyTarget),
    maxWeightKg: result.maxWeightKg,
    dailyProteinG: result.proteinG,
    dailyFatG: result.fatG,
    dailyCarbsG: result.carbsG,
  })

  return [
    'Recalculado! ✅',
    `Meta: ${Math.round(result.dailyTarget)} kcal`,
    `Proteína: ${result.proteinG}g | Gordura: ${result.fatG}g | Carbs: ${result.carbsG}g`,
  ].join('\n')
}
