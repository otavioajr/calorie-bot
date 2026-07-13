# Inbound retry fresco — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Em retomada (sweeper/piggyback), só responder WhatsApp se a mensagem tiver ≤90s e for a mais recente do telefone; senão marcar `failed_terminal` sem reply.

**Architecture:** Helper puro de TTL + query `hasNewerInboundWork`; gate no `processInboundWork` após o claim, controlado por `freshnessGate` (default `true`; webhook inline passa `false`). Sem migration.

**Tech Stack:** TypeScript, Supabase JS client, Vitest.

**Spec:** [2026-07-13-inbound-retry-fresco-design.md](../specs/2026-07-13-inbound-retry-fresco-design.md)

---

## File Structure

```
src/lib/bot/inbound-freshness.ts              [CREATE] TTL + decisão pura
src/lib/db/queries/inbound-work.ts            [MODIFY] hasNewerInboundWork
src/lib/bot/inbound-processor.ts              [MODIFY] gate pós-claim
src/app/api/webhook/whatsapp/route.ts         [MODIFY] inline freshnessGate:false
src/app/api/cron/inbox-sweeper/route.ts       [MODIFY] (opcional; gate default true)
tests/unit/bot/inbound-freshness.test.ts      [CREATE]
tests/unit/bot/inbound-processor.test.ts      [MODIFY]
tests/unit/db/inbound-work.test.ts            [MODIFY]
tests/unit/webhook/route.test.ts              [MODIFY] se necessário
tests/unit/cron/inbox-sweeper.test.ts         [MODIFY] se necessário
```

---

### Task 1: Helper puro de frescor (TTL)

**Files:**
- Create: `src/lib/bot/inbound-freshness.ts`
- Create: `tests/unit/bot/inbound-freshness.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from 'vitest'
import {
  INBOUND_REPLY_TTL_SECONDS,
  evaluateInboundTtl,
} from '@/lib/bot/inbound-freshness'

describe('evaluateInboundTtl', () => {
  const now = new Date('2026-07-13T12:00:00.000Z')

  it('exposes 90s TTL constant', () => {
    expect(INBOUND_REPLY_TTL_SECONDS).toBe(90)
  })

  it('allows message within TTL', () => {
    const receivedAt = new Date('2026-07-13T11:59:30.000Z')
    expect(evaluateInboundTtl(receivedAt, now)).toEqual({ ok: true })
  })

  it('rejects message older than TTL', () => {
    const receivedAt = new Date('2026-07-13T11:58:00.000Z')
    expect(evaluateInboundTtl(receivedAt, now)).toEqual({
      ok: false,
      errorCode: 'stale_expired',
    })
  })

  it('rejects at exactly TTL+1ms boundary as expired', () => {
    const receivedAt = new Date(now.getTime() - (90_000 + 1))
    expect(evaluateInboundTtl(receivedAt, now).ok).toBe(false)
  })

  it('allows at exactly TTL boundary', () => {
    const receivedAt = new Date(now.getTime() - 90_000)
    expect(evaluateInboundTtl(receivedAt, now)).toEqual({ ok: true })
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test:unit -- tests/unit/bot/inbound-freshness.test.ts`

Expected: FAIL (módulo inexistente)

- [ ] **Step 3: Write minimal implementation**

```ts
// src/lib/bot/inbound-freshness.ts
export const INBOUND_REPLY_TTL_SECONDS = 90

export type InboundTtlResult =
  | { ok: true }
  | { ok: false; errorCode: 'stale_expired' }

export function evaluateInboundTtl(
  receivedAt: Date,
  now: Date = new Date(),
): InboundTtlResult {
  const ageMs = now.getTime() - receivedAt.getTime()
  if (ageMs > INBOUND_REPLY_TTL_SECONDS * 1000) {
    return { ok: false, errorCode: 'stale_expired' }
  }
  return { ok: true }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test:unit -- tests/unit/bot/inbound-freshness.test.ts`

Expected: PASS

- [ ] **Step 5: Commit** (somente se o usuário pedir commit nesta sessão)

```bash
git add src/lib/bot/inbound-freshness.ts tests/unit/bot/inbound-freshness.test.ts
git commit -m "$(cat <<'EOF'
feat: add inbound reply TTL freshness helper

EOF
)"
```

---

### Task 2: `hasNewerInboundWork` query

**Files:**
- Modify: `src/lib/db/queries/inbound-work.ts`
- Modify: `tests/unit/db/inbound-work.test.ts`

- [ ] **Step 1: Write the failing test**

Adicionar em `tests/unit/db/inbound-work.test.ts` (adaptar o chain de mock ao padrão do arquivo):

```ts
it('hasNewerInboundWork returns true when a newer row exists', async () => {
  const maybeSingle = vi.fn().mockResolvedValue({ data: { id: 'newer-id' }, error: null })
  const supabase = {
    from: vi.fn(() => ({
      select: vi.fn(() => ({
        eq: vi.fn(() => ({
          neq: vi.fn(() => ({
            or: vi.fn(() => ({
              limit: vi.fn(() => ({
                maybeSingle,
              })),
            })),
          })),
        })),
      })),
    })),
  } as never

  const newer = await hasNewerInboundWork(supabase, {
    workId: 'work-old',
    userPhone: '5511999999999',
    receivedAt: '2026-07-13T12:00:00.000Z',
    createdAt: '2026-07-13T12:00:00.000Z',
  })
  expect(newer).toBe(true)
})

it('hasNewerInboundWork returns false when userPhone is null', async () => {
  const newer = await hasNewerInboundWork({} as never, {
    workId: 'work-1',
    userPhone: null,
    receivedAt: '2026-07-13T12:00:00.000Z',
    createdAt: '2026-07-13T12:00:00.000Z',
  })
  expect(newer).toBe(false)
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test:unit -- tests/unit/db/inbound-work.test.ts`

Expected: FAIL (`hasNewerInboundWork` undefined)

- [ ] **Step 3: Write minimal implementation**

Em `src/lib/db/queries/inbound-work.ts`:

```ts
export type HasNewerInboundWorkInput = {
  workId: string
  userPhone: string | null
  receivedAt: string
  createdAt: string
}

/**
 * True if another inbound_work for the same phone is strictly newer
 * by (received_at, created_at) lexicographic order.
 */
export async function hasNewerInboundWork(
  supabase: SupabaseClient,
  input: HasNewerInboundWorkInput,
): Promise<boolean> {
  if (!input.userPhone) return false

  const receivedAt = input.receivedAt
  const createdAt = input.createdAt

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data, error } = await (supabase as any)
    .from('inbound_work')
    .select('id')
    .eq('user_phone', input.userPhone)
    .neq('id', input.workId)
    .or(
      `received_at.gt.${receivedAt},and(received_at.eq.${receivedAt},created_at.gt.${createdAt})`,
    )
    .limit(1)
    .maybeSingle()

  if (error) {
    console.error('[inbound-work] hasNewerInboundWork failed:', error.message)
    // Fail closed for reply: treat as superseded so we do not send a late WhatsApp
    return true
  }

  return data != null
}
```

Se o PostgREST exigir aspas no ISO do `.or()`, ajustar para o formato que funcionar (ex. timestamps entre aspas duplas). Validar na implementação; unitários mockam o chain.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test:unit -- tests/unit/db/inbound-work.test.ts`

Expected: PASS

- [ ] **Step 5: Commit** (se pedido)

```bash
git add src/lib/db/queries/inbound-work.ts tests/unit/db/inbound-work.test.ts
git commit -m "$(cat <<'EOF'
feat: detect newer inbound_work for same phone

EOF
)"
```

---

### Task 3: Gate no `processInboundWork`

**Files:**
- Modify: `src/lib/bot/inbound-processor.ts`
- Modify: `tests/unit/bot/inbound-processor.test.ts`

- [ ] **Step 1: Extend unit tests (failing)**

Mockar também `hasNewerInboundWork`. Incluir casos:

1. `freshnessGate: true` + `received_at` velho → `failed_terminal` / `stale_expired`, handler não chamado  
2. `freshnessGate: true` + TTL ok + `hasNewer=true` → `failed_terminal` / `superseded`  
3. `freshnessGate: false` → não chama `from`/`hasNewer`, handler roda  

Usar `vi.useFakeTimers()` nos casos de TTL. Atualizar testes existentes de sucesso para passar `{ freshnessGate: false }` quando o default for `true`.

Exemplo do caso stale:

```ts
it('with freshnessGate marks stale_expired without calling handler', async () => {
  mockHasNewer.mockResolvedValue(false)
  const supabase = supabaseWithMeta({
    received_at: '2026-07-13T11:00:00.000Z',
    created_at: '2026-07-13T11:00:00.000Z',
    user_phone: '5511999999999',
  })
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-07-13T12:00:00.000Z'))

  const outcome = await processInboundWork(
    supabase,
    { workId: 'work-1', payload },
    'owner-1',
    { freshnessGate: true },
  )

  expect(outcome).toBe('failed_terminal')
  expect(mockHandleIncomingMessage).not.toHaveBeenCalled()
  expect(mockComplete).toHaveBeenCalledWith(
    supabase,
    'work-1',
    'owner-1',
    'failed_terminal',
    'stale_expired',
    expect.any(String),
  )
  vi.useRealTimers()
})
```

Helper `supabaseWithMeta` retorna client com `.from().select().eq().single()` resolvendo o meta.

- [ ] **Step 2: Run tests to verify new cases fail**

Run: `npm run test:unit -- tests/unit/bot/inbound-processor.test.ts`

Expected: FAIL (options / gate inexistentes)

- [ ] **Step 3: Implement gate**

Após `claim` bem-sucedido, se `options.freshnessGate ?? true`:

1. `select received_at, created_at, user_phone` da row  
2. `evaluateInboundTtl` → se fail, `complete(..., 'failed_terminal', 'stale_expired', ...)` e return  
3. `hasNewerInboundWork` → se true, `complete(..., 'failed_terminal', 'superseded', ...)` e return  
4. Senão `dispatchInboundPayload` + `committed` (fluxo atual)

Se meta faltar: `failed_retryable` / `freshness_meta_error` (não enviar WhatsApp).

Assinatura:

```ts
export type ProcessInboundWorkOptions = {
  /** Default true. Webhook inline deve passar false. */
  freshnessGate?: boolean
}

export async function processInboundWork(
  supabase: SupabaseClient,
  work: { workId: string; payload: InboundPayload; status?: InboundWorkStatus },
  leaseOwner: string,
  options: ProcessInboundWorkOptions = {},
): Promise<InboundProcessOutcome>
```

- [ ] **Step 4: Run processor tests**

Run: `npm run test:unit -- tests/unit/bot/inbound-processor.test.ts`

Expected: PASS

- [ ] **Step 5: Commit** (se pedido)

```bash
git add src/lib/bot/inbound-processor.ts tests/unit/bot/inbound-processor.test.ts
git commit -m "$(cat <<'EOF'
feat: gate inbound retry by TTL and latest message

EOF
)"
```

---

### Task 4: Webhook inline desliga o gate; retomada usa default

**Files:**
- Modify: `src/app/api/webhook/whatsapp/route.ts`
- Modify: `tests/unit/webhook/route.test.ts` (se assertar args de `processInboundWork`)
- Modify: `tests/unit/cron/inbox-sweeper.test.ts` (garantir que não passa `freshnessGate: false`)

- [ ] **Step 1: Ajustar chamada inline**

Em `processInboundEvent`:

```ts
  await processInboundWork(
    supabase,
    {
      workId: enqueued.workId,
      payload: toInboundPayload(event),
      status: enqueued.status,
    },
    leaseOwner,
    { freshnessGate: false },
  )
```

Piggyback e sweeper **não** passam options (default `true`).

- [ ] **Step 2: Atualizar testes do webhook/sweeper** conforme mocks

- [ ] **Step 3: Rodar suite unitária afetada**

```bash
npm run test:unit -- \
  tests/unit/bot/inbound-freshness.test.ts \
  tests/unit/bot/inbound-processor.test.ts \
  tests/unit/db/inbound-work.test.ts \
  tests/unit/webhook/route.test.ts \
  tests/unit/cron/inbox-sweeper.test.ts
```

Expected: PASS

- [ ] **Step 4: Typecheck**

Run: `npx tsc --noEmit`

Expected: 0 erros novos

- [ ] **Step 5: Commit** (se pedido)

```bash
git add src/app/api/webhook/whatsapp/route.ts tests/unit/webhook/route.test.ts tests/unit/cron/inbox-sweeper.test.ts
git commit -m "$(cat <<'EOF'
fix: disable freshness gate on inline webhook process

EOF
)"
```

---

### Task 5: Status do spec

**Files:**
- Modify: `docs/superpowers/specs/2026-07-13-inbound-retry-fresco-design.md` — status → Implementado (quando o código estiver pronto)

- [ ] Atualizar status após implementação
- [ ] Commit docs só se o usuário pedir

---

## Spec coverage checklist

| Requisito spec | Task |
|---|---|
| TTL 90s `received_at` | Task 1 + 3 |
| Superseded por telefone | Task 2 + 3 |
| Sem WhatsApp no expire | Task 3 |
| Gate só em retomada; inline off | Task 4 |
| `error_code` stale_expired / superseded | Task 3 |
| Sem migration / sem mudar lease-attempts | — |
| Testes aceitação | Tasks 1–4 |

---

## Notas de produção

- Sem env nova; sem migration VPS.
- Merge em `main` = deploy. Comportamento novo só no retry (sweeper/piggyback).
- Rollback: reverter o PR.
