import { describe, it, expect, vi, beforeAll, afterEach, afterAll } from 'vitest'
import { http, HttpResponse } from 'msw'
import { server } from '../../mocks/server'
import { OllamaProvider } from '@/lib/llm/providers/ollama'

beforeAll(() => server.listen())
afterEach(() => server.resetHandlers())
afterAll(() => server.close())

vi.stubEnv('OLLAMA_BASE_URL', 'http://localhost:11434')
vi.stubEnv('OLLAMA_MODEL_MEAL', 'llama3.1:8b')
vi.stubEnv('OLLAMA_MODEL_CLASSIFY', 'llama3.1:8b')

const validMealAnalysisContent = JSON.stringify({
  meal_type: 'lunch',
  confidence: 'high',
  items: [
    {
      food: 'Arroz',
      quantity_grams: 150,
      quantity_source: 'estimated',
      calories: 195,
      protein: 4,
      carbs: 42,
      fat: 0.5,
    },
  ],
  unknown_items: [],
  needs_clarification: false,
})

const validIntentContent = JSON.stringify({ intent: 'meal_log' })

function makeOllamaResponse(content: string) {
  return {
    message: { content },
  }
}

describe('OllamaProvider', () => {
  describe('analyzeMeal', () => {
    it('returns validated MealAnalysis', async () => {
      server.use(
        http.post('http://localhost:11434/api/chat', () => {
          return HttpResponse.json(makeOllamaResponse(validMealAnalysisContent))
        }),
      )

      const provider = new OllamaProvider()
      const result = await provider.analyzeMeal('almocei arroz', 'approximate')

      expect(result).toHaveLength(1)
      expect(result[0].meal_type).toBe('lunch')
      expect(result[0].confidence).toBe('high')
      expect(result[0].items).toHaveLength(1)
      expect(result[0].items[0].food).toBe('Arroz')
    })

    it('retries once on bad JSON and succeeds on second attempt', async () => {
      let callCount = 0
      server.use(
        http.post('http://localhost:11434/api/chat', () => {
          callCount++
          if (callCount === 1) {
            return HttpResponse.json(makeOllamaResponse('not json at all'))
          }
          return HttpResponse.json(makeOllamaResponse(validMealAnalysisContent))
        }),
      )

      const provider = new OllamaProvider()
      const result = await provider.analyzeMeal('almocei arroz', 'approximate')

      expect(callCount).toBe(2)
      expect(result[0].meal_type).toBe('lunch')
    })

    it('throws after retry fails when both attempts return invalid JSON', async () => {
      server.use(
        http.post('http://localhost:11434/api/chat', () => {
          return HttpResponse.json(makeOllamaResponse('bad json'))
        }),
      )

      const provider = new OllamaProvider()
      await expect(provider.analyzeMeal('test', 'approximate')).rejects.toThrow()
    })

    it('sends format: "json" and stream: false for analyzeMeal', async () => {
      let capturedBody: { format?: string; stream?: boolean } | null = null

      server.use(
        http.post('http://localhost:11434/api/chat', async ({ request }) => {
          capturedBody = (await request.json()) as { format?: string; stream?: boolean }
          return HttpResponse.json(makeOllamaResponse(validMealAnalysisContent))
        }),
      )

      const provider = new OllamaProvider()
      await provider.analyzeMeal('arroz', 'approximate')

      const body = capturedBody as { format?: string; stream?: boolean } | null
      expect(body?.format).toBe('json')
      expect(body?.stream).toBe(false)
    })

    it('does not send Authorization header', async () => {
      let capturedAuthHeader: string | null = 'not-checked'

      server.use(
        http.post('http://localhost:11434/api/chat', ({ request }) => {
          capturedAuthHeader = request.headers.get('Authorization')
          return HttpResponse.json(makeOllamaResponse(validMealAnalysisContent))
        }),
      )

      const provider = new OllamaProvider()
      await provider.analyzeMeal('arroz', 'approximate')

      expect(capturedAuthHeader).toBeNull()
    })
  })

  describe('classifyIntent', () => {
    it('returns correct intent type', async () => {
      server.use(
        http.post('http://localhost:11434/api/chat', () => {
          return HttpResponse.json(makeOllamaResponse(validIntentContent))
        }),
      )

      const provider = new OllamaProvider()
      const result = await provider.classifyIntent('comi um arroz hoje')

      expect(result).toBe('meal_log')
    })

    it('sends format: "json" and stream: false for classifyIntent', async () => {
      let capturedBody: { format?: string; stream?: boolean } | null = null

      server.use(
        http.post('http://localhost:11434/api/chat', async ({ request }) => {
          capturedBody = (await request.json()) as { format?: string; stream?: boolean }
          return HttpResponse.json(makeOllamaResponse(validIntentContent))
        }),
      )

      const provider = new OllamaProvider()
      await provider.classifyIntent('test')

      const body = capturedBody as { format?: string; stream?: boolean } | null
      expect(body?.format).toBe('json')
      expect(body?.stream).toBe(false)
    })
  })

  describe('analyzeImage', () => {
    it('sends multimodal message with images array to vision model', async () => {
      vi.stubEnv('OLLAMA_BASE_URL', 'http://localhost:11434')
      vi.stubEnv('OLLAMA_MODEL_VISION', 'llava:13b')

      const mockResponse = {
        image_type: 'nutrition_label',
        confidence: 'high',
        items: [{ food: 'Granola', quantity_grams: 40, calories: 180, protein: 4, carbs: 28, fat: 6 }],
        unknown_items: [],
        needs_clarification: false,
      }

      const originalFetch = global.fetch
      const mockFetch = vi.fn().mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          message: { content: JSON.stringify(mockResponse) },
        }),
      })

      vi.stubGlobal('fetch', mockFetch)

      try {
        const provider = new OllamaProvider()
        const result = await provider.analyzeImage('data:image/jpeg;base64,abc123', 'tabela nutricional', 'approximate')

        expect(result.image_type).toBe('nutrition_label')
        expect(result.items).toHaveLength(1)

        const [, options] = mockFetch.mock.calls[0] as [string, RequestInit]
        const body = JSON.parse(options.body as string)
        expect(body.model).toBe('llava:13b')
        expect(body.messages[1].images).toBeDefined()
        expect(body.messages[1].images[0]).toBe('abc123') // base64 without prefix
      } finally {
        vi.stubGlobal('fetch', originalFetch)
      }
    })
  })

  describe('chat', () => {
    it('returns raw text response', async () => {
      server.use(
        http.post('http://localhost:11434/api/chat', () => {
          return HttpResponse.json(makeOllamaResponse('Olá! Como posso ajudar?'))
        }),
      )

      const provider = new OllamaProvider()
      const result = await provider.chat('Oi', 'Você é um assistente.')

      expect(result).toBe('Olá! Como posso ajudar?')
    })

    it('does not send format: "json" for chat', async () => {
      let capturedBody: { format?: unknown } | null = null

      server.use(
        http.post('http://localhost:11434/api/chat', async ({ request }) => {
          capturedBody = (await request.json()) as { format?: unknown }
          return HttpResponse.json(makeOllamaResponse('resposta'))
        }),
      )

      const provider = new OllamaProvider()
      await provider.chat('Oi', 'System prompt')

      const body = capturedBody as { format?: unknown } | null
      expect(body?.format).toBeUndefined()
    })
  })
})
