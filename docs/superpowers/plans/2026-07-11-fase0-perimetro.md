# Fase 0 — Perímetro (plano de implementação)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fechar a porta de entrada do bot: autenticar webhook, enumerar batch, cron seguro, validar phone_number_id, responder tipos não suportados e limitar entradas — sem migrations de domínio.

**Architecture:** Validação D0 na borda (`webhook.ts`, `route.ts`, `cron auth`, `input-limits.ts`) antes de DB/LLM. `parseWebhookEvents` substitui o parser de evento único. Handlers existentes permanecem; novos `handleUnsupportedMessage` e guardas de texto vazio/tamanho.

**Tech Stack:** Next.js Route Handlers, Node `crypto` (HMAC), TypeScript strict, Vitest.

**Roadmap:** [2026-07-11-roadmap-bot-inteligente-economico.md](2026-07-11-roadmap-bot-inteligente-economico.md) · **Branch:** `fix/fase0-perimetro`

**Achados:** WEB-01, WEB-02, SEC-02, REL-22, ROUTE-06, ROUTE-07 · **Invariantes:** INV-01, INV-02, INV-24

**REL-15 (rate limit):** adiado para Fase 2 (inbox por usuário em serverless).

---

## Decisões de produto (defaults)

| Decisão | Default |
|---|---|
| Assinatura inválida / secret ausente | `401`, fail-closed — sem DB/LLM |
| `WHATSAPP_PHONE_NUMBER_ID` ausente em dev | Validação desligada (log warning); em produção deve estar definido |
| Status + messages no mesmo `value` | Messages processadas; statuses ignorados nesta fase |
| Tipos não suportados | Resposta orientada + dedup (não silêncio) |
| Texto vazio | Resposta local, zero LLM |
| Erro de handler individual em batch | try/catch por mensagem; demais continuam; POST ainda `200` para Meta |

---

## File Structure

```
src/lib/whatsapp/webhook.ts              [MODIFY] verifyWebhookSignature, parseWebhookEvents
src/lib/whatsapp/limits.ts               [CREATE] MAX_WEBHOOK_BODY_BYTES, MAX_INCOMING_TEXT_CHARS
src/lib/auth/cron.ts                     [CREATE] isCronAuthorized
src/lib/bot/input-validation.ts          [CREATE] isBlankText, isTextTooLong
src/lib/bot/handler.ts                   [MODIFY] handleUnsupportedMessage, guardas ROUTE-07
src/app/api/webhook/whatsapp/route.ts    [MODIFY] assinatura, batch, phone id
src/app/api/cron/reminders/route.ts      [MODIFY] isCronAuthorized
src/app/api/cron/webhook-health/route.ts [MODIFY] isCronAuthorized
src/app/api/cron/products-consensus/route.ts [MODIFY] isCronAuthorized compartilhado
.env.example                             [MODIFY] META_APP_SECRET obrigatório para webhook
tests/unit/whatsapp/webhook.test.ts      [MODIFY] parseWebhookEvents + assinatura
tests/unit/webhook/route.test.ts         [MODIFY] assinatura, batch, phone id
tests/unit/auth/cron.test.ts             [CREATE]
tests/unit/bot/input-validation.test.ts  [CREATE]
tests/unit/bot/unsupported-message.test.ts [CREATE]
```

---

### Task 1: WEB-01 — Assinatura `X-Hub-Signature-256`

- [ ] Teste: `verifyWebhookSignature` aceita HMAC válido, rejeita inválido/ausente/secret vazio
- [ ] Implementar `verifyWebhookSignature` em `webhook.ts`
- [ ] Route: `request.text()` → validar → `JSON.parse`; inválido → `401`
- [ ] Testes de route: POST sem assinatura → `401`, handler não chamado

### Task 2: WEB-02 — Enumerar batch

- [ ] Teste: `parseWebhookEvents` retorna N mensagens para N items; statuses+messages coexistem
- [ ] Implementar `parseWebhookEvents`; incluir `phoneNumberId` no evento
- [ ] Route itera eventos com try/catch individual
- [ ] Remover uso de `parseWebhookPayload` na route; adaptar testes

### Task 3: SEC-02 — Cron auth

- [ ] Teste: `isCronAuthorized` nega secret vazio, header errado, aceita correto
- [ ] Criar `src/lib/auth/cron.ts`
- [ ] Aplicar nos 3 crons
- [ ] Teste reminders: `CRON_SECRET` undefined → `401`

### Task 4: REL-22 — `phone_number_id`

- [ ] Teste: evento com phone id errado é ignorado
- [ ] Route filtra por `WHATSAPP_PHONE_NUMBER_ID` quando definido

### Task 5: ROUTE-06 — Tipos não suportados

- [ ] Parser: `type: 'unsupported'`, `rawType` para video/sticker/document/etc.
- [ ] `handleUnsupportedMessage(from, rawType)` com mensagens por tipo
- [ ] Route chama handler para `unsupported`
- [ ] Testes unitários do handler

### Task 6: ROUTE-07 — Texto vazio e limites

- [ ] `isBlankText`, `isTextTooLong` + testes
- [ ] `handleIncomingMessage`: guarda no início — resposta local sem LLM
- [ ] Route: rejeitar body > `MAX_WEBHOOK_BODY_BYTES` com `413`

### Task 7: Finalização

- [ ] `npm test` verde · `npm run lint` 0 erros · `tsc` 0 erros novos
- [ ] Atualizar status Fase 0 no roadmap
- [ ] PR `fix/fase0-perimetro`

---

## Gates de aceitação (Fase 0)

- Payload sem assinatura válida nunca chama handler/DB/LLM
- Batch com 2 mensagens processa 2 handlers
- `statuses` + `messages` no mesmo value: messages não somem
- Cron com `CRON_SECRET` vazio → `401`
- Vídeo/sticker → resposta orientada ao usuário
- Texto só espaços → resposta local, classificador não chamado
