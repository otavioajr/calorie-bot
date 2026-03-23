import { createServiceRoleClient } from '@/lib/db/supabase'
import { findUserByPhone, createUser, getUserWithSettings } from '@/lib/db/queries/users'
import { getState, setState, type ConversationContext } from '@/lib/bot/state'
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
import { formatOutOfScope, formatError, formatMealBreakdown } from '@/lib/utils/formatters'
import { downloadAudioMedia, transcribeAudio, AudioTooLargeError } from '@/lib/audio/transcribe'
import { downloadWhatsAppMedia, MediaTooLargeError } from '@/lib/whatsapp/media'
import { detectMimeType } from '@/lib/whatsapp/mime'
import { logLLMUsage } from '@/lib/db/queries/llm-usage'
import { getDailyCalories } from '@/lib/db/queries/meals'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { ImageAnalysis } from '@/lib/llm/schemas/image-analysis'
import type { MealAnalysis } from '@/lib/llm/schemas/meal-analysis'

const MAX_IMAGE_SIZE = 5_242_880 // 5MB

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
        case 'awaiting_label_portions': {
          await handleLabelPortions(supabase, from, user.id, text, context, {
            calorieMode: user.calorieMode,
            dailyCalorieTarget: user.dailyCalorieTarget,
          })
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

    // Log Whisper API usage (fire-and-forget)
    logLLMUsage(supabase, {
      provider: 'openai',
      model: 'whisper-1',
      functionType: 'audio_transcription',
      latencyMs,
      success: true,
    }).catch(() => {})

    if (!transcription.trim()) {
      await sendTextMessage(from, '🎤 Não consegui entender o áudio. Tenta mandar de novo ou digita o que comeu?')
      return
    }

    await sendTextMessage(from, `🎤 Entendi: *${transcription}*`)
    await handleIncomingMessage(from, messageId, transcription)
  } catch (err) {
    console.error('[handler] Audio error:', err)
    await sendTextMessage(from, formatError()).catch(() => {})
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

    const llm = getLLMProvider()
    const calorieMode = user.calorieMode as Parameters<typeof llm.analyzeMeal>[1]

    const startTime = Date.now()
    const imageResult: ImageAnalysis = await llm.analyzeImage(dataUrl, caption, calorieMode)
    const latencyMs = Date.now() - startTime

    logLLMUsage(supabase, {
      provider: process.env.LLM_PROVIDER || 'openrouter',
      model: process.env.LLM_MODEL_VISION || 'openai/gpt-4o',
      functionType: 'vision',
      latencyMs,
      success: true,
    }).catch(() => {})

    if (imageResult.needs_clarification || imageResult.items.length === 0) {
      const msg = imageResult.clarification_question ||
        'Não consegui identificar os alimentos nessa foto 😅 Pode descrever o que comeu?'
      await sendTextMessage(from, msg)
      return
    }

    const mealAnalysis: MealAnalysis = {
      meal_type: imageResult.meal_type ?? 'snack',
      confidence: imageResult.confidence,
      items: imageResult.items,
      unknown_items: imageResult.unknown_items,
      needs_clarification: false,
    }

    if (imageResult.image_type === 'nutrition_label') {
      const item = mealAnalysis.items[0]
      const labelMsg = [
        '📋 Tabela nutricional detectada!',
        '',
        `• ${item.food} (porção ${item.quantity_grams}g) — ${Math.round(item.calories)} kcal`,
        `  P: ${item.protein}g | C: ${item.carbs}g | G: ${item.fat}g`,
        '',
        'Quantas porções você comeu? Responda com o número para eu registrar.',
      ].join('\n')

      await setState(user.id, 'awaiting_label_portions', {
        mealAnalysis: mealAnalysis as unknown as Record<string, unknown>,
        originalMessage: caption || '[imagem]',
      })

      await sendTextMessage(from, labelMsg)
      return
    }

    const dailyConsumed = await getDailyCalories(supabase, user.id)
    const target = user.dailyCalorieTarget ?? 2000

    const response = formatMealBreakdown(
      mealAnalysis.meal_type,
      mealAnalysis.items.map((item) => ({
        food: item.food,
        quantityGrams: item.quantity_grams,
        calories: item.calories,
      })),
      Math.round(mealAnalysis.items.reduce((sum, item) => sum + item.calories, 0)),
      dailyConsumed,
      target,
    )

    await setState(user.id, 'awaiting_confirmation', {
      mealAnalysis: mealAnalysis as unknown as Record<string, unknown>,
      originalMessage: caption || '[imagem]',
    })

    await sendTextMessage(from, response)
  } catch (err) {
    console.error('[handler] Image error:', err)
    await sendTextMessage(from, formatError()).catch(() => {})
  }
}

async function handleLabelPortions(
  supabase: SupabaseClient,
  from: string,
  userId: string,
  message: string,
  context: ConversationContext,
  user: { calorieMode: string; dailyCalorieTarget: number | null },
): Promise<void> {
  const portions = parseFloat(message.trim().replace(',', '.'))

  if (isNaN(portions) || portions <= 0) {
    await sendTextMessage(from, 'Me manda um número de porções (ex: 1, 2, 0.5) 😊')
    return
  }

  const mealAnalysis = context.contextData.mealAnalysis as unknown as MealAnalysis

  const multipliedItems = mealAnalysis.items.map((item) => ({
    ...item,
    quantity_grams: Math.round(item.quantity_grams * portions),
    calories: Math.round(item.calories * portions),
    protein: Math.round(item.protein * portions * 10) / 10,
    carbs: Math.round(item.carbs * portions * 10) / 10,
    fat: Math.round(item.fat * portions * 10) / 10,
  }))

  const multipliedAnalysis: MealAnalysis = {
    ...mealAnalysis,
    items: multipliedItems,
  }

  const dailyConsumed = await getDailyCalories(supabase, userId)
  const target = user.dailyCalorieTarget ?? 2000
  const total = Math.round(multipliedItems.reduce((sum, item) => sum + item.calories, 0))

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

  await setState(userId, 'awaiting_confirmation', {
    mealAnalysis: multipliedAnalysis as unknown as Record<string, unknown>,
    originalMessage: context.contextData.originalMessage || '[imagem]',
  })

  await sendTextMessage(from, response)
}
