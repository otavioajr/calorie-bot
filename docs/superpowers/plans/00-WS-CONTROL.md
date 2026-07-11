# Meal-Flow Remediation — Controle / Progresso (WS1–WS6)

> **Source of truth** da remediação do fluxo de registro (auditoria 2026-05-31).
> O agente que implementa **atualiza este arquivo**: marca uma WS como **✅ DONE** somente quando TODOS os gates da "Definition of Done" estiverem marcados. Sempre pegar a próxima WS **NÃO INICIADA** na ordem, respeitando as dependências.
>
> Progresso por-task (TDD) vive **dentro de cada plano** (`- [ ]` por step). Este arquivo controla o nível-WS.

## Superseded por o roadmap 2026-07-11

A partir de **11/07/2026**, o programa de correção conversacional/nutricional/confiabilidade passou a ser governado por:

**[`2026-07-11-roadmap-bot-inteligente-economico.md`](2026-07-11-roadmap-bot-inteligente-economico.md)**

(fonte de achados: [`../specs/2026-07-11-auditoria-conversacional-e-registro-alimentos.md`](../specs/2026-07-11-auditoria-conversacional-e-registro-alimentos.md))

### Absorção das WS abertas

| WS | Status neste arquivo | Destino no roadmap |
|---|---|---|
| WS1 | ✅ DONE (permanece histórico) | — |
| WS2 | ✅ DONE (permanece histórico) | — |
| WS3 — continuação de refeição | ⏸ Absorvida — **não iniciar isolada** | Fase 4 (+ CROSS/STATE na Fase 8) |
| WS4 — robustez rótulo/visão | ⏸ Absorvida — **não iniciar isolada** | Fase 6 (+ NUTX na Fase 5) |
| WS5 — dedup vs confirmação | ⏸ Absorvida — **não iniciar isolada** | Fase 2 (inbox/`work_id` generaliza o claim) |
| WS6 — DECIMAL em products | ⏸ Absorvida — **não iniciar isolada** | Fase 5 (PROD-04) |

**Regra para agentes:** não abrir branch `fix/ws3|ws4|ws5|ws6-*` nem executar os planos WS3–WS6 como frentes isoladas. Ao detalhar a fase correspondente do roadmap, reutilizar tasks úteis dos planos WS e fechar o restante no novo plano da fase.

Ordem operacional atual: **Fase 0** (e opcionalmente **Fase 1** em paralelo) → depois Fase 2 → 3 → 4 → 5–8 conforme o roadmap.

---

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

## Ordem & dependências (histórico WS1–WS6)

- **WS1 precisa estar no `main` antes de WS2 e WS6** (WS2 extrai `buildMacrosBlock`; WS6 reusa `decToNum`).
- Sequência original: WS1 → WS2 → WS3 → WS4 → WS5 → WS6 (WS6 podia rodar após WS1).
- **Atualização 2026-07-11:** WS3–WS6 não seguem mais esta sequência isolada; ver seção “Superseded” acima.

---

## Status

### WS1 — Coerção DECIMAL (macros davam NaN) — ✅ DONE
- Implementado direto (sem doc de plano) · Branch `fix/decimal-string-coercion-macros` · **PR #14**
- [x] Tasks (TDD: `decToNum` + 6 sites de leitura)
- [x] `npm test` verde (1074)
- [x] lint 0 · tsc 0 erros novos
- [x] PR aberto (#14), review CodeRabbit limpo
- [x] **PR #14 mergeado no `main`** (commit `12ff2a5`) — desbloqueia WS2 e WS6

### WS2 — Exibição de macros consistente — ✅ DONE
- Plano: [`2026-05-31-ws2-macro-display-consistency.md`](2026-05-31-ws2-macro-display-consistency.md) · 9 tasks · Branch `fix/ws2-macro-display-consistency`
- Decisões de produto confirmadas pelo Otávio (2026-05-31): macros em todos os fluxos · ordem P/G/C
- [x] Todas as 9 tasks implementadas (TDD red→green cada) — commits `162d463`..`09c6251`
- [x] `npm test` — 1088 verdes, 0 falhas
- [x] `npm run lint` — 0 erros (22 warnings pré-existentes)
- [x] `npx tsc --noEmit` — 10 erros, idênticos ao `main` (0 novos)
- [x] Cada task revisada (spec + qualidade) por subagente; review final holístico: pronto
- [x] **PR aberto contra `main`** — **PR #16**
- [x] Review + merge do Otávio
- [x] **PR #16 mergeado no `main`** (merge commit `c319c73`, 2026-06-01)
- Conferência manual recomendada (pós-merge): smoke por fluxo com user que tem as 3 metas; caso keto 0g (gate `!= null`)
- Follow-ups fora de escopo (anotados): migrar `summary.ts` p/ usar `buildMacrosBlock`; helper `finalizeMealResponse` se um 4º fluxo copiar o triplet; corrigir os 10 erros tsc pré-existentes (fixtures `nutrition_basis_*`/`chat`/`quantity_source`)

### WS3 — Continuação de refeição ("também") — ⏸ ABSORVIDA (não iniciar)
- Plano legado: [`2026-05-31-ws3-meal-continuation.md`](2026-05-31-ws3-meal-continuation.md) · 10 tasks
- Absorvida por: **Fase 4** (+ CROSS/STATE na **Fase 8**) do [roadmap 2026-07-11](2026-07-11-roadmap-bot-inteligente-economico.md)
- [ ] Definition of Done — *fechada apenas quando a fase correspondente do roadmap estiver DONE*

### WS4 — Robustez do rótulo/visão — ⏸ ABSORVIDA (não iniciar)
- Plano legado: [`2026-05-31-ws4-label-vision-robustness.md`](2026-05-31-ws4-label-vision-robustness.md) · 7 tasks
- Reparo pendente no plano legado: trocar o marcador `TODO(WS5)` (tema null-vs-0 é da própria WS4) — tratar no plano da **Fase 6**
- Absorvida por: **Fase 6** (+ NUTX na **Fase 5**) do [roadmap 2026-07-11](2026-07-11-roadmap-bot-inteligente-economico.md)
- [ ] Definition of Done — *fechada apenas quando a fase correspondente do roadmap estiver DONE*

### WS5 — Webhook: dedup vs confirmação — ⏸ ABSORVIDA (não iniciar)
- Plano legado: [`2026-05-31-ws5-webhook-dedup-vs-confirmation.md`](2026-05-31-ws5-webhook-dedup-vs-confirmation.md) · 6 tasks
- Inclui migration (coluna `status` em `processed_messages`) — generalizada pela inbox/`work_id` da **Fase 2**
- Absorvida por: **Fase 2** do [roadmap 2026-07-11](2026-07-11-roadmap-bot-inteligente-economico.md)
- [ ] Definition of Done — *fechada apenas quando a fase correspondente do roadmap estiver DONE*

### WS6 — DECIMAL no fluxo de products — ⏸ ABSORVIDA (não iniciar)
- Plano legado: [`2026-05-31-ws6-products-decimal-coercion.md`](2026-05-31-ws6-products-decimal-coercion.md) · 2 tasks
- Depende de: WS1 mergeado (reusa `decToNum`) — já satisfeito
- Absorvida por: **Fase 5** (PROD-04) do [roadmap 2026-07-11](2026-07-11-roadmap-bot-inteligente-economico.md)
- [ ] Definition of Done — *fechada apenas quando a fase correspondente do roadmap estiver DONE*

---

## Log de conclusão

| Data | WS | PR | Notas |
|------|----|----|-------|
| 2026-05-31 | WS1 | #14 | ✅ Mergeado no `main` (commit `12ff2a5`) |
| 2026-06-01 | WS2 | #16 | ✅ Mergeado no `main` (merge commit `c319c73`) · 9 tasks · 1088 testes verdes |
| 2026-07-11 | WS3–WS6 | — | ⏸ Absorvidas pelo roadmap [`2026-07-11-roadmap-bot-inteligente-economico.md`](2026-07-11-roadmap-bot-inteligente-economico.md); não iniciar isoladas |
