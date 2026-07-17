# Fase 2b — Tudo que ainda falta

## Estado atual

- Branch: `codex/fase2b-outbox-duravel`.
- Plano corretivo registrado em `a39d6f1`.
- Primeiro lote corretivo concluído em `8a50d21`.
- Já corrigido:
  - fallback separado por modo e fonte;
  - OTP/reminder podem usar o fallback one-shot sem fence de inbound;
  - bot prompt/terminal exige fence de replay antes do fallback;
  - progresso falha fechado e nunca usa fallback direto;
  - `shadow` mantém o envio direto autoritativo quando o enqueue falha;
  - callbacks são tolerados antes da migration somente em `off`, sem geração e com RPC comprovadamente ausente;
  - sweeper distingue resultado processado de resultado não persistido;
  - `source` omitido é normalizado como `bot` antes das decisões de segurança.
- Verificação desse lote:
  - 1.387 testes unitários passando;
  - TypeScript passando;
  - ESLint passando;
  - revisão independente sem achados abertos.
- Nada foi aplicado na VPS ou ativado em produção.

## 1. Corrigir as invariantes do Postgres

### 1.1 Impedir fallback depois da suspensão da geração

Arquivos principais:

- `supabase/migrations/20260713120000_outbox_messages.sql`
- `tests/integration/outbox-rpcs.test.ts`

Trabalho necessário:

- Fazer `begin_outbox_fallback_attempt` descobrir a geração da linha e adquirir o advisory lock compartilhado da geração antes do lock da chave e da linha.
- Consultar `private.outbox_suspended_generations` dentro da mesma transação.
- Retornar `started=false`, sem lease, quando a geração estiver suspensa.
- Em `enqueue_outbox_message`, dar precedência à razão de suspensão da geração sobre `enqueue_fallback:*`.
- Garantir que uma linha criada depois do rollback não possa recuperar uma razão de fallback que permita POST.
- Garantir que um crash nesse caminho não deixe lease permanente numa geração suspensa.

Testes obrigatórios:

- fallback fence → suspensão da geração → enqueue do tombstone → `begin` recusado;
- tombstone → suspensão da geração → `begin` recusado;
- nenhuma chamada Meta após suspensão;
- nenhuma lease residual.

### 1.2 Evitar bloqueio por múltiplas respostas não-progress

Arquivos principais:

- `supabase/migrations/20260713120000_outbox_messages.sql`
- `tests/integration/outbox-rpcs.test.ts`

Trabalho necessário:

- Em `finalize_outbox_scope`, superseder todas as emissões anteriores do mesmo `work_id` que estejam `pending` ou `retryable`, não apenas mensagens `progress`.
- Preservar linhas `sending`, aceitas ou com callbacks, sem regressão de estado.
- Finalizar somente a última resposta como `prompt` ou `terminal`.
- Fazer `response_count` considerar apenas respostas não superseded.
- Provar que uma resposta anterior com `429` não fica inelegível ao sweeper bloqueando a resposta final até a expiração.

### 1.3 Corrigir redaction e dados dos callbacks

Arquivos principais:

- `supabase/migrations/20260713120000_outbox_messages.sql`
- `src/lib/outbox/repository.ts`
- `src/lib/outbox/callbacks.ts`
- `tests/unit/outbox/repository.test.ts`
- `tests/unit/outbox/callbacks.test.ts`
- `tests/integration/outbox-rpcs.test.ts`

Trabalho necessário:

- Adicionar `metaSubcode?: number | null` a `ApplyCallbackInput`.
- Adicionar `p_meta_subcode INTEGER DEFAULT NULL` à RPC `apply_outbox_callback`.
- Atualizar a assinatura exata usada em `REVOKE` e `GRANT EXECUTE`.
- Propagar `error_subcode` do parser até `outbox_status_events.meta_subcode`.
- Propagar `meta_subcode` ao religar callbacks órfãos.
- Quando callback `sent`, `delivered` ou `read` comprovar aceitação de OTP:
  - apagar `payload_json` na mesma transação;
  - preencher `payload_redacted_at` na mesma transação.
- Para callbacks fora de ordem, usar o instante mais antigo conhecido em `accepted_at`, `sent_at`, `delivered_at` e `read_at`, sem regredir o status.

Testes obrigatórios:

- callback positivo antes da persistência do `wamid` redige o OTP atomicamente;
- callback com `error_subcode` preserva o valor no ledger;
- callbacks fora de ordem mantêm status monotônico e timestamps corretos;
- callback órfão religado preserva código e subcódigo.

### 1.4 Uniformizar a ordem dos locks da manutenção

Arquivo principal:

- `supabase/migrations/20260713120000_outbox_messages.sql`

Problema restante:

- A manutenção inicial de `claim_outbox_messages` pode bloquear uma linha antes de adquirir o advisory lock do destinatário, enquanto enqueue e finalização usam destinatário antes da linha.

Trabalho necessário:

- Fazer expiry, stale lease, terminal lease cleanup e reconciliação de `unknown` adquirirem o lock do destinatário antes do lock/update da linha.
- Manter processamento limitado, `SKIP LOCKED` e leases independentes.
- Não trocar por um lock exclusivo da geração que serialize todos os envios inline.

Testes obrigatórios:

- manutenção concorrente com enqueue terminal;
- manutenção concorrente com `finalize_outbox_scope`;
- ausência de deadlock e preservação do FIFO.

## 2. Completar a matriz de testes prometida

Arquivos principais:

- `tests/unit/outbox/fault-injection.test.ts`
- `tests/integration/outbox-rpcs.test.ts`
- `tests/integration/webhook/webhook-e2e.test.ts`

Histórias que precisam ficar executáveis:

- webhook assinado → enqueue → POST Meta → `api_accepted` → callback → replay sem duplicação;
- rejeição `429` com backoff correto;
- rejeição permanente sem retry;
- timeout/socket depois do início do POST virando `unknown`, sem novo POST;
- OTP com chave pelo `auth_code.id`, limite de três tentativas e redaction;
- reminder com chave por usuário, tipo e janela local;
- progresso com uma tentativa e supersede pela resposta final.

Fault injection que precisa ficar explícito:

1. crash depois do enqueue e antes do POST;
2. crash depois da aceitação Meta e antes de persistir o `wamid`;
3. falha dentro da transação de callback antes de concluir a projeção, provando rollback conjunto de ledger e estado;
4. resultado ambíguo do enqueue depois de possível mutação de domínio;
5. crash durante lease do sweeper, seguido de `unknown` sem reenvio.

Regras dos testes:

- não adicionar branches de fault injection ao código de produção;
- usar Postgres real para concorrência, locks, leases e atomicidade;
- usar MSW para HTTP Meta;
- provar quantidade de POSTs, não apenas estado final;
- provar correlação por `biz_opaque_callback_data` e fallback por `wamid` histórico.

## 3. Corrigir observabilidade e runbook

Arquivo:

- `docs/ops/vps-outbox-sweeper.md`

Trabalho necessário:

- Corrigir o gate `progress_after_response`.
- Comparar `progress.accepted_at` com o instante do evento `scope_finalized` da resposta final.
- Incluir respostas finais ainda sem `accepted_at`.
- Manter gates para:
  - conflito chave/hash;
  - retry depois de `unknown`;
  - retry depois de callback `failed`;
  - progresso aceito depois da resposta final;
  - lease presa;
  - aceitação sem `wamid` correlacionável;
  - `missing_terminal_outbox` e demais incidentes de inbound.

## 4. Fazer revisão completa após as correções

Revisar especificamente:

- nenhuma geração suspensa consegue iniciar claim ou fallback;
- nenhum caminho de `unknown` cria retry;
- callback `failed` após aceitação nunca cria retry;
- shadow continua permanentemente não claimable;
- OTP é redigido na primeira prova positiva de aceitação;
- todo `wamid` fica preservado no ledger;
- nenhuma resposta anterior bloqueia a terminal final;
- nenhum RPC ganhou acesso para `PUBLIC`, `anon` ou `authenticated`;
- `service_role` continua sem acesso direto às tabelas;
- todas as funções privilegiadas continuam com `SET search_path = ''`;
- `.cursor/settings.json` continua intocado e untracked;
- nenhuma dependência ou lockfile foi alterado.

CodeRabbit:

- A CLI está instalada, mas atualmente sem autenticação.
- Autenticar e rodar CodeRabbit é desejável, mas não substitui os testes nem deve bloquear a revisão independente local.

## 5. Executar a verificação automatizada completa

Comandos obrigatórios:

```bash
npm test
npm run test:integration
npm run lint
npx tsc --noEmit
npm run build
```

Registrar no fechamento:

- quantidade exata de arquivos e testes unitários;
- quantidade exata de integrações em Postgres real;
- erros e warnings do ESLint;
- resultado do TypeScript;
- resultado do build;
- warnings preexistentes separados de regressões novas.

Não considerar a fase concluída se algum comando obrigatório não tiver sido executado ou estiver falhando.

## 6. Commitar e aguardar revisão do usuário

Commits ainda esperados:

- correção das invariantes e corridas do banco;
- fechamento dos testes de falha e do runbook;
- eventuais correções decorrentes da revisão final.

Antes de encerrar:

- conferir `git diff --check`;
- conferir `git status --short`;
- excluir dos commits qualquer artefato local ou cache;
- não fazer push, PR ou merge sem solicitação;
- apresentar os commits e aguardar a revisão do usuário.

## 7. Ações operacionais que continuam separadas

Estas ações não devem ser executadas durante a correção local sem autorização explícita:

1. Deploy do código com `OUTBOX_MODE=off`.
2. Aplicação da migration na VPS.
3. Verificação real dos grants e RPCs na VPS.
4. Instalação/configuração do cron autenticado de um minuto.
5. Smokes reais em `off`:
   - texto;
   - áudio;
   - imagem;
   - OTP;
   - reminder;
   - health alert.
6. Execução de `shadow` por pelo menos 24 horas e 20 envios.
7. Avaliação de todos os gates sem piora do baseline.
8. Ativação da allowlist interna.
9. Rollout determinístico em 10%, 50% e 100%, com 24 horas por degrau.
10. Smoke em `active` para destinatário allowlisted.
11. Teste operacional do rollback:
    - mudar para `off`;
    - suspender a geração via RPC;
    - provar que nenhum claim ou fallback envia;
    - reativar somente com uma nova geração.

## Critério final de conclusão

A Fase 2b só estará pronta para revisão final quando:

- todas as correções das seções 1 a 3 estiverem implementadas;
- toda a matriz da seção 2 estiver passando;
- a revisão da seção 4 não tiver achados Critical ou Important;
- todos os comandos da seção 5 passarem;
- os commits locais estiverem limpos e sem arquivos estranhos;
- a migration e a ativação em produção continuarem pendentes de autorização explícita.

## 8. Observações pós-review PR #24 (planejar na próxima fase)

Fonte: review Codex + CodeRabbit CLI em `codex/fase2b-outbox-duravel` (2026-07-17).
Nesta PR foi corrigido apenas o P2 do Codex (`attemptResultPersisted` em `scope.ts`).
Os itens abaixo ficaram de fora de propósito — avaliar e planejar ao iniciar a próxima fase.

### Código / dados (alta prioridade ao planejar)

1. **UNIQUE em `provider_message_id` + validação no callback** (CodeRabbit major)
   - `supabase/migrations/20260713120000_outbox_messages.sql`
   - Índice atual não é único; `apply_outbox_callback` confia em `p_outbox_id` mesmo se o WAMID da row divergir.
   - Plano: `UNIQUE` parcial + checagem `provider_message_id IS NULL OR = p_provider_message_id` no `FOR UPDATE`.

2. **Identidade de rollout na idempotência** (CodeRabbit major)
   - Em `enqueue_outbox_message`, conflito de chave só compara payload/recipient/provider/business.
   - Incluir `rollout_mode`, `rollout_generation` e `message_kind` no `idempotency_conflict` para não reaproveitar row antiga após rollback.

3. **`retryable` exige `nextAttemptAt`** (CodeRabbit major)
   - Tipagem em `RecordAttemptInput` permite `retryable` sem schedule; service já costuma passar, mas o tipo não força.
   - Plano: union discriminada + validação runtime em `recordOutboxAttemptResult`.

### Produto (escopo separado do outbox)

4. **`registerFromQuotedQuery` sem meal ID** (CodeRabbit minor)
   - `handler.ts` grava `resourceType: 'meal'` com `resourceId: null` no fluxo de quote→registro.
   - `registerFromQuotedQuery` hoje retorna só `string`; precisa passar a devolver o `mealId` e propagar em `sendTextMessageWithResource` / `saveBotMessages`.
   - Bug de quote/resource lookup — planejar fora do núcleo do outbox.

### Docs / ops (alinhar runbook e specs)

5. **Não documentar migration com `DATABASE_URL` na CLI** — usar PGSERVICE/PGPASSFILE (plan post-review).
6. **Conflito de contrato FIFO** — spec duraável vs runbook (release só após `terminal_at` na manutenção).
7. **Bloco de migration mutante no runbook** — self-contained com assert de target antes do DDL.
8. **Ordem de locks no design de invariantes** — documentar recipient advisory lock antes do `FOR UPDATE` da row.
9. **Superseder regra legacy de shadow direct-send** no plan de corrections (exige `begin_outbox_fallback_attempt`).

### Testes (higiene, baixa prioridade)

10. Mocks de `recordAttempt` em `service.test.ts` devem espelhar o outcome sob teste (`failed_terminal` / `unknown`).
11. Mocks de `beginFallback` / `recordAttempt` em `fault-injection.test.ts` devem usar `sending` / `api_accepted`, não `suspended`.
