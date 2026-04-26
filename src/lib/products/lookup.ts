import type { SupabaseClient } from '@supabase/supabase-js'
import type { MealItem } from '@/lib/llm/schemas/meal-analysis'
import { shouldUseProductFlow } from './classify'
import { searchByName } from './off-client'
import { findApprovedProduct, findPrivateProduct, recordUsage } from './queries'
import type { ProductLookupOutcome } from './types'

export async function tryProductLookup(
  supabase: SupabaseClient,
  item: MealItem,
  userId: string,
): Promise<ProductLookupOutcome> {
  const eligible = await shouldUseProductFlow(item, supabase)
  if (!eligible) return { kind: 'skip' }

  const quantityGrams = item.quantity_grams ?? null

  const approvedProduct = await findApprovedProduct(supabase, item.food)
  if (approvedProduct) {
    await recordUsage(supabase, approvedProduct.id, userId)
    return { kind: 'matched', product: approvedProduct, quantityGrams }
  }

  const privateProduct = await findPrivateProduct(supabase, userId, item.food)
  if (privateProduct) {
    await recordUsage(supabase, privateProduct.id, userId)
    return { kind: 'matched', product: privateProduct, quantityGrams }
  }

  const candidates = await searchByName(item.food)
  if (candidates.length > 0) {
    return {
      kind: 'needs_off_choice',
      query: item.food,
      candidates,
      quantityGrams,
    }
  }

  return {
    kind: 'needs_label',
    food: item.food,
    quantityGrams,
  }
}
