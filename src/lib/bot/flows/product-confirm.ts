import type { SupabaseClient } from '@supabase/supabase-js'
import { clearState, setState, type ConversationContext } from '@/lib/bot/state'
import { createProduct, recordUsage } from '@/lib/products/queries'
import type { OffProduct, Product } from '@/lib/products/types'

export interface ProductConfirmResult {
  response: string
  completed: boolean
  productId?: string
  product?: Product
}

interface StartOffChoiceInput {
  query: string
  candidates: OffProduct[]
  quantityGrams: number | null
  pendingMeal?: ProductPendingMeal
}

export interface ProductPendingMeal {
  mealType: string
  originalMessage: string
  food: string
  quantityDisplay: string | null
}

interface LabelProductDraft {
  name: string
  brand: string
  caloriesPer100g: number
  proteinPer100g: number
  carbsPer100g: number
  fatPer100g: number
}

const LABEL_FORMAT_MESSAGE =
  'Me envie os dados do rótulo neste formato: Marca NomeDaMarca, 420 kcal, proteína 9g, carbo 72g, gordura 10g por 100g.'

function normalizeAnswer(message: string): string {
  return message
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim()
}

function isYes(message: string): boolean {
  return ['sim', 's', 'ok', 'confirmo', 'isso'].includes(normalizeAnswer(message))
}

function isNo(message: string): boolean {
  return ['nao', 'n', 'não', 'nenhum', 'corrigir'].includes(normalizeAnswer(message))
}

function isNone(message: string): boolean {
  return ['nenhum', 'nenhuma', 'nao', 'não', 'n'].includes(normalizeAnswer(message))
}

function getCandidates(context: ConversationContext): OffProduct[] {
  const candidates = context.contextData.candidates
  return Array.isArray(candidates) ? (candidates as OffProduct[]) : []
}

function getCandidate(context: ConversationContext): OffProduct | null {
  const candidate = context.contextData.candidate
  return candidate && typeof candidate === 'object' ? (candidate as OffProduct) : null
}

function getQuantityGrams(context: ConversationContext): number | null {
  const value = context.contextData.quantityGrams
  return typeof value === 'number' ? value : null
}

function getPendingMeal(context: ConversationContext): ProductPendingMeal | undefined {
  const value = context.contextData.pendingMeal
  return value && typeof value === 'object' ? (value as ProductPendingMeal) : undefined
}

function getLabelName(context: ConversationContext): string {
  const value = context.contextData.name
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : 'Produto'
}

function formatCandidate(candidate: OffProduct): string {
  const brand = candidate.brand?.trim()
  const brandPart = brand ? ` - ${brand}` : ''
  const servingPart = candidate.servingDisplay ? ` (${candidate.servingDisplay})` : ''
  return `${candidate.productName}${brandPart}${servingPart}`
}

function formatOffConfirmation(candidate: OffProduct): string {
  return [
    `Confirma este produto? ${formatCandidate(candidate)}`,
    `${candidate.caloriesPer100g} kcal, ${candidate.proteinPer100g}g proteína, ${candidate.carbsPer100g}g carbo, ${candidate.fatPer100g}g gordura por 100g.`,
    'Responda sim para usar ou não para cadastrar pelo rótulo.',
  ].join('\n')
}

function labelInputPrompt(name: string): string {
  return [
    `Certo. Vou cadastrar "${name}" pelo rótulo.`,
    LABEL_FORMAT_MESSAGE,
  ].join('\n')
}

function confirmationPrompt(product: LabelProductDraft): string {
  return [
    `Confirma este cadastro? ${product.name} - ${product.brand}`,
    `${product.caloriesPer100g} kcal, ${product.proteinPer100g}g proteína, ${product.carbsPer100g}g carbo, ${product.fatPer100g}g gordura por 100g.`,
    'Responda sim para salvar ou não para enviar o rótulo novamente.',
  ].join('\n')
}

function parseNumber(value: string): number | null {
  const normalized = value.replace(',', '.')
  const parsed = Number.parseFloat(normalized)
  return Number.isFinite(parsed) ? parsed : null
}

function matchNutrient(text: string, patterns: RegExp[]): number | null {
  for (const pattern of patterns) {
    const match = text.match(pattern)
    if (match?.[1]) {
      return parseNumber(match[1])
    }
  }
  return null
}

function parseLabelInput(message: string, productName: string): LabelProductDraft | null {
  const brandMatch = message.match(/marca\s*:?\s*([^,;\n]+)/i)
  const firstField = message.split(/[,;\n]/)[0]?.trim()
  const brand = brandMatch?.[1]?.trim() ?? firstField

  const calories = matchNutrient(message, [
    /(\d+(?:[,.]\d+)?)\s*kcal/i,
    /calorias?\s*:?\s*(\d+(?:[,.]\d+)?)/i,
  ])
  const protein = matchNutrient(message, [
    /prote[ií]na\s*:?\s*(\d+(?:[,.]\d+)?)\s*g?/i,
    /(\d+(?:[,.]\d+)?)\s*g?\s*de\s*prote[ií]na/i,
  ])
  const carbs = matchNutrient(message, [
    /carbo(?:idratos?)?\s*:?\s*(\d+(?:[,.]\d+)?)\s*g?/i,
    /(\d+(?:[,.]\d+)?)\s*g?\s*de\s*carbo(?:idratos?)?/i,
  ])
  const fat = matchNutrient(message, [
    /gordura\s*:?\s*(\d+(?:[,.]\d+)?)\s*g?/i,
    /lip[ií]dios\s*:?\s*(\d+(?:[,.]\d+)?)\s*g?/i,
    /(\d+(?:[,.]\d+)?)\s*g?\s*de\s*gordura/i,
  ])

  if (!brand || calories == null || protein == null || carbs == null || fat == null) {
    return null
  }

  if (!isPlausibleLabelNutrition(calories, protein, carbs, fat)) {
    return null
  }

  return {
    name: productName,
    brand,
    caloriesPer100g: calories,
    proteinPer100g: protein,
    carbsPer100g: carbs,
    fatPer100g: fat,
  }
}

function isPlausibleLabelNutrition(
  calories: number,
  protein: number,
  carbs: number,
  fat: number,
): boolean {
  if (calories < 20 || calories > 900) return false
  if (protein < 0 || protein > 100) return false
  if (carbs < 0 || carbs > 100) return false
  if (fat < 0 || fat > 100) return false

  const macroCalories = protein * 4 + carbs * 4 + fat * 9
  return Math.abs(macroCalories - calories) / calories <= 0.2
}

async function moveToLabelInput(
  userId: string,
  name: string,
  quantityGrams: number | null,
  pendingMeal?: ProductPendingMeal,
): Promise<ProductConfirmResult> {
  await setState(userId, 'awaiting_label_input', { name, quantityGrams, pendingMeal })
  return {
    response: labelInputPrompt(name),
    completed: false,
  }
}

export async function handleStartOffChoice(
  userId: string,
  input: StartOffChoiceInput,
): Promise<ProductConfirmResult> {
  await setState(userId, 'awaiting_off_choice', {
    query: input.query,
    quantityGrams: input.quantityGrams,
    candidates: input.candidates,
    pendingMeal: input.pendingMeal,
  })

  const options = input.candidates
    .map((candidate, index) => `${index + 1}. ${formatCandidate(candidate)}`)
    .join('\n')

  return {
    response: [
      'Encontrei algumas opções para esse produto:',
      options,
      'Responda com o número da opção correta ou "nenhum" para cadastrar pelo rótulo.',
    ].join('\n'),
    completed: false,
  }
}

export async function handleStartLabelInput(
  userId: string,
  input: {
    food: string
    quantityGrams: number | null
    pendingMeal?: ProductPendingMeal
  },
): Promise<ProductConfirmResult> {
  return moveToLabelInput(userId, input.food, input.quantityGrams, input.pendingMeal)
}

export async function handleAwaitingOffChoice(
  userId: string,
  message: string,
  context: ConversationContext,
): Promise<ProductConfirmResult> {
  const candidates = getCandidates(context)
  const query = typeof context.contextData.query === 'string' ? context.contextData.query : 'Produto'
  const quantityGrams = getQuantityGrams(context)

  if (isNone(message)) {
    return moveToLabelInput(userId, query, quantityGrams, getPendingMeal(context))
  }

  const choice = Number.parseInt(message.trim(), 10)
  const candidate = Number.isInteger(choice) ? candidates[choice - 1] : undefined

  if (!candidate) {
    return {
      response: 'Não encontrei essa opção. Responda com um dos números da lista ou "nenhum".',
      completed: false,
    }
  }

  if (!candidate.brand?.trim()) {
    await setState(userId, 'awaiting_off_brand', {
      candidate,
      quantityGrams,
      pendingMeal: getPendingMeal(context),
    })
    return {
      response: `Qual é a marca de "${candidate.productName}"?`,
      completed: false,
    }
  }

  await setState(userId, 'awaiting_off_confirm', {
    candidate,
    quantityGrams,
    pendingMeal: getPendingMeal(context),
  })
  return {
    response: formatOffConfirmation(candidate),
    completed: false,
  }
}

export async function handleAwaitingOffBrand(
  userId: string,
  message: string,
  context: ConversationContext,
): Promise<ProductConfirmResult> {
  const brand = message.trim()
  const candidate = getCandidate(context)

  if (!candidate) {
    return moveToLabelInput(userId, 'Produto', getQuantityGrams(context), getPendingMeal(context))
  }

  if (brand.length === 0) {
    return {
      response: 'Me envie o nome da marca para continuar.',
      completed: false,
    }
  }

  const candidateWithBrand = { ...candidate, brand }
  await setState(userId, 'awaiting_off_confirm', {
    candidate: candidateWithBrand,
    quantityGrams: getQuantityGrams(context),
    pendingMeal: getPendingMeal(context),
  })

  return {
    response: formatOffConfirmation(candidateWithBrand),
    completed: false,
  }
}

export async function handleAwaitingOffConfirm(
  supabase: SupabaseClient,
  userId: string,
  message: string,
  context: ConversationContext,
): Promise<ProductConfirmResult> {
  const candidate = getCandidate(context)

  if (!candidate) {
    return moveToLabelInput(userId, 'Produto', getQuantityGrams(context), getPendingMeal(context))
  }

  if (isNo(message)) {
    return moveToLabelInput(userId, candidate.productName, getQuantityGrams(context), getPendingMeal(context))
  }

  if (!isYes(message)) {
    return {
      response: 'Responda sim para usar este produto ou não para cadastrar pelo rótulo.',
      completed: false,
    }
  }

  const product = await createProduct(supabase, {
    name: candidate.productName,
    brand: candidate.brand,
    barcode: candidate.code,
    servingSizeG: candidate.servingSizeG,
    servingDisplay: candidate.servingDisplay,
    caloriesPer100g: candidate.caloriesPer100g,
    proteinPer100g: candidate.proteinPer100g,
    carbsPer100g: candidate.carbsPer100g,
    fatPer100g: candidate.fatPer100g,
    fiberPer100g: candidate.fiberPer100g,
    source: 'open_food_facts',
    sourceRef: candidate.sourceUrl,
    status: 'aprovado',
    createdBy: null,
  })

  await recordUsage(supabase, product.id, userId)
  await clearState(userId)

  return {
    response: `Produto salvo: ${product.name}.`,
    completed: true,
    productId: product.id,
    product,
  }
}

export async function handleAwaitingLabelInput(
  userId: string,
  message: string,
  context: ConversationContext,
): Promise<ProductConfirmResult> {
  const name = getLabelName(context)
  const parsed = parseLabelInput(message, name)

  if (!parsed) {
    return {
      response: LABEL_FORMAT_MESSAGE,
      completed: false,
    }
  }

  await setState(userId, 'awaiting_label_confirm', {
    product: parsed,
    quantityGrams: getQuantityGrams(context),
    pendingMeal: getPendingMeal(context),
  })

  return {
    response: confirmationPrompt(parsed),
    completed: false,
  }
}

export async function handleAwaitingLabelConfirm(
  supabase: SupabaseClient,
  userId: string,
  message: string,
  context: ConversationContext,
): Promise<ProductConfirmResult> {
  const productDraft = context.contextData.product as LabelProductDraft | undefined

  if (!productDraft) {
    return moveToLabelInput(userId, getLabelName(context), getQuantityGrams(context), getPendingMeal(context))
  }

  if (isNo(message)) {
    return moveToLabelInput(userId, productDraft.name, getQuantityGrams(context), getPendingMeal(context))
  }

  if (!isYes(message)) {
    return {
      response: 'Responda sim para salvar ou não para enviar os dados do rótulo novamente.',
      completed: false,
    }
  }

  const product = await createProduct(supabase, {
    name: productDraft.name,
    brand: productDraft.brand,
    caloriesPer100g: productDraft.caloriesPer100g,
    proteinPer100g: productDraft.proteinPer100g,
    carbsPer100g: productDraft.carbsPer100g,
    fatPer100g: productDraft.fatPer100g,
    source: 'user_label',
    status: 'privado',
    createdBy: userId,
  })

  await recordUsage(supabase, product.id, userId)
  await clearState(userId)

  return {
    response: `Produto salvo para seu uso: ${product.name}.`,
    completed: true,
    productId: product.id,
    product,
  }
}
