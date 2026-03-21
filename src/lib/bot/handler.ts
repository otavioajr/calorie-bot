import { createServiceRoleClient } from '@/lib/db/supabase'
import { findUserByPhone, createUser } from '@/lib/db/queries/users'
import { getState } from '@/lib/bot/state'
import { classifyByRules } from '@/lib/bot/router'
import { handleOnboarding } from '@/lib/bot/flows/onboarding'
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

    // 3. Check for active conversation context
    const context = await getState(user.id)
    if (context) {
      // TODO: Handle context-specific flows (meal confirmation, etc.)
      // For now, just handle onboarding context if somehow still active
      // Other context types will be added in Phase 6-7
    }

    // 4. Classify intent
    const intent = classifyByRules(text)
    // TODO: LLM fallback when intent is null (Task 23)

    // 5. Route to appropriate flow
    let response: string
    switch (intent) {
      case 'help':
        // TODO: Task 29
        response = formatOutOfScope() // placeholder
        break
      case 'summary':
      case 'edit':
      case 'query':
      case 'weight':
      case 'settings':
      case 'user_data':
      case 'meal_log':
        // TODO: Will be implemented in Tasks 22-30
        response = 'Essa função ainda não está disponível. Aguarde! 🚧'
        break
      case 'out_of_scope':
        response = formatOutOfScope()
        break
      default:
        // No rule matched, no LLM yet — treat as potential meal log
        // TODO: LLM classification (Task 23)
        response = 'Não entendi 🤔 Me manda o que comeu ou digite "menu".'
        break
    }

    await sendTextMessage(from, response)
  } catch (err) {
    console.error('[handler] Error:', err)
    await sendTextMessage(from, formatError()).catch(() => {})
  }
}
