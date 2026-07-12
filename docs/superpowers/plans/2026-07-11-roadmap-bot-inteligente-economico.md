# Roadmap: bot inteligente e econômico

- **Data:** 11/07/2026 (atualizado 12/07/2026)
- **Status:** Fase 0 + patch mínimo (auditoria §20.1) **mergeados em `main` via PR #20 — em produção**; **Fase 1 com spec e plano aprovados** (12/07/2026); Fases 1–8 de implementação pendentes
- **Fonte de verdade dos achados:** [`docs/superpowers/specs/2026-07-11-auditoria-conversacional-e-registro-alimentos.md`](../specs/2026-07-11-auditoria-conversacional-e-registro-alimentos.md)
- **Política de produto:** recomendações padrão da seção 18 da auditoria, adotadas como defaults oficiais
- **Adendo §20 da auditoria:** a seção 20 registra o patch mínimo já entregue (§20.1), os gates reproduzíveis de merge (§20.2) e a arquitetura completa de idempotência (§20.3), que passa a ser a **spec canônica das Fases 2 e 3**
- **Escopo deste arquivo:** ordenar o trabalho em 9 fases (0–8), com IDs, invariantes, escopo técnico e gates. **Não** detalha tasks TDD nem altera código.

> **Como usar:** cada fase futura deve ganhar um plano de implementação próprio (estilo WS3–WS6) antes de editar código. Este roadmap é o mapa; o plano da fase é o roteiro executável.

---

## 1. Promessa do programa

Não prometemos que a LLM “nunca erra”. Prometemos:

1. registrar exatamente o que o usuário quis dizer, quando a interpretação for segura;
2. nunca perder, duplicar ou corromper uma operação quando uma dependência falha;
3. recuperar a conversa sem resposta genérica e sem gastar LLM desnecessariamente;
4. **nenhum erro incerto vira gravação silenciosa ou irreversível**.

Os 30 invariantes da auditoria (INV-01…INV-30) são a definição operacional. Cada fase prova um subconjunto deles.

---

## 2. Decisões de produto adotadas (seção 18)

Resumo das políticas oficiais a partir desta data. Detalhes e justificativas permanecem na auditoria.

| Tema | Política adotada |
|---|---|
| Registro automático | Alta confiança + fonte compatível + efeito reversível; sempre recibo + `desfazer`. |
| Modo manual | Preview/confirm para toda mutação nutricional, em todos os canais. |
| Nível de detalhe | Afeta só a apresentação; nunca a precisão nem o que é persistido. |
| Quantidade ausente | Bulk/alta variação perguntam; unidade natural estável pode sugerir peso típico marcado. |
| Fuzzy/default | Exato aceita; médio mostra candidatos; baixo pergunta. Default só após confirmação. |
| Cru/cozido | Explícito vence; se omissão for material, perguntar. |
| `ml`/densidade | Preservar ml; converter só com densidade específica versionada. |
| Zero vs null | Zero é valor válido; null/ausente nunca vira zero fabricado. |
| Repetição legítima | Dedup por `operation_id`, nunca por alimento+gramas. |
| Delete/reset | Sempre confirmação forte com alvo/data/efeito. |
| Imagem | Preview por padrão; visão observa, enrichment comum decide fonte. |
| Áudio | Confirmar só números/trechos materiais incertos. |
| Fonte indisponível | Não degradar como `not_found`; retry/rótulo/estimativa consentida. |
| Economia | Só reduzir modelo/prompt se gates de integridade e eval permanecerem aprovados. |

---

## 3. Mudanças locais antigas — resolvidas pelo patch mínimo (auditoria §20.1)

A auditoria foi feita sobre `main` + mudanças locais não commitadas. Essas pendências foram **corrigidas e mergeadas na PR #20** conforme o patch mínimo aprovado em §20.1:

| Item | Estado após PR #20 |
|---|---|
| Dedup LOCAL `alimento + gramas` (DUP-01) | **Removido**: igualdade de conteúdo não bloqueia mais inserções; repetição legítima conta duas vezes. A identidade persistida por `operation_id + item_index` continua pendente (Fases 2–3, §20.3). |
| Append com histórico | `appendItemsToMeal` analisa só a instrução atual (histórico vazio) e usa exatamente o `mealId` do contexto `recent_meal`. |
| Roteamento de edit | Verbos amplos de adição fora das keywords globais de `edit`; baixa confiança bloqueada no executor compartilhado; gatekeeper recebe o tipo atual da refeição. |
| Recibo | Contém apenas itens realmente persistidos no destino único, com total recalculado desse destino. |

**Limite consciente** (§20.1): o patch não cria identidade por inbound/ato/item. Replay, concorrência e crash entre escritas continuam abertos (WEB-03/04/05, DB-01…04) e pertencem às Fases 2–3.

---

## 4. Ordem e paralelismo

```text
Fase 0 ──┐
         ├── (paralelo) ──► Fase 2 ──► Fase 3 ──► Fase 4 ──┬──► Fase 5
Fase 1 ──┘                                                ├──► Fase 6
                                                          ├──► Fase 7
                                                          └──► Fase 8
```

- **Fases 0 e 1** podem andar em paralelo.
- **2 → 3 → 4** são sequenciais (fundação de identidade, transação e barreira).
- **5–8** dependem de 2–4; podem se sobrepor entre si após a Fase 4.
- Cada fase: plano detalhado próprio → branch `fix/fase<N>-<slug>` → PR → merge pelo Otávio.

### Relação com WS3–WS6

Os planos abertos WS3–WS6 são **absorvidos** por este roadmap (ver também [`00-WS-CONTROL.md`](00-WS-CONTROL.md)):

| WS antiga | Absorvida por | Motivo |
|---|---|---|
| WS3 — continuação de refeição | Fase 4 (+ CROSS/STATE na Fase 8) | Continuação exige barreira semântica e estado correto, não só TTL. |
| WS4 — robustez rótulo/visão | Fase 6 (+ NUTX na Fase 5) | Preview, null-vs-0 e enrichment comum. |
| WS5 — dedup vs confirmação | Fase 2 | Inbox/`work_id` generaliza o claim `processing`/`done`. |
| WS6 — DECIMAL em products | Fase 5 (PROD-04) | Coerção na fronteira nutricional. |

Não iniciar WS3–WS6 como frentes isoladas. Ao detalhar a fase correspondente, reutilizar tasks úteis dos planos WS e fechar o restante no novo plano.

---

## 5. Definition of Done (gates comuns a toda fase)

Uma fase só é **DONE** quando:

- [ ] Plano detalhado da fase existe e foi aprovado
- [ ] Todos os achados listados na fase têm regressão com o ID do achado
- [ ] Invariantes listados têm prova automatizada ou checklist operacional
- [ ] `npm test` verde; `npm run lint` 0 erros; `npx tsc --noEmit` 0 erros novos vs `main`
- [ ] Gates da auditoria §15.8 aplicáveis à fase passam
- [ ] Gates reproduzíveis da auditoria §20.2 quando a fase tocar env vars ou migrations: job protegido valida presença das env obrigatórias (sem imprimir valores) e `git diff --quiet origin/main...HEAD -- supabase/migrations/` comprova o escopo de migration autorizado
- [ ] PR mergeado no `main` pelo Otávio

---

## 6. Fases

### Fase 0 — Perímetro (quick wins D0)

| | |
|---|---|
| **Status** | ✅ **DONE — mergeada em `main` via PR #20 (produção)** · plano: [2026-07-11-fase0-perimetro.md](2026-07-11-fase0-perimetro.md) · status pós-snapshot: auditoria §20.0 |
| **Objetivo** | Fechar a porta de entrada: autenticar, enumerar todos os eventos, rejeitar abuso óbvio, sem migrar schema de domínio. |
| **Tamanho / risco** | Pequeno / baixo — mudanças localizadas em webhook, cron e parsers. |
| **Pode sair primeiro** | Sim; independente de 2–8. |

**Achados:** WEB-01, WEB-02, SEC-02, REL-22, ROUTE-06, ROUTE-07.

**Invariantes:** INV-01, INV-02, INV-24.

**Escopo técnico resumido:**

- Validar `X-Hub-Signature-256` sobre o corpo bruto antes do parse; rejeitar 401/403 sem tocar DB/LLM.
- `parseWebhookPayload` (ou equivalente) retorna **lista** de eventos; processar/registrar cada `message_id`.
- Falhar se `CRON_SECRET` estiver vazio; comparação segura do Bearer.
- Validar `phone_number_id` / WABA esperados.
- Tipos não suportados (`video`, `sticker`, …) recebem orientação específica, não silêncio.
- Normalizar texto vazio/limites de tamanho com resposta local.

**Gate de aceitação:**

- Payload sem assinatura válida nunca chama handler/LLM.
- Batch com N mensagens processa N (ou registra falha por id); status + messages coexistem sem engolir messages.
- Cron com secret ausente não executa jobs.
- Tipo não suportado gera resposta terminal; texto vazio não chama classificador.

**Registro pós-merge (auditoria §20.0):** WEB-01, WEB-02 e SEC-02 estão **contidos** pela implementação mergeada. Permanecem fora da Fase 0: persistência/reconciliação dos callbacks de status (REL-26, Fase 2) e o claim antecipado/ACK em falha/fail-open do dedupe (WEB-03/04/05, Fase 2). Verificar operacionalmente que `META_APP_SECRET` e `CRON_SECRET` estão configurados na Vercel.

---

### Fase 1 — Fundações de prova

| | |
|---|---|
| **Status** | 📋 **Plano aprovado** (12/07/2026) · spec: [2026-07-12-fase1-fundacoes-de-prova-design.md](../specs/2026-07-12-fase1-fundacoes-de-prova-design.md) · plano: [2026-07-12-fase1-fundacoes-de-prova.md](2026-07-12-fase1-fundacoes-de-prova.md) · branch prevista: `fix/fase1-fundacoes-de-prova` |
| **Objetivo** | Tornar possível provar as fases seguintes com Postgres real, E2E mockado e corpus — não só unit mocks. |
| **Tamanho / risco** | Médio / baixo em produção (só infra de teste + zerar dívida de TS). |
| **Paralelo com** | Fase 0 (✅ mergeada). |

**Achados / lacunas:** ausência de `tests/integration/`, ausência de E2E Playwright apesar do script, COST-18 (esqueleto de eval), 10 erros TypeScript em fixtures/mocks.

**Invariantes:** INV-30 (base), rastreabilidade §15.9.

**Escopo técnico resumido:**

- Harness de integração com Postgres local via Supabase CLI + Colima (migrations limpas + fixtures; **nunca** banco de produção).
- Harness E2E in-process: webhook assinado → handler → DB real → Meta mock (MSW); sem Playwright nesta fase.
- Esqueleto do golden corpus conversacional em `tests/corpus/` (formato de caso: estado, relógio, escrita permitida/proibida, teto de LLM).
- Zerar os 10 erros `tsc` existentes (fixtures `nutrition_basis_*`, mocks, etc.).
- GitHub Actions em PRs: lint + `tsc` + unit + `test:integration`.

**Gate de aceitação:**

- `npx tsc --noEmit` 0 erros no snapshot.
- Pelo menos 1 teste de integração e 1 E2E smoke verdes no CI local.
- Template de caso de corpus documentado e versionado em `tests/`.

---

### Fase 2 — Inbox durável e identidade de operação

| | |
|---|---|
| **Objetivo** | ACK ≠ conclusão; retry retoma trabalho; cada inbound e cada ato têm identidade estável. Absorve e generaliza WS5. |
| **Tamanho / risco** | Grande / alto — migrations + mudança do contrato do webhook. |
| **Depende de** | Fase 0 (✅ mergeada); Fase 1 para provar. |
| **Spec canônica** | Auditoria **§20.3**: identidades (`work_id`, `operation_id`, `item_operation_key`), tabelas `inbound_work` e `outbox_messages`, fluxo transacional, provas obrigatórias em Postgres real. |

**Achados:** WEB-03, WEB-04, WEB-05, STATE-11, REL-01, REL-02, REL-05 (parcial outbox), REL-15, REL-25, REL-26, COST-15, LLM-01 (deadline propagado — início).

**REL-15:** a Fase 2 é autoritativa para rate limit, porque quota e backpressure precisam compartilhar a identidade durável e a serialização da inbox.

**Invariantes:** INV-03, INV-21, INV-22, INV-25 (parcial), INV-26.

**Escopo técnico resumido:**

- `work_id` = `unique(provider, business_account_id, provider_message_id)` — identidade interna do inbound (§20.3); conteúdo/hash semântico nunca é chave de idempotência.
- Tabela `inbound_work` (§20.3): status, attempt, `lease_owner`/`lease_expires_at`, `plan_json` checkpointado com `plan_schema_version`/`prompt_version`/`model_id`, timestamps de estágio e erro normalizado.
- Inbox com status (`accepted` / `processing` / `committed` / `failed` / …), lease e attempt.
- ACK `2xx` só após todos os eventos autenticados estarem duravelmente enfileirados; falha de inbox permite retry da Meta.
- Claim idempotente é precondição; nunca fail-open (WEB-05).
- Fila/serialização por usuário dentro de janela limitada (`event_at`, `received_at`).
- Quota transacional por usuário/WABA, orçamento global, backpressure e circuit breaker.
- Checkpoint de resultado LLM validado por `operation_id + input_hash + versões`.
- Propagar `event_at` (não só relógio de processamento).
- Retenção de dedup alinhada ao horizonte do provedor + idempotência de domínio.
- Outbox `outbox_messages` (§20.3): status `pending/sending/api_accepted/delivered/read/failed/unknown`, `payload_hash`, attempts, correlação com callbacks da Meta (REL-26).
- Retry por estágio (§20.3): `accepted/interpreting` retoma lease; `ready` executa comando persistido; `committed` não repete DB/LLM; `failed_terminal` preserva erro para suporte.

**Gate de aceitação:**

- Crash após claim e antes do commit: retry retoma sem silêncio e sem duplicar efeito se houver checkpoint/commit.
- Duplicata `message_id` consulta ledger; não “OK e descarta” com trabalho incompleto.
- Duas mensagens rápidas do mesmo usuário não aplicam duas transições de estado concorrentes cegas.
- Fault injection: falha de insert de inbox não processa mutação.
- Provas §20.3 aplicáveis: duas sessões concorrentes para o mesmo `provider_message_id` produzem um `work_id`; retry com checkpoint válido não chama LLM.

**Nota:** o plano WS5 (`processing`/`done`) é o núcleo mínimo; este roadmap exige o modelo completo de ledger da auditoria §13.2 e §20.3. O plano da fase deve fechar as decisões listadas em §20.3 que lhe couberem (retenção de `inbound_work`, reordenação por usuário, janela de reconciliação de delivery `unknown`, rollout por feature flag).

---

### Fase 3 — Transação atômica e estado versionado

| | |
|---|---|
| **Objetivo** | Refeição, itens, total e contexto nunca ficam pela metade; dedup deixa de ser semântico. |
| **Tamanho / risco** | Grande / alto — RPCs, CAS de contexto, identidade persistida por item. |
| **Depende de** | Fase 2 (`operation_id`). |
| **Spec canônica** | Auditoria **§20.3**: tabela `domain_operations`, `meal_items.source_operation_id + source_item_index` (UNIQUE), transação nutricional, migração aditiva com feature flag/dual-write/shadow. |

**Achados:** DB-01, DB-02, DB-03, DB-04, DUP-01, STATE-02, STATE-03, STATE-06, REL-03, REL-04, REL-07, REL-08, REL-09, REL-19, REL-20, NUTX-01, ONB-03, ONB-04.

**Invariantes:** INV-04, INV-18, INV-19.

**Escopo técnico resumido:**

- RPC/transação única: claim da operação + itens + total + vínculo mensagem.
- Serialização até commit dos itens (não só advisory lock no find-or-create).
- Multi-refeição: commit atômico do comando ou recibo parcial explícito e retomável.
- Dedup por `operation_id + item_index` (§20.3). A igualdade alimento+gramas **já foi removida** na PR #20 (DUP-01, §20.1); esta fase adiciona a identidade persistida que faltava — conteúdo/hash semântico nunca volta a ser chave.
- `upsertContext` transacional com versão/CAS; schema por `ContextType`.
- Draft sem efeito nutricional **ou** gravação parcial com undo explícito (STATE-03) — alinhar à política: preferir draft.
- Find-or-create de usuário com `ON CONFLICT ... RETURNING`.
- Constraints UNIQUE/checks que hoje permitem múltiplos settings/contextos.
- Arredondamento: precisão canônica no DB; arredondar uma vez na apresentação.

**Gate de aceitação:**

- Crash após criar meal / após item N / após total: rollback completo ou commit indivisível identificável.
- “Mais uma banana de 120 g” nunca é descartada por coincidir com banana anterior (já vale desde a PR #20; a regressão permanece).
- Uma mensagem com duas bananas idênticas produz `item_index` 0 e 1, ambos válidos (§20.3).
- Dois appends concorrentes não duplicam itens lidos do mesmo snapshot.
- Contexto: delete+insert separado não deixa usuário sem estado.
- `meal.total_calories == SUM(meal_items.calories)` após qualquer replay (§20.3).

---

### Fase 4 — Barreira semântica e confirmação proporcional

| | |
|---|---|
| **Objetivo** | Schema válido ≠ autorizado a mutar. Estados roteados; destrutivo confirma; falha de LLM não grava. Absorve intenção da WS3. |
| **Tamanho / risco** | Grande / médio-alto — handler, edit, meal-log, quote, cron, auth web. |
| **Depende de** | Fases 2 e 3. |

**Achados (núcleo P0 + P1 de barreira):** STATE-01, STATE-04, STATE-05, STATE-07, STATE-08, STATE-12, LLM-02, FOOD-01, FOOD-02, FOOD-03, FOOD-04, MULTI-01, EDIT-01, EDIT-02, EDIT-03, EDIT-12, CRON-01, SEC-01, REL-10, PRIV-01, CROSS-01…CROSS-08, QUOTE-01, ROUTE-01…ROUTE-05, ROUTE-10, QUERY-06, CANCEL-01, SET-01, SET-02.

**Já parcialmente contidos pela PR #20** (auditoria §20.1/§20.4, com regressões no repositório): parte de ROUTE-01 (verbos de adição fora das keywords globais de `edit`), STATE-07/09 (append usa o `mealId` exato do contexto; tipo diferente sai da correção), CROSS-03/04 (detector destino vs. alimento; gatekeeper recebe o tipo atual) e EDIT-09 (baixa confiança bloqueada no executor compartilhado). O plano da fase formaliza e completa esses pontos em vez de reimplementá-los.

**Invariantes:** INV-05, INV-06, INV-07, INV-08, INV-09, INV-10, INV-11, INV-20, INV-23.

**Escopo técnico resumido:**

- Switch/exhaustividade de todo `ContextType` (incl. `awaiting_history_selection`); falha de compilação/teste se faltar handler.
- Falha de classificador → recuperação sem escrita (nunca default `meal_log`).
- Estimativa/decomposição inválida → `unresolved`, nunca `0 kcal` persistido.
- Rename usa pipeline nutricional completo ou preserva valores até confirmação.
- Histórico: snapshot completo da refeição; referências resolvem todos os itens da mensagem.
- Multi-refeição: draft com todas as pendências; não descartar refeições seguintes.
- Delete/replace ambíguo: confirmação com alvo/data/token idempotente; regex citada não executa delete direto; polaridade (“não apaga”).
- Edit por tipo resolve data+tipo+quote; matching de item com candidatos ou pergunta.
- Remover auto-confirm por silêncio no cron.
- Quote: `(message_id, user_id)` + ownership em toda mutação.
- Sessão web: cookie/sessão assinada validada server-side (REL-10).
- Reset: inventário completo de tabelas por usuário (PRIV-01).
- Dispatch `(resource, intent)` — quote não força edit cegamente.
- `calorieMode` / `detailLevel` passam a governar o pipeline ou a promessa é removida.
- Comandos/regras determinísticas **antes** do gatekeeper de `recent_meal`.

**Gate de aceitação:**

- Resposta “1” em `awaiting_history_selection` seleciona o match.
- Classificador fora do ar: zero mutações nutricionais.
- “não apaga o arroz” (citado) não apaga.
- “Corrige o almoço de ontem” não altera o almoço de hoje sem resolução de data.
- Silêncio nunca confirma refeição pendente.
- Quote de outro usuário nunca muta recurso alheio.

---

### Fase 5 — Verdade nutricional

| | |
|---|---|
| **Objetivo** | Identidade, quantidade consumida, base da fonte, proveniência e confiança por campo. Absorve WS6. |
| **Tamanho / risco** | Grande / médio — enrichment, TACO, products, schemas. |
| **Depende de** | Fase 4 (barreira); se beneficia da Fase 3. |

**Achados:** FOOD-05…FOOD-25 (prioridade P1 material), PROD-01…PROD-11, NUTX-02…NUTX-21 (exceto os já cobertos), LABEL-02, LABEL-07, LABEL-08, COST-16, COST-17.

**Invariantes:** INV-12, INV-13, INV-14, INV-15, INV-16, INV-17.

**Escopo técnico resumido:**

- Modelo dimensional: `basis_amount/unit` + `consumed_amount/unit`; cálculo local.
- Cascata de fontes §14.4; superior `unavailable` ≠ `not_found`.
- Result type tri-state em TACO/products/OFF.
- Confiança composta por campo; score fuzzy no recibo; faixas exato/médio/baixo.
- `ml` preservado; densidade por alimento; sem densidade → perguntar/estimar explícito.
- Limites de plausibilidade e schemas Zod em estimativas (fim do cast solto).
- Zero kcal válido; macros parciais mesclados com proveniência; não completar com zero.
- `decToNum` em toda fronteira PostgREST de products (WS6).
- Produto: nome+marca+código; múltiplos candidatos → escolha; porção sugerida ≠ fato.
- Aprendizado de default TACO só após confirmação.
- Receitas do usuário no fluxo WhatsApp antes de decomposição genérica.

**Gate de aceitação:**

- “30 g; rótulo 200 kcal/100 g” calcula 60 kcal, não 200.
- Falha de RPC TACO não empurra automaticamente para estimativa LLM.
- Fuzzy médio não grava sem confirmação/candidatos.
- Bebida 0 kcal não é substituída por outra fonte por causa de `> 0`.

---

### Fase 6 — Multimodal seguro

| | |
|---|---|
| **Objetivo** | Foto, rótulo e áudio usam o mesmo envelope de intenção/contexto; percepção ≠ commit. Absorve WS4. |
| **Tamanho / risco** | Médio-grande / médio. |
| **Depende de** | Fases 4 e 5 (enrichment comum). |

**Achados:** IMG-01…IMG-14, LABEL-01…LABEL-05, LABEL-03, AUDIO-01…AUDIO-07, STATE-14, CROSS-02.

**Invariantes:** INV-13, INV-14, INV-20 (modalidades), INV-01 (todas as modalidades).

**Escopo técnico resumido:**

- Preview antes de commit em imagem; fonte `vision_food` / `vision_label`; null preservado.
- Campo ilegível → pergunta direcionada, nunca `0`.
- Enrichment comum texto/visão/áudio antes de preview/commit.
- Quote em imagem respeitado; imagem lê estado/cancelamento.
- Confiança por campo controla mutação.
- Áudio: confirmar números materiais incertos; MIME/duração corretos; timeout.
- MIME/tamanho de mídia validados com deadline; tipos desconhecidos orientados.
- Precedência de meal type: legenda explícita > quote/continuação > visão confiável > horário.

**Gate de aceitação:**

- Foto de prato não grava sem preview/confirmação (política automática: só alta confiança + undo, se adotado explicitamente no plano da fase; default do roadmap = preview).
- Rótulo sem gordura legível não persiste gordura 0.
- Foto durante `awaiting_bulk_quantities` não abandona o fluxo sem política explícita.
- Mesmo alimento via texto e via foto passa pelo mesmo enrichment (fonte pode diferir, invariantes não).

---

### Fase 7 — Economia de LLM

| | |
|---|---|
| **Objetivo** | Cascata D0 → D1 → L1 → L2 → L3 → Q; orçamento por operação; telemetria total. |
| **Tamanho / risco** | Médio / médio — risco de regressão de qualidade se mal calibrado; gates impedem isso. |
| **Depende de** | Fase 2 (checkpoint); idealmente 4–5 para não economizar sobre pipeline mutante. |

**Achados:** COST-01…COST-18, LLM-01 (completo), HIST-03 (parcialmente contido pela PR #20: o append já analisa a instrução atual com histórico vazio — §20.1; resta a memória estruturada geral).

**Invariantes:** INV-25, INV-26, INV-27, INV-28.

**Escopo técnico resumido:**

- Parsers/regras locais para comando, yes/no, número/unidade, datas, meal type, negação — antes de LLM.
- Detector local de ato/alimento; L1 só na zona ambígua.
- Quantidade de edit/bulk: regex/tabela primeiro; L1 residual.
- Budget compartilhado: deadline, max_tokens, teto de chamadas/custo; repair dirigido único; fallback conta no mesmo orçamento.
- Instrumentar 100% das attempts no provider (usage OpenRouter, model, cache hit, latência).
- Roteamento por complexidade (não usar `mealModel` para tudo).
- Prompt de analyze enxuto; medidas/porções resolvidas localmente quando possível.
- Memória estruturada mínima em vez de 10 mensagens brutas.
- Ativar `food_cache` **depois** de corrigir semântica (NUTX-10).
- Matriz de chamadas esperadas (§14.5) como regressão de custo no corpus.

**Gate de aceitação:**

- Comando/menu/número explícito: 0 chamadas LLM.
- Alimento simples + match local seguro: 0 chamadas.
- Replay com checkpoint válido: 0 novas chamadas.
- Telemetria cobre classify/analyze/gatekeeper/correction/decompose/estimate.
- Redução de tokens não piora gates de integridade/precisão do corpus da fase.

---

### Fase 8 — Recuperação e conversa

| | |
|---|---|
| **Objetivo** | Contrato §13: nunca só “não entendi”; menor pergunta; retomada; recibo/undo; memória confirmada. |
| **Tamanho / risco** | Médio / baixo-médio — UX conversacional sobre fundações já estáveis. |
| **Depende de** | Fases 2–4; se beneficia de 5–7. |

**Achados:** ROUTE-05, STATE-04, STATE-09, STATE-10, STATE-13, STATE-15, STATE-16, HIST-01, HIST-02, REL-06, REL-21, ONB-01, ONB-02, ONB-05, ONB-06, WEIGHT-01…WEIGHT-04, SUMMARY-01…SUMMARY-05, TIME-01…TIME-06, DETAIL-01, DETAIL-02, SET-03, SET-04, QUERY-01…QUERY-05, EDIT-04…EDIT-11, FOOD-06, NUTX-05…NUTX-07.

**Invariantes:** INV-05, INV-09, INV-10, INV-17 (visível), restante de INV-06/08.

**Escopo técnico resumido:**

- Template de recuperação: estado do efeito → entendimento parcial → dúvida → próxima ação → continuidade.
- Acumular quantidades resolvidas; perguntar só o que falta.
- Tombstone de contexto expirado; oferecer retomar.
- Recibos, preview, cancel vs undo conforme §13.6.
- Chunking ordenado de respostas longas (limite WhatsApp).
- Progress vs terminal; progress sem conclusão observável.
- Memória/defaults só de fatos confirmados; undo invalida aprendizado.
- Parsers de peso/resumo/data/settings sem sequestrar intenções.
- Onboarding: consumir primeira mensagem compatível; todas as modalidades no mesmo step machine.
- Vincular `resourceType`/`resourceId`/`operationId` em todas as respostas de domínio.

**Gate de aceitação:**

- Nenhuma resposta terminal é apenas “Não entendi” sem opções.
- Resposta parcial de quantidade não reabre campos já resolvidos.
- “200g” após TTL: oferece retomada, não inicia meal_log cego.
- Cancel antes do commit = zero efeitos; undo depois = reversão auditável.
- Resumo “ontem” / ceia / peso query cobertos por regressão.

---

## 7. Backlog consciente (fora das fases 0–8)

Itens adiáveis sem bloquear a promessa de integridade. Cada um deve ser puxado para um plano quando priorizado.

| Item | Origem | Por que adiar |
|---|---|---|
| Retenção/TTL completo por categoria de dado + anonimização | REL-23 | Precisa inventário jurídico/produto; reset mínimo já está na Fase 4 (PRIV-01). |
| Shadow/canary de modelo | §15.2 | Só após evals e telemetria (Fase 7) estáveis. |
| Property-based/fuzz amplo | §15.2 | Depois do harness da Fase 1 e corpus mínimo. |
| HELP-01 label `athlete` | P3 | Cosmético. |
| SUMMARY-03/04 inconsistências de formatação | P2 | Após SUMMARY-01/02 na Fase 8. |
| IMG-12 barcode/cardápio/recibo como modalidades próprias | LR/P2 | Depois do pipeline multimodal base (Fase 6). |
| NUTX-20 safety médico/alergia completo | LR | Rota mínima de “não garanto adequação clínica” pode entrar na Fase 4/8; inventário OFF de alergênicos é maior. |
| REL-27 grants/RLS em `auth_codes`/`processed_messages` no VPS | RP | Auditar grants reais no VPS; não bloqueia fases locais. |
| CEIA/timezone viagem UX fina | §18 teste com usuários | Política base na Fase 8; calibração com usuários depois. |
| Limiares numéricos exatos de budget/confiança | §14.5 | Calibrar com telemetria pós-Fase 7, não inventar no roadmap. |

Nenhum achado P0 fica neste backlog: todos os 33 P0 estão mapeados nas Fases 0–6.

### Índice rápido dos 33 P0 → fase

| P0 | Fase |
|---|---|
| WEB-01, WEB-02 | 0 |
| WEB-03, WEB-04, WEB-05 | 2 |
| SEC-02 | 0 |
| SEC-01, REL-10, CRON-01, PRIV-01, STATE-01, STATE-11*, LLM-02, FOOD-01, FOOD-02, FOOD-03, FOOD-04, MULTI-01, EDIT-01, EDIT-02, EDIT-03, EDIT-12 | 4 (*STATE-11 começa na 2) |
| DB-01, DB-02, DB-03, DB-04, DUP-01, STATE-02, STATE-03 | 3 |
| STATE-11 | 2 |
| NUTX-02 | 5 |
| IMG-01, IMG-02 | 6 |
| LLM-01 | 2 (início) + 7 (completo) |

\* Índice canônico da auditoria §6.1: WEB-01…05, SEC-01/02, DB-01…04, DUP-01, FOOD-01…04, STATE-01/02/03/11, MULTI-01, NUTX-02, IMG-01/02, EDIT-01/02/03/12, LLM-01/02, CRON-01, PRIV-01, REL-10.

---

## 8. Métricas de sucesso do programa

Medir por fase e no agregado (sem PII/conteúdo bruto):

- taxa de escrita errada evitadas / silêncio / duplicação / parcialidade → tendência a zero nos P0;
- % mensagens com 0 LLM; custo e latência p50/p95 por inbound;
- perguntas por operação e abandono de draft;
- taxa de correção/undo após cada fonte;
- inbox `processing` além do lease; progress sem terminal; meal total ≠ SUM(items).

Uma redução de tokens só conta como sucesso se os gates de integridade permanecerem verdes.

---

## 9. Próximo passo operacional

1. ✅ Fase 0 + patch mínimo (§20.1) mergeados em `main` via PR #20 (11/07/2026) e deploy de produção `READY` na Vercel; plano das correções: [2026-07-11-correcao-mudancas-antigas.md](2026-07-11-correcao-mudancas-antigas.md). Nenhuma migration entrou na PR.
2. Verificação operacional pós-merge: confirmar `META_APP_SECRET` e `CRON_SECRET` configurados na Vercel e webhook recebendo mensagens assinadas em produção.
3. ✅ Spec e plano da **Fase 1** aprovados (12/07/2026): [2026-07-12-fase1-fundacoes-de-prova-design.md](../specs/2026-07-12-fase1-fundacoes-de-prova-design.md) · [2026-07-12-fase1-fundacoes-de-prova.md](2026-07-12-fase1-fundacoes-de-prova.md).
4. Implementar a Fase 1 com TDD e a Definition of Done deste documento (branch `fix/fase1-fundacoes-de-prova`).
5. Após a Fase 1 mergeada, detalhar a **Fase 2** (inbox) usando §20.3 como spec canônica, sem pular a identidade de operação.

Este arquivo não escolhe cronograma de calendário; escolhe ordem e critérios.
