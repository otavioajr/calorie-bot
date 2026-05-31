# WS5 — Webhook Reliability (Dedup vs. Confirmation) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Garantir que um retry da Meta nunca devolva OK sem reprocessar quando a execução anterior gravou a refeição mas não conseguiu entregar nenhuma resposta ao usuário.

**Architecture:** `processed_messages` ganha uma coluna `status` (`'processing'`/`'done'`). O webhook *reivindica* a mensagem via RPC atômica (`claim_message`) que insere `status='processing'` quando ausente, reclama uma linha `processing` *stale* (>60s), e devolve `claimed=false` quando já está `done`. Os três handlers passam a retornar `Promise<boolean>` indicando se entregaram alguma resposta ao usuário (confirmação ou mensagem de erro). O route só marca a linha como `done` quando o handler retorna `true`; se retornar `false`, a linha permanece `processing` e o próximo retry da Meta a reclama e reprocessa. O cron de limpeza passa a apagar somente linhas `done`.

**Tech Stack:** Next.js Route Handlers, Supabase (Postgres `plpgsql` RPC `SECURITY DEFINER`, `INSERT ... ON CONFLICT`), TypeScript strict, Vitest (mock do supabase via chain thenable / `rpc` mock).

---

## Decisões de produto (defaults escolhidos)

| Decisão | Default (best-practice) | Alternativa para ajustar |
|---|---|---|
| Dedup vs. confirmação | Coluna `status` (`processing`/`done`); marca `done` só após entregar resposta; retry reprocessa enquanto `processing`/ausente; claim atômico via RPC evita dupla-execução concorrente. | (A) dedup só após sucesso — risco de dupla-execução concorrente; (B) escrita da refeição idempotente por `(user, message_id)` — mais seguro porém cirurgia grande. |
| Sinal de sucesso do handler | Handlers retornam `Promise<boolean>`: `true` = entregou ALGUMA resposta (feliz ou erro); `false` = nem o fallback `formatError()` saiu. Corpo atual roda intacto numa closure interna (preserva os ~40 `return` nus). | Converter 40 `return` nus em `return true` (frágil) ou route inspecionar exceções re-lançadas (quebra "sempre 200"). |
| O que marca `done` | Entrega de QUALQUER mensagem ao usuário. Perigo = refeição gravada + `sendTextMessage` falha + fallback falha → `false` → retry reenvia. | Marcar `done` só no caminho 100% feliz (gera spam de retry quando o usuário já viu a mensagem de erro). |
| Janela de "stale processing" | 60s (= `maxDuration=60`). Linha `processing` mais velha = execução morta → segura para reclamar. | Sem janela (presa para sempre) ou janela curta (<10s, reprocessa execução viva). |
| Idempotência da escrita da refeição | Fora do escopo: reprocesso só ocorre quando a execução anterior NÃO entregou resposta; `logFoodToMeal` já consolida por `(user, dia, meal_type)` via `find_or_create_meal`. Follow-up documentado. | Implementar idempotência por `message_id` agora — robusto, porém grande e cruza WS de meal-log. |
| Limpeza | Cron passa a apagar só `status='done'` >24h. | Apagar por idade ignorando status (perde rastro de `processing` stale). |

> **Por que `INSERT ... ON CONFLICT` e não advisory lock?** A PK `message_id` já serializa o claim: dois retries concorrentes do mesmo `message_id` competem pelo `ON CONFLICT`; exatamente um observa a linha como recém-criada/reclamável. Mais simples que o advisory lock usado em `find_or_create_meal` (que precisava serializar chaves *diferentes* da PK).

## File Structure

```
supabase/migrations/
  20260531223000_processed_messages_status.sql   [CREATE] coluna status + RPC claim_message
src/lib/db/queries/
  dedup.ts                                        [CREATE] claimMessage() / markMessageDone()
src/app/api/webhook/whatsapp/route.ts             [MODIFY] usa claimMessage + marca done por retorno do handler
src/lib/bot/handler.ts                            [MODIFY] 3 handlers → Promise<boolean>
src/app/api/cron/reminders/route.ts               [MODIFY] cleanup só de status='done'
tests/unit/db/dedup.test.ts                       [CREATE]
tests/unit/webhook/route.test.ts                  [MODIFY] novos casos de retry/falha
tests/unit/bot/handler-delivery-signal.test.ts    [CREATE]
tests/unit/cron/processed-messages-cleanup.test.ts[CREATE]
```

---

### Task 1: Migration — coluna `status` + RPC `claim_message`

**Files:**
- Create: `supabase/migrations/20260531223000_processed_messages_status.sql`
- Test: `tests/unit/db/dedup.test.ts` (cobre o wrapper TS na Task 2; aqui validamos a presença/forma da migration por leitura — sem teste de SQL executável neste repo, seguindo o padrão de `tests/unit/db/reset-user-data-migration.test.ts`)

- [ ] **Step 1: Write the failing test**

Cria `tests/unit/db/dedup.test.ts` com um teste que lê o arquivo de migration e exige a coluna + a função (mesmo estilo de leitura-de-migration já usado no repo):

```ts
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const MIGRATION = resolve(
  __dirname,
  '../../../supabase/migrations/20260531223000_processed_messages_status.sql',
)

describe('migration: processed_messages status + claim_message', () => {
  const sql = (() => {
    try {
      return readFileSync(MIGRATION, 'utf8')
    } catch {
      return ''
    }
  })()

  it('adds a status column defaulting to processing', () => {
    expect(sql).toMatch(/ALTER TABLE processed_messages\s+ADD COLUMN IF NOT EXISTS status/i)
    expect(sql).toMatch(/DEFAULT 'processing'/i)
  })

  it('backfills existing rows to done', () => {
    expect(sql).toMatch(/UPDATE processed_messages\s+SET status = 'done'/i)
  })

  it('defines claim_message as SECURITY DEFINER with pinned search_path', () => {
    expect(sql).toMatch(/CREATE OR REPLACE FUNCTION claim_message/i)
    expect(sql).toMatch(/SECURITY DEFINER/i)
    expect(sql).toMatch(/SET search_path = public, pg_temp/i)
  })

  it('grants execute only to service_role', () => {
    expect(sql).toMatch(/GRANT EXECUTE ON FUNCTION claim_message.*TO service_role/i)
    expect(sql).toMatch(/REVOKE ALL ON FUNCTION claim_message.*FROM PUBLIC/i)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**
  Run: `npx vitest run tests/unit/db/dedup.test.ts`
  Expected: FAIL — arquivo de migration não existe, `sql` é `''`, todos os `toMatch` falham.

- [ ] **Step 3: Write minimal implementation**

Cria `supabase/migrations/20260531223000_processed_messages_status.sql` (espelha as convenções de `20260530120000_atomic_find_or_create_meal.sql`: `SECURITY DEFINER`, `SET search_path`, `REVOKE`/`GRANT service_role`):

```sql
-- Webhook reliability: distinguish "still processing" from "done" so a Meta retry
-- reprocesses a message whose prior execution logged a meal but failed to deliver
-- ANY reply. Status column + an atomic claim function (INSERT ... ON CONFLICT) that
-- the PK on message_id already serializes against concurrent retries.

-- 1. Status column. Existing rows predate this change and were only ever inserted
--    AFTER (implicit) processing, so backfill them to 'done'.
ALTER TABLE processed_messages
  ADD COLUMN IF NOT EXISTS status VARCHAR(12) NOT NULL DEFAULT 'processing';

UPDATE processed_messages
  SET status = 'done'
  WHERE status <> 'done';

-- 2. Atomic claim. Returns claimed=TRUE when the caller may process the message:
--      - row absent           -> insert as 'processing', claimed=TRUE
--      - row 'processing' and older than p_stale_seconds -> reclaim, claimed=TRUE
--      - row 'processing' and fresh -> claimed=FALSE (a live execution owns it)
--      - row 'done'           -> claimed=FALSE (already answered)
--    The PK on message_id serializes concurrent retries through ON CONFLICT.
CREATE OR REPLACE FUNCTION claim_message(
  p_message_id    VARCHAR,
  p_stale_seconds INTEGER DEFAULT 60
)
RETURNS TABLE (claimed BOOLEAN, prior_status VARCHAR)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_inserted BOOLEAN := FALSE;
  v_status   VARCHAR(12);
  v_age      INTERVAL;
BEGIN
  INSERT INTO processed_messages (message_id, status)
  VALUES (p_message_id, 'processing')
  ON CONFLICT (message_id) DO NOTHING;

  GET DIAGNOSTICS v_inserted = ROW_COUNT;

  IF v_inserted > 0 THEN
    -- Brand-new claim.
    claimed := TRUE;
    prior_status := NULL;
    RETURN NEXT;
    RETURN;
  END IF;

  -- Row already existed: inspect it.
  SELECT status, (NOW() - processed_at)
    INTO v_status, v_age
  FROM processed_messages
  WHERE message_id = p_message_id
  FOR UPDATE;

  IF v_status = 'done' THEN
    claimed := FALSE;
    prior_status := 'done';
    RETURN NEXT;
    RETURN;
  END IF;

  -- v_status = 'processing'
  IF v_age > make_interval(secs => p_stale_seconds) THEN
    -- Prior execution is stale/dead: reclaim it and reset the clock.
    UPDATE processed_messages
      SET processed_at = NOW()
      WHERE message_id = p_message_id;
    claimed := TRUE;
    prior_status := 'processing';
    RETURN NEXT;
    RETURN;
  END IF;

  -- Fresh 'processing': a live execution still owns it.
  claimed := FALSE;
  prior_status := 'processing';
  RETURN NEXT;
END;
$$;

REVOKE ALL ON FUNCTION claim_message(VARCHAR, INTEGER) FROM PUBLIC;
REVOKE ALL ON FUNCTION claim_message(VARCHAR, INTEGER) FROM anon;
REVOKE ALL ON FUNCTION claim_message(VARCHAR, INTEGER) FROM authenticated;
GRANT EXECUTE ON FUNCTION claim_message(VARCHAR, INTEGER) TO service_role;
```

> Nota: `GET DIAGNOSTICS v_inserted = ROW_COUNT` retorna inteiro; o `IF v_inserted > 0` trata isso (a declaração como BOOLEAN é apenas semântica — em plpgsql `ROW_COUNT` é numérico, então a comparação `> 0` é a forma correta; se o linter de tipo reclamar, troque a DECLARE para `v_inserted INTEGER := 0`).

- [ ] **Step 4: Run test to verify it passes**
  Run: `npx vitest run tests/unit/db/dedup.test.ts`
  Expected: PASS — todos os 4 `toMatch` encontram o conteúdo.

- [ ] **Step 5: Commit**
  Run:
  ```bash
  git add supabase/migrations/20260531223000_processed_messages_status.sql tests/unit/db/dedup.test.ts
  git commit -m "feat(webhook): processed_messages status + atomic claim_message RPC"
  ```

---

### Task 2: Wrapper TS `claimMessage` / `markMessageDone`

**Files:**
- Create: `src/lib/db/queries/dedup.ts`
- Test: `tests/unit/db/dedup.test.ts` (append — mocka `rpc` no estilo de `tests/unit/db/taco.test.ts:13`)

- [ ] **Step 1: Write the failing test**

Append em `tests/unit/db/dedup.test.ts`:

```ts
import { vi } from 'vitest'

describe('claimMessage', () => {
  it('calls claim_message RPC and returns claimed=true for a fresh message', async () => {
    const { claimMessage } = await import('@/lib/db/queries/dedup')
    const rpc = vi.fn().mockResolvedValue({ data: [{ claimed: true, prior_status: null }], error: null })
    const supabase = { rpc } as unknown as import('@supabase/supabase-js').SupabaseClient

    const result = await claimMessage(supabase, 'wamid.abc123')

    expect(rpc).toHaveBeenCalledWith('claim_message', {
      p_message_id: 'wamid.abc123',
      p_stale_seconds: 60,
    })
    expect(result).toEqual({ claimed: true, priorStatus: null })
  })

  it('returns claimed=false when prior status is done', async () => {
    const { claimMessage } = await import('@/lib/db/queries/dedup')
    const rpc = vi.fn().mockResolvedValue({ data: [{ claimed: false, prior_status: 'done' }], error: null })
    const supabase = { rpc } as unknown as import('@supabase/supabase-js').SupabaseClient

    const result = await claimMessage(supabase, 'wamid.dup')

    expect(result).toEqual({ claimed: false, priorStatus: 'done' })
  })

  it('FAILS OPEN (claimed=true) when the RPC errors, so we never silently drop a message', async () => {
    const { claimMessage } = await import('@/lib/db/queries/dedup')
    const rpc = vi.fn().mockResolvedValue({ data: null, error: { message: 'connection refused' } })
    const supabase = { rpc } as unknown as import('@supabase/supabase-js').SupabaseClient

    const result = await claimMessage(supabase, 'wamid.err')

    expect(result).toEqual({ claimed: true, priorStatus: null })
  })
})

describe('markMessageDone', () => {
  it('updates the row status to done by message_id', async () => {
    const { markMessageDone } = await import('@/lib/db/queries/dedup')

    const chain: Record<string, unknown> = {}
    chain.update = vi.fn(() => chain)
    chain.eq = vi.fn(() => Promise.resolve({ data: null, error: null }))
    const supabase = { from: vi.fn(() => chain) } as unknown as import('@supabase/supabase-js').SupabaseClient

    await markMessageDone(supabase, 'wamid.abc123')

    expect(supabase.from).toHaveBeenCalledWith('processed_messages')
    expect(chain.update).toHaveBeenCalledWith({ status: 'done' })
    expect(chain.eq).toHaveBeenCalledWith('message_id', 'wamid.abc123')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**
  Run: `npx vitest run tests/unit/db/dedup.test.ts`
  Expected: FAIL — `@/lib/db/queries/dedup` não existe (erro de import nos novos `describe`).

- [ ] **Step 3: Write minimal implementation**

Cria `src/lib/db/queries/dedup.ts`:

```ts
import type { SupabaseClient } from '@supabase/supabase-js'

const STALE_SECONDS = 60

export interface ClaimResult {
  /** True when the caller is allowed to process this message. */
  claimed: boolean
  /** Previous row status, or null if the row was just created. */
  priorStatus: 'processing' | 'done' | null
}

/**
 * Atomically claim a webhook message for processing. Returns claimed=true when the
 * message is new, or when a prior 'processing' claim is stale (a dead execution).
 * Fails OPEN (claimed=true) on RPC error: dropping a message silently is worse than
 * a rare double-process, and logFoodToMeal already consolidates by (user, day, type).
 */
export async function claimMessage(
  supabase: SupabaseClient,
  messageId: string,
): Promise<ClaimResult> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data, error } = await (supabase as any).rpc('claim_message', {
    p_message_id: messageId,
    p_stale_seconds: STALE_SECONDS,
  })

  if (error) {
    console.error('[dedup] claim_message RPC failed (failing open):', error.message)
    return { claimed: true, priorStatus: null }
  }

  const row = (Array.isArray(data) ? data[0] : data) as
    | { claimed: boolean; prior_status: 'processing' | 'done' | null }
    | undefined

  if (!row) {
    console.error('[dedup] claim_message returned no row (failing open)')
    return { claimed: true, priorStatus: null }
  }

  return { claimed: row.claimed, priorStatus: row.prior_status }
}

/** Mark a message as fully processed (a reply was delivered to the user). */
export async function markMessageDone(
  supabase: SupabaseClient,
  messageId: string,
): Promise<void> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { error } = await (supabase as any)
    .from('processed_messages')
    .update({ status: 'done' })
    .eq('message_id', messageId)

  if (error) {
    console.error('[dedup] markMessageDone failed:', error.message)
  }
}
```

- [ ] **Step 4: Run test to verify it passes**
  Run: `npx vitest run tests/unit/db/dedup.test.ts`
  Expected: PASS — todos os casos de `claimMessage`/`markMessageDone` verdes (migration + wrapper).

- [ ] **Step 5: Commit**
  Run:
  ```bash
  git add src/lib/db/queries/dedup.ts tests/unit/db/dedup.test.ts
  git commit -m "feat(webhook): claimMessage/markMessageDone dedup query helpers"
  ```

---

### Task 3: Handlers retornam `Promise<boolean>` (sinal de entrega)

**Files:**
- Modify: `src/lib/bot/handler.ts`
  - `handleIncomingMessage` (assinatura/closure: linhas 237–242 e o `catch` final em 705–711)
  - `handleIncomingAudio` (linhas 713–718 e `catch` 763–768)
  - `handleIncomingImage` (linhas 771–777 e `catch` 964–969)
- Test: `tests/unit/bot/handler-delivery-signal.test.ts`

**Estratégia (preserva os ~40 `return` nus):** o corpo atual de cada handler vira uma closure interna `run()` (mantém todos os `return` como estão, retornando `void`). A função externa: chama `await run()`; em sucesso retorna `true`. No `catch`, tenta enviar `formatError()` — se conseguir, retorna `true` (usuário recebeu UMA resposta), se o fallback também falhar, retorna `false`.

- [ ] **Step 1: Write the failing test**

Cria `tests/unit/bot/handler-delivery-signal.test.ts`. Mocka `sendTextMessage` e o caminho de usuário para forçar o cenário perigoso (refeição "gravada", depois falha de envio):

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest'

const { mockSendTextMessage } = vi.hoisted(() => ({
  mockSendTextMessage: vi.fn(),
}))
vi.mock('@/lib/whatsapp/client', () => ({
  sendTextMessage: mockSendTextMessage,
}))

// Force the handler down a path that throws AFTER user lookup but emits no reply,
// by making findUserByPhone reject. The outer boundary must then attempt the
// fallback error message; its delivery decides the boolean.
const { mockFindUserByPhone } = vi.hoisted(() => ({
  mockFindUserByPhone: vi.fn(),
}))
vi.mock('@/lib/db/queries/users', () => ({
  findUserByPhone: mockFindUserByPhone,
  createUser: vi.fn(),
  getUserWithSettings: vi.fn(),
}))

vi.mock('@/lib/db/supabase', () => ({
  createServiceRoleClient: () => ({ from: vi.fn() }),
}))

import { handleIncomingMessage } from '@/lib/bot/handler'

describe('handleIncomingMessage delivery signal', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('returns true when an error message is delivered to the user', async () => {
    mockFindUserByPhone.mockRejectedValue(new Error('db down'))
    mockSendTextMessage.mockResolvedValue('wamid.out')

    const ok = await handleIncomingMessage('5511999887766', 'wamid.in', 'oi')

    expect(ok).toBe(true)
    expect(mockSendTextMessage).toHaveBeenCalled()
  })

  it('returns false when even the fallback error message fails to send', async () => {
    mockFindUserByPhone.mockRejectedValue(new Error('db down'))
    mockSendTextMessage.mockRejectedValue(new Error('Meta API 500'))

    const ok = await handleIncomingMessage('5511999887766', 'wamid.in', 'oi')

    expect(ok).toBe(false)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**
  Run: `npx vitest run tests/unit/bot/handler-delivery-signal.test.ts`
  Expected: FAIL — `handleIncomingMessage` retorna `undefined` (assinatura `Promise<void>`); `expect(ok).toBe(true)` falha com `received undefined`.

- [ ] **Step 3: Write minimal implementation (handleIncomingMessage)**

Em `src/lib/bot/handler.ts`, altera a assinatura (linha 237–242) e envolve o corpo. O corpo existente (linhas 245–704, ou seja, tudo dentro do `try` atual) move-se intacto para dentro de `run()`; o `catch` final passa a decidir o boolean.

Topo (linhas 237–245) passa de:

```ts
export async function handleIncomingMessage(
  from: string,
  messageId: string,
  text: string,
  quotedMessageId?: string,
): Promise<void> {
  const supabase = createServiceRoleClient()

  try {
```

para:

```ts
export async function handleIncomingMessage(
  from: string,
  messageId: string,
  text: string,
  quotedMessageId?: string,
): Promise<boolean> {
  const supabase = createServiceRoleClient()

  const run = async (): Promise<void> => {
```

E o fundo (linhas 704–711) passa de:

```ts
    await saveBotMessages(supabase, user.id, messageId, sentMessageId, null, null)
  } catch (err) {
    console.error('[handler] Error:', err)
    await sendTextMessage(from, formatError()).catch((sendErr) => {
      console.error('[handler] Failed to send error message (send error):', sendErr)
    })
  }
}
```

para:

```ts
    await saveBotMessages(supabase, user.id, messageId, sentMessageId, null, null)
  }

  try {
    await run()
    return true
  } catch (err) {
    console.error('[handler] Error:', err)
    try {
      await sendTextMessage(from, formatError())
      return true
    } catch (sendErr) {
      console.error('[handler] Failed to send error message (send error):', sendErr)
      return false
    }
  }
}
```

> Atenção: a indentação interna do corpo movido NÃO muda — `run` é uma arrow com o mesmo nível de chaves do antigo `try { ... }`. O `user` continua acessível porque é declarado dentro de `run`. Os ~30 `return` nus desse handler permanecem válidos (retornam de `run`, que é `Promise<void>`).

- [ ] **Step 4: Run test to verify it passes**
  Run: `npx vitest run tests/unit/bot/handler-delivery-signal.test.ts`
  Expected: PASS — `true` quando o fallback envia, `false` quando o fallback também falha.

- [ ] **Step 5: Commit**
  Run:
  ```bash
  git add src/lib/bot/handler.ts tests/unit/bot/handler-delivery-signal.test.ts
  git commit -m "feat(handler): handleIncomingMessage returns delivery success boolean"
  ```

---

### Task 4: `handleIncomingAudio` e `handleIncomingImage` retornam boolean

**Files:**
- Modify: `src/lib/bot/handler.ts`
  - `handleIncomingAudio` (assinatura 713–718; `catch` 763–768; e o encadeamento para `handleIncomingMessage` na linha 762)
  - `handleIncomingImage` (assinatura 771–777; `catch` 964–969)
- Test: `tests/unit/bot/handler-delivery-signal.test.ts` (append)

- [ ] **Step 1: Write the failing test**

Append em `tests/unit/bot/handler-delivery-signal.test.ts`. Para áudio, força falha no download (já dentro do `try`) e checa o boolean; para imagem, idem via `findUserByPhone`:

```ts
import { downloadAudioMedia } from '@/lib/audio/transcribe'

vi.mock('@/lib/audio/transcribe', () => ({
  downloadAudioMedia: vi.fn(),
  transcribeAudio: vi.fn(),
  AudioTooLargeError: class AudioTooLargeError extends Error {},
}))

vi.mock('@/lib/whatsapp/media', () => ({
  downloadWhatsAppMedia: vi.fn().mockRejectedValue(new Error('media fetch failed')),
  MediaTooLargeError: class MediaTooLargeError extends Error {},
}))

describe('handleIncomingAudio delivery signal', () => {
  beforeEach(() => vi.clearAllMocks())

  it('returns true when the error fallback is delivered', async () => {
    const { handleIncomingAudio } = await import('@/lib/bot/handler')
    ;(downloadAudioMedia as unknown as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('boom'))
    mockSendTextMessage.mockResolvedValue('wamid.out')

    const ok = await handleIncomingAudio('5511999887766', 'wamid.in', 'audio-id')
    expect(ok).toBe(true)
  })

  it('returns false when the error fallback also fails', async () => {
    const { handleIncomingAudio } = await import('@/lib/bot/handler')
    ;(downloadAudioMedia as unknown as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('boom'))
    mockSendTextMessage.mockRejectedValue(new Error('Meta 500'))

    const ok = await handleIncomingAudio('5511999887766', 'wamid.in', 'audio-id')
    expect(ok).toBe(false)
  })
})

describe('handleIncomingImage delivery signal', () => {
  beforeEach(() => vi.clearAllMocks())

  it('returns true when the error fallback is delivered', async () => {
    const { handleIncomingImage } = await import('@/lib/bot/handler')
    mockFindUserByPhone.mockRejectedValue(new Error('db down'))
    mockSendTextMessage.mockResolvedValue('wamid.out')

    const ok = await handleIncomingImage('5511999887766', 'wamid.in', 'img-id')
    expect(ok).toBe(true)
  })

  it('returns false when the error fallback also fails', async () => {
    const { handleIncomingImage } = await import('@/lib/bot/handler')
    mockFindUserByPhone.mockRejectedValue(new Error('db down'))
    mockSendTextMessage.mockRejectedValue(new Error('Meta 500'))

    const ok = await handleIncomingImage('5511999887766', 'wamid.in', 'img-id')
    expect(ok).toBe(false)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**
  Run: `npx vitest run tests/unit/bot/handler-delivery-signal.test.ts`
  Expected: FAIL — os 4 novos casos esperam boolean; hoje ambos retornam `undefined`.

- [ ] **Step 3: Write minimal implementation**

**`handleIncomingAudio`** — assinatura (713–718) de `Promise<void>` para `Promise<boolean>`, corpo em `run()`. O `await handleIncomingMessage(...)` na linha 762 deve repassar o boolean: dentro de `run` ele permanece `await handleIncomingMessage(from, messageId, transcription, quotedMessageId)` (retorno descartado — o `markMessageDone` será disparado pelo handler de texto via route? Não: áudio é a entrada do webhook). **Decisão:** como o áudio delega ao texto, o sucesso do áudio = sucesso da entrega final. Capture o retorno e propague:

Linha 761–762 passa de:

```ts
    await sendTextMessage(from, `🎤 Entendi: *${transcription}*\n\n⏳ Registrando...`)
    await handleIncomingMessage(from, messageId, transcription, quotedMessageId)
```

para:

```ts
    await sendTextMessage(from, `🎤 Entendi: *${transcription}*\n\n⏳ Registrando...`)
    deliveredViaText = await handleIncomingMessage(from, messageId, transcription, quotedMessageId)
```

Declara no topo do `run` de áudio (logo após `const run = async (): Promise<void> => {`): nada — em vez disso, mude `run` para retornar boolean apenas neste caso. Para manter simples e uniforme, faça `run` de áudio retornar `boolean` e a borda externa repassar:

Topo (713–721) vira:

```ts
export async function handleIncomingAudio(
  from: string,
  messageId: string,
  audioId: string,
  quotedMessageId?: string,
): Promise<boolean> {
  const supabase = createServiceRoleClient()

  const run = async (): Promise<boolean> => {
```

As primeiras saídas dentro do áudio (linhas 727–728, 741–742, 757–758) que hoje fazem `await sendTextMessage(...)` seguido de `return` viram `return true` (a mensagem foi entregue). Concretamente:

- 727–728: `await sendTextMessage(from, '🎤 Áudio muito longo!...'); return` → `await sendTextMessage(...); return true`
- 741–742: idem → `return true`
- 757–758: idem → `return true`

E a linha final do fluxo feliz (762) vira:

```ts
    return await handleIncomingMessage(from, messageId, transcription, quotedMessageId)
```

O fundo (763–769) passa de:

```ts
  } catch (err) {
    console.error('[handler] Audio error:', err)
    await sendTextMessage(from, formatError()).catch((sendErr) => {
      console.error('[handler] Failed to send error message (send error):', sendErr)
    })
  }
}
```

para:

```ts
  }

  try {
    return await run()
  } catch (err) {
    console.error('[handler] Audio error:', err)
    try {
      await sendTextMessage(from, formatError())
      return true
    } catch (sendErr) {
      console.error('[handler] Failed to send error message (send error):', sendErr)
      return false
    }
  }
}
```

> O `run` de áudio tem 3 saídas `return true` (limites de tamanho/transcrição) e a saída final que propaga o boolean do `handleIncomingMessage`. Todos os caminhos retornam boolean — TS strict fica satisfeito.

**`handleIncomingImage`** — segue o mesmo molde do `handleIncomingMessage` (Task 3), pois NÃO delega a outro handler. Topo (771–780) vira `Promise<boolean>` + `const run = async (): Promise<void> => {`; as saídas que enviam mensagem e dão `return` (ex.: 787–788 onboarding, 799–800 imagem grande, 903–905, 929–933 backdated, 961–963 fluxo feliz) permanecem `return` nus dentro de `run`; o fundo (964–970) vira:

```ts
  }

  try {
    await run()
    return true
  } catch (err) {
    console.error('[handler] Image error:', err)
    try {
      await sendTextMessage(from, formatError())
      return true
    } catch (sendErr) {
      console.error('[handler] Failed to send error message (send error):', sendErr)
      return false
    }
  }
}
```

- [ ] **Step 4: Run test to verify it passes**
  Run: `npx vitest run tests/unit/bot/handler-delivery-signal.test.ts`
  Expected: PASS — 6 casos verdes (texto + áudio + imagem).

- [ ] **Step 5: Run the full handler suite to confirm no regression** (os handlers são muito testados)
  Run: `npx vitest run tests/unit/bot`
  Expected: PASS — nenhum teste existente quebra (a mudança é só no tipo de retorno; chamadas que ignoram o retorno continuam válidas).

- [ ] **Step 6: Commit**
  Run:
  ```bash
  git add src/lib/bot/handler.ts tests/unit/bot/handler-delivery-signal.test.ts
  git commit -m "feat(handler): audio/image handlers return delivery success boolean"
  ```

---

### Task 5: Route usa `claimMessage` e marca `done` por retorno do handler

**Files:**
- Modify: `src/app/api/webhook/whatsapp/route.ts` (linhas 1–66 inteiras)
- Test: `tests/unit/webhook/route.test.ts` (modify — substitui o mock de dedup por `claimMessage`/`markMessageDone` e adiciona casos de retry)

- [ ] **Step 1: Write the failing test**

Substitui o bloco de mock do supabase (linhas 7–21) e adiciona mocks de `@/lib/db/queries/dedup`. Adiciona casos novos. O mock de handler (linhas 28–38) passa a resolver `true` por default:

Topo do arquivo (substitui 7–38):

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest'

const { mockClaimMessage, mockMarkMessageDone } = vi.hoisted(() => ({
  mockClaimMessage: vi.fn(),
  mockMarkMessageDone: vi.fn().mockResolvedValue(undefined),
}))
vi.mock('@/lib/db/queries/dedup', () => ({
  claimMessage: mockClaimMessage,
  markMessageDone: mockMarkMessageDone,
}))

vi.mock('@/lib/db/supabase', () => ({
  createServiceRoleClient: () => ({}),
}))

vi.mock('@/lib/whatsapp/webhook', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/whatsapp/webhook')>()
  return actual
})

const { mockHandleIncomingMessage, mockHandleIncomingAudio, mockHandleIncomingImage } = vi.hoisted(() => ({
  mockHandleIncomingMessage: vi.fn().mockResolvedValue(true),
  mockHandleIncomingAudio: vi.fn().mockResolvedValue(true),
  mockHandleIncomingImage: vi.fn().mockResolvedValue(true),
}))
vi.mock('@/lib/bot/handler', () => ({
  handleIncomingMessage: mockHandleIncomingMessage,
  handleIncomingAudio: mockHandleIncomingAudio,
  handleIncomingImage: mockHandleIncomingImage,
}))
```

Atualiza os casos existentes do `describe('POST /api/webhook/whatsapp')` que dependiam de `mockSingle`/`mockInsert`. Substitui-os por estes (e remove os antigos `mockInsert`/`mockSelect`/`mockSingle` e as referências a eles, incluindo o caso "deduplicates via insert", "duplicate message", "non-duplicate error", "logs error"):

```ts
describe('POST /api/webhook/whatsapp', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockClaimMessage.mockResolvedValue({ claimed: true, priorStatus: null })
    mockMarkMessageDone.mockResolvedValue(undefined)
    mockHandleIncomingMessage.mockResolvedValue(true)
    mockHandleIncomingAudio.mockResolvedValue(true)
    mockHandleIncomingImage.mockResolvedValue(true)
  })

  it('claims the message and processes a fresh text message', async () => {
    const response = await POST(makePostRequest(makeTextPayload()))
    expect(response.status).toBe(200)
    expect(mockClaimMessage).toHaveBeenCalledWith(expect.anything(), 'wamid.abc123')
    expect(mockHandleIncomingMessage).toHaveBeenCalledWith(
      '5511999887766', 'wamid.abc123', 'almocei arroz e feijão', undefined,
    )
  })

  it('marks the message done after the handler delivers a reply', async () => {
    mockHandleIncomingMessage.mockResolvedValue(true)
    await POST(makePostRequest(makeTextPayload()))
    expect(mockMarkMessageDone).toHaveBeenCalledWith(expect.anything(), 'wamid.abc123')
  })

  it('does NOT mark done when the handler failed to deliver a reply (so a retry reprocesses)', async () => {
    mockHandleIncomingMessage.mockResolvedValue(false)
    await POST(makePostRequest(makeTextPayload()))
    expect(mockMarkMessageDone).not.toHaveBeenCalled()
  })

  it('skips processing when claim returns claimed=false (already done)', async () => {
    mockClaimMessage.mockResolvedValue({ claimed: false, priorStatus: 'done' })
    const response = await POST(makePostRequest(makeTextPayload()))
    expect(response.status).toBe(200)
    expect(mockHandleIncomingMessage).not.toHaveBeenCalled()
    expect(mockMarkMessageDone).not.toHaveBeenCalled()
  })

  it('reprocesses a stale processing claim (claimed=true, priorStatus=processing)', async () => {
    mockClaimMessage.mockResolvedValue({ claimed: true, priorStatus: 'processing' })
    await POST(makePostRequest(makeTextPayload()))
    expect(mockHandleIncomingMessage).toHaveBeenCalled()
  })

  it('always returns 200 even when claimMessage rejects', async () => {
    mockClaimMessage.mockRejectedValue(new Error('rpc blew up'))
    const response = await POST(makePostRequest(makeTextPayload()))
    expect(response.status).toBe(200)
  })

  it('returns 200 for a status update event without claiming', async () => {
    const response = await POST(makePostRequest(makeStatusPayload()))
    expect(response.status).toBe(200)
    expect(mockClaimMessage).not.toHaveBeenCalled()
  })

  it('returns 200 for an empty / unparseable body', async () => {
    const response = await POST(makePostRequest({}))
    expect(response.status).toBe(200)
    expect(mockClaimMessage).not.toHaveBeenCalled()
  })
})
```

Nos blocos de áudio/imagem, ajusta os dois testes de dedup existentes (`'deduplication works for audio'` / `'...image...'`) para usar o claim:

```ts
  it('deduplication works for audio: when claim is not granted, handler is NOT called', async () => {
    mockClaimMessage.mockResolvedValue({ claimed: false, priorStatus: 'done' })
    await POST(makePostRequest(makeAudioPayload()))
    expect(mockHandleIncomingAudio).not.toHaveBeenCalled()
  })
```

(idem para imagem, trocando o handler). E nos `beforeEach` desses dois `describe`, adiciona `mockClaimMessage.mockResolvedValue({ claimed: true, priorStatus: null })`. Os testes `'returns 200 even when handleIncomingAudio throws'` permanecem válidos (a borda do route nunca propaga — ver impl).

- [ ] **Step 2: Run test to verify it fails**
  Run: `npx vitest run tests/unit/webhook/route.test.ts`
  Expected: FAIL — o route ainda usa `from('processed_messages').insert(...)` e não importa `claimMessage`/`markMessageDone`; `mockClaimMessage` nunca é chamado, `mockMarkMessageDone` nunca chamado.

- [ ] **Step 3: Write minimal implementation**

Reescreve `src/app/api/webhook/whatsapp/route.ts`:

```ts
export const maxDuration = 60

import { verifyWebhook, parseWebhookPayload } from '@/lib/whatsapp/webhook'
import { createServiceRoleClient } from '@/lib/db/supabase'
import { handleIncomingMessage, handleIncomingAudio, handleIncomingImage } from '@/lib/bot/handler'
import { claimMessage, markMessageDone } from '@/lib/db/queries/dedup'

export async function GET(request: Request) {
  const url = new URL(request.url)
  const params = url.searchParams
  const verifyToken = process.env.WHATSAPP_VERIFY_TOKEN!

  const challenge = verifyWebhook(params, verifyToken)
  if (challenge) {
    return new Response(challenge, { status: 200 })
  }
  return new Response('Forbidden', { status: 403 })
}

export async function POST(request: Request) {
  try {
    const body = await request.json()
    const event = parseWebhookPayload(body)

    // Ignore non-message events
    if (!event || event.type === 'status') {
      return new Response('OK', { status: 200 })
    }

    const supabase = createServiceRoleClient()

    // Atomically claim the message. claimed=false means a live execution owns it
    // or it is already done → skip. Stale 'processing' claims are reclaimed so a
    // prior execution that crashed before replying gets reprocessed.
    const { claimed } = await claimMessage(supabase, event.messageId)
    if (!claimed) {
      return new Response('OK', { status: 200 })
    }

    // Process. The handler returns true only if it delivered SOME reply to the
    // user (confirmation or a friendly error). We mark the message done only then,
    // so a Meta retry reprocesses a message that logged a meal but never replied.
    let delivered = false
    if (event.type === 'text' && event.text) {
      delivered = await handleIncomingMessage(event.from, event.messageId, event.text, event.quotedMessageId)
    } else if (event.type === 'audio' && event.audioId) {
      delivered = await handleIncomingAudio(event.from, event.messageId, event.audioId, event.quotedMessageId)
    } else if (event.type === 'image' && event.imageId) {
      delivered = await handleIncomingImage(event.from, event.messageId, event.imageId, event.caption, event.quotedMessageId)
    } else {
      // Unknown/empty event we still claimed: nothing to do, mark done to avoid retries.
      delivered = true
    }

    if (delivered) {
      await markMessageDone(supabase, event.messageId)
    }

    return new Response('OK', { status: 200 })
  } catch (err) {
    // ALWAYS return 200 to Meta, even on error. The message stays 'processing'
    // (not marked done), so a retry reprocesses it.
    console.error('[webhook] Error processing message:', err)
    return new Response('OK', { status: 200 })
  }
}
```

> Nota: trocamos os `if` independentes por `else if` para que o `delivered` reflita exatamente o ramo executado (antes eram três `if` sequenciais; só um casa por evento, então o comportamento de roteamento é idêntico).

- [ ] **Step 4: Run test to verify it passes**
  Run: `npx vitest run tests/unit/webhook/route.test.ts`
  Expected: PASS — claim chamado, `done` só quando `delivered`, skip quando `!claimed`, sempre 200.

- [ ] **Step 5: Commit**
  Run:
  ```bash
  git add src/app/api/webhook/whatsapp/route.ts tests/unit/webhook/route.test.ts
  git commit -m "fix(webhook): claim-then-confirm — mark processed only after reply delivered"
  ```

---

### Task 6: Cron de limpeza apaga apenas `status='done'`

**Files:**
- Modify: `src/app/api/cron/reminders/route.ts` (linha 404–406)
- Test: `tests/unit/cron/processed-messages-cleanup.test.ts`

- [ ] **Step 1: Write the failing test**

Cria `tests/unit/cron/processed-messages-cleanup.test.ts`. Testa só o trecho de limpeza extraído para uma função pura `cleanupProcessedMessages` (extraímos para testar; o cron a chama):

```ts
import { describe, it, expect, vi } from 'vitest'

describe('cleanupProcessedMessages', () => {
  it('deletes only done rows older than the 24h cutoff', async () => {
    const { cleanupProcessedMessages } = await import('@/app/api/cron/reminders/route')

    const chain: Record<string, unknown> = {}
    chain.delete = vi.fn(() => chain)
    chain.eq = vi.fn(() => chain)
    chain.lt = vi.fn(() => Promise.resolve({ data: null, error: null }))
    const supabase = { from: vi.fn(() => chain) } as unknown as import('@supabase/supabase-js').SupabaseClient

    await cleanupProcessedMessages(supabase)

    expect(supabase.from).toHaveBeenCalledWith('processed_messages')
    expect(chain.delete).toHaveBeenCalled()
    expect(chain.eq).toHaveBeenCalledWith('status', 'done')
    expect(chain.lt).toHaveBeenCalledWith('processed_at', expect.any(String))
  })
})
```

- [ ] **Step 2: Run test to verify it fails**
  Run: `npx vitest run tests/unit/cron/processed-messages-cleanup.test.ts`
  Expected: FAIL — `cleanupProcessedMessages` não é exportado de `route.ts` (erro de import).

- [ ] **Step 3: Write minimal implementation**

Em `src/app/api/cron/reminders/route.ts`, extrai a limpeza para uma função exportada e substitui o trecho inline (linhas 404–406). Adiciona a função (perto das outras helpers do arquivo):

```ts
import type { SupabaseClient } from '@supabase/supabase-js'

export async function cleanupProcessedMessages(supabase: SupabaseClient): Promise<void> {
  // Only delete rows that finished ('done'). A stale 'processing' row must survive
  // so a future retry can detect staleness via claim_message and reprocess it.
  const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()
  await supabase
    .from('processed_messages')
    .delete()
    .eq('status', 'done')
    .lt('processed_at', cutoff)
}
```

> Se `SupabaseClient` já estiver importado no arquivo, não duplique o import. Confirme com `grep -n "SupabaseClient" src/app/api/cron/reminders/route.ts` antes de adicionar.

E substitui o trecho inline (404–406):

```ts
    // --- Step 6: Cleanup processed_messages older than 24h ---
    const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()
    await supabase.from('processed_messages').delete().lt('processed_at', cutoff)
```

por:

```ts
    // --- Step 6: Cleanup processed_messages older than 24h (done rows only) ---
    await cleanupProcessedMessages(supabase)
```

- [ ] **Step 4: Run test to verify it passes**
  Run: `npx vitest run tests/unit/cron/processed-messages-cleanup.test.ts`
  Expected: PASS — delete filtra por `status='done'` e `processed_at < cutoff`.

- [ ] **Step 5: Run the existing cron suite to confirm no regression**
  Run: `npx vitest run tests/unit/cron`
  Expected: PASS — nenhum teste de cron quebra com a extração.

- [ ] **Step 6: Commit**
  Run:
  ```bash
  git add src/app/api/cron/reminders/route.ts tests/unit/cron/processed-messages-cleanup.test.ts
  git commit -m "refactor(cron): cleanup only done processed_messages, keep stale processing"
  ```

---

## Verificação final

- [ ] **Suite completa:** `npm test` → tudo verde.
- [ ] **Lint:** `npm run lint` → sem erros (atenção aos `// eslint-disable-next-line @typescript-eslint/no-explicit-any` em `dedup.ts`, espelhando o padrão já usado no route original).
- [ ] **Build de tipos:** `npm run build` (opcional mas recomendado) → confirma que os novos retornos `Promise<boolean>` dos handlers não quebram nenhum chamador (busque outros chamadores com `grep -rn "handleIncoming" src/` — hoje só o route e o encadeamento áudio→texto consomem).
- [ ] **Aplicar a migration em prod (self-hosted Docker, ver MEMORY):** rodar o SQL de `20260531223000_processed_messages_status.sql` no Postgres self-hosted (`ssh ubuntu@147.15.89.175`), NÃO via cloud MCP. O `ADD COLUMN IF NOT EXISTS` + backfill `done` são idempotentes e seguros em linhas existentes.

## Follow-up documentado (fora do escopo desta frente)

Defesa em profundidade contra dupla-contagem caso o reprocesso de um `processing` stale venha a gravar `meal_items` duplicados: tornar `logFoodToMeal` idempotente por `(user, message_id)` (ex.: vincular `meal_items` ao `incoming message_id` e inserir só se ausente). Hoje o risco é baixo — o reprocesso só ocorre quando a execução anterior NÃO entregou resposta, e a consolidação por `(user, dia, meal_type)` via `find_or_create_meal` já evita refeições duplicadas (mas não itens duplicados dentro da mesma refeição). Abrir como WS separado se o monitoramento de prod mostrar itens duplicados.