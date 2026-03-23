import { MealAnalysis, MealAnalysisSchema } from '../schemas/meal-analysis'
import { ImageAnalysis, ImageAnalysisSchema } from '../schemas/image-analysis'
import { IntentClassificationSchema } from '../schemas/intent'
import { CalorieMode } from '../schemas/common'
import { LLMProvider, IntentType } from '../provider'
import { buildApproximatePrompt } from '../prompts/approximate'
import { buildTacoPrompt, TacoFood } from '../prompts/taco'
import { buildClassifyPrompt } from '../prompts/classify'
import { buildVisionPrompt } from '../prompts/vision'

interface OllamaMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

interface OllamaRequestBody {
  model: string
  messages: OllamaMessage[]
  format?: 'json'
  stream: false
}

interface OllamaVisionMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
  images?: string[]
}

interface OllamaVisionRequestBody {
  model: string
  messages: OllamaVisionMessage[]
  format?: 'json'
  stream: false
}

interface OllamaResponse {
  message: {
    content: string
  }
}

export class OllamaProvider implements LLMProvider {
  private baseUrl: string
  private mealModel: string
  private classifyModel: string
  private visionModel: string

  constructor() {
    this.baseUrl = process.env.OLLAMA_BASE_URL || 'http://localhost:11434'
    this.mealModel = process.env.OLLAMA_MODEL_MEAL || 'llama3.1:8b'
    this.classifyModel = process.env.OLLAMA_MODEL_CLASSIFY || 'llama3.1:8b'
    this.visionModel = process.env.OLLAMA_MODEL_VISION || 'llava:13b'
  }

  async analyzeMeal(message: string, mode: CalorieMode, context?: TacoFood[]): Promise<MealAnalysis> {
    const systemPrompt = mode === 'taco'
      ? buildTacoPrompt(context ?? [])
      : buildApproximatePrompt()

    const rawContent = await this.callAPI(this.mealModel, systemPrompt, message, true)

    const parsed = this.parseJSON(rawContent)
    const validated = MealAnalysisSchema.safeParse(parsed)

    if (validated.success) {
      return validated.data
    }

    // Retry once on validation failure
    const retryContent = await this.callAPI(this.mealModel, systemPrompt, message, true)
    const retryParsed = this.parseJSON(retryContent)
    const retryValidated = MealAnalysisSchema.safeParse(retryParsed)

    if (retryValidated.success) {
      return retryValidated.data
    }

    throw new Error(
      `MealAnalysis validation failed after retry: ${retryValidated.error.message}`,
    )
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

  async analyzeImage(
    imageBase64: string,
    caption: string | undefined,
    mode: CalorieMode,
    context?: TacoFood[],
  ): Promise<ImageAnalysis> {
    const systemPrompt = buildVisionPrompt(mode, context)
    const captionText = caption || 'Analise esta imagem.'

    const rawContent = await this.callVisionAPI(this.visionModel, systemPrompt, imageBase64, captionText)
    const parsed = this.parseJSON(rawContent)
    const validated = ImageAnalysisSchema.safeParse(parsed)

    if (validated.success) {
      return validated.data
    }

    const retryContent = await this.callVisionAPI(this.visionModel, systemPrompt, imageBase64, captionText)
    const retryParsed = this.parseJSON(retryContent)
    const retryValidated = ImageAnalysisSchema.safeParse(retryParsed)

    if (retryValidated.success) {
      return retryValidated.data
    }

    throw new Error(`ImageAnalysis validation failed after retry: ${retryValidated.error.message}`)
  }

  private parseJSON(content: string): unknown {
    try {
      return JSON.parse(content)
    } catch {
      return null
    }
  }

  private async callVisionAPI(
    model: string,
    systemPrompt: string,
    imageBase64: string,
    caption: string,
  ): Promise<string> {
    // Strip data URL prefix for Ollama (expects raw base64)
    const base64Only = imageBase64.replace(/^data:image\/\w+;base64,/, '')

    const body: OllamaVisionRequestBody = {
      model,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: caption, images: [base64Only] },
      ],
      format: 'json',
      stream: false,
    }

    const response = await fetch(`${this.baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })

    if (!response.ok) {
      throw new Error(`Ollama API error: ${response.status} ${response.statusText}`)
    }

    const data = (await response.json()) as OllamaResponse
    return data.message.content
  }

  private async callAPI(
    model: string,
    systemPrompt: string,
    userMessage: string,
    jsonMode: boolean,
  ): Promise<string> {
    const body: OllamaRequestBody = {
      model,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userMessage },
      ],
      stream: false,
    }

    if (jsonMode) {
      body.format = 'json'
    }

    const response = await fetch(`${this.baseUrl}/api/chat`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    })

    if (!response.ok) {
      throw new Error(`Ollama API error: ${response.status} ${response.statusText}`)
    }

    const data = (await response.json()) as OllamaResponse
    return data.message.content
  }
}
