# Audio Message Support for CalorieBot

**Date:** 2026-03-22
**Status:** Approved

## Summary

Add support for WhatsApp audio messages (voice notes). When a user sends an audio message, the bot downloads it, transcribes it using OpenAI Whisper API, shows the transcription as feedback, and processes it through the existing text pipeline.

## Decisions

- **STT Provider:** OpenAI Whisper API (`api.openai.com/v1/audio/transcriptions`), via dedicated `OPENAI_API_KEY`
- **Feedback:** Always show transcription before processing — "🎤 Entendi: *{texto}*"
- **Duration limit:** 30 seconds (~480KB OGG/Opus)
- **Architecture:** Dedicated audio module (`src/lib/audio/transcribe.ts`), not inline in handler
- **No retry on transcription failure** — user can resend

## Changes

### 1. Webhook parsing (`src/lib/whatsapp/webhook.ts`)

- Add `'audio'` to `WhatsAppMessage.type` union: `'text' | 'image' | 'audio' | 'unknown'`
- Add optional field `audioId?: string` to `WhatsAppMessage`
- Add `RawMessage.audio` handling: when `msgType === 'audio'`, extract `audio.id` from payload
- WhatsApp sends: `{ audio: { id: "MEDIA_ID", mime_type: "audio/ogg" } }`

### 2. Audio module (`src/lib/audio/transcribe.ts`) — NEW

Two exported functions:

**`downloadWhatsAppMedia(mediaId: string): Promise<Buffer>`**
1. `GET https://graph.facebook.com/v21.0/{mediaId}` with `WHATSAPP_ACCESS_TOKEN` → returns JSON with `url`
2. `GET {url}` with same auth header → returns audio binary
3. Validates size (reject if > ~480KB for 30s limit)
4. Throws descriptive error on failure

**`transcribeAudio(audioBuffer: Buffer): Promise<string>`**
1. `POST https://api.openai.com/v1/audio/transcriptions`
2. Sends buffer as `multipart/form-data` with `model: "whisper-1"`, `language: "pt"`
3. Uses `OPENAI_API_KEY` env var
4. Returns transcribed text string

### 3. Webhook route (`src/app/api/webhook/whatsapp/route.ts`)

Add branch in POST handler:
```
if (event.type === 'audio' && event.audioId) {
  await handleIncomingAudio(event.from, event.messageId, event.audioId)
}
```

### 4. Bot handler (`src/lib/bot/handler.ts`)

New exported function:

**`handleIncomingAudio(from: string, messageId: string, audioId: string): Promise<void>`**
1. Call `downloadWhatsAppMedia(audioId)` — if size exceeds limit, respond: "🎤 Áudio muito longo! Manda um áudio de até 30 segundos 😊"
2. Call `transcribeAudio(buffer)` — if transcription is empty, respond: "🎤 Não consegui entender o áudio. Tenta mandar de novo ou digita o que comeu?"
3. Send feedback: "🎤 Entendi: *{transcribed text}*"
4. Call `handleIncomingMessage(from, messageId, transcribedText)` — reuses 100% of existing pipeline

On any error (download fail, API fail), respond with standard error message via `formatError()`.

### 5. Environment

New env var in `.env.local` and `.env.example`:
```
OPENAI_API_KEY=sk-...
```

## Edge Cases

- **Audio during onboarding** — works normally; transcribed text enters onboarding flow
- **Audio during active conversation** (awaiting confirmation, etc.) — works; text goes through context pipeline
- **Audio format** — WhatsApp sends OGG/Opus, Whisper accepts natively, no conversion needed
- **Webhook always returns 200** — even if transcription fails
- **Empty transcription** — user gets friendly message asking to retry or type instead
- **No retry on transcription** — unlike LLM calls, not worth retrying; user can resend audio

## Files Modified

| File | Change |
|------|--------|
| `src/lib/whatsapp/webhook.ts` | Add `audio` type + `audioId` field + parsing |
| `src/lib/audio/transcribe.ts` | **NEW** — download media + transcribe functions |
| `src/app/api/webhook/whatsapp/route.ts` | Add audio branch in POST handler |
| `src/lib/bot/handler.ts` | Add `handleIncomingAudio` function |
| `.env.example` | Add `OPENAI_API_KEY` |
| `.env.local` | Add `OPENAI_API_KEY` value |
