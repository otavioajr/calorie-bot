import { createServiceRoleClient } from '@/lib/db/supabase'
import { findUserByPhone, createUser } from '@/lib/db/queries/users'
import { getState } from '@/lib/bot/state'
import { classifyByRules } from '@/lib/bot/router'
import { handleOnboarding } from '@/lib/bot/flows/onboarding'
import { handleMealLog } from '@/lib/bot/flows/meal-log'
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
      await sendTextMessage(from, result.response)
      return
    }

    const userSettings = {
      calorieMode: user.calorieMode,
      dailyCalorieTarget: user.dailyCalorieTarget,
    }

    // 3. Check for active conversation context
    const context = await getState(user.id)
    if (context) {
      if (
        ['awaiting_confirmation', 'awaiting_clarification', 'awaiting_correction'].includes(
          context.contextType
        )
      ) {
        const result = await handleMealLog(supabase, user.id, text, userSettings, context)
        await sendTextMessage(from, result.response)
        return
      }
      // Other context types will be handled later (settings_menu, etc.)
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
      case 'help':
        // TODO: Task 29
        response = formatOutOfScope() // placeholder
        break
      case 'meal_log': {
        const result = await handleMealLog(supabase, user.id, text, userSettings, null)
        response = result.response
        break
      }
      case 'summary':
      case 'edit':
      case 'query':
      case 'weight':
      case 'settings':
      case 'user_data':
        // TODO: Will be implemented in Tasks 24-30
        response = 'Essa função ainda não está disponível. Aguarde! 🚧'
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
