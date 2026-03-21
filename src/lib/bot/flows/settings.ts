import type { SupabaseClient } from '@supabase/supabase-js'
import type { User, UserSettings } from '@/lib/db/queries/users'
import { updateUser } from '@/lib/db/queries/users'
import { updateSettings } from '@/lib/db/queries/settings'
import type { ConversationContext } from '@/lib/bot/state'
import { setState, clearState } from '@/lib/bot/state'
import { formatSettingsMenu } from '@/lib/utils/formatters'
import { calculateAll } from '@/lib/calc/tdee'
import type { Sex, ActivityLevel, Goal } from '@/lib/calc/tdee'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type GoalValue = 'lose' | 'maintain' | 'gain'
type CalorieModeValue = 'approximate' | 'taco' | 'manual'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const WEB_PANEL_URL = process.env.NEXT_PUBLIC_APP_URL ?? 'https://caloriebot.app'

const GOAL_LABELS: Record<GoalValue, string> = {
  lose: 'Perder peso',
  maintain: 'Manter peso',
  gain: 'Ganhar massa',
}

const MODE_LABELS: Record<CalorieModeValue, string> = {
  approximate: 'Aproximado',
  taco: 'TACO',
  manual: 'Manual',
}

// ---------------------------------------------------------------------------
// handleSettings
// ---------------------------------------------------------------------------

export async function handleSettings(
  supabase: SupabaseClient,
  userId: string,
  message: string,
  user: User,
  settings: UserSettings | null,
  context: ConversationContext | null,
): Promise<string> {
  const trimmed = message.trim()

  // -------------------------------------------------------------------------
  // Branch: settings_change context — apply the value
  // -------------------------------------------------------------------------
  if (context?.contextType === 'settings_change') {
    return applySettingChange(supabase, userId, trimmed, user, context)
  }

  // -------------------------------------------------------------------------
  // Branch: settings_menu context — user selected an option number
  // -------------------------------------------------------------------------
  if (context?.contextType === 'settings_menu') {
    return handleMenuSelection(supabase, userId, trimmed, user, settings)
  }

  // -------------------------------------------------------------------------
  // Default: show settings menu
  // -------------------------------------------------------------------------
  return showSettingsMenu(supabase, userId, user, settings)
}

// ---------------------------------------------------------------------------
// showSettingsMenu
// ---------------------------------------------------------------------------

async function showSettingsMenu(
  supabase: SupabaseClient,
  userId: string,
  user: User,
  settings: UserSettings | null,
): Promise<string> {
  const goal = user.goal ?? 'maintain'
  const calorieMode = user.calorieMode ?? 'approximate'
  const dailyTarget = user.dailyCalorieTarget ?? 2000
  const remindersEnabled = settings?.remindersEnabled ?? false
  const detailLevel = settings?.detailLevel ?? 'brief'

  const menu = formatSettingsMenu({
    goal: GOAL_LABELS[goal as GoalValue] ?? goal,
    calorieMode: MODE_LABELS[calorieMode as CalorieModeValue] ?? calorieMode,
    dailyTarget,
    remindersEnabled,
    detailLevel,
  })

  await setState(userId, 'settings_menu', {})

  return menu
}

// ---------------------------------------------------------------------------
// handleMenuSelection
// ---------------------------------------------------------------------------

async function handleMenuSelection(
  supabase: SupabaseClient,
  userId: string,
  message: string,
  user: User,
  settings: UserSettings | null,
): Promise<string> {
  const option = parseInt(message, 10)

  if (isNaN(option) || option < 1 || option > 7) {
    return 'Opção inválida. Por favor, escolha um número de 1 a 7.'
  }

  switch (option) {
    case 1:
      await setState(userId, 'settings_change', { option: 1, field: 'goal' })
      return buildGoalSubMenu(user.goal)

    case 2:
      await setState(userId, 'settings_change', { option: 2, field: 'calorieMode' })
      return buildCalorieModeSubMenu(user.calorieMode)

    case 3:
      await setState(userId, 'settings_change', { option: 3, field: 'dailyCalorieTarget' })
      return `Qual sua nova meta de calorias diárias? (atual: ${user.dailyCalorieTarget ?? 2000} kcal)`

    case 4:
      await setState(userId, 'settings_change', { option: 4, field: 'remindersEnabled' })
      return 'Lembretes: 1️⃣ Ligar  2️⃣ Desligar'

    case 5:
      await setState(userId, 'settings_change', { option: 5, field: 'detailLevel' })
      return 'Nível de detalhe: 1️⃣ Resumido  2️⃣ Detalhado'

    case 6:
      await clearState(userId)
      return 'Para atualizar seu peso, me diga: "pesei X kg"'

    case 7:
      await clearState(userId)
      return `Acesse o painel completo na web: ${WEB_PANEL_URL}`

    default:
      return 'Opção inválida. Por favor, escolha um número de 1 a 7.'
  }
}

// ---------------------------------------------------------------------------
// applySettingChange
// ---------------------------------------------------------------------------

async function applySettingChange(
  supabase: SupabaseClient,
  userId: string,
  message: string,
  user: User,
  context: ConversationContext,
): Promise<string> {
  const field = context.contextData.field as string

  switch (field) {
    case 'goal':
      return applyGoalChange(supabase, userId, message, user)

    case 'calorieMode':
      return applyCalorieModeChange(supabase, userId, message, user)

    case 'dailyCalorieTarget':
      return applyCalorieTargetChange(supabase, userId, message)

    case 'remindersEnabled':
      return applyRemindersChange(supabase, userId, message)

    case 'detailLevel':
      return applyDetailLevelChange(supabase, userId, message)

    default:
      await clearState(userId)
      return 'Configuração atualizada! ✅'
  }
}

// ---------------------------------------------------------------------------
// applyGoalChange
// ---------------------------------------------------------------------------

async function applyGoalChange(
  supabase: SupabaseClient,
  userId: string,
  message: string,
  user: User,
): Promise<string> {
  const goalMap: Record<string, GoalValue> = {
    '1': 'lose',
    perder: 'lose',
    '2': 'maintain',
    manter: 'maintain',
    '3': 'gain',
    ganhar: 'gain',
  }

  const newGoal = goalMap[message.toLowerCase()]

  if (!newGoal) {
    return 'Opção inválida. Digite 1 (perder), 2 (manter) ou 3 (ganhar).'
  }

  const updatePayload: Partial<Omit<User, 'id' | 'createdAt' | 'updatedAt'>> = { goal: newGoal }

  // Recalculate TDEE if possible
  if (
    !user.calorieTargetManual &&
    user.sex &&
    user.weightKg &&
    user.heightCm &&
    user.age &&
    user.activityLevel
  ) {
    const { tmb, tdee, dailyTarget } = calculateAll({
      sex: user.sex as Sex,
      weightKg: user.weightKg,
      heightCm: user.heightCm,
      age: user.age,
      activityLevel: user.activityLevel as ActivityLevel,
      goal: newGoal,
    })
    updatePayload.tmb = tmb
    updatePayload.tdee = tdee
    updatePayload.dailyCalorieTarget = dailyTarget
  }

  await updateUser(supabase, userId, updatePayload)
  await clearState(userId)

  const label = GOAL_LABELS[newGoal]
  return `Objetivo atualizado para: ${label} ✅`
}

// ---------------------------------------------------------------------------
// applyCalorieModeChange
// ---------------------------------------------------------------------------

async function applyCalorieModeChange(
  supabase: SupabaseClient,
  userId: string,
  message: string,
  user: User,
): Promise<string> {
  const modeMap: Record<string, CalorieModeValue> = {
    '1': 'approximate',
    aproximado: 'approximate',
    '2': 'taco',
    taco: 'taco',
    '3': 'manual',
    manual: 'manual',
  }

  const newMode = modeMap[message.toLowerCase()]

  if (!newMode) {
    return 'Modo inválido. Digite 1 (aproximado), 2 (TACO) ou 3 (manual).'
  }

  await updateUser(supabase, userId, { calorieMode: newMode })
  await clearState(userId)

  const label = MODE_LABELS[newMode]
  return `Modo de cálculo atualizado para: ${label} ✅`
}

// ---------------------------------------------------------------------------
// applyCalorieTargetChange
// ---------------------------------------------------------------------------

async function applyCalorieTargetChange(
  supabase: SupabaseClient,
  userId: string,
  message: string,
): Promise<string> {
  const target = parseInt(message.replace(/[^\d]/g, ''), 10)

  if (isNaN(target) || target < 500 || target > 10000) {
    return 'Valor inválido. Informe um número de calorias entre 500 e 10000 kcal.'
  }

  await updateUser(supabase, userId, {
    dailyCalorieTarget: target,
    calorieTargetManual: true,
  })
  await clearState(userId)

  return `Meta calórica atualizada para: ${target} kcal ✅`
}

// ---------------------------------------------------------------------------
// applyRemindersChange
// ---------------------------------------------------------------------------

async function applyRemindersChange(
  supabase: SupabaseClient,
  userId: string,
  message: string,
): Promise<string> {
  const enableMap: Record<string, boolean> = {
    '1': true,
    ligar: true,
    sim: true,
    '2': false,
    desligar: false,
    não: false,
    nao: false,
  }

  const enabled = enableMap[message.toLowerCase()]

  if (enabled === undefined) {
    return 'Opção inválida. Digite 1 (ligar) ou 2 (desligar).'
  }

  await updateSettings(supabase, userId, { remindersEnabled: enabled })
  await clearState(userId)

  const statusLabel = enabled ? 'ligados' : 'desligados'
  return `Lembretes ${statusLabel}! ✅`
}

// ---------------------------------------------------------------------------
// applyDetailLevelChange
// ---------------------------------------------------------------------------

async function applyDetailLevelChange(
  supabase: SupabaseClient,
  userId: string,
  message: string,
): Promise<string> {
  const levelMap: Record<string, 'brief' | 'detailed'> = {
    '1': 'brief',
    resumido: 'brief',
    '2': 'detailed',
    detalhado: 'detailed',
  }

  const level = levelMap[message.toLowerCase()]

  if (!level) {
    return 'Opção inválida. Digite 1 (resumido) ou 2 (detalhado).'
  }

  await updateSettings(supabase, userId, { detailLevel: level })
  await clearState(userId)

  const levelLabel = level === 'brief' ? 'Resumido' : 'Detalhado'
  return `Nível de detalhe atualizado para: ${levelLabel} ✅`
}

// ---------------------------------------------------------------------------
// Sub-menu builders
// ---------------------------------------------------------------------------

function buildGoalSubMenu(currentGoal: string | null): string {
  const current = currentGoal ? (GOAL_LABELS[currentGoal as GoalValue] ?? currentGoal) : '—'
  return [
    `🎯 Qual seu objetivo? (atual: ${current})`,
    '',
    '1️⃣ Perder peso',
    '2️⃣ Manter peso',
    '3️⃣ Ganhar massa',
  ].join('\n')
}

function buildCalorieModeSubMenu(currentMode: string): string {
  const current = MODE_LABELS[currentMode as CalorieModeValue] ?? currentMode
  return [
    `⚙️ Qual modo de cálculo? (atual: ${current})`,
    '',
    '1️⃣ Aproximado (estimativas rápidas)',
    '2️⃣ TACO (tabela nutricional brasileira)',
    '3️⃣ Manual (você define tudo)',
  ].join('\n')
}
