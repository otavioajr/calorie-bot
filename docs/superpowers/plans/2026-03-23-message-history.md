# Message History Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add conversation history (last 5 exchanges) so the bot maintains context for corrections and references in meal_log and edit flows.

**Architecture:** New `message_history` table stores the last 10 messages (5 user + 5 assistant) per user with FIFO rotation. History is saved centrally in the handler after processing, and read only in `meal_log` and `edit` flows to pass as prior messages to the LLM. The `LLMProvider` interface and both providers (OpenRouter, Ollama) gain an optional `history` parameter on `analyzeMeal` and `callAPI`.

**Tech Stack:** Supabase (Postgres), TypeScript, Vitest

---

## File Structure

| Action | File | Responsibility |
|--------|------|----------------|
| Create | `supabase/migrations/00007_message_history.sql` | Table creation + RLS + update `reset_user_data` |
| Create | `src/lib/db/queries/message-history.ts` | Query layer: save, get, clear history |
| Modify | `src/lib/llm/provider.ts` | Add `history` param to `analyzeMeal` interface |
| Modify | `src/lib/llm/providers/openrouter.ts` | Accept `history` in `analyzeMeal` and `callAPI` |
| Modify | `src/lib/llm/providers/ollama.ts` | Accept `history` in `analyzeMeal` and `callAPI` |
| Modify | `src/lib/bot/flows/meal-log.ts` | Pass history to `analyzeMeal` |
| _(skip)_ | `src/lib/bot/flows/edit.ts` | No LLM calls currently — deferred until edit gains LLM-based correction |
| Modify | `src/lib/bot/handler.ts` | Save messages to history after processing |
| Create | `tests/unit/db/message-history.test.ts` | Tests for query layer |
| Modify | `tests/unit/bot/meal-log.test.ts` | Update tests for new history param |
| Modify | `tests/unit/bot/handler.test.ts` | Add mock for message-history, test saving |

---

### Task 1: Database Migration

**Files:**
- Create: `supabase/migrations/00007_message_history.sql`

- [ ] **Step 1: Write the migration file**

```sql
-- Create message_history table
CREATE TABLE message_history (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role text NOT NULL CHECK (role IN ('user', 'assistant')),
  content text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_message_history_user_created ON message_history (user_id, created_at);

ALTER TABLE message_history ENABLE ROW LEVEL SECURITY;

-- Only service role manages this table (bot uses createServiceRoleClient)
-- No policies for authenticated web users

-- Update reset_user_data to also clear message history
CREATE OR REPLACE FUNCTION reset_user_data(p_user_id UUID) RETURNS void AS $$
BEGIN
  DELETE FROM meals WHERE user_id = p_user_id;
  DELETE FROM weight_log WHERE user_id = p_user_id;
  DELETE FROM user_settings WHERE user_id = p_user_id;
  DELETE FROM conversation_context WHERE user_id = p_user_id;
  DELETE FROM llm_usage_log WHERE user_id = p_user_id;
  DELETE FROM message_history WHERE user_id = p_user_id;
  UPDATE users SET
    name = '',
    sex = NULL,
    age = NULL,
    weight_kg = NULL,
    height_cm = NULL,
    activity_level = NULL,
    goal = NULL,
    calorie_mode = 'approximate',
    daily_calorie_target = NULL,
    calorie_target_manual = false,
    tmb = NULL,
    tdee = NULL,
    onboarding_complete = false,
    onboarding_step = 0,
    updated_at = NOW()
  WHERE id = p_user_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;
```

- [ ] **Step 2: Push migration to Supabase**

Run: `npx supabase db push`
Expected: Migration applied successfully.

- [ ] **Step 3: Commit**

```bash
git add supabase/migrations/00007_message_history.sql
git commit -m "feat: add message_history table and update reset_user_data"
```

---

### Task 2: Query Layer

**Files:**
- Create: `src/lib/db/queries/message-history.ts`
- Create: `tests/unit/db/message-history.test.ts`

- [ ] **Step 1: Write the test file**

Create `tests/unit/db/message-history.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest'

const { mockFrom, mockInsert, mockSelect, mockDelete, mockEq, mockOrder, mockLimit } = vi.hoisted(() => {
  const mockLimit = vi.fn().mockResolvedValue({ data: [], error: null })
  const mockOrder = vi.fn().mockReturnValue({ limit: mockLimit })
  const mockEq = vi.fn().mockReturnValue({ order: mockOrder })
  const mockSelect = vi.fn().mockReturnValue({ eq: mockEq })
  const mockDelete = vi.fn().mockReturnValue({ eq: vi.fn().mockReturnValue({
    not: vi.fn().mockResolvedValue({ error: null }),
  })})
  const mockInsert = vi.fn().mockResolvedValue({ error: null })
  const mockFrom = vi.fn().mockReturnValue({
    select: mockSelect,
    insert: mockInsert,
    delete: mockDelete,
  })
  return { mockFrom, mockInsert, mockSelect, mockDelete, mockEq, mockOrder, mockLimit }
})

const mockSupabase = { from: mockFrom } as any

import { getRecentMessages, saveMessage, clearHistory, MAX_HISTORY_MESSAGES } from '@/lib/db/queries/message-history'

describe('message-history queries', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('MAX_HISTORY_MESSAGES is 10', () => {
    expect(MAX_HISTORY_MESSAGES).toBe(10)
  })

  describe('getRecentMessages', () => {
    it('queries message_history for user ordered by created_at DESC and reverses for chronological order', async () => {
      mockLimit.mockResolvedValueOnce({
        data: [
          { role: 'assistant', content: 'Almoço registrado!' },
          { role: 'user', content: 'arroz com feijão' },
        ],
        error: null,
      })

      const result = await getRecentMessages(mockSupabase, 'user-123')

      expect(mockFrom).toHaveBeenCalledWith('message_history')
      expect(mockSelect).toHaveBeenCalledWith('role, content')
      expect(mockEq).toHaveBeenCalledWith('user_id', 'user-123')
      expect(mockOrder).toHaveBeenCalledWith('created_at', { ascending: false })
      expect(mockLimit).toHaveBeenCalledWith(MAX_HISTORY_MESSAGES)
      // Result is reversed to chronological order
      expect(result).toEqual([
        { role: 'user', content: 'arroz com feijão' },
        { role: 'assistant', content: 'Almoço registrado!' },
      ])
    })

    it('returns empty array on error', async () => {
      mockLimit.mockResolvedValueOnce({ data: null, error: { message: 'DB error' } })

      const result = await getRecentMessages(mockSupabase, 'user-123')
      expect(result).toEqual([])
    })
  })

  describe('saveMessage', () => {
    it('inserts message into message_history', async () => {
      await saveMessage(mockSupabase, 'user-123', 'user', 'arroz com feijão')

      expect(mockFrom).toHaveBeenCalledWith('message_history')
      expect(mockInsert).toHaveBeenCalledWith({
        user_id: 'user-123',
        role: 'user',
        content: 'arroz com feijão',
      })
    })
  })

  describe('clearHistory', () => {
    it('deletes all message_history for user', async () => {
      const mockDeleteEq = vi.fn().mockResolvedValue({ error: null })
      mockFrom.mockReturnValueOnce({ delete: vi.fn().mockReturnValue({ eq: mockDeleteEq }) })

      await clearHistory(mockSupabase, 'user-123')

      expect(mockDeleteEq).toHaveBeenCalledWith('user_id', 'user-123')
    })
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test:unit -- tests/unit/db/message-history.test.ts`
Expected: FAIL — module `@/lib/db/queries/message-history` not found.

- [ ] **Step 3: Write the implementation**

Create `src/lib/db/queries/message-history.ts`:

```typescript
import type { SupabaseClient } from '@supabase/supabase-js'

export const MAX_HISTORY_MESSAGES = 10

export interface ChatMessage {
  role: 'user' | 'assistant'
  content: string
}

/**
 * Get the most recent messages for a user, ordered chronologically (oldest first).
 * Queries descending to get the newest N, then reverses for chronological order.
 */
export async function getRecentMessages(
  supabase: SupabaseClient,
  userId: string,
): Promise<ChatMessage[]> {
  const { data, error } = await supabase
    .from('message_history')
    .select('role, content')
    .eq('user_id', userId)
    .order('created_at', { ascending: false })
    .limit(MAX_HISTORY_MESSAGES)

  if (error || !data) {
    return []
  }

  return (data as ChatMessage[]).reverse()
}

/**
 * Save a message to history. After inserting, prune to keep only the
 * most recent MAX_HISTORY_MESSAGES rows per user.
 */
export async function saveMessage(
  supabase: SupabaseClient,
  userId: string,
  role: 'user' | 'assistant',
  content: string,
): Promise<void> {
  await supabase.from('message_history').insert({
    user_id: userId,
    role,
    content,
  })

  // Prune: keep only the most recent MAX_HISTORY_MESSAGES
  // Get the id of the Nth newest message, then delete anything older
  const { data: keepRows } = await supabase
    .from('message_history')
    .select('id')
    .eq('user_id', userId)
    .order('created_at', { ascending: false })
    .limit(MAX_HISTORY_MESSAGES)

  if (keepRows && keepRows.length === MAX_HISTORY_MESSAGES) {
    const keepIds = keepRows.map((r) => r.id)
    await supabase
      .from('message_history')
      .delete()
      .eq('user_id', userId)
      .not('id', 'in', `(${keepIds.join(',')})`)
  }
}

/**
 * Clear all message history for a user (used on data reset).
 */
export async function clearHistory(
  supabase: SupabaseClient,
  userId: string,
): Promise<void> {
  await supabase
    .from('message_history')
    .delete()
    .eq('user_id', userId)
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test:unit -- tests/unit/db/message-history.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/lib/db/queries/message-history.ts tests/unit/db/message-history.test.ts
git commit -m "feat: add message-history query layer with tests"
```

---

### Task 3: LLMProvider Interface + OpenRouter + Ollama

**Files:**
- Modify: `src/lib/llm/provider.ts`
- Modify: `src/lib/llm/providers/openrouter.ts`
- Modify: `src/lib/llm/providers/ollama.ts`

- [ ] **Step 1: Update the LLMProvider interface**

In `src/lib/llm/provider.ts`, add the `history` parameter to `analyzeMeal`:

```typescript
// Change this line:
analyzeMeal(message: string, mode: CalorieMode, context?: TacoFood[]): Promise<MealAnalysis>
// To:
analyzeMeal(message: string, mode: CalorieMode, context?: TacoFood[], history?: { role: string; content: string }[]): Promise<MealAnalysis>
```

- [ ] **Step 2: Update OpenRouter provider — `callAPI` to accept history**

In `src/lib/llm/providers/openrouter.ts`, modify the `callAPI` private method signature (line ~198) to accept an optional `history` array:

```typescript
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

  // Insert history messages between system prompt and current user message
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

  // ... rest stays the same
```

- [ ] **Step 3: Update OpenRouter `analyzeMeal` to accept and forward history**

In `src/lib/llm/providers/openrouter.ts`, modify `analyzeMeal` (line ~61):

```typescript
async analyzeMeal(message: string, mode: CalorieMode, context?: TacoFood[], history?: { role: string; content: string }[]): Promise<MealAnalysis> {
  const systemPrompt = mode === 'taco'
    ? buildTacoPrompt(context ?? [])
    : buildApproximatePrompt()

  const rawContent = await this.callAPI(this.mealModel, systemPrompt, message, true, history)

  const parsed = this.parseJSON(rawContent)
  const validated = MealAnalysisSchema.safeParse(parsed)

  if (validated.success) {
    return validated.data
  }

  // Retry once on validation failure
  const retryContent = await this.callAPI(this.mealModel, systemPrompt, message, true, history)
  // ... rest stays the same
```

- [ ] **Step 4: Update Ollama provider — same changes**

In `src/lib/llm/providers/ollama.ts`, apply the same pattern:

1. Update `analyzeMeal` signature to accept `history?` param (line ~55)
2. Update `callAPI` to accept and splice `history` between system and user messages (line ~166)
3. Forward `history` from `analyzeMeal` to `callAPI`

The `callAPI` change:

```typescript
private async callAPI(
  model: string,
  systemPrompt: string,
  userMessage: string,
  jsonMode: boolean,
  history?: { role: string; content: string }[],
): Promise<string> {
  const messages: OllamaMessage[] = [
    { role: 'system', content: systemPrompt },
  ]

  if (history && history.length > 0) {
    for (const msg of history) {
      messages.push({ role: msg.role as 'user' | 'assistant', content: msg.content })
    }
  }

  messages.push({ role: 'user', content: userMessage })

  const body: OllamaRequestBody = {
    model,
    messages,
    stream: false,
  }
  // ... rest stays the same
```

- [ ] **Step 5: Verify TypeScript compiles**

Run: `npx tsc --noEmit`
Expected: No errors.

- [ ] **Step 6: Run existing tests to make sure nothing broke**

Run: `npm run test:unit`
Expected: All tests pass.

- [ ] **Step 7: Commit**

```bash
git add src/lib/llm/provider.ts src/lib/llm/providers/openrouter.ts src/lib/llm/providers/ollama.ts
git commit -m "feat: add history parameter to LLMProvider analyzeMeal"
```

---

### Task 4: Pass History in meal-log Flow

**Files:**
- Modify: `src/lib/bot/flows/meal-log.ts`
- Modify: `tests/unit/bot/meal-log.test.ts`

- [ ] **Step 1: Update `meal-log.ts` to accept and use history**

In `src/lib/bot/flows/meal-log.ts`:

1. Add import at top:
```typescript
import { getRecentMessages } from '@/lib/db/queries/message-history'
```

2. In `analyzeAndConfirm`, fetch history and pass to `analyzeMeal`:
```typescript
async function analyzeAndConfirm(
  supabase: SupabaseClient,
  userId: string,
  messageToAnalyze: string,
  originalMessage: string,
  user: { calorieMode: string; dailyCalorieTarget: number | null },
): Promise<MealLogResult> {
  const llm = getLLMProvider()
  const calorieMode = user.calorieMode as Parameters<typeof llm.analyzeMeal>[1]

  // Fetch conversation history for context
  const history = await getRecentMessages(supabase, userId)

  const result: MealAnalysis = await llm.analyzeMeal(messageToAnalyze, calorieMode, undefined, history)
  // ... rest stays the same
```

- [ ] **Step 2: Update meal-log tests**

In `tests/unit/bot/meal-log.test.ts`, add mock for `getRecentMessages`:

1. Add to hoisted mocks:
```typescript
mockGetRecentMessages: vi.fn().mockResolvedValue([]),
```

2. Add module mock:
```typescript
vi.mock('@/lib/db/queries/message-history', () => ({
  getRecentMessages: mockGetRecentMessages,
}))
```

3. Update the `mockAnalyzeMeal` expectations — `analyzeMeal` is now called with 4 args (the 4th being the history array). Existing assertions that check `mockAnalyzeMeal.mock.calls[0]` may need to account for the extra arg.

- [ ] **Step 3: Run tests**

Run: `npm run test:unit -- tests/unit/bot/meal-log.test.ts`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add src/lib/bot/flows/meal-log.ts tests/unit/bot/meal-log.test.ts
git commit -m "feat: pass conversation history to LLM in meal-log flow"
```

---

### Task 5: Pass History in edit Flow

**Files:**
- Modify: `src/lib/bot/flows/edit.ts`

- [ ] **Step 1: Review edit.ts for LLM calls**

Currently `edit.ts` does NOT call the LLM directly — it only queries the database for recent meals and manages delete confirmation state. The history is still useful here for future LLM-based correction, but for now no LLM integration is needed.

**No changes needed in edit.ts for this task.** The history will already be available in the handler context for when edit flow gains LLM capabilities.

- [ ] **Step 2: Commit (skip — no changes)**

---

### Task 6: Save Messages in Handler

**Files:**
- Modify: `src/lib/bot/handler.ts`
- Modify: `tests/unit/bot/handler.test.ts`

- [ ] **Step 1: Update handler.ts to save messages after processing**

In `src/lib/bot/handler.ts`:

1. Add import at top:
```typescript
import { saveMessage } from '@/lib/db/queries/message-history'
```

2. Create a helper function to save both messages (fire-and-forget):
```typescript
function saveHistory(supabase: SupabaseClient, userId: string, userMsg: string, botMsg: string): void {
  saveMessage(supabase, userId, 'user', userMsg).catch(() => {})
  saveMessage(supabase, userId, 'assistant', botMsg).catch(() => {})
}
```

3. In `handleIncomingMessage`, add `saveHistory` calls at ALL the following save points. **Do NOT save** onboarding messages (handler returns early at line 51) or error messages (catch block at line 149).

**Context-routed branches (lines 62-94) — 6 save points:**

```typescript
case 'awaiting_confirmation':
case 'awaiting_clarification': {
  const mealResult = await handleMealLog(supabase, user.id, text, userSettings, context)
  await sendTextMessage(from, mealResult.response)
  saveHistory(supabase, user.id, text, mealResult.response)
  return
}
case 'awaiting_correction': {
  const editResponse = await handleEdit(supabase, user.id, text, context)
  await sendTextMessage(from, editResponse)
  saveHistory(supabase, user.id, text, editResponse)
  return
}
case 'awaiting_weight': {
  const weightResponse = await handleWeight(supabase, user.id, text, user)
  await sendTextMessage(from, weightResponse)
  saveHistory(supabase, user.id, text, weightResponse)
  return
}
case 'settings_menu':
case 'settings_change':
case 'awaiting_reset_confirmation': {
  const settingsData = await getUserWithSettings(supabase, user.id)
  const settingsResponse = await handleSettings(supabase, user.id, text, user, settingsData.settings, context)
  await sendTextMessage(from, settingsResponse)
  saveHistory(supabase, user.id, text, settingsResponse)
  return
}
case 'awaiting_label_portions': {
  await handleLabelPortions(supabase, from, user.id, text, context, { ... })
  // Note: handleLabelPortions sends messages internally, so save here with a generic response
  saveMessage(supabase, user.id, 'user', text).catch(() => {})
  // The bot response is sent inside handleLabelPortions — to save it, refactor handleLabelPortions
  // to return the response string, or skip saving the assistant message for this branch.
  return
}
```

**Intent-routed response (after line 148):**

```typescript
await sendTextMessage(from, response)
saveHistory(supabase, user.id, text, response)
```

4. In `handleIncomingImage`, add save calls at 3 points where the bot sends a final response:

- After nutrition label response (line 296): `saveHistory(supabase, user.id, caption || '[imagem de alimento]', labelMsg)`
- After food image confirmation (line 320): `saveHistory(supabase, user.id, caption || '[imagem de alimento]', response)`
- After clarification question (line 268): `saveHistory(supabase, user.id, caption || '[imagem de alimento]', msg)`

**Do NOT save** the processing feedback message ("📸 Analisando..."), only the final response.

Note: `handleIncomingAudio` calls `handleIncomingMessage` with the transcribed text, so it will be saved via that path. No changes needed in `handleIncomingAudio`.

- [ ] **Step 2: Update handler tests**

In `tests/unit/bot/handler.test.ts`:

1. Add to hoisted mocks:
```typescript
mockSaveMessage: vi.fn().mockResolvedValue(undefined),
```

2. Add module mock:
```typescript
vi.mock('@/lib/db/queries/message-history', () => ({
  saveMessage: mockSaveMessage,
}))
```

3. Add tests that verify `saveMessage` is called after processing:

```typescript
it('saves user message and bot response to message history', async () => {
  mockFindUserByPhone.mockResolvedValueOnce(completedUser)
  mockGetState.mockResolvedValueOnce(null)
  mockClassifyByRules.mockReturnValueOnce('meal_log')
  mockHandleMealLog.mockResolvedValueOnce({ response: 'Almoço registrado!', completed: true })

  await handleIncomingMessage('5511999999999', 'msg-1', 'arroz com feijão')

  expect(mockSaveMessage).toHaveBeenCalledWith(expect.anything(), completedUser.id, 'user', 'arroz com feijão')
  expect(mockSaveMessage).toHaveBeenCalledWith(expect.anything(), completedUser.id, 'assistant', 'Almoço registrado!')
})

it('does NOT save onboarding messages to history', async () => {
  const onboardingUser = { ...completedUser, onboardingComplete: false, onboardingStep: 0 }
  mockFindUserByPhone.mockResolvedValueOnce(onboardingUser)
  mockHandleOnboarding.mockResolvedValueOnce({ response: 'Qual seu nome?' })

  await handleIncomingMessage('5511999999999', 'msg-1', 'oi')

  expect(mockSaveMessage).not.toHaveBeenCalled()
})
```

4. Add a test for `handleIncomingImage` saving history:

```typescript
it('saves image interaction to message history', async () => {
  // Setup: completed user, successful image analysis with food items
  mockFindUserByPhone.mockResolvedValueOnce(completedUser)
  mockDownloadImageMedia.mockResolvedValueOnce(Buffer.from('fake-image'))
  mockAnalyzeImage.mockResolvedValueOnce({
    meal_type: 'lunch', confidence: 'high',
    items: [{ food: 'Arroz', quantity_grams: 100, calories: 130, protein: 3, carbs: 28, fat: 0.3 }],
    unknown_items: [], needs_clarification: false, image_type: 'food_photo',
  })
  mockGetDailyCalories.mockResolvedValueOnce(500)

  await handleIncomingImage('5511999999999', 'msg-1', 'img-id', 'meu almoço')

  expect(mockSaveMessage).toHaveBeenCalledWith(expect.anything(), completedUser.id, 'user', 'meu almoço')
  expect(mockSaveMessage).toHaveBeenCalledWith(expect.anything(), completedUser.id, 'assistant', expect.any(String))
})
```

- [ ] **Step 3: Run tests**

Run: `npm run test:unit -- tests/unit/bot/handler.test.ts`
Expected: PASS

- [ ] **Step 4: Run full test suite**

Run: `npm run test:unit`
Expected: All tests pass.

- [ ] **Step 5: TypeScript check**

Run: `npx tsc --noEmit`
Expected: No errors.

- [ ] **Step 6: Commit**

```bash
git add src/lib/bot/handler.ts tests/unit/bot/handler.test.ts
git commit -m "feat: save conversation history in message handler"
```

---

### Task 7: Final Verification & Deploy

- [ ] **Step 1: Run full test suite**

Run: `npm run test:unit`
Expected: All tests pass.

- [ ] **Step 2: TypeScript compilation check**

Run: `npx tsc --noEmit`
Expected: No errors.

- [ ] **Step 3: Push to deploy**

Run: `git push`
Expected: Vercel auto-deploys from main.
