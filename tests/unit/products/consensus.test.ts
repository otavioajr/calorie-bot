import type { SupabaseClient } from '@supabase/supabase-js'
import { describe, expect, it, vi } from 'vitest'
import { runConsensusPromotion } from '@/lib/products/consensus'

interface ProductRow {
  id: string
  name: string
  name_normalized: string | null
  brand: string | null
  brand_normalized: string | null
  calories_per_100g: number
  protein_per_100g: number
  carbs_per_100g: number
  fat_per_100g: number
  status: 'privado'
  created_by: string | null
}

function row(
  overrides: Partial<ProductRow> & Pick<ProductRow, 'id' | 'created_by'>,
): ProductRow {
  return {
    id: overrides.id,
    name: 'name' in overrides ? overrides.name! : 'Magic Toast Tradicional',
    name_normalized: 'name_normalized' in overrides
      ? overrides.name_normalized!
      : 'magic toast tradicional',
    brand: 'brand' in overrides ? overrides.brand! : 'Marilan',
    brand_normalized: 'brand_normalized' in overrides ? overrides.brand_normalized! : 'marilan',
    calories_per_100g: 'calories_per_100g' in overrides ? overrides.calories_per_100g! : 420,
    protein_per_100g: 'protein_per_100g' in overrides ? overrides.protein_per_100g! : 9,
    carbs_per_100g: 'carbs_per_100g' in overrides ? overrides.carbs_per_100g! : 72,
    fat_per_100g: 'fat_per_100g' in overrides ? overrides.fat_per_100g! : 10,
    status: 'privado',
    created_by: overrides.created_by,
  }
}

function makeSupabase(privateRows: ProductRow[], approvedExists = false) {
  const inserted: unknown[] = []
  const deleted = vi.fn()
  const updated = vi.fn()

  const query = {
    eq: vi.fn().mockReturnThis(),
    not: vi.fn().mockReturnThis(),
    then: (
      resolve: (value: { data: ProductRow[]; error: null }) => unknown,
      reject?: (reason: unknown) => unknown,
    ) => Promise.resolve({ data: privateRows, error: null }).then(resolve, reject),
  }

  const approvedQuery = {
    eq: vi.fn().mockReturnThis(),
    limit: vi.fn().mockReturnThis(),
    maybeSingle: vi.fn().mockResolvedValue({
      data: approvedExists ? { id: 'approved-existing' } : null,
      error: null,
    }),
  }

  const productsTable = {
    select: vi.fn((columns?: string) => {
      if (columns === 'id') return approvedQuery
      return query
    }),
    insert: vi.fn(async (payload: unknown) => {
      inserted.push(payload)
      return { data: null, error: null }
    }),
    update: updated,
    delete: deleted,
  }

  return {
    supabase: {
      from: vi.fn().mockReturnValue(productsTable),
    } as unknown as SupabaseClient,
    inserted,
    productsTable,
    query,
    approvedQuery,
    updated,
    deleted,
  }
}

describe('runConsensusPromotion', () => {
  it('promotes a private product cluster from 3 distinct users using nutritional medians', async () => {
    const { supabase, inserted, productsTable, query, updated, deleted } = makeSupabase([
      row({ id: 'product-a', created_by: 'user-a', calories_per_100g: 410, protein_per_100g: 8.5 }),
      row({ id: 'product-b', created_by: 'user-b', calories_per_100g: 420, protein_per_100g: 9 }),
      row({ id: 'product-c', created_by: 'user-c', calories_per_100g: 430, protein_per_100g: 9.5 }),
    ])

    const report = await runConsensusPromotion(supabase)

    expect(productsTable.select).toHaveBeenCalled()
    expect(query.eq).toHaveBeenCalledWith('status', 'privado')
    expect(query.not).toHaveBeenCalledWith('brand_normalized', 'is', null)
    expect(query.not).toHaveBeenCalledWith('name_normalized', 'is', null)
    expect(report).toEqual({ promoted: 1, clusters: 1 })
    expect(inserted).toEqual([
      {
        name: 'Magic Toast Tradicional',
        name_normalized: 'magic toast tradicional',
        brand: 'Marilan',
        brand_normalized: 'marilan',
        barcode: null,
        serving_size_g: null,
        serving_display: null,
        calories_per_100g: 420,
        protein_per_100g: 9,
        carbs_per_100g: 72,
        fat_per_100g: 10,
        fiber_per_100g: null,
        sodium_per_100g: null,
        source: 'consenso_usuarios',
        source_ref: null,
        status: 'aprovado',
        created_by: null,
        contributor_ids: ['user-a', 'user-b', 'user-c'],
        promoted_at: expect.any(String),
      },
    ])
    expect(updated).not.toHaveBeenCalled()
    expect(deleted).not.toHaveBeenCalled()
  })

  it('rejects clusters with fewer than 3 distinct users', async () => {
    const { supabase, inserted } = makeSupabase([
      row({ id: 'product-a', created_by: 'user-a' }),
      row({ id: 'product-b', created_by: 'user-b' }),
      row({ id: 'product-c', created_by: 'user-b' }),
    ])

    await expect(runConsensusPromotion(supabase)).resolves.toEqual({ promoted: 0, clusters: 1 })
    expect(inserted).toEqual([])
  })

  it('rejects clusters with a nutritional outlier beyond tolerance', async () => {
    const { supabase, inserted } = makeSupabase([
      row({ id: 'product-a', created_by: 'user-a', calories_per_100g: 420 }),
      row({ id: 'product-b', created_by: 'user-b', calories_per_100g: 420 }),
      row({ id: 'product-c', created_by: 'user-c', calories_per_100g: 600 }),
    ])

    await expect(runConsensusPromotion(supabase)).resolves.toEqual({ promoted: 0, clusters: 1 })
    expect(inserted).toEqual([])
  })

  it('does not promote rows missing brand or created_by', async () => {
    const { supabase, inserted } = makeSupabase([
      row({ id: 'product-a', created_by: 'user-a', brand: null, brand_normalized: null }),
      row({ id: 'product-b', created_by: 'user-b', brand: null, brand_normalized: null }),
      row({ id: 'product-c', created_by: 'user-c', brand: null, brand_normalized: null }),
      row({ id: 'product-d', created_by: null }),
      row({ id: 'product-e', created_by: null }),
      row({ id: 'product-f', created_by: null }),
    ])

    await expect(runConsensusPromotion(supabase)).resolves.toEqual({ promoted: 0, clusters: 0 })
    expect(inserted).toEqual([])
  })

  it('skips promotion when an approved product for the same normalized brand and name already exists', async () => {
    const { supabase, inserted, approvedQuery } = makeSupabase([
      row({ id: 'product-a', created_by: 'user-a' }),
      row({ id: 'product-b', created_by: 'user-b' }),
      row({ id: 'product-c', created_by: 'user-c' }),
    ], true)

    await expect(runConsensusPromotion(supabase)).resolves.toEqual({ promoted: 0, clusters: 1 })
    expect(approvedQuery.eq).toHaveBeenCalledWith('status', 'aprovado')
    expect(approvedQuery.eq).toHaveBeenCalledWith('brand_normalized', 'marilan')
    expect(approvedQuery.eq).toHaveBeenCalledWith('name_normalized', 'magic toast tradicional')
    expect(inserted).toEqual([])
  })
})
