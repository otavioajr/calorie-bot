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
      calories: null,
      protein: null,
      carbs: null,
      fat: null,
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
      const result = await provider.analyzeMeal('almocei arroz')

      expect(result).toHaveLength(1)
      expect(result[0].meal_type).toBe('lunch')
      expect(result[0].confidence).toBe('high')
      expect(result[0].items).toHaveLength(1)
      expect(result[0].items[0].food).toBe('Arroz')
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
      const result = await provider.analyzeMeal('almocei arroz')

      expect(callCount).toBe(2)
      expect(result[0].meal_type).toBe('lunch')
    })

    it('throws after retry fails when both attempts return invalid JSON', async () => {
      server.use(
        http.post('https://openrouter.ai/api/v1/chat/completions', () => {
          return HttpResponse.json(makeOpenRouterResponse('bad json'))
        }),
      )

      const provider = new OpenRouterProvider()
      await expect(provider.analyzeMeal('test')).rejects.toThrow()
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
      await provider.analyzeMeal('almocei arroz')

      expect(capturedHeaders.authorization).toBe('Bearer test-key')
      expect(capturedHeaders.referer).toBe('https://caloriebot.vercel.app')
      expect(capturedHeaders.title).toBe('CalorieBot')
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
      await provider.analyzeMeal('arroz')

      const body = capturedBody as { response_format?: { type: string } } | null
      expect(body?.response_format).toEqual({ type: 'json_object' })
    })

    it('passes conversation history to the LLM', async () => {
      let capturedBody: {
        messages: Array<{ role: string; content: string }>
      } | null = null

      server.use(
        http.post('https://openrouter.ai/api/v1/chat/completions', async ({ request }) => {
          capturedBody = (await request.json()) as typeof capturedBody
          return HttpResponse.json(makeOpenRouterResponse(validMealAnalysisContent))
        }),
      )

      const provider = new OpenRouterProvider()
      const history = [
        { role: 'user', content: 'almocei arroz' },
        { role: 'assistant', content: 'ok' },
      ]
      await provider.analyzeMeal('e feijão também', history)

      expect(capturedBody).not.toBeNull()
      // history messages should be in the request
      const messages = capturedBody!.messages
      expect(messages.length).toBeGreaterThan(2) // system + history + user
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

      const body = capturedBody as { model: string } | null
      expect(body?.model).toBe('meta-llama/llama-3.1-8b-instruct:free')
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

      const body = capturedBody as { response_format?: { type: string } } | null
      expect(body?.response_format).toEqual({ type: 'json_object' })
    })
  })

  describe('analyzeImage', () => {
    it('sends multimodal message with image_url and text to vision model', async () => {
      vi.stubEnv('LLM_MODEL_VISION', 'openai/gpt-4o')

      const mockImageResponse = JSON.stringify({
        image_type: 'food',
        meal_type: 'lunch',
        confidence: 'high',
        items: [{ food: 'Rice', quantity_grams: 150, calories: 195, protein: 4, carbs: 42, fat: 0.5 }],
        unknown_items: [],
        needs_clarification: false,
      })

      let capturedBody: {
        model: string
        messages: Array<{ role: string; content: unknown }>
      } | null = null

      server.use(
        http.post('https://openrouter.ai/api/v1/chat/completions', async ({ request }) => {
          capturedBody = (await request.json()) as typeof capturedBody
          return HttpResponse.json(makeOpenRouterResponse(mockImageResponse))
        }),
      )

      const provider = new OpenRouterProvider()
      const result = await provider.analyzeImage('data:image/jpeg;base64,abc123', 'meu almoço')

      expect(result.image_type).toBe('food')
      expect(result.items).toHaveLength(1)

      expect(capturedBody).not.toBeNull()
      expect(capturedBody!.model).toBe('openai/gpt-4o')

      const userMsg = capturedBody!.messages[1]
      expect(Array.isArray(userMsg.content)).toBe(true)
      const contentParts = userMsg.content as Array<{ type: string; text?: string }>
      expect(contentParts[0].type).toBe('image_url')
      expect(contentParts[1].type).toBe('text')
      expect(contentParts[1].text).toBe('meu almoço')
    })

    it('uses default text when no caption provided', async () => {
      vi.stubEnv('LLM_MODEL_VISION', 'openai/gpt-4o')

      const mockImageResponse = JSON.stringify({
        image_type: 'food',
        confidence: 'low',
        items: [],
        needs_clarification: true,
        clarification_question: 'Não consegui identificar.',
      })

      let capturedBody: {
        messages: Array<{ role: string; content: unknown }>
      } | null = null

      server.use(
        http.post('https://openrouter.ai/api/v1/chat/completions', async ({ request }) => {
          capturedBody = (await request.json()) as typeof capturedBody
          return HttpResponse.json(makeOpenRouterResponse(mockImageResponse))
        }),
      )

      const provider = new OpenRouterProvider()
      const result = await provider.analyzeImage('data:image/jpeg;base64,abc123', undefined)

      expect(result.needs_clarification).toBe(true)

      expect(capturedBody).not.toBeNull()
      const userMsg = capturedBody!.messages[1]
      const contentParts = userMsg.content as Array<{ type: string; text?: string }>
      expect(contentParts[1].text).toBe('Analise esta imagem.')
    })
  })

  describe('decomposeMeal', () => {
    it('decomposes a composite food into ingredients', async () => {
      const mockDecomposition = JSON.stringify({
        ingredients: [
          { food: 'Farinha de trigo', quantity_grams: 40 },
          { food: 'Frango desfiado', quantity_grams: 60 },
        ],
      })

      server.use(
        http.post('https://openrouter.ai/api/v1/chat/completions', () => {
          return HttpResponse.json(makeOpenRouterResponse(mockDecomposition))
        }),
      )

      const provider = new OpenRouterProvider()
      const result = await provider.decomposeMeal('coxinha', 120)

      expect(result).toHaveLength(2)
      expect(result[0].food).toBe('Farinha de trigo')
      expect(result[0].quantity_grams).toBe(40)
      expect(result[1].food).toBe('Frango desfiado')
      expect(result[1].quantity_grams).toBe(60)
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

      const body = capturedBody as { response_format?: unknown } | null
      expect(body?.response_format).toBeUndefined()
    })
  })
})
