import { createServiceRoleClient } from '@/lib/db/supabase'
import { findUserByPhone, createUser, getUserWithSettings } from '@/lib/db/queries/users'
import { getState, setState, clearState, type ConversationContext } from '@/lib/bot/state'
import { classifyByRules, isCancelCommand } from '@/lib/bot/router'
import { handleOnboarding } from '@/lib/bot/flows/onboarding'
import { handleMealLog } from '@/lib/bot/flows/meal-log'
import { handleSummary } from '@/lib/bot/flows/summary'
import { handleQuery, handleQueryConfirmation } from '@/lib/bot/flows/query'
import { handleEdit } from '@/lib/bot/flows/edit'
import { handleWeight } from '@/lib/bot/flows/weight'
import { handleSettings } from '@/lib/bot/flows/settings'
import { handleHelp, handleUserData } from '@/lib/bot/flows/help'
import { handleRecalculate } from '@/lib/bot/flows/recalculate'
import { getLLMProvider } from '@/lib/llm/index'
import { sendTextMessage } from '@/lib/whatsapp/client'
import { formatOutOfScope, formatError, formatMealBreakdown } from '@/lib/utils/formatters'
import { downloadAudioMedia, transcribeAudio, AudioTooLargeError } from '@/lib/audio/transcribe'
import { downloadWhatsAppMedia, MediaTooLargeError } from '@/lib/whatsapp/media'
import { detectMimeType } from '@/lib/whatsapp/mime'
import { logLLMUsage } from '@/lib/db/queries/llm-usage'
import { createMeal, getDailyCalories, getMealWithItems } from '@/lib/db/queries/meals'
import { saveMessage } from '@/lib/db/queries/message-history'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { ImageAnalysis } from '@/lib/llm/schemas/image-analysis'
import type { MealAnalysis } from '@/lib/llm/schemas/meal-analysis'
import { buildContextualCorrectionPrompt } from '@/lib/llm/prompts/contextual-correction'
import type { RecentMealItem } from '@/lib/llm/prompts/contextual-correction'

const MAX_IMAGE_SIZE = 5_242_880 // 5MB

function saveHistory(supabase: SupabaseClient, userId: string, userMsg: string, botMsg: string): void {
  saveMessage(supabase, userId, 'user', userMsg).catch(() => {})
  saveMessage(supabase, userId, 'assistant', botMsg).catch(() => {})
}

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
      dailyProteinG: user.dailyProteinG,
      dailyFatG: user.dailyFatG,
      dailyCarbsG: user.dailyCarbsG,
      phone: from,
      timezone: user.timezone,
    }

    // 3. Check for active conversation context
    const context = await getState(user.id)

    // 3.1 Cancel command — escape any active flow
    if (context && isCancelCommand(text)) {
      await clearState(user.id)
      const cancelMsg = 'Tudo bem, cancelei! 👍 Me manda o que precisar.'
      await sendTextMessage(from, cancelMsg)
      saveHistory(supabase, user.id, text, cancelMsg)
      return
    }

    if (context) {
      switch (context.contextType) {
        case 'recent_meal': {
          // LLM gatekeeper: is this a correction of the recent meal?
          const recentItems = context.contextData.items as unknown as RecentMealItem[]
          const recentMealId = context.contextData.mealId as string
          try {
            const llm = getLLMProvider()
            const gatekeeperRaw = await llm.chat(
              buildContextualCorrectionPrompt(recentItems, text),
              'Você detecta correções de refeições. Responda APENAS com JSON válido.',
              true,
            )
            const gatekeeper = JSON.parse(gatekeeperRaw.trim()) as { is_correction: boolean; corrected_message?: string }

            if (gatekeeper.is_correction && gatekeeper.corrected_message) {
              const editResponse = await handleEdit(supabase, user.id, gatekeeper.corrected_message, null, {
                timezone: user.timezone,
                dailyCalorieTarget: user.dailyCalorieTarget,
              })

              // After correction, refresh recent_meal state with updated items
              const updatedMeal = await getMealWithItems(supabase, recentMealId)
              if (updatedMeal && updatedMeal.items.length > 0) {
                await setState(user.id, 'recent_meal', {
                  mealId: recentMealId,
                  mealType: updatedMeal.mealType,
                  items: updatedMeal.items.map(i => ({
                    id: i.id,
                    foodName: i.foodName,
                    quantityGrams: i.quantityGrams,
                    quantityDisplay: i.quantityDisplay,
                    calories: i.calories,
                    proteinG: i.proteinG,
                    carbsG: i.carbsG,
                    fatG: i.fatG,
                  })),
                })
              }

              await sendTextMessage(from, editResponse)
              saveHistory(supabase, user.id, text, editResponse)
              return
            }
          } catch {
            // Gatekeeper failed — fall through to normal classification
          }
          // Not a correction — clear state and continue to intent classification
          await clearState(user.id)
          break
        }
        case 'awaiting_confirmation': {
          if (context.contextData.flow === 'query') {
            const confirmResponse = await handleQueryConfirmation(supabase, user.id, text, context, {
              timezone: user.timezone,
              dailyCalorieTarget: user.dailyCalorieTarget,
            })
            await sendTextMessage(from, confirmResponse)
            saveHistory(supabase, user.id, text, confirmResponse)
            return
          }
          // Other confirmation flows — clear state and proceed to intent classification
          await clearState(user.id)
          break
        }
        case 'awaiting_clarification': {
          const mealResult = await handleMealLog(supabase, user.id, text, userSettings, context)
          await sendTextMessage(from, mealResult.response)
          saveHistory(supabase, user.id, text, mealResult.response)
          return
        }
        case 'awaiting_bulk_quantities': {
          const mealResult = await handleMealLog(supabase, user.id, text, userSettings, context)
          await sendTextMessage(from, mealResult.response)
          saveHistory(supabase, user.id, text, mealResult.response)
          return
        }
        case 'awaiting_correction': {
          const editResponse = await handleEdit(supabase, user.id, text, context, {
            timezone: user.timezone,
            dailyCalorieTarget: user.dailyCalorieTarget,
          })
          await sendTextMessage(from, editResponse)
          saveHistory(supabase, user.id, text, editResponse)
          return
        }
        case 'awaiting_correction_item':
        case 'awaiting_correction_value': {
          const editResponse = await handleEdit(supabase, user.id, text, context, {
            timezone: user.timezone,
            dailyCalorieTarget: user.dailyCalorieTarget,
          })
          await sendTextMessage(from, editResponse)
          saveHistory(supabase, user.id, text, editResponse)
          return
        }
        case 'awaiting_weight': {
          const weightResponse = await handleWeight(supabase, user.id, text, user)
          await sendTextMessage(from, weightResponse)
          saveHistory(supabase, user.id, text, weightResponse)
          return
        }
        case 'settings_menu':
        case 'settings_change':
        case 'awaiting_reset_confirmation': {
          const settingsData = await getUserWithSettings(supabase, user.id)
          const settingsResponse = await handleSettings(supabase, user.id, text, user, settingsData.settings, context)
          await sendTextMessage(from, settingsResponse)
          saveHistory(supabase, user.id, text, settingsResponse)
          return
        }
        case 'awaiting_label_portions': {
          await handleLabelPortions(supabase, from, user.id, text, context, {
            calorieMode: user.calorieMode,
            dailyCalorieTarget: user.dailyCalorieTarget,
            timezone: user.timezone,
          })
          saveMessage(supabase, user.id, 'user', text).catch(() => {})
          return
        }
      }
    }

    // 4. Classify intent
    let intent = classifyByRules(text)
    if (!intent) {
      try {
        console.log('[handler] Classifying intent via LLM...')
        const llm = getLLMProvider()
        intent = await llm.classifyIntent(text)
        console.log('[handler] Intent classified:', intent)
      } catch (err) {
        console.error('[handler] LLM classify failed:', err)
        // LLM failed — default to assuming it's a meal log
        intent = 'meal_log'
      }
    }

    // 5. Route to appropriate flow
    console.log('[handler] Routing to flow:', intent)
    let response: string
    switch (intent) {
      case 'meal_log': {
        console.log('[handler] Starting meal log...')
        const result = await handleMealLog(supabase, user.id, text, userSettings, null)
        console.log('[handler] Meal log done, completed:', result.completed)
        response = result.response
        break
      }
      case 'summary':
        response = await handleSummary(supabase, user.id, text, { dailyCalorieTarget: user.dailyCalorieTarget, timezone: user.timezone })
        break
      case 'query':
        response = await handleQuery(supabase, user.id, text)
        break
      case 'edit':
        response = await handleEdit(supabase, user.id, text, null, {
          timezone: user.timezone,
          dailyCalorieTarget: user.dailyCalorieTarget,
        })
        break
      case 'weight':
        response = await handleWeight(supabase, user.id, text, user)
        break
      case 'recalculate':
        response = await handleRecalculate(supabase, user.id)
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

    console.log('[handler] Sending response, length:', response.length)
    await sendTextMessage(from, response)
    console.log('[handler] Response sent successfully')
    saveHistory(supabase, user.id, text, response)
  } catch (err) {
    console.error('[handler] Error:', err)
    await sendTextMessage(from, formatError()).catch((sendErr) => {
      console.error('[handler] Failed to send error message (send error):', sendErr)
    })
  }
}

export async function handleIncomingAudio(
  from: string,
  messageId: string,
  audioId: string
): Promise<void> {
  const supabase = createServiceRoleClient()

  try {
    let buffer: Buffer
    try {
      buffer = await downloadAudioMedia(audioId)
    } catch (err) {
      if (err instanceof AudioTooLargeError || (err instanceof Error && err.name === 'AudioTooLargeError')) {
        await sendTextMessage(from, '🎤 Áudio muito longo! Manda um áudio de até 30 segundos 😊')
        return
      }
      throw err
    }

    let transcription: string
    let latencyMs: number
    try {
      const result = await transcribeAudio(buffer)
      transcription = result.text
      latencyMs = result.latencyMs
    } catch (err) {
      if (err instanceof Error && err.message.includes('OPENAI_API_KEY')) {
        await sendTextMessage(from, '🎤 Suporte a áudio não está disponível. Digita o que comeu?')
        return
      }
      throw err
    }

    // Log transcription API usage (fire-and-forget)
    logLLMUsage(supabase, {
      provider: 'openai',
      model: 'gpt-4o-mini-transcribe',
      functionType: 'audio_transcription',
      latencyMs,
      success: true,
    }).catch(() => {})

    if (!transcription.trim()) {
      await sendTextMessage(from, '🎤 Não consegui entender o áudio. Tenta mandar de novo ou digita o que comeu?')
      return
    }

    await sendTextMessage(from, `🎤 Entendi: *${transcription}*\n\n⏳ Registrando...`)
    await handleIncomingMessage(from, messageId, transcription)
  } catch (err) {
    console.error('[handler] Audio error:', err)
    await sendTextMessage(from, formatError()).catch((sendErr) => {
      console.error('[handler] Failed to send error message (send error):', sendErr)
    })
  }
}

export async function handleIncomingImage(
  from: string,
  messageId: string,
  imageId: string,
  caption?: string,
): Promise<void> {
  const supabase = createServiceRoleClient()

  try {
    let user = await findUserByPhone(supabase, from)
    if (!user) {
      user = await createUser(supabase, from)
    }

    if (!user.onboardingComplete) {
      await sendTextMessage(from, 'Primeiro preciso te conhecer! Me diz, qual o seu nome?')
      return
    }

    // Send immediate feedback while processing
    const processingPromise = sendTextMessage(from, '📸 Analisando sua foto... aguarda um instante!')

    let buffer: Buffer
    try {
      buffer = await downloadWhatsAppMedia(imageId, MAX_IMAGE_SIZE)
    } catch (err) {
      if (err instanceof MediaTooLargeError) {
        await sendTextMessage(from, '📸 Imagem muito grande! Tenta mandar uma foto menor (até 5MB) 😊')
        return
      }
      throw err
    }

    const mimeType = detectMimeType(buffer)
    const base64 = buffer.toString('base64')
    const dataUrl = `data:${mimeType};base64,${base64}`

    // Ensure processing message was sent before continuing
    await processingPromise

    const llm = getLLMProvider()

    const startTime = Date.now()
    const imageResult: ImageAnalysis = await llm.analyzeImage(dataUrl, caption)
    const latencyMs = Date.now() - startTime

    logLLMUsage(supabase, {
      provider: process.env.LLM_PROVIDER || 'openrouter',
      model: process.env.LLM_MODEL_VISION || 'openai/gpt-4o',
      functionType: 'vision',
      latencyMs,
      success: true,
    }).catch(() => {})

    const hasInvalidItems = imageResult.items.some((item) => !item.quantity_grams || item.quantity_grams <= 0)
    if (imageResult.needs_clarification || imageResult.items.length === 0 || hasInvalidItems) {
      const msg = imageResult.clarification_question ||
        'Não consegui identificar os alimentos nessa foto 😅 Pode descrever o que comeu?'
      await sendTextMessage(from, msg)
      saveHistory(supabase, user.id, caption || '[imagem de alimento]', msg)
      return
    }

    const mealAnalysis: MealAnalysis = {
      meal_type: imageResult.meal_type ?? 'snack',
      confidence: imageResult.confidence,
      references_previous: false,
      reference_query: null,
      items: imageResult.items.map((item) => ({
        ...item,
        portion_type: 'unit' as const,
        has_user_quantity: false,
      })),
      unknown_items: imageResult.unknown_items,
      needs_clarification: false,
    }

    if (imageResult.image_type === 'nutrition_label') {
      const item = mealAnalysis.items[0]
      const labelMsg = [
        '📋 Tabela nutricional detectada!',
        '',
        `• ${item.food} (porção ${item.quantity_grams ?? 0}g) — ${Math.round(item.calories ?? 0)} kcal`,
        `  P: ${item.protein ?? 0}g | C: ${item.carbs ?? 0}g | G: ${item.fat ?? 0}g`,
        '',
        'Quantas porções você comeu? Responda com o número para eu registrar.',
      ].join('\n')

      await setState(user.id, 'awaiting_label_portions', {
        mealAnalysis: mealAnalysis as unknown as Record<string, unknown>,
        originalMessage: caption || '[imagem]',
      })

      await sendTextMessage(from, labelMsg)
      saveHistory(supabase, user.id, caption || '[imagem de alimento]', labelMsg)
      return
    }

    const imageTotal = Math.round(mealAnalysis.items.reduce((sum, item) => sum + (item.calories ?? 0), 0))
    const originalMessage = caption || '[imagem]'

    // Save meal to database BEFORE showing confirmation
    const mealId = await createMeal(supabase, {
      userId: user.id,
      mealType: mealAnalysis.meal_type,
      totalCalories: imageTotal,
      originalMessage,
      llmResponse: mealAnalysis as unknown as Record<string, unknown>,
      items: mealAnalysis.items.map((item) => ({
        foodName: item.food,
        quantityGrams: item.quantity_grams ?? 0,
        calories: item.calories ?? 0,
        proteinG: item.protein ?? 0,
        carbsG: item.carbs ?? 0,
        fatG: item.fat ?? 0,
        source: 'manual' as const,
      })),
    })

    // Save recent_meal state for contextual corrections
    const mealWithItems = await getMealWithItems(supabase, mealId)
    if (mealWithItems && mealWithItems.items.length > 0) {
      await setState(user.id, 'recent_meal', {
        mealId,
        mealType: mealWithItems.mealType,
        items: mealWithItems.items.map(i => ({
          id: i.id,
          foodName: i.foodName,
          quantityGrams: i.quantityGrams,
          quantityDisplay: i.quantityDisplay,
          calories: i.calories,
          proteinG: i.proteinG,
          carbsG: i.carbsG,
          fatG: i.fatG,
        })),
      })
    }

    const dailyConsumed = await getDailyCalories(supabase, user.id, undefined, user.timezone)
    const target = user.dailyCalorieTarget ?? 2000

    const response = formatMealBreakdown(
      mealAnalysis.meal_type,
      mealAnalysis.items.map((item) => ({
        food: item.food,
        quantityGrams: item.quantity_grams ?? 0,
        calories: item.calories ?? 0,
      })),
      imageTotal,
      dailyConsumed,
      target,
    )

    await sendTextMessage(from, response)
    saveHistory(supabase, user.id, caption || '[imagem de alimento]', response)
  } catch (err) {
    console.error('[handler] Image error:', err)
    await sendTextMessage(from, formatError()).catch((sendErr) => {
      console.error('[handler] Failed to send error message (send error):', sendErr)
    })
  }
}

async function handleLabelPortions(
  supabase: SupabaseClient,
  from: string,
  userId: string,
  message: string,
  context: ConversationContext,
  user: { calorieMode: string; dailyCalorieTarget: number | null; timezone?: string },
): Promise<void> {
  const portions = parseFloat(message.trim().replace(',', '.'))

  if (isNaN(portions) || portions <= 0) {
    await sendTextMessage(from, 'Me manda um número de porções (ex: 1, 2, 0.5) 😊')
    return
  }

  const mealAnalysis = context.contextData.mealAnalysis as unknown as MealAnalysis

  const multipliedItems = mealAnalysis.items.map((item) => ({
    ...item,
    quantity_grams: Math.round((item.quantity_grams ?? 0) * portions * 10) / 10,
    calories: Math.round((item.calories ?? 0) * portions),
    protein: Math.round((item.protein ?? 0) * portions * 10) / 10,
    carbs: Math.round((item.carbs ?? 0) * portions * 10) / 10,
    fat: Math.round((item.fat ?? 0) * portions * 10) / 10,
  }))

  const multipliedAnalysis: MealAnalysis = {
    ...mealAnalysis,
    items: multipliedItems,
  }

  const total = Math.round(multipliedItems.reduce((sum, item) => sum + item.calories, 0))
  const originalMessage = (context.contextData.originalMessage as string) || '[imagem]'

  // Save meal to database BEFORE showing confirmation
  const labelMealId = await createMeal(supabase, {
    userId,
    mealType: multipliedAnalysis.meal_type,
    totalCalories: total,
    originalMessage,
    llmResponse: multipliedAnalysis as unknown as Record<string, unknown>,
    items: multipliedItems.map((item) => ({
      foodName: item.food,
      quantityGrams: item.quantity_grams,
      calories: item.calories,
      proteinG: item.protein ?? 0,
      carbsG: item.carbs ?? 0,
      fatG: item.fat ?? 0,
      source: 'manual' as const,
    })),
  })

  // Replace clearState with recent_meal state for contextual corrections
  const labelMealWithItems = await getMealWithItems(supabase, labelMealId)
  if (labelMealWithItems && labelMealWithItems.items.length > 0) {
    await setState(userId, 'recent_meal', {
      mealId: labelMealId,
      mealType: labelMealWithItems.mealType,
      items: labelMealWithItems.items.map(i => ({
        id: i.id,
        foodName: i.foodName,
        quantityGrams: i.quantityGrams,
        quantityDisplay: i.quantityDisplay,
        calories: i.calories,
        proteinG: i.proteinG,
        carbsG: i.carbsG,
        fatG: i.fatG,
      })),
    })
  } else {
    await clearState(userId)
  }

  const dailyConsumed = await getDailyCalories(supabase, userId, undefined, user.timezone)
  const target = user.dailyCalorieTarget ?? 2000

  const response = formatMealBreakdown(
    multipliedAnalysis.meal_type,
    multipliedItems.map((item) => ({
      food: item.food,
      quantityGrams: item.quantity_grams,
      calories: item.calories,
    })),
    total,
    dailyConsumed,
    target,
  )

  await sendTextMessage(from, response)
}
