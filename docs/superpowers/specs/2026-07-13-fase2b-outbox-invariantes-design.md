# Fase 2b — Invariantes transacionais pendentes da outbox

- **Data:** 13/07/2026
- **Status:** Aprovado
- **Branch:** `codex/fase2b-outbox-duravel`
- **Spec-base:** `docs/superpowers/specs/2026-07-13-fase2b-outbox-duravel-design.md`
- **Origem das pendências:** `docs/superpowers/plans/2026-07-13-fase2b-outbox-pendencias.md`

## 1. Objetivo

Fechar as invariantes transacionais ainda pendentes na outbox sem alterar sua
arquitetura aprovada. A correção impede fallback após suspensão de geração,
remove respostas antigas que bloqueiam a resposta final, preserva integralmente
os dados de callbacks e uniformiza a ordem de locks da manutenção.

O trabalho permanece local. A migration da outbox ainda não foi aplicada na VPS,
portanto será corrigida em seu arquivo atual antes do primeiro deploy. Nenhuma
ação de produção, rollout ou alteração de infraestrutura faz parte desta spec.

## 2. Escopo

Esta spec cobre:

- fence de geração em `begin_outbox_fallback_attempt`;
- precedência da suspensão em `enqueue_outbox_message`;
- supersede de emissões anteriores em `finalize_outbox_scope`;
- propagação de `meta_subcode` e redaction atômica de OTP;
- timestamps monotônicos de callbacks;
- religação completa de callbacks órfãos;
- ordem de locks da manutenção executada por `claim_outbox_messages`;
- testes unitários e testes concorrentes com Postgres real dessas invariantes.

Ficam fora do escopo:

- matriz ampla de fault injection e histórias E2E da release;
- correção do gate operacional `progress_after_response`;
- verificação completa de release e smokes;
- aplicação da migration, cron, shadow, canário ou rollout na VPS;
- novos estados, tabelas, workers, dependências ou contratos de produto.

## 3. Restrições

- Preservar os nomes e formatos de retorno dos RPCs existentes.
- Alterar apenas a assinatura de entrada de `apply_outbox_callback`, adicionando
  `p_meta_subcode INTEGER DEFAULT NULL` após `p_meta_code`.
- Adicionar `metaSubcode?: number | null` a `ApplyCallbackInput`.
- Manter todos os RPCs como `SECURITY DEFINER SET search_path = ''`.
- Revogar execução de `PUBLIC`, `anon` e `authenticated`; conceder somente a
  `service_role` pela assinatura exata.
- Manter `service_role` sem acesso direto às tabelas da outbox.
- Não criar branches de fault injection no código de produção.
- Não alterar dependências, lockfile ou `.cursor/settings.json`.

## 4. Arquitetura transacional

### 4.1 Ordem canônica de locks

Os fluxos afetados obedecem à seguinte hierarquia:

```text
geração → chave idempotente, quando aplicável → destinatário, quando aplicável → linha
```

O lock compartilhado de geração permite concorrência normal e serializa o início
do trabalho com o lock exclusivo usado por `suspend_outbox_generation`. O fluxo
normal não adquire lock exclusivo de geração.

Advisory locks de destinatário são tentados antes de qualquer row lock nos fluxos
que podem disputar com enqueue ou finalização. Nenhum fluxo pode manter uma linha
bloqueada enquanto aguarda o lock do destinatário.

### 4.2 Fronteiras preservadas

Não serão criados novos RPCs públicos nem helpers privilegiados. As correções
ficam nas funções existentes, com revalidação explícita após cada lock. Isso
mantém a superfície de segurança e o contrato do repository atuais.

O TypeScript continua acessando a outbox exclusivamente pelo repository. O
callback adapter normaliza dados do webhook, e o Postgres permanece responsável
por correlação, projeção monotônica, redaction e ledger.

## 5. Suspensão de geração e fallback

### 5.1 Início da tentativa direta

`begin_outbox_fallback_attempt` executa a sequência abaixo:

1. lê, sem row lock, a geração imutável da linha indicada;
2. se a linha não existir ou não corresponder à chave, retorna `started=false`;
3. adquire o advisory lock compartilhado da geração;
4. consulta `private.outbox_suspended_generations` dentro da transação;
5. se a geração estiver suspensa, retorna `started=false`, sem lease;
6. adquire o advisory lock da chave idempotente;
7. relê a linha com `FOR UPDATE` e revalida ID, chave, geração, estado, razão,
   tentativa, `provider_message_id` e ausência de lease;
8. somente então cria a lease da tentativa direta e registra
   `fallback_started`.

A geração é relida depois do lock para não confiar na observação inicial. Como
`rollout_generation` faz parte da identidade imutável da linha, uma divergência
na revalidação fecha a tentativa com `started=false`.

Se a geração estiver suspensa, a função não altera a linha e não cria evento ou
lease. O serviço que recebe `started=false` não inicia POST para a Meta.

### 5.2 Precedência no enqueue

`enqueue_outbox_message` mantém separados:

- `v_generation_suspended`, com a razão registrada para a geração;
- `v_fallback_fenced`, com a razão do fence da chave.

Quando ambos forem verdadeiros, a linha nasce `suspended` pela geração. Sua razão
e seu evento de enqueue representam a suspensão da geração, nunca
`enqueue_fallback:*`. Assim, um tombstone criado após rollback não volta a ser
elegível para `begin_outbox_fallback_attempt`.

## 6. Finalização e FIFO

`finalize_outbox_scope` mantém a ordem geração → destinatário → linha e, depois
dos locks, relê e revalida a última emissão do `work_id`.

A finalização:

1. atualiza somente a última emissão com o `message_kind` final e `expires_at`;
2. encontra emissões anteriores do mesmo `work_id` e destinatário, com sequência
   menor que a última;
3. muda para `superseded` todas as anteriores em `pending` ou `retryable`, seja
   qual for o `message_kind`;
4. limpa `next_attempt_at`, define `terminal_at` e grava
   `superseded_by_scope` para cada transição;
5. grava `scope_finalized` somente na última emissão;
6. calcula `response_count` usando apenas linhas `prompt` ou `terminal` cujo
   estado não seja `superseded`.

Linhas anteriores em `sending`, `api_accepted`, `sent`, `delivered`, `read`,
`failed_terminal`, `expired`, `suspended` ou `unknown` não são regressadas nem
reescritas. Se uma resposta anterior já tiver evidência irreversível, ela segue
visível em `response_count`; isso expõe a anomalia em vez de apagar histórico.

O campo `message_kind` de uma linha superseded não precisa ser reclassificado. A
inelegibilidade decorre do estado, e apenas a última linha recebe o evento de
finalização do escopo.

Essa regra garante que uma resposta anterior rejeitada com `429` e deixada em
`retryable` não bloqueie a resposta final até o TTL.

## 7. Callbacks, ledger e privacidade

### 7.1 Subcódigo da Meta

O primeiro erro normalizado do callback percorre todo o fluxo:

```text
WhatsApp error_subcode
  → OutboxCallbackEvent
  → projectOutboxCallback
  → ApplyCallbackInput.metaSubcode
  → p_meta_subcode
  → outbox_status_events.meta_subcode
```

O valor é gravado tanto para callbacks correlacionados quanto para órfãos. Ao
religar um órfão em `record_outbox_attempt_result`, código e subcódigo originais
são repassados à aplicação do callback.

### 7.2 Redaction atômica de OTP

Callbacks `sent`, `delivered` ou `read` constituem prova positiva de aceitação.
Para uma mensagem `otp`, `apply_outbox_callback` executa na mesma transação:

- projeção monotônica do estado;
- atualização dos timestamps;
- `payload_json = NULL`;
- preenchimento idempotente de `payload_redacted_at`;
- append do evento de callback;
- projeção idempotente de `bot_messages`, quando aplicável.

Isso também vale quando o callback chegou primeiro como órfão e foi aplicado ao
persistir o `wamid`. Qualquer erro desfaz conjuntamente ledger, projeção e
redaction.

### 7.3 Timestamps fora de ordem

Para cada evidência implicada por um callback positivo, o timestamp projetado é
o menor entre o valor existente e `p_event_at`:

- `sent` atualiza `accepted_at` e `sent_at`;
- `delivered` atualiza `accepted_at`, `sent_at` e `delivered_at`;
- `read` atualiza `accepted_at`, `sent_at`, `delivered_at` e `read_at`.

Valores nulos recebem o instante do evento. Um callback tardio de menor
precedência pode melhorar o timestamp correspondente, mas nunca reduz o status.
Uma prova positiva posterior a `failed_terminal` pode avançar a projeção conforme
o desenho-base; um callback `failed` nunca cria retry.

## 8. Manutenção concorrente

As quatro rotinas iniciais de `claim_outbox_messages` são afetadas:

- expiração por TTL;
- lease `sending` abandonada para `unknown`;
- limpeza de lease em estado terminal;
- reconciliação terminal de `unknown`.

Cada rotina usa o mesmo padrão:

1. seleciona, sem row lock, uma lista ordenada e limitada de candidatos contendo
   ID e destinatário;
2. mantém os limites existentes, com no máximo 100 candidatos por conjunto;
3. tenta `pg_try_advisory_xact_lock` para o destinatário;
4. se o destinatário estiver ocupado, ignora o candidato até outra execução;
5. busca a linha pelo ID com `FOR UPDATE SKIP LOCKED`;
6. se a linha estiver ocupada, segue para o próximo candidato;
7. revalida geração, `p_outbox_id`, estado e condições temporais com o mesmo
   `v_now` da chamada;
8. aplica a transição e insere seu evento na mesma transação.

O lock compartilhado da geração continua sendo adquirido no início da RPC. Os
advisory locks de destinatário permanecem até o fim da transação, mas seu número
é estritamente limitado pela seleção de candidatos. O uso de `try lock` impede
espera circular e preserva concorrência entre destinatários.

Não serão colocadas chamadas de advisory lock dentro de CTEs como forma de impor
ordem, porque o planner não garante a ordem de avaliação necessária para essa
invariante.

O loop final de claim conserva FIFO, leases independentes, limite de lote e
revalidação depois do lock do destinatário.

## 9. Tratamento de erros e atomicidade

- Resultados recusados por estado ou suspensão retornam os formatos atuais, sem
  lançar erro de infraestrutura.
- Entradas inválidas continuam falhando com `22023`.
- Conflitos de identidade imutável continuam falhando fechados.
- Erros SQL não são capturados dentro dos RPCs; a transação reverte estado e
  ledger conjuntamente.
- Callbacks sem correlação permanecem duravelmente órfãos e podem ser religados.
- Nenhuma falha de callback, resultado `unknown` ou suspensão cria caminho de
  retry novo.

## 10. Segurança

A assinatura exata de `apply_outbox_callback` passa a ser:

```text
(TEXT, TEXT, TIMESTAMPTZ, UUID, INTEGER, INTEGER, TEXT, JSONB)
```

O `REVOKE ALL` e o `GRANT EXECUTE` serão atualizados para essa assinatura.
Testes provarão que:

- `service_role` executa a função;
- `PUBLIC`, `anon` e `authenticated` não a executam;
- nenhum papel de API recebe acesso direto a `outbox_messages` ou
  `outbox_status_events`.

## 11. Estratégia de testes

### 11.1 Unitários

- repository mapeia `metaSubcode` para `p_meta_subcode`;
- callback adapter extrai e encaminha `error_subcode`;
- recusa de `begin_outbox_fallback_attempt` impede chamada ao cliente Meta.

### 11.2 Integração com Postgres real

Os testes cobrem:

1. fallback fence → suspensão → tombstone → `begin` recusado;
2. tombstone → suspensão → `begin` recusado;
3. ausência de lease e de `fallback_started` após a recusa;
4. resposta anterior `retryable` por `429` superseded pela finalização;
5. resposta final imediatamente elegível sem aguardar o TTL anterior;
6. preservação de linhas anteriores `sending` ou aceitas;
7. callback positivo antes do `wamid` com redaction atômica de OTP;
8. preservação de `meta_code` e `meta_subcode` em callback órfão religado;
9. callbacks fora de ordem com estado monotônico e timestamps mínimos;
10. manutenção concorrente com enqueue terminal;
11. manutenção concorrente com `finalize_outbox_scope`;
12. ausência de deadlock, preservação de FIFO e limites;
13. privilégios da nova assinatura da RPC.

Corridas usam clientes Postgres independentes, barreiras ou triggers temporários
criados apenas pelo teste, além de `lock_timeout` e `statement_timeout` curtos.
Os testes não dependem de sleeps probabilísticos e sempre removem objetos
temporários em `finally`.

## 12. Critérios de aceitação

O escopo está concluído quando:

- uma geração já suspensa não inicia fallback nem recebe lease;
- uma razão de fallback nunca mascara a suspensão da geração;
- nenhuma emissão anterior `pending` ou `retryable` bloqueia a resposta final;
- evidência irreversível de envio nunca é apagada ou regredida;
- callbacks preservam código, subcódigo e cronologia;
- OTP é redigido na primeira prova positiva dentro da transação do callback;
- manutenção nunca bloqueia linha antes do lock do destinatário;
- testes unitários focados e `tests/integration/outbox-rpcs.test.ts` passam em
  Postgres real;
- segurança e assinaturas são verificadas;
- nenhuma ação de VPS ou rollout foi executada.
