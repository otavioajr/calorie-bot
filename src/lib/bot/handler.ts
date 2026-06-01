import { createServiceRoleClient } from '@/lib/db/supabase'
import { findUserByPhone, createUser, getUserWithSettings } from '@/lib/db/queries/users'
import { getState, setState, clearState, type ConversationContext } from '@/lib/bot/state'
import { classifyByRules, isCancelCommand } from '@/lib/bot/router'
import { handleOnboarding } from '@/lib/bot/flows/onboarding'
import { enrichItemsWithTaco, handleMealLog, logFoodToMeal, type EnrichedItem } from '@/lib/bot/flows/meal-log'
import { setRecentMealState, buildConsolidatedMealResponse } from '@/lib/bot/meal-response'
import { buildMacrosBlock } from '@/lib/bot/macros'
import { handleSummary } from '@/lib/bot/flows/summary'
import { handleQuery, handleQueryConfirmation, registerFromQuotedQuery } from '@/lib/bot/flows/query'
import { handleEdit } from '@/lib/bot/flows/edit'
import { handleWeight } from '@/lib/bot/flows/weight'
import { handleSettings } from '@/lib/bot/flows/settings'
import { handleHelp, handleUserData } from '@/lib/bot/flows/help'
import { handleRecalculate } from '@/lib/bot/flows/recalculate'
import { handleMealDetail } from '@/lib/bot/flows/meal-detail'
import {
  buildProductQuantityParseFailureMessage,
  buildProductQuantityPrompt,
  handleAwaitingLabelConfirm,
  handleAwaitingLabelInput,
  handleAwaitingOffBrand,
  handleAwaitingOffChoice,
  handleAwaitingOffConfirm,
  type ProductPendingMeal,
} from '@/lib/bot/flows/product-confirm'
import { getLLMProvider } from '@/lib/llm/index'
import { sendTextMessage } from '@/lib/whatsapp/client'
import { formatOutOfScope, formatError } from '@/lib/utils/formatters'
import { parseDateFromMessage, formatDateLabel, localDateString } from '@/lib/utils/relative-date'
import { downloadAudioMedia, transcribeAudio, AudioTooLargeError } from '@/lib/audio/transcribe'
import { downloadWhatsAppMedia, MediaTooLargeError } from '@/lib/whatsapp/media'
import { detectMimeType } from '@/lib/whatsapp/mime'
import { logLLMUsage } from '@/lib/db/queries/llm-usage'
import { getDailyMacros, getMealWithItems } from '@/lib/db/queries/meals'
import { saveMessage } from '@/lib/db/queries/message-history'
import { resolveQuote } from '@/lib/bot/quote'
import type { QuoteContext } from '@/lib/bot/quote'
import { saveBotMessage } from '@/lib/db/queries/bot-messages'
import { extractLabelGramsFromCaption, extractLabelPortionsFromCaption } from '@/lib/bot/label-portions'
import { scaleNutritionLabelItem } from '@/lib/bot/nutrition-label'
import { getUserLocalTime, resolveMealTypeFromContext, detectExplicitMealType } from '@/lib/utils/meal-time'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { ImageAnalysis } from '@/lib/llm/schemas/image-analysis'
import type { MealAnalysis, MealItem } from '@/lib/llm/schemas/meal-analysis'
import { buildContextualCorrectionPrompt } from '@/lib/llm/prompts/contextual-correction'
import type { RecentMealItem } from '@/lib/llm/prompts/contextual-correction'
import type { Product } from '@/lib/products/types'

const MAX_IMAGE_SIZE = 5_242_880 // 5MB

function saveHistory(supabase: SupabaseClient, userId: string, userMsg: string, botMsg: string): void {
  saveMessage(supabase, userId, 'user', userMsg).catch(() => {})
  saveMessage(supabase, userId, 'assistant', botMsg).catch(() => {})
}

async function saveBotMessages(
  supabase: SupabaseClient,
  userId: string,
  incomingMessageId: string,
  outgoingMessageId: string | null,
  resourceType: 'meal' | 'summary' | 'query' | 'weight' | null,
  resourceId: string | null,
  metadata?: Record<string, unknown> | null,
): Promise<void> {
  await saveBotMessage(supabase, {
    userId,
    messageId: incomingMessageId,
    direction: 'incoming',
    resourceType,
    resourceId,
    metadata: metadata ?? null,
  })

  if (outgoingMessageId) {
    await saveBotMessage(supabase, {
      userId,
      messageId: outgoingMessageId,
      direction: 'outgoing',
      resourceType,
      resourceId,
      metadata: metadata ?? null,
    })
  }
}

function productMacros(product: Product, quantityGrams: number) {
  const factor = quantityGrams / 100
  return {
    calories: Math.round(product.caloriesPer100g * factor),
    protein: Math.round(product.proteinPer100g * factor * 10) / 10,
    carbs: Math.round(product.carbsPer100g * factor * 10) / 10,
    fat: Math.round(product.fatPer100g * factor * 10) / 10,
  }
}

function confirmedProductItem(
  pendingMeal: ProductPendingMeal,
  product: Product,
  quantityGrams: number | null,
): EnrichedItem {
  const resolvedQuantity = quantityGrams ?? product.servingSizeG ?? 0
  const quantityDisplay = pendingMeal.quantityDisplay ?? product.servingDisplay ?? null
  const macros = productMacros(product, resolvedQuantity)

  return {
    food: product.name,
    quantityGrams: resolvedQuantity,
    quantityDisplay,
    calories: macros.calories,
    protein: macros.protein,
    carbs: macros.carbs,
    fat: macros.fat,
    source: 'product',
    productId: product.id,
  }
}

function parseProductQuantity(
  message: string,
  product: Product,
): { quantityGrams: number; quantityDisplay: string } | null {
  const trimmed = message.trim()
  const normalized = trimmed
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()

  const gramsMatch = normalized.match(/(\d+(?:[,.]\d+)?)\s*(?:g|grama|gramas)\b/)
  if (gramsMatch?.[1]) {
    const grams = Number.parseFloat(gramsMatch[1].replace(',', '.'))
    if (Number.isFinite(grams) && grams > 0) {
      return { quantityGrams: grams, quantityDisplay: trimmed }
    }
  }

  const servingAmountMatch = normalized.match(/(\d+(?:[,.]\d+)?)/)
  const servingUnitPattern = /\b(?:unidade|unidades|unid|pacote|pacotes|pacotinho|pacotinhos|porcao|porcoes|torrada|torradas|torradinha|torradinhas|fatia|fatias|barra|barras|barrinha|barrinhas|biscoito|biscoitos)\b/
  if (servingAmountMatch?.[1] && product.servingSizeG && servingUnitPattern.test(normalized)) {
    const amount = Number.parseFloat(servingAmountMatch[1].replace(',', '.'))
    if (Number.isFinite(amount) && amount > 0) {
      return {
        quantityGrams: Math.round(product.servingSizeG * amount * 10) / 10,
        quantityDisplay: trimmed,
      }
    }
  }

  return null
}

async function buildConfirmedProductMealItems(
  supabase: SupabaseClient,
  userId: string,
  pendingMeal: ProductPendingMeal,
  product: Product,
  quantityGrams: number | null,
): Promise<EnrichedItem[]> {
  const productItem = confirmedProductItem(pendingMeal, product, quantityGrams)
  const mealItems = pendingMeal.mealItems
  const productItemIndex = pendingMeal.productItemIndex

  if (!mealItems || typeof productItemIndex !== 'number') {
    return [productItem]
  }

  const remainingItems = mealItems
    .map((item, index) => ({ item: item as MealItem, index }))
    .filter(({ index }) => index !== productItemIndex)

  const enrichedRemaining = remainingItems.length > 0
    ? await enrichItemsWithTaco(supabase, remainingItems.map(({ item }) => item), getLLMProvider(), userId)
    : []

  const items: EnrichedItem[] = []
  let remainingIndex = 0
  for (let index = 0; index < mealItems.length; index += 1) {
    if (index === productItemIndex) {
      items.push(productItem)
    } else {
      items.push(enrichedRemaining[remainingIndex])
      remainingIndex += 1
    }
  }

  return items.filter(Boolean)
}

async function registerConfirmedProductMeal(
  supabase: SupabaseClient,
  userId: string,
  pendingMeal: ProductPendingMeal,
  product: Product,
  quantityGrams: number | null,
  user: {
    dailyCalorieTarget: number | null
    dailyProteinG?: number | null
    dailyFatG?: number | null
    dailyCarbsG?: number | null
    timezone?: string
  },
): Promise<{ response: string; mealId: string }> {
  const items = await buildConfirmedProductMealItems(supabase, userId, pendingMeal, product, quantityGrams)

  const { date: targetDate } = parseDateFromMessage(pendingMeal.originalMessage, user.timezone)
  const dateLabel = formatDateLabel(targetDate, user.timezone)

  const logResult = await logFoodToMeal(supabase, {
    userId,
    mealType: pendingMeal.mealType,
    items: items.map((item) => ({
      foodName: item.food,
      quantityGrams: item.quantityGrams,
      quantityDisplay: item.quantityDisplay ?? undefined,
      calories: item.calories,
      proteinG: item.protein,
      carbsG: item.carbs,
      fatG: item.fat,
      source: item.source,
      tacoId: item.tacoId,
      productId: item.productId,
      confidence: item.source === 'approximate' ? 'low' : 'high',
    })),
    originalMessage: pendingMeal.originalMessage,
    llmResponse: {
      product_id: product.id,
      source: 'product-confirm',
      original_food: pendingMeal.food,
      original_message: pendingMeal.originalMessage,
    },
    targetDate,
    timezone: user.timezone,
  })

  await setRecentMealState(userId, logResult.meal)

  const dailyMacros = await getDailyMacros(supabase, userId, targetDate, user.timezone)
  const { target, macros } = buildMacrosBlock(user, dailyMacros)
  const response = buildConsolidatedMealResponse(logResult, dailyMacros.calories, target, dateLabel, macros)

  return { response, mealId: logResult.mealId }
}

export async function handleIncomingMessage(
  from: string,
  messageId: string,
  text: string,
  quotedMessageId?: string,
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

    // Resolve quote context if message is a reply
    const quoteContext = await resolveQuote(quotedMessageId)

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
          const recentItems = context.contextData.items as unknown as RecentMealItem[]
          const recentMealId = context.contextData.mealId as string

          // If user quoted a meal message, skip gatekeeper and go directly to edit
          if (quoteContext?.resourceType === 'meal' && quoteContext.resourceId) {
            const editResponse = await handleEdit(supabase, user.id, text, null, {
              timezone: user.timezone,
              dailyCalorieTarget: user.dailyCalorieTarget,
              dailyProteinG: user.dailyProteinG,
              dailyFatG: user.dailyFatG,
              dailyCarbsG: user.dailyCarbsG,
            }, quoteContext)
            await clearState(user.id)
            const sentId = await sendTextMessage(from, editResponse, quotedMessageId)
            saveHistory(supabase, user.id, text, editResponse)
            await saveBotMessages(supabase, user.id, messageId, sentId, null, null)
            return
          }

          // LLM gatekeeper: is this a correction, confirmation, or something else?
          try {
            const llm = getLLMProvider()
            const gatekeeperRaw = await llm.chat(
              buildContextualCorrectionPrompt(recentItems, text),
              'Você classifica mensagens após registro de refeição. Responda APENAS com JSON válido.',
              true,
            )
            const gatekeeper = JSON.parse(gatekeeperRaw.trim()) as { type: string; corrected_message?: string }

            if (gatekeeper.type === 'correction' && gatekeeper.corrected_message) {
              const editResponse = await handleEdit(supabase, user.id, gatekeeper.corrected_message, null, {
                timezone: user.timezone,
                dailyCalorieTarget: user.dailyCalorieTarget,
                dailyProteinG: user.dailyProteinG,
                dailyFatG: user.dailyFatG,
                dailyCarbsG: user.dailyCarbsG,
              }, quoteContext ?? undefined)

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

              const corrSentId = await sendTextMessage(from, editResponse)
              saveHistory(supabase, user.id, text, editResponse)
              await saveBotMessages(supabase, user.id, messageId, corrSentId, 'meal', recentMealId)
              return
            }

            if (gatekeeper.type === 'confirmation') {
              await clearState(user.id)
              const confirmMsg = 'Tudo certo! ✅ Refeição registrada.'
              await sendTextMessage(from, confirmMsg)
              saveHistory(supabase, user.id, text, confirmMsg)
              return
            }
          } catch (err) {
            console.error('[handler] recent_meal gatekeeper failed:', err)
          }
          // "other" — clear state and continue to intent classification
          await clearState(user.id)
          break
        }
        case 'awaiting_confirmation': {
          if (context.contextData.flow === 'query') {
            const confirmResponse = await handleQueryConfirmation(supabase, user.id, text, context, {
              timezone: user.timezone,
              dailyCalorieTarget: user.dailyCalorieTarget,
              dailyProteinG: user.dailyProteinG,
              dailyFatG: user.dailyFatG,
              dailyCarbsG: user.dailyCarbsG,
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
          const clarSentId = await sendTextMessage(from, mealResult.response)
          saveHistory(supabase, user.id, text, mealResult.response)
          await saveBotMessages(supabase, user.id, messageId, clarSentId,
            mealResult.completed && mealResult.mealId ? 'meal' : null,
            mealResult.mealId ?? null)
          return
        }
        case 'awaiting_bulk_quantities': {
          const mealResult = await handleMealLog(supabase, user.id, text, userSettings, context)
          const bulkSentId = await sendTextMessage(from, mealResult.response)
          saveHistory(supabase, user.id, text, mealResult.response)
          await saveBotMessages(supabase, user.id, messageId, bulkSentId,
            mealResult.completed && mealResult.mealId ? 'meal' : null,
            mealResult.mealId ?? null)
          return
        }
        case 'awaiting_meal_type': {
          const mealResult = await handleMealLog(supabase, user.id, text, userSettings, context)
          const mtSentId = await sendTextMessage(from, mealResult.response)
          saveHistory(supabase, user.id, text, mealResult.response)
          await saveBotMessages(supabase, user.id, messageId, mtSentId,
            mealResult.completed && mealResult.mealId ? 'meal' : null,
            mealResult.mealId ?? null)
          return
        }
        case 'awaiting_correction': {
          const editResponse = await handleEdit(supabase, user.id, text, context, {
            timezone: user.timezone,
            dailyCalorieTarget: user.dailyCalorieTarget,
            dailyProteinG: user.dailyProteinG,
            dailyFatG: user.dailyFatG,
            dailyCarbsG: user.dailyCarbsG,
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
            dailyProteinG: user.dailyProteinG,
            dailyFatG: user.dailyFatG,
            dailyCarbsG: user.dailyCarbsG,
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
          await handleLabelPortions(supabase, from, user.id, messageId, text, context, {
            calorieMode: user.calorieMode,
            dailyCalorieTarget: user.dailyCalorieTarget,
            dailyProteinG: user.dailyProteinG,
            dailyFatG: user.dailyFatG,
            dailyCarbsG: user.dailyCarbsG,
            timezone: user.timezone,
          })
          saveMessage(supabase, user.id, 'user', text).catch(() => {})
          return
        }
        case 'awaiting_product_quantity': {
          const product = context.contextData.product as Product | undefined
          const pendingMeal = context.contextData.pendingMeal as ProductPendingMeal | undefined

          if (!product || !pendingMeal) {
            const response = 'Não consegui recuperar o produto. Pode mandar o alimento e a quantidade de novo?'
            const sentId = await sendTextMessage(from, response)
            saveHistory(supabase, user.id, text, response)
            await saveBotMessages(supabase, user.id, messageId, sentId, null, null)
            return
          }

          const parsedQuantity = parseProductQuantity(text, product)
          if (!parsedQuantity) {
            const response = buildProductQuantityParseFailureMessage(text.trim(), product.servingSizeG)
            const sentId = await sendTextMessage(from, response)
            saveHistory(supabase, user.id, text, response)
            await saveBotMessages(supabase, user.id, messageId, sentId, null, null)
            return
          }

          const registered = await registerConfirmedProductMeal(
            supabase,
            user.id,
            { ...pendingMeal, quantityDisplay: parsedQuantity.quantityDisplay },
            product,
            parsedQuantity.quantityGrams,
            {
              dailyCalorieTarget: user.dailyCalorieTarget,
              dailyProteinG: user.dailyProteinG,
              dailyFatG: user.dailyFatG,
              dailyCarbsG: user.dailyCarbsG,
              timezone: user.timezone,
            },
          )
          const sentId = await sendTextMessage(from, registered.response)
          saveHistory(supabase, user.id, text, registered.response)
          await saveBotMessages(supabase, user.id, messageId, sentId, 'meal', registered.mealId)
          return
        }
        case 'awaiting_off_choice': {
          const productResult = await handleAwaitingOffChoice(user.id, text, context)
          const sentId = await sendTextMessage(from, productResult.response)
          saveHistory(supabase, user.id, text, productResult.response)
          await saveBotMessages(supabase, user.id, messageId, sentId, null, null)
          return
        }
        case 'awaiting_off_brand': {
          const productResult = await handleAwaitingOffBrand(user.id, text, context)
          const sentId = await sendTextMessage(from, productResult.response)
          saveHistory(supabase, user.id, text, productResult.response)
          await saveBotMessages(supabase, user.id, messageId, sentId, null, null)
          return
        }
        case 'awaiting_off_confirm':
        case 'awaiting_label_confirm': {
          const productResult = context.contextType === 'awaiting_off_confirm'
            ? await handleAwaitingOffConfirm(supabase, user.id, text, context)
            : await handleAwaitingLabelConfirm(supabase, user.id, text, context)

          const pendingMeal = context.contextData.pendingMeal as ProductPendingMeal | undefined
          const quantityGrams = typeof context.contextData.quantityGrams === 'number'
            ? context.contextData.quantityGrams
            : null

          if (productResult.completed && productResult.product && pendingMeal) {
            if (quantityGrams === null) {
              const response = buildProductQuantityPrompt(
                productResult.product.name,
                productResult.product.servingDisplay,
                productResult.product.servingSizeG,
              )
              await setState(user.id, 'awaiting_product_quantity', {
                product: productResult.product,
                pendingMeal,
              })
              const sentId = await sendTextMessage(from, response)
              saveHistory(supabase, user.id, text, response)
              await saveBotMessages(supabase, user.id, messageId, sentId, null, null)
              return
            }

            const registered = await registerConfirmedProductMeal(
              supabase,
              user.id,
              pendingMeal,
              productResult.product,
              quantityGrams,
              {
                dailyCalorieTarget: user.dailyCalorieTarget,
                dailyProteinG: user.dailyProteinG,
                dailyFatG: user.dailyFatG,
                dailyCarbsG: user.dailyCarbsG,
                timezone: user.timezone,
              },
            )
            const sentId = await sendTextMessage(from, registered.response)
            saveHistory(supabase, user.id, text, registered.response)
            await saveBotMessages(supabase, user.id, messageId, sentId, 'meal', registered.mealId)
            return
          }

          const sentId = await sendTextMessage(from, productResult.response)
          saveHistory(supabase, user.id, text, productResult.response)
          await saveBotMessages(supabase, user.id, messageId, sentId, null, null)
          return
        }
        case 'awaiting_label_input': {
          const productResult = await handleAwaitingLabelInput(user.id, text, context)
          const sentId = await sendTextMessage(from, productResult.response)
          saveHistory(supabase, user.id, text, productResult.response)
          await saveBotMessages(supabase, user.id, messageId, sentId, null, null)
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

    // Quote with meal resource → always route to edit flow (correction context)
    if (quoteContext?.resourceType === 'meal' && quoteContext.resourceId) {
      const editResponse = await handleEdit(supabase, user.id, text, null, {
        timezone: user.timezone,
        dailyCalorieTarget: user.dailyCalorieTarget,
        dailyProteinG: user.dailyProteinG,
        dailyFatG: user.dailyFatG,
        dailyCarbsG: user.dailyCarbsG,
      }, quoteContext)
      const sentId = await sendTextMessage(from, editResponse, quotedMessageId)
      saveHistory(supabase, user.id, text, editResponse)
      await saveBotMessages(supabase, user.id, messageId, sentId, null, null)
      return
    }

    // Quote exists but no meal resource — route edit intents to edit flow with quote
    if (quoteContext && (intent === 'edit' || intent === 'meal_log')) {
      const editResponse = await handleEdit(supabase, user.id, text, null, {
        timezone: user.timezone,
        dailyCalorieTarget: user.dailyCalorieTarget,
        dailyProteinG: user.dailyProteinG,
        dailyFatG: user.dailyFatG,
        dailyCarbsG: user.dailyCarbsG,
      }, quoteContext)
      const sentId = await sendTextMessage(from, editResponse, quotedMessageId)
      saveHistory(supabase, user.id, text, editResponse)
      await saveBotMessages(supabase, user.id, messageId, sentId, null, null)
      return
    }

    // Quote fallback: if quote has no applicable flow
    const QUOTE_SUPPORTED_INTENTS = new Set(['edit', 'meal_log', 'summary', 'meal_detail', 'query'])
    if (quoteContext && intent && !QUOTE_SUPPORTED_INTENTS.has(intent)) {
      const fallbackMsg = 'Ainda não consigo fazer isso com mensagens citadas 😅 Mas posso te ajudar com outra coisa! Digite *menu* para ver as opções.'
      await clearState(user.id)
      await sendTextMessage(from, fallbackMsg)
      saveHistory(supabase, user.id, text, fallbackMsg)
      return
    }

    // 5. Route to appropriate flow
    console.log('[handler] Routing to flow:', intent)
    let response: string
    switch (intent) {
      case 'meal_log': {
        // If user quoted a query and wants to register it
        if (quoteContext?.resourceType === 'query' && quoteContext.metadata) {
          const registerResponse = await registerFromQuotedQuery(supabase, user.id, quoteContext, {
            timezone: user.timezone,
            dailyCalorieTarget: user.dailyCalorieTarget,
            dailyProteinG: user.dailyProteinG,
            dailyFatG: user.dailyFatG,
            dailyCarbsG: user.dailyCarbsG,
          })
          const sentId = await sendTextMessage(from, registerResponse, quotedMessageId)
          saveHistory(supabase, user.id, text, registerResponse)
          await saveBotMessages(supabase, user.id, messageId, sentId, 'meal', null)
          return
        }
        console.log('[handler] Starting meal log...')
        const result = await handleMealLog(supabase, user.id, text, userSettings, null)
        console.log('[handler] Meal log done, completed:', result.completed)
        if (result.completed && result.mealId) {
          const sentId = await sendTextMessage(from, result.response, quoteContext ? quotedMessageId : undefined)
          saveHistory(supabase, user.id, text, result.response)
          await saveBotMessages(supabase, user.id, messageId, sentId, 'meal', result.mealId)
          return
        }
        response = result.response
        break
      }
      case 'summary':
        // If user quoted a summary, treat as meal_detail request
        if (quoteContext?.resourceType === 'summary') {
          response = await handleMealDetail(supabase, user.id, text, {
            timezone: user.timezone,
          })
          break
        }
        response = await handleSummary(supabase, user.id, text, {
          dailyCalorieTarget: user.dailyCalorieTarget,
          dailyProteinG: user.dailyProteinG,
          dailyFatG: user.dailyFatG,
          dailyCarbsG: user.dailyCarbsG,
          timezone: user.timezone,
        })
        break
      case 'meal_detail':
        response = await handleMealDetail(supabase, user.id, text, {
          timezone: user.timezone,
        })
        break
      case 'query': {
        response = await handleQuery(supabase, user.id, text)
        // Query data is in the awaiting_confirmation state — capture for bot_messages
        const queryState = await getState(user.id)
        const queryMetadata = queryState?.contextType === 'awaiting_confirmation'
          ? (queryState.contextData as Record<string, unknown>)
          : null
        const sentId = await sendTextMessage(from, response, quoteContext ? quotedMessageId : undefined)
        saveHistory(supabase, user.id, text, response)
        await saveBotMessages(supabase, user.id, messageId, sentId, 'query', null, queryMetadata)
        return
      }
      case 'edit':
        response = await handleEdit(supabase, user.id, text, null, {
          timezone: user.timezone,
          dailyCalorieTarget: user.dailyCalorieTarget,
          dailyProteinG: user.dailyProteinG,
          dailyFatG: user.dailyFatG,
          dailyCarbsG: user.dailyCarbsG,
        }, quoteContext ?? undefined)
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
    const sentMessageId = await sendTextMessage(from, response, quoteContext ? quotedMessageId : undefined)
    console.log('[handler] Response sent successfully')
    saveHistory(supabase, user.id, text, response)
    await saveBotMessages(supabase, user.id, messageId, sentMessageId, null, null)
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
  audioId: string,
  quotedMessageId?: string,
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
    await handleIncomingMessage(from, messageId, transcription, quotedMessageId)
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
  quotedMessageId?: string,
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

    const currentTime = getUserLocalTime(user.timezone)

    const startTime = Date.now()
    const imageResult: ImageAnalysis = await llm.analyzeImage(dataUrl, caption, currentTime)
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

    const resolvedMealType = resolveMealTypeFromContext({ caption, currentTime })

    const mealAnalysis: MealAnalysis = {
      meal_type: resolvedMealType,
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

    const labelPortionsFromCaption = extractLabelPortionsFromCaption(caption)

    if (imageResult.image_type === 'nutrition_label') {
      const previewItem = scaleNutritionLabelItem(mealAnalysis.items[0])

      const servingGrams = mealAnalysis.items[0]?.quantity_grams ?? 0
      const labelGramsFromCaption = extractLabelGramsFromCaption(caption)
      const portionsFromGrams =
        labelGramsFromCaption !== null && servingGrams > 0
          ? labelGramsFromCaption / servingGrams
          : null
      const resolvedPortions = labelPortionsFromCaption ?? portionsFromGrams

      if (resolvedPortions !== null) {
        await handleLabelPortions(
          supabase,
          from,
          user.id,
          messageId,
          String(resolvedPortions),
          {
            contextData: {
              mealAnalysis: mealAnalysis as unknown as Record<string, unknown>,
              originalMessage: caption || '[imagem]',
            },
          },
          {
            calorieMode: user.calorieMode,
            dailyCalorieTarget: user.dailyCalorieTarget,
            dailyProteinG: user.dailyProteinG,
            dailyFatG: user.dailyFatG,
            dailyCarbsG: user.dailyCarbsG,
            timezone: user.timezone,
          },
        )
        return
      }

      const item = mealAnalysis.items[0]
  const labelMsg = [
        '📋 Tabela nutricional detectada!',
        '',
        `• ${item.food} (porção ${previewItem.quantity_grams ?? 0}g) — ${previewItem.calories ?? 0} kcal`,
        `  P: ${previewItem.protein ?? 0}g | G: ${previewItem.fat ?? 0}g | C: ${previewItem.carbs ?? 0}g`,
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

    const originalMessage = caption || '[imagem]'
    const { date: targetDate } = parseDateFromMessage(originalMessage, user.timezone)
    const dateLabel = formatDateLabel(targetDate, user.timezone)

    // Backdated photo without an explicit meal type → ask which meal before logging.
    // Time-of-day classification reflects NOW, not the backdated day, so it would misfile.
    const backdated = localDateString(targetDate, user.timezone) !== localDateString(new Date(), user.timezone)
    if (backdated && !detectExplicitMealType(originalMessage)) {
      await setState(user.id, 'awaiting_meal_type', {
        items: mealAnalysis.items.map((item) => ({
          foodName: item.food,
          quantityGrams: item.quantity_grams ?? 0,
          calories: item.calories ?? 0,
          proteinG: item.protein ?? 0,
          carbsG: item.carbs ?? 0,
          fatG: item.fat ?? 0,
          source: 'manual' as const,
        })) as unknown as Record<string, unknown>,
        targetDateISO: targetDate.toISOString(),
        originalMessage,
      })
      const askMsg = 'Essa foto é de outro dia. Em qual refeição? (café da manhã, almoço, lanche, jantar ou ceia)'
      const askSentId = await sendTextMessage(from, askMsg)
      saveHistory(supabase, user.id, caption || '[imagem de alimento]', askMsg)
      await saveBotMessages(supabase, user.id, messageId, askSentId, null, null)
      return
    }

    const logResult = await logFoodToMeal(supabase, {
      userId: user.id,
      mealType: mealAnalysis.meal_type,
      items: mealAnalysis.items.map((item) => ({
        foodName: item.food,
        quantityGrams: item.quantity_grams ?? 0,
        calories: item.calories ?? 0,
        proteinG: item.protein ?? 0,
        carbsG: item.carbs ?? 0,
        fatG: item.fat ?? 0,
        source: 'manual' as const,
      })),
      originalMessage,
      llmResponse: mealAnalysis as unknown as Record<string, unknown>,
      targetDate,
      timezone: user.timezone,
    })

    // Keep recent_meal state pointing at the consolidated meal (for corrections)
    await setRecentMealState(user.id, logResult.meal)

    const dailyMacros = await getDailyMacros(supabase, user.id, targetDate, user.timezone)
    const { target, macros } = buildMacrosBlock(user, dailyMacros)
    const response = buildConsolidatedMealResponse(logResult, dailyMacros.calories, target, dateLabel, macros)

    const imgSentId = await sendTextMessage(from, response)
    saveHistory(supabase, user.id, caption || '[imagem de alimento]', response)
    await saveBotMessages(supabase, user.id, messageId, imgSentId, 'meal', logResult.mealId)
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
  incomingMessageId: string,
  message: string,
  context: Pick<ConversationContext, 'contextData'>,
  user: {
    calorieMode: string
    dailyCalorieTarget: number | null
    dailyProteinG?: number | null
    dailyFatG?: number | null
    dailyCarbsG?: number | null
    timezone?: string
  },
): Promise<void> {
  const portions = parseFloat(message.trim().replace(',', '.'))

  if (isNaN(portions) || portions <= 0) {
    await sendTextMessage(from, 'Me manda um número de porções (ex: 1, 2, 0.5) 😊')
    return
  }

  const mealAnalysis = context.contextData.mealAnalysis as unknown as MealAnalysis

  const multipliedItems = mealAnalysis.items.map((item) => scaleNutritionLabelItem(item, portions))

  const multipliedAnalysis: MealAnalysis = {
    ...mealAnalysis,
    items: multipliedItems,
  }

  const originalMessage = (context.contextData.originalMessage as string) || '[imagem]'
  const { date: targetDate } = parseDateFromMessage(originalMessage, user.timezone)
  const dateLabel = formatDateLabel(targetDate, user.timezone)

  // Backdated label photo without an explicit meal type → ask which meal before logging.
  const backdated = localDateString(targetDate, user.timezone) !== localDateString(new Date(), user.timezone)
  if (backdated && !detectExplicitMealType(originalMessage)) {
    await setState(userId, 'awaiting_meal_type', {
      items: multipliedItems.map((item) => ({
        foodName: item.food,
        quantityGrams: item.quantity_grams ?? 0,
        calories: item.calories ?? 0,
        proteinG: item.protein ?? 0,
        carbsG: item.carbs ?? 0,
        fatG: item.fat ?? 0,
        source: 'manual' as const,
      })) as unknown as Record<string, unknown>,
      targetDateISO: targetDate.toISOString(),
      originalMessage,
    })
    const askMsg = 'Essa foto é de outro dia. Em qual refeição? (café da manhã, almoço, lanche, jantar ou ceia)'
    const askSentId = await sendTextMessage(from, askMsg)
    await saveBotMessages(supabase, userId, incomingMessageId, askSentId, null, null)
    return
  }

  const logResult = await logFoodToMeal(supabase, {
    userId,
    mealType: multipliedAnalysis.meal_type,
    items: multipliedItems.map((item) => ({
      foodName: item.food,
      quantityGrams: item.quantity_grams ?? 0,
      calories: item.calories ?? 0,
      proteinG: item.protein ?? 0,
      carbsG: item.carbs ?? 0,
      fatG: item.fat ?? 0,
      source: 'manual' as const,
    })),
    originalMessage,
    llmResponse: multipliedAnalysis as unknown as Record<string, unknown>,
    targetDate,
    timezone: user.timezone,
  })

  await setRecentMealState(userId, logResult.meal)

  const dailyMacros = await getDailyMacros(supabase, userId, targetDate, user.timezone)
  const { target, macros } = buildMacrosBlock(user, dailyMacros)
  const response = buildConsolidatedMealResponse(logResult, dailyMacros.calories, target, dateLabel, macros)

  const labelSentId = await sendTextMessage(from, response)
  await saveBotMessages(supabase, userId, incomingMessageId, labelSentId, 'meal', logResult.mealId)
}
