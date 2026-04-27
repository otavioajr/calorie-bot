import type { SupabaseClient } from '@supabase/supabase-js'
import type { MealItem } from '@/lib/llm/schemas/meal-analysis'
import { shouldUseProductFlow } from './classify'
import { searchByName } from './off-client'
import { findApprovedProduct, findPrivateProduct, findRecentlyUsedProduct, recordUsage } from './queries'
import type { Product, ProductLookupOutcome } from './types'

function hasExplicitGramQuantity(item: MealItem): boolean {
  if (!item.quantity_grams || item.quantity_grams <= 0) return false
  if (!item.quantity_display) return false
  return /\d+\s*(?:g|gramas?|ml|litros?)\b/i.test(item.quantity_display)
}

function matchedProductOutcome(
  product: Product,
  quantityGrams: number | null,
): ProductLookupOutcome {
  const resolvedQuantityGrams = quantityGrams ?? product.servingSizeG
  if (resolvedQuantityGrams == null) {
    return { kind: 'needs_quantity', product }
  }

  return { kind: 'matched', product, quantityGrams: resolvedQuantityGrams }
}

export async function tryProductLookup(
  supabase: SupabaseClient,
  item: MealItem,
  userId: string,
): Promise<ProductLookupOutcome> {
  const eligible = await shouldUseProductFlow(item, supabase)
  if (!eligible) return { kind: 'skip' }

  const quantityGrams = hasExplicitGramQuantity(item) ? item.quantity_grams! : null

  const approvedProduct = await findApprovedProduct(supabase, item.food)
  if (approvedProduct) {
    await recordUsage(supabase, approvedProduct.id, userId)
    return matchedProductOutcome(approvedProduct, quantityGrams)
  }

  const privateProduct = await findPrivateProduct(supabase, userId, item.food)
  if (privateProduct) {
    await recordUsage(supabase, privateProduct.id, userId)
    return matchedProductOutcome(privateProduct, quantityGrams)
  }

  const recentlyUsedProduct = await findRecentlyUsedProduct(supabase, userId, item.food)
  if (recentlyUsedProduct) {
    await recordUsage(supabase, recentlyUsedProduct.id, userId)
    return matchedProductOutcome(recentlyUsedProduct, quantityGrams)
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
