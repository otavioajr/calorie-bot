# Meal-Flow Remediation — Controle / Progresso (WS1–WS6)

> **Source of truth** da remediação do fluxo de registro (auditoria 2026-05-31).
> O agente que implementa **atualiza este arquivo**: marca uma WS como **✅ DONE** somente quando TODOS os gates da "Definition of Done" estiverem marcados. Sempre pegar a próxima WS **NÃO INICIADA** na ordem, respeitando as dependências.
>
> Progresso por-task (TDD) vive **dentro de cada plano** (`- [ ]` por step). Este arquivo controla o nível-WS.

## Definition of Done (gates — iguais para toda WS)

Uma WS só é **✅ DONE** quando cada caixa estiver marcada:

- [ ] Todas as tasks do plano da WS marcadas (`- [ ]` → `- [x]`)
- [ ] `npm test` — suíte completa verde, 0 falhas
- [ ] `npm run lint` — 0 erros
- [ ] `npx tsc --noEmit` — 0 erros **novos** vs `main`
- [ ] Comportamento novo/alterado coberto por teste escrito **test-first** (TDD)
- [ ] Commitado em branch dedicada `fix/ws<N>-<slug>` (Conventional Commits)
- [ ] Push + PR aberto contra `main`
- [ ] Review limpo (CodeRabbit sem comentário acionável + revisão do Otávio)
- [ ] **PR mergeado no `main` pelo Otávio** — o agente NÃO mergeia

## Ordem & dependências

- **WS1 precisa estar no `main` antes de WS2 e WS6** (WS2 extrai `buildMacrosBlock`; WS6 reusa `decToNum`).
- Sequência: WS1 → WS2 → WS3 → WS4 → WS5 → WS6 (WS6 pode rodar a qualquer momento após WS1).
- Antes de iniciar uma WS, reler as "Decisões de produto" no topo do plano dela e aplicar ajustes que o Otávio pediu.

---

## Status

### WS1 — Coerção DECIMAL (macros davam NaN) — 🟡 PR aberto, aguardando merge
- Implementado direto (sem doc de plano) · Branch `fix/decimal-string-coercion-macros` · **PR #14**
- [x] Tasks (TDD: `decToNum` + 6 sites de leitura)
- [x] `npm test` verde (1074)
- [x] lint 0 · tsc 0 erros novos
- [x] PR aberto (#14), review CodeRabbit limpo
- [ ] **PR #14 mergeado no `main`** ← bloqueia WS2 e WS6

### WS2 — Exibição de macros consistente — ⬜ NÃO INICIADA
- Plano: [`2026-05-31-ws2-macro-display-consistency.md`](2026-05-31-ws2-macro-display-consistency.md) · 9 tasks
- Depende de: WS1 mergeado
- [ ] Definition of Done (todos os gates acima)

### WS3 — Continuação de refeição ("também") — ⬜ NÃO INICIADA
- Plano: [`2026-05-31-ws3-meal-continuation.md`](2026-05-31-ws3-meal-continuation.md) · 10 tasks
- [ ] Definition of Done

### WS4 — Robustez do rótulo/visão — ⬜ NÃO INICIADA
- Plano: [`2026-05-31-ws4-label-vision-robustness.md`](2026-05-31-ws4-label-vision-robustness.md) · 7 tasks
- Reparo pendente: trocar o marcador `TODO(WS5)` (tema null-vs-0 é da própria WS4)
- [ ] Definition of Done

### WS5 — Webhook: dedup vs confirmação — ⬜ NÃO INICIADA
- Plano: [`2026-05-31-ws5-webhook-dedup-vs-confirmation.md`](2026-05-31-ws5-webhook-dedup-vs-confirmation.md) · 6 tasks
- Inclui migration (coluna `status` em `processed_messages`)
- [ ] Definition of Done

### WS6 — DECIMAL no fluxo de products — ⬜ NÃO INICIADA
- Plano: [`2026-05-31-ws6-products-decimal-coercion.md`](2026-05-31-ws6-products-decimal-coercion.md) · 2 tasks
- Depende de: WS1 mergeado (reusa `decToNum`)
- [ ] Definition of Done

---

## Log de conclusão

| Data | WS | PR | Notas |
|------|----|----|-------|
| 2026-05-31 | WS1 | #14 | Aberto, aguardando merge |
