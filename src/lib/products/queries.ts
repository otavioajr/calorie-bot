import type { SupabaseClient } from '@supabase/supabase-js'
import { normalizeBrand, normalizeProductName } from './normalize'
import type { Product, ProductSource, ProductStatus } from './types'

const PRODUCT_COLUMNS = [
  'id',
  'name',
  'name_normalized',
  'brand',
  'brand_normalized',
  'barcode',
  'serving_size_g',
  'serving_display',
  'calories_per_100g',
  'protein_per_100g',
  'carbs_per_100g',
  'fat_per_100g',
  'fiber_per_100g',
  'sodium_per_100g',
  'source',
  'source_ref',
  'status',
  'created_by',
  'created_at',
  'updated_at',
  'promoted_at',
  'contributor_ids',
].join(',')

interface ProductRow {
  id: string
  name: string
  name_normalized: string
  brand: string | null
  brand_normalized: string | null
  barcode: string | null
  serving_size_g: number | null
  serving_display: string | null
  calories_per_100g: number
  protein_per_100g: number
  carbs_per_100g: number
  fat_per_100g: number
  fiber_per_100g: number | null
  sodium_per_100g: number | null
  source: ProductSource
  source_ref: string | null
  status: ProductStatus
  created_by: string | null
  created_at: string
  updated_at: string
  promoted_at: string | null
  contributor_ids: string[] | null
}

export interface CreateProductInput {
  name: string
  brand: string | null
  barcode?: string | null
  servingSizeG?: number | null
  servingDisplay?: string | null
  caloriesPer100g: number
  proteinPer100g: number
  carbsPer100g: number
  fatPer100g: number
  fiberPer100g?: number | null
  sodiumPer100g?: number | null
  source: ProductSource
  sourceRef?: string | null
  status: ProductStatus
  createdBy: string | null
}

function rowToProduct(row: ProductRow): Product {
  return {
    id: row.id,
    name: row.name,
    nameNormalized: row.name_normalized,
    brand: row.brand,
    brandNormalized: row.brand_normalized,
    barcode: row.barcode,
    servingSizeG: row.serving_size_g,
    servingDisplay: row.serving_display,
    caloriesPer100g: row.calories_per_100g,
    proteinPer100g: row.protein_per_100g,
    carbsPer100g: row.carbs_per_100g,
    fatPer100g: row.fat_per_100g,
    fiberPer100g: row.fiber_per_100g,
    sodiumPer100g: row.sodium_per_100g,
    source: row.source,
    sourceRef: row.source_ref,
    status: row.status,
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    promotedAt: row.promoted_at,
    contributorIds: row.contributor_ids,
  }
}

export async function findApprovedProduct(
  supabase: SupabaseClient,
  name: string,
  brand?: string | null,
): Promise<Product | null> {
  let query = supabase
    .from('products')
    .select(PRODUCT_COLUMNS)
    .eq('status', 'aprovado')
    .eq('name_normalized', normalizeProductName(name))

  const brandNormalized = normalizeBrand(brand)
  if (brandNormalized) {
    query = query.eq('brand_normalized', brandNormalized)
  }

  const { data, error } = await query.limit(1).maybeSingle()
  if (error || !data) return null

  return rowToProduct(data as ProductRow)
}

export async function findPrivateProduct(
  supabase: SupabaseClient,
  userId: string,
  name: string,
): Promise<Product | null> {
  const { data, error } = await supabase
    .from('products')
    .select(PRODUCT_COLUMNS)
    .eq('status', 'privado')
    .eq('created_by', userId)
    .eq('name_normalized', normalizeProductName(name))
    .limit(1)
    .maybeSingle()

  if (error || !data) return null

  return rowToProduct(data as ProductRow)
}

export async function findByBarcode(
  supabase: SupabaseClient,
  barcode: string,
): Promise<Product | null> {
  const { data, error } = await supabase
    .from('products')
    .select(PRODUCT_COLUMNS)
    .eq('barcode', barcode)
    .limit(1)
    .maybeSingle()

  if (error || !data) return null

  return rowToProduct(data as ProductRow)
}

export async function createProduct(
  supabase: SupabaseClient,
  input: CreateProductInput,
): Promise<Product> {
  const { data, error } = await supabase
    .from('products')
    .insert({
      name: input.name,
      name_normalized: normalizeProductName(input.name),
      brand: input.brand,
      brand_normalized: normalizeBrand(input.brand),
      barcode: input.barcode ?? null,
      serving_size_g: input.servingSizeG ?? null,
      serving_display: input.servingDisplay ?? null,
      calories_per_100g: input.caloriesPer100g,
      protein_per_100g: input.proteinPer100g,
      carbs_per_100g: input.carbsPer100g,
      fat_per_100g: input.fatPer100g,
      fiber_per_100g: input.fiberPer100g ?? null,
      sodium_per_100g: input.sodiumPer100g ?? null,
      source: input.source,
      source_ref: input.sourceRef ?? null,
      status: input.status,
      created_by: input.createdBy,
    })
    .select(PRODUCT_COLUMNS)
    .single()

  if (error || !data) {
    throw new Error(`createProduct failed: ${error?.message ?? 'unknown error'}`)
  }

  return rowToProduct(data as ProductRow)
}

export async function recordUsage(
  supabase: SupabaseClient,
  productId: string,
  userId: string,
): Promise<void> {
  const { error } = await supabase.from('product_usage').insert({
    product_id: productId,
    user_id: userId,
  })

  if (error) {
    throw new Error(`recordUsage failed: ${error.message ?? 'unknown error'}`)
  }
}
