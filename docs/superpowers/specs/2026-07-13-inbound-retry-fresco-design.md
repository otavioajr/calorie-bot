# Inbound retry fresco — TTL 90s + última mensagem (design spec)

**Data:** 13/07/2026  
**Status:** Implementado na branch fix/inbound-retry-fresco — aguardando PR/merge  
**Plano:** [2026-07-13-inbound-retry-fresco.md](../plans/2026-07-13-inbound-retry-fresco.md)  
**Roadmap:** [2026-07-11-roadmap-bot-inteligente-economico.md](../plans/2026-07-11-roadmap-bot-inteligente-economico.md)  
**Spec pai:** [2026-07-12-fase2-inbox-enxuta-design.md](2026-07-12-fase2-inbox-enxuta-design.md)  
**Branch prevista:** `fix/inbound-retry-fresco` (ou equivalente)

---

## 1. Problema

A Fase 2 (`inbound_work` + sweeper/piggyback) evita perda de mensagem após ACK à Meta. Porém o retry **não tem limite de frescor**: uma mensagem órfã pode ser processada minutos depois e gerar reply WhatsApp fora de contexto — sensação de “mensagem do nada” numa conversa ao vivo.

Isso conflita com a expectativa de UX: atraso curto é aceitável; resposta atrasada demais não.

---

## 2. Objetivo

Permitir retry **só enquanto a mensagem ainda for relevante na conversa**:

1. **TTL = 90s** desde `received_at`.
2. **Só a última** mensagem do mesmo `user_phone` pode gerar reply no caminho de retomada.
3. Fora dessas regras → `failed_terminal` **sem** envio WhatsApp.

O caminho inline do webhook (mensagem do POST atual) continua processando normalmente; o TTL não bloqueia o enqueue+process do request que acabou de chegar.

---

## 3. Decisão

**Abordagem B** (escolhida):

| Regra | Comportamento |
|---|---|
| `now - received_at > 90s` | `failed_terminal`, `error_code = stale_expired`, sem reply |
| Existe row mais recente do mesmo `user_phone` | `failed_terminal`, `error_code = superseded`, sem reply |
| Dentro do TTL e é a mais recente | claim + process + reply (como hoje) |

Constante: `INBOUND_REPLY_TTL_SECONDS = 90` (env opcional em refinement futuro; nesta entrega, constante no código).

Relógio: `received_at` da row (já preenchido no enqueue).

---

## 4. Onde aplicar

Filtro **central** antes do `dispatch` no processador de retomada (`processInboundWork` / helper chamado por sweeper e piggyback), para um único caminho.

Não exigir mudança de schema além do uso de `error_code` / `error_message` já existentes em `complete_inbound_work`.

Opcional (não obrigatório nesta entrega): `list_stale_inbound_work` pode pré-filtrar por TTL no SQL para não claimar trabalho já morto — se feito, o filtro de “última mensagem” ainda deve rodar no processador (precisa de contexto por telefone).

### 4.1 Inline vs retomada

| Caminho | Aplica TTL / superseded? |
|---|---|
| Webhook processando o `work_id` acabado de enfileirar neste request | **Não** (mensagem fresca por definição) |
| Piggyback / sweeper retomando órfão | **Sim** |

Implementação sugerida: parâmetro `options: { freshnessGate?: boolean }` (default `true` em retomada; `false` no inline do webhook).

---

## 5. Semântica de “última mensagem”

Para `user_phone` P e work W:

- Existe outra row W2 com mesmo `user_phone = P` e `received_at > W.received_at` → W está **superseded**.
- Empate de `received_at`: desempate por `created_at` / `id` (ordem estável); só a mais nova processa.
- `user_phone` NULL: tratar como não supersedível por telefone; aplicar **somente** TTL (caso raro / status events sem from).

Não comparar com `bot_messages` nesta fase — só `inbound_work`.

---

## 6. Status e erros

| Situação | Status final | `error_code` | WhatsApp |
|---|---|---|---|
| Processamento OK | `committed` | — | reply normal |
| TTL estourado | `failed_terminal` | `stale_expired` | nenhum |
| Superseded | `failed_terminal` | `superseded` | nenhum |
| Erro transitório (inalterado) | `failed_retryable` / terminal por attempts | existente | nenhum até retry fresco |

Não enviar mensagem de desculpas ao usuário no expire (silêncio consciente).

---

## 7. Fora de escopo

- Alterar duração de lease ou `MAX_INBOUND_ATTEMPTS`
- Outbox / `domain_operations`
- Env var para TTL (pode vir depois)
- Reprocessamento manual admin
- Notificar usuário que a mensagem expirou

---

## 8. Testes (aceitação)

1. Retomada com `received_at` há 30s, única do telefone → processa e `committed`.
2. Retomada com `received_at` há >90s → `failed_terminal` / `stale_expired`, handler **não** chamado.
3. Work A antigo (<90s) + work B mais novo do mesmo phone → A `superseded` sem reply; B pode processar se fresco.
4. Inline webhook da mensagem recém-enfileirada → processa mesmo se o gate existir no código (flag off no inline).
5. Unitários no helper de freshness + cobertura no processor/sweeper mocks.

---

## 9. Rollout

- Feature já atrás de `INBOUND_WORK_ENABLED`; mudança é comportamento do retry.
- Deploy normal via merge em `main`.
- Sem migration obrigatória.
- Observabilidade: log `stale_expired` / `superseded` com `work_id` + `provider_message_id`.

---

## 10. Relação com Fase 2

Complementa, não substitui, a inbox: ACK durável permanece; o que muda é **quando** o retry pode falar com o usuário.
