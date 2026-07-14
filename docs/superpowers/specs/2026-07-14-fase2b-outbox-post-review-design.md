# Fase 2b — Correções pós-revisão do outbox

Data: 2026-07-14

Status: aprovado para implementação

Branch: codex/fase2b-outbox-duravel

Base da revisão: 7505a76c16d3fdf35ae61ae0e56122f01c9b9f97

Head revisado: c871a478bfd5d4624de201cd36f788e9a218940f

## 1. Contexto

A implementação da Fase 2b passou pelos quatro lotes de correção das
invariantes locais, mas a revisão transversal da branch encontrou blockers que
atravessam o transporte HTTP, o fallback direto, o rollback de geração, a
projeção de callbacks e o procedimento de release.

As correções desta spec acontecem antes da primeira aplicação da migration
20260713120000_outbox_messages.sql na VPS. A migration continua editável
in-place. Nenhuma ação de produção, rollout, cron ou migration remota faz parte
deste trabalho.

## 2. Objetivos

O trabalho deve:

- impedir perda de mensagem quando uma rejeição HTTP comprovada possui body
  ilegível;
- colocar shadow e fallback sob uma autorização durável anterior ao POST;
- integrar o fallback ativo ao FIFO e à reconciliação de unknown;
- definir rollback como fence contra novos starts seguido de drain explícito;
- impedir envio shadow quando a geração já estiver cercada;
- preservar usuário e contexto nas respostas antecipadas do handler;
- projetar bot_messages também quando o primeiro callback correlacionado for
  failed;
- tornar migration, schema reload e gates operacionais seguros;
- fechar a matriz obrigatória de fault injection, concorrência, privilégios,
  OTP e reminders;
- garantir que CI e verificação local cubram corpus, integração, lint,
  TypeScript e build.

## 3. Não objetivos

Continuam fora do escopo:

- aplicar a migration na VPS;
- alterar variáveis de produção;
- instalar ou ativar cron real;
- iniciar shadow, canário ou rollout active;
- fazer push, abrir PR ou merge;
- criar dependência nova;
- adicionar branches de fault injection ao runtime;
- mudar o comportamento do modo off ou de destinatários active não
  selecionados.

## 4. Alternativas consideradas

### 4.1 Escolhida: start durável e drain explícito

Claim ou begin com lease representa o início oficial de uma tentativa de
transporte. A suspensão instala um fence que impede novas autorizações, mas não
finge cancelar tentativas já iniciadas. O rollback só termina quando o drain
prova ausência de sending, unknown não reconciliado e leases residuais.

O fallback usa a mesma máquina de estados da entrega normal. Quando não puder
iniciar imediatamente por causa do FIFO, a mensagem permanece durável para o
sweeper.

Esta opção corrige os blockers sem criar tabela, worker ou lifecycle público
novo.

### 4.2 Rejeitada: lifecycle de geração active, draining e suspended

Uma tabela adicional de lifecycle e RPCs de tokens de transporte tornariam o
estado de drain explícito no banco. A solução é mais formal, mas amplia schema,
contratos, operação e testes sem eliminar a necessidade de definir o instante
de início entre banco e HTTP.

### 4.3 Rejeitada: remover fallback direto

Desabilitar todo fallback simplificaria FIFO e rollback, mas reduziria a
disponibilidade de OTP e reminder e abandonaria um requisito já aprovado do
produto.

## 5. Definições e invariantes

### 5.1 Start de transporte

Um transporte da geração começa quando o banco concede uma lease durável para
a tentativa. O POST HTTP ocorre somente depois desse start.

Os caminhos cobertos são:

- active inline: claim_outbox_messages;
- active sweeper: claim_outbox_messages;
- shadow: begin_outbox_fallback_attempt generalizado como gate direto;
- fallback active ou shadow: o mesmo gate direto.

Modo off e active não selecionado continuam usando o transporte direto legado
e não pertencem a uma geração durável.

### 5.2 Suspensão

suspend_outbox_generation instala o fence exclusivo da geração. Depois do
commit desse fence:

- nenhum claim novo pode ser concedido;
- nenhum begin direto novo pode ser concedido;
- nenhum enqueue suspenso pode ser enviado;
- tentativas que já possuem lease permanecem observáveis como in-flight;
- a suspensão não apaga a lease de uma tentativa ainda em sending.

### 5.3 Drain completo

Uma geração cercada só é considerada completamente parada quando uma consulta
operacional provar zero para:

- status sending;
- status unknown com terminal_at nulo;
- qualquer lease_token residual.

O intervalo de reconciliação de unknown deve continuar maior que o timeout
máximo do HTTP e da execução serverless. A release deve verificar essa relação.

### 5.4 Lock hierarchy

Todo fluxo afetado segue:

geração → chave idempotente quando aplicável → destinatário quando aplicável → linha

Nenhum fluxo pode bloquear uma linha e depois tentar adquirir o lock de
destinatário.

## 6. Protocolo unificado de envio

### 6.1 Active normal

O fluxo normal continua:

1. enqueue durável;
2. claim da linha com lease;
3. POST Meta;
4. record_outbox_attempt_result;
5. callback e projeção posteriores.

Claim é o start da tentativa. Uma suspensão concorrente posterior preserva a
linha sending até o resultado ou até a manutenção transformá-la em unknown.

### 6.2 Shadow

Shadow deixa de chamar Meta apenas com base em wasInserted.

Depois do enqueue, o serviço chama begin_outbox_fallback_attempt usando o
outbox_id e a chave. A RPC reconhece uma linha shadow pending, verifica o fence
da geração, adquire lease e muda a linha para sending antes do POST.

Regras:

- uma linha shadow criada como suspended nunca chama Meta;
- uma linha shadow já resolvida nunca é reenviada;
- falha conhecida termina em failed_terminal;
- resultado ambíguo termina em unknown;
- shadow permanece não claimable pelo sweeper;
- falha ambígua do enqueue shadow segue a recuperação por fence e tombstone
  descrita na seção 6.3, nunca o POST direto legado;
- se enqueue ou begin não puderem estabelecer autorização durável, shadow
  falha fechado em vez de enviar sem fence.

### 6.3 Recuperação após enqueue ambíguo

fence_outbox_fallback passa a adquirir:

1. shared lock da geração;
2. lock da chave;
3. lock do destinatário;
4. row lock, se houver linha.

A RPC consulta a suspensão dentro da mesma transação. Ela pode registrar o
fence idempotente, mas nunca retorna safe_for_direct para uma geração cercada.

O segundo enqueue cria ou recupera o tombstone com a mesma chave. Para uma
resposta prompt ou terminal, o enqueue supersede progressos anteriores em
pending ou retryable mesmo quando existe fallback fence, desde que a geração
não esteja suspensa.

### 6.4 Begin do fallback

begin_outbox_fallback_attempt mantém nome, assinatura e formato de retorno, mas
passa a ser o gate comum das tentativas diretas duráveis.

Para fallback active, a RPC:

1. lê a geração e o destinatário sem row lock;
2. adquire geração, chave e destinatário nessa ordem;
3. consulta o fence de geração;
4. relê a linha com FOR UPDATE;
5. revalida identidade, razão do fallback, attempt, WAMID e lease;
6. verifica predecessores FIFO sob o lock do destinatário;
7. se puder iniciar, muda suspended para sending, limpa campos de suspensão,
   cria lease e registra fallback_started;
8. se houver predecessor, muda o tombstone para pending, limpa os campos de
   suspensão e retorna started=false com status pending;
9. se a geração estiver suspensa, mantém status suspended e retorna sem lease.

Para shadow, a mesma RPC reconhece pending sem delivery authority, valida a
geração e cria uma lease shadow-direct. Shadow não entra na fila do sweeper.

### 6.5 Fallback bloqueado pelo FIFO

Quando begin retorna started=false e status pending para uma linha active, o
serviço não chama Meta e não trata o caso como perda:

- retorna resultado durablyEnqueued=true;
- permite que o scope seja finalizado;
- deixa a linha para o sweeper após os predecessores;
- mantém o replay do inbound cercado porque há uma mensagem durável.

Estados sending e unknown anteriores nunca são apagados para liberar um
fallback.

### 6.6 Resultado do fallback

Uma tentativa direta iniciada usa a máquina normal:

- accepted → api_accepted;
- rejeição conhecida → failed_terminal, sem retry direto;
- ambiguidade → unknown com unknown_reconcile_at;
- callback positivo ou failed pode chegar antes do resultado;
- resultado tardio continua idempotente pela last_lease_token.

Enquanto sending ou unknown não reconciliado, a linha bloqueia sucessores FIFO.

## 7. Rollback e manutenção

### 7.1 Comportamento de suspend_outbox_generation

A RPC:

- normaliza a razão uma única vez;
- instala o fence sob lock exclusivo da geração;
- muda pending e retryable para suspended;
- converte tombstones de fallback ainda não iniciados para razão de rollback;
- preserva sending e unknown não reconciliado;
- não limpa leases de sending;
- pode liberar lease apenas de estados já terminais ou com prova positiva;
- mantém o formato suspended_count.

### 7.2 Manutenção de geração cercada

claim_outbox_messages não retorna entregas quando a geração está cercada, mas
continua executando manutenção segura antes de retornar:

- sending com lease vencida → unknown;
- unknown vencido → reconciliado terminal;
- leases de estados terminais → limpeza;
- expiração aplicável.

Esses loops incluem tentativas shadow em voo mesmo sem delivery_authority.

O runbook usa p_limit=0 para executar somente manutenção durante o drain.

### 7.3 Semântica operacional

O retorno de suspend_outbox_generation significa fence instalado, não drain
concluído. O operador:

1. muda o código/configuração para off;
2. instala o fence da geração;
3. executa manutenção sem claim;
4. espera o gate de in-flight zerar;
5. registra o rollback como concluído;
6. nunca reutiliza a geração.

Nenhuma tentativa autorizada depois do fence é possível. Uma tentativa
autorizada antes do fence pode terminar durante draining, mas não depois do
gate final se os limites de runtime e reconciliação forem respeitados.

## 8. Correções de runtime

### 8.1 Resposta HTTP rejeitada com body ilegível

sendMetaTextMessage verifica response.ok mesmo quando a leitura ou parse do
body falha:

- response.ok=false → rejected, preservando HTTP status e request ID;
- response.ok=true com body ilegível ou sem WAMID → outcome_unknown;
- falha de rede depois do início do request → outcome_unknown.

Assim, 429 e 5xx continuam elegíveis à política de retry.

### 8.2 Contexto de usuário em respostas antecipadas

processInboundWork consulta apenas o usuário existente pelo telefone antes de
abrir runWithOutboxScope e passa seu userId, quando houver.

O lookup não cria usuário. O handler continua responsável por criar novos
usuários e pode atualizar o scope com setOutboxScopeUser.

Blank text, texto longo, unsupported e falhas iniciais de áudio/imagem passam a:

- persistir user_id quando o usuário já existe;
- consultar o contexto ativo correto na finalização;
- usar TTL de prompt quando aplicável;
- projetar bot_messages normalmente.

Falha no lookup é tratada pelo lifecycle normal de inbound_work, não ignorada.

### 8.3 Projeção em callback failed

apply_outbox_callback chama project_outbox_bot_message para qualquer callback
correlacionado que forneça WAMID válido, inclusive failed.

O helper continua idempotente. A RPC usa o provider_message_id consolidado da
linha e não cria projeção duplicada quando um resultado tardio chega.

### 8.4 Cron HTTP

As rotas reminders e webhook-health exportam GET para Vercel Cron. POST pode
permanecer como alias para compatibilidade e smoke manual. Autorização e
respostas permanecem iguais nos dois métodos.

### 8.5 Telemetria de replay

Quando uma linha existente pending ou retryable é reclamada inline, replayed
deve refletir que o enqueue não inseriu uma linha nova.

## 9. Migration e segurança

### 9.1 Aplicação atômica

O procedimento da VPS usa:

- psql -X;
- ON_ERROR_STOP=on;
- --single-transaction;
- --file com caminho explícito;
- alvo/container/database confirmados;
- checksum da migration registrado.

Uma falha desfaz DDL, funções e ACLs em conjunto.

### 9.2 Defesa em profundidade

Cada função SECURITY DEFINER recebe REVOKE da assinatura exata imediatamente
após sua definição. Os grants para service_role continuam explícitos e o bloco
final valida todas as assinaturas.

As duas tabelas permanecem sem SELECT, INSERT, UPDATE ou DELETE para PUBLIC,
anon, authenticated e service_role.

### 9.3 Schema cache

Depois dos grants, a aplicação envia NOTIFY pgrst para reload de schema e o
runbook mantém restart controlado como fallback.

O smoke pós-migration invoca todas as assinaturas RPC pelo caminho
service-role/PostgREST. Consultar apenas pg_proc não é suficiente.

### 9.4 Preflight

Antes da migration, o runbook confirma:

- migration ainda não aplicada;
- public.inbound_work e migrations predecessoras presentes;
- backup restaurável e ensaio de restore;
- roles esperadas;
- checksum do arquivo;
- modo off, geração vazia, allowlist vazia e percent zero.

## 10. Gates operacionais

### 10.1 progress_after_response

O gate usa o primeiro evento scope_finalized da resposta final e conta
progressos cujo accepted_at seja posterior ao event_at desse evento.

Ele não depende de response.accepted_at e inclui respostas finais ainda não
aceitas pela Meta.

### 10.2 Outros gates

Permanecem obrigatórios:

- conflito de chave e hash;
- retry depois de unknown;
- retry depois de callback failed;
- leases presas;
- aceitação sem WAMID correlacionável;
- missing_terminal_outbox e incidentes de inbound;
- in-flight da geração durante rollback;
- erros ou redactionErrors do sweeper.

O wrapper operacional interpreta o JSON do sweeper e falha quando houver
contadores de erro, mesmo que o endpoint responda HTTP 200.

### 10.3 Estado pré-migration

O runbook documenta:

- 200 em off pristine quando PGRST202 ou 42883 confirma RPC ausente;
- 503 quando há geração conhecida, modo diferente de off ou erro não
  reconhecido.

## 11. Testes obrigatórios

Todo bug segue RED, confirmação da falha esperada e GREEN.

### 11.1 Transporte e rollback

- body-read failure em 429 e 503 continua rejected e retryable;
- body-read failure em 2xx vira unknown;
- shadow recém-enfileirado em geração suspensa faz zero POSTs;
- shadow não envia sem autorização durável;
- fallback terminal supersede progresso retryable anterior;
- fallback com predecessor sending ou unknown fica pending e faz zero POSTs;
- sweeper envia o fallback enfileirado somente após liberar FIFO;
- fallback unknown bloqueia sucessor até reconciliação;
- suspensão entre claim ou begin e POST preserva a tentativa como in-flight;
- nenhum start novo ocorre depois do fence;
- maintenance com p_limit=0 drena geração cercada sem claim;
- gate de drain zera depois de resultado ou reconciliação.

### 11.2 Scope e callbacks

- blank, texto longo e unsupported com usuário/contexto existente preservam
  user_id, prompt e TTL;
- falhas antecipadas de áudio/imagem seguem a mesma regra;
- callback failed antes do resultado cria exatamente uma projeção;
- resultado tardio não duplica bot_messages;
- falha forçada durante projeção de callback desfaz row update, ledger,
  redaction e marker na mesma transação.

O fault test usa trigger/função temporários no Postgres local e remove ambos em
finally.

### 11.3 Concorrência determinística

Testes de callback/WAMID e demais races deixam de depender de sleep arbitrário.
Eles usam sessões reais, marker em pg_stat_activity e estado intermediário
observável.

O teste de callback órfão prova:

- callback chegou ao ponto marcado;
- record result ficou bloqueado no lock comum;
- órfão original foi criado;
- exatamente um orphan_callback_linked foi gravado.

### 11.4 Privilégios

A integração testa:

- SELECT, INSERT, UPDATE e DELETE nas duas tabelas;
- roles PUBLIC, anon, authenticated e service_role;
- EXECUTE da assinatura exata de cada RPC;
- somente service_role com EXECUTE;
- search_path vazio e SECURITY DEFINER em todas as funções privilegiadas.

### 11.5 Histórias completas

Com Postgres real e MSW:

- webhook bot: enqueue, um POST, api_accepted, callback e replay sem segundo
  POST;
- OTP: chave auth_code.id, máximo de três tentativas, WAMID e redaction;
- reminder: chave por usuário/tipo/janela, WAMID e replay;
- 429 com backoff;
- rejeição permanente sem retry;
- socket/timeout ambíguo sem novo POST;
- progresso com uma tentativa e supersede pela resposta final.

As histórias afirmam quantidade de POSTs, não apenas estado final.

### 11.6 Cron e CI

- GET autenticado de reminders e webhook-health;
- POST alias, se mantido;
- CI obrigatória executa npm test e npm run build além de lint e TypeScript;
- integração PostgreSQL permanece gate local/release até existir serviço
  Postgres confiável na CI.

## 12. Organização da implementação

O plano de implementação deve separar quatro lotes sequenciais:

1. protocolo de transporte, fallback, shadow e rollback;
2. meta-client, scope antecipado, callback failed e cron GET;
3. fault matrix, concorrência, ACL, histórias OTP/reminder e CI;
4. runbook, gates, revisão transversal e verificação completa.

Cada lote recebe implementador, commit escopado e revisão independente antes do
seguinte.

## 13. Verificação final

No SHA final, executar:

- npm test;
- npm run test:integration;
- npm run lint;
- npx tsc --noEmit;
- npm run build;
- git diff --check.

Registrar:

- quantidade exata de arquivos e testes;
- resultado completo da integração Postgres;
- erros e warnings do lint, separando preexistentes;
- TypeScript e build;
- ausência de processos de teste ou sessões de banco órfãs;
- status limpo exceto pelos arquivos untracked protegidos.

## 14. Critérios de aceitação

O trabalho está pronto para revisão final quando:

- não restar Critical ou Important da revisão transversal;
- toda chamada Meta em shadow ou active selecionado possuir start durável;
- fallback não ultrapassar FIFO nem liberar sucessor durante unknown;
- geração cercada não conceder novo claim ou begin;
- rollback só for declarado concluído depois do drain;
- 429/5xx comprovadamente rejeitados continuarem retryable;
- early responses preservarem usuário e contexto;
- callback failed com WAMID projetar exatamente uma bot_message;
- migration e ACLs forem aplicáveis atomicamente;
- PostgREST enxergar todas as RPCs após reload;
- progress_after_response usar scope_finalized;
- fault matrix, histórias e ACL matrix passarem;
- CI e verificação local completa passarem;
- migration, cron e rollout de produção permanecerem não executados.

## 15. Arquivos protegidos

Durante todos os lotes:

- .cursor/settings.json permanece intocado e untracked;
- docs/superpowers/plans/2026-07-13-fase2b-outbox-pendencias.md permanece
  intocado e untracked;
- docs/superpowers/plans/2026-07-13-fase2b-outbox-invariantes.md permanece
  intocado e untracked;
- nenhuma dependência ou lockfile muda.
