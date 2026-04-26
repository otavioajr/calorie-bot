import { z } from 'zod'

export const ProductSourceSchema = z.enum([
  'open_food_facts',
  'user_label',
  'consenso_usuarios',
])
export const ProductStatusSchema = z.enum(['aprovado', 'privado'])

export type ProductSource = z.infer<typeof ProductSourceSchema>
export type ProductStatus = z.infer<typeof ProductStatusSchema>

export interface Product {
  id: string
  name: string
  nameNormalized: string
  brand: string | null
  brandNormalized: string | null
  barcode: string | null
  servingSizeG: number | null
  servingDisplay: string | null
  caloriesPer100g: number
  proteinPer100g: number
  carbsPer100g: number
  fatPer100g: number
  fiberPer100g: number | null
  sodiumPer100g: number | null
  source: ProductSource
  sourceRef: string | null
  status: ProductStatus
  createdBy: string | null
  createdAt: string
  updatedAt: string
  promotedAt: string | null
  contributorIds: string[] | null
}

export interface ProductUsage {
  productId: string
  userId: string
  usedAt: string
}

export interface OffProduct {
  code: string
  productName: string
  brand: string | null
  caloriesPer100g: number
  proteinPer100g: number
  carbsPer100g: number
  fatPer100g: number
  fiberPer100g: number | null
  servingSizeG: number | null
  servingDisplay: string | null
  sourceUrl: string
}

export type ProductLookupOutcome =
  | { kind: 'matched'; product: Product; quantityGrams: number }
  | {
      kind: 'needs_off_choice'
      query: string
      candidates: OffProduct[]
      quantityGrams: number | null
    }
  | { kind: 'needs_label'; food: string; quantityGrams: number | null }
  | { kind: 'skip' }
