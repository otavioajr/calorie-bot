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

      expect(result.meal_type).toBe('lunch')
      expect(result.confidence).toBe('high')
      expect(result.items).toHaveLength(1)
      expect(result.items[0].food).toBe('Arroz')
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
      expect(result.meal_type).toBe('lunch')
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

      expect(capturedBody?.format).toBe('json')
      expect(capturedBody?.stream).toBe(false)
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

      expect(capturedBody?.format).toBe('json')
      expect(capturedBody?.stream).toBe(false)
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

      expect(capturedBody?.format).toBeUndefined()
    })
  })
})
