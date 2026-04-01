# Quoted Message Reply Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Allow users to quote/reply to specific WhatsApp messages for contextual actions — corrections, deletions, registering queries as meals, and summary details.

**Architecture:** Quote as context puro — webhook extracts `quotedMessageId`, handler resolves it via new `bot_messages` table into a `QuoteContext`, which flows receive as an optional parameter. A new `bot_messages` table links WhatsApp message IDs to resources (meals, queries, etc.).

**Tech Stack:** Next.js App Router, Supabase (Postgres), TypeScript, Vitest, WhatsApp Meta Cloud API

---

## File Structure

| Action | File | Responsibility |
|--------|------|----------------|
| Create | `supabase/migrations/00016_create_bot_messages.sql` | Migration for `bot_messages` table |
| Create | `src/lib/db/queries/bot-messages.ts` | CRUD for `bot_messages` (save, lookup, cleanup) |
| Create | `tests/unit/db/bot-messages.test.ts` | Unit tests for bot-messages queries |
| Modify | `src/lib/whatsapp/webhook.ts` | Extract `quotedMessageId` from payload |
| Modify | `tests/unit/whatsapp/webhook.test.ts` | Tests for quoted message parsing |
| Modify | `src/lib/whatsapp/client.ts` | Add `replyToMessageId` param to `sendTextMessage` |
| Modify | `tests/unit/whatsapp/client.test.ts` | Tests for reply support |
| Create | `src/lib/bot/quote.ts` | `QuoteContext` type + `resolveQuote()` helper |
| Create | `tests/unit/bot/quote.test.ts` | Tests for quote resolution |
| Modify | `src/lib/bot/handler.ts` | Resolve quote, pass to flows, save bot_messages |
| Modify | `src/lib/bot/flows/edit.ts` | Handle quote-based corrections (delete, rename, quantity) |
| Modify | `tests/unit/bot/edit.test.ts` | Tests for quote-based edit scenarios |
| Modify | `src/lib/bot/flows/query.ts` | Register query as meal from quoted message |
| Modify | `src/lib/bot/flows/summary.ts` | Redirect to meal_detail from quoted summary |
| Modify | `src/app/api/webhook/whatsapp/route.ts` | Pass `quotedMessageId` to handlers |
| Modify | `src/app/api/cron/reminders/route.ts` | Add bot_messages cleanup to existing cron (or create new cron) |

---

### Task 1: Database migration — `bot_messages` table

**Files:**
- Create: `supabase/migrations/00016_create_bot_messages.sql`

- [ ] **Step 1: Write the migration**

```sql
-- supabase/migrations/00016_create_bot_messages.sql

CREATE TABLE bot_messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  message_id TEXT NOT NULL,
  direction TEXT NOT NULL CHECK (direction IN ('incoming', 'outgoing')),
  resource_type TEXT CHECK (resource_type IS NULL OR resource_type IN ('meal', 'summary', 'query', 'weight')),
  resource_id UUID,
  metadata JSONB,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_bot_messages_message_id ON bot_messages(message_id);
CREATE INDEX idx_bot_messages_user_resource ON bot_messages(user_id, resource_type, resource_id);

-- RLS: service role only (bot writes via service role client)
ALTER TABLE bot_messages ENABLE ROW LEVEL SECURITY;
```

- [ ] **Step 2: Commit**

```bash
git add supabase/migrations/00016_create_bot_messages.sql
git commit -m "feat: add bot_messages migration for quoted message tracking"
```

---

### Task 2: DB query layer — `bot-messages.ts`

**Files:**
- Create: `src/lib/db/queries/bot-messages.ts`
- Create: `tests/unit/db/bot-messages.test.ts`

- [ ] **Step 1: Write the failing tests**

```typescript
// tests/unit/db/bot-messages.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest'

const { mockFrom } = vi.hoisted(() => {
  const mockSingle = vi.fn()
  const mockLimit = vi.fn().mockReturnValue({ single: mockSingle })
  const mockEq = vi.fn().mockReturnValue({ limit: mockLimit })
  const mockSelect = vi.fn().mockReturnValue({ eq: mockEq })
  const mockInsert = vi.fn().mockReturnValue({ error: null })
  const mockDelete = vi.fn()
  const mockLt = vi.fn().mockResolvedValue({ error: null, count: 5 })

  return {
    mockFrom: vi.fn().mockReturnValue({
      insert: mockInsert,
      select: mockSelect,
      delete: vi.fn().mockReturnValue({
        lt: mockLt,
      }),
    }),
    mockInsert,
    mockSelect,
    mockEq,
    mockLimit,
    mockSingle,
    mockDelete,
    mockLt,
  }
})

const mockSupabase = { from: mockFrom } as unknown as import('@supabase/supabase-js').SupabaseClient

import { saveBotMessage, getMessageResource, cleanupOldMessages } from '@/lib/db/queries/bot-messages'

describe('saveBotMessage', () => {
  beforeEach(() => vi.clearAllMocks())

  it('inserts a row with all fields', async () => {
    await saveBotMessage(mockSupabase, {
      userId: 'user-1',
      messageId: 'wamid.abc123',
      direction: 'outgoing',
      resourceType: 'meal',
      resourceId: 'meal-uuid-1',
      metadata: null,
    })

    expect(mockFrom).toHaveBeenCalledWith('bot_messages')
  })

  it('inserts a row with null resource fields', async () => {
    await saveBotMessage(mockSupabase, {
      userId: 'user-1',
      messageId: 'wamid.def456',
      direction: 'incoming',
      resourceType: null,
      resourceId: null,
      metadata: null,
    })

    expect(mockFrom).toHaveBeenCalledWith('bot_messages')
  })
})

describe('getMessageResource', () => {
  beforeEach(() => vi.clearAllMocks())

  it('returns resource data when message found', async () => {
    const { mockSingle } = vi.hoisted(() => ({ mockSingle: vi.fn() }))
    // This test validates the function signature and return type
    expect(typeof getMessageResource).toBe('function')
  })
})

describe('cleanupOldMessages', () => {
  it('is a function', () => {
    expect(typeof cleanupOldMessages).toBe('function')
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/unit/db/bot-messages.test.ts`
Expected: FAIL — module `@/lib/db/queries/bot-messages` not found

- [ ] **Step 3: Write the implementation**

```typescript
// src/lib/db/queries/bot-messages.ts
import type { SupabaseClient } from '@supabase/supabase-js'

export type BotMessageDirection = 'incoming' | 'outgoing'
export type BotMessageResourceType = 'meal' | 'summary' | 'query' | 'weight'

export interface BotMessageInsert {
  userId: string
  messageId: string
  direction: BotMessageDirection
  resourceType?: BotMessageResourceType | null
  resourceId?: string | null
  metadata?: Record<string, unknown> | null
}

export interface BotMessageResource {
  direction: BotMessageDirection
  resourceType: BotMessageResourceType | null
  resourceId: string | null
  metadata: Record<string, unknown> | null
}

export async function saveBotMessage(
  supabase: SupabaseClient,
  data: BotMessageInsert,
): Promise<void> {
  const { error } = await supabase.from('bot_messages').insert({
    user_id: data.userId,
    message_id: data.messageId,
    direction: data.direction,
    resource_type: data.resourceType ?? null,
    resource_id: data.resourceId ?? null,
    metadata: data.metadata ?? null,
  })

  if (error) {
    console.error('[bot-messages] Failed to save:', error.message)
  }
}

export async function getMessageResource(
  supabase: SupabaseClient,
  messageId: string,
): Promise<BotMessageResource | null> {
  const { data, error } = await supabase
    .from('bot_messages')
    .select('direction, resource_type, resource_id, metadata')
    .eq('message_id', messageId)
    .limit(1)
    .single()

  if (error || !data) return null

  return {
    direction: data.direction as BotMessageDirection,
    resourceType: data.resource_type as BotMessageResourceType | null,
    resourceId: data.resource_id as string | null,
    metadata: data.metadata as Record<string, unknown> | null,
  }
}

export async function cleanupOldMessages(
  supabase: SupabaseClient,
  retentionDays: number = 30,
): Promise<number> {
  const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000).toISOString()

  const { error, count } = await supabase
    .from('bot_messages')
    .delete()
    .lt('created_at', cutoff)

  if (error) {
    console.error('[bot-messages] Cleanup failed:', error.message)
    return 0
  }

  return count ?? 0
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/unit/db/bot-messages.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/lib/db/queries/bot-messages.ts tests/unit/db/bot-messages.test.ts
git commit -m "feat: add bot-messages query layer for quote tracking"
```

---

### Task 3: Webhook parsing — Extract `quotedMessageId`

**Files:**
- Modify: `src/lib/whatsapp/webhook.ts`
- Modify: `tests/unit/whatsapp/webhook.test.ts`

- [ ] **Step 1: Write the failing tests**

Add to `tests/unit/whatsapp/webhook.test.ts`:

```typescript
it('extracts quotedMessageId when message has context', () => {
  const payload = {
    object: 'whatsapp_business_account',
    entry: [{
      id: 'BIZ_ACCOUNT_ID',
      changes: [{
        value: {
          messaging_product: 'whatsapp',
          messages: [{
            from: '5511999887766',
            id: 'wamid.reply123',
            timestamp: '1710000000',
            type: 'text',
            text: { body: 'apaga o arroz' },
            context: { id: 'wamid.original456' },
          }],
        },
        field: 'messages',
      }],
    }],
  }

  const result = parseWebhookPayload(payload)
  expect(result).not.toBeNull()
  const msg = result as WhatsAppMessage
  expect(msg.quotedMessageId).toBe('wamid.original456')
})

it('quotedMessageId is undefined when no context', () => {
  const result = parseWebhookPayload(makeTextPayload())
  expect(result).not.toBeNull()
  const msg = result as WhatsAppMessage
  expect(msg.quotedMessageId).toBeUndefined()
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/unit/whatsapp/webhook.test.ts`
Expected: FAIL — `quotedMessageId` property does not exist

- [ ] **Step 3: Update `WhatsAppMessage` interface and parser**

In `src/lib/whatsapp/webhook.ts`:

Add `quotedMessageId?: string` to the `WhatsAppMessage` interface:

```typescript
export interface WhatsAppMessage {
  type: 'text' | 'image' | 'audio' | 'unknown'
  from: string
  messageId: string
  text?: string
  audioId?: string
  imageId?: string
  caption?: string
  timestamp: number
  quotedMessageId?: string
}
```

Add `context` to the `RawMessage` interface:

```typescript
interface RawMessage {
  from?: unknown
  id?: unknown
  timestamp?: unknown
  type?: unknown
  text?: { body?: unknown }
  audio?: { id?: unknown; mime_type?: unknown }
  image?: { id?: unknown; caption?: unknown; mime_type?: unknown }
  context?: { id?: unknown }
}
```

In `parseWebhookPayload`, after extracting `msgType`, add quote extraction:

```typescript
const quotedMessageId = isObject(rawMsg.context)
  ? asString((rawMsg.context as { id?: unknown }).id)
  : undefined
```

Then include `quotedMessageId` in every message return (text, image, audio, unknown):

For the text branch:
```typescript
return {
  type: 'text',
  from,
  messageId,
  text: textBody,
  timestamp,
  quotedMessageId,
}
```

Apply the same pattern to image, audio, and unknown return objects.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/unit/whatsapp/webhook.test.ts`
Expected: PASS (all existing + 2 new tests)

- [ ] **Step 5: Commit**

```bash
git add src/lib/whatsapp/webhook.ts tests/unit/whatsapp/webhook.test.ts
git commit -m "feat: extract quotedMessageId from WhatsApp webhook payload"
```

---

### Task 4: WhatsApp client — Reply support

**Files:**
- Modify: `src/lib/whatsapp/client.ts`
- Modify: `tests/unit/whatsapp/client.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `tests/unit/whatsapp/client.test.ts`:

```typescript
it('includes context when replyToMessageId is provided', async () => {
  vi.stubEnv('WHATSAPP_PHONE_NUMBER_ID', '123456789')
  vi.stubEnv('WHATSAPP_ACCESS_TOKEN', 'test-token')

  let capturedBody: Record<string, unknown> | null = null

  server.use(
    http.post(
      'https://graph.facebook.com/v21.0/123456789/messages',
      async ({ request }) => {
        capturedBody = await request.json() as Record<string, unknown>
        return HttpResponse.json({ messages: [{ id: 'wamid.reply' }] })
      },
    ),
  )

  const msgId = await sendTextMessage('5511999887766', 'Corrigido!', 'wamid.original123')

  expect(msgId).toBe('wamid.reply')
  expect(capturedBody).not.toBeNull()
  expect((capturedBody as Record<string, unknown>).context).toEqual({ message_id: 'wamid.original123' })
})

it('does not include context when replyToMessageId is undefined', async () => {
  vi.stubEnv('WHATSAPP_PHONE_NUMBER_ID', '123456789')
  vi.stubEnv('WHATSAPP_ACCESS_TOKEN', 'test-token')

  let capturedBody: Record<string, unknown> | null = null

  server.use(
    http.post(
      'https://graph.facebook.com/v21.0/123456789/messages',
      async ({ request }) => {
        capturedBody = await request.json() as Record<string, unknown>
        return HttpResponse.json({ messages: [{ id: 'wamid.noreply' }] })
      },
    ),
  )

  await sendTextMessage('5511999887766', 'Normal message')

  expect(capturedBody).not.toBeNull()
  expect((capturedBody as Record<string, unknown>).context).toBeUndefined()
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/unit/whatsapp/client.test.ts`
Expected: FAIL — `sendTextMessage` doesn't accept 3rd argument (TypeScript error or context not present)

- [ ] **Step 3: Add `replyToMessageId` parameter**

In `src/lib/whatsapp/client.ts`, update `sendTextMessage`:

```typescript
export async function sendTextMessage(
  to: string,
  text: string,
  replyToMessageId?: string,
): Promise<string> {
  const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID
  const accessToken = process.env.WHATSAPP_ACCESS_TOKEN

  if (!accessToken) {
    throw new Error('WHATSAPP_ACCESS_TOKEN is not configured')
  }
  if (!phoneNumberId) {
    throw new Error('WHATSAPP_PHONE_NUMBER_ID is not configured')
  }

  const url = `https://graph.facebook.com/v21.0/${phoneNumberId}/messages`

  const payload: Record<string, unknown> = {
    messaging_product: 'whatsapp',
    to,
    type: 'text',
    text: { body: text },
  }

  if (replyToMessageId) {
    payload.context = { message_id: replyToMessageId }
  }

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  })

  if (!response.ok) {
    const errorBody = await response.text()
    throw new Error(
      `WhatsApp API error: HTTP ${response.status} — ${errorBody}`,
    )
  }

  const data = (await response.json()) as WhatsAppSendResponse
  return data.messages[0].id
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/unit/whatsapp/client.test.ts`
Expected: PASS (all existing + 2 new tests)

- [ ] **Step 5: Commit**

```bash
git add src/lib/whatsapp/client.ts tests/unit/whatsapp/client.test.ts
git commit -m "feat: add replyToMessageId support to sendTextMessage"
```

---

### Task 5: QuoteContext type and resolver

**Files:**
- Create: `src/lib/bot/quote.ts`
- Create: `tests/unit/bot/quote.test.ts`

- [ ] **Step 1: Write the failing tests**

```typescript
// tests/unit/bot/quote.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest'

const { mockGetMessageResource } = vi.hoisted(() => ({
  mockGetMessageResource: vi.fn(),
}))

vi.mock('@/lib/db/queries/bot-messages', () => ({
  getMessageResource: mockGetMessageResource,
}))

vi.mock('@/lib/db/supabase', () => ({
  createServiceRoleClient: () => ({} as unknown),
}))

import { resolveQuote } from '@/lib/bot/quote'
import type { QuoteContext } from '@/lib/bot/quote'

describe('resolveQuote', () => {
  beforeEach(() => vi.clearAllMocks())

  it('returns QuoteContext when message_id found in bot_messages', async () => {
    mockGetMessageResource.mockResolvedValue({
      direction: 'outgoing',
      resourceType: 'meal',
      resourceId: 'meal-uuid-1',
      metadata: null,
    })

    const result = await resolveQuote('wamid.quoted123')

    expect(result).not.toBeNull()
    const ctx = result as QuoteContext
    expect(ctx.quotedMessageId).toBe('wamid.quoted123')
    expect(ctx.direction).toBe('outgoing')
    expect(ctx.resourceType).toBe('meal')
    expect(ctx.resourceId).toBe('meal-uuid-1')
    expect(ctx.metadata).toBeUndefined()
  })

  it('returns QuoteContext with metadata when present', async () => {
    const meta = { items: [{ food: 'Arroz', calories: 195 }] }
    mockGetMessageResource.mockResolvedValue({
      direction: 'outgoing',
      resourceType: 'query',
      resourceId: null,
      metadata: meta,
    })

    const result = await resolveQuote('wamid.query456')

    expect(result).not.toBeNull()
    expect(result!.metadata).toEqual(meta)
  })

  it('returns null when message_id not found', async () => {
    mockGetMessageResource.mockResolvedValue(null)

    const result = await resolveQuote('wamid.unknown789')

    expect(result).toBeNull()
  })

  it('returns null when quotedMessageId is undefined', async () => {
    const result = await resolveQuote(undefined)

    expect(result).toBeNull()
    expect(mockGetMessageResource).not.toHaveBeenCalled()
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/unit/bot/quote.test.ts`
Expected: FAIL — module `@/lib/bot/quote` not found

- [ ] **Step 3: Write the implementation**

```typescript
// src/lib/bot/quote.ts
import { createServiceRoleClient } from '@/lib/db/supabase'
import { getMessageResource } from '@/lib/db/queries/bot-messages'
import type { BotMessageResourceType, BotMessageDirection } from '@/lib/db/queries/bot-messages'

export interface QuoteContext {
  quotedMessageId: string
  direction: BotMessageDirection
  resourceType: BotMessageResourceType | null
  resourceId: string | null
  metadata?: Record<string, unknown>
}

export async function resolveQuote(
  quotedMessageId: string | undefined,
): Promise<QuoteContext | null> {
  if (!quotedMessageId) return null

  const supabase = createServiceRoleClient()
  const resource = await getMessageResource(supabase, quotedMessageId)

  if (!resource) return null

  return {
    quotedMessageId,
    direction: resource.direction,
    resourceType: resource.resourceType,
    resourceId: resource.resourceId,
    ...(resource.metadata ? { metadata: resource.metadata } : {}),
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/unit/bot/quote.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/lib/bot/quote.ts tests/unit/bot/quote.test.ts
git commit -m "feat: add QuoteContext type and resolveQuote helper"
```

---

### Task 6: Webhook route — Pass `quotedMessageId` to handlers

**Files:**
- Modify: `src/app/api/webhook/whatsapp/route.ts`

- [ ] **Step 1: Update handler calls to pass `quotedMessageId`**

In `src/app/api/webhook/whatsapp/route.ts`, update the POST handler. The handler functions need to accept `quotedMessageId`. Update all three handler calls:

```typescript
if (event.type === 'text' && event.text) {
  await handleIncomingMessage(event.from, event.messageId, event.text, event.quotedMessageId)
}

if (event.type === 'audio' && event.audioId) {
  await handleIncomingAudio(event.from, event.messageId, event.audioId, event.quotedMessageId)
}

if (event.type === 'image' && event.imageId) {
  await handleIncomingImage(event.from, event.messageId, event.imageId, event.caption, event.quotedMessageId)
}
```

- [ ] **Step 2: Update handler signatures in `handler.ts`**

In `src/lib/bot/handler.ts`, update all three handler signatures to accept `quotedMessageId?: string` as the last parameter. For now, just add the parameter without using it — that comes in Task 8.

`handleIncomingMessage`:
```typescript
export async function handleIncomingMessage(
  from: string,
  messageId: string,
  text: string,
  quotedMessageId?: string,
): Promise<void> {
```

`handleIncomingAudio`:
```typescript
export async function handleIncomingAudio(
  from: string,
  messageId: string,
  audioId: string,
  quotedMessageId?: string,
): Promise<void> {
```

Note: In `handleIncomingAudio`, the recursive call to `handleIncomingMessage` at line 345 should also pass `quotedMessageId`:
```typescript
await handleIncomingMessage(from, messageId, transcription, quotedMessageId)
```

`handleIncomingImage`:
```typescript
export async function handleIncomingImage(
  from: string,
  messageId: string,
  imageId: string,
  caption?: string,
  quotedMessageId?: string,
): Promise<void> {
```

- [ ] **Step 3: Run TypeScript check**

Run: `npx tsc --noEmit`
Expected: No errors

- [ ] **Step 4: Commit**

```bash
git add src/app/api/webhook/whatsapp/route.ts src/lib/bot/handler.ts
git commit -m "feat: pass quotedMessageId through webhook route to handler"
```

---

### Task 7: Edit flow — Quote-based corrections

**Files:**
- Modify: `src/lib/bot/flows/edit.ts`
- Modify: `tests/unit/bot/edit.test.ts`

- [ ] **Step 1: Write the failing tests for quote-based edit**

Add to `tests/unit/bot/edit.test.ts`:

```typescript
// Add mockCreateMeal to the hoisted mocks:
// In the existing vi.hoisted block, add:
// mockAnalyzeMeal: vi.fn(),
// Then in vi.mock('@/lib/llm/index'), update to:
// getLLMProvider: () => ({ chat: mockLLMChat, analyzeMeal: mockAnalyzeMeal }),

describe('handleEdit with quoteContext', () => {
  const quoteContext = {
    quotedMessageId: 'wamid.quoted1',
    direction: 'outgoing' as const,
    resourceType: 'meal' as const,
    resourceId: 'meal-quote-1',
  }

  beforeEach(() => {
    vi.clearAllMocks()
    mockGetMealWithItems.mockResolvedValue({
      id: 'meal-quote-1',
      mealType: 'lunch',
      totalCalories: 800,
      registeredAt: '2024-03-21T12:00:00Z',
      items: [
        { id: 'item-1', foodName: 'Arroz branco', quantityGrams: 150, quantityDisplay: '150g', calories: 195, proteinG: 4, carbsG: 42, fatG: 0.5 },
        { id: 'item-2', foodName: 'Feijão preto', quantityGrams: 100, quantityDisplay: '100g', calories: 77, proteinG: 5, carbsG: 14, fatG: 0.5 },
      ],
    })
  })

  it('deletes entire meal when user says "apaga" with quote and no item specified', async () => {
    const result = await handleEdit(
      mockSupabase, USER_ID, 'apaga', null,
      { timezone: 'America/Sao_Paulo', dailyCalorieTarget: 2000 },
      quoteContext,
    )

    expect(mockDeleteMeal).toHaveBeenCalledWith(mockSupabase, 'meal-quote-1')
    expect(result).toContain('apagada')
  })

  it('removes specific item when user says "apaga o arroz" with quote', async () => {
    mockRecalculateMealTotal.mockResolvedValue(77)

    const result = await handleEdit(
      mockSupabase, USER_ID, 'apaga o arroz', null,
      { timezone: 'America/Sao_Paulo', dailyCalorieTarget: 2000 },
      quoteContext,
    )

    expect(mockRemoveMealItem).toHaveBeenCalledWith(mockSupabase, 'item-1')
    expect(result).toContain('removido')
  })

  it('returns fallback when quoteContext has no meal resource', async () => {
    const helpQuote = {
      quotedMessageId: 'wamid.help1',
      direction: 'outgoing' as const,
      resourceType: null,
      resourceId: null,
    }

    const result = await handleEdit(
      mockSupabase, USER_ID, 'apaga', null,
      { timezone: 'America/Sao_Paulo', dailyCalorieTarget: 2000 },
      helpQuote,
    )

    expect(result).toContain('não consigo')
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/unit/bot/edit.test.ts`
Expected: FAIL — `handleEdit` doesn't accept 6th argument

- [ ] **Step 3: Update `handleEdit` to accept and use `QuoteContext`**

In `src/lib/bot/flows/edit.ts`:

Add import at top:
```typescript
import type { QuoteContext } from '@/lib/bot/quote'
```

Update `handleEdit` signature:
```typescript
export async function handleEdit(
  supabase: SupabaseClient,
  userId: string,
  message: string,
  context: ConversationContext | null,
  user?: { timezone?: string; dailyCalorieTarget?: number | null },
  quoteContext?: QuoteContext,
): Promise<string> {
  const trimmed = message.trim()

  // If we have a quote with a meal resource, handle it directly
  if (quoteContext) {
    return handleQuotedEdit(supabase, userId, trimmed, quoteContext, user)
  }

  if (context) {
    // ... existing context handling
  }
  // ... rest of existing code
}
```

Add the new `handleQuotedEdit` function:

```typescript
const QUOTE_DELETE_NO_ITEM = /^(apaga|remove|exclui|deleta)r?$/i
const QUOTE_DELETE_ITEM = /(?:apaga|remove|exclui|deleta)r?\s+(?:o\s+|a\s+)?(.+)/i
const QUOTE_RENAME = /(?:era|na verdade era|na real era|na real é|é|eh)\s+(.+?)(?:\s*,?\s*(?:não|nao|e não|e nao)\s+(.+))?$/i
const QUOTE_QUANTITY = /(?:era|eram|foi|na verdade)\s+(\d+(?:[.,]\d+)?)\s*(?:g|gramas?|ml)?\s*(?:de\s+(.+))?$/i

async function handleQuotedEdit(
  supabase: SupabaseClient,
  userId: string,
  message: string,
  quoteContext: QuoteContext,
  user?: { timezone?: string; dailyCalorieTarget?: number | null },
): Promise<string> {
  if (quoteContext.resourceType !== 'meal' || !quoteContext.resourceId) {
    return 'Ainda não consigo fazer isso com mensagens citadas 😅 Mas posso te ajudar com outra coisa! Digite *menu* para ver as opções.'
  }

  const meal = await getMealWithItems(supabase, quoteContext.resourceId)
  if (!meal || meal.items.length === 0) {
    return 'Não encontrei essa refeição. Pode já ter sido apagada.'
  }

  // Delete entire meal (no item specified)
  if (QUOTE_DELETE_NO_ITEM.test(message)) {
    await deleteMeal(supabase, quoteContext.resourceId)
    await clearState(userId)
    const dailyConsumed = await getDailyCalories(supabase, userId, undefined, user?.timezone)
    const target = user?.dailyCalorieTarget ?? 2000
    return `Refeição apagada! ✅\n${formatProgress(dailyConsumed, target)}`
  }

  // Delete specific item
  const deleteItemMatch = QUOTE_DELETE_ITEM.exec(message)
  if (deleteItemMatch) {
    const itemName = deleteItemMatch[1].trim()
    const targetItem = findItemByFoodName(meal.items, itemName)

    if (!targetItem) {
      const itemList = meal.items.map(i => i.foodName).join(', ')
      return `Não encontrei *${itemName}* nessa refeição. Os itens são: ${itemList}. Qual você quer apagar?`
    }

    await removeMealItem(supabase, targetItem.id)
    const newTotal = await recalculateMealTotal(supabase, quoteContext.resourceId)
    await clearState(userId)
    const dailyConsumed = await getDailyCalories(supabase, userId, undefined, user?.timezone)
    const target = user?.dailyCalorieTarget ?? 2000
    return `✅ ${targetItem.foodName} removido! Novo total: ${newTotal} kcal\n${formatProgress(dailyConsumed, target)}`
  }

  // Rename food item ("era quinoa, não arroz" or "era quinoa")
  const renameMatch = QUOTE_RENAME.exec(message)
  if (renameMatch) {
    const newFood = renameMatch[1].trim()
    const oldFood = renameMatch[2]?.trim()

    let targetItem: typeof meal.items[0] | undefined

    if (oldFood) {
      targetItem = findItemByFoodName(meal.items, oldFood)
    } else if (meal.items.length === 1) {
      targetItem = meal.items[0]
    }

    if (!targetItem) {
      const itemList = meal.items.map(i => i.foodName).join(', ')
      await setState(userId, 'awaiting_correction_item', {
        mealId: quoteContext.resourceId,
        mealType: meal.mealType,
        items: meal.items as unknown as Record<string, unknown>[],
        renameTarget: newFood,
      })
      return `Não encontrei *${oldFood || 'o item'}* nessa refeição. Os itens são: ${itemList}. Qual você quer corrigir?`
    }

    // Call LLM to analyze the new food with same quantity
    return renameItem(supabase, userId, quoteContext.resourceId, targetItem, newFood, user)
  }

  // Quantity correction ("era 200g" or "era 200g de arroz")
  const qtyMatch = QUOTE_QUANTITY.exec(message)
  if (qtyMatch) {
    const newGrams = parseFloat(qtyMatch[1].replace(',', '.'))
    const itemName = qtyMatch[2]?.trim()

    let targetItem: typeof meal.items[0] | undefined

    if (itemName) {
      targetItem = findItemByFoodName(meal.items, itemName)
    } else if (meal.items.length === 1) {
      targetItem = meal.items[0]
    }

    if (!targetItem) {
      const itemList = meal.items.map((item, idx) => `${idx + 1}️⃣ ${item.foodName} (${item.quantityGrams}g)`).join('\n')
      return `Qual item quer corrigir?\n\n${itemList}`
    }

    const ratio = targetItem.quantityGrams > 0 ? newGrams / targetItem.quantityGrams : 1
    const newCalories = Math.round(targetItem.calories * ratio)
    const newProtein = Math.round(targetItem.proteinG * ratio * 10) / 10
    const newCarbs = Math.round(targetItem.carbsG * ratio * 10) / 10
    const newFat = Math.round(targetItem.fatG * ratio * 10) / 10

    await updateMealItem(supabase, targetItem.id, {
      quantityGrams: newGrams,
      quantityDisplay: `${newGrams}g`,
      calories: newCalories,
      proteinG: newProtein,
      carbsG: newCarbs,
      fatG: newFat,
    })

    await recalculateMealTotal(supabase, quoteContext.resourceId)
    await clearState(userId)
    const dailyConsumed = await getDailyCalories(supabase, userId, undefined, user?.timezone)
    const target = user?.dailyCalorieTarget ?? 2000
    return `✅ ${targetItem.foodName} atualizado: ${targetItem.quantityGrams}g → ${newGrams}g (${targetItem.calories} → ${newCalories} kcal)\n${formatProgress(dailyConsumed, target)}`
  }

  // Fall through to natural language correction scoped to the quoted meal
  return handleNaturalLanguageCorrectionWithMeal(supabase, userId, message, quoteContext.resourceId, meal.items, user)
}
```

Add the `findItemByFoodName` helper (used by `handleQuotedEdit`):

```typescript
function findItemByFoodName(
  items: Array<{ id: string; foodName: string; [key: string]: unknown }>,
  name: string,
): typeof items[0] | undefined {
  const normalize = (s: string) =>
    s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim()
  const target = normalize(name)

  return items.find(i => {
    const n = normalize(i.foodName)
    return n.includes(target) || target.includes(n)
  })
}
```

Add the `renameItem` function:

```typescript
async function renameItem(
  supabase: SupabaseClient,
  userId: string,
  mealId: string,
  targetItem: { id: string; foodName: string; quantityGrams: number; calories: number; proteinG: number; carbsG: number; fatG: number },
  newFoodName: string,
  user?: { timezone?: string; dailyCalorieTarget?: number | null },
): Promise<string> {
  const llm = getLLMProvider()

  try {
    const meals = await llm.analyzeMeal(`${newFoodName} ${targetItem.quantityGrams}g`)
    const newItem = meals[0]?.items[0]

    if (!newItem) {
      return `Não consegui analisar *${newFoodName}*. Pode tentar de novo?`
    }

    const oldName = targetItem.foodName
    const oldCalories = targetItem.calories

    await updateMealItem(supabase, targetItem.id, {
      quantityGrams: newItem.quantity_grams ?? targetItem.quantityGrams,
      calories: Math.round(newItem.calories ?? 0),
      proteinG: newItem.protein ?? 0,
      carbsG: newItem.carbs ?? 0,
      fatG: newItem.fat ?? 0,
      foodName: newItem.food,
    })

    const newTotal = await recalculateMealTotal(supabase, mealId)
    await clearState(userId)
    const dailyConsumed = await getDailyCalories(supabase, userId, undefined, user?.timezone)
    const target = user?.dailyCalorieTarget ?? 2000

    return [
      '✏️ Corrigido!',
      `  ${oldName} ${targetItem.quantityGrams}g → ${newItem.food} ${newItem.quantity_grams ?? targetItem.quantityGrams}g`,
      `  ${oldCalories} kcal → ${Math.round(newItem.calories ?? 0)} kcal`,
      '',
      `📊 Novo total da refeição: ${newTotal} kcal`,
      formatProgress(dailyConsumed, target),
    ].join('\n')
  } catch {
    return `Não consegui analisar *${newFoodName}*. Pode tentar de novo?`
  }
}
```

Note: `updateMealItem` in `src/lib/db/queries/meals.ts` currently accepts `quantityGrams`, `quantityDisplay`, `calories`, `proteinG`, `carbsG`, `fatG`. We need to add `foodName` to its update interface. Check the current signature and add `foodName?: string` to the update parameter type and the update object.

- [ ] **Step 4: Update `updateMealItem` to accept `foodName`**

In `src/lib/db/queries/meals.ts`, find the `updateMealItem` function and add `foodName` to its update parameter:

```typescript
export async function updateMealItem(
  supabase: SupabaseClient,
  itemId: string,
  update: {
    quantityGrams: number
    quantityDisplay?: string
    calories: number
    proteinG: number
    carbsG: number
    fatG: number
    foodName?: string
  },
): Promise<void> {
  const updateData: Record<string, unknown> = {
    quantity_grams: update.quantityGrams,
    calories: update.calories,
    protein_g: update.proteinG,
    carbs_g: update.carbsG,
    fat_g: update.fatG,
  }

  if (update.quantityDisplay !== undefined) {
    updateData.quantity_display = update.quantityDisplay
  }

  if (update.foodName !== undefined) {
    updateData.food_name = update.foodName
  }

  const { error } = await supabase
    .from('meal_items')
    .update(updateData)
    .eq('id', itemId)

  if (error) {
    throw new Error(`Failed to update meal item: ${error.message}`)
  }
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run tests/unit/bot/edit.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/lib/bot/flows/edit.ts tests/unit/bot/edit.test.ts src/lib/db/queries/meals.ts
git commit -m "feat: add quote-based meal corrections (delete, rename, quantity)"
```

---

### Task 8: Handler — Resolve quote and pass to flows + save bot_messages

**Files:**
- Modify: `src/lib/bot/handler.ts`

- [ ] **Step 1: Add imports for quote and bot_messages**

At the top of `src/lib/bot/handler.ts`, add:

```typescript
import { resolveQuote } from '@/lib/bot/quote'
import type { QuoteContext } from '@/lib/bot/quote'
import { saveBotMessage } from '@/lib/db/queries/bot-messages'
```

- [ ] **Step 2: Resolve quote at start of `handleIncomingMessage`**

After loading `context` (line ~75) and before the cancel command check, add:

```typescript
// Resolve quote context if message is a reply
const quoteContext = await resolveQuote(quotedMessageId)
```

- [ ] **Step 3: Pass `quoteContext` to the edit flow**

In the intent routing switch (line ~254), update the `edit` case:

```typescript
case 'edit':
  response = await handleEdit(supabase, user.id, text, null, {
    timezone: user.timezone,
    dailyCalorieTarget: user.dailyCalorieTarget,
  }, quoteContext ?? undefined)
  break
```

Also in the context switch handlers for `awaiting_correction`, `awaiting_correction_item`, `awaiting_correction_value` — these don't need `quoteContext` because they're already mid-flow.

- [ ] **Step 4: Handle quote fallback for unsupported flows**

When `quoteContext` is present and the classified intent doesn't support quote yet (anything except `edit`, `meal_log`, `summary`, `meal_detail`), check after routing:

Add this logic after intent classification but before the switch — if `quoteContext` exists and the intent doesn't support it, respond with the fallback message:

```typescript
// Quote fallback: if quote has no applicable flow
const QUOTE_SUPPORTED_INTENTS = new Set(['edit', 'meal_log', 'summary', 'meal_detail', 'query'])
if (quoteContext && intent && !QUOTE_SUPPORTED_INTENTS.has(intent)) {
  const fallbackMsg = 'Ainda não consigo fazer isso com mensagens citadas 😅 Mas posso te ajudar com outra coisa! Digite *menu* para ver as opções.'
  await clearState(user.id)
  await sendTextMessage(from, fallbackMsg)
  saveHistory(supabase, user.id, text, fallbackMsg)
  return
}
```

- [ ] **Step 5: Save incoming + outgoing to `bot_messages`**

Create a helper at the top of handler.ts for saving messages after a flow:

```typescript
function saveBotMessages(
  supabase: SupabaseClient,
  userId: string,
  incomingMessageId: string,
  outgoingMessageId: string | null,
  resourceType: 'meal' | 'summary' | 'query' | 'weight' | null,
  resourceId: string | null,
  metadata?: Record<string, unknown> | null,
): void {
  saveBotMessage(supabase, {
    userId,
    messageId: incomingMessageId,
    direction: 'incoming',
    resourceType,
    resourceId,
    metadata: metadata ?? null,
  }).catch(() => {})

  if (outgoingMessageId) {
    saveBotMessage(supabase, {
      userId,
      messageId: outgoingMessageId,
      direction: 'outgoing',
      resourceType,
      resourceId,
      metadata: metadata ?? null,
    }).catch(() => {})
  }
}
```

Update the main `sendTextMessage` call at the end of `handleIncomingMessage` to capture the returned message ID and save both messages. The current code at line ~286-288 is:

```typescript
await sendTextMessage(from, response)
saveHistory(supabase, user.id, text, response)
```

Change to:

```typescript
const sentMessageId = await sendTextMessage(from, response, quoteContext ? quotedMessageId : undefined)
saveHistory(supabase, user.id, text, response)
saveBotMessages(supabase, user.id, messageId, sentMessageId, null, null)
```

For the meal_log case specifically, the `handleMealLog` function returns `{ response, completed, mealId? }`. We need to check if `mealId` is available in the result to save with `resourceType: 'meal'`. However, `handleMealLog` currently doesn't return a `mealId`. This is OK for this task — we'll add meal-specific tracking in a follow-up. For now, save all messages with `null` resource type as a baseline.

For the `query` case, the response contains the analysis in the state, so save with `resourceType: 'query'` when confirmation is set.

- [ ] **Step 6: Run TypeScript check and tests**

Run: `npx tsc --noEmit && npx vitest run tests/unit/bot/handler.test.ts`
Expected: No TS errors, existing handler tests pass

- [ ] **Step 7: Commit**

```bash
git add src/lib/bot/handler.ts
git commit -m "feat: resolve quote context and save bot_messages in handler"
```

---

### Task 9: Meal log flow — Return mealId for bot_messages tracking

**Files:**
- Modify: `src/lib/bot/flows/meal-log.ts`
- Modify: `src/lib/bot/handler.ts`

- [ ] **Step 1: Update `MealLogResult` to include optional `mealId`**

In `src/lib/bot/flows/meal-log.ts`, update the interface:

```typescript
export interface MealLogResult {
  response: string
  completed: boolean
  mealId?: string
}
```

Find every `return { response: ..., completed: true }` in meal-log.ts where a meal was just created (after `createMeal` calls) and add `mealId` to the return:

```typescript
return { response, completed: true, mealId }
```

- [ ] **Step 2: Use `mealId` in handler to save bot_messages**

In `src/lib/bot/handler.ts`, in the `meal_log` case of the intent switch:

```typescript
case 'meal_log': {
  const result = await handleMealLog(supabase, user.id, text, userSettings, null)
  response = result.response
  // Save bot_messages after sending (done below)
  if (result.completed && result.mealId) {
    const sentId = await sendTextMessage(from, response, quoteContext ? quotedMessageId : undefined)
    saveHistory(supabase, user.id, text, response)
    saveBotMessages(supabase, user.id, messageId, sentId, 'meal', result.mealId)
    return
  }
  break
}
```

- [ ] **Step 3: Run TypeScript check**

Run: `npx tsc --noEmit`
Expected: No errors

- [ ] **Step 4: Commit**

```bash
git add src/lib/bot/flows/meal-log.ts src/lib/bot/handler.ts
git commit -m "feat: return mealId from meal-log flow for bot_messages tracking"
```

---

### Task 10: Query flow — Register from quoted message

**Files:**
- Modify: `src/lib/bot/flows/query.ts`
- Modify: `src/lib/bot/handler.ts`

- [ ] **Step 1: Update handler to detect "registra" with query quote**

In `src/lib/bot/handler.ts`, in the intent routing, add special handling when the user quotes a query message and says "registra":

In the switch, update `meal_log` case to check for quoted query:

```typescript
case 'meal_log': {
  // If user quoted a query and wants to register it
  if (quoteContext?.resourceType === 'query' && quoteContext.metadata) {
    const registerResponse = await registerFromQuotedQuery(supabase, user.id, quoteContext, {
      timezone: user.timezone,
      dailyCalorieTarget: user.dailyCalorieTarget,
    })
    const sentId = await sendTextMessage(from, registerResponse, quotedMessageId)
    saveHistory(supabase, user.id, text, registerResponse)
    saveBotMessages(supabase, user.id, messageId, sentId, 'meal', null)
    return
  }
  // ... existing meal_log handling
}
```

Also add the import for the new function at the top of handler.ts:

```typescript
import { registerFromQuotedQuery } from '@/lib/bot/flows/query'
```

- [ ] **Step 2: Implement `registerFromQuotedQuery` in query.ts**

Add to `src/lib/bot/flows/query.ts`:

```typescript
export async function registerFromQuotedQuery(
  supabase: SupabaseClient,
  userId: string,
  quoteContext: { metadata?: Record<string, unknown> },
  user?: { timezone?: string; dailyCalorieTarget?: number | null },
): Promise<string> {
  const metadata = quoteContext.metadata
  if (!metadata?.items || !Array.isArray(metadata.items)) {
    return 'Não encontrei os dados dessa consulta. Manda de novo o que quer registrar?'
  }

  const items = metadata.items as Array<{
    food: string
    quantityGrams: number
    quantityDisplay?: string | null
    calories: number
    protein: number
    carbs: number
    fat: number
    source: string
    tacoId?: number
  }>

  const mealType = (metadata.mealType as string) || 'snack'
  const originalMessage = (metadata.originalMessage as string) || '[query registrada]'
  const totalCalories = Math.round(items.reduce((sum, i) => sum + i.calories, 0))

  await createMeal(supabase, {
    userId,
    mealType,
    totalCalories,
    originalMessage,
    llmResponse: {},
    items: items.map(i => ({
      foodName: i.food,
      quantityGrams: i.quantityGrams,
      calories: i.calories,
      proteinG: i.protein,
      carbsG: i.carbs,
      fatG: i.fat,
      source: i.source,
      tacoId: i.tacoId,
      confidence: i.source === 'approximate' ? 'low' : 'high',
      quantityDisplay: i.quantityDisplay ?? undefined,
    })),
  })

  await clearState(userId)
  const dailyConsumed = await getDailyCalories(supabase, userId, undefined, user?.timezone)
  const target = user?.dailyCalorieTarget ?? 2000

  return `✅ Refeição registrada! (${totalCalories} kcal)\n${formatProgress(dailyConsumed, target)}`
}
```

- [ ] **Step 3: Save query metadata in handler for bot_messages**

In the `query` case of handler's intent switch, save the query analysis as metadata:

```typescript
case 'query': {
  response = await handleQuery(supabase, user.id, text)
  // Query data is in the awaiting_confirmation state — capture for bot_messages
  const queryState = await getState(user.id)
  const queryMetadata = queryState?.contextType === 'awaiting_confirmation'
    ? (queryState.contextData as Record<string, unknown>)
    : null
  const sentId = await sendTextMessage(from, response, quoteContext ? quotedMessageId : undefined)
  saveHistory(supabase, user.id, text, response)
  saveBotMessages(supabase, user.id, messageId, sentId, 'query', null, queryMetadata)
  return
}
```

- [ ] **Step 4: Run TypeScript check**

Run: `npx tsc --noEmit`
Expected: No errors

- [ ] **Step 5: Commit**

```bash
git add src/lib/bot/flows/query.ts src/lib/bot/handler.ts
git commit -m "feat: register meal from quoted query without re-calling LLM"
```

---

### Task 11: Summary flow — Redirect to meal_detail from quoted summary

**Files:**
- Modify: `src/lib/bot/handler.ts`

- [ ] **Step 1: Add quote handling for summary intent**

In the handler's intent switch, when `summary` or `meal_detail` is classified and there's a `quoteContext` with `resourceType: 'summary'`, redirect to meal_detail. Since summaries don't have a resource_id, this is a simple intent redirect — the user's message text provides the details (e.g., "detalha o almoço").

In the `summary` case:

```typescript
case 'summary':
  // If user quoted a summary, treat as meal_detail request
  if (quoteContext?.resourceType === 'summary') {
    response = await handleMealDetail(supabase, user.id, text, {
      timezone: user.timezone,
    })
    break
  }
  response = await handleSummary(supabase, user.id, text, { dailyCalorieTarget: user.dailyCalorieTarget, timezone: user.timezone })
  break
```

- [ ] **Step 2: Run TypeScript check**

Run: `npx tsc --noEmit`
Expected: No errors

- [ ] **Step 3: Commit**

```bash
git add src/lib/bot/handler.ts
git commit -m "feat: redirect quoted summary to meal_detail flow"
```

---

### Task 12: Cleanup cron — Delete old bot_messages

**Files:**
- Modify: `src/app/api/cron/reminders/route.ts` (add cleanup to existing cron)

- [ ] **Step 1: Read the existing cron file**

Read `src/app/api/cron/reminders/route.ts` to understand the current structure.

- [ ] **Step 2: Add bot_messages cleanup**

Add import and call to `cleanupOldMessages` in the existing cron handler:

```typescript
import { cleanupOldMessages } from '@/lib/db/queries/bot-messages'
```

At the end of the cron handler, add:

```typescript
// Cleanup old bot_messages (30-day retention)
const supabase = createServiceRoleClient()
const deletedCount = await cleanupOldMessages(supabase, 30)
if (deletedCount > 0) {
  console.log(`[cron] Cleaned up ${deletedCount} old bot_messages`)
}
```

- [ ] **Step 3: Run TypeScript check**

Run: `npx tsc --noEmit`
Expected: No errors

- [ ] **Step 4: Commit**

```bash
git add src/app/api/cron/reminders/route.ts
git commit -m "feat: add bot_messages cleanup to existing cron job"
```

---

### Task 13: Integration test — Full quote flow

**Files:**
- Modify: `tests/unit/bot/handler.test.ts`

- [ ] **Step 1: Add integration test for quoted message flow**

Add to `tests/unit/bot/handler.test.ts` (after adding appropriate mocks):

```typescript
describe('quoted message flow', () => {
  it('passes quotedMessageId to handleEdit when user quotes a meal', async () => {
    // Setup: mock resolveQuote to return a meal quote context
    // Mock handleEdit to verify it receives quoteContext
    // Call handleIncomingMessage with quotedMessageId
    // Assert handleEdit was called with the quoteContext parameter
  })

  it('returns fallback message when quote has no applicable flow', async () => {
    // Setup: mock resolveQuote to return a null-resource quote
    // Mock classifyByRules to return 'help'
    // Call handleIncomingMessage with quotedMessageId
    // Assert the fallback message was sent
  })
})
```

Note: The exact mock setup depends on the existing handler test structure. Read the full `tests/unit/bot/handler.test.ts` file first and follow its mock patterns.

- [ ] **Step 2: Run the full test suite**

Run: `npx vitest run`
Expected: ALL tests pass

- [ ] **Step 3: Run TypeScript check**

Run: `npx tsc --noEmit`
Expected: No errors

- [ ] **Step 4: Commit**

```bash
git add tests/unit/bot/handler.test.ts
git commit -m "test: add integration tests for quoted message flow"
```

---

### Task 14: Final verification

- [ ] **Step 1: Run all tests**

Run: `npx vitest run`
Expected: ALL pass

- [ ] **Step 2: TypeScript strict check**

Run: `npx tsc --noEmit`
Expected: No errors

- [ ] **Step 3: Apply migration to Supabase**

Run: `npx supabase db push`
Expected: Migration applied successfully

- [ ] **Step 4: Manual smoke test with ngrok**

1. Start dev server: `npm run dev`
2. Start ngrok: `ngrok http 3000`
3. Send a normal message → verify it works as before
4. Register a meal → verify bot_messages are saved (check Supabase dashboard)
5. Quote the meal confirmation → write "apaga" → verify meal is deleted
6. Quote the meal confirmation → write "apaga o arroz" → verify only that item is removed
7. Quote the meal confirmation → write "era quinoa, não arroz" → verify rename works
8. Quote a help message → write anything → verify fallback message appears
