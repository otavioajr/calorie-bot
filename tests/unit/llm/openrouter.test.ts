import { describe, it, expect, vi, beforeAll, afterEach, afterAll } from 'vitest'
import { http, HttpResponse } from 'msw'
import { server } from '../../mocks/server'
import { OpenRouterProvider } from '@/lib/llm/providers/openrouter'

beforeAll(() => server.listen())
afterEach(() => server.resetHandlers())
afterAll(() => server.close())

vi.stubEnv('LLM_API_KEY', 'test-key')
vi.stubEnv('LLM_MODEL_MEAL', 'openai/gpt-4o-mini')
vi.stubEnv('LLM_MODEL_CLASSIFY', 'meta-llama/llama-3.1-8b-instruct:free')

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

function makeOpenRouterResponse(content: string) {
  return {
    choices: [{ message: { content } }],
  }
}

describe('OpenRouterProvider', () => {
  describe('analyzeMeal', () => {
    it('sends correct request and returns validated MealAnalysis', async () => {
      server.use(
        http.post('https://openrouter.ai/api/v1/chat/completions', () => {
          return HttpResponse.json(makeOpenRouterResponse(validMealAnalysisContent))
        }),
      )

      const provider = new OpenRouterProvider()
      const result = await provider.analyzeMeal('almocei arroz', 'approximate')

      expect(result.meal_type).toBe('lunch')
      expect(result.confidence).toBe('high')
      expect(result.items).toHaveLength(1)
      expect(result.items[0].food).toBe('Arroz')
    })

    it('retries once on invalid JSON and succeeds on second attempt', async () => {
      let callCount = 0
      server.use(
        http.post('https://openrouter.ai/api/v1/chat/completions', () => {
          callCount++
          if (callCount === 1) {
            return HttpResponse.json(makeOpenRouterResponse('not json at all'))
          }
          return HttpResponse.json(makeOpenRouterResponse(validMealAnalysisContent))
        }),
      )

      const provider = new OpenRouterProvider()
      const result = await provider.analyzeMeal('almocei arroz', 'approximate')

      expect(callCount).toBe(2)
      expect(result.meal_type).toBe('lunch')
    })

    it('throws after retry fails when both attempts return invalid JSON', async () => {
      server.use(
        http.post('https://openrouter.ai/api/v1/chat/completions', () => {
          return HttpResponse.json(makeOpenRouterResponse('bad json'))
        }),
      )

      const provider = new OpenRouterProvider()
      await expect(provider.analyzeMeal('test', 'approximate')).rejects.toThrow()
    })

    it('sends correct headers: Authorization, HTTP-Referer, X-Title', async () => {
      let capturedHeaders: Record<string, string> = {}

      server.use(
        http.post('https://openrouter.ai/api/v1/chat/completions', ({ request }) => {
          capturedHeaders = {
            authorization: request.headers.get('Authorization') ?? '',
            referer: request.headers.get('HTTP-Referer') ?? '',
            title: request.headers.get('X-Title') ?? '',
          }
          return HttpResponse.json(makeOpenRouterResponse(validMealAnalysisContent))
        }),
      )

      const provider = new OpenRouterProvider()
      await provider.analyzeMeal('almocei arroz', 'approximate')

      expect(capturedHeaders.authorization).toBe('Bearer test-key')
      expect(capturedHeaders.referer).toBe('https://caloriebot.vercel.app')
      expect(capturedHeaders.title).toBe('CalorieBot')
    })

    it('uses taco prompt when mode is taco', async () => {
      let capturedBody: { model: string; messages: Array<{ role: string; content: string }> } | null =
        null

      server.use(
        http.post('https://openrouter.ai/api/v1/chat/completions', async ({ request }) => {
          capturedBody = (await request.json()) as {
            model: string
            messages: Array<{ role: string; content: string }>
          }
          return HttpResponse.json(makeOpenRouterResponse(validMealAnalysisContent))
        }),
      )

      const provider = new OpenRouterProvider()
      const tacoContext = [
        {
          id: 1,
          foodName: 'Arroz branco cozido',
          caloriesPer100g: 128,
          proteinPer100g: 2.5,
          carbsPer100g: 28.1,
          fatPer100g: 0.2,
        },
      ]
      await provider.analyzeMeal('arroz', 'taco', tacoContext)

      expect(capturedBody).not.toBeNull()
      const systemMessage = capturedBody!.messages.find((m) => m.role === 'system')
      expect(systemMessage?.content).toContain('TACO')
    })

    it('sends response_format json_object for analyzeMeal', async () => {
      let capturedBody: { response_format?: { type: string } } | null = null

      server.use(
        http.post('https://openrouter.ai/api/v1/chat/completions', async ({ request }) => {
          capturedBody = (await request.json()) as { response_format?: { type: string } }
          return HttpResponse.json(makeOpenRouterResponse(validMealAnalysisContent))
        }),
      )

      const provider = new OpenRouterProvider()
      await provider.analyzeMeal('arroz', 'approximate')

      expect(capturedBody?.response_format).toEqual({ type: 'json_object' })
    })
  })

  describe('classifyIntent', () => {
    it('returns correct intent type', async () => {
      server.use(
        http.post('https://openrouter.ai/api/v1/chat/completions', () => {
          return HttpResponse.json(makeOpenRouterResponse(validIntentContent))
        }),
      )

      const provider = new OpenRouterProvider()
      const result = await provider.classifyIntent('comi um arroz hoje')

      expect(result).toBe('meal_log')
    })

    it('uses classify model, not meal model', async () => {
      let capturedBody: { model: string } | null = null

      server.use(
        http.post('https://openrouter.ai/api/v1/chat/completions', async ({ request }) => {
          capturedBody = (await request.json()) as { model: string }
          return HttpResponse.json(makeOpenRouterResponse(validIntentContent))
        }),
      )

      const provider = new OpenRouterProvider()
      await provider.classifyIntent('help me')

      expect(capturedBody?.model).toBe('meta-llama/llama-3.1-8b-instruct:free')
    })

    it('sends response_format json_object for classifyIntent', async () => {
      let capturedBody: { response_format?: { type: string } } | null = null

      server.use(
        http.post('https://openrouter.ai/api/v1/chat/completions', async ({ request }) => {
          capturedBody = (await request.json()) as { response_format?: { type: string } }
          return HttpResponse.json(makeOpenRouterResponse(validIntentContent))
        }),
      )

      const provider = new OpenRouterProvider()
      await provider.classifyIntent('test')

      expect(capturedBody?.response_format).toEqual({ type: 'json_object' })
    })
  })

  describe('chat', () => {
    it('returns raw text response', async () => {
      server.use(
        http.post('https://openrouter.ai/api/v1/chat/completions', () => {
          return HttpResponse.json(makeOpenRouterResponse('Olá! Como posso ajudar?'))
        }),
      )

      const provider = new OpenRouterProvider()
      const result = await provider.chat('Oi', 'Você é um assistente.')

      expect(result).toBe('Olá! Como posso ajudar?')
    })

    it('does not send response_format for chat', async () => {
      let capturedBody: { response_format?: unknown } | null = null

      server.use(
        http.post('https://openrouter.ai/api/v1/chat/completions', async ({ request }) => {
          capturedBody = (await request.json()) as { response_format?: unknown }
          return HttpResponse.json(makeOpenRouterResponse('resposta'))
        }),
      )

      const provider = new OpenRouterProvider()
      await provider.chat('Oi', 'System prompt')

      expect(capturedBody?.response_format).toBeUndefined()
    })
  })
})
