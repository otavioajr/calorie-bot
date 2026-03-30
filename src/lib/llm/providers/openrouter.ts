import { MealAnalysis, MealAnalysisSchema, MultiMealAnalysisSchema } from '../schemas/meal-analysis'
import { ImageAnalysis, ImageAnalysisSchema } from '../schemas/image-analysis'
import { IntentClassificationSchema } from '../schemas/intent'
import { LLMProvider, IntentType } from '../provider'
import { buildAnalyzePrompt } from '../prompts/analyze'
import { buildDecomposePrompt } from '../prompts/decompose'
import { buildClassifyPrompt } from '../prompts/classify'
import { buildVisionPrompt } from '../prompts/vision'
import { DecomposedItem, DecompositionResultSchema } from '../schemas/decomposition'

interface OpenRouterMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

interface OpenRouterRequestBody {
  model: string
  messages: OpenRouterMessage[]
  response_format?: { type: 'json_object' }
  temperature?: number
  provider?: { ignore?: string[] }
}

type ContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } }

interface OpenRouterVisionMessage {
  role: 'system' | 'user' | 'assistant'
  content: string | ContentPart[]
}

interface OpenRouterVisionRequestBody {
  model: string
  messages: OpenRouterVisionMessage[]
  response_format?: { type: 'json_object' }
  temperature?: number
}

interface OpenRouterResponse {
  choices: Array<{
    message: {
      content: string
    }
  }>
}

export class OpenRouterProvider implements LLMProvider {
  private apiKey: string
  private mealModel: string
  private classifyModel: string
  private visionModel: string

  constructor() {
    this.apiKey = process.env.LLM_API_KEY!
    this.mealModel = process.env.LLM_MODEL_MEAL ?? 'openai/gpt-4o-mini'
    this.classifyModel =
      process.env.LLM_MODEL_CLASSIFY ?? 'meta-llama/llama-3.1-8b-instruct:free'
    this.visionModel = process.env.LLM_MODEL_VISION ?? 'openai/gpt-4o'
  }

  async analyzeMeal(message: string, history?: { role: string; content: string }[]): Promise<MealAnalysis[]> {
    const systemPrompt = buildAnalyzePrompt()

    const rawContent = await this.callAPI(this.mealModel, systemPrompt, message, true, history)

    const parsed = this.parseJSON(rawContent)
    const result = this.parseMealResponse(parsed)

    if (result) {
      return result
    }

    // Retry once on validation failure
    const retryContent = await this.callAPI(this.mealModel, systemPrompt, message, true, history)
    const retryParsed = this.parseJSON(retryContent)
    const retryResult = this.parseMealResponse(retryParsed)

    if (retryResult) {
      return retryResult
    }

    throw new Error(
      'MealAnalysis validation failed after retry',
    )
  }

  private parseMealResponse(parsed: unknown): MealAnalysis[] | null {
    // Try multi-meal format first
    const multi = MultiMealAnalysisSchema.safeParse(parsed)
    if (multi.success) {
      return multi.data.meals
    }

    // Fall back to single meal wrapped in array
    const single = MealAnalysisSchema.safeParse(parsed)
    if (single.success) {
      return [single.data]
    }

    return null
  }

  async analyzeImage(
    imageBase64: string,
    caption: string | undefined,
  ): Promise<ImageAnalysis> {
    const systemPrompt = buildVisionPrompt()
    const captionText = caption || 'Analise esta imagem.'

    const rawContent = await this.callVisionAPI(this.visionModel, systemPrompt, imageBase64, captionText)
    const parsed = this.parseJSON(rawContent)
    const validated = ImageAnalysisSchema.safeParse(parsed)

    if (validated.success) {
      return validated.data
    }

    // Retry once on validation failure
    const retryContent = await this.callVisionAPI(this.visionModel, systemPrompt, imageBase64, captionText)
    const retryParsed = this.parseJSON(retryContent)
    const retryValidated = ImageAnalysisSchema.safeParse(retryParsed)

    if (retryValidated.success) {
      return retryValidated.data
    }

    throw new Error(`ImageAnalysis validation failed after retry: ${retryValidated.error.message}`)
  }

  async decomposeMeal(foodName: string, grams: number): Promise<DecomposedItem[]> {
    const systemPrompt = buildDecomposePrompt(foodName, grams)
    const rawContent = await this.callAPI(this.mealModel, systemPrompt, `Decompor: ${foodName} (${grams}g)`, true)
    const parsed = this.parseJSON(rawContent)
    const validated = DecompositionResultSchema.safeParse(parsed)

    if (validated.success) return validated.data.ingredients

    // Retry once
    const retryContent = await this.callAPI(this.mealModel, systemPrompt, `Decompor: ${foodName} (${grams}g)`, true)
    const retryParsed = this.parseJSON(retryContent)
    const retryValidated = DecompositionResultSchema.safeParse(retryParsed)

    if (retryValidated.success) return retryValidated.data.ingredients

    throw new Error('Decomposition validation failed after retry')
  }

  async classifyIntent(message: string): Promise<IntentType> {
    const systemPrompt = buildClassifyPrompt()
    const rawContent = await this.callAPI(this.classifyModel, systemPrompt, message, true)

    const parsed = this.parseJSON(rawContent)
    const validated = IntentClassificationSchema.parse(parsed)

    return validated.intent
  }

  async chat(message: string, systemPrompt: string): Promise<string> {
    return this.callAPI(this.mealModel, systemPrompt, message, false)
  }

  private async callVisionAPI(
    model: string,
    systemPrompt: string,
    imageBase64: string,
    caption: string,
  ): Promise<string> {
    const body: OpenRouterVisionRequestBody = {
      model,
      messages: [
        { role: 'system', content: systemPrompt },
        {
          role: 'user',
          content: [
            { type: 'image_url', image_url: { url: imageBase64 } },
            { type: 'text', text: caption },
          ],
        },
      ],
      response_format: { type: 'json_object' },
      temperature: 0,
    }

    const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'https://caloriebot.vercel.app',
        'X-Title': 'CalorieBot',
      },
      body: JSON.stringify(body),
    })

    if (!response.ok) {
      const errorBody = await response.text()
      console.error(`[OpenRouter] ${response.status} for model ${model}:`, errorBody)
      throw new Error(`OpenRouter API error: ${response.status} ${response.statusText}`)
    }

    const data = await response.json()
    console.log('[OpenRouter] Vision response:', JSON.stringify(data).substring(0, 500))

    const content = data?.choices?.[0]?.message?.content
    if (!content) {
      throw new Error(`OpenRouter returned unexpected format: ${JSON.stringify(data).substring(0, 200)}`)
    }
    return content
  }

  private parseJSON(content: string): unknown {
    try {
      return JSON.parse(content)
    } catch {
      // Some models wrap JSON in markdown code blocks
      const match = content.match(/```(?:json)?\s*([\s\S]*?)```/)
      if (match) {
        try {
          return JSON.parse(match[1].trim())
        } catch {
          return null
        }
      }
      return null
    }
  }

  private async callAPI(
    model: string,
    systemPrompt: string,
    userMessage: string,
    jsonMode: boolean,
    history?: { role: string; content: string }[],
  ): Promise<string> {
    const messages: OpenRouterMessage[] = [
      { role: 'system', content: systemPrompt },
    ]

    if (history && history.length > 0) {
      for (const msg of history) {
        messages.push({ role: msg.role as 'user' | 'assistant', content: msg.content })
      }
    }

    messages.push({ role: 'user', content: userMessage })

    const body: OpenRouterRequestBody = {
      model,
      messages,
    }

    if (jsonMode) {
      body.response_format = { type: 'json_object' }
    }

    body.temperature = 0
    body.provider = {
      ignore: ['Azure'],
    }

    const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'https://caloriebot.vercel.app',
        'X-Title': 'CalorieBot',
      },
      body: JSON.stringify(body),
    })

    if (!response.ok) {
      const errorBody = await response.text()
      console.error(`[OpenRouter] ${response.status} for model ${model}:`, errorBody)
      throw new Error(`OpenRouter API error: ${response.status} ${response.statusText}`)
    }

    const data = await response.json()
    console.log('[OpenRouter] Response:', JSON.stringify(data).substring(0, 500))

    const content = data?.choices?.[0]?.message?.content
    if (!content) {
      throw new Error(`OpenRouter returned unexpected format: ${JSON.stringify(data).substring(0, 200)}`)
    }
    return content
  }
}
