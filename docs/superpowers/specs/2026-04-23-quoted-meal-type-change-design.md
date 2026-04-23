# Quoted Meal Type Change — Design Spec

**Data:** 2026-04-23
**Status:** Aprovado

---

## Objetivo

Permitir que o usuário cite uma mensagem de refeição já registrada e mude o tipo da refeição inteira com linguagem natural, por exemplo:

- `trocar para o café da manhã`
- `isso era almoço`
- `mover pro jantar`

Quando isso acontecer, o bot deve atualizar o `meal_type` da refeição citada. Todos os itens daquela refeição continuam os mesmos; o que muda é o agrupamento da refeição.

---

## Problema Atual

Hoje o fluxo de edição por mensagem citada entende bem:

- apagar refeição inteira
- apagar item específico
- corrigir quantidade
- trocar um item por outro
- corrigir valor nutricional

Mas não existe uma ação explícita para mudar o tipo da refeição inteira. Quando o usuário responde algo como `trocar para o café da manhã`, a mensagem cai no parser genérico de correção e termina em fallback, porque o schema atual não representa `change_meal_type`.

---

## Decisões de Design

1. **Escopo mínimo:** suportar mudança de `meal_type` apenas no fluxo de edição com `QuoteContext` de `resourceType='meal'`.
2. **Mudança no nível da refeição:** a atualização acontece na row de `meals`. Nenhum `meal_item` é recriado, removido ou trocado.
3. **Nova intenção explícita:** adicionar ação `change_meal_type` ao schema e ao prompt de correção, evitando ambiguidade com `replace_item`.
4. **Prioridade semântica:** se a mensagem descreve mudança de refeição (`café da manhã`, `almoço`, `lanche`, `jantar`, `ceia`) sem alvo de item, o fluxo trata como mudança de `meal_type` da refeição inteira.
5. **Fluxo atual preservado:** comandos de item continuam com o comportamento atual. Exemplo: `trocar arroz por quinoa` continua sendo correção de item, não mudança de refeição.

---

## Comportamento Esperado

### Casos suportados

Usuário cita uma mensagem vinculada a uma refeição e envia:

- `trocar para o café da manhã`
- `isso era almoço`
- `muda pro lanche`
- `passa para jantar`
- `na verdade era ceia`

Resultado:

1. Resolver `quoteContext`
2. Buscar refeição por `resourceId`
3. Identificar `target_meal_type`
4. Atualizar `meals.meal_type`
5. Recalcular progresso diário
6. Responder com confirmação clara

Exemplo de resposta:

```text
✅ Refeição movida de Lanche para Café da manhã.
📊 Hoje: 19 / 2336 kcal
```

### Regra principal

Se o usuário muda o tipo da refeição citada, **tudo que está naquela mensagem muda junto**. Se a refeição tem 4 alimentos, os 4 continuam na mesma refeição, agora com novo `meal_type`.

### Casos que não devem mudar

- `trocar arroz por quinoa` → continua `replace_item`
- `apaga o arroz` → continua remoção de item
- `era 200g de arroz` → continua correção de quantidade
- `o arroz é 120 kcal` → continua `update_value`

---

## Heurística de Interpretação

Para manter mudança pequena e previsível:

1. O fluxo quoted edit tenta primeiro a interpretação estruturada com nova ação `change_meal_type`.
2. O prompt de correção passa a aceitar frases de mudança de refeição inteira.
3. O parser deve preencher:

```json
{
  "action": "change_meal_type",
  "target_meal_type": "breakfast|lunch|snack|dinner|supper",
  "target_food": null,
  "new_quantity": null,
  "new_food": null,
  "new_value": null,
  "confidence": "high|medium|low"
}
```

4. Se a LLM não retornar isso com confiança suficiente, o fluxo mantém comportamento atual e cai no fallback existente.

---

## Mudanças Técnicas

### 1. Schema de correção

Arquivo: `src/lib/llm/schemas/correction.ts`

- adicionar `change_meal_type` ao `CorrectionActionSchema`
- continuar usando `target_meal_type` como destino da mudança

### 2. Prompt de correção

Arquivo: `src/lib/llm/prompts/correction.ts`

Adicionar nova ação:

- `change_meal_type`: mudar a refeição inteira para outro tipo (ex: `trocar para café da manhã`, `isso era almoço`)

Regras novas:

- Se a mensagem menciona um tipo de refeição como destino da refeição inteira, usar `change_meal_type`
- Não usar `replace_item` quando o texto descreve mudança de refeição, não de alimento

### 3. Query de update da refeição

Arquivo: `src/lib/db/queries/meals.ts`

Adicionar helper dedicado:

```typescript
updateMealType(supabase, mealId, mealType)
```

Responsabilidade:

- atualizar `meals.meal_type`
- não tocar em `meal_items`

### 4. Flow de edit quoted

Arquivo: `src/lib/bot/flows/edit.ts`

No `handleQuotedEdit`:

- após carregar `meal`, aceitar resultado `change_meal_type`
- atualizar `meal_type` da refeição citada
- limpar estado
- recalcular `getDailyCalories(...)`
- responder com antes/depois usando labels humanas

---

## Resposta do Bot

Formato recomendado:

```text
✅ Refeição movida de {origem} para {destino}.
{progress}
```

Exemplo:

```text
✅ Refeição movida de Lanche para Café da manhã.
📊 Hoje: 19 / 2336 kcal
```

Se o destino for igual ao tipo atual:

```text
Essa refeição já está como Café da manhã.
```

---

## Arquivos Afetados

| Arquivo | Mudança |
|---------|---------|
| `src/lib/llm/schemas/correction.ts` | nova action `change_meal_type` |
| `src/lib/llm/prompts/correction.ts` | prompt passa a reconhecer mudança de refeição inteira |
| `src/lib/db/queries/meals.ts` | novo helper `updateMealType` |
| `src/lib/bot/flows/edit.ts` | handler para `change_meal_type` em quote |
| `tests/unit/bot/edit.test.ts` | cobertura do novo comportamento |
| `tests/unit/llm/correction-schema.test.ts` | validar schema com nova action |

---

## Testes

Cobrir pelo menos:

1. Cita refeição e manda `trocar para o café da manhã` → atualiza `meal_type` para `breakfast`
2. Mantém mesmos itens da refeição; não chama remoção nem rename de item
3. Responde com confirmação incluindo origem e destino
4. Se tipo já era igual, responde que já está naquele tipo
5. `trocar arroz por quinoa` continua fluxo de item, não `change_meal_type`

---

## Fora de Escopo

- mudar `meal_type` sem quote
- mover só parte dos itens para outra refeição
- criar nova refeição a partir de itens separados
- reclassificar refeições antigas em lote
- alterar heurística de classificação de refeição no registro inicial
