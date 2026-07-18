# VPS outbox sweeper — operação e rollout

O bot está em produção. Aplicar a migration ou ativar a outbox exige autorização
operacional explícita. O banco é o PostgreSQL/Supabase self-hosted da VPS; não use
o dashboard do Supabase Cloud. Nunca coloque a service-role key no histórico do
shell, em argumentos de processo ou em logs. Todos os comandos deste documento
são procedimentos para uma janela autorizada; este runbook não autoriza sua
execução.

## Configuração segura

O deploy inicial usa:

```dotenv
OUTBOX_MODE=off
OUTBOX_GENERATION=
OUTBOX_CANARY_PHONES=
OUTBOX_CANARY_PERCENT=0
```

`shadow` e `active` exigem uma geração não vazia. Para mensagens do bot, ambos
também exigem `INBOUND_WORK_ENABLED=true`. OTP e reminders têm identidades próprias.
Callbacks continuam sendo projetados mesmo em `off`; o health-check continua direto.

### Compatibilidade antes da migration

A exceção code-first existe somente para o estado **off pristine**:
`OUTBOX_MODE=off` e `OUTBOX_GENERATION` vazia. Nesse estado o sweeper responde
`200` sem acessar o banco. Para callbacks de status no webhook, a matriz é:

| Configuração do deploy | Erro da RPC de callback ausente | Resposta do webhook |
| --- | --- | --- |
| `off`, geração vazia | `PGRST202` ou `42883` | `200`, apenas durante a janela pré-migration |
| `off`, geração conhecida | `PGRST202` ou `42883` | `503` |
| `shadow` ou `active` | qualquer erro de RPC ausente | `503` |
| qualquer configuração | erro diferente de `PGRST202`/`42883` | `503` |

Portanto, `200` diante de uma RPC ausente nunca é aceito depois que uma geração
foi registrada. No sweeper, `off` com geração conhecida e `shadow` executam a
redaction; se a RPC estiver ausente o endpoint pode responder HTTP `200` com
`redactionErrors > 0`, e o wrapper obrigatório abaixo transforma isso em falha.

### Relação de timeouts

Registre estes valores no change record e revalide-os no SHA que será implantado:

- timeout HTTP do cliente da Meta: `15s` (`DEFAULT_TIMEOUT_MS = 15_000`);
- timeout do cliente cron: `55s` (`curl --max-time 55`);
- duração máxima das rotas serverless: `60s` (`maxDuration = 60`);
- lease de claim/begin: `90s`;
- cadência nominal do cron/manutenção: `60s`;
- atraso nominal de reconciliação de `unknown`: `300s`.

O deadline efetivo **não é sempre cinco minutos**. Para um resultado ambíguo em
`t_unknown`, a migration grava formalmente:

```text
effective_unknown_deadline = min(t_unknown + 300s, expires_at)
effective_unknown_window   = effective_unknown_deadline - t_unknown
```

Para `sending` abandonado, `t_unknown` ocorre somente depois do vencimento da
lease e de uma passagem de manutenção. Portanto, o TTL pode encurtar a janela para
menos que qualquer timeout ou até zerá-la. Comparar apenas o atraso nominal de
300 segundos ao teto serverless de 60 segundos não prova um invariante do
sistema atual.

Use uma margem operacional explícita de `30s`. Para cada chamada, defina:

```text
L      = lease solicitada pela chamada
T_pre  = L
C      = pior cadência aceita da manutenção = 60s
T_post = max(HTTP Meta 15s, curl 55s, serverless 60s, L) = max(L, 60s)
M      = margem operacional = 30s
H(L)   = L + 60s + max(L, 60s) + 30s
H(90)  = 270s
H(900) = 1890s
```

Uma garantia conservadora exige, no mínimo, que `claim_outbox_messages` e
`begin_outbox_fallback_attempt` recusem iniciar quando
`expires_at <= v_now + H(L)`, usando o mesmo instante transacional que concede a
lease. Para `L=90s`, isso preserva pelo menos `T_post + M = 120s` depois de
`t_unknown`; o atraso nominal de `300s` é maior que `120s`, mas o
`LEAST(..., expires_at)` continua sendo a autoridade.

O SQL desta migration no working tree já calcula `H(L)` uma vez por chamada e
revalida o headroom antes de conceder lease em claim e begin. Isso ainda não é
evidência de instalação nem de execução no PostgreSQL alvo. `shadow` e `active`
só podem ser considerados depois que este mesmo SQL for instalado/reaplicado no
ambiente de teste e os testes de integração PostgreSQL, o build e os gates da
Task 9 passarem. Até lá, `off` continua sendo o único modo liberado.

FIFO não é liberado pelo relógio de reconciliação: todo predecessor com
`status='unknown' AND terminal_at IS NULL` bloqueia claim e begin, mesmo depois
de `unknown_reconcile_at` ou `expires_at`. Somente a manutenção que grava
`terminal_at` libera o sucessor.

Use a consulta abaixo como gate observacional adicional; ela não substitui o
guard atômico. Os valores mostrados correspondem ao lease operacional de `90s`;
se a chamada usar outro lease, derive `start_headroom_seconds` de `H(L)`:

```sql
\set generation 'fase2b-20260713-g1'
\set start_headroom_seconds 270
\set post_unknown_headroom_seconds 120

SELECT
  COUNT(*) FILTER (
    WHERE (
        (om.delivery_authority AND om.status IN ('pending', 'retryable'))
        OR (
          NOT om.delivery_authority
          AND om.rollout_mode = 'shadow'
          AND om.status = 'pending'
          AND om.attempt = 0
        )
        OR (
          om.delivery_authority
          AND om.rollout_mode = 'active'
          AND om.status = 'suspended'
          AND om.suspended_reason LIKE 'enqueue_fallback:%'
          AND om.attempt = 0
        )
      )
      AND om.provider_message_id IS NULL
      AND om.lease_token IS NULL
      AND om.expires_at <= NOW()
        + pg_catalog.make_interval(secs => :start_headroom_seconds)
      AND NOT EXISTS (
        SELECT 1
        FROM private.outbox_suspended_generations AS osg
        WHERE osg.generation = om.rollout_generation
      )
  ) AS potentially_startable_without_safe_headroom,
  COUNT(*) FILTER (
    WHERE om.status = 'sending'
      AND om.expires_at <= NOW()
        + pg_catalog.make_interval(secs => :post_unknown_headroom_seconds)
  ) AS inflight_without_reconcile_headroom,
  COUNT(*) FILTER (
    WHERE om.status = 'unknown'
      AND om.terminal_at IS NULL
      AND om.unknown_reconcile_at <= NOW()
        + pg_catalog.make_interval(secs => :post_unknown_headroom_seconds)
  ) AS unknown_deadline_too_early
FROM public.outbox_messages AS om
WHERE om.rollout_generation = :'generation';
```

Aceitação: evidência do guard atômico nos dois caminhos, incluindo a fronteira
dinâmica em que TTL de aproximadamente `20min` recusa `L=900s` e aceita `L=90s`,
cron observado com atraso máximo de `60s` e as três contagens iguais a zero. A
primeira inclui claims ativos, begins shadow e tombstones `suspended` de fallback
potencialmente iniciáveis, mas continua apenas observacional. Se timeout, lease,
cadência ou margem mudar, recalcule `T_pre`, `T_post`, `C` e `H(L)`, atualize o
guard/testes e mantenha `shadow`/`active` bloqueados até nova verificação.

## Instalação

Pare antes de qualquer mudança se um item abaixo não tiver evidência registrada:

1. janela, operador, alvo VPS, container PostgreSQL e database aprovados;
2. SHA do release imutável e working tree limpa;
3. migration `20260713120000` ainda ausente, sem objetos parciais;
4. predecessor `20260712140000_inbound_work.sql` aplicado e suas quatro RPCs
   resolvíveis;
5. backup com checksum e ensaio de restauração concluído com sucesso em banco
   isolado; possuir apenas um dump sem ensaio não libera a mudança;
6. roles `postgres`, `anon`, `authenticated` e `service_role` presentes;
7. SHA-256 do arquivo da migration igual ao aprovado no change record;
8. configuração **do deploy em produção**, não de um `.env` local:
   `OUTBOX_MODE=off`, geração vazia, allowlist vazia e percentual zero.

Use exclusivamente um serviço libpq nomeado em `PGSERVICE`, definido por
`PGSERVICEFILE`, e `.pgpass`/`PGPASSFILE`; ambos os arquivos devem ter permissão
`0600`, e a credencial deve ficar apenas no passfile. `DATABASE_URL` e
`PGPASSWORD` são proibidos mesmo quando vazios. Não ative `set -x`. No checkout
imutável que originará a migration, execute o preflight local abaixo com os
valores e evidências aprovados:

```bash
set -euo pipefail
set +x

if [[ ${DATABASE_URL+x} == x || ${PGPASSWORD+x} == x ]]; then
  echo 'ABORT: remova DATABASE_URL e PGPASSWORD do ambiente' >&2
  exit 1
fi

: "${APPROVED_PGSERVICE:?registre o nome do serviço libpq aprovado}"
: "${APPROVED_PGSERVICEFILE:?registre o service file aprovado}"
: "${APPROVED_PGPASSFILE:?registre o passfile aprovado}"
export PGSERVICE="$APPROVED_PGSERVICE"
export PGSERVICEFILE="$APPROVED_PGSERVICEFILE"
export PGPASSFILE="$APPROVED_PGPASSFILE"
export PGCONNECT_TIMEOUT=10
export PGOPTIONS='-c lock_timeout=5s -c statement_timeout=15min -c idle_in_transaction_session_timeout=60s'

test -r "$PGSERVICEFILE"
test -r "$PGPASSFILE"
test "$(stat -c '%a' "$PGSERVICEFILE")" = "600"
test "$(stat -c '%a' "$PGPASSFILE")" = "600"
if grep -Eiq \
  '^[[:space:]]*(password|passfile|connect_timeout|options)[[:space:]]*=' \
  "$PGSERVICEFILE"; then
  echo 'ABORT: service file contém segredo ou override de bounds/passfile' >&2
  exit 1
fi
: "${EXPECTED_RELEASE_SHA:?registre o SHA aprovado}"
: "${EXPECTED_OUTBOX_MIGRATION_SHA256:?registre o SHA-256 aprovado}"
: "${POSTGRES_CONTAINER:?registre o container aprovado}"
: "${EXPECTED_DATABASE:?registre o database aprovado}"
: "${EXPECTED_DB_USER:?registre o owner aprovado}"
: "${EXPECTED_DB_ADDRESS:?registre o endereço observado no baseline}"
: "${EXPECTED_DB_PORT:?registre a porta observada no baseline}"
: "${BACKUP_ARTIFACT:?registre o caminho do backup}"
: "${BACKUP_SHA256:?registre o checksum do backup}"
: "${RESTORE_DRILL_ID:?registre a evidência do ensaio}"
: "${RESTORE_DRILL_RESULT:?registre passed somente após validar o ensaio}"
: "${OUTBOX_MODE:?copie o valor verificado no deploy de produção}"
: "${OUTBOX_CANARY_PERCENT:?copie o valor verificado no deploy de produção}"

test "$(git rev-parse HEAD)" = "$EXPECTED_RELEASE_SHA"
test -z "$(git status --porcelain)"
test "$OUTBOX_MODE" = "off"
test -z "${OUTBOX_GENERATION-}"
test -z "${OUTBOX_CANARY_PHONES-}"
test "$OUTBOX_CANARY_PERCENT" = "0"
test "$RESTORE_DRILL_RESULT" = "passed"
test -r "$BACKUP_ARTIFACT"
test "$(sha256sum "$BACKUP_ARTIFACT" | awk '{print $1}')" = "$BACKUP_SHA256"

MIGRATION=supabase/migrations/20260713120000_outbox_messages.sql
test "$(sha256sum "$MIGRATION" | awk '{print $1}')" = \
  "$EXPECTED_OUTBOX_MIGRATION_SHA256"

test "$(docker inspect --format '{{.State.Running}}' "$POSTGRES_CONTAINER")" = "true"
docker inspect --format \
  'container={{.Name}} id={{.Id}} image={{.Config.Image}} status={{.State.Status}}' \
  "$POSTGRES_CONTAINER"
```

`psql` recebe o serviço somente pelas variáveis libpq exportadas; não passe uma
flag de seleção de serviço no cliente. Todas as invocações usam `-w`
(`--no-password`) para falhar em vez de abrir prompt de senha.

Anexe a saída de `docker inspect` ao change record e confirme-a contra o inventário
da VPS. O DDL de `supabase_migrations.schema_migrations` não está versionado neste
repositório; por isso, a existência das colunas `version` e `name` deve ser
confirmada pelo gate bloqueante abaixo antes da janela, sem assumir o schema da
instalação self-hosted. Depois execute este preflight SQL; qualquer `\quit 3`
cancela a janela:

```bash
PGCONNECT_TIMEOUT=10 \
PGOPTIONS='-c lock_timeout=5s -c statement_timeout=15min -c idle_in_transaction_session_timeout=60s' \
psql -X -w \
  --set=ON_ERROR_STOP=on \
  --set=expected_database="$EXPECTED_DATABASE" \
  --set=expected_db_user="$EXPECTED_DB_USER" \
  --set=expected_db_address="$EXPECTED_DB_ADDRESS" \
  --set=expected_db_port="$EXPECTED_DB_PORT" <<'SQL'
SELECT current_database() AS database,
       current_user AS database_user,
       COALESCE(inet_server_addr()::text, 'local') AS server_address,
       inet_server_port() AS server_port,
       pg_is_in_recovery() AS is_replica;

SELECT (
  current_database() = :'expected_database'
  AND current_user = :'expected_db_user'
  AND COALESCE(inet_server_addr()::text, 'local') = :'expected_db_address'
  AND inet_server_port()::text = :'expected_db_port'
  AND NOT pg_is_in_recovery()
) AS target_ok \gset
\if :target_ok
\else
  \echo 'ABORT: host/database/user/port inesperado ou alvo em recovery'
  \quit 3
\endif

SELECT (
  to_regclass('supabase_migrations.schema_migrations') IS NOT NULL
  AND (
    SELECT COUNT(*)
    FROM information_schema.columns
    WHERE table_schema = 'supabase_migrations'
      AND table_name = 'schema_migrations'
      AND column_name IN ('version', 'name')
  ) = 2
) AS migration_history_schema_ok \gset
\if :migration_history_schema_ok
\else
  \echo 'ABORT: schema_migrations sem as colunas version/name esperadas'
  \quit 3
\endif

SELECT NOT EXISTS (
  SELECT 1
  FROM supabase_migrations.schema_migrations
  WHERE version = '20260713120000'
) AS migration_unregistered \gset
\if :migration_unregistered
\else
  \echo 'ABORT: migration 20260713120000 já registrada'
  \quit 3
\endif

SELECT (
  to_regclass('public.outbox_messages') IS NULL
  AND to_regclass('public.outbox_status_events') IS NULL
  AND to_regclass('private.outbox_suspended_generations') IS NULL
  AND to_regclass('private.outbox_fallback_fences') IS NULL
) AS outbox_absent \gset
\if :outbox_absent
\else
  \echo 'ABORT: tabela privada/pública parcial ou migration já aplicada'
  \quit 3
\endif

WITH forbidden(schema_name, function_name) AS (
  VALUES
    ('private', 'project_outbox_bot_message'),
    ('public', 'enqueue_outbox_message'),
    ('public', 'fence_outbox_fallback'),
    ('public', 'begin_outbox_fallback_attempt'),
    ('public', 'claim_outbox_messages'),
    ('public', 'record_outbox_attempt_result'),
    ('public', 'apply_outbox_callback'),
    ('public', 'finalize_outbox_scope'),
    ('public', 'list_outbox_sweeper_work'),
    ('public', 'suspend_outbox_generation'),
    ('public', 'redact_outbox_payloads')
)
SELECT NOT EXISTS (
  SELECT 1
  FROM pg_catalog.pg_proc AS p
  JOIN pg_catalog.pg_namespace AS n ON n.oid = p.pronamespace
  JOIN forbidden AS f
    ON f.schema_name = n.nspname
   AND f.function_name = p.proname
) AS outbox_function_names_absent \gset
\if :outbox_function_names_absent
\else
  \echo 'ABORT: função homônima/overload/estado parcial da outbox encontrado'
  \quit 3
\endif

SELECT (
  EXISTS (
    SELECT 1
    FROM supabase_migrations.schema_migrations
    WHERE version = '20260712140000'
  )
  AND to_regclass('public.inbound_work') IS NOT NULL
  AND to_regprocedure(
    'public.enqueue_inbound_work(text,text,text,text,timestamptz,jsonb)'
  ) IS NOT NULL
  AND to_regprocedure('public.claim_inbound_work(uuid,text,integer)') IS NOT NULL
  AND to_regprocedure(
    'public.complete_inbound_work(uuid,text,text,text,text)'
  ) IS NOT NULL
  AND to_regprocedure('public.list_stale_inbound_work(integer)') IS NOT NULL
) AS predecessor_ok \gset
\if :predecessor_ok
\else
  \echo 'ABORT: predecessor inbound_work ausente ou incompleto'
  \quit 3
\endif

WITH expected(role_name) AS (
  VALUES ('postgres'), ('anon'), ('authenticated'), ('service_role')
)
SELECT bool_and(pg_roles.rolname IS NOT NULL) AS roles_ok
FROM expected
LEFT JOIN pg_roles ON pg_roles.rolname = expected.role_name
\gset
\if :roles_ok
\else
  \echo 'ABORT: uma ou mais roles esperadas estão ausentes'
  \quit 3
\endif
SQL
```

O preflight não substitui a conferência humana do backup/restore, do container e
dos quatro valores de rollout. Com todos os gates aprovados, aplique o arquivo
inteiro e registre a versão no histórico em **uma única sessão/transação**:

```bash
PGCONNECT_TIMEOUT=10 \
PGOPTIONS='-c lock_timeout=5s -c statement_timeout=15min -c idle_in_transaction_session_timeout=60s' \
psql -X -w \
  --set=ON_ERROR_STOP=on \
  --single-transaction \
  --file supabase/migrations/20260713120000_outbox_messages.sql \
  --command="INSERT INTO supabase_migrations.schema_migrations (version, name) VALUES ('20260713120000', 'outbox_messages');"
```

`--single-transaction` envolve o `--file` e o `--command`; falha no DDL ou no
`INSERT` reverte ambos. Não execute o arquivo por partes, não use `psql` interativo
para colar trechos e não insira o histórico separadamente. Registre horário de
commit e SHA-256 no change record.

Imediatamente depois, faça o pós-check bloqueante de registro e objetos:

```bash
PGCONNECT_TIMEOUT=10 \
PGOPTIONS='-c lock_timeout=5s -c statement_timeout=15min -c idle_in_transaction_session_timeout=60s' \
psql -X -w \
  --set=ON_ERROR_STOP=on \
  --set=expected_database="$EXPECTED_DATABASE" \
  --set=expected_db_user="$EXPECTED_DB_USER" \
  --set=expected_db_address="$EXPECTED_DB_ADDRESS" \
  --set=expected_db_port="$EXPECTED_DB_PORT" <<'SQL'
SELECT (
  current_database() = :'expected_database'
  AND current_user = :'expected_db_user'
  AND COALESCE(inet_server_addr()::text, 'local') = :'expected_db_address'
  AND inet_server_port()::text = :'expected_db_port'
  AND NOT pg_is_in_recovery()
) AS post_install_target_ok \gset
\if :post_install_target_ok
\else
  \echo 'ABORT: alvo pós-instalação inesperado'
  \quit 3
\endif

WITH expected(schema_name, function_name, identity_args) AS (
  VALUES
    ('private', 'project_outbox_bot_message', 'uuid, text'),
    ('public', 'enqueue_outbox_message', 'text, text, text, text, text, jsonb, text, text, text, integer, timestamp with time zone, uuid, uuid, integer, text, text, uuid, jsonb'),
    ('public', 'fence_outbox_fallback', 'text, text, text, text, text, text, text'),
    ('public', 'begin_outbox_fallback_attempt', 'uuid, text, integer'),
    ('public', 'claim_outbox_messages', 'text, text, integer, integer, uuid, boolean'),
    ('public', 'record_outbox_attempt_result', 'uuid, uuid, text, text, timestamp with time zone, integer, integer, integer, text, text, jsonb'),
    ('public', 'apply_outbox_callback', 'text, text, timestamp with time zone, uuid, integer, integer, text, jsonb'),
    ('public', 'finalize_outbox_scope', 'uuid, uuid, text, timestamp with time zone'),
    ('public', 'list_outbox_sweeper_work', 'text, integer'),
    ('public', 'suspend_outbox_generation', 'text, text'),
    ('public', 'redact_outbox_payloads', 'integer')
), expected_names AS (
  SELECT DISTINCT schema_name, function_name FROM expected
), actual AS (
  SELECT n.nspname AS schema_name,
         p.proname AS function_name,
         pg_catalog.oidvectortypes(p.proargtypes) AS identity_args
  FROM pg_catalog.pg_proc AS p
  JOIN pg_catalog.pg_namespace AS n ON n.oid = p.pronamespace
  JOIN expected_names AS names
    ON names.schema_name = n.nspname
   AND names.function_name = p.proname
)
SELECT (
  EXISTS (
    SELECT 1 FROM supabase_migrations.schema_migrations
    WHERE version = '20260713120000' AND name = 'outbox_messages'
  )
  AND to_regclass('public.outbox_messages') IS NOT NULL
  AND to_regclass('public.outbox_status_events') IS NOT NULL
  AND to_regclass('private.outbox_suspended_generations') IS NOT NULL
  AND to_regclass('private.outbox_fallback_fences') IS NOT NULL
  AND (SELECT COUNT(*) FROM actual) = 11
  AND NOT EXISTS (
    (SELECT * FROM expected EXCEPT SELECT * FROM actual)
    UNION ALL
    (SELECT * FROM actual EXCEPT SELECT * FROM expected)
  )
) AS post_install_ok \gset
\if :post_install_ok
\else
  \echo 'ABORT: registro/objetos/assinaturas pós-migration divergentes'
  \quit 3
\endif
NOTIFY pgrst, 'reload schema';
SQL
```

Política de retry: a aplicação da migration **nunca** tem retry automático. Em
caso de falha, preserve a evidência, confirme o rollback transacional e somente
então, mediante nova decisão humana, repita o preflight pré-instalação. Depois que
a migration tiver sucesso, **nunca** repita esse preflight: ele exige versão e
objetos ausentes. O pós-check+`NOTIFY` e a validação de ACL admitem no máximo três
tentativas totais. Antes de cada nova tentativa idempotente, execute novamente o
pós-check completo acima: ele é o preflight pós-instalação e confirma alvo,
`version/name` e o conjunto exato de onze funções. Só repita a ACL após esse gate
pós-instalação passar; na terceira falha, aborte a janela.

Há uma janela curta entre deploy e migration em que callbacks podem receber `503`
por RPC ainda inexistente. Mantenha a migration pronta, encurte essa janela e monitore
o webhook; a Meta poderá repetir o callback.

## Reload do schema e smoke das RPCs

A migration termina com `NOTIFY pgrst, 'reload schema'`; a notificação só é
entregue depois do commit da transação. O pós-check pós-instalação acima reforça a
notificação somente depois de confirmar alvo, histórico e superfície exata.

Carregue `SUPABASE_API_URL` e `SUPABASE_SERVICE_ROLE_KEY` de um arquivo privado
`0600`, mantenha xtrace desligado e exija `jq`. O smoke abaixo faz uma chamada
PostgREST com service-role para cada uma das dez assinaturas de `privilegedRpcs`.
Os argumentos são deliberadamente inválidos antes de qualquer mutação; `400` com
SQLSTATE `22023` prova que a assinatura foi encontrada e executada. `404` ou
`PGRST202` prova cache desatualizado/assinatura ausente e sempre falha.

```bash
set -euo pipefail
set +x
: "${SUPABASE_API_URL:?configure a URL da API self-hosted}"
: "${SUPABASE_SERVICE_ROLE_KEY:?carregue do arquivo privado}"
command -v jq >/dev/null

rpc_schema_smoke() (
  local rpc="$1" payload="$2" body_file http_status code
  body_file="$(mktemp)"
  trap 'rm -f "$body_file"' EXIT
  http_status="$(
    printf 'Authorization: Bearer %s\napikey: %s\n' \
      "$SUPABASE_SERVICE_ROLE_KEY" "$SUPABASE_SERVICE_ROLE_KEY" |
      curl --silent --show-error --max-time 15 \
        --output "$body_file" --write-out '%{http_code}' \
        --request POST \
        --header @- \
        --header 'Content-Type: application/json' \
        --data "$payload" \
        "${SUPABASE_API_URL%/}/rest/v1/rpc/$rpc"
  )" || {
    return 1
  }
  code="$(jq -r '.code // empty' "$body_file")"
  if [ "$http_status" = "404" ] || [ "$code" = "PGRST202" ]; then
    echo "FAIL $rpc: schema cache/assinatura ausente ($http_status/$code)" >&2
    return 1
  fi
  if [ "$http_status" != "400" ] || [ "$code" != "22023" ]; then
    echo "FAIL $rpc: resposta inesperada ($http_status/$code)" >&2
    jq -c '{code,message,hint,details}' "$body_file" >&2 || true
    return 1
  fi
  echo "OK $rpc: assinatura resolvida"
)

rpc_schema_smoke enqueue_outbox_message \
  '{"p_provider":"schema-smoke","p_business_account_id":"schema-smoke","p_recipient":"","p_idempotency_key":"schema-smoke","p_message_kind":"terminal","p_payload_json":{},"p_payload_hash":"0000000000000000000000000000000000000000000000000000000000000000","p_rollout_mode":"shadow","p_rollout_generation":"schema-smoke","p_max_attempts":1,"p_expires_at":"1970-01-01T00:00:00Z","p_user_id":null,"p_work_id":null,"p_emission_index":null,"p_reply_to_message_id":null,"p_resource_type":null,"p_resource_id":null,"p_resource_metadata":null}'
rpc_schema_smoke fence_outbox_fallback \
  '{"p_provider":"schema-smoke","p_business_account_id":"schema-smoke","p_recipient":"","p_idempotency_key":"schema-smoke","p_payload_hash":"0000000000000000000000000000000000000000000000000000000000000000","p_rollout_generation":"schema-smoke","p_reason":"schema-smoke"}'
rpc_schema_smoke begin_outbox_fallback_attempt \
  '{"p_outbox_id":null,"p_idempotency_key":"schema-smoke","p_lease_seconds":90}'
rpc_schema_smoke claim_outbox_messages \
  '{"p_owner":"","p_generation":"schema-smoke","p_limit":0,"p_lease_seconds":90,"p_outbox_id":null,"p_allow_unfinalized":false}'
rpc_schema_smoke record_outbox_attempt_result \
  '{"p_outbox_id":null,"p_lease_token":null,"p_outcome":"schema-smoke","p_provider_message_id":null,"p_next_attempt_at":null,"p_http_status":null,"p_meta_code":null,"p_meta_subcode":null,"p_error_code":null,"p_error_message":null,"p_response_json":null}'
rpc_schema_smoke apply_outbox_callback \
  '{"p_provider_message_id":"schema-smoke","p_callback_status":"schema-smoke","p_event_at":"1970-01-01T00:00:00Z","p_outbox_id":null,"p_meta_code":null,"p_meta_subcode":null,"p_error_message":null,"p_callback_json":null}'
rpc_schema_smoke finalize_outbox_scope \
  '{"p_work_id":null,"p_last_outbox_id":null,"p_message_kind":"schema-smoke","p_expires_at":"1970-01-01T00:00:00Z"}'
rpc_schema_smoke list_outbox_sweeper_work \
  '{"p_generation":"","p_limit":0}'
rpc_schema_smoke suspend_outbox_generation \
  '{"p_generation":"","p_reason":"schema-smoke"}'
rpc_schema_smoke redact_outbox_payloads \
  '{"p_limit":-1}'
```

Se qualquer chamada retornar `PGRST202`/`404`, repita o pós-check bounded (que
inclui o `NOTIFY`), aguarde até `60s` e repita o conjunto completo, respeitando o
limite de três tentativas totais. Persistindo a falha, inicie uma identificação
somente leitura. Resolva separadamente os IDs de PostgREST e PostgreSQL, exija IDs
diferentes e compare nome/imagem imutável dos dois com o inventário aprovado:

```bash
set -euo pipefail
set +x

: "${EXPECTED_POSTGREST_NAME:?nome PostgREST aprovado no inventário}"
: "${EXPECTED_POSTGRES_NAME:?nome PostgreSQL aprovado no inventário}"
: "${EXPECTED_POSTGREST_IMAGE:?imagem PostgREST aprovada no inventário}"
: "${EXPECTED_POSTGREST_IMAGE_ID:?ID imutável da imagem PostgREST aprovada}"
: "${EXPECTED_POSTGRES_IMAGE:?imagem PostgreSQL aprovada no inventário}"
: "${EXPECTED_POSTGRES_IMAGE_ID:?ID imutável da imagem PostgreSQL aprovada}"

POSTGREST_ID="$(docker inspect --format '{{.Id}}' "$EXPECTED_POSTGREST_NAME")"
POSTGRES_ID="$(docker inspect --format '{{.Id}}' "$EXPECTED_POSTGRES_NAME")"
test -n "$POSTGREST_ID"
test -n "$POSTGRES_ID"
test "$POSTGREST_ID" != "$POSTGRES_ID"
test "$(docker inspect --format '{{.Name}}' "$POSTGREST_ID")" = \
  "/$EXPECTED_POSTGREST_NAME"
test "$(docker inspect --format '{{.Name}}' "$POSTGRES_ID")" = \
  "/$EXPECTED_POSTGRES_NAME"

POSTGREST_IMAGE="$(docker inspect --format '{{.Config.Image}}' "$POSTGREST_ID")"
POSTGREST_IMAGE_ID="$(docker inspect --format '{{.Image}}' "$POSTGREST_ID")"
POSTGRES_IMAGE="$(docker inspect --format '{{.Config.Image}}' "$POSTGRES_ID")"
POSTGRES_IMAGE_ID="$(docker inspect --format '{{.Image}}' "$POSTGRES_ID")"
test "$POSTGREST_IMAGE" = "$EXPECTED_POSTGREST_IMAGE"
test "$POSTGREST_IMAGE_ID" = "$EXPECTED_POSTGREST_IMAGE_ID"
test "$POSTGRES_IMAGE" = "$EXPECTED_POSTGRES_IMAGE"
test "$POSTGRES_IMAGE_ID" = "$EXPECTED_POSTGRES_IMAGE_ID"

docker inspect --format \
  'container={{.Name}} id={{.Id}} image={{.Config.Image}} status={{.State.Status}}' \
  "$POSTGREST_ID" "$POSTGRES_ID"
```

Pare aqui. Um segundo operador deve comparar a saída com o inventário/change
record e fornecer o ID completo do PostgREST como token de confirmação. Somente
em seguida execute o bloco mutante autocontido abaixo. Ele recalcula e revalida
as duas identidades sem confiar no estado do shell/bloco de inspeção anterior:

```bash
set -euo pipefail
set +x

: "${EXPECTED_POSTGREST_NAME:?nome PostgREST aprovado no inventário}"
: "${EXPECTED_POSTGRES_NAME:?nome PostgreSQL aprovado no inventário}"
: "${EXPECTED_POSTGREST_IMAGE:?imagem PostgREST aprovada no inventário}"
: "${EXPECTED_POSTGREST_IMAGE_ID:?ID imutável da imagem PostgREST aprovada}"
: "${EXPECTED_POSTGRES_IMAGE:?imagem PostgreSQL aprovada no inventário}"
: "${EXPECTED_POSTGRES_IMAGE_ID:?ID imutável da imagem PostgreSQL aprovada}"
: "${POSTGREST_RESTART_CONFIRMATION:?segundo operador deve confirmar o ID completo}"

POSTGREST_ID="$(docker inspect --format '{{.Id}}' "$EXPECTED_POSTGREST_NAME")"
POSTGRES_ID="$(docker inspect --format '{{.Id}}' "$EXPECTED_POSTGRES_NAME")"
test -n "$POSTGREST_ID"
test -n "$POSTGRES_ID"
test "$POSTGREST_ID" != "$POSTGRES_ID"
test "$(docker inspect --format '{{.Name}}' "$POSTGREST_ID")" = \
  "/$EXPECTED_POSTGREST_NAME"
test "$(docker inspect --format '{{.Name}}' "$POSTGRES_ID")" = \
  "/$EXPECTED_POSTGRES_NAME"

POSTGREST_IMAGE="$(docker inspect --format '{{.Config.Image}}' "$POSTGREST_ID")"
POSTGREST_IMAGE_ID="$(docker inspect --format '{{.Image}}' "$POSTGREST_ID")"
POSTGRES_IMAGE="$(docker inspect --format '{{.Config.Image}}' "$POSTGRES_ID")"
POSTGRES_IMAGE_ID="$(docker inspect --format '{{.Image}}' "$POSTGRES_ID")"
POSTGRES_STARTED_AT_BEFORE="$(
  docker inspect --format '{{.State.StartedAt}}' "$POSTGRES_ID"
)"
test "$POSTGREST_IMAGE" = "$EXPECTED_POSTGREST_IMAGE"
test "$POSTGREST_IMAGE_ID" = "$EXPECTED_POSTGREST_IMAGE_ID"
test "$POSTGRES_IMAGE" = "$EXPECTED_POSTGRES_IMAGE"
test "$POSTGRES_IMAGE_ID" = "$EXPECTED_POSTGRES_IMAGE_ID"
test "$(docker inspect --format '{{.State.Running}}' "$POSTGREST_ID")" = "true"
test "$(docker inspect --format '{{.State.Running}}' "$POSTGRES_ID")" = "true"
test "$POSTGREST_RESTART_CONFIRMATION" = "$POSTGREST_ID"
docker restart "$POSTGREST_ID"
test "$(docker inspect --format '{{.State.StartedAt}}' "$POSTGRES_ID")" = \
  "$POSTGRES_STARTED_AT_BEFORE"
test "$(docker inspect --format '{{.State.Running}}' "$POSTGRES_ID")" = "true"
```

Em um terceiro bloco autocontido, apenas depois do retorno do restart, recalcule e
verifique as identidades e os estados. O bloco mutante já comprovou que o
`StartedAt` do PostgreSQL permaneceu inalterado. Não reinicie PostgreSQL nem a
stack inteira:

```bash
set -euo pipefail
set +x

: "${EXPECTED_POSTGREST_NAME:?nome PostgREST aprovado no inventário}"
: "${EXPECTED_POSTGRES_NAME:?nome PostgreSQL aprovado no inventário}"
: "${EXPECTED_POSTGREST_IMAGE:?imagem PostgREST aprovada no inventário}"
: "${EXPECTED_POSTGREST_IMAGE_ID:?ID imutável da imagem PostgREST aprovada}"
: "${EXPECTED_POSTGRES_IMAGE:?imagem PostgreSQL aprovada no inventário}"
: "${EXPECTED_POSTGRES_IMAGE_ID:?ID imutável da imagem PostgreSQL aprovada}"

POSTGREST_ID="$(docker inspect --format '{{.Id}}' "$EXPECTED_POSTGREST_NAME")"
POSTGRES_ID="$(docker inspect --format '{{.Id}}' "$EXPECTED_POSTGRES_NAME")"
test -n "$POSTGREST_ID"
test -n "$POSTGRES_ID"
test "$POSTGREST_ID" != "$POSTGRES_ID"
test "$(docker inspect --format '{{.Name}}' "$POSTGREST_ID")" = \
  "/$EXPECTED_POSTGREST_NAME"
test "$(docker inspect --format '{{.Name}}' "$POSTGRES_ID")" = \
  "/$EXPECTED_POSTGRES_NAME"
test "$(docker inspect --format '{{.Config.Image}}' "$POSTGREST_ID")" = \
  "$EXPECTED_POSTGREST_IMAGE"
test "$(docker inspect --format '{{.Image}}' "$POSTGREST_ID")" = \
  "$EXPECTED_POSTGREST_IMAGE_ID"
test "$(docker inspect --format '{{.State.Running}}' "$POSTGREST_ID")" = "true"
test "$(docker inspect --format '{{.Config.Image}}' "$POSTGRES_ID")" = \
  "$EXPECTED_POSTGRES_IMAGE"
test "$(docker inspect --format '{{.Image}}' "$POSTGRES_ID")" = \
  "$EXPECTED_POSTGRES_IMAGE_ID"
test "$(docker inspect --format '{{.State.Running}}' "$POSTGRES_ID")" = "true"
```

Depois do fallback, repita as dez chamadas; não prossiga com grants, cron ou
rollout enquanto uma delas não retornar o `22023` esperado.

No arquivo privado já usado pelos crons da VPS:

```bash
OUTBOX_SWEEPER_URL=https://caloriebot.app/api/cron/outbox-sweeper
CRON_SECRET=trocar-por-segredo-existente
```

Proteja-o com `chmod 600`. Adicione ao crontab da mesma VPS:

```bash
chmod 600 "$HOME/.caloriebot-cron.env"
test -x /usr/bin/curl
test -x /usr/bin/jq
```

O cron não deve chamar `curl` diretamente. Instale, sob a mesma conta do cron, o
wrapper abaixo em `$HOME/bin/run-caloriebot-outbox-sweeper`, com permissão `0700`:

```bash
#!/usr/bin/env bash
set -euo pipefail
set +x
umask 077

. "$HOME/.caloriebot-cron.env"
: "${OUTBOX_SWEEPER_URL:?missing OUTBOX_SWEEPER_URL}"
: "${CRON_SECRET:?missing CRON_SECRET}"

body="$(
  printf 'Authorization: Bearer %s\n' "$CRON_SECRET" |
    /usr/bin/curl \
      --fail-with-body \
      --silent \
      --show-error \
      --max-time 55 \
      --header @- \
      "$OUTBOX_SWEEPER_URL"
)"

if ! printf '%s' "$body" | /usr/bin/jq -e '
  type == "object"
  and (.errors | type == "number" and . >= 0)
  and (.redactionErrors | type == "number" and . >= 0)
' >/dev/null; then
  echo 'outbox sweeper returned an invalid JSON contract' >&2
  exit 1
fi

if ! printf '%s' "$body" | /usr/bin/jq -e '
  .errors == 0 and .redactionErrors == 0
' >/dev/null; then
  printf '%s' "$body" | /usr/bin/jq -c \
    '{mode,generation,claimed,processed,errors,redacted,redactionErrors}' >&2
  exit 1
fi

printf '%s' "$body" | /usr/bin/jq -c \
  '{mode,generation,claimed,processed,errors,redacted,redactionErrors}'
```

Depois de gravar o wrapper, execute:

```bash
chmod 700 "$HOME/bin/run-caloriebot-outbox-sweeper"
```

`curl --fail-with-body` faz HTTP não-2xx falhar; a validação com `jq` também faz
HTTP `200` falhar se o body não for JSON válido, se os contadores estiverem ausentes
ou se `errors`/`redactionErrors` forem maiores que zero. Nunca registre o header de
autorização.

Crontab:

```cron
* * * * * "$HOME/bin/run-caloriebot-outbox-sweeper" >> "$HOME/caloriebot-outbox-sweeper.log" 2>&1
```

Antes de instalar o cron de um minuto, execute o wrapper manualmente sem `set -x`
e verifique exit code zero e JSON compacto. Respostas esperadas: `off` não envia;
`shadow` redige mas não reivindica; `active` retorna `claimed`, `processed`,
`errors`, `redacted` e `redactionErrors`. Uma geração suspensa produz zero claims.

## Validação de grants

Execute como owner `postgres`. As tabelas não devem ter acesso direto por
`anon`, `authenticated` ou `service_role`; o serviço usa somente RPCs
`SECURITY DEFINER`.

```bash
PGCONNECT_TIMEOUT=10 \
PGOPTIONS='-c lock_timeout=5s -c statement_timeout=15min -c idle_in_transaction_session_timeout=60s' \
psql -X -w --set=ON_ERROR_STOP=on <<'SQL'
WITH roles(role_name) AS (
  VALUES ('anon'), ('authenticated'), ('service_role')
), tables(table_name) AS (
  VALUES ('public.outbox_messages'), ('public.outbox_status_events')
), operations(privilege_type) AS (
  VALUES ('SELECT'), ('INSERT'), ('UPDATE'), ('DELETE')
)
SELECT (
  COUNT(*) = 24
  AND bool_and(NOT allowed)
) AS direct_table_acl_ok
FROM (
  SELECT has_table_privilege(
    role_name, table_name, privilege_type
  ) AS allowed
  FROM tables
  CROSS JOIN roles
  CROSS JOIN operations
) AS direct_table_acl
\gset
\if :direct_table_acl_ok
\else
  \echo 'ABORT: role possui DML direto nas tabelas de outbox'
  \quit 3
\endif

WITH target_tables(table_name) AS (
  VALUES ('public.outbox_messages'), ('public.outbox_status_events')
), operations(privilege_type) AS (
  VALUES ('SELECT'), ('INSERT'), ('UPDATE'), ('DELETE')
)
SELECT NOT EXISTS (
  SELECT 1
  FROM target_tables
  JOIN pg_catalog.pg_class AS c
    ON c.oid = pg_catalog.to_regclass(target_tables.table_name)
  CROSS JOIN operations
  CROSS JOIN LATERAL pg_catalog.aclexplode(
    COALESCE(c.relacl, pg_catalog.acldefault('r', c.relowner))
  ) AS acl
  WHERE acl.grantee = 0
    AND acl.privilege_type = operations.privilege_type
) AS public_table_acl_ok \gset
\if :public_table_acl_ok
\else
  \echo 'ABORT: PUBLIC possui DML direto nas tabelas de outbox'
  \quit 3
\endif

WITH expected(
  schema_name, function_name, identity_args,
  security_definer, service_execute
) AS (
  VALUES
    ('private', 'project_outbox_bot_message', 'uuid, text', FALSE, FALSE),
    ('public', 'enqueue_outbox_message', 'text, text, text, text, text, jsonb, text, text, text, integer, timestamp with time zone, uuid, uuid, integer, text, text, uuid, jsonb', TRUE, TRUE),
    ('public', 'fence_outbox_fallback', 'text, text, text, text, text, text, text', TRUE, TRUE),
    ('public', 'begin_outbox_fallback_attempt', 'uuid, text, integer', TRUE, TRUE),
    ('public', 'claim_outbox_messages', 'text, text, integer, integer, uuid, boolean', TRUE, TRUE),
    ('public', 'record_outbox_attempt_result', 'uuid, uuid, text, text, timestamp with time zone, integer, integer, integer, text, text, jsonb', TRUE, TRUE),
    ('public', 'apply_outbox_callback', 'text, text, timestamp with time zone, uuid, integer, integer, text, jsonb', TRUE, TRUE),
    ('public', 'finalize_outbox_scope', 'uuid, uuid, text, timestamp with time zone', TRUE, TRUE),
    ('public', 'list_outbox_sweeper_work', 'text, integer', TRUE, TRUE),
    ('public', 'suspend_outbox_generation', 'text, text', TRUE, TRUE),
    ('public', 'redact_outbox_payloads', 'integer', TRUE, TRUE)
), expected_names AS (
  SELECT DISTINCT schema_name, function_name FROM expected
), actual AS (
  SELECT n.nspname AS schema_name,
         p.proname AS function_name,
         pg_catalog.oidvectortypes(p.proargtypes) AS identity_args,
         p.oid,
         p.prosecdef,
         p.proconfig,
         p.proacl,
         p.proowner
  FROM pg_catalog.pg_proc AS p
  JOIN pg_catalog.pg_namespace AS n ON n.oid = p.pronamespace
  JOIN expected_names AS names
    ON names.schema_name = n.nspname
   AND names.function_name = p.proname
), missing AS (
  SELECT schema_name, function_name, identity_args FROM expected
  EXCEPT
  SELECT schema_name, function_name, identity_args FROM actual
), extras AS (
  SELECT schema_name, function_name, identity_args FROM actual
  EXCEPT
  SELECT schema_name, function_name, identity_args FROM expected
)
SELECT (
  (SELECT COUNT(*) FROM actual) = 11
  AND NOT EXISTS (
    SELECT 1 FROM missing
    UNION ALL
    SELECT 1 FROM extras
  )
  AND bool_and(
    COALESCE(a.prosecdef = e.security_definer, FALSE)
  )
  AND bool_and(COALESCE(EXISTS (
    SELECT 1
    FROM pg_catalog.unnest(a.proconfig) AS config(setting)
    WHERE setting ~ '^search_path=(""|)$'
  ), FALSE))
  AND bool_and(
    COALESCE(pg_catalog.has_function_privilege(
      'service_role', a.oid, 'EXECUTE'
    ), FALSE) = e.service_execute
  )
  AND bool_and(NOT COALESCE(pg_catalog.has_function_privilege(
    'anon', a.oid, 'EXECUTE'
  ), TRUE))
  AND bool_and(NOT COALESCE(pg_catalog.has_function_privilege(
    'authenticated', a.oid, 'EXECUTE'
  ), TRUE))
  AND bool_and(NOT COALESCE(EXISTS (
    SELECT 1
    FROM pg_catalog.aclexplode(
      COALESCE(a.proacl, pg_catalog.acldefault('f', a.proowner))
    ) AS acl
    WHERE acl.grantee = 0
      AND acl.privilege_type = 'EXECUTE'
  ), TRUE))
) AS exact_surface_and_acl_ok
FROM expected AS e
LEFT JOIN actual AS a USING (schema_name, function_name, identity_args)
\gset

\if :exact_surface_and_acl_ok
\else
  \echo 'ABORT: superfície/ACL/modelo SECURITY/search_path divergente'
  \quit 3
\endif
SQL
```

O primeiro gate exige as 24 combinações role/tabela/DML como `false`; o segundo
exige zero grants de tabela para `PUBLIC` via `aclexplode`, como no teste de
integração.
O gate seguinte exige o conjunto exato de onze assinaturas, sem overload extra ou
duplicata: dez RPCs públicas `SECURITY DEFINER` e o helper privado
`SECURITY INVOKER`. Todas devem ter `search_path` vazio/pinado; `PUBLIC`, `anon`
e `authenticated` não executam nenhuma. `service_role` executa somente as dez
públicas e não executa o helper. `NULL` ou qualquer `\quit 3` é falha.

## Rollout

Use a mesma geração enquanto o rollout estiver saudável, por exemplo
`fase2b-20260713-g1`. Registre horário, SHA, env e métricas em cada degrau.

1. `off`: migration aplicada, grants validados, cron instalado e smokes legados.
2. Gate de headroom: confirmar que o SQL instalado é exatamente o guard atômico
   `H(L)` deste working tree em claim e begin. Task 9, reapply da migration no
   banco local, integração PostgreSQL e build precisam passar; enquanto faltar
   qualquer evidência, permanecer em `off`.
3. `shadow`, somente após todos os gates do passo 2: considerar
   `INBOUND_WORK_ENABLED=true`, geração nova, allowlist vazia e 0%; manter por
   pelo menos 24 horas e 20 envios.
4. `active`, ainda **BLOQUEADO**: considerar apenas depois da evidência
   automatizada completa, query de headroom zerada e revisão transversal no SHA
   final; então usar a mesma geração, allowlist interna e 0% por 24 horas.
5. Manter a allowlist e subir para 10%, 50% e 100%, aguardando 24 horas por degrau.

Não avance se um gate obrigatório for diferente de zero ou se `unknown`/
`failed_terminal` piorar o baseline de shadow.

Volume e comparação:

```sql
\set generation 'fase2b-20260713-g1'
\set since '2026-07-13T00:00:00Z'

SELECT rollout_mode, message_kind, status, COUNT(*) AS messages
FROM public.outbox_messages
WHERE rollout_generation = :'generation'
  AND created_at >= :'since'::timestamptz
GROUP BY 1, 2, 3
ORDER BY 1, 2, 3;

SELECT rollout_mode, COUNT(*) AS total,
  ROUND(100.0 * COUNT(*) FILTER (WHERE status = 'unknown') /
    NULLIF(COUNT(*), 0), 2) AS unknown_pct,
  ROUND(100.0 * COUNT(*) FILTER (WHERE status = 'failed_terminal') /
    NULLIF(COUNT(*), 0), 2) AS failed_pct,
  ROUND(100.0 * COUNT(*) FILTER (
    WHERE status IN ('api_accepted', 'sent', 'delivered', 'read')
  ) / NULLIF(COUNT(*), 0), 2) AS positive_pct
FROM public.outbox_messages
WHERE rollout_generation = :'generation'
  AND created_at >= :'since'::timestamptz
GROUP BY rollout_mode;
```

Gates obrigatórios, todos iguais a zero:

```sql
WITH m AS MATERIALIZED (
  SELECT * FROM public.outbox_messages
  WHERE rollout_generation = :'generation'
    AND created_at >= :'since'::timestamptz
), e AS MATERIALIZED (
  SELECT ose.* FROM public.outbox_status_events ose
  JOIN m ON m.id = ose.outbox_id
), first_unknown AS (
  SELECT outbox_id, MIN(created_at) AS happened_at
  FROM e WHERE new_status = 'unknown' GROUP BY outbox_id
), callback_failed AS (
  SELECT outbox_id, MIN(created_at) AS happened_at
  FROM e
  WHERE event_type = 'callback' AND new_status = 'failed_terminal'
  GROUP BY outbox_id
), response_finalized AS (
  SELECT ose.outbox_id, MIN(ose.event_at) AS finalized_at
  FROM e AS ose
  WHERE ose.event_type = 'scope_finalized'
  GROUP BY ose.outbox_id
)
SELECT
  (SELECT COUNT(*) FROM e
    WHERE event_type = 'idempotency_conflict') AS key_hash_conflicts,
  (SELECT COUNT(*) FROM m
    WHERE accepted_at IS NOT NULL AND provider_message_id IS NULL)
    AS accepted_without_wamid,
  (SELECT COUNT(*) FROM m
    WHERE lease_token IS NOT NULL
      AND lease_expires_at < NOW() - INTERVAL '2 minutes') AS stuck_leases,
  (SELECT COUNT(*) FROM first_unknown u JOIN e c
    ON c.outbox_id = u.outbox_id
    AND c.event_type = 'claimed'
    AND c.created_at > u.happened_at) AS retries_after_unknown,
  (SELECT COUNT(*) FROM callback_failed f JOIN e c
    ON c.outbox_id = f.outbox_id
    AND c.event_type = 'claimed'
    AND c.created_at > f.happened_at) AS retries_after_callback_failure,
  (SELECT COUNT(DISTINCT p.id)
   FROM m AS p
   JOIN m AS r ON r.work_id = p.work_id
   JOIN response_finalized AS rf ON rf.outbox_id = r.id
   WHERE p.message_kind = 'progress'
     AND r.message_kind IN ('prompt', 'terminal')
     AND p.accepted_at > rf.finalized_at) AS progress_after_response,
  (SELECT COUNT(*)
   FROM public.inbound_work AS iw
   WHERE iw.received_at >= :'since'::timestamptz
     AND iw.error_code = 'missing_terminal_outbox')
    AS missing_terminal_outbox,
  (SELECT COUNT(*)
   FROM public.inbound_work AS iw
   WHERE iw.received_at >= :'since'::timestamptz
     AND iw.error_code LIKE 'outbox\_%' ESCAPE '\'
     AND iw.error_code <> 'missing_terminal_outbox')
    AS other_inbound_outbox_incidents,
  (SELECT COUNT(*) FROM m
   WHERE status = 'sending') AS inflight_sending,
  (SELECT COUNT(*) FROM m
   WHERE status = 'unknown' AND terminal_at IS NULL)
    AS unreconciled_unknown,
  (SELECT COUNT(*) FROM m
   WHERE lease_token IS NOT NULL) AS residual_leases;
```

`other_inbound_outbox_incidents` inclui todo código durável com prefixo
`outbox_`, inclusive conflitos, falha de lookup/finalize e fallback ambíguo, sem
depender de uma allowlist que possa ficar desatualizada. Como
`missing_terminal_outbox` pode ocorrer sem uma linha terminal associável à geração,
os dois gates de inbound usam a janela inteira iniciada em `:'since'`. Não avance
se houver outra geração concorrente nessa janela sem separar e auditar seus eventos.

Repita o bloco em uma janela sem novos envios até os três contadores in-flight
(`inflight_sending`, `unreconciled_unknown`, `residual_leases`) zerarem. Não
force `UPDATE` de status/leases para obter zero. Qualquer coluna diferente de zero
bloqueia o próximo degrau e abre incidente.

Orphan callbacks são informativos durante rollout parcial, pois envios legados não
têm correlação de outbox. Redaction vencida deve ser zero:

```sql
SELECT
  COUNT(*) FILTER (
    WHERE message_kind = 'otp' AND payload_json IS NOT NULL
      AND (expires_at <= NOW()
        OR status IN ('api_accepted', 'sent', 'delivered', 'read', 'expired'))
  ) AS overdue_otp,
  COUNT(*) FILTER (
    WHERE message_kind <> 'otp' AND payload_json IS NOT NULL
      AND created_at <= NOW() - INTERVAL '7 days' AND expires_at <= NOW()
  ) AS overdue_common
FROM public.outbox_messages;
```

## Rollback

1. Mude `OUTBOX_MODE=off` e redeploye, mantendo a geração antiga configurada para
   que o endpoint continue a redaction sem enviar.
2. Defina `ROLLBACK_GENERATION` com a geração exata e execute o ciclo crítico
   autocontido abaixo. Ele faz fence, confirma zero work elegível, roda manutenção
   com limite zero, tenta redaction e mede o drain na mesma invocação bounded:

```bash
set -euo pipefail
set +x

if [[ ${DATABASE_URL+x} == x || ${PGPASSWORD+x} == x ]]; then
  echo 'ABORT: remova DATABASE_URL e PGPASSWORD do ambiente' >&2
  exit 1
fi

: "${APPROVED_PGSERVICE:?registre o serviço libpq aprovado}"
: "${APPROVED_PGSERVICEFILE:?registre o service file aprovado}"
: "${APPROVED_PGPASSFILE:?registre o passfile aprovado}"
: "${EXPECTED_DATABASE:?registre o database aprovado}"
: "${EXPECTED_DB_USER:?registre o owner aprovado}"
: "${EXPECTED_DB_ADDRESS:?registre o endereço aprovado}"
: "${EXPECTED_DB_PORT:?registre a porta aprovada}"
: "${ROLLBACK_GENERATION:?registre a geração exata do rollback}"
export PGSERVICE="$APPROVED_PGSERVICE"
export PGSERVICEFILE="$APPROVED_PGSERVICEFILE"
export PGPASSFILE="$APPROVED_PGPASSFILE"
test -r "$PGSERVICEFILE"
test -r "$PGPASSFILE"
test "$(stat -c '%a' "$PGSERVICEFILE")" = "600"
test "$(stat -c '%a' "$PGPASSFILE")" = "600"
if grep -Eiq \
  '^[[:space:]]*(password|passfile|connect_timeout|options)[[:space:]]*=' \
  "$PGSERVICEFILE"; then
  echo 'ABORT: service file contém segredo ou override de bounds/passfile' >&2
  exit 1
fi

PGCONNECT_TIMEOUT=10 \
PGOPTIONS='-c lock_timeout=5s -c statement_timeout=15min -c idle_in_transaction_session_timeout=60s' \
psql -X -w \
  --set=ON_ERROR_STOP=on \
  --set=expected_database="$EXPECTED_DATABASE" \
  --set=expected_db_user="$EXPECTED_DB_USER" \
  --set=expected_db_address="$EXPECTED_DB_ADDRESS" \
  --set=expected_db_port="$EXPECTED_DB_PORT" \
  --set=generation="$ROLLBACK_GENERATION" <<'SQL'
SELECT (
  current_database() = :'expected_database'
  AND current_user = :'expected_db_user'
  AND COALESCE(inet_server_addr()::text, 'local') = :'expected_db_address'
  AND inet_server_port()::text = :'expected_db_port'
  AND NOT pg_is_in_recovery()
) AS rollback_target_ok
\gset
\if :rollback_target_ok
\else
  \echo 'ABORT: alvo de rollback inesperado'
  \quit 4
\endif

BEGIN;
SET LOCAL ROLE service_role;
SELECT * FROM public.suspend_outbox_generation(
  :'generation', 'rollback: operator requested'
);
COMMIT;

BEGIN;
SET LOCAL ROLE service_role;
SELECT COUNT(*) = 0 AS no_sweeper_work
FROM public.list_outbox_sweeper_work(:'generation', 25)
\gset
\if :no_sweeper_work
\else
  \echo 'ABORT: geração suspensa ainda possui work elegível'
  \quit 4
\endif

SELECT * FROM public.claim_outbox_messages(
  'rollback-maintenance', :'generation', 0, 90, NULL, FALSE
);
SELECT * FROM public.redact_outbox_payloads(1000);
COMMIT;

SELECT
  COUNT(*) FILTER (WHERE status = 'sending') AS sending,
  COUNT(*) FILTER (
    WHERE status = 'unknown' AND terminal_at IS NULL
  ) AS unreconciled_unknown,
  COUNT(*) FILTER (WHERE lease_token IS NOT NULL) AS residual_leases,
  COUNT(*) FILTER (WHERE status = 'sending') = 0
    AND COUNT(*) FILTER (
      WHERE status = 'unknown' AND terminal_at IS NULL
    ) = 0
    AND COUNT(*) FILTER (WHERE lease_token IS NOT NULL) = 0 AS drain_zero
FROM public.outbox_messages
WHERE rollout_generation = :'generation'
\gset
\echo sending=:sending unknown=:unreconciled_unknown leases=:residual_leases
\if :drain_zero
\else
  \echo 'WAIT: drain ainda observável; repita o ciclo sem alterar relógios/status'
  \quit 4
\endif
SQL
```

`-w` (`--no-password`) impede prompt; os bounds exatos não herdam valores do
ambiente. `p_limit=0` retorna zero rows de claim, mas ainda executa expiry,
converte `sending` com lease vencida em `unknown`, libera leases terminais
vencidas e reconcilia `unknown` cujo prazo chegou. A função processa lotes
limitados; repita o ciclo enquanto o exit code indicar drain observável. Não
diminua leases, não antecipe `unknown_reconcile_at` e não altere status
manualmente. Até essa manutenção gravar `terminal_at`, o predecessor `unknown`
continua bloqueando todo sucessor FIFO; vencer o deadline sozinho não o libera.

3. Confirme também que o wrapper do endpoint retorna `mode=off`, a geração antiga,
   `claimed=0`, `errors=0` e `redactionErrors=0`.

O deadline efetivo de uma ambiguidade é sempre
`min(t_unknown + 300s, expires_at)` e pode já estar vencido em `t_unknown`; não há
espera adicional fixa. Esse deadline apenas torna a linha elegível à manutenção:
FIFO continua bloqueado até a mesma manutenção persistir `terminal_at`. Uma
tentativa iniciada antes do fence pode permanecer in-flight até a lease vencer. O
rollback avança somente pelo estado observável: repita o ciclo bounded até
`sending`, `unreconciled_unknown` e `residual_leases` zerarem; nunca use limite
positivo na geração suspensa.

4. Repita o bloco de gates obrigatórios da seção de rollout. Rollback operacional
   só termina quando os gates, o drain e o wrapper estiverem todos verdes.
5. Nunca reutilize uma geração suspensa. Para reativar, crie outra geração e repita
   shadow por pelo menos 24 horas e 20 envios.

Callbacks de linhas antigas continuam sendo aplicados durante rollback. Se o cron
estiver indisponível, o ciclo bounded já executa `redact_outbox_payloads(1000)`
como `service_role`; repita-o em lotes até retornar zero e repita os gates de
redaction. Essa contingência não substitui restaurar o wrapper do cron.

## Smokes

Antes de ativar: em `off`, validar texto, áudio, imagem, OTP, reminder e health alert.
Em ambiente não produtivo após a migration, validar shadow e um telefone interno
allowlisted em active. Não aplicar migration nem ativar produção sem autorização
explícita.
