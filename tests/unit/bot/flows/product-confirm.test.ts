import type { SupabaseClient } from '@supabase/supabase-js'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  handleAwaitingLabelConfirm,
  handleAwaitingLabelInput,
  handleAwaitingOffBrand,
  handleAwaitingOffChoice,
  handleAwaitingOffConfirm,
  handleStartOffChoice,
} from '@/lib/bot/flows/product-confirm'
import type { ConversationContext } from '@/lib/bot/state'
import type { OffProduct, Product } from '@/lib/products/types'

vi.mock('@/lib/bot/state', () => ({
  setState: vi.fn().mockResolvedValue(undefined),
  clearState: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('@/lib/products/queries', () => ({
  createProduct: vi.fn(),
  recordUsage: vi.fn().mockResolvedValue(undefined),
}))

import { clearState, setState } from '@/lib/bot/state'
import { createProduct, recordUsage } from '@/lib/products/queries'

const supabase = {} as SupabaseClient
const userId = 'user-1'

const offCandidateWithBrand: OffProduct = {
  code: '7891000000000',
  productName: 'Magic Toast Tradicional',
  brand: 'Marilan',
  caloriesPer100g: 420,
  proteinPer100g: 9,
  carbsPer100g: 72,
  fatPer100g: 10,
  fiberPer100g: null,
  servingSizeG: 25,
  servingDisplay: '1 pacote (25 g)',
  sourceUrl: 'https://example.test/product/7891000000000',
}

const offCandidateWithoutBrand: OffProduct = {
  ...offCandidateWithBrand,
  code: '7891000000001',
  brand: null,
}

function product(overrides: Partial<Product> = {}): Product {
  return {
    id: 'product-1',
    name: 'Magic Toast Tradicional',
    nameNormalized: 'magic toast tradicional',
    brand: 'Marilan',
    brandNormalized: 'marilan',
    barcode: '7891000000000',
    servingSizeG: 25,
    servingDisplay: '1 pacote (25 g)',
    caloriesPer100g: 420,
    proteinPer100g: 9,
    carbsPer100g: 72,
    fatPer100g: 10,
    fiberPer100g: null,
    sodiumPer100g: null,
    source: 'open_food_facts',
    sourceRef: 'https://example.test/product/7891000000000',
    status: 'aprovado',
    createdBy: null,
    createdAt: '2026-04-26T00:00:00.000Z',
    updatedAt: '2026-04-26T00:00:00.000Z',
    promotedAt: null,
    contributorIds: null,
    ...overrides,
  }
}

function context(
  type: ConversationContext['contextType'],
  data: Record<string, unknown>,
): ConversationContext {
  return {
    id: 'ctx-1',
    userId,
    contextType: type,
    contextData: data,
    expiresAt: '2026-04-26T12:00:00.000Z',
    createdAt: '2026-04-26T11:00:00.000Z',
  }
}

describe('product-confirm flow', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(createProduct).mockResolvedValue(product())
  })

  it('starts the OFF choice state with numbered candidates and no provider name in the response', async () => {
    const result = await handleStartOffChoice(userId, {
      query: 'magic toast',
      quantityGrams: 25,
      candidates: [offCandidateWithBrand],
    })

    expect(result).toEqual(expect.objectContaining({ completed: false }))
    expect(result.response).toContain('1.')
    expect(result.response).toContain('Magic Toast Tradicional')
    expect(result.response).toContain('Marilan')
    expect(result.response).not.toMatch(/open food facts/i)
    expect(setState).toHaveBeenCalledWith(
      userId,
      'awaiting_off_choice',
      expect.objectContaining({
        query: 'magic toast',
        quantityGrams: 25,
        candidates: [offCandidateWithBrand],
      }),
    )
  })

  it('moves a valid branded OFF choice to confirmation', async () => {
    const currentContext = context('awaiting_off_choice', {
      query: 'magic toast',
      quantityGrams: 25,
      candidates: [offCandidateWithBrand],
    })

    const result = await handleAwaitingOffChoice(userId, '1', currentContext)

    expect(result.completed).toBe(false)
    expect(result.response).toMatch(/confirm/i)
    expect(result.response).toContain('Magic Toast Tradicional')
    expect(setState).toHaveBeenCalledWith(
      userId,
      'awaiting_off_confirm',
      expect.objectContaining({
        quantityGrams: 25,
        candidate: offCandidateWithBrand,
      }),
    )
  })

  it('asks for a brand when the chosen OFF candidate has no brand', async () => {
    const currentContext = context('awaiting_off_choice', {
      query: 'produto sem marca',
      quantityGrams: null,
      candidates: [offCandidateWithoutBrand],
    })

    const result = await handleAwaitingOffChoice(userId, '1', currentContext)

    expect(result.completed).toBe(false)
    expect(result.response).toMatch(/marca/i)
    expect(setState).toHaveBeenCalledWith(
      userId,
      'awaiting_off_brand',
      expect.objectContaining({
        candidate: offCandidateWithoutBrand,
      }),
    )
  })

  it('moves to label input when the user chooses none', async () => {
    const currentContext = context('awaiting_off_choice', {
      query: 'magic toast',
      quantityGrams: 25,
      candidates: [offCandidateWithBrand],
    })

    const result = await handleAwaitingOffChoice(userId, 'nenhum', currentContext)

    expect(result.completed).toBe(false)
    expect(result.response).toMatch(/rótulo|rotulo/i)
    expect(setState).toHaveBeenCalledWith(
      userId,
      'awaiting_label_input',
      expect.objectContaining({
        name: 'magic toast',
        quantityGrams: 25,
      }),
    )
  })

  it('stores typed brand and moves to OFF confirmation', async () => {
    const currentContext = context('awaiting_off_brand', {
      quantityGrams: 25,
      candidate: offCandidateWithoutBrand,
    })

    const result = await handleAwaitingOffBrand(userId, 'Marilan', currentContext)

    expect(result.completed).toBe(false)
    expect(result.response).toMatch(/confirm/i)
    expect(result.response).toContain('Marilan')
    expect(setState).toHaveBeenCalledWith(
      userId,
      'awaiting_off_confirm',
      expect.objectContaining({
        candidate: expect.objectContaining({ brand: 'Marilan' }),
      }),
    )
  })

  it('creates an approved product and records usage when OFF confirmation is yes', async () => {
    const savedProduct = product({ id: 'saved-off-1' })
    vi.mocked(createProduct).mockResolvedValue(savedProduct)
    const currentContext = context('awaiting_off_confirm', {
      quantityGrams: 25,
      candidate: offCandidateWithBrand,
    })

    const result = await handleAwaitingOffConfirm(supabase, userId, 'sim', currentContext)

    expect(createProduct).toHaveBeenCalledWith(
      supabase,
      expect.objectContaining({
        name: 'Magic Toast Tradicional',
        brand: 'Marilan',
        barcode: '7891000000000',
        caloriesPer100g: 420,
        proteinPer100g: 9,
        carbsPer100g: 72,
        fatPer100g: 10,
        source: 'open_food_facts',
        status: 'aprovado',
        createdBy: null,
      }),
    )
    expect(recordUsage).toHaveBeenCalledWith(supabase, 'saved-off-1', userId)
    expect(clearState).toHaveBeenCalledWith(userId)
    expect(result).toEqual(
      expect.objectContaining({
        completed: true,
        productId: 'saved-off-1',
      }),
    )
  })

  it('moves OFF confirmation no to label input', async () => {
    const currentContext = context('awaiting_off_confirm', {
      quantityGrams: 25,
      candidate: offCandidateWithBrand,
    })

    const result = await handleAwaitingOffConfirm(supabase, userId, 'não', currentContext)

    expect(createProduct).not.toHaveBeenCalled()
    expect(result.completed).toBe(false)
    expect(setState).toHaveBeenCalledWith(
      userId,
      'awaiting_label_input',
      expect.objectContaining({
        name: 'Magic Toast Tradicional',
        quantityGrams: 25,
      }),
    )
  })

  it('asks for the expected label format when nutrition input is ambiguous', async () => {
    const currentContext = context('awaiting_label_input', {
      name: 'Magic Toast Tradicional',
      quantityGrams: 25,
    })

    const result = await handleAwaitingLabelInput(userId, 'tem umas calorias aqui', currentContext)

    expect(result.completed).toBe(false)
    expect(result.response).toMatch(/marca/i)
    expect(result.response).toMatch(/100g/i)
    expect(setState).not.toHaveBeenCalled()
  })

  it('parses label input and asks for confirmation', async () => {
    const currentContext = context('awaiting_label_input', {
      name: 'Magic Toast Tradicional',
      quantityGrams: 25,
    })

    const result = await handleAwaitingLabelInput(
      userId,
      'Marca Marilan, 420 kcal, proteína 9g, carbo 72g, gordura 10g por 100g',
      currentContext,
    )

    expect(result.completed).toBe(false)
    expect(result.response).toMatch(/confirm/i)
    expect(result.response).toContain('Marilan')
    expect(setState).toHaveBeenCalledWith(
      userId,
      'awaiting_label_confirm',
      expect.objectContaining({
        product: expect.objectContaining({
          name: 'Magic Toast Tradicional',
          brand: 'Marilan',
          caloriesPer100g: 420,
          proteinPer100g: 9,
          carbsPer100g: 72,
          fatPer100g: 10,
        }),
      }),
    )
  })

  it('accepts label input when the brand is the first comma-separated field', async () => {
    const currentContext = context('awaiting_label_input', {
      name: 'Magic Toast Tradicional',
      quantityGrams: 25,
    })

    const result = await handleAwaitingLabelInput(
      userId,
      'Marilan, 420 kcal, proteína 9g, carbo 72g, gordura 10g por 100g',
      currentContext,
    )

    expect(result.completed).toBe(false)
    expect(setState).toHaveBeenCalledWith(
      userId,
      'awaiting_label_confirm',
      expect.objectContaining({
        product: expect.objectContaining({ brand: 'Marilan' }),
      }),
    )
  })

  it('rejects implausible label macros before confirmation', async () => {
    const currentContext = context('awaiting_label_input', {
      name: 'Magic Toast Tradicional',
      quantityGrams: 25,
    })

    const result = await handleAwaitingLabelInput(
      userId,
      'Marilan, 50 kcal, proteína 40g, carbo 40g, gordura 40g por 100g',
      currentContext,
    )

    expect(result.completed).toBe(false)
    expect(result.response).toMatch(/rótulo|rotulo|formato/i)
    expect(setState).not.toHaveBeenCalled()
  })

  it('creates a private user label product when label confirmation is yes', async () => {
    const savedProduct = product({
      id: 'private-label-1',
      source: 'user_label',
      status: 'privado',
      createdBy: userId,
    })
    vi.mocked(createProduct).mockResolvedValue(savedProduct)
    const currentContext = context('awaiting_label_confirm', {
      product: {
        name: 'Magic Toast Tradicional',
        brand: 'Marilan',
        caloriesPer100g: 420,
        proteinPer100g: 9,
        carbsPer100g: 72,
        fatPer100g: 10,
      },
    })

    const result = await handleAwaitingLabelConfirm(supabase, userId, 'sim', currentContext)

    expect(createProduct).toHaveBeenCalledWith(
      supabase,
      expect.objectContaining({
        name: 'Magic Toast Tradicional',
        brand: 'Marilan',
        caloriesPer100g: 420,
        proteinPer100g: 9,
        carbsPer100g: 72,
        fatPer100g: 10,
        source: 'user_label',
        status: 'privado',
        createdBy: userId,
      }),
    )
    expect(recordUsage).toHaveBeenCalledWith(supabase, 'private-label-1', userId)
    expect(clearState).toHaveBeenCalledWith(userId)
    expect(result.productId).toBe('private-label-1')
  })
})
