# Fase 2 — Inbox enxuta Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Inbox durável (`inbound_work`) com lease atômico, ACK só após enqueue, fail-closed no claim, processamento inline, piggyback + sweeper acionado por cron na VPS — sem outbox nem `domain_operations`.

**Architecture:** Migration aditiva + RPCs `SECURITY DEFINER`; wrappers TS em `src/lib/db/queries/inbound-work.ts`; webhook enfileira → claim → handlers atuais → complete; `/api/cron/inbox-sweeper` reprocessa órfãos; feature flag `INBOUND_WORK_ENABLED`.

**Tech Stack:** Next.js route handlers, Postgres (Supabase migrations), Vitest unit + integration, `CRON_SECRET` / `isCronAuthorized`.

**Roadmap:** [2026-07-11-roadmap-bot-inteligente-economico.md](2026-07-11-roadmap-bot-inteligente-economico.md) · **Spec:** [2026-07-12-fase2-inbox-enxuta-design.md](../specs/2026-07-12-fase2-inbox-enxuta-design.md) · **Branch:** `fix/fase2-inbox-enxuta`

**Achados:** WEB-03, WEB-04, WEB-05 · **Invariantes:** INV-03, INV-21, INV-22 (parcial)

**Produção:** merge em `main` = deploy. Aplicar migration na VPS **antes** de ligar `INBOUND_WORK_ENABLED=true`.

---

## Decisões de produto (defaults da spec)

| Decisão | Default |
|---|---|
| Processamento | Inline no webhook (`maxDuration=60`) |
| Retry órfãos | Piggyback (2) + sweeper na VPS do Postgres `147.15.89.175` (`*/2`) + cron diário Vercel |
| Fail-open | Proibido (flag on e off) |
| Flag | `INBOUND_WORK_ENABLED` |
| Lease / max attempts | 90s / 5 |
| Fora | outbox, `domain_operations`, QStash, worker VPS |

---

## File Structure

```
supabase/migrations/
  20260712140000_inbound_work.sql          [CREATE] tabela + RPCs + grants
src/lib/db/queries/
  inbound-work.ts                          [CREATE] enqueue/claim/complete/listStale
src/lib/bot/
  inbound-processor.ts                     [CREATE] claim+processMessage+complete (shared)
src/app/api/webhook/whatsapp/route.ts      [MODIFY] enqueue, fail-closed, piggyback, flag
src/app/api/cron/inbox-sweeper/route.ts    [CREATE] cron auth + batch stale
vercel.json                                [MODIFY] cron diário de rede de segurança
.env.example                               [MODIFY] INBOUND_WORK_ENABLED + nota VPS sweeper
tests/unit/db/inbound-work.test.ts         [CREATE] wrappers + migration smoke read
tests/unit/webhook/route.test.ts           [MODIFY] fail-closed, 503, flag paths
tests/unit/cron/inbox-sweeper.test.ts      [CREATE]
tests/integration/db/inbound-work.test.ts  [CREATE] concorrência, lease, unique
tests/integration/webhook/webhook-e2e.test.ts [MODIFY] assert inbound_work quando flag on
tests/integration/helpers/db-reset.ts      [MODIFY] TRUNCATE inbound_work
docs/superpowers/plans/2026-07-11-roadmap-bot-inteligente-economico.md [MODIFY] status Fase 2
docs/ops/vps-inbox-sweeper.md              [CREATE] instruções crontab (sem secrets)
```

---

### Task 1: Migration `inbound_work` + RPCs

**Files:**
- Create: `supabase/migrations/20260712140000_inbound_work.sql`
- Test: `tests/unit/db/inbound-work.test.ts` (leitura da migration, estilo WS5)

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const MIGRATION = resolve(
  __dirname,
  '../../../supabase/migrations/20260712140000_inbound_work.sql',
)

describe('migration: inbound_work', () => {
  const sql = (() => {
    try {
      return readFileSync(MIGRATION, 'utf8')
    } catch {
      return ''
    }
  })()

  it('creates inbound_work with unique provider triple', () => {
    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS inbound_work/i)
    expect(sql).toMatch(/UNIQUE\s*\(\s*provider\s*,\s*business_account_id\s*,\s*provider_message_id\s*\)/i)
  })

  it('defines claim_inbound_work as SECURITY DEFINER with pinned search_path', () => {
    expect(sql).toMatch(/CREATE OR REPLACE FUNCTION claim_inbound_work/i)
    expect(sql).toMatch(/SECURITY DEFINER/i)
    expect(sql).toMatch(/SET search_path = public, pg_temp/i)
  })

  it('defines enqueue_inbound_work, complete_inbound_work, list_stale_inbound_work', () => {
    expect(sql).toMatch(/CREATE OR REPLACE FUNCTION enqueue_inbound_work/i)
    expect(sql).toMatch(/CREATE OR REPLACE FUNCTION complete_inbound_work/i)
    expect(sql).toMatch(/CREATE OR REPLACE FUNCTION list_stale_inbound_work/i)
  })

  it('grants execute only to service_role', () => {
    expect(sql).toMatch(/GRANT EXECUTE ON FUNCTION claim_inbound_work/i)
    expect(sql).toMatch(/TO service_role/i)
    expect(sql).toMatch(/REVOKE ALL ON FUNCTION claim_inbound_work/i)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/db/inbound-work.test.ts`  
Expected: FAIL — arquivo de migration ausente.

- [ ] **Step 3: Write migration**

Criar `supabase/migrations/20260712140000_inbound_work.sql` conforme spec §4.2–4.4:

- Tabela `inbound_work` com colunas da spec.
- Check constraint em `status`: `accepted`, `processing`, `committed`, `failed_retryable`, `failed_terminal`.
- Índices `(status, lease_expires_at)`, `(user_phone, event_at)`.
- `enqueue_inbound_work(...) RETURNS TABLE (work_id UUID, status TEXT, was_inserted BOOLEAN)` — INSERT ON CONFLICT DO NOTHING; se conflito, SELECT da row existente.
- `claim_inbound_work(p_work_id UUID, p_owner TEXT, p_lease_seconds INTEGER DEFAULT 90) RETURNS TABLE (claimed BOOLEAN, status TEXT, attempt INTEGER)` — `FOR UPDATE`; reclaim se lease expirado; incrementa `attempt`.
- `complete_inbound_work(p_work_id UUID, p_owner TEXT, p_status TEXT, p_error_code TEXT DEFAULT NULL, p_error_message TEXT DEFAULT NULL)` — só se `lease_owner = p_owner` e status atual `processing`.
- `list_stale_inbound_work(p_limit INTEGER DEFAULT 5)` — `accepted` OU (`processing` AND lease expirado) OU `failed_retryable` com `attempt < 5`, ordenado por `received_at`, LIMIT.
- Grants espelhando `find_or_create_meal`.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/unit/db/inbound-work.test.ts`  
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/20260712140000_inbound_work.sql tests/unit/db/inbound-work.test.ts
git commit -m "$(cat <<'EOF'
feat(db): add inbound_work table and claim RPCs for Fase 2

EOF
)"
```

---

### Task 2: Wrappers TypeScript `inbound-work.ts`

**Files:**
- Create: `src/lib/db/queries/inbound-work.ts`
- Modify: `tests/unit/db/inbound-work.test.ts` (append mocks de `rpc`)

- [ ] **Step 1: Write failing tests for wrappers**

```ts
import { describe, it, expect, vi } from 'vitest'

describe('enqueueInboundWork', () => {
  it('calls enqueue_inbound_work RPC and returns work id', async () => {
    const { enqueueInboundWork } = await import('@/lib/db/queries/inbound-work')
    const rpc = vi.fn().mockResolvedValue({
      data: [{ work_id: '11111111-1111-1111-1111-111111111111', status: 'accepted', was_inserted: true }],
      error: null,
    })
    const supabase = { rpc } as never
    const result = await enqueueInboundWork(supabase, {
      provider: 'whatsapp_cloud',
      businessAccountId: 'pnid',
      providerMessageId: 'wamid.1',
      userPhone: '5511999999999',
      eventAt: new Date().toISOString(),
      payload: { type: 'text', text: 'oi' },
    })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.workId).toBe('11111111-1111-1111-1111-111111111111')
      expect(result.wasInserted).toBe(true)
    }
  })

  it('returns ok=false on RPC error (fail-closed)', async () => {
    const { enqueueInboundWork } = await import('@/lib/db/queries/inbound-work')
    const rpc = vi.fn().mockResolvedValue({ data: null, error: { message: 'down' } })
    const result = await enqueueInboundWork({ rpc } as never, {
      provider: 'whatsapp_cloud',
      businessAccountId: 'pnid',
      providerMessageId: 'wamid.err',
      userPhone: '5511999999999',
      eventAt: new Date().toISOString(),
      payload: { type: 'text' },
    })
    expect(result.ok).toBe(false)
  })
})

describe('claimInboundWork', () => {
  it('returns claimed=false without failing open on RPC error', async () => {
    const { claimInboundWork } = await import('@/lib/db/queries/inbound-work')
    const rpc = vi.fn().mockResolvedValue({ data: null, error: { message: 'down' } })
    const result = await claimInboundWork({ rpc } as never, '11111111-1111-1111-1111-111111111111', 'owner-1')
    expect(result.claimed).toBe(false)
  })
})
```

- [ ] **Step 2: Run test — expect FAIL** (módulo inexistente)

Run: `npx vitest run tests/unit/db/inbound-work.test.ts`

- [ ] **Step 3: Implement wrappers**

`src/lib/db/queries/inbound-work.ts`:

- Tipos de payload mínimo alinhados a `WhatsAppMessage` (campos necessários para `processMessage`).
- `enqueueInboundWork`, `claimInboundWork`, `completeInboundWork`, `listStaleInboundWork`.
- **Fail-closed:** qualquer `error` de RPC → `ok: false` / `claimed: false`; logar mensagem sem payload de usuário.
- Helper `isInboundWorkEnabled(): boolean` → `process.env.INBOUND_WORK_ENABLED === 'true'`.

- [ ] **Step 4: Run tests — PASS**

- [ ] **Step 5: Commit**

```bash
git add src/lib/db/queries/inbound-work.ts tests/unit/db/inbound-work.test.ts
git commit -m "$(cat <<'EOF'
feat(db): TypeScript wrappers for inbound_work RPCs (fail-closed)

EOF
)"
```

---

### Task 3: Processor compartilhado

**Files:**
- Create: `src/lib/bot/inbound-processor.ts`
- Test: `tests/unit/bot/inbound-processor.test.ts`

- [ ] **Step 1: Failing tests**

- Claim false → não chama `processMessage`.
- Claim true + process ok → `complete` com `committed`.
- Claim true + process throws → `complete` com `failed_retryable`.
- Se `attempt >= 5` após falha → `failed_terminal` (via complete com status terminal ou RPC que encapsule).

- [ ] **Step 2: Implement**

```ts
// Assinatura alvo
export async function processInboundWork(
  supabase: SupabaseClient,
  work: { workId: string; payload: InboundPayload },
  leaseOwner: string,
): Promise<'committed' | 'skipped' | 'failed_retryable' | 'failed_terminal'>
```

Internamente: claim → mapear payload para `processMessage` (mesma lógica do route atual) → complete. Extrair o corpo de `processMessage` do route para este módulo **ou** importar handlers e duplicar o switch type (preferir extrair `processMessage` do route para `inbound-processor.ts` / `webhook-process.ts` para DRY).

- [ ] **Step 3: PASS + commit**

```bash
git commit -m "$(cat <<'EOF'
feat(bot): shared inbound work processor with lease lifecycle

EOF
)"
```

---

### Task 4: Webhook route — enqueue, fail-closed, flag, piggyback

**Files:**
- Modify: `src/app/api/webhook/whatsapp/route.ts`
- Modify: `tests/unit/webhook/route.test.ts`

- [ ] **Step 1: Update/add unit tests**

Casos obrigatórios (IDs nos nomes/comentários):

1. **WEB-05:** erro no enqueue/claim legado → **não** chama handler; status **503** se inbox dirty.
2. **WEB-03/04:** com flag on, enqueue ok + claim ok → processa; segunda chamada same id com status committed → skip handler.
3. Flag off: ainda fail-closed no insert `processed_messages` (remover ramo “processing anyway”).
4. Piggyback: `listStale` retorna 1 id → `processInboundWork` chamado para ele (mock).

- [ ] **Step 2: Run — expect FAIL** nos novos asserts.

- [ ] **Step 3: Implement route**

Pseudocódigo:

```
POST:
  ... signature / parse (unchanged) ...
  leaseOwner = randomUUID()
  inboxFailed = false

  if isInboundWorkEnabled():
    await piggybackStale(supabase, leaseOwner, limit=2)
    for event of events:
      if !phoneOk: continue
      enq = await enqueueInboundWork(...)
      if !enq.ok: inboxFailed = true; continue
      if enq.status in committed|failed_terminal: continue
      await processInboundWork(supabase, enq, leaseOwner)
  else:
    for event:
      // legado: insert processed_messages
      // SE insert error != 23505: inboxFailed=true; NÃO processar
      // SE 23505: skip
      // else processMessage

  return inboxFailed ? 503 : 200
```

- [ ] **Step 4: Suite webhook unit PASS**

Run: `npx vitest run tests/unit/webhook/route.test.ts`

- [ ] **Step 5: Commit**

```bash
git commit -m "$(cat <<'EOF'
fix(webhook): durable inbound_work enqueue with fail-closed claim

EOF
)"
```

---

### Task 5: Cron `inbox-sweeper`

**Files:**
- Create: `src/app/api/cron/inbox-sweeper/route.ts`
- Create: `tests/unit/cron/inbox-sweeper.test.ts`
- Modify: `vercel.json` (cron diário)
- Modify: `.env.example`
- Create: `docs/ops/vps-inbox-sweeper.md`

- [ ] **Step 1: Failing tests**

- Sem auth → 401.
- Com auth → chama `listStaleInboundWork(5)` e processa cada um.
- `CRON_SECRET` ausente → 401 (`isCronAuthorized`).

- [ ] **Step 2: Implement route**

```ts
export const maxDuration = 60
// GET or POST — prefer POST to match other crons if they use GET; mirror reminders:
export async function GET(request: Request) {
  if (!isCronAuthorized(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  // list stale, processInboundWork each, return summary
}
```

- [ ] **Step 3: `vercel.json`**

Adicionar (diário, Hobby-safe):

```json
{
  "path": "/api/cron/inbox-sweeper",
  "schedule": "15 4 * * *"
}
```

- [ ] **Step 4: Docs VPS**

`docs/ops/vps-inbox-sweeper.md`:

- Criar `~/.caloriebot-cron.env` com `CRON_SECRET` e `SWEEPER_URL=https://caloriebot.app/api/cron/inbox-sweeper` (ajustar domínio real).
- Crontab `*/2 * * * *`.
- Sem commitar secrets.

`.env.example`:

```
# Fase 2 inbox (set true only after migration applied on VPS)
INBOUND_WORK_ENABLED=false
# Sweeper: VPS crontab curls /api/cron/inbox-sweeper every 2m — see docs/ops/vps-inbox-sweeper.md
```

- [ ] **Step 5: Commit**

```bash
git commit -m "$(cat <<'EOF'
feat(cron): inbox-sweeper endpoint and VPS ops docs

EOF
)"
```

---

### Task 6: Testes de integração Postgres

**Files:**
- Create: `tests/integration/db/inbound-work.test.ts`
- Modify: `tests/integration/helpers/db-reset.ts` — incluir `inbound_work` no TRUNCATE
- Modify: `tests/integration/webhook/webhook-e2e.test.ts` — com flag on, assert row `committed`

**Pré-requisito:** `colima start` + `supabase start` + `supabase db reset` (ou migration aplicada) + `.env.test.local`.

- [ ] **Step 1: Integration tests**

```ts
it('two concurrent enqueues for same provider triple yield one work_id', ...)
it('only one concurrent claim succeeds', ...)
it('expired lease can be reclaimed', ...)
it('fresh lease cannot be claimed by another owner', ...)
it('complete by non-owner does not flip status', ...)
```

Usar `Promise.all` com dois clients service role / duas RPCs.

- [ ] **Step 2: E2E**

Setar `process.env.INBOUND_WORK_ENABLED = 'true'` no describe; smoke existente deve criar `inbound_work` `committed`; replay same message id → handler mock count não sobe (ajustar conforme mocks atuais).

- [ ] **Step 3: Run**

```bash
npm run test:integration
```

Expected: PASS. Ao terminar local: `supabase stop` && `colima stop`.

- [ ] **Step 4: Commit**

```bash
git commit -m "$(cat <<'EOF'
test(integration): prove inbound_work uniqueness, lease, and webhook commit

EOF
)"
```

---

### Task 7: Roadmap + verificação final

**Files:**
- Modify: `docs/superpowers/plans/2026-07-11-roadmap-bot-inteligente-economico.md`

- [ ] Atualizar status Fase 2 → implementando / branch `fix/fase2-inbox-enxuta`; linkar spec + este plano; §9 próximo passo.
- [ ] Rodar: `npm test` · `npm run lint` · `npx tsc --noEmit`
- [ ] Checklist pré-merge produção:
  - [ ] Migration aplicada na VPS
  - [ ] `INBOUND_WORK_ENABLED` ainda `false` no primeiro deploy (ou true só após migration)
  - [ ] `CRON_SECRET` na Vercel e na VPS
  - [ ] Crontab VPS instalado
  - [ ] Sweeper diário no `vercel.json`

- [ ] Commit docs:

```bash
git commit -m "$(cat <<'EOF'
docs: link Fase 2 inbox enxuta spec and plan in roadmap

EOF
)"
```

---

## Verificação final (DoD)

- [ ] WEB-03: crash simulado / lease expirado → sweeper ou piggyback retoma
- [ ] WEB-04: duplicate `message_id` / triple → não reprocessa se `committed`
- [ ] WEB-05: falha de enqueue → 503, zero handler
- [ ] Gates §20.2: migration no diff exatamente a autorizada neste plano
- [ ] Sem outbox / sem `domain_operations` neste PR
- [ ] PR → merge pelo Otávio após review

## Follow-up explícito (não neste PR)

- Fase 2b: `outbox_messages` + REL-26
- Fase 3: `domain_operations` + `meal_items.source_operation_id`
- Remover `processed_messages` após período de observação
