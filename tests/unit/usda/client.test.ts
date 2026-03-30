import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockChat = vi.fn()

vi.mock('@/lib/llm/index', () => ({
  getLLMProvider: vi.fn(() => ({
    chat: mockChat,
    analyzeMeal: vi.fn(),
    classifyIntent: vi.fn(),
    decomposeMeal: vi.fn(),
    analyzeImage: vi.fn(),
  })),
}))

// Must import after mock
import { translateFoodName, searchUSDAFood } from '@/lib/usda/client'

describe('translateFoodName', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('uses static dictionary for known terms (no LLM call)', async () => {
    const result = await translateFoodName('Proteína de soro de leite')

    expect(result).toBe('whey protein powder')
    expect(mockChat).not.toHaveBeenCalled()
  })

  it('static lookup is case-insensitive', async () => {
    const result = await translateFoodName('CREATINA')

    expect(result).toBe('creatine supplement')
    expect(mockChat).not.toHaveBeenCalled()
  })

  it('falls back to LLM for unknown terms', async () => {
    mockChat.mockResolvedValue('tapioca flour')

    const result = await translateFoodName('farinha de tapioca')

    expect(mockChat).toHaveBeenCalledWith(
      'farinha de tapioca',
      expect.stringContaining('Translate'),
    )
    expect(result).toBe('tapioca flour')
  })

  it('returns null if LLM fails for unknown term', async () => {
    mockChat.mockRejectedValue(new Error('LLM error'))

    const result = await translateFoodName('comida desconhecida')

    expect(result).toBeNull()
  })

  it('returns null if LLM returns same text as input', async () => {
    mockChat.mockResolvedValue('salgadinho')

    const result = await translateFoodName('salgadinho')

    expect(result).toBeNull()
  })
})

const mockFetch = vi.fn()
vi.stubGlobal('fetch', mockFetch)

// USDA API response fixture
const usdaWheyResponse = {
  foods: [
    {
      fdcId: 456789,
      description: 'Whey protein powder, vanilla',
      foodNutrients: [
        { nutrientId: 1008, value: 400 },
        { nutrientId: 1003, value: 80 },
        { nutrientId: 1005, value: 10 },
        { nutrientId: 1004, value: 5 },
      ],
    },
  ],
}

const usdaEmptyResponse = { foods: [] }

const usdaIncompleteNutrientsResponse = {
  foods: [
    {
      fdcId: 111,
      description: 'Some food',
      foodNutrients: [
        { nutrientId: 1008, value: 200 },
      ],
    },
  ],
}

describe('searchUSDAFood', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    process.env.USDA_API_KEY = 'test-key'
  })

  it('returns macros scaled to quantity when USDA finds a match', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => usdaWheyResponse,
    })

    const result = await searchUSDAFood('Proteína de soro de leite', 30)

    expect(result).not.toBeNull()
    expect(result!.fdcId).toBe(456789)
    expect(result!.calories).toBe(120)
    expect(result!.protein).toBe(24)
    expect(result!.carbs).toBe(3)
    expect(result!.fat).toBe(1.5)
    expect(result!.food).toBe('Proteína de soro de leite')
    expect(result!.usdaFoodName).toBe('Whey protein powder, vanilla')
  })

  it('uses static dictionary translation for known foods', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => usdaWheyResponse,
    })

    await searchUSDAFood('Proteína de soro de leite', 30)

    // Should use dictionary (no LLM call), then search USDA
    expect(mockChat).not.toHaveBeenCalled()
    expect(mockFetch).toHaveBeenCalledTimes(1)
    const calledUrl = mockFetch.mock.calls[0][0] as string
    expect(calledUrl).toContain('query=whey+protein+powder')
  })

  it('uses LLM translation for unknown foods', async () => {
    mockChat.mockResolvedValue('tapioca flour')
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => usdaWheyResponse,
    })

    await searchUSDAFood('farinha de tapioca', 100)

    expect(mockChat).toHaveBeenCalled()
    expect(mockFetch).toHaveBeenCalledTimes(1)
    const calledUrl = mockFetch.mock.calls[0][0] as string
    expect(calledUrl).toContain('query=tapioca+flour')
  })

  it('returns null when USDA returns no results', async () => {
    mockChat.mockResolvedValue('invented food')
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => usdaEmptyResponse,
    })

    const result = await searchUSDAFood('Comida inventada', 100)

    expect(result).toBeNull()
  })

  it('returns null when USDA results lack complete nutrients', async () => {
    mockChat.mockResolvedValue('some food')
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => usdaIncompleteNutrientsResponse,
    })

    const result = await searchUSDAFood('Some food', 100)

    expect(result).toBeNull()
  })

  it('returns null when API call fails', async () => {
    mockFetch.mockRejectedValue(new Error('Network error'))

    const result = await searchUSDAFood('whey', 30)

    expect(result).toBeNull()
  })

  it('returns null when API returns non-OK status', async () => {
    mockFetch.mockResolvedValue({ ok: false, status: 429 })

    const result = await searchUSDAFood('whey', 30)

    expect(result).toBeNull()
  })

  it('returns null when USDA_API_KEY is not set', async () => {
    delete process.env.USDA_API_KEY

    const result = await searchUSDAFood('whey', 30)

    expect(result).toBeNull()
  })

  it('returns null when LLM translation fails for unknown term', async () => {
    mockChat.mockRejectedValue(new Error('LLM error'))

    const result = await searchUSDAFood('comida desconhecida', 30)

    expect(result).toBeNull()
    expect(mockFetch).not.toHaveBeenCalled()
  })
})
