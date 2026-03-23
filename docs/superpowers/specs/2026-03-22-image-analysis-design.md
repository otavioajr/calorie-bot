# Image Analysis Design Spec — CalorieBot

**Date:** 2026-03-22
**Status:** Approved

## Overview

Add image analysis support to CalorieBot's WhatsApp integration. Users can send photos of food plates or nutrition labels, and the bot analyzes them using a vision-capable LLM to estimate calories and macros. Both cases feed into the existing meal-log confirmation flow.

## Scope

### In Scope
- Photo of food → LLM estimates items, quantities, calories, macros
- Photo of nutrition label → LLM extracts nutritional data per serving
- Auto-detection of image type (food vs nutrition label) in a single LLM call
- Caption text used as additional context when present
- Integration with existing meal-log confirmation flow
- OpenRouter and Ollama provider support

### Out of Scope
- Multiple image grouping (each image processed independently)
- Image cropping/editing
- Barcode scanning
- Storing nutrition labels as reusable templates

## Architecture

### Pipeline

```
WhatsApp image message
  → Webhook parses imageId + caption
  → downloadWhatsAppMedia(imageId) → Buffer
  → Convert to base64 data URL
  → LLM vision (unified prompt: classify + analyze)
  → Result as MealAnalysis
  → Existing meal-log confirmation flow
  → Save as meal + meal_items
```

### Approach

Single LLM call (Approach B) that both classifies the image type and performs analysis. The unified prompt instructs the LLM to:
1. Determine if the image is food or a nutrition label
2. If food: identify items, estimate quantities, calculate calories/macros
3. If nutrition label: extract nutritional data per serving

Both cases return the same `MealAnalysis` schema. The `image_type` field is used only for message formatting.

## Changes by Component

### 1. WhatsApp Webhook Parser (`src/lib/whatsapp/webhook.ts`)

Add `imageId` and `caption` fields to image message parsing:

```typescript
// Current: returns { type: 'image', from, messageId, timestamp }
// New: returns { type: 'image', from, messageId, timestamp, imageId, caption? }
```

**Type changes required:**
- `RawMessage` interface: add `image?: { id: string; caption?: string }` field (same pattern as `audio?: { id: string }`)
- `WhatsAppMessage` type: add `imageId: string` and `caption?: string` for image messages
- Image branch in parser: extract `msg.image.id` and `msg.image.caption` from the raw message

### 2. Webhook Route (`src/app/api/webhook/whatsapp/route.ts`)

Add handler for `event.type === 'image'`:
- Extract `imageId` and `caption` from the parsed event
- Call `handleIncomingImage(from, imageId, caption)`
- Same deduplication pattern as text/audio messages

### 3. Bot Handler (`src/lib/bot/handler.ts`)

New function `handleIncomingImage(from: string, imageId: string, caption?: string)`:
1. Check user exists + onboarding complete (same as text/audio)
2. Call `downloadWhatsAppMedia(imageId)` to get image buffer
3. Detect MIME type from buffer magic bytes (JPEG: `FF D8`, PNG: `89 50 4E 47`, WebP: `52 49 46 46`). Default to `image/jpeg` if unknown.
4. Convert buffer to base64 data URL (`data:{mimeType};base64,...`)
5. Get user's `calorie_mode` from database
6. Call `llm.analyzeImage(imageBase64, caption, calorieMode, tacoContext?)`
7. If `needs_clarification === true` or `items` is empty: send clarification message and return (do NOT enter meal-log flow)
8. **Convert `ImageAnalysis` → `MealAnalysis`:** Map the result to `MealAnalysis` format:
   - `meal_type`: use value from LLM if present; default to `"snack"` for nutrition labels or when absent
   - `items`: must have at least 1 item (guaranteed by step 7 guard)
   - Drop `image_type` field (only used for message formatting in this function)
9. Format result based on `image_type`:
   - `food`: standard meal breakdown message → enter `awaiting_confirmation` state
   - `nutrition_label`: show extracted data + ask portions → enter **`awaiting_label_portions`** state (new state, see section below)
10. Send message to user

#### Nutrition Label Portions Flow (new conversation state)

When `image_type === "nutrition_label"`, instead of going directly to `awaiting_confirmation`:

1. Bot shows extracted label data and asks "Quantas porções você comeu?"
2. State saved as `awaiting_label_portions` in `conversation_context` with `context_data` containing the `MealAnalysis` (per-serving values)
3. User responds with a number (e.g., "2", "1.5", "meia porção")
4. Handler parses numeric value, multiplies all nutritional values (calories, protein, carbs, fat) by portions count
5. Shows final breakdown → enters `awaiting_confirmation` with multiplied values
6. Standard confirmation flow from here

**Router integration:** When `conversation_context.state === 'awaiting_label_portions'`, route the next text message to a `handleLabelPortions(from, message)` function. Simple numeric parse — if not a number, ask again.

This requires adding `'awaiting_label_portions'` to the `ConversationState` type.

### 4. LLM Provider Interface (`src/lib/llm/provider.ts`)

Add new method:

```typescript
interface LLMProvider {
  // ... existing methods
  analyzeImage(
    imageBase64: string,
    caption: string | undefined,
    mode: CalorieMode,
    context?: TacoFood[]
  ): Promise<ImageAnalysis>
}
```

### 5. OpenRouter Provider (`src/lib/llm/providers/openrouter.ts`)

- Load `LLM_MODEL_VISION` from environment
- **Type changes:** Update `OpenRouterMessage` to support multimodal content. The `content` field must accept both `string` and `Array<{ type: "text", text: string } | { type: "image_url", image_url: { url: string } }>`. Either widen the existing type or create a new `callVisionAPI` method that uses the multimodal type.
- Implement `analyzeImage()` using multimodal message format:

```typescript
messages: [
  { role: "system", content: visionSystemPrompt },
  {
    role: "user",
    content: [
      { type: "image_url", image_url: { url: imageBase64DataUrl } },
      { type: "text", text: caption || "Analise esta imagem." }
    ]
  }
]
```

### 6. Ollama Provider (`src/lib/llm/providers/ollama.ts`)

- Load `OLLAMA_MODEL_VISION` from environment (new env var)
- Implement `analyzeImage()` using Ollama's multimodal format:

```typescript
{
  model: visionModel,
  messages: [
    { role: "system", content: visionSystemPrompt },
    { role: "user", content: caption || "Analyze this image.", images: [base64WithoutPrefix] }
  ],
  format: "json",
  stream: false
}
```

### 7. Image Analysis Schema (`src/lib/llm/schemas/image-analysis.ts`)

New schema file:

```typescript
export const ImageAnalysisSchema = z.object({
  image_type: z.enum(["food", "nutrition_label"]),
  meal_type: MealTypeSchema.optional(),       // Optional: LLM may not know for labels. Default to "snack" in handler.
  confidence: ConfidenceSchema,
  items: z.array(MealItemSchema).default([]), // Can be empty when needs_clarification is true
  unknown_items: z.array(z.string()).default([]),
  needs_clarification: z.boolean().default(false),
  clarification_question: z.string().nullable().optional(),
})
```

Same structure as `MealAnalysis` plus `image_type`. Both food and nutrition_label results are normalized into `items[]` with calories and macros.

**Conversion to `MealAnalysis`:** The handler maps `ImageAnalysis` → `MealAnalysis` before entering the meal-log flow. This is only done when `items.length > 0` and `needs_clarification === false`. The mapping:
- `meal_type`: use LLM value if present, otherwise `"snack"`
- `items`: passed through (already `MealItemSchema[]`)
- `image_type`: dropped (not part of `MealAnalysis`)
- All other fields: passed through as-is

### 8. Vision System Prompt (`src/lib/llm/prompts/vision.ts`)

New prompt file with unified instructions:

```
Você é um analisador nutricional visual. Analise a imagem enviada.

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

REGRAS:
- Responda APENAS em JSON no formato especificado
- NUNCA invente valores — se não conseguir identificar, retorne needs_clarification: true
- Se a imagem estiver ilegível ou não contiver comida/tabela, retorne needs_clarification: true
- NUNCA dê conselhos de saúde ou nutrição
```

Mode-specific additions (taco context, etc.) appended dynamically, same as text analysis.

### 9. Media Download

Extract `downloadWhatsAppMedia()` from `src/lib/audio/transcribe.ts` to a shared utility at `src/lib/whatsapp/media.ts`, since it's now used by both audio and image flows.

**Important:** The current implementation has a hardcoded `MAX_AUDIO_SIZE = 480_000` bytes and throws `AudioTooLargeError`. Images are typically larger. The extracted version must:
- Accept an optional `maxSize` parameter (default: no limit)
- Each caller passes its own limit: audio keeps 480KB, images use 5MB (`MAX_IMAGE_SIZE = 5_242_880`)
- Rename the error to `MediaTooLargeError` (generic)
- `src/lib/audio/transcribe.ts` imports from the new location and passes the audio size limit

## Environment Variables

```env
# Already defined, now actually used:
LLM_MODEL_VISION=openai/gpt-4o

# New for Ollama users:
OLLAMA_MODEL_VISION=llava:13b
```

Update `.env.example` to include `OLLAMA_MODEL_VISION`.

## Error Handling

| Scenario | Behavior |
|----------|----------|
| Image unreadable / no food | `needs_clarification: true` → "Não consegui identificar os alimentos nessa foto 😅 Pode descrever o que comeu?" |
| Media download fails | Standard error message: "Ops, tive um probleminha aqui 😅 Tenta de novo em alguns segundos?" |
| LLM vision timeout | Timeout set to 30s (vs 15s for text). On timeout, standard error message |
| Partial nutrition label | Returns what it can extract with `confidence: "low"`. User can correct during confirmation |
| Multiple images | Each processed independently as separate messages |
| Caption without image | Normal text flow, not image flow |

## Message Formatting

**Food photo response:**
```
🍽️ Identifiquei na sua foto:

• Arroz branco — 150g — 195 kcal
• Feijão — 100g — 77 kcal
• Frango grelhado — 120g — 198 kcal

Total: 470 kcal | P: 38g | C: 52g | G: 12g

Confirma o registro? (sim/não)
```

**Nutrition label response:**
```
📋 Tabela nutricional detectada!

• Granola (porção 40g) — 180 kcal
  P: 4g | C: 28g | G: 6g

Quantas porções você comeu? Responda com o número para eu registrar.
```

Note: For nutrition labels, the bot enters `awaiting_label_portions` state. The user responds with a number, the handler multiplies the per-serving values, then enters the standard `awaiting_confirmation` flow.

## LLM Usage Logging

Vision model calls (e.g., GPT-4o) are significantly more expensive than text calls. All vision API calls must be logged to `llm_usage_log` with:
- `model`: the vision model used
- `tokens_in` / `tokens_out`: from API response
- `latency_ms`: measured in the provider
- `purpose`: `"image_analysis"`

Same pattern as existing meal analysis logging.

## CLAUDE.md Updates

Add to project structure:
- `src/lib/llm/schemas/image-analysis.ts`
- `src/lib/llm/prompts/vision.ts`
- `src/lib/whatsapp/media.ts` (extracted from audio)

Update webhook description to include image support.
Add `OLLAMA_MODEL_VISION` to environment variables section.
Add `awaiting_label_portions` to conversation state types documentation.
