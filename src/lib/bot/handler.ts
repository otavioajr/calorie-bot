import { createServiceRoleClient } from '@/lib/db/supabase'
import { findUserByPhone, createUser, getUserWithSettings } from '@/lib/db/queries/users'
import { getState } from '@/lib/bot/state'
import { classifyByRules } from '@/lib/bot/router'
import { handleOnboarding } from '@/lib/bot/flows/onboarding'
import { handleMealLog } from '@/lib/bot/flows/meal-log'
import { handleSummary } from '@/lib/bot/flows/summary'
import { handleQuery } from '@/lib/bot/flows/query'
import { handleEdit } from '@/lib/bot/flows/edit'
import { handleWeight } from '@/lib/bot/flows/weight'
import { handleSettings } from '@/lib/bot/flows/settings'
import { handleHelp, handleUserData } from '@/lib/bot/flows/help'
import { getLLMProvider } from '@/lib/llm/index'
import { sendTextMessage } from '@/lib/whatsapp/client'
import { formatOutOfScope, formatError } from '@/lib/utils/formatters'

export async function handleIncomingMessage(
  from: string,
  messageId: string,
  text: string
): Promise<void> {
  const supabase = createServiceRoleClient()

  try {
    // 1. Find or create user
    let user = await findUserByPhone(supabase, from)
    if (!user) {
      user = await createUser(supabase, from)
    }

    // 2. Check if onboarding is complete
    if (!user.onboardingComplete) {
      const result = await handleOnboarding(supabase, user.id, text, user.onboardingStep)
      console.log('[handler] Sending onboarding response to', from, ':', result.response.substring(0, 50))
      try {
        await sendTextMessage(from, result.response)
        console.log('[handler] Message sent successfully')
      } catch (sendErr) {
        console.error('[handler] Failed to send message:', sendErr)
      }
      return
    }

    const userSettings = {
      calorieMode: user.calorieMode,
      dailyCalorieTarget: user.dailyCalorieTarget,
    }

    // 3. Check for active conversation context
    const context = await getState(user.id)
    if (context) {
      switch (context.contextType) {
        case 'awaiting_confirmation':
        case 'awaiting_clarification':
        case 'awaiting_correction': {
          const mealResult = await handleMealLog(supabase, user.id, text, userSettings, context)
          await sendTextMessage(from, mealResult.response)
          return
        }
        case 'awaiting_weight': {
          const weightResponse = await handleWeight(supabase, user.id, text, user)
          await sendTextMessage(from, weightResponse)
          return
        }
        case 'settings_menu':
        case 'settings_change': {
          const settingsData = await getUserWithSettings(supabase, user.id)
          const settingsResponse = await handleSettings(supabase, user.id, text, user, settingsData.settings, context)
          await sendTextMessage(from, settingsResponse)
          return
        }
      }
    }

    // 4. Classify intent
    let intent = classifyByRules(text)
    if (!intent) {
      try {
        const llm = getLLMProvider()
        intent = await llm.classifyIntent(text)
      } catch {
        // LLM failed — default to assuming it's a meal log
        intent = 'meal_log'
      }
    }

    // 5. Route to appropriate flow
    let response: string
    switch (intent) {
      case 'meal_log': {
        const result = await handleMealLog(supabase, user.id, text, userSettings, null)
        response = result.response
        break
      }
      case 'summary':
        response = await handleSummary(supabase, user.id, text, { dailyCalorieTarget: user.dailyCalorieTarget })
        break
      case 'query':
        response = await handleQuery(supabase, user.id, text)
        break
      case 'edit':
        response = await handleEdit(supabase, user.id, text, null)
        break
      case 'weight':
        response = await handleWeight(supabase, user.id, text, user)
        break
      case 'settings': {
        const data = await getUserWithSettings(supabase, user.id)
        response = await handleSettings(supabase, user.id, text, user, data.settings, null)
        break
      }
      case 'help':
        response = await handleHelp()
        break
      case 'user_data':
        response = await handleUserData(supabase, user.id)
        break
      case 'out_of_scope':
        response = formatOutOfScope()
        break
      default:
        response = 'Não entendi 🤔 Me manda o que comeu ou digite "menu".'
        break
    }

    await sendTextMessage(from, response)
  } catch (err) {
    console.error('[handler] Error:', err)
    await sendTextMessage(from, formatError()).catch(() => {})
  }
}
