# Audio Messages Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add WhatsApp audio message support — download voice notes, transcribe with Whisper, show feedback, process through existing text pipeline.

**Architecture:** New `src/lib/audio/transcribe.ts` module handles media download and Whisper transcription. Webhook parser gains `audio` type. Handler gains `handleIncomingAudio` that orchestrates download → transcribe → feedback → delegate to existing `handleIncomingMessage`.

**Tech Stack:** OpenAI Whisper API, WhatsApp Media API, Vitest

**Spec:** `docs/superpowers/specs/2026-03-22-audio-messages-design.md`

---

## File Structure

| File | Action | Responsibility |
|------|--------|----------------|
| `src/lib/audio/transcribe.ts` | Create | Download media from WhatsApp, transcribe with Whisper |
| `src/lib/whatsapp/webhook.ts` | Modify | Parse `audio` message type, extract `audioId` |
| `src/lib/bot/handler.ts` | Modify | New `handleIncomingAudio` function |
| `src/app/api/webhook/whatsapp/route.ts` | Modify | Route audio events to handler |
| `.env.example` | Modify | Add `OPENAI_API_KEY` |
| `CLAUDE.md` | Modify | Document new module + env var |
| `tests/unit/audio/transcribe.test.ts` | Create | Tests for download + transcribe |
| `tests/unit/whatsapp/webhook.test.ts` | Modify | Tests for audio payload parsing |
| `tests/unit/bot/handler.test.ts` | Modify | Tests for `handleIncomingAudio` |
| `tests/unit/webhook/route.test.ts` | Modify | Tests for audio routing in POST handler |
| `src/lib/db/queries/llm-usage.ts` | Modify | Add `audio_transcription` to `functionType` union |

---

## Task 1: Audio module — `downloadWhatsAppMedia`

**Files:**
- Create: `src/lib/audio/transcribe.ts`
- Create: `tests/unit/audio/transcribe.test.ts`

- [ ] **Step 1: Write failing tests for `downloadWhatsAppMedia`**

Create `tests/unit/audio/transcribe.test.ts`. Use `vi.fn()` to mock `global.fetch`. Test cases:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest'

// Tests for downloadWhatsAppMedia:
// 1. Calls GET /v21.0/{mediaId} with WHATSAPP_ACCESS_TOKEN, then fetches the returned URL
// 2. Returns a Buffer of the audio binary
// 3. Throws AudioTooLargeError when response body exceeds 480_000 bytes
// 4. Throws when the media metadata request fails (non-ok response)
// 5. Throws when the binary download request fails (non-ok response)
```

Mock `global.fetch` to simulate the two-step WhatsApp Media API flow (metadata → binary download). Set `process.env.WHATSAPP_ACCESS_TOKEN` in `beforeEach`.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm run test:unit -- tests/unit/audio/transcribe.test.ts`
Expected: FAIL — module does not exist yet

- [ ] **Step 3: Implement `downloadWhatsAppMedia`**

Create `src/lib/audio/transcribe.ts`:

```typescript
const MAX_AUDIO_SIZE = 480_000 // ~30s OGG/Opus

export class AudioTooLargeError extends Error {
  constructor() {
    super('Audio exceeds 30 second limit')
    this.name = 'AudioTooLargeError'
  }
}

export async function downloadWhatsAppMedia(mediaId: string): Promise<Buffer> {
  const accessToken = process.env.WHATSAPP_ACCESS_TOKEN
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

  if (buffer.length > MAX_AUDIO_SIZE) throw new AudioTooLargeError()

  return buffer
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm run test:unit -- tests/unit/audio/transcribe.test.ts`
Expected: All `downloadWhatsAppMedia` tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/lib/audio/transcribe.ts tests/unit/audio/transcribe.test.ts
git commit -m "feat: add downloadWhatsAppMedia for WhatsApp audio support"
```

---

## Task 2: Audio module — `transcribeAudio`

**Files:**
- Modify: `src/lib/audio/transcribe.ts`
- Modify: `tests/unit/audio/transcribe.test.ts`

- [ ] **Step 1: Write failing tests for `transcribeAudio`**

Add to `tests/unit/audio/transcribe.test.ts`. Test cases:

```typescript
// Tests for transcribeAudio:
// 1. Sends POST to api.openai.com/v1/audio/transcriptions with correct headers and form data
// 2. Returns the transcribed text string from Whisper response
// 3. Throws when OPENAI_API_KEY is not set
// 4. Throws when Whisper API returns non-ok response
// 5. Returns empty string when Whisper returns empty text
```

Mock `global.fetch` to simulate the Whisper API response `{ text: "almocei arroz e feijão" }`. Set `process.env.OPENAI_API_KEY` in `beforeEach`.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm run test:unit -- tests/unit/audio/transcribe.test.ts`
Expected: FAIL — `transcribeAudio` not defined yet

- [ ] **Step 3: Implement `transcribeAudio`**

Add to `src/lib/audio/transcribe.ts`:

```typescript
export interface TranscriptionResult {
  text: string
  latencyMs: number
}

export async function transcribeAudio(audioBuffer: Buffer): Promise<TranscriptionResult> {
  const apiKey = process.env.OPENAI_API_KEY
  if (!apiKey) throw new Error('OPENAI_API_KEY is not configured')

  const startTime = Date.now()

  const formData = new FormData()
  formData.append('file', new Blob([audioBuffer], { type: 'audio/ogg' }), 'audio.ogg')
  formData.append('model', 'whisper-1')
  formData.append('language', 'pt')

  const response = await fetch('https://api.openai.com/v1/audio/transcriptions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}` },
    body: formData,
  })

  const latencyMs = Date.now() - startTime

  if (!response.ok) {
    const errorBody = await response.text()
    throw new Error(`Whisper API error: ${response.status} — ${errorBody}`)
  }

  const data = (await response.json()) as { text: string }
  return { text: data.text ?? '', latencyMs }
}
```

Also update `LLMUsageEntry.functionType` in `src/lib/db/queries/llm-usage.ts` to add `'audio_transcription'` to the union type.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm run test:unit -- tests/unit/audio/transcribe.test.ts`
Expected: All tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/lib/audio/transcribe.ts tests/unit/audio/transcribe.test.ts
git commit -m "feat: add transcribeAudio using OpenAI Whisper API"
```

---

## Task 3: Webhook parsing — add `audio` type

**Files:**
- Modify: `src/lib/whatsapp/webhook.ts`
- Modify: `tests/unit/whatsapp/webhook.test.ts`

- [ ] **Step 1: Update existing test that expects `unknown` for audio**

In `tests/unit/whatsapp/webhook.test.ts`, the test at line ~210 currently asserts `msg.type === 'unknown'` for audio payloads. It works by mutating a text payload's type to `'audio'` but does not include the `audio: { id }` field. Update the test to:
1. Add `audio: { id: 'media_audio_123', mime_type: 'audio/ogg' }` to the mutated message
2. Change assertion from `msg.type === 'unknown'` to `msg.type === 'audio'`
3. Assert `msg.audioId === 'media_audio_123'`

- [ ] **Step 2: Add new test with audio fixture**

Add `makeAudioPayload()` helper and a new test:

```typescript
function makeAudioPayload() {
  return {
    object: 'whatsapp_business_account',
    entry: [{
      id: 'BIZ_ACCOUNT_ID',
      changes: [{
        value: {
          messaging_product: 'whatsapp',
          messages: [{
            from: '5511999887766',
            id: 'wamid.audio789',
            timestamp: '1710000002',
            type: 'audio',
            audio: { id: 'media_audio_123', mime_type: 'audio/ogg' },
          }],
        },
        field: 'messages',
      }],
    }],
  }
}

// Test: parses audio message and extracts audioId
// Test: audioId is undefined for non-audio message types
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `npm run test:unit -- tests/unit/whatsapp/webhook.test.ts`
Expected: FAIL — `audio` type not handled, `audioId` not in interface

- [ ] **Step 4: Implement audio parsing in webhook.ts**

In `src/lib/whatsapp/webhook.ts`:
1. Add `'audio'` to `WhatsAppMessage.type` union
2. Add `audioId?: string` to `WhatsAppMessage` interface
3. Add `audio?: { id?: unknown; mime_type?: unknown }` to `RawMessage`
4. Add `if (msgType === 'audio')` branch that extracts `audio.id` and returns `WhatsAppMessage` with `type: 'audio'` and `audioId`

- [ ] **Step 5: Run tests to verify they pass**

Run: `npm run test:unit -- tests/unit/whatsapp/webhook.test.ts`
Expected: All tests PASS

- [ ] **Step 6: Commit**

```bash
git add src/lib/whatsapp/webhook.ts tests/unit/whatsapp/webhook.test.ts
git commit -m "feat: parse audio messages in WhatsApp webhook"
```

---

## Task 4: Bot handler — `handleIncomingAudio`

**Files:**
- Modify: `src/lib/bot/handler.ts`
- Modify: `src/lib/db/queries/llm-usage.ts` (add `'audio_transcription'` to union)
- Modify: `tests/unit/bot/handler.test.ts`

- [ ] **Step 1: Write failing tests for `handleIncomingAudio`**

Add to `tests/unit/bot/handler.test.ts`. Add mocks for the new audio module at the top of the file:

```typescript
const { mockDownloadWhatsAppMedia, mockTranscribeAudio } = vi.hoisted(() => ({
  mockDownloadWhatsAppMedia: vi.fn(),
  mockTranscribeAudio: vi.fn(),
}))

vi.mock('@/lib/audio/transcribe', () => ({
  downloadWhatsAppMedia: mockDownloadWhatsAppMedia,
  transcribeAudio: mockTranscribeAudio,
  AudioTooLargeError: class AudioTooLargeError extends Error {
    constructor() { super('Audio exceeds 30 second limit'); this.name = 'AudioTooLargeError' }
  },
}))
```

Update import to include `handleIncomingAudio`.

Test cases in a new `describe('handleIncomingAudio')` block:

```typescript
// 1. Downloads media, transcribes, sends feedback "🎤 Entendi: *{text}*", then calls handleIncomingMessage pipeline
// 2. Sends "audio too long" message when AudioTooLargeError is thrown
// 3. Sends "couldn't understand" message when transcription returns empty string
// 4. Sends "audio not available" message when OPENAI_API_KEY is missing (transcribeAudio throws)
// 5. Sends formatError() on unexpected errors (download failure, API failure)
// 6. Feedback message is sent (await) BEFORE handleIncomingMessage pipeline runs
// 7. Delegates transcribed text to handleIncomingMessage (verifying the full pipeline is invoked, covering onboarding/context edge cases)
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm run test:unit -- tests/unit/bot/handler.test.ts`
Expected: FAIL — `handleIncomingAudio` not defined

- [ ] **Step 3: Implement `handleIncomingAudio`**

Add to `src/lib/bot/handler.ts`:

```typescript
import { downloadWhatsAppMedia, transcribeAudio, AudioTooLargeError } from '@/lib/audio/transcribe'
import { logLLMUsage } from '@/lib/db/queries/llm-usage'

export async function handleIncomingAudio(
  from: string,
  messageId: string,
  audioId: string
): Promise<void> {
  const supabase = createServiceRoleClient()

  try {
    let buffer: Buffer
    try {
      buffer = await downloadWhatsAppMedia(audioId)
    } catch (err) {
      if (err instanceof AudioTooLargeError) {
        await sendTextMessage(from, '🎤 Áudio muito longo! Manda um áudio de até 30 segundos 😊')
        return
      }
      throw err
    }

    let transcription: string
    let latencyMs: number
    try {
      const result = await transcribeAudio(buffer)
      transcription = result.text
      latencyMs = result.latencyMs
    } catch (err) {
      if (err instanceof Error && err.message.includes('OPENAI_API_KEY')) {
        await sendTextMessage(from, '🎤 Suporte a áudio não está disponível. Digita o que comeu?')
        return
      }
      throw err
    }

    // Log Whisper API usage (fire-and-forget)
    logLLMUsage(supabase, {
      provider: 'openai',
      model: 'whisper-1',
      functionType: 'audio_transcription',
      latencyMs,
      success: true,
    }).catch(() => {})

    if (!transcription.trim()) {
      await sendTextMessage(from, '🎤 Não consegui entender o áudio. Tenta mandar de novo ou digita o que comeu?')
      return
    }

    await sendTextMessage(from, `🎤 Entendi: *${transcription}*`)
    await handleIncomingMessage(from, messageId, transcription)
  } catch (err) {
    console.error('[handler] Audio error:', err)
    await sendTextMessage(from, formatError()).catch(() => {})
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm run test:unit -- tests/unit/bot/handler.test.ts`
Expected: All tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/lib/bot/handler.ts tests/unit/bot/handler.test.ts
git commit -m "feat: add handleIncomingAudio to bot handler"
```

---

## Task 5: Webhook route — add audio branch

**Files:**
- Modify: `src/app/api/webhook/whatsapp/route.ts`
- Modify: `tests/unit/webhook/route.test.ts`

- [ ] **Step 1: Add handler mock to route test file**

The existing `tests/unit/webhook/route.test.ts` does NOT mock `@/lib/bot/handler`. Add mock setup at the top of the file (alongside the existing Supabase mock):

```typescript
const { mockHandleIncomingMessage, mockHandleIncomingAudio } = vi.hoisted(() => ({
  mockHandleIncomingMessage: vi.fn().mockResolvedValue(undefined),
  mockHandleIncomingAudio: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('@/lib/bot/handler', () => ({
  handleIncomingMessage: mockHandleIncomingMessage,
  handleIncomingAudio: mockHandleIncomingAudio,
}))
```

- [ ] **Step 2: Write failing test for audio routing**

Add to `tests/unit/webhook/route.test.ts`:

```typescript
function makeAudioPayload() {
  return {
    object: 'whatsapp_business_account',
    entry: [{
      id: 'BIZ_ACCOUNT_ID',
      changes: [{
        value: {
          messaging_product: 'whatsapp',
          messages: [{
            from: '5511999887766',
            id: 'wamid.audio789',
            timestamp: '1710000002',
            type: 'audio',
            audio: { id: 'media_audio_123', mime_type: 'audio/ogg' },
          }],
        },
        field: 'messages',
      }],
    }],
  }
}

// Test: returns 200 for audio message and calls mockHandleIncomingAudio with correct args
// Test: returns 200 for audio message even when mockHandleIncomingAudio throws
// Test: deduplication works for audio messages (insert error → no handler call)
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `npm run test:unit -- tests/unit/webhook/route.test.ts`
Expected: FAIL — audio branch not implemented

- [ ] **Step 4: Add audio branch to route.ts**

In `src/app/api/webhook/whatsapp/route.ts`, import `handleIncomingAudio` and add after the text branch:

```typescript
if (event.type === 'audio' && event.audioId) {
  await handleIncomingAudio(event.from, event.messageId, event.audioId)
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npm run test:unit -- tests/unit/webhook/route.test.ts`
Expected: All tests PASS

- [ ] **Step 6: Commit**

```bash
git add src/app/api/webhook/whatsapp/route.ts tests/unit/webhook/route.test.ts
git commit -m "feat: route audio messages to handleIncomingAudio in webhook"
```

---

## Task 6: Environment and documentation updates

**Files:**
- Modify: `.env.example`
- Modify: `CLAUDE.md`

- [ ] **Step 1: Add `OPENAI_API_KEY` to `.env.example`**

Add under a new `# Audio (OpenAI Whisper)` section:

```
# Audio (OpenAI Whisper — for voice message transcription)
OPENAI_API_KEY=
```

- [ ] **Step 2: Update `CLAUDE.md` — project structure**

Add `│   │   ├── audio/` section under `src/lib/`:

```
│   │   ├── audio/
│   │   │   └── transcribe.ts         # Download WhatsApp media + Whisper transcription
```

- [ ] **Step 3: Update `CLAUDE.md` — environment variables**

Add `OPENAI_API_KEY` to the env vars section:

```
# Audio (OpenAI Whisper)
OPENAI_API_KEY=sk-...                                       # transcrição de áudio via Whisper
```

- [ ] **Step 4: Update `CLAUDE.md` — WhatsAppMessage type reference**

In the webhook description or wherever message types are referenced, note that `audio` is now a supported type.

- [ ] **Step 5: Run full test suite**

Run: `npm run test:unit`
Expected: All tests PASS (no regressions)

- [ ] **Step 6: Run TypeScript type check**

Run: `npx tsc --noEmit`
Expected: No errors

- [ ] **Step 7: Commit**

```bash
git add .env.example CLAUDE.md
git commit -m "docs: update env and CLAUDE.md for audio message support"
```

---

## Task 7: Manual integration test

**Files:** None (verification only)

- [ ] **Step 1: Add `OPENAI_API_KEY` to `.env.local`**

Add your OpenAI API key to `.env.local`.

- [ ] **Step 2: Start dev server and ngrok**

```bash
npm run dev       # terminal 1
ngrok http 3000   # terminal 2
```

- [ ] **Step 3: Send a voice note via WhatsApp**

Send a short voice note (< 30s) to the bot's WhatsApp number. Verify:
1. Bot responds with "🎤 Entendi: *{transcription}*"
2. Bot processes the transcription through the normal pipeline (e.g., logs a meal if you described food)

- [ ] **Step 4: Test edge cases**

1. Send a long voice note (> 30s) — should get "🎤 Áudio muito longo!" response
2. Send an unintelligible audio — should get "🎤 Não consegui entender" response
3. Send a text message — should work exactly as before (no regression)
