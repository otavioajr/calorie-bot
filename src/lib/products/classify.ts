import type { SupabaseClient } from '@supabase/supabase-js'
import type { MealItem } from '@/lib/llm/schemas/meal-analysis'

export const GENERIC_FOOD_TOKENS = [
  'arroz',
  'feijão',
  'feijao',
  'frango',
  'carne',
  'peixe',
  'atum',
  'salmão',
  'salmao',
  'ovo',
  'ovos',
  'leite',
  'iogurte',
  'queijo',
  'requeijão',
  'requeijao',
  'manteiga',
  'pão',
  'pao',
  'tapioca',
  'cuscuz',
  'macarrão',
  'macarrao',
  'massa',
  'batata',
  'mandioca',
  'aipim',
  'inhame',
  'banana',
  'maçã',
  'maca',
  'laranja',
  'mamão',
  'mamao',
  'manga',
  'uva',
  'morango',
  'tomate',
  'cebola',
  'alface',
  'couve',
  'brócolis',
  'brocolis',
  'espinafre',
  'cenoura',
  'beterraba',
  'abobrinha',
  'pimentão',
  'pimentao',
  'azeite',
  'óleo',
  'oleo',
  'açúcar',
  'acucar',
  'sal',
  'café',
  'cafe',
  'chá',
  'cha',
  'água',
  'agua',
] as const

const GENERIC_FOOD_TOKEN_SET = new Set<string>(GENERIC_FOOD_TOKENS)

function normalizeFoodName(food: string): string {
  return food
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .replace(/[^\p{Letter}\p{Number}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function hasGenericFoodToken(food: string): boolean {
  const tokens = normalizeFoodName(food).split(' ').filter(Boolean)
  return tokens.some(token => GENERIC_FOOD_TOKEN_SET.has(token))
}

async function hasNearbyTacoMatch(item: MealItem, supabase: SupabaseClient): Promise<boolean> {
  const input = normalizeFoodName(item.food)
  if (!input) return false

  const { data, error } = await supabase.rpc('taco_max_similarity', { input })
  if (error || data === null || data === undefined) {
    console.error('[classify] taco_max_similarity RPC failed:', error, 'for input:', input)
    return true  // Fail closed: treat as TACO match to avoid routing real TACO foods to product flow
  }

  const similarity = Number(data)
  return Number.isFinite(similarity) && similarity > 0.5
}

export async function shouldUseProductFlow(
  item: MealItem,
  supabase: SupabaseClient,
): Promise<boolean> {
  if (item.portion_type !== 'packaged') return false
  if (hasGenericFoodToken(item.food)) return false
  if (await hasNearbyTacoMatch(item, supabase)) return false

  return true
}
