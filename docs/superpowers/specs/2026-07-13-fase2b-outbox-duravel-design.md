# Fase 2b — Outbox durável e callbacks da Meta (design spec)

**Data:** 13/07/2026
**Status:** Aprovado — implementação em `codex/fase2b-outbox-duravel`
**Roadmap:** `docs/superpowers/plans/2026-07-11-roadmap-bot-inteligente-economico.md`
**Depende de:** Fase 2 e inbound retry fresco, ambos mergeados em `main`
**Próxima sequência:** Fase 3A (domínio atômico) → 3B (contexto CAS) → 3C (constraints e demais escritas)

## 1. Objetivo

Persistir cada mensagem de WhatsApp antes de tentar entregá-la, registrar a evolução observável na Meta e separar conclusão do processamento de entrega externa. A Fase 2b fecha a lacuna entre `inbound_work` e a futura transação de domínio: um retry de entrega nunca pode reexecutar o handler ou repetir uma mutação nutricional.

Esta fase cobre respostas do bot, OTP e lembretes. O alerta de saúde do próprio webhook continua usando envio direto, porque precisa funcionar quando o banco/outbox estiver indisponível.

## 2. Decisões aprovadas

| Tema | Decisão |
|---|---|
| Ordem do roadmap | Implementar 2b antes da Fase 3. |
| Arquitetura | Serviço de outbox compatível com os callers atuais; tentativa inline e sweeper para recuperação. |
| Cobertura | Todas as mensagens destinadas ao usuário: bot, OTP e reminders. Health alert permanece direto. |
| Infraestrutura | Postgres/VPS e Vercel atuais; sem fila paga, nova VPS ou worker permanente. |
| Conclusão do inbound | `inbound_work.committed` quando prompt/terminal estiver duravelmente enfileirado; entrega Meta evolui separadamente. |
| Timeout incerto | Aguardar callback por até 5 minutos; não reenviar automaticamente. |
| Falhas explícitas | Retentar somente allowlist transitória, dentro do TTL. |
| Progresso | Uma tentativa; sem retry; prompt/terminal posterior torna progresso pendente `superseded`. |
| Ordenação | FIFO por destinatário, com bloqueio limitado pelo TTL/reconciliação da cabeça. |
| Retenção | Payload comum redigido 7 dias após terminal; OTP ao `api_accepted` ou expiração. |
| Falha ao enfileirar | Para terminal/prompt após possível mutação: uma tentativa direta, alerta e nenhum replay do handler. |
| Rollout | `off` → `shadow` → allowlist → 10% → 50% → 100%, por geração. |

## 3. Persistência

### 3.1 `outbox_messages`

Projeção atual de uma mensagem lógica. Deve conter:

- identidade UUID e chave idempotente única;
- `provider`, `recipient`, `user_id` opcional e `work_id` opcional;
- `message_kind`: `progress`, `prompt`, `terminal`, `otp` ou `reminder`;
- payload JSON, `payload_hash`, reply/quote e vínculo opcional a recurso;
- sequência monotônica por destinatário;
- modo/geração de rollout;
- status atual, attempts, `next_attempt_at`, lease owner/expiry e `expires_at`;
- `provider_message_id` mais recente, erros normalizados e timestamps de estágio;
- `payload_redacted_at`.

Estados da projeção:

```text
pending
sending
retryable
unknown
api_accepted
sent
delivered
read
failed_terminal
expired
superseded
suspended
```

`unknown` é terminal para retries e libera a fila após a janela de reconciliação, mas callback positivo tardio ainda pode avançar a projeção para `sent`, `delivered` ou `read`.

### 3.2 `outbox_status_events`

Ledger append-only de enqueue, claim, tentativa, resposta HTTP, callback, redaction e suspensão. Cada evento preserva status anterior/novo, attempt, `provider_message_id`, código/erro normalizado e timestamp. Um novo envio após falha explícita pode produzir outro `wamid`; todos permanecem no ledger.

### 3.3 RPCs

As RPCs serão `SECURITY DEFINER`, `search_path` fixado e executáveis somente por `service_role`:

- enqueue idempotente com detecção de conflito chave/hash e sequência por destinatário;
- claim por lease respeitando FIFO, TTL, `next_attempt_at` e geração ativa;
- conclusão de tentativa com transição validada;
- aplicação monotônica de callback por `outbox_id` opaco e fallback por `wamid`;
- listagem limitada do trabalho recuperável;
- suspensão das linhas ativas de uma geração;
- redaction de payloads elegíveis.

Migration apenas aditiva. `processed_messages` e tabelas existentes não serão removidas.

## 4. Runtime e interfaces

O cliente atual será dividido em:

1. cliente Meta de baixo nível: monta o payload, inclui `biz_opaque_callback_data`, executa o POST e devolve resultado tipado;
2. serviço de outbox: enfileira, reivindica, tenta entregar, registra resultado e retorna `wamid | null`;
3. façade `sendTextMessage`: mantém um único ponto para callers, agora com opções semânticas explícitas.

O processamento inbound abre um escopo server-side com `workId`, destinatário e contador de emissão. A chave padrão é `workId + emissionIndex`. Replay devolve a linha existente; mesma chave com outro `payload_hash` é conflito terminal e alerta, nunca overwrite.

Origens sem inbound usam chaves próprias:

- OTP: ID do `auth_code`;
- reminder: usuário + tipo + data/janela local;
- futura Fase 3A: `operation_id + response_version`.

Ao aceitar uma mensagem, o `wamid` é gravado e seu vínculo em `bot_messages` é criado com os metadados de recurso da outbox. O parser do webhook passa a enumerar `messages[]` e `statuses[]` no mesmo payload. Callback correlaciona primeiro por `biz_opaque_callback_data = outbox_id` e depois pelo `wamid`.

Se o handler terminar com progresso enfileirado, mas sem prompt/terminal, o inbound recebe `missing_terminal_outbox` e gera alerta. Falha de entrega não reabre nem repete domínio.

## 5. Falhas, TTL e ordenação

Backoff nominal, drenado pelo cron VPS a cada minuto:

```text
1 min → 2 min → 5 min → 5 min
```

Máximo geral de cinco tentativas:

- `progress`: uma tentativa imediata, sem retry;
- `otp`: três tentativas no máximo, sempre antes do vencimento de 5 minutos;
- `prompt`: até `conversation_context.expires_at`; default 10 minutos sem vínculo;
- `terminal`: 15 minutos;
- `reminder`: 15 minutos.

Respostas HTTP/códigos Meta explicitamente transitórios viram `retryable`. Configuração, autorização, payload inválido, janela encerrada e códigos permanentes viram `failed_terminal`. Timeout ou socket encerrado depois do início do POST vira `unknown`; o sistema aguarda callback por até 5 minutos e não faz retry automático.

Callbacks são preservados mesmo fora de ordem, mas a projeção é monotônica: `read` implica `delivered` e `sent`; `delivered` implica `sent`; evento tardio de menor precedência não regride o estado. Callback `failed` recebido depois de `api_accepted` é terminal, gera alerta e nunca cria retry automático, pois a aceitação já liberou a próxima mensagem no FIFO. Apenas rejeições síncronas comprovadamente anteriores a `api_accepted` podem entrar em `retryable`. OTP redigido após aceitação não é retentado; o usuário solicita novo código.

A fila usa sequência por destinatário. Uma cabeça ativa bloqueia posteriores; `failed_terminal`, `expired`, `superseded`, `suspended` ou `unknown` reconciliado libera a próxima.

## 6. Callers e compatibilidade

- Bot: classificar cada emissão como progress, prompt ou terminal; carregar vínculo de recurso na própria outbox.
- OTP: enfileirar com ID do código, TTL de 5 minutos e redaction antecipada.
- Reminders: chave por janela; marcar geração lógica no enqueue, não depois do POST.
- Health check: chamar explicitamente o cliente Meta direto.
- `bot_messages`: outgoing é criado quando houver `wamid`; incoming continua persistido pelo fluxo atual.

`OUTBOX_MODE=off` preserva o caminho direto. `shadow` grava ledger e usa correlação opaca, mas o caminho direto permanece autoritativo e o sweeper não envia linhas shadow. `active` torna a outbox autoritativa para recipients elegíveis pelo canário.

## 7. Rollout e rollback

Novas configurações:

```text
OUTBOX_MODE=off|shadow|active
OUTBOX_GENERATION=<identificador não vazio>
OUTBOX_CANARY_PHONES=<lista E.164 opcional>
OUTBOX_CANARY_PERCENT=<0..100>
```

Sequência:

1. merge/deploy com `OUTBOX_MODE=off`;
2. aplicar migration no Postgres da VPS e validar grants/RPCs;
3. shadow por 24 horas e pelo menos 20 envios;
4. active na allowlist interna;
5. 10%, 50% e 100%, com 24 horas por degrau.

Gates de avanço:

- zero conflito de chave/hash;
- zero retry de `unknown`;
- zero progresso entregue após terminal;
- zero lease além da janela;
- toda aceitação Meta com `wamid` correlacionado;
- taxa de `unknown`/`failed` não piora o baseline.

Rollback altera modo para `off` e executa a RPC de suspensão para a geração ativa. Reativação usa nova geração; linhas antigas nunca voltam a enviar. Migration e ledger permanecem para auditoria.

## 8. Testes de aceitação

- Unit: hashing/idempotência, classificação de erro, TTL/backoff, transições monotônicas, redaction, supersede e parser combinado.
- Postgres real: concorrência de enqueue/claim, FIFO, leases, callbacks fora de ordem, múltiplos `wamid`, suspensão e cleanup.
- E2E/MSW: webhook assinado → handler → outbox → Meta → callback; replay sem duplicação; 429, erro permanente, timeout, OTP, reminder e progresso.
- Fault injection: crash após enqueue, após aceitação, antes de persistir `wamid`, após callback e durante falha do insert da outbox.
- Gates finais: suíte unit/corpus, integração, lint, `tsc --noEmit`, build e smokes manuais de texto, áudio, imagem, OTP e reminder.

## 9. Fora de escopo

- `domain_operations` e identidade de item;
- transação nutricional atômica;
- contexto versionado/CAS;
- constraints gerais de usuários/settings;
- remoção de `processed_messages`;
- upgrade da versão Graph API;
- nova infraestrutura permanente.
