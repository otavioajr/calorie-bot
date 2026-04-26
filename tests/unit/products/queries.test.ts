import type { SupabaseClient } from '@supabase/supabase-js'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createProduct,
  findApprovedProduct,
  findByBarcode,
  findPrivateProduct,
  recordUsage,
} from '@/lib/products/queries'

const productRow = {
  id: 'product-1',
  name: 'Magic Toast',
  name_normalized: 'magic toast',
  brand: 'Marilan',
  brand_normalized: 'marilan',
  barcode: '7891000000000',
  serving_size_g: 25,
  serving_display: '1 pacote (25 g)',
  calories_per_100g: 420,
  protein_per_100g: 9,
  carbs_per_100g: 72,
  fat_per_100g: 10,
  fiber_per_100g: 4,
  sodium_per_100g: 320,
  source: 'open_food_facts',
  source_ref: 'https://world.openfoodfacts.org/product/7891000000000',
  status: 'aprovado',
  created_by: null,
  created_at: '2026-04-26T12:00:00.000Z',
  updated_at: '2026-04-26T12:30:00.000Z',
  promoted_at: '2026-04-26T13:00:00.000Z',
  contributor_ids: ['user-1', 'user-2'],
}

function makeSupabase(result: {
  maybeSingle?: { data: unknown; error: { message?: string } | null }
  single?: { data: unknown; error: { message?: string } | null }
}) {
  const builder = {
    select: vi.fn().mockReturnThis(),
    eq: vi.fn().mockReturnThis(),
    order: vi.fn().mockReturnThis(),
    limit: vi.fn().mockReturnThis(),
    insert: vi.fn().mockReturnThis(),
    maybeSingle: vi
      .fn()
      .mockResolvedValue(result.maybeSingle ?? { data: null, error: null }),
    single: vi.fn().mockResolvedValue(result.single ?? { data: null, error: null }),
  }

  return {
    supabase: { from: vi.fn().mockReturnValue(builder) } as unknown as SupabaseClient,
    builder,
  }
}

describe('product queries', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  describe('findApprovedProduct', () => {
    it('normalizes name and brand, searches approved products, and maps the row to Product', async () => {
      const { supabase, builder } = makeSupabase({
        maybeSingle: { data: productRow, error: null },
      })

      const result = await findApprovedProduct(supabase, 'Magic Tóast', 'Marilan')

      expect(supabase.from).toHaveBeenCalledWith('products')
      expect(builder.eq).toHaveBeenCalledWith('status', 'aprovado')
      expect(builder.eq).toHaveBeenCalledWith('name_normalized', 'magic toast')
      expect(builder.eq).toHaveBeenCalledWith('brand_normalized', 'marilan')
      expect(builder.limit).toHaveBeenCalledWith(1)
      expect(result).toEqual({
        id: 'product-1',
        name: 'Magic Toast',
        nameNormalized: 'magic toast',
        brand: 'Marilan',
        brandNormalized: 'marilan',
        barcode: '7891000000000',
        servingSizeG: 25,
        servingDisplay: '1 pacote (25 g)',
        caloriesPer100g: 420,
        proteinPer100g: 9,
        carbsPer100g: 72,
        fatPer100g: 10,
        fiberPer100g: 4,
        sodiumPer100g: 320,
        source: 'open_food_facts',
        sourceRef: 'https://world.openfoodfacts.org/product/7891000000000',
        status: 'aprovado',
        createdBy: null,
        createdAt: '2026-04-26T12:00:00.000Z',
        updatedAt: '2026-04-26T12:30:00.000Z',
        promotedAt: '2026-04-26T13:00:00.000Z',
        contributorIds: ['user-1', 'user-2'],
      })
    })

    it('does not filter by brand when brand is omitted', async () => {
      const { supabase, builder } = makeSupabase({
        maybeSingle: { data: productRow, error: null },
      })

      await findApprovedProduct(supabase, 'Magic Toast')

      expect(builder.eq).not.toHaveBeenCalledWith('brand_normalized', expect.anything())
    })

    it('returns null when no approved product matches', async () => {
      const { supabase } = makeSupabase({
        maybeSingle: { data: null, error: null },
      })

      await expect(findApprovedProduct(supabase, 'Não existe')).resolves.toBeNull()
    })
  })

  describe('findPrivateProduct', () => {
    it('normalizes the name and searches the current user private products', async () => {
      const { supabase, builder } = makeSupabase({
        maybeSingle: { data: productRow, error: null },
      })

      const result = await findPrivateProduct(supabase, 'user-1', 'Meu produto')

      expect(builder.eq).toHaveBeenCalledWith('status', 'privado')
      expect(builder.eq).toHaveBeenCalledWith('created_by', 'user-1')
      expect(builder.eq).toHaveBeenCalledWith('name_normalized', 'meu produto')
      expect(result?.id).toBe('product-1')
    })
  })

  describe('findByBarcode', () => {
    it('searches products by barcode without normalizing text fields', async () => {
      const { supabase, builder } = makeSupabase({
        maybeSingle: { data: productRow, error: null },
      })

      const result = await findByBarcode(supabase, '7891000000000')

      expect(builder.eq).toHaveBeenCalledWith('barcode', '7891000000000')
      expect(result?.barcode).toBe('7891000000000')
    })
  })

  describe('createProduct', () => {
    it('normalizes insert fields, writes snake_case payload, and returns mapped product', async () => {
      const { supabase, builder } = makeSupabase({
        single: { data: productRow, error: null },
      })

      const result = await createProduct(supabase, {
        name: 'Magic Tóast',
        brand: 'Marilan',
        barcode: '7891000000000',
        servingSizeG: 25,
        servingDisplay: '1 pacote (25 g)',
        caloriesPer100g: 420,
        proteinPer100g: 9,
        carbsPer100g: 72,
        fatPer100g: 10,
        fiberPer100g: 4,
        sodiumPer100g: 320,
        source: 'open_food_facts',
        sourceRef: 'https://world.openfoodfacts.org/product/7891000000000',
        status: 'aprovado',
        createdBy: null,
      })

      expect(builder.insert).toHaveBeenCalledWith({
        name: 'Magic Tóast',
        name_normalized: 'magic toast',
        brand: 'Marilan',
        brand_normalized: 'marilan',
        barcode: '7891000000000',
        serving_size_g: 25,
        serving_display: '1 pacote (25 g)',
        calories_per_100g: 420,
        protein_per_100g: 9,
        carbs_per_100g: 72,
        fat_per_100g: 10,
        fiber_per_100g: 4,
        sodium_per_100g: 320,
        source: 'open_food_facts',
        source_ref: 'https://world.openfoodfacts.org/product/7891000000000',
        status: 'aprovado',
        created_by: null,
      })
      expect(result.id).toBe('product-1')
    })

    it('throws when insert fails', async () => {
      const { supabase } = makeSupabase({
        single: { data: null, error: { message: 'duplicate barcode' } },
      })

      await expect(
        createProduct(supabase, {
          name: 'Magic Toast',
          brand: null,
          caloriesPer100g: 420,
          proteinPer100g: 9,
          carbsPer100g: 72,
          fatPer100g: 10,
          source: 'user_label',
          status: 'privado',
          createdBy: 'user-1',
        }),
      ).rejects.toThrow('createProduct failed: duplicate barcode')
    })
  })

  describe('recordUsage', () => {
    it('inserts product usage with snake_case columns', async () => {
      const { supabase, builder } = makeSupabase({
        single: { data: null, error: null },
      })

      await recordUsage(supabase, 'product-1', 'user-1')

      expect(supabase.from).toHaveBeenCalledWith('product_usage')
      expect(builder.insert).toHaveBeenCalledWith({
        product_id: 'product-1',
        user_id: 'user-1',
      })
    })
  })
})
