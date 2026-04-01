import type { SupabaseClient } from '@supabase/supabase-js'
import type { ConversationContext } from '@/lib/bot/state'
import { setState, clearState } from '@/lib/bot/state'
import type { QuoteContext } from '@/lib/bot/quote'
import {
  deleteMeal,
  getLastMeal,
  getRecentMeals,
  getMealWithItems,
  updateMealItem,
  removeMealItem,
  recalculateMealTotal,
  getDailyCalories,
} from '@/lib/db/queries/meals'
import type { RecentMeal, MealItemDetail } from '@/lib/db/queries/meals'
import { getLLMProvider } from '@/lib/llm/index'
import { buildCorrectionPrompt } from '@/lib/llm/prompts/correction'
import { CorrectionSchema } from '@/lib/llm/schemas/correction'
import type { Correction } from '@/lib/llm/schemas/correction'
import { formatProgress } from '@/lib/utils/formatters'

// ---------------------------------------------------------------------------
// Patterns
// ---------------------------------------------------------------------------

const DELETE_PATTERN = /apaga(r)?\s*(último|ultimo|last)?/i
const CORRECTION_PATTERN = /^corrigir$/i
const CONFIRM_PATTERN = /^(sim|s|ok|confirma)$/i
const REJECT_PATTERN = /^(não|nao|n|cancelar|cancela)$/i

// Quote-based correction patterns
const QUOTE_DELETE_NO_ITEM = /^(apaga|remove|exclui|deleta)r?$/i
const QUOTE_DELETE_ITEM = /(?:apaga|remove|exclui|deleta)r?\s+(?:o\s+|a\s+)?(.+)/i
const QUOTE_RENAME = /(?:era|na verdade era|na real era|na real é|é|eh)\s+(.+?)(?:\s*,?\s*(?:não|nao|e não|e nao)\s+(.+))?$/i
const QUOTE_QUANTITY = /(?:era|eram|foi|na verdade)\s+(\d+(?:[.,]\d+)?)\s*(?:g|gramas?|ml)?\s*(?:de\s+(.+))?$/i

// ---------------------------------------------------------------------------
// Meal type display labels
// ---------------------------------------------------------------------------

const MEAL_TYPE_LABELS: Record<string, string> = {
  breakfast: 'Café da manhã',
  lunch: 'Almoço',
  snack: 'Lanche',
  dinner: 'Jantar',
  supper: 'Ceia',
}

function mealLabel(mealType: string): string {
  return MEAL_TYPE_LABELS[mealType] ?? mealType
}

// ---------------------------------------------------------------------------
// handleEdit (main entry)
// ---------------------------------------------------------------------------

export async function handleEdit(
  supabase: SupabaseClient,
  userId: string,
  message: string,
  context: ConversationContext | null,
  user?: { timezone?: string; dailyCalorieTarget?: number | null },
  quoteContext?: QuoteContext,
): Promise<string> {
  const trimmed = message.trim()

  // If we have a quote, handle it directly
  if (quoteContext) {
    return handleQuotedEdit(supabase, userId, trimmed, quoteContext, user)
  }

  if (context) {
    switch (context.contextType) {
      case 'awaiting_correction':
        return handleAwaitingCorrection(supabase, userId, trimmed, context, user)
      case 'awaiting_correction_item':
        return handleAwaitingCorrectionItem(supabase, userId, trimmed, context, user)
      case 'awaiting_correction_value':
        return handleAwaitingCorrectionValue(supabase, userId, trimmed, context, user)
    }
  }

  if (DELETE_PATTERN.test(trimmed)) {
    return initiateDeleteLastMeal(supabase, userId)
  }

  if (CORRECTION_PATTERN.test(trimmed)) {
    return showRecentMealsForCorrection(supabase, userId)
  }

  return handleNaturalLanguageCorrection(supabase, userId, trimmed, user)
}

// ---------------------------------------------------------------------------
// Guided correction flow
// ---------------------------------------------------------------------------

async function handleAwaitingCorrection(
  supabase: SupabaseClient,
  userId: string,
  message: string,
  context: ConversationContext,
  user?: { timezone?: string; dailyCalorieTarget?: number | null },
): Promise<string> {
  const action = context.contextData.action as string

  if (action === 'delete_confirm') {
    if (CONFIRM_PATTERN.test(message)) {
      return confirmDeleteMeal(supabase, userId, context)
    }
    if (REJECT_PATTERN.test(message)) {
      await clearState(userId)
      return 'Ok, mantive a refeição. Pode me mandar o que quer corrigir!'
    }
  }

  if (action === 'select_meal') {
    return handleMealSelection(supabase, userId, message, context)
  }

  await clearState(userId)
  return showRecentMealsForCorrection(supabase, userId)
}

async function handleMealSelection(
  supabase: SupabaseClient,
  userId: string,
  message: string,
  context: ConversationContext,
): Promise<string> {
  const meals = context.contextData.meals as unknown as RecentMeal[]
  const choice = parseInt(message, 10)

  if (isNaN(choice) || choice < 1 || choice > meals.length) {
    return `Opção inválida. Digite um número de 1 a ${meals.length}.`
  }

  const selected = meals[choice - 1]
  const mealWithItems = await getMealWithItems(supabase, selected.id)

  if (!mealWithItems || mealWithItems.items.length === 0) {
    await setState(userId, 'awaiting_correction', {
      action: 'delete_confirm',
      mealId: selected.id,
      mealType: selected.mealType,
      totalCalories: selected.totalCalories,
    })
    return `Quer apagar: ${mealLabel(selected.mealType)} (${selected.totalCalories} kcal)? (sim/não)`
  }

  const itemLines = mealWithItems.items.map((item, idx) => {
    const display = item.quantityDisplay || `${item.quantityGrams}g`
    return `${idx + 1}️⃣ ${item.foodName} (${display}) — ${item.calories} kcal`
  })

  await setState(userId, 'awaiting_correction_item', {
    mealId: selected.id,
    mealType: selected.mealType,
    items: mealWithItems.items as unknown as Record<string, unknown>[],
  })

  return [
    `${mealLabel(selected.mealType)}:`,
    ...itemLines,
    '',
    'Qual item? (número ou descreve a correção)',
  ].join('\n')
}

async function handleAwaitingCorrectionItem(
  supabase: SupabaseClient,
  userId: string,
  message: string,
  context: ConversationContext,
  user?: { timezone?: string; dailyCalorieTarget?: number | null },
): Promise<string> {
  const mealId = context.contextData.mealId as string
  const items = context.contextData.items as unknown as Array<{
    id: string
    foodName: string
    quantityGrams: number
    quantityDisplay: string | null
    calories: number
  }>

  const choice = parseInt(message, 10)

  if (!isNaN(choice) && choice >= 1 && choice <= items.length) {
    const selectedItem = items[choice - 1]

    await setState(userId, 'awaiting_correction_value', {
      mealId,
      itemId: selectedItem.id,
      foodName: selectedItem.foodName,
      currentGrams: selectedItem.quantityGrams,
    })

    return `${selectedItem.foodName} — qual a quantidade certa? (ex: 2 escumadeiras, 200g)`
  }

  // Natural language correction within the meal
  return handleNaturalLanguageCorrectionWithMeal(supabase, userId, message, mealId, items, user)
}

async function handleAwaitingCorrectionValue(
  supabase: SupabaseClient,
  userId: string,
  message: string,
  context: ConversationContext,
  user?: { timezone?: string; dailyCalorieTarget?: number | null },
): Promise<string> {
  const mealId = context.contextData.mealId as string
  const itemId = context.contextData.itemId as string
  const foodName = context.contextData.foodName as string
  const currentGrams = context.contextData.currentGrams as number

  let newGrams: number
  let newDisplay: string

  try {
    const llm = getLLMProvider()
    const raw = await llm.chat(
      `O usuário informou a quantidade de "${foodName}": "${message}". Converta para gramas. Use a tabela: 1 escumadeira de arroz=90g, 1 concha de feijão=80g, 1 colher de sopa=25g, 1 pegador de macarrão=110g, 1 fatia=20g, 1 copo=200ml≈206g. Responda APENAS com JSON: {"quantity_grams": number, "quantity_display": "texto do usuario"}`,
      'Você é um conversor de medidas culinárias. Responda APENAS com JSON válido.',
      true,
    )

    const parsed = JSON.parse(raw.trim()) as { quantity_grams: number; quantity_display: string }
    newGrams = parsed.quantity_grams
    newDisplay = parsed.quantity_display
  } catch {
    const num = parseFloat(message.replace(/[^\d.,]/g, '').replace(',', '.'))
    if (isNaN(num)) {
      return 'Não entendi a quantidade. Pode me dizer em gramas, ml ou medidas caseiras? (ex: 200g, 1 escumadeira)'
    }
    newGrams = num
    newDisplay = message.trim()
  }

  const mealWithItems = await getMealWithItems(supabase, mealId)
  const targetItem = mealWithItems?.items.find(i => i.id === itemId)
  if (!targetItem) {
    await clearState(userId)
    return 'Não encontrei o item para corrigir. Tenta de novo?'
  }

  const ratio = currentGrams > 0 ? newGrams / currentGrams : 1
  const newCalories = Math.round(targetItem.calories * ratio)
  const newProtein = Math.round(targetItem.proteinG * ratio * 10) / 10
  const newCarbs = Math.round(targetItem.carbsG * ratio * 10) / 10
  const newFat = Math.round(targetItem.fatG * ratio * 10) / 10

  await updateMealItem(supabase, itemId, {
    quantityGrams: newGrams,
    quantityDisplay: newDisplay,
    calories: newCalories,
    proteinG: newProtein,
    carbsG: newCarbs,
    fatG: newFat,
  })

  await recalculateMealTotal(supabase, mealId)
  await clearState(userId)

  const dailyConsumed = await getDailyCalories(supabase, userId, undefined, user?.timezone)
  const target = user?.dailyCalorieTarget ?? 2000
  const progress = formatProgress(dailyConsumed, target)

  return `✅ ${foodName} atualizado: ${currentGrams}g → ${newGrams}g (${targetItem.calories} → ${newCalories} kcal)\n${progress}`
}

// ---------------------------------------------------------------------------
// Natural language correction
// ---------------------------------------------------------------------------

async function handleNaturalLanguageCorrection(
  supabase: SupabaseClient,
  userId: string,
  message: string,
  user?: { timezone?: string; dailyCalorieTarget?: number | null },
): Promise<string> {
  const llm = getLLMProvider()

  let correction: Correction
  try {
    const raw = await llm.chat(
      buildCorrectionPrompt(message),
      'Você analisa intenções de correção de refeições. Responda APENAS com JSON válido.',
      true,
    )
    correction = CorrectionSchema.parse(JSON.parse(raw.trim()))
  } catch {
    return showRecentMealsForCorrection(supabase, userId)
  }

  if (correction.confidence === 'low') {
    return showRecentMealsForCorrection(supabase, userId)
  }

  const recentMeals = await getRecentMeals(supabase, userId, 5)
  let targetMeal: RecentMeal | undefined

  if (correction.target_meal_type) {
    targetMeal = recentMeals.find(m => m.mealType === correction.target_meal_type)
  }
  if (!targetMeal) {
    targetMeal = recentMeals[0]
  }
  if (!targetMeal) {
    return 'Não encontrei nenhuma refeição recente para corrigir.'
  }

  const mealWithItems = await getMealWithItems(supabase, targetMeal.id)
  if (!mealWithItems) {
    return 'Não encontrei os itens dessa refeição.'
  }

  return handleNaturalLanguageCorrectionWithMeal(
    supabase, userId, message, targetMeal.id, mealWithItems.items, user,
  )
}

async function handleNaturalLanguageCorrectionWithMeal(
  supabase: SupabaseClient,
  userId: string,
  message: string,
  mealId: string,
  items: Array<{ id: string; foodName: string; quantityGrams: number; calories: number; proteinG?: number; carbsG?: number; fatG?: number }>,
  user?: { timezone?: string; dailyCalorieTarget?: number | null },
): Promise<string> {
  const llm = getLLMProvider()

  let correction: Correction
  try {
    const raw = await llm.chat(
      buildCorrectionPrompt(message),
      'Você analisa intenções de correção de refeições. Responda APENAS com JSON válido.',
      true,
    )
    correction = CorrectionSchema.parse(JSON.parse(raw.trim()))
  } catch {
    await clearState(userId)
    return 'Não entendi a correção. Pode descrever de novo? (ex: "o arroz era 2 escumadeiras")'
  }

  const targetItem = correction.target_food
    ? items.find(i => i.foodName.toLowerCase().includes(correction.target_food!.toLowerCase()))
    : null

  switch (correction.action) {
    case 'remove_item': {
      if (!targetItem) {
        await clearState(userId)
        return `Não encontrei "${correction.target_food}" nessa refeição.`
      }
      await removeMealItem(supabase, targetItem.id)
      const newTotal = await recalculateMealTotal(supabase, mealId)
      await clearState(userId)
      const dailyConsumed = await getDailyCalories(supabase, userId, undefined, user?.timezone)
      const target = user?.dailyCalorieTarget ?? 2000
      return `✅ ${targetItem.foodName} removido! Novo total: ${newTotal} kcal\n${formatProgress(dailyConsumed, target)}`
    }

    case 'update_quantity': {
      if (!targetItem || !correction.new_quantity) {
        await clearState(userId)
        return 'Não entendi qual item corrigir ou a nova quantidade. Tenta "corrigir" pro menu guiado.'
      }
      await setState(userId, 'awaiting_correction_value', {
        mealId,
        itemId: targetItem.id,
        foodName: targetItem.foodName,
        currentGrams: targetItem.quantityGrams,
      })
      return handleAwaitingCorrectionValue(
        supabase, userId, correction.new_quantity,
        {
          id: '', userId, contextType: 'awaiting_correction_value',
          contextData: { mealId, itemId: targetItem.id, foodName: targetItem.foodName, currentGrams: targetItem.quantityGrams },
          expiresAt: '', createdAt: '',
        },
        user,
      )
    }

    case 'delete_meal': {
      await deleteMeal(supabase, mealId)
      await clearState(userId)
      return 'Refeição apagada! ✅'
    }

    case 'update_value': {
      if (!targetItem || !correction.new_value) {
        await clearState(userId)
        return 'Não entendi qual item corrigir ou o novo valor. Tenta "corrigir" pro menu guiado.'
      }
      const { field, amount } = correction.new_value
      const updateData = {
        quantityGrams: targetItem.quantityGrams,
        calories: targetItem.calories,
        proteinG: targetItem.proteinG ?? 0,
        carbsG: targetItem.carbsG ?? 0,
        fatG: targetItem.fatG ?? 0,
      }
      const fieldMap: Record<string, string> = {
        calories: 'calories',
        protein: 'proteinG',
        carbs: 'carbsG',
        fat: 'fatG',
      }
      const fieldLabels: Record<string, string> = {
        calories: 'kcal',
        protein: 'g proteína',
        carbs: 'g carboidratos',
        fat: 'g gordura',
      }
      const key = fieldMap[field] as keyof typeof updateData
      const oldValue = updateData[key]
      updateData[key] = amount

      await updateMealItem(supabase, targetItem.id, updateData)
      await recalculateMealTotal(supabase, mealId)
      await clearState(userId)

      const dailyConsumed = await getDailyCalories(supabase, userId, undefined, user?.timezone)
      const target = user?.dailyCalorieTarget ?? 2000
      return `✅ ${targetItem.foodName}: ${oldValue} → ${amount} ${fieldLabels[field]}\n${formatProgress(dailyConsumed, target)}`
    }

    default:
      await clearState(userId)
      return 'Não entendi a correção. Manda "corrigir" pro menu guiado.'
  }
}

// ---------------------------------------------------------------------------
// Quote-based correction flow
// ---------------------------------------------------------------------------

function findItemByFoodName(
  items: MealItemDetail[],
  name: string,
): MealItemDetail | undefined {
  const normalize = (s: string) =>
    s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim()
  const target = normalize(name)

  return items.find(i => {
    const n = normalize(i.foodName)
    return n.includes(target) || target.includes(n)
  })
}

async function renameItem(
  supabase: SupabaseClient,
  userId: string,
  mealId: string,
  targetItem: { id: string; foodName: string; quantityGrams: number; calories: number; proteinG: number; carbsG: number; fatG: number },
  newFoodName: string,
  user?: { timezone?: string; dailyCalorieTarget?: number | null },
): Promise<string> {
  const llm = getLLMProvider()

  try {
    const meals = await llm.analyzeMeal(`${newFoodName} ${targetItem.quantityGrams}g`)
    const newItem = meals[0]?.items[0]

    if (!newItem) {
      return `Não consegui analisar *${newFoodName}*. Pode tentar de novo?`
    }

    const oldName = targetItem.foodName
    const oldCalories = targetItem.calories

    await updateMealItem(supabase, targetItem.id, {
      quantityGrams: newItem.quantity_grams ?? targetItem.quantityGrams,
      calories: Math.round(newItem.calories ?? 0),
      proteinG: newItem.protein ?? 0,
      carbsG: newItem.carbs ?? 0,
      fatG: newItem.fat ?? 0,
      foodName: newItem.food,
    })

    const newTotal = await recalculateMealTotal(supabase, mealId)
    await clearState(userId)
    const dailyConsumed = await getDailyCalories(supabase, userId, undefined, user?.timezone)
    const target = user?.dailyCalorieTarget ?? 2000

    return [
      '✏️ Corrigido!',
      `  ${oldName} ${targetItem.quantityGrams}g → ${newItem.food} ${newItem.quantity_grams ?? targetItem.quantityGrams}g`,
      `  ${oldCalories} kcal → ${Math.round(newItem.calories ?? 0)} kcal`,
      '',
      `📊 Novo total da refeição: ${newTotal} kcal`,
      formatProgress(dailyConsumed, target),
    ].join('\n')
  } catch {
    return `Não consegui analisar *${newFoodName}*. Pode tentar de novo?`
  }
}

async function handleQuotedEdit(
  supabase: SupabaseClient,
  userId: string,
  message: string,
  quoteContext: QuoteContext,
  user?: { timezone?: string; dailyCalorieTarget?: number | null },
): Promise<string> {
  if (quoteContext.resourceType !== 'meal' || !quoteContext.resourceId) {
    return 'Ainda não consigo fazer isso com mensagens citadas 😅 Mas posso te ajudar com outra coisa! Digite *menu* para ver as opções.'
  }

  const meal = await getMealWithItems(supabase, quoteContext.resourceId)
  if (!meal || meal.items.length === 0) {
    return 'Não encontrei essa refeição. Pode já ter sido apagada.'
  }

  // Delete entire meal (no item specified)
  if (QUOTE_DELETE_NO_ITEM.test(message)) {
    await deleteMeal(supabase, quoteContext.resourceId)
    await clearState(userId)
    const dailyConsumed = await getDailyCalories(supabase, userId, undefined, user?.timezone)
    const target = user?.dailyCalorieTarget ?? 2000
    return `Refeição apagada! ✅\n${formatProgress(dailyConsumed, target)}`
  }

  // Delete specific item
  const deleteItemMatch = QUOTE_DELETE_ITEM.exec(message)
  if (deleteItemMatch) {
    const itemName = deleteItemMatch[1].trim()
    const targetItem = findItemByFoodName(meal.items, itemName)

    if (!targetItem) {
      const itemList = meal.items.map(i => i.foodName).join(', ')
      return `Não encontrei *${itemName}* nessa refeição. Os itens são: ${itemList}. Qual você quer apagar?`
    }

    await removeMealItem(supabase, targetItem.id)
    const newTotal = await recalculateMealTotal(supabase, quoteContext.resourceId)
    await clearState(userId)
    const dailyConsumed = await getDailyCalories(supabase, userId, undefined, user?.timezone)
    const target = user?.dailyCalorieTarget ?? 2000
    return `✅ ${targetItem.foodName} removido! Novo total: ${newTotal} kcal\n${formatProgress(dailyConsumed, target)}`
  }

  // Rename food item ("era quinoa, não arroz" or "era quinoa")
  const renameMatch = QUOTE_RENAME.exec(message)
  if (renameMatch) {
    const newFood = renameMatch[1].trim()
    const oldFood = renameMatch[2]?.trim()

    let targetItem: typeof meal.items[0] | undefined

    if (oldFood) {
      targetItem = findItemByFoodName(meal.items, oldFood)
    } else if (meal.items.length === 1) {
      targetItem = meal.items[0]
    }

    if (!targetItem) {
      const itemList = meal.items.map(i => i.foodName).join(', ')
      await setState(userId, 'awaiting_correction_item', {
        mealId: quoteContext.resourceId,
        mealType: meal.mealType,
        items: meal.items as unknown as Record<string, unknown>[],
        renameTarget: newFood,
      })
      return `Não encontrei *${oldFood || 'o item'}* nessa refeição. Os itens são: ${itemList}. Qual você quer corrigir?`
    }

    return renameItem(supabase, userId, quoteContext.resourceId, targetItem, newFood, user)
  }

  // Quantity correction ("era 200g" or "era 200g de arroz")
  const qtyMatch = QUOTE_QUANTITY.exec(message)
  if (qtyMatch) {
    const newGrams = parseFloat(qtyMatch[1].replace(',', '.'))
    const itemName = qtyMatch[2]?.trim()

    let targetItem: typeof meal.items[0] | undefined

    if (itemName) {
      targetItem = findItemByFoodName(meal.items, itemName)
    } else if (meal.items.length === 1) {
      targetItem = meal.items[0]
    }

    if (!targetItem) {
      const itemList = meal.items.map((item, idx) => `${idx + 1}️⃣ ${item.foodName} (${item.quantityGrams}g)`).join('\n')
      return `Qual item quer corrigir?\n\n${itemList}`
    }

    const ratio = targetItem.quantityGrams > 0 ? newGrams / targetItem.quantityGrams : 1
    const newCalories = Math.round(targetItem.calories * ratio)
    const newProtein = Math.round(targetItem.proteinG * ratio * 10) / 10
    const newCarbs = Math.round(targetItem.carbsG * ratio * 10) / 10
    const newFat = Math.round(targetItem.fatG * ratio * 10) / 10

    await updateMealItem(supabase, targetItem.id, {
      quantityGrams: newGrams,
      quantityDisplay: `${newGrams}g`,
      calories: newCalories,
      proteinG: newProtein,
      carbsG: newCarbs,
      fatG: newFat,
    })

    await recalculateMealTotal(supabase, quoteContext.resourceId)
    await clearState(userId)
    const dailyConsumed = await getDailyCalories(supabase, userId, undefined, user?.timezone)
    const target = user?.dailyCalorieTarget ?? 2000
    return `✅ ${targetItem.foodName} atualizado: ${targetItem.quantityGrams}g → ${newGrams}g (${targetItem.calories} → ${newCalories} kcal)\n${formatProgress(dailyConsumed, target)}`
  }

  // Fall through to natural language correction scoped to the quoted meal
  return handleNaturalLanguageCorrectionWithMeal(supabase, userId, message, quoteContext.resourceId, meal.items, user)
}

// ---------------------------------------------------------------------------
// Existing helpers
// ---------------------------------------------------------------------------

async function initiateDeleteLastMeal(
  supabase: SupabaseClient,
  userId: string,
): Promise<string> {
  const lastMeal = await getLastMeal(supabase, userId)
  if (!lastMeal) {
    return 'Não encontrei nenhuma refeição para apagar.'
  }

  await setState(userId, 'awaiting_correction', {
    action: 'delete_confirm',
    mealId: lastMeal.id,
    mealType: lastMeal.mealType,
    totalCalories: lastMeal.totalCalories,
  })

  return `Quer apagar: ${mealLabel(lastMeal.mealType)} (${lastMeal.totalCalories} kcal)? (sim/não)`
}

async function confirmDeleteMeal(
  supabase: SupabaseClient,
  userId: string,
  context: ConversationContext,
): Promise<string> {
  const mealId = context.contextData.mealId as string
  await deleteMeal(supabase, mealId)
  await clearState(userId)
  return 'Refeição apagada! ✅'
}

async function showRecentMealsForCorrection(
  supabase: SupabaseClient,
  userId: string,
): Promise<string> {
  const meals = await getRecentMeals(supabase, userId, 3)
  if (meals.length === 0) {
    return 'Não encontrei nenhuma refeição recente para corrigir.'
  }

  await setState(userId, 'awaiting_correction', {
    action: 'select_meal',
    meals: meals as unknown as Record<string, unknown>[],
  })

  const mealLines = meals.map((meal, idx) => {
    const label = mealLabel(meal.mealType)
    const dateStr = new Date(meal.registeredAt).toLocaleDateString('pt-BR')
    return `${idx + 1}️⃣ ${label} — ${meal.totalCalories} kcal (${dateStr})`
  })

  return `Qual refeição quer corrigir?\n\n${mealLines.join('\n')}\n\nDigite o número:`
}
