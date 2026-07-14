# Fase 2b Outbox — Correções Pós-Revisão Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fechar todos os achados Critical e Important da revisão transversal da Fase 2b, garantindo start durável antes de cada POST selecionado, FIFO uniforme, rollback com drain explícito e release local verificável.

**Architecture:** `claim_outbox_messages` e `begin_outbox_fallback_attempt` são as únicas autorizações duráveis de transporte. Active inline, sweeper, shadow e fallback persistem uma lease antes do POST; suspensão impede novas leases e a manutenção drena tentativas já iniciadas. A mesma migration mantém a máquina de estados, os locks, a projeção transacional e as ACLs, enquanto o serviço TypeScript executa as decisões persistidas.

**Tech Stack:** Next.js 16.2.1, TypeScript strict, PostgreSQL/PLpgSQL, Supabase JS 2.99.3 contra PostgreSQL self-hosted, Vitest 4.1.0, MSW 2.12.14 e GitHub Actions.

**Design:** `docs/superpowers/specs/2026-07-14-fase2b-outbox-post-review-design.md`.

## Global Constraints

- Não aplicar migration na VPS, alterar env de produção, instalar cron real, iniciar shadow/canário/active, fazer push, abrir PR ou merge.
- Editar `supabase/migrations/20260713120000_outbox_messages.sql` in-place; ela ainda não foi aplicada em produção.
- Não adicionar dependência nem alterar `package-lock.json`.
- Todo POST Meta de destinatário selecionado em shadow ou active exige lease durável anterior.
- A ordem de locks é geração → chave idempotente → destinatário → linha.
- `unknown_reconcile_at` deve permanecer posterior ao maior timeout de HTTP e de execução serverless documentado.
- `suspend_outbox_generation` instala o fence; rollback só termina após zero `sending`, zero `unknown` não reconciliado e zero `lease_token`.
- Modo `off` e active não selecionado preservam o transporte direto legado.
- `.cursor/settings.json`, `docs/superpowers/plans/2026-07-13-fase2b-outbox-pendencias.md` e `docs/superpowers/plans/2026-07-13-fase2b-outbox-invariantes.md` permanecem intactos e untracked.
- Cada tarefa começa em RED, registra a falha esperada, implementa o mínimo, passa em GREEN e termina com commit escopado.
- Cada tarefa recebe revisão de conformidade com a spec e revisão de qualidade
  antes de iniciar a seguinte; Critical ou Important reabre o ciclo RED/GREEN.

## File Map

- `supabase/migrations/20260713120000_outbox_messages.sql`: máquina de estados, locks, leases, callbacks, projeção, ACLs e schema reload.
- `src/lib/outbox/repository.ts`: adaptação tipada das RPCs; a assinatura pública de `beginOutboxFallbackAttempt` permanece estável.
- `src/lib/outbox/service.ts`: roteamento active/shadow/fallback e persistência dos resultados Meta.
- `src/lib/whatsapp/meta-client.ts`: classificação HTTP conhecida versus resultado ambíguo.
- `src/lib/bot/inbound-processor.ts`: pré-carga do usuário existente antes de abrir o scope.
- `src/app/api/cron/reminders/route.ts` e `src/app/api/cron/webhook-health/route.ts`: handlers GET/POST.
- `tests/unit/outbox/service.test.ts` e `tests/unit/outbox/repository.test.ts`: protocolo sem banco e contrato das RPCs.
- `tests/unit/whatsapp/client.test.ts`: classificação do body de resposta.
- `tests/unit/bot/inbound-processor.test.ts`: usuário/contexto nas respostas antecipadas.
- `tests/unit/cron/reminders.test.ts` e `tests/unit/cron/webhook-health.test.ts`: paridade GET/POST.
- `tests/integration/outbox-rpcs.test.ts`: invariantes SQL, races determinísticas, atomicidade e ACLs.
- `tests/integration/webhook/webhook-e2e.test.ts`: história completa do webhook.
- `tests/integration/outbox-delivery-stories.test.ts`: histórias reais de OTP, reminder, retries e fallback.
- `tests/unit/outbox/fault-injection.test.ts`: falhas de persistência e garantias de zero repost.
- `.github/workflows/ci.yml`: corpus completo e build no quality gate.
- `docs/ops/vps-outbox-sweeper.md`: aplicação atômica, schema cache, gates e drain.

---

## Lote 1 — Protocolo de transporte, fallback, shadow e rollback

### Task 1: Generalizar o gate SQL de tentativa direta e preservar FIFO

**Files:**
- Modify: `supabase/migrations/20260713120000_outbox_messages.sql`
- Modify: `tests/integration/outbox-rpcs.test.ts`
- Modify: `tests/unit/outbox/repository.test.ts`

**Interfaces:**
- Consumes: `beginOutboxFallbackAttempt(supabase, { outboxId, idempotencyKey, leaseSeconds })`.
- Produces: o mesmo `BeginOutboxFallbackAttemptResult`, com `started=false`, `leaseToken=null`, `status='pending'` significando active duravelmente enfileirado por FIFO.
- Produces: evento `fallback_queued` quando um tombstone active vira pending, e `fallback_started` quando uma lease direta é criada.

- [ ] **Step 1: Adicionar o helper e testes RED do begin generalizado**

No escopo dos helpers de `tests/integration/outbox-rpcs.test.ts`, adicionar:

```ts
async function beginFallbackAttempt(
  row: RpcRow,
  key: string,
  leaseSeconds: number = 90,
): Promise<RpcRow> {
  const supabase = getIntegrationSupabase()
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data, error } = await (supabase as any).rpc(
    'begin_outbox_fallback_attempt',
    {
      p_outbox_id: row.outbox_id,
      p_idempotency_key: key,
      p_lease_seconds: leaseSeconds,
    },
  )
  if (error) throw new Error(error.message)
  return data[0] as RpcRow
}
```

Adicionar os casos:

```ts
it('starts a newly inserted shadow row only through a durable lease', async () => {
  const key = 'shadow-direct:start'
  const row = await enqueue(key, { rolloutMode: 'shadow' })
  const begun = await beginFallbackAttempt(row, key)

  expect(begun).toMatchObject({
    started: true,
    status: 'sending',
    attempt: 1,
  })
  expect(begun.lease_token).toEqual(expect.any(String))
  expect(adminRows(`
    SELECT status, lease_token IS NOT NULL AS leased
    FROM public.outbox_messages
    WHERE id = '${row.outbox_id}'
  `)[0]).toMatchObject({ status: 'sending', leased: true })
})

it('queues an active fallback behind an unresolved predecessor', async () => {
  const predecessor = await enqueue('fallback-fifo:predecessor')
  await claim(
    'fallback-fifo-owner',
    GENERATION,
    90,
    predecessor.outbox_id as string,
    true,
  )

  const key = 'fallback-fifo:terminal'
  const payload = { type: 'text', text: key }
  await fenceFallback(key, hashPayload(payload))
  const tombstone = await enqueue(key, { payload })
  const begun = await beginFallbackAttempt(tombstone, key)

  expect(begun).toMatchObject({
    started: false,
    lease_token: null,
    status: 'pending',
    attempt: 0,
  })
  expect(adminRows(`
    SELECT status, suspended_reason, delivery_authority
    FROM public.outbox_messages
    WHERE id = '${tombstone.outbox_id}'
  `)[0]).toMatchObject({
    status: 'pending',
    suspended_reason: null,
    delivery_authority: true,
  })
})
```

No mesmo ciclo RED, adicionar três casos completos:

- `terminal fallback supersedes an earlier retryable progress`: o progresso
  termina em `retryable`, o tombstone terminal é enfileirado, o progresso vira
  `superseded` e deixa de bloquear o terminal;
- `sweeper claims a queued fallback only after its predecessor resolves`: antes
  do resultado do predecessor o claim retorna vazio; depois do resultado ele
  retorna somente o tombstone;
- `unknown fallback blocks its successor until reconciliation`: após begin e
  record unknown o sucessor não é claimado; depois de
  `unknown_reconcile_at` e maintenance ele passa a ser elegível.

- [ ] **Step 2: Executar os testes para confirmar RED**

Run:

```bash
npm run test:integration -- tests/integration/outbox-rpcs.test.ts
```

Expected: os dois casos falham porque shadow pending não é aceito pelo begin e o fallback active ignora o predecessor ou permanece suspended.

- [ ] **Step 3: Reescrever `begin_outbox_fallback_attempt` com a hierarquia única de locks**

Preservar assinatura e retorno. Antes de qualquer `FOR UPDATE`, ler geração e destinatário; depois adquirir:

```sql
PERFORM pg_catalog.pg_advisory_xact_lock_shared(
  pg_catalog.hashtextextended('outbox-generation:' || v_generation, 0)
);
PERFORM pg_catalog.pg_advisory_xact_lock(
  pg_catalog.hashtextextended('outbox-key:' || p_idempotency_key, 0)
);
PERFORM pg_catalog.pg_advisory_xact_lock(
  pg_catalog.hashtextextended('outbox-recipient:' || v_recipient, 0)
);

SELECT * INTO v_row
FROM public.outbox_messages AS om
WHERE om.id = p_outbox_id
  AND om.idempotency_key = p_idempotency_key
FOR UPDATE;
```

Sob esses locks, recusar geração suspensa. Para active com predecessor, usar:

```sql
IF v_row.rollout_mode = 'active'
   AND EXISTS (
     SELECT 1
     FROM public.outbox_messages AS earlier
     WHERE earlier.recipient = v_row.recipient
       AND earlier.sequence_no < v_row.sequence_no
       AND earlier.delivery_authority
       AND (
         earlier.status IN ('pending', 'sending', 'retryable')
         OR (
           earlier.status = 'unknown'
           AND earlier.terminal_at IS NULL
           AND COALESCE(
             earlier.unknown_reconcile_at,
             'infinity'::TIMESTAMPTZ
           ) > v_now
         )
       )
   ) THEN
  UPDATE public.outbox_messages AS om
  SET status = 'pending', suspended_reason = NULL, updated_at = v_now
  WHERE om.id = v_row.id
  RETURNING * INTO v_row;

  INSERT INTO public.outbox_status_events (
    outbox_id, event_type, previous_status, new_status, attempt, event_at
  ) VALUES (
    v_row.id, 'fallback_queued', 'suspended', 'pending', v_row.attempt, v_now
  );

  started := FALSE;
  lease_token := NULL;
  status := v_row.status;
  attempt := v_row.attempt;
  RETURN NEXT;
  RETURN;
END IF;
```

Reordenar também `fence_outbox_fallback`: ler geração e recipient sem row lock,
adquirir geração → chave → destinatário, consultar a suspensão na mesma
transação e somente então bloquear fence/row. Para geração cercada,
`safe_for_direct` é sempre false, mesmo quando o fence já existia.

Autorizar somente shadow/pending/attempt 0 sem delivery authority ou active/suspended/enqueue_fallback/attempt 0 com delivery authority. Para ambos:

```sql
v_token := gen_random_uuid();
UPDATE public.outbox_messages AS om
SET
  status = 'sending',
  suspended_reason = NULL,
  attempt = om.attempt + 1,
  lease_owner = CASE
    WHEN om.rollout_mode = 'shadow' THEN 'shadow-direct'
    ELSE 'fallback-direct'
  END,
  lease_token = v_token,
  last_lease_token = v_token,
  lease_expires_at = v_now
    + pg_catalog.make_interval(secs => p_lease_seconds),
  next_attempt_at = NULL,
  updated_at = v_now
WHERE om.id = v_row.id
RETURNING * INTO v_row;
```

- [ ] **Step 4: Fazer tombstone terminal superseder progresso anterior**

Em `enqueue_outbox_message`, ainda sob geração → chave → destinatário:

```sql
IF v_row.rollout_mode = 'active'
   AND v_row.message_kind IN ('prompt', 'terminal')
   AND v_row.work_id IS NOT NULL THEN
  UPDATE public.outbox_messages AS older
  SET
    status = 'superseded',
    terminal_at = COALESCE(older.terminal_at, NOW()),
    next_attempt_at = NULL,
    updated_at = NOW()
  WHERE older.work_id = v_row.work_id
    AND older.id <> v_row.id
    AND older.message_kind = 'progress'
    AND older.status IN ('pending', 'retryable');
END IF;
```

Não alterar sending, unknown, estados aceitos ou terminais.

- [ ] **Step 5: Testar o contrato TypeScript estável**

Em `tests/unit/outbox/repository.test.ts`, mapear o retorno pending:

```ts
expect(await beginOutboxFallbackAttempt({ rpc } as never, {
  outboxId: 'outbox-1',
  idempotencyKey: 'fallback-fifo:terminal',
  leaseSeconds: 90,
})).toEqual({
  ok: true,
  started: false,
  leaseToken: null,
  status: 'pending',
  attempt: 0,
})
```

Nenhum novo campo entra em `BeginOutboxFallbackAttemptResult`.

- [ ] **Step 6: Executar GREEN**

```bash
npm run test:integration -- tests/integration/outbox-rpcs.test.ts
npm run test:unit -- tests/unit/outbox/repository.test.ts
```

Expected: ambos passam; o fallback enfileirado tem zero lease.

- [ ] **Step 7: Commitar o gate SQL**

```bash
git add supabase/migrations/20260713120000_outbox_messages.sql tests/integration/outbox-rpcs.test.ts tests/unit/outbox/repository.test.ts
git commit -m "fix: unify durable outbox starts"
```

### Task 2: Unificar shadow e fallback no serviço TypeScript

**Files:**
- Modify: `src/lib/outbox/service.ts`
- Modify: `tests/unit/outbox/service.test.ts`

**Interfaces:**
- Consumes: `BeginOutboxFallbackAttemptResult` da Task 1.
- Produces: `sendText()` sem POST shadow/fallback anterior à lease.
- Produces: active bloqueado por FIFO retorna `durablyEnqueued=true`, `status='pending'` e `route='active'`.

- [ ] **Step 1: Substituir expectativas legadas por testes RED**

Adicionar:

```ts
it('does not post a newly inserted suspended shadow row', async () => {
  const dependencies = createDependencies({
    readEnv: () => activeEnv({ OUTBOX_MODE: 'shadow' }),
    enqueue: vi.fn().mockResolvedValue(enqueueResult({
      wasInserted: true,
      status: 'suspended',
    })),
  })

  const result = await createOutboxDeliveryService(dependencies)
    .sendText(durableInput())

  expect(dependencies.beginFallback).not.toHaveBeenCalled()
  expect(dependencies.sendMeta).not.toHaveBeenCalled()
  expect(result).toMatchObject({
    route: 'shadow',
    status: 'suspended',
    durablyEnqueued: true,
  })
})

it('starts shadow through begin before posting', async () => {
  const order: string[] = []
  const dependencies = createDependencies({
    readEnv: () => activeEnv({ OUTBOX_MODE: 'shadow' }),
    beginFallback: vi.fn().mockImplementation(async () => {
      order.push('begin')
      return {
        ok: true,
        started: true,
        leaseToken: LEASE_TOKEN,
        status: 'sending',
        attempt: 1,
      }
    }),
    sendMeta: vi.fn().mockImplementation(async () => {
      order.push('post')
      return { kind: 'accepted', providerMessageId: 'wamid.shadow' }
    }),
    recordAttempt: vi.fn().mockImplementation(async () => {
      order.push('record')
      return {
        ok: true,
        applied: true,
        status: 'api_accepted',
        attempt: 1,
        providerMessageId: 'wamid.shadow',
      }
    }),
  })

  const result = await createOutboxDeliveryService(dependencies)
    .sendText(durableInput())

  expect(order).toEqual(['begin', 'post', 'record'])
  expect(dependencies.recordAttempt).toHaveBeenCalledWith(
    expect.anything(),
    expect.objectContaining({ leaseToken: LEASE_TOKEN }),
  )
  expect(result.route).toBe('shadow')
})

it('returns a FIFO-blocked active fallback as durably queued', async () => {
  const dependencies = createDependencies({
    enqueue: vi.fn()
      .mockRejectedValueOnce(new Error('connection dropped'))
      .mockResolvedValueOnce(enqueueResult({
        wasInserted: false,
        status: 'suspended',
      })),
    beginFallback: vi.fn().mockResolvedValue({
      ok: true,
      started: false,
      leaseToken: null,
      status: 'pending',
      attempt: 0,
    }),
  })

  const result = await createOutboxDeliveryService(dependencies)
    .sendText(durableInput())

  expect(dependencies.sendMeta).not.toHaveBeenCalled()
  expect(result).toMatchObject({
    route: 'active',
    status: 'pending',
    durablyEnqueued: true,
    replayed: true,
  })
})
```

Adicionar um quarto caso em que shadow ou fallback recebe
`outcome_unknown`: begin devolve a lease, há um único POST e `recordAttempt`
recebe `outcome:'unknown'`, `nextAttemptAt:null` e a mesma lease.

- [ ] **Step 2: Confirmar RED**

```bash
npm run test:unit -- tests/unit/outbox/service.test.ts
```

Expected: shadow envia diretamente, usa lease nula, e active `started=false` lança erro.

- [ ] **Step 3: Criar persistência direta comum com lease obrigatória**

Substituir `recordShadowOutcome` e `recordFallbackOutcome` por `persistDirectOutcome` com parâmetros:

```ts
async function persistDirectOutcome(
  supabase: SupabaseClient,
  input: OutboxTextInput,
  outboxId: string,
  leaseToken: string,
  outcome: MetaSendOutcome,
  route: 'shadow' | 'enqueue-fallback',
  preventInboundReplay: boolean,
): Promise<OutboxSendResult>
```

A função classifica accepted/unknown/failed_terminal como o fluxo atual, sempre passa `leaseToken` a `recordAttempt`, preserva o `reportCritical` e retorna `durablyEnqueued:true`.

- [ ] **Step 4: Fazer todos os caminhos selecionados chamarem begin antes do POST**

Shadow normal aceita POST apenas para row pending com begin iniciado e lease. Enqueue ambíguo de shadow usa `fenceFallback` → segundo enqueue/tombstone → `beginFallback`, igual ao active. Qualquer falha em fence/tombstone/begin termina com zero POST.

Para active bloqueado:

```ts
if (
  begun.ok &&
  !begun.started &&
  begun.status === 'pending' &&
  config.mode === 'active'
) {
  return {
    providerMessageId: null,
    outboxId,
    status: 'pending',
    route: 'active',
    durablyEnqueued: true,
    replayed: true,
    preventInboundReplay: requiresInboundReplayFence,
    attemptResultPersisted: false,
  }
}
```

- [ ] **Step 5: Corrigir telemetria de replay**

Propagar `replayed: !enqueued.wasInserted` ao retorno inline; uma row pending/retryable existente reclamada no request deve retornar true.

- [ ] **Step 6: Executar GREEN e typecheck**

```bash
npm run test:unit -- tests/unit/outbox/service.test.ts tests/unit/outbox/repository.test.ts
npx tsc --noEmit
```

Expected: passa e nenhuma tentativa shadow/fallback persiste resultado com lease nula.

- [ ] **Step 7: Commitar o serviço**

```bash
git add src/lib/outbox/service.ts tests/unit/outbox/service.test.ts
git commit -m "fix: fence shadow and fallback delivery"
```

### Task 3: Implementar suspensão como fence seguido de drain

**Files:**
- Modify: `supabase/migrations/20260713120000_outbox_messages.sql`
- Modify: `tests/integration/outbox-rpcs.test.ts`

**Interfaces:**
- Consumes: locks e leases das Tasks 1–2.
- Produces: `suspend_outbox_generation` preserva tentativas in-flight.
- Produces: `claim_outbox_messages(..., p_limit => 0, ...)` executa manutenção em geração suspensa e retorna zero rows.

- [ ] **Step 1: Escrever testes RED de fence e drain**

Após claim ou begin, suspender e afirmar:

```ts
expect(adminRows(`
  SELECT status, lease_token IS NOT NULL AS leased
  FROM public.outbox_messages
  WHERE id = '${sending.outbox_id}'
`)[0]).toMatchObject({ status: 'sending', leased: true })
```

Expirar a lease via `adminExec`, chamar claim com `p_limit:0` e afirmar zero rows, status unknown, lease nula e `unknown_reconcile_at` preenchido. Repetir para shadow com `delivery_authority=false`.

- [ ] **Step 2: Confirmar RED**

```bash
npm run test:integration -- tests/integration/outbox-rpcs.test.ts
```

Expected: suspensão altera ou limpa sending e a manutenção retorna cedo.

- [ ] **Step 3: Preservar in-flight em `suspend_outbox_generation`**

Normalizar a razão uma vez e limitar a transição:

```sql
UPDATE public.outbox_messages AS om
SET
  status = 'suspended',
  suspended_reason = v_reason,
  next_attempt_at = NULL,
  terminal_at = COALESCE(om.terminal_at, v_now),
  updated_at = v_now
WHERE om.rollout_generation = p_generation
  AND om.status IN ('pending', 'retryable');
```

Não incluir sending/unknown nem limpar lease de sending. Tombstone suspended ainda não iniciado recebe `v_reason` sem mudar attempt.

- [ ] **Step 4: Executar manutenção antes do early return**

Manter o shared generation lock, executar expiry, stale sending, terminal lease cleanup e unknown reconciliation, e só então:

```sql
IF EXISTS (
  SELECT 1
  FROM private.outbox_suspended_generations AS osg
  WHERE osg.generation = p_generation
) THEN
  RETURN;
END IF;
```

Nos loops de stale sending e unknown, remover o filtro delivery authority para incluir shadow. Claims continuam exigindo authority e nunca rodam depois do return.

- [ ] **Step 5: Tornar races determinísticas**

Usar `trackAdminExec` e `waitForDbActivity` já existentes, com marker único em `pg_stat_activity`. Provar exatamente uma ordem: start antes do `suspended_at` e preservado como in-flight, ou fence antes e zero start.

- [ ] **Step 6: Executar GREEN**

```bash
npm run test:integration -- tests/integration/outbox-rpcs.test.ts
```

Expected: passa sem sleep arbitrário e sem sessão psql pendente.

- [ ] **Step 7: Commitar fence e drain**

```bash
git add supabase/migrations/20260713120000_outbox_messages.sql tests/integration/outbox-rpcs.test.ts
git commit -m "fix: drain suspended outbox generations"
```


---

## Lote 2 — Meta client, scope, callbacks e cron

### Task 4: Classificar rejeição HTTP mesmo quando o body é ilegível

**Files:**
- Modify: `src/lib/whatsapp/meta-client.ts`
- Modify: `tests/unit/whatsapp/client.test.ts`

**Interfaces:**
- Produces: `response.ok=false` sempre retorna `MetaRejectedOutcome` com `httpStatus`.
- Produces: body ilegível em 2xx continua `MetaUnknownOutcome`.

- [ ] **Step 1: Escrever testes RED para 429, 503 e 2xx**

Usar:

```ts
it.each([429, 503])(
  'keeps HTTP %s rejected when reading the body fails',
  async (status) => {
    configureWhatsApp()
    const fetchImpl = vi.fn<MetaFetch>().mockResolvedValue({
      ok: false,
      status,
      headers: new Headers({ 'x-fb-request-id': 'body-read-failed' }),
      text: vi.fn().mockRejectedValue(new Error('body stream failed')),
    } as unknown as Response)

    const outcome = await sendMetaTextMessage(
      { to: '5511999887766', text: 'Hello!' },
      { fetchImpl },
    )

    expect(outcome).toMatchObject({
      kind: 'rejected',
      httpStatus: status,
      requestId: 'body-read-failed',
      message: 'body stream failed',
    })
    expect(classifySynchronousFailure(outcome).retryable).toBe(true)
  },
)
```

Manter um caso equivalente com `ok:true/status:200` esperando outcome_unknown.

- [ ] **Step 2: Confirmar RED**

```bash
npm run test:unit -- tests/unit/whatsapp/client.test.ts
```

Expected: 429 e 503 retornam outcome_unknown.

- [ ] **Step 3: Ramificar o catch de body por `response.ok`**

```ts
} catch (error) {
  clearTimeout(timer)
  if (!response.ok) {
    return {
      kind: 'rejected',
      httpStatus: response.status,
      ...(requestId ? { requestId } : {}),
      message: errorMessage(error),
    }
  }
  return {
    kind: 'outcome_unknown',
    outcomeUnknown: true,
    httpStatus: response.status,
    ...(requestId ? { requestId } : {}),
    message: errorMessage(error),
  }
}
```

- [ ] **Step 4: Executar GREEN e commit**

```bash
npm run test:unit -- tests/unit/whatsapp/client.test.ts tests/unit/outbox/policy.test.ts
git add src/lib/whatsapp/meta-client.ts tests/unit/whatsapp/client.test.ts
git commit -m "fix: preserve known Meta rejections"
```

### Task 5: Pré-carregar usuário existente no outbox scope

**Files:**
- Modify: `src/lib/bot/inbound-processor.ts`
- Modify: `tests/unit/bot/inbound-processor.test.ts`

**Interfaces:**
- Consumes: `findUserByPhone(supabase, phone): Promise<User | null>`.
- Produces: `runWithOutboxScope({ userId })` antes de qualquer resposta antecipada.

- [ ] **Step 1: Mockar lookup e escrever testes RED**

Adicionar:

```ts
const mockFindUserByPhone = vi.fn()

vi.mock('@/lib/db/queries/users', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/db/queries/users')>()
  return {
    ...actual,
    findUserByPhone: (...args: unknown[]) => mockFindUserByPhone(...args),
  }
})
```

No beforeEach, retornar `{ id: 'user-existing' }`. Testar text vazio, text longo, unsupported, áudio sem ID e imagem sem ID; cada caso afirma:

```ts
expect(mockRunWithOutboxScope).toHaveBeenCalledWith(
  expect.objectContaining({
    workId: 'work-1',
    recipient: payload.from,
    userId: 'user-existing',
  }),
  expect.any(Function),
)
```

Adicionar falha do lookup esperando failed_retryable, handler_error e zero dispatch.

Nos casos com contexto ativo, fazer o mock do scope devolver
`userId:'user-existing'`, afirmar chamada a `getActiveContextResult` com esse
ID e verificar que `finalizeOutboxScope` recebe o expiry de prompt, não o TTL
terminal default.

- [ ] **Step 2: Confirmar RED**

```bash
npm run test:unit -- tests/unit/bot/inbound-processor.test.ts
```

Expected: o scope não recebe userId.

- [ ] **Step 3: Fazer lookup sem criar usuário**

Importar `findUserByPhone` e, dentro do try principal antes do scope:

```ts
const existingUser = await findUserByPhone(supabase, work.payload.from)
const { summary } = await runWithOutboxScope(
  {
    workId: work.workId,
    recipient: work.payload.from,
    userId: existingUser?.id ?? null,
    beforeUnsafeFallback: async (incident) => {
      const completed = await completeInboundWork(
        supabase,
        work.workId,
        leaseOwner,
        'committed',
        'outbox_enqueue_fallback',
        incident.error.message,
      )
      if (!completed.completed) {
        throw new Error(
          'Could not durably fence inbound replay before direct fallback',
        )
      }
    },
  },
  () => dispatchInboundPayload(work.payload),
)
```

Não chamar `createUser`; o handler mantém essa responsabilidade.

Quando `summary.unsafeFallbackFenced` também possuir terminal durável, não
retornar antes de `finalizeDurableInboundResponse`. Usar a ordem:

```ts
if (summary.unsafeFallbackFenced && !summary.hasDurableTerminal) {
  return 'committed'
}

if (outboxConfig.mode === 'shadow') {
  await finalizeDurableInboundResponse(
    supabase,
    work.workId,
    leaseOwner,
    summary,
    false,
  )
} else if (requiresDurableTerminal) {
  const durableOutcome = await finalizeDurableInboundResponse(
    supabase,
    work.workId,
    leaseOwner,
    summary,
    true,
  )
  if (durableOutcome) return durableOutcome
}

if (summary.unsafeFallbackFenced) return 'committed'
```

Assim o fallback pending recebe `scope_finalized` e fica claimable pelo
sweeper, sem tentar completar novamente o inbound já cercado.

- [ ] **Step 4: Executar GREEN e commit**

```bash
npm run test:unit -- tests/unit/bot/inbound-processor.test.ts tests/unit/outbox/scope.test.ts
git add src/lib/bot/inbound-processor.ts tests/unit/bot/inbound-processor.test.ts
git commit -m "fix: preload users into outbox scope"
```

### Task 6: Projetar callbacks failed e provar rollback transacional

**Files:**
- Modify: `supabase/migrations/20260713120000_outbox_messages.sql`
- Modify: `tests/integration/outbox-rpcs.test.ts`

**Interfaces:**
- Consumes: `private.project_outbox_bot_message(UUID, TEXT)`.
- Produces: todo callback correlacionado com WAMID válido tenta projeção exatamente uma vez, inclusive failed.

- [ ] **Step 1: Escrever teste RED de projeção failed**

Criar usuário, enqueue com userId, aplicar callback failed e afirmar:

```ts
expect(adminRows(`
  SELECT COUNT(*)::integer AS count
  FROM public.bot_messages
  WHERE user_id = '${user.id}'
    AND message_id = 'wamid.failed-first'
    AND direction = 'outgoing'
`)[0]).toMatchObject({ count: 1 })
```

Chamar record result tardio com o mesmo WAMID e manter count 1.

- [ ] **Step 2: Escrever fault test RED de rollback conjunto**

Criar e remover em finally:

```sql
CREATE OR REPLACE FUNCTION public.test_fail_bot_projection()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $trigger$
BEGIN
  IF NEW.message_id = 'wamid.rollback-projection' THEN
    RAISE EXCEPTION 'forced bot projection failure';
  END IF;
  RETURN NEW;
END;
$trigger$;
CREATE TRIGGER test_fail_bot_projection
BEFORE INSERT ON public.bot_messages
FOR EACH ROW EXECUTE FUNCTION public.test_fail_bot_projection();
```

Esperar erro da RPC. Depois afirmar status original, zero callback ledger, zero bot_message, payload OTP não redigido e marker nulo.

- [ ] **Step 3: Confirmar RED**

```bash
npm run test:integration -- tests/integration/outbox-rpcs.test.ts
```

Expected: failed não cria projeção.

- [ ] **Step 4: Projetar qualquer callback correlacionado**

Substituir o guard positivo por:

```sql
IF v_row.id IS NOT NULL
   AND p_provider_message_id IS NOT NULL
   AND BTRIM(p_provider_message_id) <> '' THEN
  PERFORM private.project_outbox_bot_message(
    v_row.id,
    COALESCE(v_row.provider_message_id, p_provider_message_id)
  );
END IF;
```

A chamada permanece na mesma transação depois do update e ledger insert; nenhuma exception é capturada.

- [ ] **Step 5: Tornar a race callback/WAMID determinística**

Substituir `pg_sleep(1.5)` e `setTimeout(300)` por sessão marcada observada com `waitForDbActivity`. Provar: callback alcançou o marker; record result aguardou Advisory; órfão original foi criado; exatamente um `orphan_callback_linked` referencia seu `related_event_id`.

- [ ] **Step 6: Executar GREEN e commit**

```bash
npm run test:integration -- tests/integration/outbox-rpcs.test.ts
git add supabase/migrations/20260713120000_outbox_messages.sql tests/integration/outbox-rpcs.test.ts
git commit -m "fix: project failed outbox callbacks"
```

### Task 7: Exportar GET para os crons configurados

**Files:**
- Modify: `src/app/api/cron/reminders/route.ts`
- Modify: `src/app/api/cron/webhook-health/route.ts`
- Modify: `tests/unit/cron/reminders.test.ts`
- Modify: `tests/unit/cron/webhook-health.test.ts`

**Interfaces:**
- Produces: GET e POST com autorização, efeitos e payload idênticos em cada rota.

- [ ] **Step 1: Escrever testes RED de GET**

Parametrizar:

```ts
function request(
  method: 'GET' | 'POST',
  secret: string = 'test-cron-secret',
) {
  return new Request('http://localhost/api/cron/reminders', {
    method,
    headers: { authorization: `Bearer ${secret}` },
  })
}
```

Importar GET e POST; para cada um afirmar 401 com segredo inválido e 200 com segredo válido. No reminder, cada chamada isolada produz as três chaves estáveis.

- [ ] **Step 2: Confirmar RED**

```bash
npm run test:unit -- tests/unit/cron/reminders.test.ts tests/unit/cron/webhook-health.test.ts
```

Expected: os módulos não exportam GET.

- [ ] **Step 3: Extrair handler comum e aliases**

Em cada rota, mover o corpo autorizado para `runAuthorizedCron` e usar:

```ts
async function handleCron(request: Request) {
  if (!isCronAuthorized(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  return runAuthorizedCron()
}

export const GET = handleCron
export const POST = handleCron
```

Manter status HTTP, efeitos e logs atuais.

- [ ] **Step 4: Executar GREEN e commit**

```bash
npm run test:unit -- tests/unit/cron/reminders.test.ts tests/unit/cron/webhook-health.test.ts
git add src/app/api/cron/reminders/route.ts src/app/api/cron/webhook-health/route.ts tests/unit/cron/reminders.test.ts tests/unit/cron/webhook-health.test.ts
git commit -m "fix: support GET cron invocations"
```


---

## Lote 3 — Fault matrix, histórias, ACL e CI

### Task 8: Fechar histórias reais de entrega e fault injection

**Files:**
- Create: `tests/integration/outbox-delivery-stories.test.ts`
- Modify: `tests/integration/webhook/webhook-e2e.test.ts`
- Modify: `tests/unit/outbox/fault-injection.test.ts`

**Interfaces:**
- Consumes: serviço unificado e RPCs corrigidas.
- Produces: histórias com PostgreSQL real, MSW e contagem exata de POSTs.

- [ ] **Step 1: Criar fixture de histórias com contagem de POSTs**

O novo arquivo inicia MSW, chama `resetIntegrationDb()` em beforeEach, configura active/generation/percent 100 e captura:

```ts
type CapturedPost = {
  to: string
  text: { body: string }
  biz_opaque_callback_data?: string
}

const capturedPosts: CapturedPost[] = []

server.use(http.post(
  'https://graph.facebook.com/v21.0/000000000000000/messages',
  async ({ request }) => {
    capturedPosts.push(await request.json() as CapturedPost)
    return HttpResponse.json({
      contacts: [{ wa_id: capturedPosts.at(-1)?.to }],
      messages: [{ id: `wamid.story.${capturedPosts.length}` }],
    })
  },
))
```

- [ ] **Step 2: Adicionar história OTP**

Chamar `sendOTP(phone)` contra banco real e afirmar:

```ts
await sendOTP('5511999000001')

expect(capturedPosts).toHaveLength(1)
const otp = adminRows(`
  SELECT om.id, om.idempotency_key, om.max_attempts, om.status,
         om.provider_message_id, om.payload_json,
         om.payload_redacted_at IS NOT NULL AS redacted,
         ac.id AS auth_code_id
  FROM public.outbox_messages AS om
  JOIN public.auth_codes AS ac ON ac.id = om.resource_id
  WHERE om.recipient = '5511999000001'
`)[0]
expect(otp).toMatchObject({
  idempotency_key: `otp:${otp?.auth_code_id}`,
  max_attempts: 3,
  status: 'api_accepted',
  provider_message_id: 'wamid.story.1',
  payload_json: null,
  redacted: true,
})
```

Criar quatro solicitações na mesma janela e afirmar que a quarta rejeita por
rate limit antes do POST; o total Meta permanece três.

- [ ] **Step 3: Adicionar história reminder**

Enviar duas vezes a mesma chave:

```ts
const reminder = {
  to: '5511999000002',
  text: 'Hora do almoço',
  options: {
    source: 'reminder' as const,
    messageKind: 'reminder' as const,
    idempotencyKey: 'reminder:user-1:daily-reminder:2026-07-14',
    userId: userId,
    resourceMetadata: {
      reminderType: 'lunch',
      localDate: '2026-07-14',
    },
  },
}
await sendTextThroughOutbox(reminder)
await sendTextThroughOutbox(reminder)

expect(capturedPosts).toHaveLength(1)
expect(adminRows(`
  SELECT COUNT(*)::integer AS count
  FROM public.outbox_messages
  WHERE idempotency_key =
    'reminder:user-1:daily-reminder:2026-07-14'
`)[0]).toMatchObject({ count: 1 })
```

- [ ] **Step 4: Adicionar histórias de erro e supersede**

Cobrir MSW 429 → retryable com backoff; 400 permanente → failed_terminal; socket/timeout após início → unknown sem `next_attempt_at`; progresso → uma tentativa e superseded pela resposta final. Cada história afirma contagem 0 ou 1 de POSTs.

Usar a tabela de expectativas:

```ts
const rejectionStories = [
  { httpStatus: 429, expectedStatus: 'retryable' },
  { httpStatus: 400, expectedStatus: 'failed_terminal' },
] as const

for (const story of rejectionStories) {
  const result = await sendWithMetaStatus(story.httpStatus)
  expect(result.status).toBe(story.expectedStatus)
  expect(capturedPosts).toHaveLength(1)
}
```

Definir o helper:

```ts
async function sendWithMetaStatus(httpStatus: number) {
  capturedPosts.length = 0
  server.use(http.post(
    'https://graph.facebook.com/v21.0/000000000000000/messages',
    async ({ request }) => {
      capturedPosts.push(await request.json() as CapturedPost)
      return HttpResponse.json(
        { error: { message: `HTTP ${httpStatus}` } },
        { status: httpStatus },
      )
    },
  ))
  return sendTextThroughOutbox({
    to: '5511999000003',
    text: `status ${httpStatus}`,
    options: {
      source: 'reminder',
      messageKind: 'reminder',
      idempotencyKey: `reminder:error:${httpStatus}`,
    },
  })
}
```

O caso unknown inclui um sucessor do mesmo recipient e prova zero POST desse
sucessor até a reconciliação terminal.

- [ ] **Step 5: Reforçar webhook completo**

Em `webhook-e2e.test.ts`, manter a história active e acrescentar: um evento scope_finalized, uma bot_message, exatamente um POST antes/depois do replay e correlação pelo `biz_opaque_callback_data`.

As asserções finais são:

```ts
expect(capturedMetaMessages).toHaveLength(1)
expect(adminRows(`
  SELECT COUNT(*)::integer AS count
  FROM public.outbox_status_events
  WHERE outbox_id = '${sent.biz_opaque_callback_data}'
    AND event_type = 'scope_finalized'
`)[0]).toMatchObject({ count: 1 })
expect(adminRows(`
  SELECT COUNT(*)::integer AS count
  FROM public.bot_messages
  WHERE metadata->>'outbox_id' = '${sent.biz_opaque_callback_data}'
`)[0]).toMatchObject({ count: 1 })
```

- [ ] **Step 6: Completar fault injection unitária**

Em `fault-injection.test.ts`, cobrir:

- crash após enqueue e antes de POST: row pending e zero POST;
- aceitação Meta e falha de recordAttempt: um POST, incidente crítico e zero repost;
- enqueue ambíguo após mutação: fence/tombstone/begin antes do possível POST;
- lease vencida do sweeper: manutenção muda para unknown sem novo POST.

Cada caso usa `toHaveBeenCalledTimes(0)` ou `toHaveBeenCalledTimes(1)` sobre sendMeta.

Auditar os testes de concorrência tocados nesta fase: nenhum usa espera fixa
para provar ordenação. Cada race usa marker em `pg_stat_activity`, wait event
observável e cleanup da sessão em `finally`.

- [ ] **Step 7: Executar RED, corrigir desvios apenas no código responsável e obter GREEN**

```bash
npm run test:unit -- tests/unit/outbox/fault-injection.test.ts
npm run test:integration -- tests/integration/outbox-delivery-stories.test.ts tests/integration/webhook/webhook-e2e.test.ts
```

Expected final: todos passam e cada história afirma quantidade de POSTs.

- [ ] **Step 8: Commitar matriz de histórias**

```bash
git add tests/integration/outbox-delivery-stories.test.ts tests/integration/webhook/webhook-e2e.test.ts tests/unit/outbox/fault-injection.test.ts src/lib/outbox/service.ts supabase/migrations/20260713120000_outbox_messages.sql
git commit -m "test: cover durable outbox delivery stories"
```

### Task 9: Fechar ACLs, schema reload e CI

**Files:**
- Modify: `supabase/migrations/20260713120000_outbox_messages.sql`
- Modify: `tests/integration/outbox-rpcs.test.ts`
- Modify: `.github/workflows/ci.yml`

**Interfaces:**
- Produces: funções privilegiadas indisponíveis para PUBLIC/anon/authenticated e executáveis somente por service_role.
- Produces: tabelas sem SELECT/INSERT/UPDATE/DELETE para todos os API roles.

- [ ] **Step 1: Escrever matriz RED de privilégios**

Testar as duas tabelas, quatro operações e roles anon, authenticated e
service_role com `has_table_privilege`. Para PUBLIC, consultar ACL expandida
com `aclexplode` e `grantee=0`; PUBLIC é pseudo-role, não nome de role aceito
por `has_*_privilege`. Para cada assinatura, afirmar service_role true, demais
roles false e ausência de grantee 0:

```ts
const privilegedRpcs = [
  'public.enqueue_outbox_message(text,text,text,text,text,jsonb,text,text,text,integer,timestamptz,uuid,uuid,integer,text,text,uuid,jsonb)',
  'public.fence_outbox_fallback(text,text,text,text,text,text,text)',
  'public.begin_outbox_fallback_attempt(uuid,text,integer)',
  'public.claim_outbox_messages(text,text,integer,integer,uuid,boolean)',
  'public.record_outbox_attempt_result(uuid,uuid,text,text,timestamptz,integer,integer,integer,text,text,jsonb)',
  'public.apply_outbox_callback(text,text,timestamptz,uuid,integer,integer,text,jsonb)',
  'public.finalize_outbox_scope(uuid,uuid,text,timestamptz)',
  'public.list_outbox_sweeper_work(text,integer)',
  'public.suspend_outbox_generation(text,text)',
  'public.redact_outbox_payloads(integer)',
] as const
```

Também afirmar `prosecdef=true` e `proconfig` contendo `search_path=` nas dez RPCs.

Usar esta consulta para PUBLIC nas funções:

```sql
SELECT COUNT(*)::integer AS public_execute
FROM pg_catalog.pg_proc AS p
CROSS JOIN LATERAL pg_catalog.aclexplode(
  COALESCE(p.proacl, pg_catalog.acldefault('f', p.proowner))
) AS acl
WHERE p.oid = 'public.claim_outbox_messages(text,text,integer,integer,uuid,boolean)'::regprocedure
  AND acl.grantee = 0
  AND acl.privilege_type = 'EXECUTE';
```

- [ ] **Step 2: Confirmar RED**

```bash
npm run test:integration -- tests/integration/outbox-rpcs.test.ts
```

Expected: qualquer grant default ou operação de tabela não coberta aparece na matriz.

- [ ] **Step 3: Revogar cada função imediatamente após sua definição**

Depois de cada `CREATE OR REPLACE FUNCTION ... $$;`, inserir `REVOKE ALL ON FUNCTION` com a assinatura exata da lista, antes da função seguinte. Manter grants service_role no bloco final.

As tabelas recebem:

```sql
REVOKE SELECT, INSERT, UPDATE, DELETE
ON TABLE public.outbox_messages, public.outbox_status_events
FROM PUBLIC, anon, authenticated, service_role;
```

- [ ] **Step 4: Notificar reload do schema depois dos grants**

No final da migration:

```sql
NOTIFY pgrst, 'reload schema';
```

- [ ] **Step 5: Ampliar o quality gate da CI**

Renomear quality para `lint · tsc · corpus · build`, substituir `npm run test:unit` por:

```yaml
      - run: npm test

      - run: npm run build
```

Manter o job integration/Supabase local.

- [ ] **Step 6: Executar GREEN e validar diff**

```bash
npm run test:integration -- tests/integration/outbox-rpcs.test.ts
git diff --check -- supabase/migrations/20260713120000_outbox_messages.sql .github/workflows/ci.yml
```

Expected: integração passa sem whitespace errors.

- [ ] **Step 7: Commitar hardening e CI**

```bash
git add supabase/migrations/20260713120000_outbox_messages.sql tests/integration/outbox-rpcs.test.ts .github/workflows/ci.yml
git commit -m "chore: harden outbox release gates"
```

---

## Lote 4 — Runbook, revisão e verificação

### Task 10: Atualizar runbook e executar verificação transversal final

**Files:**
- Modify: `docs/ops/vps-outbox-sweeper.md`
- Review: todos os arquivos alterados desde `7505a76c16d3fdf35ae61ae0e56122f01c9b9f97`

**Interfaces:**
- Consumes: protocolo, drain, ACLs e CI das Tasks 1–9.
- Produces: procedimento operacional executável sem realizar ação remota.

- [ ] **Step 1: Corrigir instalação atômica e preflight**

Documentar:

```bash
psql -X \
  --set=ON_ERROR_STOP=on \
  --single-transaction \
  --file supabase/migrations/20260713120000_outbox_messages.sql \
  "$DATABASE_URL"
```

Antes, exigir alvo/container/database confirmados, migration ausente, predecessor inbound_work aplicado, backup restaurável com ensaio, roles esperadas, SHA-256 registrado, modo off, geração vazia, allowlist vazia e percent zero.

- [ ] **Step 2: Documentar schema reload e smoke RPC**

Depois da migration, documentar NOTIFY pgrst, restart controlado como fallback e uma chamada service-role/PostgREST para cada assinatura da lista `privilegedRpcs`. O smoke falha em PGRST202/404.

- [ ] **Step 3: Corrigir `progress_after_response`**

Adicionar CTE:

```sql
response_finalized AS (
  SELECT ose.outbox_id, MIN(ose.event_at) AS finalized_at
  FROM e AS ose
  WHERE ose.event_type = 'scope_finalized'
  GROUP BY ose.outbox_id
)
```

Contar:

```sql
(SELECT COUNT(DISTINCT p.id)
 FROM m AS p
 JOIN m AS r ON r.work_id = p.work_id
 JOIN response_finalized AS rf ON rf.outbox_id = r.id
 WHERE p.message_kind = 'progress'
   AND r.message_kind IN ('prompt', 'terminal')
   AND p.accepted_at > rf.finalized_at) AS progress_after_response
```

- [ ] **Step 4: Documentar drain e wrapper do sweeper**

O rollback executa manutenção com p_limit 0 e aguarda:

```sql
SELECT * FROM public.claim_outbox_messages(
  'rollback-maintenance', :'generation', 0, 90, NULL, FALSE
);
```

Depois aguarda:

```sql
SELECT
  COUNT(*) FILTER (WHERE status = 'sending') AS sending,
  COUNT(*) FILTER (
    WHERE status = 'unknown' AND terminal_at IS NULL
  ) AS unreconciled_unknown,
  COUNT(*) FILTER (WHERE lease_token IS NOT NULL) AS residual_leases
FROM public.outbox_messages
WHERE rollout_generation = :'generation';
```

Os três valores devem zerar. O wrapper usa `curl --fail-with-body`, lê JSON e falha se errors ou redactionErrors forem maiores que zero, mesmo com HTTP 200.

Preservar no mesmo bloco de gates contagens explícitas para: conflito de
chave/hash, retry depois de unknown, retry depois de callback failed, lease
presa, aceitação sem WAMID, `missing_terminal_outbox`, demais incidentes de
inbound e in-flight da geração. Todos permanecem zero antes de avançar o
rollout.

- [ ] **Step 5: Corrigir estado pré-migration e relação de timeouts**

Documentar 200 somente para off pristine com PGRST202/42883 reconhecido; 503 para geração conhecida, modo diferente de off ou erro não reconhecido. Registrar timeout HTTP e máximo serverless e exigir unknown reconciliation maior que ambos.

- [ ] **Step 6: Executar verificação completa no SHA final**

Sem paralelizar comandos que compartilham o banco:

```bash
PATH="$HOME/.local/node-v22.22.1/bin:$PATH" npm test
PATH="$HOME/.local/node-v22.22.1/bin:$PATH" npm run test:integration
PATH="$HOME/.local/node-v22.22.1/bin:$PATH" npm run lint
PATH="$HOME/.local/node-v22.22.1/bin:$PATH" npx tsc --noEmit
PATH="$HOME/.local/node-v22.22.1/bin:$PATH" npm run build
git diff --check
```

Expected: testes, integração, TypeScript e build passam; lint tem zero errors e somente warnings preexistentes documentados.

- [ ] **Step 7: Auditar processos, sessões e arquivos protegidos**

```bash
ps -Ao pid,command | rg 'vitest|vite|psql.*outbox' || true
git status --short
git diff --name-only 7505a76c16d3fdf35ae61ae0e56122f01c9b9f97..HEAD
```

Expected: nenhum processo/sessão de teste órfão; três arquivos protegidos untracked e fora dos commits; nenhum lockfile mudou.

- [ ] **Step 8: Fazer revisão transversal independente**

Revisar o range para:

- nenhuma chamada Meta selecionada sem claim/begin e lease;
- nenhum begin/claim concedido depois do fence;
- fallback respeita predecessor sending/unknown;
- shadow suspenso faz zero POST;
- callback failed projeta uma bot_message e rollback é atômico;
- early responses preservam usuário/contexto;
- ACL exata e migration atômica;
- GET cron, corpus e build cobertos;
- runbook não executa ação de produção.

Corrigir Critical/Important com novo RED/GREEN e commit próprio.

- [ ] **Step 9: Commitar documentação final**

```bash
git add docs/ops/vps-outbox-sweeper.md
git commit -m "docs: harden outbox rollout runbook"
```

- [ ] **Step 10: Preparar o handoff**

Registrar SHA final, commits, quantidade exata de arquivos/testes, integração PostgreSQL, lint errors/warnings, TypeScript, build, revisão sem Critical/Important, arquivos protegidos e: “Nenhuma migration, env, cron ou etapa de rollout foi aplicada em produção.” Não fazer push, PR ou merge.
