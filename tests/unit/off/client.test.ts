import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockFetch = vi.fn()
vi.stubGlobal('fetch', mockFetch)

import { searchOFFFood } from '@/lib/off/client'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const offValidResponse = {
  products: [
    {
      id: 'abc123',
      product_name: 'Whey Protein Baunilha',
      completeness: 0.8,
      nutriments: {
        'energy-kcal_100g': 400,
        proteins_100g: 80,
        carbohydrates_100g: 10,
        fat_100g: 5,
      },
    },
  ],
}

const offMissingFatResponse = {
  products: [
    {
      id: 'def456',
      product_name: 'Produto Incompleto',
      completeness: 0.7,
      nutriments: {
        'energy-kcal_100g': 200,
        proteins_100g: 10,
        carbohydrates_100g: 30,
        // fat_100g ausente
      },
    },
  ],
}

const offLowCompletenessResponse = {
  products: [
    {
      id: 'ghi789',
      product_name: 'Produto Raso',
      completeness: 0.3,
      nutriments: {
        'energy-kcal_100g': 300,
        proteins_100g: 15,
        carbohydrates_100g: 40,
        fat_100g: 8,
      },
    },
  ],
}

const offEmptyResponse = { products: [] }

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('searchOFFFood', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('retorna OFFResult corretamente escalado para a quantidade informada', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => offValidResponse,
    })

    const result = await searchOFFFood('Whey protein', 30)

    expect(result).not.toBeNull()
    expect(result!.food).toBe('Whey protein')
    expect(result!.offFoodName).toBe('Whey Protein Baunilha')
    expect(result!.offId).toBe('abc123')
    expect(result!.calories).toBe(120)   // 400 * 30/100 = 120
    expect(result!.protein).toBe(24)     // 80 * 0.3 = 24
    expect(result!.carbs).toBe(3)        // 10 * 0.3 = 3
    expect(result!.fat).toBe(1.5)        // 5 * 0.3 = 1.5
  })

  it('envia o User-Agent obrigatório na requisição', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => offValidResponse,
    })

    await searchOFFFood('Arroz branco', 100)

    const [, options] = mockFetch.mock.calls[0]
    expect(options.headers['User-Agent']).toContain('CalorieBot')
  })

  it('ignora resultado sem fat_100g e retorna null quando nenhum válido', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => offMissingFatResponse,
    })

    const result = await searchOFFFood('Produto incompleto', 100)

    expect(result).toBeNull()
  })

  it('ignora resultado com completeness < 0.5 e retorna null', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => offLowCompletenessResponse,
    })

    const result = await searchOFFFood('Produto raso', 100)

    expect(result).toBeNull()
  })

  it('retorna null quando a lista de produtos está vazia', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => offEmptyResponse,
    })

    const result = await searchOFFFood('Comida inexistente', 100)

    expect(result).toBeNull()
  })

  it('retorna null quando a API retorna status HTTP não-2xx', async () => {
    mockFetch.mockResolvedValue({ ok: false, status: 503 })

    const result = await searchOFFFood('whey', 30)

    expect(result).toBeNull()
  })

  it('retorna null quando fetch lança exceção (timeout, rede)', async () => {
    mockFetch.mockRejectedValue(new Error('Network error'))

    const result = await searchOFFFood('whey', 30)

    expect(result).toBeNull()
  })
})
