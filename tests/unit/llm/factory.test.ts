import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { LLMProvider } from '@/lib/llm/provider'

// Mock the provider modules before importing them
vi.mock('@/lib/llm/providers/openrouter')
vi.mock('@/lib/llm/providers/ollama')

import { OpenRouterProvider } from '@/lib/llm/providers/openrouter'
import { OllamaProvider } from '@/lib/llm/providers/ollama'

const MockOpenRouterProvider = vi.mocked(OpenRouterProvider)
const MockOllamaProvider = vi.mocked(OllamaProvider)

// Helper: build a mock LLMProvider instance
function makeMockProvider(overrides: Partial<LLMProvider> = {}): LLMProvider {
  return {
    analyzeMeal: vi.fn().mockResolvedValue({ items: [] }),
    classifyIntent: vi.fn().mockResolvedValue('meal_log'),
    chat: vi.fn().mockResolvedValue('response'),
    ...overrides,
  }
}

// Vitest v4 requires a class keyword when mocking constructors called with `new`
function setupConstructorMock(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  MockClass: { mockImplementation: (impl: any) => void },
  instance: LLMProvider,
) {
  MockClass.mockImplementation(
    class {
      analyzeMeal = instance.analyzeMeal
      classifyIntent = instance.classifyIntent
      chat = instance.chat
    },
  )
}

describe('getLLMProvider', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.unstubAllEnvs()
    MockOpenRouterProvider.mockReset()
    MockOllamaProvider.mockReset()
  })

  it('returns OpenRouterProvider when LLM_PROVIDER=openrouter', async () => {
    vi.stubEnv('LLM_PROVIDER', 'openrouter')
    vi.stubEnv('LLM_FALLBACK_PROVIDER', '')

    const mockInstance = makeMockProvider()
    setupConstructorMock(MockOpenRouterProvider, mockInstance)

    const { getLLMProvider } = await import('@/lib/llm/index')
    const provider = getLLMProvider()

    expect(MockOpenRouterProvider).toHaveBeenCalledOnce()
    // Provider should have the same methods as the mock instance
    expect(provider.analyzeMeal).toBe(mockInstance.analyzeMeal)
    expect(provider.classifyIntent).toBe(mockInstance.classifyIntent)
    expect(provider.chat).toBe(mockInstance.chat)
  })

  it('returns OllamaProvider when LLM_PROVIDER=ollama', async () => {
    vi.stubEnv('LLM_PROVIDER', 'ollama')
    vi.stubEnv('LLM_FALLBACK_PROVIDER', '')

    const mockInstance = makeMockProvider()
    setupConstructorMock(MockOllamaProvider, mockInstance)

    const { getLLMProvider } = await import('@/lib/llm/index')
    const provider = getLLMProvider()

    expect(MockOllamaProvider).toHaveBeenCalledOnce()
    expect(provider.analyzeMeal).toBe(mockInstance.analyzeMeal)
  })

  it('throws on unknown provider', async () => {
    vi.stubEnv('LLM_PROVIDER', 'unknown-provider')
    vi.stubEnv('LLM_FALLBACK_PROVIDER', '')

    const { getLLMProvider } = await import('@/lib/llm/index')

    expect(() => getLLMProvider()).toThrow('Unknown LLM provider: unknown-provider')
  })

  it('returns direct provider when no fallback configured', async () => {
    vi.stubEnv('LLM_PROVIDER', 'openrouter')
    vi.stubEnv('LLM_FALLBACK_PROVIDER', '')

    const mockInstance = makeMockProvider()
    setupConstructorMock(MockOpenRouterProvider, mockInstance)

    const { getLLMProvider } = await import('@/lib/llm/index')
    getLLMProvider()

    // Only OpenRouter should be created; no Ollama
    expect(MockOpenRouterProvider).toHaveBeenCalledOnce()
    expect(MockOllamaProvider).not.toHaveBeenCalled()
  })

  describe('with fallback', () => {
    it('returns result from primary on success', async () => {
      vi.stubEnv('LLM_PROVIDER', 'openrouter')
      vi.stubEnv('LLM_FALLBACK_PROVIDER', 'ollama')

      const expectedResult = 'meal_log' as const
      const primaryClassifyFn = vi.fn().mockResolvedValue(expectedResult)
      const fallbackClassifyFn = vi.fn().mockResolvedValue('help' as const)

      const primaryInstance = makeMockProvider({ classifyIntent: primaryClassifyFn })
      const fallbackInstance = makeMockProvider({ classifyIntent: fallbackClassifyFn })

      setupConstructorMock(MockOpenRouterProvider, primaryInstance)
      setupConstructorMock(MockOllamaProvider, fallbackInstance)

      const { getLLMProvider } = await import('@/lib/llm/index')
      const provider = getLLMProvider()

      const result = await provider.classifyIntent('test message')

      expect(result).toBe(expectedResult)
      expect(primaryClassifyFn).toHaveBeenCalledWith('test message')
      expect(fallbackClassifyFn).not.toHaveBeenCalled()
    })

    it('falls back when primary throws', async () => {
      vi.stubEnv('LLM_PROVIDER', 'openrouter')
      vi.stubEnv('LLM_FALLBACK_PROVIDER', 'ollama')

      const fallbackResponse = 'summary' as const
      const primaryClassifyFn = vi.fn().mockRejectedValue(new Error('Primary failed'))
      const fallbackClassifyFn = vi.fn().mockResolvedValue(fallbackResponse)

      const primaryInstance = makeMockProvider({ classifyIntent: primaryClassifyFn })
      const fallbackInstance = makeMockProvider({ classifyIntent: fallbackClassifyFn })

      setupConstructorMock(MockOpenRouterProvider, primaryInstance)
      setupConstructorMock(MockOllamaProvider, fallbackInstance)

      const { getLLMProvider } = await import('@/lib/llm/index')
      const provider = getLLMProvider()

      const result = await provider.classifyIntent('test message')

      expect(result).toBe(fallbackResponse)
      expect(primaryClassifyFn).toHaveBeenCalledWith('test message')
      expect(fallbackClassifyFn).toHaveBeenCalledWith('test message')
    })

    it('throws if both primary and fallback fail', async () => {
      vi.stubEnv('LLM_PROVIDER', 'openrouter')
      vi.stubEnv('LLM_FALLBACK_PROVIDER', 'ollama')

      const primaryChatFn = vi.fn().mockRejectedValue(new Error('Primary failed'))
      const fallbackChatFn = vi.fn().mockRejectedValue(new Error('Fallback also failed'))

      const primaryInstance = makeMockProvider({ chat: primaryChatFn })
      const fallbackInstance = makeMockProvider({ chat: fallbackChatFn })

      setupConstructorMock(MockOpenRouterProvider, primaryInstance)
      setupConstructorMock(MockOllamaProvider, fallbackInstance)

      const { getLLMProvider } = await import('@/lib/llm/index')
      const provider = getLLMProvider()

      await expect(provider.chat('hello', 'system')).rejects.toThrow('Fallback also failed')
    })

    it('throws on unknown fallback provider', async () => {
      vi.stubEnv('LLM_PROVIDER', 'openrouter')
      vi.stubEnv('LLM_FALLBACK_PROVIDER', 'unknown-fallback')

      const mockInstance = makeMockProvider()
      setupConstructorMock(MockOpenRouterProvider, mockInstance)

      const { getLLMProvider } = await import('@/lib/llm/index')

      expect(() => getLLMProvider()).toThrow('Unknown fallback LLM provider: unknown-fallback')
    })
  })
})

describe('logLLMUsage', () => {
  it('inserts entry with snake_case columns', async () => {
    const { logLLMUsage } = await import('@/lib/db/queries/llm-usage')

    const insertFn = vi.fn(() => Promise.resolve({ data: null, error: null }))
    const mockSupabase = {
      from: vi.fn(() => ({ insert: insertFn })),
    }

    await logLLMUsage(mockSupabase as never, {
      userId: 'user-123',
      provider: 'openrouter',
      model: 'openai/gpt-4o-mini',
      functionType: 'meal_analysis',
      tokensInput: 100,
      tokensOutput: 200,
      costUsd: 0.0005,
      latencyMs: 350,
      success: true,
    })

    expect(mockSupabase.from).toHaveBeenCalledWith('llm_usage_log')
    expect(insertFn).toHaveBeenCalledWith({
      user_id: 'user-123',
      provider: 'openrouter',
      model: 'openai/gpt-4o-mini',
      function_type: 'meal_analysis',
      tokens_input: 100,
      tokens_output: 200,
      cost_usd: 0.0005,
      latency_ms: 350,
      success: true,
    })
  })

  it('inserts entry without optional fields when not provided', async () => {
    const { logLLMUsage } = await import('@/lib/db/queries/llm-usage')

    const insertFn = vi.fn(() => Promise.resolve({ data: null, error: null }))
    const mockSupabase = {
      from: vi.fn(() => ({ insert: insertFn })),
    }

    await logLLMUsage(mockSupabase as never, {
      provider: 'ollama',
      model: 'llama3.1:8b',
      functionType: 'chat',
      latencyMs: 500,
      success: false,
    })

    expect(insertFn).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: 'ollama',
        model: 'llama3.1:8b',
        function_type: 'chat',
        latency_ms: 500,
        success: false,
      }),
    )
    // Optional fields should not be present when not provided
    const callArg = (insertFn.mock.calls as unknown as [Record<string, unknown>][])[0][0]
    expect(callArg).not.toHaveProperty('user_id')
    expect(callArg).not.toHaveProperty('tokens_input')
    expect(callArg).not.toHaveProperty('tokens_output')
    expect(callArg).not.toHaveProperty('cost_usd')
  })
})
