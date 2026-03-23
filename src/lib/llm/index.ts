import { LLMProvider } from './provider'
import { OpenRouterProvider } from './providers/openrouter'
import { OllamaProvider } from './providers/ollama'

export function getLLMProvider(): LLMProvider {
  const provider = process.env.LLM_PROVIDER || 'openrouter'
  const fallbackProvider = process.env.LLM_FALLBACK_PROVIDER

  let primary: LLMProvider
  switch (provider) {
    case 'openrouter':
      primary = new OpenRouterProvider()
      break
    case 'ollama':
      primary = new OllamaProvider()
      break
    default:
      throw new Error(`Unknown LLM provider: ${provider}`)
  }

  if (!fallbackProvider) {
    return primary
  }

  // Wrap with fallback
  let fallback: LLMProvider
  switch (fallbackProvider) {
    case 'openrouter':
      fallback = new OpenRouterProvider()
      break
    case 'ollama':
      fallback = new OllamaProvider()
      break
    default:
      throw new Error(`Unknown fallback LLM provider: ${fallbackProvider}`)
  }

  return createFallbackProxy(primary, fallback)
}

function createFallbackProxy(primary: LLMProvider, fallback: LLMProvider): LLMProvider {
  // Returns a proxy that tries primary first, falls back on error
  return {
    async analyzeMeal(...args) {
      try {
        return await primary.analyzeMeal(...args)
      } catch {
        return await fallback.analyzeMeal(...args)
      }
    },
    async analyzeImage(...args) {
      try {
        return await primary.analyzeImage(...args)
      } catch {
        return await fallback.analyzeImage(...args)
      }
    },
    async classifyIntent(...args) {
      try {
        return await primary.classifyIntent(...args)
      } catch {
        return await fallback.classifyIntent(...args)
      }
    },
    async chat(...args) {
      try {
        return await primary.chat(...args)
      } catch {
        return await fallback.chat(...args)
      }
    },
  }
}
