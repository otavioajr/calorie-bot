# Fix Silent Failures Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Eliminate silent failure modes in the WhatsApp webhook pipeline so errors are always logged and diagnosable.

**Architecture:** Three targeted fixes: (1) Replace all `.catch(() => {})` on `sendTextMessage` with error logging, (2) Fix dedup insert treating DB errors as duplicates, (3) Add env var validation at module load time. No new files — all changes are to existing modules.

**Tech Stack:** TypeScript, Vitest, Next.js

---

## File Map

| File | Action | Purpose |
|------|--------|---------|
| `src/lib/whatsapp/client.ts` | Modify | Add error logging to sendTextMessage |
| `src/lib/bot/handler.ts` | Modify | Replace `.catch(() => {})` with logged catches |
| `src/app/api/webhook/whatsapp/route.ts` | Modify | Fix dedup logic, add env validation |
| `tests/unit/bot/handler.test.ts` | Modify | Add tests for send-failure logging |
| `tests/unit/webhook/route.test.ts` | Modify | Add tests for dedup bug fix |

---

### Task 1: Add error logging to sendTextMessage catch blocks in handler.ts

**Files:**
- Modify: `src/lib/bot/handler.ts:164,219,340`
- Test: `tests/unit/bot/handler.test.ts`

- [ ] **Step 1: Write failing test — error handler logs when sendTextMessage fails**

Add to the `handleIncomingMessage — error handling` describe block in `tests/unit/bot/handler.test.ts`:

```typescript
it('logs error when sendTextMessage fails in error handler', async () => {
  const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
  mockFindUserByPhone.mockRejectedValue(new Error('DB connection failed'))
  mockSendTextMessage.mockRejectedValue(new Error('WhatsApp API error: HTTP 401 — Unauthorized'))

  await handleIncomingMessage(FROM, MESSAGE_ID, TEXT)

  expect(consoleSpy).toHaveBeenCalledWith(
    expect.stringContaining('[handler]'),
    expect.any(Error)
  )
  // Should have been called twice: once for original error, once for send failure
  const sendFailCalls = consoleSpy.mock.calls.filter(
    call => typeof call[0] === 'string' && call[0].includes('send error')
  )
  expect(sendFailCalls.length).toBe(1)
  consoleSpy.mockRestore()
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test:unit -- --reporter=verbose tests/unit/bot/handler.test.ts -t "logs error when sendTextMessage fails in error handler"`

Expected: FAIL — current `.catch(() => {})` doesn't log anything

- [ ] **Step 3: Replace all `.catch(() => {})` on sendTextMessage in handler.ts**

In `src/lib/bot/handler.ts`, replace line 164:

```typescript
// OLD:
await sendTextMessage(from, formatError()).catch(() => {})

// NEW:
await sendTextMessage(from, formatError()).catch((sendErr) => {
  console.error('[handler] Failed to send error message (send error):', sendErr)
})
```

Apply the same pattern to line 219 (audio error handler):

```typescript
// OLD:
await sendTextMessage(from, formatError()).catch(() => {})

// NEW:
await sendTextMessage(from, formatError()).catch((sendErr) => {
  console.error('[handler] Failed to send error message (send error):', sendErr)
})
```

And line 340 (image error handler):

```typescript
// OLD:
await sendTextMessage(from, formatError()).catch(() => {})

// NEW:
await sendTextMessage(from, formatError()).catch((sendErr) => {
  console.error('[handler] Failed to send error message (send error):', sendErr)
})
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test:unit -- --reporter=verbose tests/unit/bot/handler.test.ts -t "logs error when sendTextMessage fails in error handler"`

Expected: PASS

- [ ] **Step 5: Write failing test — audio error handler logs when sendTextMessage fails**

Add to a new describe block or the existing audio describe in `tests/unit/bot/handler.test.ts`:

```typescript
it('logs error when sendTextMessage fails in audio error handler', async () => {
  const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
  mockDownloadAudioMedia.mockRejectedValue(new Error('network error'))
  mockSendTextMessage.mockRejectedValue(new Error('WhatsApp API error: HTTP 401'))

  await handleIncomingAudio(FROM, MESSAGE_ID, 'audio-id')

  const sendFailCalls = consoleSpy.mock.calls.filter(
    call => typeof call[0] === 'string' && call[0].includes('send error')
  )
  expect(sendFailCalls.length).toBe(1)
  consoleSpy.mockRestore()
})
```

- [ ] **Step 6: Run test to verify it passes (already fixed in step 3)**

Run: `npm run test:unit -- --reporter=verbose tests/unit/bot/handler.test.ts -t "logs error when sendTextMessage fails in audio error handler"`

Expected: PASS

- [ ] **Step 7: Write failing test — image error handler logs when sendTextMessage fails**

```typescript
it('logs error when sendTextMessage fails in image error handler', async () => {
  const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
  mockFindUserByPhone.mockRejectedValue(new Error('DB error'))
  mockSendTextMessage.mockRejectedValue(new Error('WhatsApp API error: HTTP 401'))

  await handleIncomingImage(FROM, MESSAGE_ID, 'image-id')

  const sendFailCalls = consoleSpy.mock.calls.filter(
    call => typeof call[0] === 'string' && call[0].includes('send error')
  )
  expect(sendFailCalls.length).toBe(1)
  consoleSpy.mockRestore()
})
```

- [ ] **Step 8: Run test to verify it passes (already fixed in step 3)**

Run: `npm run test:unit -- --reporter=verbose tests/unit/bot/handler.test.ts -t "logs error when sendTextMessage fails in image error handler"`

Expected: PASS

- [ ] **Step 9: Run full handler test suite**

Run: `npm run test:unit -- --reporter=verbose tests/unit/bot/handler.test.ts`

Expected: All tests pass

- [ ] **Step 10: Commit**

```bash
git add src/lib/bot/handler.ts tests/unit/bot/handler.test.ts
git commit -m "fix: log errors when sendTextMessage fails in error handlers

Replace .catch(() => {}) with .catch((err) => console.error(...))
in all three error handlers (text, audio, image) so WhatsApp API
failures are visible in Vercel logs instead of silently swallowed."
```

---

### Task 2: Fix dedup insert treating all DB errors as duplicates

**Files:**
- Modify: `src/app/api/webhook/whatsapp/route.ts:36-39`
- Test: `tests/unit/webhook/route.test.ts`

The current code treats ANY insert error as a duplicate (including DB connection failures, RLS errors, table-not-found). Only unique constraint violations (`code: '23505'`) should be treated as duplicates.

- [ ] **Step 1: Write failing test — non-duplicate DB error should still process message**

Add to the `POST — incoming messages` describe block in `tests/unit/webhook/route.test.ts`:

```typescript
it('processes message when insert fails with non-duplicate error (e.g. connection error)', async () => {
  mockSingle.mockResolvedValue({
    data: null,
    error: { code: '500', message: 'connection refused' },
  })

  const request = makePostRequest(makeTextPayload())
  const response = await POST(request)

  expect(response.status).toBe(200)
  // Message should still be processed despite dedup insert failure
  expect(mockHandleIncomingMessage).toHaveBeenCalledWith(
    '5511999887766',
    'wamid.abc123',
    'almocei arroz e feijão',
  )
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test:unit -- --reporter=verbose tests/unit/webhook/route.test.ts -t "processes message when insert fails with non-duplicate error"`

Expected: FAIL — current code returns early on any error, so `mockHandleIncomingMessage` is not called

- [ ] **Step 3: Fix dedup logic to only skip on actual duplicates**

In `src/app/api/webhook/whatsapp/route.ts`, replace lines 30-41:

```typescript
// OLD:
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data, error } = await (supabase as any)
      .from('processed_messages')
      .insert({ message_id: event.messageId })
      .select()
      .single()

    if (error) {
      // Duplicate — already processed
      return new Response('OK', { status: 200 })
    }

    void data // suppress unused variable warning

// NEW:
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { error: dedupError } = await (supabase as any)
      .from('processed_messages')
      .insert({ message_id: event.messageId })
      .select()
      .single()

    if (dedupError?.code === '23505') {
      // Genuine duplicate — already processed
      return new Response('OK', { status: 200 })
    }

    if (dedupError) {
      // Non-duplicate DB error — log but continue processing
      console.error('[webhook] Dedup insert failed (processing anyway):', dedupError.message)
    }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test:unit -- --reporter=verbose tests/unit/webhook/route.test.ts -t "processes message when insert fails with non-duplicate error"`

Expected: PASS

- [ ] **Step 5: Update existing duplicate test to use code 23505 explicitly**

The existing test at line 263-275 already uses `code: '23505'` — verify it still passes.

- [ ] **Step 6: Write test — dedup insert with connection error logs the error**

```typescript
it('logs error when dedup insert fails with non-duplicate error', async () => {
  const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
  mockSingle.mockResolvedValue({
    data: null,
    error: { code: '500', message: 'connection refused' },
  })

  const request = makePostRequest(makeTextPayload())
  await POST(request)

  expect(consoleSpy).toHaveBeenCalledWith(
    expect.stringContaining('[webhook] Dedup insert failed'),
    expect.stringContaining('connection refused'),
  )
  consoleSpy.mockRestore()
})
```

- [ ] **Step 7: Run test to verify it passes**

Run: `npm run test:unit -- --reporter=verbose tests/unit/webhook/route.test.ts -t "logs error when dedup insert fails"`

Expected: PASS

- [ ] **Step 8: Run full route test suite**

Run: `npm run test:unit -- --reporter=verbose tests/unit/webhook/route.test.ts`

Expected: All tests pass

- [ ] **Step 9: Commit**

```bash
git add src/app/api/webhook/whatsapp/route.ts tests/unit/webhook/route.test.ts
git commit -m "fix: only treat duplicate key (23505) as dedup in webhook

Previously ANY insert error was treated as 'already processed',
silently dropping messages on DB connection errors or RLS failures.
Now only PostgreSQL unique constraint violation (23505) triggers
dedup skip. Other errors are logged and the message is processed."
```

---

### Task 3: Add critical env var validation at webhook startup

**Files:**
- Modify: `src/lib/whatsapp/client.ts:5-7`
- Modify: `src/app/api/webhook/whatsapp/route.ts` (top of POST)

- [ ] **Step 1: Add validation to sendTextMessage**

In `src/lib/whatsapp/client.ts`, add validation at the top of `sendTextMessage` (lines 6-7):

```typescript
// OLD:
export async function sendTextMessage(to: string, text: string): Promise<string> {
  const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID
  const accessToken = process.env.WHATSAPP_ACCESS_TOKEN

// NEW:
export async function sendTextMessage(to: string, text: string): Promise<string> {
  const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID
  const accessToken = process.env.WHATSAPP_ACCESS_TOKEN

  if (!accessToken) {
    throw new Error('WHATSAPP_ACCESS_TOKEN is not configured')
  }
  if (!phoneNumberId) {
    throw new Error('WHATSAPP_PHONE_NUMBER_ID is not configured')
  }
```

- [ ] **Step 2: Run full test suite to verify nothing breaks**

Run: `npm run test:unit -- --reporter=verbose`

Expected: All tests pass (tests mock sendTextMessage so validation won't fire)

- [ ] **Step 3: Commit**

```bash
git add src/lib/whatsapp/client.ts
git commit -m "fix: validate WhatsApp env vars in sendTextMessage

Throw clear error messages when WHATSAPP_ACCESS_TOKEN or
WHATSAPP_PHONE_NUMBER_ID are missing, instead of making
API calls with undefined credentials that fail silently."
```

---

### Task 4: Final validation

- [ ] **Step 1: Run full unit test suite**

Run: `npm run test:unit`

Expected: All tests pass

- [ ] **Step 2: Run TypeScript type check**

Run: `npx tsc --noEmit`

Expected: No errors

- [ ] **Step 3: Verify no regressions in webhook behavior**

Run: `npm run test:unit -- --reporter=verbose tests/unit/webhook/route.test.ts tests/unit/bot/handler.test.ts`

Expected: All tests pass
