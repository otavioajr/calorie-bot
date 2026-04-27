import { beforeEach, describe, expect, it, vi } from 'vitest'
import { tryProductLookup } from '@/lib/products/lookup'
import type { MealItem } from '@/lib/llm/schemas/meal-analysis'
import type { OffProduct, Product } from '@/lib/products/types'

vi.mock('@/lib/products/classify', () => ({ shouldUseProductFlow: vi.fn() }))
vi.mock('@/lib/products/queries', () => ({
  findApprovedProduct: vi.fn(),
  findPrivateProduct: vi.fn(),
  findRecentlyUsedProduct: vi.fn(),
  recordUsage: vi.fn(),
}))
vi.mock('@/lib/products/off-client', () => ({ searchByName: vi.fn() }))

import { shouldUseProductFlow } from '@/lib/products/classify'
import { searchByName } from '@/lib/products/off-client'
import { findApprovedProduct, findPrivateProduct, findRecentlyUsedProduct, recordUsage } from '@/lib/products/queries'

const supabase = {} as Parameters<typeof tryProductLookup>[0]

function mealItem(overrides: Partial<MealItem> = {}): MealItem {
  return {
    food: 'Magic Toast',
    portion_type: 'packaged',
    quantity_grams: 30,
    quantity_display: '1 pacote',
    quantity_source: 'estimated',
    has_user_quantity: false,
    nutrition_basis_grams: null,
    nutrition_basis_calories: null,
    nutrition_basis_protein: null,
    nutrition_basis_carbs: null,
    nutrition_basis_fat: null,
    calories: null,
    protein: null,
    carbs: null,
    fat: null,
    confidence: 'medium',
    ...overrides,
  }
}

function product(overrides: Partial<Product> = {}): Product {
  return {
    id: 'product-1',
    name: 'Magic Toast',
    nameNormalized: 'magic toast',
    brand: 'Marilan',
    brandNormalized: 'marilan',
    barcode: null,
    servingSizeG: 30,
    servingDisplay: '1 pacote',
    caloriesPer100g: 420,
    proteinPer100g: 9,
    carbsPer100g: 72,
    fatPer100g: 10,
    fiberPer100g: null,
    sodiumPer100g: null,
    source: 'open_food_facts',
    sourceRef: null,
    status: 'aprovado',
    createdBy: null,
    createdAt: '2026-04-26T00:00:00.000Z',
    updatedAt: '2026-04-26T00:00:00.000Z',
    promotedAt: null,
    contributorIds: null,
    ...overrides,
  }
}

const offCandidate: OffProduct = {
  code: '789',
  productName: 'Magic Toast',
  brand: 'Marilan',
  caloriesPer100g: 420,
  proteinPer100g: 9,
  carbsPer100g: 72,
  fatPer100g: 10,
  fiberPer100g: null,
  servingSizeG: 30,
  servingDisplay: '1 pacote',
  sourceUrl: 'https://world.openfoodfacts.org/product/789',
}

beforeEach(() => {
  vi.resetAllMocks()
})

describe('tryProductLookup', () => {
  it('returns skip without touching catalogs when guardrail rejects', async () => {
    vi.mocked(shouldUseProductFlow).mockResolvedValue(false)

    await expect(tryProductLookup(supabase, mealItem(), 'user-1')).resolves.toEqual({
      kind: 'skip',
    })
    expect(findApprovedProduct).not.toHaveBeenCalled()
    expect(findPrivateProduct).not.toHaveBeenCalled()
    expect(searchByName).not.toHaveBeenCalled()
  })

  it('returns matched approved product and records usage', async () => {
    const approved = product({ id: 'approved-1' })
    vi.mocked(shouldUseProductFlow).mockResolvedValue(true)
    vi.mocked(findApprovedProduct).mockResolvedValue(approved)

    const result = await tryProductLookup(supabase, mealItem(), 'user-1')

    expect(result).toEqual({ kind: 'matched', product: approved, quantityGrams: 30 })
    expect(findApprovedProduct).toHaveBeenCalledWith(supabase, 'Magic Toast')
    expect(findPrivateProduct).not.toHaveBeenCalled()
    expect(findRecentlyUsedProduct).not.toHaveBeenCalled()
    expect(recordUsage).toHaveBeenCalledWith(supabase, 'approved-1', 'user-1')
  })

  it('passes through explicit gram quantity', async () => {
    const approved = product({ id: 'approved-1' })
    vi.mocked(shouldUseProductFlow).mockResolvedValue(true)
    vi.mocked(findApprovedProduct).mockResolvedValue(approved)

    const result = await tryProductLookup(supabase, mealItem({ quantity_grams: 30, quantity_display: '30g' }), 'user-1')

    expect(result).toEqual({ kind: 'matched', product: approved, quantityGrams: 30 })
  })

  it('uses product serving size when matched product has no explicit gram quantity', async () => {
    const approved = product({ id: 'approved-1' })
    vi.mocked(shouldUseProductFlow).mockResolvedValue(true)
    vi.mocked(findApprovedProduct).mockResolvedValue(approved)

    const result = await tryProductLookup(supabase, mealItem({ quantity_grams: null }), 'user-1')

    expect(result).toEqual({ kind: 'matched', product: approved, quantityGrams: 30 })
  })

  it('falls through to private product when approved catalog has no match', async () => {
    const privateProduct = product({ id: 'private-1', status: 'privado', createdBy: 'user-1' })
    vi.mocked(shouldUseProductFlow).mockResolvedValue(true)
    vi.mocked(findApprovedProduct).mockResolvedValue(null)
    vi.mocked(findPrivateProduct).mockResolvedValue(privateProduct)

    const result = await tryProductLookup(supabase, mealItem(), 'user-1')

    expect(result).toEqual({ kind: 'matched', product: privateProduct, quantityGrams: 30 })
    expect(findPrivateProduct).toHaveBeenCalledWith(supabase, 'user-1', 'Magic Toast')
    expect(findRecentlyUsedProduct).not.toHaveBeenCalled()
    expect(recordUsage).toHaveBeenCalledWith(supabase, 'private-1', 'user-1')
  })

  it('reuses a recently used matching product before searching Open Food Facts', async () => {
    const recent = product({
      id: 'recent-1',
      name: 'Lev Magic Toast',
      nameNormalized: 'lev magic toast',
    })
    vi.mocked(shouldUseProductFlow).mockResolvedValue(true)
    vi.mocked(findApprovedProduct).mockResolvedValue(null)
    vi.mocked(findPrivateProduct).mockResolvedValue(null)
    vi.mocked(findRecentlyUsedProduct).mockResolvedValue(recent)

    const result = await tryProductLookup(supabase, mealItem({ food: 'magic toast' }), 'user-1')

    expect(result).toEqual({ kind: 'matched', product: recent, quantityGrams: 30 })
    expect(findRecentlyUsedProduct).toHaveBeenCalledWith(supabase, 'user-1', 'magic toast')
    expect(recordUsage).toHaveBeenCalledWith(supabase, 'recent-1', 'user-1')
    expect(searchByName).not.toHaveBeenCalled()
  })

  it('returns OFF choice request when catalogs miss and OFF has candidates', async () => {
    vi.mocked(shouldUseProductFlow).mockResolvedValue(true)
    vi.mocked(findApprovedProduct).mockResolvedValue(null)
    vi.mocked(findPrivateProduct).mockResolvedValue(null)
    vi.mocked(findRecentlyUsedProduct).mockResolvedValue(null)
    vi.mocked(searchByName).mockResolvedValue([offCandidate])

    const result = await tryProductLookup(supabase, mealItem(), 'user-1')

    expect(result).toEqual({
      kind: 'needs_off_choice',
      query: 'Magic Toast',
      candidates: [offCandidate],
      quantityGrams: null,
    })
  })

  it('returns needs_quantity when product has no serving size and quantity is not in grams', async () => {
    const approved = product({ id: 'approved-1', servingSizeG: null, servingDisplay: null })
    vi.mocked(shouldUseProductFlow).mockResolvedValue(true)
    vi.mocked(findApprovedProduct).mockResolvedValue(approved)

    const result = await tryProductLookup(supabase, mealItem({ quantity_display: '2 torradinhas' }), 'user-1')

    expect(result).toEqual({ kind: 'needs_quantity', product: approved })
  })

  it('returns label request when catalogs and OFF miss', async () => {
    vi.mocked(shouldUseProductFlow).mockResolvedValue(true)
    vi.mocked(findApprovedProduct).mockResolvedValue(null)
    vi.mocked(findPrivateProduct).mockResolvedValue(null)
    vi.mocked(findRecentlyUsedProduct).mockResolvedValue(null)
    vi.mocked(searchByName).mockResolvedValue([])

    const result = await tryProductLookup(supabase, mealItem({ quantity_grams: null }), 'user-1')

    expect(result).toEqual({
      kind: 'needs_label',
      food: 'Magic Toast',
      quantityGrams: null,
    })
  })
})
