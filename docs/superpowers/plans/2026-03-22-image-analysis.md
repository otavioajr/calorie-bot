# Image Analysis Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add image analysis to CalorieBot so users can send food photos or nutrition label photos via WhatsApp and get calorie/macro analysis.

**Architecture:** Single vision LLM call (Approach B) classifies image type (food vs label) and analyzes in one shot. Pipeline mirrors audio: webhook → download media → base64 → LLM vision → existing meal-log confirmation flow. Nutrition labels get an extra `awaiting_label_portions` state for portion count.

**Tech Stack:** Next.js, TypeScript, Zod, OpenRouter/Ollama vision models, WhatsApp Graph API

**Spec:** `docs/superpowers/specs/2026-03-22-image-analysis-design.md`

---

### Task 1: Extract `downloadWhatsAppMedia` to Shared Media Utility

**Files:**
- Create: `src/lib/whatsapp/media.ts`
- Modify: `src/lib/audio/transcribe.ts`
- Modify: `tests/unit/audio/transcribe.test.ts`
- Create: `tests/unit/whatsapp/media.test.ts`

- [ ] **Step 1: Write the failing tests for the shared media download**

Create `tests/unit/whatsapp/media.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { downloadWhatsAppMedia, MediaTooLargeError } from '@/lib/whatsapp/media'

describe('downloadWhatsAppMedia', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    vi.stubEnv('WHATSAPP_ACCESS_TOKEN', 'test-access-token')
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('downloads media by ID via Graph API two-step flow', async () => {
    const mediaUrl = 'https://lookaside.fbsbx.com/whatsapp_business/attachments/?mid=abc'
    const mockFetch = vi.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ url: mediaUrl }) })
      .mockResolvedValueOnce({ ok: true, arrayBuffer: async () => new ArrayBuffer(100) })

    vi.stubGlobal('fetch', mockFetch)

    const result = await downloadWhatsAppMedia('media-123')

    expect(result).toBeInstanceOf(Buffer)
    expect(mockFetch).toHaveBeenCalledTimes(2)
    expect(mockFetch).toHaveBeenNthCalledWith(1, 'https://graph.facebook.com/v21.0/media-123', {
      headers: { Authorization: 'Bearer test-access-token' },
    })
  })

  it('throws MediaTooLargeError when buffer exceeds maxSize', async () => {
    const mediaUrl = 'https://lookaside.fbsbx.com/whatsapp_business/attachments/?mid=large'
    const mockFetch = vi.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ url: mediaUrl }) })
      .mockResolvedValueOnce({ ok: true, arrayBuffer: async () => new ArrayBuffer(1000) })

    vi.stubGlobal('fetch', mockFetch)

    await expect(downloadWhatsAppMedia('media-large', 500)).rejects.toThrow(MediaTooLargeError)
  })

  it('does not throw when no maxSize is provided', async () => {
    const mediaUrl = 'https://lookaside.fbsbx.com/whatsapp_business/attachments/?mid=big'
    const mockFetch = vi.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ url: mediaUrl }) })
      .mockResolvedValueOnce({ ok: true, arrayBuffer: async () => new ArrayBuffer(10_000_000) })

    vi.stubGlobal('fetch', mockFetch)

    const result = await downloadWhatsAppMedia('media-big')
    expect(result).toBeInstanceOf(Buffer)
  })

  it('throws when WHATSAPP_ACCESS_TOKEN is not configured', async () => {
    vi.stubEnv('WHATSAPP_ACCESS_TOKEN', '')
    await expect(downloadWhatsAppMedia('media-no-token')).rejects.toThrow('WHATSAPP_ACCESS_TOKEN is not configured')
  })

  it('throws when metadata request fails', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce({ ok: false, status: 401 }))
    await expect(downloadWhatsAppMedia('media-fail')).rejects.toThrow('WhatsApp Media API error: 401')
  })

  it('throws when binary download fails', async () => {
    const mockFetch = vi.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ url: 'https://example.com/media' }) })
      .mockResolvedValueOnce({ ok: false, status: 403 })

    vi.stubGlobal('fetch', mockFetch)
    await expect(downloadWhatsAppMedia('media-dl-fail')).rejects.toThrow('WhatsApp media download error: 403')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/whatsapp/media.test.ts`
Expected: FAIL — module `@/lib/whatsapp/media` not found

- [ ] **Step 3: Implement `src/lib/whatsapp/media.ts`**

```typescript
export class MediaTooLargeError extends Error {
  constructor(size: number, maxSize: number) {
    super(`Media size ${size} bytes exceeds limit of ${maxSize} bytes`)
    this.name = 'MediaTooLargeError'
  }
}

export async function downloadWhatsAppMedia(mediaId: string, maxSize?: number): Promise<Buffer> {
  const accessToken = process.env.WHATSAPP_ACCESS_TOKEN
  if (!accessToken) throw new Error('WHATSAPP_ACCESS_TOKEN is not configured')

  // Step 1: GET media metadata → { url }
  const metaRes = await fetch(`https://graph.facebook.com/v21.0/${mediaId}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  })
  if (!metaRes.ok) throw new Error(`WhatsApp Media API error: ${metaRes.status}`)
  const { url } = (await metaRes.json()) as { url: string }

  // Step 2: GET binary from URL
  const binaryRes = await fetch(url, {
    headers: { Authorization: `Bearer ${accessToken}` },
  })
  if (!binaryRes.ok) throw new Error(`WhatsApp media download error: ${binaryRes.status}`)

  const arrayBuffer = await binaryRes.arrayBuffer()
  const buffer = Buffer.from(arrayBuffer)

  if (maxSize !== undefined && buffer.length > maxSize) {
    throw new MediaTooLargeError(buffer.length, maxSize)
  }

  return buffer
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/unit/whatsapp/media.test.ts`
Expected: PASS — all 6 tests pass

- [ ] **Step 5: Update `src/lib/audio/transcribe.ts` to use shared download**

Remove `downloadWhatsAppMedia` and `MAX_AUDIO_SIZE` from this file. Keep `AudioTooLargeError` as its own class (don't alias — constructor signatures differ). Import the shared download and wrap it:

```typescript
import { downloadWhatsAppMedia, MediaTooLargeError } from '@/lib/whatsapp/media'

export class AudioTooLargeError extends Error {
  constructor() {
    super('Audio exceeds 30 second limit')
    this.name = 'AudioTooLargeError'
  }
}

const MAX_AUDIO_SIZE = 480_000 // ~30s OGG/Opus

export interface TranscriptionResult {
  text: string
  latencyMs: number
}

export async function downloadAudioMedia(mediaId: string): Promise<Buffer> {
  try {
    return await downloadWhatsAppMedia(mediaId, MAX_AUDIO_SIZE)
  } catch (err) {
    if (err instanceof MediaTooLargeError) {
      throw new AudioTooLargeError()
    }
    throw err
  }
}

export async function transcribeAudio(audioBuffer: Buffer): Promise<TranscriptionResult> {
  // ... existing implementation unchanged
}
```

Update `src/lib/bot/handler.ts` import to use `downloadAudioMedia` instead of `downloadWhatsAppMedia` for audio:

```typescript
import { downloadAudioMedia, transcribeAudio, AudioTooLargeError } from '@/lib/audio/transcribe'
```

And in `handleIncomingAudio`, change `downloadWhatsAppMedia(audioId)` to `downloadAudioMedia(audioId)`. The `AudioTooLargeError` check in the handler stays the same — no changes needed.

- [ ] **Step 6: Run existing audio tests to verify no regressions**

Run: `npx vitest run tests/unit/audio/transcribe.test.ts`
Expected: PASS — existing tests still pass (the re-exports maintain backwards compat)

- [ ] **Step 7: Commit**

```bash
git add src/lib/whatsapp/media.ts tests/unit/whatsapp/media.test.ts src/lib/audio/transcribe.ts src/lib/bot/handler.ts
git commit -m "refactor: extract downloadWhatsAppMedia to shared whatsapp/media utility"
```

---

### Task 2: Add Image Schema and Vision Prompt

**Files:**
- Create: `src/lib/llm/schemas/image-analysis.ts`
- Create: `src/lib/llm/prompts/vision.ts`
- Create: `tests/unit/llm/image-analysis-schema.test.ts`

- [ ] **Step 1: Write the failing tests for `ImageAnalysisSchema`**

Create `tests/unit/llm/image-analysis-schema.test.ts`:

```typescript
import { describe, it, expect } from 'vitest'
import { ImageAnalysisSchema } from '@/lib/llm/schemas/image-analysis'

describe('ImageAnalysisSchema', () => {
  it('validates a food image analysis result', () => {
    const input = {
      image_type: 'food',
      meal_type: 'lunch',
      confidence: 'high',
      items: [
        {
          food: 'Arroz branco',
          quantity_grams: 150,
          calories: 195,
          protein: 4,
          carbs: 42,
          fat: 0.5,
        },
      ],
    }

    const result = ImageAnalysisSchema.safeParse(input)
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.image_type).toBe('food')
      expect(result.data.meal_type).toBe('lunch')
      expect(result.data.items).toHaveLength(1)
    }
  })

  it('validates a nutrition_label result with optional meal_type', () => {
    const input = {
      image_type: 'nutrition_label',
      confidence: 'high',
      items: [
        {
          food: 'Granola',
          quantity_grams: 40,
          calories: 180,
          protein: 4,
          carbs: 28,
          fat: 6,
        },
      ],
    }

    const result = ImageAnalysisSchema.safeParse(input)
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.image_type).toBe('nutrition_label')
      expect(result.data.meal_type).toBeUndefined()
    }
  })

  it('allows empty items when needs_clarification is true', () => {
    const input = {
      image_type: 'food',
      confidence: 'low',
      items: [],
      needs_clarification: true,
      clarification_question: 'Não consegui identificar os alimentos.',
    }

    const result = ImageAnalysisSchema.safeParse(input)
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.items).toHaveLength(0)
      expect(result.data.needs_clarification).toBe(true)
    }
  })

  it('defaults needs_clarification to false', () => {
    const input = {
      image_type: 'food',
      confidence: 'high',
      items: [{ food: 'Banana', quantity_grams: 120, calories: 107, protein: 1.3, carbs: 27, fat: 0.3 }],
    }

    const result = ImageAnalysisSchema.safeParse(input)
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.needs_clarification).toBe(false)
    }
  })

  it('rejects invalid image_type', () => {
    const input = {
      image_type: 'selfie',
      confidence: 'high',
      items: [],
    }

    const result = ImageAnalysisSchema.safeParse(input)
    expect(result.success).toBe(false)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/llm/image-analysis-schema.test.ts`
Expected: FAIL — module `@/lib/llm/schemas/image-analysis` not found

- [ ] **Step 3: Implement `src/lib/llm/schemas/image-analysis.ts`**

```typescript
import { z } from 'zod'
import { MealTypeSchema, ConfidenceSchema } from './common'
import { MealItemSchema } from './meal-analysis'

export const ImageAnalysisSchema = z.object({
  image_type: z.enum(['food', 'nutrition_label']),
  meal_type: MealTypeSchema.optional(),
  confidence: ConfidenceSchema,
  items: z.array(MealItemSchema).default([]),
  unknown_items: z.array(z.string()).default([]),
  needs_clarification: z.boolean().default(false),
  clarification_question: z.string().nullable().optional(),
})

export type ImageAnalysis = z.infer<typeof ImageAnalysisSchema>
```

- [ ] **Step 4: Implement `src/lib/llm/prompts/vision.ts`**

```typescript
import { CalorieMode } from '../schemas/common'
import { TacoFood } from './taco'

export function buildVisionPrompt(mode: CalorieMode, context?: TacoFood[]): string {
  let prompt = `Você é um analisador nutricional visual. Analise a imagem enviada.

PRIMEIRO: Identifique o tipo de imagem:
- "food": foto de comida/prato/refeição
- "nutrition_label": foto de tabela nutricional/rótulo de embalagem

SE COMIDA:
1. Identifique os alimentos visíveis
2. Estime quantidades em gramas
3. Calcule calorias e macros por item
4. Se houver texto/caption do usuário, use como contexto adicional

SE TABELA NUTRICIONAL:
1. Extraia os dados por porção
2. Retorne como um único item com os valores da tabela
3. Use o nome do produto como nome do item (se visível)

REGRAS ABSOLUTAS:
- Responda APENAS em JSON no formato especificado
- NUNCA invente valores — se não conseguir identificar, retorne needs_clarification: true
- Se a imagem estiver ilegível ou não contiver comida/tabela, retorne needs_clarification: true
- NUNCA dê conselhos de saúde, dieta ou nutrição
- NUNCA sugira alimentos ou substituições

FORMATO DE RESPOSTA (JSON):
{
  "image_type": "food|nutrition_label",
  "meal_type": "breakfast|lunch|snack|dinner|supper",
  "confidence": "high|medium|low",
  "items": [
    {
      "food": "nome do alimento",
      "quantity_grams": 100,
      "quantity_source": "estimated",
      "calories": 200,
      "protein": 10.0,
      "carbs": 25.0,
      "fat": 5.0,
      "taco_match": false,
      "taco_id": null,
      "confidence": "high|medium|low"
    }
  ],
  "unknown_items": [],
  "needs_clarification": false,
  "clarification_question": null
}

Responda SOMENTE com o JSON. Não inclua texto antes ou depois do JSON.`

  if (mode === 'taco' && context && context.length > 0) {
    const tacoList = context.map((f) => `- ${f.name} (${f.calories} kcal/100g)`).join('\n')
    prompt += `\n\nUSE PREFERENCIALMENTE dados da Tabela TACO abaixo:\n${tacoList}`
  }

  return prompt
}
```

- [ ] **Step 5: Add a test for `buildVisionPrompt`**

Add to `tests/unit/llm/image-analysis-schema.test.ts` (or create separate `tests/unit/llm/vision-prompt.test.ts`):

```typescript
import { buildVisionPrompt } from '@/lib/llm/prompts/vision'

describe('buildVisionPrompt', () => {
  it('returns base prompt for approximate mode', () => {
    const prompt = buildVisionPrompt('approximate')
    expect(prompt).toContain('analisador nutricional visual')
    expect(prompt).toContain('"food"')
    expect(prompt).toContain('"nutrition_label"')
    expect(prompt).not.toContain('Tabela TACO')
  })

  it('appends TACO data for taco mode', () => {
    const context = [{ name: 'Arroz branco', calories: 128 }]
    const prompt = buildVisionPrompt('taco', context as any)
    expect(prompt).toContain('Tabela TACO')
    expect(prompt).toContain('Arroz branco')
  })
})
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `npx vitest run tests/unit/llm/image-analysis-schema.test.ts`
Expected: PASS — all tests pass

- [ ] **Step 7: Commit**

```bash
git add src/lib/llm/schemas/image-analysis.ts src/lib/llm/prompts/vision.ts tests/unit/llm/image-analysis-schema.test.ts
git commit -m "feat: add ImageAnalysis schema and vision system prompt"
```

---

### Task 3: Add `analyzeImage` to LLM Provider Interface and OpenRouter

**Files:**
- Modify: `src/lib/llm/provider.ts`
- Modify: `src/lib/llm/providers/openrouter.ts`
- Modify: `src/lib/llm/index.ts`
- Modify: `tests/unit/llm/openrouter.test.ts`

- [ ] **Step 1: Write the failing test for OpenRouter `analyzeImage`**

Add to `tests/unit/llm/openrouter.test.ts`:

```typescript
describe('analyzeImage', () => {
  it('sends multimodal message with image_url and text to vision model', async () => {
    vi.stubEnv('LLM_API_KEY', 'test-key')
    vi.stubEnv('LLM_MODEL_VISION', 'openai/gpt-4o')

    const mockResponse = {
      image_type: 'food',
      meal_type: 'lunch',
      confidence: 'high',
      items: [{ food: 'Rice', quantity_grams: 150, calories: 195, protein: 4, carbs: 42, fat: 0.5 }],
      unknown_items: [],
      needs_clarification: false,
    }

    const mockFetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: JSON.stringify(mockResponse) } }],
      }),
    })

    vi.stubGlobal('fetch', mockFetch)

    const provider = new OpenRouterProvider()
    const result = await provider.analyzeImage('data:image/jpeg;base64,abc123', 'meu almoço', 'approximate')

    expect(result.image_type).toBe('food')
    expect(result.items).toHaveLength(1)

    const [, options] = mockFetch.mock.calls[0] as [string, RequestInit]
    const body = JSON.parse(options.body as string)
    expect(body.model).toBe('openai/gpt-4o')

    // Verify multimodal message format
    const userMsg = body.messages[1]
    expect(Array.isArray(userMsg.content)).toBe(true)
    expect(userMsg.content[0].type).toBe('image_url')
    expect(userMsg.content[1].type).toBe('text')
    expect(userMsg.content[1].text).toBe('meu almoço')
  })

  it('uses default text when no caption provided', async () => {
    vi.stubEnv('LLM_API_KEY', 'test-key')
    vi.stubEnv('LLM_MODEL_VISION', 'openai/gpt-4o')

    const mockResponse = {
      image_type: 'food',
      confidence: 'low',
      items: [],
      needs_clarification: true,
      clarification_question: 'Não consegui identificar.',
    }

    const mockFetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: JSON.stringify(mockResponse) } }],
      }),
    })

    vi.stubGlobal('fetch', mockFetch)

    const provider = new OpenRouterProvider()
    const result = await provider.analyzeImage('data:image/jpeg;base64,abc123', undefined, 'approximate')

    expect(result.needs_clarification).toBe(true)

    const [, options] = mockFetch.mock.calls[0] as [string, RequestInit]
    const body = JSON.parse(options.body as string)
    const userMsg = body.messages[1]
    expect(userMsg.content[1].text).toBe('Analise esta imagem.')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/llm/openrouter.test.ts`
Expected: FAIL — `analyzeImage` is not a function

- [ ] **Step 3: Update `src/lib/llm/provider.ts` — add `analyzeImage` to interface**

```typescript
import { MealAnalysis } from './schemas/meal-analysis'
import { ImageAnalysis } from './schemas/image-analysis'
import { CalorieMode } from './schemas/common'
import { TacoFood } from './prompts/taco'

export type IntentType =
  | 'meal_log'
  | 'summary'
  | 'edit'
  | 'query'
  | 'weight'
  | 'help'
  | 'settings'
  | 'out_of_scope'

export interface LLMProvider {
  analyzeMeal(message: string, mode: CalorieMode, context?: TacoFood[]): Promise<MealAnalysis>
  analyzeImage(imageBase64: string, caption: string | undefined, mode: CalorieMode, context?: TacoFood[]): Promise<ImageAnalysis>
  classifyIntent(message: string): Promise<IntentType>
  chat(message: string, systemPrompt: string): Promise<string>
}
```

- [ ] **Step 4: Implement `analyzeImage` in OpenRouter provider**

Add to `src/lib/llm/providers/openrouter.ts`:

1. Add `visionModel` field to the constructor:
```typescript
private visionModel: string

constructor() {
  // ... existing fields
  this.visionModel = process.env.LLM_MODEL_VISION ?? 'openai/gpt-4o'
}
```

2. Add multimodal types (alongside existing `OpenRouterMessage`):
```typescript
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
}
```

3. Add `callVisionAPI` private method (separate from `callAPI` to keep types clean):
```typescript
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
```

4. Add `analyzeImage` method:
```typescript
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

  // Retry once on validation failure
  const retryContent = await this.callVisionAPI(this.visionModel, systemPrompt, imageBase64, captionText)
  const retryParsed = this.parseJSON(retryContent)
  const retryValidated = ImageAnalysisSchema.safeParse(retryParsed)

  if (retryValidated.success) {
    return retryValidated.data
  }

  throw new Error(`ImageAnalysis validation failed after retry: ${retryValidated.error.message}`)
}
```

Add the required imports at top of file:
```typescript
import { ImageAnalysis, ImageAnalysisSchema } from '../schemas/image-analysis'
import { buildVisionPrompt } from '../prompts/vision'
```

- [ ] **Step 5: Update fallback proxy in `src/lib/llm/index.ts`**

Add `analyzeImage` to the `createFallbackProxy` function:

```typescript
async analyzeImage(...args) {
  try {
    return await primary.analyzeImage(...args)
  } catch {
    return await fallback.analyzeImage(...args)
  }
},
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `npx vitest run tests/unit/llm/openrouter.test.ts`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add src/lib/llm/provider.ts src/lib/llm/providers/openrouter.ts src/lib/llm/index.ts tests/unit/llm/openrouter.test.ts
git commit -m "feat: add analyzeImage to LLM provider interface and OpenRouter implementation"
```

---

### Task 4: Add `analyzeImage` to Ollama Provider

**Files:**
- Modify: `src/lib/llm/providers/ollama.ts`
- Modify: `tests/unit/llm/ollama.test.ts`

- [ ] **Step 1: Write the failing test for Ollama `analyzeImage`**

Add to `tests/unit/llm/ollama.test.ts`:

```typescript
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

    const mockFetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        message: { content: JSON.stringify(mockResponse) },
      }),
    })

    vi.stubGlobal('fetch', mockFetch)

    const provider = new OllamaProvider()
    // base64 without data URL prefix for Ollama
    const result = await provider.analyzeImage('data:image/jpeg;base64,abc123', 'tabela nutricional', 'approximate')

    expect(result.image_type).toBe('nutrition_label')
    expect(result.items).toHaveLength(1)

    const [, options] = mockFetch.mock.calls[0] as [string, RequestInit]
    const body = JSON.parse(options.body as string)
    expect(body.model).toBe('llava:13b')
    expect(body.messages[1].images).toBeDefined()
    expect(body.messages[1].images[0]).toBe('abc123') // base64 without prefix
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/llm/ollama.test.ts`
Expected: FAIL — `analyzeImage` is not a function

- [ ] **Step 3: Implement `analyzeImage` in Ollama provider**

Add to `src/lib/llm/providers/ollama.ts`:

1. Add `visionModel` field:
```typescript
private visionModel: string

constructor() {
  // ... existing fields
  this.visionModel = process.env.OLLAMA_MODEL_VISION || 'llava:13b'
}
```

2. Add types for vision messages:
```typescript
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
```

3. Add `callVisionAPI` method:
```typescript
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
```

4. Add `analyzeImage` method:
```typescript
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

  // Retry once
  const retryContent = await this.callVisionAPI(this.visionModel, systemPrompt, imageBase64, captionText)
  const retryParsed = this.parseJSON(retryContent)
  const retryValidated = ImageAnalysisSchema.safeParse(retryParsed)

  if (retryValidated.success) {
    return retryValidated.data
  }

  throw new Error(`ImageAnalysis validation failed after retry: ${retryValidated.error.message}`)
}
```

Add required imports:
```typescript
import { ImageAnalysis, ImageAnalysisSchema } from '../schemas/image-analysis'
import { buildVisionPrompt } from '../prompts/vision'
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/unit/llm/ollama.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/lib/llm/providers/ollama.ts tests/unit/llm/ollama.test.ts
git commit -m "feat: add analyzeImage to Ollama provider"
```

---

### Task 5: Add Image Parsing to WhatsApp Webhook

**Files:**
- Modify: `src/lib/whatsapp/webhook.ts`
- Modify: `tests/unit/whatsapp/webhook.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `tests/unit/whatsapp/webhook.test.ts`:

```typescript
it('parses image message with imageId and caption', () => {
  const payload = {
    object: 'whatsapp_business_account',
    entry: [{
      id: 'BIZ_ACCOUNT_ID',
      changes: [{
        value: {
          messaging_product: 'whatsapp',
          messages: [{
            from: '5511999887766',
            id: 'wamid.img789',
            timestamp: '1710000003',
            type: 'image',
            image: { id: 'img_media_id_789', mime_type: 'image/jpeg', caption: 'meu almoço de hoje' },
          }],
        },
        field: 'messages',
      }],
    }],
  }

  const result = parseWebhookPayload(payload)
  expect(result).not.toBeNull()
  const msg = result as WhatsAppMessage
  expect(msg.type).toBe('image')
  expect(msg.imageId).toBe('img_media_id_789')
  expect(msg.caption).toBe('meu almoço de hoje')
  expect(msg.from).toBe('5511999887766')
})

it('parses image message without caption', () => {
  const result = parseWebhookPayload(makeImagePayload())
  expect(result).not.toBeNull()
  const msg = result as WhatsAppMessage
  expect(msg.type).toBe('image')
  expect(msg.imageId).toBe('img_media_id')
  expect(msg.caption).toBeUndefined()
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/whatsapp/webhook.test.ts`
Expected: FAIL — `imageId` is undefined

- [ ] **Step 3: Update `src/lib/whatsapp/webhook.ts`**

1. Add `imageId` and `caption` to `WhatsAppMessage`:
```typescript
export interface WhatsAppMessage {
  type: 'text' | 'image' | 'audio' | 'unknown'
  from: string
  messageId: string
  text?: string
  imageId?: string
  caption?: string
  audioId?: string
  timestamp: number
}
```

2. Add `image` field to `RawMessage`:
```typescript
interface RawMessage {
  from?: unknown
  id?: unknown
  timestamp?: unknown
  type?: unknown
  text?: { body?: unknown }
  image?: { id?: unknown; caption?: unknown; mime_type?: unknown }
  audio?: { id?: unknown; mime_type?: unknown }
}
```

3. Update the image branch in `parseWebhookPayload`:
```typescript
if (msgType === 'image') {
  const imageId = isObject(rawMsg.image) ? asString((rawMsg.image as { id?: unknown }).id) : undefined
  const caption = isObject(rawMsg.image) ? asString((rawMsg.image as { caption?: unknown }).caption) : undefined

  return {
    type: 'image',
    from,
    messageId,
    imageId,
    caption,
    timestamp,
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/unit/whatsapp/webhook.test.ts`
Expected: PASS — all tests including the new ones

- [ ] **Step 5: Commit**

```bash
git add src/lib/whatsapp/webhook.ts tests/unit/whatsapp/webhook.test.ts
git commit -m "feat: parse imageId and caption from WhatsApp image messages"
```

---

### Task 6: Add `awaiting_label_portions` Conversation State

**Files:**
- Modify: `src/lib/db/queries/context.ts`

- [ ] **Step 1: Add the new state type and TTL**

In `src/lib/db/queries/context.ts`:

1. Add `'awaiting_label_portions'` to the `ContextType` union:
```typescript
export type ContextType =
  | 'onboarding'
  | 'awaiting_confirmation'
  | 'awaiting_clarification'
  | 'awaiting_correction'
  | 'awaiting_weight'
  | 'awaiting_label_portions'
  | 'settings_menu'
  | 'settings_change'
```

2. Add TTL entry to `CONTEXT_TTLS`:
```typescript
export const CONTEXT_TTLS: Record<ContextType, number> = {
  onboarding: 1440,
  awaiting_confirmation: 5,
  awaiting_clarification: 10,
  awaiting_correction: 10,
  awaiting_weight: 5,
  awaiting_label_portions: 5,
  settings_menu: 5,
  settings_change: 5,
}
```

- [ ] **Step 2: Verify TypeScript compiles**

Run: `npx tsc --noEmit`
Expected: No errors (the new type is added consistently to both the type and the TTLS record)

- [ ] **Step 3: Commit**

```bash
git add src/lib/db/queries/context.ts
git commit -m "feat: add awaiting_label_portions conversation state"
```

---

### Task 7: Add MIME Type Detection Utility

**Files:**
- Create: `src/lib/whatsapp/mime.ts`
- Create: `tests/unit/whatsapp/mime.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `tests/unit/whatsapp/mime.test.ts`:

```typescript
import { describe, it, expect } from 'vitest'
import { detectMimeType } from '@/lib/whatsapp/mime'

describe('detectMimeType', () => {
  it('detects JPEG from magic bytes', () => {
    const buffer = Buffer.from([0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x00])
    expect(detectMimeType(buffer)).toBe('image/jpeg')
  })

  it('detects PNG from magic bytes', () => {
    const buffer = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A])
    expect(detectMimeType(buffer)).toBe('image/png')
  })

  it('detects WebP from magic bytes', () => {
    // RIFF....WEBP
    const buffer = Buffer.from([0x52, 0x49, 0x46, 0x46, 0x00, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50])
    expect(detectMimeType(buffer)).toBe('image/webp')
  })

  it('defaults to image/jpeg for unknown format', () => {
    const buffer = Buffer.from([0x00, 0x00, 0x00, 0x00])
    expect(detectMimeType(buffer)).toBe('image/jpeg')
  })

  it('defaults to image/jpeg for empty buffer', () => {
    const buffer = Buffer.from([])
    expect(detectMimeType(buffer)).toBe('image/jpeg')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/whatsapp/mime.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement `src/lib/whatsapp/mime.ts`**

```typescript
export function detectMimeType(buffer: Buffer): string {
  if (buffer.length >= 2 && buffer[0] === 0xFF && buffer[1] === 0xD8) {
    return 'image/jpeg'
  }
  if (buffer.length >= 4 && buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4E && buffer[3] === 0x47) {
    return 'image/png'
  }
  if (buffer.length >= 12 && buffer[0] === 0x52 && buffer[1] === 0x49 && buffer[2] === 0x46 && buffer[3] === 0x46 &&
      buffer[8] === 0x57 && buffer[9] === 0x45 && buffer[10] === 0x42 && buffer[11] === 0x50) {
    return 'image/webp'
  }
  return 'image/jpeg'
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/unit/whatsapp/mime.test.ts`
Expected: PASS — all 5 tests pass

- [ ] **Step 5: Commit**

```bash
git add src/lib/whatsapp/mime.ts tests/unit/whatsapp/mime.test.ts
git commit -m "feat: add MIME type detection from image buffer magic bytes"
```

---

### Task 8: Implement `handleIncomingImage` in Bot Handler

**Files:**
- Modify: `src/lib/bot/handler.ts`
- Modify: `tests/unit/bot/handler.test.ts`

- [ ] **Step 1: Add new mocks to `tests/unit/bot/handler.test.ts`**

The handler test file uses `vi.hoisted` to declare all mocks upfront. Add these new mocks:

1. In the `vi.hoisted(() => { ... })` block, add:
```typescript
mockDownloadImageMedia: vi.fn(),
mockDetectMimeType: vi.fn().mockReturnValue('image/jpeg'),
mockAnalyzeImage: vi.fn(),
mockSetState: vi.fn().mockResolvedValue(undefined),
mockGetDailyCalories: vi.fn().mockResolvedValue(0),
mockFormatMealBreakdown: vi.fn().mockReturnValue('meal breakdown message'),
```

2. Update `mockGetLLMProvider` to include `analyzeImage`:
```typescript
mockGetLLMProvider: vi.fn(() => ({
  classifyIntent: mockClassifyIntent,
  analyzeImage: mockAnalyzeImage,
})),
```

3. Add new `vi.mock` blocks:
```typescript
vi.mock('@/lib/whatsapp/media', () => ({
  downloadWhatsAppMedia: mockDownloadImageMedia,
  MediaTooLargeError: class MediaTooLargeError extends Error {
    constructor(size: number, maxSize: number) { super(`Media size ${size} exceeds ${maxSize}`); this.name = 'MediaTooLargeError' }
  },
}))

vi.mock('@/lib/whatsapp/mime', () => ({
  detectMimeType: mockDetectMimeType,
}))
```

4. Update existing mocks to include new exports:
```typescript
// Update state mock to include setState
vi.mock('@/lib/bot/state', () => ({
  getState: mockGetState,
  setState: mockSetState,
}))

// Update meals mock to include getDailyCalories
vi.mock('@/lib/db/queries/meals', () => ({
  createMeal: vi.fn(),
  getDailyCalories: mockGetDailyCalories,
}))

// Update formatters mock to include formatMealBreakdown
vi.mock('@/lib/utils/formatters', () => ({
  formatOutOfScope: mockFormatOutOfScope,
  formatError: mockFormatError,
  formatMealBreakdown: mockFormatMealBreakdown,
}))
```

5. Update the import line:
```typescript
import { handleIncomingMessage, handleIncomingAudio, handleIncomingImage } from '@/lib/bot/handler'
```

6. Add to `beforeEach`:
```typescript
mockDownloadImageMedia.mockResolvedValue(Buffer.from([0xFF, 0xD8, 0xFF, 0xE0])) // JPEG header
mockDetectMimeType.mockReturnValue('image/jpeg')
mockGetDailyCalories.mockResolvedValue(500)
mockAnalyzeImage.mockResolvedValue({
  image_type: 'food',
  meal_type: 'lunch',
  confidence: 'high',
  items: [{ food: 'Arroz', quantity_grams: 150, calories: 195, protein: 4, carbs: 42, fat: 0.5 }],
  unknown_items: [],
  needs_clarification: false,
})
```

- [ ] **Step 2: Write the failing tests for `handleIncomingImage`**

Add to the test file:

```typescript
// ---------------------------------------------------------------------------
// Test 8: handleIncomingImage
// ---------------------------------------------------------------------------

const IMAGE_ID = 'img_media_123'

// Local MediaTooLargeError for use in tests
class MediaTooLargeError extends Error {
  constructor(size: number, maxSize: number) { super(`Media size ${size} exceeds ${maxSize}`); this.name = 'MediaTooLargeError' }
}

describe('handleIncomingImage', () => {
  beforeEach(() => {
    mockFindUserByPhone.mockResolvedValue(completedUser)
    mockGetLLMProvider.mockReturnValue({
      classifyIntent: mockClassifyIntent,
      analyzeImage: mockAnalyzeImage,
    })
  })

  it('downloads image, analyzes via LLM vision, and sends food confirmation', async () => {
    await handleIncomingImage(FROM, MESSAGE_ID, IMAGE_ID, 'meu almoço')

    expect(mockDownloadImageMedia).toHaveBeenCalledWith(IMAGE_ID, 5_242_880)
    expect(mockDetectMimeType).toHaveBeenCalled()
    expect(mockAnalyzeImage).toHaveBeenCalledWith(
      expect.stringContaining('data:image/jpeg;base64,'),
      'meu almoço',
      'approximate',
    )
    expect(mockSetState).toHaveBeenCalledWith(
      completedUser.id,
      'awaiting_confirmation',
      expect.objectContaining({ originalMessage: 'meu almoço' }),
    )
    expect(mockFormatMealBreakdown).toHaveBeenCalled()
    expect(mockSendTextMessage).toHaveBeenCalledWith(FROM, 'meal breakdown message')
  })

  it('sends clarification message when LLM returns needs_clarification', async () => {
    mockAnalyzeImage.mockResolvedValue({
      image_type: 'food',
      confidence: 'low',
      items: [],
      needs_clarification: true,
      clarification_question: 'Não consegui identificar.',
    })

    await handleIncomingImage(FROM, MESSAGE_ID, IMAGE_ID)

    expect(mockSendTextMessage).toHaveBeenCalledWith(FROM, 'Não consegui identificar.')
    expect(mockSetState).not.toHaveBeenCalled()
  })

  it('sends default clarification when items empty and no question', async () => {
    mockAnalyzeImage.mockResolvedValue({
      image_type: 'food',
      confidence: 'low',
      items: [],
      needs_clarification: false,
    })

    await handleIncomingImage(FROM, MESSAGE_ID, IMAGE_ID)

    expect(mockSendTextMessage).toHaveBeenCalledWith(
      FROM,
      expect.stringContaining('Não consegui identificar'),
    )
    expect(mockSetState).not.toHaveBeenCalled()
  })

  it('enters awaiting_label_portions for nutrition_label images', async () => {
    mockAnalyzeImage.mockResolvedValue({
      image_type: 'nutrition_label',
      confidence: 'high',
      items: [{ food: 'Granola', quantity_grams: 40, calories: 180, protein: 4, carbs: 28, fat: 6 }],
      unknown_items: [],
      needs_clarification: false,
    })

    await handleIncomingImage(FROM, MESSAGE_ID, IMAGE_ID, 'tabela nutricional')

    expect(mockSetState).toHaveBeenCalledWith(
      completedUser.id,
      'awaiting_label_portions',
      expect.objectContaining({
        mealAnalysis: expect.objectContaining({ meal_type: 'snack' }),
      }),
    )
    expect(mockSendTextMessage).toHaveBeenCalledWith(
      FROM,
      expect.stringContaining('Quantas porções'),
    )
  })

  it('handles MediaTooLargeError gracefully', async () => {
    mockDownloadImageMedia.mockRejectedValue(new MediaTooLargeError(6_000_000, 5_242_880))

    await handleIncomingImage(FROM, MESSAGE_ID, IMAGE_ID)

    expect(mockSendTextMessage).toHaveBeenCalledWith(
      FROM,
      expect.stringContaining('Imagem muito grande'),
    )
    expect(mockAnalyzeImage).not.toHaveBeenCalled()
  })

  it('sends onboarding message for incomplete user', async () => {
    mockFindUserByPhone.mockResolvedValue(existingUserIncomplete)

    await handleIncomingImage(FROM, MESSAGE_ID, IMAGE_ID)

    expect(mockSendTextMessage).toHaveBeenCalledWith(
      FROM,
      expect.stringContaining('Primeiro preciso te conhecer'),
    )
    expect(mockDownloadImageMedia).not.toHaveBeenCalled()
  })

  it('sends formatError on unexpected error', async () => {
    mockDownloadImageMedia.mockRejectedValue(new Error('Network timeout'))

    await handleIncomingImage(FROM, MESSAGE_ID, IMAGE_ID)

    expect(mockFormatError).toHaveBeenCalled()
    expect(mockSendTextMessage).toHaveBeenCalledWith(FROM, 'error message')
  })

  it('uses "[imagem]" as originalMessage when no caption', async () => {
    await handleIncomingImage(FROM, MESSAGE_ID, IMAGE_ID)

    expect(mockSetState).toHaveBeenCalledWith(
      completedUser.id,
      'awaiting_confirmation',
      expect.objectContaining({ originalMessage: '[imagem]' }),
    )
  })

  it('logs vision API usage', async () => {
    await handleIncomingImage(FROM, MESSAGE_ID, IMAGE_ID)

    expect(mockLogLLMUsage).toHaveBeenCalledWith(
      mockSupabase,
      expect.objectContaining({
        functionType: 'vision',
        success: true,
      }),
    )
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/bot/handler.test.ts`
Expected: FAIL — `handleIncomingImage` is not exported

- [ ] **Step 3: Implement `handleIncomingImage` in `src/lib/bot/handler.ts`**

Add these imports at the top of the file:
```typescript
import { downloadWhatsAppMedia, MediaTooLargeError } from '@/lib/whatsapp/media'
import { detectMimeType } from '@/lib/whatsapp/mime'
import { setState } from '@/lib/bot/state'
import { getDailyCalories } from '@/lib/db/queries/meals'
import { formatMealBreakdown } from '@/lib/utils/formatters'
import type { ImageAnalysis } from '@/lib/llm/schemas/image-analysis'
import type { MealAnalysis } from '@/lib/llm/schemas/meal-analysis'
```

Note: `getDailyCalories` is already imported if `createMeal` is imported from the same module. Check existing imports and add only what's missing. `setState` from `@/lib/bot/state` and `formatMealBreakdown` from `@/lib/utils/formatters` are NOT currently imported — they must be added.

Add the constant:
```typescript
const MAX_IMAGE_SIZE = 5_242_880 // 5MB
```

Add the handler function:
```typescript
export async function handleIncomingImage(
  from: string,
  messageId: string,
  imageId: string,
  caption?: string,
): Promise<void> {
  const supabase = createServiceRoleClient()

  try {
    // 1. Find or create user
    let user = await findUserByPhone(supabase, from)
    if (!user) {
      user = await createUser(supabase, from)
    }

    // 2. Check onboarding
    if (!user.onboardingComplete) {
      await sendTextMessage(from, 'Primeiro preciso te conhecer! Me diz, qual o seu nome?')
      return
    }

    // 3. Download image
    let buffer: Buffer
    try {
      buffer = await downloadWhatsAppMedia(imageId, MAX_IMAGE_SIZE)
    } catch (err) {
      if (err instanceof MediaTooLargeError) {
        await sendTextMessage(from, '📸 Imagem muito grande! Tenta mandar uma foto menor (até 5MB) 😊')
        return
      }
      throw err
    }

    // 4. Convert to base64 data URL
    const mimeType = detectMimeType(buffer)
    const base64 = buffer.toString('base64')
    const dataUrl = `data:${mimeType};base64,${base64}`

    // 5. Analyze with LLM vision
    const llm = getLLMProvider()
    const calorieMode = user.calorieMode as Parameters<typeof llm.analyzeMeal>[1]

    const startTime = Date.now()
    const imageResult: ImageAnalysis = await llm.analyzeImage(dataUrl, caption, calorieMode)
    const latencyMs = Date.now() - startTime

    // Log vision API usage (fire-and-forget)
    logLLMUsage(supabase, {
      provider: process.env.LLM_PROVIDER || 'openrouter',
      model: process.env.LLM_MODEL_VISION || 'openai/gpt-4o',
      functionType: 'vision',
      latencyMs,
      success: true,
    }).catch(() => {})

    // 6. Handle clarification
    if (imageResult.needs_clarification || imageResult.items.length === 0) {
      const msg = imageResult.clarification_question ||
        'Não consegui identificar os alimentos nessa foto 😅 Pode descrever o que comeu?'
      await sendTextMessage(from, msg)
      return
    }

    // 7. Convert ImageAnalysis → MealAnalysis
    const mealAnalysis: MealAnalysis = {
      meal_type: imageResult.meal_type ?? 'snack',
      confidence: imageResult.confidence,
      items: imageResult.items,
      unknown_items: imageResult.unknown_items,
      needs_clarification: false,
    }

    // 8. Build response based on image type
    if (imageResult.image_type === 'nutrition_label') {
      // Show label data, ask for portions
      const item = mealAnalysis.items[0]
      const labelMsg = [
        '📋 Tabela nutricional detectada!',
        '',
        `• ${item.food} (porção ${item.quantity_grams}g) — ${Math.round(item.calories)} kcal`,
        `  P: ${item.protein}g | C: ${item.carbs}g | G: ${item.fat}g`,
        '',
        'Quantas porções você comeu? Responda com o número para eu registrar.',
      ].join('\n')

      await setState(user.id, 'awaiting_label_portions', {
        mealAnalysis: mealAnalysis as unknown as Record<string, unknown>,
        originalMessage: caption || '[imagem]',
      })

      await sendTextMessage(from, labelMsg)
      return
    }

    // Food photo — standard confirmation flow
    const dailyConsumed = await getDailyCalories(supabase, user.id)
    const target = user.dailyCalorieTarget ?? 2000

    const response = formatMealBreakdown(
      mealAnalysis.meal_type,
      mealAnalysis.items.map((item) => ({
        food: item.food,
        quantityGrams: item.quantity_grams,
        calories: item.calories,
      })),
      Math.round(mealAnalysis.items.reduce((sum, item) => sum + item.calories, 0)),
      dailyConsumed,
      target,
    )

    await setState(user.id, 'awaiting_confirmation', {
      mealAnalysis: mealAnalysis as unknown as Record<string, unknown>,
      originalMessage: caption || '[imagem]',
    })

    await sendTextMessage(from, response)
  } catch (err) {
    console.error('[handler] Image error:', err)
    await sendTextMessage(from, formatError()).catch(() => {})
  }
}
```

Also add the import for getDailyCalories if not already present:
```typescript
import { createMeal, getDailyCalories } from '@/lib/db/queries/meals'
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/unit/bot/handler.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/lib/bot/handler.ts tests/unit/bot/handler.test.ts
git commit -m "feat: implement handleIncomingImage for food photos and nutrition labels"
```

---

### Task 9: Add `handleLabelPortions` for Nutrition Label Portion Flow

**Files:**
- Modify: `src/lib/bot/handler.ts`
- Modify: `tests/unit/bot/handler.test.ts`

- [ ] **Step 1: Write the failing tests**

Add to `tests/unit/bot/handler.test.ts`. The `handleLabelPortions` function is private — it is tested through `handleIncomingMessage` with an active `awaiting_label_portions` context:

```typescript
// ---------------------------------------------------------------------------
// Test 9: handleIncomingMessage with awaiting_label_portions context
// ---------------------------------------------------------------------------

describe('handleIncomingMessage — awaiting_label_portions context', () => {
  const labelContext = {
    contextType: 'awaiting_label_portions' as const,
    contextData: {
      mealAnalysis: {
        meal_type: 'snack',
        confidence: 'high',
        items: [{ food: 'Granola', quantity_grams: 40, calories: 180, protein: 4, carbs: 28, fat: 6 }],
        unknown_items: [],
        needs_clarification: false,
      },
      originalMessage: '[imagem]',
    },
  }

  beforeEach(() => {
    mockFindUserByPhone.mockResolvedValue(completedUser)
    mockGetState.mockResolvedValue(labelContext)
    mockGetLLMProvider.mockReturnValue({
      classifyIntent: mockClassifyIntent,
      analyzeImage: mockAnalyzeImage,
    })
  })

  it('multiplies nutrition values by portion count and enters awaiting_confirmation', async () => {
    await handleIncomingMessage(FROM, MESSAGE_ID, '2')

    expect(mockSetState).toHaveBeenCalledWith(
      completedUser.id,
      'awaiting_confirmation',
      expect.objectContaining({
        mealAnalysis: expect.objectContaining({
          items: expect.arrayContaining([
            expect.objectContaining({
              food: 'Granola',
              quantity_grams: 80,   // 40 * 2
              calories: 360,        // 180 * 2
            }),
          ]),
        }),
      }),
    )
    expect(mockFormatMealBreakdown).toHaveBeenCalled()
    expect(mockSendTextMessage).toHaveBeenCalledWith(FROM, 'meal breakdown message')
  })

  it('handles decimal portions like "1.5"', async () => {
    await handleIncomingMessage(FROM, MESSAGE_ID, '1.5')

    expect(mockSetState).toHaveBeenCalledWith(
      completedUser.id,
      'awaiting_confirmation',
      expect.objectContaining({
        mealAnalysis: expect.objectContaining({
          items: expect.arrayContaining([
            expect.objectContaining({
              quantity_grams: 60,   // 40 * 1.5
              calories: 270,        // 180 * 1.5
            }),
          ]),
        }),
      }),
    )
  })

  it('handles comma decimal "1,5"', async () => {
    await handleIncomingMessage(FROM, MESSAGE_ID, '1,5')

    expect(mockSetState).toHaveBeenCalledWith(
      completedUser.id,
      'awaiting_confirmation',
      expect.objectContaining({
        mealAnalysis: expect.objectContaining({
          items: expect.arrayContaining([
            expect.objectContaining({
              calories: 270,        // 180 * 1.5
            }),
          ]),
        }),
      }),
    )
  })

  it('asks again when message is not a number', async () => {
    await handleIncomingMessage(FROM, MESSAGE_ID, 'banana')

    expect(mockSendTextMessage).toHaveBeenCalledWith(
      FROM,
      expect.stringContaining('número de porções'),
    )
    expect(mockSetState).not.toHaveBeenCalled()
  })

  it('asks again when number is zero or negative', async () => {
    await handleIncomingMessage(FROM, MESSAGE_ID, '0')

    expect(mockSendTextMessage).toHaveBeenCalledWith(
      FROM,
      expect.stringContaining('número de porções'),
    )
    expect(mockSetState).not.toHaveBeenCalled()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/bot/handler.test.ts`
Expected: FAIL — function not found

- [ ] **Step 3: Implement `handleLabelPortions`**

Add to `src/lib/bot/handler.ts`:

```typescript
async function handleLabelPortions(
  supabase: SupabaseClient,
  from: string,
  userId: string,
  message: string,
  context: ConversationContext,
  user: { calorieMode: string; dailyCalorieTarget: number | null },
): Promise<void> {
  const portions = parseFloat(message.trim().replace(',', '.'))

  if (isNaN(portions) || portions <= 0) {
    await sendTextMessage(from, 'Me manda um número de porções (ex: 1, 2, 0.5) 😊')
    return
  }

  const mealAnalysis = context.contextData.mealAnalysis as unknown as MealAnalysis

  // Multiply nutritional values by portions
  const multipliedItems = mealAnalysis.items.map((item) => ({
    ...item,
    quantity_grams: Math.round(item.quantity_grams * portions),
    calories: Math.round(item.calories * portions),
    protein: Math.round(item.protein * portions * 10) / 10,
    carbs: Math.round(item.carbs * portions * 10) / 10,
    fat: Math.round(item.fat * portions * 10) / 10,
  }))

  const multipliedAnalysis: MealAnalysis = {
    ...mealAnalysis,
    items: multipliedItems,
  }

  const dailyConsumed = await getDailyCalories(supabase, userId)
  const target = user.dailyCalorieTarget ?? 2000

  const total = Math.round(multipliedItems.reduce((sum, item) => sum + item.calories, 0))

  const response = formatMealBreakdown(
    multipliedAnalysis.meal_type,
    multipliedItems.map((item) => ({
      food: item.food,
      quantityGrams: item.quantity_grams,
      calories: item.calories,
    })),
    total,
    dailyConsumed,
    target,
  )

  await setState(userId, 'awaiting_confirmation', {
    mealAnalysis: multipliedAnalysis as unknown as Record<string, unknown>,
    originalMessage: context.contextData.originalMessage || '[imagem]',
  })

  await sendTextMessage(from, response)
}
```

Add these imports to the top of `handler.ts` (they are not currently imported):
```typescript
import type { SupabaseClient } from '@supabase/supabase-js'
import type { ConversationContext } from '@/lib/bot/state'
```
Both are needed for the `handleLabelPortions` function signature. `ConversationContext` is re-exported from `@/lib/bot/state`.

- [ ] **Step 4: Route `awaiting_label_portions` in `handleIncomingMessage`**

In `handleIncomingMessage`, add a case in the context switch block (after the existing cases, around line 73):

```typescript
case 'awaiting_label_portions': {
  await handleLabelPortions(supabase, from, user.id, text, context, {
    calorieMode: user.calorieMode,
    dailyCalorieTarget: user.dailyCalorieTarget,
  })
  return
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run tests/unit/bot/handler.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/lib/bot/handler.ts tests/unit/bot/handler.test.ts
git commit -m "feat: add handleLabelPortions for nutrition label portion flow"
```

---

### Task 10: Wire Image Handler to Webhook Route

**Files:**
- Modify: `src/app/api/webhook/whatsapp/route.ts`
- Modify: `tests/unit/webhook/route.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `tests/unit/webhook/route.test.ts`:

```typescript
it('routes image messages to handleIncomingImage with imageId and caption', async () => {
  // Create payload with image message containing imageId and caption
  // Mock: deduplication succeeds (no error on insert)
  // Mock: handleIncomingImage
  // Assert: handleIncomingImage called with (from, messageId, imageId, caption)
  // Assert: response is 200
})

it('routes image messages without caption', async () => {
  // Same as above but no caption
  // Assert: handleIncomingImage called with (from, messageId, imageId, undefined)
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/webhook/route.test.ts`
Expected: FAIL — route doesn't handle image messages yet

- [ ] **Step 3: Update `src/app/api/webhook/whatsapp/route.ts`**

1. Add import:
```typescript
import { handleIncomingMessage, handleIncomingAudio, handleIncomingImage } from '@/lib/bot/handler'
```

2. Add image handler after the audio handler block:
```typescript
if (event.type === 'image' && event.imageId) {
  await handleIncomingImage(event.from, event.messageId, event.imageId, event.caption)
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/unit/webhook/route.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/app/api/webhook/whatsapp/route.ts tests/unit/webhook/route.test.ts
git commit -m "feat: route WhatsApp image messages to handleIncomingImage"
```

---

### Task 11: Update `.env.example` and CLAUDE.md

**Files:**
- Modify: `.env.example`
- Modify: `CLAUDE.md`

- [ ] **Step 1: Update `.env.example`**

Add after the existing Ollama variables:
```env
OLLAMA_MODEL_VISION=llava:13b
```

- [ ] **Step 2: Update CLAUDE.md**

Add the following changes:
1. In project structure, add new files:
   - `src/lib/llm/schemas/image-analysis.ts`
   - `src/lib/llm/prompts/vision.ts`
   - `src/lib/whatsapp/media.ts`
   - `src/lib/whatsapp/mime.ts`
2. Update webhook route description to include image support
3. Add `OLLAMA_MODEL_VISION` to environment variables section
4. Add `awaiting_label_portions` to conversation state documentation

- [ ] **Step 3: Commit**

```bash
git add .env.example CLAUDE.md
git commit -m "docs: update env and CLAUDE.md for image analysis support"
```

---

### Task 12: Run Full Test Suite and Verify

- [ ] **Step 1: Run all tests**

Run: `npx vitest run`
Expected: All tests pass

- [ ] **Step 2: Run TypeScript check**

Run: `npx tsc --noEmit`
Expected: No errors

- [ ] **Step 3: Fix any failures**

If any tests fail, investigate and fix. Re-run until clean.

- [ ] **Step 4: Final commit (if any fixes)**

```bash
git add -A
git commit -m "fix: resolve test failures from image analysis integration"
```
