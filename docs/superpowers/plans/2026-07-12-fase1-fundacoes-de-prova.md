# Fase 1 — Fundações de prova (plano de implementação)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Infraestrutura de prova para as Fases 2–8: Postgres real local, E2E in-process do webhook, esqueleto de golden corpus, `tsc` limpo e CI em PRs — sem alterar código de produção.

**Architecture:** Supabase CLI local (Colima) expõe Postgres + PostgREST; testes de integração usam `createServiceRoleClient()` real; E2E importa o route handler com HMAC verdadeiro e MSW para Meta; corpus versionado sem runner de LLM.

**Tech Stack:** Vitest, MSW, Supabase CLI, GitHub Actions, TypeScript strict.

**Roadmap:** [2026-07-11-roadmap-bot-inteligente-economico.md](2026-07-11-roadmap-bot-inteligente-economico.md) · **Spec:** [2026-07-12-fase1-fundacoes-de-prova-design.md](../specs/2026-07-12-fase1-fundacoes-de-prova-design.md) · **Branch:** `fix/fase1-fundacoes-de-prova`

**Achados:** COST-18, lacuna `tests/integration/`, lacuna E2E real, 10 erros `tsc` · **Invariantes:** INV-30, rastreabilidade §15.9

**Regra operacional:** antes de `npm run test:integration`, ligar Colima + Supabase; ao terminar, desligar (`.cursor/rules/testes-supabase-colima.mdc`).

---

## Decisões de produto (defaults)

| Decisão | Default |
|---|---|
| Banco de teste | Supabase local apenas; guard recusa URL não-localhost |
| E2E webhook | In-process Vitest; sem Playwright nesta fase |
| LLM no smoke E2E | Mock pontual do provider/classifier **somente no teste** se necessário para determinismo; Supabase nunca mockado no E2E |
| Corpus | JSON versionado; runner de LLM adiado para Fase 7 |
| CI | PR → lint + tsc + unit + integration; sem secrets de produção |
| Código de produção | Zero alterações em `src/` e `supabase/migrations/` |

---

## File Structure

```
vitest.config.ts                         [MODIFY] node env + setup integration
package.json                             [MODIFY] scripts test:integration se necessário
.env.test.example                        [CREATE] template chaves locais
tests/integration/
  setup.ts                               [CREATE] guard localhost + env
  helpers/
    supabase-local.ts                    [CREATE] client + assertLocalSupabaseUrl
    db-reset.ts                          [CREATE] truncate tabelas de domínio
    webhook-request.ts                   [CREATE] buildSignedWebhookRequest
  db/
    find-or-create-meal.test.ts          [CREATE] RPC real
    processed-messages.test.ts           [CREATE] UNIQUE message_id
  webhook/
    webhook-e2e.test.ts                  [CREATE] smoke + batch + dedup
tests/corpus/
  README.md                              [CREATE]
  schema.json                            [CREATE]
  cases/
    meal_log_banana_simples.json         [CREATE]
    help_menu.json                       [CREATE]
    dedup_same_message_id.json           [CREATE]
tests/mocks/handlers.ts                  [MODIFY] opcional: capturar body enviado à Meta
tests/unit/**                            [MODIFY] fixtures tsc (Task 1)
.github/workflows/ci.yml                 [CREATE]
docs/superpowers/plans/2026-07-11-roadmap-bot-inteligente-economico.md [MODIFY] status Fase 1
```

---

### Task 0: Pré-requisitos locais

- [ ] `colima start` e `supabase start` funcionam no Mac do desenvolvedor
- [ ] `supabase status` retorna API URL, anon key e service_role key
- [ ] Copiar `.env.test.example` → `.env.test.local` com valores do `supabase status`
- [ ] Documentar no README do corpus ou em `.env.test.example` que `.env.test.local` não vai para o git

---

### Task 1: Zerar erros `tsc --noEmit`

- [ ] Rodar `npx tsc --noEmit` e listar os 10 erros (fixtures `MealItem`, `nutrition_basis_*`, etc.)
- [ ] Criar helper de fixture compartilhado se reduzir duplicação (ex.: `tests/helpers/meal-item-fixture.ts`)
- [ ] Corrigir cada arquivo de teste afetado **sem** alterar `src/`
- [ ] Gate: `npx tsc --noEmit` → 0 erros

**Arquivos prováveis:** `tests/unit/bot/meal-log.test.ts`, `tests/unit/bot/meal-response.test.ts`, `tests/unit/products/classify.test.ts`, outros apontados pelo `tsc`.

---

### Task 2: Config Vitest para integração

- [ ] Teste smoke: arquivo placeholder em `tests/integration/setup.test.ts` que só verifica `assertLocalSupabaseUrl()`
- [ ] Em `vitest.config.ts`: `environmentMatchGlobs` → `[['tests/integration/**', 'node']]`
- [ ] `setupFiles`: adicionar `./tests/integration/setup.ts` apenas para integration (via project Vitest ou condicional)
- [ ] Desabilitar paralelismo para integration (`poolOptions.threads.singleThread: true` no project integration ou global para pasta)
- [ ] Gate: `npm run test:integration` encontra a pasta (mesmo com 0 testes reais ainda)

---

### Task 3: Harness Postgres — helpers

- [ ] `assertLocalSupabaseUrl()`: aceita `localhost`, `127.0.0.1`, `host.docker.internal`; rejeita qualquer outro host com mensagem clara
- [ ] `getIntegrationSupabase()`: usa `createServiceRoleClient()` com env de teste
- [ ] `resetIntegrationDb()`: `TRUNCATE` tabelas (`users`, `meals`, `meal_items`, `processed_messages`, `conversation_state`, `user_settings`, …) com `RESTART IDENTITY CASCADE`
- [ ] Teste: após reset, `processed_messages` e `meals` vazias

---

### Task 4: Teste de integração — `find_or_create_meal`

- [ ] RED: `tests/integration/db/find-or-create-meal.test.ts`
  - Cria usuário fixture
  - Chama RPC `find_or_create_meal` duas vezes com mesmo `(user, day, meal_type)` → segunda retorna `was_append: true` e mesmo `meal_id`
  - Terceira chamada com `meal_type` diferente → novo `meal_id`, `was_append: false`
- [ ] GREEN: implementação já existe na migration `20260530120000_atomic_find_or_create_meal.sql` — só o teste é novo
- [ ] `beforeEach`: `resetIntegrationDb()` + seed mínimo de usuário

---

### Task 5: Teste de integração — `processed_messages`

- [ ] RED: `tests/integration/db/processed-messages.test.ts`
  - Insert `message_id` → sucesso
  - Insert duplicado → erro de constraint (ou comportamento idempotente documentado se usar `ON CONFLICT`)
- [ ] GREEN: alinhar assert ao comportamento real da tabela (`PRIMARY KEY` em `message_id`)
- [ ] Referência: `supabase/migrations/00004_create_supporting_tables.sql`

---

### Task 6: E2E in-process do webhook

- [ ] `tests/integration/helpers/webhook-request.ts`: monta payload Meta + `X-Hub-Signature-256` com `signWebhookBody` / `createHmac`
- [ ] Estender `tests/mocks/handlers.ts` para expor último body POST à Meta (array ou callback) — facilita assert
- [ ] RED: `tests/integration/webhook/webhook-e2e.test.ts`
  - **Smoke:** POST assinado com mensagem simples → `200`; linha em `processed_messages`; Meta mock recebeu POST
  - **Batch:** payload com 2 `message_id` → 2 linhas em `processed_messages`
  - **Dedup:** mesmo `message_id` duas vezes → segunda não duplica efeito colateral indevido
- [ ] Se smoke depender de LLM: `vi.mock` pontual de `@/lib/llm/...` ou classifier **apenas neste arquivo**; documentar no topo do teste
- [ ] `beforeEach`: `resetIntegrationDb()`; `server.listen()` MSW; `afterEach`: `server.resetHandlers()`
- [ ] Gate: 3 describes verdes com Supabase local rodando

**Nota:** reutilizar padrões de `tests/unit/webhook/route.test.ts` para montagem de payload, mas **sem** mock de `@/lib/db/supabase`.

---

### Task 7: Golden corpus (COST-18)

- [ ] Criar `tests/corpus/schema.json` (JSON Schema do formato de caso)
- [ ] Criar `tests/corpus/README.md` com: campos obrigatórios, como adicionar caso, que runner vem na Fase 7
- [ ] Adicionar 3 casos em `tests/corpus/cases/`:
  - `meal_log_banana_simples.json`
  - `help_menu.json`
  - `dedup_same_message_id.json`
- [ ] Teste leve: validar que cada JSON parseia e respeita campos mínimos (sem executar bot)

---

### Task 8: GitHub Actions

- [ ] Criar `.github/workflows/ci.yml`
- [ ] Job `quality`: `npm ci`, `npm run lint`, `npx tsc --noEmit`, `npm run test:unit`
- [ ] Job `integration`:
  - `supabase/setup-cli@v1`
  - `supabase start`
  - Exportar env do `supabase status` + secrets de teste (`META_APP_SECRET`, `WHATSAPP_PHONE_NUMBER_ID`, `WHATSAPP_VERIFY_TOKEN`, etc.)
  - `npm run test:integration`
- [ ] Trigger: `pull_request` para `main`
- [ ] Gate: workflow verde no PR da Fase 1

---

### Task 9: Finalização

- [ ] `npm test` verde · `npm run lint` 0 erros · `tsc` 0 erros
- [ ] `npm run test:integration` verde local (Colima + Supabase ligados)
- [ ] Atualizar status Fase 1 no roadmap → plano em execução / DONE após merge
- [ ] PR `fix/fase1-fundacoes-de-prova` · merge pelo Otávio

---

## Gates de aceitação (Fase 1)

- `npx tsc --noEmit` — 0 erros
- ≥1 teste de integração DB verde (`find_or_create_meal` ou `processed_messages`)
- ≥1 smoke E2E webhook verde (handler → Postgres real → Meta mock)
- Template de corpus em `tests/corpus/` com ≥2 casos versionados
- CI em PR com jobs `quality` + `integration` verdes
- Nenhuma migration nova; nenhuma alteração em `src/`

---

## Ordem sugerida de execução

```text
Task 0 (pré-req) → Task 1 (tsc) → Task 2 (vitest config)
  → Task 3 (helpers) → Task 4 + 5 (DB tests) → Task 6 (E2E)
  → Task 7 (corpus) → Task 8 (CI) → Task 9 (finalização)
```

Tasks 4 e 5 podem rodar em paralelo após Task 3. Task 7 pode começar em paralelo com Task 6.

---

## Referências

- Fase 0 (padrão de plano): [2026-07-11-fase0-perimetro.md](2026-07-11-fase0-perimetro.md)
- Auditoria §15.2 (tipos de prova): [2026-07-11-auditoria-conversacional-e-registro-alimentos.md](../specs/2026-07-11-auditoria-conversacional-e-registro-alimentos.md)
- Regra Colima/Supabase: `.cursor/rules/testes-supabase-colima.mdc`
