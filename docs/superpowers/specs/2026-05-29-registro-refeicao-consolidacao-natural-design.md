# Registro de refeição: consolidação por dia/tipo + conversa natural

**Data:** 2026-05-29
**Status:** Aprovado (aguardando revisão do spec antes do plano)

## Problema

No fluxo de registro de refeição, mandar mais comida do mesmo tipo de refeição
**parece substituir** a refeição em vez de somar. Exemplo real (prints do usuário):

1. Texto: *"Comi no café da manhã 2 ovos e uma fatia de queijo mussarela"*
   → `🍽️ Café da manhã registrado!` — Ovo 146 + Queijo 66 = **212 kcal**. Hoje: 212/2168.
2. Mais tarde, **foto** de rótulo nutricional com legenda *"Comi também no café da
   manhã 67g desse açaí"*
   → `🍽️ Café da manhã registrado!` — **só** Açaí 67g 80 kcal = **80 kcal**. Hoje: 292/2168.

O total do dia (292 = 212 + 80) está correto, mas o café da manhã virou **dois
registros separados** e a confirmação mostrou **só o item novo** — daí a sensação de
"substituiu". O usuário pediu um fluxo **mais inteligente e conversacional**.

## Diagnóstico (causa-raiz, confirmada no código)

Não existe "substituição" em lugar nenhum — existem **dois registros de `breakfast`**.
Três defeitos somados:

- **(A) Roteamento — culpado principal.** `handleIncomingImage`
  (`src/lib/bot/handler.ts:788-989`) é um caminho paralelo que **nunca** lê o contexto
  `recent_meal` nem passa pelo gatekeeper/`add_item`. Para foto-rótulo com gramas na
  legenda ele calcula `resolvedPortions` e chama `handleLabelPortions`
  (`handler.ts:991-1075`), que **sempre** faz `createMeal` (`meals.ts:46-93`). A legenda
  "Comi também" só chega ao **modelo de visão** como contexto (`openrouter.ts:111`),
  nunca ao roteamento. Ou seja: "também" não tem efeito numa foto.
- **(B) Modelo de dados — torna a consolidação impossível por padrão.** Não há unique
  constraint em `(user_id, date, meal_type)` (`supabase/migrations/00003_create_meals.sql`).
  Múltiplos `breakfast` no mesmo dia são permitidos; nada procura o registro existente
  para somar.
- **(C) Exibição — o que faz *parecer* substituição.** A confirmação (`formatMealBreakdown`,
  `formatters.ts:45-84`) é montada **apenas com os itens recém-inseridos**. O total do dia
  fica certo porque `getDailyCalories` (`meals.ts:203-232`) soma todos os registros.

Verdade do modelo de dados: refeição = **uma linha `meals` + N linhas `meal_items`**
(normalizado). `createMeal` aceita `registeredAt` opcional, mas o bot **nunca** backdata
um registro vindo de texto (só o log de receita pela web usa isso). `parseDateFromMessage`
(`meal-detail.ts:62`) já entende **anteontem, ontem, hoje, dias da semana e "dia X"**, mas
hoje só é usado na **consulta**, nunca no registro.

## Decisões (aprovadas com o usuário)

1. **Consolidação:** uma refeição por **(dia do consumo, tipo de refeição)**. Logar comida
   desse tipo/dia **soma** no registro existente (cria se não houver). Sem mudança de schema;
   a regra é aplicada na aplicação (timezone-aware; uma constraint de banco não lidaria bem
   com o dia no fuso do usuário).
2. **Confirmação:** **delta + refeição completa** ("Somei X… / Café da manhã agora: …").
3. **Backdate:** o registro passa a entender data ("ontem", "anteontem", dia da semana,
   "dia X") **no texto e na legenda da foto**, gravando `registered_at` no dia certo e
   consolidando nesse dia.
4. **Backdate sem tipo explícito:** quando o registro é de **outro dia** e **sem `meal_type`
   explícito**, o bot **pergunta** "Em qual refeição? (café/almoço/lanche/jantar/ceia)".
   Para registro de **hoje** sem tipo, mantém o default por horário (sem mudança).

## Arquitetura

### Costura única: `logFoodToMeal`

Uma função central, usada pelos **3 caminhos de inserção** (texto, foto de comida,
foto de rótulo), substituindo os `createMeal` espalhados.

```
logFoodToMeal(supabase, userId, mealType, items, targetDate, originalMessage, source, timezone)
  1. busca refeição de (targetDate, mealType)
       → getMealDetailByType(userId, mealType, targetDate, timezone)  // já é timezone-aware
  2. existe?
       → addMealItems(mealId, items) + recalculateMealTotal(mealId)
       → retorna { wasAppend: true,  mealId, addedItems, fullMeal }
  3. não existe?
       → createMeal({ ..., registeredAt: ancorado no targetDate })
       → retorna { wasAppend: false, mealId, addedItems, fullMeal }
```

`fullMeal` = todos os itens da refeição após a operação (para a confirmação consolidada).
`addedItems` = itens desta operação (para a linha de delta).

### Caminhos que mudam

| Caminho | Hoje | Depois |
|---|---|---|
| Texto (novo log) | `saveMeals` → `createMeal` por refeição | `saveMeals` → `logFoodToMeal` por refeição |
| Foto de comida | `handler.ts` branch ~929 → `createMeal` | → `logFoodToMeal` |
| Foto de rótulo | `handleLabelPortions` ~1020 → `createMeal` | → `logFoodToMeal` |
| `add_item` (texto "comi também") | `appendItemsToMeal` (com guard que falha calado) | → `logFoodToMeal` (mesmo helper) |

### Data do consumo (backdate)

- Extrair `parseDateFromMessage` de `meal-detail.ts` para **`src/lib/utils/relative-date.ts`**
  e reusar em ambos (consulta e registro). DRY; `meal-detail.ts` passa a importar do util.
- No registro: `const { date, wasExplicit } = parseDateFromMessage(message ?? caption, now)`.
  `targetDate = date`.
- **Correção de fuso na escrita:** o parser atual faz contas em UTC (`getUTCDate`/`setUTCDate`).
  Ao gravar, ancorar `registered_at` em um horário **dentro do dia alvo no fuso do usuário**
  (ex.: meio-dia do dia alvo no TZ, ou o horário atual transposto para a data alvo) para não
  vazar para o dia vizinho nas bordas. Os reads já usam `getDayBoundsForTimezone`, então a
  consolidação por dia continua correta.
- Imagem: rodar o parser na **legenda** também, então foto backdatada consolida no dia certo.

### `meal_type` quando backdatado sem tipo explícito

- Se `targetDate` ≠ hoje **e** não há `meal_type` explícito (nem na mensagem nem na legenda):
  perguntar a refeição (novo estado de contexto curto, ex. `awaiting_meal_type`, guardando
  os itens já analisados + `targetDate`). Ao responder, segue para `logFoodToMeal`.
- Se `targetDate` = hoje e sem tipo explícito: mantém o default por horário (comportamento atual).

### Conserto do guard que falha calado

`appendItemsToMeal` (`meal-log.ts:648-650`) hoje dá `return null` quando o `meal_type`
re-analisado diverge do alvo — perda silenciosa. Substituir por: **rotear os itens para a
refeição do tipo correto** via `logFoodToMeal` (find-or-create do tipo certo), em vez de
descartar. Nada se perde.

### Confirmação (delta + refeição) ciente da data

Nova variante de formatação (estender `formatMealBreakdown` ou novo `formatMealUpdate`):

- `wasAppend === true`:
  ```
  🍽️ Somei Açaí (67g) — 80 kcal ao café da manhã.

  Café da manhã agora:
  • Ovo (2 ovos) — 146 kcal
  • Queijo mussarela (1 fatia) — 66 kcal
  • Açaí (67g) — 80 kcal
  Total: 292 kcal

  📊 Hoje: 292 / 2168 kcal
  ```
- `wasAppend === false`: mantém o atual `🍽️ {refeição} registrado!`.
- **Rótulo de data:** a linha de progresso reflete a data do registro — `Hoje` / `Ontem` /
  `Sáb 24/05` — em vez de sempre "Hoje". Quando vários itens foram adicionados numa operação,
  a linha de delta lista todos.

## Componentes / arquivos

| Arquivo | Função | Mudança |
|---|---|---|
| `src/lib/bot/flows/meal-log.ts` | novo `logFoodToMeal`; `saveMeals`; `appendItemsToMeal` | criar helper; rotear inserts; trocar o bail por reroteamento |
| `src/lib/bot/handler.ts` | `handleIncomingImage`, `handleLabelPortions` | usar `logFoodToMeal`; rodar parser de data na legenda; estado `awaiting_meal_type` |
| `src/lib/utils/relative-date.ts` (novo) | `parseDateFromMessage` | extrair de `meal-detail.ts` (reuso) |
| `src/lib/bot/flows/meal-detail.ts` | — | importar do util novo |
| `src/lib/db/queries/meals.ts` | `getMealDetailByType`, `addMealItems`, `recalculateMealTotal`, `createMeal` | reuso; `createMeal` com `registeredAt` ancorado no TZ |
| `src/lib/utils/formatters.ts` | `formatMealBreakdown`/novo + `formatProgress` | variante "adicionado" + rótulo de data |
| `src/lib/db/queries/context.ts` | `CONTEXT_TTLS` | (talvez) novo `awaiting_meal_type` |

## Casos de borda / limitações

- **Lanche/ceia repetidos** no mesmo dia somam num único registro daquele tipo (ok para
  contagem de calorias; perde granularidade de horário).
- **Registros duplicados antigos** no banco ficam como estão — a correção vale daqui pra
  frente. Script de consolidação retroativa fica como follow-up opcional.
- **Corrida** (2 mensagens simultâneas do mesmo usuário): baixo risco (processamento
  sequencial por usuário + dedup em `processed_messages`). Não adicionamos lock por ora.
- **Virada de dia / log tardio:** ceia logada após meia-noite cai no novo dia (igual hoje;
  não piora).

## Testes (TDD)

- **Unit `relative-date`:** ontem/anteontem/hoje/dia-da-semana/"dia X"; virada de fuso
  (registro perto da meia-noite não vaza para o dia vizinho).
- **Unit `logFoodToMeal`:** append vs create; `recalculateMealTotal` após append;
  `fullMeal`/`addedItems` corretos.
- **Unit formatter:** modos append vs novo; rótulo de data (Hoje/Ontem/data).
- **Integração (reproduz o print):** texto (ovos+queijo) → foto-rótulo açaí "no café da
  manhã" → **1 café com 3 itens**, confirmação consolidada, total do dia 292.
- **Integração foto:** foto de comida do mesmo tipo/dia consolida (não cria 2ª linha).
- **Integração backdate:** "ontem no jantar comi X" → registro no dia certo; backdate sem
  tipo → pergunta de refeição → resposta consolida no dia certo.
- **Regressão `add_item`:** atualizar testes de `edit.test.ts`; "comi também frango no
  lanche" (tipo divergente) agora roteia para o lanche em vez de falhar.

## Fora de escopo

- Migração/consolidação dos registros duplicados já existentes.
- "Sessão de refeição" persistente além do dia (modelo já cobre multi-mensagem via
  consolidação por dia/tipo, sem precisar de TTL longo).
- Escape "novo lanche" para forçar um segundo registro do mesmo tipo no mesmo dia.
