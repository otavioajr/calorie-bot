# Consulta de refeição por tipo e data

## Objetivo

Permitir que o usuário pergunte o que comeu em uma refeição específica (café, almoço, lanche, jantar, ceia) em qualquer dia. O bot responde com a lista de alimentos e calorias de cada item.

Exemplos de mensagens:
- "o que comi no café da manhã?"
- "o que eu comi no almoço?"
- "o que comi no jantar ontem?"
- "o que comi no almoço segunda?"
- "comi o que no lanche dia 25?"

## Nova intenção: `meal_detail`

Adicionar `meal_detail` ao `IntentType` em `src/lib/bot/router.ts` e ao schema Zod em `src/lib/llm/schemas/intent.ts`.

### Keywords (regras fixas)

Padrões que ativam a intenção sem LLM:
- "o que comi no" / "o que eu comi no" / "o que comi de"
- "comi no cafe" / "comi no almoco" / "comi no jantar" / "comi no lanche" / "comi na ceia"
- "que comi" (genérico, captura variações)

Prioridade: inserir **antes** de `summary` no `classifyByRules`, para não confundir com "quanto comi".

### LLM fallback

Adicionar `meal_detail` ao enum do `IntentClassificationSchema` para que a LLM possa classificar quando as regras não matcharem.

## Parsing de meal_type e data

### Novo módulo: `src/lib/bot/flows/meal-detail.ts`

#### Extração de meal_type (regras fixas)

Mapa de keywords para meal_type:
- `cafe`, `cafe da manha`, `manha` → `breakfast`
- `almoco` → `lunch`
- `lanche` → `snack`
- `jantar`, `janta` → `dinner`
- `ceia` → `supper`

Aplicar após normalização (sem acentos, lowercase). Se nenhum tipo for identificado, default para listar **todas** as refeições do dia (comportamento similar ao resumo, mas com itens detalhados).

#### Extração de data (híbrido: regras + LLM fallback)

**Regras fixas** (custo zero):
- Sem indicação de data → hoje
- "hoje" → hoje
- "ontem" → hoje - 1
- "anteontem" → hoje - 2
- Dias da semana ("segunda", "terca", ..., "domingo") → último dia da semana correspondente (se for o dia atual, assume hoje)
- "dia X" ou "dia XX" → dia X do mês atual; se o dia X ainda não passou, assume mês anterior

**Fallback LLM**: se as regras não extraírem a data, enviar a mensagem para a LLM com prompt pedindo JSON:
```json
{
  "meal_type": "breakfast",
  "date": "2026-03-28"
}
```

O prompt deve incluir a data atual para referência. Modelo: usar o mesmo modelo de classificação (`LLM_MODEL_CLASSIFY`) para manter custo baixo.

## Query no banco

### Nova função: `getMealDetailByType`

Em `src/lib/db/queries/meals.ts`:

```typescript
interface MealDetailItem {
  foodName: string
  quantityGrams: number
  quantityDisplay: string | null
  calories: number
}

interface MealDetail {
  mealType: string
  registeredAt: string
  items: MealDetailItem[]
  totalCalories: number
}

async function getMealDetailByType(
  supabase: SupabaseClient,
  userId: string,
  mealType: string,
  date: Date,
  timezone: string,
): Promise<MealDetail[]>
```

Busca `meals` + `meal_items` filtrado por `user_id`, `meal_type` e dia (usando `getDayBoundsForTimezone` existente). Retorna array porque pode haver mais de uma refeição do mesmo tipo no dia (ex: dois lanches).

Se `mealType` for `null`, busca todas as refeições do dia (sem filtro de tipo).

## Formatação da resposta

### Nova função: `formatMealDetail`

Em `src/lib/utils/formatters.ts`:

**Com registro encontrado:**
```
☕ Cafe da manha (28/03):

• Pao frances (2 un) — 300 kcal
• Manteiga (10g) — 72 kcal
• Cafe com leite (200ml) — 80 kcal

Total: 452 kcal
```

Se houver mais de uma refeição do mesmo tipo:
```
☕ Cafe da manha (28/03):

1a refeicao:
• Pao frances (2 un) — 300 kcal
• Manteiga (10g) — 72 kcal
Total: 372 kcal

2a refeicao:
• Banana (1 un) — 89 kcal
Total: 89 kcal

Total geral: 461 kcal
```

**Sem registro:**
```
Nao encontrei nenhum registro de cafe da manha em 28/03 ☕
```

## Fluxo no handler

No `handler.ts`, adicionar case `meal_detail` no switch de intenções:

```typescript
case 'meal_detail':
  response = await handleMealDetail(supabase, user.id, text, {
    timezone: user.timezone,
  })
  break
```

Sem estado de conversa — é uma consulta pontual, sem ida e volta.

## Arquivos modificados

| Arquivo | Mudança |
|---------|---------|
| `src/lib/bot/router.ts` | Adicionar `meal_detail` ao `IntentType`, keywords em `classifyByRules` |
| `src/lib/llm/schemas/intent.ts` | Adicionar `meal_detail` ao enum do schema Zod |
| `src/lib/bot/flows/meal-detail.ts` | **Novo** — `handleMealDetail` com parsing de tipo/data e resposta |
| `src/lib/db/queries/meals.ts` | Adicionar `getMealDetailByType` |
| `src/lib/utils/formatters.ts` | Adicionar `formatMealDetail` |
| `src/lib/bot/handler.ts` | Adicionar case `meal_detail` no switch de intenções |
| `src/lib/bot/flows/help.ts` | Atualizar menu de ajuda com a nova opção |

## Decisoes de design

- **Nao usa LLM para a resposta**: a LLM so e usada (se necessario) para extrair meal_type + data da mensagem. A resposta vem direto do banco.
- **Prioridade antes de summary**: "o que comi" deve ir para `meal_detail`, nao para `summary`. O summary fica para "quanto comi" / "como to".
- **Default sem tipo**: se o usuario perguntar "o que comi hoje?" sem especificar tipo, lista todas as refeicoes do dia com itens.
- **Nivel de detalhe**: alimentos + quantidade + calorias. Sem macros na resposta (usuario escolheu opcao 1).
