import type { SupabaseClient } from '@supabase/supabase-js'
import {
  validateName,
  validateAge,
  validateSex,
  validateWeight,
  validateHeight,
  validateActivityLevel,
  validateGoal,
  validateCalorieMode,
} from '@/lib/utils/validators'
import { calculateAll } from '@/lib/calc/tdee'
import { setState, clearState } from '@/lib/bot/state'
import { updateUser, getUserWithSettings } from '@/lib/db/queries/users'
import { createDefaultSettings } from '@/lib/db/queries/settings'
import { formatOnboardingComplete } from '@/lib/utils/formatters'

// ---------------------------------------------------------------------------
// Public interface
// ---------------------------------------------------------------------------

export interface OnboardingResult {
  response: string
  completed: boolean
}

// ---------------------------------------------------------------------------
// Step messages
// ---------------------------------------------------------------------------

const WELCOME_MSG = `Olá! 👋 Eu sou o CalorieBot, seu assistente de controle de calorias.\nVou te fazer algumas perguntas rápidas pra configurar tudo (< 2 min).\nQual é o seu nome?`

const MSG_ASK_SEX = `Para calcular sua meta calórica, preciso saber:\n1️⃣ Masculino\n2️⃣ Feminino`

const MSG_ASK_WEIGHT = `Qual seu peso atual em kg? (ex: 72.5)`

const MSG_ASK_HEIGHT = `E sua altura em cm? (ex: 175)`

const MSG_ASK_ACTIVITY = `Qual seu nível de atividade física?\n1️⃣ Sedentário (pouco ou nenhum exercício)\n2️⃣ Leve (1-3 dias/semana)\n3️⃣ Moderado (3-5 dias/semana)\n4️⃣ Intenso (6-7 dias/semana)`

const MSG_ASK_GOAL = `Qual seu objetivo?\n1️⃣ Perder peso\n2️⃣ Manter peso\n3️⃣ Ganhar massa`

const MSG_ASK_CALORIE_MODE = `Como quer que eu calcule as calorias?\n1️⃣ Tabela TACO — uso a tabela oficial brasileira (mais preciso)\n2️⃣ Manual — você me envia a tabela nutricional (precisão total)`

// ---------------------------------------------------------------------------
// Main handler
// ---------------------------------------------------------------------------

export async function handleOnboarding(
  supabase: SupabaseClient,
  userId: string,
  message: string,
  currentStep: number,
): Promise<OnboardingResult> {
  // -------------------------------------------------------------------------
  // Step 0 — first contact, send welcome and ask for name
  // -------------------------------------------------------------------------
  if (currentStep === 0) {
    await updateUser(supabase, userId, { onboardingStep: 1 })
    await setState(userId, 'onboarding', { step: 1 })
    return { response: WELCOME_MSG, completed: false }
  }

  // -------------------------------------------------------------------------
  // Step 1 — user sends name
  // -------------------------------------------------------------------------
  if (currentStep === 1) {
    const result = validateName(message)
    if (!result.valid) {
      return { response: result.error, completed: false }
    }
    const name = result.value
    await updateUser(supabase, userId, { name, onboardingStep: 2 })
    await setState(userId, 'onboarding', { step: 2, name })
    return { response: `Prazer, ${name}! Quantos anos você tem?`, completed: false }
  }

  // -------------------------------------------------------------------------
  // Step 2 — user sends age
  // -------------------------------------------------------------------------
  if (currentStep === 2) {
    const result = validateAge(message)
    if (!result.valid) {
      return { response: result.error, completed: false }
    }
    const age = result.value
    await updateUser(supabase, userId, { age, onboardingStep: 3 })
    await setState(userId, 'onboarding', { step: 3, age })
    return { response: MSG_ASK_SEX, completed: false }
  }

  // -------------------------------------------------------------------------
  // Step 3 — user sends sex
  // -------------------------------------------------------------------------
  if (currentStep === 3) {
    const result = validateSex(message)
    if (!result.valid) {
      return { response: result.error, completed: false }
    }
    const sex = result.value
    await updateUser(supabase, userId, { sex, onboardingStep: 4 })
    await setState(userId, 'onboarding', { step: 4, sex })
    return { response: MSG_ASK_WEIGHT, completed: false }
  }

  // -------------------------------------------------------------------------
  // Step 4 — user sends weight
  // -------------------------------------------------------------------------
  if (currentStep === 4) {
    const result = validateWeight(message)
    if (!result.valid) {
      return { response: result.error, completed: false }
    }
    const weightKg = result.value

    // Save weight to users table
    await updateUser(supabase, userId, { weightKg, onboardingStep: 5 })

    // Also create a weight_log entry
    await supabase.from('weight_log').insert({
      user_id: userId,
      weight_kg: weightKg,
      logged_at: new Date().toISOString(),
    })

    await setState(userId, 'onboarding', { step: 5, weightKg })
    return { response: MSG_ASK_HEIGHT, completed: false }
  }

  // -------------------------------------------------------------------------
  // Step 5 — user sends height
  // -------------------------------------------------------------------------
  if (currentStep === 5) {
    const result = validateHeight(message)
    if (!result.valid) {
      return { response: result.error, completed: false }
    }
    const heightCm = result.value
    await updateUser(supabase, userId, { heightCm, onboardingStep: 6 })
    await setState(userId, 'onboarding', { step: 6, heightCm })
    return { response: MSG_ASK_ACTIVITY, completed: false }
  }

  // -------------------------------------------------------------------------
  // Step 6 — user sends activity level
  // -------------------------------------------------------------------------
  if (currentStep === 6) {
    const result = validateActivityLevel(message)
    if (!result.valid) {
      return { response: result.error, completed: false }
    }
    const activityLevel = result.value
    await updateUser(supabase, userId, { activityLevel, onboardingStep: 7 })
    await setState(userId, 'onboarding', { step: 7, activityLevel })
    return { response: MSG_ASK_GOAL, completed: false }
  }

  // -------------------------------------------------------------------------
  // Step 7 — user sends goal
  // -------------------------------------------------------------------------
  if (currentStep === 7) {
    const result = validateGoal(message)
    if (!result.valid) {
      return { response: result.error, completed: false }
    }
    const goal = result.value
    await updateUser(supabase, userId, { goal, onboardingStep: 8 })
    await setState(userId, 'onboarding', { step: 8, goal })
    return { response: MSG_ASK_CALORIE_MODE, completed: false }
  }

  // -------------------------------------------------------------------------
  // Step 8 — user sends calorie mode (finalization)
  // -------------------------------------------------------------------------
  if (currentStep === 8) {
    const result = validateCalorieMode(message)
    if (!result.valid) {
      return { response: result.error, completed: false }
    }
    const calorieMode = result.value

    // Save calorie mode first
    await updateUser(supabase, userId, { calorieMode })

    // Fetch full user data from DB for TMB/TDEE calculation
    const { user } = await getUserWithSettings(supabase, userId)

    // Calculate TMB, TDEE and daily target
    const { tmb, tdee, dailyTarget } = calculateAll({
      sex: user.sex!,
      weightKg: user.weightKg!,
      heightCm: user.heightCm!,
      age: user.age!,
      activityLevel: user.activityLevel!,
      goal: user.goal!,
    })

    // Persist calculations and mark onboarding complete
    await updateUser(supabase, userId, {
      tmb,
      tdee,
      dailyCalorieTarget: Math.round(dailyTarget),
      onboardingComplete: true,
      onboardingStep: 8,
    })

    // Create default settings for the new user
    await createDefaultSettings(supabase, userId)

    // Clear the onboarding context
    await clearState(userId)

    return {
      response: formatOnboardingComplete(user.name, dailyTarget),
      completed: true,
    }
  }

  // Fallback — should never be reached for steps 0-8
  return { response: WELCOME_MSG, completed: false }
}
