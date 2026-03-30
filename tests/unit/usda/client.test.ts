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

  it('translates PT-BR food name to English via LLM', async () => {
    mockChat.mockResolvedValue('whey protein')

    const result = await translateFoodName('Proteína de soro de leite')

    expect(mockChat).toHaveBeenCalledWith(
      'Proteína de soro de leite',
      expect.stringContaining('Translate'),
    )
    expect(result).toBe('whey protein')
  })

  it('trims whitespace from LLM response', async () => {
    mockChat.mockResolvedValue('  whey protein  \n')

    const result = await translateFoodName('Proteína de soro de leite')

    expect(result).toBe('whey protein')
  })

  it('returns original name if translation fails', async () => {
    mockChat.mockRejectedValue(new Error('LLM error'))

    const result = await translateFoodName('Creatina')

    expect(result).toBe('Creatina')
  })
})

// Add at top level, after existing imports:
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
        // missing protein, carbs, fat
      ],
    },
  ],
}

describe('searchUSDAFood', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockChat.mockResolvedValue('whey protein')
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
    expect(result!.calories).toBe(120) // 400 * 30/100
    expect(result!.protein).toBe(24)   // 80 * 30/100
    expect(result!.carbs).toBe(3)      // 10 * 30/100
    expect(result!.fat).toBe(1.5)      // 5 * 30/100
    expect(result!.food).toBe('Proteína de soro de leite')
    expect(result!.usdaFoodName).toBe('Whey protein powder, vanilla')
  })

  it('calls USDA API with translated name and correct params', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => usdaWheyResponse,
    })

    await searchUSDAFood('Proteína de soro de leite', 30)

    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining('api.nal.usda.gov/fdc/v1/foods/search'),
      expect.objectContaining({
        signal: expect.any(AbortSignal),
      }),
    )
    const calledUrl = mockFetch.mock.calls[0][0] as string
    expect(calledUrl).toContain('query=whey+protein')
    expect(calledUrl).toContain('api_key=test-key')
    expect(calledUrl).toContain('pageSize=5')
  })

  it('returns null when USDA returns no results', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => usdaEmptyResponse,
    })

    const result = await searchUSDAFood('Comida inventada', 100)

    expect(result).toBeNull()
  })

  it('returns null when USDA results lack complete nutrients', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => usdaIncompleteNutrientsResponse,
    })

    const result = await searchUSDAFood('Some food', 100)

    expect(result).toBeNull()
  })

  it('returns null when API call fails', async () => {
    mockFetch.mockRejectedValue(new Error('Network error'))

    const result = await searchUSDAFood('Whey protein', 30)

    expect(result).toBeNull()
  })

  it('returns null when API returns non-OK status', async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 429,
    })

    const result = await searchUSDAFood('Whey protein', 30)

    expect(result).toBeNull()
  })

  it('returns null when USDA_API_KEY is not set', async () => {
    delete process.env.USDA_API_KEY

    const result = await searchUSDAFood('Whey protein', 30)

    expect(result).toBeNull()
  })
})
